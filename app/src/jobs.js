  // ================================================================ JOBS section
  // Sub-tabs: Jobs (+ drawer), Search settings, Blocked names.

  // ================= Categories + type rules (shared state) =================
  let categoriesById = new Map();
  let categoriesList = [];
  let catsLoaded = false;
  let rulesByType = new Map();
  let rulesLoaded = false;

  async function loadCategories() {
    const { data, error } = await supabase
      .from("job_categories")
      .select("id, name, display_label, config")
      .order("name", { ascending: true });
    if (error) { showError("settingsError", "Could not load categories: " + error.message); return; }
    categoriesList = data || [];
    categoriesById = new Map(categoriesList.map((c) => [c.id, c]));
    catsLoaded = true;
  }

  async function loadRules() {
    const { data, error } = await supabase
      .from("job_type_rules")
      .select("job_type, allowed, category_id, config_override, comm_workflow")
      .order("job_type", { ascending: true });
    if (error) { showError("settingsError", "Could not load type rules: " + error.message); return; }
    rulesByType = new Map((data || []).map((r) => [r.job_type, r]));
    rulesLoaded = true;
  }

  async function ensureRules() {
    if (!catsLoaded) await loadCategories();
    if (!rulesLoaded) await loadRules();
    renderSettings();
  }

  async function reloadRulesAndJobs() {
    await Promise.all([loadCategories(), loadRules()]);
    renderSettings();
    await refreshVisibility();
    renderJobs();
    renderDrawer();
  }

  function catForType(jobType) {
    const rule = rulesByType.get(jobType);
    return rule && rule.category_id ? categoriesById.get(rule.category_id) || null : null;
  }

  // ================= Jobs =================
  let allJobs = [];
  let visibleIds = new Set();
  let pubById = new Map(); // public_jobs rows (group_options etc.) for the field editor
  let jobFilter = "all";
  let jobSort = "shoot"; // shoot (upcoming soonest first, then past) | published | name
  let jobScope = { type: null, cat: null };
  let selectedJobId = null;
  let openRequests = []; // pending lookup_requests, shared with the drawer

  async function fetchAllJobs() {
    // Page through the whole table. A flat .limit() silently truncates the list
    // once the job count passes it, and PostgREST caps a single response at
    // max-rows (1000 by default), so raising the number only moves the cliff.
    const PAGE = 500;
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from("synced_jobs")
        .select("gotphoto_job_id, name, job_type, status, code_count, hide_override, field_config, missing_fields, shoot_at, gp_activated_at, access_type, comm_workflow, hub_dates, child_limit_by_searcher")
        .order("name", { ascending: true })
        // Some jobs share a name, so name alone is not a total order: without
        // this tiebreaker rows can repeat or vanish at a page boundary.
        .order("gotphoto_job_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return { data: null, error };
      rows.push(...(data || []));
      if ((data || []).length < PAGE) return { data: rows, error: null };
    }
  }

  async function refreshVisibility() {
    const { data, error } = await supabase.from("public_jobs").select("gotphoto_job_id, group_options");
    if (error) { showError("jobsError", "Visibility could not be computed: " + error.message); return; }
    visibleIds = new Set((data || []).map((r) => r.gotphoto_job_id));
    pubById = new Map((data || []).map((r) => [r.gotphoto_job_id, r]));
  }

  async function loadJobs() {
    clearError("jobsError");
    const [jobsRes] = await Promise.all([fetchAllJobs(), refreshVisibility()]);
    if (jobsRes.error) {
      showError("jobsError", "Could not load jobs: " + jobsRes.error.message);
      el("jobsBody").innerHTML = '<tr><td colspan="2" class="empty">Unavailable.</td></tr>';
      return;
    }
    allJobs = jobsRes.data || [];
    renderJobs();
    renderDrawer();
    renderBlockJobOptions();
  }

  // Sports Admin Hub (/sportsadmin/) copy set for a sport job. Mirrors the sports_hub_jobs view:
  // per-job override, else a shared team code means "school" (the old roster workflow), else the
  // job type's comm_workflow (Sport (Other) = league by convention). Never decided by the client.
  const WF_LABEL = { league: "Registered families", school: "Roster only" };
  function isSportJob(j) { return typeof j.job_type === "string" && j.job_type.indexOf("sport") === 0; }
  function hubWorkflow(j) {
    if (j.comm_workflow === "league" || j.comm_workflow === "school") return { wf: j.comm_workflow, why: "set here for this job", ov: j.comm_workflow };
    if (j.access_type === "single_password") return { wf: "school", why: "shared team code (old workflow)", ov: "auto" };
    const rule = rulesByType.get(j.job_type);
    const wf = rule && rule.comm_workflow === "league" ? "league" : "school";
    return { wf, why: "type " + j.job_type + (rule && rule.comm_workflow ? "" : " (default)"), ov: "auto" };
  }

  function jobOverrideState(hide_override) {
    if (hide_override === true) return "hide";
    if (hide_override === false) return "show";
    return "auto";
  }

  // Why is this job findable (or not)? Mirrors the public_jobs view: published AND
  // (forced on, OR (not forced off AND the type is allowed)). visibleIds is the truth;
  // this only explains it.
  function explainJob(j) {
    const visible = visibleIds.has(j.gotphoto_job_id);
    // Since migration 20260912T07 the website lists selling AND planning jobs; only archived ones
    // are out of scope. `pub` keeps its name but means "eligible".
    const pub = j.status === "published" || j.status === "created";
    const planning = j.status === "created";
    const ov = jobOverrideState(j.hide_override);
    const rule = rulesByType.get(j.job_type);
    const cat = catForType(j.job_type);
    const missing = Array.isArray(j.missing_fields) && j.missing_fields.length > 0;
    let state, reason, attention = false;
    if (!pub) { state = "Not yet"; reason = j.status === "archived" ? "archived in GotPhoto" : "status " + j.status + " in GotPhoto"; }
    else if (visible && ov === "show") { state = "Visible"; reason = "forced on for this job" + (planning ? " · planning" : ""); }
    else if (visible) { state = "Visible"; reason = (cat ? "via " + cat.name : "via global defaults") + (planning ? " · planning" : ""); }
    else if (ov === "hide") { state = "Hidden"; reason = "forced off for this job"; }
    else if (!rule) { state = "Hidden"; reason = "type " + j.job_type + " has no rule yet"; attention = true; }
    else if (!rule.allowed) { state = "Hidden"; reason = "type " + j.job_type + " is switched off"; attention = true; }
    else { state = "Hidden"; reason = "not in public_jobs"; attention = true; }
    if (pub && visible && missing) attention = true;
    const pill = state === "Visible" ? "visible" : (attention ? "warn" : "hidden-pill");
    return { visible, pub, ov, rule, cat, missing, state, reason, attention, pill };
  }

  function jobMatchesFilters(j, ex) {
    const q = el("jobSearch").value.trim().toLowerCase();
    if (q && !(j.name || "").toLowerCase().includes(q)) return false;
    if (jobScope.type && j.job_type !== jobScope.type) return false;
    if (jobScope.cat && !(ex.cat && ex.cat.id === jobScope.cat)) return false;
    if (jobFilter === "visible") return ex.visible;
    if (jobFilter === "hidden") return ex.pub && !ex.visible;
    if (jobFilter === "attention") return ex.attention;
    return true;
  }

  function fmtShort(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });
  }
  // Sort a copy of allJobs.
  //   "shoot"     = anchored on today: today's and upcoming shoots first, soonest at the top, then
  //                 past shoots most-recent first. The job you are about to shoot is always at
  //                 the top of the list; planning jobs (no publish date) take part like any other.
  //   "published" = GotPhoto's activated timestamp, newest first; never-published jobs last.
  //   "name"      = A–Z. Ties everywhere fall back to name.
  function sortedJobs() {
    const byName = (a, b) => (a.name || "").localeCompare(b.name || "") || a.gotphoto_job_id.localeCompare(b.gotphoto_job_id);
    const ts = (v) => (v ? new Date(v).getTime() : 0);
    const list = allJobs.slice();
    if (jobSort === "name") return list.sort(byName);
    if (jobSort === "published") return list.sort((a, b) => (ts(b.gp_activated_at) - ts(a.gp_activated_at)) || byName(a, b));
    // Start of today in Maine, so a shoot dated today counts as upcoming all day.
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dayOf = (v) => (v ? new Date(v).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");
    const upcoming = [], past = [], undated = [];
    list.forEach((j) => { const d = dayOf(j.shoot_at); if (!d) undated.push(j); else if (d >= todayStr) upcoming.push(j); else past.push(j); });
    upcoming.sort((a, b) => (ts(a.shoot_at) - ts(b.shoot_at)) || byName(a, b));
    past.sort((a, b) => (ts(b.shoot_at) - ts(a.shoot_at)) || byName(a, b));
    return upcoming.concat(past, undated.sort(byName));
  }

  function renderJobs() {
    const explained = sortedJobs().map((j) => [j, explainJob(j)]);
    const counts = { all: explained.length, visible: 0, hidden: 0, attention: 0 };
    explained.forEach(([, ex]) => {
      if (ex.visible) counts.visible++;
      if (ex.pub && !ex.visible) counts.hidden++;
      if (ex.attention) counts.attention++;
    });
    el("jobFilters").querySelectorAll("button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.filter === jobFilter));
      const c = b.querySelector("[data-count]");
      if (c) c.textContent = counts[b.dataset.filter];
    });
    const scopeNode = el("jobScope");
    if (jobScope.type || jobScope.cat) {
      const cat = jobScope.cat ? categoriesById.get(jobScope.cat) : null;
      el("jobScopeLabel").textContent = jobScope.type ? "type " + jobScope.type : "category " + (cat ? cat.name : "?");
      scopeNode.classList.remove("hidden");
    } else {
      scopeNode.classList.add("hidden");
    }

    const rows = explained.filter(([j, ex]) => jobMatchesFilters(j, ex));
    const body = el("jobsBody");
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="2" class="empty">No jobs match.</td></tr>';
      return;
    }
    // Two-line rows (name, then type · when · codes) with the visibility pill on the right. The
    // "why" behind the pill lives in the drawer, and as a tooltip here, so nothing wraps.
    body.innerHTML = rows.map(([j, ex]) => {
      const when = j.status === "published" ? (fmtShort(j.gp_activated_at) ? "published " + fmtShort(j.gp_activated_at) : "published")
        : (j.status === "created" ? "planning" : j.status);
      const codes = (j.code_count == null ? 0 : j.code_count) + (j.code_count === 1 ? " code" : " codes");
      return '<tr class="row' + (j.gotphoto_job_id === selectedJobId ? ' sel' : '') + '" data-job="' + esc(j.gotphoto_job_id) + '" title="' + esc(ex.state + ": " + ex.reason) + '">' +
        '<td class="jobcell"><div class="jname">' + esc(j.name) + '</div>' +
          '<div class="jmeta"><span class="mono">' + esc(j.job_type) + '</span> · ' + esc(when) + ' · ' + esc(codes) +
          (j.field_config ? ' · <span class="pill warn">Custom fields</span>' : '') +
          (ex.missing && ex.pub ? ' · <span class="pill warn" title="Missing: ' + esc(j.missing_fields.join(", ")) + '">Roster gaps</span>' : '') +
          '</div></td>' +
        '<td class="jstate"><span class="pill ' + ex.pill + '">' + esc(ex.state) + '</span></td>' +
      '</tr>';
    }).join("");
  }

  el("jobSearch").addEventListener("input", renderJobs);
  el("jobSort").addEventListener("change", () => { jobSort = el("jobSort").value; renderJobs(); });
  el("jobFilters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    jobFilter = b.dataset.filter;
    renderJobs();
  });
  el("jobScopeClear").addEventListener("click", () => { jobScope = { type: null, cat: null }; renderJobs(); });

  function showJobsFor(scope, opts) {
    jobScope = Object.assign({ type: null, cat: null }, scope);
    jobFilter = "all";
    el("jobSearch").value = "";
    if (opts && opts.select !== undefined) selectedJobId = opts.select;
    showTab("jobs");
    renderJobs();
    renderDrawer();
  }

  el("jobsBody").addEventListener("click", (e) => {
    const row = e.target.closest("tr.row");
    if (!row) return;
    selectedJobId = selectedJobId === row.dataset.job ? null : row.dataset.job;
    renderJobs();
    renderDrawer();
  });

  // ---- Shared search-field config editors ----
  // Defaults cascade job -> type config_override -> category config -> global
  // (mirroring effective_search_config in Postgres). All three tiers store the
  // same shape, so the job, type, and category editors share one markup
  // builder and one collector. Blank input = inherit from the tier above.

  function cascade(tiers) {
    const t = (tiers || []).filter(Boolean);
    const fieldsTier = t.find((c) => Array.isArray(c.fields));
    const keys = fieldsTier ? fieldsTier.fields.map((f) => f.key) : ["first_name", "last_name"];
    const attr = (k, a) => {
      for (const c of t) {
        if (!Array.isArray(c.fields)) continue;
        const f = c.fields.find((x) => x.key === k);
        if (f && f[a]) return f[a];
      }
      return null;
    };
    let groupLabel = null;
    let groupDisplay = null;
    let allowErrors = null;
    for (const c of t) {
      if (groupLabel === null && c.group_label) groupLabel = c.group_label;
      if (groupDisplay === null && c.group_display) groupDisplay = c.group_display;
      if (allowErrors === null && c.allow_errors != null) allowErrors = c.allow_errors;
    }
    return {
      keys,
      label: (k) => attr(k, "label") || DEFAULT_LABELS[k] || k,
      placeholder: (k) => attr(k, "placeholder") || "",
      verify: (k) => {
        for (const c of t) {
          if (!Array.isArray(c.fields)) continue;
          const f = c.fields.find((x) => x.key === k);
          if (f && typeof f.verify === "boolean") return f.verify;
        }
        return true;
      },
      groupLabel: groupLabel || DEFAULT_GROUP_LABEL,
      groupDisplay: groupDisplay === "before_dash" ? "before_dash" : "full",
      allowErrors: allowErrors == null ? 1 : allowErrors,
    };
  }

  function inheritedForJob(job) {
    const rule = rulesByType.get(job.job_type) || {};
    const cat = rule.category_id ? categoriesById.get(rule.category_id) : null;
    const inh = cascade([rule.config_override, cat && cat.config]);
    inh.source = rule.config_override
      ? "type '" + job.job_type + "' (custom)"
      : (cat
        ? "category '" + cat.name + "' (via type '" + job.job_type + "')"
        : "no category — global defaults");
    return inh;
  }

  // Which tier a job's effective settings come from, per aspect. Used by the drawer's
  // "what parents type" list so every line carries a source badge.
  function resolveJobConfig(job) {
    const rule = rulesByType.get(job.job_type) || {};
    const cat = rule.category_id ? categoriesById.get(rule.category_id) : null;
    const tiers = [
      { cfg: job.field_config, src: "This job" },
      { cfg: rule.config_override, src: job.job_type },
      { cfg: cat && cat.config, src: cat ? cat.name : null },
    ].filter((t) => t.cfg && t.src);
    const eff = cascade(tiers.map((t) => t.cfg));
    const fieldsTier = tiers.find((t) => Array.isArray(t.cfg.fields));
    const labelSrc = (k) => { const t = tiers.find((x) => Array.isArray(x.cfg.fields) && x.cfg.fields.some((f) => f.key === k && f.label)); return t ? t.src : (fieldsTier ? fieldsTier.src : "Global"); };
    const groupTier = tiers.find((t) => t.cfg.group_label);
    const gdispTier = tiers.find((t) => t.cfg.group_display);
    const errTier = tiers.find((t) => t.cfg.allow_errors != null);
    return {
      cat, rule, eff,
      fields: eff.keys.map((k) => ({ key: k, label: eff.label(k), src: labelSrc(k), verify: eff.verify(k) })),
      groupLabel: eff.groupLabel, groupSrc: groupTier ? groupTier.src : "Global",
      groupDisplay: eff.groupDisplay, gdispSrc: gdispTier ? gdispTier.src : "Global",
      allowErrors: eff.allowErrors, errSrc: errTier ? errTier.src : "Global",
      inheritsFrom: fieldsTier ? fieldsTier.src : "Global",
    };
  }

  // opts: { title, subtitle, showCoverage, nameValue, chipValue, extraNote, resetLabel, extraSection }
  function cfgEditorMarkup(cfg, inh, opts) {
    const cfgFields = Array.isArray(cfg.fields) ? cfg.fields : null;
    const enabledKeys = cfgFields ? cfgFields.map((f) => f.key) : inh.keys;
    const byKey = {};
    (cfgFields || []).forEach((f) => { byKey[f.key] = f; });
    const fieldRows = MATCH_FIELD_OPTIONS.map((opt) => {
      const k = opt.key;
      const ov = byKey[k] || {};
      const phCell = k === "birthdate"
        ? '<span class="muted">Shown as a date picker</span>'
        : '<input type="text" class="fc-ph" data-key="' + k + '" value="' + esc(ov.placeholder || "") + '" placeholder="' + esc(inh.placeholder(k) || "Enter exact " + inh.label(k).toLowerCase()) + '" maxlength="120" />';
      const covCell = opts.showCoverage
        ? '<span class="fc-cov" data-key="' + k + '"><span class="pill muted">…</span></span>'
        : '<span></span>';
      // "Accept anything": the field stays on the website (parents must fill it in) but is
      // not compared to the roster — for rosters whose e.g. teacher names are unreliable.
      const ownVerify = typeof ov.verify === "boolean" ? ov.verify : inh.verify(k);
      return '<div class="fc-line">' +
        '<div class="fc-name-cell">' +
          '<label class="fc-on-label"><input type="checkbox" class="fc-on" data-key="' + k + '"' + (enabledKeys.includes(k) ? " checked" : "") + ' /> ' + esc(opt.label) + '</label>' +
          '<label class="fc-any-label muted" title="Keep the field on the website, but accept whatever the parent types"><input type="checkbox" class="fc-any" data-key="' + k + '"' + (ownVerify ? "" : " checked") + ' /> Accept anything</label>' +
        '</div>' +
        '<input type="text" class="fc-label" data-key="' + k + '" value="' + esc(ov.label || "") + '" placeholder="' + esc(inh.label(k)) + '" maxlength="80" />' +
        phCell + covCell +
        '</div>';
    }).join("");
    const nameInput = opts.nameValue == null ? "" :
      '<label>Name <input type="text" class="fc-name" value="' + esc(opts.nameValue) + '" maxlength="60" /></label>';
    const chipInput = opts.chipValue == null ? "" :
      '<label>Chip label (website) <input type="text" class="fc-chip" value="' + esc(opts.chipValue) + '" placeholder="Event" maxlength="40" /></label>';
    return '<div class="fc-editor">' +
      '<div class="fc-head">' + opts.title +
        (opts.subtitle ? ' — <span class="muted">' + opts.subtitle + '</span>' : '') + '</div>' +
      '<div class="fc-cols muted"><span>Field</span><span>Label on the website (blank = inherit)</span><span>Placeholder text (blank = inherit)</span><span>' + (opts.showCoverage ? 'Roster data' : '') + '</span></div>' +
      fieldRows +
      '<div class="fc-extra">' +
        nameInput + chipInput +
        '<label>Team/class dropdown label ' +
          '<input type="text" class="fc-glabel" value="' + esc(cfg.group_label || "") + '" placeholder="' + esc(inh.groupLabel) + '" maxlength="40" /></label>' +
        // School rosters name groups "<grade> - <teacher>". Showing the teacher in the
        // dropdown gives away the answer to the "Teacher's last name" question, so those
        // jobs display only the part before the dash; duplicates collapse to one option
        // and a pick matches every teacher in that grade.
        '<label>Dropdown shows ' +
          '<select class="fc-gdisp">' +
            '<option value=""' + (cfg.group_display ? "" : " selected") + '>Inherit — ' + esc(GROUP_DISPLAY_LABELS[inh.groupDisplay]) + '</option>' +
            '<option value="full"' + (cfg.group_display === "full" ? " selected" : "") + '>' + esc(GROUP_DISPLAY_LABELS.full) + '</option>' +
            '<option value="before_dash"' + (cfg.group_display === "before_dash" ? " selected" : "") + '>' + esc(GROUP_DISPLAY_LABELS.before_dash) + '</option>' +
          '</select></label>' +
        (opts.extraNote ? '<span class="muted fc-gnote">' + opts.extraNote + '</span>' : '') +
        '<label>Typo tolerance ' +
          '<input type="number" class="fc-errors" min="0" max="9" value="' + esc(cfg.allow_errors == null ? "" : cfg.allow_errors) + '" placeholder="' + esc(inh.allowErrors) + '" /></label>' +
      '</div>' +
      (opts.extraSection || '') +
      '<div class="fc-actions">' +
        '<button class="small primary fc-save">Save</button> ' +
        '<button class="small fc-reset">' + esc(opts.resetLabel) + '</button> ' +
        '<button class="small fc-cancel">Close</button>' +
        '<span class="row-msg fc-msg"></span>' +
      '</div>' +
      '</div>';
  }

  // Reads an editor back into a minimal config: anything matching the
  // inherited tier is omitted; returns {config: object|null} or {error}.
  function collectCfg(ed, inh) {
    const enabled = MATCH_FIELD_OPTIONS
      .map((o) => o.key)
      .filter((k) => ed.querySelector('.fc-on[data-key="' + k + '"]').checked);
    if (enabled.length === 0) return { error: "Enable at least one field." };
    const val = (sel, k) => {
      const inp = ed.querySelector(sel + '[data-key="' + k + '"]');
      return inp ? inp.value.trim() : "";
    };
    const verifyOf = (k) => !ed.querySelector('.fc-any[data-key="' + k + '"]').checked;
    if (!enabled.some(verifyOf)) return { error: "At least one field must be checked (not \"Accept anything\")." };
    const anyText = enabled.some((k) => val(".fc-label", k) || val(".fc-ph", k) || verifyOf(k) !== inh.verify(k));
    const sameKeys = enabled.length === inh.keys.length && enabled.every((k) => inh.keys.includes(k));
    const cfg = {};
    if (!sameKeys || anyText) {
      cfg.fields = enabled.map((k) => {
        const f = { key: k };
        const l = val(".fc-label", k);
        const p = val(".fc-ph", k);
        if (l) f.label = l;
        if (p) f.placeholder = p;
        if (verifyOf(k) !== inh.verify(k)) f.verify = verifyOf(k);
        return f;
      });
    }
    const gl = ed.querySelector(".fc-glabel").value.trim();
    if (gl) cfg.group_label = gl;
    const gd = ed.querySelector(".fc-gdisp").value;
    if (gd) cfg.group_display = gd;
    const ae = ed.querySelector(".fc-errors").value.trim();
    if (ae !== "" && !isNaN(parseInt(ae, 10))) cfg.allow_errors = parseInt(ae, 10);
    return { config: Object.keys(cfg).length ? cfg : null };
  }

  function coveragePill(have, total) {
    if (!total) return '<span class="pill muted">no codes yet</span>';
    const pct = Math.round((have / total) * 100);
    const cls = have === 0 ? "err" : (pct < 50 ? "warn" : "ok");
    return '<span class="pill ' + cls + '">' + num(have) + " of " + num(total) + " (" + num(pct) + "%)</span>";
  }

  // Coverage counts + top-5 sample values per field (aggregate-ish only — the codes table
  // itself is not readable here). The samples matter: the GotPhoto Identifier column has held
  // jersey numbers, divisions, or real student IDs depending on the job, and requiring the
  // wrong kind as a search factor would be useless or misleading.
  function fillCoverage(container, jobId) {
    supabase.rpc("admin_job_field_coverage", { p_job_id: jobId }).then(({ data, error }) => {
      if (!container.isConnected) return;
      container.querySelectorAll(".fc-cov").forEach((slot) => {
        if (error || !data) { slot.innerHTML = '<span class="pill muted">n/a</span>'; return; }
        const k = slot.dataset.key;
        let html = coveragePill(data[k] || 0, data.total || 0);
        const samples = data.samples && data.samples[k];
        if (Array.isArray(samples) && samples.length) {
          const joined = samples.join(" · ");
          html += '<div class="fc-samples muted" title="' + esc(joined) + '">e.g. ' + esc(joined) + '</div>';
        }
        slot.innerHTML = html;
      });
      const gnote = container.querySelector(".fc-gnote");
      if (!error && data && gnote && data.total) {
        gnote.textContent += " · " + (data.group || 0) + " of " + data.total + " codes have a team/class";
      }
    });
  }

  // ================= Mobile sheet for the job drawer (below 900px) =================
  (function () {
    const css = `
    .aca .drawer .dhead .js-dclose .x { display: none; }
    @media (max-width: 900px) {
      .aca .drawer:not(.hidden) { position: fixed; inset: 0; top: var(--og-top, 0px); width: 100vw; max-width: none; flex: none; z-index: 9990; overflow: auto; -webkit-overflow-scrolling: touch; background: var(--surface); border: none; padding: 0 16px 24px; }
      .aca .drawer .dhead { position: sticky; top: 0; z-index: 2; background: var(--surface); padding: 10px 0; border-bottom: 1px solid var(--border); align-items: center; }
      .aca .drawer .dhead > div { min-width: 0; overflow-wrap: anywhere; }
      .aca .drawer .dhead .js-dclose { min-width: 40px; min-height: 40px; flex: 0 0 auto; font-size: 18px; line-height: 1; }
      .aca .drawer .dhead .js-dclose .x { display: inline; }
      .aca .drawer .dhead .js-dclose .w { display: none; }
    }
    body.aca-sheet-open { overflow: hidden; }`;
    const t = document.createElement("style"); t.textContent = css; document.head.appendChild(t);
  })();

  // ================= Job drawer =================
  let drawerEditing = false; // per-job field editor open in the drawer

  function renderDrawer() {
    const drawer = el("jobDrawer");
    const job = selectedJobId ? allJobs.find((j) => j.gotphoto_job_id === selectedJobId) : null;
    if (!job) { drawer.classList.add("hidden"); drawer.innerHTML = ""; drawerEditing = false; document.body.classList.remove("aca-sheet-open"); return; }
    const ex = explainJob(job);
    const res = resolveJobConfig(job);
    const pub = pubById.get(job.gotphoto_job_id);
    const groupCount = pub && Array.isArray(pub.group_options) ? pub.group_options.length : 0;
    const blockedByType = ex.pub && !ex.visible && ex.ov === "auto" && ex.rule && !ex.rule.allowed;
    const boxCls = ex.visible ? "good" : (ex.attention ? "bad" : "plain");

    const step = (cls, text, note, extra) =>
      '<div class="step"><span class="sdot ' + cls + '"></span><span class="stext">' + text +
      (note ? '<div class="snote">' + note + '</div>' : '') + '</span>' + (extra || '') + '</div>';
    const tri =
      '<span class="tri" role="group" aria-label="Visibility override">' +
        ['auto', 'show', 'hide'].map((s) => '<button data-state="' + s + '" aria-pressed="' + (ex.ov === s) + '">' + s[0].toUpperCase() + s.slice(1) + '</button>').join("") +
      '</span>';

    const fieldsHtml = res.fields.map((f) =>
      '<div class="fr"><span>' + esc(f.label) + (f.verify ? '' : '<span class="muted" style="font-size:12px"> · accepts anything</span>') + '</span><span class="src">' + esc(f.src) + '</span></div>').join("") +
      '<div class="fr"><span>Dropdown · "' + esc(res.groupLabel) + '"' +
        '<span class="muted" style="font-size:12px"> · ' + (groupCount > 1 ? groupCount + " values in this roster" : "hidden: 0–1 values in roster") + '</span></span><span class="src">' + esc(res.groupSrc) + '</span></div>' +
      '<div class="fr"><span>Dropdown shows · ' + esc(GROUP_DISPLAY_LABELS[res.groupDisplay]) + '</span><span class="src">' + esc(res.gdispSrc) + '</span></div>' +
      '<div class="fr"><span>Typo tolerance · ' + esc(res.allowErrors) + '</span><span class="src">' + esc(res.errSrc) + '</span></div>';

    const missingHtml = ex.missing && ex.pub
      ? '<div class="muted" style="font-size:12.5px;margin-top:8px;color:var(--warn-fg)">Required field' + (job.missing_fields.length > 1 ? 's' : '') + ' ' +
        job.missing_fields.map((m) => '<span class="pill warn">' + esc(m) + '</span>').join(" ") + ' missing for most of this roster — those parents cannot match.</div>'
      : '';
    const reqs = openRequests.filter((r) => r.gotphoto_job_id === job.gotphoto_job_id);

    drawer.innerHTML =
      '<div class="dhead"><div><div class="t">' + esc(job.name) + '</div>' +
        '<div class="mono muted">' + esc(job.job_type) + ' · ' + (job.status === "published" && job.gp_activated_at ? 'published ' + esc(fmtShort(job.gp_activated_at)) : (job.status === "created" ? "planning" : esc(job.status))) + ' · ' + esc(job.code_count == null ? 0 : job.code_count) + ' codes' +
        (job.shoot_at ? ' · shot ' + esc(new Date(job.shoot_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })) : '') + '</div>' +
        '<div class="muted hidden" style="font-size:12.5px;margin-top:2px" data-gplinks="' + esc(job.gotphoto_job_id) + '"></div></div>' +
        '<button class="small js-dclose" aria-label="Close"><span class="x" aria-hidden="true">&#10005;</span><span class="w">Close</span></button></div>' +

      '<div class="panelbox ' + boxCls + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><span class="th">On the website</span><span class="pill ' + ex.pill + '">' + esc(ex.state) + '</span></div>' +
        step(ex.pub ? "ok" : "bad", "Selling or planning in GotPhoto",
          ex.pub ? (job.status === "created" ? "in planning — findable before picture day" : "selling") : "no — it is " + esc(job.status) + "; move it to planning or selling and it appears here within 5 minutes") +
        step(ex.rule && ex.rule.allowed ? "ok" : "bad", 'Type <span class="mono">' + esc(job.job_type) + '</span> is switched on',
          ex.rule && ex.rule.allowed ? "yes" : (blockedByType
            ? "no — this is what's hiding it. Switching it on also affects every other " + esc(job.job_type) + " job."
            : (ex.rule ? "no — but the override below is deciding instead" : "no rule for this type yet")),
          blockedByType ? '<button class="small primary js-type-on" data-type="' + esc(job.job_type) + '">Switch on</button>' : '') +
        step(ex.ov === "auto" ? "ok" : "warn", "Per-job override",
          ex.ov === "auto" ? "Auto — following the type" : (ex.ov === "show" ? "Show — forced visible regardless of type" : "Hide — forced hidden regardless of type"),
          tri) +
      '</div>' +

      '<div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span class="th">What parents type to find it</span>' +
        '<span class="muted" style="font-size:12px">' + (job.field_config ? "custom for this job" : "inheriting from " + esc(res.inheritsFrom)) + '</span></div>' +
        '<div class="flist">' + fieldsHtml + '</div>' + missingHtml +
        '<div class="btnrow">' +
          '<button class="small js-customize">' + (job.field_config ? "Edit this job's fields" : "Customize for this job") + '</button>' +
          (res.cat ? '<button class="small js-edit-cat" data-cat="' + esc(res.cat.id) + '">Edit ' + esc(res.cat.name) + ' defaults →</button>' : '') +
          (ex.rule ? '<button class="small js-edit-type" data-type="' + esc(job.job_type) + '">Edit ' + esc(job.job_type) + ' →</button>' : '') +
        '</div>' +
        '<div id="aca-drawerEditor"></div>' +
      '</div>' +

      (!isSportJob(job) ? (function () {
        const bySearcher = !!job.child_limit_by_searcher;
        const ltri = '<span class="tri js-limit-tri" role="group" aria-label="Student limit counts per">' +
          [["ip", "Connection"], ["searcher", "Searcher"]].map(([v, l]) =>
            '<button data-limit="' + v + '" aria-pressed="' + ((v === "searcher") === bySearcher) + '">' + l + '</button>').join("") + '</span>';
        return '<div class="panelbox plain">' +
          '<div style="display:flex;justify-content:space-between;align-items:center"><span class="th">Student limit counts per</span>' +
            '<span class="pill ' + (bySearcher ? "warn" : "muted") + '">' + (bySearcher ? "Searcher" : "Connection") + '</span></div>' +
          step(bySearcher ? "warn" : "ok", bySearcher
              ? "Each searcher (by email) can find 3 different students a day"
              : "Each internet connection can find 3 different students a day",
            bySearcher
              ? "Families on shared Wi-Fi no longer block each other. Someone could get around it by changing their email, so switch back once the rush is over."
              : "Siblings never count. Switch to Searcher when many families search from one shared network (you get an email when 6+ people share one).", ltri) +
        '</div>';
      })() : '') +

      (isSportJob(job) ? (function () {
        const hw = hubWorkflow(job);
        const wtri = '<span class="tri js-wf-tri" role="group" aria-label="Sports hub workflow">' +
          [["auto", "Auto"], ["league", "Registered"], ["school", "Roster"]].map(([v, l]) =>
            '<button data-wf="' + v + '" aria-pressed="' + (hw.ov === v) + '">' + l + '</button>').join("") + '</span>';
        return '<div class="panelbox plain">' +
          '<div style="display:flex;justify-content:space-between;align-items:center"><span class="th">Sports Admin Hub copy</span>' +
            '<span class="pill ' + (hw.wf === "league" ? "ok" : "muted") + '">' + esc(WF_LABEL[hw.wf]) + '</span></div>' +
          step("ok", hw.wf === "league"
              ? "Families get their gallery link by email/text; Find My Photos is the backup"
              : "Families look their athlete up under Find My Photos",
            esc(hw.why) + ' · <a href="https://207photo.com/sportsadmin/#job=' + esc(job.gotphoto_job_id) + '" target="_blank" rel="noopener">open on the hub</a>', wtri) +
          '<div class="js-hub-dates" style="margin-top:10px"><span class="muted" style="font-size:12.5px">Loading picture dates…</span></div>' +
        '</div>';
      })() : '') +

      '<div><div class="th" style="margin-bottom:8px">Roster health</div><div class="js-health"><span class="pill muted">…</span></div></div>' +

      '<div><div class="th" style="margin-bottom:8px">Recent searches for this job</div><div class="js-searches minilist"><span class="muted" style="font-size:12.5px">Loading…</span></div></div>' +

      (reqs.length ? '<div><div class="th" style="margin-bottom:8px">Help requests from this job</div><div class="minilist">' +
        reqs.map((r) => '<div class="li" data-req="' + esc(r.id) + '"><span><b>' + esc(r.parent_email) + '</b><div class="muted" style="font-size:12px">' + blockedFlag(r) + esc(summarizeSearch(r.search_data)) + ' · ' + esc(fmtAgo(r.created_at)) + '</div></span><button class="small js-resolve-req" data-id="' + esc(r.id) + '">Resolve</button></div>').join("") +
        '</div></div>' : '');

    drawer.classList.remove("hidden");
    drawer.scrollTop = 0;
    document.body.classList.toggle("aca-sheet-open", window.matchMedia("(max-width: 900px)").matches);

    if (drawerEditing) openDrawerEditor(job);

    // Sports hub picture dates: confirmed (hub_dates) or the automatic suggestions. What the
    // client sees on /sportsadmin/ is decided here, never by the client.
    const datesBox = drawer.querySelector(".js-hub-dates");
    if (datesBox) fillHubDates(datesBox, job);
    fillJobLinks(drawer); // job page + partner when a booking has this GotPhoto job (ws/partners 2026-10-24)

    // Async fills: roster coverage + last searches.
    const healthBox = drawer.querySelector(".js-health");
    supabase.rpc("admin_job_field_coverage", { p_job_id: job.gotphoto_job_id }).then(({ data, error }) => {
      if (!healthBox.isConnected) return;
      if (error || !data || !data.total) { healthBox.innerHTML = '<span class="pill muted">no codes yet</span>'; return; }
      const keys = res.fields.map((f) => f.key).concat(groupCount > 1 ? ["group"] : []);
      healthBox.innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap">' + keys.map((k) => {
        const have = data[k] || 0; const pct = Math.round((have / data.total) * 100);
        const cls = have === 0 ? "err" : (pct < 50 ? "warn" : "ok");
        const label = k === "group" ? "team/class" : (MATCH_FIELD_OPTIONS.find((o) => o.key === k) || { label: k }).label.toLowerCase();
        return '<span class="pill ' + cls + '">' + esc(label) + ' ' + num(have) + ' of ' + num(data.total) + '</span>';
      }).join("") + (data.unassigned ? '<span class="pill muted" title="Spare codes in GotPhoto with no student attached (e.g. extra QR codes from picture day). Not counted above.">+ ' + data.unassigned + ' unassigned codes</span>' : '') + '</div>';
    });
    const sBox = drawer.querySelector(".js-searches");
    supabase.from("lookup_events").select("created_at, outcome, search")
      .eq("gotphoto_job_id", job.gotphoto_job_id).order("created_at", { ascending: false }).limit(8)
      .then(({ data, error }) => {
        if (!sBox.isConnected) return;
        if (error) { sBox.innerHTML = '<span class="muted" style="font-size:12.5px">Unavailable.</span>'; return; }
        if (!data || !data.length) { sBox.innerHTML = '<span class="muted" style="font-size:12.5px">No searches yet.</span>'; return; }
        sBox.innerHTML = data.map((e) => '<div class="li"><span class="muted" style="font-size:12.5px">' + esc(summarizeSearch(e.search) || "(shared gallery code)") +
          '<div style="font-size:11.5px">' + esc(fmtAgo(e.created_at)) + '</div></span>' + outcomePill(e.outcome) + '</div>').join("");
      });
  }

  const HUB_GENERIC = new Set(["fall","spring","summer","winter","sports","sport","photos","photo","picture","pictures","day","days","high","school","middle","elementary","ms","hs","the","of","and"]);
  // Same cleaning the hub applies to a calendar label: "BYF '26 Day 2: Flag - 6th" -> "Flag - 6th", "Fall Sports 26" -> "".
  function hubCleanLabel(v) {
    let t = String(v || "").replace(/[\u2018\u2019']?\d{2,4}(-\d{2,4})?/g, "").replace(/\s+/g, " ").trim();
    const hadColon = t.indexOf(":") !== -1;
    if (hadColon) t = t.slice(t.lastIndexOf(":") + 1).trim();
    const words = t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(" ").filter(Boolean);
    const generic = !hadColon && words.every((w) => HUB_GENERIC.has(w));
    return (generic || !words.length) ? "" : t.replace(/^[\s:\-\u2022]+|[\s:\-\u2022]+$/g, "");
  }
  function hubLongDate(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  function hubDateRow(r) {
    return '<div class="li" style="display:grid;grid-template-columns:auto 110px minmax(0,1fr);gap:8px;align-items:center;padding:6px 0">' +
      '<input type="checkbox" class="js-hd-on"' + (r.on ? ' checked' : '') + ' data-date="' + esc(r.date) + '" aria-label="Use this date">' +
      '<span class="mono" style="font-size:12.5px">' + esc(hubLongDate(r.date)) + '<div class="muted" style="font-size:11px">' + esc(r.src) + '</div></span>' +
      '<input type="text" class="small js-hd-label" value="' + esc(r.label) + '" placeholder="Who is photographed (e.g. flag football)" aria-label="Label" style="width:100%">' +
    '</div>';
  }
  async function fillHubDates(box, job) {
    const { data, error } = await supabase.from("sports_hub_jobs")
      .select("picture_day, hub_dates, calendar_dates").eq("gotphoto_job_id", job.gotphoto_job_id).maybeSingle();
    if (!box.isConnected) return;
    if (error) { box.innerHTML = '<span class="muted" style="font-size:12.5px">Dates unavailable: ' + esc(error.message) + '</span>'; return; }
    if (!data) { box.innerHTML = '<span class="muted" style="font-size:12.5px">Not on the hub (outside the 30-day-back / 180-day-ahead window).</span>'; return; }
    const confirmed = Array.isArray(data.hub_dates) && data.hub_dates.length ? data.hub_dates : null;
    const seen = new Set(); const rows = [];
    (data.calendar_dates || []).forEach((ev) => {
      const d = String(ev.date).slice(0, 10); if (seen.has(d)) return; seen.add(d);
      rows.push({ date: d, label: hubCleanLabel(ev.label), src: "schedule: " + String(ev.summary || "").slice(0, 40), on: !confirmed });
    });
    const pd = String(data.picture_day).slice(0, 10);
    if (!seen.has(pd)) { seen.add(pd); rows.push({ date: pd, label: "", src: "GotPhoto job date", on: !confirmed && rows.length === 0 }); }
    if (confirmed) {
      rows.forEach((r) => { r.on = false; });
      confirmed.forEach((c) => {
        const d = String(c.date).slice(0, 10);
        const hit = rows.find((r) => r.date === d);
        if (hit) { hit.on = true; hit.label = String(c.label || ""); }
        else rows.push({ date: d, label: String(c.label || ""), src: "added here", on: true });
      });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center"><span class="th" style="font-size:12px">Picture dates on the hub</span>' +
        '<span class="pill ' + (confirmed ? "ok" : "muted") + '">' + (confirmed ? "confirmed" : "automatic") + '</span></div>' +
      '<div class="minilist js-hd-rows">' + rows.map(hubDateRow).join("") + '</div>' +
      '<div style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">' +
        '<input type="date" class="small js-hd-new" aria-label="Add a date">' +
        '<button class="small js-hd-add">Add date</button>' +
        '<span style="flex:1"></span>' +
        (confirmed ? '<button class="small js-hd-auto">Back to automatic</button>' : '') +
        '<button class="small primary js-hd-save">Save dates</button>' +
      '</div>' +
      '<div class="muted" style="font-size:11.5px;margin-top:4px">Ticked dates and labels are what families see in the copy. Automatic = calendar matches, else the GotPhoto date.</div>';
  }

  function summarizeSearch(sd) {
    if (!sd || typeof sd !== "object") return "";
    return Object.keys(sd).filter((k) => sd[k] != null && String(sd[k]).trim() !== "")
      .map((k) => (Object.hasOwn(SEARCH_KEY_LABELS, k) ? SEARCH_KEY_LABELS[k] : k) + ' "' + String(sd[k]).trim() + '"').join(" · ");
  }
  function outcomePill(o) {
    if (o === "found") return '<span class="pill ok">Found</span>';
    if (o === "cooldown") return '<span class="pill err">Rate-limited</span>';
    if (o === "unknown_job") return '<span class="pill muted">Unknown job</span>';
    if (o === "blocked") return '<span class="pill err">Blocked</span>';
    if (o === "no_contact") return '<span class="pill err" title="School search without the searcher\'s name, email and phone">No contact info</span>';
    if (o === "unconfirmed") return '<span class="pill err" title="Searched without ticking the parent/guardian box">Unconfirmed</span>';
    if (o === "limit") return '<span class="pill err" title="4th different child from this address in this gallery today">Limit reached</span>';
    return '<span class="pill warn">Not found</span>';
  }

  function openDrawerEditor(job) {
    const host = el("drawerEditor");
    if (!host) return;
    const inh = inheritedForJob(job);
    const pub = pubById.get(job.gotphoto_job_id);
    const groupCount = pub && Array.isArray(pub.group_options) ? pub.group_options.length : 0;
    host.innerHTML = '<div class="fc-wrap" data-job="' + esc(job.gotphoto_job_id) + '" style="margin-top:10px">' + cfgEditorMarkup(job.field_config || {}, inh, {
      title: 'Search fields for <b>' + esc(job.name) + '</b>',
      subtitle: job.field_config ? "custom for this job" : "inheriting from " + esc(inh.source),
      showCoverage: true,
      resetLabel: "Reset to inherited defaults",
      extraNote: (groupCount > 1
        ? groupCount + " team/class values in this roster — dropdown is shown"
        : "0–1 team/class values — dropdown is hidden for this job"),
    }) + '</div>';
    fillCoverage(host, job.gotphoto_job_id);
  }

  el("jobDrawer").addEventListener("click", async (e) => {
    const job = selectedJobId ? allJobs.find((j) => j.gotphoto_job_id === selectedJobId) : null;
    if (!job) return;

    if (e.target.closest(".js-dclose")) { selectedJobId = null; drawerEditing = false; renderJobs(); renderDrawer(); return; }

    const onBtn = e.target.closest(".js-type-on");
    if (onBtn) {
      onBtn.disabled = true;
      const { error } = await supabase.from("job_type_rules").update({ allowed: true }).eq("job_type", onBtn.dataset.type);
      if (error) { onBtn.disabled = false; toast("Could not switch on " + onBtn.dataset.type + ": " + error.message, true); return; }
      toast(onBtn.dataset.type + " is now switched on.");
      await reloadRulesAndJobs();
      return;
    }

    const triBtn = e.target.closest(".tri button[data-state]");
    if (triBtn) {
      const state = triBtn.dataset.state;
      const newVal = state === "hide" ? true : (state === "show" ? false : null);
      triBtn.closest(".tri").querySelectorAll("button").forEach((b) => b.disabled = true);
      const { error } = await supabase.from("synced_jobs").update({ hide_override: newVal }).eq("gotphoto_job_id", job.gotphoto_job_id);
      if (error) { toast("Could not save: " + error.message, true); renderDrawer(); return; }
      job.hide_override = newVal;
      await refreshVisibility();
      renderJobs(); renderDrawer();
      toast("Visibility updated.");
      return;
    }

    const hdAdd = e.target.closest(".js-hd-add");
    if (hdAdd) {
      const box = hdAdd.closest(".js-hub-dates"); const inp = box.querySelector(".js-hd-new");
      const v = inp.value; if (!v) { inp.focus(); return; }
      if (box.querySelector('.js-hd-on[data-date="' + v + '"]')) { box.querySelector('.js-hd-on[data-date="' + v + '"]').checked = true; inp.value = ""; return; }
      const list = box.querySelector(".js-hd-rows");
      list.insertAdjacentHTML("beforeend", hubDateRow({ date: v, label: "", src: "added here", on: true }));
      inp.value = "";
      return;
    }
    const hdSave = e.target.closest(".js-hd-save");
    if (hdSave) {
      const box = hdSave.closest(".js-hub-dates");
      const rows = Array.from(box.querySelectorAll(".js-hd-rows .li")).filter((li) => li.querySelector(".js-hd-on").checked)
        .map((li) => ({ date: li.querySelector(".js-hd-on").dataset.date, label: li.querySelector(".js-hd-label").value.trim() }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (!rows.length) { toast("Tick at least one date, or use Back to automatic.", true); return; }
      hdSave.disabled = true;
      const { error } = await supabase.from("synced_jobs").update({ hub_dates: rows }).eq("gotphoto_job_id", job.gotphoto_job_id);
      if (error) { hdSave.disabled = false; toast("Could not save dates: " + error.message, true); return; }
      job.hub_dates = rows;
      toast("Picture dates saved for the hub.");
      fillHubDates(box, job);
      return;
    }
    const hdAuto = e.target.closest(".js-hd-auto");
    if (hdAuto) {
      const box = hdAuto.closest(".js-hub-dates");
      hdAuto.disabled = true;
      const { error } = await supabase.from("synced_jobs").update({ hub_dates: null }).eq("gotphoto_job_id", job.gotphoto_job_id);
      if (error) { hdAuto.disabled = false; toast("Could not reset dates: " + error.message, true); return; }
      job.hub_dates = null;
      toast("Dates back to automatic.");
      fillHubDates(box, job);
      return;
    }

    const limBtn = e.target.closest(".js-limit-tri button");
    if (limBtn) {
      const newVal = limBtn.dataset.limit === "searcher";
      limBtn.closest(".tri").querySelectorAll("button").forEach((b) => b.disabled = true);
      const { error } = await supabase.from("synced_jobs").update({ child_limit_by_searcher: newVal }).eq("gotphoto_job_id", job.gotphoto_job_id);
      if (error) { toast("Could not save: " + error.message, true); renderDrawer(); return; }
      job.child_limit_by_searcher = newVal;
      renderDrawer();
      toast("Student limit now counts per " + (newVal ? "searcher." : "connection."));
      return;
    }

    const wfBtn = e.target.closest(".js-wf-tri button");
    if (wfBtn) {
      const v = wfBtn.dataset.wf;
      const newVal = v === "auto" ? null : v;
      wfBtn.closest(".tri").querySelectorAll("button").forEach((b) => b.disabled = true);
      const { error } = await supabase.from("synced_jobs").update({ comm_workflow: newVal }).eq("gotphoto_job_id", job.gotphoto_job_id);
      if (error) { toast("Could not save: " + error.message, true); renderDrawer(); return; }
      job.comm_workflow = newVal;
      renderDrawer();
      toast("Sports hub copy: " + (newVal ? WF_LABEL[newVal] : "automatic") + ".");
      return;
    }

    if (e.target.closest(".js-customize")) {
      drawerEditing = !drawerEditing;
      if (drawerEditing) openDrawerEditor(job); else el("drawerEditor").innerHTML = "";
      return;
    }
    const editCat = e.target.closest(".js-edit-cat");
    if (editCat) { openSettingsAt({ cat: editCat.dataset.cat }); return; }
    const editType = e.target.closest(".js-edit-type");
    if (editType) { openSettingsAt({ type: editType.dataset.type }); return; }

    const resolveBtn = e.target.closest(".js-resolve-req");
    if (resolveBtn) { await resolveRequest(resolveBtn.dataset.id, resolveBtn); return; }

    // Per-job field editor actions.
    const saveBtn = e.target.closest(".fc-save");
    const resetBtn = e.target.closest(".fc-reset");
    const cancelBtn = e.target.closest(".fc-cancel");
    if (!saveBtn && !resetBtn && !cancelBtn) return;
    const ed = e.target.closest(".fc-wrap[data-job]");
    if (!ed) return;
    if (cancelBtn) { drawerEditing = false; el("drawerEditor").innerHTML = ""; return; }
    const msg = ed.querySelector(".fc-msg");
    let newConfig = null;
    if (saveBtn) {
      const res = collectCfg(ed, inheritedForJob(job));
      if (res.error) { msg.className = "row-msg fc-msg err"; msg.textContent = res.error; return; }
      newConfig = res.config;
    }
    ed.querySelectorAll("button").forEach((b) => b.disabled = true);
    msg.className = "row-msg fc-msg"; msg.textContent = "Saving…";
    const { error } = await supabase.from("synced_jobs").update({ field_config: newConfig }).eq("gotphoto_job_id", job.gotphoto_job_id);
    ed.querySelectorAll("button").forEach((b) => b.disabled = false);
    if (error) { msg.className = "row-msg fc-msg err"; msg.textContent = error.message; toast("Could not save fields: " + error.message, true); return; }
    job.field_config = newConfig;
    drawerEditing = false;
    toast(newConfig ? "Search fields saved for this job." : "Job reset to inherited defaults.");
    await refreshVisibility();
    renderJobs(); renderDrawer();
  });

  // ================= Search settings (tree) =================
  let collapsedCats = new Set();   // expanded by default; remember what the user folds
  let editingCat = null;
  let editingType = null;

  function openSettingsAt(target) {
    if (target.cat) {
      editingCat = target.cat; editingType = null; collapsedCats.delete(target.cat);
    } else if (target.type) {
      const rule = rulesByType.get(target.type);
      editingType = target.type; editingCat = null;
      if (rule && rule.category_id) collapsedCats.delete(rule.category_id);
    }
    showTab("settings");
    renderSettings();
    const node = el("settingsTree").querySelector(".fc-wrap");
    if (node && node.scrollIntoView) node.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function typeStats(jobType) {
    let jobs = 0, published = 0, hiddenPub = 0;
    allJobs.forEach((j) => {
      if (j.job_type !== jobType) return;
      jobs++;
      if (j.status === "published") published++;
      if (j.status === "published" && !visibleIds.has(j.gotphoto_job_id) && jobOverrideState(j.hide_override) === "auto") hiddenPub++;
    });
    return { jobs, published, hiddenPub };
  }

  function fieldsSummary(cfg) {
    const inh = cascade([cfg]);
    return inh.keys.map((k) => inh.label(k)).join(" · ") + ' · dropdown "' + inh.groupLabel + '"';
  }

  function catSelect(rule) {
    return '<select class="small js-cat-select" data-type="' + esc(rule.job_type) + '" aria-label="Category">' +
      '<option value="">No category</option>' +
      categoriesList.map((c) => '<option value="' + esc(c.id) + '"' + (rule.category_id === c.id ? " selected" : "") + '>' + esc(c.name) + '</option>').join("") +
      '</select>';
  }

  function typeRowHtml(rule) {
    const st = typeStats(rule.job_type);
    const on = !!rule.allowed;
    const warn = !on && st.hiddenPub > 0;
    const cat = rule.category_id ? categoriesById.get(rule.category_id) : null;
    const note = warn ? "⚠ " + st.hiddenPub + " published job" + (st.hiddenPub > 1 ? "s" : "") + " hidden"
      : (rule.config_override ? "custom fields for this type" : (cat ? "inherits " + cat.name : "inherits global defaults"));
    return '<div class="trow type' + (warn ? ' warn' : '') + '" data-type="' + esc(rule.job_type) + '">' +
      '<span style="display:flex;align-items:center;gap:10px"><span class="mono">' + esc(rule.job_type) + '</span>' +
        (rule.config_override ? '<span class="pill warn">Custom</span>' : '') + '</span>' +
      '<span class="sub"' + (warn ? ' style="color:var(--warn-fg)"' : '') + '>' + esc(note) + '</span>' +
      '<span class="ctl"><span class="sw' + (on ? ' on' : '') + ' js-sw" role="switch" aria-checked="' + on + '" data-type="' + esc(rule.job_type) + '" title="' + (on ? "Findable — click to hide" : "Hidden — click to make findable") + '"><span class="knob"></span></span>' +
        '<span class="stlabel" style="color:' + (on ? 'var(--ok-fg)' : 'var(--muted)') + '">' + (on ? "Findable" : "Hidden") + '</span>' +
        '<span class="lnk js-type-jobs" data-type="' + esc(rule.job_type) + '" style="font-size:12.5px">' + st.jobs + ' job' + (st.jobs === 1 ? '' : 's') + ' →</span></span>' +
      '<span class="acts">' + catSelect(rule) +
        (rule.job_type.indexOf("sport") === 0
          ? '<select class="small js-wf-select" data-type="' + esc(rule.job_type) + '" aria-label="Sports hub copy" title="Which copy the Sports Admin Hub gives jobs of this type">' +
              '<option value="school"' + (rule.comm_workflow === "league" ? "" : " selected") + '>Hub: roster only</option>' +
              '<option value="league"' + (rule.comm_workflow === "league" ? " selected" : "") + '>Hub: registered families</option></select>'
          : '') +
        '<button class="small js-type-fields" data-type="' + esc(rule.job_type) + '">Fields</button></span>' +
    '</div>' +
    (editingType === rule.job_type ? '<div class="fc-wrap" data-type="' + esc(rule.job_type) + '">' + cfgEditorMarkup(rule.config_override || {}, cascade([cat && cat.config]), {
      title: 'Fields for type <b>' + esc(rule.job_type) + '</b>',
      subtitle: rule.config_override ? "custom for this type" : (cat ? "inheriting from category '" + esc(cat.name) + "'" : "no category — global defaults"),
      showCoverage: false,
      resetLabel: "Reset to category defaults",
    }) + '</div>' : '');
  }

  function renderSettings() {
    const tree = el("settingsTree");
    if (!catsLoaded || !rulesLoaded) return;
    const rules = Array.from(rulesByType.values());
    const groups = categoriesList.map((c) => ({ cat: c, id: c.id, types: rules.filter((r) => r.category_id === c.id) }));
    const orphans = rules.filter((r) => !r.category_id || !categoriesById.has(r.category_id));
    if (orphans.length) groups.push({ cat: null, id: "__none", types: orphans });

    let html = '<div class="trow global"><span>Global defaults</span>' +
      '<span class="sub">First name · Last name · dropdown "Team / class" · typo tolerance 1</span>' +
      '<span class="sub">built in — applies where nothing else does</span><span></span></div>';

    html += groups.map((g) => {
      const expanded = !collapsedCats.has(g.id);
      const hidingTypes = g.types.filter((r) => !r.allowed && typeStats(r.job_type).hiddenPub > 0).length;
      const jobCount = g.cat ? allJobs.filter((j) => { const c = catForType(j.job_type); return c && c.id === g.cat.id; }).length
                             : allJobs.filter((j) => !catForType(j.job_type)).length;
      const onCount = g.types.filter((r) => r.allowed).length;
      const head = g.cat
        ? '<div class="trow cat' + (editingCat === g.cat.id ? ' editing' : '') + '" data-cat="' + esc(g.cat.id) + '">' +
            '<span class="catname js-cat-toggle" data-cat="' + esc(g.cat.id) + '"><span class="caret">' + (expanded ? "▾" : "▸") + '</span>' + esc(g.cat.name) +
              '<span class="pill muted">' + esc(g.cat.display_label) + '</span>' +
              (hidingTypes ? '<span class="pill warn">' + hidingTypes + ' type' + (hidingTypes > 1 ? 's' : '') + ' hiding jobs</span>' : '') + '</span>' +
            '<span class="sub">' + esc(fieldsSummary(g.cat.config || {})) + '</span>' +
            '<span class="sub">' + onCount + ' of ' + g.types.length + ' types on · <span class="lnk js-cat-jobs" data-cat="' + esc(g.cat.id) + '">' + jobCount + ' jobs →</span></span>' +
            '<span class="acts"><button class="small js-cat-edit" data-cat="' + esc(g.cat.id) + '">Edit</button><button class="small js-cat-del" data-cat="' + esc(g.cat.id) + '">Delete</button></span>' +
          '</div>' +
          (editingCat === g.cat.id ? '<div class="fc-wrap" data-cat="' + esc(g.cat.id) + '">' + cfgEditorMarkup(g.cat.config || {}, cascade([]), {
            title: 'Defaults for category <b>' + esc(g.cat.name) + '</b>',
            subtitle: "blank fields fall back to the global defaults",
            showCoverage: false, nameValue: g.cat.name, chipValue: g.cat.display_label,
            resetLabel: "Reset to global defaults",
          }) + '</div>' : '')
        : '<div class="trow cat" data-cat="__none"><span class="catname js-cat-toggle" data-cat="__none"><span class="caret">' + (expanded ? "▾" : "▸") + '</span>Not in a category</span>' +
            '<span class="sub">inherit global defaults</span><span class="sub">' + onCount + ' of ' + g.types.length + ' types on</span><span></span></div>';
      return head + (expanded ? g.types.map(typeRowHtml).join("") : "");
    }).join("");

    tree.innerHTML = html;
  }

  el("addCatBtn").addEventListener("click", async () => {
    const name = el("newCatName").value.trim();
    if (!name) { toast("Enter a category name first.", true); return; }
    const { error } = await supabase.from("job_categories").insert({ name });
    if (error) { toast("Could not add category: " + error.message, true); return; }
    el("newCatName").value = "";
    toast("Category '" + name + "' added.");
    await loadCategories();
    renderSettings();
  });

  el("settingsTree").addEventListener("change", async (e) => {
    const wfSel = e.target.closest(".js-wf-select");
    if (wfSel) {
      const jobType = wfSel.dataset.type;
      wfSel.disabled = true;
      const { error } = await supabase.from("job_type_rules").update({ comm_workflow: wfSel.value }).eq("job_type", jobType);
      if (error) { wfSel.disabled = false; toast("Could not update " + jobType + ": " + error.message, true); return; }
      toast(jobType + " jobs now get the " + (wfSel.value === "league" ? "registered-families" : "roster-only") + " copy on the sports hub.");
      await reloadRulesAndJobs();
      return;
    }
    const sel = e.target.closest(".js-cat-select");
    if (!sel) return;
    const jobType = sel.dataset.type;
    const category_id = sel.value || null;
    sel.disabled = true;
    const { error } = await supabase.from("job_type_rules").update({ category_id }).eq("job_type", jobType);
    if (error) { sel.disabled = false; toast("Could not move " + jobType + ": " + error.message, true); return; }
    toast(jobType + (category_id ? " moved to " + categoriesById.get(category_id).name + "." : " removed from its category."));
    await reloadRulesAndJobs();
  });

  el("settingsTree").addEventListener("click", async (e) => {
    const toggle = e.target.closest(".js-cat-toggle");
    if (toggle) {
      const id = toggle.dataset.cat;
      if (collapsedCats.has(id)) collapsedCats.delete(id); else collapsedCats.add(id);
      renderSettings(); return;
    }
    const sw = e.target.closest(".js-sw");
    if (sw) {
      const jobType = sw.dataset.type;
      const rule = rulesByType.get(jobType);
      if (!rule) return;
      sw.classList.add("busy");
      const { error } = await supabase.from("job_type_rules").update({ allowed: !rule.allowed }).eq("job_type", jobType);
      if (error) { sw.classList.remove("busy"); toast("Could not update " + jobType + ": " + error.message, true); return; }
      toast(jobType + (rule.allowed ? " is now hidden." : " is now findable."));
      await reloadRulesAndJobs();
      return;
    }
    const catJobs = e.target.closest(".js-cat-jobs");
    if (catJobs) { showJobsFor({ cat: catJobs.dataset.cat }, { select: null }); return; }
    const typeJobs = e.target.closest(".js-type-jobs");
    if (typeJobs) { showJobsFor({ type: typeJobs.dataset.type }, { select: null }); return; }

    const catEdit = e.target.closest(".js-cat-edit");
    if (catEdit) { editingCat = editingCat === catEdit.dataset.cat ? null : catEdit.dataset.cat; editingType = null; collapsedCats.delete(catEdit.dataset.cat); renderSettings(); return; }
    const typeFields = e.target.closest(".js-type-fields");
    if (typeFields) { editingType = editingType === typeFields.dataset.type ? null : typeFields.dataset.type; editingCat = null; renderSettings(); return; }

    const catDel = e.target.closest(".js-cat-del");
    if (catDel) {
      const cat = categoriesById.get(catDel.dataset.cat);
      if (!cat) return;
      const assigned = Array.from(rulesByType.values()).filter((r) => r.category_id === cat.id).length;
      const warning = assigned > 0
        ? assigned + " job type(s) are assigned to it and will revert to global defaults."
        : "No job types are assigned to it.";
      if (!confirm('Delete category "' + cat.name + '"? ' + warning)) return;
      const { error } = await supabase.from("job_categories").delete().eq("id", cat.id);
      if (error) { toast("Could not delete: " + error.message, true); return; }
      toast("Category '" + cat.name + "' deleted.");
      await reloadRulesAndJobs();
      return;
    }

    // Inline editor actions (category or type).
    const saveBtn = e.target.closest(".fc-save");
    const resetBtn = e.target.closest(".fc-reset");
    const cancelBtn = e.target.closest(".fc-cancel");
    if (!saveBtn && !resetBtn && !cancelBtn) return;
    const ed = e.target.closest(".fc-wrap");
    if (!ed) return;
    if (cancelBtn) { editingCat = null; editingType = null; renderSettings(); return; }
    const msg = ed.querySelector(".fc-msg");
    const busy = (on) => ed.querySelectorAll("button").forEach((b) => b.disabled = on);

    if (ed.dataset.cat) {
      const cat = categoriesById.get(ed.dataset.cat);
      if (!cat) return;
      let payload;
      if (saveBtn) {
        const res = collectCfg(ed, cascade([]));
        if (res.error) { msg.className = "row-msg fc-msg err"; msg.textContent = res.error; return; }
        payload = {
          name: (ed.querySelector(".fc-name").value.trim() || cat.name),
          display_label: (ed.querySelector(".fc-chip").value.trim() || "Event"),
          config: res.config || {},
        };
      } else {
        payload = { config: {} }; // reset config only; keep name + chip
      }
      busy(true); msg.className = "row-msg fc-msg"; msg.textContent = "Saving…";
      const { error } = await supabase.from("job_categories").update(payload).eq("id", cat.id);
      if (error) { busy(false); msg.className = "row-msg fc-msg err"; msg.textContent = error.message; toast("Could not save category: " + error.message, true); return; }
      toast("Category saved.");
      editingCat = null;
      await reloadRulesAndJobs();
      return;
    }

    if (ed.dataset.type) {
      const jobType = ed.dataset.type;
      const rule = rulesByType.get(jobType) || {};
      const cat = rule.category_id ? categoriesById.get(rule.category_id) : null;
      let newOverride = null;
      if (saveBtn) {
        const res = collectCfg(ed, cascade([cat && cat.config]));
        if (res.error) { msg.className = "row-msg fc-msg err"; msg.textContent = res.error; return; }
        newOverride = res.config;
      }
      busy(true); msg.className = "row-msg fc-msg"; msg.textContent = "Saving…";
      const { error } = await supabase.from("job_type_rules").update({ config_override: newOverride }).eq("job_type", jobType);
      if (error) { busy(false); msg.className = "row-msg fc-msg err"; msg.textContent = error.message; toast("Could not save type fields: " + error.message, true); return; }
      toast(newOverride ? "Fields saved for type " + jobType + "." : "Type " + jobType + " reset to category defaults.");
      editingType = null;
      await reloadRulesAndJobs();
    }
  });

  // ================= Blocked names (lookup_blocks) =================
  // A block hides one child from the public name lookup (migration 20260912T08): the matcher
  // skips roster rows whose exact name is blocked, so the parent sees "not found". Here we list
  // the blocks with how many roster rows each one really hits, and flag any pending help request
  // whose typed name is a block (the alert email carries the same warning, server-side).
  let blocksList = [];

  function normName(v) { return String(v == null ? "" : v).trim().toLowerCase(); }
  // Levenshtein <= 1: the same tolerance the widget's fuzzy match uses, so a typo'd help
  // request for a blocked child is still flagged.
  function within1(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, jj = 0, edits = 0;
    while (i < la && jj < lb) {
      if (a[i] === b[jj]) { i++; jj++; continue; }
      if (++edits > 1) return false;
      if (la > lb) i++; else if (lb > la) jj++; else { i++; jj++; }
    }
    return edits + (la - i) + (lb - jj) <= 1;
  }
  function blocksForRequest(r) {
    const sd = r && r.search_data && typeof r.search_data === "object" ? r.search_data : {};
    const f = normName(sd.first_name), l = normName(sd.last_name);
    if (!f || !l) return [];
    return blocksList.filter((b) =>
      (!b.gotphoto_job_id || b.gotphoto_job_id === r.gotphoto_job_id) &&
      within1(normName(b.first_name), f) && within1(normName(b.last_name), l));
  }
  function blockedFlag(r) {
    return blocksForRequest(r).length
      ? '<span class="pill err" title="This name is on the Blocked names list. Verify who is asking before sharing anything — never email the code back.">Blocked name — do not send the code</span> '
      : '';
  }

  async function loadBlocks() {
    clearError("blocksError");
    const { data, error } = await supabase.rpc("admin_lookup_blocks");
    if (error) {
      showError("blocksError", "Could not load blocked names: " + error.message);
      el("blocksBody").innerHTML = '<tr><td colspan="6" class="empty">Unavailable.</td></tr>';
      return;
    }
    blocksList = Array.isArray(data) ? data : [];
    renderBlocks();
    renderRequests(); // request rows carry the blocked-name flag
    renderDrawer();
  }

  function renderBlockJobOptions() {
    const sel = el("newBlockJob");
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = '<option value="">All jobs (recommended)</option>' +
      allJobs.map((jb) => '<option value="' + esc(jb.gotphoto_job_id) + '">' + esc(jb.name || jb.gotphoto_job_id) + '</option>').join("");
    sel.value = keep;
  }

  function renderBlocks() {
    const body = el("blocksBody");
    const badge = el("blockBadge");
    const n = blocksList.length;
    el("blockCount").textContent = n === 0 ? "" : n + (n === 1 ? " name" : " names") + " blocked";
    if (n) { badge.textContent = n; badge.classList.remove("hidden"); } else badge.classList.add("hidden");
    if (n === 0) {
      body.innerHTML = '<tr><td colspan="6" class="empty">No blocked names. Add one above when a parent asks that their child not be findable by name.</td></tr>';
      return;
    }
    body.innerHTML = blocksList.map((b) => {
      const scope = b.gotphoto_job_id
        ? '<span class="lnk js-open-job" data-job="' + esc(b.gotphoto_job_id) + '">' + esc(b.job_name || b.gotphoto_job_id) + '</span> <span class="muted" style="font-size:12px">only</span>'
        : '<span class="pill accent">All jobs</span>';
      const hits = b.roster_matches | 0;
      const jobs = Array.isArray(b.matched_jobs) ? b.matched_jobs : [];
      const roster = hits === 0
        ? '<span class="pill warn" title="No roster row has exactly this name, so the block is not hiding anyone yet. Check the spelling against GotPhoto.">Not on any roster</span>'
        : '<span class="pill ok">' + hits + (hits === 1 ? " entry" : " entries") + '</span> <span class="muted" style="font-size:12px">' +
          jobs.map((jb) => '<span class="lnk js-open-job" data-job="' + esc(jb.id) + '">' + esc(jb.name || jb.id) + '</span>').join(", ") + '</span>';
      return '<tr data-block="' + esc(b.id) + '">' +
        '<td class="name">' + esc(b.first_name) + ' ' + esc(b.last_name) + '</td>' +
        '<td>' + scope + '</td>' +
        '<td>' + roster + '</td>' +
        '<td class="muted">' + esc(b.note || "") + '</td>' +
        '<td class="muted">' + fmtDate(b.created_at) + (b.created_by ? '<div class="mono" style="font-size:11.5px">' + esc(b.created_by) + '</div>' : '') + '</td>' +
        '<td><button class="small js-b-del">Unblock</button></td>' +
        '</tr>';
    }).join("");
  }

  el("addBlockBtn").addEventListener("click", async () => {
    const first_name = el("newBlockFirst").value.trim();
    const last_name = el("newBlockLast").value.trim();
    const gotphoto_job_id = el("newBlockJob").value || null;
    const note = el("newBlockNote").value.trim() || null;
    if (!first_name || !last_name) { toast("First and last name are both required.", true); return; }
    const btn = el("addBlockBtn");
    btn.disabled = true;
    const { error } = await supabase.from("lookup_blocks").insert({ first_name, last_name, gotphoto_job_id, note });
    btn.disabled = false;
    if (error) {
      toast(error.code === "23505" ? "That name is already blocked for that scope." : "Could not block name: " + error.message, true);
      return;
    }
    ["newBlockFirst", "newBlockLast", "newBlockNote"].forEach((id) => { el(id).value = ""; });
    el("newBlockJob").value = "";
    toast('"' + first_name + " " + last_name + '" is now hidden from the name lookup.');
    loadBlocks();
  });

  el("blocksBody").addEventListener("click", async (e) => {
    const open = e.target.closest(".js-open-job");
    if (open) { showJobsFor({}, { select: open.dataset.job }); return; }
    const del = e.target.closest(".js-b-del");
    if (!del) return;
    const row = e.target.closest("tr[data-block]");
    if (!row) return;
    const b = blocksList.find((x) => x.id === row.dataset.block);
    const label = b ? b.first_name + " " + b.last_name : "this name";
    if (!confirm('Unblock "' + label + '"? Parents will be able to find this child\'s code by name again.')) return;
    del.disabled = true;
    const { error } = await supabase.from("lookup_blocks").delete().eq("id", row.dataset.block);
    if (error) { del.disabled = false; toast("Could not unblock: " + error.message, true); return; }
    toast('"' + label + '" unblocked.');
    loadBlocks();
  });

