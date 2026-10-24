  // ================================================================ TEAM (2026-10-21)
  // People and what they can see. Full-access people add teammates and choose None / View / Edit per
  // module (public.app_modules). Accounts are created by the `team` edge function (it needs the service
  // key); everything else is SQL: team_list / team_save / team_audit_list, all checked with is_admin()
  // and logged in team_audit. This file is also the example for new modules: one registerPage() call,
  // one panel in a src/*.html partial, one IIFE holding the page's state.
  // One person record (ws/settings 2026-10-24): access presets by employment type, the access grid folded under
  // "Change access" with "Copy access from", rows named and grouped like the menu (modules with no page hidden),
  // Longest drive and Pay (the person's own timeclock_rates row) on the same form; the list shows type and roles.
  registerPage({ id: "team", group: "System", section: "system", module: "team", tabs: [["team", "Team"]], onShow: () => Team.load() });

  const Team = (function () {
    const tmCss = document.createElement("style");
    tmCss.textContent = ".aca .tm-acc { margin: 0 0 8px; font-size: 13.5px; } .aca .tm-presets { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 10px; font-size: 13px; }" +
      " .aca .tm-sub { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }" +
      " .aca .tm-role { display: inline-block; font-size: 11.5px; font-weight: 500; padding: 1px 8px; border: 1px solid var(--border); border-radius: 999px; vertical-align: 1px; }" +
      " .aca .tm-accsum > summary { cursor: pointer; list-style: none; } .aca .tm-accsum > summary::-webkit-details-marker { display: none; }" +
      " .aca .tm-accsum > summary::after { content: \"Show\"; margin-left: 6px; font-size: 12.5px; color: var(--muted); text-decoration: underline; } .aca .tm-accsum[open] > summary::after { content: \"Hide\"; }" +
      " .aca .tm-accsum > div { margin-top: 6px; font-size: 13px; line-height: 20px; }" +
      " .aca .tm-logcard > summary { cursor: pointer; display: flex; align-items: baseline; gap: 8px; } .aca .tm-logcard > summary h2 { display: inline; margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; color: var(--head); }" +
      " .aca .tm-logcard > summary { list-style: none; } .aca .tm-logcard > summary::-webkit-details-marker { display: none; }" +
      " .aca .tm-logcard > summary::after { content: \"Show\"; margin-left: auto; font-size: 13px; color: var(--muted); text-decoration: underline; } .aca .tm-logcard[open] > summary::after { content: \"Hide\"; }" +
      " .aca .tm-logcard[open] > summary { margin-bottom: 4px; }" +
      " .aca .tm-log li .muted.tm-also { font-size: 12.5px; } .aca .tm-older { margin-top: 8px; }" +
      " .aca #aca-tmMore > summary { cursor: pointer; font-weight: 600; font-size: 13.5px; margin: 4px 0 8px; } .aca .tm-copy { margin: 4px 0 10px; font-size: 13px; }";
    document.head.appendChild(tmCss);
    const TEAM_FN_URL = SUPABASE_URL + "/functions/v1/team";
    let modules = [], people = [];
    const LEVEL_WORD = { view: "view", edit: "edit" };

    async function teamFn(body) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { location.reload(); throw new Error("Signed out."); }
      const r = await fetch(TEAM_FN_URL, { method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || "HTTP " + r.status);
      return j;
    }

    async function load() {
      clearError("teamErr");
      try {
        const [m, p] = await Promise.all([
          supabase.from("app_modules").select("key,label,section,description,sort,status,admin_only").order("sort"),
          supabase.rpc("team_list"),
        ]);
        if (m.error) throw m.error;
        if (p.error) throw p.error;
        modules = (m.data || []).filter((x) => !x.admin_only);
        people = p.data || [];
        // Crew roles (crew.js): what each person can do on a job. Optional, so the page still works without them.
        const cr = await supabase.rpc("crew_roles_list");
        crewRoles = cr.error || !cr.data ? { roles: [], members: {} } : cr.data;
        render();
      } catch (e) {
        showError("teamErr", "Could not load the team: " + (e.message || e));
        el("teamBody").innerHTML = '<tr><td colspan="5" class="empty">Unavailable.</td></tr>';
      }
      loadLog();
    }

    // Employment type (2026-10-23): Part time and 1099 get Open jobs offers; Salaried and 1099 get no overtime.
    const TYPES = [["full_time", "Full time"], ["salaried", "Salaried"], ["part_time", "Part time"], ["contractor", "1099 contractor"]];
    const typeLabel = (t) => (TYPES.find((x) => x[0] === t) || [null, ""])[1];
    const rolesOf = (uid) => ((crewRoles.members || {})[uid] || []).map((id) => ((crewRoles.roles || []).find((r) => r.id === id) || {}).label).filter(Boolean);

    // Access presets. Part time and 1099 people get My day, Time clock, My records and Open jobs (all view); the
    // database gives the same when their type is set (migration 20261024020000). Office is a starting point.
    const PHOTO = { assignments: "view", timeclock: "view", staffrecords: "view", openjobs: "view" };
    const PRESETS = [["contractor", "1099 photographer", PHOTO], ["part_time", "Part-time photographer", PHOTO],
      ["office", "Office", { bookings: "edit", parents: "edit", partners: "view", agreements: "view", scheduling: "edit", timeoff: "view", openjobs: "view", assignments: "edit",
                             workflows: "edit", timeclock: "view", staffrecords: "view", inventory: "view", emails: "view", galleries: "view", hub: "view" }],
      ["admin", "Admin (full access)", null]];
    const presetFor = (type) => (type === "part_time" ? "part_time" : type === "contractor" ? "contractor" : type === "full_time" || type === "salaried" ? "office" : null);

    // The menu's words for each module: [group, "Tab, Tab"]. Modules on no page (no menu tab) are left out of the grid.
    function menuWords() {
      const out = {};
      MENU.forEach(([group, entries]) => entries.forEach(([, title, specs]) => specs.map(parseSpec).forEach((sp) => {
        const it = itemOf(sp.tab); if (!it || it.hidden) return;
        const mod = sp.module || it.module; if (!mod) return;
        const label = sp.label || (it.tabs.find((t) => t[0] === sp.tab) || [])[1] || title;
        const o = out[mod] || (out[mod] = { group: null, words: [] });
        if (!o.group || (o.group === "My work" && group !== "My work")) o.group = group || "Today";
        if (!o.words.includes(label)) o.words.push(label);
      })));
      RAIL.forEach((it) => { if (it.hidden || !it.module || out[it.module]) return; out[it.module] = { group: (it.group || "Other").replace("Outreach", "Partners"), words: it.tabs.map((t) => t[1]) }; });
      return out;
    }

    // The list shows a short summary (the preset it matches, or Custom, and how many areas); the full list folds open.
    function accessText(p) {
      if (p.is_admin) return "<b>Full access</b>";
      const mine = modules.filter((m) => p.modules[m.key]);
      if (!mine.length) return '<span class="muted">Nothing yet</span>';
      const same = (o) => Object.keys(o).length === mine.length && mine.every((m) => o[m.key] === p.modules[m.key]);
      const preset = PRESETS.find((x) => x[2] && same(x[2]));
      const edits = mine.filter((m) => p.modules[m.key] === "edit").length;
      const parts = mine.map((m) => esc(m.label) + ' <span class="muted">(' + LEVEL_WORD[p.modules[m.key]] + ")</span>");
      return '<details class="tm-accsum"><summary><b>' + esc(preset ? preset[1] : "Custom") + '</b> <span class="muted">&middot; ' + mine.length + (mine.length === 1 ? " area" : " areas") +
        (edits ? ", " + edits + " can edit" : ", view only") + "</span></summary><div>" + parts.join(", ") + "</div></details>";
    }

    function render() {
      el("teamBody").innerHTML = people.length ? people.map((p) =>
        "<tr" + (p.active ? "" : ' class="muted"') + '><td class="name">' + esc(p.name || p.email) + (p.is_me ? ' <span class="muted">(you)</span>' : "") +
          rolesOf(p.user_id).map((r) => ' <span class="tm-role">' + esc(r) + "</span>").join("") +
        '<div class="muted tm-sub">' + [p.job_title, typeLabel(p.employment_type), p.weekly_hours != null ? Number(p.weekly_hours) + " h/week" : ""].filter(Boolean).map(esc).join(" &middot; ") + "</div>" +
        '<div class="muted tm-sub">' + esc(p.email) + "</div></td>" +
        "<td>" + accessText(p) + "</td>" +
        "<td>" + esc(p.last_sign_in_at ? fmtAgo(p.last_sign_in_at) : "never") + "</td>" +
        "<td>" + (!p.active ? '<span class="pill muted">Deactivated</span>' : p.must_change_password ? '<span class="pill warn">Temporary password</span>' : '<span class="pill ok">Active</span>') + "</td>" +
        '<td><button type="button" class="small" data-edit="' + esc(p.user_id) + '">Edit</button></td></tr>').join("")
        : '<tr><td colspan="5" class="empty">Nobody yet.</td></tr>';
    }
    el("teamBody").addEventListener("click", (e) => { const b = e.target.closest("[data-edit]"); if (b) openEditor(people.find((p) => p.user_id === b.dataset.edit)); });
    el("teamAdd").addEventListener("click", () => openEditor(null));

    // Module grid: one row per module, None / View / Edit. Planned modules can be granted ahead of launch.
    function grid(current) {
      const words = menuWords(), groups = [];
      MENU.forEach(([g]) => { if (!groups.includes(g || "Today")) groups.push(g || "Today"); });
      const shownMods = modules.filter((m) => words[m.key]);
      shownMods.forEach((m) => { if (!groups.includes(words[m.key].group)) groups.push(words[m.key].group); });
      return groups.filter((g) => shownMods.some((m) => words[m.key].group === g)).map((g) => '<div class="tm-sec">' + esc(g) + "</div>" + shownMods.filter((m) => words[m.key].group === g).map((m) => {
        const lv = current[m.key] || "none";
        const w = words[m.key].words.slice(0, 4).join(", ");
        return '<div class="tm-row"><div><b>' + esc(w) + "</b>" + (m.status === "planned" ? ' <span class="pill muted">Coming soon</span>' : "") +
          '<div class="muted">' + esc(m.description) + '</div></div><div class="seg" role="radiogroup" aria-label="' + esc(w) + '">' +
          ["none", "view", "edit"].map((l) => '<label><input type="radio" name="tm-' + esc(m.key) + '" value="' + l + '"' + (lv === l ? " checked" : "") + " /><span>" + l[0].toUpperCase() + l.slice(1) + "</span></label>").join("") +
          "</div></div>";
      }).join("")).join("");
    }

    let crewRoles = { roles: [], members: {} };
    function openEditor(p) {
      const isNew = !p;
      p = p || { name: "", email: "", is_admin: false, active: true, modules: {}, weekly_hours: null, employment_type: null, job_title: "" };
      const m = openModal(
        "<h2>" + (isNew ? "Add a person" : "Edit " + esc(p.name || p.email)) + "</h2>" +
        '<div class="field"><label for="aca-tmName">Name</label><input type="text" id="aca-tmName" maxlength="120" value="' + esc(p.name) + '" /></div>' +
        '<div class="field"><label for="aca-tmEmail">Email</label><input type="email" id="aca-tmEmail" value="' + esc(p.email) + '"' + (isNew ? "" : " disabled") + " /></div>" +
        (isNew ? '<label class="tm-full"><input type="checkbox" id="aca-tmWelcome" checked /> <span><b>Email them a welcome</b><br><span class="muted">Their temporary password, how to sign in, and a link that puts 207 Admin on their phone.</span></span></label>' : "") +
        '<div class="tm-two"><div class="field"><label for="aca-tmTitle">Job title</label><input type="text" id="aca-tmTitle" maxlength="80" value="' + esc(p.job_title || "") + '" placeholder="e.g. Lead photographer" /></div>' +
        '<div class="field"><label for="aca-tmType">Employment type</label><select id="aca-tmType"><option value="">Not set</option>' + TYPES.map((t) => '<option value="' + t[0] + '"' + (p.employment_type === t[0] ? " selected" : "") + ">" + t[1] + "</option>").join("") + "</select></div></div>" +
        '<p class="muted" id="aca-tmTypeNote" style="font-size:12.5px;margin:-6px 0 12px"></p>' +
        '<div class="field"><label for="aca-tmHome">Home address</label><input type="text" id="aca-tmHome" maxlength="300" value="' + esc(p.home_address || "") + '" placeholder="Street and town, or just the town" />' +
        '<span class="muted" style="font-size:12.5px" id="aca-tmHomeNote"></span></div>' +
        '<div class="tm-two"><div class="field"><label for="aca-tmDrive">Longest drive (minutes, one way)</label><input type="number" id="aca-tmDrive" min="5" max="300" step="5" value="' + esc(p.max_drive_min == null ? 60 : p.max_drive_min) + '" />' +
        '<span class="muted" style="font-size:12.5px">Open jobs offers only go to jobs within this drive.</span></div>' +
        '<div class="field"><label for="aca-tmRate">Pay</label><div style="display:flex;gap:6px;align-items:center">$<input type="number" id="aca-tmRate" min="0" max="10000" step="0.5" style="width:96px" placeholder="from defaults" />' +
        '<select id="aca-tmBasis" aria-label="Per"><option value="hourly">per hour</option><option value="day">per day</option><option value="job">per job</option></select></div>' +
        '<span class="muted" style="font-size:12.5px" id="aca-tmRateNote">Their own rate. Empty uses the defaults (Settings, Team &amp; pay).</span></div></div>' +
        '<div class="field"><label for="aca-tmHours">Default hours per week</label><input type="number" id="aca-tmHours" min="0" max="80" step="0.5" style="width:110px" value="' + esc(p.weekly_hours == null ? "" : String(Number(p.weekly_hours))) + '" placeholder="e.g. 32" />' +
        '<span class="muted" style="font-size:12.5px">The Schedule shows how many hours they are scheduled against this each week. Leave empty if it doesn&#39;t apply.</span></div>' +
        ((crewRoles.roles || []).length ? '<div class="field"><label>Crew roles</label><div id="aca-tmRoles" style="display:flex;flex-wrap:wrap;gap:8px">' + crewRoles.roles.map((r) =>
          '<label style="display:inline-flex;gap:8px;align-items:center;font-weight:400;white-space:nowrap;padding:6px 12px;border:1px solid var(--border);border-radius:999px;cursor:pointer"><input type="checkbox" style="width:auto;margin:0" value="' + esc(r.id) + '"' + (((crewRoles.members || {})[p.user_id] || []).includes(r.id) ? " checked" : "") + " /> " + esc(r.label) + "</label>").join("") +
          '</div><span class="muted" style="font-size:12.5px">What they can do on a job. The Schedule&#39;s crew picker shows these and suggests the first one. Roles are set up under Crew settings on the Schedule.</span></div>' : "") +
        '<label class="tm-full"><input type="checkbox" id="aca-tmAdmin"' + (p.is_admin ? " checked" : "") + (p.is_me ? " disabled" : "") + ' /> <span><b>Full access</b><br><span class="muted">Everything, including Settings and this Team page. For owners and managers only.</span></span></label>' +
        '<div id="aca-tmAccess"' + (p.is_admin ? ' class="hidden"' : "") + '><p class="tm-acc"><b>Access:</b> <span id="aca-tmAccTxt"></span></p>' +
        '<div class="tm-presets"><span class="muted">Start from</span>' + PRESETS.map((x) => '<button type="button" class="small" data-preset="' + x[0] + '">' + esc(x[1]) + "</button>").join("") + "</div>" +
        '<details id="aca-tmMore"' + (isNew ? " open" : "") + '><summary>Change access</summary>' +
        (people.length ? '<div class="tm-copy"><label for="aca-tmCopyFrom" class="muted">Copy access from</label> <select class="small" id="aca-tmCopyFrom"><option value="">Pick someone&#8230;</option>' +
          people.filter((x) => x.user_id !== p.user_id && !x.is_admin).map((x) => '<option value="' + esc(x.user_id) + '">' + esc(x.name || x.email) + "</option>").join("") + "</select></div>" : "") +
        '<div id="aca-tmGrid" class="tm-grid">' + grid(p.modules) + "</div></details></div>" +
        '<div class="inline-error hidden" id="aca-tmErr"></div>' +
        '<div class="modal-actions">' +
        (isNew || p.is_me ? "" : '<button type="button" class="small" id="aca-tmReset">Reset password</button><button type="button" class="small" id="aca-tmActive">' + (p.active ? "Deactivate" : "Reactivate") + "</button>" +
          (p.active ? "" : '<button type="button" class="small warn" id="aca-tmRemove">Remove</button>')) +
        (isNew ? "" : '<button type="button" class="small" id="aca-tmSignins">Sign-ins</button>') +
        '<span class="grow"></span><button type="button" class="small" id="aca-tmCancel">Cancel</button><button type="button" class="primary" id="aca-tmSave">' + (isNew ? "Add and create login" : "Save") + "</button></div>");
      const err = (t) => { const n = el("tmErr"); n.textContent = t; n.classList.remove("hidden"); };
      if (el("tmSignins")) el("tmSignins").addEventListener("click", () => HistoryView.signins(p.user_id, "Sign-ins: " + (p.name || p.email)));
      el("tmAdmin").addEventListener("change", () => el("tmAccess").classList.toggle("hidden", el("tmAdmin").checked));
      const typeNote = () => { el("tmTypeNote").textContent = ({ full_time: "Hourly, with overtime on the time clock.", salaried: "Hours are tracked, but no overtime on the time clock.",
        part_time: "Gets Open jobs offers near them, plus My day, Time clock, My records and Open jobs. Overtime applies.", contractor: "Gets Open jobs offers near them, plus My day, Time clock, My records and Open jobs. No overtime; kept out of the payroll CSV and listed separately." })[el("tmType").value] || ""; };
      Places.attach(el("tmHome"), { note: el("tmHomeNote"), hint: "Drive times (and paid drive time) are measured from here; mileage is always reimbursed from the studio. The town alone is enough." });
      el("tmCancel").addEventListener("click", () => m.close());
      // Modules not in the grid (no page) keep whatever level the person already has.
      const picked = () => { const o = {}; modules.forEach((x) => { const r = m.querySelector('input[name="tm-' + x.key + '"]'); if (!r) { if (p.modules[x.key]) o[x.key] = p.modules[x.key]; return; }
        const c = m.querySelector('input[name="tm-' + x.key + '"]:checked'); if (c && c.value !== "none") o[x.key] = c.value; }); return o; };
      const setGrid = (lv, add) => modules.forEach((x) => { const want = lv[x.key] || "none"; if (add && want === "none") return;
        const cur = (m.querySelector('input[name="tm-' + x.key + '"]:checked') || {}).value || "none";
        if (add && (cur === "edit" || (cur === "view" && want === "view"))) return;
        const r = m.querySelector('input[name="tm-' + x.key + '"][value="' + want + '"]'); if (r) r.checked = true; });
      const accTxt = () => { const o = picked(), w = menuWords(); const list = modules.filter((x) => o[x.key]).map((x) => ((w[x.key] && w[x.key].words[0]) || x.label) + (o[x.key] === "edit" ? " (edit)" : ""));
        el("tmAccTxt").textContent = list.length ? list.join(", ") : "nothing yet"; };
      m.addEventListener("change", (e) => { if (e.target.name && e.target.name.startsWith("tm-")) accTxt(); });
      m.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
        const x = PRESETS.find((y) => y[0] === b.dataset.preset);
        if (!x[2]) { if (!p.is_me) { el("tmAdmin").checked = true; el("tmAccess").classList.add("hidden"); } return; }
        setGrid(x[2], false); accTxt(); toast("Access set to " + x[1] + ". Open Change access to adjust.");
      }));
      if (el("tmCopyFrom")) el("tmCopyFrom").addEventListener("change", (e) => {
        const from = people.find((x) => x.user_id === e.target.value); if (!from) return;
        setGrid(from.modules || {}, false); accTxt(); el("tmMore").open = true; toast("Copied " + (from.name || from.email) + "\u2019s access.");
      });
      // Changing the type applies its preset: a new person gets exactly it, someone already on the team only gains.
      el("tmType").addEventListener("change", () => {
        typeNote();
        const k = presetFor(el("tmType").value), x = PRESETS.find((y) => y[0] === k);
        if (!x || !x[2] || el("tmAdmin").checked || (!isNew && k === "office")) return;
        setGrid(x[2], !isNew); accTxt();
        el("tmTypeNote").textContent += " Access " + (isNew ? "set to" : "now includes") + " the " + x[1] + " preset.";
      });
      typeNote(); accTxt();
      // Pay: the person's own rate (the same row as Pay rates > a person).
      let myRate = null;
      supabase.rpc("timeclock_rates").then(({ data }) => {
        myRate = ((data && data.rates) || []).find((r) => r.scope === "person" && r.scope_key === p.user_id) || null;
        if (myRate && el("tmRate")) { el("tmRate").value = myRate.rate; el("tmBasis").value = myRate.basis; if (myRate.basis === "day" && myRate.half_day_rate != null) el("tmRateNote").textContent = "Their own rate. Half day $" + Number(myRate.half_day_rate).toFixed(2) + " (change it under Pay rates)."; }
      }, () => {});

      el("tmSave").addEventListener("click", async () => {
        const name = el("tmName").value.trim(), email = el("tmEmail").value.trim(), isAdmin = el("tmAdmin").checked;
        if (!name) return err("Enter a name.");
        if (isNew && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Enter a valid email address.");
        const hoursTxt = el("tmHours").value.trim(), hours = hoursTxt === "" ? null : Number(hoursTxt);
        if (hours != null && !(hours >= 0 && hours <= 80)) return err("Hours per week is 0 to 80.");
        const hoursChanged = hours !== (p.weekly_hours == null ? null : Number(p.weekly_hours));
        const setHours = async (uid) => { if (!hoursChanged) return; const { error } = await supabase.rpc("team_set_hours", { p_user_id: uid, p_hours: hours }); if (error) throw error; };
        const type = el("tmType").value || null, title = el("tmTitle").value.trim();
        const setProfile = async (uid) => { if (type === (p.employment_type || null) && title === (p.job_title || "")) return; const { error } = await supabase.rpc("team_set_profile", { p_user_id: uid, p_type: type || "", p_title: title }); if (error) throw error; };
        const home = el("tmHome").value.trim();
        const setHome = async (uid) => { if (home === (p.home_address || "")) return; const { error } = await supabase.rpc("team_set_home", { p_user_id: uid, p_home: home }); if (error) throw error; };
        const drive = Math.round(Number(el("tmDrive").value) || 60);
        if (drive < 5 || drive > 300) return err("Longest drive is 5 to 300 minutes.");
        const setDrive = async (uid) => { if (drive === (p.max_drive_min == null ? 60 : Number(p.max_drive_min))) return; const { error } = await supabase.rpc("team_set_max_drive", { p_user_id: uid, p_min: drive }); if (error) throw error; };
        const rateTxt = el("tmRate").value.trim(), basis = el("tmBasis").value;
        if (rateTxt !== "" && !(Number(rateTxt) >= 0 && Number(rateTxt) <= 10000)) return err("Pay is $0 to $10,000.");
        const setPay = async (uid) => {
          if (rateTxt === "") { if (myRate) { const { error } = await supabase.rpc("timeclock_rate_remove", { p_id: myRate.id }); if (error) throw error; } return; }
          if (myRate && Number(myRate.rate) === Number(rateTxt) && myRate.basis === basis) return;
          const { error } = await supabase.rpc("timeclock_rate_save", { p: { id: myRate ? myRate.id : null, scope: "person", scope_key: uid, basis, rate: rateTxt, half_day_rate: myRate && basis === "day" ? myRate.half_day_rate : null } });
          if (error) throw error;
        };
        const roleIds = el("tmRoles") ? [...el("tmRoles").querySelectorAll("input:checked")].map((x) => x.value) : null;
        const roles0 = ((crewRoles.members || {})[p.user_id] || []).slice().sort().join();
        const setRoles = async (uid) => { if (!roleIds || roleIds.slice().sort().join() === roles0) return; const { error } = await supabase.rpc("team_set_roles", { p_user_id: uid, p_roles: roleIds }); if (error) throw error; };
        el("tmSave").disabled = true;
        try {
          if (isNew) {
            const r = await teamFn({ action: "create", email, name, is_admin: isAdmin, permissions: isAdmin ? {} : picked(), send_welcome: el("tmWelcome").checked });
            try { await setHours(r.user_id); await setProfile(r.user_id); await setHome(r.user_id); await setRoles(r.user_id); await setDrive(r.user_id); await setPay(r.user_id); } catch (_e) { toast("Added, but the hours, job title, type, home address, roles, longest drive or pay did not save. Edit them on the Team page.", true); }
            m.close();
            showPassword({ user_id: r.user_id, name, email }, r.temp_password, true, r);
          } else {
            const { error } = await supabase.rpc("team_save", { p_user_id: p.user_id, p_name: name, p_is_admin: isAdmin, p_permissions: isAdmin ? {} : picked() });
            if (error) throw error;
            await setHours(p.user_id);
            await setProfile(p.user_id);
            await setHome(p.user_id);
            await setRoles(p.user_id);
            await setDrive(p.user_id);
            await setPay(p.user_id);
            m.close();
            toast("Saved. " + (name || email) + " sees the change the next time they load the page.");
          }
          load();
        } catch (e) { err(e.message || String(e)); } finally { el("tmSave") && (el("tmSave").disabled = false); }
      });

      if (isNew || p.is_me) return;
      el("tmReset").addEventListener("click", async () => {
        if (!confirm("Give " + (p.name || p.email) + " a new temporary password? Their current password stops working.")) return;
        try { const r = await teamFn({ action: "reset_password", user_id: p.user_id }); m.close(); showPassword(p, r.temp_password, false, null); load(); }
        catch (e) { err(e.message || String(e)); }
      });
      el("tmActive").addEventListener("click", async () => {
        if (p.active && !confirm("Deactivate " + (p.name || p.email) + "? They are signed out of everything and can't sign in until you reactivate them.")) return;
        try { await teamFn({ action: "set_active", user_id: p.user_id, active: !p.active }); m.close(); toast(p.active ? "Deactivated." : "Reactivated."); load(); }
        catch (e) { err(e.message || String(e)); }
      });
      if (p.active) return;
      el("tmRemove").addEventListener("click", async () => {
        if (!confirm("Remove " + (p.name || p.email) + " from the team? Their login is deleted and they drop off this list. The change log keeps their name. This can't be undone; to bring them back, add them again.")) return;
        try { await teamFn({ action: "remove", user_id: p.user_id }); m.close(); toast("Removed."); load(); }
        catch (e) { err(e.message || String(e)); }
      });
    }

    // sent: the create result ({emailed, email_error}) when a welcome email was asked for, else null.
    function showPassword(person, pw, isNew, sent) {
      const name = person.name, email = person.email;
      const emailed = !!(sent && sent.emailed), failed = !!(sent && !sent.emailed && sent.email_error);
      const m = openModal("<h2>" + (isNew ? esc(name) + " can sign in now" : "New temporary password") + "</h2>" +
        (emailed ? '<p><span class="pill ok">Welcome email sent</span></p><p>We emailed <b>' + esc(email) + "</b> this temporary password, how to sign in, and the link that puts 207 Admin on their phone. It is also shown here, only once, in case they need it.</p>"
          : (failed ? '<div class="inline-error">The welcome email did not send: ' + esc(sent.email_error) + "</div>" : "") +
            "<p>Give " + esc(name || email) + " this temporary password. It is shown only once. They sign in at <b>admin.207photo.com</b> with <b>" + esc(email) +
            "</b>, enter the 6-digit code emailed to them, then choose their own password.</p>") +
        '<div class="tm-pw"><code id="aca-tmPw">' + esc(pw) + '</code><button type="button" class="small" id="aca-tmCopy">Copy</button></div>' +
        '<div class="modal-actions">' + (emailed ? "" : '<button type="button" class="small" id="aca-tmMail">Email it to them</button>') +
        '<span class="grow"></span><button type="button" class="primary" id="aca-tmDone">Done</button></div>', { locked: true });
      el("tmCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(pw); toast("Copied."); } catch (_e) { toast("Select the password and copy it.", true); } });
      el("tmDone").addEventListener("click", () => m.close());
      if (emailed) return;
      el("tmMail").addEventListener("click", async () => {
        const b = el("tmMail"); b.disabled = true;
        try { await teamFn({ action: "send_welcome", user_id: person.user_id, temp_password: pw }); b.textContent = "Emailed"; toast("Emailed " + email + "."); loadLog(); }
        catch (e) { b.disabled = false; toast(e.message || String(e), true); }
      });
    }

    const ACTIONS = { added: "added", updated: "changed access for", deactivated: "deactivated", reactivated: "reactivated", removed: "removed", temp_password_set: "set a temporary password for", temp_password_cleared: "cleared the temporary password for", hours_set: "changed the weekly hours for", profile_set: "changed the job title or employment type for", roles_set: "changed the crew roles for", welcome_sent: "emailed sign-in details to" };
    // One save writes several audit rows (added, temporary password, hours, roles...). Rows by the same person about the
    // same person within two minutes read as one entry; the newest few show and the rest fold under "Show older".
    const ALSO = { updated: "access", hours_set: "weekly hours", profile_set: "job title or type", roles_set: "crew roles", temp_password_set: "temporary password",
      temp_password_cleared: "temporary password cleared", welcome_sent: "welcome email sent", deactivated: "deactivated", reactivated: "reactivated", removed: "removed" };
    const LOG_SHOWN = 6;
    async function loadLog() {
      const { data, error } = await supabase.rpc("team_audit_list", { p_limit: 60 });
      if (error) { el("teamLog").innerHTML = '<span class="inline-error">' + esc(error.message) + "</span>"; return; }
      if (!data || !data.length) { el("teamLog").innerHTML = '<p class="muted">No changes yet.</p>'; return; }
      el("teamLogLast").textContent = "\u00b7 last " + fmtDate(data.reduce((a, r) => (r.at > a ? r.at : a), data[0].at));
      const groups = [];
      data.forEach((r) => {
        const g = groups[groups.length - 1];
        if (g && g.actor === r.actor && g.target === r.target && Math.abs(new Date(g.last) - new Date(r.at)) <= 120000) { g.rows.push(r); g.last = r.at; }
        else groups.push({ actor: r.actor, target: r.target, at: r.at, last: r.at, rows: [r] });
      });
      const line = (g) => {
        // The list is newest first, so the first thing done in a save is the group's last row.
        const main = g.rows.find((r) => r.action === "added") || (g.rows.length === 1 ? g.rows[0] : null);
        const verb = main ? ACTIONS[main.action] || main.action : "updated";
        const also = [...new Set(g.rows.filter((r) => r !== main).reverse().map((r) => ALSO[r.action] || ACTIONS[r.action] || r.action))];
        return "<li><span class=\"muted\">" + esc(fmtDate(g.at)) + "</span> " + esc(g.actor || "Someone") + " " + esc(verb) + " " + esc(g.target || "") +
          (also.length ? ' <span class="muted tm-also">&middot; ' + esc(also.join(", ")) + "</span>" : "") + "</li>";
      };
      const older = groups.slice(LOG_SHOWN);
      el("teamLog").innerHTML = '<ul class="tm-log">' + groups.slice(0, LOG_SHOWN).map(line).join("") + "</ul>" +
        (older.length ? '<details class="tm-older"><summary class="muted">Show older (' + older.length + ')</summary><ul class="tm-log">' + older.map(line).join("") + "</ul></details>" : "");
    }

    // Open one person's record (Open jobs > Part-timers & 1099 links here).
    async function edit(uid) {
      if (!people.length) await load();
      const p = people.find((x) => x.user_id === uid);
      if (p) openEditor(p); else toast("That person is not on the team list.", true);
    }
    return { load, edit };
  })();

