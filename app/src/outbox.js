  // ================================================================ OUTREACH > Outbox (2026-10-12 redesign)
  // Every email the system will send or has just sent, from every pipeline, in one list: outreach steps and
  // quick emails, booking admin emails, makeup notices, hub send-day reminders and the morning digest.
  // Data: admin_outbox() (migration 20261012T01). Actions reuse the pipelines' own RPCs.
  const Outbox = (function () {
  const sb = supabase;
  const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
  const TZ = "America/New_York";
  let rows = [], filter = "needs", src = "all", openId = null, loaded = false;
  const SRC = { outreach: "Outreach", booking: "Bookings", makeup: "Makeups", hub: "Hub reminders", digest: "Morning digest" };
  const STATUS = { needs_review: ["warn", "needs review"], ready: ["warn", "ready to send"], failed: ["err", "failed"], scheduled: ["ok", "scheduled"], waiting: ["muted", "waiting"], sent: ["ok", "sent"], skipped: ["muted", "skipped"] };

  const css = `
  .aca .ob-day td { padding: 16px 10px 6px; font-size: 12px; font-weight: 600; color: var(--faint); border-bottom: 1px solid var(--border); background: transparent; cursor: pointer; user-select: none; }
  .aca .ob-day:hover td { background: var(--surface-2); }
  .aca .ob-chev { border: 0; background: transparent; height: auto; padding: 0 6px 0 0; vertical-align: middle; }
  .aca .ob-day.folded .ob-chev .sl-chev { transform: rotate(-45deg); margin-top: 0; }
  .aca tr.ob-row { cursor: pointer; }
  .aca tr.ob-row.sel td { background: var(--sel-bg); }
  .aca tr.ob-row.sel td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
  .aca .ob-when { font-weight: 600; white-space: nowrap; }
  .aca .ob-m { display: block; font-size: 13px; color: var(--muted); }
  .aca .ob-mail { margin-top: 8px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; font-size: 13px; line-height: 19px; white-space: pre-wrap; max-height: 50vh; overflow: auto; }
  .aca .ob-h4 { margin: 20px 0 6px; font-size: 12px; font-weight: 600; color: var(--faint); }
  .aca .ob-panel .bk-sec { padding: 14px 18px; border-bottom: 1px solid var(--border); }
  @media (max-width: 760px) {
    .aca #aca-panel-outbox .table-wrap, .aca #aca-obBody { overflow: visible; }
    .aca #aca-panel-outbox table, .aca #aca-panel-outbox tbody { display: block; width: 100%; min-width: 0; }
    .aca #aca-panel-outbox thead { display: none; }
    .aca #aca-panel-outbox tr.ob-day { display: block; }
    .aca #aca-panel-outbox tr.ob-day td { display: flex; align-items: center; padding: 12px 4px 4px; }
    .aca #aca-panel-outbox tr.ob-day.hidden, .aca #aca-panel-outbox tr.ob-row.hidden { display: none; }
    .aca .ob-chev { min-width: 40px; min-height: 40px; display: inline-flex; align-items: center; justify-content: center; padding: 0; margin: -8px 0 -8px -8px; }
    .aca #aca-panel-outbox tr.ob-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "to status" "email email" "from when"; gap: 2px 12px; padding: 12px 4px; border-bottom: 1px solid var(--border); }
    .aca #aca-panel-outbox tr.ob-row td { display: block; padding: 0; border: 0; min-width: 0; white-space: normal; overflow-wrap: anywhere; background: transparent; }
    .aca #aca-panel-outbox tr.ob-row td:nth-child(1) { grid-area: when; text-align: right; align-self: baseline; font-size: 13px; color: var(--muted); }
    .aca #aca-panel-outbox tr.ob-row td:nth-child(1) .ob-when { font-weight: 400; }
    .aca #aca-panel-outbox tr.ob-row td:nth-child(2) { grid-area: to; font-weight: 600; }
    .aca #aca-panel-outbox tr.ob-row td:nth-child(3) { grid-area: email; }
    .aca #aca-panel-outbox tr.ob-row td:nth-child(4) { grid-area: from; font-size: 13px; color: var(--muted); align-self: baseline; }
    .aca #aca-panel-outbox tr.ob-row td:nth-child(5) { grid-area: status; text-align: right; }
    .aca #aca-panel-outbox tr.ob-row td:nth-child(1) .ob-m { display: inline; margin-left: 6px; }
    .aca #aca-panel-outbox tr.ob-row td:nth-child(2) .ob-m { font-weight: 400; }
    .aca #aca-panel-outbox tr.ob-row.sel td:first-child { box-shadow: none; }
    .aca #aca-panel-outbox tr.ob-row.sel { box-shadow: inset 2px 0 0 var(--accent); }
    .aca #aca-panel-outbox tr.ob-row.sel td { background: transparent; }
  }`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  function ensureMarkup() {
    const root = el("panel-outbox");
    if (root.dataset.ready) return;
    root.dataset.ready = "1";
    root.innerHTML = `
      <div class="card">
        <div class="card-head"><div><h2>Everything going out</h2><p>Every email from outreach, bookings, makeups, hub reminders and the morning digest, with the same actions: preview, approve, send now, skip, resend. Nothing here is a copy; each row is the real scheduled email.</p></div></div>
        <div class="toolbar">
          <div class="chips" id="aca-obChips" role="group" aria-label="Filter">
            <button type="button" data-f="needs" aria-pressed="true">Needs you <span class="tnum" data-c="needs"></span></button>
            <button type="button" data-f="today" aria-pressed="false">Today <span class="tnum" data-c="today"></span></button>
            <button type="button" data-f="scheduled" aria-pressed="false">Scheduled <span class="tnum" data-c="scheduled"></span></button>
            <button type="button" data-f="sent" aria-pressed="false">Sent <span class="tnum" data-c="sent"></span></button>
            <button type="button" data-f="all" aria-pressed="false">All</button>
          </div>
          <select id="aca-obSrc" class="small" aria-label="Source" style="margin-left:auto"><option value="all">All sources</option>${Object.keys(SRC).map((k) => '<option value="' + k + '">' + SRC[k] + "</option>").join("")}</select>
        </div>
        <div id="aca-obErr" class="inline-error hidden"></div>
        <div class="table-wrap"><table><thead><tr><th>When</th><th>To</th><th>Email</th><th>From</th><th>Status</th></tr></thead><tbody id="aca-obBody"><tr><td colspan="5" class="empty">Loading&#8230;</td></tr></tbody></table></div>
      </div>
      <aside class="og-panel ob-panel hidden" id="aca-obPanel" aria-label="Email details"></aside>`;
    el("obChips").addEventListener("click", (e) => { const b = e.target.closest("button[data-f]"); if (!b) return; filter = b.dataset.f; el("obChips").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); render(); });
    el("obSrc").addEventListener("change", () => { src = el("obSrc").value; render(); });
    el("obBody").addEventListener("click", (e) => {
      const d = e.target.closest("tr.ob-day");
      if (d) {
        const folded = d.classList.toggle("folded");
        d.querySelector(".ob-chev").setAttribute("aria-expanded", String(!folded));
        el("obBody").querySelectorAll('tr.ob-row[data-grp="' + CSS.escape(d.dataset.grp) + '"]').forEach((x) => x.classList.toggle("hidden", folded));
        try { localStorage.setItem("aca-obfold:" + d.dataset.grp, folded ? "1" : "0"); } catch (_) {}
        return;
      }
      const r = e.target.closest("tr[data-id]"); if (r) open(r.dataset.id);
    });
    el("obPanel").addEventListener("click", onPanelClick);
  }

  async function load() {
    ensureMarkup();
    try {
      const { data, error } = await sb.rpc("admin_outbox", { p_days_back: 14 });
      if (error) throw error;
      rows = data || []; loaded = true;
      el("obErr").classList.add("hidden");
      render();
      if (openId) open(openId, true);
    } catch (e) { el("obErr").textContent = cleanErr(e); el("obErr").classList.remove("hidden"); el("obBody").innerHTML = '<tr><td colspan="5" class="empty">Unavailable.</td></tr>'; }
  }
  // Today's "Going out today" line + the Outbox badge (outreach waiting for review).
  async function loadToday() {
    try {
      const { data, error } = await sb.rpc("admin_outbox", { p_days_back: 1 });
      if (error) throw error;
      const all = data || [];
      const today = todayStr();
      const going = all.filter((r) => r.status === "scheduled" && dayOf(r.at) === today);
      const bySrc = {}; going.forEach((r) => { bySrc[r.src] = (bySrc[r.src] || 0) + 1; });
      const parts = Object.keys(bySrc).map((k) => bySrc[k] + " " + ({ outreach: "outreach", booking: "booking", makeup: "makeup", hub: "hub reminder", digest: "digest" }[k] || k) + (bySrc[k] === 1 ? "" : "s").replace(/ss$/, "s"));
      // Booking emails wait on something (coach emails, the gallery going live), not on the sending switch.
      const waitingRows = all.filter((r) => r.src === "booking" && r.status === "waiting");
      const waitingB = waitingRows.length;
      const byWhy = {}; waitingRows.forEach((r) => { const k = r.error || "waiting on an earlier step"; byWhy[k] = (byWhy[k] || 0) + 1; });
      const whyText = Object.keys(byWhy).map((k) => byWhy[k] + " " + k).join(", ");
      const needs = all.filter((r) => ["needs_review", "ready", "failed"].includes(r.status)).length;
      const out = el("todayOut");
      if (out) out.innerHTML = (going.length ? "Going out today: " + esc(parts.join(", ")) + "." : "Nothing is scheduled to go out today.") +
        (waitingB ? " " + waitingB + (waitingB === 1 ? " booking email is" : " booking emails are") + " on hold until they're ready (" + esc(whyText) + ")." : "") +
        (needs ? " " + needs + (needs === 1 ? " email needs you." : " emails need you.") : "") + ' <a href="#partners/outbox">Open the outbox</a>';
    } catch (_e) { const out = el("todayOut"); if (out) out.textContent = "Could not load the outbox."; }
    renderDigestNote();
  }

  const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }) : "");
  const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) : "");
  function dayLabel(d) {
    const t = todayStr(), tm = new Date(Date.now() + 864e5).toLocaleDateString("en-CA", { timeZone: TZ });
    if (d === t) return "Today"; if (d === tm) return "Tomorrow";
    return new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  }
  function matches(r) {
    if (src !== "all" && r.src !== src) return false;
    if (filter === "needs") return ["needs_review", "ready", "failed"].includes(r.status);
    if (filter === "today") return dayOf(r.at) === todayStr() && !["sent", "skipped"].includes(r.status);
    if (filter === "scheduled") return ["scheduled", "waiting"].includes(r.status);
    if (filter === "sent") return r.status === "sent";
    return true;
  }
  function render() {
    const counts = { needs: 0, today: 0, scheduled: 0, sent: 0 };
    rows.forEach((r) => { if (src !== "all" && r.src !== src) return; if (["needs_review", "ready", "failed"].includes(r.status)) counts.needs++; if (dayOf(r.at) === todayStr() && !["sent", "skipped"].includes(r.status)) counts.today++; if (["scheduled", "waiting"].includes(r.status)) counts.scheduled++; if (r.status === "sent") counts.sent++; });
    el("obChips").querySelectorAll("[data-c]").forEach((s) => { s.textContent = counts[s.dataset.c] || ""; });
    const shown = rows.filter(matches);
    const body = el("obBody");
    if (!shown.length) { body.innerHTML = '<tr><td colspan="5" class="empty">' + (filter === "needs" ? "Nothing needs you. Everything else is on schedule." : "Nothing here.") + "</td></tr>"; return; }
    let html = "", lastGroup = null, grpFolded = false;
    // Groups fold on their header. "Needs you" and "Today" start open, the rest closed; a click is remembered.
    const isFolded = (g) => { try { const v = localStorage.getItem("aca-obfold:" + g); if (v !== null) return v === "1"; } catch (_) {} return !(g === "Needs you" || g === "Today"); };
    const grpCounts = {};
    shown.forEach((r) => { const needs = ["needs_review", "ready", "failed"].includes(r.status); const g = needs ? "Needs you" : (r.status === "sent" || r.status === "skipped") ? "Sent" : dayLabel(dayOf(r.at)); grpCounts[g] = (grpCounts[g] || 0) + 1; });
    shown.forEach((r) => {
      const needs = ["needs_review", "ready", "failed"].includes(r.status);
      const grp = needs ? "Needs you" : (r.status === "sent" || r.status === "skipped") ? "Sent" : dayLabel(dayOf(r.at));
      if (grp !== lastGroup) {
        grpFolded = isFolded(grp);
        html += '<tr class="ob-day' + (grpFolded ? " folded" : "") + '" data-grp="' + esc(grp) + '"><td colspan="5"><button type="button" class="ob-chev" aria-expanded="' + (!grpFolded) + '" aria-label="Fold or unfold ' + esc(grp) + '"><span class="sl-chev"></span></button>' + esc(grp) + ' <span style="font-weight:400">' + grpCounts[grp] + "</span></td></tr>";
        lastGroup = grp;
      }
      const s = STATUS[r.status] || ["muted", r.status];
      const when = needs ? (r.status === "failed" ? "Failed" : r.status === "ready" ? "Ready" : "Held") : (r.status === "sent" ? fmtWhen(r.sent_at || r.at) : fmtTime(r.at));
      html += '<tr class="ob-row row' + (r.id === openId ? " sel" : "") + (grpFolded ? " hidden" : "") + '" data-grp="' + esc(grp) + '" data-id="' + esc(r.id) + '"><td><span class="ob-when">' + esc(when) + "</span>" + (needs && r.at ? '<span class="ob-m">' + esc(fmtWhen(r.at)) + "</span>" : "") + "</td>" +
        "<td>" + esc(r.to_name || r.to_email || "") + (r.org ? '<span class="ob-m">' + esc(r.org) + "</span>" : "") + "</td>" +
        "<td>" + esc(r.subject || "") + '<span class="ob-m">' + esc(r.detail || "") + "</span></td>" +
        "<td>" + esc(SRC[r.src] || r.src) + "</td>" +
        '<td><span class="pill ' + s[0] + '">' + esc(r.status === "failed" && r.error ? r.error.slice(0, 60) : s[1]) + "</span></td></tr>";
    });
    body.innerHTML = html;
  }

  async function open(id, keep) {
    const r = rows.find((x) => x.id === id); if (!r) return;
    openId = id; if (!keep) render();
    const p = el("obPanel"); p.classList.remove("hidden"); Orgs.measureTop();
    const s = STATUS[r.status] || ["muted", r.status];
    const acts = [];
    if (r.src === "outreach" && r.status === "needs_review") acts.push('<button type="button" class="primary" data-v="approve">Approve and schedule</button>');
    if (r.src === "outreach" && ["needs_review", "scheduled"].includes(r.status)) acts.push('<button type="button" data-v="edit">Edit on the organization</button><button type="button" data-v="skip">Skip</button>');
    if (r.src === "booking" && ["scheduled", "waiting", "failed", "skipped"].includes(r.status)) acts.push('<button type="button" class="primary" data-v="sendnow">Send now</button>');
    if (r.src === "booking" && r.status === "sent") acts.push('<button type="button" data-v="resend">Resend</button>');
    if (r.src === "booking") acts.push('<button type="button" data-v="booking">Open the booking</button>');
    if (r.src === "makeup") acts.push('<button type="button" class="primary" data-v="makeups">Open in Makeups</button>');
    if (r.src === "hub") acts.push('<button type="button" data-v="hub">Open Hub activity</button>');
    if (r.src === "digest") acts.push('<button type="button" data-v="settings">Digest settings</button>');
    if (r.org_id) acts.push('<button type="button" data-v="org">Open ' + esc(r.org) + "</button>");
    p.innerHTML = `
      <div class="og-phead"><div class="og-ptop"><div style="flex:1;min-width:0"><div style="font-size:16px;font-weight:600;line-height:22px">${esc(r.subject || "")}</div>
        <div class="muted" style="font-size:13px">To ${esc(r.to_name || "")}${r.to_email ? " &lt;" + esc(r.to_email) + "&gt;" : ""}${r.org ? " at " + esc(r.org) : ""}. ${esc(r.detail || "")}.</div></div>
        <button type="button" data-v="close" aria-label="Close">&#10005;</button></div>
        <div class="og-pmeta"><span class="pill ${s[0]}">${esc(s[1])}</span>${r.at ? '<span class="muted">' + esc(fmtWhen(r.at)) + "</span>" : ""}${r.error ? '<span class="muted" style="color:var(--err-fg)">' + esc(r.error) + "</span>" : ""}</div>
        <div class="og-actions">${acts.join("")}</div></div>
      <div class="og-pbody"><div class="ob-h4">Preview</div><div class="ob-mail" id="aca-obPreview"><span class="spin"></span>Loading&#8230;</div></div>`;
    loadPreview(r);
  }
  async function loadPreview(r) {
    const box = el("obPreview"); if (!box) return;
    try {
      if (r.src === "booking") {
        const { data, error } = await sb.rpc("booking_email_preview", { p_email: r.id }); if (error) throw error;
        box.innerHTML = data && (data.html || data.body) ? (data.html ? data.html : esc(data.body)) : "No preview.";
      } else if (r.src === "outreach") {
        const { data, error } = await sb.from("prospect_scheduled_emails").select("body").eq("id", r.id).maybeSingle(); if (error) throw error;
        box.textContent = (data && data.body) || "No preview.";
      } else if (r.src === "makeup") {
        box.textContent = "The photos-ready email with the gallery link and coupon. Confirm and send it from Makeups.";
      } else if (r.src === "hub") {
        box.textContent = "The send-day reminder for " + (r.org || "") + ": a short email telling the contacts that today is the day to send the hub message to parents.";
      } else {
        box.textContent = "The Today page, as an email: what is broken, what is waiting on you, what to check soon, and the next picture day.";
      }
    } catch (e) { box.textContent = cleanErr(e); }
  }
  function closePanel() { openId = null; el("obPanel").classList.add("hidden"); render(); }
  async function onPanelClick(e) {
    const b = e.target.closest("button[data-v]"); if (!b) return;
    const r = rows.find((x) => x.id === openId); if (!r) return;
    const v = b.dataset.v;
    try {
      if (v === "close") return closePanel();
      if (v === "org") { showTab("orgs"); Orgs.open(r.org_id); return; }
      if (v === "booking") { showTab("bookings"); Bookings.openId(r.booking_id); return; }
      if (v === "makeups") return showTab("makeups");
      if (v === "hub") return showTab("hubact");
      if (v === "settings") return showTab("sending");
      if (v === "edit") { showTab("orgs"); Orgs.open(r.org_id); return; }
      b.disabled = true;
      if (v === "approve") {
        const { error } = r.enrollment_id ? await sb.rpc("prospect_approve", { p_enrollment: r.enrollment_id }) : await sb.rpc("prospect_approve_quick", { p_ids: [r.id] });
        if (error) throw error; toast("Approved and scheduled.");
      } else if (v === "skip") {
        if (!confirm("Skip this email? The rest of the sequence carries on without it.")) { b.disabled = false; return; }
        const { error } = await sb.from("prospect_scheduled_emails").update({ status: "skipped" }).eq("id", r.id); if (error) throw error; toast("Skipped.");
      } else if (v === "sendnow") {
        const { data, error } = await sb.rpc("booking_send_now", { p_email: r.id }); if (error) throw error; if (data && data.ok === false) throw new Error(data.error || "Could not send."); toast("Sending now.");
      } else if (v === "resend") {
        const { data, error } = await sb.rpc("booking_resend", { p_email: r.id }); if (error) throw error; if (data && data.ok === false) throw new Error(data.error || "Could not resend."); toast("Resend queued.");
      }
      await load(); Orgs.loadAttention(); Bookings.loadAttention();
    } catch (err) { toast(cleanErr(err), true); b.disabled = false; }
  }
  return { load, loadToday, hide: () => { if (openId) closePanel(); } };
  })();

  // Today's "This page, by email" line.
  async function renderDigestNote() {
    const n = el("todayDigest"); if (!n) return;
    try {
      const { data } = await supabase.from("admin_settings").select("digest_enabled,digest_time,digest_recipients").maybeSingle();
      if (!data) { n.innerHTML = 'Not set up yet. <a href="#system/sending">Settings</a>'; return; }
      const [h, m] = String(data.digest_time || "07:00").split(":").map(Number);
      const t = ((h + 11) % 12 + 1) + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM");
      n.innerHTML = data.digest_enabled ? "Sent at " + esc(t) + " each morning to " + esc((data.digest_recipients || []).join(", ") || "nobody yet") + '. <a href="#system/sending">Change who gets it</a>'
        : 'The morning digest is switched off. <a href="#system/sending">Turn it on</a>';
    } catch (_e) { n.textContent = ""; }
  }
