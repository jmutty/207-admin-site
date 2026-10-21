  // ================================================================ SETTINGS > Sending (2026-10-12 redesign)
  // One place for "what goes out": a switch per pipeline, the booking sender's from/reply-to/signature,
  // test mode, and the morning digest (the Today page by email; recipients are a list Jeremiah edits).
  // Booking settings live in booking_settings (one row, id = true); outreach pause in prospect_settings;
  // the digest in admin_settings (one row, id = true; migration 20261012T01).
  const SendingSettings = (function () {
  const sb = supabase;
  const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
  let bs = null, ps = null, ad = null, loaded = false;

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
  @media (max-width: 700px) { .aca .ss .kv { grid-template-columns: 1fr; } }`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  const sw = (id, on, label) => '<span class="sw' + (on ? " on" : "") + '" role="switch" aria-checked="' + on + '" tabindex="0" data-sw="' + id + '" aria-label="' + esc(label) + '"><span class="knob"></span></span>';
  const t5 = (t) => String(t || "07:00").slice(0, 5);

  async function load() {
    const root = el("panel-sending");
    if (!loaded) root.innerHTML = '<div class="empty"><span class="spin"></span>Loading settings&#8230;</div>';
    try {
      const [b, p, a] = await Promise.all([sb.from("booking_settings").select("*").maybeSingle(), sb.from("prospect_settings").select("paused,test_mode,test_recipient,daily_cap,gmail_daily_budget").maybeSingle(), sb.from("admin_settings").select("*").maybeSingle()]);
      if (b.error) throw b.error; if (p.error) throw p.error; if (a.error) throw a.error;
      bs = b.data || {}; ps = p.data || {}; ad = a.data || { digest_enabled: true, digest_time: "07:00", digest_recipients: [] };
      loaded = true;
      render();
    } catch (e) { root.innerHTML = '<div class="inline-error">' + esc(cleanErr(e)) + "</div>"; }
  }

  function render() {
    const root = el("panel-sending");
    const legacy = bs.legacy_hub_reminders !== false;
    root.innerHTML = `
      <div class="ss">
        <h2>What goes out</h2>
        <p>Switch a pipeline off and its emails wait instead of sending. Nothing is lost.</p>
        <div class="line"><div>Outreach sequences<span class="m">Prospecting emails to leagues and schools. The first email of a sequence waits in the outbox for your review.</span></div>${sw("outreach", !ps.paused, "Outreach sequences")}</div>
        <div class="line"><div>Booking emails<span class="m">The admin series after a job is booked.${bs.sending_enabled ? "" : " Off, scheduled emails are waiting."}</span></div>${sw("booking", !!bs.sending_enabled, "Booking emails")}</div>
        <div class="line"><div>Old hub reminders<span class="m">The alerts@207photo.com send-day reminders for jobs that have no booking. Turn off once every job is booked here.</span></div>${sw("legacy", legacy, "Old hub reminders")}</div>
        <div class="line"><div>Morning digest<span class="m">The Today page, by email, each morning.</span></div>${sw("digest", ad.digest_enabled !== false, "Morning digest")}</div>

        <h2>Who goes first</h2>
        <p>Booking emails and prospecting share the Gmail account. Booking emails always go first: while one is due, prospecting waits, and a daily Gmail budget keeps room for the booking emails still scheduled that day. Prospect emails that no longer fit move to the next day. Hub reminders use a separate sender and go out at 7:00 AM regardless.</p>
        <div class="kv">
          <label for="aca-ssPcap">Prospect emails per day</label><div><input type="number" id="aca-ssPcap" value="${esc(ps.daily_cap ?? 40)}" min="0" max="500" /> <span class="muted" style="font-size:13px">at most, spread across the send window</span></div>
          <label for="aca-ssBudget">Gmail emails per day</label><div><input type="number" id="aca-ssBudget" value="${esc(ps.gmail_daily_budget ?? 150)}" min="10" max="2000" /> <span class="muted" style="font-size:13px">everything from this account; booking emails are counted first</span></div>
        </div>

        <h2>Morning digest</h2>
        <p>One email that reads like the Today page. It replaces the separate follow-up, help-request and failed-send alerts.</p>
        <div class="kv">
          <label for="aca-ssDigestTime">Sent at</label><div><select id="aca-ssDigestTime">${["06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00"].map((t) => '<option value="' + t + '"' + (t5(ad.digest_time) === t ? " selected" : "") + ">" + fmtT(t) + "</option>").join("")}</select> <span class="muted" style="font-size:13px">Eastern</span></div>
          <label>Goes to</label><div class="tags" id="aca-ssRecips">${(ad.digest_recipients || []).map((r) => '<span class="tag">' + esc(r) + '<button type="button" data-rm="' + esc(r) + '" aria-label="Remove ' + esc(r) + '">&times;</button></span>').join("")}<input type="email" id="aca-ssNewRecip" placeholder="Add an address and press Enter" /></div>
          <label></label><div><button type="button" class="small" id="aca-ssDigestNow">Send me today's digest now</button> <span class="muted" id="aca-ssDigestMsg" style="font-size:13px"></span></div>
        </div>

        <h2>Booking emails: from and signature</h2>
        <p>Sent from ${esc(bs.from_email || "the Gmail account")} through Gmail.</p>
        <div class="kv">
          <label for="aca-ssFromName">From name</label><div><input type="text" id="aca-ssFromName" value="${esc(bs.from_name || "")}" /></div>
          <label for="aca-ssReply">Replies go to</label><div><input type="text" id="aca-ssReply" value="${esc(bs.reply_to || "")}" placeholder="jmutty@207photo.com, info@207photo.com" /><span class="muted" style="font-size:12.5px;display:block;margin-top:2px">Rosters come back here. Separate addresses with commas.</span></div>
          <label for="aca-ssBcc">Bcc</label><div><input type="email" id="aca-ssBcc" value="${esc(bs.bcc || "")}" placeholder="optional" /></div>
          <label for="aca-ssSig">Signature</label><div><textarea id="aca-ssSig" rows="3">${esc(bs.signature || "")}</textarea></div>
          <label for="aca-ssDelay">Undo window</label><div><input type="number" id="aca-ssDelay" value="${esc(bs.day0_delay_min ?? 10)}" min="1" max="120" /> <span class="muted" style="font-size:13px">minutes after booking before the first email goes</span></div>
          <label>Quiet hours</label><div><input type="time" id="aca-ssQ1" value="${esc(t5(bs.quiet_start || "21:00"))}" /> to <input type="time" id="aca-ssQ2" value="${esc(t5(bs.quiet_end || "07:00"))}" /> <span class="muted" style="font-size:13px">no sending overnight</span></div>
        </div>

        <h2>Test mode</h2>
        <p>While on, booking emails go to you instead of the real recipient, with [TEST] in the subject. Outreach has its own test mode in the Library.</p>
        <div class="line"><div>Test mode<span class="m">${bs.test_mode ? "On. Everything goes to " + esc(bs.test_recipient || "?") + "." : "Off. Emails go to real recipients."}</span></div>${sw("test", !!bs.test_mode, "Test mode")}</div>
        <div class="kv" style="margin-top:12px"><label for="aca-ssTestTo">Test recipient</label><div><input type="email" id="aca-ssTestTo" value="${esc(bs.test_recipient || "")}" placeholder="you@207photo.com" /></div></div>

        <div id="aca-ssErr" class="inline-error hidden"></div>
        <div class="acts"><button type="button" class="primary" id="aca-ssSave">Save changes</button><button type="button" class="quiet" id="aca-ssDiscard">Discard</button></div>
      </div>`;
    root.querySelectorAll("[data-sw]").forEach((s) => {
      const flip = () => { const on = s.getAttribute("aria-checked") !== "true"; s.classList.toggle("on", on); s.setAttribute("aria-checked", String(on)); };
      s.addEventListener("click", flip);
      s.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); } });
    });
    el("ssRecips").addEventListener("click", (e) => { const b = e.target.closest("[data-rm]"); if (b) b.parentElement.remove(); });
    el("ssNewRecip").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== ",") return;
      e.preventDefault();
      const v = el("ssNewRecip").value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { toast("That doesn't look like an email address.", true); return; }
      const tag = document.createElement("span"); tag.className = "tag"; tag.innerHTML = esc(v) + '<button type="button" data-rm="' + esc(v) + '" aria-label="Remove ' + esc(v) + '">&times;</button>';
      el("ssNewRecip").before(tag); el("ssNewRecip").value = "";
    });
    el("ssSave").addEventListener("click", save);
    el("ssDiscard").addEventListener("click", () => { loaded = false; load(); });
    el("ssDigestNow").addEventListener("click", async () => {
      const b = el("ssDigestNow"); b.disabled = true; el("ssDigestMsg").textContent = "Sending…";
      const { data, error } = await sb.rpc("admin_morning_digest", { p_force: true });
      b.disabled = false;
      el("ssDigestMsg").textContent = error ? cleanErr(error) : (data && data.ok ? "Sent to " + (data.to || []).join(", ") + "." : "Could not send (" + ((data && data.error) || "unknown") + ").");
    });
  }
  const fmtT = (t) => { const [h, m] = t.split(":").map(Number); return ((h + 11) % 12 + 1) + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM"); };
  const swOn = (id) => el("panel-sending").querySelector('[data-sw="' + id + '"]').getAttribute("aria-checked") === "true";

  async function save() {
    const err = (m) => { el("ssErr").textContent = m; el("ssErr").classList.remove("hidden"); };
    el("ssErr").classList.add("hidden");
    const bRow = { sending_enabled: swOn("booking"), legacy_hub_reminders: swOn("legacy"), test_mode: swOn("test"), test_recipient: el("ssTestTo").value.trim() || null,
      from_name: el("ssFromName").value.trim() || "207 Photo", reply_to: el("ssReply").value.split(",").map((x) => x.trim()).filter(Boolean).join(", ") || null,
      bcc: el("ssBcc").value.trim() || null, signature: el("ssSig").value.trim(), day0_delay_min: Math.max(1, Number(el("ssDelay").value) || 10), quiet_start: el("ssQ1").value || "21:00", quiet_end: el("ssQ2").value || "07:00" };
    if (bRow.test_mode && !bRow.test_recipient) return err("Test mode needs a test address.");
    if (bRow.sending_enabled && !bs.sending_enabled && !bRow.test_mode && !confirm("Turn on real sending? Every scheduled booking email will go to the actual admins from now on.")) return;
    const recips = [...el("ssRecips").querySelectorAll(".tag")].map((t) => t.firstChild.textContent.trim());
    const aRow = { digest_enabled: swOn("digest"), digest_time: el("ssDigestTime").value, digest_recipients: recips };
    if (aRow.digest_enabled && !recips.length) return err("The morning digest needs at least one address, or switch it off.");
    const pRow = { paused: !swOn("outreach"), daily_cap: Math.max(0, Number(el("ssPcap").value) || 0), gmail_daily_budget: Math.max(10, Number(el("ssBudget").value) || 150) };
    el("ssSave").disabled = true;
    try {
      let r = await sb.from("booking_settings").update(bRow).eq("id", true); if (r.error) throw r.error;
      r = await sb.from("prospect_settings").update(pRow).eq("id", true); if (r.error) throw r.error;
      r = await sb.from("admin_settings").upsert(Object.assign({ id: true }, aRow)); if (r.error) throw r.error;
      toast("Settings saved");
      Bookings.loadAttention(); loaded = false; load(); if (typeof renderDigestNote === "function") renderDigestNote();
    } catch (e) { err(cleanErr(e)); }
    finally { el("ssSave").disabled = false; }
  }
  return { load };
  })();
