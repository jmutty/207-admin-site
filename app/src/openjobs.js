  // ================================================================ STAFF: Open jobs (2026-10-22)
  // Jobs offered to part-time photographers near them. A manager (Edit) picks a booked job, sees each
  // part-timer's drive from home (offer-drive edge function, Google Maps) and who is busy, and sends it to
  // the ones they tick. Each gets a push and answers here: Take it or Pass. First come, first served: taking
  // it puts them on the schedule with their own drive time; once every spot is taken the offer is filled.
  // View = a part-timer (only the offers sent to you); Edit = post offers, see answers, set up part-timers.
  // RPCs: openjobs_mine / openjobs_answer / openjobs_attention (view); openjobs_upcoming / openjobs_candidates /
  // openjobs_post / openjobs_list / openjobs_close / openjobs_people / openjobs_person_save (edit).
  // Link #staff/openjobs/<booking id> opens "Offer a job" on that booking.
  registerPage({ id: "openjobs", group: "Staff", section: "staff", module: "openjobs", title: "Open jobs", selfService: true, // View = answer your own offers
                 tabs: [["openjobs", "Open jobs"]], onShow: () => OpenJobs.load() });
  registerAttention("openJobsWaiting", { module: "openjobs", level: "warn", name: "open job offers",
    one: "A job was offered to you. Take it or pass.", many: "{n} jobs were offered to you. Take them or pass." });
  registerAttention("openJobsNoTakers", { module: "openjobs", level: "soon", name: "open jobs nobody took",
    one: "Everyone passed on an open job. Offer it to more people or staff it yourself.", many: "Everyone passed on {n} open jobs." });
  registerTodayLoader("openjobs", () => OpenJobs.loadAttention());

  const OpenJobs = (function () {
    const T = StaffTime;
    const sb = supabase;
    const FN_URL = SUPABASE_URL + "/functions/v1/offer-drive";
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const mapLink = (loc) => '<a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(loc) + '" target="_blank" rel="noopener">' + esc(loc) + "</a>";
    const DRIVES = [20, 30, 45, 60, 75, 90, 120, 150, 180];

    const css = `
    .aca .oj-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 0 0 14px; }
    .aca .oj-bar .grow { flex: 1; }
    .aca .oj-sec { margin: 0 0 28px; }
    .aca .oj-sec > h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .aca .oj-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin: 0 0 10px; background: var(--surface); }
    .aca .oj-card.done { background: var(--surface-2); }
    .aca .oj-card h4 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
    .aca .oj-facts { margin: 0; font-size: 13.5px; color: var(--muted); line-height: 1.55; }
    .aca .oj-facts b { color: var(--text); font-weight: 600; }
    .aca .oj-note { margin: 8px 0 0; font-size: 13.5px; white-space: pre-wrap; }
    .aca .oj-acts { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .aca .oj-acts button { min-height: 40px; padding: 0 18px; }
    .aca .oj-tag { display: inline-block; font-size: 11.5px; font-weight: 700; padding: 0 6px; border-radius: 3px; margin-left: 6px; vertical-align: 1px; background: var(--hidden-bg); color: var(--hidden-fg); }
    .aca .oj-tag.ok { background: var(--ok-bg); color: var(--ok-fg); }
    .aca .oj-tag.warn { background: var(--warn-bg); color: var(--warn-fg); }
    .aca .oj-tag.err { background: var(--err-bg); color: var(--err-fg); }
    .aca .oj-who { list-style: none; margin: 10px 0 0; padding: 0; font-size: 13.5px; }
    .aca .oj-who li { display: flex; gap: 8px; align-items: baseline; padding: 5px 0; border-top: 1px solid var(--line2); flex-wrap: wrap; }
    .aca .oj-who .n { font-weight: 600; min-width: 110px; }
    .aca .oj-who .s { color: var(--muted); font-size: 12.5px; }
    .aca .oj-modal { max-width: 640px; }
    .aca .oj-modal .field input[type=text], .aca .oj-modal .field select, .aca .oj-modal .field textarea { width: 100%; }
    .aca .oj-modal textarea { height: 60px; padding: 6px 10px; }
    .aca .oj-modal .row2 { display: grid; grid-template-columns: 120px 1fr; gap: 10px; }
    .aca .oj-pick { list-style: none; margin: 0; padding: 0; max-height: 300px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
    .aca .oj-pick li { border-bottom: 1px solid var(--line2); }
    .aca .oj-pick li:last-child { border-bottom: 0; }
    .aca .oj-pick label { display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px; cursor: pointer; font-size: 14px; }
    .aca .oj-pick input { margin-top: 3px; width: 17px; height: 17px; flex: none; }
    .aca .oj-pick .s { display: block; color: var(--muted); font-size: 12.5px; }
    .aca .oj-ppl td { padding: 8px 8px; vertical-align: top; font-size: 13.5px; }
    .aca .oj-ppl input[type=text] { width: 100%; min-width: 200px; }
    .aca .oj-ppl .s { display: block; color: var(--muted); font-size: 12px; margin-top: 3px; }
    @media (max-width: 700px) { .aca .oj-modal .row2 { grid-template-columns: 1fr; } .aca .oj-acts button { flex: 1; } .aca .oj-ppl thead { display: none; } .aca .oj-ppl tr { display: block; border-bottom: 1px solid var(--line2); padding: 6px 0; } .aca .oj-ppl td { display: block; padding: 4px 0; } }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    const root = el("panel-openjobs");
    root.innerHTML =
      '<div class="oj-bar hidden" id="aca-ojBar"><button type="button" class="primary" id="aca-ojOffer">Offer a job</button><button type="button" class="small" id="aca-ojPeople">Part-timers</button><span class="grow"></span></div>' +
      '<div id="aca-ojErr" class="inline-error hidden"></div>' +
      '<div class="oj-sec" id="aca-ojMineSec"><h3>Offered to you</h3><div id="aca-ojMine"><p class="empty">Loading&#8230;</p></div></div>' +
      '<div class="oj-sec hidden" id="aca-ojPostedSec"><h3>Offers you sent</h3><div id="aca-ojPosted"></div></div>';

    // "Sat Oct 25, 9am-12pm; Sun Oct 26, time not set yet"
    function daysText(days) {
      if (!days || !days.length) return "No days left";
      return days.map((d) => T.fmtDay(d.day) + ", " + (d.start_at ? T.fmtTs(d.start_at) + "–" + T.fmtTs(d.end_at) : "time not set yet")).join("; ");
    }
    const spotsText = (o) => o.spots === 1 ? (o.taken ? "Taken" : "1 person needed") : o.taken + " of " + o.spots + " spots taken";

    // ---------------------------------------------------------------- load
    let pending = null;   // a booking id from #staff/openjobs/<id>
    async function load() {
      clearError("ojErr");
      const edit = canEdit("openjobs");
      el("ojBar").classList.toggle("hidden", !edit);
      el("ojPostedSec").classList.toggle("hidden", !edit);
      const m = location.hash.match(/^#staff\/openjobs\/([0-9a-z-]{3,40})/i);
      if (m && edit) { pending = m[1]; history.replaceState(null, "", "#staff/openjobs"); }
      try {
        const { data, error } = await sb.rpc("openjobs_mine");
        if (error) throw error;
        renderMine((data && data.offers) || [], edit);
      } catch (e) { showError("ojErr", "Could not load your offers: " + cleanErr(e)); }
      if (edit) {
        try {
          const { data, error } = await sb.rpc("openjobs_list");
          if (error) throw error;
          renderPosted(data || []);
        } catch (e) { showError("ojErr", "Could not load the offers: " + cleanErr(e)); }
        if (pending) { const b = pending; pending = null; openOffer(b); }
      }
      loadAttention();
    }

    // ---------------------------------------------------------------- part-timer: offers to me
    function renderMine(offers, edit) {
      el("ojMineSec").classList.toggle("hidden", edit && !offers.length);
      if (!offers.length) { el("ojMine").innerHTML = '<p class="empty">No jobs offered to you right now. When one comes up near you, you get a notification and it shows here.</p>'; return; }
      el("ojMine").innerHTML = offers.map((o) => {
        const me = o.mine || {};
        const open = o.status === "open" && !me.answer;
        const tag = me.answer === "accepted" ? '<span class="oj-tag ok">You took it</span>' : me.answer === "declined" ? '<span class="oj-tag">You passed</span>'
          : o.status === "filled" ? '<span class="oj-tag">Already taken</span>' : o.status === "closed" ? '<span class="oj-tag">No longer needed</span>' : "";
        return '<div class="oj-card' + (open ? "" : " done") + '" data-offer="' + esc(o.id) + '"><h4>' + esc(o.title) + tag + "</h4>" +
          '<p class="oj-facts"><b>' + esc(daysText(o.days)) + "</b>" + (o.location ? "<br>" + mapLink(o.location) : "") +
          (me.drive_min != null ? "<br>About " + num(me.drive_min) + " min drive from home" : "") + (o.pay ? "<br>Pay: " + esc(o.pay) : "") +
          (o.spots > 1 ? "<br>" + esc(spotsText(o)) : "") + "</p>" +
          (o.note ? '<p class="oj-note">' + esc(o.note) + "</p>" : "") +
          (me.answer === "declined" && me.reason ? '<p class="oj-facts">You said: ' + esc(me.reason) + "</p>" : "") +
          (me.answer === "accepted" ? '<p class="oj-facts">It is on your schedule' + (canSee("assignments") ? ' (<a href="#staff/myday">My day</a>)' : "") + ".</p>" : "") +
          (open || (me.answer === "declined" && o.status === "open")
            ? '<div class="oj-acts"><button type="button" class="primary" data-take="' + esc(o.id) + '">Take it</button>' + (open ? '<button type="button" data-pass="' + esc(o.id) + '">Pass</button>' : "") + "</div>" : "") +
          "</div>";
      }).join("");
    }
    root.addEventListener("click", async (ev) => {
      const take = ev.target.closest("[data-take]"), pass = ev.target.closest("[data-pass]");
      if (take) {
        take.disabled = true;
        try {
          const { data, error } = await sb.rpc("openjobs_answer", { p_offer: take.dataset.take, p_accept: true, p_reason: "" });
          if (error) throw error;
          if (!data.ok) toast(data.error === "filled" ? "Someone already took this one. Thanks for answering!" : "This job is no longer open.", true);
          else toast("It's yours." + (data.scheduled ? " It is on your schedule." : "") + (data.untimed ? " A day without a time yet gets added once it has one." : ""));
        } catch (e) { toast(cleanErr(e), true); }
        load();
      }
      if (pass) openPass(pass.dataset.pass);
      const close = ev.target.closest("[data-close]");
      if (close && confirm("Close this offer? People who haven't answered can't take it any more.")) {
        close.disabled = true;
        const { error } = await sb.rpc("openjobs_close", { p_offer: close.dataset.close });
        if (error) toast(cleanErr(error), true); else toast("Closed.");
        load();
      }
      const again = ev.target.closest("[data-again]");
      if (again) openOffer(again.dataset.again);
    });
    function openPass(id) {
      const m = openModal('<div class="oj-modal"><h2>Pass on this job</h2><div class="field"><label for="aca-ojReason">Why (optional)</label><input type="text" id="aca-ojReason" maxlength="300" placeholder="Busy that day, too far, ..." /></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="pass">Pass</button></div></div>');
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") return m.close();
        t.disabled = true;
        const { error } = await sb.rpc("openjobs_answer", { p_offer: id, p_accept: false, p_reason: el("ojReason").value.trim() });
        if (error) { toast(cleanErr(error), true); t.disabled = false; return; }
        m.close(); toast("Thanks, we'll ask someone else."); load();
      });
    }

    // ---------------------------------------------------------------- manager: offers sent
    function renderPosted(offers) {
      if (!offers.length) { el("ojPosted").innerHTML = '<p class="empty">Nothing offered yet. Use Offer a job to send a booked job to part-timers near it.</p>'; return; }
      el("ojPosted").innerHTML = offers.map((o) => {
        const live = o.status === "open" && o.booking_status === "booked" && o.days.length;
        const state = o.booking_status !== "booked" ? '<span class="oj-tag err">Job ' + esc(o.booking_status) + "</span>"
          : o.status === "filled" ? '<span class="oj-tag ok">Filled</span>' : o.status === "closed" ? '<span class="oj-tag">Closed</span>'
          : !o.days.length ? '<span class="oj-tag">Past</span>' : '<span class="oj-tag warn">Open</span>';
        const who = (o.recipients || []).map((r) => {
          const a = r.answer === "accepted" ? '<span class="oj-tag ok">Took it</span>' : r.answer === "declined" ? '<span class="oj-tag">Passed</span>'
            : r.seen_at ? '<span class="oj-tag">Seen, no answer</span>' : r.notified ? '<span class="oj-tag">Notified</span>' : '<span class="oj-tag warn">No notifications on</span>';
          return '<li><span class="n">' + esc(T.shortName(r.name)) + "</span>" + a + (r.drive_min != null ? '<span class="s">' + num(r.drive_min) + " min</span>" : "") +
            (r.reason ? '<span class="s">&ldquo;' + esc(r.reason) + "&rdquo;</span>" : "") + (r.answered_at ? '<span class="s">' + esc(fmtAgo(r.answered_at)) + "</span>" : "") + "</li>";
        }).join("");
        return '<div class="oj-card' + (live ? "" : " done") + '"><h4>' + esc(o.title) + state + "</h4>" +
          '<p class="oj-facts"><b>' + esc(daysText(o.days)) + "</b>" + (o.location ? "<br>" + esc(o.location) : "") + "<br>" + esc(spotsText(o)) +
          (o.pay ? " &middot; Pay: " + esc(o.pay) : "") + " &middot; Sent " + esc(fmtAgo(o.created_at)) + (o.created_by ? " by " + esc(T.shortName(o.created_by)) : "") + "</p>" +
          (o.note ? '<p class="oj-note">' + esc(o.note) + "</p>" : "") + '<ul class="oj-who">' + who + "</ul>" +
          (live ? '<div class="oj-acts"><button type="button" class="small" data-again="' + esc(o.booking_id) + '">Offer to more people</button><button type="button" class="small" data-close="' + esc(o.id) + '">Close offer</button></div>' : "") +
          "</div>";
      }).join("");
    }

    // ---------------------------------------------------------------- manager: offer a job
    async function lookupDrives(bookingId) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Signed out.");
      const r = await fetch(FN_URL, { method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ booking_id: bookingId }) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || "HTTP " + r.status);
      return j;
    }
    async function openOffer(bookingId) {
      const m = openModal('<div class="oj-modal"><h2>Offer a job to part-timers</h2>' +
        '<div class="field"><label for="aca-ojJob">Job</label><select id="aca-ojJob"><option value="">Loading jobs&#8230;</option></select></div>' +
        '<div id="aca-ojJobFacts" class="oj-facts" style="margin:-4px 0 12px"></div>' +
        '<div class="field"><label>Who gets it</label><div id="aca-ojCands"><p class="empty">Pick a job first.</p></div></div>' +
        '<div class="row2"><div class="field"><label for="aca-ojSpots">People needed</label><select id="aca-ojSpots">' + [1, 2, 3, 4, 5].map((n) => '<option value="' + n + '">' + n + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="aca-ojPay">Pay (optional)</label><input type="text" id="aca-ojPay" maxlength="80" placeholder="$150 flat, $25/hr, ..." /></div></div>' +
        '<div class="field"><label for="aca-ojNote">Note (optional)</label><textarea id="aca-ojNote" maxlength="500" placeholder="What to bring, where to park, who to ask for"></textarea></div>' +
        '<div class="inline-error hidden" id="aca-ojMErr"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="send" disabled>Send offer</button></div></div>');
      const mErr = (t) => { const n = el("ojMErr"); n.textContent = t; n.classList.toggle("hidden", !t); };
      const send = m.querySelector('[data-m="send"]');
      let jobs = [];
      try {
        const { data, error } = await sb.rpc("openjobs_upcoming");
        if (error) throw error;
        jobs = data || [];
      } catch (e) { mErr("Could not load jobs: " + cleanErr(e)); }
      el("ojJob").innerHTML = '<option value="">' + (jobs.length ? "Pick a booked job" : "No booked jobs coming up") + "</option>" + jobs.map((j) =>
        '<option value="' + esc(j.booking_id) + '">' + esc(T.fmtDay(j.first_day) + (j.days > 1 ? " +" + (j.days - 1) : "") + " · " + j.title + (j.crew ? " (" + j.crew + " on it)" : "") + (j.open_offers ? " · offered" : "")) + "</option>").join("");
      if (bookingId && jobs.some((j) => j.booking_id === bookingId)) el("ojJob").value = bookingId;
      else if (bookingId) mErr("That job is not booked or has no days left, so it can't be offered.");

      async function pickJob() {
        const id = el("ojJob").value;
        send.disabled = true; mErr("");
        if (!id) { el("ojCands").innerHTML = '<p class="empty">Pick a job first.</p>'; el("ojJobFacts").innerHTML = ""; return; }
        el("ojCands").innerHTML = '<p class="empty">Working out drive times&#8230;</p>';
        let driveNote = "";
        try { await lookupDrives(id); } catch (e) { driveNote = cleanErr(e); }
        if (el("ojJob").value !== id) return;
        try {
          const { data, error } = await sb.rpc("openjobs_candidates", { p_booking: id });
          if (error) throw error;
          renderCands(data, driveNote);
        } catch (e) { el("ojCands").innerHTML = ""; mErr(cleanErr(e)); }
      }
      function renderCands(d, driveNote) {
        const b = d.booking;
        el("ojJobFacts").innerHTML = esc(daysText(b.days)) + (b.location ? "<br>" + esc(b.location) : "") + (driveNote ? '<br><span class="oj-tag warn">' + esc(driveNote) + "</span>" : "");
        const ppl = d.people || [];
        if (!ppl.length) { el("ojCands").innerHTML = '<p class="empty">Nobody is marked part-time yet. Use Part-timers to set people up with their home address.</p>'; return; }
        el("ojCands").innerHTML = '<ul class="oj-pick">' + ppl.map((p) => {
          const flags = [];
          if (p.on_job) flags.push('<span class="oj-tag ok">Already on this job</span>');
          if (p.offered) flags.push('<span class="oj-tag">Already offered</span>');
          if (p.busy && p.busy.length) flags.push('<span class="oj-tag warn">Busy ' + esc(p.busy.map((x) => T.fmtDay(x, { month: undefined, day: undefined })).join(", ")) + "</span>");
          if (!p.has_access) flags.push('<span class="oj-tag err">No Open jobs access</span>');
          else if (!p.has_device) flags.push('<span class="oj-tag warn">No notifications on</span>');
          const drive = !p.home_set ? "No home address" : p.drive_min == null ? "Drive unknown" : p.drive_min + " min drive" + (p.in_range ? "" : " (farther than their " + p.max_drive_min + " min)");
          const pre = p.in_range && !p.on_job && !p.offered && !(p.busy && p.busy.length) && p.has_access;
          return '<li><label><input type="checkbox" class="oj-cand" value="' + esc(p.user_id) + '"' + (pre ? " checked" : "") + (p.has_access ? "" : " disabled") + " /><span>" +
            esc(T.shortName(p.name)) + flags.join("") + '<span class="s">' + esc(drive) + "</span></span></label></li>";
        }).join("") + "</ul>";
        syncSend();
      }
      const picked = () => [...m.querySelectorAll(".oj-cand:checked")].map((x) => x.value);
      function syncSend() { const n = picked().length; send.disabled = !n; send.textContent = n ? "Send to " + n + (n === 1 ? " person" : " people") : "Send offer"; }
      el("ojJob").addEventListener("change", pickJob);
      m.addEventListener("change", (ev) => { if (ev.target.classList.contains("oj-cand")) syncSend(); });
      if (el("ojJob").value) pickJob();
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        if (t.dataset.m === "cancel") return m.close();
        t.disabled = true; mErr("");
        try {
          const { data, error } = await sb.rpc("openjobs_post", { p: { booking_id: el("ojJob").value, spots: +el("ojSpots").value, pay: el("ojPay").value.trim(), note: el("ojNote").value.trim(), user_ids: picked() } });
          if (error) throw error;
          m.close();
          const off = data.sent - data.pushed;
          toast("Offered to " + data.sent + (data.sent === 1 ? " person." : " people.") + (off ? " " + off + " won't get a notification (not turned on), so it waits on their Open jobs page." : ""));
          load();
        } catch (e) { mErr(cleanErr(e)); t.disabled = false; }
      });
    }

    // ---------------------------------------------------------------- manager: part-timers
    async function openPeople() {
      const m = openModal('<div class="oj-modal" style="max-width:820px"><h2>Part-timers</h2><p class="oj-facts">Part-timers get Open jobs offers. Their home address is where the drive to a job is measured from; offers start ticked for jobs within their longest drive.</p>' +
        '<div id="aca-ojPplBody"><p class="empty">Loading&#8230;</p></div><div class="modal-actions"><span class="grow"></span><button type="button" class="primary" data-m="done">Done</button></div></div>', { onClose: load });
      m.querySelector('[data-m="done"]').addEventListener("click", () => m.close());
      let d;
      try { const r = await sb.rpc("openjobs_people"); if (r.error) throw r.error; d = r.data; }
      catch (e) { el("ojPplBody").innerHTML = '<p class="inline-error">' + esc(cleanErr(e)) + "</p>"; return; }
      const note = (p) => !p.part_time ? "" : !p.has_access ? (d.can_grant ? "Gets Open jobs access when saved." : "Needs Open jobs on the Team page to see offers.") : !p.has_device ? "Hasn't turned on notifications yet (account menu, Notifications)." : "";
      el("ojPplBody").innerHTML = '<table class="oj-ppl"><thead><tr><th>Person</th><th>Part-timer</th><th>Home address</th><th>Longest drive</th></tr></thead><tbody>' + d.people.map((p) =>
        '<tr data-u="' + esc(p.user_id) + '"><td><b>' + esc(T.shortName(p.name)) + '</b><span class="s oj-pnote">' + esc(note(p)) + "</span></td>" +
        '<td><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" class="oj-pt"' + (p.part_time ? " checked" : "") + " /> Gets offers</label></td>" +
        '<td><input type="text" class="oj-home" maxlength="300" value="' + esc(p.home_address) + '" placeholder="Street, town" /><span class="s oj-homenote"></span></td>' +
        '<td><select class="oj-max small">' + DRIVES.concat(DRIVES.includes(p.max_drive_min) ? [] : [p.max_drive_min]).sort((a, b) => a - b).map((n) => '<option value="' + n + '"' + (n === p.max_drive_min ? " selected" : "") + ">" + n + " min</option>").join("") + "</select></td></tr>").join("") + "</tbody></table>";
      el("ojPplBody").querySelectorAll("tr[data-u]").forEach((tr) => {
        if (typeof Places !== "undefined") Places.attach(tr.querySelector(".oj-home"), { note: tr.querySelector(".oj-homenote") });
        const p = d.people.find((x) => x.user_id === tr.dataset.u);
        async function save() {
          const pt = tr.querySelector(".oj-pt").checked, home = tr.querySelector(".oj-home").value.trim(), max = +tr.querySelector(".oj-max").value;
          if (pt === p.part_time && home === p.home_address && max === p.max_drive_min) return;
          const { data, error } = await sb.rpc("openjobs_person_save", { p_user: p.user_id, p_part_time: pt, p_home: home, p_max_drive: max });
          if (error) { toast(cleanErr(error), true); return; }
          Object.assign(p, { part_time: pt, home_address: home, max_drive_min: max }, data.granted ? { has_access: true } : {});
          tr.querySelector(".oj-pnote").textContent = note(p);
          toast("Saved." + (data.granted ? " " + T.shortName(p.name) + " can now see Open jobs." : "") + (pt && !home ? " Add a home address so drive times work." : ""));
        }
        tr.addEventListener("change", save);
      });
    }
    el("ojOffer").addEventListener("click", () => openOffer(null));
    el("ojPeople").addEventListener("click", openPeople);

    // ---------------------------------------------------------------- Today
    async function loadAttention() {
      try {
        const { data: d, error } = await sb.rpc("openjobs_attention");
        if (error) throw error;
        setAttention("openJobsWaiting", num(d && d.waiting), "Jobs offered to you", "openjobs");
        setAttention("openJobsNoTakers", num(d && d.no_takers), "Open jobs nobody took", "openjobs");
      } catch (_e) { /* Today reports it as unchecked */ }
    }

    return { load, loadAttention };
  })();
