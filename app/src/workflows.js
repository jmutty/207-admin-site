  // ================================================================ JOBS: Job checklists (2026-10-22)
  // A checklist per job type (or every type). Each step is due some days after booking, before or after picture
  // day, or after launch, and goes to the job's crew (first person scheduled on it) or to one named person.
  // Booking a job turns the steps into one-time Assignments tasks, which follow the job when its picture day or
  // crew changes until someone edits them by hand. Track-only and cancelled jobs get none.
  // RPCs: workflow_jobs / workflow_templates / workflow_step_save / workflow_step_archive / workflow_attention
  // (migration 20261022180000). View = see checklists and every job's tasks; Edit = change the checklists.
  // 2026-10-22 (migration 20261022234500): a step can wait for another step (its task stays off people's lists until
  // that one is checked off), belong to a group ("Editing team": the least busy member gets it, anyone in it can
  // check it off), and have reminder rules (push the owner N days before; push + email a manager N days late).
  // Steps never email leagues or schools (2026-10-23, Jeremiah: hub messages cover that). Each step reads back as a sentence. Groups: staff_group_save / _archive.
  registerPage({ id: "checklists", group: "Jobs", section: "jobs", module: "workflows", title: "Job checklists",
                 tabs: [["checklists", "Jobs"], ["wfsteps", "Checklists"]], onShow: (tab) => (tab === "wfsteps" ? Workflows.loadSteps() : Workflows.loadJobs()) });
  registerAttention("workflowOverdue", { module: "workflows", level: "warn", name: "job checklist tasks",
    one: "A job checklist task is overdue.", many: "{n} job checklist tasks are overdue." });
  registerTodayLoader("workflows", () => Workflows.loadAttention());

  const Workflows = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const ANCHOR = { booked: "after booking", picture_day: "picture day", launch: "after launch" };

    const css = `
    .aca .wf-job { padding: 12px 0; border-bottom: 1px solid var(--line2); }
    .aca .wf-job h3 { margin: 0; font-size: 14.5px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .aca .wf-job h3 a { color: inherit; }
    .aca .wf-job .s { color: var(--muted); font-size: 12.5px; font-weight: 400; }
    .aca .wf-tasks { list-style: none; margin: 6px 0 0; padding: 0; }
    .aca .wf-tasks li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; align-items: baseline; padding: 4px 0; font-size: 13.5px; }
    .aca .wf-tasks li.done .t { text-decoration: line-through; color: var(--muted); }
    .aca .wf-tasks .w { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
    .aca .wf-tasks .late { color: var(--err-fg); font-weight: 600; }
    .aca .wf-tag { display: inline-block; font-size: 11.5px; font-weight: 700; padding: 0 6px; border-radius: 3px; background: var(--err-bg); color: var(--err-fg); margin-left: 6px; }
    .aca .wf-type { margin: 20px 0 4px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .aca .wf-table td, .aca .wf-table th { padding: 9px 10px; font-size: 13px; vertical-align: top; }
    .aca .wf-table tr.wf-row { cursor: pointer; } .aca .wf-table tr.wf-row:hover td { background: var(--surface-2); }
    .aca .wf-when { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .aca .wf-modal .field input[type=text], .aca .wf-modal .field select, .aca .wf-modal .field textarea { width: 100%; }
    .aca .wf-modal textarea { height: 64px; padding: 6px 10px; }
    .aca .wf-modal .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .aca .wf-modal .when { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .aca .wf-modal .when input { width: 80px; }
    .aca .wf-tasks li.wait .t { color: var(--muted); }
    .aca .wf-wait { display: block; font-size: 12px; color: var(--muted); }
    .aca .wf-say { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
    .aca .wf-modal .wf-say { margin: 0 0 12px; padding: 8px 10px; background: var(--surface-2); border-radius: 4px; color: inherit; font-size: 13px; }
    .aca .wf-rule { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 13.5px; margin: 0 0 8px; }
    .aca .wf-rule input[type=checkbox] { width: 16px; height: 16px; margin: 0; }
    .aca .wf-rule input[type=number] { width: 64px; }
    .aca .wf-modal fieldset { border: 1px solid var(--border); border-radius: 4px; padding: 8px 12px 4px; margin: 0 0 12px; }
    .aca .wf-modal legend { font-size: 12.5px; font-weight: 700; padding: 0 4px; }
    .aca .wf-groups li { padding: 8px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; list-style: none; }
    .aca .wf-groups { margin: 0; padding: 0; }
    .aca .wf-groups li.edit { cursor: pointer; } .aca .wf-groups li.edit:hover { background: var(--surface-2); }
    .aca .wf-people { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 4px 12px; max-height: 260px; overflow: auto; }
    .aca .wf-people label { display: flex; gap: 6px; align-items: center; font-size: 13.5px; }
    .aca .wf-people input { width: 16px; height: 16px; margin: 0; }
    @media (max-width: 700px) { .aca .wf-modal .row2 { grid-template-columns: 1fr; } .aca .wf-hide-sm { display: none; } }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    // "7 days before picture day", "Picture day", "2 days after booking"
    function whenText(s) {
      const n = Math.abs(s.offset_days), d = n === 1 ? "1 day" : n + " days";
      if (s.anchor === "picture_day") return s.offset_days === 0 ? "On picture day" : d + (s.offset_days < 0 ? " before" : " after") + " picture day";
      return s.offset_days === 0 ? (s.anchor === "launch" ? "At launch" : "When booked") : d + " " + ANCHOR[s.anchor];
    }

    // The whole step as one sentence: "Due 1 day after picture day, to the crew. Waits for Cards uploaded. ..."
    function sayStep(s) {
      const who = s.assign_to === "person" ? T.shortName(s.user_name || "the person") : s.assign_to === "group" ? "the " + (s.group_name || "group") + " (whoever has least on)" :
        "the crew on the job" + (s.user_name ? " (" + T.shortName(s.user_name) + " until someone is)" : "");
      const w = whenText(s), out = [(/^(On|At|When)/.test(w) ? "Due " + w.charAt(0).toLowerCase() + w.slice(1) : "Due " + w) + ", for " + who + "."];
      if (s.waits_for_title) out.push("Waits until " + s.waits_for_title + " is checked off.");
      const d = (n) => (n === 1 ? "1 day" : n + " days");
      if (s.remind_days) out.push("A push " + d(s.remind_days) + " before it is due.");
      if (s.late_days) out.push("If it is " + d(s.late_days) + " late, a push and email to " + (s.late_user_name ? T.shortName(s.late_user_name) : "the full-access people") + ".");
      return out.join(" ");
    }

    // ---------------------------------------------------------------- Jobs: each booked job's checklist
    const jobsRoot = el("panel-checklists");
    jobsRoot.innerHTML =
      '<div class="card"><div class="card-head"><div><h2>Job checklists</h2><p>Every booked job and its checklist tasks. Tasks land on each person&#39;s Assignments and get checked off there. They follow the job when its picture day or crew changes.</p></div>' +
      '<label style="font-size:13px">Show <select class="small" id="aca-wfShow"><option value="open">Jobs with tasks to do</option><option value="all">All jobs</option></select></label></div>' +
      '<div id="aca-wfErr" class="inline-error hidden"></div><div id="aca-wfJobs"><p class="empty">Loading&#8230;</p></div></div>';
    let jobs = null, show = "open";

    async function loadJobs() {
      clearError("wfErr");
      try {
        const { data, error } = await sb.rpc("workflow_jobs", {});
        if (error) throw error;
        jobs = data || [];
        renderJobs();
      } catch (e) { showError("wfErr", "Could not load job checklists: " + cleanErr(e)); }
    }
    function renderJobs() {
      const t = T.today();
      const list = jobs.filter((j) => show === "all" || j.open_count > 0);
      el("wfJobs").innerHTML = list.length ? list.map((j) =>
        '<div class="wf-job"><h3><a href="' + esc(typeof jobLink === "function" ? jobLink(j.booking_id, "checklist") : "#jobs/bookings/" + j.booking_id) + '">' + esc(j.title) + '</a><span class="s">' + esc(T.fmtDay(j.picture_day)) +
        (j.lead ? " · " + esc(T.shortName(j.lead)) : "") + " · " + (j.open_count ? j.open_count + " to do" : "all done") + "</span>" +
        (j.overdue_count ? '<span class="wf-tag">' + j.overdue_count + " overdue</span>" : "") + "</h3>" +
        '<ul class="wf-tasks">' + j.tasks.map((k) => {
          const done = !!k.done_at, late = !done && !k.waiting && k.due_on < t;
          return '<li class="' + (done ? "done" : k.waiting ? "wait" : "") + '"><span aria-hidden="true">' + (done ? "✓" : k.waiting ? "&#8987;" : "○") + '</span><span class="t">' + esc(k.title) +
            (k.priority === "urgent" ? '<span class="wf-tag">Urgent</span>' : "") + (k.waiting ? '<span class="wf-wait">waits for ' + esc(k.waits_for || "an earlier step") + "</span>" : "") +
            '</span><span class="w">' + esc(T.shortName(k.user_name || "")) + (k.group_name ? " (" + esc(k.group_name) + ")" : "") + " · " +
            (done ? "done " + esc(T.fmtDay(k.done_at.slice(0, 10))) : '<span class="' + (late ? "late" : "") + '">' + (k.due_on === t ? "today" : esc(T.fmtDay(k.due_on))) + "</span>") + "</span></li>";
        }).join("") + "</ul></div>").join("")
        : '<p class="empty">' + (jobs.length ? "Every job&#39;s checklist is done." : "No booked jobs have checklist tasks yet. Set up the steps on the Checklists tab, and the next job you book gets them.") + "</p>";
    }
    el("wfShow").addEventListener("change", () => { show = el("wfShow").value; if (jobs) renderJobs(); });

    // ---------------------------------------------------------------- Checklists: the steps per job type
    const stepsRoot = el("panel-wfsteps");
    stepsRoot.innerHTML =
      '<div class="card"><div class="card-head"><div><h2>Checklist steps</h2><p>The steps every booked job gets, per job type (also under Settings, Job types). A crew step goes to the first person scheduled on the job, or the backup person until someone is. Changes apply to jobs from today on.</p></div>' +
      '<button type="button" class="primary hidden" id="aca-wfAdd">Add step</button></div>' +
      '<div id="aca-wfSErr" class="inline-error hidden"></div><div id="aca-wfSteps"><p class="empty">Loading&#8230;</p></div></div>' +
      '<div class="card"><div class="card-head"><div><h2>Groups</h2><p>A group (like &#8220;Editing team&#8221;) can own a step. Each job&#39;s task goes to the member with the least on their list, and anyone in the group can check it off.</p></div>' +
      '<button type="button" class="small hidden" id="aca-wfGAdd">Add group</button></div><ul class="wf-groups" id="aca-wfGroups"></ul></div>';
    let tpl = null;

    async function loadSteps() {
      clearError("wfSErr");
      try {
        const { data, error } = await sb.rpc("workflow_templates");
        if (error) throw error;
        tpl = data;
        el("wfAdd").classList.toggle("hidden", !tpl.can_edit);
        el("wfGAdd").classList.toggle("hidden", !tpl.can_edit);
        renderSteps();
        renderGroups();
      } catch (e) { showError("wfSErr", "Could not load checklists: " + cleanErr(e)); }
    }
    const typeLabel = (k) => (k ? ((tpl.types.find((t) => t.key === k) || {}).label || k) : "Every job type");
    function renderSteps() {
      const groups = [null].concat(tpl.types.map((t) => t.key)).filter((k) => tpl.steps.some((s) => s.type_key === k));
      el("wfSteps").innerHTML = groups.length ? groups.map((k) =>
        '<div class="wf-type">' + esc(typeLabel(k)) + '</div><div class="table-wrap"><table class="wf-table"><thead><tr><th>Step</th><th>When</th><th class="wf-hide-sm">Who</th></tr></thead><tbody>' +
        tpl.steps.filter((s) => s.type_key === k).map((s) =>
          '<tr class="' + (tpl.can_edit ? "wf-row" : "") + '" data-id="' + esc(s.id) + '"><td><b>' + esc(s.title) + "</b>" + (s.priority === "urgent" ? '<span class="wf-tag">Urgent</span>' : "") +
          (s.notes ? '<div class="muted" style="font-size:12.5px">' + esc(s.notes) + "</div>" : "") + '<div class="wf-say">' + esc(sayStep(s)) + "</div>" +
          '</td><td class="wf-when">' + esc(whenText(s)) + '</td><td class="wf-hide-sm">' +
          esc(s.assign_to === "person" ? T.shortName(s.user_name || "") : s.assign_to === "group" ? (s.group_name || "Group") : "Crew" + (s.user_name ? " (else " + T.shortName(s.user_name) + ")" : "")) + "</td></tr>").join("") +
        "</tbody></table></div>").join("")
        : '<p class="empty">No steps yet.' + (tpl.can_edit ? " Add one, like &#8220;Pack the kit, 1 day before picture day&#8221;." : "") + "</p>";
    }
    el("wfAdd").addEventListener("click", () => openStep(null));
    el("wfSteps").addEventListener("click", (e) => { const r = e.target.closest("tr.wf-row"); if (r) openStep(tpl.steps.find((s) => s.id === r.dataset.id)); });

    function renderGroups() {
      const gs = tpl.groups || [];
      el("wfGroups").innerHTML = gs.length ? gs.map((g) => '<li class="' + (tpl.can_edit ? "edit" : "") + '" data-g="' + esc(g.id) + '"><b>' + esc(g.name) + "</b> &middot; " +
        (g.members.length ? esc(g.members.map((m) => T.shortName(m.name)).join(", ")) : '<span class="muted">nobody yet</span>') +
        (g.steps ? ' <span class="muted">&middot; owns ' + g.steps + (g.steps === 1 ? " step" : " steps") + "</span>" : "") + "</li>").join("")
        : '<li class="muted">No groups yet.</li>';
    }
    el("wfGAdd").addEventListener("click", () => openGroup(null));
    el("wfGroups").addEventListener("click", (e) => { const li = e.target.closest("li.edit[data-g]"); if (li) openGroup(tpl.groups.find((g) => g.id === li.dataset.g)); });
    function openGroup(g) {
      const isNew = !g; g = g || { name: "", members: [] };
      const have = new Set(g.members.map((m) => m.user_id));
      const m = openModal('<div class="wf-modal"><h2>' + (isNew ? "Add a group" : "Change group") + "</h2>" +
        '<div class="field"><label for="aca-wgName">Name</label><input type="text" id="aca-wgName" maxlength="60" value="' + esc(g.name) + '" placeholder="Editing team" /></div>' +
        '<div class="field"><label>Who is in it</label><div class="wf-people">' + tpl.people.map((p) => '<label><input type="checkbox" value="' + esc(p.user_id) + '"' + (have.has(p.user_id) ? " checked" : "") + " /> " + esc(T.shortName(p.name)) + "</label>").join("") + "</div></div>" +
        '<div class="inline-error hidden" id="aca-wgErr"></div><div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" data-m="remove">Remove</button>') +
        '<span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">' + (isNew ? "Add" : "Save") + "</button></div></div>");
      const err = (x) => { const e = el("wgErr"); e.textContent = x; e.classList.remove("hidden"); };
      m.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "cancel") return m.close();
        b.disabled = true;
        try {
          if (b.dataset.m === "remove") {
            if (!confirm("Remove the group " + g.name + "? Its steps go back to the crew on each job; open tasks keep their person.")) { b.disabled = false; return; }
            const { error } = await sb.rpc("staff_group_archive", { p_id: g.id }); if (error) throw error; toast("Removed.");
          } else {
            const p = { id: isNew ? null : g.id, name: el("wgName").value.trim(), members: [...m.querySelectorAll(".wf-people input:checked")].map((x) => x.value) };
            if (!p.name) { b.disabled = false; return err("Give the group a name."); }
            const { error } = await sb.rpc("staff_group_save", { p }); if (error) throw error; toast(isNew ? "Added." : "Saved.");
          }
          m.close(); loadSteps();
        } catch (e) { err(cleanErr(e)); b.disabled = false; }
      });
    }

    // The checklist steps for Settings > Job types (loads them when this page has not yet).
    async function templates() {
      if (tpl) return tpl;
      const { data, error } = await sb.rpc("workflow_templates");
      if (error) throw error;
      tpl = data;
      return tpl;
    }
    // One step dialog, opened from Checklist steps and from Settings > Job types.
    // opts.type_key: the job type a new step starts on; opts.onSaved: runs after a save or remove.
    async function openStepFor(s, opts) {
      try { await templates(); } catch (e) { toast(cleanErr(e), true); return; }
      openStep(s, opts);
    }
    function openStep(s, opts) {
      opts = opts || {};
      const after = () => { loadSteps(); if (opts.onSaved) opts.onSaved(); };
      const isNew = !s;
      s = s || { type_key: opts.type_key || null, title: "", notes: "", anchor: "picture_day", offset_days: -1, assign_to: "crew", user_id: null, priority: "normal",
                 waits_for: null, remind_days: 2, late_days: null, late_user_id: null, partner_email: false, partner_subject: "", partner_body: "" };
      const n = Math.abs(s.offset_days);
      const dir = s.anchor === "picture_day" ? (s.offset_days < 0 ? "before" : s.offset_days > 0 ? "after" : "on") : s.anchor;
      const people = tpl.people.map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === s.user_id ? " selected" : "") + ">" + esc(T.shortName(p.name)) + "</option>").join("");
      const m = openModal('<div class="wf-modal"><h2>' + (isNew ? "Add a step" : "Change step") + "</h2>" +
        '<div class="field"><label for="aca-wsTitle">Step</label><input type="text" id="aca-wsTitle" maxlength="120" value="' + esc(s.title) + '" placeholder="Pack the kit and charge batteries" /></div>' +
        '<div class="field"><label for="aca-wsType">Job type</label><select id="aca-wsType"><option value="">Every job type</option>' +
        tpl.types.map((t) => '<option value="' + esc(t.key) + '"' + (t.key === s.type_key ? " selected" : "") + ">" + esc(t.label) + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="aca-wsDays">Due</label><div class="when"><input type="number" id="aca-wsDays" min="0" max="365" value="' + n + '" aria-label="Days" /> days ' +
        '<select id="aca-wsDir"><option value="before">before picture day</option><option value="on">on picture day</option><option value="after">after picture day</option><option value="booked">after booking</option><option value="launch">after launch</option></select></div></div>' +
        '<div class="row2"><div class="field"><label for="aca-wsTo">Who</label><select id="aca-wsTo"><option value="crew"' + (s.assign_to === "crew" ? " selected" : "") + '>The crew on the job</option><option value="person"' + (s.assign_to === "person" ? " selected" : "") + ">One person</option>" +
        ((tpl.groups || []).length ? '<option value="group"' + (s.assign_to === "group" ? " selected" : "") + ">A group</option>" : "") + "</select></div>" +
        '<div class="field" id="aca-wsUserF"><label for="aca-wsUser" id="aca-wsUserL">Backup person</label><select id="aca-wsUser"><option value="">' + (s.assign_to === "person" ? "Pick someone…" : "Nobody (wait for crew)") + "</option>" + people + "</select></div>" +
        '<div class="field hidden" id="aca-wsGroupF"><label for="aca-wsGroup">Group</label><select id="aca-wsGroup"><option value="">Pick a group…</option>' +
        (tpl.groups || []).map((g) => '<option value="' + esc(g.id) + '"' + (g.id === s.group_id ? " selected" : "") + ">" + esc(g.name) + "</option>").join("") + "</select></div></div>" +
        '<div class="field"><label for="aca-wsWaits">Waits for</label><select id="aca-wsWaits"><option value="">Nothing, it starts on its own</option></select></div>' +
        '<div class="field"><label>Priority</label><div class="seg" role="radiogroup" aria-label="Priority"><label><input type="radio" name="aca-wsPri" value="normal"' + (s.priority !== "urgent" ? " checked" : "") + ' /><span>Normal</span></label><label><input type="radio" name="aca-wsPri" value="urgent"' + (s.priority === "urgent" ? " checked" : "") + " /><span>Urgent</span></label></div></div>" +
        '<div class="field"><label for="aca-wsNotes">Notes</label><textarea id="aca-wsNotes" maxlength="2000">' + esc(s.notes || "") + "</textarea></div>" +
        '<fieldset><legend>Reminders</legend>' +
        '<label class="wf-rule"><input type="checkbox" id="aca-wsRemOn"' + (s.remind_days ? " checked" : "") + ' /> Push the owner <input type="number" id="aca-wsRem" min="1" max="30" value="' + (s.remind_days || 2) + '" aria-label="Days before" /> days before it is due</label>' +
        '<label class="wf-rule"><input type="checkbox" id="aca-wsLateOn"' + (s.late_days ? " checked" : "") + ' /> If it is <input type="number" id="aca-wsLate" min="1" max="30" value="' + (s.late_days || 1) + '" aria-label="Days late" /> days late, push and email ' +
        '<select class="small" id="aca-wsLateUser"><option value="">the full-access people</option>' + tpl.people.map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === s.late_user_id ? " selected" : "") + ">" + esc(T.shortName(p.name)) + "</option>").join("") + "</select></label>" +
        "</fieldset>" +
        '<p class="wf-say" id="aca-wsSay"></p>' +
        '<div class="inline-error hidden" id="aca-wsErr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" data-m="remove">Remove</button>') + '<span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">' + (isNew ? "Add" : "Save") + "</button></div></div>");
      el("wsDir").value = dir;
      // steps it can wait for: same job type or every type, not itself
      const fillWaits = () => {
        const tk = el("wsType").value || null, cur = el("wsWaits").value || s.waits_for || "";
        el("wsWaits").innerHTML = '<option value="">Nothing, it starts on its own</option>' + tpl.steps.filter((x) => x.id !== s.id && (!x.type_key || x.type_key === tk))
          .map((x) => '<option value="' + esc(x.id) + '">' + esc(x.title) + (x.type_key ? "" : " (every job type)") + "</option>").join("");
        el("wsWaits").value = [...el("wsWaits").options].some((o) => o.value === cur) ? cur : "";
      };
      fillWaits();
      const form = () => {
        const d = el("wsDir").value, days = Math.max(0, Math.round(+el("wsDays").value || 0)), to = el("wsTo").value;
        const person = tpl.people.find((p) => p.user_id === el("wsUser").value), grp = (tpl.groups || []).find((g) => g.id === el("wsGroup").value);
        const late = tpl.people.find((p) => p.user_id === el("wsLateUser").value), waits = tpl.steps.find((x) => x.id === el("wsWaits").value);
        return { id: isNew ? null : s.id, type_key: el("wsType").value || null, title: el("wsTitle").value.trim(), notes: el("wsNotes").value.trim(),
          anchor: d === "booked" || d === "launch" ? d : "picture_day", offset_days: d === "before" ? -days : d === "on" ? 0 : days,
          assign_to: to, user_id: to === "group" ? null : el("wsUser").value || null, user_name: person ? person.name : null,
          group_id: to === "group" ? el("wsGroup").value || null : null, group_name: grp ? grp.name : null,
          priority: m.querySelector('input[name="aca-wsPri"]:checked').value, waits_for: el("wsWaits").value || null, waits_for_title: waits ? waits.title : null,
          remind_days: el("wsRemOn").checked ? Math.max(1, Math.min(30, Math.round(+el("wsRem").value || 2))) : null,
          late_days: el("wsLateOn").checked ? Math.max(1, Math.min(30, Math.round(+el("wsLate").value || 1))) : null,
          late_user_id: el("wsLateOn").checked ? el("wsLateUser").value || null : null, late_user_name: late ? late.name : null,
          partner_email: false, partner_subject: "", partner_body: "" };
      };
      const sync = () => {
        const on = el("wsDir").value === "on", to = el("wsTo").value;
        el("wsDays").disabled = on; if (on) el("wsDays").value = 0;
        el("wsUserL").textContent = to === "person" ? "Person" : "Backup person";
        el("wsUser").options[0].textContent = to === "person" ? "Pick someone…" : "Nobody (wait for crew)";
        el("wsUserF").classList.toggle("hidden", to === "group");
        el("wsGroupF").classList.toggle("hidden", to !== "group");
        el("wsSay").textContent = sayStep(Object.assign(form(), { title: el("wsTitle").value.trim() || "this step" }));
      };
      sync();
      m.addEventListener("change", (e) => { if (e.target.id === "aca-wsType") fillWaits(); sync(); });
      m.addEventListener("input", sync);
      const err = (x) => { const e = el("wsErr"); e.textContent = x; e.classList.remove("hidden"); };
      m.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "cancel") m.close();
        if (b.dataset.m === "remove") {
          if (!confirm("Remove “" + s.title + "”? Its open tasks come off people's lists. Tasks already done stay.")) return;
          b.disabled = true;
          try { const { error } = await sb.rpc("workflow_step_archive", { p_id: s.id }); if (error) throw error; m.close(); toast("Removed."); after(); }
          catch (e) { err(cleanErr(e)); b.disabled = false; }
        }
        if (b.dataset.m === "save") {
          const f = form(), p = {};
          ["id", "type_key", "title", "notes", "anchor", "offset_days", "assign_to", "user_id", "group_id", "priority", "waits_for", "remind_days", "late_days", "late_user_id",
           "partner_email", "partner_subject", "partner_body"].forEach((k) => { p[k] = f[k]; });
          if (!p.title) return err("Give the step a name.");
          if (p.assign_to === "person" && !p.user_id) return err("Pick the person.");
          if (p.assign_to === "group" && !p.group_id) return err("Pick the group.");
          b.disabled = true;
          try { const { error } = await sb.rpc("workflow_step_save", { p }); if (error) throw error; m.close(); toast(isNew ? "Added. Booked jobs get it now." : "Saved."); after(); }
          catch (e) { err(cleanErr(e)); b.disabled = false; }
        }
      });
    }

    async function loadAttention() {
      try {
        const { data: d, error } = await sb.rpc("workflow_attention");
        if (error) throw error;
        setAttention("workflowOverdue", num(d && d.overdue), "Overdue checklist tasks", "checklists");
      } catch (_e) { /* Today reports it as unchecked */ }
    }

    return { loadJobs, loadSteps, loadAttention, templates, openStep: openStepFor, sayStep, whenText };
  })();
