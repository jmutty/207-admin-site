  // ================================================================ JOBS: the job page's Checklist tab (2026-10-22)
  // The tasks a job's checklist made, with who has each one and when it is due; tick them off here.
  // People who can edit Assignments hand a step to someone else with its "who" menu (task_bulk).
  // Polish pass 2026-10-23: the Task board (board, calendar, workload) came out. Tasks live in one plain list
  // (Team > Tasks, assignments.js) and on each person's My day. RPCs: workflow_job / assignment_check.
  const TaskBoard = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    // The job page (jobpage.js) may not be in this build; registerJobTab may be a function declaration or not exist.
    const jobPage = () => { try { return typeof registerJobTab === "function"; } catch (_e) { return false; } };
    const short = (n) => T.shortName(n || "");
    const css = `
    .aca .tb-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 0 5px; border-radius: 3px; margin-left: 4px; vertical-align: 1px; background: var(--err-bg); color: var(--err-fg); }
    .aca .tb-jt { list-style: none; margin: 0; padding: 0; }
    .aca .tb-jt li { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; align-items: baseline; }
    .aca .tb-jt li.done .t { text-decoration: line-through; color: var(--muted); }
    .aca .tb-jt .w { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
    .aca .tb-jt .late { color: var(--err-fg); font-weight: 600; }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    // ---------------------------------------------------------------- the job page's Checklist tab
    function jobTab(booking, host) {
      const id = typeof booking === "string" ? booking : booking && (booking.id || booking.booking_id);
      host.innerHTML = '<p class="empty">Loading&#8230;</p>';
      const draw = async () => {
        try {
          const { data: j, error } = await sb.rpc("workflow_job", { p_booking: id });
          if (error) throw error;
          const t = T.today(), mine = (k) => j.can_check || k.user_id === j.me;
          host.innerHTML = (j.tasks.length ? '<ul class="tb-jt">' + j.tasks.map((k) => {
            const done = !!k.done_at, late = !done && !k.waiting && k.due_on < t;
            return '<li class="' + (done ? "done" : "") + '"><span>' + (k.waiting ? '<span title="Waiting" aria-label="Waiting">&#8987;</span>'
                : mine(k) ? '<input type="checkbox" data-task="' + esc(k.task_id) + '" data-on="' + esc(k.due_on) + '"' + (done ? " checked" : "") + ' aria-label="Done: ' + esc(k.title) + '" />' : done ? "&#10003;" : "&#9675;") + "</span>" +
              '<span class="t">' + esc(k.title) + (k.priority === "urgent" ? '<span class="tb-tag">Urgent</span>' : "") + (k.waiting ? '<div class="muted" style="font-size:12.5px">Waits for ' + esc(k.waits_for || "an earlier step") + "</div>" : "") + "</span>" +
              '<span class="w">' + (j.can_check && !done && (j.people || []).length
                ? '<select class="small" data-give="' + esc(k.task_id) + '" aria-label="Who has ' + esc(k.title) + '">' + j.people.map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === k.user_id ? " selected" : "") + ">" + esc(short(p.name)) + "</option>").join("") + "</select>"
                : esc(short(k.user_name))) + (k.group_name ? " (" + esc(k.group_name) + ")" : "") + " &middot; " +
              (done ? "done " + esc(T.fmtDay(k.done_at.slice(0, 10))) : '<span class="' + (late ? "late" : "") + '">' + esc(T.fmtDay(k.due_on)) + (late ? " (" + T.daysBetween(k.due_on, t) + " days late)" : "") + "</span>") + "</span></li>";
          }).join("") + "</ul>" : '<p class="empty">' + (j.status === "booked" ? "No checklist tasks yet. They appear once someone is on the job (or a step has a set person)." : "Only booked jobs get checklist tasks.") + "</p>");
        } catch (e) { host.innerHTML = '<p class="inline-error">' + esc(cleanErr(e)) + "</p>"; }
      };
      host.onchange = async (e) => {
        const g = e.target.closest("select[data-give]");
        if (g) {
          g.disabled = true;
          const { data: r, error } = await sb.rpc("task_bulk", { p_ids: [g.dataset.give], p: { user_id: g.value } });
          if (error || !r.changed) { toast(error ? cleanErr(error) : "Not changed" + (r.why ? ": " + r.why : "") + ".", true); draw(); return; }
          toast("Given to " + short(g.options[g.selectedIndex].text) + "."); draw(); return;
        }
        const c = e.target.closest("input[data-task]"); if (!c) return;
        c.disabled = true;
        const { error } = await sb.rpc("assignment_check", { p_task: c.dataset.task, p_on: c.dataset.on, p_done: c.checked });
        if (error) { toast(cleanErr(error), true); c.checked = !c.checked; c.disabled = false; return; }
        draw();
      };
      draw();
    }
    // Register now if the job page is already defined, otherwise once every file has run (whatever the build order).
    let tabAdded = false;
    const addTab = () => { if (!tabAdded && jobPage()) { tabAdded = true; registerJobTab({ id: "checklist", label: "Checklist", order: 30, render: jobTab,
      // Shown to anyone with steps on this job (the person shooting it too), and to Job checklists people on every job (2026-10-24).
      show: (j) => !!(j && j.tasks && (j.tasks.length || canSee("workflows"))),
      count: (j) => (j && j.tasks ? j.tasks.filter((t) => !t.done).length : 0) }); } };
    addTab(); if (!tabAdded) setTimeout(addTab, 0);

    return { jobTab };
  })();
