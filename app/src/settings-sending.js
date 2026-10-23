  // ================================================================ SETTINGS > Sending (2026-10-12 redesign; ws/settings 2026-10-24)
  // One place for "what goes out", and the only editor of booking_settings (the Email library's old "Sending
  // settings" dialog is gone; its button links here). The pipeline switches save the moment they are flipped,
  // with a toast; the fields below save from the sticky Save bar. The Outreach block (pause, test mode, track
  // opens) moved here from the Partners Library. The morning digest moved to Settings > Team emails.
  // Booking settings live in booking_settings (one row, id = true); outreach in prospect_settings.
  const SendingSettings = (function () {
  const sb = supabase;
  const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
  let bs = null, ps = null, loaded = false;

  const css = `
  .aca .ss h2 { margin: 32px 0 4px; font-size: 15px; font-weight: 600; }
  .aca .ss h2:first-child { margin-top: 0; }
  .aca .ss h2 + p { margin: 0 0 12px; color: var(--muted); font-size: 13px; max-width: 80ch; }
  .aca .ss .line { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--line2); }
  .aca .ss .line .m { display: block; font-size: 13px; color: var(--muted); }
  .aca .ss .kv { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px 16px; align-items: center; max-width: 720px; }
  .aca .ss .kv label { color: var(--muted); font-size: 13px; }
  .aca .ss .kv input[type=text], .aca .ss .kv input[type=email], .aca .ss .kv textarea, .aca .ss .kv select { width: 100%; max-width: 440px; }
  .aca .ss .tag { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 4px 0 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--surface); font-size: 13px; }
  .aca .ss .tag button { border: 0; background: transparent; color: var(--faint); height: 24px; padding: 0 6px; font-size: 14px; }
  .aca .ss .tag button:hover { color: var(--err-fg); background: transparent; }
  .aca .ss .tags { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .aca .ss .tags input { width: 220px; max-width: none; }
  .aca .ss .acts { margin-top: 28px; display: flex; gap: 8px; align-items: center; }
  .aca .ss .savebar { position: sticky; bottom: 0; z-index: 3; margin: 28px -16px 0; padding: 10px 16px; display: flex; gap: 8px; align-items: center; background: var(--surface); border-top: 1px solid var(--border); }
  .aca .ss .savebar .m { color: var(--muted); font-size: 13px; }
  .aca .ss .savebar:not(.dirty) .m::after { content: "Switches save as you flip them."; }
  .aca .ss .savebar.dirty .m::after { content: "You have unsaved changes."; }
  @media (max-width: 700px) { .aca .ss .kv { grid-template-columns: 1fr; } }`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  const sw = (id, on, label) => '<span class="sw' + (on ? " on" : "") + '" role="switch" aria-checked="' + on + '" tabindex="0" data-sw="' + id + '" aria-label="' + esc(label) + '"><span class="knob"></span></span>';
  const t5 = (t) => String(t || "07:00").slice(0, 5);

  async function load() {
    const root = el("panel-sending");
    if (!loaded) root.innerHTML = '<div class="empty"><span class="spin"></span>Loading settings&#8230;</div>';
    try {
      const [b, p] = await Promise.all([sb.from("booking_settings").select("*").maybeSingle(), sb.from("prospect_settings").select("*").maybeSingle()]);
      if (b.error) throw b.error; if (p.error) throw p.error;
      bs = b.data || {}; ps = p.data || {};
      loaded = true;
      render();
    } catch (e) { root.innerHTML = '<div class="inline-error">' + esc(cleanErr(e)) + "</div>"; }
  }

  function render() {
    const root = el("panel-sending");
    const legacy = bs.legacy_hub_reminders !== false;
    const win = typeof Prior !== "undefined" && ps.send_days ? Prior.scheduleText(ps) : "";
    root.innerHTML = `
      <div class="ss">
        <h2>What goes out</h2>
        <p>Switch a pipeline off and its emails wait instead of sending. Nothing is lost. Each switch saves as soon as you flip it.</p>
        <div class="line"><div>Outreach sequences<span class="m">Prospecting emails to leagues and schools. The first email of a sequence waits in Outreach to review.${ps.paused ? " Paused: due emails are waiting." : ""}</span></div>${sw("outreach", !ps.paused, "Outreach sequences")}</div>
        <div class="line"><div>Booking emails<span class="m">The admin series after a job is booked.${bs.sending_enabled ? "" : " Off, scheduled emails are waiting."}</span></div>${sw("booking", !!bs.sending_enabled, "Booking emails")}</div>
        <div class="line"><div>Old hub reminders<span class="m">The alerts@207photo.com send-day reminders for jobs that have no booking. Turn off once every job is booked here.</span></div>${sw("legacy", legacy, "Old hub reminders")}</div>
        <p class="muted" style="font-size:13px;margin:10px 0 0">The morning digest and the emails to the team are under <a href="#system/teamemails">Team emails</a>.</p>

        <h2>Outreach</h2>
        <p>Prospecting emails go out ${win ? esc(win) : "in their send window"}.</p>
        <div class="line"><div>Test mode<span class="m">${ps.test_mode ? "On. Outreach emails go to " + esc(ps.test_recipient || "?") + " instead of the league." : "Off. Outreach emails go to the real contacts."}</span></div>${sw("otest", !!ps.test_mode, "Outreach test mode")}</div>
        <div class="kv" style="margin-top:10px"><label for="aca-ssOTestTo">Outreach test address</label><div><input type="email" id="aca-ssOTestTo" value="${esc(ps.test_recipient || "")}" placeholder="you@207photo.com" /></div></div>
        <div class="line"><div>Track opens<span class="m">A tiny image in each outreach email says when it was opened. Some mail apps block it, so "not opened" is a guess.</span></div>${sw("track", ps.track_opens !== false, "Track opens")}</div>

        <h2>Who goes first</h2>
        <p>Booking emails and prospecting share the Gmail account. Booking emails always go first: while one is due, prospecting waits, and a daily Gmail budget keeps room for the booking emails still scheduled that day. Prospect emails that no longer fit move to the next day. Hub reminders use a separate sender and go out at 7:00 AM regardless.</p>
        <div class="kv">
          <label for="aca-ssPcap">Prospect emails per day</label><div><input type="number" id="aca-ssPcap" value="${esc(ps.daily_cap ?? 40)}" min="0" max="500" /> <span class="muted" style="font-size:13px">at most, spread across the send window</span></div>
          <label for="aca-ssBudget">Gmail emails per day</label><div><input type="number" id="aca-ssBudget" value="${esc(ps.gmail_daily_budget ?? 150)}" min="10" max="2000" /> <span class="muted" style="font-size:13px">everything from this account; booking emails are counted first</span></div>
        </div>

        <h2>Booking emails: from and signature</h2>
        <p>Sent from ${esc(bs.from_email || "the Gmail account")} through Gmail.</p>
        <div class="kv">
          <label for="aca-ssFromName">From name</label><div><input type="text" id="aca-ssFromName" value="${esc(bs.from_name || "")}" /></div>
          <label for="aca-ssReply">Replies go to</label><div><input type="text" id="aca-ssReply" value="${esc(bs.reply_to || "")}" placeholder="jmutty@207photo.com, info@207photo.com" /><span class="muted" style="font-size:12.5px;display:block;margin-top:2px">Rosters come back here. Separate addresses with commas.</span></div>
          <label for="aca-ssBcc">Bcc</label><div><input type="email" id="aca-ssBcc" value="${esc(bs.bcc || "")}" placeholder="optional" /></div>
          <label for="aca-ssSig">Signature</label><div><textarea id="aca-ssSig" rows="3">${esc(bs.signature || "")}</textarea></div>
          <label for="aca-ssDelay">Undo window</label><div><input type="number" id="aca-ssDelay" value="${esc(bs.day0_delay_min ?? 10)}" min="1" max="120" /> <span class="muted" style="font-size:13px">minutes after booking before the first email goes</span></div>
          <label for="aca-ssW1">Send window</label><div><input type="time" id="aca-ssW1" value="${esc(t5(bs.quiet_end || "07:00"))}" aria-label="Send from" /> to <input type="time" id="aca-ssW2" value="${esc(t5(bs.quiet_start || "21:00"))}" aria-label="Send until" /> <span class="muted" style="font-size:13px">Eastern. Emails due overnight wait for the morning.</span></div>
        </div>

        <h2>Booking test mode</h2>
        <p>While on, booking emails go to you instead of the real recipient, with [TEST] in the subject. Outreach has its own test mode above.</p>
        <div class="line"><div>Test mode<span class="m">${bs.test_mode ? "On. Everything goes to " + esc(bs.test_recipient || "?") + "." : "Off. Emails go to real recipients."}</span></div>${sw("test", !!bs.test_mode, "Booking test mode")}</div>
        <div class="kv" style="margin-top:12px"><label for="aca-ssTestTo">Test recipient</label><div><input type="email" id="aca-ssTestTo" value="${esc(bs.test_recipient || "")}" placeholder="you@207photo.com" /></div></div>

        <div id="aca-ssErr" class="inline-error hidden"></div>
        <div class="savebar" id="aca-ssBar"><button type="button" class="primary" id="aca-ssSave">Save changes</button><button type="button" class="quiet" id="aca-ssDiscard">Discard</button><span class="m"></span></div>
      </div>`;
    root.querySelectorAll("[data-sw]").forEach((s) => {
      const go = () => flip(s);
      s.addEventListener("click", go);
      s.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); go(); } });
    });
    root.querySelector(".ss").addEventListener("input", () => el("ssBar").classList.add("dirty"));
    el("ssSave").addEventListener("click", save);
    el("ssDiscard").addEventListener("click", () => { loaded = false; load(); });
  }

  // A switch saves at once. What it writes: [table, row patch, toast].
  async function flip(s) {
    const id = s.dataset.sw, on = s.getAttribute("aria-checked") !== "true";
    let table, patch, msg;
    if (id === "outreach") {
      if (!on && !confirm("Pause all prospect emails? Nothing sends until you switch it back on; sequences pick up where they left off.")) return;
      table = "prospect_settings"; patch = { paused: !on }; msg = on ? "Outreach is sending." : "Outreach paused.";
    } else if (id === "otest") {
      const to = el("ssOTestTo").value.trim();
      if (on && !to) { toast("Put in the outreach test address first.", true); el("ssOTestTo").focus(); return; }
      table = "prospect_settings"; patch = { test_mode: on, test_recipient: to || null }; msg = on ? "Outreach test mode on: emails go to " + to + "." : "Outreach test mode off.";
    } else if (id === "track") {
      table = "prospect_settings"; patch = { track_opens: on }; msg = on ? "Tracking opens." : "Not tracking opens.";
    } else if (id === "booking") {
      if (on && !bs.test_mode && !confirm("Turn on real sending? Every scheduled booking email will go to the actual admins from now on.")) return;
      table = "booking_settings"; patch = { sending_enabled: on }; msg = on ? "Booking emails on." : "Booking emails off. They wait until you turn them back on.";
    } else if (id === "legacy") {
      table = "booking_settings"; patch = { legacy_hub_reminders: on }; msg = on ? "Old hub reminders on." : "Old hub reminders off.";
    } else if (id === "test") {
      const to = el("ssTestTo").value.trim();
      if (on && !to) { toast("Put in the test recipient first.", true); el("ssTestTo").focus(); return; }
      table = "booking_settings"; patch = { test_mode: on, test_recipient: to || null }; msg = on ? "Booking test mode on: emails go to " + to + "." : "Booking test mode off. Emails go to real recipients.";
    } else return;
    s.classList.toggle("on", on); s.setAttribute("aria-checked", String(on));
    const { error } = await sb.from(table).update(patch).eq("id", true);
    if (error) { s.classList.toggle("on", !on); s.setAttribute("aria-checked", String(!on)); toast(cleanErr(error), true); return; }
    Object.assign(table === "booking_settings" ? bs : ps, patch);
    toast(msg);
    if (table === "booking_settings") Bookings.loadAttention();
    // refresh the one-line descriptions without losing typed, unsaved fields
    const line = s.closest(".line"), m = line && line.querySelector(".m");
    if (m && id === "test") m.textContent = bs.test_mode ? "On. Everything goes to " + (bs.test_recipient || "?") + "." : "Off. Emails go to real recipients.";
    if (m && id === "otest") m.textContent = ps.test_mode ? "On. Outreach emails go to " + (ps.test_recipient || "?") + " instead of the league." : "Off. Outreach emails go to the real contacts.";
  }

  async function save() {
    const err = (m) => { el("ssErr").textContent = m; el("ssErr").classList.remove("hidden"); };
    el("ssErr").classList.add("hidden");
    const bRow = { test_recipient: el("ssTestTo").value.trim() || null,
      from_name: el("ssFromName").value.trim() || "207 Photo", reply_to: el("ssReply").value.split(",").map((x) => x.trim()).filter(Boolean).join(", ") || null,
      bcc: el("ssBcc").value.trim() || null, signature: el("ssSig").value.trim(), day0_delay_min: Math.max(1, Number(el("ssDelay").value) || 10),
      quiet_end: el("ssW1").value || "07:00", quiet_start: el("ssW2").value || "21:00" };
    if (bs.test_mode && !bRow.test_recipient) return err("Booking test mode is on, so it needs a test address.");
    if (bRow.quiet_end === bRow.quiet_start) return err("The send window needs a start and an end that differ.");
    const pRow = { daily_cap: Math.max(0, Number(el("ssPcap").value) || 0), gmail_daily_budget: Math.max(10, Number(el("ssBudget").value) || 150), test_recipient: el("ssOTestTo").value.trim() || null };
    if (ps.test_mode && !pRow.test_recipient) return err("Outreach test mode is on, so it needs a test address.");
    el("ssSave").disabled = true;
    try {
      let r = await sb.from("booking_settings").update(bRow).eq("id", true); if (r.error) throw r.error;
      r = await sb.from("prospect_settings").update(pRow).eq("id", true); if (r.error) throw r.error;
      toast("Settings saved");
      Bookings.loadAttention(); loaded = false; load();
    } catch (e) { err(cleanErr(e)); }
    finally { if (el("ssSave")) el("ssSave").disabled = false; }
  }
  return { load };
  })();
