  // ================================================================ STAFF: Task board (2026-10-22)
  // Every one-time task (job checklist steps and hand-made ones) three ways:
  //   Board     Waiting / Overdue / To do / Done. Drag a card to Done to check it off (or back to undo).
  //   Calendar  a month of due days. Drag a task to another day to move it (Edit).
  //   Workload  per person: due this week, done this week, overdue, waiting, later.
  // Tick cards to change several at once: done, due day, owner, priority. Filters can be saved as views
  // (SavedViews, page "taskboard"). The job page gets a Checklist tab (registerJobTab, when it exists).
  // RPCs: task_board / task_bulk / task_workload / workflow_job / assignment_check (migration 20261022234500).
  // View = your own and your groups' tasks; Edit = everyone's, and moving or reassigning them.
  registerPage({ id: "board", group: "Staff", section: "staff", module: "taskboard", title: "Task board", selfService: true,
                 tabs: [["board", "Board"], ["taskcal", "Calendar"], ["workload", "Workload"]], onShow: (tab) => TaskBoard.show(tab) });

  const TaskBoard = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    // The job page (jobpage.js) may not be in this build; registerJobTab may be a function declaration or not exist.
    const jobPage = () => { try { return typeof registerJobTab === "function"; } catch (_e) { return false; } };
    const COLS = [["waiting", "Waiting"], ["overdue", "Overdue"], ["todo", "To do"], ["done", "Done"]];
    const SHOW = [["open", "Not done"], ["overdue", "Overdue"], ["waiting", "Waiting"], ["done", "Done"], ["all", "Everything"]];

    const css = `
    .aca .tb-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 0 12px; }
    .aca .tb-bar .grow { flex: 1; }
    .aca .tb-bar input[type=search] { width: 180px; }
    .aca .tb-bar h2 { margin: 0 8px 0 4px; font-size: 17px; font-weight: 600; white-space: nowrap; }
    .aca .tb-cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; }
    .aca .tb-col { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px; min-height: 120px; }
    .aca .tb-col.drop { outline: 2px dashed var(--accent); outline-offset: -2px; }
    .aca .tb-col h3 { margin: 2px 4px 8px; font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); display: flex; justify-content: space-between; }
    .aca .tb-card { background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 8px 10px 8px 8px; margin: 0 0 8px; font-size: 13.5px;
                    display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 4px; cursor: pointer; }
    .aca .tb-card[draggable=true] { cursor: grab; }
    .aca .tb-card.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .aca .tb-card input { width: 16px; height: 16px; margin: 2px 0 0; }
    .aca .tb-card .t { font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
    .aca .tb-card .s { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
    .aca .tb-card.done .t { text-decoration: line-through; color: var(--muted); }
    .aca .tb-card .late { color: var(--err-fg); font-weight: 600; }
    .aca .tb-tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 0 5px; border-radius: 3px; margin-left: 4px; vertical-align: 1px; background: var(--err-bg); color: var(--err-fg); }
    .aca .tb-tag.g { background: var(--sel-bg); color: var(--accent); }
    .aca .tb-more { font-size: 12.5px; color: var(--muted); padding: 2px 4px; }
    .aca .tb-bulk { position: sticky; bottom: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; padding: 10px 12px;
                    background: var(--sel-bg); border: 1px solid var(--border); border-radius: 6px; font-size: 13px; box-shadow: 0 -2px 8px rgba(16,24,40,.08); }
    .aca .tb-cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border-top: 1px solid var(--border); border-left: 1px solid var(--border); }
    .aca .tb-cal .hd { padding: 6px 8px; font-size: 12px; font-weight: 700; color: var(--muted); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--surface-2); }
    .aca .tb-day { min-height: 104px; padding: 4px 4px 6px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--surface); }
    .aca .tb-day.other { background: var(--surface-2); }
    .aca .tb-day.today .n { background: var(--accent); color: #fff; border-radius: 10px; padding: 0 6px; }
    .aca .tb-day.drop { outline: 2px dashed var(--accent); outline-offset: -2px; }
    .aca .tb-day .n { display: inline-block; font-size: 12px; font-weight: 700; margin: 0 0 3px 2px; }
    .aca .tb-day .wd { display: none; }
    .aca .tb-chip { display: block; width: 100%; text-align: left; font: inherit; font-size: 12px; line-height: 1.3; padding: 2px 5px; margin: 0 0 3px; border-radius: 3px; border: 0;
                    background: #e5edf8; color: #1d3f6e; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .aca .tb-chip[draggable=true] { cursor: grab; }
    .aca .tb-chip.urgent { background: var(--err-bg); color: var(--err-fg); }
    .aca .tb-chip.done { background: transparent; color: var(--muted); text-decoration: line-through; }
    .aca .tb-chip.wait { background: transparent; color: var(--muted); border: 1px dashed var(--border); }
    .aca .tb-chip.rep { background: transparent; color: var(--muted); }
    .aca .tb-wl td, .aca .tb-wl th { padding: 9px 10px; font-size: 13.5px; text-align: right; font-variant-numeric: tabular-nums; }
    .aca .tb-wl td:first-child, .aca .tb-wl th:first-child { text-align: left; }
    .aca .tb-wl .bad { color: var(--err-fg); font-weight: 700; }
    .aca .tb-wl .g { display: block; color: var(--muted); font-size: 12px; }
    .aca .tb-wl button.link { font-weight: 600; }
    .aca .tb-modal .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .aca .tb-modal .field select, .aca .tb-modal .field input { width: 100%; }
    .aca .tb-modal .s { color: var(--muted); font-size: 13px; white-space: pre-wrap; }
    .aca .tb-jt { list-style: none; margin: 0; padding: 0; }
    .aca .tb-jt li { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; align-items: baseline; }
    .aca .tb-jt li.done .t { text-decoration: line-through; color: var(--muted); }
    .aca .tb-jt .w { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
    @media (max-width: 900px) { .aca .tb-cols { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 700px) {
      .aca .tb-cols { grid-template-columns: 1fr; }
      .aca .tb-bar input[type=search] { width: 100%; }
      .aca .tb-cal { display: block; border: 0; }
      .aca .tb-cal .hd { display: none; }
      .aca .tb-day { min-height: 0; border: 0; border-bottom: 1px solid var(--line2); padding: 8px 2px; }
      .aca .tb-day.other, .aca .tb-day.empty { display: none; }
      .aca .tb-day .wd { display: inline; font-size: 12px; font-weight: 700; margin-right: 4px; }
      .aca .tb-chip { font-size: 13.5px; padding: 6px 8px; white-space: normal; }
      .aca .tb-modal .row2 { grid-template-columns: 1fr; }
      .aca .tb-hide-sm { display: none; }
      .aca .tb-bulk select, .aca .tb-bulk input, .aca .tb-bulk button { min-height: 40px; }
    }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    // ---------------------------------------------------------------- state
    let data = null, tab = "board", month = null, week = null, workload = null;
    const selected = new Set();
    const prefs = (() => { try { return JSON.parse(localStorage.getItem("aca-taskboard") || "{}"); } catch (_e) { return {}; } })();
    const filt = { who: prefs.who || "me", show: prefs.show || "open", q: "", checklist: !!prefs.checklist };
    const savePrefs = () => { try { localStorage.setItem("aca-taskboard", JSON.stringify({ who: filt.who, show: filt.show, checklist: filt.checklist })); } catch (_e) { /* private mode */ } };
    const today = () => (data && data.today) || T.today();
    const me = () => (data && data.me) || ACCESS.user_id;
    const short = (n) => T.shortName(n || "");
    const colOf = (k) => (k.done_at ? "done" : k.waiting ? "waiting" : k.due_on < today() ? "overdue" : "todo");
    const canMove = () => !!(data && data.can_edit);
    const canCheck = (k) => canMove() || k.user_id === me() || (k.group_id && myGroups().has(k.group_id));
    let groupsMine = null;
    const myGroups = () => groupsMine || new Set();

    // ---------------------------------------------------------------- filter bar (shared by Board and Calendar)
    function barHtml(id) {
      return '<div class="tb-bar" id="aca-' + id + 'Bar">' +
        '<select class="small" data-f="who" aria-label="Whose tasks"></select>' +
        '<select class="small" data-f="show" aria-label="Show">' + SHOW.map((s) => '<option value="' + s[0] + '">' + s[1] + "</option>").join("") + "</select>" +
        '<label style="font-size:13px;display:inline-flex;gap:5px;align-items:center"><input type="checkbox" data-f="checklist" /> Job checklists only</label>' +
        '<input type="search" data-f="q" placeholder="Search tasks&#8230;" aria-label="Search tasks" />' +
        '<span class="grow"></span><span data-views></span></div>';
    }
    function fillBar(bar) {
      const who = bar.querySelector('[data-f="who"]');
      const people = (data && data.people) || [], groups = (data && data.groups) || [];
      who.innerHTML = '<option value="me">My tasks</option>' + (canMove() ? '<option value="all">Everyone</option>' +
        (people.length ? '<optgroup label="Person">' + people.filter((p) => p.user_id !== me()).map((p) => '<option value="' + esc(p.user_id) + '">' + esc(short(p.name)) + "</option>").join("") + "</optgroup>" : "") : "") +
        (groups.length ? '<optgroup label="Group">' + groups.map((g) => '<option value="g:' + esc(g.id) + '">' + esc(g.name) + "</option>").join("") + "</optgroup>" : "");
      if (![...who.options].some((o) => o.value === filt.who)) filt.who = "me";
      who.value = filt.who;
      bar.querySelector('[data-f="show"]').value = filt.show;
      bar.querySelector('[data-f="checklist"]').checked = filt.checklist;
      bar.querySelector('[data-f="q"]').value = filt.q;
    }
    function wireBar(bar) {
      bar.addEventListener("change", (e) => {
        const f = e.target.dataset.f; if (!f || f === "q") return;
        const before = filt.who;
        filt[f] = f === "checklist" ? e.target.checked : e.target.value;
        savePrefs(); views.forEach((v) => v.clear());
        if (f === "who" && whoParam(before) !== whoParam(filt.who)) load(); else renderAll();
      });
      bar.addEventListener("input", (e) => { if (e.target.dataset.f === "q") { filt.q = e.target.value; renderAll(); } });
    }
    // The server filters by person only for Edit; groups and "me" for View are filtered here.
    const whoParam = (w) => (canMove() && w && w !== "all" && !w.startsWith("g:") ? (w === "me" ? me() : w) : null);
    function visible(list) {
      const q = filt.q.trim().toLowerCase();
      return list.filter((k) => {
        if (filt.who === "me" && k.user_id !== me()) return false;
        if (filt.who.startsWith("g:") && k.group_id !== filt.who.slice(2)) return false;
        if (filt.who !== "me" && filt.who !== "all" && !filt.who.startsWith("g:") && k.user_id !== filt.who) return false;
        if (filt.checklist && !k.checklist) return false;
        const c = colOf(k);
        if (filt.show === "open" && c === "done") return false;
        if (filt.show !== "open" && filt.show !== "all" && c !== filt.show) return false;
        return !q || (k.title + " " + (k.user_name || "") + " " + (k.group_name || "")).toLowerCase().includes(q);
      });
    }

    // ---------------------------------------------------------------- Board
    const boardRoot = el("panel-board");
    boardRoot.innerHTML = barHtml("tbB") + '<div id="aca-tbErr" class="inline-error hidden"></div><div class="tb-cols" id="aca-tbCols"><p class="empty">Loading&#8230;</p></div>' +
      '<div class="tb-bulk hidden" id="aca-tbBulk"></div>';
    const calRoot = el("panel-taskcal");
    calRoot.innerHTML = barHtml("tbC") + '<div class="tb-bar"><button type="button" class="small" data-m="prev" aria-label="Month before">&lsaquo;</button><button type="button" class="small" data-m="this">This month</button>' +
      '<button type="button" class="small" data-m="next" aria-label="Month after">&rsaquo;</button><h2 id="aca-tbMonth"></h2><span class="grow"></span><span class="muted" style="font-size:12.5px" id="aca-tbCalHint"></span></div>' +
      '<div id="aca-tbCErr" class="inline-error hidden"></div><div class="tb-cal" id="aca-tbCal"></div><div class="tb-bulk hidden" id="aca-tbBulkC"></div>';
    wireBar(el("tbBBar")); wireBar(el("tbCBar"));
    const BUILTIN = [{ id: "b-mine", name: "My open tasks", config: { who: "me", show: "open", checklist: false } },
      { id: "b-late", name: "Everyone, overdue", config: { who: "all", show: "overdue", checklist: false } },
      { id: "b-wait", name: "Waiting on an earlier step", config: { who: "all", show: "waiting", checklist: true } }];
    const viewOpts = { page: "taskboard", builtins: BUILTIN, get: () => ({ who: filt.who, show: filt.show, checklist: filt.checklist, q: filt.q }),
      apply: (c) => { const before = filt.who; Object.assign(filt, { who: c.who || "me", show: c.show || "open", checklist: !!c.checklist, q: c.q || "" }); savePrefs();
                      if (whoParam(before) !== whoParam(filt.who)) load(); else renderAll(); } };
    const views = [SavedViews.mount(boardRoot.querySelector("[data-views]"), viewOpts), SavedViews.mount(calRoot.querySelector("[data-views]"), viewOpts)];

    function card(k) {
      const c = colOf(k), late = c === "overdue";
      const sub = [esc(short(k.user_name)) + (k.group_name ? '<span class="tb-tag g">' + esc(k.group_name) + "</span>" : ""),
        k.done_at ? "done " + esc(T.fmtDay(k.done_at.slice(0, 10))) : '<span class="' + (late ? "late" : "") + '">' + (k.due_on === today() ? "today" : esc(T.fmtDay(k.due_on))) + "</span>"];
      if (k.waiting && k.waits_for) sub.push("waits for " + esc(k.waits_for));
      const drag = !k.waiting && canCheck(k);
      return '<div class="tb-card' + (k.done_at ? " done" : "") + (selected.has(k.id) ? " sel" : "") + '" data-id="' + esc(k.id) + '"' + (drag ? ' draggable="true"' : "") + ">" +
        '<input type="checkbox" aria-label="Select ' + esc(k.title) + '"' + (selected.has(k.id) ? " checked" : "") + " />" +
        '<div><div class="t">' + esc(k.title) + (k.priority === "urgent" ? '<span class="tb-tag">Urgent</span>' : "") + '</div><div class="s">' + sub.join(" &middot; ") + "</div></div></div>";
    }
    function renderBoard() {
      const list = visible(data.tasks);
      const by = { waiting: [], overdue: [], todo: [], done: [] };
      list.forEach((k) => by[colOf(k)].push(k));
      by.done.sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
      const cols = COLS.filter(([c]) => filt.show === "all" || filt.show === c || (filt.show === "open" && c !== "done"));
      el("tbCols").style.gridTemplateColumns = window.matchMedia("(max-width: 700px)").matches ? "" : "repeat(" + cols.length + ", minmax(0, 1fr))";
      el("tbCols").innerHTML = cols.map(([c, label]) => {
        const items = by[c], cap = c === "done" ? 30 : 200;
        return '<div class="tb-col" data-col="' + c + '"><h3><span>' + label + "</span><span>" + items.length + "</span></h3>" +
          (items.length ? items.slice(0, cap).map(card).join("") + (items.length > cap ? '<div class="tb-more">and ' + (items.length - cap) + " more</div>" : "")
            : '<div class="tb-more">' + (c === "waiting" ? "Nothing waiting on an earlier step." : c === "overdue" ? "Nothing overdue." : c === "done" ? "Nothing checked off yet." : "Nothing to do.") + "</div>") + "</div>";
      }).join("");
    }

    // ---------------------------------------------------------------- Calendar
    function monthDays() {
      const first = month, start = T.weekStart(first);
      const next = T.addDays(first, 32).slice(0, 8) + "01";
      const end = T.addDays(T.weekStart(T.addDays(next, -1)), 6);
      return { first, start, end, next };
    }
    function renderCal() {
      const { first, start, end } = monthDays(), t = today();
      el("tbMonth").textContent = new Date(first + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
      el("tbCalHint").textContent = canMove() ? "Drag a task to another day to move it." : "";
      const list = visible(data.tasks).filter((k) => !k.done_at || (filt.show !== "open"));
      const byDay = {};
      // open tasks from before this month sit on today
      list.forEach((k) => { const d = k.due_on < start && !k.done_at ? t : k.due_on; (byDay[d] = byDay[d] || []).push(k); });
      // repeating tasks (Assignments) show faintly for a person or everyone, not for a group or checklists only
      const repWho = (r) => (filt.who === "me" ? r.user_id === me() : filt.who === "all" ? true : filt.who.startsWith("g:") ? false : r.user_id === filt.who);
      const reps = (filt.show === "open" || filt.show === "all") && !filt.checklist ? (data.repeating || []).filter((r) => repWho(r) && (filt.show === "all" || !r.done)) : [];
      reps.forEach((r) => { (byDay[r.day] = byDay[r.day] || []).push(Object.assign({ rep: true }, r)); });
      let html = T.WEEKDAYS.map((w) => '<div class="hd">' + w + "</div>").join("");
      for (let d = start; d <= end; d = T.addDays(d, 1)) {
        const items = (byDay[d] || []).sort((a, b) => (a.rep ? 1 : 0) - (b.rep ? 1 : 0) || (b.priority === "urgent") - (a.priority === "urgent"));
        html += '<div class="tb-day' + (d.slice(0, 7) !== first.slice(0, 7) ? " other" : "") + (d === t ? " today" : "") + (items.length ? "" : " empty") + '" data-day="' + d + '">' +
          '<span class="wd">' + esc(T.fmtDay(d, { month: undefined, day: undefined })) + '</span><span class="n">' + (d.slice(8) === "01" || d === start ? esc(T.fmtDay(d, { weekday: undefined })) : +d.slice(8)) + "</span>" +
          items.map((k) => k.rep
            ? '<button type="button" class="tb-chip rep' + (k.done ? " done" : "") + '" title="Repeats: ' + esc(k.title) + '">&#8635; ' + esc(k.title) + "</button>"
            : '<button type="button" class="tb-chip' + (k.done_at ? " done" : k.waiting ? " wait" : k.priority === "urgent" ? " urgent" : "") + '" data-id="' + esc(k.id) + '"' +
              (canMove() && !k.done_at ? ' draggable="true"' : "") + ' title="' + esc(k.title + " (" + short(k.user_name) + ")") + '">' + (filt.who === "me" ? "" : esc(short(k.user_name).split(" ")[0]) + ": ") + esc(k.title) + "</button>").join("") + "</div>";
      }
      el("tbCal").innerHTML = html;
    }
    calRoot.addEventListener("click", (e) => {
      const b = e.target.closest("[data-m]"); if (!b || !month) return;
      month = b.dataset.m === "this" ? today().slice(0, 8) + "01" : T.addDays(month, b.dataset.m === "next" ? 32 : -1).slice(0, 8) + "01";
      load();
    });

    // ---------------------------------------------------------------- drag and drop (board columns, calendar days)
    let dragId = null;
    [boardRoot, calRoot].forEach((root) => {
      root.addEventListener("dragstart", (e) => { const c = e.target.closest("[data-id][draggable=true]"); if (!c) return; dragId = c.dataset.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); });
      root.addEventListener("dragend", () => { dragId = null; root.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop")); });
      root.addEventListener("dragover", (e) => {
        const z = e.target.closest(".tb-col[data-col], .tb-day[data-day]"); if (!z || !dragId) return;
        if (z.dataset.col === "waiting") return;
        e.preventDefault(); root.querySelectorAll(".drop").forEach((x) => x !== z && x.classList.remove("drop")); z.classList.add("drop");
      });
      root.addEventListener("drop", async (e) => {
        const z = e.target.closest(".tb-col[data-col], .tb-day[data-day]"); const id = dragId; if (!z || !id) return;
        e.preventDefault(); z.classList.remove("drop");
        const k = data.tasks.find((x) => x.id === id); if (!k) return;
        if (z.dataset.day) { if (z.dataset.day !== k.due_on) await bulk([id], { due_on: z.dataset.day }, "Moved to " + T.fmtDay(z.dataset.day) + "."); return; }
        const to = z.dataset.col, from = colOf(k);
        if (to === from || (to !== "done" && from !== "done")) return;
        await bulk([id], { done: to === "done" }, to === "done" ? "Checked off." : "Back to do.");
      });
    });

    // ---------------------------------------------------------------- selecting and bulk changes
    function renderBulk() {
      [["tbBulk", boardRoot], ["tbBulkC", calRoot]].forEach(([id]) => {
        const box = el(id), show = selected.size > 0 && id === (tab === "taskcal" ? "tbBulkC" : "tbBulk");
        box.classList.toggle("hidden", !show);
        if (!show) return;
        const people = (data.people || []).map((p) => '<option value="' + esc(p.user_id) + '">' + esc(short(p.name)) + "</option>").join("");
        box.innerHTML = "<strong>" + selected.size + " selected</strong>" +
          '<button type="button" class="small primary" data-b="done">Mark done</button><button type="button" class="small" data-b="undone">Not done</button>' +
          (canMove() ? '<input type="date" class="small" data-b="due" aria-label="New due day" title="Move to this day" />' +
            '<select class="small" data-b="owner" aria-label="New owner"><option value="">Give to&#8230;</option>' + people + "</select>" +
            '<select class="small" data-b="prio" aria-label="Priority"><option value="">Priority&#8230;</option><option value="normal">Normal</option><option value="urgent">Urgent</option></select>' +
            '<button type="button" class="small" data-b="apply">Apply</button>' : "") +
          '<button type="button" class="link" data-b="clear">Clear selection</button>';
      });
    }
    function onBulkClick(box) {
      box.addEventListener("click", async (e) => {
        const b = e.target.closest("button[data-b]"); if (!b) return;
        const ids = [...selected];
        if (b.dataset.b === "clear") { selected.clear(); renderAll(); return; }
        if (b.dataset.b === "done") return bulk(ids, { done: true }, "Checked off.");
        if (b.dataset.b === "undone") return bulk(ids, { done: false }, "Marked not done.");
        if (b.dataset.b === "apply") {
          const p = {}, due = box.querySelector('[data-b="due"]').value, owner = box.querySelector('[data-b="owner"]').value, prio = box.querySelector('[data-b="prio"]').value;
          if (due) p.due_on = due; if (owner) p.user_id = owner; if (prio) p.priority = prio;
          if (!Object.keys(p).length) return toast("Pick a day, a person or a priority first.", true);
          if (ids.some((id) => (data.tasks.find((k) => k.id === id) || {}).checklist) &&
              !confirm("Checklist tasks you change here stop following their job (picture day and crew changes). Go ahead?")) return;
          return bulk(ids, p, "Changed.");
        }
      });
    }
    onBulkClick(el("tbBulk")); onBulkClick(el("tbBulkC"));
    async function bulk(ids, p, msg) {
      try {
        const { data: r, error } = await sb.rpc("task_bulk", { p_ids: ids, p });
        if (error) throw error;
        toast(r.skipped ? msg + " " + r.skipped + " skipped" + (r.why ? " (" + r.why + ")" : "") + "." : msg);
        if (r.changed) selected.clear();
        await load();
      } catch (e) { toast(cleanErr(e), true); }
    }
    [boardRoot, calRoot].forEach((root) => root.addEventListener("click", (e) => {
      if (e.target.closest(".tb-bulk, .tb-bar")) return;
      const c = e.target.closest("[data-id]"); if (!c) return;
      if (e.target.matches('input[type="checkbox"]')) {
        if (e.target.checked) selected.add(c.dataset.id); else selected.delete(c.dataset.id);
        c.classList.toggle("sel", e.target.checked); renderBulk(); return;
      }
      openTask(data.tasks.find((k) => k.id === c.dataset.id));
    }));

    // One task: what it is, check it off, move it.
    function openTask(k) {
      if (!k) return;
      const c = colOf(k);
      const m = openModal('<div class="tb-modal"><h2>' + esc(k.title) + (k.priority === "urgent" ? '<span class="tb-tag">Urgent</span>' : "") + "</h2>" +
        '<p class="s" style="margin-top:0">' + esc(short(k.user_name)) + (k.group_name ? " (" + esc(k.group_name) + ")" : "") + " &middot; " +
        (k.done_at ? "done " + esc(T.fmtDay(k.done_at.slice(0, 10))) : "due " + esc(T.fmtDay(k.due_on))) +
        (k.waiting ? "<br>Waiting for <b>" + esc(k.waits_for || "an earlier step") + "</b> on the job. It shows on their list once that is checked off." : "") +
        (k.booking_id ? '<br><a href="' + esc(typeof jobLink === "function" ? jobLink(k.booking_id, "checklist") : "#jobs/bookings/" + k.booking_id) + '">Open the job</a>' : "") + "</p>" +
        (k.notes ? '<p class="s">' + esc(k.notes) + "</p>" : "") +
        (canMove() && !k.done_at ? '<div class="row2"><div class="field"><label for="aca-tbMDue">Due</label><input type="date" id="aca-tbMDue" value="' + esc(k.due_on) + '" /></div>' +
          '<div class="field"><label for="aca-tbMWho">Who</label><select id="aca-tbMWho">' + (data.people || []).map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === k.user_id ? " selected" : "") + ">" + esc(short(p.name)) + "</option>").join("") + "</select></div></div>" : "") +
        '<div class="modal-actions">' + (canCheck(k) && !k.waiting ? '<button type="button" class="small" data-m="toggle">' + (c === "done" ? "Not done" : "Mark done") + "</button>" : "") +
        '<span class="grow"></span><button type="button" class="small" data-m="close">Close</button>' + (canMove() && !k.done_at ? '<button type="button" class="primary" data-m="save">Save</button>' : "") + "</div></div>");
      m.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "close") return m.close();
        if (b.dataset.m === "toggle") { m.close(); return bulk([k.id], { done: c !== "done" }, c === "done" ? "Back to do." : "Checked off."); }
        if (b.dataset.m === "save") {
          const p = {}; if (el("tbMDue").value && el("tbMDue").value !== k.due_on) p.due_on = el("tbMDue").value; if (el("tbMWho").value !== k.user_id) p.user_id = el("tbMWho").value;
          m.close(); if (Object.keys(p).length) return bulk([k.id], p, "Saved.");
        }
      });
    }

    // ---------------------------------------------------------------- Workload
    const wlRoot = el("panel-workload");
    wlRoot.innerHTML = '<div class="card"><div class="card-head"><div><h2>Workload</h2><p>Each person&#39;s tasks for the week: everything due (repeating tasks count each day), what got checked off, what is overdue now, and checklist steps waiting on an earlier step. Click a name to see their board.</p></div>' +
      '<div class="tb-bar" style="padding:0"><button type="button" class="small" data-w="prev" aria-label="Week before">&lsaquo;</button><button type="button" class="small" data-w="this">This week</button><button type="button" class="small" data-w="next" aria-label="Week after">&rsaquo;</button></div></div>' +
      '<div id="aca-tbWErr" class="inline-error hidden"></div><div class="table-wrap"><table class="tb-wl"><thead><tr><th id="aca-tbWWeek">Person</th><th>Due this week</th><th>Done</th><th>Overdue</th><th class="tb-hide-sm">Waiting</th><th class="tb-hide-sm">Later</th></tr></thead><tbody id="aca-tbWBody"><tr><td colspan="6" class="empty">Loading&#8230;</td></tr></tbody></table></div></div>';
    async function loadWorkload() {
      clearError("tbWErr");
      week = week || T.weekStart(T.today());
      try {
        const { data: d, error } = await sb.rpc("task_workload", { p_week: week });
        if (error) throw error;
        workload = d;
        el("tbWWeek").textContent = "Week of " + T.fmtDay(d.week, { weekday: undefined });
        el("tbWBody").innerHTML = (d.rows || []).length ? d.rows.map((r) => {
          const pct = r.due_week ? Math.round((100 * r.done_week) / r.due_week) : null;
          return "<tr><td>" + (canSee("taskboard") ? '<button type="button" class="link" data-u="' + esc(r.user_id) + '">' + esc(short(r.name)) + "</button>" : esc(short(r.name))) +
            (r.groups && r.groups.length ? '<span class="g">' + esc(r.groups.join(", ")) + "</span>" : "") + "</td><td>" + r.due_week + "</td><td>" + r.done_week +
            (pct != null ? ' <span class="muted">(' + pct + "%)</span>" : "") + '</td><td class="' + (r.overdue ? "bad" : "") + '">' + r.overdue + '</td><td class="tb-hide-sm">' + r.waiting + '</td><td class="tb-hide-sm">' + r.later + "</td></tr>";
        }).join("") : '<tr><td colspan="6" class="empty">Nobody has Assignments yet.</td></tr>';
      } catch (e) { showError("tbWErr", "Could not load the workload: " + cleanErr(e)); }
    }
    wlRoot.addEventListener("click", (e) => {
      const w = e.target.closest("[data-w]");
      if (w) { week = w.dataset.w === "this" ? T.weekStart(T.today()) : T.addDays(week, w.dataset.w === "next" ? 7 : -7); loadWorkload(); return; }
      const u = e.target.closest("[data-u]");
      if (u) { filt.who = u.dataset.u === me() ? "me" : u.dataset.u; filt.show = "open"; savePrefs(); views.forEach((v) => v.clear()); data = null; location.hash = "#staff/board"; }
    });

    // ---------------------------------------------------------------- loading
    async function load() {
      const errId = tab === "taskcal" ? "tbCErr" : "tbErr";
      clearError(errId);
      const t = T.today();
      month = month || t.slice(0, 8) + "01";
      // the board looks a few weeks back and two months ahead; the calendar covers the month shown
      const { start, end } = monthDays();
      const from = tab === "taskcal" ? start : T.addDays(t, -21), to = tab === "taskcal" ? end : T.addDays(t, 60);
      try {
        const [{ data: d, error }, g] = await Promise.all([sb.rpc("task_board", { p_from: from, p_to: to, p_user: whoParam(filt.who) }),
          groupsMine ? Promise.resolve(null) : sb.from("staff_group_members").select("group_id").eq("user_id", ACCESS.user_id || "")]);
        if (error) throw error;
        if (g && !g.error) groupsMine = new Set((g.data || []).map((x) => x.group_id));
        data = d;
        const ids = new Set(d.tasks.map((k) => k.id));
        [...selected].forEach((id) => { if (!ids.has(id)) selected.delete(id); });
        renderAll();
      } catch (e) { showError(errId, "Could not load tasks: " + cleanErr(e)); }
    }
    function renderAll() {
      if (!data) return;
      fillBar(el("tbBBar")); fillBar(el("tbCBar"));
      if (tab === "taskcal") renderCal(); else renderBoard();
      renderBulk();
    }
    function show(t) {
      const was = tab;
      tab = t;
      views.forEach((v) => v.ensure());
      if (t === "workload") return loadWorkload();
      if (!data || was !== t) load(); else renderAll();
    }

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
              '<span class="w">' + esc(short(k.user_name)) + (k.group_name ? " (" + esc(k.group_name) + ")" : "") + " &middot; " + (done ? "done " + esc(T.fmtDay(k.done_at.slice(0, 10))) : '<span class="' + (late ? "late" : "") + '">' + esc(T.fmtDay(k.due_on)) + "</span>") + "</span></li>";
          }).join("") + "</ul>" : '<p class="empty">' + (j.status === "booked" ? "No checklist tasks yet. They appear once someone is on the job (or a step has a set person)." : "Only booked jobs get checklist tasks.") + "</p>") +
          (j.emails.length ? '<h3 style="margin:16px 0 6px;font-size:13px">Emails to the partner</h3><ul class="tb-jt">' + j.emails.map((m) => '<li><span></span><span class="t">' + esc(m.subject) +
            '<div class="muted" style="font-size:12.5px">to ' + esc(m.to) + (m.test_mode ? " (test mode)" : "") + (m.error ? " &middot; " + esc(m.error) : "") + '</div></span><span class="w">' + esc(m.status) + "</span></li>").join("") + "</ul>" : "");
        } catch (e) { host.innerHTML = '<p class="inline-error">' + esc(cleanErr(e)) + "</p>"; }
      };
      host.onchange = async (e) => {
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
    const addTab = () => { if (!tabAdded && jobPage()) { tabAdded = true; registerJobTab({ id: "checklist", label: "Checklist", module: "workflows", order: 30, render: jobTab,
      count: (j) => (j && j.tasks ? j.tasks.filter((t) => !t.done).length : 0) }); } };
    addTab(); if (!tabAdded) setTimeout(addTab, 0);

    return { show, jobTab };
  })();
