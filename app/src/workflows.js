  // ================================================================ JOBS: Job checklists (2026-10-22)
  // A checklist per job type (or every type). Each step is due some days after booking, before or after picture
  // day, or after launch, and goes to the job's crew (first person scheduled on it) or to one named person.
  // Booking a job turns the steps into one-time Assignments tasks, which follow the job when its picture day or
  // crew changes until someone edits them by hand. Track-only and cancelled jobs get none.
  // RPCs: workflow_jobs / workflow_templates / workflow_step_save / workflow_step_archive / workflow_attention
  // (migration 20261022180000). View = see checklists and every job's tasks; Edit = change the checklists.
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
    @media (max-width: 700px) { .aca .wf-modal .row2 { grid-template-columns: 1fr; } .aca .wf-hide-sm { display: none; } }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    // "7 days before picture day", "Picture day", "2 days after booking"
    function whenText(s) {
      const n = Math.abs(s.offset_days), d = n === 1 ? "1 day" : n + " days";
      if (s.anchor === "picture_day") return s.offset_days === 0 ? "On picture day" : d + (s.offset_days < 0 ? " before" : " after") + " picture day";
      return s.offset_days === 0 ? (s.anchor === "launch" ? "At launch" : "When booked") : d + " " + ANCHOR[s.anchor];
    }

    // ---------------------------------------------------------------- Jobs: each booked job's checklist
    const jobsRoot = el("panel-checklists");
    jobsRoot.innerHTML =
      '<div class="card"><div class="card-head"><div><h2>Booked jobs</h2><p>Every booked job and its checklist tasks. Tasks land on each person&#39;s Assignments and get checked off there. They follow the job when its picture day or crew changes.</p></div>' +
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
        '<div class="wf-job"><h3><a href="#jobs/bookings/' + esc(j.booking_id) + '">' + esc(j.title) + '</a><span class="s">' + esc(T.fmtDay(j.picture_day)) +
        (j.lead ? " · " + esc(T.shortName(j.lead)) : "") + " · " + (j.open_count ? j.open_count + " to do" : "all done") + "</span>" +
        (j.overdue_count ? '<span class="wf-tag">' + j.overdue_count + " overdue</span>" : "") + "</h3>" +
        '<ul class="wf-tasks">' + j.tasks.map((k) => {
          const done = !!k.done_at, late = !done && k.due_on < t;
          return '<li class="' + (done ? "done" : "") + '"><span aria-hidden="true">' + (done ? "✓" : "○") + '</span><span class="t">' + esc(k.title) +
            (k.priority === "urgent" ? '<span class="wf-tag">Urgent</span>' : "") + '</span><span class="w">' + esc(T.shortName(k.user_name || "")) + " · " +
            (done ? "done " + esc(T.fmtDay(k.done_at.slice(0, 10))) : '<span class="' + (late ? "late" : "") + '">' + (k.due_on === t ? "today" : esc(T.fmtDay(k.due_on))) + "</span>") + "</span></li>";
        }).join("") + "</ul></div>").join("")
        : '<p class="empty">' + (jobs.length ? "Every job&#39;s checklist is done." : "No booked jobs have checklist tasks yet. Set up the steps on the Checklists tab, and the next job you book gets them.") + "</p>";
    }
    el("wfShow").addEventListener("change", () => { show = el("wfShow").value; if (jobs) renderJobs(); });

    // ---------------------------------------------------------------- Checklists: the steps per job type
    const stepsRoot = el("panel-wfsteps");
    stepsRoot.innerHTML =
      '<div class="card"><div class="card-head"><div><h2>Checklists</h2><p>The steps every booked job gets, per job type. A crew step goes to the first person scheduled on the job, or the backup person until someone is. Changes apply to jobs from today on.</p></div>' +
      '<button type="button" class="primary hidden" id="aca-wfAdd">Add step</button></div>' +
      '<div id="aca-wfSErr" class="inline-error hidden"></div><div id="aca-wfSteps"><p class="empty">Loading&#8230;</p></div></div>';
    let tpl = null;

    async function loadSteps() {
      clearError("wfSErr");
      try {
        const { data, error } = await sb.rpc("workflow_templates");
        if (error) throw error;
        tpl = data;
        el("wfAdd").classList.toggle("hidden", !tpl.can_edit);
        renderSteps();
      } catch (e) { showError("wfSErr", "Could not load checklists: " + cleanErr(e)); }
    }
    const typeLabel = (k) => (k ? ((tpl.types.find((t) => t.key === k) || {}).label || k) : "Every job type");
    function renderSteps() {
      const groups = [null].concat(tpl.types.map((t) => t.key)).filter((k) => tpl.steps.some((s) => s.type_key === k));
      el("wfSteps").innerHTML = groups.length ? groups.map((k) =>
        '<div class="wf-type">' + esc(typeLabel(k)) + '</div><div class="table-wrap"><table class="wf-table"><thead><tr><th>Step</th><th>When</th><th class="wf-hide-sm">Who</th></tr></thead><tbody>' +
        tpl.steps.filter((s) => s.type_key === k).map((s) =>
          '<tr class="' + (tpl.can_edit ? "wf-row" : "") + '" data-id="' + esc(s.id) + '"><td><b>' + esc(s.title) + "</b>" + (s.priority === "urgent" ? '<span class="wf-tag">Urgent</span>' : "") +
          (s.notes ? '<div class="muted" style="font-size:12.5px">' + esc(s.notes) + "</div>" : "") + '</td><td class="wf-when">' + esc(whenText(s)) + '</td><td class="wf-hide-sm">' +
          esc(s.assign_to === "person" ? T.shortName(s.user_name || "") : "Crew" + (s.user_name ? " (else " + T.shortName(s.user_name) + ")" : "")) + "</td></tr>").join("") +
        "</tbody></table></div>").join("")
        : '<p class="empty">No steps yet.' + (tpl.can_edit ? " Add one, like &#8220;Pack the kit, 1 day before picture day&#8221;." : "") + "</p>";
    }
    el("wfAdd").addEventListener("click", () => openStep(null));
    el("wfSteps").addEventListener("click", (e) => { const r = e.target.closest("tr.wf-row"); if (r) openStep(tpl.steps.find((s) => s.id === r.dataset.id)); });

    function openStep(s) {
      const isNew = !s;
      s = s || { type_key: null, title: "", notes: "", anchor: "picture_day", offset_days: -1, assign_to: "crew", user_id: null, priority: "normal" };
      const n = Math.abs(s.offset_days);
      const dir = s.anchor === "picture_day" ? (s.offset_days < 0 ? "before" : s.offset_days > 0 ? "after" : "on") : s.anchor;
      const people = tpl.people.map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === s.user_id ? " selected" : "") + ">" + esc(T.shortName(p.name)) + "</option>").join("");
      const m = openModal('<div class="wf-modal"><h2>' + (isNew ? "Add a step" : "Change step") + "</h2>" +
        '<div class="field"><label for="aca-wsTitle">Step</label><input type="text" id="aca-wsTitle" maxlength="120" value="' + esc(s.title) + '" placeholder="Pack the kit and charge batteries" /></div>' +
        '<div class="field"><label for="aca-wsType">Job type</label><select id="aca-wsType"><option value="">Every job type</option>' +
        tpl.types.map((t) => '<option value="' + esc(t.key) + '"' + (t.key === s.type_key ? " selected" : "") + ">" + esc(t.label) + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="aca-wsDays">Due</label><div class="when"><input type="number" id="aca-wsDays" min="0" max="365" value="' + n + '" aria-label="Days" /> days ' +
        '<select id="aca-wsDir"><option value="before">before picture day</option><option value="on">on picture day</option><option value="after">after picture day</option><option value="booked">after booking</option><option value="launch">after launch</option></select></div></div>' +
        '<div class="row2"><div class="field"><label for="aca-wsTo">Who</label><select id="aca-wsTo"><option value="crew"' + (s.assign_to === "crew" ? " selected" : "") + '>The crew on the job</option><option value="person"' + (s.assign_to === "person" ? " selected" : "") + ">One person</option></select></div>" +
        '<div class="field"><label for="aca-wsUser" id="aca-wsUserL">Backup person</label><select id="aca-wsUser"><option value="">' + (s.assign_to === "person" ? "Pick someone…" : "Nobody (wait for crew)") + "</option>" + people + "</select></div></div>" +
        '<div class="field"><label>Priority</label><div class="seg" role="radiogroup" aria-label="Priority"><label><input type="radio" name="aca-wsPri" value="normal"' + (s.priority !== "urgent" ? " checked" : "") + ' /><span>Normal</span></label><label><input type="radio" name="aca-wsPri" value="urgent"' + (s.priority === "urgent" ? " checked" : "") + " /><span>Urgent</span></label></div></div>" +
        '<div class="field"><label for="aca-wsNotes">Notes</label><textarea id="aca-wsNotes" maxlength="2000">' + esc(s.notes || "") + "</textarea></div>" +
        '<div class="inline-error hidden" id="aca-wsErr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" data-m="remove">Remove</button>') + '<span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">' + (isNew ? "Add" : "Save") + "</button></div></div>");
      el("wsDir").value = dir;
      const sync = () => {
        const on = el("wsDir").value === "on";
        el("wsDays").disabled = on; if (on) el("wsDays").value = 0;
        el("wsUserL").textContent = el("wsTo").value === "person" ? "Person" : "Backup person";
        el("wsUser").options[0].textContent = el("wsTo").value === "person" ? "Pick someone…" : "Nobody (wait for crew)";
      };
      sync();
      el("wsDir").addEventListener("change", sync);
      el("wsTo").addEventListener("change", sync);
      const err = (x) => { const e = el("wsErr"); e.textContent = x; e.classList.remove("hidden"); };
      m.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "cancel") m.close();
        if (b.dataset.m === "remove") {
          if (!confirm("Remove “" + s.title + "”? Its open tasks come off people's lists. Tasks already done stay.")) return;
          b.disabled = true;
          try { const { error } = await sb.rpc("workflow_step_archive", { p_id: s.id }); if (error) throw error; m.close(); toast("Removed."); loadSteps(); }
          catch (e) { err(cleanErr(e)); b.disabled = false; }
        }
        if (b.dataset.m === "save") {
          const d = el("wsDir").value, days = Math.max(0, Math.round(+el("wsDays").value || 0));
          const p = { id: isNew ? null : s.id, type_key: el("wsType").value || null, title: el("wsTitle").value.trim(), notes: el("wsNotes").value.trim(),
            anchor: d === "booked" || d === "launch" ? d : "picture_day", offset_days: d === "before" ? -days : d === "on" ? 0 : days,
            assign_to: el("wsTo").value, user_id: el("wsUser").value || null, priority: m.querySelector('input[name="aca-wsPri"]:checked').value };
          if (!p.title) return err("Give the step a name.");
          if (p.assign_to === "person" && !p.user_id) return err("Pick the person.");
          b.disabled = true;
          try { const { error } = await sb.rpc("workflow_step_save", { p }); if (error) throw error; m.close(); toast(isNew ? "Added. Booked jobs get it now." : "Saved."); loadSteps(); }
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

    return { loadJobs, loadSteps, loadAttention };
  })();
