  // ================================================================ PARENTS section
  // Sub-tabs: Help requests, Makeups.

  // ================= Mobile card layout (below 760px) =================
  (function () {
    const css = `
    .aca .rq-pre { display: none; }
    /* help request details: roster picks + reply (open on load, 2026-10-13) */
    .aca #aca-reqBody tr.rq-row > td { border-bottom: none; }
    .aca #aca-reqBody tr.req-searches > td { padding: 4px 12px 18px; border-bottom: 1px solid var(--border); }
    .aca #aca-reqBody tr.req-searches:hover, .aca #aca-reqBody tr.rq-row:hover { background: transparent; }
    .aca .rq-detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 12px 28px; margin-bottom: 14px; }
    .aca .rq-picks { display: flex; flex-direction: column; }
    .aca .rq-pick { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto auto; gap: 4px 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line2); cursor: pointer; font-size: 14px; }
    .aca .rq-pick:last-child { border-bottom: none; }
    .aca .rq-pick-none { grid-template-columns: 22px minmax(0, 1fr); }
    .aca .rq-pk-name { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
    .aca .rq-pk-name .muted { font-size: 12.5px; }
    .aca a.rq-code { font-size: 13px; color: var(--text); text-decoration: underline; text-decoration-color: var(--accent); text-underline-offset: 3px; white-space: nowrap; }
    .aca .rq-reply label { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 8px; }
    .aca .rq-reply input, .aca .rq-reply textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 3px; font: inherit; font-size: 14px; color: var(--text); }
    .aca .rq-reply textarea { line-height: 1.45; resize: vertical; min-height: 220px; padding: 8px 10px; }
    .aca .rq-reply-acts { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
    .aca .rq-affirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13.5px; margin: 4px 0 12px; }
    @media (max-width: 1000px) { .aca .rq-detail { grid-template-columns: 1fr; } }
    @media (max-width: 760px) {
      .aca #aca-panel-requests thead { display: none; }
      .aca #aca-panel-requests .table-wrap { overflow-x: visible; }
      .aca .rq-pre { display: inline; }
      .aca #aca-reqBody tr.rq-row { display: block; padding: 12px 16px; border-bottom: 1px solid var(--border); }
      .aca #aca-reqBody tr.rq-row > td { display: block; padding: 0; border: none; width: auto; }
      .aca #aca-reqBody tr.rq-row > td.name { font-weight: 600; overflow-wrap: anywhere; }
      .aca #aca-reqBody tr.rq-row > td.rq-job { margin-top: 2px; overflow-wrap: anywhere; }
      .aca #aca-reqBody tr.rq-row > td.rq-typed { margin-top: 6px; overflow-wrap: anywhere; }
      .aca #aca-reqBody tr.rq-row > td.rq-when { margin-top: 6px; font-size: 13px; color: var(--muted); }
      .aca #aca-reqBody tr.rq-row > td.rq-when::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); margin-right: 8px; vertical-align: 0; }
      .aca #aca-reqBody tr.rq-row > td.rq-act { margin-top: 10px; }
      .aca #aca-reqBody tr.rq-row > td.rq-act button { min-height: 40px; width: 100%; }
      .aca #aca-panel-requests table, .aca #aca-reqBody { display: block; width: 100%; }
      .aca #aca-reqBody tr.req-searches { display: block; }
      .aca #aca-reqBody tr.req-searches > td { display: block; padding: 12px 16px 14px; border: none; }
      /* expanded roster matches + searches: stacked rows instead of 4- and 6-column tables (2026-10-13) */
      .aca #aca-reqBody table.rq-dt, .aca #aca-reqBody table.rq-dt tbody { display: block; width: 100%; }
      .aca #aca-reqBody table.rq-dt thead { display: none; }
      .aca #aca-reqBody table.rq-dt tr { display: block; padding: 10px 0; border-bottom: 1px solid var(--line2); }
      .aca #aca-reqBody table.rq-dt tr:last-child { border-bottom: none; }
      .aca #aca-reqBody table.rq-dt td { display: block; padding: 0; border: none; text-align: left !important; white-space: normal !important; overflow-wrap: anywhere; font-size: 14px; }
      .aca #aca-reqBody table.rq-dt td + td { margin-top: 3px; }
      .aca #aca-reqBody table.rq-dt td.mono { font-size: 12.5px; color: var(--muted); }
      .aca #aca-reqBody table.rq-dt td.rq-empty { display: none; }
      .aca #aca-reqBody tr.rq-row { border-bottom: none; padding-bottom: 4px; }
      .aca #aca-reqBody tr.req-searches > td { padding: 4px 16px 18px; border-bottom: 1px solid var(--border); }
      .aca .rq-pick { grid-template-columns: 22px minmax(0, 1fr) auto; }
      .aca .rq-pick .js-copy-code { grid-column: 2 / -1; justify-self: start; }
      .aca .rq-pick a.rq-code { font-size: 14px; min-height: 40px; display: inline-flex; align-items: center; }
      .aca .rq-reply textarea { min-height: 260px; }
      .aca .rq-reply-acts button { width: 100%; }
      .aca #aca-panel-makeups .toolbar input, .aca #aca-panel-makeups .toolbar button.small { min-height: 40px; }
    }`;
    const t = document.createElement("style"); t.textContent = css; document.head.appendChild(t);
  })();

  // ================= Help requests =================
  async function loadRequests() {
    clearError("reqError");
    const body = el("reqBody");
    const { data, error } = await supabase
      .from("lookup_requests")
      .select("id, gotphoto_job_id, parent_email, search_data, status, created_at, ip_key")
      .neq("status", "resolved")
      .order("created_at", { ascending: false });
    if (error) {
      showError("reqError", "Could not load help requests: " + error.message);
      body.innerHTML = '<tr><td colspan="5" class="empty">Unavailable.</td></tr>';
      return;
    }
    openRequests = data || [];
    renderRequests();
  }

  function jobName(id) {
    const j = allJobs.find((x) => x.gotphoto_job_id === id);
    return j ? j.name : null;
  }

  function renderRequests() {
    const body = el("reqBody");
    const badge = el("reqBadge");
    if (openRequests.length) { badge.textContent = openRequests.length; badge.classList.remove("hidden"); }
    else badge.classList.add("hidden");
    setAttention("requests", openRequests.length, openRequests.length === 1 ? "parent asked for help finding their code" : "parents asked for help finding their code", "requests", "warn");
    if (openRequests.length === 0) {
      body.innerHTML = '<tr><td colspan="5" class="empty">No pending help requests.</td></tr>';
      return;
    }
    body.innerHTML = openRequests.map((r) => {
      const name = r.gotphoto_job_id ? jobName(r.gotphoto_job_id) : null;
      const jobCell = r.gotphoto_job_id
        ? '<span class="lnk js-open-job" data-job="' + esc(r.gotphoto_job_id) + '">' + esc(name || r.gotphoto_job_id) + '</span>' +
          '<div class="req-who hidden" data-gplinks="' + esc(r.gotphoto_job_id) + '"></div>'
        : '<span class="muted">—</span>';
      // who asked: name/phone from the school form (search_data.searcher_*), plus the IP (2026-10-05)
      const sd = r.search_data || {};
      const who = [sd.searcher_name, sd.searcher_phone].filter(Boolean).map(esc).join(" &middot; ");
      return '<tr class="rq-row" data-id="' + esc(r.id) + '">' +
        '<td class="name">' + esc(r.parent_email) +
          (who ? '<div class="req-who">' + who + '</div>' : '') +
          (r.ip_key ? '<div class="req-who mono">IP ' + esc(r.ip_key) + '</div>' : '') +
          '<div class="req-who">' + (affirmed(sd) ? '<span class="pill ok">&#10003; Parent/guardian</span>' : '<span class="pill err">Not confirmed parent/guardian</span>') + '</div></td>' +
        '<td class="rq-job">' + jobCell + '</td>' +
        '<td class="rq-typed muted mono">' + blockedFlag(r) + esc(summarizeSearch(studentOnly(r.search_data)) || "—") + '</td>' +
        '<td class="rq-when"><span class="rq-pre">Waiting since </span>' + fmtDate(r.created_at) + '</td>' +
        '<td class="rq-act"><button class="small js-resolve" data-id="' + esc(r.id) + '">Mark handled</button> <span class="row-msg js-req-msg"></span></td>' +
        '</tr>' +
        // roster matches + reply + searches open on load (2026-10-13)
        '<tr class="req-searches" data-id="' + esc(r.id) + '"><td colspan="5"><div class="empty">Loading&#8230;</div></td></tr>';
    }).join("");
    openRequests.forEach((r) => loadReqDetails(r));
    fillJobLinks(body); // the job page and partner, when a booking has this GotPhoto job (2026-10-24)
  }

  // the parent/guardian checkbox on the lookup form, saved as search_data.affirm = "yes" (2026-10-23)
  function affirmed(sd) {
    const v = (sd || {}).affirm;
    return v === true || /^(yes|true|on|1)$/i.test(String(v == null ? "" : v).trim());
  }
  function affirmHtml(r) {
    return affirmed(r.search_data)
      ? '<div class="rq-affirm"><span class="pill ok">&#10003; Parent/guardian</span> They ticked the box saying they are the parent or guardian.</div>'
      : '<div class="rq-affirm"><span class="pill err">Not confirmed</span> They did not tick the parent/guardian box. Check who is asking before sending a code.</div>';
  }

  // the typed student fields only (the searcher's own details show under the email; affirm is just the checkbox)
  function studentOnly(sd) {
    const o = {};
    Object.keys(sd || {}).forEach((k) => { if (k !== "affirm" && k.indexOf("searcher_") !== 0) o[k] = sd[k]; });
    return o;
  }

  // ---- Reply drafts: kept per request so a re-render (blocks reload, another request resolved) doesn't lose typing
  const reqDrafts = {};   // id -> { pick, to, subject, body, dirty }
  const reqMatches = {};  // id -> roster matches from admin_request_matches
  function titleCase(t) { return String(t || "").toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase()); }
  function reqReplyText(r, m) {
    const sd = r.search_data || {};
    const hi = (sd.searcher_name || "").trim().split(/\s+/)[0];
    const org = ((jobName(r.gotphoto_job_id) || "").split("|")[0] || "").trim();
    const kid = m ? titleCase([m.first, m.last].filter(Boolean).join(" ")) : titleCase([sd.first_name, sd.last_name].filter(Boolean).join(" "));
    const kidFirst = kid.split(" ")[0] || "your child";
    const sign = "\n\nWarmly,\nJeremiah & The 207 Photo Team";
    if (m) {
      const code = String(m.code || "").toUpperCase();
      return {
        subject: "Your access code for " + kidFirst + "'s photos",
        body: "Hi " + (hi ? titleCase(hi) : "there") + ",\n\nThanks for reaching out! Here is the access code for " + kid +
          (m.group ? " (" + m.group + ")" : "") + (org ? " from " + org : "") + ":\n\n" + code + "\n\n" +
          (m.link ? "This link opens " + kidFirst + "'s gallery directly:\n" + m.link + "\n\nOr enter the code at https://pictureday.207photo.com"
                  : "Enter it at https://pictureday.207photo.com to see " + kidFirst + "'s photos.") +
          "\n\nIf anything else comes up, just reply to this email." + sign,
      };
    }
    return {
      subject: "Finding " + kidFirst + "'s photos",
      body: "Hi " + (hi ? titleCase(hi) : "there") + ",\n\nThanks for reaching out about " + (kid || "your child") + "'s photos" + (org ? " from " + org : "") + ". " +
        "I looked through the roster and couldn't find a match yet.\n\n" +
        "Could you reply with your child's full name as it was given to the team or school, and their team, grade, or teacher? I'll get you the code as soon as I find it." + sign,
    };
  }
  function reqApplyPick(r, pick, force) {
    const d = reqDrafts[r.id];
    if (d.dirty && !force && !confirm("Replace the message you edited with the one for this choice?")) return false;
    const m = pick >= 0 ? (reqMatches[r.id] || [])[pick] : null;
    const t = reqReplyText(r, m);
    Object.assign(d, { pick, subject: t.subject, body: t.body, dirty: false });
    return true;
  }

  async function loadReqDetails(r) {
    const tr = el("reqBody").querySelector('tr.req-searches[data-id="' + r.id + '"]');
    if (!tr) return;
    const cell = tr.firstElementChild;
    const [sr, mr] = await Promise.all([supabase.rpc("admin_request_searches", { p_id: r.id }), supabase.rpc("admin_request_matches", { p_id: r.id })]);
    if (!cell.isConnected) return;
    if (sr.error) { cell.innerHTML = '<div class="inline-error">' + esc(sr.error.message) + '</div>'; return; }
    const rows = sr.data || [], matches = (mr && !mr.error && mr.data) || [];
    reqMatches[r.id] = matches;
    const blocked = blocksForRequest(r).length > 0;
    if (!reqDrafts[r.id]) { reqDrafts[r.id] = { to: r.parent_email || "", pick: matches.length ? 0 : -1 }; reqApplyPick(r, reqDrafts[r.id].pick, true); }
    const d = reqDrafts[r.id];
    if (d.pick >= matches.length) reqApplyPick(r, -1, true);
    const nm = 'rqpick-' + r.id;
    // closest roster names with codes: only here, never in the alert email (a reply would quote them)
    const matchHtml = '<div class="req-sh">Closest names on the roster' + (blocked ? '' : ' <span class="muted" style="font-weight:400">&middot; pick the one to send</span>') + '</div>' +
      '<div class="rq-picks">' + matches.map((m, i) => {
        const code = String(m.code || "").toUpperCase();
        return '<label class="rq-pick">' + (blocked ? '' : '<input type="radio" name="' + nm + '" class="js-rq-pick" data-id="' + esc(r.id) + '" value="' + i + '"' + (d.pick === i ? ' checked' : '') + ' />') +
          '<span class="rq-pk-name"><b>' + esc([m.first, m.last].filter(Boolean).join(" ")) + '</b><span class="muted">' + esc([m.group, m.teacher].filter(Boolean).join(" · ")) + '</span></span>' +
          (m.link ? '<a class="mono rq-code" href="' + esc(m.link) + '" target="_blank" rel="noopener" title="Open this gallery in GotPhoto">' + esc(code) + ' &#8599;</a>' : '<span class="mono rq-code">' + esc(code) + '</span>') +
          '<button type="button" class="small js-copy-code" data-code="' + esc(code) + '">Copy code</button></label>';
      }).join("") +
      (matches.length ? '' : '<div class="muted" style="font-size:13px;margin-bottom:6px">' + (mr && mr.error ? esc(mr.error.message) : 'No one close on the roster (or the name is blocked).') + '</div>') +
      (blocked ? '' : '<label class="rq-pick rq-pick-none"><input type="radio" name="' + nm + '" class="js-rq-pick" data-id="' + esc(r.id) + '" value="-1"' + (d.pick === -1 ? ' checked' : '') + ' /><span class="rq-pk-name">No code &middot; ask for more details</span></label>') +
      '</div>';
    const replyHtml = blocked
      ? '<div class="inline-error" style="margin:12px 0">Blocked name: no reply from here. Verify who is asking through the school or league.</div>'
      : '<div class="rq-reply">' +
          '<div class="req-sh">Reply</div>' +
          '<label>To <input type="email" class="js-rq-f" data-f="to" data-id="' + esc(r.id) + '" value="' + esc(d.to) + '" /></label>' +
          '<label>Subject <input type="text" class="js-rq-f" data-f="subject" data-id="' + esc(r.id) + '" value="' + esc(d.subject) + '" maxlength="200" /></label>' +
          '<label>Message <textarea class="js-rq-f" data-f="body" data-id="' + esc(r.id) + '" rows="12">' + esc(d.body) + '</textarea></label>' +
          '<div class="rq-reply-acts"><button class="small primary js-rq-send" data-id="' + esc(r.id) + '">Send reply</button>' +
          '<span class="muted" style="font-size:12.5px">From info@207photo.com. Sending marks the request handled.</span> <span class="row-msg js-rq-sendmsg"></span></div>' +
        '</div>';
    const histHtml = rows.length ? '<div class="req-sh">Last 7 days from this email or IP: ' + rows.length + ' search' + (rows.length === 1 ? '' : 'es') + '</div>' +
      '<table class="sl-dtable rq-dt"><thead><tr><th>When</th><th>Job</th><th>What they typed</th><th>Searcher</th><th>IP</th><th>Result</th></tr></thead><tbody>' +
      rows.map((x) => '<tr><td class="muted" style="white-space:nowrap">' + fmtDate(x.at) + '</td><td>' + esc(x.job_name) + '</td>' +
        '<td class="mono">' + esc(summarizeSearch(x.search) || "—") + '</td>' +
        '<td' + (x.searcher ? '' : ' class="rq-empty"') + '>' + esc(x.searcher ? [x.searcher.name, x.searcher.email, x.searcher.phone].filter(Boolean).join(" · ") : "—") + '</td>' +
        '<td class="mono' + (x.ip ? '' : ' rq-empty') + '">' + esc(x.ip || "—") + '</td><td>' + outcomePill(x.outcome) + '</td></tr>').join("") + '</tbody></table>'
      : '<div class="muted" style="font-size:13px">No searches from this email or IP in the last 7 days.</div>';
    cell.innerHTML = affirmHtml(r) + '<div class="rq-detail"><div>' + matchHtml + '</div>' + replyHtml + '</div>' + '<div class="rq-hist">' + histHtml + '</div>';
  }

  function reqRemoveRows(id) {
    openRequests = openRequests.filter((r) => String(r.id) !== String(id));
    delete reqDrafts[id];
    el("reqBody").querySelectorAll('tr[data-id="' + id + '"]').forEach((t) => t.remove());
    if (!openRequests.length) { renderRequests(); } else {
      const badge = el("reqBadge"); badge.textContent = openRequests.length;
      setAttention("requests", openRequests.length, openRequests.length === 1 ? "parent asked for help finding their code" : "parents asked for help finding their code", "requests", "warn");
    }
    renderDrawer();
  }

  async function resolveRequest(id, btn) {
    if (btn) btn.disabled = true;
    const { error } = await supabase.from("lookup_requests")
      .update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", id);
    if (error) { if (btn) btn.disabled = false; toast("Could not resolve: " + error.message, true); return; }
    toast("Marked handled.");
    reqRemoveRows(id);
  }

  async function sendReqReply(id, btn) {
    const r = openRequests.find((x) => String(x.id) === id), d = reqDrafts[id];
    if (!r || !d) return;
    const msg = btn.parentElement.querySelector(".js-rq-sendmsg");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.to.trim())) { msg.className = "row-msg err js-rq-sendmsg"; msg.textContent = "Enter a valid email."; return; }
    const m = d.pick >= 0 ? (reqMatches[id] || [])[d.pick] : null;
    if (!confirm("Send this reply to " + d.to.trim() + (m ? " with code " + String(m.code || "").toUpperCase() : "") + "?")) return;
    btn.disabled = true; msg.className = "row-msg js-rq-sendmsg"; msg.textContent = "Sending…";
    const { data, error } = await supabase.rpc("lookup_request_reply", { p_id: id, p_to: d.to.trim(), p_subject: d.subject, p_body: d.body, p_code: m ? m.code : null });
    if (error || !data || data.ok !== true) {
      btn.disabled = false;
      const why = error ? error.message : (data && data.error) || "unknown";
      const words = { blocked: "this name is blocked", bad_email: "that email address looks wrong", empty: "subject and message are required", too_long: "the message is too long", just_sent: "a reply was just sent", no_resend_key: "the email service key is missing" };
      msg.className = "row-msg err js-rq-sendmsg"; msg.textContent = "Not sent: " + (words[why] || why);
      return;
    }
    toast("Reply sent to " + data.to + ". Marked handled.");
    reqRemoveRows(id);
  }

  el("reqBody").addEventListener("input", (e) => {
    const f = e.target.closest(".js-rq-f");
    if (!f || !reqDrafts[f.dataset.id]) return;
    reqDrafts[f.dataset.id][f.dataset.f] = f.value;
    if (f.dataset.f !== "to") reqDrafts[f.dataset.id].dirty = true;
  });
  el("reqBody").addEventListener("change", (e) => {
    const p = e.target.closest(".js-rq-pick");
    if (!p) return;
    const r = openRequests.find((x) => String(x.id) === p.dataset.id), d = r && reqDrafts[r.id];
    if (!d) return;
    if (!reqApplyPick(r, Number(p.value))) {  // cancelled: put the radio back
      const back = el("reqBody").querySelector('.js-rq-pick[data-id="' + r.id + '"][value="' + d.pick + '"]');
      if (back) back.checked = true;
      return;
    }
    const box = p.closest("td");
    box.querySelector('.js-rq-f[data-f="subject"]').value = d.subject;
    box.querySelector('.js-rq-f[data-f="body"]').value = d.body;
  });

  el("reqBody").addEventListener("click", async (e) => {
    const open = e.target.closest(".js-open-job");
    if (open) { showJobsFor({}, { select: open.dataset.job }); return; }
    const cp = e.target.closest(".js-copy-code");
    if (cp) { try { await navigator.clipboard.writeText(cp.dataset.code); cp.textContent = "Copied"; setTimeout(() => { cp.textContent = "Copy code"; }, 1500); } catch (er) { toast("Couldn't copy: " + cp.dataset.code, true); } return; }
    const snd = e.target.closest(".js-rq-send");
    if (snd) { await sendReqReply(snd.dataset.id, snd); return; }
    const btn = e.target.closest(".js-resolve");
    if (btn) await resolveRequest(btn.dataset.id, btn);
  });

  // ================= Makeups (makeup_bookings, migration 20260926T01) =================
  // Bookings arrive from the Coupon Ledger Apps Script (makeupCoupons.gs) a minute after a parent
  // books. After the makeup, confirm the team's job and send the "photos are ready" email. Every
  // read and write goes through admin-only RPCs, and makeup_send_ready re-checks the status on the
  // server, so this page cannot send before the makeup, without a job, or twice by accident.
  let mkList = [];
  let mkFilter = "todo";
  let mkJobs = [];
  const MK_STATUS = {
    ready: ["warn", "Ready to send"],
    needs_job: ["err", "Needs job"],
    waiting_photos: ["muted", "Waiting for photos"],
    upcoming: ["muted", "Upcoming"],
    sent: ["ok", "Sent"],
    dismissed: ["muted", "Handled"],
  };

  function mkWhen(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return Fmt.dayTime(d.toISOString());
  }
  function mkFirstName(name) {
    return String(name || "").replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, "").trim().split(/\s+/)[0] || "";
  }

  async function loadMakeups() {
    clearError("mkError");
    const [rows, jobs] = await Promise.all([supabase.rpc("admin_makeups"), supabase.rpc("admin_makeup_jobs")]);
    if (rows.error) {
      showError("mkError", "Could not load makeup bookings: " + rows.error.message);
      el("mkBody").innerHTML = '<tr><td colspan="7" class="empty">Unavailable.</td></tr>';
      return;
    }
    mkList = Array.isArray(rows.data) ? rows.data : [];
    mkJobs = !jobs.error && Array.isArray(jobs.data) ? jobs.data : [];
    renderMakeups();
  }

  function mkJobCell(m) {
    const locked = m.status === "sent" || m.status === "dismissed";
    const curName = m.confirmed_job_id ? (m.confirmed_name || m.confirmed_job_id) : (m.suggested_job_id ? (m.suggested_name || m.suggested_job_id) : "");
    let html = curName ? '<span class="mk-jobname">' + esc(curName) + '</span>' : "";
    if (m.confirmed_job_id) {
      html += '<span class="mk-sub">Confirmed' + (m.confirmed_live ? "" : " · gallery not live yet") +
        (locked ? "" : ' · <button class="link js-mk-pick">Change</button>') + '</span>';
    } else if (m.suggested_job_id) {
      html += '<span class="mk-sub"><span class="mk-sug">Suggested, not confirmed</span> ' +
        (locked ? "" : '<button class="small js-mk-confirm">Confirm</button> <button class="link js-mk-pick">Change</button>') + '</span>';
    } else {
      html += '<span class="mk-sub">No close match for “' + esc(m.team_text || "") + '”.</span>' +
        (locked ? "" : '<button class="small js-mk-pick">Pick a job…</button>');
    }
    return html + mkCodeLine(m);
  }

  // Searchable job picker (opens under the job cell). Empty search = best matches, then recent jobs.
  function mkPickerItems(m, q) {
    const seen = new Set();
    const cands = (Array.isArray(m.candidates) ? m.candidates : []).map((c) => ({ job_id: c.job_id, name: c.name, live: c.live, best: true }));
    const all = cands.concat(mkJobs).filter((j) => j.job_id && !seen.has(j.job_id) && seen.add(j.job_id));
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { items: all.slice(0, cands.length + 12), total: all.length };
    const hits = all.filter((j) => { const n = String(j.name).toLowerCase(); return words.every((w) => n.includes(w)); });
    return { items: hits.slice(0, 40), total: hits.length };
  }

  function mkRenderPicker(picker, m) {
    const q = picker.querySelector(".mk-pick-q").value;
    const { items, total } = mkPickerItems(m, q);
    let html = "";
    let lastBest = null;
    items.forEach((j, i) => {
      if (!q.trim() && j.best !== lastBest) {
        html += '<div class="mk-pick-h">' + (j.best ? "Best matches" : "Recent sports jobs") + '</div>';
        lastBest = !!j.best;
      }
      html += '<button class="mk-pick-item' + (i === 0 ? " first" : "") + '" data-job="' + esc(j.job_id) + '">' +
        esc(j.name) + (j.live ? "" : ' <span class="muted">(not live yet)</span>') + '</button>';
    });
    if (!items.length) html = '<div class="mk-pick-h">No job matches “' + esc(q) + '”.</div>';
    else if (total > items.length) html += '<div class="mk-pick-h">' + (total - items.length) + " more · keep typing to narrow it down</div>";
    if (m.confirmed_job_id) html += '<button class="mk-pick-item mk-pick-clear" data-job="">Clear the job</button>';
    picker.querySelector(".mk-pick-list").innerHTML = html;
  }

  function mkOpenPicker(cell, m) {
    el("mkBody").querySelectorAll(".mk-picker").forEach((p) => p.remove());
    const picker = document.createElement("div");
    picker.className = "mk-picker";
    picker.innerHTML = '<input type="text" class="mk-pick-q" placeholder="Search jobs… (Enter picks the top one, Esc closes)" aria-label="Search jobs" />' +
      '<div class="mk-pick-list"></div>';
    cell.appendChild(picker);
    mkRenderPicker(picker, m);
    picker.querySelector(".mk-pick-q").focus();
  }

  async function mkPick(row, jobId) {
    const picker = row.querySelector(".mk-picker");
    if (picker) picker.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    await mkSet(row.dataset.id, { p_job_id: jobId }, jobId ? "Job confirmed." : "Job cleared.");
  }

  // Which access code the ready email will use (makeup_code_for in Postgres).
  function mkCodeLine(m) {
    const c = m.code_choice;
    if (!c) return "";
    const who = String(m.athlete_name || "").split(/\s+/)[0] || "the athlete";
    if (c.kind === "player") return '<span class="mk-sub">Code <span class="mono">' + esc(String(c.code || "").toUpperCase()) + '</span> · ' + esc(who) + '’s own</span>';
    if (c.kind === "team") return '<span class="mk-sub">Code <span class="mono">' + esc(String(c.code || "").toUpperCase()) + '</span> · team code, shared</span>';
    return '<span class="mk-sub mk-nocode">No code for ' + esc(m.athlete_name || "this athlete") + ' yet · photo may not be uploaded</span>';
  }

  function mkStatusCell(m) {
    const st = MK_STATUS[m.status] || ["muted", m.status];
    let html = '<span class="pill ' + st[0] + '">' + esc(st[1]) + '</span>';
    if (m.status === "sent") {
      html += '<span class="mk-sub">' + fmtDate(m.sent_at) + (m.sent_to ? " to " + esc(m.sent_to) : "") + '</span>';
      if (m.send_status === "failed") html += '<span class="pill err">Delivery failed</span><span class="mk-sub">' + esc(m.send_error || "") + '</span>';
      else if (m.send_status === "pending") html += '<span class="mk-sub">Delivery check within 10 min</span>';
    } else if (m.status === "upcoming") {
      html += '<span class="mk-sub">Send unlocks after the makeup</span>';
    } else if (m.status === "waiting_photos") {
      html += '<span class="mk-sub">Checking GotPhoto every 20 min</span>';
    }
    if (m.status !== "sent" && m.photos_in_at) html += '<span class="mk-sub">Photos in GotPhoto ' + fmtDate(m.photos_in_at) + (m.photos_how === "name" ? " (found by name)" : " (new upload)") + '</span>';
    if (m.auto_confirmed) html += '<span class="mk-sub">Job confirmed by the photos check</span>';
    if (m.coupon_made_at) html += '<span class="mk-sub">Coupon made in GotPhoto</span>';
    return html;
  }

  function mkActions(m) {
    let a = "";
    if (m.status === "ready") a = '<button class="small primary js-mk-open">Send ready email</button>';
    else if (m.status === "sent") a = '<button class="small js-mk-open">Resend</button>';
    else if (m.status === "needs_job") a = '<button class="small" disabled title="Confirm the job first">Send ready email</button>';
    else if (m.status === "waiting_photos") a = '<button class="small js-mk-open" title="Photos not found yet in GotPhoto">Send anyway</button>';
    else if (m.status === "upcoming") a = '<button class="small" disabled title="Unlocks after the makeup">Send ready email</button>';
    a += m.status === "dismissed"
      ? ' <button class="link js-mk-undismiss">Undo</button>'
      : (m.status === "sent" ? "" : ' <button class="link js-mk-dismiss" title="No-show or cancelled: nothing to send">Mark handled</button>');
    return a;
  }

  function renderMakeups() {
    const todo = mkList.filter((m) => m.status === "ready" || m.status === "needs_job").length;
    const badge = el("mkBadge");
    if (todo) { badge.textContent = todo; badge.classList.remove("hidden"); } else badge.classList.add("hidden");
    setAttention("makeups", todo, todo === 1 ? "makeup to handle" : "makeups to handle", "makeups", "warn");
    el("mkCount").textContent = mkList.length ? mkList.length + " bookings · " + (todo ? todo + " to do" : "nothing to do") : "";
    const q = el("mkSearch").value.trim().toLowerCase();
    const rows = mkList.filter((m) => {
      if (mkFilter === "todo" && !(m.status === "ready" || m.status === "needs_job")) return false;
      if (mkFilter !== "todo" && mkFilter !== "all" && m.status !== mkFilter) return false;
      if (!q) return true;
      return [m.athlete_name, m.parent_name, m.parent_email, m.team_text].some((v) => String(v || "").toLowerCase().includes(q));
    });
    const body = el("mkBody");
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty">' +
        (mkList.length ? (mkFilter === "todo" ? "Nothing to do. Every past makeup has been emailed or marked handled." : "Nothing here for this filter.")
                       : "No makeup bookings yet. They appear here a minute after a parent books.") + '</td></tr>';
      return;
    }
    body.innerHTML = rows.map((m) =>
      '<tr class="mk-row' + (m.status === "dismissed" ? " dim" : "") + '" data-id="' + esc(m.id) + '">' +
        '<td class="name">' + esc(m.athlete_name || "—") + '<span class="mk-sub">' + esc(m.team_text || "") + '</span></td>' +
        '<td>' + esc(m.parent_name || "") + '<span class="mk-sub">' + esc(m.parent_email) + '</span></td>' +
        '<td class="tnum">' + mkWhen(m.makeup_at) + '</td>' +
        '<td class="mono">' + (m.coupon_code ? esc(m.coupon_code) : '<span class="pill warn">none</span>') + '</td>' +
        '<td class="mk-jobcell">' + mkJobCell(m) + '</td>' +
        '<td>' + mkStatusCell(m) + '</td>' +
        '<td>' + mkActions(m) + ' <span class="row-msg js-mk-msg"></span></td>' +
      '</tr>').join("");
  }

  async function mkSet(id, args, okMsg) {
    const { data, error } = await supabase.rpc("admin_makeup_set", Object.assign({ p_id: id }, args));
    if (error || !data || data.ok !== true) {
      toast("Could not save: " + (error ? error.message : (data && data.error) || "unknown"), true);
      return false;
    }
    if (okMsg) toast(okMsg);
    await loadMakeups();
    return true;
  }

  function mkClosePanel() {
    const open = el("mkBody").querySelector("tr.mk-panel-row");
    if (open) open.remove();
  }

  async function mkPreview(panel) {
    const info = panel.querySelector(".mk-linkinfo");
    const subj = panel.querySelector(".mk-subject");
    const frame = panel.querySelector(".mk-frame");
    const send = panel.querySelector(".js-mk-send");
    send.disabled = true;
    info.textContent = "Building preview…";
    const { data, error } = await supabase.rpc("makeup_ready_email", {
      p_id: panel.dataset.id,
      p_email: panel.querySelector(".mk-to").value.trim(),
      p_first: panel.querySelector(".mk-first").value.trim(),
      p_coupon: panel.querySelector(".mk-coupon").value.trim(),
    });
    if (error || !data || data.ok !== true) {
      info.innerHTML = '<span class="pill err">Can’t build the email</span> ' + esc(error ? error.message : (data && data.error) || "unknown");
      subj.textContent = "";
      frame.srcdoc = "";
      return;
    }
    const where = esc(data.org || "the team");
    info.innerHTML = (data.code_kind === "player"
        ? '<span class="pill ok">Player code</span> <span class="mono">' + esc(String(data.code || "").toUpperCase()) + '</span> is ' + esc(data.athlete) + "’s own code. The button goes straight to their gallery."
        : data.code_kind === "team"
        ? '<span class="pill accent">Team code</span> <span class="mono">' + esc(String(data.code || "").toUpperCase()) + '</span> is shared by all of ' + where + ". The button opens " + where + " on Find My Photos, and the email includes the code."
        : '<span class="pill warn">No code yet</span> No code for “' + esc(data.athlete) + "” on " + where + " yet. The photo may not be uploaded or synced. The email asks the parent to search by name on Find My Photos.") +
      (data.coupon ? "" : ' <span class="pill err">No coupon</span> The coupon paragraph will be left out.') +
      (/^https:\/\//.test(data.link || "") ? ' <a href="' + esc(data.link) + '" target="_blank" rel="noopener">test the link</a>' : '');
    subj.innerHTML = '<span class="muted">To</span> ' + esc(data.to) + ' &nbsp; <span class="muted">Subject</span> ' + esc(data.subject);
    frame.srcdoc = data.html;
    send.disabled = false;
  }

  function mkOpenPanel(row, m) {
    const wasOpen = row.nextElementSibling && row.nextElementSibling.classList.contains("mk-panel-row");
    mkClosePanel();
    if (wasOpen) return;
    const tr = document.createElement("tr");
    tr.className = "mk-panel-row";
    tr.dataset.id = m.id;
    tr.innerHTML = '<td colspan="7" class="mk-panel"><div class="fc-editor">' +
      '<div class="fc-head">' + (m.status === "sent" ? "Resend" : "Send") + ' the “photos are ready” email for <b>' + esc(m.athlete_name || "") + '</b>' +
        (m.status === "sent" ? ' <span class="muted">(already sent ' + fmtDate(m.sent_at) + ')</span>' : "") + '</div>' +
      '<div class="fc-extra">' +
        '<label>To <input type="email" class="mk-to" value="' + esc(m.parent_email) + '" /></label>' +
        '<label>First name <input type="text" class="mk-first" value="' + esc(mkFirstName(m.parent_name)) + '" size="12" /></label>' +
        '<label>Coupon <input type="text" class="mk-coupon mono" value="' + esc(m.coupon_code || "") + '" size="9" /></label>' +
        '<button class="small js-mk-refresh">Update preview</button>' +
      '</div>' +
      '<div class="mk-linkinfo"></div>' +
      '<div class="mk-subject" style="font-size:13px"></div>' +
      '<iframe class="mk-frame" title="Email preview" sandbox=""></iframe>' +
      '<div class="fc-actions">' +
        '<button class="small primary js-mk-send" disabled>' + (m.status === "sent" ? "Send again" : "Send email") + '</button>' +
        '<button class="small js-mk-close">Close</button>' +
        '<span class="row-msg js-mk-panelmsg"></span>' +
      '</div></div></td>';
    row.after(tr);
    mkPreview(tr);
  }

  async function mkSend(panel) {
    const m = mkList.find((x) => x.id === panel.dataset.id);
    if (!m) return;
    const msg = panel.querySelector(".js-mk-panelmsg");
    const to = panel.querySelector(".mk-to").value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { msg.className = "row-msg err js-mk-panelmsg"; msg.textContent = "Enter a valid email."; return; }
    const force = m.status === "sent";
    if (force && !confirm("This was already sent " + fmtDate(m.sent_at) + " to " + (m.sent_to || m.parent_email) + ". Send it again to " + to + "?")) return;
    panel.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    msg.className = "row-msg js-mk-panelmsg";
    msg.textContent = "Sending…";
    const { data, error } = await supabase.rpc("makeup_send_ready", {
      p_id: m.id, p_email: to,
      p_first: panel.querySelector(".mk-first").value.trim(),
      p_coupon: panel.querySelector(".mk-coupon").value.trim(),
      p_force: force,
    });
    if (error || !data || data.ok !== true) {
      panel.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      const why = error ? error.message : (data && data.error) || "unknown";
      const words = { upcoming: "the makeup hasn't happened yet", needs_job: "confirm the job first", already_sent: "it was already sent", dismissed: "this booking is marked handled", bad_email: "that email address looks wrong", no_resend_key: "the email service key is missing" };
      msg.className = "row-msg err js-mk-panelmsg";
      msg.textContent = "Not sent: " + (words[why] || why);
      toast("Email not sent.", true);
      return;
    }
    toast("Email sent to " + data.to + ".");
    mkClosePanel();
    await loadMakeups();
  }

  el("mkChips").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-f]");
    if (!btn) return;
    mkFilter = btn.dataset.f;
    el("mkChips").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
    renderMakeups();
  });
  el("mkSearch").addEventListener("input", renderMakeups);
  el("mkRefresh").addEventListener("click", () => {
    el("mkBody").innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
    loadMakeups();
  });

  el("mkBody").addEventListener("input", (e) => {
    const q = e.target.closest(".mk-pick-q");
    if (!q) return;
    const row = q.closest("tr.mk-row");
    const m = mkList.find((x) => x.id === row.dataset.id);
    if (m) mkRenderPicker(q.closest(".mk-picker"), m);
  });
  el("mkBody").addEventListener("keydown", (e) => {
    const q = e.target.closest(".mk-pick-q");
    if (!q) return;
    if (e.key === "Escape") { q.closest(".mk-picker").remove(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const first = q.closest(".mk-picker").querySelector(".mk-pick-item:not(.mk-pick-clear)");
      if (first) mkPick(q.closest("tr.mk-row"), first.dataset.job);
    }
  });

  el("mkBody").addEventListener("click", async (e) => {
    const panel = e.target.closest("tr.mk-panel-row");
    if (panel) {
      if (e.target.closest(".js-mk-close")) mkClosePanel();
      else if (e.target.closest(".js-mk-refresh")) mkPreview(panel);
      else if (e.target.closest(".js-mk-send")) mkSend(panel);
      return;
    }
    const row = e.target.closest("tr.mk-row");
    if (!row) return;
    const m = mkList.find((x) => x.id === row.dataset.id);
    if (!m) return;
    if (e.target.closest(".js-mk-open")) { mkOpenPanel(row, m); return; }
    const item = e.target.closest(".mk-pick-item");
    if (item) { await mkPick(row, item.dataset.job); return; }
    if (e.target.closest(".js-mk-pick")) {
      const open = row.querySelector(".mk-picker");
      if (open) open.remove(); else mkOpenPicker(row.querySelector(".mk-jobcell"), m);
      return;
    }
    if (e.target.closest(".js-mk-confirm")) {
      e.target.disabled = true;
      await mkSet(m.id, { p_job_id: m.suggested_job_id }, "Job confirmed.");
      return;
    }
    if (e.target.closest(".js-mk-dismiss")) { await mkSet(m.id, { p_dismiss: true }, "Marked handled. Find it under Handled to undo."); return; }
    if (e.target.closest(".js-mk-undismiss")) { await mkSet(m.id, { p_dismiss: false }, "Back on the list."); return; }
  });


  // ================= Retakes (retake_requests, migration 20261016T03) =================
  // Parents request a school retake on Find My Photos; Names List flags the student when it opens the job.
  // Today: "retakesNew" (asked in the last 24 h) and "retakeDayTomorrow" (requests for a school whose retake day is tomorrow).
  let rtList = [];
  const nyDay = (offset) => new Date(Date.now() + (offset || 0) * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const rtDay = (d) => (d ? Fmt.day(d) : "no retake day");

  async function loadRetakes() {
    clearError("rtError");
    const { data, error } = await supabase.rpc("admin_retakes", { p_days_back: 60 });
    if (error) {
      showError("rtError", "Could not load retake requests: " + error.message);
      el("rtBody").innerHTML = '<tr><td colspan="6" class="empty">Unavailable.</td></tr>';
      return;
    }
    rtList = Array.isArray(data) ? data : [];
    renderRetakes();
  }

  function renderRetakes() {
    const dayAgo = Date.now() - 864e5;
    const fresh = rtList.filter((r) => new Date(r.created_at).getTime() > dayAgo).length;
    setAttention("retakesNew", fresh, "new retake requests", "retakes", "soon");
    const tomorrow = nyDay(1), bySchool = {};
    rtList.filter((r) => r.retake_day === tomorrow).forEach((r) => {
      const s = bySchool[r.school] || (bySchool[r.school] = { n: 0, np: 0 });
      s.n++; if (!r.pulled_at) s.np++;
    });
    const schools = Object.keys(bySchool);
    const tmrN = schools.reduce((n, k) => n + bySchool[k].n, 0);
    setAttention("retakeDayTomorrow", tmrN, schools.map((k) => "Retake day at " + k + " is tomorrow: " + bySchool[k].n +
      (bySchool[k].n === 1 ? " request" : " requests") + (bySchool[k].np ? ", " + bySchool[k].np + " not yet in Names List" : "")).join("; ") + ".", "retakes", "warn");

    el("rtCount").textContent = rtList.length ? rtList.length + (rtList.length === 1 ? " request" : " requests") : "";
    const q = el("rtSearch").value.trim().toLowerCase();
    const rows = rtList.filter((r) => !q || [r.child, r.school, r.group, r.parent_name, r.parent_email].some((v) => String(v || "").toLowerCase().includes(q)));
    if (!rows.length) {
      el("rtBody").innerHTML = '<tr><td colspan="6" class="empty">' + (rtList.length ? "Nothing matches." : "No retake requests yet. They appear here the moment a parent sends one.") + "</td></tr>";
      return;
    }
    let last = null, html = "";
    rows.forEach((r) => {
      const grp = r.school + "|" + (r.retake_day || "");
      if (grp !== last) {
        last = grp;
        const past = r.retake_day && r.retake_day < nyDay(0);
        html += '<tr class="rt-grp"><td colspan="6">' + esc(r.school) + ' <span class="muted">· retake day ' + esc(rtDay(r.retake_day)) + (past ? " (passed)" : "") + "</span></td></tr>";
      }
      const notes = (Array.isArray(r.notes) ? r.notes : []).map((n) => '<span class="rt-sub">“' + esc(n.text) + "”</span>").join("");
      html += '<tr data-id="' + esc(r.id) + '">' +
        '<td class="name">' + esc(r.child || "—") + '<span class="rt-sub">' + esc(r.group || "") + ' · <span class="mono">' + esc(String(r.access_code || "").toUpperCase()) + "</span></span></td>" +
        "<td>" + esc((r.reasons || []).join(", ") || "—") + notes + "</td>" +
        "<td>" + esc(r.parent_name || "") + '<span class="rt-sub">' + esc(r.parent_email || "") + "</span></td>" +
        '<td class="tnum">' + fmtDate(r.updated_at || r.created_at) + "</td>" +
        "<td>" + (r.pulled_at ? '<span class="dot ok"></span>In Names List<span class="rt-sub">' + fmtDate(r.pulled_at) + (r.pulled_by ? ", " + esc(r.pulled_by) : "") + "</span>"
                              : '<span class="dot warn"></span>Not yet in Names List') + "</td>" +
        '<td>' + (r.pulled_at ? "" : '<button class="link js-rt-done" title="Flagged by hand in Names List">Mark handled</button> ') + '<button class="link js-rt-del">Delete</button></td></tr>';
    });
    el("rtBody").innerHTML = html;
  }

  el("rtSearch").addEventListener("input", renderRetakes);
  el("rtRefresh").addEventListener("click", () => { el("rtBody").innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>'; loadRetakes(); });
  el("rtBody").addEventListener("click", async (e) => {
    const h = e.target.closest(".js-rt-done");
    if (h) {
      const hr = rtList.find((x) => x.id === h.closest("tr").dataset.id); if (!hr) return;
      if (!confirm("Mark the request for " + (hr.child || "this student") + " as handled? Do this after flagging them by hand in Names List.")) return;
      h.disabled = true;
      const { error } = await supabase.rpc("admin_retake_mark_handled", { p_id: hr.id });
      if (error) { h.disabled = false; toast("Could not save: " + error.message, true); return; }
      toast("Marked handled.");
      await loadRetakes();
      return;
    }
    const b = e.target.closest(".js-rt-del"); if (!b) return;
    const row = b.closest("tr"), r = rtList.find((x) => x.id === row.dataset.id); if (!r) return;
    if (!confirm("Delete the retake request for " + (r.child || "this student") + "? If Names List already flagged them, clear the flag there too.")) return;
    b.disabled = true;
    const { error } = await supabase.rpc("admin_retake_delete", { p_id: r.id });
    if (error) { b.disabled = false; toast("Could not delete: " + error.message, true); return; }
    toast("Deleted.");
    await loadRetakes();
  });
