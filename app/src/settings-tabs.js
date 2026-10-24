  // ================================================================ SETTINGS: Team emails, Job types, Team & pay, Company (ws/settings 2026-10-24)
  // Rule: a setting has one home in Settings and may have a shortcut on its old page. Each card here shows where a
  // setting stands and opens the same dialog its old page opens (Schedule.openCrewSettings, TimeClock.openSettings,
  // StaffRecords.openKinds, Bookings.openJobTypes, ...), so there is one copy of each editor.
  //   Team emails: morning digest (moved from Sending), the your-day notification and morning email (from Tasks),
  //     asking the crew and the weekly schedule email (from Schedule > Crew settings), clock reminders (from
  //     Timesheets > Settings), and the default for every kind of notification (each person can still change theirs).
  //   Job types: one card per job type: stages and saved deliverables, checklist steps, its booking emails, plus
  //     auto-track and adding a job type (booking_type_add).
  //   Team & pay: crew roles, kinds of clearance, onboarding steps, pay rates, time clock rules.
  //   Company: studio address and setup/teardown, then the sync runs, data-quality warnings and sign-in security
  //     cards that used to be the Sync and Sign-in tabs (system.js still fills those).
  // RPCs added for this: settings_team_emails, push_topic_set_default, booking_type_add (migration 20261024020000).
  // Until the shell stream adds these tabs to the Settings menu entry they show as an entry of their own.
  registerPage({ id: "settingsmore", group: "System", section: "system", module: "settings", title: "Settings",
                 tabs: [["teamemails", "Team emails"], ["jobtypes", "Job types"], ["teampay", "Team & pay"], ["company", "Company"]],
                 onShow: (tab) => SettingsTabs.show(tab) });
  // Old links to the Sync and Sign-in tabs land on Company.
  (function () {
    const it = RAIL.find((x) => x.id === "sending");
    if (it && !it.onShow) it.onShow = (tab) => { if (tab === "health" || tab === "signin") setTimeout(() => showTab("company"), 0); };
  })();

  const SettingsTabs = (function () {
    const sb = supabase;
    const T = StaffTime;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const DOWS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MODE = [["push", "Push now"], ["email", "Morning email"], ["off", "Off"]];
    const css = `
    .aca .st-card .card-head h2 { font-size: 15px; }
    .aca .st-body { padding: 4px 16px 16px; font-size: 13.5px; }
    .aca .st-body p { margin: 0 0 8px; }
    .aca .st-sum { color: var(--muted); font-size: 13px; }
    .aca .st-list { list-style: none; margin: 0 0 8px; padding: 0; }
    .aca .st-list li { display: flex; gap: 10px; align-items: baseline; padding: 6px 0; border-bottom: 1px solid var(--line2); }
    .aca .st-list li .grow { flex: 1; min-width: 0; }
    .aca .st-list li .s { display: block; color: var(--muted); font-size: 12.5px; }
    .aca .st-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
    .aca .st-chips span { display: inline-block; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; font-size: 12.5px; background: var(--surface); }
    .aca .st-sec { margin: 12px 0 0; }
    .aca .st-sec h3 { margin: 0 0 6px; font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); display: flex; gap: 8px; align-items: center; }
    .aca .st-sec h3 .grow { flex: 1; }
    .aca .st-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .aca .st-row .grow { flex: 1; }
    .aca .st-topics td, .aca .st-topics th { padding: 7px 8px; font-size: 13px; vertical-align: top; }
    .aca .st-topics td .s { display: block; color: var(--muted); font-size: 12px; }
    .aca .st-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 0 16px; }
    .aca .st-tags { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .aca .st-tags .tag { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 4px 0 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--surface); font-size: 13px; }
    .aca .st-tags .tag button { border: 0; background: transparent; color: var(--faint); height: 24px; padding: 0 6px; font-size: 14px; }
    .aca .st-tags input { width: 220px; max-width: 100%; }
    @media (max-width: 700px) { .aca .st-grid { grid-template-columns: 1fr; } .aca .st-hide-sm { display: none; } .aca .st-body { padding: 4px 12px 14px; } }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    const card = (id, title, intro, body, action) => '<div class="card st-card" id="aca-' + id + '"><div class="card-head"><div><h2>' + title + "</h2>" + (intro ? "<p>" + intro + "</p>" : "") + "</div>" +
      (action || "") + '</div><div class="st-body">' + body + "</div></div>";
    const btn = (act, label, extra) => '<button type="button" class="small" data-st="' + act + '"' + (extra || "") + ">" + label + "</button>";
    const hour = (h) => (h == null ? "" : T.fmtMin(num(h) * 60));
    const fail = (box, e) => { el(box).innerHTML = '<div class="inline-error">' + esc(cleanErr(e)) + "</div>"; };
    let current = null;
    function show(tab) {
      current = tab;
      if (tab === "teamemails") return loadTeamEmails();
      if (tab === "jobtypes") return loadJobTypes();
      if (tab === "teampay") return loadTeamPay();
      if (tab === "company") return loadCompany();
    }
    const again = () => { if (current) show(current); };

    // ================================================================ Team emails
    let te = null, digest = null, team = [];
    async function loadTeamEmails() {
      try {
        const [a, d, t] = await Promise.all([sb.rpc("settings_team_emails"), sb.from("admin_settings").select("*").maybeSingle(), sb.rpc("team_list").then((r) => r, () => ({ data: [] }))]);
        if (a.error) throw a.error; if (d.error) throw d.error;
        te = a.data || {}; digest = d.data || { digest_enabled: true, digest_time: "07:00", digest_recipients: [] };
        team = ((t && t.data) || []).filter((m) => m.active && m.email);
        renderTeamEmails();
      } catch (e) { fail("stTeBody", e); }
    }
    function renderTeamEmails() {
      const c = te.clock || {};
      const t5 = (x) => String(x || "07:00").slice(0, 5);
      const fmtT = (x) => { const [h, m] = x.split(":").map(Number); return T.fmtMin(h * 60 + m); };
      const tag = (r) => '<span class="tag">' + esc(r) + '<button type="button" data-rm="' + esc(r) + '" aria-label="Remove ' + esc(r) + '">&times;</button></span>';
      el("stTeBody").innerHTML =
        card("stDigest", "Morning digest", "One email that reads like the Today page, for you and whoever else should get it. It replaces the separate follow-up, help-request and failed-send alerts.",
          '<div class="st-row" style="margin-bottom:10px"><label><input type="checkbox" id="aca-stDgOn"' + (digest.digest_enabled !== false ? " checked" : "") + " /> Send it</label> at " +
            '<select class="small" id="aca-stDgTime">' + ["06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00"].map((x) => '<option value="' + x + '"' + (t5(digest.digest_time) === x ? " selected" : "") + ">" + fmtT(x) + "</option>").join("") + "</select> Eastern</div>" +
          '<div class="st-tags" id="aca-stDgTo">' + (digest.digest_recipients || []).map(tag).join("") + '<input type="email" id="aca-stDgNew" placeholder="Add an address and press Enter" aria-label="Add an address" /></div>' +
          (team.length ? '<div style="margin-top:8px"><select class="small" id="aca-stDgTeam"><option value="">Add someone on the team&#8230;</option>' + team.map((m) => '<option value="' + esc(m.email.toLowerCase()) + '">' + esc(m.name || m.email) + "</option>").join("") + "</select></div>" : "") +
          '<div class="st-row" style="margin-top:12px"><button type="button" class="primary small" data-st="dgsave">Save</button><button type="button" class="small" data-st="dgnow">Send me today&#39;s digest now</button><span class="st-sum" id="aca-stDgMsg"></span></div>') +
        card("stDaily", "Your-day notification and morning email", "For everyone with My day. The Tasks page has a shortcut to the same settings.",
          '<p class="st-sum">' + esc(Assignments.dailyText(te)) + "</p>", btn("daily", "Change")) +
        card("stCrew", "Asking the crew and the weekly schedule email", "From the Schedule&#39;s Crew settings.",
          '<p class="st-sum">Ask people to confirm a job they are put on: ' + (te.crew_confirm_on ? "on" : "off") + ". Weekly schedule email: " +
            (te.week_email_auto ? esc(DOWS[num(te.week_email_dow)]) + "s at " + esc(hour(te.week_email_hour)) : "off (send it by hand from the Schedule)") + ". Jobs you put yourself on are confirmed for you.</p>", btn("crew", "Change")) +
        card("stClock", "Clock reminders", "Phone notifications from the time clock. The same settings as Timesheets, Settings.",
          '<p class="st-sum">Clock-in reminder: ' + (num(c.remind_before_min) ? num(c.remind_before_min) + " minutes before a scheduled start" : "off") + ". Clock-out reminder: " +
            (num(c.remind_out_after_min) ? num(c.remind_out_after_min) + " minutes after a scheduled end" : "off") + ". Overtime warning: " + (num(c.ot_warn_hours) ? num(c.ot_warn_hours) + " hours before overtime" : "off") + ".</p>", btn("clock", "Change")) +
        card("stTopics", "Notifications", "Every kind of notification and what it does unless the person changes it: <b>Push now</b>, wait for their <b>Morning email</b>, or <b>Off</b>. Each person can change theirs in the account menu, Notifications.",
          '<div class="table-wrap"><table class="st-topics"><thead><tr><th>Kind</th><th>Default</th></tr></thead><tbody>' +
          (te.topics || []).map((x) => "<tr><td><b>" + esc(x.label) + "</b>" + (x.description ? '<span class="s">' + esc(x.description) + "</span>" : "") + "</td><td>" +
            '<select class="small" data-deftopic="' + esc(x.key) + '" aria-label="Default for ' + esc(x.label) + '">' + MODE.map((m) => '<option value="' + m[0] + '"' + (x.default_mode === m[0] ? " selected" : "") + ">" + m[1] + "</option>").join("") + "</select></td></tr>").join("") +
          "</tbody></table></div>");
      const addTo = (v) => {
        if ([...el("stDgTo").querySelectorAll("[data-rm]")].some((b) => b.dataset.rm === v)) return;
        el("stDgNew").insertAdjacentHTML("beforebegin", tag(v));
      };
      el("stDgTo").addEventListener("click", (e) => { const b = e.target.closest("[data-rm]"); if (b) b.parentElement.remove(); });
      if (el("stDgTeam")) el("stDgTeam").addEventListener("change", (e) => { if (e.target.value) addTo(e.target.value); e.target.value = ""; });
      el("stDgNew").addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== ",") return;
        e.preventDefault();
        const v = el("stDgNew").value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { toast("That doesn't look like an email address.", true); return; }
        addTo(v); el("stDgNew").value = "";
      });
      el("stTeBody").querySelectorAll("select[data-deftopic]").forEach((s) => s.addEventListener("change", async () => {
        const topic = te.topics.find((x) => x.key === s.dataset.deftopic), was = topic.default_mode, v = s.value;
        topic.default_mode = v;
        const r = await Saves.run("deftopic:" + topic.key, () => sb.rpc("push_topic_set_default", { p_topic: topic.key, p_mode: v }), () => { topic.default_mode = was; s.value = was; });
        if (!r) return;
        toast("Saved. People who haven't picked their own get " + MODE.find((m) => m[0] === v)[1].toLowerCase() + ".");
      }));
    }
    async function saveDigest(b) {
      const recips = [...el("stDgTo").querySelectorAll(".tag")].map((t) => t.firstChild.textContent.trim());
      const row = { digest_enabled: el("stDgOn").checked, digest_time: el("stDgTime").value, digest_recipients: recips };
      if (row.digest_enabled && !recips.length) { toast("The morning digest needs at least one address, or switch it off.", true); return; }
      b.disabled = true;
      const { error } = await sb.from("admin_settings").upsert(Object.assign({ id: true }, row));
      b.disabled = false;
      if (error) { toast(cleanErr(error), true); return; }
      toast("Saved."); Object.assign(digest, row);
      if (typeof renderDigestNote === "function") renderDigestNote();
    }

    // ================================================================ Job types
    async function loadJobTypes() {
      try {
        const [t, st, dt, sq, ss, tr, wf] = await Promise.all([sb.from("booking_types").select("*").order("sort_order"), sb.from("booking_stages").select("*").order("sort"),
          sb.from("deliverable_templates").select("*").is("archived_at", null).order("sort"), sb.from("booking_sequences").select("*").order("created_at"),
          sb.from("booking_steps").select("id, sequence_id, is_active"), sb.from("booking_tracking_settings").select("*").maybeSingle(),
          Workflows.templates().then((x) => x, () => null)]);
        [t, st, dt, sq, ss].forEach((r) => { if (r.error) throw r.error; });
        const gd = await sb.from("gp_type_defaults").select("*");
        gpDefs = gd.error ? null : gd.data || [];
        renderJobTypes(t.data || [], (st.data || []).filter((x) => !x.archived_at), dt.data || [], sq.data || [], ss.data || [], tr.data || {}, wf);
      } catch (e) { fail("stJtBody", e); }
    }
    let jt = null, gpDefs = null, gpLists = null;
    // GotPhoto defaults (gp_type_defaults): what a job made by 207 Admin gets. Empty = copied from the newest job.
    const GP_JOB_TYPES = [["sport_other", "Sport (Other)"], ["school_k_12", "K-12 School"]];
    const GP_ARCHIVE = [["month_after", "One month after the shoot"], ["june_1", "June 1 after the shoot (school's out)"]];
    const GP_REVIEW = [["", "Copy from the newest job"], ["off", "Off"], ["on", "On"], ["auto", "Auto"]];
    const GP_FAV = [["", "Copy from the newest job"], ["off", "No selection box"], ["favorite", "Favorite photo"], ["yearbook", "Yearbook photo"], ["student_id", "ID card photo"]];
    const GP_PREPAY = [["", "Copy from the newest job"], ["true", "On"], ["false", "Off"]];
    // One price list per job type (Jeremiah 2026-10-23): a new season's list is picked once, here or on the check screen
    // when a job is created, and stays. The per-season columns are no longer used.
    const GP_SEASONS = [["price_profile_id", "Price list"]];
    const gpDefOf = (x) => (gpDefs || []).find((d) => d.type_key === x.key) ||
      { type_key: x.key, gp_job_type: x.audience === "school" ? "school_k_12" : "sport_other", archive_rule: x.audience === "school" ? "june_1" : "month_after", labels: {} };
    const pick = (list, v) => (list.find((o) => o[0] === (v == null ? "" : String(v))) || [null, v])[1];
    function gpSummary(x) {
      if (!gpDefs) return '<p class="st-sum">Could not load.</p>';
      const d = gpDefOf(x), L = d.labels || {}, parts = [];
      parts.push(pick(GP_JOB_TYPES, d.gp_job_type) || d.gp_job_type, "archive " + pick(GP_ARCHIVE, d.archive_rule).toLowerCase());
      GP_SEASONS.forEach(([k, lab]) => { if (d[k]) parts.push(lab + ": " + (L[k] || d[k])); });
      if (d.communication_profile_id) parts.push("emails: " + (L.communication_profile_id || d.communication_profile_id));
      if (d.access_type) parts.push(pick(gpAccessList(gpAccessOf(d), true), gpAccessOf(d)));
      if (d.prepay != null) parts.push("prepay " + (d.prepay ? "on" : "off") + (d.prepay_deadline_days != null ? ", deadline " + d.prepay_deadline_days + " days after" : ""));
      return '<div class="st-chips">' + parts.map((t) => "<span>" + esc(t) + "</span>").join("") + "</div>" +
        '<p class="st-sum">Anything not set is copied from your newest ' + esc(pick(GP_JOB_TYPES, d.gp_job_type) || "") + " job.</p>";
    }
    async function openGpDefaults(key) {
      const x = jt.types.find((t) => t.key === key); if (!x) return;
      const d = Object.assign({}, gpDefOf(x)), can = canEdit("bookings");
      const sel = (id, list, v) => '<select id="aca-stGp' + id + '" style="width:100%"' + (can ? "" : " disabled") + ">" + list.map(([k, l]) => '<option value="' + esc(k) + '"' + (String(v == null ? "" : v) === k ? " selected" : "") + ">" + esc(l) + "</option>").join("") + "</select>";
      const profSel = (id, kind, v) => {
        const L = d.labels || {}, opts = gpLists && gpLists[kind] ? gpLists[kind] : null;
        const list = [["", id === "price_profile_id" || id === "communication_profile_id" ? "Copy from the newest job" : "Use the any-season one"]]
          .concat(opts ? opts.map((o) => [o.id, o.name]) : []).concat(v && !(opts || []).some((o) => o.id === v) ? [[v, L[id] || v]] : []);
        return sel(id, list, v || "");
      };
      const field = (label, html, hint) => '<div class="field"><label>' + label + "</label>" + html + (hint ? '<p class="muted" style="font-size:12px;margin:4px 0 0">' + hint + "</p>" : "") + "</div>";
      const body = () => '<div style="max-width:560px"><h2>GotPhoto defaults: ' + esc(x.label) + "</h2>" +
        '<p class="muted" style="font-size:12.5px">What a GotPhoto job made by 207 Admin for this job type gets. You also see these when you create a job, and a change there is saved here. Anything left on "copy" comes from your newest job of the same GotPhoto job type.</p>' +
        (gpLists === null ? '<p class="muted" id="aca-stGpLoad" style="font-size:12.5px">Loading your GotPhoto price and email profiles\u2026</p>' : gpLists.error ? '<div class="inline-error">' + esc(gpLists.error) + "</div>" : "") +
        field("GotPhoto job type", sel("gp_job_type", GP_JOB_TYPES, d.gp_job_type)) +
        field("Archive date", sel("archive_rule", GP_ARCHIVE, d.archive_rule)) +
        GP_SEASONS.map(([k, lab]) => field(lab, profSel(k, "price_profiles", d[k]))).join("") +
        field("Communication profile", profSel("communication_profile_id", "communication_profiles", d.communication_profile_id)) +
        field("Photo access", sel("access", gpAccessList(gpAccessOf(d), true), gpAccessOf(d))) +
        field("Prepay shop", sel("prepay", GP_PREPAY, d.prepay)) +
        field("Prepay deadline, days after the shoot", '<input type="number" id="aca-stGpprepay_deadline_days" min="-60" max="365" style="width:120px" value="' + esc(d.prepay_deadline_days == null ? "" : String(d.prepay_deadline_days)) + '"' + (can ? "" : " disabled") + " />", "Empty = same distance as on the newest job.") +
        field("Review photos before the lab", sel("review_orders_photos", GP_REVIEW, d.review_orders_photos)) +
        field("Customers pick a favorite photo", sel("customer_set_favorite_photo", GP_FAV, d.customer_set_favorite_photo)) +
        field("Photos per person goal", '<input type="number" id="aca-stGpphotographer_goal" min="0" max="99" style="width:120px" value="' + esc(d.photographer_goal == null ? "" : String(d.photographer_goal)) + '"' + (can ? "" : " disabled") + " />", "Empty = copy from the newest job.") +
        '<p class="muted" style="font-size:12px">Registration after code login carries over from your last job in GotPhoto. Not settable through GotPhoto\u2019s API: "Switch price list on", coupons, registration form fields and products. Set those in GotPhoto.</p>' +
        '<div class="inline-error hidden" id="aca-stGpErr"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">' + (can ? "Cancel" : "Close") + "</button>" +
        (can ? '<button type="button" class="primary" data-m="save">Save</button>' : "") + "</div></div>";
      const m = openModal(body());
      const read = () => {
        const v = (id) => { const n = el("stGp" + id); return n ? n.value : ""; };
        const p = {}; ["gp_job_type", "archive_rule", "register_after_password_login", "communication_profile_id", "prepay", "prepay_deadline_days", "review_orders_photos", "customer_set_favorite_photo", "photographer_goal"]
          .concat(GP_SEASONS.map((s2) => s2[0])).forEach((k) => { p[k] = v(k); });
        [p.access_type, p.password_source] = v("access") ? v("access").split("|") : ["", ""];
        const labels = {};
        ["communication_profile_id"].concat(GP_SEASONS.map((s2) => s2[0])).forEach((k) => { const n = el("stGp" + k); if (n && n.value) labels[k] = n.options[n.selectedIndex].text; });
        p.labels = labels; return p;
      };
      if (gpLists === null) {
        try {
          const { data: { session } } = await sb.auth.getSession();
          const resp = await fetch(ADMIN_FN_URL + "/gplists", { method: "POST", headers: { Authorization: "Bearer " + session.access_token } });
          let b = {}; try { b = await resp.json(); } catch (_) {}
          gpLists = resp.ok && b.ok ? { price_profiles: b.price_profiles || [], communication_profiles: b.communication_profiles || [] } : { error: "Couldn't load the profiles from GotPhoto: " + (b.error || resp.status) + ". The saved picks stay." };
        } catch (e) { gpLists = { error: "Couldn't load the profiles from GotPhoto. The saved picks stay." }; }
        if (m.open !== false && document.body.contains(m)) { Object.assign(d, read()); const inner = m.querySelector("div"); if (inner) inner.outerHTML = body(); }
        if (gpLists.error) gpLists = null;   // try again next time
      }
      m.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "cancel") return m.close();
        b.disabled = true;
        const { error } = await sb.rpc("gp_type_defaults_save", { p_type: key, p: read() });
        if (error) { b.disabled = false; const n = el("stGpErr"); n.textContent = cleanErr(error); n.classList.remove("hidden"); return; }
        m.close(); toast("Saved. New GotPhoto jobs for " + x.label + " use these."); await loadJobTypes();
      });
    }
    function renderJobTypes(types, stages, tpls, seqs, steps, track, wf) {
      jt = { types, wf };
      const can = canEdit("bookings");
      const stepsOf = (k) => (wf ? wf.steps.filter((s) => (s.type_key || null) === k) : []);
      const stepList = (k) => !wf ? '<p class="st-sum">Checklists could not be loaded.</p>' :
        (stepsOf(k).length ? '<ul class="st-list">' + stepsOf(k).map((s) => '<li><span class="grow"><b>' + esc(s.title) + '</b><span class="s">' + esc(Workflows.whenText(s)) + "</span></span>" +
          (wf.can_edit ? btn("step", "Edit", ' data-id="' + esc(s.id) + '"') : "") + "</li>").join("") + "</ul>" : '<p class="st-sum">No steps of its own.</p>') +
        (wf.can_edit ? '<button type="button" class="link" data-st="addstep" data-k="' + esc(k || "") + '">+ Add a checklist step</button>' : "");
      const typeCard = (x) => {
        const sts = stages.filter((s) => s.type_key === x.key).sort((a, b) => a.sort - b.sort);
        const dls = tpls.filter((d) => d.type_key === x.key);
        const qs = seqs.filter((q) => q.type_key === x.key);
        return card("stJt-" + x.key, esc(x.label), esc(x.description || (x.audience === "school" ? "A school job." : "A sports job.")),
          '<div class="st-sec"><h3>Stages</h3><div class="st-chips">' + (sts.map((s, i) => "<span>" + (i + 1) + ". " + esc(s.label) + "</span>").join("") || '<span class="st-sum">none</span>') + "</div></div>" +
          '<div class="st-sec"><h3>Saved deliverables</h3>' + (dls.length ? '<div class="st-chips">' + dls.map((d) => "<span>" + esc(d.label) + (d.due_days != null ? ", due " + num(d.due_days) + " days after launch" : "") + (d.auto_add ? ", every job" : "") + "</span>").join("") + "</div>" : '<p class="st-sum">None saved.</p>') + "</div>" +
          '<div class="st-sec"><h3>Checklist steps</h3>' + stepList(x.key) + "</div>" +
          '<div class="st-sec"><h3><span class="grow">GotPhoto defaults</span>' + btn("gpdef", canEdit("bookings") ? "Edit" : "View", ' data-k="' + esc(x.key) + '"') + "</h3>" + gpSummary(x) + "</div>" +
          '<div class="st-sec"><h3>Booking emails</h3>' + (qs.length ? qs.map((q) => '<p class="st-sum">' + esc(q.name) + ": " + (q.is_active ? "on" : "off") + ", " + steps.filter((s) => s.sequence_id === q.id && s.is_active).length + " active steps. " +
              '<a href="#system/library">Edit in the Email library</a></p>').join("") : '<p class="st-sum">No booking email sequence yet. <a href="#system/library">Email library</a></p>') + "</div>",
          btn("stages", "Stages &amp; deliverables", ' data-k="' + esc(x.key) + '"'));
      };
      el("stJtBody").innerHTML =
        card("stJtTop", "Job types", "Each job type has its own stages, saved deliverables, checklist steps and booking emails.",
          '<label class="st-row"><input type="checkbox" id="aca-stAuto"' + (track.auto_track ? " checked" : "") + (can ? "" : " disabled") + " /> Add new GotPhoto jobs to tracking by themselves (hourly, when the organization is clear). Tracked jobs get stages and deliverables, no emails.</label>",
          can ? '<button type="button" class="primary small" data-st="addtype">Add a job type</button>' : "") +
        types.map(typeCard).join("") +
        card("stJt-all", "Every job type", "Deliverables and checklist steps every job gets, whatever its type.",
          '<div class="st-sec"><h3>Saved deliverables</h3>' + (tpls.filter((d) => !d.type_key).length ? '<div class="st-chips">' + tpls.filter((d) => !d.type_key).map((d) => "<span>" + esc(d.label) + "</span>").join("") + "</div>" : '<p class="st-sum">None saved.</p>') + "</div>" +
          '<div class="st-sec"><h3>Checklist steps</h3>' + stepList(null) + "</div>", btn("stages", "Deliverables", ' data-k=""'));
      el("stAuto").addEventListener("change", async (e) => {
        const on = e.target.checked;
        const r = await Saves.run("auto_track", () => sb.rpc("booking_set_auto_track", { p_on: on }), () => { e.target.checked = !on; });
        if (!r) return;
        toast(on ? "New GotPhoto jobs are tracked by themselves." : "Auto-track off.");
      });
    }
    function addType() {
      const types = jt.types;
      const m = openModal('<div style="max-width:460px"><h2>Add a job type</h2>' +
        '<div class="field"><label for="aca-stNtName">Name</label><input type="text" id="aca-stNtName" maxlength="60" placeholder="Dance recital" style="width:100%" /></div>' +
        '<div class="field"><label for="aca-stNtFrom">Start from</label><select id="aca-stNtFrom" style="width:100%">' + types.map((t) => '<option value="' + esc(t.key) + '">' + esc(t.label) + "</option>").join("") + "</select></div>" +
        '<p class="muted" style="font-size:12.5px">It copies that type&#39;s settings (school or sports, title choices, length) and gets the usual stages. It starts with no booking emails and no checklist steps of its own; add them here or in the Email library.</p>' +
        '<div class="inline-error hidden" id="aca-stNtErr"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">Add</button></div></div>');
      m.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "cancel") return m.close();
        b.disabled = true;
        const { data, error } = await sb.rpc("booking_type_add", { p_label: el("stNtName").value.trim(), p_copy_from: el("stNtFrom").value });
        if (error) { b.disabled = false; const n = el("stNtErr"); n.textContent = cleanErr(error); n.classList.remove("hidden"); return; }
        m.close(); toast("Added."); Bookings.resetTypes(); await loadJobTypes();
        const c = el("stJt-" + (data && data.key)); if (c) c.scrollIntoView({ block: "start" });
      });
    }

    // ================================================================ Team & pay
    async function loadTeamPay() {
      try {
        const [r, sr, rt, tc] = await Promise.all([sb.rpc("crew_roles_list"), sb.rpc("staff_records"), sb.rpc("timeclock_rates"), sb.rpc("timeclock_settings_get")]);
        [r, sr, rt, tc].forEach((x) => { if (x.error) throw x.error; });
        renderTeamPay(r.data || {}, sr.data || {}, rt.data || {}, tc.data || {});
      } catch (e) { fail("stTpBody", e); }
    }
    const TYPE = { full_time: "Full time", salaried: "Salaried", part_time: "Part time", contractor: "1099" };
    const rateTxt = (x) => "$" + num(x.rate).toFixed(2) + (x.basis === "day" ? " a day" + (x.half_day_rate != null ? ", $" + num(x.half_day_rate).toFixed(2) + " a half day" : "") : x.basis === "job" ? " a job" : " an hour");
    function renderTeamPay(roles, recs, rates, tc) {
      const rl = rates.rates || [];
      const scope = (x) => (x.scope === "type" ? TYPE[x.scope_key] || x.scope_key : x.scope === "title" ? "Job title: " + x.scope_key : x.name || "Someone");
      el("stTpBody").innerHTML = '<div class="st-grid">' +
        card("stRoles", "Crew roles", "What someone does on a job. Pick each person&#39;s roles on the Team page.",
          '<div class="st-chips">' + ((roles.roles || []).map((x) => "<span>" + esc(x.label) + "</span>").join("") || '<span class="st-sum">No roles yet.</span>') + "</div>", btn("roles", "Change")) +
        card("stKinds", "Kinds of clearance", "Background checks, SafeSport and the rest. The Records page has the same button.",
          '<ul class="st-list">' + ((recs.types || []).map((x) => '<li><span class="grow">' + esc(x.label) + '<span class="s">' + (x.school_required ? "for schools, " : "") + "warns " + num(x.warn_days) + " days ahead</span></span></li>").join("") || '<li class="st-sum">None yet.</li>') + "</ul>", btn("kinds", "Change")) +
        card("stSteps", "Onboarding steps", "The checklist each new person works through.",
          '<ul class="st-list">' + ((recs.steps || []).map((x, i) => '<li><span class="grow">' + (i + 1) + ". " + esc(x.title) + "</span></li>").join("") || '<li class="st-sum">No steps yet.</li>') + "</ul>", btn("steps", "Change")) +
        card("stRates", "Pay rate defaults", "For estimated pay and payroll. A person&#39;s own rate wins, then their job title&#39;s, then their employment type&#39;s. Set one person&#39;s rate on their Team record.",
          '<ul class="st-list">' + (rl.filter((x) => x.scope !== "person").map((x) => '<li><span class="grow">' + esc(scope(x)) + '</span><span class="st-sum">' + esc(rateTxt(x)) + "</span></li>").join("") || '<li class="st-sum">No rates yet.</li>') + "</ul>" +
            (rl.some((x) => x.scope === "person") ? '<p class="st-sum">' + rl.filter((x) => x.scope === "person").length + " people have their own rate.</p>" : ""), btn("rates", "Change")) +
        card("stRules", "Time clock rules", "Pay periods, overtime, mileage, location and the midnight stop. The Timesheets page has the same Settings button.",
          '<p class="st-sum">Pay period: ' + (num(tc.pay_weeks) === 1 ? "every week" : "every 2 weeks") + ", Monday to Sunday" + (tc.pay_anchor ? " (one started " + esc(+tc.pay_anchor.slice(5, 7) + "/" + +tc.pay_anchor.slice(8, 10)) + ")" : "") + ", payday " + num(tc.payday_days) + " days after it ends. Overtime after " + num(tc.overtime_after) + " hours a week. Mileage $" + num(tc.mileage_rate).toFixed(3).replace(/0$/, "") + " a mile. A half day is under " + num(tc.half_day_hours) + " hours. " +
            "Location " + (tc.gps_on ? "saved" : "not saved") + " with each clock in and out. Clocks still running at midnight " + (tc.auto_out ? "are stopped there (marked stopped at midnight)" : "keep running") + ".</p>" +
            '<button type="button" class="link" data-st="payroll">Open payroll</button>', btn("rules", "Change")) +
        "</div>";
    }

    // ================================================================ Company
    async function loadCompany() {
      if (typeof loadHealth === "function") loadHealth();
      if (typeof GpTasks !== "undefined") GpTasks.loadSettings();
      try {
        const d = await Schedule.scheduleData();
        el("stCoBody").innerHTML = card("stStudio", "Studio and setup", "Drive times and trip miles start from the studio. Setup and teardown are added around each job on the Schedule.",
          '<p class="st-sum">Studio: ' + (d.studio_address ? esc(d.studio_address) : "<b>not set</b>, so drive times and job miles can&#39;t be looked up") + ".</p>" +
          '<p class="st-sum">Setup ' + num(d.setup_default != null ? d.setup_default : 30) + " minutes before each job, teardown " + num(d.teardown_default != null ? d.teardown_default : 30) + " minutes after.</p>",
          btn("studio", "Change"));
      } catch (e) { fail("stCoBody", e); }
    }

    // ================================================================ buttons
    const after = { onSaved: () => again(), onClose: () => again() };
    document.querySelector(".aca").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-st]");
      if (!b || !b.closest("#aca-panel-teamemails, #aca-panel-jobtypes, #aca-panel-teampay, #aca-panel-company")) return;
      const a = b.dataset.st;
      if (a === "dgsave") return saveDigest(b);
      if (a === "dgnow") {
        b.disabled = true; el("stDgMsg").textContent = "Sending…";
        sb.rpc("admin_morning_digest", { p_force: true }).then(({ data, error }) => {
          b.disabled = false;
          el("stDgMsg").textContent = error ? cleanErr(error) : (data && data.ok ? "Sent to " + (data.to || []).join(", ") + "." : "Could not send (" + ((data && data.error) || "unknown") + ").");
        });
        return;
      }
      if (a === "daily") return Assignments.openDaily(Object.assign({ values: te }, after));
      if (a === "crew") return Schedule.openCrewSettings(Object.assign({ only: "emails", settings: te }, after));
      if (a === "clock" || a === "rules") return TimeClock.openSettings(after);
      if (a === "payroll") return TimeClock.openPayroll();
      if (a === "roles") return Schedule.openCrewSettings(Object.assign({ only: "roles" }, after));
      if (a === "kinds") return StaffRecords.openKinds(after);
      if (a === "steps") return StaffRecords.openSteps(after);
      if (a === "rates") return TimeClockExtra.openRates(after);
      if (a === "studio") return Schedule.openStudio(after);
      if (a === "addtype") return addType();
      if (a === "gpdef") return openGpDefaults(b.dataset.k);
      if (a === "stages") return Bookings.openJobTypes(b.dataset.k, after);
      if (a === "step") return Workflows.openStep(jt.wf.steps.find((s) => s.id === b.dataset.id), after);
      if (a === "addstep") return Workflows.openStep(null, Object.assign({ type_key: b.dataset.k || null }, after));
    });
    // a "+ Add a checklist step" link is a button.link with data-st too (handled above)

    return { show };
  })();
