  // ================================================================ JOBS: did families hear? (2026-10-24, adaptive booking emails)
  // The job page's Parents tab: each hub message for the job (sent, copied too early to count, or not yet), the
  // roster, coaches, student data, weather checks and which email links the director opened. Plus the staff
  // tasks the email series raises (booking_followups) on Today, for whoever booked the job:
  //   followParents  families weren't sent the one-week or gallery message and there are no coaches to fall back on
  //   followRoster   a Parent Contacts job has no roster two weeks out: keep the date (run as Roster Only), move it, or wait
  //   followWeather  20%+ rain or gusts over 25 mph during an outdoor shoot, from three days out
  // RPCs (migration 20261024080000_adaptive_booking_emails.sql): booking_parents, booking_followups_mine,
  // booking_followup_done, booking_followup_snooze, booking_run_roster_only.
  registerAttention("followParents", { module: "bookings", level: "warn", name: "families not reached", mine: true,
    one: "Families on a job haven't been sent their picture day message, and there are no coaches to fall back on. Call the director.",
    many: "Families on {n} jobs haven't been sent their picture day messages. Call the directors." });
  registerAttention("followRoster", { module: "bookings", level: "warn", name: "jobs with no roster", mine: true,
    one: "A Parent Contacts job is two weeks out with no roster. Keep the date or move it.",
    many: "{n} Parent Contacts jobs are two weeks out with no roster. Keep the dates or move them." });
  registerAttention("followWeather", { module: "bookings", level: "warn", name: "weather watch", mine: true,
    one: "Rain or wind is in the forecast for an outdoor picture day.", many: "Rain or wind is in the forecast for {n} outdoor picture days." });
  Object.assign(JOB_REASON, { followParents: "families haven't been told: call the director", followRoster: "no roster two weeks out",
    followWeather: "rain or wind in the forecast" });
  registerTodayLoader("bookings", () => ParentsReach.loadAttention());

  const ParentsReach = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const KIND_KEY = { parents: "followParents", roster: "followRoster", weather: "followWeather" };
    const SHOOT = { indoors: "Indoors", outdoors: "Outdoors", either: "Indoors or outdoors" };
    const st = document.createElement("style");
    st.textContent = `
  .aca .pr-sec { margin: 0 0 22px; max-width: 820px; }
  .aca .pr-sec > h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .aca .pr-facts { display: flex; flex-wrap: wrap; gap: 6px 22px; font-size: 13.5px; color: var(--muted); }
  .aca .pr-facts b { color: var(--text); font-weight: 600; }
  .aca .pr-task { border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px; padding: 10px 14px; margin: 0 0 10px; background: var(--surface); }
  .aca .pr-task.done { border-left-color: var(--border); background: var(--surface-2); }
  .aca .pr-task h4 { margin: 0 0 4px; font-size: 14.5px; font-weight: 600; }
  .aca .pr-task p { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--muted); overflow-wrap: anywhere; }
  .aca .pr-acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .aca .pr-tbl { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  .aca .pr-tbl th { text-align: left; font-weight: 600; color: var(--muted); font-size: 12.5px; padding: 4px 10px 6px 0; border-bottom: 1px solid var(--border); }
  .aca .pr-tbl td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
  .aca .pr-tbl .m { color: var(--muted); font-size: 12.5px; }
  @media (max-width: 640px) { .aca .pr-acts button { flex: 1; } }`;
    document.head.appendChild(st);

    let mine = [];
    async function loadAttention() {
      try {
        const { data, error } = await sb.rpc("booking_followups_mine");
        if (error) throw error;
        mine = data || [];
      } catch (_e) { mine = []; }
      Object.entries(KIND_KEY).forEach(([kind, key]) => {
        const rows = mine.filter((f) => f.kind === kind);
        const seen = new Set();
        const jobs = rows.filter((f) => !seen.has(f.booking_id) && seen.add(f.booking_id)).map((f) => ({ id: f.booking_id, title: f.org || "A job", day: f.picture_day, tab: "parents" }));
        setAttention(key, jobs.length, rows.length ? rows[0].title : "", "bookings", "warn", null, jobs);
      });
    }

    const dayOrNot = (d) => (d ? Fmt.day(d) : "");
    function msgStatus(m, today) {
      if (m.sent_at) return '<span class="pill ok">Sent ' + esc(Fmt.dayTime(m.sent_at)) + "</span>";
      const early = m.copied_at ? '<div class="m">Copied ' + esc(Fmt.day(m.copied_at)) + ", too early to count" + (m.counts_from ? " (counts from " + esc(Fmt.day(m.counts_from)) + ")" : "") + "</div>" : "";
      if (!m.due) return '<span class="pill">Not yet</span>' + early;
      return (String(m.due) < today ? '<span class="pill err">Not sent</span>' : '<span class="pill">Not yet</span>') + early;
    }
    function taskHtml(f, audience) {
      const open = !f.done_at;
      let acts = "";
      if (open) {
        if (f.kind === "roster") {
          acts = '<button type="button" class="primary small" data-pr-roster="' + esc(f.id) + '">Keep date (run as Roster Only)</button>' +
            '<button type="button" class="small" data-pr-move="1">Move date</button>' +
            '<button type="button" class="small" data-pr-snooze="' + esc(f.id) + '" data-days="2">Wait 2 days</button>';
        } else {
          acts = '<button type="button" class="primary small" data-pr-done="' + esc(f.id) + '">' + (f.kind === "weather" ? "Handled" : "Called, done") + "</button>" +
            '<button type="button" class="small" data-pr-snooze="' + esc(f.id) + '" data-days="1">Tomorrow</button>';
        }
      }
      return '<div class="pr-task' + (open ? "" : " done") + '"><h4>' + esc(f.title) + "</h4><p>" + esc(f.detail) + "</p>" +
        (open ? (f.snooze_until ? '<p>Snoozed until ' + esc(Fmt.day(f.snooze_until)) + ".</p>" : "") : "<p>Done " + esc(Fmt.day(f.done_at)) + (f.done_note ? ": " + esc(f.done_note) : "") + "</p>") +
        (acts ? '<div class="pr-acts">' + acts + "</div>" : "") + "</div>";
    }

    async function render(bk, box) {
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      let d;
      try {
        const { data, error } = await sb.rpc("booking_parents", { p_booking: bk.id });
        if (error) throw error;
        d = data;
      } catch (e) { box.innerHTML = '<div class="inline-error">Could not load: ' + esc(cleanErr(e)) + "</div>"; return; }
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const school = d.audience === "school";
      const facts = [
        "<span>Shooting: <b>" + esc(SHOOT[d.shoot_setting] || "Not set") + "</b></span>",
        school ? "<span>Student data: <b>" + (d.school_data_at ? "in " + esc(Fmt.day(d.school_data_at)) : "not yet") + "</b></span>"
          : "<span>Coaches on file: <b>" + num(d.coaches) + "</b></span>",
        school ? "" : "<span>Roster: <b>" + (d.roster_loaded_at ? "loaded " + esc(Fmt.day(d.roster_loaded_at)) : "not yet") + "</b>" + (num(d.code_count) ? " (" + num(d.code_count) + " codes)" : "") + "</span>",
      ].filter(Boolean).join("");
      const tasks = d.followups || [];
      let h = '<div class="pr-sec"><div class="pr-facts">' + facts + "</div></div>";
      if (tasks.length) h += '<div class="pr-sec"><h3>For us to do</h3>' + tasks.map((f) => taskHtml(f, d.audience)).join("") + "</div>";
      h += '<div class="pr-sec"><h3>Messages to families</h3><p class="muted" style="margin:0 0 8px;font-size:13px">A copy on the hub counts as sent only close to when it was due' +
        " (a copy weeks early, or three messages grabbed at once, doesn't). When one counts, the reminder email for it isn't sent.</p>" +
        '<div style="overflow-x:auto"><table class="pr-tbl"><thead><tr><th>Message</th><th>Due</th><th>On the hub</th></tr></thead><tbody>' +
        (d.messages || []).map((m) => "<tr><td>" + esc(m.title) + '</td><td class="m">' + esc(dayOrNot(m.due) || "after the gallery opens") + "</td><td>" + msgStatus(m, today) + "</td></tr>").join("") +
        "</tbody></table></div></div>";
      if ((d.weather || []).length) {
        h += '<div class="pr-sec"><h3>Weather</h3><table class="pr-tbl"><thead><tr><th>Day</th><th>Forecast during the shoot</th><th>Checked</th></tr></thead><tbody>' +
          d.weather.map((w) => "<tr><td>" + esc(Fmt.day(w.day)) + "</td><td>" + (w.error ? '<span class="pill">Couldn&#39;t check</span> <span class="m">' + esc(w.error) + "</span>"
            : '<span class="pill ' + (w.bad ? "err" : "ok") + '">' + esc(num(w.max_pop) + "% rain, gusts to " + num(w.max_gust) + " mph") + "</span>") +
            '</td><td class="m">' + esc(Fmt.dayTime(w.checked_at)) + "</td></tr>").join("") + "</tbody></table></div>";
      }
      const clicks = d.clicks || [];
      h += '<div class="pr-sec"><h3>Links opened from our emails</h3>' + (clicks.length
        ? '<table class="pr-tbl"><tbody>' + clicks.map((c) => "<tr><td>" + esc(linkName(c.url)) + '<div class="m">' + esc(c.subject || "") + '</div></td><td class="m">' + esc(Fmt.dayTime(c.at)) + "</td></tr>").join("") + "</tbody></table>"
        : '<p class="empty" style="margin:0">None yet.</p>') + "</div>";
      box.innerHTML = h;
      box.onclick = async (ev) => {
        const done = ev.target.closest("[data-pr-done]"), snooze = ev.target.closest("[data-pr-snooze]"), roster = ev.target.closest("[data-pr-roster]"), move = ev.target.closest("[data-pr-move]");
        if (move) { location.hash = jobLink(bk.id, "booking"); return; }
        const btn = done || snooze || roster;
        if (!btn) return;
        btn.disabled = true;
        try {
          let r;
          if (done) r = await sb.rpc("booking_followup_done", { p_id: done.dataset.prDone, p_note: null });
          else if (snooze) r = await sb.rpc("booking_followup_snooze", { p_id: snooze.dataset.prSnooze, p_days: +snooze.dataset.days || 1 });
          else r = await sb.rpc("booking_run_roster_only", { p_booking: bk.id });
          if (r.error) throw r.error;
          toast(roster ? "Kept the date. This job now gets the Roster Only emails." : done ? "Done." : "Snoozed.");
          loadAttention();
          render(bk, box);
        } catch (e) { btn.disabled = false; toast(cleanErr(e), true); }
      };
    }
    function linkName(u) {
      const s = String(u || "");
      const m = /\/send=([a-z0-9-]+)/.exec(s);
      if (m) return "Hub message: " + ({ heads: "One week before", live: "Photos are online", lastcall: "Last call", m1: "Two weeks before", m2: "One week before", m3: "Day before",
        m4: "Gallery published", r1: "Retake day, one week out", r2: "Retake day, day before" }[m[1]] || (/^day-/.test(m[1]) ? "Day before" : m[1]));
      if (/#day\//.test(s)) return "Their picture day page";
      if (/booking-ics/.test(s)) return "Add to calendar";
      if (/207photo\.com\/(sports|school)admin/.test(s)) return "The hub";
      return s;
    }
    return { loadAttention, render };
  })();
  if (typeof registerJobTab === "function") registerJobTab({ id: "parents", label: "Parents", order: 14, module: "bookings", render: (bk, box) => ParentsReach.render(bk, box) });
