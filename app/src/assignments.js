  // ================================================================ STAFF: Assignments (2026-10-22)
  // My day: my scheduled time (jobs with when to leave, other time, time off) and my tasks to check off.
  // Tasks: daily (on chosen weekdays), weekly, monthly or one-time tasks per person, with a priority. A missed
  // task carries over as overdue until done or its next due day; urgent ones sit at the top. People with Edit
  // see and assign everyone's; View is your own. Each evening (8pm by default) a "Tomorrow" push sums up the
  // next day. RPCs: my_day / assignments_day / assignment_check / assignments_list / assignment_save /
  // assignment_archive / staff_settings_save. Each morning a "Your day" email too (day_email_status /
  // day_email_settings_save / day_email_mine; migration 20261022160000).
  registerPage({ id: "myday", group: "Staff", section: "staff", module: "assignments", title: "Assignments", selfService: true, // View = use it for your own tasks, so no "view-only" notice
                 tabs: [["myday", "My day"], ["tasks", "Tasks"]], onShow: (tab) => (tab === "tasks" ? Assignments.loadTasks() : Assignments.loadDay()) });
  registerTodayLoader("assignments", () => Assignments.loadToday());

  const Assignments = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const REPEAT = { once: "Once", daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

    const css = `
    .aca .as-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 0 14px; }
    .aca .as-bar h2 { margin: 0 8px 0 4px; font-size: 17px; font-weight: 600; }
    .aca .as-bar .grow { flex: 1; }
    .aca .as-sec { margin: 0 0 26px; }
    .aca .as-sec h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .aca .as-plan { list-style: none; margin: 0; padding: 0; }
    .aca .as-hrs { margin: 0 0 6px; font-size: 13.5px; color: var(--muted); }
    .aca .as-plan li { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line2); font-size: 14px; }
    .aca .as-plan .t { font-weight: 600; white-space: nowrap; }
    .aca .as-plan .drive { color: #8a6100; }
    .aca .as-plan .s { display: block; color: var(--muted); font-size: 12.5px; }
    .aca .as-task { display: flex; gap: 10px; align-items: flex-start; padding: 9px 0; border-bottom: 1px solid var(--line2); font-size: 14px; }
    .aca .as-task input { margin-top: 3px; width: 18px; height: 18px; flex: none; }
    .aca .as-task.done .as-title { text-decoration: line-through; color: var(--muted); }
    .aca .as-task .s { display: block; color: var(--muted); font-size: 12.5px; white-space: pre-wrap; }
    .aca .as-tag { display: inline-block; font-size: 11.5px; font-weight: 700; padding: 0 6px; border-radius: 3px; margin-left: 6px; vertical-align: 1px; }
    .aca .as-tag.urgent { background: var(--err-bg); color: var(--err-fg); }
    .aca .as-tag.overdue { background: var(--warn-bg); color: var(--warn-fg); }
    .aca .as-who { margin: 18px 0 2px; font-size: 13.5px; font-weight: 700; }
    .aca .as-table td, .aca .as-table th { padding: 9px 10px; font-size: 13px; vertical-align: top; }
    .aca .as-table tr.as-row { cursor: pointer; } .aca .as-table tr.as-row:hover td { background: var(--surface-2); }
    .aca .as-modal .field input[type=text], .aca .as-modal .field select, .aca .as-modal .field textarea { width: 100%; }
    .aca .as-modal textarea { height: 64px; padding: 6px 10px; }
    .aca .as-modal .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .aca .as-days { display: flex; gap: 4px; flex-wrap: wrap; }
    .aca .as-days label { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; font-size: 13px; cursor: pointer; }
    .aca .as-days input { margin: 0; }
    .aca .as-mail { display: flex; gap: 8px; align-items: center; margin-top: 18px; font-size: 13.5px; color: var(--muted); }
    .aca .as-mail input { width: 16px; height: 16px; margin: 0; }
    .aca .as-settings { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 13.5px; padding: 12px 0; }
    @media (max-width: 700px) { .aca .as-plan li { grid-template-columns: 1fr; gap: 2px; } .aca .as-modal .row2 { grid-template-columns: 1fr; } .aca .as-hide-sm { display: none; } }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    // ---------------------------------------------------------------- My day
    const dayRoot = el("panel-myday");
    dayRoot.innerHTML =
      '<div class="as-bar"><button type="button" class="small" data-v="prev" aria-label="Day before">&lsaquo;</button><button type="button" class="small" data-v="today">Today</button>' +
      '<button type="button" class="small" data-v="tomorrow">Tomorrow</button><button type="button" class="small" data-v="next" aria-label="Day after">&rsaquo;</button>' +
      '<h2 id="aca-asTitle">My day</h2><span class="grow"></span>' +
      '<label class="hidden" id="aca-asWhoWrap" style="font-size:13px">Showing <select class="small" id="aca-asWho"><option value="me">Me</option><option value="all">Everyone</option></select></label></div>' +
      '<div id="aca-asErr" class="inline-error hidden"></div><div id="aca-asBody"><p class="empty">Loading&#8230;</p></div>';
    // Evenings open on tomorrow (that is what the 8pm notification is about).
    let day = null, who = "me", people = [];
    const defaultDay = () => (T.local(Date.now()).min >= 18 * 60 ? T.addDays(T.today(), 1) : T.today());

    async function loadDay() {
      if (!day) day = defaultDay();
      clearError("asErr");
      const t = T.today();
      el("asTitle").textContent = (day === t ? "Today, " : day === T.addDays(t, 1) ? "Tomorrow, " : day === T.addDays(t, -1) ? "Yesterday, " : "") + T.fmtDay(day, { weekday: "long" });
      const canAll = canEdit("assignments");
      el("asWhoWrap").classList.toggle("hidden", !canAll);
      if (canAll && !people.length) await loadPeople();
      try {
        if (who === "me") {
          const { data, error } = await sb.rpc("my_day", { p_day: day });
          if (error) throw error;
          renderMine(data);
        } else {
          const { data, error } = await sb.rpc("assignments_day", who === "all" ? { p_day: day, p_all: true } : { p_day: day, p_user: who });
          if (error) throw error;
          renderTasks(data || [], true);
        }
      } catch (e) { showError("asErr", "Could not load the day: " + cleanErr(e)); }
    }
    async function loadPeople() {
      const { data } = await sb.rpc("assignments_list");
      people = ((data && data.people) || []).map((p) => Object.assign({}, p, { name: T.shortName(p.name) }));
      el("asWho").innerHTML = '<option value="me">Me</option><option value="all">Everyone</option>' + people.filter((p) => p.user_id !== (data && data.me)).map((p) => '<option value="' + esc(p.user_id) + '">' + esc(p.name) + "</option>").join("");
      el("asWho").value = who;
    }

    function renderMine(d) {
      const rows = [];
      (d.entries || []).forEach((e) => {
        const s = new Date(e.starts_at), en = new Date(e.ends_at);
        const sDay = T.local(e.starts_at).day, eDay = T.local(e.ends_at).day;
        if (e.kind === "off") { rows.push([0, '<li><span class="t">All day</span><span>Time off' + (e.title ? ": " + esc(e.title) : "") + "</span></li>"]); return; }
        const su = e.kind === "job" ? num(e.setup_min) : 0, td = e.kind === "job" ? num(e.teardown_min) : 0;
        if (e.kind === "job" && e.drive_before_min) {
          const leave = new Date(s - (e.drive_before_min + su) * 6e4).toISOString();
          rows.push([T.local(leave).min, '<li class="drive"><span class="t drive">' + esc(T.fmtTs(leave)) + '</span><span class="drive">' + (e.from_last_job ? "Leave the last job" : e.from_home ? "Leave home" : "Leave the studio") + " (" + num(e.drive_before_min) + " min drive)</span></li>"]);
        }
        if (su) { const at = new Date(s - su * 6e4).toISOString(); rows.push([T.local(at).min, '<li><span class="t drive">' + esc(T.fmtTs(at)) + '</span><span class="drive">Set up (' + su + " min)</span></li>"]); }
        rows.push([sDay < day ? 0 : T.local(e.starts_at).min, '<li><span class="t">' + esc(T.fmtTs(e.starts_at)) + "\u2013" + esc(T.fmtTs(e.ends_at)) + (eDay > day ? "+" : "") + "</span><span>" +
          esc(e.kind === "job" ? e.booking_title : e.title || ({ studio: "Studio", admin: "Admin" })[e.kind] || "Work") + (e.booking_status === "cancelled" ? ' <span class="as-tag urgent">cancelled</span>' : "") +
          (e.booking_location ? '<span class="s">' + esc(e.booking_location) + "</span>" : "") + (e.note ? '<span class="s">' + esc(e.note) + "</span>" : "") + "</span></li>"]);
        if (td) { rows.push([T.local(e.ends_at).min + 0.5, '<li><span class="t drive">' + esc(T.fmtTs(e.ends_at)) + '</span><span class="drive">Tear down (' + td + " min)</span></li>"]); }
        if (e.kind === "job" && e.drive_after_min) {
          const back = new Date(en.getTime() + (e.drive_after_min + td) * 6e4).toISOString();
          rows.push([T.local(back).min, '<li><span class="t drive">' + esc(T.fmtTs(back)) + '</span><span class="drive">' + (e.from_home ? "Back home" : "Back at the studio") + " (" + num(e.drive_after_min) + " min drive)</span></li>"]);
        }
      });
      rows.sort((a, b) => a[0] - b[0]);
      const hrs = T.workHours(d.entries || [], day);
      const hrsLine = hrs > 0 ? '<p class="as-hrs">' + (Math.round(hrs * 4) / 4) + " hours scheduled" + (hrs >= T.LUNCH_AFTER_H ? ' <span class="as-tag overdue">Plan a lunch break</span>' : "") + "</p>" : "";
      el("asBody").innerHTML =
        '<div class="as-sec"><h3>Schedule</h3>' + hrsLine + (rows.length ? '<ul class="as-plan">' + rows.map((r) => r[1]).join("") + "</ul>" : '<p class="empty">Nothing on the schedule.' + (canSee("scheduling") ? ' <a href="#staff/schedule">Open the schedule</a>' : "") + "</p>") + "</div>" +
        '<div class="as-sec"><h3>Tasks</h3><div id="aca-asTasks"></div></div>' +
        '<label class="as-mail hidden"><input type="checkbox" id="aca-asMailMine" /> Email me my day each morning</label>';
      renderTasks(d.tasks || [], false, el("asTasks"));
      sb.rpc("day_email_status").then(({ data: m }) => {
        const box = el("asMailMine"); if (!m || !box) return;
        box.checked = !!m.mine; box.disabled = !m.on;
        box.parentNode.title = m.on ? "" : "The morning email is switched off for everyone.";
        box.parentNode.classList.remove("hidden");
      });
    }

    function taskHtml(t) {
      const done = !!t.done_at;
      const since = t.overdue ? "from " + T.fmtDay(t.on_date) : "";
      return '<label class="as-task' + (done ? " done" : "") + '"><input type="checkbox" data-task="' + esc(t.task_id) + '" data-on="' + esc(t.on_date) + '"' + (done ? " checked" : "") + " />" +
        '<span><span class="as-title">' + esc(t.title) + "</span>" + (t.priority === "urgent" ? '<span class="as-tag urgent">Urgent</span>' : "") + (t.overdue && !done ? '<span class="as-tag overdue">Overdue, ' + esc(since) + "</span>" : "") +
        '<span class="s">' + esc([REPEAT[t.repeat], t.est_minutes ? "about " + t.est_minutes + " min" : "", done ? "done " + T.fmtTs(t.done_at) + (t.done_by ? " by " + T.shortName(t.done_by) : "") : ""].filter(Boolean).join(" \u00b7 ")) + "</span>" +
        (t.notes ? '<span class="s">' + esc(t.notes) + "</span>" : "") + "</span></label>";
    }
    function renderTasks(list, grouped, into) {
      const box = into || el("asBody");
      if (!list.length) { box.innerHTML = '<p class="empty">No tasks ' + (day === T.today() ? "today" : "this day") + "." + (canEdit("assignments") ? ' <a href="#staff/tasks">Assign one</a>' : "") + "</p>"; return; }
      if (!grouped) { box.innerHTML = list.map(taskHtml).join(""); return; }
      const names = [...new Set(list.map((t) => t.user_name))];
      box.innerHTML = names.map((n) => '<div class="as-who">' + esc(T.shortName(n)) + "</div>" + list.filter((t) => t.user_name === n).map(taskHtml).join("")).join("");
    }

    dayRoot.addEventListener("click", (e) => {
      const v = e.target.closest("[data-v]"); if (!v) return;
      const a = v.dataset.v;
      if (a === "prev") day = T.addDays(day, -1);
      if (a === "next") day = T.addDays(day, 1);
      if (a === "today") day = T.today();
      if (a === "tomorrow") day = T.addDays(T.today(), 1);
      loadDay();
    });
    dayRoot.addEventListener("change", async (e) => {
      if (e.target.id === "aca-asWho") { who = e.target.value; loadDay(); return; }
      if (e.target.id === "aca-asMailMine") {
        const on = e.target.checked;
        const { error } = await sb.rpc("day_email_mine", { p_on: on });
        if (error) { e.target.checked = !on; toast(cleanErr(error), true); return; }
        toast(on ? "You'll get your day by email each morning." : "Morning email off for you.");
        return;
      }
      const cb = e.target.closest("[data-task]"); if (!cb) return;
      cb.disabled = true;
      try {
        const { error } = await sb.rpc("assignment_check", { p_task: cb.dataset.task, p_on: cb.dataset.on, p_done: cb.checked });
        if (error) throw error;
        loadDay();
      } catch (err) { cb.checked = !cb.checked; cb.disabled = false; toast(cleanErr(err), true); }
    });

    // ---------------------------------------------------------------- Tasks (manage)
    const taskRoot = el("panel-tasks");
    taskRoot.innerHTML =
      '<div class="card"><div class="card-head"><div><h2>Tasks</h2><p>Daily, weekly, monthly and one-time tasks for each person. They show on that person&#39;s My day and in the evening notification. A missed task carries over until it is done (or its next due day comes around); urgent ones go to the top.</p></div>' +
      '<select class="small hidden" id="aca-asFilter" aria-label="Person"></select><button type="button" class="primary hidden" id="aca-asAdd">Add task</button></div>' +
      '<div id="aca-asTErr" class="inline-error hidden"></div>' +
      '<div class="table-wrap"><table class="as-table"><thead><tr><th>Task</th><th>Who</th><th>Repeats</th><th class="as-hide-sm">Last done</th></tr></thead><tbody id="aca-asTBody"><tr><td colspan="4" class="empty">Loading&#8230;</td></tr></tbody></table></div></div>' +
      '<div class="card hidden" id="aca-asSetCard"><div class="card-head"><div><h2>Evening notification</h2><p>Each person with Assignments gets a notification with the next day&#39;s jobs (and when to leave), other scheduled time and tasks. Nothing is sent when there is nothing on. Set it before noon and it is about the same day instead. Everyone can switch it off for themselves under Notifications.</p></div></div>' +
      '<div class="as-settings"><label><input type="checkbox" id="aca-asPlanOn" /> Send it</label> at <select class="small" id="aca-asPlanHour"></select> <button type="button" class="small" id="aca-asPlanSave">Save</button></div>' +
      '<div class="card-head"><div><h2>Morning email</h2><p>Each person with Assignments also gets an email in the morning with that day&#39;s schedule (with when to leave for on site jobs, hours and a lunch reminder at 6 hours) and their tasks, urgent first. Nothing is sent on a day with nothing on. Everyone can switch it off for themselves on My day.</p></div></div>' +
      '<div class="as-settings"><label><input type="checkbox" id="aca-asMailOn" /> Send it</label> at <select class="small" id="aca-asMailHour"></select> <button type="button" class="small" id="aca-asMailSave">Save</button></div></div>';
    el("asPlanHour").innerHTML = Array.from({ length: 18 }, (_, i) => i + 4).map((h) => '<option value="' + h + '">' + T.fmtMin(h * 60) + "</option>").join("");
    el("asMailHour").innerHTML = Array.from({ length: 8 }, (_, i) => i + 4).map((h) => '<option value="' + h + '">' + T.fmtMin(h * 60) + "</option>").join("");
    let list = null, filter = "";

    function repeatText(t) {
      if (t.repeat === "once") return "Once, " + T.fmtDay(t.due_on);
      if (t.repeat === "daily") {
        const d = (t.weekdays || []).slice().sort();
        return !d.length ? "Every day" : d.join() === "1,2,3,4,5" ? "Weekdays" : d.map((x) => T.WEEKDAYS[x]).join(", ");
      }
      if (t.repeat === "weekly") return "Every " + T.WEEKDAYS[(t.weekdays || [])[0]];
      return "Monthly, on the " + (t.month_day >= 29 ? t.month_day + nth(t.month_day) + " (or the last day)" : t.month_day + nth(t.month_day));
    }
    function nth(n) { return n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"; }

    async function loadTasks() {
      clearError("asTErr");
      try {
        const { data, error } = await sb.rpc("assignments_list");
        if (error) throw error;
        list = data; people = (data.people || []).map((p) => Object.assign({}, p, { name: T.shortName(p.name) }));
        const ed = !!data.can_edit;
        el("asAdd").classList.toggle("hidden", !ed);
        el("asFilter").classList.toggle("hidden", !ed);
        el("asSetCard").classList.toggle("hidden", !ed);
        el("asFilter").innerHTML = '<option value="">Everyone</option>' + people.map((p) => '<option value="' + esc(p.user_id) + '">' + esc(p.name) + "</option>").join("");
        el("asFilter").value = filter;
        if (data.settings) { el("asPlanOn").checked = !!data.settings.day_plan_on; el("asPlanHour").value = String(data.settings.day_plan_hour); }
        if (ed) {
          const { data: m } = await sb.rpc("day_email_status");
          if (m) { el("asMailOn").checked = !!m.on; el("asMailHour").value = String(m.hour); }
        }
        renderList();
      } catch (e) { showError("asTErr", "Could not load tasks: " + cleanErr(e)); }
    }
    const nameOf = (id) => { const p = people.find((x) => x.user_id === id); return p ? p.name : "Someone"; };
    function renderList() {
      const rows = list.tasks.filter((t) => !filter || t.user_id === filter)
        .sort((a, b) => nameOf(a.user_id).localeCompare(nameOf(b.user_id)) || (b.priority === "urgent") - (a.priority === "urgent") || a.title.localeCompare(b.title));
      el("asTBody").innerHTML = rows.length ? rows.map((t) =>
        '<tr class="' + (list.can_edit ? "as-row" : "") + '" data-id="' + esc(t.id) + '"><td><b>' + esc(t.title) + "</b>" + (t.priority === "urgent" ? '<span class="as-tag urgent">Urgent</span>' : "") + (t.notes ? '<div class="muted" style="font-size:12.5px">' + esc(t.notes) + "</div>" : "") + "</td>" +
        "<td>" + esc(nameOf(t.user_id)) + "</td><td>" + esc(repeatText(t)) + '</td><td class="as-hide-sm">' + esc(t.last_done ? T.fmtDay(t.last_done) : "never") + "</td></tr>").join("")
        : '<tr><td colspan="4" class="empty">' + (list.can_edit ? "No tasks yet. Add one and it shows on that person&#39;s My day." : "Nothing assigned to you.") + "</td></tr>";
    }
    el("asFilter").addEventListener("change", () => { filter = el("asFilter").value; renderList(); });
    el("asAdd").addEventListener("click", () => openTask(null));
    el("asTBody").addEventListener("click", (e) => { const r = e.target.closest("tr.as-row"); if (r) openTask(list.tasks.find((t) => t.id === r.dataset.id)); });
    el("asPlanSave").addEventListener("click", async () => {
      try {
        const { error } = await sb.rpc("staff_settings_save", { p_on: el("asPlanOn").checked, p_hour: +el("asPlanHour").value });
        if (error) throw error;
        toast(el("asPlanOn").checked ? "Saved. It goes out at " + T.fmtMin(+el("asPlanHour").value * 60) + "." : "Saved. The notification is off.");
      } catch (e) { toast(cleanErr(e), true); }
    });

    el("asMailSave").addEventListener("click", async () => {
      try {
        const { error } = await sb.rpc("day_email_settings_save", { p_on: el("asMailOn").checked, p_hour: +el("asMailHour").value });
        if (error) throw error;
        toast(el("asMailOn").checked ? "Saved. The morning email goes out at " + T.fmtMin(+el("asMailHour").value * 60) + "." : "Saved. The morning email is off.");
      } catch (e) { toast(cleanErr(e), true); }
    });

    function openTask(t) {
      const isNew = !t;
      t = t || { user_id: filter || "", title: "", notes: "", repeat: "daily", weekdays: [1, 2, 3, 4, 5], month_day: 1, due_on: T.today(), starts_on: T.today(), priority: "normal", est_minutes: null };
      const wd = t.repeat === "daily" && !(t.weekdays || []).length ? [0, 1, 2, 3, 4, 5, 6] : t.weekdays || [];
      const m = openModal('<div class="as-modal"><h2>' + (isNew ? "Add a task" : "Change task") + "</h2>" +
        '<div class="row2"><div class="field"><label for="aca-atWho">For</label><select id="aca-atWho">' + (t.user_id ? "" : '<option value="">Pick someone\u2026</option>') + people.map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === t.user_id ? " selected" : "") + ">" + esc(p.name) + (p.gets_day_plan ? "" : " (no Assignments access)") + "</option>").join("") + "</select></div>" +
        '<div class="field"><label>Priority</label><div class="seg" role="radiogroup" aria-label="Priority"><label><input type="radio" name="aca-atPri" value="normal"' + (t.priority !== "urgent" ? " checked" : "") + ' /><span>Normal</span></label><label><input type="radio" name="aca-atPri" value="urgent"' + (t.priority === "urgent" ? " checked" : "") + " /><span>Urgent</span></label></div></div></div>" +
        '<div class="field"><label for="aca-atTitle">Task</label><input type="text" id="aca-atTitle" maxlength="160" value="' + esc(t.title) + '" placeholder="Back up memory cards" /></div>' +
        '<div class="field"><label>Repeats</label><div class="seg" role="radiogroup" aria-label="Repeats">' + ["once", "daily", "weekly", "monthly"].map((r) => '<label><input type="radio" name="aca-atRep" value="' + r + '"' + (r === t.repeat ? " checked" : "") + " /><span>" + REPEAT[r] + "</span></label>").join("") + "</div></div>" +
        '<div class="field at-once"><label for="aca-atDue">Due</label><input type="date" id="aca-atDue" value="' + esc(t.due_on || T.today()) + '" /></div>' +
        '<div class="field at-daily"><label>On</label><div class="as-days">' + T.WEEKDAYS.map((n, i) => '<label><input type="checkbox" value="' + i + '"' + (wd.includes(i) ? " checked" : "") + " />" + n + "</label>").join("") + "</div></div>" +
        '<div class="field at-weekly"><label for="aca-atDow">Every</label><select id="aca-atDow">' + T.WEEKDAYS.map((n, i) => '<option value="' + i + '"' + ((t.repeat === "weekly" ? (t.weekdays || [])[0] : 1) === i ? " selected" : "") + ">" + n + "</option>").join("") + "</select></div>" +
        '<div class="field at-monthly"><label for="aca-atMd">On day</label><select id="aca-atMd">' + Array.from({ length: 31 }, (_, i) => i + 1).map((d) => '<option value="' + d + '"' + (d === +(t.month_day || 1) ? " selected" : "") + ">" + d + nth(d) + (d >= 29 ? " (or the last day)" : "") + "</option>").join("") + "</select></div>" +
        '<div class="row2"><div class="field at-repeats"><label for="aca-atStart">Starting</label><input type="date" id="aca-atStart" value="' + esc(t.starts_on || T.today()) + '" /></div>' +
        '<div class="field"><label for="aca-atEst">Time needed (min, optional)</label><input type="number" id="aca-atEst" min="1" max="1440" step="5" value="' + esc(t.est_minutes || "") + '" style="width:100%" /></div></div>' +
        '<div class="field"><label for="aca-atNotes">Notes</label><textarea id="aca-atNotes" maxlength="2000">' + esc(t.notes || "") + "</textarea></div>" +
        '<div class="inline-error hidden" id="aca-atErr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" data-m="remove">Remove</button>') + '<span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">' + (isNew ? "Add" : "Save") + "</button></div></div>");
      const rep = () => m.querySelector('input[name="aca-atRep"]:checked').value;
      const sync = () => { const r = rep(); ["once", "daily", "weekly", "monthly"].forEach((k) => m.querySelectorAll(".at-" + k).forEach((n) => n.classList.toggle("hidden", r !== k))); m.querySelector(".at-repeats").classList.toggle("hidden", r === "once"); };
      sync();
      m.querySelectorAll('input[name="aca-atRep"]').forEach((x) => x.addEventListener("change", sync));
      const err = (s) => { const n = el("atErr"); n.textContent = s; n.classList.remove("hidden"); };
      m.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "cancel") m.close();
        if (b.dataset.m === "remove") {
          if (!confirm("Remove \u201c" + t.title + "\u201d? It comes off " + nameOf(t.user_id) + "'s list.")) return;
          b.disabled = true;
          try { const { error } = await sb.rpc("assignment_archive", { p_id: t.id }); if (error) throw error; m.close(); toast("Removed."); loadTasks(); }
          catch (e) { err(cleanErr(e)); b.disabled = false; }
        }
        if (b.dataset.m === "save") {
          const r = rep();
          const p = { id: isNew ? null : t.id, user_id: el("atWho").value, title: el("atTitle").value.trim(), notes: el("atNotes").value.trim(), repeat: r,
            priority: m.querySelector('input[name="aca-atPri"]:checked').value, starts_on: el("atStart").value || T.today(), est_minutes: el("atEst").value || null };
          if (!p.user_id) return err("Pick who it is for.");
          if (!p.title) return err("Give the task a name.");
          if (r === "once") p.due_on = el("atDue").value;
          if (r === "daily") { p.weekdays = [...m.querySelectorAll(".at-daily input:checked")].map((x) => +x.value); if (!p.weekdays.length) return err("Pick at least one day."); }
          if (r === "weekly") p.weekdays = [+el("atDow").value];
          if (r === "monthly") p.month_day = +el("atMd").value;
          b.disabled = true;
          try { const { error } = await sb.rpc("assignment_save", { p }); if (error) throw error; m.close(); toast(isNew ? "Added." : "Saved."); loadTasks(); }
          catch (e) { err(cleanErr(e)); b.disabled = false; }
        }
      });
    }

    // ---------------------------------------------------------------- Today: your assignments
    // A section at the top of each person's Today screen: today's tasks to check off (urgent and overdue
    // first, as my_day sorts them) and a one-line look at their schedule.
    async function loadToday() {
      const box = el("todayMine");
      if (!box) return;
      const t = T.today();
      try {
        const { data, error } = await sb.rpc("my_day", { p_day: t });
        if (error) throw error;
        const tasks = data.tasks || [], entries = (data.entries || []).filter((e) => e.kind !== "off");
        const open = tasks.filter((x) => !x.done_at).length;
        const off = (data.entries || []).some((e) => e.kind === "off");
        const hrs = T.workHours(data.entries || [], t);
        const sched = off && !entries.length ? "You have time off today."
          : entries.length ? entries.map((e) => T.fmtTs(e.starts_at) + "\u2013" + T.fmtTs(e.ends_at) + " " + (e.kind === "job" ? e.booking_title : e.title || ({ studio: "Studio", admin: "Admin" })[e.kind] || "Work")).join(", ") +
            " (" + (Math.round(hrs * 4) / 4) + " h" + (hrs >= T.LUNCH_AFTER_H ? ", plan a lunch break" : "") + ")"
          : "Nothing on your schedule today.";
        box.innerHTML = '<h2>Your assignments <span class="c">' + (open ? open + " to do" : "all done") + '</span><a href="#staff/myday">My day</a></h2>' +
          '<p class="sched">' + esc(sched) + "</p>" +
          (tasks.length ? tasks.map(taskHtml).join("") : '<p class="empty">No tasks today.</p>');
        box.classList.remove("hidden");
      } catch (e) {
        box.innerHTML = '<h2>Your assignments</h2><p class="muted">Could not load your tasks: ' + esc(cleanErr(e)) + "</p>";
        box.classList.remove("hidden");
      }
    }
    const todayBox = el("todayMine");
    if (todayBox) todayBox.addEventListener("change", async (e) => {
      const cb = e.target.closest("[data-task]"); if (!cb) return;
      cb.disabled = true;
      try {
        const { error } = await sb.rpc("assignment_check", { p_task: cb.dataset.task, p_on: cb.dataset.on, p_done: cb.checked });
        if (error) throw error;
        loadToday();
      } catch (err) { cb.checked = !cb.checked; cb.disabled = false; toast(cleanErr(err), true); }
    });

    return { loadDay, loadTasks, loadToday };
  })();
