  // ================================================================ OUTREACH: Partner portal (2026-10-23)
  // One link per league or school (#portal/<token>; the page is portal-public.js). Staff make the link, put up
  // proofs and composites for approval, share files and see what the organization sent, and email the link.
  // RPCs (supabase/migrations/20261023114700_partner_portal.sql): portal_list, portal_orgs, portal_get, portal_save,
  // portal_proof_save, portal_proof_withdraw, portal_file_add, portal_file_remove, portal_files_seen, portal_attention,
  // portal_compose, portal_queue, portal_job. Files go to the private `portal` bucket under the portal's file_key.
  // Emails go through the outreach pipeline (Outbox, Outreach to review), and only to organizations with a booked job.
  registerPage({ id: "portal", label: "Partner portal", group: "Outreach", section: "partners", module: "portal",
                 tabs: [["portal", "Partner portal"]], onShow: () => Portal.show() });
  registerAttention("portalChanges", { module: "portal", level: "warn", name: "proof changes",
    one: "A league or school asked for changes to a proof.", many: "{n} proofs have changes asked for." });
  registerAttention("portalFiles", { module: "portal", level: "soon", name: "files from partners",
    one: "A league or school sent a file through their portal.", many: "{n} files came in through partner portals." });
  registerTodayLoader("portal", () => Portal.loadAttention());

  const Portal = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .pt-table td { vertical-align: top; }
    .aca .pt-table td .muted { font-size: 12.5px; }
    .aca tr.pt-click { cursor: pointer; } .aca tr.pt-click:hover td { background: var(--surface-2); }
    .aca .pt-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 4px 0 2px; }
    .aca .pt-head h2 { margin: 0; font-size: 19px; font-weight: 600; }
    .aca .pt-link { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0 4px; }
    .aca .pt-link code { font-size: 12.5px; padding: 6px 8px; background: var(--surface-2); border-radius: 4px; overflow-wrap: anywhere; }
    .aca .pt-sec { margin: 26px 0 8px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .aca .pt-sec h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--head); }
    .aca .pt-help { font-size: 13px; color: var(--muted); margin: 0 0 10px; max-width: 80ch; }
    .aca .pt-proof { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; padding: 10px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; }
    .aca .pt-proof .muted { font-size: 12.5px; }
    .aca .pt-proof .acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; }
    .aca .pt-proof .said { grid-column: 1 / -1; color: var(--accent); white-space: pre-wrap; }
    .aca .pt-files { list-style: none; margin: 0; padding: 0; }
    .aca .pt-files li { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; }
    .aca .pt-files li.new { font-weight: 600; }
    .aca .pt-set { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; margin: 8px 0; font-size: 13.5px; }
    .aca .pt-set label { display: flex; gap: 6px; align-items: center; }
    .aca .modal .field input[type=text], .aca .modal .field select, .aca .modal textarea { width: 100%; }
    .aca .modal textarea.pt-body { min-height: 220px; resize: vertical; }
    .aca .modal textarea.pt-short { min-height: 64px; resize: vertical; }
    .aca .pt-orgpick { max-height: 280px; overflow: auto; border-top: 1px solid var(--line2); }
    .aca .pt-orgpick button { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--line2); border-radius: 0; background: transparent; padding: 8px 4px; height: auto; font-weight: 400; }
    .aca .pt-orgpick button:hover { background: var(--surface-2); }
    .aca .pt-warn { padding: 8px 12px; border-radius: 4px; background: var(--surface-2); font-size: 13px; margin: 0 0 12px; }
    @media (max-width: 700px) { .aca .pt-table .hide-sm { display: none; } .aca .pt-proof { grid-template-columns: 1fr; } .aca .pt-proof .acts { justify-content: flex-start; } }`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    const root = () => el("panel-portal");
    const openId = () => { const m = /^#partners\/portal\/([0-9a-f-]{36})/.exec(location.hash); return m ? m[1] : null; };
    const link = (tok) => "https://admin.207photo.com/#portal/" + tok;
    const day = (d) => (d ? new Date(String(d).length > 10 ? d : d + "T12:00:00").toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "");
    const pill = (cls, text) => '<span class="pill ' + cls + '">' + esc(text) + "</span>";
    const size = (n) => (!n ? "" : n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
    const safeName = (n) => n.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
    let D = null;

    function show() { const id = openId(); if (id) open(id); else list(); }

    // ---------------------------------------------------------------- the list
    async function list() {
      D = null;
      const ed = canEdit("portal");
      root().innerHTML = '<div class="card"><div class="card-head"><div><h2>Partner portal</h2>' +
        "<p>One page for each league or school: their picture days and team times, the roster form, deliverable downloads, proofs to approve, their agreement, files both ways and their sales statement. No sign-in: the link is the key.</p></div>" +
        (ed ? '<button type="button" class="primary" id="aca-ptNew">New portal</button>' : "") + "</div>" +
        '<div id="aca-ptErr" class="inline-error hidden"></div><div class="table-wrap"><table class="pt-table"><thead><tr><th>Organization</th><th>Opened</th><th>Proofs</th><th class="hide-sm">Files from them</th><th class="hide-sm">Next picture day</th></tr></thead>' +
        '<tbody id="aca-ptBody"><tr><td colspan="5" class="empty">Loading&#8230;</td></tr></tbody></table></div></div>';
      if (ed) el("ptNew").addEventListener("click", newPortal);
      el("ptBody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-org]"); if (tr) go(tr.dataset.org); });
      const { data, error } = await sb.rpc("portal_list");
      if (!el("ptBody")) return;
      if (error) { showError("ptErr", cleanErr(error)); return; }
      const rows = data || [];
      el("ptBody").innerHTML = rows.length ? rows.map((r) => '<tr class="pt-click" data-org="' + esc(r.org_id) + '">' +
        "<td><b>" + esc(r.org) + "</b>" + (r.active ? "" : " " + pill("muted", "Off")) + (r.town ? '<br><span class="muted">' + esc(r.town) + "</span>" : "") + "</td>" +
        "<td>" + (r.viewed_at ? esc(fmtAgo(r.viewed_at)) + '<br><span class="muted">' + num(r.view_count) + (num(r.view_count) === 1 ? " visit" : " visits") + "</span>" : '<span class="muted">Not yet</span>') + "</td>" +
        "<td>" + ([r.changes ? pill("warn", num(r.changes) + " to change") : "", r.waiting ? pill("accent", num(r.waiting) + " waiting") : "", r.approved ? pill("ok", num(r.approved) + " approved") : ""].filter(Boolean).join(" ") || '<span class="muted">&#8212;</span>') + "</td>" +
        '<td class="hide-sm">' + (r.new_files ? pill("warn", num(r.new_files) + " new") : '<span class="muted">&#8212;</span>') + "</td>" +
        '<td class="hide-sm">' + (r.next_day ? esc(day(r.next_day)) : '<span class="muted">&#8212;</span>') + "</td></tr>").join("")
        : '<tr><td colspan="5" class="empty">No portals yet.' + (ed ? " Start one with New portal." : "") + "</td></tr>";
    }
    function go(org) { history.replaceState(null, "", "#partners/portal/" + org); open(org); }
    function back() { history.replaceState(null, "", "#partners/portal"); list(); }

    function newPortal() {
      const m = openModal('<h2>New portal</h2><div class="field"><label for="aca-ptQ">Organization</label><input type="text" id="aca-ptQ" placeholder="Type a name or town&#8230;" autocomplete="off" /></div>' +
        '<div class="pt-orgpick" id="aca-ptPick"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-ptNCancel">Cancel</button></div>');
      let timer = null, seq = 0;
      const search = async () => {
        const my = ++seq;
        const { data, error } = await sb.rpc("portal_orgs", { p_q: el("ptQ").value.trim() });
        if (my !== seq) return;
        if (error) { el("ptPick").innerHTML = '<p class="inline-error">' + esc(cleanErr(error)) + "</p>"; return; }
        el("ptPick").innerHTML = (data || []).map((o) => '<button type="button" data-org="' + esc(o.id) + '"><b>' + esc(o.name) + "</b>" + (o.town ? ' <span class="muted">' + esc(o.town) + "</span>" : "") +
          (o.has ? " " + pill("muted", "Has a portal") : "") + "</button>").join("") || '<p class="muted">No matches.</p>';
      };
      el("ptQ").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 200); });
      el("ptNCancel").addEventListener("click", () => m.close());
      el("ptPick").addEventListener("click", (e) => { const b = e.target.closest("button[data-org]"); if (b) { m.close(); go(b.dataset.org); } });
      search();
    }

    // ---------------------------------------------------------------- one organization
    async function open(org) {
      const r = root();
      if (!D || D.org_id !== org) r.innerHTML = '<div class="card"><div class="empty"><span class="spin"></span>Loading&#8230;</div></div>';
      const { data, error } = await sb.rpc("portal_get", { p_org: org });
      if (error) { r.innerHTML = '<div class="card"><button type="button" class="link" id="aca-ptBack">&#8592; All portals</button><div class="inline-error">' + esc(cleanErr(error)) + "</div></div>"; el("ptBack").addEventListener("click", back); return; }
      D = data;
      render();
    }

    function render() {
      const d = D, p = d.portal, ed = canEdit("portal");
      let h = '<div class="card"><button type="button" class="link" id="aca-ptBack">&#8592; All portals</button>' +
        '<div class="pt-head"><h2>' + esc(d.org) + "</h2>" + (p && !p.active ? pill("muted", "Turned off") : "") + "</div>";
      if (!p) { root().innerHTML = h + '<p class="muted">No portal yet. Someone who can edit the Partner portal can make one.</p></div>'; wireBack(); return; }
      h += '<p class="muted" style="margin:2px 0 0;font-size:13.5px">' + (p.viewed_at ? "Opened " + esc(fmtAgo(p.viewed_at)) + ", " + num(p.view_count) + (num(p.view_count) === 1 ? " visit" : " visits") : "Not opened yet") +
        (p.email ? " &#183; Link email: " + emailState(p.email) : "") + "</p>" +
        '<div class="pt-link"><code>' + esc(link(p.token)) + '</code><button type="button" class="small" id="aca-ptCopy">Copy link</button><button type="button" class="small" id="aca-ptView">Open their page</button>' +
        (ed ? '<button type="button" class="small' + (d.can_email ? "" : " hidden") + '" id="aca-ptEmail">Email the link</button>' : "") + "</div>" +
        (ed && !d.can_email ? '<p class="pt-help">No booked job, so no emails go out from here (track-only jobs never send). Copy the link if they should have it.</p>' : "") +
        (ed ? '<div class="pt-set"><label><input type="checkbox" id="aca-ptOn"' + (p.active ? " checked" : "") + " /> Link works</label>" +
          '<label><input type="checkbox" id="aca-ptSales"' + (p.show_sales ? " checked" : "") + " /> Show sales and payouts</label>" +
          '<button type="button" class="link" id="aca-ptWelcome">' + (p.welcome ? "Edit the welcome note" : "Add a welcome note") + "</button>" +
          '<button type="button" class="link" id="aca-ptNewLink">Make a new link</button></div>' : "");

      // proofs
      h += '<div class="pt-sec"><h3>Proofs to approve</h3>' + (ed ? '<button type="button" class="small" id="aca-ptAddProof">Add a proof</button>' : "") + "</div>" +
        '<p class="pt-help">Composites, banners, a team photo to check. They open it on their page and approve it or ask for changes. A new file on the same proof starts the next round.</p>' +
        (d.proofs.length ? d.proofs.map(proofRow).join("") : '<p class="muted">None yet.</p>');

      // files
      const out = d.files.filter((f) => f.direction === "out"), inn = d.files.filter((f) => f.direction === "in");
      const li = (f) => '<li class="' + (f.direction === "in" && !f.seen_at ? "new" : "") + '"><span><button type="button" class="link" data-open="' + esc(f.path) + '" data-name="' + esc(f.name) + '">' + esc(f.name) + "</button>" +
        (f.note ? '<br><span class="muted">' + esc(f.note) + "</span>" : "") + '</span><span class="muted">' + esc([f.from_name, size(f.size), day(f.created_at)].filter(Boolean).join(" · ")) +
        (ed ? ' <button type="button" class="link" data-rmfile="' + esc(f.id) + '">Remove</button>' : "") + "</span></li>";
      h += '<div class="pt-sec"><h3>Files from them</h3>' + (inn.some((f) => !f.seen_at) ? '<button type="button" class="small" id="aca-ptSeen">Mark all seen</button>' : "") + "</div>" +
        (inn.length ? '<ul class="pt-files">' + inn.map(li).join("") + "</ul>" : '<p class="muted">Nothing yet. They can send a roster, logo or list from their page.</p>') +
        '<div class="pt-sec"><h3>Shared with them</h3>' + (ed ? '<input type="file" id="aca-ptFile" class="hidden" /><button type="button" class="small" id="aca-ptShare">Share a file</button>' : "") + "</div>" +
        (out.length ? '<ul class="pt-files">' + out.map(li).join("") + "</ul>" : '<p class="muted">Nothing shared. Finished deliverables with a link already show on their page.</p>');
      root().innerHTML = h + "</div>";
      wire();
    }
    function emailState(e) {
      const s = e.status;
      return s === "review" ? pill("warn", "Waiting for your review") : s === "held" ? pill("muted", "Held") : s === "scheduled" || s === "sending" ? pill("accent", "Scheduled " + day(e.at))
        : s === "sent" ? pill("ok", "Sent " + day(e.at)) : s === "failed" ? pill("err", "Failed") : pill("muted", "Not sent");
    }
    function proofRow(x) {
      const ed = canEdit("portal");
      const st = x.status === "approved" ? pill("ok", "Approved " + day(x.decided_at)) : x.status === "changes" ? pill("warn", "Changes asked " + day(x.decided_at))
        : x.status === "withdrawn" ? pill("muted", "Taken down") : pill("accent", "Waiting for them");
      return '<div class="pt-proof" data-proof="' + esc(x.id) + '"><div><b>' + esc(x.label) + "</b> " + st + (x.round > 1 ? ' <span class="muted">round ' + num(x.round) + "</span>" : "") +
        '<br><span class="muted">' + esc([x.job, x.file_name || (x.link ? "Link" : ""), x.email ? "email " + (x.email.status === "review" ? "waiting for review" : x.email.status) : ""].filter(Boolean).join(" · ")) + "</span></div>" +
        '<div class="acts">' + (x.file_path ? '<button type="button" class="small" data-open="' + esc(x.file_path) + '">Open</button>' : '<button type="button" class="small" data-link="' + esc(x.link) + '">Open</button>') +
        (ed && x.status !== "withdrawn" ? '<button type="button" class="small" data-edit>' + (x.status === "changes" ? "Upload new version" : "Edit") + "</button>" : "") +
        (ed && x.status === "withdrawn" ? '<button type="button" class="small" data-edit>Put back up</button>' : "") +
        (ed && x.status === "waiting" && D.can_email ? '<button type="button" class="small" data-mail>Email them</button>' : "") +
        (ed && x.status !== "withdrawn" ? '<button type="button" class="small quiet" data-down>Take down</button>' : "") + "</div>" +
        (x.decided_name ? '<div class="said">' + esc(x.decided_name) + (x.decided_note ? ": &#8220;" + esc(x.decided_note) + "&#8221;" : "") + "</div>" : "") + "</div>";
    }
    function wireBack() { el("ptBack").addEventListener("click", back); }
    function wire() {
      wireBack();
      const p = D.portal, org = D.org_id;
      el("ptCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(link(p.token)); toast("Link copied."); } catch (_e) { prompt("Copy this link:", link(p.token)); } });
      el("ptView").addEventListener("click", () => window.open(link(p.token), "_blank", "noopener"));
      root().onclick = onClick;
      if (!canEdit("portal")) return;
      if (el("ptEmail")) el("ptEmail").addEventListener("click", () => compose("invite", org));
      el("ptOn").addEventListener("change", () => save({ active: el("ptOn").checked }, el("ptOn").checked ? "The link works again." : "Turned off. The link and its files stop working."));
      el("ptSales").addEventListener("change", () => save({ show_sales: el("ptSales").checked }, el("ptSales").checked ? "Sales and payouts show on their page." : "Sales and payouts are hidden."));
      el("ptNewLink").addEventListener("click", () => { if (confirm("Make a new link? The old one stops working, so anyone who had it needs the new one.")) save({ new_link: true }, "New link made. Send it to them again."); });
      el("ptWelcome").addEventListener("click", () => {
        const m = openModal('<h2>Welcome note</h2><p class="pt-help">Shows at the top of their page. A line about picture day, who to call, or what is new.</p>' +
          '<div class="field"><textarea id="aca-ptWel" class="pt-short" maxlength="2000">' + esc(p.welcome) + "</textarea></div>" +
          '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-ptWelC">Cancel</button><button type="button" class="primary" id="aca-ptWelS">Save</button></div>');
        el("ptWelC").addEventListener("click", () => m.close());
        el("ptWelS").addEventListener("click", async () => { await save({ welcome: el("ptWel").value }, "Saved."); m.close(); });
      });
      el("ptAddProof").addEventListener("click", () => proofModal(null));
      el("ptShare").addEventListener("click", () => el("ptFile").click());
      el("ptFile").addEventListener("change", () => { const f = el("ptFile").files[0]; if (f) shareFile(f); });
    }
    async function onClick(e) {
      const lk = e.target.closest("[data-link]");
      if (lk) { window.open(lk.dataset.link, "_blank", "noopener"); return; }
      const op = e.target.closest("[data-open]");
      if (op) {
        const w = window.open("", "_blank");
        const { data, error } = await sb.storage.from("portal").createSignedUrl(op.dataset.open, 300, op.dataset.name ? { download: op.dataset.name } : undefined);
        if (error || !data) { if (w) w.close(); return toast(cleanErr(error || "Could not open the file."), true); }
        if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
        const f = D.files.find((x) => x.path === op.dataset.open);
        if (f && f.direction === "in" && !f.seen_at) { await sb.rpc("portal_files_seen", { p_org: D.org_id, p_ids: [f.id] }); f.seen_at = new Date().toISOString(); loadAttention(); }
        return;
      }
      if (e.target.closest("#aca-ptSeen")) { await sb.rpc("portal_files_seen", { p_org: D.org_id, p_ids: null }); loadAttention(); return open(D.org_id); }
      const rm = e.target.closest("[data-rmfile]");
      if (rm) {
        if (!confirm("Remove this file from their page?")) return;
        const { error } = await sb.rpc("portal_file_remove", { p_id: rm.dataset.rmfile });
        if (error) return toast(cleanErr(error), true);
        return open(D.org_id);
      }
      const row = e.target.closest("[data-proof]");
      if (!row) return;
      const x = D.proofs.find((y) => y.id === row.dataset.proof);
      if (e.target.closest("[data-edit]")) return proofModal(x);
      if (e.target.closest("[data-mail]")) return compose("proof", x.id);
      if (e.target.closest("[data-down]")) {
        if (!confirm("Take " + x.label + " down from their page?")) return;
        const { error } = await sb.rpc("portal_proof_withdraw", { p_id: x.id });
        if (error) return toast(cleanErr(error), true);
        open(D.org_id);
      }
    }
    async function save(p, msg) {
      const { error } = await sb.rpc("portal_save", { p_org: D.org_id, p });
      if (error) { toast(cleanErr(error), true); return open(D.org_id); }
      toast(msg);
      open(D.org_id);
    }

    async function upload(kind, file) {
      if (file.size > 25 * 1024 * 1024) throw new Error("That file is over 25 MB. Share a Dropbox link instead.");
      const path = D.portal.file_key + "/" + kind + "/" + Date.now() + "-" + safeName(file.name);
      const { error } = await sb.storage.from("portal").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (error) throw error;
      return path;
    }
    async function shareFile(f) {
      const note = prompt("A note for them about " + f.name + "? (optional)", "");
      if (note === null) { el("ptFile").value = ""; return; }
      try {
        const path = await upload("out", f);
        const { error } = await sb.rpc("portal_file_add", { p_org: D.org_id, p_path: path, p_name: f.name, p_size: f.size, p_note: note, p_booking: null });
        if (error) throw error;
        toast("Shared. It's on their page now.");
        open(D.org_id);
      } catch (e) { toast(cleanErr(e), true); }
    }

    // Add or change a proof: a file (uploaded here) or a link, and which job it belongs to.
    function proofModal(x, bookingId, onDone) {
      const d = D, bk = x ? x.booking_id : bookingId || "";
      const m = openModal("<h2>" + (x ? esc(x.label) : "Add a proof") + "</h2>" +
        (x && x.status === "changes" ? '<div class="pt-warn"><b>' + esc(x.decided_name) + " asked:</b> " + esc(x.decided_note) + "</div>" : "") +
        '<div class="field"><label for="aca-ptPrLabel">What it is</label><input type="text" id="aca-ptPrLabel" maxlength="120" placeholder="Team composite" value="' + esc(x ? x.label : "") + '" /></div>' +
        '<div class="field"><label for="aca-ptPrBk">Job <span class="muted">(optional)</span></label><select id="aca-ptPrBk"><option value="">None</option>' +
          (d.bookings || []).map((b) => '<option value="' + esc(b.id) + '"' + (b.id === bk ? " selected" : "") + ">" + esc(b.title + " " + day(b.picture_day)) + (b.status !== "booked" ? " (" + esc(b.status) + ")" : "") + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="aca-ptPrFile">' + (x && x.file_path ? "New file <span class=\"muted\">(" + esc(x.file_name || "") + " now)</span>" : "File") + '</label><input type="file" id="aca-ptPrFile" accept="application/pdf,image/*" style="height:auto" /></div>' +
        '<div class="field"><label for="aca-ptPrLink">Or a link <span class="muted">(Dropbox, Google Drive)</span></label><input type="text" id="aca-ptPrLink" placeholder="https://" value="' + esc(x && x.link ? x.link : "") + '" /></div>' +
        '<div class="field"><label for="aca-ptPrNote">Note for them <span class="muted">(optional)</span></label><textarea id="aca-ptPrNote" class="pt-short" maxlength="2000" placeholder="Check spelling of every name.">' + esc(x ? x.note : "") + "</textarea></div>" +
        (x && x.status !== "waiting" && x.status !== "withdrawn" ? '<p class="pt-help">A new file or link starts round ' + (num(x.round) + 1) + " and asks them again.</p>" : "") +
        '<div class="inline-error hidden" id="aca-ptPrErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-ptPrC">Cancel</button><button type="button" class="primary" id="aca-ptPrS">Save</button></div>');
      const err = (t) => { const n = el("ptPrErr"); n.textContent = t; n.classList.remove("hidden"); };
      el("ptPrC").addEventListener("click", () => m.close());
      el("ptPrS").addEventListener("click", async () => {
        const btn = el("ptPrS"); btn.disabled = true; btn.textContent = "Saving…";
        try {
          const f = el("ptPrFile").files[0];
          const p = { org_id: d.org_id, label: el("ptPrLabel").value, booking_id: el("ptPrBk").value, note: el("ptPrNote").value, link: el("ptPrLink").value.trim() };
          if (f) { p.file_path = await upload("proofs", f); p.file_name = f.name; }
          const { error } = await sb.rpc("portal_proof_save", { p_id: x ? x.id : null, p });
          if (error) throw error;
          m.close();
          toast("Saved. It's on their page.");
          if (onDone) onDone(); else open(d.org_id);
        } catch (e) { err(cleanErr(e)); btn.disabled = false; btn.textContent = "Save"; }
      });
    }

    // ---------------------------------------------------------------- email (held for review or approved)
    async function compose(kind, ref) {
      const { data: c0, error } = await sb.rpc("portal_compose", { p_kind: kind, p_ref: ref, p_contact: null });
      if (error) return toast(cleanErr(error), true);
      let c = c0 || {}, edited = false;
      const m = openModal("<h2>" + (kind === "invite" ? "Email the link" : "Ask for their OK") + ": " + esc(c.org || "") + "</h2>" +
        '<div class="pt-warn' + (c.warning ? "" : " hidden") + '">' + esc(c.warning || "") + "</div>" +
        ((c.contacts || []).length
          ? '<div class="field"><label for="aca-ptCmTo">To</label><select id="aca-ptCmTo">' + c.contacts.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === c.contact_id ? " selected" : "") + ">" +
              esc(x.name) + (x.name !== x.email ? " &lt;" + esc(x.email) + "&gt;" : "") + (x.role ? " (" + esc(x.role) + ")" : "") + "</option>").join("") + "</select></div>"
          : '<p class="inline-error">Nobody to email. Add a contact on the organization first.</p>') +
        '<div class="field"><label for="aca-ptCmSubj">Subject</label><input type="text" id="aca-ptCmSubj" maxlength="200" /></div>' +
        '<div class="field"><label for="aca-ptCmBody">Message</label><textarea id="aca-ptCmBody" class="pt-body"></textarea></div>' +
        '<p class="pt-help">Your outreach signature is added when it sends. It goes out through the Outbox like every outreach email.</p>' +
        '<div class="inline-error hidden" id="aca-ptCmErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-ptCmCancel">Cancel</button>' +
        '<button type="button" id="aca-ptCmHold">Hold for review</button><button type="button" class="primary" id="aca-ptCmGo">Approve and schedule</button></div>');
      const fill = () => { el("ptCmSubj").value = c.subject || ""; el("ptCmBody").value = c.body || ""; edited = false; };
      fill();
      ["ptCmSubj", "ptCmBody"].forEach((id) => el(id).addEventListener("input", () => { edited = true; }));
      if (el("ptCmTo")) el("ptCmTo").addEventListener("change", async () => {
        if (edited) return;
        const { data } = await sb.rpc("portal_compose", { p_kind: kind, p_ref: ref, p_contact: el("ptCmTo").value });
        if (data) { c = data; fill(); }
      });
      const err = (t) => { const n = el("ptCmErr"); n.textContent = t; n.classList.remove("hidden"); };
      el("ptCmCancel").addEventListener("click", () => m.close());
      const send = async (approve) => {
        if (!el("ptCmTo")) return err("Nobody to email.");
        const btns = [el("ptCmHold"), el("ptCmGo")]; btns.forEach((b) => { b.disabled = true; });
        const { error: e2 } = await sb.rpc("portal_queue", { p_kind: kind, p_ref: ref, p_contact: el("ptCmTo").value,
          p_subject: el("ptCmSubj").value, p_body: el("ptCmBody").value, p_approve: approve });
        btns.forEach((b) => { b.disabled = false; });
        if (e2) return err(cleanErr(e2));
        m.close();
        toast(approve ? "Approved. It goes out in the next sending window." : "Saved. It's waiting in Outreach to review.");
        if (D) open(D.org_id);
      };
      el("ptCmHold").addEventListener("click", () => send(false));
      el("ptCmGo").addEventListener("click", () => send(true));
    }

    async function loadAttention() {
      try {
        const { data, error } = await sb.rpc("portal_attention");
        if (error) throw error;
        setAttention("portalChanges", num(data && data.changes), "Proofs to change", "portal");
        setAttention("portalFiles", num(data && data.files), "Files from partners", "portal");
      } catch (_e) { /* Today reports it as unchecked */ }
    }

    // ---------------------------------------------------------------- the job page's tab
    async function renderJobTab(booking, box) {
      const id = booking && (booking.id || booking.booking_id);
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const { data, error } = await sb.rpc("portal_job", { p_booking: id });
      if (error) { box.innerHTML = '<div class="inline-error">' + esc(cleanErr(error)) + "</div>"; return; }
      const ed = canEdit("portal");
      const proofs = data.proofs || [];
      box.innerHTML = '<p class="pt-help">' + esc(data.org || "This organization") + (data.token ? (data.active ? "&#8217;s portal: " + (data.viewed_at ? "opened " + esc(fmtAgo(data.viewed_at)) : "not opened yet") : "&#8217;s portal is turned off") : " has no portal yet") + ".</p>" +
        '<div class="pt-link">' + (data.token ? '<button type="button" class="small" data-j="copy">Copy their link</button>' : "") +
        '<button type="button" class="small" data-j="open">' + (data.token ? "Open in Partner portal" : "Make one in Partner portal") + "</button>" +
        (ed && data.token ? '<button type="button" class="small" data-j="proof">Add a proof for this job</button>' : "") + "</div>" +
        '<div class="pt-sec"><h3>Proofs for this job</h3></div>' +
        (proofs.length ? proofs.map((x) => '<div class="pt-proof"><div><b>' + esc(x.label) + "</b> " +
          (x.status === "approved" ? pill("ok", "Approved " + day(x.decided_at)) : x.status === "changes" ? pill("warn", "Changes asked") : pill("accent", "Waiting for them")) +
          (x.decided_note ? '<br><span class="muted">' + esc(x.decided_name) + ": " + esc(x.decided_note) + "</span>" : "") + "</div></div>").join("") : '<p class="muted">None.</p>');
      box.onclick = async (e) => {
        const b = e.target.closest("[data-j]");
        if (!b) return;
        if (b.dataset.j === "copy") { try { await navigator.clipboard.writeText(link(data.token)); toast("Link copied."); } catch (_e) { prompt("Copy this link:", link(data.token)); } }
        if (b.dataset.j === "open") { location.hash = "#partners/portal/" + data.org_id; }
        if (b.dataset.j === "proof") {
          const r = await sb.rpc("portal_get", { p_org: data.org_id });
          if (r.error) return toast(cleanErr(r.error), true);
          D = r.data;
          proofModal(null, id, () => renderJobTab(booking, box));
        }
      };
    }

    return { show, loadAttention, renderJobTab };
  })();

  // The job page (jobpage.js, when it is in the build) gets a Partner portal tab. Registered after load so the
  // order of files in build.py doesn't matter.
  (function () {
    let done = false;
    const add = () => {
      if (done) return;
      try {
        if (typeof registerJobTab !== "function") return;
        registerJobTab({ id: "portal", label: "Partner portal", module: "portal", order: 70, render: (booking, box) => Portal.renderJobTab(booking, box) });
        done = true;
      } catch (_e) { /* not ready yet */ }
    };
    add();
    if (!done) setTimeout(add, 0);
  })();
