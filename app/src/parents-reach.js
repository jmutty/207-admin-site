  // ================================================================ JOBS: did families hear? (2026-10-24, adaptive booking emails)
  // The job page's Hub tab (was Parents + the Hub activity page, 2026-10-25): each hub message the league or school sends
  // families (grabbed, by whom, copied too early to count, late or not yet), the roster, coaches, student data, weather
  // checks and which email links the director opened, each section with a line saying what it holds. Plus the staff
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
  .aca .pr-intro { margin: 0 0 20px; max-width: 760px; font-size: 14px; line-height: 1.5; }
  .aca .pr-note { margin: -2px 0 10px; max-width: 760px; font-size: 13px; line-height: 1.5; color: var(--muted); }
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
        // No roster shows on Today as its own line from the roster tag (bookings.js rosterLate), so not twice.
        const rows = kind === "roster" ? [] : mine.filter((f) => f.kind === kind);
        const seen = new Set();
        const jobs = rows.filter((f) => !seen.has(f.booking_id) && seen.add(f.booking_id)).map((f) => ({ id: f.booking_id, title: f.org || "A job", day: f.picture_day, tab: "hub" }));
        setAttention(key, jobs.length, rows.length ? rows[0].title : "", "bookings", "warn", null, jobs);
      });
    }

    const dayOrNot = (d) => (d ? Fmt.day(d) : "");
    // Did they grab it? A copy counts only close to when it was due; an earlier one is shown but doesn't count.
    function msgStatus(m, today, send) {
      const fm = { email: "email", text: "text", flyer: "flyer", social: "social post" };
      const who = send && send.grabs > 0 ? [(send.who || []).join(", "), (send.formats || []).map((f) => fm[f] || f).join(", ")].filter(Boolean).join(" \u00b7 ") : "";
      const by = who ? '<div class="m">By ' + esc(who) + "</div>" : "";
      if (m.sent_at) return '<span class="pill ok">Grabbed ' + esc(Fmt.day(String(m.sent_at).slice(0, 10))) + "</span>" + by;
      const early = m.copied_at ? '<div class="m">Copied ' + esc(Fmt.day(m.copied_at)) + ", too early to count" + (m.counts_from ? " (counts from " + esc(Fmt.day(m.counts_from)) + ")" : "") + "</div>" : "";
      if (!m.due) return '<span class="pill">Not yet</span>' + early + by;
      return (String(m.due) < today ? '<span class="pill err">Late: not grabbed</span>' : '<span class="pill">Not yet</span>') + early + by;
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
      const hub = await hubFor(bk, d);
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const school = d.audience === "school";
      const them = school ? "the school" : "the league";
      const sec = (title, note, body) => '<div class="pr-sec"><h3>' + title + "</h3>" + (note ? '<p class="pr-note">' + note + "</p>" : "") + body + "</div>";
      const tasks = d.followups || [];
      let h = '<p class="pr-intro">How families hear about picture day. ' + (school ? "The school" : "The league") +
        " sends parents our messages from its hub page; this tab shows whether they did, what we still need from them, and anything we have to do.</p>";
      if (tasks.length) h += sec("For us to do", "", tasks.map((f) => taskHtml(f, d.audience)).join(""));
      const sendOf = (m) => hub && (hub.row.sends || []).find((x) => x.key === m.key || (m.key === "day" && /^day-/.test(x.key || "")));
      h += sec("Messages " + them + " sends families",
        "Each one is ready on their hub page to copy or download. Grabbed means they took it, close enough to the date to count. On each send day we email them a reminder, unless they already grabbed it.",
        (hub ? '<p class="pr-facts" style="margin:0 0 8px">' + hub.facts + "</p>" : "") +
        '<div style="overflow-x:auto"><table class="pr-tbl"><thead><tr><th>Message</th><th>Send on</th><th>Did they grab it?</th></tr></thead><tbody>' +
        (d.messages || []).map((m) => "<tr><td>" + esc(m.title) + '</td><td class="m">' + esc(dayOrNot(m.due) || "after the gallery opens") + "</td><td>" + msgStatus(m, today, sendOf(m)) + "</td></tr>").join("") +
        "</tbody></table></div>");
      const facts = [
        school ? "<span>Student data: <b>" + (d.school_data_at ? "in " + esc(Fmt.day(d.school_data_at)) : "not yet") + "</b></span>"
          : "<span>Roster with parent emails: <b>" + (d.roster_loaded_at ? "loaded " + esc(Fmt.day(d.roster_loaded_at)) : "not yet") + "</b>" + (num(d.code_count) ? " (" + num(d.code_count) + " codes)" : "") + "</span>",
        school ? "" : "<span>Coach emails: <b>" + num(d.coaches) + "</b></span>",
        "<span>Shooting: <b>" + esc(SHOOT[d.shoot_setting] || "Not set") + "</b></span>",
      ].filter(Boolean).join("");
      h += sec("What we have from " + them, school ? "The student data file lets parents find their photos." :
        "With a roster we email parents directly. Without one, coaches are the backup for reaching families.", '<div class="pr-facts">' + facts + "</div>");
      if ((d.weather || []).length) {
        h += sec("Weather", "Checked from three days out for outdoor shoots.", '<table class="pr-tbl"><thead><tr><th>Day</th><th>Forecast during the shoot</th><th>Checked</th></tr></thead><tbody>' +
          d.weather.map((w) => "<tr><td>" + esc(Fmt.day(w.day)) + "</td><td>" + (w.error ? '<span class="pill">Couldn&#39;t check</span> <span class="m">' + esc(w.error) + "</span>"
            : '<span class="pill ' + (w.bad ? "err" : "ok") + '">' + esc(num(w.max_pop) + "% rain, gusts to " + num(w.max_gust) + " mph") + "</span>") +
            '</td><td class="m">' + esc(Fmt.dayTime(w.checked_at)) + "</td></tr>").join("") + "</tbody></table>");
      }
      const clicks = d.clicks || [];
      h += sec("What they opened from our emails", "Links " + them + " clicked in emails we sent them.", clicks.length
        ? '<table class="pr-tbl"><tbody>' + clicks.map((c) => "<tr><td>" + esc(linkName(c.url)) + '<div class="m">' + esc(c.subject || "") + '</div></td><td class="m">' + esc(Fmt.dayTime(c.at)) + "</td></tr>").join("") + "</tbody></table>"
        : '<p class="empty" style="margin:0">None yet.</p>');
      const fam = typeof GpTasks !== "undefined" ? await GpTasks.familiesLine(bk.id) : "";
      if (fam) h += sec("Families in GotPhoto", "Registered means the family signed in with their code. Updated every few hours.", '<div class="pr-facts">' + fam + "</div>");
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
    // This job's row from the hub (who grabbed what, the hub link) and who gets the send-day reminders. Only for
    // people with the hub area; null when the job isn't on the hub yet.
    async function hubFor(bk, d) {
      if (!canSee("hub") || typeof HubActivity === "undefined") return null;
      try {
        const { data: rows } = await sb.rpc("admin_bookings", { p_from: bk.picture_day, p_to: bk.picture_day });
        const b = (rows || []).find((r) => r.id === bk.id) || {};
        const orgId = d.audience === "school" ? b.hub_school_id : bk.gotphoto_job_id || b.gotphoto_job_id;
        const row = await HubActivity.forBooking(d.audience, orgId);
        if (!row) return null;
        const who = (b.contacts || []).map((c) => c.name || c.email).filter(Boolean);
        const facts = '<span><a href="' + esc(HubActivity.link(d.audience, orgId)) + '" target="_blank" rel="noopener">Open their hub page</a></span>' +
          "<span>Reminders go to: <b>" + (who.length ? esc(who.join(", ")) : "nobody yet") + '</b> <a href="' + esc(jobLink(bk.id, "booking")) + '">change</a></span>';
        return { row, facts };
      } catch (_e) { return null; }
    }
    function linkName(u) {
      const s = String(u || "");
      const m = /\/send=([a-z0-9-]+)/.exec(s);
      if (m) return "Hub message: " + ({ heads: "One week before", live: "Photos are online", lastcall: "Last call", m1: "Two weeks before", m2: "One week before", m3: "Day before",
        m4: "Gallery published", r1: "Makeup day, one week out", r2: "Makeup day, day before" }[m[1]] || (/^day-/.test(m[1]) ? "Day before" : m[1]));
      if (/#day\//.test(s)) return "Their picture day page";
      if (/booking-ics/.test(s)) return "Add to calendar";
      if (/207photo\.com\/(sports|school)admin/.test(s)) return "The hub";
      return s;
    }
    return { loadAttention, render };
  })();
  if (typeof registerJobTab === "function") registerJobTab({ id: "hub", label: "Hub", order: 14, module: "bookings", render: (bk, box) => ParentsReach.render(bk, box) });
