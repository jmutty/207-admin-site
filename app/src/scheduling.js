  // ================================================================ STAFF: Schedule (bar scheduler, 2026-10-22)
  // One row per person, weeks start on Sunday, the week's bookings across the top. Bars come from
  // schedule_entries: job (a person on a booking, with drive time before/after in its own color), work (any
  // other time) and off (time off). Scheduled hours are compared with each person's default hours per week
  // (Team page). View = see the team's week; Edit = add, change and remove bars. Drive times come from the
  // drive-time edge function (Google Maps, from the studio address). Every job bar also has setup before it
  // and teardown after it (30 min each by default). Right-click (or long-press on a phone) a job bar to batch
  // it with another job that day: the drive then goes studio -> A -> B -> studio, job to job. Everything goes
  // through RPCs: schedule_week / schedule_save / schedule_remove / schedule_batch_save / schedule_settings_save /
  // schedule_setup_save / schedule_attention.
  // Crew (2026-10-23, crew.js): a job bar has a role and an answer (Waiting / Confirmed; "can't make it" takes
  // the bar off and the job is back under Jobs not assigned until it has as many people as it needs). The
  // crew picker shows roles, who is busy or off and the drive from home (CrewPick). "Still waiting" shows only
  // unanswered jobs. A capacity strip under the days, the busiest days ahead, and "Email the week" (each
  // person gets only their own schedule). RPCs: crew_options / crew_needed_set / crew_ask_now /
  // crew_roles_list / crew_role_save / crew_role_archive / crew_settings_save / crew_capacity /
  // week_email_preview / week_email_send.
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
    // "11/16" (one date format everywhere, see Fmt). Two exceptions keep a weekday because they head a calendar column
    // or day: { calendar: true } gives "Mon 11/16", and { month: undefined } gives the narrow week-column "Mon 16".
    const fmtDay = (day, o) => o && "month" in o && o.month === undefined
      ? new Date(day + "T12:00:00Z").toLocaleDateString("en-US", Object.assign({ timeZone: "UTC", weekday: "short", day: "numeric" }, o))
      : (o && o.calendar ? WEEKDAYS[new Date(day + "T12:00:00Z").getUTCDay()] + " " : "") + Fmt.day(day);
    const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    // Hours scheduled on one Eastern day: jobs with their drive, setup and teardown time, and work; time off doesn't count.
    function workHours(entries, day) {
      const a = new Date(toIso(day, "00:00")).getTime(), z = new Date(toIso(addDays(day, 1), "00:00")).getTime();
      return entries.reduce((sum, e) => {
        if (e.kind === "off") return sum;
        const s = new Date(e.starts_at).getTime() - ((e.drive_before_min || 0) + (e.setup_min || 0)) * 6e4, en = new Date(e.ends_at).getTime() + ((e.drive_after_min || 0) + (e.teardown_min || 0)) * 6e4;
        return sum + Math.max(0, Math.min(en, z) - Math.max(s, a)) / 36e5;
      }, 0);
    }
    const LUNCH_AFTER_H = 6; // a day this long needs a lunch break
    // People show as first name and last initial ("Sam H.") to keep things short.
    const shortName = (n) => { const w = String(n || "").trim().split(/\s+/); return w.length > 1 && w[w.length - 1] ? w[0] + " " + w[w.length - 1][0].toUpperCase() + "." : String(n || ""); };
    return { TZ, local, today, addDays, dow, weekStart, daysBetween, toIso, hhmm, fmtMin, fmtTs, fmtDay, WEEKDAYS, workHours, LUNCH_AFTER_H, shortName };
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
    .aca .sc-k-setup { background: #9fc0e6; color: #12355e; }
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
    .aca .sc-head.hl { background: var(--accent-soft, #e6f0fb); box-shadow: inset 0 0 0 2px var(--accent); }
    /* ws/settings (2026-10-24): 8 weeks view (B1), Times and drive fold (B8), phone swipe hint (B2) */
    .aca #aca-scWeeks { display: none; }
    .aca .sc-w8 #aca-scWeeks { display: block; }
    .aca .sc-w8 .sc-scroll, .aca .sc-w8 #aca-scSum, .aca .sc-w8 #aca-scWarn, .aca .sc-w8 .sc-swipe, .aca .sc-w8 [data-v="prev"], .aca .sc-w8 [data-v="next"], .aca .sc-w8 [data-v="today"],
      .aca .sc-w8 #aca-scJump, .aca .sc-w8 .sc-mineopt { display: none !important; }
    .aca .sc-w8row { border: 1px solid var(--border); border-radius: 4px; background: var(--surface); padding: 8px 10px; margin: 0 0 8px; }
    .aca .sc-w8row h3 { margin: 0 0 6px; font-size: 14px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .aca .sc-w8row h3 .s { font-weight: 400; color: var(--muted); font-size: 12.5px; }
    .aca .sc-w8row .sc-jobs { display: flex; flex-wrap: wrap; gap: 6px; padding: 0; min-height: 0; }
    .aca .sc-w8row .sc-chip { max-width: 100%; }
    .aca .sc-fold { margin: 4px 0 10px; border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; }
    .aca .sc-fold > summary { cursor: pointer; font-weight: 600; font-size: 13.5px; }
    .aca .sc-fold > summary .s { font-weight: 400; color: var(--muted); font-size: 12.5px; margin-left: 6px; }
    .aca .sc-fold[open] > summary { margin-bottom: 8px; }
    .aca .sc-swipe { font-size: 12px; color: var(--muted); margin: 0 0 4px; text-align: right; }
    .aca .sc-scroll.fade { -webkit-mask-image: linear-gradient(to right, #000 82%, transparent); mask-image: linear-gradient(to right, #000 82%, transparent); }
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
    .aca .sc-chip.sel, .aca .scl-item.sel, .aca button.scm-chip.sel, .aca button.scc-card.sel { outline: 2px solid var(--accent); outline-offset: -1px; background: var(--surface-2); }
    .aca .sc-pickmany { border: 0; background: none; padding: 0; margin-left: 6px; color: var(--accent); font-size: 11.5px; font-weight: 600; cursor: pointer; text-decoration: underline; }
    .aca .sc-bulk { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 40; display: flex; gap: 10px; align-items: center; padding: 10px 14px;
      background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.18); font-size: 14px; max-width: calc(100vw - 32px); flex-wrap: wrap; }
    .aca .sc-bulk.hidden { display: none; }
    .aca .sc-bulkjobs { list-style: none; margin: 0 0 12px; padding: 0; font-size: 13.5px; max-height: 180px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
    .aca .sc-bulkjobs li { padding: 6px 10px; border-bottom: 1px solid var(--line2); }
    .aca .sc-bulkjobs li:last-child { border-bottom: 0; }
    .aca .sc-bulkjobs .s { color: var(--muted); font-size: 12.5px; }
    .aca .sc-cell { position: relative; min-height: 46px; cursor: default; }
    .aca .sc-cell.edit { cursor: copy; }
    .aca .sc-cell.today { background: #fffaf4; }
    .aca .sc-cell.grid { background-image: repeating-linear-gradient(90deg, transparent 0, transparent calc(100% / var(--hours) - 1px), var(--line2) calc(100% / var(--hours) - 1px), var(--line2) calc(100% / var(--hours))); }
    .aca .sc-b { position: absolute; height: 22px; border-radius: 3px; font-size: 11.5px; line-height: 22px; padding: 0 5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; border: 0; box-sizing: border-box; min-width: 4px; }
    .aca .sc-b.drive { border-radius: 0; padding: 0; }
    .aca .sc-b.drive.first { border-radius: 3px 0 0 3px; } .aca .sc-b.drive.last { border-radius: 0 3px 3px 0; }
    .aca .sc-b.job.mid { border-radius: 0; }
    .aca .sc-b.setup { border-radius: 0; padding: 0; }
    .aca .sc-b.trip { background: transparent; height: 2px; margin-top: 10px; border-top: 2px dashed #c98f00; border-radius: 0; padding: 0; min-width: 0; }
    .aca .sc-b.late { box-shadow: 0 0 0 2px var(--err-fg); }
    .aca .sc-b.batched:not(.drive):not(.setup):not(.trip)::before { content: "\\21c4  "; }
    .aca .sc-menu { position: fixed; z-index: 1000; min-width: 220px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 4px 0; }
    .aca .sc-menu .sc-mh { padding: 6px 12px 4px; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; }
    .aca .sc-menu button { display: block; width: 100%; text-align: left; border: 0; background: none; border-radius: 0; padding: 9px 12px; height: auto; font-size: 13.5px; color: var(--text); cursor: pointer; }
    .aca .sc-menu button:hover, .aca .sc-menu button:focus-visible { background: var(--surface-2); outline: none; }
    .aca .sc-trip { list-style: none; margin: 4px 0 10px; padding: 0; font-size: 13px; line-height: 20px; }
    .aca .sc-trip li { display: flex; gap: 10px; align-items: baseline; padding: 2px 0; }
    .aca .sc-trip .t { width: 62px; flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
    .aca .sc-trip .leg { color: #8a6100; }
    .aca .sc-modal .sc-trip .leg input { width: 64px; height: 28px; padding: 0 6px; margin: 0 4px; }
    .aca .sc-trip .bad { color: var(--err-fg); font-weight: 600; }
    .aca .sc-modal .sc-pick label { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; font-size: 13.5px; font-weight: 400; line-height: 19px; }
    .aca .sc-modal .field .sc-pick input { width: 18px; height: 18px; flex: none; margin: 1px 0 0; }
    .aca .sc-pick small { display: block; color: var(--muted); font-size: 12px; }
    .aca .sc-b.clash { box-shadow: 0 0 0 2px var(--err-fg); }
    .aca .sc-b.cancelled { text-decoration: line-through; opacity: .6; }
    .aca .sc-b:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .aca .sc-tasks { position: absolute; right: 4px; bottom: 2px; font-size: 11px; color: var(--muted); }
    .aca .sc-b .sc-cf { display: inline-block; width: 14px; height: 14px; line-height: 14px; margin: 0 4px 0 -1px; border-radius: 50%; text-align: center; font-size: 10px; font-weight: 700; font-style: normal; vertical-align: 0; }
    .aca .sc-b .sc-cf.ok { background: #fff; color: #2e7d46; }
    .aca .sc-b .sc-cf.wait { background: #f0b429; color: #3d2c00; }
    .aca .sc-b.dim { opacity: .28; }
    .aca .sc-b.asked { background: repeating-linear-gradient(135deg, transparent 0 6px, rgba(150,140,125,.18) 6px 12px); border: 1px dashed #a39d93; color: var(--muted); }
    .aca .sc-chip .sc-no { display: block; color: var(--err-fg); font-size: 11.5px; }
    .aca .sc-chip .sc-need { color: var(--accent); font-weight: 600; }
    .aca .sc-cap { padding: 5px 8px; font-size: 11.5px; line-height: 15px; background: var(--surface); color: var(--muted); }
    .aca .sc-cap b { color: var(--text); font-weight: 600; }
    .aca .sc-cap.amber { background: #fdf6e3; } .aca .sc-cap.amber b { color: #8a6100; }
    .aca .sc-cap.red { background: var(--err-bg); } .aca .sc-cap.red b { color: var(--err-fg); }
    .aca .sc-cap.quiet { color: var(--faint); }
    .aca .sc-pick { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
    .aca .sc-pick li { display: grid; grid-template-columns: 22px minmax(0, 1fr) 150px; gap: 8px; align-items: center; padding: 7px 10px; border-bottom: 1px solid var(--line2); }
    .aca .sc-pick li:last-child { border-bottom: 0; }
    .aca .sc-pick input[type=checkbox] { width: 18px; height: 18px; margin: 0; }
    .aca .sc-pick .n { font-size: 13.5px; font-weight: 600; }
    .aca .sc-pick .r { font-weight: 400; color: var(--muted); font-size: 12px; margin-left: 4px; }
    .aca .sc-pick .s { display: block; font-size: 12px; color: var(--muted); font-weight: 400; }
    .aca .sc-pick .s.warn { color: #8a6100; } .aca .sc-pick .s.bad { color: var(--err-fg); }
    .aca .sc-pick select { width: 100%; height: 32px; font-size: 13px; }
    .aca .sc-onit { list-style: none; margin: 0 0 12px; padding: 0; font-size: 13.5px; }
    .aca .sc-onit li { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; border-bottom: 1px solid var(--line2); }
    .aca .sc-onit .s { color: var(--muted); font-size: 12.5px; }
    .aca .sc-modal .sc-sub { margin: 14px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .aca .sc-modal .sc-chk { display: flex; gap: 8px; align-items: flex-start; font-weight: 400; font-size: 13.5px; margin: 0 0 10px; }
    .aca .sc-modal .sc-chk input { width: 18px; height: 18px; flex: none; margin: 1px 0 0; }
    .aca .sc-roles li { display: flex; gap: 8px; align-items: center; padding: 4px 0; }
    .aca .sc-roles input[type=text] { flex: 1; }
    .aca .sc-peak td, .aca .sc-peak th { text-align: right; }
    .aca .sc-peak td:first-child, .aca .sc-peak th:first-child { text-align: left; }
    .aca .sc-peak .red { color: var(--err-fg); font-weight: 600; } .aca .sc-peak .amber { color: #8a6100; font-weight: 600; }
    .aca .sc-modal .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .aca .sc-modal .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
    .aca .sc-modal .field input, .aca .sc-modal .field select, .aca .sc-modal .field textarea { width: 100%; }
    .aca .sc-modal textarea { height: 60px; padding: 6px 10px; }
    .aca .sc-modal .sc-drive { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
    .aca .sc-modal .sc-drive .field { margin-bottom: 0; }
    .aca .sc-modal .sc-drive input { width: 90px; }
    .aca .sc-modal .sc-drive + .sc-drive { margin-top: 10px; }
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
    .aca .sc-listopt { display: none; }
    .aca .sc-list { display: flex; flex-direction: column; gap: 18px; padding: 4px 0; }
    .aca .scl-day h3 { margin: 0 0 8px; font-size: 15px; font-weight: 700; }
    .aca .scl-lbl { font-size: 13px; color: var(--muted); margin: 10px 0 4px; } .aca .scl-lbl b { color: var(--text); font-size: 14px; }
    .aca button.scl-item { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; width: 100%; height: auto; min-height: 48px; padding: 9px 12px; margin: 0 0 6px; text-align: left; white-space: normal; font-weight: 400; align-items: start; border-left: 4px solid var(--border); }
    .aca button.scl-item .t { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13.5px; }
    .aca button.scl-item .w { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .aca button.scl-item .w b { font-weight: 600; font-size: 14.5px; overflow-wrap: anywhere; }
    .aca button.scl-item small { color: var(--muted); font-size: 13px; } .aca button.scl-item small.ok { color: var(--ok-fg); } .aca button.scl-item small.wait { color: var(--accent); }
    .aca button.scl-item.open { border-left-color: var(--err-fg); }
    .aca button.scl-item.scl-k-job { border-left-color: #3b6fb6; } .aca button.scl-item.scl-k-studio { border-left-color: #7a4fb3; } .aca button.scl-item.scl-k-admin { border-left-color: #3d8a55; }
    .aca button.scl-item.scl-k-off, .aca button.scl-item.scl-k-asked { border-left-color: var(--faint); color: var(--muted); }
    .aca button.scl-item.cancelled .w b { text-decoration: line-through; }
    .aca .scl-free { font-size: 13px; color: var(--muted); margin: 8px 0 0; }
    .aca .sc-islist .sc-scroll { border: 0; background: transparent; overflow: visible; }
    .aca .sc-islist .sc-bar #aca-scJump, .aca .sc-islist .sc-keybtn, .aca .sc-islist .sc-legend, .aca .sc-islist .sc-bar button[data-v="weekmail"] { display: none; }
    .aca .sc-more { margin-top: 14px; }
    .aca .sc-more > summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--muted); }
    .aca .sc-more[open] > summary { margin-bottom: 4px; }
    .aca .sc-islist .sc-more { display: none; }
    .aca .sc-help { font-size: 12.5px; color: var(--muted); margin: 10px 0 12px; }
    .aca .sc-help summary { cursor: pointer; font-weight: 600; }
    .aca .sc-help p { margin: 6px 0 0; line-height: 19px; }
    /* Schedule views (2026-10-24): options row, pills, cards (week / 2 weeks), month, problems, map */
    .aca .sc-bar2 { display: flex; align-items: center; gap: 6px 14px; flex-wrap: wrap; margin: -4px 0 10px; font-size: 13px; }
    .aca .sc-bar2 .grow { flex: 1; }
    .aca .sc-opt { display: inline-flex; align-items: center; gap: 5px; font-weight: 400; font-size: 13px; white-space: nowrap; cursor: pointer; }
    .aca .sc-opt input[type=checkbox] { width: 16px; height: 16px; margin: 0; }
    .aca .sc-opt select { height: 28px; font-size: 12.5px; padding: 0 6px; }
    .aca .sc-opt .s { color: var(--faint); font-size: 12px; }
    .aca .sc-probbtn.bad { border-color: var(--err-fg); color: var(--err-fg); font-weight: 600; }
    .aca .sc-w8 .sc-bar2 > :not(.sc-calbtn), .aca .sc-w8 .sc-map, .aca .sc-w8 #aca-scProblems, .aca .sc-w8 #aca-scColKey { display: none !important; }
    .aca .sc-colkey { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--muted); margin: -4px 0 8px; }
    .aca .sc-colkey i { display: inline-block; width: 12px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
    .aca .sc-problems { border: 1px solid var(--border); border-left: 3px solid var(--err-fg); border-radius: 4px; background: var(--surface); padding: 8px 12px; margin: 0 0 10px; font-size: 13px; }
    .aca .sc-problems ul { margin: 6px 0 0; padding: 0; list-style: none; max-height: 220px; overflow: auto; }
    .aca .sc-problems li { padding: 3px 0; line-height: 18px; }
    .aca .sc-problems li button.link { font-weight: 600; padding: 0; height: auto; margin-right: 4px; }
    .aca .sc-pills { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
    .aca .sc-pill { display: inline-block; font-size: 11px; font-weight: 600; line-height: 16px; padding: 0 6px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
    .aca .sc-pill.quiet { font-weight: 400; color: var(--faint); }
    .aca .sc-pill.bad { background: var(--err-bg); border-color: transparent; color: var(--err-fg); }
    .aca .sc-pill.wx { background: #e8f0fb; border-color: transparent; color: #24528a; }
    .aca .sc-wx { color: #24528a; } .aca .sc-late { color: var(--err-fg); font-weight: 600; }
    .aca .sc-st { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: 0; background: #fff; }
    .aca .sc-st.on { background: #4cd07a; box-shadow: 0 0 0 1px #fff; } .aca .sc-st.done { background: #c9d4e2; } .aca .sc-st.late { background: #ff6b5a; box-shadow: 0 0 0 1px #fff; }
    .aca .sc-edge { position: absolute; bottom: 3px; transform: translateX(-100%); font-size: 11px; color: var(--muted); white-space: nowrap; padding-right: 2px; }
    .aca .sc-edge.end, .aca .sc-edge.near { transform: none; padding: 0 0 0 2px; }
    .aca .sc-now { position: absolute; top: 0; bottom: 0; width: 0; border-left: 2px solid var(--accent); z-index: 2; pointer-events: none; }
    .aca .sc-main { display: block; }
    /* the map sits under the schedule, as wide as it (Jeremiah 2026-10-24) */
    .aca .sc-map { margin-top: 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); font-size: 13px; overflow: hidden; }
    .aca .sc-mapbody { display: grid; grid-template-columns: minmax(0, 1fr) 300px; align-items: start; }
    .aca .sc-mapside { border-left: 1px solid var(--line2); min-width: 0; }
    .aca .sc-maphd { padding: 8px 10px; border-bottom: 1px solid var(--line2); }
    .aca .sc-mapimg, .aca .sc-mapsvg { display: block; width: 100%; height: auto; }
    .aca .sc-maperr { padding: 0 10px; color: #8a6100; }
    .aca .sc-routes { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 8px 10px 0; font-size: 12.5px; }
    .aca .sc-routes i { display: inline-block; width: 12px; height: 4px; border-radius: 2px; margin-right: 5px; vertical-align: 2px; }
    .aca .sc-maplist { list-style: none; margin: 0; padding: 6px 10px 10px; max-height: 520px; overflow: auto; }
    .aca .sc-maplist li { display: flex; gap: 8px; align-items: flex-start; padding: 4px 0; line-height: 17px; }
    .aca .sc-maplist .pin { flex: none; width: 18px; height: 18px; border-radius: 50%; color: #fff; font-size: 11px; font-weight: 700; text-align: center; line-height: 18px; }
    .aca .sc-maplist small { display: block; color: var(--muted); font-size: 12px; }
    .aca .scc-grid { display: grid; grid-template-columns: 150px repeat(var(--cols), minmax(118px, 1fr)) 92px; min-width: calc(242px + var(--cols) * 118px); }
    .aca .scc-grid.two { grid-template-columns: 130px repeat(var(--cols), minmax(84px, 1fr)) 84px; min-width: calc(214px + var(--cols) * 84px); }
    .aca .scc-grid > div { border-bottom: 1px solid var(--line2); border-left: 1px solid var(--line2); min-width: 0; }
    .aca .scc-name { position: sticky; left: 0; z-index: 3; background: var(--surface); border-left: 0 !important; padding: 8px 10px; font-size: 13px; }
    .aca .scc-name b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .aca .scc-name .sc-hrs, .aca .scc-tot .sc-hrs { display: block; font-size: 12px; color: var(--muted); }
    .aca .scc-tot { padding: 8px; font-size: 12.5px; text-align: right; }
    .aca .scc-hrow { background: var(--surface-2); font-weight: 600; }
    .aca .scc-head { padding: 6px 8px; font-size: 12.5px; font-weight: 600; background: var(--surface-2); }
    .aca .scc-head.today { color: var(--accent); box-shadow: inset 0 -2px 0 var(--accent); }
    .aca .scc-head.hl { background: var(--accent-soft, #e6f0fb); box-shadow: inset 0 0 0 2px var(--accent); }
    .aca .scc-head button.link { font-weight: 600; font-size: 12.5px; padding: 0; height: auto; }
    .aca .scc-lane { padding: 5px; display: flex; flex-direction: column; gap: 4px; background: var(--surface-2); }
    .aca .scc-cell { padding: 4px; display: flex; flex-direction: column; gap: 4px; min-height: 52px; }
    .aca .scc-cell.today { background: #fffaf4; }
    .aca button.scc-card { --cc: #2f6db5; display: block; width: 100%; height: auto; text-align: left; white-space: normal; padding: 3px 6px 4px; border: 0; border-left: 4px solid var(--cc); border-radius: 3px;
      background: color-mix(in srgb, var(--cc) 12%, var(--surface)); color: var(--text); font-size: 12px; line-height: 15px; font-weight: 400; cursor: pointer; }
    .aca button.scc-card .t { display: block; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .aca button.scc-card .n { display: block; font-weight: 600; overflow-wrap: anywhere; }
    .aca button.scc-card .d { display: block; font-size: 11px; color: var(--muted); }
    .aca button.scc-card .d .dr { color: #8a6100; } .aca button.scc-card .d .dr.far { color: var(--err-fg); font-weight: 600; }
    .aca button.scc-card .d .ok { color: var(--ok-fg); } .aca button.scc-card .d .wait { color: #b07a00; }
    .aca button.scc-card .d .wx { color: #24528a; } .aca button.scc-card .d .due { color: var(--muted, #666); } .aca button.scc-card .d .due.bad { color: var(--err-fg); font-weight: 600; }
    .aca button.scc-card .d .st.on { color: var(--ok-fg); font-weight: 600; } .aca button.scc-card .d .st.late { color: var(--err-fg); font-weight: 600; }
    .aca button.scc-card.scc-studio { --cc: #7b5cc4; } .aca button.scc-card.scc-admin { --cc: #3f8f5a; } .aca button.scc-card.scc-flex { --cc: #1f8a84; } .aca button.scc-card.scc-work { --cc: #6b7a8f; }
    .aca button.scc-card.scc-off, .aca button.scc-card.scc-asked { --cc: #a39d93; background: repeating-linear-gradient(135deg, #ece8e1 0 6px, #f5f2ec 6px 12px); color: var(--muted); }
    .aca button.scc-card.scc-asked { border-left-style: dashed; }
    .aca button.scc-card.cancelled .n { text-decoration: line-through; }
    .aca button.scc-card.dim { opacity: .3; }
    .aca .scc-foot { font-size: 11px; color: var(--muted); margin-top: auto; }
    .aca .scc-grid.two .scc-card .d, .aca .scc-grid.two .scc-head .sc-pills .sc-pill.quiet { display: none; }
    .aca .scm-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)) 96px; }
    .aca .scm-h { padding: 6px 8px; font-size: 12px; font-weight: 600; color: var(--muted); background: var(--surface-2); border-bottom: 1px solid var(--line2); }
    .aca .scm-day { min-height: 104px; padding: 4px 5px 6px; border-bottom: 1px solid var(--line2); border-left: 1px solid var(--line2); display: flex; flex-direction: column; gap: 3px; cursor: pointer; min-width: 0; }
    .aca .scm-day:nth-child(8n+9) { border-left: 0; }
    .aca .scm-day.other { background: var(--surface-2); } .aca .scm-day.other .scm-dn { color: var(--faint); }
    .aca .scm-day.past { opacity: .7; }
    .aca .scm-day.today { box-shadow: inset 0 0 0 2px var(--accent); }
    .aca .scm-dn { font-weight: 600; font-size: 12.5px; padding: 0; height: auto; text-align: left; color: var(--text); }
    .aca .scm-dn span { color: var(--accent); font-size: 11px; }
    .aca button.scm-chip { display: flex; gap: 4px; justify-content: space-between; width: 100%; height: auto; padding: 1px 5px; border: 0; border-left: 3px solid #2f6db5; border-radius: 2px; background: #e8f0fb; color: var(--text); font-size: 11.5px; line-height: 16px; font-weight: 400; text-align: left; cursor: pointer; min-width: 0; }
    .aca button.scm-chip .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .aca button.scm-chip .who { flex: none; color: var(--muted); font-size: 11px; }
    .aca button.scm-chip.need { border-left-color: #c2412d; background: var(--err-bg); } .aca button.scm-chip.need .who { color: var(--err-fg); font-weight: 600; }
    .aca button.scm-chip.wait { border-left-color: #b07a00; background: #fdf6e3; }
    .aca button.scm-chip.gcal { border-left-color: #8a8580; background: var(--surface); border-top: 1px dashed var(--border); border-right: 1px dashed var(--border); border-bottom: 1px dashed var(--border); color: var(--muted); }
    .aca .scm-more { font-size: 11.5px; padding: 0; height: auto; text-align: left; }
    .aca .scm-off { font-size: 11px; color: var(--faint); margin-top: auto; }
    .aca .scm-day .sc-pill.wx { align-self: flex-start; }
    .aca .scm-wt { display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 6px 8px; height: auto; border: 0; border-bottom: 1px solid var(--line2); border-left: 1px solid var(--line2); border-radius: 0; background: var(--surface-2); font-size: 12px; color: var(--muted); text-align: left; text-decoration: none; }
    .aca .scm-h.scm-wt { justify-content: flex-start; }
    .aca .scm-wt b { color: var(--text); } .aca .scm-wt .bad { color: var(--err-fg); font-weight: 600; }
    .aca .scm-key { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 8px 10px; font-size: 12px; color: var(--muted); }
    .aca .scm-key i { display: inline-block; width: 12px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; background: #2f6db5; }
    .aca .scm-key i.need { background: #c2412d; } .aca .scm-key i.wait { background: #b07a00; } .aca .scm-key i.gcal { background: #8a8580; }
    .aca .modal:has(.sc-viewmodal) { width: min(760px, calc(100vw - 32px)); max-width: none; }
    .aca .sc-vwtop { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 12px; }
    .aca .sc-vwtop h2 { margin: 0; flex: 1 1 auto; }
    .aca .sc-vwtop select { flex: 0 1 260px; min-width: 0; }
    .aca .sc-vwsum { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 10px; font-size: 13px; color: var(--muted); }
    .aca .sc-vwsum .p { padding: 2px 9px; border-radius: 999px; background: var(--surface-2); color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
    .aca .sc-vwsum .p.amber { background: var(--warn-bg); color: var(--warn-fg); }
    .aca .sc-vwsum .to { margin-left: auto; }
    .aca .sc-vwlist { max-height: 56vh; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
    .aca .sc-vwday { display: grid; grid-template-columns: 76px 1fr; gap: 12px; padding: 12px 14px; border-top: 1px solid var(--border); }
    .aca .sc-vwday:first-child { border-top: 0; }
    .aca .sc-vwday.chg { background: linear-gradient(90deg, var(--warn-bg), transparent 40%); }
    .aca .sc-vwdate .w { display: block; font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
    .aca .sc-vwdate .n { display: block; font-size: 20px; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; }
    .aca .sc-vwdate .chgp { display: inline-block; margin-top: 4px; padding: 1px 7px; border-radius: 999px; background: var(--warn-bg); color: var(--warn-fg); font-size: 11px; font-weight: 600; }
    .aca .sc-vwitems { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .aca .sc-vwitem { --cc: #2f6db5; border-left: 4px solid var(--cc); border-radius: 4px; background: var(--surface-2); padding: 7px 10px; }
    .aca .sc-vwitem.k-studio { --cc: #7b5cc4; } .aca .sc-vwitem.k-admin { --cc: #3f8f5a; } .aca .sc-vwitem.k-flex { --cc: #1f8a84; } .aca .sc-vwitem.k-work { --cc: #6b7a8f; }
    .aca .sc-vwitem.k-off { --cc: #a39d93; background: repeating-linear-gradient(135deg, #ece8e1 0 6px, #f5f2ec 6px 12px); color: var(--muted); }
    .aca .sc-vwitem .t { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .aca .sc-vwitem .n { font-weight: 600; overflow-wrap: anywhere; }
    .aca .sc-vwitem .d { font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
    .aca .sc-vwitem .ok { color: var(--ok-fg); font-weight: 600; } .aca .sc-vwitem .wait { color: #8a6100; font-weight: 600; }
    .aca .sc-vwgone { font-size: 12.5px; color: var(--err-fg); }
    .aca .sc-vwnone { font-size: 13px; color: var(--muted); }
    .aca .sc-vwempty { padding: 28px 16px; text-align: center; color: var(--muted); }
    .aca .sc-vwmail { margin: 10px 0 0; font-size: 13px; }
    .aca .sc-vwmail summary { cursor: pointer; color: var(--muted); }
    .aca .sc-vwframe { display: block; width: 100%; height: 50vh; margin-top: 8px; border: 1px solid var(--border); border-radius: 4px; background: #fff; }
    @media (max-width: 560px) { .aca .sc-vwday { grid-template-columns: 1fr; gap: 6px; } .aca .sc-vwdate .n { display: inline; font-size: 16px; margin-left: 6px; } .aca .sc-vwdate .w { display: inline; } .aca .sc-vwsum .to { margin-left: 0; } }
    .aca .sc-bad { color: var(--err-fg); }
    .aca .sc-chgprev { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin: 10px 0; font-size: 13px; }
    .aca .sc-chgprev pre { white-space: pre-wrap; font: inherit; margin: 6px 0 0; max-height: 220px; overflow: auto; }
    .aca .scl-trip { font-size: 12.5px; color: var(--muted); margin: -2px 0 6px; padding-left: 4px; }
    .aca .scl-trip b { color: var(--text); font-weight: 600; }
    @media (max-width: 760px) {
      .aca .sc-bar { gap: 6px; }
      .aca .sc-bar h2 { order: -1; flex: 1 0 100%; margin: 0 0 2px; font-size: 16px; }
      .aca .sc-bar .grow { display: none; }
      .aca .sc-legend { display: none; order: 10; flex: 1 0 100%; gap: 6px 12px; font-size: 12px; padding: 4px 0; }
      .aca .sc-showkey .sc-legend { display: flex; }
      .aca .sc-keybtn { display: inline-block; }
      .aca .sc-listopt { display: block; }
      .aca .sc-bar button[data-v="studio"], .aca .sc-bar button[data-v="crewset"] { display: none; }
      .aca .sc-pick li { grid-template-columns: 22px minmax(0, 1fr); }
      .aca .sc-pick li select { grid-column: 2; }
      .aca .sc-cap { padding: 4px 5px; font-size: 11px; }
      .aca .sc-bar .primary { margin-left: auto; }
      .aca .sc-bar #aca-scJump { flex: 1 1 120px; min-width: 0; }
      .aca .sc-bar .sc-mineopt { font-size: 12.5px !important; }
      .aca #aca-scPeak { display: none; }
      .aca .sc-w8 #aca-scPeak:not(.hidden) { display: block; }
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
      .aca .sc-bar2 { gap: 6px 12px; }
      .aca .sc-wide, .aca .sc-mapopt, .aca .sc-colopt { display: none !important; }
      .aca .sc-mapbody { grid-template-columns: 1fr; }
      .aca .sc-mapside { border-left: 0; border-top: 1px solid var(--line2); }
      .aca .scm-grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }
      .aca .scm-wt, .aca .scm-h.scm-wt, .aca .scm-off, .aca .scm-day .sc-pill, .aca .scm-more { display: none !important; }
      .aca .scm-day { min-height: 58px; padding: 3px; gap: 2px; flex-direction: row; flex-wrap: wrap; align-content: flex-start; }
      .aca .scm-dn { flex: 1 0 100%; font-size: 12px; }
      .aca .scm-dn span { display: none; }
      .aca .scm-key .kl { display: none; }
      .aca button.scm-chip { flex: none; width: 9px; height: 9px; min-height: 0; min-width: 0; padding: 0; border: 0 !important; border-radius: 50%; background: #2f6db5; }
      .aca button.scm-chip.need { background: #c2412d; } .aca button.scm-chip.wait { background: #b07a00; } .aca button.scm-chip.gcal { background: #8a8580; }
      .aca button.scm-chip .nm, .aca button.scm-chip .who { display: none; }
      .aca .scc-grid { grid-template-columns: 92px repeat(var(--cols), minmax(112px, 1fr)) 70px; min-width: calc(162px + var(--cols) * 112px); }
      .aca .sc-sum table { min-width: 0; width: 100%; }
    }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    const root = el("panel-schedule");
    root.innerHTML =
      '<div class="sc-bar">' +
        '<button type="button" class="small" data-v="prev" aria-label="Earlier">&lsaquo;</button><button type="button" class="small" data-v="today">Today</button><button type="button" class="small" data-v="next" aria-label="Later">&rsaquo;</button>' +
        '<select class="small" id="aca-scJump" aria-label="Jump to a week"></select>' +
        '<h2 id="aca-scTitle">Schedule</h2>' +
        '<div class="seg" role="radiogroup" aria-label="View"><label class="sc-listopt"><input type="radio" name="aca-scView" value="list" /><span>List</span></label><label><input type="radio" name="aca-scView" value="week" checked /><span>Week</span></label><label><input type="radio" name="aca-scView" value="day" /><span>Day</span></label><label class="sc-wide"><input type="radio" name="aca-scView" value="weeks2" /><span>2 weeks</span></label><label><input type="radio" name="aca-scView" value="month" /><span>Month</span></label><label><input type="radio" name="aca-scView" value="weeks8" /><span>8 weeks</span></label></div>' +
        '<span class="grow"></span>' +
        '<button type="button" class="small sc-keybtn" data-v="key" aria-expanded="false">Colors</button>' +
        '<div class="sc-legend"><span><i class="sc-k-job"></i>On site job</span><span><i class="sc-k-drive"></i>Drive</span><span><i class="sc-k-setup"></i>Setup / teardown</span><span><i class="sc-k-studio"></i>Studio</span><span><i class="sc-k-admin"></i>Admin</span><span><i class="sc-k-flex"></i>Flex</span><span><i class="sc-k-work"></i>Other</span><span><i class="sc-k-off"></i>Time off</span><span><i class="sc-k-gcal"></i>Google Calendar</span></div>' +
        '<button type="button" class="small sc-ed" data-v="studio">Drive &amp; setup</button>' +
        '<button type="button" class="small sc-ed" data-v="crewset">Crew settings</button>' +
        '<button type="button" class="small sc-ed" data-v="weekmail">Email the week</button>' +
        '<button type="button" class="small sc-ed sc-chg hidden" data-v="changes" id="aca-scChg">View schedule</button>' +
        '<button type="button" class="primary sc-ed" data-v="add">Add time</button>' +
        '<button type="button" class="primary sc-flexbtn hidden" data-v="addflex">Add flex time</button>' +
      "</div>" +
      // Schedule views (2026-10-24): what's shown, the problems list, the map and the phone calendar link
      '<div class="sc-bar2">' +
        '<label class="sc-opt sc-mineopt"><input type="checkbox" id="aca-scMine" /> Just me</label>' +
        '<label class="sc-opt sc-mineopt sc-waitopt" title="Only jobs where someone hasn&#39;t answered yet"><input type="checkbox" id="aca-scWait" /> Still waiting</label>' +
        '<label class="sc-opt sc-needopt" title="Only jobs that still need people"><input type="checkbox" id="aca-scNeedOnly" /> Needs people</label>' +
        '<label class="sc-opt" id="aca-scGcalOpt"><input type="checkbox" id="aca-scGcal" checked /> Google Calendar <span class="s" id="aca-scGcalAge"></span></label>' +
        '<label class="sc-opt sc-scaleopt" title="Bars drawn to the hour, with drive, setup and the capacity strip, instead of cards"><input type="checkbox" id="aca-scScale" /> To scale</label>' +
        '<label class="sc-opt sc-mapopt"><input type="checkbox" id="aca-scMapOn" /> Map</label>' +
        '<label class="sc-opt sc-colopt">Color by <select id="aca-scColor" class="small"><option value="kind">Kind</option><option value="status">Status</option><option value="type">Job type</option><option value="person">Person</option></select></label>' +
        '<button type="button" class="small sc-probbtn" data-v="problems" id="aca-scProbBtn" aria-expanded="false">Problems</button>' +
        '<span class="grow"></span>' +
        '<button type="button" class="small sc-calbtn hidden" data-v="cal">Phone calendar</button>' +
      "</div>" +
      '<div id="aca-scColKey" class="sc-colkey hidden"></div>' +
      '<div id="aca-scProblems" class="sc-problems hidden"></div>' +
      '<div id="aca-scErr" class="inline-error hidden"></div>' +
      '<div id="aca-scWarn" class="sc-warn hidden"></div>' +
      '<div id="aca-scWeeks"></div>' +
      '<p class="sc-swipe hidden" id="aca-scSwipe">Swipe sideways for more days &rsaquo;</p>' +
      '<div class="sc-main"><div class="sc-scroll"><div id="aca-scGrid"><p class="empty" style="padding:16px">Loading&#8230;</p></div></div>' +
      '<aside class="sc-map hidden" id="aca-scMap" aria-label="Map"></aside></div>' +
      // Rarely needed (Jeremiah 2026-10-24): folded until opened; the 8 weeks view opens it for Busiest days.
      '<details class="sc-more" id="aca-scMore"><summary>Hours scheduled and busiest days</summary>' +
      '<div class="sc-sum hidden" id="aca-scSum"></div>' +
      '<div class="sc-sum hidden" id="aca-scPeak"></div></details>' +
      '<details class="sc-help"><summary>How the schedule works</summary><p>Weeks run Sunday to Saturday. Hours count jobs, drive time, setup, teardown and work, not time off, against each person&#39;s default hours per week (set on the Team page). A day of 6 hours or more is marked &#8220;lunch&#8221;: plan a lunch break. <span class="sc-ed">Click an empty spot to add time; click a job under Jobs not assigned to put people on it. To add someone to a job that already has people, click its blue bar and choose More people. Every job has setup before it and teardown after it (light blue). When a crew does two jobs in one trip, right-click a job (on a phone, press and hold it) and choose Batch with another job: the drive then goes from the studio to the first job, job to job, and back from the last one. A dashed line joins the jobs of a trip. People with a home address on the Team page start and end at home; anyone without one starts at the studio.</span> Putting someone on a job just puts them on it. To ask several people at once, use Ask who&#39;s available on the job: they say if they can make it and you pick one. If Ask people to confirm is turned on (Settings, Scheduling), people put on a booked job also get an email to confirm it: a white &#10003; on the bar means confirmed, a yellow ? means still waiting, and someone who can&#39;t make it comes off the job. The strip under the days counts who is free against the people the day&#39;s jobs still need. Flex time is for work that isn&#39;t tied to a set hour: everyone can add and move their own. Events on the 207 Photo Booking Google Calendar that aren&#39;t bookings show under From Google Calendar (bookings are never shown twice), and ones named like &#8220;Ryan Off&#8221; show as that person&#39;s time off. Untick Google Calendar to hide them.</p>' +
        '<p>Week and 2 weeks show a card for each job and time with the drive and who has answered; Day shows bars to scale with when each person leaves and gets back, and a line at the time now. Month shows every job colored by whether it still needs people (red), is waiting on an answer (yellow) or is covered (blue); click a day to open it or the week total to open the week. Problems lists things to look at from today on: jobs short of people or with no start time, two things at once, someone on a job during time off, long drives, very long days, bad weather for an outdoor job, and Google Calendar events nobody is on. Color by changes the bar colors. Map shows where the jobs are, and on Day each person&#39;s route. <span class="sc-ed">View schedule shows the email a person would get with their next two weeks (days that changed since they were last told are marked) and sends it to them from there.</span> Each job&#39;s Lead (or its Editor, picked on the job page) gets Flex time for editing (an hour for the first hour of shooting, 30 minutes for each hour after), due 24 hours after the shoot. It goes right after they get home if there&#39;s room before 9pm and their day stays at 8 hours or less, otherwise the next morning after a 12 hour break; they can move it. Phone calendar gives you a link that puts your own schedule in your phone&#39;s calendar.</p></details>';

    const narrow = () => window.innerWidth < 760;
    // Phones open on a list of today and tomorrow (2026-10-23, Jeremiah's pick); the grids are one tap away.
    let view = narrow() ? "list" : "week";
    let anchor = T.today();       // the day shown in day view; its week in week view
    let data = null, mineOnly = false, waitOnly = false, loading = 0;
    let highlight = null;     // a day picked from the 8 weeks view or Busiest days, outlined in the week
    let pendingAssign = null; // a job picked from the 8 weeks view: open its assign dialog once its week is loaded
    root.querySelector('input[name="aca-scView"][value="' + view + '"]').checked = true;
    // Schedule views (2026-10-24): remembered per browser. Google Calendar events on (Jeremiah: a show/hide tick, to
    // catch anything that didn't go through booking), map off, colored by kind.
    const pref = (k, dflt) => { try { const v = localStorage.getItem("aca-sc-" + k); return v == null ? dflt : v; } catch (_e) { return dflt; } };
    const setPref = (k, v) => { try { localStorage.setItem("aca-sc-" + k, String(v)); } catch (_e) { /* private mode */ } };
    let gcalOn = pref("gcal", "1") === "1", mapOn = pref("map", "0") === "1", colorBy = pref("color", "kind"), scaleOn = pref("scale", "0") === "1", needOnly = false, probOpen = false;
    el("scMore").open = pref("more", "0") === "1";
    el("scMore").addEventListener("toggle", () => { if (view !== "weeks8") setPref("more", el("scMore").open ? 1 : 0); });
    el("scScale").checked = scaleOn; el("scGcal").checked = gcalOn; el("scMapOn").checked = mapOn; el("scColor").value = colorBy;
    // The days each view loads: a week (the list needs the next day too), two weeks, or the whole weeks of a month.
    function rangeFor(v, a) {
      if (v === "month") { const first = a.slice(0, 8) + "01", s0 = T.weekStart(first), last = T.addDays(T.addDays(first, 32).slice(0, 8) + "01", -1); return { start: s0, days: T.daysBetween(s0, T.addDays(T.weekStart(last), 7)) }; }
      return { start: T.weekStart(a), days: v === "list" ? 8 : v === "weeks2" ? 14 : 7 };
    }

    const editable = () => !!(data && data.can_edit);
    // Without Scheduling edit you can still add, move and remove your own flex time.
    const isMine = (id) => !!(data && data.me && id === data.me);
    const canChange = (e) => !e.gcal && (editable() || (e.kind === "flex" && isMine(e.user_id)));
    const personName = (id) => { const p = data && data.people.find((x) => x.user_id === id); return p ? p.name : "Someone"; };
    const bookingLabel = (b) => b.title + (b.day_label ? " (" + b.day_label + ")" : "");
    // A school's makeup day (booking_days kind makeup) can start out with no time. The first time given to it here
    // (assigning, or changing a crew bar) becomes the makeup day's own time, so the calendar event gets it too.
    const untimedMakeup = (b) => !!b && b.day_label === "Makeup day" && !b.start_at;
    async function setMakeupTime(b, st, et) {
      const { error } = await sb.rpc("booking_set_makeup", { p_booking: b.booking_id, p: { day: b.day, start_time: st, end_time: et } });
      if (error) throw error;
    }
    const shortTitle = (s) => String(s || "").split(" \u2022 ")[0];
    // Bulk assign (2026-10-23): Ctrl / Cmd / Shift-click jobs under Jobs not assigned (or turn on "Pick several",
    // which phones need) to pick several, then put the same people on all of them at once. Picks are kept by
    // booking + day, across weeks, until they're assigned or cleared.
    const bulk = new Map();
    let bulkMode = false;
    const bulkKey = (id, day) => id + "|" + day;
    const selCls = (b, d) => (bulk.has(bulkKey(b.booking_id, d)) ? " sel" : "");
    const pickManyBtn = () => editable() ? '<button type="button" class="sc-pickmany" data-bulkmode>' + (bulkMode ? "Done picking" : "Pick several") + "</button>" : "";

    async function load() {
      if (view === "weeks8") return loadWeeks();
      const my = ++loading;
      clearError("scErr");
      const { start, days: span } = rangeFor(view, anchor);
      fillJump();
      try {
        // The list shows the anchor day and the next one, which can be the Sunday after this week.
        const { data: d, error } = await sb.rpc("schedule_week", { p_start: start, p_days: span });
        if (error) throw error;
        if (my !== loading) return;
        // B3: a copy, so the "X Off" bars below are never pushed into the RPC result itself
        data = Object.assign({}, d, { start, span, entries: (d.entries || []).slice() });
        data.crew = Object.assign({ roles: [], needed: {}, declined: [], requests: [], settings: {} }, d.crew || {});
        (d.people || []).forEach((p) => { p.name = T.shortName(p.name); });
        // Time off someone asked for and nobody has answered yet: a faded bar on their row (not counted as hours)
        data.asked = (data.crew.requests || []).map((r) => ({ id: "req:" + r.id, user_id: r.user_id, kind: "asked", booking_id: null, drive_before_min: 0, drive_after_min: 0,
          starts_at: T.toIso(r.first_day, r.start_time || "00:00"), ends_at: r.start_time ? T.toIso(r.first_day, r.end_time) : T.toIso(T.addDays(r.last_day, 1), "00:00"), title: r.note || "", note: "", request: r }));
        // "Ryan Off" on the Google Calendar: time off on that person's row (read only; change it in Google)
        (d.calendar || []).filter((c) => c.off_user).forEach((c) => data.entries.push({ id: "gcal:" + c.event_id, user_id: c.off_user, kind: "off", booking_id: null,
          starts_at: c.all_day || !c.start_at ? T.toIso(c.start_date, "00:00") : c.start_at, ends_at: c.all_day || !c.end_at ? T.toIso(T.addDays(c.end_date, 1), "00:00") : c.end_at,
          drive_before_min: 0, drive_after_min: 0, title: c.summary, note: "", gcal: c }));
        render();
        loadPeak();
        openPending();
        loadChanges();
      } catch (e) {
        if (my !== loading) return;
        showError("scErr", "Could not load the schedule: " + cleanErr(e));
      }
    }

    // Busiest days in the next 8 weeks (for seasonal hiring): jobs, people needed, and who is free.
    let peakFor = "";
    async function loadPeak() {
      const box = el("scPeak");
      if ((narrow() && view !== "weeks8") || peakFor === T.today()) return;
      try {
        const { data: c, error } = await sb.rpc("crew_capacity", { p_from: T.today(), p_days: 56 });
        if (error) throw error;
        peakFor = T.today();
        const days = (c.days || []).map((d) => Object.assign(d, { free: c.team - d.off - d.asked_off })).sort((a, b) => b.needed - a.needed || a.free - b.free || (a.day < b.day ? -1 : 1)).slice(0, 8);
        box.classList.toggle("hidden", !days.length);
        box.innerHTML = '<h3>Busiest days, next 8 weeks</h3><div class="table-wrap"><table class="sc-peak"><thead><tr><th>Day</th><th>Jobs</th><th>People needed</th><th>On jobs now</th><th>Off</th><th>Asked off</th><th>Free</th></tr></thead><tbody>' +
          days.map((d) => { const lvl = d.needed > d.free ? "red" : d.needed === d.free ? "amber" : "";
            return '<tr><td><button type="button" class="link" data-peak="' + esc(d.day) + '">' + esc(T.fmtDay(d.day)) + "</button></td><td>" + num(d.jobs) + "</td><td>" + num(d.needed) + "</td><td>" + num(d.on_jobs) + "</td><td>" + num(d.off) + "</td><td>" + num(d.asked_off) +
              '</td><td class="' + lvl + '">' + num(d.free) + (lvl === "red" ? " (short " + num(d.needed - d.free) + ")" : "") + "</td></tr>"; }).join("") +
          '</tbody></table></div><p class="sc-note">Free = everyone on the team minus time off (approved or asked for). Red: the jobs need more people than are free. Click a day to see its week.</p>';
      } catch (_e) { box.classList.add("hidden"); }
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
      const s = new Date(e.starts_at).getTime(), en = new Date(e.ends_at).getTime(), su = num(e.setup_min) * 6e4, td = num(e.teardown_min) * 6e4;
      const segs = e.kind === "job"
        ? [["drive", s - su - e.drive_before_min * 6e4, s - su], ["setup", s - su, s], ["job", s, en], ["setup", en, en + td], ["drive", en + td, en + td + e.drive_after_min * 6e4]]
        : [[e.kind, s, en]];
      const dayStart = new Date(T.toIso(day, "00:00")).getTime(), dayEnd = new Date(T.toIso(T.addDays(day, 1), "00:00")).getTime();
      return segs.filter((g) => g[2] > g[1] && g[1] < dayEnd && g[2] > dayStart).map((g) => ({
        part: g[0], from: Math.max(0, Math.round((Math.max(g[1], dayStart) - dayStart) / 6e4)), to: Math.min(1440, Math.round((Math.min(g[2], dayEnd) - dayStart) / 6e4)),
      }));
    }
    const hoursOf = (e) => e.kind === "off" ? 0 : (new Date(e.ends_at) - new Date(e.starts_at)) / 36e5 + (e.drive_before_min + e.drive_after_min + num(e.setup_min) + num(e.teardown_min)) / 60;
    // A bar's full time out: leave (drive + setup before the start) to back (teardown + drive after the end).
    const outAt = (e) => new Date(e.starts_at).getTime() - (e.drive_before_min + num(e.setup_min)) * 6e4;
    const backAt = (e) => new Date(e.ends_at).getTime() + (e.drive_after_min + num(e.teardown_min)) * 6e4;
    // The other bars of a bar's trip, in order (itself included).
    const tripOf = (e) => e.batch_id ? data.entries.filter((x) => x.batch_id === e.batch_id).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)) : [e];
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

    // ---------------------------------------------------------------- crew counts
    // Ask people to confirm (Settings, Scheduling) is off by default: putting someone on a job just assigns it.
    const confirmOn = () => !!(data && data.crew && data.crew.settings && data.crew.settings.crew_confirm_on === true);
    const neededOf = (bookingId) => num((data.crew.needed || {})[bookingId]) || 1;
    // people on a booking that day
    const staffedCount = (bookingId, d) => new Set(data.entries.filter((e) => e.booking_id === bookingId && T.local(e.starts_at).day <= d && T.local(e.ends_at).day >= d).map((e) => e.user_id)).size;
    function capacityOn(d) {
      const dayStart = new Date(T.toIso(d, "00:00")).getTime(), dayEnd = new Date(T.toIso(T.addDays(d, 1), "00:00")).getTime();
      const touches = (e) => new Date(e.starts_at).getTime() < dayEnd && new Date(e.ends_at).getTime() > dayStart;
      const off = new Set(data.entries.filter((e) => e.kind === "off" && touches(e)).map((e) => e.user_id));
      const asked = new Set((data.asked || []).filter((e) => touches(e) && !off.has(e.user_id)).map((e) => e.user_id));
      const onJobs = new Set(data.entries.filter((e) => e.kind === "job" && touches(e)).map((e) => e.user_id));
      const jobs = data.bookings.filter((b) => b.day === d && b.status === "booked");
      const need = jobs.reduce((n, b) => n + Math.max(0, neededOf(b.booking_id) - staffedCount(b.booking_id, d)), 0);
      const available = data.people.filter((p) => !off.has(p.user_id)).length;
      const free = data.people.filter((p) => !off.has(p.user_id) && !asked.has(p.user_id) && !onJobs.has(p.user_id)).length;
      return { jobs: jobs.length, off: off.size, asked: asked.size, onJobs: onJobs.size, available, free, need, short: need - free, spare: free - need };
    }

    // ---------------------------------------------------------------- render
    function render() {
      if (root.classList.contains("sc-w8")) el("scMore").open = pref("more", "0") === "1";
      root.classList.remove("sc-w8");
      root.classList.toggle("sc-islist", view === "list");
      renderChrome();
      if (view === "list") return renderList();
      if (view === "month") return renderMonth();
      if (view === "weeks2" || (view === "week" && !scaleOn)) return renderCards();
      const start = data.start, today = T.today();
      const days = view === "week" ? [0, 1, 2, 3, 4, 5, 6].map((i) => T.addDays(start, i)) : [anchor];
      el("scTitle").textContent = view === "week"
        ? T.fmtDay(days[0]) + " \u2013 " + T.fmtDay(days[6])
        : T.fmtDay(anchor, { calendar: true });
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
      // B2: on a phone the week is wider than the screen; say so until they swipe
      const sw = narrow() && view === "week", scr = root.querySelector(".sc-scroll");
      el("scSwipe").classList.toggle("hidden", !sw);
      scr.classList.toggle("fade", sw);
      if (sw) scr.scrollLeft = 0;

      let h = '<div class="sc-head sc-name">' + (view === "week" ? "Team" : "") + "</div>";
      days.forEach((d) => {
        h += '<div class="sc-head' + (d === today ? " today" : "") + (d === highlight && view === "week" ? " hl" : "") + '">' + (view === "week" ? '<button type="button" class="link" data-day="' + d + '">' + esc(T.fmtDay(d, { calendar: true })) + "</button>" : esc(T.fmtDay(d, { calendar: true }))) +
          (view === "day" ? dayPills(d) : "") + '<div class="sc-ticks">' + ticks() + "</div></div>";
      });
      // Capacity: per day, who is free (not off) against the people that day's jobs still need.
      if (data.people.length && !mineOnly) {
        h += '<div class="sc-name sc-cap"><b>Capacity</b></div>';
        days.forEach((d) => {
          const c = capacityOn(d), lvl = !c.jobs ? "quiet" : c.short > 0 ? "red" : c.need > 0 && c.spare <= 0 ? "amber" : "";
          h += '<div class="sc-cap ' + lvl + '" title="' + esc(c.available + " of " + data.people.length + " available (" + c.off + " off" + (c.asked ? ", " + c.asked + " asked off" : "") + "), " + c.onJobs + " on jobs, " + c.need + " more needed") + '">' +
            (c.jobs ? "<b>" + num(c.free) + " free</b> &middot; " + (c.need ? num(c.need) + " needed" + (c.short > 0 ? " (short " + num(c.short) + ")" : "") : "jobs covered") : num(c.available) + " available") + "</div>";
        });
      }
      // Jobs not assigned: a job stays in this lane until it has as many people as it needs that day.
      const open = data.bookings.filter((b) => days.includes(b.day) && staffedCount(b.booking_id, b.day) < neededOf(b.booking_id));
      h += '<div class="sc-name"><b>Jobs not assigned</b><span class="sc-hrs">' + (open.length ? num(open.length) + " this " + (view === "week" ? "week" : "day") + pickManyBtn() : "All jobs have someone") + "</span></div>";
      days.forEach((d) => {
        const list = open.filter((b) => b.day === d);
        h += '<div class="sc-jobs">' + list.map((b) => {
          const have = staffedCount(b.booking_id, d), need = neededOf(b.booking_id);
          const no = (data.crew.declined || []).filter((x) => x.booking_id === b.booking_id);
          return '<button type="button" class="sc-chip' + (b.status === "tracked" ? " tracked" : b.status === "booked" && !have ? " none" : have ? " part" : "") + selCls(b, d) + '" data-booking="' + esc(b.booking_id) + '" data-day="' + esc(d) + '" title="' + esc(bookingLabel(b) + (b.location ? "\n" + b.location : "") + no.map((x) => "\n" + T.shortName(x.name) + " can't make it" + (x.reason ? ": " + x.reason : "")).join("")) + '">' +
            esc(view === "week" ? shortTitle(b.title) : bookingLabel(b)) + "<small>" + esc(b.start_at ? T.fmtTs(b.start_at) + (b.end_at ? "\u2013" + T.fmtTs(b.end_at) : "") : "time not set yet") +
            (have ? ' <span class="sc-need">&middot; ' + num(have) + " of " + num(need) + "</span>" : need > 1 ? ' <span class="sc-need">&middot; needs ' + num(need) + "</span>" : "") + "</small>" +
            no.map((x) => '<span class="sc-no">' + esc(T.shortName(x.name)) + " can&#39;t make it</span>").join("") + "</button>"; }).join("") + "</div>";
      });
      // From Google Calendar: events that aren't bookings, until someone is on them ("X Off" ones are time off instead)
      const calOpen = gcalOn ? calOpenOn(days) : [];
      if (calOpen.length) {
        h += '<div class="sc-name"><b>From Google Calendar</b><span class="sc-hrs sc-hint">Not bookings' + (editable() ? "; click one to put people on it" : "") + "</span></div>";
        days.forEach((d) => {
          h += '<div class="sc-jobs">' + calOpen.filter((c) => d >= c.start_date && d <= c.end_date).map((c) =>
            '<button type="button" class="sc-chip gcal" data-gcal="' + esc(c.event_id) + '" data-day="' + esc(d) + '" title="' + esc(c.summary) + '">' + esc(c.summary) +
            "<small>" + esc(c.all_day || !c.start_at ? "all day" : T.fmtTs(c.start_at) + "\u2013" + T.fmtTs(c.end_at)) + "</small></button>").join("") + "</div>";
        });
      }
      // People
      const waiting = (e) => e.kind === "job" && e.confirm && e.confirm.status === "pending" && days.some((d) => piecesOn(e, d).length);
      const people = (mineOnly ? data.people.filter((p) => p.user_id === data.me) : data.people).filter((p) => !waitOnly || data.entries.some((e) => e.user_id === p.user_id && waiting(e)));
      if (!people.length) h += '<div class="sc-name"><span class="muted">' + (waitOnly ? "Everyone has answered." : mineOnly ? "You are not on the team list." : "Nobody on the team yet.") + "</span></div>" + days.map(() => "<div></div>").join("");
      people.forEach((p) => {
        const mine = data.entries.filter((e) => e.user_id === p.user_id);
        const rowBars = mine.concat((data.asked || []).filter((e) => e.user_id === p.user_id));
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
          rowBars.forEach((e) => {
            const ps = piecesOn(e, d);
            ps.forEach((x, i) => items.push(Object.assign(x, { entry: e, first: i === 0, last: i === ps.length - 1 })));
          });
          // lanes per entry (its pieces share a lane)
          // a batched trip is one block: its bars plus a dashed line for any wait between them
          const blocks = [];
          rowBars.forEach((e) => {
            const ps = items.filter((x) => x.entry === e); if (!ps.length) return;
            const into = e.batch_id && blocks.find((b) => b.entry.batch_id === e.batch_id);
            if (into) {
              const prev = into.ps.filter((x) => x.part !== "trip").reduce((a, x) => x.to > a.to ? x : a), from = Math.min(...ps.map((x) => x.from));
              if (from > prev.to) into.ps.push({ part: "trip", from: prev.to, to: from, entry: e });
              if (from < prev.to) ps.forEach((x) => { x.late = true; });
              into.ps.push(...ps); into.from = Math.min(into.from, from); into.to = Math.max(into.to, ...ps.map((x) => x.to));
            } else blocks.push({ entry: e, from: Math.min(...ps.map((x) => x.from)), to: Math.max(...ps.map((x) => x.to)), ps });
          });
          const n = lanesFor(blocks);
          const tc = (data.tasks || []).find((t) => t.user_id === p.user_id && t.day === d);
          const dh = view === "week" ? T.workHours(mine, d) : 0;
          let bars = "";
          blocks.forEach((bk) => bk.ps.forEach((x) => {
            const e = x.entry, isDrive = x.part === "drive", isSetup = x.part === "setup", isTrip = x.part === "trip", isBar = !isDrive && !isSetup && !isTrip;
            const trip = e.batch_id ? tripOf(e) : null, stop = trip ? trip.indexOf(e) : -1;
            const cf = e.kind === "job" && e.confirm ? e.confirm.status : null;
            const label = !isBar ? "" : e.kind === "asked" ? "Asked off" + (e.title ? ": " + e.title : "") : e.kind === "job" ? (view === "week" ? shortTitle(e.booking_title) : e.booking_title + (e.role ? " (" + e.role + ")" : "")) : e.kind !== "off" ? (e.title || KIND[e.kind]) : "Off" + (e.title ? ": " + e.title : "");
            const tip = (e.kind === "asked" ? "Asked for time off (not answered yet)" : e.kind === "off" ? "Time off" : T.fmtTs(e.starts_at) + "\u2013" + T.fmtTs(e.ends_at)) + " " + (e.kind === "job" ? e.booking_title : e.kind !== "off" ? (e.title || KIND[e.kind] || "") : e.title) +
              (e.role ? "\nRole: " + e.role : "") + (cf ? "\n" + (cf === "confirmed" ? "Confirmed" : e.confirm.asked_at ? "Asked, no answer yet" : "Will be asked to confirm in a few minutes") : "") +
              (e.kind === "job" ? "\nSetup " + num(e.setup_min) + " min, teardown " + num(e.teardown_min) + " min" : "") +
              (e.kind === "job" && (e.drive_before_min || e.drive_after_min) ? "\nDrive " + e.drive_before_min + " min there" + (stop > 0 ? " (from the last job)" : "") + ", " + e.drive_after_min + " min back" : "") +
              (trip ? "\nStop " + (stop + 1) + " of " + trip.length + " on a batched trip" : "") + (x.late ? "\nNot enough time to get here from the last job" : "") +
              dueTip(e) + (e.note ? "\n" + e.note : "") + (bk.clash ? "\nOverlaps another bar" : "") + (editable() && e.kind === "job" ? "\nRight-click or press and hold to batch" : "");
            const cls = "sc-b " + (isTrip ? "trip" : "sc-k-" + (isDrive ? "drive" : isSetup ? "setup" : e.kind)) + (isDrive ? " drive" + (x.first ? " first" : "") + (x.last ? " last" : "") : "") + (isSetup ? " setup" : "") +
              (e.kind === "job" && isBar && x.part === "job" ? " job mid" : "") + (trip ? " batched" : "") + (x.late && x.part === "job" ? " late" : "") + (bk.clash && e.kind !== "asked" ? " clash" : "") + (e.booking_status === "cancelled" ? " cancelled" : "") +
              (e.kind === "asked" ? " asked" : "") + (waitOnly && !waiting(e) ? " dim" : "");
            const mark = isBar && cf === "confirmed" ? '<i class="sc-cf ok" aria-hidden="true">\u2713</i>' : isBar && cf === "pending" ? '<i class="sc-cf wait" aria-hidden="true">?</i>' : "";
            const col = isBar && e.kind === "job" ? colorOf(e) : null, st = isBar && e.kind === "job" && d === today ? dayStatus(e) : null;
            bars += '<button type="button" class="' + cls + '" data-entry="' + esc(e.id) + '" style="left:' + pct(x.from) + ";width:calc(" + pct(x.to) + " - " + pct(x.from) + ");top:" + (6 + bk.lane * 26) + "px" + (col ? ";background:" + col + ";color:#fff" : "") + '" title="' + esc(tip + (st ? "\n" + st.text : "")) + '" aria-label="' + esc(tip + (st ? ". " + st.text : "")) + '">' +
              (st ? '<i class="sc-st ' + st.cls + '" aria-hidden="true"></i>' : "") + mark + esc(label) + "</button>";
          }));
          // Day view: when they leave and get back, printed under the line, and the time now on today.
          let edge = "";
          if (view === "day") {
            const jobs = mine.filter((e) => e.kind === "job" && piecesOn(e, d).length);
            if (jobs.length) {
              const lv = Math.min(...jobs.map(outAt)), bk = Math.max(...jobs.map(backAt)), from = p.from_home ? "home" : "the studio";
              const lvp = (T.local(lv).min - win.lo) / span;
              edge = '<span class="sc-edge' + (lvp < 0.2 ? " near" : "") + '" style="left:' + pct(T.local(lv).min) + '">leave ' + esc(from) + " " + esc(T.fmtTs(lv)) + "</span>" +
                '<span class="sc-edge end" style="left:' + pct(T.local(bk).min) + '">back ' + esc(T.fmtTs(bk)) + "</span>";
            }
            if (d === today) { const nm = T.local(Date.now()).min; if (nm > win.lo && nm < win.hi) edge += '<i class="sc-now" style="left:' + pct(nm) + '" aria-hidden="true"></i>'; }
          }
          h += '<div class="sc-cell' + (editable() || isMine(p.user_id) ? " edit" : "") + (view === "day" ? " grid" : "") + (d === today && view === "week" ? " today" : "") + '" data-person="' + esc(p.user_id) + '" data-day="' + esc(d) + '" style="min-height:' + (n * 26 + (edge ? 30 : 18)) + 'px">' + bars + edge +
            (dh > 0 ? '<span class="sc-dh' + (dh >= T.LUNCH_AFTER_H ? " sc-lunch" : "") + '"' + (dh >= T.LUNCH_AFTER_H ? ' title="6 hours or more: plan a lunch break"' : "") + ">" + fmtH(dh) + " h" + (dh >= T.LUNCH_AFTER_H ? " &middot; lunch" : "") + "</span>" : "") +
            (tc ? '<a class="sc-tasks" href="#staff/myday/' + d + '" title="Open My day for ' + T.fmtDay(d) + '">' + num(tc.n) + " task" + (tc.n === 1 ? "" : "s") + "</a>" : "") + "</div>";
        });
      });
      grid.innerHTML = h;
      renderSummary(people);
    }

    // Hours per person per day, and the week against their target.
    // List (phones): the day on screen and the next, each with the jobs nobody is on yet, then each person's day in
    // time order with full job names, place, role and whether they've confirmed. Taps open the same dialogs as the grid.
    function renderList() {
      const today = T.today(), days = [anchor, T.addDays(anchor, 1)];
      el("scTitle").textContent = T.fmtDay(anchor, { calendar: true });
      root.querySelectorAll(".sc-ed").forEach((n) => n.classList.toggle("hidden", !editable()));
      root.querySelector(".sc-flexbtn").classList.toggle("hidden", editable() || !data.people.some((p) => isMine(p.user_id)));
      const warn = el("scWarn");
      warn.classList.toggle("hidden", !(editable() && !data.studio_address));
      warn.innerHTML = 'Add the studio address so drive times can be looked up from Google Maps. <button type="button" class="link" data-v="studio">Add it</button>';
      el("scSwipe").classList.add("hidden");
      root.querySelector(".sc-scroll").classList.remove("fade");
      el("scSum").classList.add("hidden");
      const grid = el("scGrid"); grid.className = "sc-list"; grid.removeAttribute("style");
      const when = (e) => e.kind === "off" || e.kind === "asked" ? "" : T.fmtTs(e.starts_at) + "\u2013" + T.fmtTs(e.ends_at);
      const waiting = (e) => e.kind === "job" && e.confirm && e.confirm.status === "pending";
      let h = "";
      days.forEach((d) => {
        h += '<section class="scl-day"><h3>' + (d === today ? "Today, " : d === T.addDays(today, 1) ? "Tomorrow, " : "") + esc(T.fmtDay(d, { calendar: true })) + "</h3>";
        const open = data.bookings.filter((b) => b.day === d && staffedCount(b.booking_id, d) < neededOf(b.booking_id));
        if (open.length) h += '<div class="scl-open"><div class="scl-lbl">Nobody on it yet' + pickManyBtn() + "</div>" + open.map((b) => {
          const have = staffedCount(b.booking_id, d), need = neededOf(b.booking_id);
          return '<button type="button" class="scl-item open' + selCls(b, d) + '" data-booking="' + esc(b.booking_id) + '" data-day="' + esc(d) + '"><span class="t">' + esc(b.start_at ? T.fmtTs(b.start_at) + (b.end_at ? "\u2013" + T.fmtTs(b.end_at) : "") : "Time not set") + "</span>" +
            '<span class="w"><b>' + esc(bookingLabel(b)) + "</b>" + (b.location ? "<small>" + esc(b.location) + "</small>" : "") + "<small>" + (have ? num(have) + " of " + num(need) + " people" : need > 1 ? "Needs " + num(need) + " people" : "Needs someone") + "</small></span></button>";
        }).join("") + "</div>";
        const people = (mineOnly ? data.people.filter((p) => p.user_id === data.me) : data.people);
        const free = [];
        people.forEach((p) => {
          const mine = data.entries.filter((e) => e.user_id === p.user_id).concat((data.asked || []).filter((e) => e.user_id === p.user_id))
            .filter((e) => piecesOn(e, d).length && (!waitOnly || waiting(e))).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
          if (!mine.length) { free.push(p.name); return; }
          const hrs = T.workHours(mine.filter((e) => e.kind !== "asked"), d);
          // Route line (Schedule views 2026-10-24): when they leave, how the day's driving goes, when they're back.
          const jobs = mine.filter((e) => e.kind === "job" && T.local(e.starts_at).day === d);
          const drv = jobs.reduce((a, e) => a + num(e.drive_before_min) + num(e.drive_after_min), 0);
          const route = jobs.length ? '<div class="scl-trip">Leave ' + (p.from_home ? "home" : "the studio") + " <b>" + esc(T.fmtTs(Math.min(...jobs.map(outAt)))) + "</b>" +
            (drv ? " &middot; " + esc(fmtMins(drv)) + " driving" : "") + (jobs.length > 1 ? " &middot; " + num(jobs.length) + " jobs" : "") + " &middot; back <b>" + esc(T.fmtTs(Math.max(...jobs.map(backAt)))) + "</b></div>" : "";
          h += '<div class="scl-person"><div class="scl-lbl"><b>' + esc(p.name) + "</b>" + (hrs ? " &middot; " + fmtH(hrs) + " h" + (hrs >= T.LUNCH_AFTER_H ? ' <span class="sc-lunch">&middot; lunch</span>' : "") : "") + "</div>" + route +
            mine.map((e) => {
              const title = e.kind === "job" ? e.booking_title : e.kind === "asked" ? "Asked off" + (e.title ? ": " + e.title : "") : e.kind === "off" ? "Off" + (e.title ? ": " + e.title : "") : (e.title || KIND[e.kind]);
              const cf = e.kind === "job" && e.confirm ? e.confirm.status : null;
              const wx = e.kind === "job" ? wxOf(data.bookings.find((x) => x.booking_id === e.booking_id && x.day === d)) : null, st = e.kind === "job" && d === today ? dayStatus(e) : null;
              const sub = [esc(e.role || ""), e.kind === "job" && e.drive_before_min ? num(e.drive_before_min) + " min drive" : "", e.kind !== "job" && e.kind !== "off" && e.kind !== "asked" ? KIND[e.kind] : "",
                wx ? '<span class="sc-wx">' + esc(wx.text) + "</span>" : "", st ? esc(st.text) : "",
                e.edit_due ? (pastDue(e) ? '<span class="sc-late">due ' + esc(dueAt(e)) + "</span>" : "due " + esc(dueAt(e))) : ""].filter(Boolean).join(" &middot; ");
              return '<button type="button" class="scl-item scl-k-' + esc(e.kind) + (e.booking_status === "cancelled" ? " cancelled" : "") + '" data-entry="' + esc(e.id) + '"><span class="t">' + esc(when(e) || "All day") + "</span>" +
                '<span class="w"><b>' + esc(title) + "</b>" + (sub ? "<small>" + sub + "</small>" : "") +
                (cf === "confirmed" ? '<small class="ok">Confirmed</small>' : cf === "pending" ? '<small class="wait">Hasn&#39;t confirmed yet</small>' : "") + "</span></button>";
            }).join("") + "</div>";
        });
        if (free.length && !waitOnly) h += '<p class="scl-free">Nothing scheduled: ' + free.map(esc).join(", ") + "</p>";
        if (!open.length && free.length === people.length) h += '<p class="scl-free">No jobs or time on the schedule.</p>';
        h += "</section>";
      });
      grid.innerHTML = h;
    }
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

    // ---------------------------------------------------------------- schedule views (2026-10-24)
    // From the scheduling software comparison (https://claude.ai/artifact/Xc2SyfFZR2WFgszRMh1W8C), Jeremiah: "go".
    // Week and 2 weeks show a card per bar (time, name, drive, answer) instead of tiny to-scale bars; Month is a
    // calendar; the day view prints leave / back times and the time now; a Problems list; weather on outdoor
    // days; Color by; a map beside the day and week; Google Calendar events behind a show/hide tick; each
    // person's phone calendar link; and View schedule (each person's next two weeks as they'd get it, sent from there).
    const daysOf = () => Array.from({ length: data.span || 7 }, (_, i) => T.addDays(data.start, i));
    const PALETTE = ["#2f6db5", "#7b5cc4", "#1f8a84", "#c0603a", "#8a6d1f", "#b03a74", "#4a7a2c", "#5b6577"];
    const hashIdx = (s) => { let h = 0; for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % PALETTE.length; };
    // A booking day's state: needs people / someone hasn't answered (confirm on) / covered.
    function statusOf(bookingId, d) {
      if (staffedCount(bookingId, d) < neededOf(bookingId)) return "need";
      if (confirmOn() && data.entries.some((e) => e.booking_id === bookingId && e.kind === "job" && T.local(e.starts_at).day === d && e.confirm && e.confirm.status === "pending")) return "wait";
      return "ok";
    }
    const STATUS = { need: ["#c2412d", "Needs people"], wait: ["#b07a00", "Someone hasn't answered"], ok: ["#2f6db5", "Covered"] };
    // The color of a job under "Color by" (null = the usual kind colors).
    function colorOf(e) {
      if (colorBy === "kind" || e.kind !== "job") return null;
      if (colorBy === "status") return STATUS[statusOf(e.booking_id, T.local(e.starts_at).day)][0];
      if (colorBy === "person") return PALETTE[hashIdx(e.user_id)];
      const b = data.bookings.find((x) => x.booking_id === e.booking_id);
      return PALETTE[hashIdx((b && b.type_label) || "")];
    }
    function colorKey() {
      const box = el("scColKey");
      if (colorBy === "kind" || view === "weeks8") { box.classList.add("hidden"); return; }
      let items = [];
      if (colorBy === "status") items = Object.keys(STATUS).filter((k) => k !== "wait" || confirmOn()).map((k) => STATUS[k]);
      if (colorBy === "person") items = data.people.map((p) => [PALETTE[hashIdx(p.user_id)], p.name]);
      if (colorBy === "type") items = [...new Set(data.bookings.map((b) => b.type_label || ""))].map((t) => [PALETTE[hashIdx(t)], t || "No type"]);
      box.innerHTML = items.map(([c, t]) => '<span><i style="background:' + c + '"></i>' + esc(t) + "</span>").join("");
      box.classList.toggle("hidden", !items.length);
    }
    // Weather for an outdoor job, when the forecast check has looked (1 to 3 days out).
    function wxOf(b) {
      const w = b && b.weather; if (!w || b.shoot_setting === "indoors") return null;
      const parts = [w.pop >= 20 ? "Rain " + num(w.pop) + "%" : "", w.gust > 25 ? "Gusts " + num(w.gust) + " mph" : ""].filter(Boolean);
      return parts.length ? { text: parts.join(", "), bad: !!w.bad } : null;
    }
    // Day header pills: jobs, how many still need people, the weather.
    function dayPills(d) {
      const jobs = data.bookings.filter((b) => b.day === d && b.status !== "tracked");
      const need = jobs.reduce((n, b) => n + Math.max(0, neededOf(b.booking_id) - staffedCount(b.booking_id, d)), 0);
      const c = jobs.length ? capacityOn(d) : null;
      const wx = jobs.map(wxOf).filter(Boolean);
      return '<span class="sc-pills">' + (jobs.length ? '<span class="sc-pill">' + num(jobs.length) + " job" + (jobs.length === 1 ? "" : "s") + "</span>" : '<span class="sc-pill quiet">no jobs</span>') +
        (need ? '<span class="sc-pill bad" title="' + esc(c ? c.free + " free, " + need + " more needed" : "") + '">needs ' + num(need) + (c && c.short > 0 ? ", short " + num(c.short) : "") + "</span>" : "") +
        (wx.length ? '<span class="sc-pill wx" title="Forecast for the outdoor job' + (wx.length > 1 ? "s" : "") + '">' + esc(wx[0].text) + "</span>" : "") + "</span>";
    }
    // Google Calendar events that aren't bookings, not time off, and nobody has been put on yet.
    const calOpenOn = (days) => (data.calendar || []).filter((c) => !c.off_user && !data.entries.some((e) => e.gcal_event_id === c.event_id) && days.some((d) => d >= c.start_date && d <= c.end_date));
    // Today, from the time clock: clocked in on this job, or done; late when the job started and nobody clocked in.
    function dayStatus(e) {
      const ps = (data.punches || []).filter((p) => p.user_id === e.user_id && (p.booking_id === e.booking_id || !p.booking_id) && new Date(p.clock_in) < backAt(e) && (!p.clock_out || new Date(p.clock_out) > outAt(e)));
      if (ps.some((p) => !p.clock_out)) return { cls: "on", text: "Clocked in" };
      if (ps.length && Date.now() > new Date(e.ends_at).getTime()) return { cls: "done", text: "Done (clocked out)" };
      if (!ps.length && Date.now() > new Date(e.starts_at).getTime() + 10 * 6e4 && Date.now() < new Date(e.ends_at).getTime()) return { cls: "late", text: "Not clocked in yet" };
      return null;
    }

    // The bar under the views: which options fit the view, the Google Calendar sync age, problems, the map.
    function renderChrome() {
      const v = view;
      root.querySelector(".sc-needopt").classList.toggle("hidden", v !== "month");
      root.querySelector(".sc-waitopt").classList.toggle("hidden", v === "month");
      root.querySelector(".sc-mapopt").classList.toggle("hidden", v !== "day" && v !== "week");
      root.querySelector(".sc-scaleopt").classList.toggle("hidden", v !== "week");
      root.querySelector(".sc-colopt").classList.toggle("hidden", v === "month" || v === "list");
      root.querySelector(".sc-calbtn").classList.toggle("hidden", !data.people.some((p) => isMine(p.user_id)));
      const age = data.calendar_synced_at ? Math.round((Date.now() - new Date(data.calendar_synced_at)) / 6e4) : null;
      el("scGcalAge").textContent = age == null ? "" : age < 2 ? "(synced just now)" : age < 90 ? "(synced " + age + " min ago)" : "(last synced " + Fmt.dayTime(data.calendar_synced_at) + ")";
      el("scGcalOpt").title = "Events on the 207 Photo Booking calendar that aren't bookings, so you can see anything that didn't go through booking. Bookings aren't shown twice. Events named like “Ryan Off” always show as time off.";
      colorKey();
      renderProblems();
      renderMap();
    }

    // ---- week and 2 weeks: a card per bar
    function cardFor(e, d) {
      const isJob = e.kind === "job", trip = e.batch_id ? tripOf(e) : null, stop = trip ? trip.indexOf(e) : -1;
      const b = isJob ? data.bookings.find((x) => x.booking_id === e.booking_id && x.day === d) : null;
      const cf = isJob && confirmOn() && e.confirm ? e.confirm.status : null;
      const allDay = e.kind === "off" || e.kind === "asked";
      const title = isJob ? shortTitle(e.booking_title) : e.kind === "asked" ? "Asked off" + (e.title ? ": " + e.title : "") : e.kind === "off" ? "Off" + (e.title ? ": " + e.title : "") : (e.title || KIND[e.kind]);
      const col = colorOf(e), wx = wxOf(b), st = isJob && d === T.today() ? dayStatus(e) : null;
      const sub = [];
      if (isJob && e.drive_before_min) sub.push('<span class="dr' + (e.drive_before_min >= 120 ? " far" : "") + '" title="Drive there">' + esc(fmtMins(e.drive_before_min)) + "</span>");
      if (trip && stop > 0) sub.push("same trip");
      if (e.role) sub.push(esc(e.role));
      if (cf === "confirmed") sub.push('<b class="ok" title="Confirmed">✓</b>');
      if (cf === "pending") sub.push('<b class="wait" title="Hasn’t answered yet">?</b>');
      if (wx) sub.push('<span class="wx">' + esc(wx.text) + "</span>");
      if (st) sub.push('<span class="st ' + st.cls + '">' + esc(st.text) + "</span>");
      if (e.edit_due) sub.push('<span class="due' + (pastDue(e) ? " bad" : "") + '" title="Editing is due by then">due ' + esc(dueAt(e)) + "</span>");
      const tip = (allDay ? (e.kind === "asked" ? "Asked for time off" : "Time off") : T.fmtTs(e.starts_at) + "–" + T.fmtTs(e.ends_at)) + " " + (isJob ? e.booking_title : title) +
        (isJob && e.drive_before_min ? "\nLeave " + T.fmtTs(outAt(e)) + ", back " + T.fmtTs(backAt(e)) : "") + dueTip(e) + (e.note ? "\n" + e.note : "") + (editable() && isJob ? "\nRight-click or press and hold to batch" : "");
      return '<button type="button" class="scc-card scc-' + esc(e.kind) + (e.booking_status === "cancelled" ? " cancelled" : "") + (waitOnly && !(cf === "pending") ? " dim" : "") + (b ? selCls(b, d) : "") + '" data-entry="' + esc(e.id) + '"' +
        (b ? ' data-bk="' + esc(b.booking_id) + '" data-day="' + esc(d) + '"' : "") +
        (col ? ' style="--cc:' + col + '"' : "") + ' title="' + esc(tip) + '">' +
        (allDay ? "" : '<span class="t">' + esc(T.fmtTs(e.starts_at) + "–" + T.fmtTs(e.ends_at)) + "</span>") + '<span class="n">' + esc(title) + "</span>" +
        (sub.length ? '<span class="d">' + sub.join(" ") + "</span>" : "") + "</button>";
    }
    const fmtMins = (m) => (m >= 60 ? Math.floor(m / 60) + "h" + (m % 60 ? String(m % 60).padStart(2, "0") : "") : num(m) + "m");
    function renderCards() {
      const days = daysOf(), today = T.today(), two = view === "weeks2";
      el("scTitle").textContent = T.fmtDay(days[0]) + " – " + T.fmtDay(days[days.length - 1]);
      root.querySelectorAll(".sc-ed").forEach((n) => n.classList.toggle("hidden", !editable()));
      root.querySelector(".sc-flexbtn").classList.toggle("hidden", editable() || !data.people.some((p) => isMine(p.user_id)));
      const warn = el("scWarn");
      warn.classList.toggle("hidden", !(editable() && !data.studio_address));
      warn.innerHTML = 'Add the studio address so drive times can be looked up from Google Maps. <button type="button" class="link" data-v="studio">Add it</button>';
      const grid = el("scGrid");
      grid.className = "scc-grid" + (two ? " two" : "");
      grid.removeAttribute("style");
      grid.style.setProperty("--cols", days.length);
      const sw = narrow(), scr = root.querySelector(".sc-scroll");
      el("scSwipe").classList.toggle("hidden", !sw);
      scr.classList.toggle("fade", sw);
      if (sw) scr.scrollLeft = 0;
      const row = (name, cells, cls, tot) => '<div class="scc-name ' + (cls || "") + '">' + name + "</div>" + cells.join("") + '<div class="scc-tot ' + (cls || "") + '">' + (tot || "") + "</div>";
      let h = row("Team", days.map((d) => '<div class="scc-head' + (d === today ? " today" : "") + (d === highlight ? " hl" : "") + '"><button type="button" class="link" data-day="' + d + '">' + esc(T.fmtDay(d, { calendar: true })) + "</button>" + dayPills(d) + "</div>"), "scc-hrow", "Hours");
      // Jobs not assigned (the bulk picker in #88 works on these: .sc-jobs [data-booking])
      const open = data.bookings.filter((b) => days.includes(b.day) && staffedCount(b.booking_id, b.day) < neededOf(b.booking_id));
      h += row("<b>Jobs not assigned</b><span class=\"sc-hrs\">" + (open.length ? num(open.length) + (two ? " these two weeks" : " this week") + pickManyBtn() : "All jobs have someone") + "</span>",
        days.map((d) => '<div class="sc-jobs scc-lane">' + open.filter((b) => b.day === d).map((b) => {
          const have = staffedCount(b.booking_id, d), need = neededOf(b.booking_id), wx = wxOf(b);
          return '<button type="button" class="sc-chip' + (b.status === "tracked" ? " tracked" : !have ? " none" : " part") + selCls(b, d) + '" data-booking="' + esc(b.booking_id) + '" data-day="' + esc(d) + '" title="' + esc(bookingLabel(b) + (b.location ? "\n" + b.location : "")) + '">' +
            esc(shortTitle(b.title)) + "<small>" + esc(b.start_at ? T.fmtTs(b.start_at) + (b.end_at ? "–" + T.fmtTs(b.end_at) : "") : "time not set yet") +
            (have ? ' <span class="sc-need">&middot; ' + num(have) + " of " + num(need) + "</span>" : need > 1 ? ' <span class="sc-need">&middot; needs ' + num(need) + "</span>" : "") + (wx ? ' <span class="sc-wx">' + esc(wx.text) + "</span>" : "") + "</small></button>";
        }).join("") + "</div>"), "scc-open");
      // Google Calendar events that aren't bookings and nobody is on yet
      const cal = gcalOn ? calOpenOn(days) : [];
      if (cal.length) h += row('<b>From Google Calendar</b><span class="sc-hrs">Not bookings' + (editable() ? "; click one to put people on it" : "") + "</span>",
        days.map((d) => '<div class="scc-lane">' + cal.filter((c) => d >= c.start_date && d <= c.end_date).map((c) =>
          '<button type="button" class="sc-chip gcal" data-gcal="' + esc(c.event_id) + '" data-day="' + esc(d) + '" title="' + esc(c.summary) + '">' + esc(c.summary) +
          "<small>" + esc(c.all_day || !c.start_at ? "all day" : T.fmtTs(c.start_at) + "–" + T.fmtTs(c.end_at)) + "</small></button>").join("") + "</div>"), "scc-gcal");
      const waiting = (e) => e.kind === "job" && e.confirm && e.confirm.status === "pending";
      const people = (mineOnly ? data.people.filter((p) => p.user_id === data.me) : data.people).filter((p) => !waitOnly || data.entries.some((e) => e.user_id === p.user_id && waiting(e)));
      if (!people.length) h += row('<span class="muted">' + (waitOnly ? "Everyone has answered." : mineOnly ? "You are not on the team list." : "Nobody on the team yet.") + "</span>", days.map(() => "<div></div>"));
      people.forEach((p) => {
        const mine = data.entries.filter((e) => e.user_id === p.user_id), rowBars = mine.concat((data.asked || []).filter((e) => e.user_id === p.user_id));
        const hrs = days.reduce((a, d) => a + T.workHours(mine, d), 0), tgt = p.weekly_hours == null ? null : Number(p.weekly_hours) * days.length / 7, diff = tgt == null ? 0 : hrs - tgt;
        const tot = "<b>" + fmtH(hrs) + " h</b>" + (tgt == null ? "" : '<span class="sc-hrs">of ' + fmtH(tgt) + (Math.abs(diff) < 0.25 ? ' <span class="on">on target</span>' : diff > 0 ? ' <span class="over">' + fmtH(diff) + " over</span>" : "") + "</span>");
        h += row("<b>" + esc(p.name) + '</b><span class="sc-hrs">' + (p.from_home ? "From home" : "From the studio") + "</span>", days.map((d) => {
          const list = rowBars.filter((e) => piecesOn(e, d).length).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
          const dh = T.workHours(mine, d), tc = (data.tasks || []).find((t) => t.user_id === p.user_id && t.day === d);
          return '<div class="sc-cell scc-cell' + (editable() || isMine(p.user_id) ? " edit" : "") + (d === today ? " today" : "") + '" data-person="' + esc(p.user_id) + '" data-day="' + esc(d) + '">' +
            list.map((e) => cardFor(e, d)).join("") +
            ((dh > 0 || tc) ? '<span class="scc-foot">' + (dh > 0 ? '<span class="' + (dh >= T.LUNCH_AFTER_H ? "sc-lunch" : "") + '">' + fmtH(dh) + " h" + (dh >= T.LUNCH_AFTER_H ? " &middot; lunch" : "") + "</span>" : "") +
              (tc ? ' <a class="sc-tasks2" href="#staff/myday/' + d + '" title="Open My day for ' + T.fmtDay(d) + '">' + num(tc.n) + " task" + (tc.n === 1 ? "" : "s") + "</a>" : "") + "</span>" : "") + "</div>";
        }), "", tot);
      });
      grid.innerHTML = h;
      renderSummary(people);
      if (two) el("scSum").classList.add("hidden");
    }

    // ---- month: a Sunday-start calendar
    function renderMonth() {
      const days = daysOf(), today = T.today(), month = anchor.slice(0, 7);
      const mName = new Date(anchor.slice(0, 7) + "-15T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "long" });
      el("scTitle").textContent = mName + (month.slice(0, 4) === today.slice(0, 4) ? "" : " " + month.slice(0, 4));
      root.querySelectorAll(".sc-ed").forEach((n) => n.classList.toggle("hidden", !editable()));
      root.querySelector(".sc-flexbtn").classList.add("hidden");
      el("scWarn").classList.add("hidden"); el("scSwipe").classList.add("hidden"); el("scSum").classList.add("hidden");
      const scr = root.querySelector(".sc-scroll"); scr.classList.remove("fade");
      const grid = el("scGrid"); grid.className = "scm-grid"; grid.removeAttribute("style");
      const initials = (uid) => { const n = String(personName(uid)).split(/\s+/); return (n[0] || "?")[0] + (n[1] ? n[1][0] : ""); };
      const MAXC = narrow() ? 99 : 4;
      let h = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => '<div class="scm-h">' + w + "</div>").join("") + '<div class="scm-h scm-wt">Week</div>';
      for (let w = 0; w < days.length; w += 7) {
        const week = days.slice(w, w + 7);
        let wJobs = 0, wNeed = 0, wHrs = 0;
        week.forEach((d) => {
          let jobs = data.bookings.filter((b) => b.day === d && b.status !== "tracked");
          if (mineOnly) jobs = jobs.filter((b) => data.entries.some((e) => e.booking_id === b.booking_id && e.user_id === data.me && T.local(e.starts_at).day === d));
          const st = (b) => statusOf(b.booking_id, d);
          wJobs += jobs.length; wNeed += jobs.filter((b) => st(b) === "need").length;
          wHrs += data.people.reduce((a, p) => a + T.workHours(data.entries.filter((e) => e.user_id === p.user_id), d), 0);
          const shown = needOnly ? jobs.filter((b) => st(b) === "need") : jobs;
          const chips = shown.map((b) => {
            const on = [...new Set(data.entries.filter((e) => e.kind === "job" && e.booking_id === b.booking_id && T.local(e.starts_at).day === d).map((e) => e.user_id))];
            const s = st(b), wx = wxOf(b);
            return '<button type="button" class="scm-chip ' + s + selCls(b, d) + '" data-booking="' + esc(b.booking_id) + '" data-day="' + esc(d) + '" title="' + esc(bookingLabel(b) + (b.start_at ? "\n" + T.fmtTs(b.start_at) + (b.end_at ? "–" + T.fmtTs(b.end_at) : "") : "\nTime not set yet") +
              "\n" + (on.length ? "On it: " + on.map(personName).join(", ") : "Nobody on it yet") + (s === "need" && on.length ? " (needs " + neededOf(b.booking_id) + ")" : "") + (wx ? "\n" + wx.text : "")) + '">' +
              '<span class="nm">' + esc(shortTitle(b.title)) + "</span>" + (s === "need" ? '<span class="who">' + (on.length ? num(on.length) + " of " + num(neededOf(b.booking_id)) : "needs " + num(neededOf(b.booking_id))) + "</span>" : '<span class="who">' + esc(on.map(initials).join(" ")) + (s === "wait" ? " ?" : "") + "</span>") + "</button>";
          });
          const cal = gcalOn && !needOnly ? calOpenOn([d]).map((c) => '<button type="button" class="scm-chip gcal" data-gcal="' + esc(c.event_id) + '" data-day="' + esc(d) + '" title="' + esc("Google Calendar (not a booking): " + c.summary) + '"><span class="nm">' + esc(c.summary) + "</span></button>") : [];
          const all = chips.concat(cal), more = all.length - MAXC;
          const offs = [...new Set(data.entries.filter((e) => e.kind === "off" && piecesOn(e, d).some((x) => x.to - x.from >= 240)).map((e) => e.user_id))];
          const wx = jobs.map(wxOf).filter(Boolean)[0];
          h += '<div class="scm-day' + (d.slice(0, 7) !== month ? " other" : "") + (d < today ? " past" : "") + (d === today ? " today" : "") + '" data-mday="' + esc(d) + '">' +
            '<button type="button" class="scm-dn link" data-day="' + esc(d) + '" aria-label="' + esc("Open " + T.fmtDay(d, { calendar: true })) + '">' + esc(Fmt.day(d)) + (d === today ? " <span>Today</span>" : "") + "</button>" +
            (wx ? '<span class="sc-pill wx">' + esc(wx.text) + "</span>" : "") +
            all.slice(0, more > 0 ? MAXC - 1 : MAXC).join("") + (more > 0 ? '<button type="button" class="scm-more link" data-day="' + esc(d) + '">+' + num(more + 1) + " more</button>" : "") +
            (offs.length ? '<span class="scm-off" title="' + esc("Off: " + offs.map(personName).join(", ")) + '">Off: ' + esc(offs.map(initials).join(" ")) + "</span>" : "") + "</div>";
        });
        h += '<button type="button" class="scm-wt link" data-mweek="' + esc(week[0]) + '" title="Open this week"><b>' + num(wJobs) + " job" + (wJobs === 1 ? "" : "s") + "</b>" + fmtH(wHrs) + " h" + (wNeed ? '<span class="bad">' + num(wNeed) + " need people</span>" : "") + "</button>";
      }
      grid.innerHTML = h + '<div class="scm-key"><span><i class="need"></i>Needs people</span>' + (confirmOn() ? '<span><i class="wait"></i>Someone hasn&#39;t answered</span>' : "") + '<span><i class="ok"></i>Covered</span>' + (gcalOn ? '<span><i class="gcal"></i>Google Calendar</span>' : "") + "<span class=\"kl\">Letters are who&#39;s on it</span>" + (editable() ? "<span><span class=\"kl\">Ctrl-click (&#8984;-click on a Mac) jobs to assign several at once</span>" + pickManyBtn() + "</span>" : "") + "</div>";
    }

    // ---- problems: what needs a look, from today on, in what's loaded
    function problems() {
      if (!data || view === "weeks8") return [];
      const today = T.today(), days = daysOf().filter((d) => d >= today), out = [];
      const add = (day, text, extra) => out.push(Object.assign({ day, text }, extra || {}));
      const bars = data.entries.filter((e) => e.kind !== "off" && !e.gcal);
      days.forEach((d) => {
        data.bookings.filter((b) => b.day === d && b.status === "booked").forEach((b) => {
          const have = staffedCount(b.booking_id, d), need = neededOf(b.booking_id);
          if (have < need) add(d, shortTitle(b.title) + (have ? " has " + have + " of " + need + " people" : " has nobody on it yet"), { booking: b.booking_id });
          if (!b.start_at) add(d, shortTitle(b.title) + (b.day_label === "Makeup day" ? " makeup day has no time yet" : " has no start time"), { booking: b.booking_id });
          const wx = wxOf(b); if (wx && wx.bad) add(d, shortTitle(b.title) + " is outdoors: " + wx.text, { booking: b.booking_id });
        });
        data.people.forEach((p) => {
          const mine = bars.filter((e) => e.user_id === p.user_id && piecesOn(e, d).length);
          const span = (e) => [outAt(e), backAt(e)];
          for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
            const [a1, a2] = span(mine[i]), [b1, b2] = span(mine[j]);
            const sameTrip = mine[i].batch_id && mine[i].batch_id === mine[j].batch_id;
            if (!sameTrip && a1 < b2 && b1 < a2 && T.local(mine[i].starts_at).day === d) add(d, p.name + " has two things at once: " + labelOf(mine[i]) + " and " + labelOf(mine[j]), { person: p.user_id });
          }
          const offs = data.entries.filter((e) => e.kind === "off" && e.user_id === p.user_id).concat((data.asked || []).filter((e) => e.user_id === p.user_id));
          mine.filter((e) => T.local(e.starts_at).day === d && offs.some((o) => new Date(o.starts_at) < backAt(e) && new Date(o.ends_at) > outAt(e))).forEach((e) =>
            add(d, p.name + " is on " + labelOf(e) + " during " + (offs.some((o) => o.kind === "asked") ? "time off they asked for" : "time off"), { person: p.user_id }));
          mine.filter((e) => e.kind === "job" && T.local(e.starts_at).day === d && e.drive_before_min >= 120).forEach((e) =>
            add(d, p.name + " drives " + fmtMins(e.drive_before_min) + " to " + labelOf(e), { person: p.user_id }));
          mine.filter((e) => pastDue(e) && T.local(e.starts_at).day === d).forEach((e) =>
            add(d, p.name + "’s " + labelOf(e) + " ends after it’s due (" + dueAt(e) + ")", { person: p.user_id }));
          const hrs = T.workHours(mine, d);
          if (hrs >= 10) add(d, p.name + " has a " + fmtH(hrs) + " hour day", { person: p.user_id });
          if (confirmOn()) mine.filter((e) => e.kind === "job" && e.confirm && e.confirm.status === "pending" && T.local(e.starts_at).day === d && T.daysBetween(today, d) <= 3).forEach((e) =>
            add(d, p.name + " hasn’t answered for " + labelOf(e), { person: p.user_id }));
        });
        if (gcalOn) calOpenOn([d]).filter((c) => c.start_date === d || d === days[0]).forEach((c) =>
          add(d, "On Google Calendar, not on anyone’s schedule: " + c.summary, { gcal: c.event_id }));
      });
      return out;
    }
    const labelOf = (e) => e.kind === "job" ? shortTitle(e.booking_title) : (e.title || KIND[e.kind] || "time");
    // Editing time for the Lead (flex bars the database adds for each Lead job bar): due 24 hours after the shoot
    const dueAt = (e) => e.edit_due ? T.fmtDay(T.local(e.edit_due).day) + " " + T.fmtTs(e.edit_due) : "";
    const pastDue = (e) => !!e.edit_due && new Date(e.ends_at) > new Date(e.edit_due);
    const dueTip = (e) => e.edit_due ? "\nDue " + dueAt(e) + (pastDue(e) ? " (this ends after it’s due)" : "") : "";
    function renderProblems() {
      const list = problems(), btn = el("scProbBtn"), box = el("scProblems");
      btn.textContent = list.length ? list.length + " problem" + (list.length === 1 ? "" : "s") : "No problems";
      btn.classList.toggle("bad", list.length > 0);
      btn.classList.toggle("hidden", view === "weeks8");
      btn.setAttribute("aria-expanded", String(probOpen && list.length > 0));
      box.classList.toggle("hidden", !probOpen || !list.length || view === "weeks8");
      if (!probOpen || !list.length) return;
      box.innerHTML = '<div class="sc-probhd"><b>Things to look at</b> <span class="muted">from today on, ' + (view === "month" ? "this month" : view === "day" ? "this day" : view === "list" ? "these days" : "on screen") + "</span></div><ul>" +
        list.map((x) => '<li><button type="button" class="link" data-pday="' + esc(x.day) + '"' + (x.booking ? ' data-pbook="' + esc(x.booking) + '"' : "") + ">" + esc(T.fmtDay(x.day, { calendar: true })) + "</button> " + esc(x.text) + "</li>").join("") + "</ul>";
    }

    // ---- map beside the day and week
    const MAP_FN_URL = SUPABASE_URL + "/functions/v1/schedule-map";
    let mapKey = "", mapRes = null, mapSeq = 0;
    function mapPlan() {
      const days = view === "day" ? [anchor] : daysOf();
      const jobs = data.bookings.filter((b) => days.includes(b.day)).sort((a, b) => (a.day + (a.start_at || "")).localeCompare(b.day + (b.start_at || "")));
      const ids = [...new Set(jobs.map((b) => "job:" + b.booking_id))];
      const label = {}; ids.forEach((id, i) => { label[id] = i < 9 ? String(i + 1) : String.fromCharCode(56 + i); });
      const markers = ids.map((id) => { const b = jobs.find((x) => "job:" + x.booking_id === id); return { id, label: label[id], color: STATUS[statusOf(b.booking_id, b.day)][0].slice(1) }; });
      const routes = [];
      if (view === "day") data.people.forEach((p) => {
        const js = data.entries.filter((e) => e.user_id === p.user_id && e.kind === "job" && T.local(e.starts_at).day === anchor).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
        if (!js.length) return;
        const home = p.from_home && editable() ? "home:" + p.user_id : "studio";
        routes.push({ user_id: p.user_id, color: PALETTE[hashIdx(p.user_id)].slice(1), stops: [home].concat(js.map((e) => "job:" + e.booking_id), [home]) });
      });
      return { start: days[0], days: days.length, ids, label, markers, routes, jobs };
    }
    async function renderMap() {
      const box = el("scMap"), on = mapOn && (view === "day" || view === "week") && !narrow() ? true : mapOn && (view === "day" || view === "week");
      root.classList.toggle("sc-withmap", !!on);
      box.classList.toggle("hidden", !on);
      if (!on) return;
      const plan = mapPlan(), key = JSON.stringify([plan.start, plan.days, plan.markers, plan.routes.map((r) => r.stops)]);
      const draw = () => drawMap(box, plan, mapRes);
      if (key === mapKey && mapRes) return draw();
      mapKey = key; mapRes = null;
      box.innerHTML = '<div class="sc-maphd"><b>Map</b></div><p class="sc-note" style="padding:0 10px">Loading the map&#8230;</p>';
      if (!plan.ids.length) { mapRes = { places: [], image: null }; return draw(); }
      const my = ++mapSeq;
      try {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) throw new Error("Signed out.");
        const r = await fetch(MAP_FN_URL, { method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" },
          body: JSON.stringify({ start: plan.start, days: plan.days, image: true, size: "640x400", markers: plan.markers, routes: plan.routes.map(({ color, stops }) => ({ color, stops })) }) });
        const j = await r.json().catch(() => ({}));
        if (my !== mapSeq) return;
        if (!j.ok) throw new Error(j.error || "HTTP " + r.status);
        mapRes = j;
      } catch (e) {
        if (my !== mapSeq) return;
        mapRes = { places: [], image: null, map_error: "The map didn’t load: " + cleanErr(e) };
      }
      draw();
    }
    // The picture from Google when there is one; otherwise the pins drawn to scale on a plain background.
    function drawMap(box, plan, res) {
      const at = new Map((res.places || []).map((p) => [p.id, p]));
      const title = view === "day" ? T.fmtDay(anchor, { calendar: true }) : "Week of " + T.fmtDay(plan.start);
      let pic = "";
      if (res.image) pic = '<img class="sc-mapimg" src="' + esc(res.image) + '" alt="Map of the jobs on ' + esc(title) + '" />';
      else {
        const pts = [...at.values()];
        if (pts.length) {
          const lat = pts.map((p) => p.lat), lng = pts.map((p) => p.lng), k = Math.cos(44.5 * Math.PI / 180);
          const x0 = Math.min(...lng), x1 = Math.max(...lng), y0 = Math.min(...lat), y1 = Math.max(...lat);
          const W = 640, H = 400, pad = 30, sx = (x1 - x0) * k || 0.01, sy = (y1 - y0) || 0.01, sc = Math.min((W - 2 * pad) / sx, (H - 2 * pad) / sy);
          const X = (p) => (pad + ((p.lng - x0) * k) * sc + (W - 2 * pad - sx * sc) / 2).toFixed(1), Y = (p) => (H - pad - (p.lat - y0) * sc - (H - 2 * pad - sy * sc) / 2).toFixed(1);
          let svg = "";
          plan.routes.forEach((r) => { const s = r.stops.map((id) => at.get(id)).filter(Boolean); if (s.length > 1) svg += '<polyline points="' + s.map((p) => X(p) + "," + Y(p)).join(" ") + '" fill="none" stroke="#' + r.color + '" stroke-width="2.5" stroke-dasharray="5 3" />'; });
          pts.forEach((p) => {
            const m = plan.markers.find((x) => x.id === p.id), lbl = p.kind === "studio" ? "S" : p.kind === "home" ? "H" : (m && m.label) || "";
            svg += p.kind === "job" ? '<circle cx="' + X(p) + '" cy="' + Y(p) + '" r="9" fill="#' + ((m && m.color) || "2f6db5") + '" /><text x="' + X(p) + '" y="' + (+Y(p) + 4) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">' + esc(lbl) + "</text>"
              : '<rect x="' + (X(p) - 7) + '" y="' + (Y(p) - 7) + '" width="14" height="14" rx="3" fill="' + (p.kind === "studio" ? "#222" : "#8a8580") + '" /><text x="' + X(p) + '" y="' + (+Y(p) + 4) + '" text-anchor="middle" font-size="9" font-weight="700" fill="#fff">' + lbl + "</text>";
          });
          pic = '<svg class="sc-mapsvg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Where the jobs are, to scale">' + '<rect width="' + W + '" height="' + H + '" fill="var(--surface-2)" />' + svg + "</svg>";
        }
      }
      const gdir = (stops) => { const s = stops.map((id) => at.get(id)).filter(Boolean).map((p) => p.lat.toFixed(5) + "," + p.lng.toFixed(5)); if (s.length < 2) return ""; return "https://www.google.com/maps/dir/" + s.join("/"); };
      const list = plan.ids.map((id) => {
        const b = plan.jobs.find((x) => "job:" + x.booking_id === id), on = [...new Set(data.entries.filter((e) => e.kind === "job" && e.booking_id === b.booking_id && (view !== "day" || T.local(e.starts_at).day === anchor)).map((e) => e.user_id))];
        return '<li><span class="pin" style="background:' + STATUS[statusOf(b.booking_id, b.day)][0] + '">' + esc(plan.label[id]) + "</span><span>" + (view === "day" ? "" : esc(T.fmtDay(b.day)) + " ") + esc(shortTitle(b.title)) +
          '<small>' + (on.length ? esc(on.map(personName).join(", ")) : "nobody yet") + (at.has(id) ? "" : " &middot; not on the map") + "</small></span></li>";
      }).join("");
      const routes = plan.routes.map((r) => { const u = gdir(r.stops); return u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener"><i style="background:#' + r.color + '"></i>' + esc(personName(r.user_id)) + "&#39;s route</a>" : ""; }).filter(Boolean).join("");
      box.innerHTML = '<div class="sc-maphd"><b>Map</b> <span class="muted">' + esc(title) + "</span></div>" +
        '<div class="sc-mapbody"><div class="sc-mappic">' + (pic || '<p class="sc-note" style="padding:0 10px">' + (plan.ids.length ? "Looking up where the jobs are&#8230; check back in a minute." : "No jobs on these days.") + "</p>") + "</div>" +
        '<div class="sc-mapside">' + (res.map_error ? '<p class="sc-note sc-maperr">' + esc(res.map_error) + "</p>" : "") +
        (routes ? '<div class="sc-routes">' + routes + "</div>" : "") + (list ? '<ol class="sc-maplist">' + list + "</ol>" : "") + "</div></div>";
    }

    // ---- View schedule (2026-10-24, Jeremiah): pick a person, see the email they'd get with their next two
    // weeks (changed days marked), and send it to them from here. Sending counts their saved-up changes as told.
    let changes = [];
    async function loadChanges() {
      const btn = el("scChg");
      if (!editable()) { btn.classList.add("hidden"); return; }
      try {
        const { data: d, error } = await sb.rpc("schedule_changes_pending");
        if (error) throw error;
        changes = d || [];
      } catch (_e) { changes = []; }
      btn.classList.remove("hidden");
      btn.textContent = "View schedule" + (changes.length ? " (" + changes.length + " changed)" : "");
    }
    function openChanges() {
      const changed = (uid) => changes.find((c) => c.user_id === uid);
      const people = data.people.slice().sort((a, b) => (changed(b.user_id) ? 1 : 0) - (changed(a.user_id) ? 1 : 0));
      if (!people.length) return toast("Nobody on the team yet.");
      const m = openModal('<div class="sc-modal sc-viewmodal"><div class="sc-vwtop"><h2>View schedule</h2>' +
        '<select id="aca-scVwWho" aria-label="Whose schedule">' + people.map((p) => '<option value="' + esc(p.user_id) + '">' + esc(p.name) +
          (changed(p.user_id) ? " \u00b7 changed" : "") + "</option>").join("") + "</select></div>" +
        '<div class="sc-vwsum" id="aca-scVwInfo"></div><div id="aca-scVwBox"></div><div class="inline-error hidden" id="aca-scMErr"></div>' +
        '<div class="modal-actions"><button type="button" class="small hidden" data-m="drop" title="Count their changes as told without emailing them">Don&#39;t send their changes</button><span class="grow"></span>' +
        '<button type="button" class="small" data-m="cancel">Close</button><button type="button" class="primary" data-m="send">Send to them</button></div></div>');
      const who = m.querySelector("#aca-scVwWho"), info = m.querySelector("#aca-scVwInfo"), box = m.querySelector("#aca-scVwBox"), send = m.querySelector('[data-m="send"]');
      const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const md = (iso) => { const p = String(iso).split("-"); return +p[1] + "/" + +p[2]; };
      const wd = (iso) => { const p = String(iso).split("-"); return WD[new Date(+p[0], p[1] - 1, +p[2]).getDay()]; };
      const item = (it) => {
        const sub = [it.place, it.leave, it.role, it.note].filter(Boolean).map(esc);
        if (confirmOn() && it.ask === "confirmed") sub.push('<span class="ok">Confirmed</span>');
        if (confirmOn() && it.ask === "pending") sub.push('<span class="wait">Waiting to confirm</span>');
        return '<div class="sc-vwitem k-' + esc(it.kind || "work") + '"><div class="t">' + esc(it.time) + '</div><div class="n">' + esc(it.title) + "</div>" +
          (sub.length ? '<div class="d">' + sub.join(" \u00b7 ") + "</div>" : "") + "</div>";
      };
      let seq = 0;
      async function show() {
        const uid = who.value, my = ++seq, name = personName(uid);
        el("scMErr").classList.add("hidden");
        box.innerHTML = '<p class="sc-note">Loading&#8230;</p>'; info.innerHTML = ""; send.disabled = true;
        m.querySelector('[data-m="drop"]').classList.toggle("hidden", !changed(uid));
        const { data: d, error } = await sb.rpc("schedule_view_preview", { p_user: uid });
        if (my !== seq) return;
        if (error) { box.innerHTML = ""; return mErr(cleanErr(error)); }
        const agenda = d.agenda || [];
        info.innerHTML = "<span>" + esc(md(d.start) + " to " + md(d.end)) + "</span>" +
          '<span class="p">' + num(d.jobs) + " job" + (d.jobs === 1 ? "" : "s") + "</span>" +
          '<span class="p">' + num(d.hours) + " hour" + (d.hours === 1 ? "" : "s") + "</span>" +
          (d.pending && confirmOn() ? '<span class="p amber">' + num(d.pending) + " to confirm</span>" : "") +
          (d.changed ? '<span class="p amber">' + num(d.changed) + " changed day" + (d.changed === 1 ? "" : "s") + "</span>" : "") +
          '<span class="to">' + (d.has_email ? "To: " + esc(d.email) : '<b class="sc-bad">No email address on the Team page.</b>') + "</span>";
        box.innerHTML = '<div class="sc-vwlist">' + (agenda.length ? agenda.map((g) =>
          '<div class="sc-vwday' + (g.changed ? " chg" : "") + '"><div class="sc-vwdate"><span class="w">' + wd(g.day) + '</span><span class="n">' + md(g.day) + "</span>" +
            (g.changed ? '<span class="chgp">Changed</span>' : "") + '</div><div class="sc-vwitems">' +
            ((g.items || []).length ? g.items.map(item).join("") : '<div class="sc-vwnone">Nothing scheduled now</div>') +
            (g.gone ? '<div class="sc-vwgone">Taken off: ' + esc(g.gone) + "</div>" : "") + "</div></div>").join("")
          : '<div class="sc-vwempty">Nothing scheduled for ' + esc(name) + " in the next two weeks.</div>") + "</div>" +
          '<details class="sc-vwmail"><summary>See the email: <b>' + esc(d.subject) + '</b></summary><iframe class="sc-vwframe" sandbox="" title="' + esc("The email " + name + " would get") + '"></iframe></details>';
        box.querySelector("iframe").srcdoc = d.html || "";
        send.disabled = !d.has_email;
        send.textContent = "Send to " + name;
      }
      who.addEventListener("change", show);
      show();
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") return m.close();
        if (t.dataset.m !== "send" && t.dataset.m !== "drop") return;
        const uid = who.value, name = personName(uid);
        t.disabled = true;
        const { error } = t.dataset.m === "send" ? await sb.rpc("schedule_view_send", { p_user: uid }) : await sb.rpc("schedule_changes_send", { p_users: [uid], p_send: false });
        t.disabled = false;
        if (error) return mErr(cleanErr(error));
        toast(t.dataset.m === "send" ? "Sent " + name + " their next two weeks." : name + "'s changes are marked as told. Nothing was sent.");
        await loadChanges();
        const o = who.selectedOptions[0]; if (o) o.textContent = name;
        m.querySelector('[data-m="drop"]').classList.add("hidden");
        if (t.dataset.m === "send") send.textContent = "Sent. Send again";
      });
    }

    // ---- each person's own schedule in their phone's calendar
    async function openCal(reset) {
      let tok = "";
      try { const { data: d, error } = await sb.rpc("staff_cal_link", { p_reset: !!reset }); if (error) throw error; tok = d.token; } catch (e) { toast(cleanErr(e), true); return; }
      const https = SUPABASE_URL + "/functions/v1/staff-ics?t=" + tok, webcal = https.replace(/^https:/, "webcal:");
      const m = openModal('<div class="sc-modal"><h2>Your schedule in your phone&#39;s calendar</h2>' +
        '<p>Your jobs and time from the Schedule show up in your phone&#39;s calendar and stay up to date (phones check about once an hour). Jobs have the address, when to leave, your role, the crew notes and the WiFi, with a reminder 15 minutes before you need to leave.</p>' +
        '<p><a class="primary" style="display:inline-flex;align-items:center;height:40px;padding:0 16px;border-radius:6px;text-decoration:none" href="' + esc(webcal) + '">Add to my iPhone calendar</a></p>' +
        '<div class="field"><label for="aca-scCalUrl">Or copy the link (Google Calendar: Other calendars, +, From URL)</label><div class="sc-drive"><input type="text" id="aca-scCalUrl" readonly value="' + esc(https) + '" style="flex:1;min-width:0" /><button type="button" class="small" data-m="copy">Copy</button></div></div>' +
        '<p class="sc-note">Only you should have this link: anyone with it can see your schedule. If it gets shared, make a new one and the old one stops working.</p>' +
        '<div class="modal-actions"><button type="button" class="small" data-m="reset">Make a new link</button><span class="grow"></span><button type="button" class="primary" data-m="cancel">Done</button></div></div>');
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") m.close();
        if (t.dataset.m === "copy") { const i = m.querySelector("#aca-scCalUrl"); i.select(); try { await navigator.clipboard.writeText(i.value); toast("Copied."); } catch (_e) { document.execCommand && document.execCommand("copy"); } }
        if (t.dataset.m === "reset") { m.close(); openCal(true); toast("New link made. The old one no longer works."); }
      });
    }

    // ---------------------------------------------------------------- events
    // Jump ahead up to two months (polish pass 2026-10-23: the schedule is built 2-4 weeks out, looked at up to 2 months).
    function fillJump() {
      el("scJump").classList.toggle("hidden", view === "month");
      const wk0 = T.weekStart(T.today()), cur = T.weekStart(anchor);
      const opts = Array.from({ length: 9 }, (_, i) => T.addDays(wk0, 7 * i));
      el("scJump").innerHTML = (opts.includes(cur) ? "" : '<option value="">Week of ' + esc(T.fmtDay(cur, { weekday: undefined })) + "</option>") +
        opts.map((w, i) => '<option value="' + w + '"' + (w === cur ? " selected" : "") + ">" + (i === 0 ? "This week" : i === 1 ? "Next week" : "Week of " + esc(T.fmtDay(w, { weekday: undefined }))) + "</option>").join("");
    }
    el("scJump").addEventListener("change", (e) => { if (!e.target.value) return; anchor = e.target.value; load(); });
    root.addEventListener("click", (e) => {
      if (pressed) { pressed = false; e.preventDefault(); return; } // the click after a long-press opened the menu
      if (e.target.closest("[data-bulkmode]")) { bulkMode = !bulkMode; render(); return; }
      if (e.target.closest("[data-bulkclear]")) { bulk.clear(); bulkMode = false; render(); bulkBar(); return; }
      if (e.target.closest("[data-bulkgo]")) { openBulkAssign(); return; }
      // Jobs not assigned, plus (2026-10-24, Jeremiah) any job card in week / 2 weeks and any job in the month,
      // so jobs that already have people can be picked too.
      const pk0 = e.target.closest(".sc-jobs [data-booking], .scl-open [data-booking], .scm-chip[data-booking], .scc-card[data-bk]");
      if (pk0 && editable() && (bulkMode || e.ctrlKey || e.metaKey || e.shiftKey)) {
        e.preventDefault();
        const id = pk0.dataset.booking || pk0.dataset.bk, k = bulkKey(id, pk0.dataset.day);
        const b = data.bookings.find((x) => x.booking_id === id && x.day === pk0.dataset.day);
        if (bulk.has(k)) bulk.delete(k); else if (b) bulk.set(k, Object.assign({}, b, { on: data.entries.filter((x) => x.kind === "job" && x.booking_id === b.booking_id && T.local(x.starts_at).day === b.day).map((x) => x.user_id) }));
        root.querySelectorAll('[data-day="' + pk0.dataset.day + '"]').forEach((n) => { if ((n.dataset.booking || n.dataset.bk) === id && (n.matches(".sc-chip, .scl-item, .scm-chip, .scc-card"))) n.classList.toggle("sel", bulk.has(k)); });
        bulkBar();
        return;
      }
      const v = e.target.closest("[data-v]");
      if (v) {
        const a = v.dataset.v, step = view === "week" ? 7 : view === "weeks2" ? 14 : 1, oneDay = view === "day" || view === "list";
        // a month steps to the 1st of the month before / after
        const monthStep = (n) => { const d = new Date(anchor.slice(0, 8) + "15T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 8) + "01"; };
        if (a === "prev") { anchor = view === "month" ? monthStep(-1) : T.addDays(anchor, -step); load(); }
        if (a === "next") { anchor = view === "month" ? monthStep(1) : T.addDays(anchor, step); load(); }
        if (a === "today") { anchor = T.today(); load(); }
        if (a === "addflex") openEntry(null, { user_id: data.me, kind: "flex", day: oneDay ? anchor : T.today() >= data.start && T.today() < T.addDays(data.start, 7) ? T.today() : data.start });
        if (a === "add") openEntry(null, { user_id: data && data.me, day: oneDay ? anchor : T.today() >= data.start && T.today() < T.addDays(data.start, 7) ? T.today() : data.start });
        if (a === "studio") openStudio();
        if (a === "crewset") openCrewSettings();
        if (a === "weekmail") openWeekEmail();
        if (a === "problems") { probOpen = !probOpen; renderProblems(); }
        if (a === "cal") openCal(false);
        if (a === "changes") openChanges();
        if (a === "key") v.setAttribute("aria-expanded", String(root.classList.toggle("sc-showkey")));
        return;
      }
      const pk = e.target.closest("[data-peak]");
      if (pk) { anchor = highlight = pk.dataset.peak; setView("week"); window.scrollTo(0, 0); return; }
      const w8 = e.target.closest("[data-w8week]");
      if (w8) { anchor = w8.dataset.w8week; highlight = null; setView("week"); window.scrollTo(0, 0); return; }
      const w8b = e.target.closest("[data-w8b]");
      if (w8b) { anchor = highlight = w8b.dataset.day; pendingAssign = { id: w8b.dataset.w8b, day: w8b.dataset.day }; setView("week"); window.scrollTo(0, 0); return; }
      const pd = e.target.closest("[data-pday]");
      if (pd) {
        const b = pd.dataset.pbook && data.bookings.find((x) => x.booking_id === pd.dataset.pbook && x.day === pd.dataset.pday);
        if (b && editable()) { openAssign(b); return; }
        anchor = pd.dataset.pday; setView(narrow() ? "list" : "day"); return;
      }
      const mw = e.target.closest("[data-mweek]");
      if (mw) { anchor = mw.dataset.mweek; highlight = null; setView("week"); return; }
      const dayBtn = e.target.closest(".sc-head [data-day], .scc-head [data-day], .scm-dn[data-day], .scm-more[data-day]");
      if (dayBtn) { anchor = dayBtn.dataset.day; setView(narrow() && view === "month" ? "list" : "day"); return; }
      const chip = e.target.closest("[data-booking]");
      if (chip) { const b = data.bookings.find((x) => x.booking_id === chip.dataset.booking && x.day === chip.dataset.day); if (b) { if (editable()) openAssign(b); else location.hash = jobLink(b.booking_id); } return; } // people who can't staff it go to the job page
      const gc = e.target.closest("[data-gcal]");
      if (gc) {
        const c = (data.calendar || []).find((x) => x.event_id === gc.dataset.gcal); if (!c) return;
        const timed = !c.all_day && c.start_at && T.local(c.start_at).day === gc.dataset.day;
        if (editable()) openEntry(null, { user_id: data.me, day: gc.dataset.day, startMin: timed ? T.local(c.start_at).min : 9 * 60, endMin: timed ? T.local(c.end_at).min : 17 * 60, title: c.summary, gcal: c.event_id });
        else openCalInfo(c);
        return;
      }
      const bar = e.target.closest("[data-entry]");
      if (bar && bar.dataset.entry.startsWith("req:")) { if (canEdit("timeoff")) showTab("timeoff"); else toast("Asked for time off. Nobody has answered yet."); return; }
      if (bar) { const en = data.entries.find((x) => x.id === bar.dataset.entry); if (en) en.gcal ? openCalInfo(en.gcal) : canChange(en) ? openEntry(en) : openInfo(en); return; }
      const md = e.target.closest("[data-mday]");
      if (md) { anchor = md.dataset.mday; setView(narrow() ? "list" : "day"); return; }
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
      if (e.target.id === "aca-scMine") { mineOnly = e.target.checked; if (data && view !== "weeks8") render(); }
      if (e.target.id === "aca-scWait") { waitOnly = e.target.checked; if (data && view !== "weeks8") render(); }
      if (e.target.id === "aca-scNeedOnly") { needOnly = e.target.checked; if (data && view !== "weeks8") render(); }
      if (e.target.id === "aca-scGcal") { gcalOn = e.target.checked; setPref("gcal", gcalOn ? 1 : 0); if (data && view !== "weeks8") render(); }
      if (e.target.id === "aca-scScale") { scaleOn = e.target.checked; setPref("scale", scaleOn ? 1 : 0); if (data && view !== "weeks8") render(); }
      if (e.target.id === "aca-scMapOn") { mapOn = e.target.checked; setPref("map", mapOn ? 1 : 0); if (data && view !== "weeks8") render(); }
      if (e.target.id === "aca-scColor") { colorBy = e.target.value; setPref("color", colorBy); if (data && view !== "weeks8") render(); }
    });
    root.querySelector(".sc-scroll").addEventListener("scroll", (e) => {
      const n = e.currentTarget;
      if (n.scrollLeft > 20) el("scSwipe").classList.add("hidden");
      n.classList.toggle("fade", narrow() && (view === "week" || view === "weeks2") && n.scrollLeft + n.clientWidth < n.scrollWidth - 4);
    }, { passive: true });
    function setView(v) {
      view = v;
      root.querySelector('input[name="aca-scView"][value="' + v + '"]').checked = true;
      if (v === "weeks8") { loadWeeks(); return; }
      const r = rangeFor(v, anchor);
      if (data && r.start === data.start && r.days === data.span) { render(); openPending(); } else load();
    }

    // B1: the next 8 weeks at a glance: per week, its jobs and the ones that still need people, plus Busiest days.
    // schedule_week allows up to 42 days, so two calls. A week or a job jumps to that week (a job opens its assign dialog).
    function openPending() {
      if (!pendingAssign) return;
      const pa = pendingAssign; pendingAssign = null;
      const b = data.bookings.find((x) => x.booking_id === pa.id && x.day === pa.day);
      if (b && editable()) openAssign(b);
    }
    async function loadWeeks() {
      const my = ++loading;
      clearError("scErr");
      root.classList.add("sc-w8");
      root.classList.remove("sc-islist");
      el("scMore").open = true;
      el("scTitle").textContent = "Next 8 weeks";
      const box = el("scWeeks"), wk0 = T.weekStart(T.today()), today = T.today();
      if (!box.children.length) box.innerHTML = '<p class="empty" style="padding:16px">Loading&#8230;</p>';
      peakFor = ""; loadPeak();
      try {
        const res = await Promise.all([[0, 42], [42, 14]].map(([o, n]) => sb.rpc("schedule_week", { p_start: T.addDays(wk0, o), p_days: n })));
        res.forEach((r) => { if (r.error) throw r.error; });
        if (my !== loading) return;
        const seen = new Set(), bookings = [], entries = [], needed = {};
        res.forEach(({ data: d }) => {
          (d.bookings || []).forEach((b) => { const k = b.booking_id + "|" + b.day; if (!seen.has(k)) { seen.add(k); bookings.push(b); } });
          (d.entries || []).forEach((x) => { if (!entries.some((y) => y.id === x.id)) entries.push(x); });
          Object.assign(needed, (d.crew || {}).needed || {});
        });
        const need = (id) => num(needed[id]) || 1;
        const have = (id, d) => new Set(entries.filter((x) => x.booking_id === id && T.local(x.starts_at).day <= d && T.local(x.ends_at).day >= d).map((x) => x.user_id)).size;
        const weeks = Array.from({ length: 8 }, (_, i) => T.addDays(wk0, 7 * i));
        box.innerHTML = weeks.map((w, i) => {
          const end = T.addDays(w, 7);
          const jobs = bookings.filter((b) => b.day >= w && b.day < end && b.day >= today).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : String(a.start_at || "").localeCompare(String(b.start_at || ""))));
          const open = jobs.filter((b) => have(b.booking_id, b.day) < need(b.booking_id));
          return '<div class="sc-w8row"><h3><button type="button" class="link" data-w8week="' + esc(w) + '">' + (i === 0 ? "This week" : i === 1 ? "Next week" : "Week of " + esc(T.fmtDay(w, { weekday: undefined }))) + "</button>" +
            '<span class="s">' + (jobs.length ? num(jobs.length) + " job" + (jobs.length === 1 ? "" : "s") + ", " + (open.length ? num(open.length) + " not assigned" : "all have people") : "no jobs") + "</span></h3>" +
            (open.length ? '<div class="sc-jobs">' + open.map((b) => {
              const h = have(b.booking_id, b.day), n = need(b.booking_id);
              return '<button type="button" class="sc-chip' + (b.status === "tracked" ? " tracked" : h ? " part" : " none") + '" data-w8b="' + esc(b.booking_id) + '" data-day="' + esc(b.day) + '" title="' + esc(bookingLabel(b) + (b.location ? "\n" + b.location : "")) + '">' +
                esc(shortTitle(b.title)) + "<small>" + esc(T.fmtDay(b.day)) + (b.start_at ? " &middot; " + esc(T.fmtTs(b.start_at)) : "") + (h ? " &middot; " + num(h) + " of " + num(n) : n > 1 ? " &middot; needs " + num(n) : "") + "</small></button>";
            }).join("") + "</div>" : "") + "</div>";
        }).join("");
      } catch (e) {
        if (my !== loading) return;
        box.innerHTML = "";
        showError("scErr", "Could not load the next 8 weeks: " + cleanErr(e));
      }
    }

    // ---------------------------------------------------------------- drive time
    // With a person, the drive is from where they start: home for anyone with a home address.
    const fromHome = (uid) => !!(data && data.people.some((p) => p.user_id === uid && p.from_home));
    async function lookupDrive(bookingId, userId) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Signed out.");
      const r = await fetch(DRIVE_FN_URL, { method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" }, body: JSON.stringify(userId ? { booking_id: bookingId, user_id: userId } : { booking_id: bookingId }) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "HTTP " + r.status);
      return j;
    }
    // Wires the drive inputs + "Look up" button inside a modal. getBooking() returns the picked booking id,
    // getUser() (optional) the person, so the drive is from their home when they have one.
    function driveControls(m, getBooking, auto, getUser) {
      const msg = m.querySelector(".sc-drivemsg"), btn = m.querySelector('[data-m="drive"]');
      async function go() {
        const id = getBooking();
        if (!id) { msg.textContent = "Pick the job first."; return; }
        btn.disabled = true; msg.textContent = "Asking Google Maps\u2026";
        try {
          const r = await lookupDrive(id, getUser && getUser());
          const mins = Math.ceil(r.minutes / 5) * 5;
          m.querySelector(".sc-db").value = mins; m.querySelector(".sc-da").value = mins;
          msg.textContent = r.minutes + " min from " + (r.from === "home" ? "home" : "the studio") + " to " + r.destination + (r.meters ? " (" + (r.meters / 1609.34).toFixed(1) + " mi)" : "") + ". Rounded up to " + mins + ".";
        } catch (e) { msg.textContent = cleanErr(e); }
        finally { btn.disabled = false; }
      }
      btn.addEventListener("click", go);
      if (auto) go();
      return go;
    }
    const driveHtml = (db, da, su, td) =>
      '<div class="sc-drive"><div class="field"><label for="aca-scSu">Setup (min)</label><input type="number" id="aca-scSu" class="sc-su" min="0" max="240" step="5" value="' + num(su) + '" /></div>' +
      '<div class="field"><label for="aca-scTd">Teardown (min)</label><input type="number" id="aca-scTd" class="sc-td" min="0" max="240" step="5" value="' + num(td) + '" /></div></div>' +
      '<div class="sc-drive"><div class="field"><label for="aca-scDb">Drive there (min)</label><input type="number" id="aca-scDb" class="sc-db" min="0" max="600" step="5" value="' + num(db) + '" /></div>' +
      '<div class="field"><label for="aca-scDa">Drive back (min)</label><input type="number" id="aca-scDa" class="sc-da" min="0" max="600" step="5" value="' + num(da) + '" /></div>' +
      '<button type="button" class="small" data-m="drive">Look up drive time</button></div><p class="sc-note sc-drivemsg"></p>';
    const setupDefault = () => data && data.setup_default != null ? data.setup_default : 30;
    const teardownDefault = () => data && data.teardown_default != null ? data.teardown_default : 30;
    // setup / teardown / drive minutes from the inputs in a modal
    const driveVals = (m) => ({ setup_min: +m.querySelector(".sc-su").value || 0, teardown_min: +m.querySelector(".sc-td").value || 0,
      drive_before_min: +m.querySelector(".sc-db").value || 0, drive_after_min: +m.querySelector(".sc-da").value || 0 });

    // ---------------------------------------------------------------- put people on a job
    // The booking day a job bar belongs to (bookings on screen this week).
    const jobOf = (e) => data.bookings.find((b) => b.booking_id === e.booking_id && b.day === T.local(e.starts_at).day);
    // The floating "N jobs picked" bar.
    function bulkBar() {
      let bar = el("scBulk");
      if (!bar) { bar = document.createElement("div"); bar.className = "sc-bulk hidden"; bar.id = "aca-scBulk"; root.appendChild(bar); }
      const n = bulk.size;
      bar.classList.toggle("hidden", !n || !editable());
      bar.innerHTML = n ? "<span><b>" + num(n) + "</b> job" + (n === 1 ? "" : "s") + ' picked</span><button type="button" class="primary" data-bulkgo>Assign people</button><button type="button" class="small" data-bulkclear>Clear</button>' : "";
    }
    // Put the same people on every picked job, each at the job's own time, with drive from where they start.
    function openBulkAssign() {
      const jobs = [...bulk.values()].sort((x, y) => (x.day + (x.start_at || "")).localeCompare(y.day + (y.start_at || "")));
      if (!jobs.length) return;
      const roles = data.crew.roles || [];
      const roleSel = '<select class="sc-role" aria-label="Role"><option value="">No role</option>' + roles.map((r) => '<option value="' + esc(r.id) + '">' + esc(r.label) + "</option>").join("") + "</select>";
      const timed = (b) => !!(b.start_at && b.end_at);
      const m = openModal('<div class="sc-modal"><h2>Assign ' + num(jobs.length) + " job" + (jobs.length === 1 ? "" : "s") + "</h2>" +
        '<ul class="sc-bulkjobs">' + jobs.map((b) => "<li><b>" + esc(T.fmtDay(b.day)) + "</b> " + esc(bookingLabel(b)) + '<br><span class="s">' +
          esc(timed(b) ? T.fmtTs(b.start_at) + "–" + T.fmtTs(b.end_at) : "Time not set yet, so it's skipped") + (b.location ? " · " + esc(b.location) : "") + "</span></li>").join("") + "</ul>" +
        '<div class="field"><label>Who</label><ul class="sc-pick" id="aca-scBulkPick">' + data.people.map((p) =>
          '<li><input type="checkbox" value="' + esc(p.user_id) + '" aria-label="' + esc(p.name) + '" /><span><span class="n">' + esc(p.name) + "</span>" +
          '<span class="s">' + (p.from_home ? "Drives from home" : "Drives from the studio") + "</span></span>" + roleSel + "</li>").join("") + "</ul></div>" +
        '<p class="sc-note">Each person goes on every job at its booked time, with the usual setup and teardown. Drive time is looked up for each job from their home (or the studio if they have no home address). Anyone already on a job stays as they are.</p>' +
        '<div class="inline-error hidden" id="aca-scMErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">Assign</button></div></div>');
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") return m.close();
        if (t.dataset.m !== "save") return;
        const who = [...m.querySelectorAll("#aca-scBulkPick li")].filter((li) => li.querySelector("input:checked")).map((li) => ({ user_id: li.querySelector("input").value, role_id: li.querySelector(".sc-role").value || null }));
        if (!who.length) return mErr("Pick at least one person.");
        const todo = jobs.filter(timed);
        if (!todo.length) return mErr("None of these jobs have a time yet. Set the times on the bookings first.");
        t.disabled = true;
        let added = 0, clashes = 0, n = 0;
        const total = todo.length * who.length;
        try {
          for (const b of todo) {
            for (const w of who) {
              t.textContent = "Assigning " + (++n) + " of " + total + "…";
              if ((b.on || []).includes(w.user_id)) continue;
              const st = T.hhmm(T.local(b.start_at).min), et = T.hhmm(T.local(b.end_at).min);
              const v = { setup_min: setupDefault(), teardown_min: teardownDefault(), drive_before_min: 30, drive_after_min: 30 };
              try { v.drive_before_min = v.drive_after_min = round5((await lookupDrive(b.booking_id, w.user_id)).minutes); } catch (_e) { /* keep 30 */ }
              const { data: r, error } = await sb.rpc("schedule_save", { p: Object.assign({ user_id: w.user_id, kind: "job", booking_id: b.booking_id, role_id: w.role_id, starts_at: T.toIso(b.day, st), ends_at: T.toIso(et <= st ? T.addDays(b.day, 1) : b.day, et) }, v) });
              if (error) throw error;
              added += 1; clashes += num(r && r.overlaps);
            }
            bulk.delete(bulkKey(b.booking_id, b.day));
          }
          m.close();
          bulkMode = bulk.size > 0 && bulkMode;
          const skipped = jobs.length - todo.length;
          toast("Assigned " + num(todo.length) + " job" + (todo.length === 1 ? "" : "s") + (added ? "" : " (everyone was already on them)") + "." +
            (skipped ? " " + skipped + " without a time " + (skipped === 1 ? "is" : "are") + " still picked." : "") + (clashes ? " Heads up: " + clashes + " overlap other time on their schedule." : ""));
          bulkBar(); load(); loadAttention();
        } catch (e) { mErr(cleanErr(e)); t.disabled = false; t.textContent = "Assign"; load(); bulkBar(); }
      });
    }
    function openAssign(b) {
      const already = data.entries.filter((e) => e.booking_id === b.booking_id && T.local(e.starts_at).day === b.day);
      const mkTime = untimedMakeup(b), was = already[0];
      const s = b.start_at ? T.local(b.start_at).min : was ? T.local(was.starts_at).min : 9 * 60;
      const en = b.end_at ? T.local(b.end_at).min : was ? T.local(was.ends_at).min : s + 120;
      const roles = data.crew.roles || [];
      const roleSel = (pick, cls) => '<select class="' + cls + '" aria-label="Role"><option value="">No role</option>' + roles.map((r) => '<option value="' + esc(r.id) + '"' + (r.id === pick ? " selected" : "") + ">" + esc(r.label) + "</option>").join("") + "</select>";
      const cf = (e) => (e.confirm ? '<span class="pill ' + CREW_STATUS[e.confirm.status][1] + '">' + CREW_STATUS[e.confirm.status][0] + "</span>" : b.status && b.status !== "booked" ? "" : '<span class="muted">not asked</span>');
      const no = (data.crew.declined || []).filter((x) => x.booking_id === b.booking_id);
      const m = openModal('<div class="sc-modal"><h2>' + esc(bookingLabel(b)) + "</h2>" +
        '<p class="sc-facts">' + esc(T.fmtDay(b.day, { weekday: "long" })) + ", " + esc(b.start_at ? T.fmtTs(b.start_at) + "–" + T.fmtTs(b.end_at) : "time not set yet") + (b.location ? "<br>" + esc(b.location) : "") + "</p>" +
        (mkTime ? '<p class="sc-note">The start and end under Times and drive become the makeup day&#39;s time (on the Google Calendar too). Press Save time, or tick people and add them.</p>' : "") +
        '<div class="field"><label for="aca-scNeed">People needed</label><input type="number" id="aca-scNeed" min="1" max="20" step="1" value="' + neededOf(b.booking_id) + '" style="width:90px" /></div>' +
        (already.length ? '<h3 class="sc-sub">On it</h3><ul class="sc-onit">' + already.map((e) => "<li><b>" + esc(personName(e.user_id)) + "</b>" + (e.role ? " (" + esc(e.role) + ")" : "") + " " + cf(e) +
          ' <span class="s">' + esc(T.fmtTs(e.starts_at)) + "–" + esc(T.fmtTs(e.ends_at)) + ", drive " + num(e.drive_before_min) + "/" + num(e.drive_after_min) + " min" + (e.batch_id ? ", batched" : "") + "</span>" +
          ' <button type="button" class="link" data-m="edit" data-id="' + esc(e.id) + '">change</button>' +
          (confirmOn() && (!e.confirm || e.confirm.status !== "confirmed") ? ' <button type="button" class="link" data-m="ask" data-user="' + esc(e.user_id) + '">' + (e.confirm && e.confirm.asked_at ? "Ask again" : "Ask to confirm") + "</button>" : "") + "</li>").join("") + "</ul>" : "") +
        (no.length ? '<p class="sc-facts"><b>Can&#39;t make it:</b> ' + no.map((x) => esc(x.name) + (x.reason ? ' <span class="muted">(' + esc(x.reason) + ")</span>" : "")).join(", ") + "</p>" : "") +
        '<div class="field"><label>Add people</label><ul class="sc-pick" id="aca-scPick"><li><span></span><span class="muted">Checking who is free&#8230;</span><span></span></li></ul></div>' +
        (canEdit("openjobs") ? '<p class="sc-note">Not sure who can make it? <a href="#staff/openjobs/' + esc(b.booking_id) + '" data-m="offer">Ask who&#39;s available</a>: ask several people at once, they say if they can make it, and you pick one.</p>' : "") +
        // B8: times, setup and drive are rarely changed here once the Drive & setup defaults are set
        '<details class="sc-fold" id="aca-scTimes"' + (b.start_at ? "" : " open") + '><summary>Times and drive <span class="s" id="aca-scTimesTxt"></span></summary>' +
        '<div class="row2"><div class="field"><label for="aca-scS">Start</label><input type="time" id="aca-scS" step="300" value="' + T.hhmm(s) + '" /></div><div class="field"><label for="aca-scE">End</label><input type="time" id="aca-scE" step="300" value="' + T.hhmm(en) + '" /></div></div>' +
        driveHtml(already[0] && !already[0].batch_id ? already[0].drive_before_min : 30, already[0] && !already[0].batch_id ? already[0].drive_after_min : 30,
          already[0] ? already[0].setup_min : setupDefault(), already[0] ? already[0].teardown_min : teardownDefault()) +
        (data.people.some((p) => p.from_home) ? '<p class="sc-note">People with a home address drive from home. Ticking one person shows their drive here; with several ticked, each gets their own.</p>' : "") + "</details>" +
        '<div class="inline-error hidden" id="aca-scMErr"></div>' +
        '<div class="modal-actions"><a href="' + jobLink(b.booking_id) + '" data-m="job" class="small">Open the job</a><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">' + (mkTime ? "Save time" : "Add to the schedule") + '</button></div></div>');
      driveControls(m, () => b.booking_id, !!data.studio_address && !already.length);
      const timesTxt = () => {
        const st = el("scS").value, et = el("scE").value, v = driveVals(m);
        const t = (x) => { const [hh, mm] = x.split(":").map(Number); return T.fmtMin(hh * 60 + mm); };
        el("scTimesTxt").textContent = (st && et ? t(st) + "\u2013" + t(et) : "time not set") + ", setup " + v.setup_min + " / teardown " + v.teardown_min + " min, drive " + v.drive_before_min + " / " + v.drive_after_min + " min";
      };
      timesTxt();
      el("scTimes").addEventListener("input", timesTxt); el("scTimes").addEventListener("change", timesTxt);
      el("scTimes").addEventListener("toggle", timesTxt);
      // Who is free, their roles and the drive from home (sorted: free first, then nearest).
      const pick = m.querySelector("#aca-scPick");
      const rows = (list, cp) => list.map((p) => {
        const [line, lvl, rn] = cp ? CrewPick.describe(p, cp) : ["", "", []];
        const first = (p.roles || [])[0] || "";
        return '<li><input type="checkbox" value="' + esc(p.user_id) + '" aria-label="' + esc(p.name) + '" /><span><span class="n">' + esc(p.name) + "</span>" + (rn.length ? '<span class="r">' + esc(rn.join(", ")) + "</span>" : "") +
          (line ? '<span class="s ' + lvl + '">' + esc(line) + "</span>" : "") + "</span>" + roleSel(first, "sc-role") + "</li>";
      }).join("") || '<li><span></span><span class="muted">Everyone is already on it.</span><span></span></li>';
      const free = data.people.filter((p) => !already.some((e) => e.user_id === p.user_id)).map((p) => Object.assign({}, p, { roles: p.roles || [] }));
      // The drive boxes follow who is ticked (2026-10-24, Jeremiah: "Drive time isn't changing when I choose"):
      // one person from home shows their own minutes; several list each person's.
      const homeMin = {};
      const msgEl = m.querySelector(".sc-drivemsg");
      function followPick() {
        const ids = [...pick.querySelectorAll("input:checked")].map((x) => x.value);
        const home = ids.filter((id) => fromHome(id) && homeMin[id] != null);
        if (!home.length) return;
        if (ids.length === 1) {
          const mins = round5(homeMin[ids[0]]);
          m.querySelector(".sc-db").value = mins; m.querySelector(".sc-da").value = mins;
          msgEl.textContent = personName(ids[0]) + ": " + homeMin[ids[0]] + " min from home. Rounded up to " + mins + ".";
        } else {
          msgEl.textContent = "Each person gets their own drive: " + ids.map((id) => personName(id) + " " + (home.includes(id) ? round5(homeMin[id]) + " min from home" : "uses the minutes above")).join(", ") + ".";
        }
        timesTxt();
      }
      pick.addEventListener("change", followPick);
      if (mkTime) pick.addEventListener("change", () => { m.querySelector('[data-m="save"]').textContent = pick.querySelector("input:checked") ? "Save time and add" : "Save time"; });
      CrewPick.options(b.booking_id, b.day).then((cp) => {
        const byId = new Map(cp.people.map((p) => [p.user_id, p]));
        cp.people.forEach((p) => { if (p.home_min != null) homeMin[p.user_id] = p.home_min; });
        const rank = (p) => (p.off ? 3 : p.declined ? 2 : p.asked_off || (p.busy || []).length ? 1 : 0);
        const list = free.map((p) => Object.assign({}, byId.get(p.user_id) || { roles: p.roles, busy: [] }, { name: p.name, user_id: p.user_id }))
          .sort((x, y) => rank(x) - rank(y) || (x.home_min == null ? 1e4 : x.home_min) - (y.home_min == null ? 1e4 : y.home_min) || x.name.localeCompare(y.name));
        const was = new Set([...pick.querySelectorAll("input:checked")].map((x) => x.value));
        pick.innerHTML = rows(list, cp);
        pick.querySelectorAll("input[type=checkbox]").forEach((x) => { x.checked = was.has(x.value); });
        followPick();
      }).catch(() => { pick.innerHTML = rows(free, null); });
      const needIn = el("scNeed"), need0 = needIn.value;
      async function saveNeed() {
        if (needIn.value === need0) return;
        const { error } = await sb.rpc("crew_needed_set", { p_booking: b.booking_id, p_needed: +needIn.value || 1 });
        if (error) throw error;
      }
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") m.close();
        if (t.dataset.m === "open") { ev.preventDefault(); m.close(); Bookings.openId(b.booking_id); }
        if (t.dataset.m === "job" || t.dataset.m === "offer") m.close();
        if (t.dataset.m === "edit") { m.close(); openEntry(data.entries.find((x) => x.id === t.dataset.id)); }
        if (t.dataset.m === "ask") {
          t.disabled = true;
          try { const { error } = await sb.rpc("crew_ask_now", { p_booking: b.booking_id, p_user: t.dataset.user }); if (error) throw error; toast("Sent. " + personName(t.dataset.user) + " got an email and a notification."); t.textContent = "Sent"; load(); }
          catch (e) { mErr(cleanErr(e)); t.disabled = false; }
        }
        if (t.dataset.m === "save") {
          const who = [...pick.querySelectorAll("li")].filter((li) => li.querySelector("input:checked")).map((li) => ({ user_id: li.querySelector("input").value, role_id: li.querySelector(".sc-role").value || null }));
          const st = el("scS").value, et = el("scE").value;
          if (mkTime) {
            if (!st || !et) { el("scTimes").open = true; return mErr("Enter the makeup day's start and end time."); }
            if (et <= st) { el("scTimes").open = true; return mErr("The end time has to be after the start time."); }
          }
          if (!who.length && (mkTime || needIn.value !== need0)) {
            t.disabled = true;
            try {
              await saveNeed();
              if (mkTime) await setMakeupTime(b, st, et);
              m.close(); toast(mkTime ? "Makeup day time set. The calendar event updates in a minute." : "Saved."); load(); loadAttention();
            } catch (e) { mErr(cleanErr(e)); t.disabled = false; }
            return;
          }
          if (!who.length) return mErr("Pick at least one person.");
          if (!st || !et) { el("scTimes").open = true; return mErr("Enter the start and end time."); }
          const endDay = et <= st ? T.addDays(b.day, 1) : b.day;
          t.disabled = true;
          try {
            await saveNeed();
            if (mkTime) await setMakeupTime(b, st, et);
            let clashes = 0;
            for (const w of who) {
              const v = driveVals(m);
              if (fromHome(w.user_id)) { try { v.drive_before_min = v.drive_after_min = round5((await lookupDrive(b.booking_id, w.user_id)).minutes); } catch (_e) { /* keep the typed minutes */ } }
              const { data: r, error } = await sb.rpc("schedule_save", { p: Object.assign({ user_id: w.user_id, kind: "job", booking_id: b.booking_id, role_id: w.role_id, starts_at: T.toIso(b.day, st), ends_at: T.toIso(endDay, et) }, v) });
              if (error) throw error;
              clashes += num(r && r.overlaps);
            }
            m.close();
            toast((who.length === 1 ? "Added to the schedule." : who.length + " people added.") + (confirmOn() && (!b.status || b.status === "booked") ? " They'll be asked to confirm." : "") + (clashes ? " Heads up: it overlaps other time on their schedule." : ""));
            load(); loadAttention();
          } catch (e) { mErr(cleanErr(e)); t.disabled = false; }
        }
      });
    }
    const mErr = (t) => { const n = el("scMErr"); if (n) { n.textContent = t; n.classList.remove("hidden"); } };

    // ---------------------------------------------------------------- crew settings + email the week
    const DOWS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    // The week's data, or (opened from Settings before the Schedule was shown) today's.
    async function scheduleData() {
      if (data) return data;
      const { data: d, error } = await sb.rpc("schedule_week", { p_start: T.today(), p_days: 1 });
      if (error) throw error;
      return d || {};
    }
    // Crew settings: one dialog, opened from Schedule (Crew settings) and from Settings (Team & pay > Crew roles,
    // Team emails > Weekly schedule email). opts.only = "roles" | "emails" shows just that half;
    // opts.onSaved runs after a save.
    async function openCrewSettings(opts) {
      opts = opts || {};
      let src;
      try { src = await scheduleData(); } catch (e) { toast(cleanErr(e), true); return; }
      const st = opts.settings || (src.crew && src.crew.settings) || {};
      const roles = opts.only !== "emails", mails = opts.only !== "roles";
      const m = openModal('<div class="sc-modal"><h2>' + (opts.only === "roles" ? "Crew roles" : opts.only === "emails" ? "Asking the crew and the weekly email" : "Crew settings") + '</h2>' +
        (roles ? '<h3 class="sc-sub">Roles</h3><p class="sc-note">What someone does on a job. Pick each person&#39;s roles on the Team page; the crew picker suggests their first one.</p>' +
        '<ul class="sc-roles" id="aca-scRoles"></ul><div class="sc-drive"><div class="field" style="flex:1"><label for="aca-scRoleNew">New role</label><input type="text" id="aca-scRoleNew" maxlength="40" placeholder="Lighting, Group photos&#8230;" style="width:100%" /></div><button type="button" class="small" data-m="addrole">Add</button></div>' : "") +
        (mails ? '<h3 class="sc-sub">Asking the crew</h3><label class="sc-chk"><input type="checkbox" id="aca-scCfOn"' + (st.crew_confirm_on === true ? " checked" : "") + ' /> Ask people to confirm when they&#39;re put on a booked job (email and app notification, 7am to 9pm). Off: putting someone on a job just assigns it.</label>' +
        '<h3 class="sc-sub">Weekly schedule email</h3><label class="sc-chk"><input type="checkbox" id="aca-scWkOn"' + (st.week_email_auto ? " checked" : "") + ' /> Email everyone their next week automatically</label>' +
        '<div class="row2"><div class="field"><label for="aca-scWkD">Day</label><select id="aca-scWkD">' + DOWS.map((d, i) => '<option value="' + i + '"' + (i === num(st.week_email_dow == null ? 5 : st.week_email_dow) ? " selected" : "") + ">" + d + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="aca-scWkH">Time</label><select id="aca-scWkH">' + Array.from({ length: 15 }, (_, i) => i + 6).map((h) => '<option value="' + h + '"' + (h === num(st.week_email_hour == null ? 15 : st.week_email_hour) ? " selected" : "") + ">" + T.fmtMin(h * 60) + "</option>").join("") + "</select></div></div>" : "") +
        '<div class="inline-error hidden" id="aca-scMErr"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Close</button>' + (mails ? '<button type="button" class="primary" data-m="save">Save</button>' : "") + '</div></div>');
      const reload = async () => { if (data) await load(); if (opts.onSaved) opts.onSaved(); };
      const list = m.querySelector("#aca-scRoles");
      async function loadRoles() {
        if (!list) return;
        const { data: d, error } = await sb.rpc("crew_roles_list");
        if (error) { mErr(cleanErr(error)); return; }
        list.innerHTML = (d.roles || []).map((r) => '<li data-id="' + esc(r.id) + '"><input type="text" maxlength="40" value="' + esc(r.label) + '" aria-label="Role name" data-was="' + esc(r.label) + '" /><button type="button" class="small" data-m="renrole">Rename</button><button type="button" class="small warn" data-m="delrole">Remove</button></li>').join("") || '<li class="muted">No roles yet.</li>';
      }
      loadRoles();
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        const li = t.closest("li[data-id]");
        try {
          if (t.dataset.m === "cancel") { m.close(); return; }
          if (t.dataset.m === "addrole") {
            const v = el("scRoleNew").value.trim(); if (!v) return mErr("Type the role's name.");
            const { error } = await sb.rpc("crew_role_save", { p: { label: v, sort: 100 } }); if (error) throw error;
            el("scRoleNew").value = ""; await loadRoles(); reload();
          }
          if (t.dataset.m === "renrole" && li) {
            const inp = li.querySelector("input"); if (inp.value.trim() === inp.dataset.was) return;
            const { error } = await sb.rpc("crew_role_save", { p: { id: li.dataset.id, label: inp.value.trim() } }); if (error) throw error;
            toast("Renamed."); await loadRoles(); reload();
          }
          if (t.dataset.m === "delrole" && li) {
            if (!confirm("Remove the role “" + li.querySelector("input").dataset.was + "”? Bars that had it keep their times, without a role.")) return;
            const { error } = await sb.rpc("crew_role_archive", { p_id: li.dataset.id }); if (error) throw error;
            await loadRoles(); reload();
          }
          if (t.dataset.m === "save") {
            t.disabled = true;
            const { error } = await sb.rpc("crew_settings_save", { p: { crew_confirm_on: el("scCfOn").checked, week_email_auto: el("scWkOn").checked, week_email_dow: +el("scWkD").value, week_email_hour: +el("scWkH").value } });
            if (error) throw error;
            m.close(); toast("Saved."); reload();
          }
        } catch (e) { mErr(cleanErr(e)); t.disabled = false; }
      });
    }
    async function openWeekEmail() {
      const start = data.start;
      const m = openModal('<div class="sc-modal"><h2>Email the week of ' + esc(T.fmtDay(start)) + '</h2><p class="sc-note">Each person gets only their own schedule, with Confirm buttons for jobs they haven&#39;t answered, and an app notification. People with nothing on that week get nothing.</p>' +
        '<div id="aca-scWkList"><p class="empty">Loading&#8230;</p></div><div class="inline-error hidden" id="aca-scMErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="send" disabled>Send</button></div></div>');
      const box = m.querySelector("#aca-scWkList"), send = m.querySelector('[data-m="send"]');
      const { data: d, error } = await sb.rpc("week_email_preview", { p_start: start });
      if (error) { mErr(cleanErr(error)); box.innerHTML = ""; }
      else if (!(d || []).length) box.innerHTML = '<p class="empty">Nobody has anything on this week.</p>';
      else {
        box.innerHTML = '<ul class="sc-pick">' + d.map((p) => '<li><input type="checkbox" value="' + esc(p.user_id) + '" checked aria-label="' + esc(p.name) + '" /><span><span class="n">' + esc(p.name) + '</span><span class="s">' + esc(p.subject) +
          (p.sent_at ? " · sent " + esc(T.fmtDay(T.local(p.sent_at).day)) + " " + esc(T.fmtTs(p.sent_at)) : "") + "</span></span><span></span></li>").join("") + "</ul>";
        send.disabled = false;
      }
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") m.close();
        if (t.dataset.m === "send") {
          const who = [...box.querySelectorAll("input:checked")].map((x) => x.value);
          if (!who.length) return mErr("Pick at least one person.");
          t.disabled = true;
          try {
            const { data: r, error: e2 } = await sb.rpc("week_email_send", { p_start: start, p_users: who });
            if (e2) throw e2;
            m.close(); toast("Sent to " + num(r && r.sent) + (num(r && r.sent) === 1 ? " person." : " people.") + (num(r && r.no_email) ? " " + r.no_email + " had no email address." : ""));
          } catch (e) { mErr(cleanErr(e)); t.disabled = false; }
        }
      });
    }

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
        (e && e.edit_for ? '<p class="sc-note">Editing time, added automatically for the Lead (or the job’s Editor, if one is picked on the job page): the first hour of shooting gets an hour, each hour after that 30 minutes. Due ' + esc(dueAt(e)) + ". " +
          (e.edit_moved ? "It stays where it was put; if the job changes, only its length follows." : "Move it to whenever suits you and it stays there.") + "</p>" : "") +
        '<div class="row2"><div class="field"><label for="aca-scP">Person</label><select id="aca-scP">' + data.people.filter((p) => !limited || isMine(p.user_id)).map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === (e ? e.user_id : preset.user_id) ? " selected" : "") + ">" + esc(p.name) + "</option>").join("") + "</select></div></div>" +
        '<div class="field"><label>What</label><div class="seg" role="radiogroup" aria-label="What">' + (limited ? ["flex"] : KINDS).map((k) => '<label><input type="radio" name="aca-scK" value="' + k + '"' + (k === kind0 ? " checked" : "") + " /><span>" + KIND[k] + "</span></label>").join("") + "</div></div>" +
        '<div class="field sc-only-job"><label for="aca-scB">Job</label><select id="aca-scB"><option value="">Pick a job this week\u2026</option>' + weekBookings.map((b) => '<option value="' + esc(b.booking_id) + '" data-day="' + esc(b.day) + '"' + (e && e.booking_id === b.booking_id && b.day === day0 ? " selected" : "") + ">" + esc(T.fmtDay(b.day) + " \u00b7 " + bookingLabel(b) + (b.start_at ? " \u00b7 " + T.fmtTs(b.start_at) : "")) + "</option>").join("") +
          (e && e.booking_id && !weekBookings.some((b) => b.booking_id === e.booking_id) ? '<option value="' + esc(e.booking_id) + '" selected>' + esc(e.booking_title) + "</option>" : "") + "</select></div>" +
        ((data.crew.roles || []).length ? '<div class="field sc-only-job"><label for="aca-scRole">Role</label><select id="aca-scRole"><option value="">No role</option>' + data.crew.roles.map((r) => '<option value="' + esc(r.id) + '"' + (e && e.role_id === r.id ? " selected" : "") + ">" + esc(r.label) + "</option>").join("") + "</select></div>" : "") +
        '<div class="field sc-not-job"><label for="aca-scT">Label</label><input type="text" id="aca-scT" maxlength="120" placeholder="Editing, ordering, delivery run\u2026" value="' + esc(e ? e.title : preset.title || "") + '" /></div>' +
        '<div class="row3 sc-not-off"><div class="field"><label for="aca-scD">Day</label><input type="date" id="aca-scD" value="' + esc(day0) + '" /></div><div class="field"><label for="aca-scS">Start</label><input type="time" id="aca-scS" step="300" value="' + T.hhmm(s0) + '" /></div><div class="field"><label for="aca-scE">End</label><input type="time" id="aca-scE" step="300" value="' + T.hhmm(e0) + '" /></div></div>' +
        '<div class="row2 sc-only-off"><div class="field"><label for="aca-scO1">From</label><input type="date" id="aca-scO1" value="' + esc(day0) + '" /></div><div class="field"><label for="aca-scO2">Through</label><input type="date" id="aca-scO2" value="' + esc(offEnd) + '" /></div></div>' +
        '<div class="sc-only-job">' + driveHtml(e ? e.drive_before_min : 30, e ? e.drive_after_min : 30, e && e.kind === "job" ? e.setup_min : setupDefault(), e && e.kind === "job" ? e.teardown_min : teardownDefault()) +
          (e && e.batch_id ? '<p class="sc-note">' + esc(tripLine(e)) + ' <button type="button" class="link" data-m="trip">See the trip</button></p>' : "") + "</div>" +
        '<div class="field"><label for="aca-scN">Note</label><textarea id="aca-scN" maxlength="1000">' + esc(e ? e.note : "") + "</textarea></div>" +
        '<div class="inline-error hidden" id="aca-scMErr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" data-m="remove">Remove</button>') + (e && e.kind === "job" && !limited && jobOf(e) ? ' <button type="button" class="small" data-m="more">More people</button>' : "") +
        (e && e.kind === "job" && !limited ? ' <button type="button" class="small" data-m="batch">' + (e.batch_id ? "Add another job to this trip\u2026" : "Batch with another job\u2026") + "</button>" : "") + '<span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">' + (isNew ? "Add" : "Save") + "</button></div></div>");
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
        if (data.studio_address && !(e && e.batch_id)) lookup();
      });
      const lookup = driveControls(m, () => el("scB").value, false, () => el("scP").value);
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") m.close();
        if (t.dataset.m === "more") { m.close(); openAssign(jobOf(e)); return; }
        if (t.dataset.m === "batch") { m.close(); openBatch(e); return; }
        if (t.dataset.m === "trip") { m.close(); openTrip(e); return; }
        if (t.dataset.m === "remove") {
          if (!confirm("Remove this from " + personName(e.user_id) + "'s schedule?")) return;
          t.disabled = true;
          const rest = e.batch_id ? tripOf(e).filter((x) => x.id !== e.id) : [];
          try {
            const { error } = await sb.rpc("schedule_remove", { p_id: e.id }); if (error) throw error; m.close();
            if (rest.length) await saveTripRows(rest.length > 1 ? tripRows(rest, await planLegs(rest), e.batch_id) : [await soloRow(rest[0])]);
            toast(rest.length ? "Removed. The rest of the trip was worked out again." : "Removed."); load(); loadAttention();
          }
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
              Object.assign(p, driveVals(m));
              if (el("scRole")) p.role_id = el("scRole").value || null;
            }
          }
          // a crew bar on a makeup day with no time yet gives the makeup day its time
          const mk = k === "job" && editable() && data.bookings.find((x) => x.booking_id === p.booking_id && x.day === el("scD").value);
          const mkSet = untimedMakeup(mk) && el("scE").value > el("scS").value;
          t.disabled = true;
          try {
            const { data: r, error } = await sb.rpc("schedule_save", { p });
            if (error) throw error;
            if (mkSet) await setMakeupTime(mk, el("scS").value, el("scE").value);
            m.close();
            toast((isNew ? "Added." : "Saved.") + (num(r && r.overlaps) ? " Heads up: it overlaps other time on " + personName(p.user_id) + "'s schedule." : ""), false);
            if (T.local(p.starts_at).day < data.start || T.local(p.starts_at).day >= T.addDays(data.start, 7)) anchor = T.local(p.starts_at).day;
            // a batched bar that moved: work its trip out again (the order may have changed, or it left the trip)
            if (e && e.batch_id) await retrip(e);
            load(); loadAttention();
          } catch (err) { mErr(cleanErr(err)); t.disabled = false; }
        }
      });
    }

    // ---------------------------------------------------------------- batched trips
    // Jobs near each other are done in one trip: studio -> A -> B -> studio. A trip is one person's job bars
    // on one day sharing a batch_id. The first bar's drive there is from the studio, each later bar's from
    // the job before it, and only the last bar drives back (the drive home from the last job is taken as the
    // same as the studio to it). Right-click a job bar, or press and hold it on a phone, to batch it.
    async function lookupLeg(fromBooking, toBooking) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Signed out.");
      const r = await fetch(DRIVE_FN_URL, { method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ from_booking_id: fromBooking, booking_id: toBooking }) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "HTTP " + r.status);
      return j;
    }
    const round5 = (m) => Math.ceil(m / 5) * 5;
    const byStart = (a, b) => new Date(a.starts_at) - new Date(b.starts_at);
    const tripLine = (e) => { const t = tripOf(e); return "Stop " + (t.indexOf(e) + 1) + " of " + t.length + " on a batched trip: " + t.map((x) => shortTitle(x.booking_title)).join(" → ") + "."; };
    // The legs of a trip through these stops (in time order): studio -> first, job -> job, last -> studio.
    // A leg Google Maps can't answer keeps the minutes already on the bar, with the reason in .err.
    async function planLegs(stops) {
      return Promise.all(stops.concat([null]).map(async (to, i) => {
        const from = i ? stops[i - 1] : null;
        const fallback = !from ? to.drive_before_min : !to ? from.drive_after_min || from.drive_before_min : to.drive_before_min;
        try {
          const r = !from ? await lookupDrive(to.booking_id, to.user_id) : !to ? await lookupDrive(from.booking_id, from.user_id) : await lookupLeg(from.booking_id, to.booking_id);
          return { minutes: round5(r.minutes), meters: r.meters != null ? r.meters : null, err: "" };
        } catch (e) { return { minutes: num(fallback), meters: null, err: cleanErr(e) }; }
      }));
    }
    // What schedule_batch_save gets for a trip, and for a bar on its own (round trip from the studio).
    const tripRows = (stops, legs, batchId) => stops.map((e, i) => ({ id: e.id, batch_id: batchId, drive_before_min: legs[i].minutes, drive_before_m: legs[i].meters,
      drive_after_min: i === stops.length - 1 ? legs[i + 1].minutes : 0, drive_after_m: i === stops.length - 1 ? legs[i + 1].meters : 0 }));
    async function soloRow(e) {
      let m = e.batch_id && e.drive_after_min ? e.drive_after_min : e.drive_before_min;
      try { m = round5((await lookupDrive(e.booking_id, e.user_id)).minutes); } catch (_e) { /* keep what it has */ }
      return { id: e.id, batch_id: null, drive_before_min: m, drive_after_min: m };
    }
    async function saveTripRows(rows) { const { error } = await sb.rpc("schedule_batch_save", { p: { entries: rows } }); if (error) throw error; }
    // After a batched bar was changed: reload, then work its old trip out again.
    async function retrip(old) {
      await load();
      const now = data.entries.find((x) => x.id === old.id), rest = data.entries.filter((x) => x.batch_id === old.batch_id).sort(byStart);
      const rows = [];
      if (now && now.kind === "job" && now.batch_id !== old.batch_id) rows.push(await soloRow(now));
      if (rest.length > 1) rows.push(...tripRows(rest, await planLegs(rest), old.batch_id));
      else if (rest.length === 1) rows.push(await soloRow(rest[0]));
      if (rows.length) try { await saveTripRows(rows); } catch (e) { toast("Could not work the trip out again: " + cleanErr(e), true); }
    }

    // The trip as a timeline: leave, drive, set up, job, tear down, (wait), drive ... back at the studio.
    // With legs editable, each leg's minutes is an input (data-leg = its index).
    function tripHtml(stops, legs, editableLegs) {
      const at = (ms) => '<span class="t">' + esc(T.fmtTs(new Date(ms).toISOString())) + "</span>";
      const legIn = (i, txt) => '<li class="leg">' + '<span class="t"></span><span>' + (editableLegs ? '<input type="number" min="0" max="600" step="5" data-leg="' + i + '" value="' + num(legs[i].minutes) + '" aria-label="Minutes" />' : num(legs[i].minutes)) +
        " min " + txt + (legs[i].meters ? " (" + (legs[i].meters / 1609.34).toFixed(1) + " mi)" : "") + (legs[i].err ? ' <span class="bad">' + esc(legs[i].err) + "</span>" : "") + "</span></li>";
      let h = "", done = 0, late = 0;
      const base = fromHome(stops[0].user_id) ? "home" : "the studio";
      stops.forEach((e, i) => {
        const s = new Date(e.starts_at).getTime(), en = new Date(e.ends_at).getTime(), su = num(e.setup_min) * 6e4, td = num(e.teardown_min) * 6e4, go = s - su - legs[i].minutes * 6e4;
        if (!i) h += "<li>" + at(go) + "<span>Leave " + base + "</span></li>";
        else if (go > done) h += "<li>" + at(done) + "<span>Wait " + Math.round((go - done) / 6e4) + " min, then leave</span></li>";
        h += legIn(i, "drive to " + esc(shortTitle(e.booking_title)));
        if (i && go < done) { late += Math.round((done - go) / 6e4); h += '<li><span class="t"></span><span class="bad">' + Math.round((done - go) / 6e4) + " min late for setup</span></li>"; }
        if (su) h += "<li>" + at(s - su) + "<span>Set up (" + num(e.setup_min) + " min)</span></li>";
        h += "<li>" + at(s) + "<span><b>" + esc(e.booking_title) + "</b> until " + esc(T.fmtTs(e.ends_at)) + "</span></li>";
        if (td) h += "<li>" + at(en) + "<span>Tear down (" + num(e.teardown_min) + " min)</span></li>";
        done = en + td;
      });
      h += legIn(stops.length, "drive back " + (base === "home" ? "home" : "to the studio"));
      h += "<li>" + at(done + legs[stops.length].minutes * 6e4) + "<span>Back " + (base === "home" ? "home" : "at the studio") + "</span></li>";
      return { html: '<ul class="sc-trip">' + h + "</ul>", late };
    }
    function openTrip(e) {
      const stops = tripOf(e), legs = stops.map((x) => ({ minutes: x.drive_before_min, meters: x.drive_before_m })).concat([{ minutes: stops[stops.length - 1].drive_after_min, meters: stops[stops.length - 1].drive_after_m }]);
      const m = openModal('<div class="sc-modal"><h2>' + esc(personName(e.user_id)) + "&#39;s trip</h2><p class=\"sc-facts\">" + esc(T.fmtDay(T.local(e.starts_at).day, { weekday: "long" })) + "</p>" + tripHtml(stops, legs, false).html +
        '<div class="modal-actions">' + (editable() ? '<button type="button" class="small warn" data-m="unbatch">Take ' + esc(shortTitle(e.booking_title)) + ' out</button><button type="button" class="small" data-m="batch">Add a job</button>' : "") +
        '<span class="grow"></span><button type="button" class="primary" data-m="ok">OK</button></div></div>');
      m.addEventListener("click", (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        m.close();
        if (t.dataset.m === "unbatch") unbatch(e);
        if (t.dataset.m === "batch") openBatch(e);
      });
    }

    // Batch a bar with another job that day: one of the person's other job bars, or a job they're not on
    // yet (they're put on it). The rest of the crew on this job can come along.
    function openBatch(e) {
      const day = T.local(e.starts_at).day, trip = tripOf(e);
      const sameDay = (x) => x.kind === "job" && T.local(x.starts_at).day === day;
      const mineBars = data.entries.filter((x) => sameDay(x) && x.user_id === e.user_id && !trip.includes(x)).sort(byStart);
      const otherJobs = data.bookings.filter((b) => b.day === day && b.start_at && b.status !== "cancelled" && !data.entries.some((x) => sameDay(x) && x.user_id === e.user_id && x.booking_id === b.booking_id));
      const crew = data.entries.filter((x) => sameDay(x) && x.booking_id === e.booking_id && x.user_id !== e.user_id);
      const who = personName(e.user_id);
      if (!mineBars.length && !otherJobs.length) {
        const m = openModal('<div class="sc-modal"><h2>Batch ' + esc(shortTitle(e.booking_title)) + '</h2><p>There are no other jobs with a time on ' + esc(T.fmtDay(day, { weekday: "long" })) + " to batch it with.</p>" +
          '<div class="modal-actions"><span class="grow"></span><button type="button" class="primary" data-m="ok">OK</button></div></div>');
        m.querySelector('[data-m="ok"]').addEventListener("click", () => m.close());
        return;
      }
      const opt = (val, title, when, sub, i) => '<label><input type="radio" name="aca-scBt" value="' + esc(val) + '"' + (i === 0 ? " checked" : "") + " /><span>" + esc(title) + "<small>" + esc(when) + (sub ? " · " + esc(sub) : "") + "</small></span></label>";
      const choices = mineBars.map((x, i) => opt("e:" + x.id, x.booking_title, T.fmtTs(x.starts_at) + "–" + T.fmtTs(x.ends_at), x.batch_id ? "already on a trip" : x.booking_location || "", i))
        .concat(otherJobs.map((b, i) => opt("b:" + b.booking_id, bookingLabel(b), T.fmtTs(b.start_at) + "–" + T.fmtTs(b.end_at), who + " isn’t on it yet" + (b.location ? " · " + b.location : ""), mineBars.length + i)));
      const m = openModal('<div class="sc-modal"><h2>Batch ' + esc(shortTitle(e.booking_title)) + " with another job</h2>" +
        '<p class="sc-facts">' + esc(who) + ", " + esc(T.fmtDay(day, { weekday: "long" })) + ". The drive goes job to job instead of back to the studio in between.</p>" +
        '<div class="field"><label>Batch with</label><div class="sc-pick">' + choices.join("") + "</div></div>" +
        (crew.length ? '<div class="field"><label>Same trip for</label><div class="sc-pick">' + crew.map((x) => '<label><input type="checkbox" class="sc-crew" value="' + esc(x.user_id) + '" checked /><span>' + esc(personName(x.user_id)) + "</span></label>").join("") + "</div></div>" : "") +
        '<div class="field"><label>The trip</label><div class="sc-tripbox"><p class="sc-note">Asking Google Maps…</p></div></div>' +
        '<div class="inline-error hidden" id="aca-scMErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save" disabled>Batch them</button></div></div>');
      const box = m.querySelector(".sc-tripbox"), saveBtn = m.querySelector('[data-m="save"]');
      // A job the person isn't on yet, as the bar it will become.
      const asBar = (b, uid) => ({ id: null, user_id: uid, kind: "job", booking_id: b.booking_id, booking_title: b.title, booking_location: b.location, starts_at: b.start_at, ends_at: b.end_at,
        setup_min: setupDefault(), teardown_min: teardownDefault(), drive_before_min: 0, drive_after_min: 0 });
      // The stops of the trip for one person: this job's trip plus the picked job (and its trip).
      function stopsFor(uid, pick) {
        const base = uid === e.user_id ? e : data.entries.find((x) => sameDay(x) && x.user_id === uid && x.booking_id === e.booking_id);
        let other;
        if (pick.startsWith("e:")) {
          const pe = data.entries.find((x) => x.id === pick.slice(2));
          other = uid === e.user_id ? pe : data.entries.find((x) => sameDay(x) && x.user_id === uid && x.booking_id === pe.booking_id) || asBar(jobOf(pe) || { booking_id: pe.booking_id, title: pe.booking_title, start_at: pe.starts_at, end_at: pe.ends_at }, uid);
        } else {
          const b = data.bookings.find((x) => x.booking_id === pick.slice(2) && x.day === day);
          other = data.entries.find((x) => sameDay(x) && x.user_id === uid && x.booking_id === b.booking_id) || asBar(b, uid);
        }
        const all = tripOf(base).concat(other.id ? tripOf(other) : [other]);
        return all.filter((x, i) => !x.id || all.findIndex((y) => y.id === x.id) === i).sort(byStart);
      }
      let plan = null, seq = 0;
      async function preview() {
        const my = ++seq, pick = m.querySelector('input[name="aca-scBt"]:checked').value;
        saveBtn.disabled = true; box.innerHTML = '<p class="sc-note">Asking Google Maps…</p>';
        const stops = stopsFor(e.user_id, pick), legs = await planLegs(stops);
        if (my !== seq) return;
        plan = { pick, stops, legs };
        draw();
      }
      function draw() {
        const t = tripHtml(plan.stops, plan.legs, true);
        box.innerHTML = t.html + (t.late ? '<p class="sc-note bad" style="color:var(--err-fg)">Not enough time between the jobs: ' + t.late + " min short. You can still batch them; the bars will show it.</p>" : "") +
          '<p class="sc-note">Change any drive by typing the minutes.</p>';
        saveBtn.disabled = false;
      }
      box.addEventListener("change", (ev) => { const i = ev.target.dataset.leg; if (i == null) return; plan.legs[+i].minutes = Math.max(0, +ev.target.value || 0); plan.legs[+i].meters = null; draw(); });
      m.querySelectorAll('input[name="aca-scBt"]').forEach((r) => r.addEventListener("change", preview));
      preview();
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") m.close();
        if (t.dataset.m !== "save" || !plan) return;
        t.disabled = true;
        try {
          const people = [e.user_id].concat([...m.querySelectorAll(".sc-crew:checked")].map((x) => x.value));
          let added = 0;
          for (const uid of people) {
            const stops = uid === e.user_id ? plan.stops : stopsFor(uid, plan.pick);
            // put them on any job of the trip they aren't on yet
            for (const x of stops.filter((y) => !y.id)) {
              const { data: r, error } = await sb.rpc("schedule_save", { p: { user_id: uid, kind: "job", booking_id: x.booking_id, starts_at: x.starts_at, ends_at: x.ends_at, drive_before_min: 0, drive_after_min: 0, title: "", note: "" } });
              if (error) throw error;
              x.id = r.id; added++;
            }
            // the crew's legs are the same when their stops are the same jobs
            const same = stops.map((x) => x.booking_id).join() === plan.stops.map((x) => x.booking_id).join();
            const legs = uid === e.user_id || same ? plan.legs : await planLegs(stops);
            const batchId = (stops.find((x) => x.batch_id) || {}).batch_id || crypto.randomUUID();
            await saveTripRows(tripRows(stops, legs, batchId));
          }
          m.close();
          toast("Batched" + (people.length > 1 ? " for " + people.length + " people" : "") + "." + (added ? " " + added + " job bar" + (added === 1 ? " was" : "s were") + " added." : ""));
          load(); loadAttention();
        } catch (err) { mErr(cleanErr(err)); t.disabled = false; }
      });
    }

    // Take one bar out of its trip: it goes back to a round trip from the studio and the rest is worked out again.
    async function unbatch(e) {
      const rest = tripOf(e).filter((x) => x !== e);
      try {
        const rows = [await soloRow(e)];
        if (rest.length > 1) rows.push(...tripRows(rest, await planLegs(rest), e.batch_id));
        else rows.push(...await Promise.all(rest.map(soloRow)));
        await saveTripRows(rows);
        toast(shortTitle(e.booking_title) + " is on its own again: a round trip from the studio.");
        load();
      } catch (err) { toast("Could not take it out of the trip: " + cleanErr(err), true); }
    }

    // Right-click (desktop) or press and hold (phone) a job bar: the batching menu.
    let menuEl = null, pressTimer = null, pressed = false;
    function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
    function openMenu(en, x, y) {
      closeMenu();
      menuEl = document.createElement("div");
      menuEl.className = "sc-menu"; menuEl.setAttribute("role", "menu");
      menuEl.innerHTML = '<div class="sc-mh">' + esc(personName(en.user_id) + " · " + shortTitle(en.booking_title)) + "</div>" +
        '<button type="button" role="menuitem" data-mm="batch">' + (en.batch_id ? "Add another job to this trip…" : "Batch with another job…") + "</button>" +
        (en.batch_id ? '<button type="button" role="menuitem" data-mm="trip">See the trip</button><button type="button" role="menuitem" data-mm="unbatch">Take out of the trip</button>' : "") +
        '<button type="button" role="menuitem" data-mm="edit">Change…</button>';
      document.querySelector(".aca").appendChild(menuEl);
      const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
      menuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
      menuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
      menuEl.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-mm]"); if (!b) return;
        closeMenu();
        ({ batch: openBatch, trip: openTrip, unbatch, edit: openEntry })[b.dataset.mm](en);
      });
      menuEl.querySelector("button").focus();
    }
    const menuEntry = (target) => {
      const bar = target.closest && target.closest("[data-entry]");
      const en = bar && editable() && data.entries.find((x) => x.id === bar.dataset.entry);
      return en && en.kind === "job" && !en.gcal ? en : null;
    };
    root.addEventListener("contextmenu", (ev) => { const en = menuEntry(ev.target); if (!en) return; ev.preventDefault(); openMenu(en, ev.clientX, ev.clientY); });
    root.addEventListener("touchstart", (ev) => {
      pressed = false; clearTimeout(pressTimer);
      const en = menuEntry(ev.target); if (!en || ev.touches.length !== 1) return;
      const p = ev.touches[0];
      pressTimer = setTimeout(() => { pressed = true; openMenu(en, p.clientX, p.clientY); if (navigator.vibrate) navigator.vibrate(10); }, 500);
    }, { passive: true });
    ["touchmove", "touchend", "touchcancel"].forEach((n) => root.addEventListener(n, () => clearTimeout(pressTimer), { passive: true }));
    document.addEventListener("mousedown", (ev) => { if (menuEl && !menuEl.contains(ev.target)) closeMenu(); });
    document.addEventListener("touchstart", (ev) => { if (menuEl && !menuEl.contains(ev.target)) closeMenu(); }, { passive: true });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeMenu(); });
    window.addEventListener("scroll", closeMenu, true);

    // ---------------------------------------------------------------- view-only details
    function openInfo(e) {
      const m = openModal('<div class="sc-modal"><h2>' + esc(personName(e.user_id)) + ": " + esc(e.kind === "job" ? e.booking_title : e.kind !== "off" ? (e.title || KIND[e.kind]) : "Time off" + (e.title ? " (" + e.title + ")" : "")) + "</h2>" +
        '<p class="sc-facts">' + (e.kind === "off" ? esc(T.fmtDay(T.local(e.starts_at).day, { weekday: "long" })) + " through " + esc(T.fmtDay(T.addDays(T.local(e.ends_at).day, T.local(e.ends_at).min === 0 ? -1 : 0), { weekday: "long" }))
          : esc(T.fmtDay(T.local(e.starts_at).day, { weekday: "long" })) + ", " + esc(T.fmtTs(e.starts_at)) + "\u2013" + esc(T.fmtTs(e.ends_at))) +
        (e.kind === "job" ? "<br>" + (e.batch_id && tripOf(e)[0] !== e ? "Leave the last job by " : "Leave by ") + esc(T.fmtTs(new Date(outAt(e)).toISOString())) + " (" + num(e.drive_before_min) + " min drive, " + num(e.setup_min) + " min setup), " +
          (e.drive_after_min ? "back about " + esc(T.fmtTs(new Date(backAt(e)).toISOString())) : "on to the next job after " + num(e.teardown_min) + " min teardown") : "") +
        (e.batch_id ? "<br>" + esc(tripLine(e)) : "") +
        (e.booking_location ? "<br>" + esc(e.booking_location) : "") + (e.edit_due ? "<br>Editing time, due " + esc(dueAt(e)) : "") + (e.note ? "<br>" + esc(e.note) : "") + "</p>" +
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

    // Studio address and default setup/teardown: one dialog, opened from Schedule (Drive & setup) and from
    // Settings > Company.
    async function openStudio(opts) {
      opts = opts || {};
      let src;
      try { src = await scheduleData(); } catch (e) { toast(cleanErr(e), true); return; }
      const setupDefault = () => src.setup_default != null ? src.setup_default : 30;
      const teardownDefault = () => src.teardown_default != null ? src.teardown_default : 30;
      const m = openModal('<div class="sc-modal"><h2>Drive &amp; setup</h2><p>Drive times are measured from the studio to each job&#39;s location (or the organization and town when a booking has no location), using Google Maps. Batched jobs drive job to job. Anyone with a home address on the Team page is measured from home instead of the studio.</p>' +
        '<div class="field"><label for="aca-scAddr">Studio address</label><input type="text" id="aca-scAddr" maxlength="300" value="' + esc(src.studio_address || "") + '" placeholder="Search Google Maps or type street, town, state" /><div id="aca-scAddrNote" style="margin-top:4px;font-size:12px;color:var(--muted)"></div></div>' +
        '<div class="row2"><div class="field"><label for="aca-scSuD">Setup before each job (min)</label><input type="number" id="aca-scSuD" min="0" max="240" step="5" value="' + num(setupDefault()) + '" /></div>' +
        '<div class="field"><label for="aca-scTdD">Teardown after each job (min)</label><input type="number" id="aca-scTdD" min="0" max="240" step="5" value="' + num(teardownDefault()) + '" /></div></div>' +
        '<label class="muted" style="display:flex;gap:8px;align-items:center;font-size:13px;margin:-4px 0 12px"><input type="checkbox" id="aca-scSuAll" /> Also change jobs already on the schedule from today on</label>' +
        '<div class="inline-error hidden" id="aca-scMErr"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">Save</button></div></div>');
      Places.attach(el("scAddr"), { note: el("scAddrNote"), hint: "Pick the studio from the list so drive times start from the exact spot." });
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") m.close();
        if (t.dataset.m === "save") {
          t.disabled = true;
          try {
            const { error } = await sb.rpc("schedule_settings_save", { p_studio_address: el("scAddr").value.trim() }); if (error) throw error;
            const { data: r, error: e2 } = await sb.rpc("schedule_setup_save", { p_setup: +el("scSuD").value || 0, p_teardown: +el("scTdD").value || 0, p_apply: el("scSuAll").checked }); if (e2) throw e2;
            m.close(); toast(num(r && r.changed) ? "Saved. " + num(r.changed) + " job" + (r.changed === 1 ? "" : "s") + " changed." : "Saved."); if (data) await load(); if (opts.onSaved) opts.onSaved();
          }
          catch (e) { mErr(cleanErr(e)); t.disabled = false; }
        }
      });
    }

    // ---------------------------------------------------------------- from Book a job
    // The team, for "Who's shooting" on the booking form.
    async function team() {
      const { data: d, error } = await sb.rpc("schedule_week", { p_start: T.today(), p_days: 1 });
      if (error) throw error;
      return (d.people || []).map((p) => Object.assign({}, p, { name: T.shortName(p.name) }));
    }
    // Put people on every day of a booking that has a time (with drive time from Google Maps when it can be
    // looked up). Returns {added, untimed: [days without a time yet]}.
    async function staffBooking(bookingId, fromDay, toDay, userIds) {
      const { data: d, error } = await sb.rpc("schedule_week", { p_start: fromDay, p_days: Math.min(42, T.daysBetween(fromDay, toDay) + 1) });
      if (error) throw error;
      const days = (d.bookings || []).filter((b) => b.booking_id === bookingId);
      // the drive from the studio, or from home for anyone with a home address
      const driveFor = {};
      for (const uid of days.some((b) => b.start_at) ? userIds : []) {
        const home = (d.people || []).some((p) => p.user_id === uid && p.from_home);
        if (!home && !d.studio_address) { driveFor[uid] = 0; continue; }
        if (!home && "studio" in driveFor) { driveFor[uid] = driveFor.studio; continue; }
        try { driveFor[uid] = Math.ceil((await lookupDrive(bookingId, home ? uid : null)).minutes / 5) * 5; } catch (e) { driveFor[uid] = 0; }
        if (!home) driveFor.studio = driveFor[uid];
      }
      let added = 0;
      for (const b of days.filter((x) => x.start_at)) {
        for (const uid of userIds) {
          const drive = driveFor[uid] || 0;
          const { error: e2 } = await sb.rpc("schedule_save", { p: { user_id: uid, kind: "job", booking_id: bookingId, starts_at: b.start_at, ends_at: b.end_at, drive_before_min: drive, drive_after_min: drive, title: "", note: "" } });
          if (e2) throw e2;
          added++;
        }
      }
      if (data) load();
      loadAttention();
      return { added, untimed: days.filter((x) => !x.start_at).map((x) => x.day) };
    }

    // Open the Schedule on a day's week with that day outlined; with a booking, its assign dialog too (Time off approvals, B7).
    function showJob(bookingId, day) {
      anchor = highlight = day; pendingAssign = bookingId ? { id: bookingId, day } : null;
      view = narrow() ? "day" : "week";
      root.querySelector('input[name="aca-scView"][value="' + view + '"]').checked = true;
      showTab("schedule");
      load();
    }

    return { load, loadAttention, team, staffBooking, openCrewSettings, openStudio, scheduleData, showJob };
  })();
