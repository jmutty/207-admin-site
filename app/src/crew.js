  // ================================================================ STAFF: My jobs, time off, crew confirmations (2026-10-23)
  // Putting someone on a job just assigns it. Only with Ask people to confirm turned on (Settings, Scheduling; off by
  // default since 2026-10-23) does a booked job ask them to confirm it (email + push, a few minutes later). They answer
  // without signing in at #crew/<token> (CrewPublic below), or here on My jobs. Time off: everyone asks for
  // their own on the Time off tab; Time off Edit approves (that puts a Time off bar on the Schedule).
  // CrewPick is the crew picker's data (who is free, roles, drive from home) for the Schedule and Book a job.
  // RPCs: crew_mine / crew_answer / crew_attention, time_off_list / time_off_request / time_off_cancel /
  // time_off_decide, crew_options / crew_for_booking / crew_ask_now (scheduling). Drive from home comes from the
  // offer-drive edge function in mode "crew".
  registerPage({ id: "crew", group: "Staff", section: "staff", module: null, title: "My jobs", selfService: true,
                 tabs: [["crew", "My jobs"], ["timeoff", "Time off"]], onShow: (tab) => (tab === "timeoff" ? Crew.loadTimeOff() : Crew.loadMine()) });
  registerAttention("crewMine", { module: null, level: "warn", name: "jobs to confirm",
    one: "You were put on a job. Confirm it or say you can't make it.", many: "You were put on {n} jobs. Confirm them or say you can't make it." });
  registerAttention("crewWaiting", { module: "scheduling", level: "soon", name: "crew answers",
    one: "Someone on a job this week hasn't confirmed yet.", many: "{n} people on jobs this week haven't confirmed yet." });
  registerAttention("timeOffPending", { module: "timeoff", level: "warn", name: "time off requests",
    one: "A time off request is waiting for you.", many: "{n} time off requests are waiting for you." });
  registerTodayLoader(null, () => Crew.loadAttention());

  const CREW_STATUS = { pending: ["Waiting", "warn"], confirmed: ["Confirmed", "ok"], declined: ["Can't make it", "err"] };

  const Crew = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const mapLink = (loc) => '<a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(loc) + '" target="_blank" rel="noopener">' + esc(loc) + "</a>";

    const css = `
    .aca .cr-sec { margin: 0 0 26px; max-width: 760px; }
    .aca .cr-sec > h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .aca .cr-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin: 0 0 10px; background: var(--surface); }
    .aca .cr-card.done { background: var(--surface-2); }
    .aca .cr-card h4 { margin: 0 0 4px; font-size: 15px; font-weight: 600; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
    .aca .cr-facts { margin: 0; font-size: 13.5px; color: var(--muted); line-height: 1.55; }
    .aca .cr-facts b { color: var(--text); font-weight: 600; }
    .aca .cr-acts { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .aca .cr-acts button { min-height: 40px; padding: 0 18px; }
    .aca .cr-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; max-width: 520px; }
    .aca .cr-form .field { margin: 0; } .aca .cr-form .field input, .aca .cr-form .field textarea { width: 100%; }
    .aca .cr-form .wide { grid-column: 1 / -1; }
    .aca .cr-form textarea { height: 56px; padding: 6px 10px; }
    .aca .cr-form label.cb { display: flex; gap: 8px; align-items: center; font-weight: 400; font-size: 13.5px; }
    .aca .cr-warn { font-size: 13px; color: var(--warn-fg); margin-top: 6px; }
    @media (max-width: 640px) { .aca .cr-form { grid-template-columns: 1fr; } .aca .cr-acts button { flex: 1; } }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    const jobRoot = el("panel-crew"), offRoot = el("panel-timeoff");
    jobRoot.innerHTML = '<div id="aca-crErr" class="inline-error hidden"></div><div class="cr-sec"><h3>Your jobs</h3><div id="aca-crMine"><p class="empty">Loading&#8230;</p></div></div>';
    offRoot.innerHTML = '<div id="aca-toErr" class="inline-error hidden"></div>' +
      '<div class="cr-sec hidden" id="aca-toWaitSec"><h3>Waiting for you</h3><div id="aca-toWait"></div></div>' +
      '<div class="cr-sec hidden" id="aca-toTeamSec"><h3>The team</h3><div id="aca-toTeam"></div></div>' +
      '<div id="aca-toOwn"><button type="button" class="small hidden" id="aca-toOwnBtn" aria-expanded="false" style="margin:0 0 14px">Your own time off</button><div id="aca-toOwnBody">' +
      '<div class="cr-sec"><h3>Ask for time off</h3><div class="cr-form">' +
        '<div class="field"><label for="aca-toA">First day</label><input type="date" id="aca-toA" /></div>' +
        '<div class="field cr-thru"><label for="aca-toZ">Through</label><input type="date" id="aca-toZ" /></div>' +
        '<label class="cb wide"><input type="checkbox" id="aca-toHours" /> Only some hours that day</label>' +
        '<div class="field cr-hrs hidden"><label for="aca-toS">From</label><input type="time" id="aca-toS" step="300" value="09:00" /></div>' +
        '<div class="field cr-hrs hidden"><label for="aca-toE">Until</label><input type="time" id="aca-toE" step="300" value="12:00" /></div>' +
        '<div class="field wide"><label for="aca-toNote">Note (optional)</label><textarea id="aca-toNote" maxlength="500" placeholder="Doctor, vacation, kid&#39;s game&#8230;"></textarea></div>' +
        '<div class="wide"><button type="button" class="primary" id="aca-toSend">Send request</button></div></div></div>' +
      '<div class="cr-sec"><h3>Your requests</h3><div id="aca-toMine"><p class="empty">Loading&#8230;</p></div></div></div></div>';
    // B6 (ws/settings 2026-10-24): someone who approves time off sees Waiting for you and The team first; their own
    // requests and the form fold behind "Your own time off" (open when they have one waiting).
    let ownOpen = null;
    el("toOwnBtn").addEventListener("click", () => { ownOpen = !ownOpen; showOwn(); });
    function showOwn() {
      const fold = !!(TO && TO.can_edit);
      el("toOwnBtn").classList.toggle("hidden", !fold);
      el("toOwnBtn").setAttribute("aria-expanded", String(!fold || !!ownOpen));
      el("toOwnBtn").textContent = (ownOpen ? "Hide your own time off" : "Your own time off") + ((n) => n ? " (" + n + " waiting)" : "")(TO ? TO.mine.filter((r) => r.status === "pending").length : 0);
      el("toOwnBody").classList.toggle("hidden", fold && !ownOpen);
    }

    // "Sat Oct 25, 9am-12pm (Lead) · leave 8:15am" (· "from home" for people who start at home, 2026-10-24)
    const dayLine = (d, home) => T.fmtDay(T.local(d.starts_at).day) + ", " + T.fmtTs(d.starts_at) + "–" + T.fmtTs(d.ends_at) + (d.role ? " (" + d.role + ")" : "") +
      (d.drive_before_min ? " · leave " + T.fmtTs(new Date(new Date(d.starts_at) - d.drive_before_min * 6e4).toISOString()) + (home ? " from home" : "") : "");
    // The job's page (notes, contacts, crew, checklist) from each card; job_get lets the crew in.
    const jobHref = (id, tab) => (typeof jobLink === "function" && id ? jobLink(id, tab) : "");
    const titleLink = (id, title) => { const h = jobHref(id); return h ? '<a href="' + esc(h) + '">' + esc(title) + "</a>" : esc(title); };
    const chip = (st) => st && CREW_STATUS[st] ? '<span class="pill ' + CREW_STATUS[st][1] + '">' + CREW_STATUS[st][0] + "</span>" : "";

    // ---------------------------------------------------------------- my jobs
    let mine = [];
    async function loadMine() {
      clearError("crErr");
      try {
        const { data, error } = await sb.rpc("crew_mine");
        if (error) throw error;
        mine = data || [];
        renderMine();
      } catch (e) { showError("crErr", "Could not load your jobs: " + cleanErr(e)); }
      loadAttention();
    }
    function renderMine() {
      if (!mine.length) { el("crMine").innerHTML = '<p class="empty">You are not on any jobs in the next two months.</p>'; return; }
      el("crMine").innerHTML = mine.map((j) => '<div class="cr-card' + (j.status === "confirmed" ? " done" : "") + '"><h4>' + titleLink(j.booking_id, j.title) + chip(j.status) + "</h4>" +
        '<p class="cr-facts">' + j.days.map((d) => "<b>" + esc(dayLine(d, j.from_home)) + "</b>" + (d.note ? "<br>" + esc(d.note) : "")).join("<br>") + (j.location ? "<br>" + mapLink(j.location) : "") +
        // "Checklist: 2 open, 1 late" (their own steps on this job)
        (num(j.checklist_open) ? '<br><a href="' + esc(jobHref(j.booking_id, "checklist")) + '">Checklist: ' + num(j.checklist_open) + " open" + (num(j.checklist_late) ? ', <span style="color:var(--err-fg);font-weight:600">' + num(j.checklist_late) + " late</span>" : "") + "</a>" : "") + "</p>" +
        (j.token && j.status !== "declined" ? '<div class="cr-acts">' + (j.status !== "confirmed" ? '<button type="button" class="primary" data-yes="' + esc(j.token) + '">Confirm</button>' : "") +
          '<button type="button" data-no="' + esc(j.token) + '">Can&#39;t make it</button></div>' : "") + "</div>").join("");
    }
    jobRoot.addEventListener("click", async (ev) => {
      const yes = ev.target.closest("[data-yes]"), no = ev.target.closest("[data-no]");
      if (yes) { yes.disabled = true; await answer(yes.dataset.yes, "confirm", ""); }
      if (no) askReason((why) => answer(no.dataset.no, "decline", why));
    });
    async function answer(token, a, why) {
      const { error } = await sb.rpc("crew_answer", { p_token: token, p_answer: a, p_reason: why });
      if (error) toast(cleanErr(error), true);
      else toast(a === "confirm" ? "Confirmed. Thanks!" : "Got it. We'll find someone else.");
      loadMine();
    }
    function askReason(go) {
      const m = openModal('<div><h2>Can&#39;t make it</h2><p>We&#39;ll take you off this job and find someone else.</p><div class="field"><label for="aca-crWhy">Why (optional)</label><input type="text" id="aca-crWhy" maxlength="300" placeholder="Sick, family, another job&#8230;" style="width:100%" /></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Back</button><button type="button" class="primary" data-m="go">Take me off this job</button></div></div>');
      m.addEventListener("click", (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "go") { t.disabled = true; go(el("crWhy").value.trim()); }
        m.close();
      });
    }

    // ---------------------------------------------------------------- time off
    const whenText = (r) => T.fmtDay(r.first_day) + (r.last_day > r.first_day ? " – " + T.fmtDay(r.last_day) : "") +
      (r.start_time ? ", " + T.fmtMin(+r.start_time.slice(0, 2) * 60 + +r.start_time.slice(3, 5)) + "–" + T.fmtMin(+r.end_time.slice(0, 2) * 60 + +r.end_time.slice(3, 5)) : "");
    const TO_STATUS = { pending: ["Waiting", "warn"], approved: ["Approved", "ok"], declined: ["Declined", "err"], cancelled: ["Cancelled", ""] };
    const toChip = (s) => '<span class="pill ' + TO_STATUS[s][1] + '">' + TO_STATUS[s][0] + "</span>";
    // B7: each job links to it on the Schedule (its week, with its crew dialog open when the booking is known)
    const jobLinkOf = (j) => canSee("scheduling") ? '<a href="#staff/schedule" data-tojob="' + esc(j.booking_id || "") + '" data-day="' + esc(T.local(j.starts_at).day) + '">' + esc(T.fmtDay(T.local(j.starts_at).day) + " " + String(j.title).split(" • ")[0]) + "</a>"
      : esc(T.fmtDay(T.local(j.starts_at).day) + " " + String(j.title).split(" • ")[0]);
    const jobsWarn = (r) => r.jobs && r.jobs.length ? '<div class="cr-warn">On ' + (r.jobs.length === 1 ? "a job" : r.jobs.length + " jobs") + " then: " +
      r.jobs.map(jobLinkOf).join(", ") + "</div>" : "";
    document.addEventListener("click", (ev) => {
      const a = ev.target.closest && ev.target.closest(".aca [data-tojob]"); if (!a) return;
      ev.preventDefault();
      const mod = a.closest(".modal"); if (mod && mod.close) mod.close();
      Schedule.showJob(a.dataset.tojob || null, a.dataset.day);
    });
    let TO = null;
    async function loadTimeOff() {
      clearError("toErr");
      if (!el("toA").value) { el("toA").value = T.addDays(T.today(), 7); el("toZ").value = el("toA").value; }
      try {
        const { data, error } = await sb.rpc("time_off_list");
        if (error) throw error;
        TO = data;
        if (ownOpen === null) ownOpen = !TO.can_edit || TO.mine.some((r) => r.status === "pending");
        showOwn();
        renderTimeOff();
      } catch (e) { showError("toErr", "Could not load time off: " + cleanErr(e)); }
      loadAttention();
    }
    function renderTimeOff() {
      const today = T.today();
      el("toMine").innerHTML = TO.mine.length ? TO.mine.map((r) => '<div class="cr-card' + (r.status === "pending" ? "" : " done") + '"><h4>' + esc(whenText(r)) + toChip(r.status) + "</h4>" +
        '<p class="cr-facts">' + (r.note ? esc(r.note) + "<br>" : "") + (r.decided_at ? esc(TO_STATUS[r.status][0]) + " by " + esc(T.shortName(r.decided_by || "")) + " " + esc(fmtAgo(r.decided_at)) + (r.decision_note ? ": &ldquo;" + esc(r.decision_note) + "&rdquo;" : "") : "Asked " + esc(fmtAgo(r.created_at))) + "</p>" +
        (r.status === "pending" || (r.status === "approved" && r.first_day > today) ? '<div class="cr-acts"><button type="button" class="small" data-cancel="' + esc(r.id) + '">Cancel request</button></div>' : "") + "</div>").join("")
        : '<p class="empty">No requests yet.</p>';
      const team = TO.team || [];
      const waiting = TO.can_edit ? team.filter((r) => r.status === "pending" && r.user_id !== TO.me) : [];
      el("toWaitSec").classList.toggle("hidden", !waiting.length);
      el("toWait").innerHTML = waiting.map((r) => '<div class="cr-card"><h4>' + esc(T.shortName(r.name)) + ": " + esc(whenText(r)) + "</h4>" +
        '<p class="cr-facts">' + (r.note ? esc(r.note) + "<br>" : "") + "Asked " + esc(fmtAgo(r.created_at)) + "</p>" + jobsWarn(r) +
        '<div class="cr-acts"><button type="button" class="primary" data-approve="' + esc(r.id) + '">Approve</button><button type="button" data-decline="' + esc(r.id) + '">Decline</button></div></div>').join("");
      const rest = team.filter((r) => !waiting.includes(r) && r.user_id !== TO.me);
      el("toTeamSec").classList.toggle("hidden", !TO.can_view || !rest.length);
      el("toTeam").innerHTML = '<div class="table-wrap"><table><tbody>' + rest.map((r) => "<tr><td><b>" + esc(T.shortName(r.name)) + "</b></td><td>" + esc(whenText(r)) + "</td><td>" + toChip(r.status) + '</td><td class="muted">' + esc(r.note || "") + "</td></tr>").join("") + "</tbody></table></div>";
    }
    el("toHours").addEventListener("change", () => {
      const on = el("toHours").checked;
      offRoot.querySelectorAll(".cr-hrs").forEach((n) => n.classList.toggle("hidden", !on));
      offRoot.querySelector(".cr-thru").classList.toggle("hidden", on);
    });
    el("toA").addEventListener("change", () => { if (!el("toZ").value || el("toZ").value < el("toA").value) el("toZ").value = el("toA").value; });
    el("toSend").addEventListener("click", async () => {
      const hours = el("toHours").checked, p = { first_day: el("toA").value, last_day: hours ? el("toA").value : el("toZ").value || el("toA").value, note: el("toNote").value.trim() };
      if (!p.first_day) return toast("Pick the first day.", true);
      if (hours) { p.start_time = el("toS").value; p.end_time = el("toE").value; if (!p.start_time || !p.end_time || p.end_time <= p.start_time) return toast("The end time has to be after the start.", true); }
      el("toSend").disabled = true;
      const { error } = await sb.rpc("time_off_request", { p });
      el("toSend").disabled = false;
      if (error) return toast(cleanErr(error), true);
      el("toNote").value = "";
      toast("Sent. You'll get an answer by email" + (canSee("timeoff") ? "" : " and here") + ".");
      loadTimeOff();
    });
    offRoot.addEventListener("click", async (ev) => {
      const c = ev.target.closest("[data-cancel]"), a = ev.target.closest("[data-approve]"), d = ev.target.closest("[data-decline]");
      if (c && confirm("Cancel this time off request?")) {
        const { error } = await sb.rpc("time_off_cancel", { p_id: c.dataset.cancel });
        if (error) toast(cleanErr(error), true); else toast("Cancelled.");
        loadTimeOff();
      }
      if (a || d) decide((a || d).dataset.approve || (a || d).dataset.decline, !!a);
    });
    function decide(id, approve) {
      const r = (TO.team || []).find((x) => x.id === id); if (!r) return;
      const m = openModal("<div><h2>" + (approve ? "Approve" : "Decline") + " time off</h2><p><b>" + esc(T.shortName(r.name)) + "</b>: " + esc(whenText(r)) + "</p>" + jobsWarn(r) +
        (approve && r.jobs && r.jobs.length ? '<p class="muted" style="font-size:13px">Approving doesn&#39;t take them off ' + (r.jobs.length === 1 ? "that job" : "those jobs") + ". " +
          (canSee("scheduling") ? "Click " + (r.jobs.length === 1 ? "it" : "one") + " above to change the crew on the Schedule." : "Change the crew on the Schedule.") + "</p>" : "") +
        '<div class="field"><label for="aca-toDec">Note to them (optional)</label><input type="text" id="aca-toDec" maxlength="500" style="width:100%" placeholder="' + (approve ? "Enjoy!" : "We&#39;re short that weekend") + '" /></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="go">' + (approve ? "Approve" : "Decline") + "</button></div></div>");
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") return m.close();
        t.disabled = true;
        const { error } = await sb.rpc("time_off_decide", { p_id: id, p_approve: approve, p_note: el("toDec").value.trim() });
        if (error) { toast(cleanErr(error), true); t.disabled = false; return; }
        m.close(); toast(approve ? "Approved. It is on the Schedule, and they got an email." : "Declined. They got an email.");
        loadTimeOff();
      });
    }

    // ---------------------------------------------------------------- Today
    async function loadAttention() {
      try {
        const { data, error } = await sb.rpc("crew_attention");
        if (error) throw error;
        setAttention("crewMine", num(data.mine), "Jobs to confirm", "crew");
        if (canSee("scheduling")) setAttention("crewWaiting", num(data.waiting), "Crew not confirmed", "schedule");
        if (canEdit("timeoff")) setAttention("timeOffPending", num(data.timeoff), "Time off to approve", "timeoff");
      } catch (_e) { /* Today reports it as unchecked */ }
    }

    return { loadMine, loadTimeOff, loadAttention, chip };
  })();

  // ---------------------------------------------------------------- the crew picker's data
  // options(bookingId, day, destination?) -> crew_options, after asking Google Maps (offer-drive, mode "crew")
  // for any home -> job drive not cached yet. describe(p) -> the line under a name.
  const CrewPick = (function () {
    const T = StaffTime;
    const FN_URL = SUPABASE_URL + "/functions/v1/offer-drive";
    async function fill(bookingId, destination) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      try {
        await fetch(FN_URL, { method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "crew", booking_id: bookingId || undefined, destination: destination || undefined }) });
      } catch (_e) { /* drive times stay unknown */ }
    }
    async function options(bookingId, day, destination) {
      const call = () => supabase.rpc("crew_options", { p_booking: bookingId || null, p_day: day || null, p_destination: destination || null });
      let { data, error } = await call();
      if (error) throw error;
      if (data.destination && (data.people.some((p) => p.has_home && p.home_min == null) || data.studio_min == null)) {
        await fill(bookingId, destination);
        ({ data, error } = await call());
        if (error) throw error;
      }
      data.people.forEach((p) => { p.short = T.shortName(p.name); });
      return data;
    }
    const roleNames = (p, data) => (p.roles || []).map((id) => (data.roles.find((r) => r.id === id) || {}).label).filter(Boolean);
    // [text, level]: level "bad" (off), "warn" (busy, asked off, said no) or ""
    function describe(p, data) {
      const bits = [];
      let level = "";
      if (p.off) { bits.push("Off that day"); level = "bad"; }
      else if (p.asked_off) { bits.push("Asked for time off"); level = "warn"; }
      if (p.declined) { bits.push("Said they can't make it"); level = level || "warn"; }
      (p.busy || []).forEach((b) => { bits.push("Busy " + T.fmtTs(b.starts_at) + "–" + T.fmtTs(b.ends_at) + (b.title ? " (" + String(b.title).split(" • ")[0] + ")" : "")); level = level || "warn"; });
      bits.push(p.home_min != null ? p.home_min + " min from home" : p.has_home ? "drive from home unknown" : data.studio_min != null ? "no home address (" + data.studio_min + " min from the studio)" : "no home address");
      return [bits.join(" · "), level, roleNames(p, data)];
    }
    return { options, describe, roleNames };
  })();

  // ---------------------------------------------------------------- the job page's Crew tab
  // The job page (jobpage.js, #jobs/job/<id>/crew) may load after this file, so register once everything is defined.
  setTimeout(() => {
    try {
      if (typeof registerJobTab !== "function") return;
      registerJobTab({ id: "crew", label: "Crew", module: "scheduling", order: 15, render: (booking, box) => CrewTab.render(booking, box) });
    } catch (_e) { /* no job page in this build */ }
  }, 0);
  const CrewTab = (function () {
    const T = StaffTime;
    async function render(booking, box) {
      const id = booking && (booking.id || booking.booking_id);
      box.innerHTML = '<p class="empty">Loading&#8230;</p>';
      const { data, error } = await supabase.rpc("crew_for_booking", { p_booking: id });
      if (error) { box.innerHTML = '<p class="inline-error">' + esc(error.message) + "</p>"; return; }
      const rows = data.crew.map((c) => "<tr><td><b>" + esc(T.shortName(c.name)) + "</b>" + (c.roles.length ? ' <span class="muted">' + esc(c.roles.join(", ")) + "</span>" : "") + "</td>" +
        "<td>" + c.days.map((d) => esc(T.fmtDay(T.local(d.starts_at).day) + " " + T.fmtTs(d.starts_at) + "–" + T.fmtTs(d.ends_at))).join("<br>") + "</td>" +
        "<td>" + (c.status ? Crew.chip(c.status) : data.confirm_on ? '<span class="muted">Not asked</span>' : "") + "</td>" +
        "<td>" + (data.confirm_on && data.can_edit && data.booking_status === "booked" && c.status !== "confirmed" ? '<button type="button" class="link" data-ask="' + esc(c.user_id) + '">' + (c.status ? "Ask again" : "Ask to confirm") + "</button>" : "") + "</td></tr>").join("");
      box.innerHTML = '<p class="muted" style="margin:0 0 8px">' + num(data.crew.length) + " of " + num(data.needed) + " needed" + (data.declined.length ? " &middot; Can&#39;t make it: " + data.declined.map((d) => esc(T.shortName(d.name)) + (d.reason ? " (&ldquo;" + esc(d.reason) + "&rdquo;)" : "")).join(", ") : "") + "</p>" +
        (rows ? '<div class="table-wrap"><table><tbody>' + rows + "</tbody></table></div>" : '<p class="empty">Nobody on this job yet. Put people on it from the Schedule.</p>') +
        '<p style="margin-top:10px"><a href="#staff/schedule">Open the Schedule</a></p>';
      box.querySelectorAll("[data-ask]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        const { error: e2 } = await supabase.rpc("crew_ask_now", { p_booking: id, p_user: b.dataset.ask });
        if (e2) toast(String(e2.message).replace(/^P0001:\s*/, ""), true); else toast("Sent.");
        render(booking, box);
      }));
    }
    return { render };
  })();

  // ================================================================ PUBLIC: Confirm / Can't make it (no sign-in)
  //   https://admin.207photo.com/#crew/<token>        the job, with Confirm and Can't make it
  //   .../#crew/<token>/yes  and  .../no              from the email's buttons (Confirm still takes a tap)
  const CrewPublic = (function () {
    const route = () => /^#crew\/([0-9a-f]{32,})(?:\/(yes|no))?$/.exec(location.hash);
    const LOGO = "https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/icons/apple-touch-icon.png";
    const fmtDay = (ts) => Fmt.day(ts);
    const fmtTime = (ts) => new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
    const $ = (id) => document.getElementById("crp-" + id);
    let box = null, token = "", D = null;
    function show() {
      const st = document.createElement("style");
      st.textContent = `
      .aca .crp { max-width: 560px; margin: 0 auto; padding: 28px 16px 64px; font-size: 15px; line-height: 22px; }
      .aca .crp-top { display: flex; gap: 12px; align-items: center; margin-bottom: 18px; }
      .aca .crp-top img { width: 44px; height: 44px; border-radius: 10px; border: 1px solid var(--border); }
      .aca .crp-top b { display: block; font-size: 13px; color: var(--muted); font-weight: 600; }
      .aca .crp h1 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 700; }
      .aca .crp-day { margin: 14px 0; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
      .aca .crp-day .t { font-size: 19px; line-height: 26px; font-weight: 700; }
      .aca .crp-day .s { color: var(--muted); font-size: 14px; }
      .aca .crp-acts { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0 0; }
      .aca .crp-acts button { height: 48px; font-size: 16px; padding: 0 22px; flex: 1; min-width: 150px; }
      .aca .crp .ok { margin: 14px 0; padding: 12px 14px; border-radius: 4px; background: var(--ok-bg); color: var(--ok-fg); }
      .aca .crp .note { margin: 14px 0; padding: 12px 14px; border-radius: 4px; background: var(--surface-2); }
      .aca .crp .err { margin: 12px 0; padding: 10px 12px; border-radius: 4px; background: var(--err-bg); color: var(--err-fg); font-size: 14px; }
      .aca .crp textarea { width: 100%; min-height: 70px; padding: 8px 10px; font-size: 16px; }`;
      document.head.appendChild(st);
      ["welcomeView", "loginView", "dashView"].forEach((v) => { const n = el(v); if (n) n.classList.add("hidden"); });
      box = document.createElement("div"); box.className = "crp"; box.id = "aca-crewPublic";
      document.querySelector(".aca").appendChild(box);
      document.title = "Your job with 207 Photo";
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const r = route();
      token = r[1];
      load(r[2] || "");
      // Signed in on this device (the home-screen app, which has no address bar): a way back to My jobs.
      supabase.auth.getSession().then(({ data }) => { signedIn = !!(data && data.session); if (signedIn && D && !box.querySelector("#crp-home")) box.insertAdjacentHTML("beforeend", homeBtn()); }).catch(() => {});
      box.addEventListener("click", (e) => { if (e.target.closest("#crp-home")) { location.hash = "#staff/crew"; location.reload(); } });
    }
    let signedIn = false;
    const homeBtn = () => (signedIn ? '<div class="crp-acts"><button type="button" class="small" id="crp-home">Open 207 Admin</button></div>' : "");
    const top = (title) => '<div class="crp-top"><img src="' + LOGO + '" alt="" /><div><b>207 Photo &#183; Your job</b><h1>' + esc(title) + "</h1></div></div>";
    async function load(intent) {
      const { data, error } = await supabase.rpc("crew_public", { p_token: token });
      if (error || !data) { box.innerHTML = top("This link doesn’t work") + "<p>" + esc(error ? error.message : "You may have been taken off this job, or the link was mistyped. Please contact 207 Photo.") + "</p>"; return; }
      D = data;
      render("", intent);
    }
    function render(msg, intent) {
      const real = renderBody(msg, intent);
      if (signedIn && !box.querySelector("#crp-home")) box.insertAdjacentHTML("beforeend", homeBtn());
      return real;
    }
    function renderBody(msg, intent) {
      let h = top(D.title) + "<p>Hi " + esc(D.name) + ". " + (D.changed && D.status === "pending" ? "The time changed on this job. Can you still make it?" : "You&#8217;re on the schedule for this job.") + "</p>";
      h += D.days.map((d) => '<div class="crp-day"><div class="t">' + esc(fmtDay(d.starts_at)) + "<br>" + esc(fmtTime(d.starts_at)) + " – " + esc(fmtTime(d.ends_at)) + "</div>" +
        '<div class="s">' + [d.role ? "Your role: " + esc(d.role) : "", d.drive_before_min ? (D.from_home ? "Leave home by " : "Leave the studio by ") + esc(fmtTime(new Date(new Date(d.starts_at) - d.drive_before_min * 6e4))) : "", d.note ? esc(d.note) : ""].filter(Boolean).join("<br>") + "</div></div>").join("");
      if (D.location) h += '<p>Where: <a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(D.location) + '" target="_blank" rel="noopener">' + esc(D.location) + "</a></p>";
      if (D.crew && D.crew.length) h += '<p style="margin:8px 0;color:var(--muted)">Also on it: ' + D.crew.map((c) => esc(c.name) + (c.role ? " (" + esc(c.role) + ")" : "")).join(", ") + "</p>";
      if (msg) h += msg;
      if (D.cancelled) { box.innerHTML = h + '<div class="note">This job was cancelled. Nothing to do.</div>'; return; }
      if (D.status === "declined") { box.innerHTML = h + (msg ? "" : '<div class="note">You said you can&#8217;t make it' + (D.reason ? ": &ldquo;" + esc(D.reason) + "&rdquo;" : "") + ". If that changed, contact 207 Photo.</div>"); return; }
      if (!D.days.length) { box.innerHTML = h + '<div class="note">This job has already happened.</div>'; return; }
      if (D.status === "confirmed" && !msg) h += '<div class="ok"><b>You confirmed this job.</b> Thanks!</div>';
      h += '<div id="crp-err" class="err hidden" role="alert"></div><div class="crp-acts">' + (D.status !== "confirmed" ? '<button type="button" class="primary" id="crp-yes">Confirm</button>' : "") +
        '<button type="button" id="crp-no">Can&#8217;t make it</button></div>' +
        '<div id="crp-noBox" class="hidden" style="margin-top:16px"><label for="crp-why"><b>Why?</b> (optional)</label><textarea id="crp-why" maxlength="300" placeholder="Sick, family, another job&#8230;"></textarea>' +
        '<div class="crp-acts"><button type="button" class="primary" id="crp-noGo">Take me off this job</button></div></div>';
      box.innerHTML = h;
      if ($("yes")) { $("yes").onclick = () => reply("confirm", ""); if (intent === "yes") $("yes").focus(); }
      $("no").onclick = () => { $("noBox").classList.remove("hidden"); $("why").focus(); };
      $("noGo").onclick = () => reply("decline", $("why").value.trim());
      if (intent === "no") { $("noBox").classList.remove("hidden"); }
    }
    async function reply(a, why) {
      box.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      const { data, error } = await supabase.rpc("crew_answer", { p_token: token, p_answer: a, p_reason: why });
      if (error) { const e = $("err"); e.textContent = String(error.message).replace(/^P0001:\s*/, ""); e.classList.remove("hidden"); box.querySelectorAll("button").forEach((b) => { b.disabled = false; }); return; }
      D.status = data.status; D.reason = why;
      if (a === "decline") D.days = D.days.filter((d) => new Date(d.ends_at) <= new Date());
      render(a === "confirm" ? '<div class="ok"><b>Thanks, you&#8217;re confirmed.</b> See you there!</div>'
                             : '<div class="note"><b>Got it.</b> We took you off this job and will find someone else.</div>');
    }
    return { wanted: () => !!route(), show };
  })();
  registerPublicPage(CrewPublic);
