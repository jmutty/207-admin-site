  // ================================================================ STAFF: Schedule (bar scheduler, 2026-10-22)
  // One row per person, weeks start on Sunday, the week's bookings across the top. Bars come from
  // schedule_entries: job (a person on a booking, with drive time before/after in its own color), work (any
  // other time) and off (time off). Scheduled hours are compared with each person's default hours per week
  // (Team page). View = see the team's week; Edit = add, change and remove bars. Drive times come from the
  // drive-time edge function (Google Maps, from the studio address). Everything goes through RPCs:
  // schedule_week / schedule_save / schedule_remove / schedule_settings_save / schedule_attention.
  registerPage({ id: "schedule", group: "Staff", section: "staff", module: "scheduling", tabs: [["schedule", "Schedule"]], onShow: () => Schedule.load() });
  registerAttention("scheduleUnstaffed", { module: "scheduling", level: "soon", name: "job staffing",
    one: "A job in the next two weeks has nobody on the schedule.", many: "{n} jobs in the next two weeks have nobody on the schedule." });
  registerTodayLoader("scheduling", () => Schedule.loadAttention());

  // Dates and times in Eastern time, shared with assignments.js. Days are "YYYY-MM-DD" strings.
  const StaffTime = (function () {
    const TZ = "America/New_York";
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    // {day, min}: the Eastern calendar day and minutes after midnight of a timestamp
    function local(ts) {
      const p = {}; parts.formatToParts(new Date(ts)).forEach((x) => { p[x.type] = x.value; });
      return { day: p.year + "-" + p.month + "-" + p.day, min: (+p.hour % 24) * 60 + +p.minute };
    }
    const today = () => local(Date.now()).day;
    const addDays = (day, n) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const dow = (day) => new Date(day + "T12:00:00Z").getUTCDay();
    const weekStart = (day) => addDays(day, -dow(day));
    const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5);
    // Eastern day + "HH:MM" -> ISO timestamp (handles daylight saving)
    function toIso(day, hhmm) {
      const [y, m, d] = day.split("-").map(Number), [h, mi] = (hhmm || "00:00").split(":").map(Number);
      let t = Date.UTC(y, m - 1, d, h, mi);
      for (let i = 0; i < 2; i++) { const l = local(t); t = Date.UTC(y, m - 1, d, h, mi) - ((Date.UTC(+l.day.slice(0, 4), +l.day.slice(5, 7) - 1, +l.day.slice(8, 10)) + l.min * 6e4) - t); }
      return new Date(t).toISOString();
    }
    const hhmm = (min) => String(Math.floor(min / 60) % 24).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
    function fmtMin(min) {
      const h = Math.floor(min / 60) % 24, m = min % 60;
      return (h % 12 || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + (h < 12 ? "am" : "pm");
    }
    const fmtTs = (ts) => fmtMin(local(ts).min);
    const fmtDay = (day, o) => new Date(day + "T12:00:00Z").toLocaleDateString("en-US", Object.assign({ timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }, o || {}));
    const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    // Hours scheduled on one Eastern day: jobs with their drive time, and work; time off doesn't count.
    function workHours(entries, day) {
      const a = new Date(toIso(day, "00:00")).getTime(), z = new Date(toIso(addDays(day, 1), "00:00")).getTime();
      return entries.reduce((sum, e) => {
        if (e.kind === "off") return sum;
        const s = new Date(e.starts_at).getTime() - (e.drive_before_min || 0) * 6e4, en = new Date(e.ends_at).getTime() + (e.drive_after_min || 0) * 6e4;
        return sum + Math.max(0, Math.min(en, z) - Math.max(s, a)) / 36e5;
      }, 0);
    }
    const LUNCH_AFTER_H = 6; // a day this long needs a lunch break
    return { TZ, local, today, addDays, dow, weekStart, daysBetween, toIso, hhmm, fmtMin, fmtTs, fmtDay, WEEKDAYS, workHours, LUNCH_AFTER_H };
  })();

  const Schedule = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const DRIVE_FN_URL = SUPABASE_URL + "/functions/v1/drive-time";
    const KIND = { job: "On site job", studio: "Studio", admin: "Admin", flex: "Flex", work: "Other", off: "Time off" };
    const KINDS = ["job", "studio", "admin", "flex", "work", "off"];

    const css = `
    .aca .sc-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 0 12px; }
    .aca .sc-bar h2 { margin: 0 8px 0 4px; font-size: 17px; font-weight: 600; white-space: nowrap; }
    .aca .sc-bar .grow { flex: 1; }
    .aca .sc-legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }
    .aca .sc-legend i { display: inline-block; width: 14px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
    .aca .sc-k-job { background: #2f6db5; color: #fff; }
    .aca .sc-k-drive { background: #f0b429; color: #3d2c00; }
    .aca .sc-k-studio { background: #7b5cc4; color: #fff; }
    .aca .sc-k-admin { background: #3f8f5a; color: #fff; }
    .aca .sc-k-flex { background: #1f8a84 repeating-linear-gradient(135deg, rgba(255,255,255,.16) 0 5px, transparent 5px 10px); color: #fff; }
    .aca .sc-k-work { background: #6b7a8f; color: #fff; }
    .aca .sc-k-gcal { background: var(--surface); border: 1px solid #8a8580; border-left-width: 3px; }
    .aca .sc-k-off { background: repeating-linear-gradient(135deg, #d9d4cb 0 6px, #ece8e1 6px 12px); color: #4a463f; }
    .aca .sc-warn { margin: 0 0 10px; padding: 9px 12px; border-radius: 4px; background: var(--warn-bg); color: var(--warn-fg); font-size: 13px; }
    .aca .sc-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); }
    .aca .sc-grid { display: grid; grid-template-columns: 170px repeat(var(--cols), minmax(var(--colmin), 1fr)); min-width: calc(170px + var(--cols) * var(--colmin)); }
    .aca .sc-grid > div { border-bottom: 1px solid var(--line2); border-left: 1px solid var(--line2); min-width: 0; }
    .aca .sc-name { position: sticky; left: 0; z-index: 3; background: var(--surface); border-left: 0 !important; padding: 8px 10px; font-size: 13px; }
    .aca .sc-name b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .aca .sc-name .sc-hrs { font-size: 12px; color: var(--muted); }
    .aca .sc-hrs .over { color: var(--accent); font-weight: 600; } .aca .sc-hrs .under { color: var(--muted); } .aca .sc-hrs .on { color: var(--ok-fg); font-weight: 600; }
    .aca .sc-head { padding: 6px 8px; font-size: 12.5px; font-weight: 600; background: var(--surface-2); position: relative; }
    .aca .sc-head.today { color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }
    .aca .sc-head button.link { font-weight: 600; font-size: 12.5px; padding: 0; height: auto; }
    .aca .sc-ticks { position: relative; height: 14px; margin: 2px -8px 0; font-weight: 400; color: var(--faint); font-size: 11px; }
    .aca .sc-ticks span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
    .aca .sc-jobs { padding: 6px; display: flex; flex-direction: column; gap: 4px; background: var(--surface-2); }
    .aca .sc-chip { display: block; width: 100%; text-align: left; border: 1px solid var(--border); border-left: 3px solid #2f6db5; background: var(--surface); border-radius: 3px; padding: 3px 6px; font-size: 12px; line-height: 16px; height: auto; white-space: normal; cursor: pointer; color: var(--text); }
    .aca .sc-chip.none { border-left-color: var(--accent); }
    .aca .sc-chip small { display: block; color: var(--muted); font-size: 11.5px; }
    .aca .sc-chip.none small::after { content: " \\00b7  nobody on it"; color: var(--accent); font-weight: 600; }
    .aca .sc-chip.tracked { border-left-color: var(--faint); opacity: .8; }
    .aca .sc-chip.gcal { border-left-color: #8a8580; }
    .aca .sc-cell { position: relative; min-height: 46px; cursor: default; }
    .aca .sc-cell.edit { cursor: copy; }
    .aca .sc-cell.today { background: #fffaf4; }
    .aca .sc-cell.grid { background-image: repeating-linear-gradient(90deg, transparent 0, transparent calc(100% / var(--hours) - 1px), var(--line2) calc(100% / var(--hours) - 1px), var(--line2) calc(100% / var(--hours))); }
    .aca .sc-b { position: absolute; height: 22px; border-radius: 3px; font-size: 11.5px; line-height: 22px; padding: 0 5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; border: 0; box-sizing: border-box; min-width: 4px; }
    .aca .sc-b.drive { border-radius: 0; padding: 0; }
    .aca .sc-b.drive.first { border-radius: 3px 0 0 3px; } .aca .sc-b.drive.last { border-radius: 0 3px 3px 0; }
    .aca .sc-b.job.mid { border-radius: 0; }
    .aca .sc-b.clash { box-shadow: 0 0 0 2px var(--err-fg); }
    .aca .sc-b.cancelled { text-decoration: line-through; opacity: .6; }
    .aca .sc-b:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .aca .sc-tasks { position: absolute; right: 4px; bottom: 2px; font-size: 11px; color: var(--muted); }
    .aca .sc-modal .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .aca .sc-modal .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
    .aca .sc-modal .field input, .aca .sc-modal .field select, .aca .sc-modal .field textarea { width: 100%; }
    .aca .sc-modal textarea { height: 60px; padding: 6px 10px; }
    .aca .sc-modal .sc-drive { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
    .aca .sc-modal .sc-drive .field { margin-bottom: 0; }
    .aca .sc-modal .sc-drive input { width: 90px; }
    .aca .sc-people label { display: flex; gap: 8px; align-items: center; justify-content: flex-start; padding: 4px 0; font-size: 13.5px; font-weight: 400; }
    .aca .sc-modal .sc-people input { width: 18px; height: 18px; flex: none; margin: 0; }
    .aca .sc-dh { position: absolute; left: 5px; bottom: 2px; font-size: 11px; color: var(--muted); }
    .aca .sc-lunch { color: #8a6100; font-weight: 600; }
    .aca .sc-sum { margin-top: 18px; }
    .aca .sc-sum h3 { margin: 0 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .aca .sc-sum table { min-width: 640px; }
    .aca .sc-sum td, .aca .sc-sum th { padding: 7px 10px; font-size: 13px; text-align: right; white-space: nowrap; }
    .aca .sc-sum td:first-child, .aca .sc-sum th:first-child { text-align: left; }
    .aca .sc-sum td.lunch { background: #fdf6e3; }
    .aca .sc-sum .muted { color: var(--faint); }
    .aca .sc-note { font-size: 12.5px; color: var(--muted); margin: 6px 0 12px; }
    .aca .sc-facts { font-size: 13.5px; line-height: 21px; margin: 0 0 8px; }
    .aca .sc-keybtn { display: none; }
    .aca .sc-help { font-size: 12.5px; color: var(--muted); margin: 10px 0 12px; }
    .aca .sc-help summary { cursor: pointer; font-weight: 600; }
    .aca .sc-help p { margin: 6px 0 0; line-height: 19px; }
    @media (max-width: 760px) {
      .aca .sc-bar { gap: 6px; }
      .aca .sc-bar h2 { order: -1; flex: 1 0 100%; margin: 0 0 2px; font-size: 16px; }
      .aca .sc-bar .grow { display: none; }
      .aca .sc-legend { display: none; order: 10; flex: 1 0 100%; gap: 6px 12px; font-size: 12px; padding: 4px 0; }
      .aca .sc-showkey .sc-legend { display: flex; }
      .aca .sc-keybtn { display: inline-block; }
      .aca .sc-bar button[data-v="studio"] { display: none; }
      .aca .sc-bar .primary { margin-left: auto; }
      .aca .sc-grid { grid-template-columns: 92px repeat(var(--cols), minmax(var(--colmin), 1fr)); min-width: calc(92px + var(--cols) * var(--colmin)); }
      .aca .sc-name { padding: 6px 7px; font-size: 12.5px; }
      .aca .sc-name b { white-space: normal; overflow-wrap: anywhere; line-height: 16px; }
      .aca .sc-name .sc-hrs { font-size: 11px; line-height: 15px; display: block; margin-top: 2px; }
      .aca .sc-name .sc-hint { display: none; }
      .aca .sc-modal .row2 { grid-template-columns: 1fr; }
      .aca .sc-modal .row3 { grid-template-columns: 1fr 1fr; }
      .aca .sc-modal .row3 > :first-child { grid-column: 1 / -1; }
      .aca .sc-modal .seg { display: grid; grid-template-columns: repeat(3, 1fr); width: 100%; }
      .aca .sc-modal .seg span { text-align: center; padding: 8px 4px; border-top: 1px solid var(--border); margin-top: -1px; white-space: nowrap; }
      .aca .sc-modal .seg label:nth-child(3n+1) span { border-left: 0; }
      .aca .sc-b { height: 28px; line-height: 28px; }
      .aca .sc-sum table { min-width: 0; width: 100%; }
    }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    const root = el("panel-schedule");
    root.innerHTML =
      '<div class="sc-bar">' +
        '<button type="button" class="small" data-v="prev" aria-label="Earlier">&lsaquo;</button><button type="button" class="small" data-v="today">Today</button><button type="button" class="small" data-v="next" aria-label="Later">&rsaquo;</button>' +
        '<h2 id="aca-scTitle">Schedule</h2>' +
        '<div class="seg" role="radiogroup" aria-label="View"><label><input type="radio" name="aca-scView" value="week" checked /><span>Week</span></label><label><input type="radio" name="aca-scView" value="day" /><span>Day</span></label></div>' +
        '<label class="muted" style="font-size:13px;display:flex;gap:6px;align-items:center"><input type="checkbox" id="aca-scMine" /> Just me</label>' +
        '<span class="grow"></span>' +
        '<button type="button" class="small sc-keybtn" data-v="key" aria-expanded="false">Colors</button>' +
        '<div class="sc-legend"><span><i class="sc-k-job"></i>On site job</span><span><i class="sc-k-drive"></i>Drive</span><span><i class="sc-k-studio"></i>Studio</span><span><i class="sc-k-admin"></i>Admin</span><span><i class="sc-k-flex"></i>Flex</span><span><i class="sc-k-work"></i>Other</span><span><i class="sc-k-off"></i>Time off</span><span><i class="sc-k-gcal"></i>Google Calendar</span></div>' +
        '<button type="button" class="small sc-ed" data-v="studio">Studio address</button>' +
        '<button type="button" class="primary sc-ed" data-v="add">Add time</button>' +
        '<button type="button" class="primary sc-flexbtn hidden" data-v="addflex">Add flex time</button>' +
      "</div>" +
      '<div id="aca-scErr" class="inline-error hidden"></div>' +
      '<div id="aca-scWarn" class="sc-warn hidden"></div>' +
      '<div class="sc-scroll"><div id="aca-scGrid"><p class="empty" style="padding:16px">Loading&#8230;</p></div></div>' +
      '<div class="sc-sum hidden" id="aca-scSum"></div>' +
      '<details class="sc-help"><summary>How the schedule works</summary><p>Weeks run Sunday to Saturday. Hours count jobs, drive time and work, not time off, against each person&#39;s default hours per week (set on the Team page). A day of 6 hours or more is marked &#8220;lunch&#8221;: plan a lunch break. <span class="sc-ed">Click an empty spot to add time; click a job under Jobs not assigned to put people on it. To add someone to a job that already has people, click its blue bar and choose More people.</span> Flex time is for work that isn&#39;t tied to a set hour: everyone can add and move their own. Events on the Google Calendar that aren&#39;t bookings show under From Google Calendar, and ones named like &#8220;Ryan Off&#8221; show as that person&#39;s time off.</p></details>';

    const narrow = () => window.innerWidth < 760;
    let view = narrow() ? "day" : "week";
    let anchor = T.today();       // the day shown in day view; its week in week view
    let data = null, mineOnly = false, loading = 0;
    root.querySelector('input[name="aca-scView"][value="' + view + '"]').checked = true;

    const editable = () => !!(data && data.can_edit);
    // Without Scheduling edit you can still add, move and remove your own flex time.
    const isMine = (id) => !!(data && data.me && id === data.me);
    const canChange = (e) => !e.gcal && (editable() || (e.kind === "flex" && isMine(e.user_id)));
    const personName = (id) => { const p = data && data.people.find((x) => x.user_id === id); return p ? p.name : "Someone"; };
    const bookingLabel = (b) => b.title + (b.day_label ? " (" + b.day_label + ")" : "");
    const shortTitle = (s) => String(s || "").split(" \u2022 ")[0];

    async function load() {
      const my = ++loading;
      clearError("scErr");
      const start = T.weekStart(anchor);
      try {
        const { data: d, error } = await sb.rpc("schedule_week", { p_start: start, p_days: 7 });
        if (error) throw error;
        if (my !== loading) return;
        data = d; data.start = start;
        // "Ryan Off" on the Google Calendar: time off on that person's row (read only; change it in Google)
        (d.calendar || []).filter((c) => c.off_user).forEach((c) => d.entries.push({ id: "gcal:" + c.event_id, user_id: c.off_user, kind: "off", booking_id: null,
          starts_at: c.all_day || !c.start_at ? T.toIso(c.start_date, "00:00") : c.start_at, ends_at: c.all_day || !c.end_at ? T.toIso(T.addDays(c.end_date, 1), "00:00") : c.end_at,
          drive_before_min: 0, drive_after_min: 0, title: c.summary, note: "", gcal: c }));
        render();
      } catch (e) {
        if (my !== loading) return;
        showError("scErr", "Could not load the schedule: " + cleanErr(e));
      }
    }

    async function loadAttention() {
      try {
        const { data: d, error } = await sb.rpc("schedule_attention");
        if (error) throw error;
        setAttention("scheduleUnstaffed", num(d && d.unstaffed), "Jobs with nobody scheduled", "schedule");
      } catch (_e) { /* Today reports it as unchecked */ }
    }

    // ---------------------------------------------------------------- layout math
    // Per day: the bar pieces of every entry that touches it, in Eastern minutes.
    function piecesOn(e, day) {
      const s = new Date(e.starts_at).getTime(), en = new Date(e.ends_at).getTime();
      const segs = e.kind === "job"
        ? [["drive", s - e.drive_before_min * 6e4, s], ["job", s, en], ["drive", en, en + e.drive_after_min * 6e4]]
        : [[e.kind, s, en]];
      const dayStart = new Date(T.toIso(day, "00:00")).getTime(), dayEnd = new Date(T.toIso(T.addDays(day, 1), "00:00")).getTime();
      return segs.filter((g) => g[2] > g[1] && g[1] < dayEnd && g[2] > dayStart).map((g) => ({
        part: g[0], from: Math.max(0, Math.round((Math.max(g[1], dayStart) - dayStart) / 6e4)), to: Math.min(1440, Math.round((Math.min(g[2], dayEnd) - dayStart) / 6e4)),
      }));
    }
    const hoursOf = (e) => e.kind === "off" ? 0 : (new Date(e.ends_at) - new Date(e.starts_at)) / 36e5 + (e.drive_before_min + e.drive_after_min) / 60;
    const fmtH = (h) => (Math.round(h * 4) / 4).toString().replace(/\.0+$/, "");

    // The hours shown: 7am-7pm, stretched to fit anything earlier or later.
    function windowFor(days) {
      let lo = 7 * 60, hi = 19 * 60;
      data.entries.forEach((e) => days.forEach((d) => piecesOn(e, d).forEach((p) => { if (!(p.from === 0 && p.to === 1440)) { lo = Math.min(lo, p.from); hi = Math.max(hi, p.to); } })));
      data.bookings.forEach((b) => { if (b.start_at && days.includes(b.day)) { lo = Math.min(lo, T.local(b.start_at).min); hi = Math.max(hi, T.local(b.end_at || b.start_at).min); } });
      lo = Math.max(0, Math.floor(lo / 60) * 60); hi = Math.min(1440, Math.ceil(hi / 60) * 60);
      if (hi - lo < 240) hi = Math.min(1440, lo + 240);
      return { lo, hi };
    }

    // Stack overlapping bars in lanes. Returns lanes count; sets p.lane and marks clashes for the same person.
    function lanesFor(items) {
      const ends = [];
      items.sort((a, b) => a.from - b.from || b.to - a.to);
      items.forEach((it) => {
        let lane = ends.findIndex((x) => x <= it.from);
        if (lane < 0) { lane = ends.length; ends.push(0); }
        ends[lane] = it.to; it.lane = lane;
      });
      items.forEach((a) => { a.clash = items.some((b) => b !== a && b.entry !== a.entry && b.from < a.to && b.to > a.from); });
      return Math.max(1, ends.length);
    }

    // ---------------------------------------------------------------- render
    function render() {
      const start = data.start, today = T.today();
      const days = view === "week" ? [0, 1, 2, 3, 4, 5, 6].map((i) => T.addDays(start, i)) : [anchor];
      const sameMonth = view === "week" && days[0].slice(0, 7) === days[6].slice(0, 7);
      el("scTitle").textContent = view === "week"
        ? T.fmtDay(days[0], { weekday: undefined }) + " \u2013 " + (sameMonth ? +days[6].slice(8) : T.fmtDay(days[6], { weekday: undefined })) + ", " + days[6].slice(0, 4)
        : T.fmtDay(anchor, { weekday: "long", year: "numeric" });
      root.querySelectorAll(".sc-ed").forEach((n) => n.classList.toggle("hidden", !editable()));
      root.querySelector(".sc-flexbtn").classList.toggle("hidden", editable() || !data.people.some((p) => isMine(p.user_id)));
      const warn = el("scWarn");
      warn.classList.toggle("hidden", !(editable() && !data.studio_address));
      warn.innerHTML = 'Add the studio address so drive times can be looked up from Google Maps. <button type="button" class="link" data-v="studio">Add it</button>';

      const win = windowFor(days), span = win.hi - win.lo, hours = span / 60;
      const pct = (m) => ((Math.min(Math.max(m, win.lo), win.hi) - win.lo) / span * 100).toFixed(3) + "%";
      const ticks = () => { let h = ""; for (let m = win.lo; m <= win.hi; m += view === "day" ? (narrow() ? 120 : 60) : 360) if (m > win.lo && m < win.hi) h += '<span style="left:' + pct(m) + '">' + T.fmtMin(m) + "</span>"; return h; };
      const grid = el("scGrid");
      grid.className = "sc-grid";
      grid.style.setProperty("--cols", days.length);
      grid.style.setProperty("--colmin", view === "week" ? "118px" : narrow() ? "0px" : "640px");
      grid.style.setProperty("--hours", hours);

      let h = '<div class="sc-head sc-name">' + (view === "week" ? "Team" : "") + "</div>";
      days.forEach((d) => {
        h += '<div class="sc-head' + (d === today ? " today" : "") + '">' + (view === "week" ? '<button type="button" class="link" data-day="' + d + '">' + esc(T.fmtDay(d)) + "</button>" : esc(T.fmtDay(d, { weekday: "long" }))) +
          '<div class="sc-ticks">' + ticks() + "</div></div>";
      });
      // Jobs not assigned: a job leaves this lane once someone is on it that day (its bar is then on their row).
      const staffedOn = (b, d) => data.entries.some((e) => e.booking_id === b.booking_id && T.local(e.starts_at).day <= d && T.local(e.ends_at).day >= d);
      const open = data.bookings.filter((b) => days.includes(b.day) && !staffedOn(b, b.day));
      h += '<div class="sc-name"><b>Jobs not assigned</b><span class="sc-hrs">' + (open.length ? num(open.length) + " this " + (view === "week" ? "week" : "day") : "All jobs have someone") + "</span></div>";
      days.forEach((d) => {
        const list = open.filter((b) => b.day === d);
        h += '<div class="sc-jobs">' + list.map((b) =>
          '<button type="button" class="sc-chip' + (b.status === "tracked" ? " tracked" : b.status === "booked" ? " none" : "") + '" data-booking="' + esc(b.booking_id) + '" data-day="' + esc(d) + '" title="' + esc(bookingLabel(b) + (b.location ? "\n" + b.location : "")) + '">' +
            esc(view === "week" ? shortTitle(b.title) : bookingLabel(b)) + "<small>" + esc(b.start_at ? T.fmtTs(b.start_at) + (b.end_at ? "\u2013" + T.fmtTs(b.end_at) : "") : "time not set yet") + "</small></button>").join("") + "</div>";
      });
      // From Google Calendar: events that aren't bookings, until someone is on them ("X Off" ones are time off instead)
      const calOpen = (data.calendar || []).filter((c) => !c.off_user && !data.entries.some((e) => e.gcal_event_id === c.event_id) && days.some((d) => d >= c.start_date && d <= c.end_date));
      if (calOpen.length) {
        h += '<div class="sc-name"><b>From Google Calendar</b><span class="sc-hrs sc-hint">Not bookings' + (editable() ? "; click one to put people on it" : "") + "</span></div>";
        days.forEach((d) => {
          h += '<div class="sc-jobs">' + calOpen.filter((c) => d >= c.start_date && d <= c.end_date).map((c) =>
            '<button type="button" class="sc-chip gcal" data-gcal="' + esc(c.event_id) + '" data-day="' + esc(d) + '" title="' + esc(c.summary) + '">' + esc(c.summary) +
            "<small>" + esc(c.all_day || !c.start_at ? "all day" : T.fmtTs(c.start_at) + "\u2013" + T.fmtTs(c.end_at)) + "</small></button>").join("") + "</div>";
        });
      }
      // People
      const people = mineOnly ? data.people.filter((p) => p.user_id === data.me) : data.people;
      if (!people.length) h += '<div class="sc-name"><span class="muted">' + (mineOnly ? "You are not on the team list." : "Nobody on the team yet.") + "</span></div>" + days.map(() => "<div></div>").join("");
      people.forEach((p) => {
        const mine = data.entries.filter((e) => e.user_id === p.user_id);
        const weekHours = mine.reduce((s, e) => s + hoursOf(e), 0);
        let target = "";
        if (p.weekly_hours != null) {
          const diff = weekHours - Number(p.weekly_hours);
          target = " / " + fmtH(Number(p.weekly_hours)) + " h " + (Math.abs(diff) < 0.25 ? '<span class="on">on target</span>' : diff > 0 ? '<span class="over">' + fmtH(diff) + " over</span>" : '<span class="under">' + fmtH(-diff) + " under</span>");
        } else target = " h";
        const dayHours = view === "day" ? T.workHours(mine, anchor) : null;
        h += '<div class="sc-name"><b title="' + esc(p.name) + '">' + esc(p.name) + "</b><span class=\"sc-hrs\">" +
          (view === "day" ? fmtH(dayHours) + " h this day" + (dayHours >= T.LUNCH_AFTER_H ? ' <span class="sc-lunch" title="6 hours or more: plan a lunch break">&middot; lunch</span>' : "") + (narrow() ? "" : " &middot; ") : "") +
          (view === "day" && narrow() ? "" : fmtH(weekHours) + target + (view === "day" ? " this week" : "")) + "</span></div>";
        days.forEach((d) => {
          const items = [];
          mine.forEach((e) => {
            const ps = piecesOn(e, d);
            ps.forEach((x, i) => items.push(Object.assign(x, { entry: e, first: i === 0, last: i === ps.length - 1 })));
          });
          // lanes per entry (its pieces share a lane)
          const blocks = [];
          mine.forEach((e) => { const ps = items.filter((x) => x.entry === e); if (ps.length) blocks.push({ entry: e, from: Math.min(...ps.map((x) => x.from)), to: Math.max(...ps.map((x) => x.to)), ps }); });
          const n = lanesFor(blocks);
          const tc = (data.tasks || []).find((t) => t.user_id === p.user_id && t.day === d);
          const dh = view === "week" ? T.workHours(mine, d) : 0;
          let bars = "";
          blocks.forEach((bk) => bk.ps.forEach((x) => {
            const e = bk.entry, isDrive = x.part === "drive";
            const label = isDrive ? "" : e.kind === "job" ? (view === "week" ? shortTitle(e.booking_title) : e.booking_title) : e.kind !== "off" ? (e.title || KIND[e.kind]) : "Off" + (e.title ? ": " + e.title : "");
            const tip = (e.kind === "off" ? "Time off" : T.fmtTs(e.starts_at) + "\u2013" + T.fmtTs(e.ends_at)) + " " + (e.kind === "job" ? e.booking_title : e.kind !== "off" ? (e.title || KIND[e.kind]) : e.title) +
              (e.kind === "job" && (e.drive_before_min || e.drive_after_min) ? "\nDrive " + e.drive_before_min + " min there, " + e.drive_after_min + " min back" : "") + (e.note ? "\n" + e.note : "") + (bk.clash ? "\nOverlaps another bar" : "");
            const cls = "sc-b sc-k-" + (isDrive ? "drive" : e.kind) + (isDrive ? " drive" + (x.first ? " first" : "") + (x.last ? " last" : "") : "") +
              (e.kind === "job" && !isDrive && (bk.ps.length > 1) ? " mid" : "") + (bk.clash ? " clash" : "") + (e.booking_status === "cancelled" ? " cancelled" : "");
            bars += '<button type="button" class="' + cls + '" data-entry="' + esc(e.id) + '" style="left:' + pct(x.from) + ";width:calc(" + pct(x.to) + " - " + pct(x.from) + ");top:" + (6 + bk.lane * 26) + 'px" title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' + esc(label) + "</button>";
          }));
          h += '<div class="sc-cell' + (editable() || isMine(p.user_id) ? " edit" : "") + (view === "day" ? " grid" : "") + (d === today && view === "week" ? " today" : "") + '" data-person="' + esc(p.user_id) + '" data-day="' + esc(d) + '" style="min-height:' + (n * 26 + 18) + 'px">' + bars +
            (dh > 0 ? '<span class="sc-dh' + (dh >= T.LUNCH_AFTER_H ? " sc-lunch" : "") + '"' + (dh >= T.LUNCH_AFTER_H ? ' title="6 hours or more: plan a lunch break"' : "") + ">" + fmtH(dh) + " h" + (dh >= T.LUNCH_AFTER_H ? " &middot; lunch" : "") + "</span>" : "") +
            (tc ? '<a class="sc-tasks" href="#staff/myday" title="Tasks due">' + num(tc.n) + " task" + (tc.n === 1 ? "" : "s") + "</a>" : "") + "</div>";
        });
      });
      grid.innerHTML = h;
      renderSummary(people);
    }

    // Hours per person per day, and the week against their target.
    function renderSummary(people) {
      const box = el("scSum"), all = [0, 1, 2, 3, 4, 5, 6].map((i) => T.addDays(data.start, i));
      // Phones: just the day on screen (day view), then the week and target.
      const wk = narrow() ? (view === "day" ? [anchor] : []) : all;
      box.classList.toggle("hidden", !people.length);
      if (!people.length) return;
      box.innerHTML = "<h3>Hours scheduled</h3><div class=\"table-wrap\"><table><thead><tr><th>Person</th>" + wk.map((d) => "<th>" + esc(T.fmtDay(d, { month: undefined, day: undefined })) + " " + esc(String(+d.slice(8))) + "</th>").join("") + "<th>Week</th><th>Target</th></tr></thead><tbody>" +
        people.map((p) => {
          const mine = data.entries.filter((e) => e.user_id === p.user_id);
          const per = wk.map((d) => T.workHours(mine, d)), tot = all.reduce((a, d) => a + T.workHours(mine, d), 0);
          const tgt = p.weekly_hours == null ? null : Number(p.weekly_hours), diff = tgt == null ? 0 : tot - tgt;
          return "<tr><td><b>" + esc(p.name) + "</b></td>" + per.map((x) => x >= T.LUNCH_AFTER_H ? '<td class="lunch" title="6 hours or more: plan a lunch break">' + fmtH(x) + ' <span class="sc-lunch">lunch</span></td>' : "<td" + (x ? "" : ' class="muted"') + ">" + (x ? fmtH(x) : "&ndash;") + "</td>").join("") +
            "<td><b>" + fmtH(tot) + "</b></td><td>" + (tgt == null ? '<span class="muted">not set</span>' : fmtH(tgt) + " " + (Math.abs(diff) < 0.25 ? '<span class="sc-hrs"><span class="on">on target</span></span>' : '<span class="sc-hrs"><span class="' + (diff > 0 ? "over" : "under") + '">' + fmtH(Math.abs(diff)) + (diff > 0 ? " over" : " under") + "</span></span>")) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }

    // ---------------------------------------------------------------- events
    root.addEventListener("click", (e) => {
      const v = e.target.closest("[data-v]");
      if (v) {
        const a = v.dataset.v, step = view === "week" ? 7 : 1;
        if (a === "prev") { anchor = T.addDays(anchor, -step); load(); }
        if (a === "next") { anchor = T.addDays(anchor, step); load(); }
        if (a === "today") { anchor = T.today(); load(); }
        if (a === "addflex") openEntry(null, { user_id: data.me, kind: "flex", day: view === "day" ? anchor : T.today() >= data.start && T.today() < T.addDays(data.start, 7) ? T.today() : data.start });
        if (a === "add") openEntry(null, { user_id: data && data.me, day: view === "day" ? anchor : T.today() >= data.start && T.today() < T.addDays(data.start, 7) ? T.today() : data.start });
        if (a === "studio") openStudio();
        if (a === "key") v.setAttribute("aria-expanded", String(root.classList.toggle("sc-showkey")));
        return;
      }
      const dayBtn = e.target.closest(".sc-head [data-day]");
      if (dayBtn) { anchor = dayBtn.dataset.day; setView("day"); return; }
      const chip = e.target.closest("[data-booking]");
      if (chip) { const b = data.bookings.find((x) => x.booking_id === chip.dataset.booking && x.day === chip.dataset.day); if (b) editable() ? openAssign(b) : openBookingInfo(b); return; }
      const gc = e.target.closest("[data-gcal]");
      if (gc) {
        const c = (data.calendar || []).find((x) => x.event_id === gc.dataset.gcal); if (!c) return;
        const timed = !c.all_day && c.start_at && T.local(c.start_at).day === gc.dataset.day;
        if (editable()) openEntry(null, { user_id: data.me, day: gc.dataset.day, startMin: timed ? T.local(c.start_at).min : 9 * 60, endMin: timed ? T.local(c.end_at).min : 17 * 60, title: c.summary, gcal: c.event_id });
        else openCalInfo(c);
        return;
      }
      const bar = e.target.closest("[data-entry]");
      if (bar) { const en = data.entries.find((x) => x.id === bar.dataset.entry); if (en) en.gcal ? openCalInfo(en.gcal) : canChange(en) ? openEntry(en) : openInfo(en); return; }
      const cell = e.target.closest(".sc-cell");
      if (cell && (editable() || isMine(cell.dataset.person)) && !e.target.closest("a")) {
        // the clicked time, rounded to the half hour, becomes the start (in day view)
        let startMin = 9 * 60;
        if (view === "day") {
          const r = cell.getBoundingClientRect(), win = windowFor([anchor]);
          startMin = Math.round((win.lo + (e.clientX - r.left) / r.width * (win.hi - win.lo)) / 30) * 30;
        }
        openEntry(null, { user_id: cell.dataset.person, day: cell.dataset.day, startMin, kind: editable() ? null : "flex" });
      }
    });
    root.addEventListener("change", (e) => {
      if (e.target.name === "aca-scView") setView(e.target.value);
      if (e.target.id === "aca-scMine") { mineOnly = e.target.checked; if (data) render(); }
    });
    function setView(v) {
      view = v;
      root.querySelector('input[name="aca-scView"][value="' + v + '"]').checked = true;
      if (data && T.weekStart(anchor) === data.start) render(); else load();
    }

    // ---------------------------------------------------------------- drive time
    async function lookupDrive(bookingId) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Signed out.");
      const r = await fetch(DRIVE_FN_URL, { method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ booking_id: bookingId }) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "HTTP " + r.status);
      return j;
    }
    // Wires the drive inputs + "Look up" button inside a modal. getBooking() returns the picked booking id.
    function driveControls(m, getBooking, auto) {
      const msg = m.querySelector(".sc-drivemsg"), btn = m.querySelector('[data-m="drive"]');
      async function go() {
        const id = getBooking();
        if (!id) { msg.textContent = "Pick the job first."; return; }
        btn.disabled = true; msg.textContent = "Asking Google Maps\u2026";
        try {
          const r = await lookupDrive(id);
          const mins = Math.ceil(r.minutes / 5) * 5;
          m.querySelector(".sc-db").value = mins; m.querySelector(".sc-da").value = mins;
          msg.textContent = r.minutes + " min from the studio to " + r.destination + (r.meters ? " (" + (r.meters / 1609.34).toFixed(1) + " mi)" : "") + ". Rounded up to " + mins + ".";
        } catch (e) { msg.textContent = cleanErr(e); }
        finally { btn.disabled = false; }
      }
      btn.addEventListener("click", go);
      if (auto) go();
      return go;
    }
    const driveHtml = (db, da) =>
      '<div class="sc-drive"><div class="field"><label for="aca-scDb">Drive there (min)</label><input type="number" id="aca-scDb" class="sc-db" min="0" max="600" step="5" value="' + num(db) + '" /></div>' +
      '<div class="field"><label for="aca-scDa">Drive back (min)</label><input type="number" id="aca-scDa" class="sc-da" min="0" max="600" step="5" value="' + num(da) + '" /></div>' +
      '<button type="button" class="small" data-m="drive">Look up drive time</button></div><p class="sc-note sc-drivemsg"></p>';

    // ---------------------------------------------------------------- put people on a job
    // The booking day a job bar belongs to (bookings on screen this week).
    const jobOf = (e) => data.bookings.find((b) => b.booking_id === e.booking_id && b.day === T.local(e.starts_at).day);
    function openAssign(b) {
      const already = data.entries.filter((e) => e.booking_id === b.booking_id && T.local(e.starts_at).day === b.day);
      const s = b.start_at ? T.local(b.start_at).min : 9 * 60, en = b.end_at ? T.local(b.end_at).min : s + 120;
      const m = openModal('<div class="sc-modal"><h2>' + esc(bookingLabel(b)) + "</h2>" +
        '<p class="sc-facts">' + esc(T.fmtDay(b.day, { weekday: "long" })) + ", " + esc(b.start_at ? T.fmtTs(b.start_at) + "\u2013" + T.fmtTs(b.end_at) : "time not set yet") + (b.location ? "<br>" + esc(b.location) : "") + "</p>" +
        (already.length ? '<p class="sc-facts"><b>On it:</b> ' + already.map((e) => esc(personName(e.user_id)) + ' <span class="muted">(' + esc(T.fmtTs(e.starts_at)) + "\u2013" + esc(T.fmtTs(e.ends_at)) + ', drive ' + num(e.drive_before_min) + "/" + num(e.drive_after_min) + ' min)</span> <button type="button" class="link" data-m="edit" data-id="' + esc(e.id) + '">change</button>').join(", ") + "</p>" : "") +
        '<div class="field"><label>Add people</label><div class="sc-people">' + data.people.filter((p) => !already.some((e) => e.user_id === p.user_id)).map((p) =>
          '<label><input type="checkbox" value="' + esc(p.user_id) + '" /> ' + esc(p.name) + "</label>").join("") + "</div></div>" +
        '<div class="row2"><div class="field"><label for="aca-scS">Start</label><input type="time" id="aca-scS" step="300" value="' + T.hhmm(s) + '" /></div><div class="field"><label for="aca-scE">End</label><input type="time" id="aca-scE" step="300" value="' + T.hhmm(en) + '" /></div></div>' +
        driveHtml(already[0] ? already[0].drive_before_min : 30, already[0] ? already[0].drive_after_min : 30) +
        '<div class="inline-error hidden" id="aca-scMErr"></div>' +
        '<div class="modal-actions"><a href="#jobs/bookings" data-m="open" class="small">Open the booking</a><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">Add to the schedule</button></div></div>');
      driveControls(m, () => b.booking_id, !!data.studio_address && !already.length);
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") m.close();
        if (t.dataset.m === "open") { ev.preventDefault(); m.close(); showTab("bookings"); Bookings.openId(b.booking_id); }
        if (t.dataset.m === "edit") { m.close(); openEntry(data.entries.find((x) => x.id === t.dataset.id)); }
        if (t.dataset.m === "save") {
          const who = [...m.querySelectorAll(".sc-people input:checked")].map((x) => x.value);
          const st = el("scS").value, et = el("scE").value;
          if (!who.length) return mErr("Pick at least one person.");
          if (!st || !et) return mErr("Enter the start and end time.");
          const endDay = et <= st ? T.addDays(b.day, 1) : b.day;
          t.disabled = true;
          try {
            let clashes = 0;
            for (const u of who) {
              const { data: r, error } = await sb.rpc("schedule_save", { p: { user_id: u, kind: "job", booking_id: b.booking_id, starts_at: T.toIso(b.day, st), ends_at: T.toIso(endDay, et),
                drive_before_min: +m.querySelector(".sc-db").value || 0, drive_after_min: +m.querySelector(".sc-da").value || 0 } });
              if (error) throw error;
              clashes += num(r && r.overlaps);
            }
            m.close();
            toast(who.length === 1 ? "Added to the schedule." : who.length + " people added." + (clashes ? " Heads up: it overlaps other time on their schedule." : ""));
            load(); loadAttention();
          } catch (e) { mErr(cleanErr(e)); t.disabled = false; }
        }
      });
    }
    const mErr = (t) => { const n = el("scMErr"); if (n) { n.textContent = t; n.classList.remove("hidden"); } };

    // ---------------------------------------------------------------- add / change one bar
    function openEntry(e, preset) {
      const isNew = !e;
      preset = preset || {};
      const limited = !editable(); // only your own flex time
      const kind0 = e ? e.kind : preset.kind || (limited ? "flex" : "studio");
      const day0 = e ? T.local(e.starts_at).day : preset.day || T.today();
      const s0 = e ? T.local(e.starts_at).min : preset.startMin != null ? preset.startMin : 9 * 60;
      const e0 = e ? T.local(e.ends_at).min : preset.endMin != null && preset.endMin > s0 ? preset.endMin : Math.min(s0 + 240, 23 * 60 + 30);
      const offEnd = e && e.kind === "off" ? T.addDays(T.local(e.ends_at).day, T.local(e.ends_at).min === 0 ? -1 : 0) : day0;
      const weekBookings = data.bookings;
      const m = openModal('<div class="sc-modal"><h2>' + (isNew ? "Add time" : "Change " + esc(KIND[e.kind].toLowerCase())) + "</h2>" +
        '<div class="row2"><div class="field"><label for="aca-scP">Person</label><select id="aca-scP">' + data.people.filter((p) => !limited || isMine(p.user_id)).map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === (e ? e.user_id : preset.user_id) ? " selected" : "") + ">" + esc(p.name) + "</option>").join("") + "</select></div></div>" +
        '<div class="field"><label>What</label><div class="seg" role="radiogroup" aria-label="What">' + (limited ? ["flex"] : KINDS).map((k) => '<label><input type="radio" name="aca-scK" value="' + k + '"' + (k === kind0 ? " checked" : "") + " /><span>" + KIND[k] + "</span></label>").join("") + "</div></div>" +
        '<div class="field sc-only-job"><label for="aca-scB">Job</label><select id="aca-scB"><option value="">Pick a job this week\u2026</option>' + weekBookings.map((b) => '<option value="' + esc(b.booking_id) + '" data-day="' + esc(b.day) + '"' + (e && e.booking_id === b.booking_id && b.day === day0 ? " selected" : "") + ">" + esc(T.fmtDay(b.day) + " \u00b7 " + bookingLabel(b) + (b.start_at ? " \u00b7 " + T.fmtTs(b.start_at) : "")) + "</option>").join("") +
          (e && e.booking_id && !weekBookings.some((b) => b.booking_id === e.booking_id) ? '<option value="' + esc(e.booking_id) + '" selected>' + esc(e.booking_title) + "</option>" : "") + "</select></div>" +
        '<div class="field sc-not-job"><label for="aca-scT">Label</label><input type="text" id="aca-scT" maxlength="120" placeholder="Editing, ordering, delivery run\u2026" value="' + esc(e ? e.title : preset.title || "") + '" /></div>' +
        '<div class="row3 sc-not-off"><div class="field"><label for="aca-scD">Day</label><input type="date" id="aca-scD" value="' + esc(day0) + '" /></div><div class="field"><label for="aca-scS">Start</label><input type="time" id="aca-scS" step="300" value="' + T.hhmm(s0) + '" /></div><div class="field"><label for="aca-scE">End</label><input type="time" id="aca-scE" step="300" value="' + T.hhmm(e0) + '" /></div></div>' +
        '<div class="row2 sc-only-off"><div class="field"><label for="aca-scO1">From</label><input type="date" id="aca-scO1" value="' + esc(day0) + '" /></div><div class="field"><label for="aca-scO2">Through</label><input type="date" id="aca-scO2" value="' + esc(offEnd) + '" /></div></div>' +
        '<div class="sc-only-job">' + driveHtml(e ? e.drive_before_min : 30, e ? e.drive_after_min : 30) + "</div>" +
        '<div class="field"><label for="aca-scN">Note</label><textarea id="aca-scN" maxlength="1000">' + esc(e ? e.note : "") + "</textarea></div>" +
        '<div class="inline-error hidden" id="aca-scMErr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" data-m="remove">Remove</button>') + (e && e.kind === "job" && !limited && jobOf(e) ? ' <button type="button" class="small" data-m="more">More people</button>' : "") + '<span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">' + (isNew ? "Add" : "Save") + "</button></div></div>");
      const kind = () => m.querySelector('input[name="aca-scK"]:checked').value;
      function sync() {
        const k = kind();
        m.querySelectorAll(".sc-only-job").forEach((n) => n.classList.toggle("hidden", k !== "job"));
        m.querySelectorAll(".sc-not-job").forEach((n) => n.classList.toggle("hidden", k === "job"));
        m.querySelectorAll(".sc-only-off").forEach((n) => n.classList.toggle("hidden", k !== "off"));
        m.querySelectorAll(".sc-not-off").forEach((n) => n.classList.toggle("hidden", k === "off"));
      }
      sync();
      m.querySelectorAll('input[name="aca-scK"]').forEach((r) => r.addEventListener("change", sync));
      // Picking a job fills its day and times.
      el("scB").addEventListener("change", () => {
        const o = el("scB").selectedOptions[0];
        const b = o && weekBookings.find((x) => x.booking_id === o.value && x.day === o.dataset.day);
        if (!b) return;
        el("scD").value = b.day;
        if (b.start_at) { el("scS").value = T.hhmm(T.local(b.start_at).min); el("scE").value = T.hhmm(T.local(b.end_at).min); }
        if (data.studio_address) lookup();
      });
      const lookup = driveControls(m, () => el("scB").value, false);
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") m.close();
        if (t.dataset.m === "more") { m.close(); openAssign(jobOf(e)); return; }
        if (t.dataset.m === "remove") {
          if (!confirm("Remove this from " + personName(e.user_id) + "'s schedule?")) return;
          t.disabled = true;
          try { const { error } = await sb.rpc("schedule_remove", { p_id: e.id }); if (error) throw error; m.close(); toast("Removed."); load(); loadAttention(); }
          catch (err) { mErr(cleanErr(err)); t.disabled = false; }
        }
        if (t.dataset.m === "save") {
          const k = kind(), p = { id: e ? e.id : null, user_id: el("scP").value, kind: k, title: el("scT").value.trim(), note: el("scN").value.trim() };
          if (isNew && preset.gcal) p.gcal_event_id = preset.gcal;
          if (k === "off") {
            const a = el("scO1").value, z = el("scO2").value || a;
            if (!a) return mErr("Pick the first day off.");
            if (z < a) return mErr("\u201cThrough\u201d has to be on or after \u201cFrom\u201d.");
            p.starts_at = T.toIso(a, "00:00"); p.ends_at = T.toIso(T.addDays(z, 1), "00:00");
          } else {
            const d = el("scD").value, st = el("scS").value, et = el("scE").value;
            if (!d || !st || !et) return mErr("Enter the day, start and end.");
            p.starts_at = T.toIso(d, st); p.ends_at = T.toIso(et <= st ? T.addDays(d, 1) : d, et);
            if (k === "job") {
              p.booking_id = el("scB").value; p.title = "";
              if (!p.booking_id) return mErr("Pick the job.");
              p.drive_before_min = +m.querySelector(".sc-db").value || 0; p.drive_after_min = +m.querySelector(".sc-da").value || 0;
            }
          }
          t.disabled = true;
          try {
            const { data: r, error } = await sb.rpc("schedule_save", { p });
            if (error) throw error;
            m.close();
            toast((isNew ? "Added." : "Saved.") + (num(r && r.overlaps) ? " Heads up: it overlaps other time on " + personName(p.user_id) + "'s schedule." : ""), false);
            if (T.local(p.starts_at).day < data.start || T.local(p.starts_at).day >= T.addDays(data.start, 7)) anchor = T.local(p.starts_at).day;
            load(); loadAttention();
          } catch (err) { mErr(cleanErr(err)); t.disabled = false; }
        }
      });
    }

    // ---------------------------------------------------------------- view-only details
    function openInfo(e) {
      const m = openModal('<div class="sc-modal"><h2>' + esc(personName(e.user_id)) + ": " + esc(e.kind === "job" ? e.booking_title : e.kind !== "off" ? (e.title || KIND[e.kind]) : "Time off" + (e.title ? " (" + e.title + ")" : "")) + "</h2>" +
        '<p class="sc-facts">' + (e.kind === "off" ? esc(T.fmtDay(T.local(e.starts_at).day, { weekday: "long" })) + " through " + esc(T.fmtDay(T.addDays(T.local(e.ends_at).day, T.local(e.ends_at).min === 0 ? -1 : 0), { weekday: "long" }))
          : esc(T.fmtDay(T.local(e.starts_at).day, { weekday: "long" })) + ", " + esc(T.fmtTs(e.starts_at)) + "\u2013" + esc(T.fmtTs(e.ends_at))) +
        (e.kind === "job" ? "<br>Leave by " + esc(T.fmtTs(new Date(new Date(e.starts_at) - e.drive_before_min * 6e4).toISOString())) + " (" + num(e.drive_before_min) + " min drive), back about " + esc(T.fmtTs(new Date(new Date(e.ends_at).getTime() + e.drive_after_min * 6e4).toISOString())) : "") +
        (e.booking_location ? "<br>" + esc(e.booking_location) : "") + (e.note ? "<br>" + esc(e.note) : "") + "</p>" +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="primary" data-m="ok">OK</button></div></div>');
      m.querySelector('[data-m="ok"]').addEventListener("click", () => m.close());
    }
    function openCalInfo(c) {
      const when = c.all_day || !c.start_at ? T.fmtDay(c.start_date, { weekday: "long" }) + (c.end_date > c.start_date ? " through " + T.fmtDay(c.end_date, { weekday: "long" }) : "") + ", all day"
        : T.fmtDay(T.local(c.start_at).day, { weekday: "long" }) + ", " + T.fmtTs(c.start_at) + "\u2013" + T.fmtTs(c.end_at);
      const m = openModal('<div class="sc-modal"><h2>' + esc(c.summary) + '</h2><p class="sc-facts">' + esc(when) + (c.off_user ? "<br>Time off for " + esc(personName(c.off_user)) : "") +
        '<br><span class="muted">From the Google Calendar. Change it there and the schedule follows within a few minutes.</span></p>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="primary" data-m="ok">OK</button></div></div>');
      m.querySelector('[data-m="ok"]').addEventListener("click", () => m.close());
    }
    function openBookingInfo(b) {
      const who = data.entries.filter((e) => e.booking_id === b.booking_id && T.local(e.starts_at).day === b.day).map((e) => personName(e.user_id));
      const m = openModal('<div class="sc-modal"><h2>' + esc(bookingLabel(b)) + '</h2><p class="sc-facts">' + esc(T.fmtDay(b.day, { weekday: "long" })) + ", " + esc(b.start_at ? T.fmtTs(b.start_at) + "\u2013" + T.fmtTs(b.end_at) : "time not set yet") +
        (b.location ? "<br>" + esc(b.location) : "") + "<br><b>On it:</b> " + (who.length ? esc(who.join(", ")) : "nobody yet") + "</p>" +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="primary" data-m="ok">OK</button></div></div>');
      m.querySelector('[data-m="ok"]').addEventListener("click", () => m.close());
    }

    function openStudio() {
      const m = openModal('<div class="sc-modal"><h2>Studio address</h2><p>Drive times are measured from here to each job&#39;s location (or the organization and town when a booking has no location), using Google Maps.</p>' +
        '<div class="field"><label for="aca-scAddr">Address</label><input type="text" id="aca-scAddr" maxlength="300" value="' + esc(data.studio_address || "") + '" placeholder="Street, town, state" /></div>' +
        '<div class="inline-error hidden" id="aca-scMErr"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">Save</button></div></div>');
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") m.close();
        if (t.dataset.m === "save") {
          t.disabled = true;
          try { const { error } = await sb.rpc("schedule_settings_save", { p_studio_address: el("scAddr").value.trim() }); if (error) throw error; m.close(); toast("Saved."); load(); }
          catch (e) { mErr(cleanErr(e)); t.disabled = false; }
        }
      });
    }

    // ---------------------------------------------------------------- from Book a job
    // The team, for "Who's shooting" on the booking form.
    async function team() {
      const { data: d, error } = await sb.rpc("schedule_week", { p_start: T.today(), p_days: 1 });
      if (error) throw error;
      return d.people || [];
    }
    // Put people on every day of a booking that has a time (with drive time from Google Maps when it can be
    // looked up). Returns {added, untimed: [days without a time yet]}.
    async function staffBooking(bookingId, fromDay, toDay, userIds) {
      const { data: d, error } = await sb.rpc("schedule_week", { p_start: fromDay, p_days: Math.min(42, T.daysBetween(fromDay, toDay) + 1) });
      if (error) throw error;
      const days = (d.bookings || []).filter((b) => b.booking_id === bookingId);
      let drive = 0;
      if (d.studio_address && days.some((b) => b.start_at)) { try { drive = Math.ceil((await lookupDrive(bookingId)).minutes / 5) * 5; } catch (e) { drive = 0; } }
      let added = 0;
      for (const b of days.filter((x) => x.start_at)) {
        for (const uid of userIds) {
          const { error: e2 } = await sb.rpc("schedule_save", { p: { user_id: uid, kind: "job", booking_id: bookingId, starts_at: b.start_at, ends_at: b.end_at, drive_before_min: drive, drive_after_min: drive, title: "", note: "" } });
          if (e2) throw e2;
          added++;
        }
      }
      if (data) load();
      loadAttention();
      return { added, untimed: days.filter((x) => !x.start_at).map((x) => x.day) };
    }

    return { load, loadAttention, team, staffBooking };
  })();
