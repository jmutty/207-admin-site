  // ================================================================ PARTNERS > Library: Booking emails (2026-10-11)
  // The ex-17hats admin email series, editable: one sequence per job type, steps with "days before picture day".
  // Edits apply to every email not yet sent (rows render at send time). Sending settings live only in
  // Settings > Sending (ws/settings 2026-10-24: the duplicate dialog here is gone; the button is a link).
  // Also lists the partner emails (rebook, review request, agreement), which open the Partners dialogs.
  const BookingLibrary = (function () {
  const sb = supabase;
  const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
  const TOKENS = [["{{first_name|there}}", "the To person's first name, or the fallback after |"], ["{{org}}", "organization name"], ["{{picture_day}}", "Tuesday, October 14"],
    ["{{picture_day_short}}", "Oct 14"], ["{{start_time}}", "9:00 AM"], ["{{retake_day}}", "retake day (empty when none)"], ["{{access_code}}", "school access code"], ["{{hub_url}}", "207photo.com/schooladmin or /sportsadmin"],
    ["{{schedule}}", "one line per day: Monday, October 20, 5:00 to 7:00 PM: Flag football"], ["{{schedule_short}}", "Monday and Tuesday, October 20 and 21, 5:00 to 7:00 PM each day"], ["{{end_time}}", "7:00 PM (empty until set)"], ["{{days_count}}", "2"], ["{{day_label}}", "hub day-before steps: the label of that day"], ["{{roster_note}}", "the roster line: a thank-you when we have it, a clear ask when we don't"], ["{{cc_note}}", "the 'this went to our primary contact' note, only when someone is Cc'd"], ["{{hub_title}}", "hub steps: the message name"], ["{{hub_detail}}", "hub steps: the one-line reason"], ["{{hub_link}}", "hub steps: the link that opens the message"], ["{{live_note}}", "gallery-live steps: 'nothing to send' or 'send Photos are online'"],
    ["{{coach_note}}", "sports admin steps: how many coach emails we have, or the Reply All ask"], ["{{coach_count}}", "number of coach emails on file"], ["{{ad_name|Your athletic director}}", "coach steps: the AD's first name, or the fallback"], ["{{coach_live_note}}", "coach gallery step: 'families got a direct link' (league with parent emails) or the paste-ready search line (roster only)"],
    // Director journey (ws/director 2026-10-24): filled by booking_director_vars (migration 20261024060000)
    ["{{when_line}}", "the day(s) with the time if set: Saturday, May 9, 9:00 AM to 12:00 PM (never waits for a time)"], ["{{where_line}}", "the location, or 'we'll confirm the spot with you'"],
    ["{{day_of_phone}}", "207's picture day phone (Settings > Sending)"], ["{{day_link}}", "their read-only 'Your picture day' page"], ["{{calendar_link}}", "the 'Add to your calendar' download"],
    ["{{families_block}}", "how it works for families (registered families, roster only or school), with the order dates when set"],
    ["{{day_of_block}}", "arrival time, what we need on site, the picture day phone, and 'reply with your on-site contact'"],
    ["{{weather_line}}", "the rain plan (outdoor jobs only; empty for schools)"], ["{{flyer_line}}", "the flyer, email and text are written for you on the hub"],
    ["{{team_times}}", "the pasted team times as a list (empty when none)"], ["{{order_deadline}}", "last day to order (empty until set)"], ["{{discount_ends}}", "last day of the discount (empty until set)"]];
  const SAMPLE = { first_name: "Pat", last_name: "Lee", org: "Hampden Little League", picture_day: "Saturday, May 9", picture_day_short: "May 9", start_time: "9:00 AM", retake_day: "", access_code: "ABC123", hub_url: "207photo.com/sportsadmin", location: "Doyle Field",
    cc_note: "This went to the person we have as the primary picture day contact for Hampden Little League. If you were copied, it is only to keep you in the loop. If our records should list someone else, just reply and we will update them.",
    schedule: "- Saturday, May 9, 9:00 AM to 12:00 PM", schedule_short: "Saturday, May 9, 9:00 AM to 12:00 PM", end_time: "12:00 PM", days_count: "1", day_label: "",
    roster_note: "**Roster:** we have yours, thank you. Nothing more to send unless teams or names change.", roster_status: "in",
    hub_title: "One week before", hub_detail: "Picture day is one week away.", hub_link: "https://207photo.com/sportsadmin/#job=12345/send=heads/r", ad_name: "Pat", coach_count: "2", coach_note: "**Coaches:** we have 2 coach emails on file and will send them the checklist and the gallery link directly.", coach_live_note: "Every family on your roster was emailed and texted a direct link to their athlete's gallery, so there is nothing you have to send.", live_note: "That is your cue to send the Photos Are Online message to your families. It is written, dated and waiting on the hub.",
    // ws/director (2026-10-24)
    when_line: "Saturday, May 9, 9:00 AM to 12:00 PM", where_line: "Doyle Field", day_of_phone: "(207) 558-3185",
    day_link: "https://admin.207photo.com/#day/0123456789abcdef0123456789abcdef0123", calendar_link: "https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?t=0123456789abcdef0123456789abcdef0123",
    families_block: "**How it works for families**\n- Nothing to pay on picture day, and no order forms.\n- After picture day, every family on your roster gets an email and a text with a link to their own athlete's gallery.\n- They order online from that gallery.\n- The early-order discount ends Friday, May 22.",
    day_of_block: "**On picture day**\n- We arrive by 8:30 AM to set up (30 minutes before we start).\n- What we need: a spot about 15 by 15 feet out of direct sun, and someone who can send teams over in order.\n- If anything comes up that morning, call or text us at (207) 558-3185.\n- **Please reply with the name and mobile number of your on-site contact for the day.**",
    weather_line: "**If the weather is bad:** Outdoor shoots move to your backup date or an indoor space. We decide together by 7:00 AM on picture day, and we email and call you either way.",
    flyer_line: "A printable flyer, a parent email and a text message are written for you on the hub (207photo.com/sportsadmin). Post the flyer and send the email about a week before picture day.",
    team_times: "**Team times**\n- 9:00 U10 Blue\n- 9:15 U10 Red", order_deadline: "Friday, May 29", discount_ends: "Friday, May 22" };
  const HUB_KEYS = { sports: [["heads", "One week before"], ["day", "Day before"], ["live", "Photos are online"], ["lastcall", "Discount ends soon"]], school: [["m1", "Two weeks before"], ["m2", "One week before"], ["m3", "Day before"], ["m4", "Gallery published"], ["r1", "Retake day, one week out"], ["r2", "Retake day, day before"]] };
  let types = [], seqs = [], steps = [], settings = null, card = null;

  function ensureCard() {
    if (card) return;
    card = document.createElement("div");
    card.className = "card";
    card.id = "aca-bkLib";
    card.innerHTML = `
      <div class="card-head">
        <div><h2>Booking emails</h2>
          <p>The emails an admin gets after you book a job (these used to live in 17hats), the hub send-day reminders, and for sports the coach emails (sent to the coaches the AD CC'd on their reply, or pasted on the booking). One sequence per job type; each step is sent a number of days before picture day at the given time, or right after booking for day 0. Changes apply to every email that has not gone out yet.</p></div>
        <div class="og-actions"><button type="button" class="small" id="aca-bkLibSettings" title="Opens Settings, Sending">Sending settings</button></div>
      </div>
      <div id="aca-bkLibErr" class="inline-error hidden" style="margin-top:12px"></div>
      <div id="aca-bkLibBody" class="lb-help"></div>`;
    el("panel-library").appendChild(card);
    el("bkLibSettings").addEventListener("click", (e) => { e.stopPropagation(); location.hash = "#system/sending"; }); // a link, not a fold click
    // Partner emails: the templates behind Due to rebook, Reviews and Agreements (their buttons there stay as shortcuts).
    const pcard = document.createElement("div");
    pcard.className = "card"; pcard.id = "aca-bkLibPartner";
    pcard.innerHTML = '<div class="card-head"><div><h2>Partner emails</h2><p>The emails to leagues and schools after picture day: the rebook email, the review request, and the agreement email with its default terms.</p></div></div>' +
      '<div id="aca-bkLibPBody" class="lb-help"></div>';
    el("panel-library").appendChild(pcard);
    pcard.addEventListener("click", (e) => { const b = e.target.closest("button[data-ptpl]"); if (b) Follow.editTemplates(b.dataset.ptpl); });
    card.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-step]"); if (b) return openStep(steps.find((s) => s.id === b.dataset.step));
      const a = e.target.closest("button[data-addstep]"); if (a) return openStep(null, a.dataset.addstep);
      const t = e.target.closest("button[data-toggle]"); if (t) return toggleSeq(t.dataset.toggle);
    });
  }
  // Every card in the Library folds on a header click (remembered per card in this browser).
  const COLLAPSE_CSS = `
  .aca #aca-panel-library .card-head { cursor: pointer; user-select: none; }
  .aca #aca-panel-library .card-head h2::before { content: "\\25BE"; display: inline-block; width: 16px; color: var(--muted); transition: transform .15s; }
  .aca #aca-panel-library .card.folded .card-head h2::before { transform: rotate(-90deg); }
  .aca #aca-panel-library .card.folded > :not(.card-head) { display: none !important; }
  .aca #aca-panel-library .card.folded .card-head { border-bottom: none; }
  .aca #aca-panel-library .card.folded .card-head p { display: none; }`;
  const cst = document.createElement("style"); cst.textContent = COLLAPSE_CSS; document.head.appendChild(cst);
  const foldKey = (card) => "aca-lib-fold:" + ((card.querySelector(".card-head h2") || {}).textContent || "").trim();
  function setupFolding() {
    el("panel-library").querySelectorAll(".card").forEach((card) => {
      if (card.dataset.foldable) return;
      card.dataset.foldable = "1";
      let folded = false; try { folded = localStorage.getItem(foldKey(card)) === "1"; } catch (_) {}
      card.classList.toggle("folded", folded);
      const head = card.querySelector(".card-head"); if (!head) return;
      head.setAttribute("title", "Click to fold or unfold");
      head.addEventListener("click", (e) => {
        if (e.target.closest("button, a, input, select")) return;
        card.classList.toggle("folded");
        try { localStorage.setItem(foldKey(card), card.classList.contains("folded") ? "1" : "0"); } catch (_) {}
      });
    });
  }
  async function load() {
    ensureCard();
    setupFolding();
    clearError("bkLibErr");
    try {
      const [t, q, s, st] = await Promise.all([sb.from("booking_types").select("*").order("sort_order"), sb.from("booking_sequences").select("*").order("created_at"),
        sb.from("booking_steps").select("*").order("step_no"), sb.from("booking_settings").select("*").maybeSingle()]);
      if (t.error) throw t.error; if (q.error) throw q.error; if (s.error) throw s.error;
      types = t.data || []; seqs = q.data || []; steps = s.data || []; settings = st.data || null;
      render();
      renderPartner();
    } catch (e) { showError("bkLibErr", cleanErr(e)); }
  }
  // Timeline order for a step: booking day first, then days before picture day, then after the gallery goes live,
  // then around retake day. Admin emails and hub reminders are one sequence; the number shown is the position.
  const rank = (s) => s.trigger === "booking" ? -2000 : s.trigger === "retake_day" ? 1000 - (s.offset_days || 0) : s.trigger === "gallery_live" ? 500 + (s.offset_days || 0) : (s.offset_days || 0) === 0 ? -1000 : -(s.offset_days || 0);
  const hhmm = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return ((h % 12) || 12) + ":" + String(m).padStart(2, "0") + " " + (h >= 12 ? "PM" : "AM"); };
  function render() {
    const body = el("bkLibBody");
    const st = settings ? (settings.sending_enabled ? (settings.test_mode ? '<span class="pill accent">Test mode: everything goes to ' + esc(settings.test_recipient || "?") + "</span>" : '<span class="pill ok">Sending on</span>') : '<span class="pill warn">Sending off</span>') : "";
    body.innerHTML = '<div style="margin-bottom:12px">' + st + (settings ? ' <span class="lb-sub">From ' + esc(settings.from_name + " <" + settings.from_email + ">") + ", day-0 emails " + esc(settings.day0_delay_min) + " min after booking, sent between " + esc(hhmm(settings.quiet_end)) + " and " + esc(hhmm(settings.quiet_start)) + "</span>" : "") + "</div>" +
      types.map((t) => {
        const list = seqs.filter((q) => q.type_key === t.key);
        return '<div class="lb-step"><div class="lb-step-h"><span>' + esc(t.label) + '</span><span class="lb-sub">' + esc(t.description) + "</span></div>" +
          list.map((q) => '<div style="margin-top:8px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>' + esc(q.name) + "</strong> " +
            (q.is_active ? '<span class="pill ok">On</span>' : '<span class="pill muted">Off</span>') + ' <button type="button" class="link" data-toggle="' + esc(q.id) + '">' + (q.is_active ? "turn off" : "turn on") + "</button></div>" +
            '<table class="lb-table" style="margin-top:6px"><tbody>' + steps.filter((s) => s.sequence_id === q.id).sort((a, b) => rank(a) - rank(b) || a.step_no - b.step_no).map((s, i) =>
              '<tr class="lb-row"><td class="lb-main"><strong>' + esc((i + 1) + ". " + s.label) + '</strong><div class="lb-body">' + esc(s.subject) + "</div></td>" +
              '<td class="lb-n">' + (s.kind === "hub" ? '<span class="pill accent">Hub</span> ' : s.kind === "coach" ? '<span class="pill accent">Coach</span> ' : "") + (s.trigger === "booking" ? "Right when you book (after the undo window)" : s.trigger === "gallery_live" ? (s.offset_days ? s.offset_days + " days after the gallery goes live" : "when the gallery goes live") : s.trigger === "retake_day" ? s.offset_days + " day" + (s.offset_days === 1 ? "" : "s") + " before retake day, " + esc(hhmm(s.send_time)) : s.offset_days === 0 ? "Right after booking" : s.offset_days + " day" + (s.offset_days === 1 ? "" : "s") + " before, " + esc(hhmm(s.send_time))) + (s.covered_by_gotphoto ? ' <span class="lb-sub">skipped when GotPhoto emails families</span>' : "") + "</td>" +
              '<td class="lb-st">' + (s.is_active ? "" : '<span class="pill muted">off</span>') + '</td><td class="lb-act"><button type="button" class="small" data-step="' + esc(s.id) + '">Edit</button></td></tr>').join("") +
            '</tbody></table><div style="margin-top:6px"><button type="button" class="link" data-addstep="' + esc(q.id) + '">+ Add a step</button></div></div>').join("") +
          (list.length ? "" : '<div class="lb-sub" style="margin-top:6px">No sequence yet for this type.</div>') + "</div>";
      }).join("");
  }
  async function renderPartner() {
    const box = el("bkLibPBody"); if (!box) return;
    const show = canSee("partners") || canSee("agreements");
    el("bkLibPartner").classList.toggle("hidden", !show);
    if (!show) return;
    const { data: p } = await sb.from("partner_followup_settings").select("*").maybeSingle();
    const f = p || {};
    const row = (kind, name, subj, when, mod) => canSee(mod) ? '<tr class="lb-row"><td class="lb-main"><strong>' + esc(name) + '</strong><div class="lb-body">' + esc(subj || "(no subject yet)") + '</div></td><td class="lb-n">' + esc(when) + '</td><td class="lb-act"><button type="button" class="small" data-ptpl="' + kind + '">' + (canEdit(mod) ? "Edit" : "View") + "</button></td></tr>" : "";
    box.innerHTML = '<table class="lb-table"><tbody>' +
      row("rebook", "Rebook email", f.rebook_subject, "a client shows up " + num(f.rebook_lead_days || 75) + " days before last year\u2019s date", "partners") +
      row("review", "Review request", f.review_subject, f.review_auto ? "drafted when a job reaches Deliverables sent" : "when you ask for one", "partners") +
      row("agreement", "Agreement email and default terms", f.agreement_subject, "when you send an agreement", "agreements") + "</tbody></table>";
  }
  async function toggleSeq(id) {
    const q = seqs.find((x) => x.id === id);
    const { error } = await sb.from("booking_sequences").update({ is_active: !q.is_active }).eq("id", id);
    if (error) { toast(error.code === "23505" ? "Turn the other sequence for this job type off first (only one can be on)." : cleanErr(error), true); return; }
    toast(q.is_active ? "Turned off" : "Turned on"); load();
  }
  function dialog(html) {
    const wrap = document.createElement("div"); wrap.className = "og-modal-wrap";
    wrap.innerHTML = '<div class="og-modal wide" role="dialog" aria-modal="true">' + html + "</div>";
    const box = wrap.firstElementChild;
    const onKey = (e) => { if (e.key === "Escape" && confirm("Close without saving?")) close(); };
    const close = () => { document.removeEventListener("keydown", onKey); wrap.remove(); };
    box.close = close; document.addEventListener("keydown", onKey);
    document.querySelector(".aca").appendChild(wrap); Orgs.measureTop();
    return box;
  }
  function openStep(s, seqId) {
    const isNew = !s;
    const sid = isNew ? seqId : s.sequence_id;
    s = s || { step_no: Math.max(0, ...steps.filter((x) => x.sequence_id === sid).map((x) => x.step_no)) + 1, label: "", kind: "admin", trigger: "picture_day", offset_days: 7, send_time: "07:30", subject: "", body_md: "Hi {{first_name|there}},\n\n", is_active: true, hub_key: "", covered_by_gotphoto: false, school_days: false };
    const aud = ((types.find((t) => t.key === (seqs.find((q) => q.id === sid) || {}).type_key) || {}).audience) === "school" ? "school" : "sports";
    const box = dialog(`
      <h2>${isNew ? "New step" : "Edit step " + esc(s.step_no)}</h2>
      <div class="og-grid">
        <label for="aca-bsLabel">Name</label><input type="text" id="aca-bsLabel" value="${esc(s.label)}" placeholder="For you, e.g. Schedule check" />
        <label for="aca-bsKind">Kind</label><select id="aca-bsKind"><option value="admin" ${s.kind !== "hub" && s.kind !== "coach" ? "selected" : ""}>Admin email (asks for something)</option><option value="hub" ${s.kind === "hub" ? "selected" : ""}>Hub reminder (the evening before a send day)</option><option value="coach" ${s.kind === "coach" ? "selected" : ""}>Coach email (goes to the coaches on file)</option></select>
        <label>When</label><span><input type="number" id="aca-bsOff" value="${esc(s.offset_days)}" min="0" max="120" /> days <select id="aca-bsTrig"><option value="picture_day" ${s.trigger === "picture_day" ? "selected" : ""}>before picture day</option><option value="retake_day" ${s.trigger === "retake_day" ? "selected" : ""}>before retake day</option><option value="gallery_live" ${s.trigger === "gallery_live" ? "selected" : ""}>after the gallery goes live</option><option value="booking" ${s.trigger === "booking" ? "selected" : ""}>right when you book (days ignored)</option></select> at <input type="time" id="aca-bsTime" value="${esc(String(s.send_time).slice(0, 5))}" /> <span class="lb-sub">(0 days before picture day = the set-up email, once the GotPhoto job or access code is in; "right when you book" goes after the undo window)</span></span>
        <label for="aca-bsHub" class="bs-hub">Hub message</label><select id="aca-bsHub" class="bs-hub"><option value="">(none)</option>${HUB_KEYS[aud].map((k) => '<option value="' + k[0] + '" ' + (s.hub_key === k[0] ? "selected" : "") + ">" + k[1] + "</option>").join("")}</select>
        <label>Rules</label><span><label><input type="checkbox" id="aca-bsCov" ${s.covered_by_gotphoto ? "checked" : ""} /> skip when GotPhoto emails the families (league job with a roster loaded)</label><br><label><input type="checkbox" id="aca-bsSchool" ${s.school_days ? "checked" : ""} /> roll back to a school day (no weekends or holidays)</label></span>
        <label for="aca-bsSubj">Subject</label><input type="text" id="aca-bsSubj" value="${esc(s.subject)}" />
        <label for="aca-bsOn">Turned on</label><span><input type="checkbox" id="aca-bsOn" ${s.is_active ? "checked" : ""} /></span>
      </div>
      <textarea id="aca-bsBody" class="og-edbody">${esc(s.body_md)}</textarea>
      <div class="lb-help" style="padding:8px 0 0">Tokens: ${TOKENS.map((t) => "<code>" + esc(t[0]) + "</code> " + esc(t[1])).join(" · ")}. Formatting: <code>**bold**</code>, <code>[text](https://link)</code>, lines starting with <code>- </code> make a list, lines starting with <code>&gt; </code> become a quoted block (the paste-ready line in the coach emails). The signature from Settings, Sending is added at the end.</div>
      <div id="aca-bsErr" class="inline-error hidden" style="margin:10px 0"></div>
      <div class="og-actions" style="margin-top:10px"><button type="button" class="primary" data-v="save">Save</button><button type="button" data-v="preview">Preview with sample data</button><button type="button" data-v="close">Cancel</button>${isNew ? "" : '<button type="button" data-v="delete" style="margin-left:auto">Delete</button>'}</div>
      <div id="aca-bsPrev" class="bk-mail hidden" style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px"></div>`);
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      const err = (m) => { el("bsErr").textContent = m; el("bsErr").classList.remove("hidden"); };
      if (b.dataset.v === "close") return box.close();
      if (b.dataset.v === "preview") {
        const bad = (el("bsSubj").value + " " + el("bsBody").value).match(/\{\{\s*([a-z_]+)/gi) || [];
        const unknown = [...new Set(bad.map((x) => x.replace(/\{\{\s*/, "")))].filter((k) => !(k in SAMPLE));
        el("bsPrev").classList.remove("hidden");
        el("bsPrev").innerHTML = (unknown.length ? '<div class="inline-error" style="margin:0 0 10px">Unknown token(s): ' + esc(unknown.join(", ")) + "</div>" : "") +
          '<div class="bk-mail-head">Subject<strong>' + esc(Bookings.fill(el("bsSubj").value, SAMPLE)) + "</strong></div>" + Bookings.mdToHtml(Bookings.fill(el("bsBody").value, SAMPLE) + (settings && settings.signature ? "\n\n" + settings.signature : ""));
        return;
      }
      if (b.dataset.v === "delete") {
        if (!confirm("Delete this step? Every unsent email from it is cancelled (sent ones stay as history).")) return;
        const { error } = await sb.from("booking_steps").delete().eq("id", s.id);
        if (error) return err(cleanErr(error));
        box.close(); toast("Deleted"); load(); return;
      }
      const row = { sequence_id: sid, step_no: s.step_no, label: el("bsLabel").value.trim(), offset_days: Math.max(0, Number(el("bsOff").value) || 0), send_time: el("bsTime").value || "07:30",
        kind: el("bsKind").value, trigger: el("bsTrig").value, hub_key: el("bsHub").value || null, covered_by_gotphoto: el("bsCov").checked, school_days: el("bsSchool").checked,
        subject: el("bsSubj").value.trim(), body_md: el("bsBody").value.trim(), is_active: el("bsOn").checked };
      if (row.trigger === "booking") row.offset_days = 0;
      if (row.kind === "hub" && !row.hub_key) return err("A hub reminder needs a hub message to point at.");
      if (!row.label || !row.subject || !row.body_md) return err("Add a name, a subject and the text.");
      const unknown = [...new Set(((row.subject + " " + row.body_md).match(/\{\{\s*([a-z_]+)/gi) || []).map((x) => x.replace(/\{\{\s*/, "")))].filter((k) => !(k in SAMPLE));
      if (unknown.length) return err("Unknown token(s): " + unknown.join(", ") + ". See the list below the text.");
      b.disabled = true;
      const { error } = isNew ? await sb.from("booking_steps").insert(row) : await sb.from("booking_steps").update(row).eq("id", s.id);
      if (error) { b.disabled = false; return err(cleanErr(error)); }
      box.close(); toast("Saved. Unsent emails use the new text and timing."); load();
    });
  }
  return { load };
  })();
