  // ================================================================ PARTNERS > Outbox: Bounced (2026-10-23)
  // Emails sent through Resend (recorded by the database as it goes out) that bounced, were marked spam or failed.
  // Polish pass 2026-10-23: only "did it bounce" (no opens, clicks or monthly report), as a Bounced tab on Outbox.
  // Each email shows what was sent, Resend (Edit) to the same or a corrected address, and Mark handled.
  // RPCs: email_list / email_detail / email_resend / email_mark_handled / email_attention
  // (migration 20261023141600). Booking and outreach emails go through Gmail and are on Outbox, not here.
  registerPage({ id: "delivery", group: "Partners", section: "partners", module: "emails", title: "Bounced",
                 tabs: [["delivery", "Bounced"]], onShow: () => Emails.load() });
  registerAttention("emailProblems", { module: "emails", level: "warn", name: "bounced emails",
    one: "An email bounced in the last two weeks.", many: "{n} emails bounced in the last two weeks." });
  registerTodayLoader("emails", () => Emails.loadAttention());

  const Emails = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const SRC = { pictureday: "Picture day", makeup: "Makeups", hub: "Hub & galleries", help: "Parent help", day_email: "Your day",
                  digest: "Digests", alert: "Alerts", welcome: "Welcome", signin: "Sign-in codes", other: "Other" };
    const ST = { queued: ["muted", "Sending"], sent: ["muted", "Sent"], delivered: ["ok", "Delivered"], delayed: ["warn", "Delayed"],
                 bounced: ["err", "Bounced"], complained: ["err", "Marked spam"], failed: ["err", "Failed"], unknown: ["warn", "Unknown"] };
    const PROBLEM = { bounced: 1, complained: 1, failed: 1 };
    const when = (ts) => new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const pct = (n, d) => (d ? Math.round((100 * n) / d) + "%" : "");

    const css = `
    .aca .em-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 0 0 14px; }
    .aca .em-bar .grow { flex: 1; }
    .aca .em-bar input[type=search] { width: 220px; }
    .aca tr.em-row { cursor: pointer; }
    .aca .em-to { font-weight: 600; overflow-wrap: anywhere; }
    .aca .em-s { display: block; color: var(--muted); font-size: 12.5px; }
    .aca .em-err { display: block; color: var(--err-fg); font-size: 12.5px; }
    .aca .em-tag { display: inline-block; font-size: 11.5px; font-weight: 700; padding: 0 6px; border-radius: 3px; margin-left: 6px; background: var(--ok-bg); color: var(--ok-fg); }
    .aca .em-tag.t { background: var(--warn-bg); color: var(--warn-fg); }
    .aca .em-frame { width: 100%; height: 50vh; border: 1px solid var(--border); border-radius: 4px; background: #fff; }
    .aca .em-text { margin: 0; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; font-size: 13px; white-space: pre-wrap; max-height: 50vh; overflow: auto; }
    .aca .em-kv { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 4px 12px; font-size: 13.5px; margin: 0 0 12px; }
    .aca .em-kv dt { color: var(--muted); } .aca .em-kv dd { margin: 0; overflow-wrap: anywhere; }
    .aca .em-warn { margin: 0 0 12px; padding: 9px 12px; border-radius: 4px; background: var(--warn-bg); color: var(--warn-fg); font-size: 13px; }
    .aca .em-bars { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--line2); min-width: 80px; }
    .aca .em-bars span { display: block; height: 100%; }
    .aca .em-report td, .aca .em-report th { padding: 7px 8px; font-size: 13px; }
    .aca .em-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    @media (max-width: 700px) { .aca .em-hide-sm { display: none; } .aca .em-bar input[type=search] { width: 100%; } }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    // ---------------------------------------------------------------- Sent
    const root = el("panel-delivery");
    root.innerHTML =
      '<div class="em-bar"><div class="seg" role="radiogroup" aria-label="Show">' +
        [["problems", "Bounced and failed"], ["all", "Everything sent"]].map((f, i) => '<label><input type="radio" name="aca-emF" value="' + f[0] + '"' + (i ? "" : " checked") + " /><span>" + f[1] + "</span></label>").join("") + "</div>" +
        '<select class="small" id="aca-emSrc"><option value="">Every kind</option>' + Object.keys(SRC).map((k) => '<option value="' + k + '">' + SRC[k] + "</option>").join("") + "</select>" +
        '<input type="search" id="aca-emQ" placeholder="Address or subject" /><span class="grow"></span>' +
        '<button type="button" class="small hidden" id="aca-emHandled">Mark all handled</button></div>' +
      '<div id="aca-emErr" class="inline-error hidden"></div><div id="aca-emBody"><p class="empty">Loading&#8230;</p></div>';
    let rows = [], data = null, more = false;
    const filter = () => (root.querySelector('input[name="aca-emF"]:checked') || {}).value || "problems";

    async function load(append) {
      clearError("emErr");
      try {
        const before = append && rows.length ? rows[rows.length - 1].id : null;
        const { data: d, error } = await sb.rpc("email_list", { p_filter: filter(), p_source: el("emSrc").value || null, p_q: el("emQ").value.trim() || null, p_before: before });
        if (error) throw error;
        data = d;
        rows = append ? rows.concat(d.rows || []) : d.rows || [];
        more = (d.rows || []).length === 100;
        render();
        setAttention("emailProblems", num(d.problems), "", "delivery", null, () => { root.querySelector('input[value="problems"]').checked = true; load(); });
      } catch (e) { showError("emErr", "Could not load emails: " + cleanErr(e)); }
    }
    function statusHtml(r) {
      const s = ST[r.status] || ["muted", r.status];
      return '<span class="pill ' + s[0] + '">' + s[1] + "</span>" +
        (r.resent ? '<span class="em-tag t">resent</span>' : "") + (PROBLEM[r.status] && r.handled_at && !r.resent ? '<span class="em-tag t">handled</span>' : "");
    }
    function render() {
      const openProblems = rows.filter((r) => PROBLEM[r.status] && !r.handled_at);
      el("emHandled").classList.toggle("hidden", !(data.can_edit && openProblems.length));
      el("emBody").innerHTML = (data.capturing === false ? '<p class="em-warn">Emails are not being recorded right now (the database trigger on pg_net is missing, probably after a pg_net upgrade). Re-run the email delivery migration’s trigger line.</p>' : "") +
        (rows.length ? '<div class="table-wrap cards"><table><thead><tr><th>Sent</th><th>To</th><th>Email</th><th class="em-hide-sm">Kind</th><th>Status</th></tr></thead><tbody>' +
          rows.map((r) => '<tr class="em-row" data-id="' + esc(r.id) + '"><td style="white-space:nowrap">' + esc(when(r.sent_at)) + '</td><td><span class="em-to">' + esc((r.to || []).join(", ")) + "</span></td>" +
            "<td>" + esc(r.subject) + (r.test_mode ? '<span class="em-tag t">test</span>' : "") + (r.error && PROBLEM[r.status] ? '<span class="em-err">' + esc(r.error) + "</span>" : "") + "</td>" +
            '<td class="em-hide-sm">' + esc(SRC[r.source] || r.source) + "</td><td>" + statusHtml(r) + "</td></tr>").join("") + "</tbody></table></div>" +
          (more ? '<p style="margin:12px 0"><button type="button" class="small" data-more>Show older</button></p>' : "")
        : '<p class="empty">' + (filter() === "problems" ? "Nothing bounced or failed. Everything sent was accepted." : "Nothing here yet. Emails show up as they are sent.") + "</p>") +
        '<p class="muted" style="font-size:12.5px;margin-top:10px">Emails sent through Resend. Booking emails and outreach go through Gmail; see Outbox for those. Status is checked with Resend 10 minutes, 1 hour, 6 hours, 1 day and 3 days after sending.</p>';
    }
    root.addEventListener("change", (ev) => { if (ev.target.name === "aca-emF" || ev.target.id === "aca-emSrc") load(); });
    let qTimer = null;
    el("emQ").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => load(), 350); });
    root.addEventListener("click", async (ev) => {
      if (ev.target.closest("[data-more]")) return load(true);
      if (ev.target.id === "aca-emHandled") {
        const ids = rows.filter((r) => PROBLEM[r.status] && !r.handled_at).map((r) => r.id);
        if (!confirm("Mark " + ids.length + " problem" + (ids.length === 1 ? "" : "s") + " as handled? They leave the Today page.")) return;
        const { error } = await sb.rpc("email_mark_handled", { p_ids: ids, p_handled: true });
        if (error) return toast(cleanErr(error), true);
        toast("Marked handled."); return load();
      }
      const tr = ev.target.closest("[data-id]");
      if (tr) openEmail(+tr.dataset.id);
    });

    async function openEmail(id) {
      let d;
      try { const r = await sb.rpc("email_detail", { p_id: id }); if (r.error) throw r.error; d = r.data; }
      catch (e) { return toast(cleanErr(e), true); }
      const list = (v) => (Array.isArray(v) ? v.join(", ") : v || "");
      const problem = PROBLEM[d.status];
      const m = openModal('<div style="max-width:760px"><h2>' + esc(d.subject || "(no subject)") + "</h2>" +
        '<dl class="em-kv"><dt>To</dt><dd>' + esc(list(d.to)) + "</dd>" + (d.cc ? "<dt>Cc</dt><dd>" + esc(list(d.cc)) + "</dd>" : "") + (d.bcc ? "<dt>Bcc</dt><dd>" + esc(list(d.bcc)) + "</dd>" : "") +
          "<dt>From</dt><dd>" + esc(d.from) + (d.reply_to ? " (replies to " + esc(list(d.reply_to)) + ")" : "") + "</dd>" +
          "<dt>Sent</dt><dd>" + esc(when(d.sent_at)) + " · " + esc(SRC[d.source] || d.source) + (d.resent_by ? " · resent by " + esc(d.resent_by) : "") + "</dd>" +
          "<dt>Status</dt><dd>" + statusHtml(d) + (d.error ? '<span class="em-err">' + esc(d.error) + "</span>" : "") +
            (d.handled_by ? '<span class="em-s">Handled by ' + esc(d.handled_by) + "</span>" : "") + "</dd></dl>" +
        (d.bounced_contact ? '<p class="em-warn">This address is marked bounced on its organization contact, so outreach skips it. Fix the address there if it was a typo.</p>' : "") +
        (d.resends && d.resends.length ? '<p class="em-s" style="margin:0 0 10px">Resent: ' + d.resends.map((r) => esc(when(r.sent_at)) + " to " + esc(list(r.to)) + " (" + esc((ST[r.status] || [0, r.status])[1]) + ")").join("; ") + "</p>" : "") +
        (d.html ? '<iframe class="em-frame" sandbox="" title="The email as sent"></iframe>' : d.text ? '<pre class="em-text"></pre>' : '<p class="muted">The content isn’t kept for this one (' + (d.source === "signin" || d.source === "welcome" ? "it held a code or a password" : "over 60 days old") + ").</p>") +
        (data && data.can_edit && d.can_resend ? '<div class="field" style="margin-top:14px"><label for="aca-emTo">Resend to</label><input type="text" id="aca-emTo" value="' + esc(list(d.to)) + '" /><p class="muted" style="font-size:12px;margin:4px 0 0">Change it to send to a corrected address (one address).</p></div>' : "") +
        '<div class="modal-actions">' + (data && data.can_edit && problem ? '<button type="button" class="small" data-m="handled">' + (d.handled_at ? "Not handled" : "Mark handled") + "</button>" : "") +
          '<span class="grow"></span><button type="button" class="small" data-m="cancel">Close</button>' +
          (data && data.can_edit && d.can_resend ? '<button type="button" class="primary" data-m="resend">Resend</button>' : "") + "</div></div>");
      const fr = m.querySelector(".em-frame"); if (fr) fr.srcdoc = d.html;
      const pre = m.querySelector(".em-text"); if (pre) pre.textContent = d.text;
      m.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "cancel") return m.close();
        b.disabled = true;
        try {
          if (b.dataset.m === "handled") {
            const { error } = await sb.rpc("email_mark_handled", { p_ids: [d.id], p_handled: !d.handled_at }); if (error) throw error;
            toast(d.handled_at ? "Back on the list." : "Marked handled.");
          } else {
            const to = el("emTo").value.trim(), same = to.toLowerCase() === list(d.to).toLowerCase();
            if (!same && /[,;\s]/.test(to)) throw new Error("Resend to one address.");
            if (!confirm(same ? "Send this email again to " + list(d.to) + "?" : "Send this email to " + to + "?")) { b.disabled = false; return; }
            const { error } = await sb.rpc("email_resend", { p_id: d.id, p_to: same ? null : to }); if (error) throw error;
            toast("Sent again. Its status shows here in a minute.");
          }
          m.close(); load();
        } catch (e) { b.disabled = false; toast(cleanErr(e), true); }
      });
    }

    async function loadAttention() {
      if (!canSee("emails")) return;
      try {
        const { data: d, error } = await sb.rpc("email_attention");
        if (error) throw error;
        setAttention("emailProblems", num(d.problems), "", "delivery", null, () => { root.querySelector('input[value="problems"]').checked = true; load(); });
      } catch (e) { setAttention("emailProblems", 0); }
    }

    return { load, loadAttention };
  })();
