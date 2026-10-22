  // ================================================================ STAFF: Time clock and mileage (2026-10-22)
  // Clock: clock in from a phone to one of today's jobs (yours first) or to Studio / Admin / Other, switch, clock out.
  // Timesheets: a week (Sunday start) per person, worked vs scheduled per day, the punches behind it and fixes;
  // Edit approves weeks (that locks them) and downloads the payroll CSV. Mileage: a month of trips (clocking in to a
  // job adds its round trip from the studio), totals and pay at the mileage rate, CSV. View = your own; Edit = everyone.
  // RPCs: timeclock_status / timeclock_in / timeclock_out / timesheet_week / timepunch_save / timepunch_remove /
  // timesheet_approve / timesheet_payroll / timeclock_settings_save / mileage_list / mileage_save / mileage_remove /
  // mileage_refresh / mileage_from_schedule / timeclock_attention (migration 20261022213000).
  // Round two (migration 20261023141500): location on clock in/out, reminders and midnight clock-out (server side),
  // estimated pay and overtime warnings on timesheets; Expenses and Pay rates live in timeclock-extra.js.
  registerPage({ id: "clock", group: "Staff", section: "staff", module: "timeclock", title: "Time clock", selfService: true, // View = use it for yourself
                 tabs: [["clock", "Clock"], ["timesheets", "Timesheets"], ["mileage", "Mileage"], ["expenses", "Expenses"]],
                 onShow: (tab) => (tab === "timesheets" ? TimeClock.loadWeek() : tab === "mileage" ? TimeClock.loadMiles() : tab === "expenses" ? TimeClockExtra.loadExpenses() : TimeClock.loadClock()) });
  registerAttention("timeclockOpen", { module: "timeclock", level: "warn", name: "time clock",
    one: "A clock has been running for more than 12 hours. Someone probably forgot to clock out.", many: "{n} clocks have been running for more than 12 hours." });
  registerAttention("timesheetsApprove", { module: "timeclock", level: "soon", name: "timesheets",
    one: "A timesheet from last week is waiting for approval.", many: "{n} timesheets from last week are waiting for approval." });
  registerAttention("timeclockReview", { module: "timeclock", level: "warn", name: "time clock",
    one: "A clock was stopped at midnight. Check its clock-out time.", many: "{n} clocks were stopped at midnight. Check their clock-out times." });
  registerAttention("expensesWaiting", { module: "timeclock", level: "soon", name: "expenses",
    one: "An expense is waiting for approval.", many: "{n} expenses are waiting for approval." });
  registerAttention("overtimeNear", { module: "timeclock", level: "soon", name: "overtime",
    one: "Someone is close to overtime this week.", many: "{n} people are close to overtime this week." });
  registerTodayLoader("timeclock", () => TimeClock.loadToday());

  const TimeClock = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const DRIVE_FN_URL = SUPABASE_URL + "/functions/v1/drive-time";
    const KIND = { job: "Job", studio: "Studio", admin: "Admin", other: "Other" };
    const KINDS = ["job", "studio", "admin", "other"];
    // 135 -> "2h 15m"; 0 -> "0h"
    const hm = (min) => { min = Math.max(0, Math.round(num(min))); const h = Math.floor(min / 60), m = min % 60; return h ? h + "h" + (m ? " " + m + "m" : "") : m + "m"; };
    const hrs2 = (min) => (Math.round(num(min) / 60 * 100) / 100).toFixed(2);
    const mi = (v) => (v == null ? "" : (Math.round(num(v) * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 }));
    const money = (v) => "$" + num(v).toFixed(2);
    const rateTxt = (r) => "$" + num(r).toFixed(Math.round(num(r) * 1000) % 10 ? 3 : 2) + " a mile";
    const names = (list) => list.map((p) => T.shortName(p.name)).join(", ").replace(/\.?$/, ".");
    const what = (p) => (p.kind === "job" ? p.job_title || "Job" : KIND[p.kind] || "Work");

    const css = `
    .aca .tc-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 0 14px; }
    .aca .tc-bar h2 { margin: 0 8px 0 4px; font-size: 17px; font-weight: 600; white-space: nowrap; }
    .aca .tc-bar .grow { flex: 1; }
    .aca .tc-clock { max-width: 560px; }
    .aca .tc-state { margin: 0; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .aca .tc-state.on { color: var(--ok-fg); }
    .aca .tc-big { font-size: 44px; line-height: 52px; font-weight: 600; font-variant-numeric: tabular-nums; margin: 4px 0 2px; }
    .aca .tc-on-what { margin: 0 0 16px; font-size: 15px; }
    .aca .tc-on-what .s { display: block; color: var(--muted); font-size: 13px; }
    .aca button.tc-go { width: 100%; height: 52px; font-size: 17px; justify-content: center; }
    .aca .tc-pick { display: flex; flex-direction: column; gap: 8px; margin: 10px 0 12px; }
    .aca .tc-pick button { display: block; width: 100%; height: auto; min-height: 52px; text-align: left; padding: 10px 14px; white-space: normal; font-weight: 600; font-size: 15px; line-height: 20px; }
    .aca .tc-pick button .s { display: block; font-weight: 400; font-size: 12.5px; color: var(--muted); }
    .aca .tc-pick button.mine { border-color: var(--accent); }
    .aca .tc-kinds { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0 0 12px; }
    .aca .tc-kinds button { height: 48px; justify-content: center; font-size: 15px; }
    .aca .tc-note { width: 100%; margin: 0 0 12px; }
    .aca .tc-sec { margin: 26px 0 0; }
    .aca .tc-sec h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .aca .tc-list { list-style: none; margin: 0; padding: 0; }
    .aca .tc-list li { display: grid; grid-template-columns: 210px minmax(0, 1fr) auto; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line2); font-size: 14px; }
    .aca .tc-list .t { font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .aca .tc-list .s { display: block; color: var(--muted); font-size: 12.5px; }
    .aca .tc-tag { display: inline-block; font-size: 11.5px; font-weight: 700; padding: 0 6px; border-radius: 3px; margin-left: 6px; vertical-align: 1px; background: var(--warn-bg); color: var(--warn-fg); }
    .aca .tc-tag.ok { background: var(--ok-bg); color: var(--ok-fg); }
    .aca .tc-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .aca .tc-week td, .aca .tc-week th { padding: 8px 8px; font-size: 13px; }
    .aca .tc-week td.tc-num .s { display: block; color: var(--faint); font-size: 11.5px; }
    .aca .tc-over { color: var(--accent); font-weight: 600; } .aca .tc-under { color: var(--muted); }
    .aca .tc-person { margin: 0 0 30px; }
    .aca .tc-person h3 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 8px; font-size: 15px; }
    .aca .tc-person h3 .grow { flex: 1; }
    .aca .tc-sum { color: var(--muted); font-size: 13px; margin: 0 0 8px; }
    .aca tr.tc-row { cursor: pointer; }
    .aca .tc-modal .field input[type=text], .aca .tc-modal .field input[type=number], .aca .tc-modal .field select, .aca .tc-modal .field textarea { width: 100%; }
    .aca .tc-modal textarea { height: 60px; padding: 6px 10px; }
    .aca .tc-modal .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .aca .tc-modal .row3 { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 10px; }
    .aca .tc-warn { margin: 0 0 10px; padding: 9px 12px; border-radius: 4px; background: var(--warn-bg); color: var(--warn-fg); font-size: 13px; }
    .aca .tc-today p { margin: 8px 0; font-size: 13.5px; }
    .aca .tc-only-sm { display: none; }
    .aca .tc-today .tc-tbtn { display: flex; gap: 8px; flex-wrap: wrap; }
    @media (max-width: 700px) {
      .aca .tc-list li { grid-template-columns: 1fr auto; } .aca .tc-list li > :nth-child(2) { grid-column: 1 / -1; grid-row: 2; }
      .aca .tc-modal .row2, .aca .tc-modal .row3 { grid-template-columns: 1fr; } .aca .tc-hide-sm { display: none; } .aca .tc-only-sm { display: block; }
      .aca .tc-days li { grid-template-columns: 1fr auto; } .aca .tc-days li > :nth-child(2) { grid-column: auto; grid-row: auto; }
    }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    function download(name, rows) {
      const cell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }));
      a.download = name; document.body.appendChild(a); a.click(); a.remove();
    }
    // The phone's location for a punch, when Settings asks for it. Never holds the clock up: a refusal, no GPS or
    // more than 6 seconds = no location.
    function getLoc() {
      if (!st || !st.gps || !navigator.geolocation) return Promise.resolve(null);
      return new Promise((ok) => {
        const done = (v) => { clearTimeout(t); ok(v); };
        const t = setTimeout(() => ok(null), 6500);
        navigator.geolocation.getCurrentPosition(
          (p) => done({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6, acc: Math.round(p.coords.accuracy || 0) }),
          () => done(null), { enableHighAccuracy: false, timeout: 6000, maximumAge: 120000 });
      });
    }
    const mapLink = (l, label) => (l ? '<a href="https://www.google.com/maps?q=' + esc(l.lat + "," + l.lng) + '" target="_blank" rel="noopener" title="Within about ' + esc(l.acc) + ' m">' + label + "</a>" : "");
    const locHtml = (x) => (x.in_loc || x.out_loc ? '<span class="s">' + [mapLink(x.in_loc, "In location"), mapLink(x.out_loc, "Out location")].filter(Boolean).join(" \u00b7 ") + "</span>" : "");
    const reviewTag = (x) => (x.needs_review ? '<span class="tc-tag" title="Stopped automatically at midnight. Fix the clock-out time and save.">check time</span>' : "");
    const payTxt = (pay) => (pay ? "est. " + money(pay.pay) : "");
    const mErrIn = (m) => (t) => { const n = m.querySelector(".tc-merr"); n.textContent = t; n.classList.remove("hidden"); };

    // ---------------------------------------------------------------- Clock
    const clockRoot = el("panel-clock");
    clockRoot.innerHTML = '<div class="tc-clock"><div id="aca-tcErr" class="inline-error hidden"></div><div id="aca-tcBody"><p class="empty">Loading&#8230;</p></div></div>';
    let st = null, picking = false, ticker = null;

    async function loadClock() {
      clearError("tcErr");
      try {
        const { data, error } = await sb.rpc("timeclock_status");
        if (error) throw error;
        st = data; picking = false; renderClock();
      } catch (e) { showError("tcErr", "Could not load the time clock: " + cleanErr(e)); }
    }
    const since = (ts) => Math.max(0, (Date.now() - new Date(ts).getTime()) / 6e4);
    const clockFace = (min) => Math.floor(min / 60) + ":" + String(Math.floor(min % 60)).padStart(2, "0");
    function renderClock() {
      const o = st.open;
      let top;
      if (o && !picking) {
        top = '<p class="tc-state on">Clocked in</p><div class="tc-big" id="aca-tcTimer">' + clockFace(since(o.clock_in)) + "</div>" +
          '<p class="tc-on-what">' + esc(what(o)) + '<span class="s">since ' + esc(T.fmtTs(o.clock_in)) + (o.day !== T.today() ? " on " + esc(T.fmtDay(o.day)) : "") + (o.note ? " \u00b7 " + esc(o.note) : "") + "</span></p>" +
          '<button type="button" class="primary tc-go" data-c="out">Clock out</button>' +
          '<p style="margin:12px 0 0"><button type="button" class="link" data-c="switch">Switch to something else</button></p>';
      } else {
        const jobs = st.jobs || [];
        top = (o ? '<p class="tc-state on">Switching from ' + esc(what(o)) + '</p>' : '<p class="tc-state">Clocked out</p>') +
          '<h2 style="margin:6px 0 4px;font-size:18px">What are you working on?</h2>' +
          (jobs.length ? '<div class="tc-pick">' + jobs.map((j) => '<button type="button" data-in="job" data-b="' + esc(j.booking_id) + '"' + (j.mine ? ' class="mine"' : "") + ">" + esc(j.title) +
            '<span class="s">' + esc([j.mine ? "On your schedule" : "", j.start_at ? T.fmtTs(j.start_at) : "", j.location].filter(Boolean).join(" \u00b7 ")) + "</span></button>").join("") + "</div>"
            : '<p class="empty" style="padding:8px 0">No jobs today.</p>') +
          '<div class="tc-kinds">' + ["studio", "admin", "other"].map((k) => '<button type="button" data-in="' + k + '">' + KIND[k] + "</button>").join("") + "</div>" +
          '<input type="text" class="tc-note" id="aca-tcNote" maxlength="200" placeholder="Note (optional)" />' +
          (st.gps ? '<p class="muted" style="margin:-4px 0 12px;font-size:12.5px">Your location is saved with each clock in and out, if your phone allows it.</p>' : "") +
          (o ? '<p style="margin:0"><button type="button" class="link" data-c="cancel">Keep going on ' + esc(what(o)) + "</button></p>" : "");
      }
      const today = st.today || [];
      const worked = today.reduce((n, p) => n + num(p.minutes), 0);
      const otLeft = st.overtime_applies === false || !st.overtime_after ? null : Math.round(num(st.overtime_after) * 60) - num(st.week_worked_min);
      const warn = (st.review ? '<p class="tc-warn" style="margin-top:14px">' + (st.review === 1 ? "A clock of yours was" : st.review + " clocks of yours were") +
          ' stopped at midnight. <a href="#staff/timesheets">Put in the real time</a>.</p>' : "") +
        (otLeft != null && otLeft <= 4 * 60 ? '<p class="tc-warn" style="margin-top:14px">' + (otLeft > 0 ? hm(otLeft) + " left before overtime this week." : "You are into overtime this week.") + "</p>" : "");
      el("tcBody").innerHTML = top + warn +
        '<div class="tc-sec"><h3>Today</h3>' + (today.length ? '<ul class="tc-list">' + today.map((p) => "<li><span class=\"t\">" + esc(T.fmtTs(p.clock_in)) + "\u2013" + (p.clock_out ? esc(T.fmtTs(p.clock_out)) : "now") + "</span><span>" + esc(what(p)) +
          (p.edited ? '<span class="tc-tag">edited</span>' : "") + (p.note ? '<span class="s">' + esc(p.note) + "</span>" : "") + '</span><span class="tc-num">' + hm(p.minutes) + "</span></li>").join("") + "</ul>" : '<p class="empty">Nothing yet today.</p>') +
          (today.length ? '<p class="tc-sum" style="margin-top:8px">' + hm(worked) + " worked" + (st.today_scheduled_min ? " of " + hm(st.today_scheduled_min) + " scheduled" : "") + "</p>" : "") + "</div>" +
        '<div class="tc-sec"><h3>This week</h3><p class="tc-sum">' + hm(st.week_worked_min) + " worked" + (st.week_scheduled_min ? " of " + hm(st.week_scheduled_min) + " scheduled" : "") +
          ' \u00b7 <a href="#staff/timesheets">Timesheet</a> \u00b7 <a href="#staff/mileage">Mileage</a></p></div>';
      clearInterval(ticker);
      if (o && !picking) ticker = setInterval(() => { const n = el("tcTimer"); if (!n || !st.open) { clearInterval(ticker); return; } n.textContent = clockFace(since(st.open.clock_in)); }, 20000);
    }
    clockRoot.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-c], [data-in]"); if (!b) return;
      if (b.dataset.c === "switch") { picking = true; renderClock(); return; }
      if (b.dataset.c === "cancel") { picking = false; renderClock(); return; }
      b.disabled = true;
      try {
        if (b.dataset.c === "out") {
          const loc = await getLoc();
          const { data, error } = await sb.rpc("timeclock_out", { p_note: "", p_loc: loc });
          if (error) throw error;
          toast("Clocked out. " + hm(data && data.minutes) + ".");
        } else {
          const k = b.dataset.in;
          const note = (el("tcNote") && el("tcNote").value.trim()) || "";
          const loc = await getLoc();
          const { data, error } = await sb.rpc("timeclock_in", { p_kind: k, p_booking: k === "job" ? b.dataset.b : null, p_note: note, p_loc: loc });
          if (error) throw error;
          toast((data && data.switched ? "Switched. " : "Clocked in. ") + (k === "job" ? b.firstChild.textContent : KIND[k]) + ".");
        }
        await loadClock(); loadAttention();
      } catch (e) { b.disabled = false; toast(cleanErr(e), true); }
    });

    // ---------------------------------------------------------------- Timesheets
    const weekRoot = el("panel-timesheets");
    weekRoot.innerHTML =
      '<div class="tc-bar"><button type="button" class="small" data-w="prev" aria-label="Week before">&lsaquo;</button><button type="button" class="small" data-w="this">This week</button>' +
      '<button type="button" class="small" data-w="next" aria-label="Week after">&rsaquo;</button><h2 id="aca-tsTitle">Timesheet</h2><span class="grow"></span>' +
      '<label class="hidden" id="aca-tsWhoWrap" style="font-size:13px">Showing <select class="small" id="aca-tsWho"><option value="me">Me</option><option value="all">Everyone</option></select></label>' +
      '<button type="button" class="small" data-w="add">Add time</button><button type="button" class="small hidden tc-ed" data-w="payroll">Payroll CSV</button>' +
      '<button type="button" class="small hidden tc-ed" data-w="rates">Pay rates</button><button type="button" class="small hidden tc-ed" data-w="settings">Settings</button></div>' +
      '<div id="aca-tsErr" class="inline-error hidden"></div><div id="aca-tsBody"><p class="empty">Loading&#8230;</p></div>';
    let week = null, who = "me", wk = null, people = [];

    async function loadWeek() {
      if (!week) week = T.weekStart(T.today());
      clearError("tsErr");
      const ed = canEdit("timeclock");
      el("tsWhoWrap").classList.toggle("hidden", !ed);
      weekRoot.querySelectorAll(".tc-ed").forEach((n) => n.classList.toggle("hidden", !ed));
      el("tsTitle").textContent = (week === T.weekStart(T.today()) ? "This week, " : "Week of ") + T.fmtDay(week, { weekday: undefined }) + "\u2013" + T.fmtDay(T.addDays(week, 6), { weekday: undefined });
      try {
        const { data, error } = await sb.rpc("timesheet_week", who === "me" ? { p_start: week } : who === "all" ? { p_start: week, p_all: true } : { p_start: week, p_user: who });
        if (error) throw error;
        wk = data;
        if (ed) await loadPeople();
        renderWeek();
      } catch (e) { showError("tsErr", "Could not load the timesheet: " + cleanErr(e)); }
    }
    // Everyone on the team, for the Showing / Person pickers (Edit only).
    async function loadPeople() {
      if (people.length) return;
      const { data } = await sb.rpc("timesheet_week", { p_start: T.weekStart(T.today()), p_all: true });
      people = ((data && data.people) || []).map((p) => ({ user_id: p.user_id, name: p.name }));
      el("tsWho").innerHTML = '<option value="me">Me</option><option value="all">Everyone</option>' +
        people.filter((p) => p.user_id !== data.me).map((p) => '<option value="' + esc(p.user_id) + '">' + esc(T.shortName(p.name)) + "</option>").join("");
      el("tsWho").value = who;
    }
    const total = (p, k) => (p.days || []).reduce((n, d) => n + num(d[k]), 0);
    // Salaried and 1099 contractors get no overtime (employment type on the Team page).
    const overtime = (p) => (p.overtime_applies === false ? 0 : Math.max(0, total(p, "worked_min") - Math.round(num(wk.overtime_after) * 60)));
    function diffHtml(w, s) {
      if (!s) return "";
      const d = w - s;
      if (Math.abs(d) < 15) return '<span class="s">on schedule</span>';
      return '<span class="s ' + (d > 0 ? "tc-over" : "tc-under") + '">' + (d > 0 ? "+" : "\u2212") + hm(Math.abs(d)) + "</span>";
    }
    function statusHtml(p) {
      if (p.review && !p.approved_at) return '<span class="pill warn" title="A clock-out was filled in at midnight">Check time</span>';
      if (p.approved_at) return '<span class="pill ok">Approved' + (p.approved_by ? " by " + esc(T.shortName(p.approved_by)) : "") + "</span>";
      if (p.open) return '<span class="pill warn">Clocked in</span>';
      return total(p, "worked_min") ? '<span class="pill muted">Not approved</span>' : "";
    }
    function approveBtn(p) {
      if (!wk.can_edit || (!total(p, "worked_min") && !p.approved_at)) return "";
      return '<button type="button" class="small" data-approve="' + esc(p.user_id) + '" data-on="' + (p.approved_at ? "0" : "1") + '">' + (p.approved_at ? "Unapprove" : "Approve") + "</button>";
    }
    function renderWeek() {
      const days = Array.from({ length: 7 }, (_, i) => T.addDays(wk.week_start, i));
      const head = "<thead><tr><th></th>" + days.map((d) => '<th class="tc-num">' + esc(T.fmtDay(d, { month: undefined, day: "numeric" })) + "</th>").join("") + '<th class="tc-num">Total</th></tr></thead>';
      if (who === "all") {
        const list = wk.people.filter((p) => total(p, "worked_min") || total(p, "scheduled_min") || p.approved_at);
        el("tsBody").innerHTML = !list.length ? '<p class="empty">Nobody has time this week.</p>' :
          '<div class="table-wrap"><table class="tc-week"><thead><tr><th>Person</th>' + days.map((d) => '<th class="tc-num tc-hide-sm">' + esc(T.fmtDay(d, { month: undefined, day: "numeric" })) + "</th>").join("") +
          '<th class="tc-num">Worked</th><th class="tc-num tc-hide-sm">Scheduled</th><th class="tc-num tc-hide-sm">Overtime</th><th class="tc-num tc-hide-sm">Miles</th><th class="tc-num tc-hide-sm">Est. pay</th><th>Status</th><th></th></tr></thead><tbody>' +
          list.map((p) => { const w = total(p, "worked_min"), s = total(p, "scheduled_min"), ot = overtime(p);
            return '<tr class="tc-row" data-person="' + esc(p.user_id) + '"><td class="name">' + esc(T.shortName(p.name)) + "</td>" +
              p.days.map((d) => '<td class="tc-num tc-hide-sm">' + (d.worked_min ? hm(d.worked_min) : "") + (d.scheduled_min ? '<span class="s">' + hm(d.scheduled_min) + "</span>" : "") + "</td>").join("") +
              '<td class="tc-num">' + hm(w) + diffHtml(w, s) + '</td><td class="tc-num tc-hide-sm">' + (s ? hm(s) : "") + '</td><td class="tc-num tc-hide-sm">' + (ot ? '<span class="tc-over">' + hm(ot) + "</span>" : "") +
              '</td><td class="tc-num tc-hide-sm">' + (num(p.miles) ? mi(p.miles) : "") + '</td><td class="tc-num tc-hide-sm">' + (p.pay ? money(p.pay.pay) : "") + "</td><td>" + statusHtml(p) + "</td><td>" + approveBtn(p) + "</td></tr>"; }).join("") +
          "</tbody></table></div>" + '<p class="tc-sum" style="margin-top:8px">Small numbers are scheduled time from the Schedule. Click a person to see and fix their punches. Est. pay uses the pay rates and leaves out mileage and expenses.</p>';
        return;
      }
      el("tsBody").innerHTML = wk.people.map((p) => {
        const w = total(p, "worked_min"), s = total(p, "scheduled_min"), ot = overtime(p);
        const punches = wk.punches.filter((x) => x.user_id === p.user_id);
        const mine = p.user_id === wk.me;
        const hist = wk.can_edit && typeof HistoryView !== "undefined" ? '<button type="button" class="small quiet" data-hist="' + esc(p.user_id) + '" data-name="' + esc(p.name) + '">History</button>' : "";
        return '<div class="tc-person"><h3>' + esc(mine && who === "me" ? "Your timesheet" : T.shortName(p.name)) + " " + statusHtml(p) + '<span class="grow"></span>' + hist + approveBtn(p) + "</h3>" +
          '<p class="tc-sum">' + hm(w) + " worked" + (s ? " of " + hm(s) + " scheduled" : "") + (ot ? ' \u00b7 <span class="tc-over">' + hm(ot) + " overtime</span>" : "") + (num(p.miles) ? " \u00b7 " + mi(p.miles) + " mi" : "") + (p.pay ? " \u00b7 " + payTxt(p.pay) : "") + (num(p.expenses) ? " \u00b7 " + money(p.expenses) + " expenses" : "") + "</p>" +
          '<ul class="tc-list tc-days tc-only-sm">' + p.days.filter((d) => d.worked_min || d.scheduled_min).map((d) => '<li><span class="t">' + esc(T.fmtDay(d.day)) + '</span><span class="tc-num">' + (d.worked_min ? hm(d.worked_min) : "\u2013") +
            (d.scheduled_min ? '<span class="s">of ' + hm(d.scheduled_min) + " scheduled</span>" : "") + "</span></li>").join("") + "</ul>" +
          '<div class="table-wrap tc-hide-sm"><table class="tc-week">' + head + "<tbody>" +
          '<tr><td class="name">Worked</td>' + p.days.map((d) => '<td class="tc-num">' + (d.worked_min ? hm(d.worked_min) : "") + diffHtml(d.worked_min, d.scheduled_min) + "</td>").join("") + '<td class="tc-num"><b>' + hm(w) + "</b></td></tr>" +
          '<tr><td class="name" style="font-weight:400;color:var(--muted)">Scheduled</td>' + p.days.map((d) => '<td class="tc-num" style="color:var(--muted)">' + (d.scheduled_min ? hm(d.scheduled_min) : "") + "</td>").join("") + '<td class="tc-num" style="color:var(--muted)">' + (s ? hm(s) : "") + "</td></tr>" +
          "</tbody></table></div>" +
          '<div class="tc-sec" style="margin-top:14px"><h3>Punches</h3>' + (punches.length ? '<ul class="tc-list">' + punches.map((x) =>
            '<li class="tc-row" data-punch="' + esc(x.id) + '"><span class="t">' + esc(T.fmtDay(x.day)) + " " + esc(T.fmtTs(x.clock_in)) + "\u2013" + (x.clock_out ? esc(T.fmtTs(x.clock_out)) : "now") + "</span><span>" + esc(what(x)) +
            reviewTag(x) + (x.edited ? '<span class="tc-tag" title="' + esc(x.edited_by ? "Changed by " + x.edited_by : "Typed in") + '">edited</span>' : "") + (x.note ? '<span class="s">' + esc(x.note) + "</span>" : "") + locHtml(x) +
            '</span><span class="tc-num">' + hm(x.minutes) + "</span></li>").join("") + "</ul>" : '<p class="empty">No time clocked this week.</p>') + "</div></div>";
      }).join("") || '<p class="empty">Nothing this week.</p>';
    }
    weekRoot.addEventListener("click", async (ev) => {
      if (ev.target.closest("a[href^='https:']")) return; // a map link inside a punch row
      const hb = ev.target.closest("[data-hist]");
      if (hb) { HistoryView.open("punches", hb.dataset.hist, "Time clock: " + hb.dataset.name); return; }
      const ap = ev.target.closest("[data-approve]");
      if (ap) {
        ev.stopPropagation(); ap.disabled = true;
        try {
          const { error } = await sb.rpc("timesheet_approve", { p_user: ap.dataset.approve, p_week: wk.week_start, p_approve: ap.dataset.on === "1" });
          if (error) throw error;
          toast(ap.dataset.on === "1" ? "Approved. That week is locked now." : "Unapproved.");
          loadWeek(); loadAttention();
        } catch (e) { ap.disabled = false; toast(cleanErr(e), true); }
        return;
      }
      const row = ev.target.closest("[data-person]");
      if (row) { who = row.dataset.person === wk.me ? "me" : row.dataset.person; el("tsWho").value = who; loadWeek(); return; }
      const pr = ev.target.closest("[data-punch]");
      if (pr) { openPunch(wk.punches.find((x) => x.id === pr.dataset.punch)); return; }
      const b = ev.target.closest("[data-w]"); if (!b) return;
      const v = b.dataset.w;
      if (v === "prev") week = T.addDays(week, -7);
      else if (v === "next") week = T.addDays(week, 7);
      else if (v === "this") week = T.weekStart(T.today());
      else if (v === "add") return openPunch(null);
      else if (v === "payroll") return openPayroll();
      else if (v === "settings") return openSettings();
      else if (v === "rates") return TimeClockExtra.openRates();
      loadWeek();
    });
    el("tsWho").addEventListener("change", () => { who = el("tsWho").value; loadWeek(); });

    function openPunch(x) {
      const isNew = !x;
      const forUser = x ? x.user_id : who !== "me" && who !== "all" ? who : wk.me;
      if (x && x.locked) { toast("That week is approved. " + (wk.can_edit ? "Unapprove it to change it." : "Ask a manager to change it."), true); return; }
      if (x && x.user_id !== wk.me && !wk.can_edit) return;
      const open = x && !x.clock_out;
      const day0 = x ? x.day : T.today() < T.addDays(week, 7) && T.today() >= week ? T.today() : week;
      const kind0 = x ? x.kind : "studio";
      const jobs = wk.jobs || [];
      const m = openModal('<div class="tc-modal"><h2>' + (isNew ? "Add time" : open ? "Fix the clock-in time" : "Change time") + "</h2>" +
        (wk.can_edit && isNew ? '<div class="field"><label for="aca-tpP">Person</label><select id="aca-tpP">' + (people.length ? people : [{ user_id: wk.me, name: "Me" }]).map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === forUser ? " selected" : "") + ">" + esc(p.name) + "</option>").join("") + "</select></div>" : "") +
        '<div class="field"><label>What</label><div class="seg" role="radiogroup" aria-label="What">' + KINDS.map((k) => '<label><input type="radio" name="aca-tpK" value="' + k + '"' + (k === kind0 ? " checked" : "") + " /><span>" + KIND[k] + "</span></label>").join("") + "</div></div>" +
        '<div class="field tc-only-job"><label for="aca-tpB">Job</label><select id="aca-tpB"><option value="">Pick a job this week\u2026</option>' +
          jobs.map((j) => '<option value="' + esc(j.booking_id) + '" data-day="' + esc(j.day) + '"' + (x && x.booking_id === j.booking_id && x.day === j.day ? " selected" : "") + ">" + esc(T.fmtDay(j.day) + " \u00b7 " + j.title) + "</option>").join("") +
          (x && x.booking_id && !jobs.some((j) => j.booking_id === x.booking_id) ? '<option value="' + esc(x.booking_id) + '" selected>' + esc(x.job_title) + "</option>" : "") + "</select></div>" +
        '<div class="row3"><div class="field"><label for="aca-tpD">Day</label><input type="date" id="aca-tpD" value="' + esc(day0) + '" /></div>' +
          '<div class="field"><label for="aca-tpI">Clock in</label><input type="time" id="aca-tpI" step="60" value="' + (x ? T.hhmm(T.local(x.clock_in).min) : "09:00") + '" /></div>' +
          '<div class="field"><label for="aca-tpO">Clock out</label><input type="time" id="aca-tpO" step="60" data-dp-after="#aca-tpI" value="' + (x && x.clock_out ? T.hhmm(T.local(x.clock_out).min) : open ? "" : "17:00") + '"' + (open ? ' placeholder="Still clocked in"' : "") + " /></div></div>" +
        (open ? '<p class="muted" style="margin:-4px 0 10px;font-size:12.5px">Leave clock-out empty to stay clocked in.</p>' : "") +
        (x && x.needs_review ? '<p class="tc-warn">This clock was still running at midnight, so it was stopped then. Put in the time work really stopped, then Save.</p>' : "") +
        '<div class="field"><label for="aca-tpN">Note</label><textarea id="aca-tpN" maxlength="500">' + esc(x ? x.note : "") + "</textarea></div>" +
        '<div class="inline-error hidden tc-merr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" data-m="remove">Remove</button>') + '<span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">' + (isNew ? "Add" : "Save") + "</button></div></div>");
      const mErr = mErrIn(m);
      const kind = () => m.querySelector('input[name="aca-tpK"]:checked').value;
      const sync = () => m.querySelectorAll(".tc-only-job").forEach((n) => n.classList.toggle("hidden", kind() !== "job"));
      sync();
      m.querySelectorAll('input[name="aca-tpK"]').forEach((r) => r.addEventListener("change", sync));
      el("tpB").addEventListener("change", () => { const o = el("tpB").selectedOptions[0]; if (o && o.dataset.day) el("tpD").value = o.dataset.day; });
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") return m.close();
        if (t.dataset.m === "remove") {
          if (!confirm("Remove this time from the timesheet?")) return;
          t.disabled = true;
          try { const { error } = await sb.rpc("timepunch_remove", { p_id: x.id }); if (error) throw error; m.close(); toast("Removed."); loadWeek(); }
          catch (e) { mErr(cleanErr(e)); t.disabled = false; }
          return;
        }
        const k = kind(), d = el("tpD").value, ti = el("tpI").value, to = el("tpO").value;
        if (!d || !ti) return mErr("Enter the day and the clock-in time.");
        if (!to && !open) return mErr("Enter the clock-out time.");
        const p = { id: x ? x.id : null, kind: k, clock_in: T.toIso(d, ti), clock_out: to ? T.toIso(to <= ti ? T.addDays(d, 1) : d, to) : null, note: el("tpN").value.trim() };
        if (isNew) p.user_id = el("tpP") ? el("tpP").value : wk.me;
        if (k === "job") { p.booking_id = el("tpB").value || (x && x.booking_id) || null; if (!p.booking_id) return mErr("Pick the job."); }
        t.disabled = true;
        try {
          const { error } = await sb.rpc("timepunch_save", { p });
          if (error) throw error;
          m.close(); toast(isNew ? "Added." : "Saved.");
          const dw = T.weekStart(T.local(p.clock_in).day); if (dw !== week) week = dw;
          loadWeek();
        } catch (e) { mErr(cleanErr(e)); t.disabled = false; }
      });
    }

    async function openPayroll() {
      const m = openModal('<div class="tc-modal"><h2>Payroll</h2>' +
        '<div class="row2"><div class="field"><label for="aca-prW">Pay period</label><select id="aca-prW"><option value="1">1 week</option><option value="2">2 weeks</option></select></div>' +
        '<div class="field"><label>Ending</label><p style="margin:6px 0 0" id="aca-prEnd"></p></div></div>' +
        '<div id="aca-prBody"><p class="empty">Loading&#8230;</p></div><div class="inline-error hidden tc-merr"></div>' +
        '<div class="modal-actions"><button type="button" class="small" data-m="detail" disabled>Every punch (CSV)</button><button type="button" class="small hidden" data-m="exp">Expenses (CSV)</button><span class="grow"></span><button type="button" class="small" data-m="cancel">Close</button><button type="button" class="small hidden" data-m="cont">1099 contractors (CSV)</button><button type="button" class="primary" data-m="csv" disabled>Download payroll CSV</button></div></div>');
      const mErr = mErrIn(m);
      let pr = null;
      // 1099 contractors are kept out of the payroll CSV and listed on their own (employment type, Team page).
      const isCont = (p) => p.employment_type === "contractor";
      const TYPE = { full_time: "Full time", salaried: "Salaried", part_time: "Part time", contractor: "1099" };
      const estPay = (p) => (p.pay ? num(p.pay.pay) : null);
      const total$ = (p) => (estPay(p) == null ? null : estPay(p) + num(p.mileage_pay) + num(p.expenses));
      const table = (list, ot) => '<div class="table-wrap"><table class="tc-week"><thead><tr><th>Person</th><th class="tc-num">' + (ot ? "Regular" : "Hours") + "</th>" + (ot ? '<th class="tc-num">Overtime</th>' : "") + '<th class="tc-num">Miles</th><th class="tc-num">Mileage</th><th class="tc-num">Expenses</th><th class="tc-num">Est. pay</th></tr></thead><tbody>' +
        list.map((p) => '<tr><td class="name">' + esc(p.name) + (p.employment_type === "salaried" ? ' <span class="pill muted">Salaried</span>' : "") + '</td><td class="tc-num">' + hrs2(ot ? p.regular_min : p.worked_min) + "</td>" + (ot ? '<td class="tc-num">' + (p.overtime_min ? hrs2(p.overtime_min) : "") + "</td>" : "") + '<td class="tc-num">' + mi(p.miles) + '</td><td class="tc-num">' + money(p.mileage_pay) +
          '</td><td class="tc-num">' + (num(p.expenses) ? money(p.expenses) : "") + '</td><td class="tc-num" title="' + esc(p.pay ? (p.pay.basis === "day" ? "Day rate " + money(p.pay.rate) : money(p.pay.rate) + " an hour") + ", from the " + p.pay.source + " rate. Mileage and expenses added." : "No pay rate set") + '">' + (total$(p) != null ? money(total$(p)) : '<span class="muted">no rate</span>') + "</td></tr>").join("") +
        "</tbody></table></div>";
      async function run() {
        const n = +el("prW").value, start = T.addDays(week, -7 * (n - 1));
        el("prEnd").textContent = T.fmtDay(T.addDays(week, 6)) + " (from " + T.fmtDay(start) + ")";
        el("prBody").innerHTML = '<p class="empty">Loading&#8230;</p>';
        m.querySelectorAll('[data-m="csv"], [data-m="detail"]').forEach((b) => (b.disabled = true));
        try {
          const { data, error } = await sb.rpc("timesheet_payroll", { p_start: start, p_weeks: n });
          if (error) throw error;
          pr = data;
          const unapproved = pr.people.filter((p) => num(p.approved_weeks) < num(p.weeks)), open = pr.people.filter((p) => p.open);
          el("prBody").innerHTML = (open.length ? '<p class="tc-warn">Still clocked in: ' + esc(names(open)) + " Their open time counts up to now.</p>" : "") +
            (unapproved.length ? '<p class="tc-warn">Not approved yet: ' + esc(names(unapproved)) + "</p>" : "") +
            (pr.people.filter((p) => !isCont(p)).length ? table(pr.people.filter((p) => !isCont(p)), true) : pr.people.length ? "" : '<p class="empty">No time in this period.</p>') +
            (pr.people.some(isCont) ? '<h3 style="margin:16px 0 6px;font-size:14px">1099 contractors</h3><p class="tc-sum" style="margin:0 0 6px">Not in the payroll CSV. Pay them from their own CSV.</p>' + table(pr.people.filter(isCont), false) : "") +
            '<p class="tc-sum" style="margin-top:8px">Hours as decimals. Overtime is time over ' + esc(num(pr.overtime_after)) + " hours in a week (Sunday\u2013Saturday); salaried people and 1099 contractors get none. Mileage at " + rateTxt(pr.mileage_rate) + ". Expenses are the approved ones. Est. pay = pay rate (overtime at 1.5x) + mileage + expenses; set rates under Pay rates.</p>";
          m.querySelector('[data-m="csv"]').disabled = !pr.people.some((p) => !isCont(p));
          m.querySelector('[data-m="detail"]').disabled = !pr.people.length;
          m.querySelector('[data-m="cont"]').classList.toggle("hidden", !pr.people.some(isCont));
          m.querySelector('[data-m="exp"]').classList.toggle("hidden", !(pr.expense_rows || []).length);
        } catch (e) { mErr(cleanErr(e)); }
      }
      el("prW").addEventListener("change", run);
      run();
      m.addEventListener("click", (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") return m.close();
        if (!pr) return;
        const tag = pr.from + "_to_" + pr.to;
        if (t.dataset.m === "csv") {
          download("207-payroll-" + tag + ".csv", [["Name", "Email", "Type", "Period start", "Period end", "Regular hours", "Overtime hours", "Total hours", "Miles", "Mileage pay", "Expenses", "Est. wages", "Est. total", "Weeks approved"]]
            .concat(pr.people.filter((p) => !isCont(p)).map((p) => [p.name, p.email || "", TYPE[p.employment_type] || "", pr.from, pr.to, hrs2(p.regular_min), hrs2(p.overtime_min), hrs2(p.worked_min), (Math.round(num(p.miles) * 10) / 10).toFixed(1), num(p.mileage_pay).toFixed(2), num(p.expenses).toFixed(2),
              estPay(p) == null ? "" : estPay(p).toFixed(2), total$(p) == null ? "" : total$(p).toFixed(2), p.approved_weeks + " of " + p.weeks])));
        }
        if (t.dataset.m === "cont") {
          download("207-1099-" + tag + ".csv", [["Name", "Email", "Job title", "Period start", "Period end", "Hours", "Miles", "Mileage pay", "Expenses", "Est. fees", "Est. total", "Weeks approved"]]
            .concat(pr.people.filter(isCont).map((p) => [p.name, p.email || "", p.job_title || "", pr.from, pr.to, hrs2(p.worked_min), (Math.round(num(p.miles) * 10) / 10).toFixed(1), num(p.mileage_pay).toFixed(2), num(p.expenses).toFixed(2),
              estPay(p) == null ? "" : estPay(p).toFixed(2), total$(p) == null ? "" : total$(p).toFixed(2), p.approved_weeks + " of " + p.weeks])));
        }
        if (t.dataset.m === "exp") {
          download("207-expenses-" + tag + ".csv", [["Name", "Date", "Amount", "For", "Job", "Note", "Approved by"]]
            .concat((pr.expense_rows || []).map((x) => [x.name, x.day, num(x.amount).toFixed(2), x.category, x.job_title || "", x.note, x.reviewed_by || ""])));
        }
        if (t.dataset.m === "detail") {
          download("207-punches-" + tag + ".csv", [["Name", "Date", "Clock in", "Clock out", "Hours", "What", "Job", "Note", "Edited"]]
            .concat(pr.punches.map((x) => [x.name, x.day, T.fmtTs(x.clock_in), x.clock_out ? T.fmtTs(x.clock_out) : "(still clocked in)", hrs2(x.minutes), KIND[x.kind], x.kind === "job" ? x.job_title : "", x.note, x.edited ? "yes" : ""])));
        }
      });
    }

    async function openSettings() {
      const { data } = await sb.rpc("timeclock_settings_get");
      const v = Object.assign({ mileage_rate: 0.7, overtime_after: 40, gps_on: true, remind_before_min: 15, remind_out_after_min: 30, auto_out: true, ot_warn_hours: 4, half_day_hours: 5 }, data || {});
      const numIn = (id, label, val, min, max, step) => '<div class="field"><label for="aca-' + id + '">' + label + '</label><input type="number" id="aca-' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + esc(val) + '" /></div>';
      const box = (id, label, on) => '<label style="display:flex;gap:8px;align-items:center;margin:0 0 10px;font-size:14px"><input type="checkbox" id="aca-' + id + '"' + (on ? " checked" : "") + " /> " + label + "</label>";
      const m = openModal('<div class="tc-modal"><h2>Time clock settings</h2>' +
        '<div class="row2">' + numIn("tsR", "Mileage rate ($ a mile)", v.mileage_rate, 0, 5, 0.005) + numIn("tsO", "Overtime after (hours a week)", v.overtime_after, 0, 80, 0.5) + "</div>" +
        '<div class="row2">' + numIn("tsW", "Overtime warning (hours before; 0 = off)", v.ot_warn_hours, 0, 40, 0.5) + numIn("tsH", "Half day is under (hours)", v.half_day_hours, 1, 12, 0.5) + "</div>" +
        '<div class="row2">' + numIn("tsB", "Clock-in reminder (minutes before; 0 = off)", v.remind_before_min, 0, 120, 5) + numIn("tsA", "Clock-out reminder (minutes after; 0 = off)", v.remind_out_after_min, 0, 240, 5) + "</div>" +
        box("tsG", "Save the phone\u2019s location with each clock in and out", v.gps_on) +
        box("tsX", "Stop clocks still running at midnight and flag them to check", v.auto_out) +
        '<p class="muted" style="font-size:12.5px">Reminders and warnings are phone notifications (people can turn each kind off). Trip miles are a round trip from the studio address on the Schedule page. The half-day rate applies to day-rate people who work less than the hours above.</p>' +
        '<div class="inline-error hidden tc-merr"></div><div class="modal-actions"><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">Save</button></div></div>');
      const mErr = mErrIn(m);
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") return m.close();
        t.disabled = true;
        try {
          const { error } = await sb.rpc("timeclock_settings_save", { p_rate: parseFloat(el("tsR").value), p_overtime: parseFloat(el("tsO").value),
            p: { gps_on: el("tsG").checked, auto_out: el("tsX").checked, ot_warn_hours: parseFloat(el("tsW").value) || 0, half_day_hours: parseFloat(el("tsH").value) || 5,
                 remind_before_min: parseInt(el("tsB").value, 10) || 0, remind_out_after_min: parseInt(el("tsA").value, 10) || 0 } });
          if (error) throw error;
          m.close(); toast("Saved."); loadWeek();
        } catch (e) { mErr(cleanErr(e)); t.disabled = false; }
      });
    }

    // ---------------------------------------------------------------- Mileage
    const milesRoot = el("panel-mileage");
    milesRoot.innerHTML =
      '<div class="tc-bar"><button type="button" class="small" data-v="prev" aria-label="Month before">&lsaquo;</button><button type="button" class="small" data-v="this">This month</button>' +
      '<button type="button" class="small" data-v="next" aria-label="Month after">&rsaquo;</button><h2 id="aca-miTitle">Mileage</h2><span class="grow"></span>' +
      '<label class="hidden" id="aca-miWhoWrap" style="font-size:13px">Showing <select class="small" id="aca-miWho"><option value="me">Mine</option><option value="all">Everyone</option></select></label>' +
      '<button type="button" class="small" data-v="add">Add trip</button><button type="button" class="small" data-v="sched">Add from schedule</button><button type="button" class="small" data-v="csv">Download CSV</button></div>' +
      '<div id="aca-miErr" class="inline-error hidden"></div><div id="aca-miBody"><p class="empty">Loading&#8230;</p></div>';
    let month = null, miWho = "me", ml = null;
    const lookedUp = new Set(); // bookings already asked of Google this session
    const monthStart = (day) => day.slice(0, 8) + "01";
    const addMonths = (day, n) => { const d = new Date(monthStart(day) + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
    const lookupErr = {};

    async function loadMiles(noLookup) {
      if (!month) month = monthStart(T.today());
      clearError("miErr");
      el("miWhoWrap").classList.toggle("hidden", !canEdit("timeclock"));
      el("miTitle").textContent = new Date(month + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
      try {
        const { data, error } = await sb.rpc("mileage_list", { p_month: month, p_all: miWho === "all" });
        if (error) throw error;
        ml = data;
        if (ml.can_edit) await loadPeople();
        renderMiles();
        if (!noLookup) fillMissing();
      } catch (e) { showError("miErr", "Could not load mileage: " + cleanErr(e)); }
    }
    // Trips made before their job's distance was known: ask the drive-time function (it caches), then fill them in.
    async function fillMissing() {
      const missing = ml.trips.filter((t) => t.miles == null && t.booking_id && !t.locked);
      if (!missing.length) return;
      const ask = [...new Set(missing.filter((t) => t.est_miles == null).map((t) => t.booking_id))].filter((b) => !lookedUp.has(b)).slice(0, 6);
      if (ask.length && ml.studio_address) {
        const { data: s } = await sb.auth.getSession();
        const token = s && s.session && s.session.access_token;
        await Promise.all(ask.map(async (b) => {
          lookedUp.add(b);
          try {
            const r = await fetch(DRIVE_FN_URL, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ booking_id: b }) });
            const j = await r.json().catch(() => ({}));
            if (!j.ok) lookupErr[b] = j.error || "No distance.";
          } catch (e) { lookupErr[b] = "Could not reach Google Maps."; }
        }));
      }
      const { data } = await sb.rpc("mileage_refresh", { p_month: month, p_all: miWho === "all" });
      if ((data && data.filled) || ask.length) loadMiles(true);
    }
    function renderMiles() {
      const trips = ml.trips, rate = num(ml.mileage_rate), all = miWho === "all";
      const milesOf = (t) => (t.miles != null ? num(t.miles) : 0);
      const totals = {};
      trips.forEach((t) => { const k = t.user_id; totals[k] = totals[k] || { name: t.name, n: 0, miles: 0 }; totals[k].n++; totals[k].miles += milesOf(t); });
      const sum = Object.values(totals);
      const allMiles = sum.reduce((n, x) => n + x.miles, 0);
      el("miBody").innerHTML = (!ml.studio_address ? '<p class="tc-warn">No studio address yet, so job miles can\'t be looked up. Set it on the Schedule page (Edit).</p>' : "") +
        '<p class="tc-sum">' + (trips.length ? mi(allMiles) + " miles \u00b7 " + money(allMiles * rate) + " at " + rateTxt(rate) + "." : "No trips this month.") +
        " Clocking in to a job adds its round trip from the studio. Set miles to 0 if you rode with someone.</p>" +
        (all && sum.length > 1 ? '<div class="table-wrap" style="margin-bottom:18px"><table class="tc-week"><thead><tr><th>Person</th><th class="tc-num">Trips</th><th class="tc-num">Miles</th><th class="tc-num">Pay</th></tr></thead><tbody>' +
          sum.sort((a, b) => a.name.localeCompare(b.name)).map((x) => '<tr><td class="name">' + esc(T.shortName(x.name)) + '</td><td class="tc-num">' + x.n + '</td><td class="tc-num">' + mi(x.miles) + '</td><td class="tc-num">' + money(x.miles * rate) + "</td></tr>").join("") + "</tbody></table></div>" : "") +
        (trips.length ? '<div class="table-wrap"><table class="tc-week"><thead><tr><th>Day</th>' + (all ? "<th>Person</th>" : "") + '<th>Job or where</th><th class="tc-num">Miles</th><th class="tc-hide-sm">Note</th></tr></thead><tbody>' +
          trips.map((t) => '<tr class="tc-row" data-trip="' + esc(t.id) + '"><td style="white-space:nowrap">' + esc(T.fmtDay(t.day)) + "</td>" + (all ? "<td>" + esc(T.shortName(t.name)) + "</td>" : "") +
            "<td>" + esc(t.job_title || t.note) + (t.location ? '<span class="s" style="display:block;color:var(--muted);font-size:12px">' + esc(t.location) + "</span>" : "") + "</td>" +
            '<td class="tc-num">' + (t.miles != null ? mi(t.miles) + (t.auto ? "" : '<span class="tc-tag ok" title="Typed in">typed</span>') : t.est_miles != null ? mi(t.est_miles) + '<span class="tc-tag">est.</span>'
              : '<span class="tc-tag" title="' + esc(lookupErr[t.booking_id] || "") + '">' + (lookupErr[t.booking_id] ? "no distance" : "looking up\u2026") + "</span>") + (t.locked ? ' <span class="pill ok" title="Week approved"></span>' : "") + "</td>" +
            '<td class="tc-hide-sm">' + (t.job_title ? esc(t.note) : "") + "</td></tr>").join("") + "</tbody></table></div>" : "");
    }
    milesRoot.addEventListener("click", async (ev) => {
      const tr = ev.target.closest("[data-trip]");
      if (tr) return openTrip(ml.trips.find((t) => t.id === tr.dataset.trip));
      const b = ev.target.closest("[data-v]"); if (!b) return;
      const v = b.dataset.v;
      if (v === "prev") month = addMonths(month, -1);
      else if (v === "next") month = addMonths(month, 1);
      else if (v === "this") month = monthStart(T.today());
      else if (v === "add") return openTrip(null);
      else if (v === "csv") return milesCsv();
      else if (v === "sched") {
        b.disabled = true;
        try {
          const { data, error } = await sb.rpc("mileage_from_schedule", { p_month: month, p_all: miWho === "all" });
          if (error) throw error;
          toast(data && data.added ? "Added " + data.added + " trip" + (data.added === 1 ? "" : "s") + " from the schedule." : "Every job on the schedule this month already has a trip.");
        } catch (e) { toast(cleanErr(e), true); }
        b.disabled = false;
      }
      loadMiles();
    });
    el("miWho").addEventListener("change", () => { miWho = el("miWho").value; loadMiles(); });

    function milesCsv() {
      const rate = num(ml.mileage_rate);
      download("207-mileage-" + month.slice(0, 7) + ".csv", [["Date", "Name", "Job or where", "Address", "Miles", "Amount", "Note", "Source"]]
        .concat(ml.trips.map((t) => { const m = t.miles != null ? num(t.miles) : t.est_miles != null ? num(t.est_miles) : null;
          return [t.day, t.name, t.job_title || t.note, t.location || "", m == null ? "" : m.toFixed(1), m == null ? "" : (m * rate).toFixed(2), t.job_title ? t.note : "", t.miles == null ? (m == null ? "missing" : "estimate") : t.auto ? "Google (round trip)" : "typed"]; })));
    }

    function openTrip(t) {
      const isNew = !t;
      if (t && t.locked) { toast("That week is approved. " + (ml.can_edit ? "Unapprove it on Timesheets to change it." : "Ask a manager to change it."), true); return; }
      if (t && t.user_id !== ml.me && !ml.can_edit) return;
      const jobs = ml.jobs || [];
      const m = openModal('<div class="tc-modal"><h2>' + (isNew ? "Add a trip" : "Change trip") + "</h2>" +
        (isNew && ml.can_edit && people.length ? '<div class="field"><label for="aca-mtP">Person</label><select id="aca-mtP">' + people.map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === ml.me ? " selected" : "") + ">" + esc(p.name) + "</option>").join("") + "</select></div>" : "") +
        '<div class="field"><label for="aca-mtB">Job</label><select id="aca-mtB"><option value="">No job (say where in the note)</option>' +
          jobs.map((j) => '<option value="' + esc(j.booking_id) + '" data-day="' + esc(j.day) + '"' + (t && t.booking_id === j.booking_id && t.day === j.day ? " selected" : "") + ">" + esc(T.fmtDay(j.day) + " \u00b7 " + j.title) + "</option>").join("") +
          (t && t.booking_id && !jobs.some((j) => j.booking_id === t.booking_id && j.day === t.day) ? '<option value="' + esc(t.booking_id) + '" selected>' + esc(t.job_title) + "</option>" : "") + "</select></div>" +
        '<div class="row2"><div class="field"><label for="aca-mtD">Day</label><input type="date" id="aca-mtD" value="' + esc(t ? t.day : T.today() < addMonths(month, 1) && T.today() >= month ? T.today() : month) + '" /></div>' +
          '<div class="field"><label for="aca-mtM">Miles</label><input type="number" id="aca-mtM" min="0" max="2000" step="0.1" value="' + esc(t ? (t.miles != null ? t.miles : t.est_miles != null ? t.est_miles : "") : "") + '" /></div></div>' +
        '<div class="field"><label for="aca-mtN">Note</label><input type="text" id="aca-mtN" maxlength="300" placeholder="Staples for paper, rode with Sam\u2026" value="' + esc(t ? t.note : "") + '" /></div>' +
        '<div class="inline-error hidden tc-merr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" data-m="remove">Remove</button>') + '<span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">' + (isNew ? "Add" : "Save") + "</button></div></div>");
      const mErr = mErrIn(m);
      el("mtB").addEventListener("change", () => { const o = el("mtB").selectedOptions[0]; if (o && o.dataset.day) el("mtD").value = o.dataset.day; });
      m.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "cancel") return m.close();
        if (b.dataset.m === "remove") {
          if (!confirm("Remove this trip?")) return;
          b.disabled = true;
          try { const { error } = await sb.rpc("mileage_remove", { p_id: t.id }); if (error) throw error; m.close(); toast("Removed."); loadMiles(true); }
          catch (e) { mErr(cleanErr(e)); b.disabled = false; }
          return;
        }
        const p = { id: t ? t.id : null, booking_id: el("mtB").value || null, day: el("mtD").value, miles: el("mtM").value, note: el("mtN").value.trim() };
        if (isNew && el("mtP")) p.user_id = el("mtP").value;
        if (!p.day) return mErr("Pick the day.");
        if (p.miles === "") return mErr("Enter the miles.");
        if (!p.booking_id && !p.note) return mErr("Say where you drove in the note.");
        b.disabled = true;
        try {
          const { error } = await sb.rpc("mileage_save", { p });
          if (error) throw error;
          m.close(); toast(isNew ? "Trip added." : "Saved.");
          if (monthStart(p.day) !== month) month = monthStart(p.day);
          loadMiles(true);
        } catch (e) { mErr(cleanErr(e)); b.disabled = false; }
      });
    }

    // ---------------------------------------------------------------- Today
    async function loadAttention() {
      if (!canSee("timeclock")) return;
      try {
        const { data, error } = await sb.rpc("timeclock_attention");
        if (error) throw error;
        setAttention("timeclockOpen", num(data.open_long), "", "timesheets");
        setAttention("timesheetsApprove", canEdit("timeclock") ? num(data.to_approve) : 0, "", "timesheets",
          null, () => { week = data.last_week; who = "all"; el("tsWho").value = "all"; loadWeek(); });
        setAttention("timeclockReview", num(data.review), "", "timesheets");
        setAttention("expensesWaiting", canEdit("timeclock") ? num(data.expenses) : 0, "", "expenses");
        setAttention("overtimeNear", canEdit("timeclock") ? num(data.near_ot) : 0, "", "timesheets",
          null, () => { week = T.weekStart(T.today()); who = "all"; el("tsWho").value = "all"; loadWeek(); });
      } catch (e) { ["timeclockOpen", "timesheetsApprove", "timeclockReview", "expensesWaiting", "overtimeNear"].forEach((k) => setAttention(k, 0)); }
    }
    // A clock card at the top of Today: clocked in to what (with Clock out), or a Clock in button.
    async function loadToday() {
      loadAttention();
      let box = el("todayClock");
      if (!box) {
        const mine = el("todayMine"); if (!mine) return;
        box = document.createElement("section"); box.id = "aca-todayClock"; box.className = "today-mine tc-today";
        mine.parentNode.insertBefore(box, mine);
        box.addEventListener("click", async (ev) => {
          const b = ev.target.closest("[data-tc]"); if (!b) return;
          if (b.dataset.tc === "in") { location.hash = "#staff/clock"; return; }
          b.disabled = true;
          try { const loc = await getLoc(); const { data, error } = await sb.rpc("timeclock_out", { p_note: "", p_loc: loc }); if (error) throw error; toast("Clocked out. " + hm(data && data.minutes) + "."); loadToday(); }
          catch (e) { b.disabled = false; toast(cleanErr(e), true); }
        });
      }
      try {
        const { data, error } = await sb.rpc("timeclock_status");
        if (error) throw error;
        const o = data.open;
        st = st || data;
        st.gps = data.gps;
        box.innerHTML = '<h2>Time clock <span class="c">' + (o ? "clocked in" : "clocked out") + '</span><a href="#staff/clock">Clock</a></h2>' +
          (o ? "<p>" + esc(what(o)) + " since " + esc(T.fmtTs(o.clock_in)) + " (" + hm(since(o.clock_in)) + ")</p>" : "<p>" + esc(data.jobs && data.jobs.some((j) => j.mine) ? "You have a job today. Clock in when you start." : hm(data.week_worked_min) + " worked this week.") + "</p>") +
          '<div class="tc-tbtn">' + (o ? '<button type="button" class="primary" data-tc="out">Clock out</button><button type="button" class="small" data-tc="in">Switch</button>' : '<button type="button" class="primary" data-tc="in">Clock in</button>') + "</div>";
      } catch (e) { box.innerHTML = ""; }
    }

    return { loadClock, loadWeek, loadMiles, loadToday, loadAttention, download, hm, money, people: async () => { if (canEdit("timeclock")) await loadPeople(); return people; } };
  })();
