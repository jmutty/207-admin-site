  // ================================================================ PARTNER PORTAL: the public page (2026-10-23)
  // https://admin.207photo.com/#portal/<token>: one page per league or school, no sign-in. Shown instead of sign-in
  // (registerPublicPage in shell-top.js). Their picture days with team times, the picture day form (#plan/) and
  // deliverable downloads, proofs to approve, their agreement (#agree/), files both ways, and their sales statement.
  // RPCs (supabase/migrations/20261023114700_partner_portal.sql): portal_public, portal_public_proof, portal_public_upload.
  // Files: private bucket `portal`, read with short signed URLs; uploads go to <file_key>/in/.
  const PortalPublic = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const token = () => ((location.hash.match(/^#portal\/([0-9a-f]{32,64})\b/) || [])[1] || "");
    const wanted = () => !!token();
    const css = `
    .aca .ptl { max-width: 760px; margin: 0 auto; padding: 28px 16px 64px; font-size: 15px; line-height: 22px; }
    .aca .ptl-top { display: flex; gap: 12px; align-items: center; margin-bottom: 18px; }
    .aca .ptl-top img { width: 44px; height: 44px; border-radius: 10px; border: 1px solid var(--border); }
    .aca .ptl-top b { display: block; font-size: 13px; color: var(--muted); font-weight: 600; }
    .aca .ptl h1 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 700; }
    .aca .ptl h2 { margin: 30px 0 10px; font-size: 17px; font-weight: 700; color: var(--head); }
    .aca .ptl .welcome { white-space: pre-wrap; margin: 0 0 14px; }
    .aca .ptl-todo { margin: 0 0 8px; padding: 14px 16px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-fg); }
    .aca .ptl-todo b { display: block; margin-bottom: 6px; }
    .aca .ptl-todo ul { margin: 0; padding-left: 18px; } .aca .ptl-todo li { margin: 3px 0; }
    .aca .ptl-todo a { color: inherit; font-weight: 600; }
    .aca .ptl-card { margin: 0 0 12px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .aca .ptl-card h3 { margin: 0; font-size: 16px; font-weight: 700; }
    .aca .ptl-card .meta { margin: 2px 0 0; color: var(--muted); font-size: 14px; }
    .aca .ptl-card.past { background: var(--surface-2); }
    .aca .ptl-sub { margin: 12px 0 4px; font-size: 12px; font-weight: 600; color: var(--faint); text-transform: uppercase; letter-spacing: .04em; }
    .aca .ptl table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .aca .ptl td, .aca .ptl th { padding: 6px 8px 6px 0; border-bottom: 1px solid var(--line2); text-align: left; vertical-align: top; }
    .aca .ptl th { font-size: 12px; color: var(--faint); font-weight: 600; }
    .aca .ptl td.r, .aca .ptl th.r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .aca .ptl-acts { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 0; }
    .aca .ptl a.btn { display: inline-flex; align-items: center; height: 38px; padding: 0 14px; border-radius: 4px; border: 1px solid var(--border); background: var(--surface); color: var(--text); text-decoration: none; font-weight: 600; font-size: 14px; }
    .aca .ptl a.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .aca .ptl .ok { margin: 10px 0 0; padding: 10px 12px; border-radius: 4px; background: var(--ok-bg); color: var(--ok-fg); }
    .aca .ptl .note { margin: 10px 0 0; padding: 10px 12px; border-radius: 4px; background: var(--surface-2); font-size: 14px; white-space: pre-wrap; }
    .aca .ptl .err { margin: 10px 0 0; padding: 10px 12px; border-radius: 4px; background: var(--err-bg); color: var(--err-fg); font-size: 14px; }
    .aca .ptl .field { margin: 10px 0 0; } .aca .ptl .field input, .aca .ptl .field textarea { width: 100%; font-size: 16px; }
    .aca .ptl .field input { height: 40px; } .aca .ptl textarea { min-height: 72px; padding: 8px 10px; }
    .aca .ptl-proof { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 14px; }
    .aca .ptl-thumb { width: 120px; height: 90px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--line2); display: flex; align-items: center; justify-content: center; overflow: hidden; color: var(--muted); font-size: 12px; cursor: pointer; padding: 0; }
    .aca .ptl-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .aca .ptl-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 0 0 12px; }
    .aca .ptl-tile { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .aca .ptl-tile span { display: block; font-size: 12.5px; color: var(--muted); } .aca .ptl-tile b { font-size: 20px; font-variant-numeric: tabular-nums; }
    .aca .ptl-files li { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--line2); }
    .aca .ptl-files { list-style: none; margin: 0; padding: 0; } .aca .ptl-files .muted { font-size: 13px; }
    .aca .ptl .muted { color: var(--muted); }
    .aca .ptl .hint { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; }
    @media (max-width: 640px) {
      .aca .ptl-tiles { grid-template-columns: 1fr 1fr; }
      .aca .ptl-proof { grid-template-columns: 1fr; } .aca .ptl-thumb { width: 100%; height: 180px; }
      .aca .ptl .hide-sm { display: none; }
    }`;
    const LOGO = "https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/icons/apple-touch-icon.png";
    const TZ = "America/New_York";
    const $ = (id) => document.getElementById("ptl-" + id);
    const longDay = (d) => (d ? new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "");
    const shortDay = (d) => (d ? new Date(String(d).length > 10 ? d : d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: String(d).length > 10 ? TZ : "UTC", month: "short", day: "numeric" }) : "");
    const time = (ts) => new Date(ts).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
    const money = (v) => "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const size = (n) => (!n ? "" : n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
    const isImg = (name) => /\.(jpe?g|png|gif|webp)$/i.test(name || "");
    let box = null, D = null;

    function show() {
      const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
      ["welcomeView", "loginView", "dashView"].forEach((v) => { const n = el(v); if (n) n.classList.add("hidden"); });
      box = document.createElement("div"); box.className = "ptl"; box.id = "aca-portalPublic";
      document.querySelector(".aca").appendChild(box);
      document.title = "Your 207 Photo page";
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      // The picture day form and the agreement are their own public pages: open them (and come back) with a fresh load.
      window.addEventListener("hashchange", () => location.reload());
      load();
    }
    async function load(msg) {
      const { data, error } = await sb.rpc("portal_public", { p_token: token() });
      if (error || !data || !data.found) {
        box.innerHTML = top("This link doesn&#8217;t work") + "<p>It may have been replaced by a newer one. Reply to any email from 207 Photo and we&#8217;ll send you a fresh link.</p>";
        return;
      }
      D = data;
      document.title = (D.org || "Your") + " | 207 Photo";
      render(msg);
    }
    const top = (title) => '<div class="ptl-top"><img src="' + LOGO + '" alt="" /><div><b>207 Photo &#183; Your partner page</b><h1>' + title + "</h1></div></div>";
    async function signed(path, name) {
      const { data, error } = await sb.storage.from("portal").createSignedUrl(path, 3600, name ? { download: name } : undefined);
      if (error || !data) throw new Error("That file isn’t available right now. Please reply to our email.");
      return data.signedUrl;
    }

    function render(msg) {
      const d = D, waiting = d.proofs.filter((p) => p.status === "waiting");
      const todo = [];
      if (waiting.length) todo.push('<a href="#ptl-proofs" data-jump="proofs">' + (waiting.length === 1 ? esc(waiting[0].label) + " is" : waiting.length + " proofs are") + " waiting for your OK</a>");
      if (d.agreement && d.agreement.status === "sent") todo.push('<a href="#agree/' + esc(d.agreement.token) + '">Read and accept the ' + esc(d.agreement.title) + "</a>");
      d.jobs.filter((j) => j.plan && j.plan.token && !j.plan.submitted_at).forEach((j) =>
        todo.push('<a href="#plan/' + esc(j.plan.token) + '">Tell us about your teams for ' + esc(shortDay(j.picture_day)) + "</a>"));
      let h = top(esc(d.org)) + (msg || "") + (d.welcome ? '<p class="welcome">' + esc(d.welcome) + "</p>" : "") +
        (todo.length ? '<div class="ptl-todo"><b>Waiting on you</b><ul>' + todo.map((t) => "<li>" + t + "</li>").join("") + "</ul></div>" : "");

      h += "<h2>Picture days</h2>" + (d.jobs.length ? d.jobs.map(jobCard).join("") : '<p class="muted">Nothing on the calendar yet.</p>');
      if (d.proofs.length) h += '<h2 id="ptl-proofs">Proofs to approve</h2>' + d.proofs.map(proofCard).join("");
      if (d.agreement) {
        const a = d.agreement;
        h += '<h2>Agreement</h2><div class="ptl-card"><h3>' + esc(a.title) + "</h3>" +
          '<p class="meta">' + (a.status === "accepted" ? "Accepted by " + esc(a.accepted_name) + " on " + esc(longDay(a.accepted_at)) : "Waiting for you to read and accept it") +
          (a.renewal_date ? " &#183; runs until " + esc(longDay(a.renewal_date)) : "") + "</p>" +
          '<div class="ptl-acts"><a class="btn' + (a.status === "sent" ? " primary" : "") + '" href="#agree/' + esc(a.token) + '">' + (a.status === "sent" ? "Read and accept" : "View or print") + "</a></div></div>";
      }
      h += filesHtml();
      if (d.sales) h += salesHtml(d.sales);
      h += '<p class="muted" style="margin-top:32px;font-size:13px">Questions? Reply to any email from us. Anyone with this link can see this page, so share it only with people who help run picture day.</p>';
      box.innerHTML = h;
      wire();
    }

    function jobCard(j) {
      const when = longDay(j.picture_day) + (j.start_at ? ", " + time(j.start_at) + (j.end_at ? " to " + time(j.end_at) : "") : "");
      let h = '<div class="ptl-card' + (j.upcoming ? "" : " past") + '"><h3>' + esc(j.title) + "</h3>" +
        '<p class="meta">' + esc(when) + (j.location ? " &#183; " + esc(j.location) : "") +
        (j.stage ? ' &#183; <span class="pill ' + (j.upcoming ? "accent" : "ok") + '">' + esc(j.stage) + "</span>" : "") + "</p>";
      if (j.retake_day) h += '<p class="meta">Retake day: ' + esc(longDay(j.retake_day)) + "</p>";
      if (j.teams.length) {
        h += '<div class="ptl-sub">Team times</div><table><tbody>' + j.teams.map((t) => '<tr><td style="width:80px"><b>' + esc(time(t.slot_at)) + "</b></td><td>" + esc(t.name) +
          '</td><td class="hide-sm">' + esc(t.field) + '</td><td class="r muted">' + (t.status === "confirmed" ? "Coach confirmed" : t.status === "move" ? "Coach asked to move" : "Sent to coach") + "</td></tr>").join("") + "</tbody></table>";
      }
      if (j.deliverables.length) {
        h += '<div class="ptl-sub">What you get</div><table><tbody>' + j.deliverables.map((x) => "<tr><td>" + esc(x.label) + '</td><td class="r">' +
          (x.status === "done" ? (x.link ? '<a href="' + esc(x.link) + '" target="_blank" rel="noopener">Download</a>' : '<span class="muted">Sent ' + esc(shortDay(x.done_at)) + "</span>")
            : '<span class="muted">' + (x.due_date ? "Coming by " + esc(shortDay(x.due_date)) : "In progress") + "</span>") + "</td></tr>").join("") + "</tbody></table>";
      }
      if (j.plan && j.plan.token) {
        h += '<div class="ptl-acts"><a class="btn' + (j.plan.submitted_at ? "" : " primary") + '" href="#plan/' + esc(j.plan.token) + '">' +
          (j.plan.submitted_at ? "Change teams, coaches or roster" : "Tell us about your teams") + "</a></div>" +
          (j.plan.roster_name ? '<span class="hint">Roster on file: ' + esc(j.plan.roster_name) + "</span>" : "");
      }
      return h + "</div>";
    }

    function proofCard(p) {
      const file = p.file_path ? '<button type="button" class="ptl-thumb" data-open="' + esc(p.file_path) + '" aria-label="Open ' + esc(p.label) + '">' +
          (isImg(p.file_name) ? '<img data-thumb="' + esc(p.file_path) + '" alt="" />' : esc((p.file_name || "file").split(".").pop().toUpperCase())) + "</button>"
        : '<a class="ptl-thumb" href="' + esc(p.link) + '" target="_blank" rel="noopener">Open link</a>';
      let h = '<div class="ptl-card" data-proof="' + esc(p.id) + '"><div class="ptl-proof">' + file + "<div><h3>" + esc(p.label) + "</h3>" +
        '<p class="meta">' + (p.job ? esc(p.job) + " &#183; " : "") + (p.round > 1 ? "Version " + p.round : "Posted " + esc(shortDay(p.created_at))) + "</p>" +
        (p.note ? '<p class="note">' + esc(p.note) + "</p>" : "");
      if (p.status === "approved") h += '<div class="ok"><b>Approved</b> by ' + esc(p.decided_name) + ", " + esc(shortDay(p.decided_at)) + ". Thank you!</div>";
      else if (p.status === "changes") h += '<div class="note">You asked for changes on ' + esc(shortDay(p.decided_at)) + ": &#8220;" + esc(p.decided_note) + "&#8221; We&#8217;ll post a new version here.</div>";
      else h += '<div class="ptl-acts">' + (p.file_path ? '<a class="btn" href="#" data-open="' + esc(p.file_path) + '">Open full size</a>' : '<a class="btn" href="' + esc(p.link) + '" target="_blank" rel="noopener">Open</a>') +
          '<a class="btn primary" href="#" data-ans="approve">Approve</a><a class="btn" href="#" data-ans="changes">Ask for changes</a></div><div data-form></div>';
      return h + "</div></div></div>";
    }

    function filesHtml() {
      const out = D.files.filter((f) => f.direction === "out"), inn = D.files.filter((f) => f.direction === "in");
      const li = (f, dl) => '<li><span>' + (dl ? '<a href="#" data-dl="' + esc(f.path) + '" data-name="' + esc(f.name) + '">' + esc(f.name) + "</a>" : esc(f.name)) +
        (f.note ? '<br><span class="muted">' + esc(f.note) + "</span>" : "") + '</span><span class="muted">' + esc([f.from_name, size(f.size), shortDay(f.created_at)].filter(Boolean).join(" · ")) + "</span></li>";
      return "<h2>Files</h2>" +
        (out.length ? '<div class="ptl-sub">From 207 Photo</div><ul class="ptl-files">' + out.map((f) => li(f, true)).join("") + "</ul>" : "") +
        '<div class="ptl-sub">Send us a file</div><p class="muted" style="margin:0;font-size:14px">A roster, a logo, a list of names to fix: anything up to 25 MB.</p>' +
        '<div class="field"><input type="file" id="ptl-file" style="height:auto" /></div>' +
        '<div class="field"><label for="ptl-from">Your name</label><input type="text" id="ptl-from" maxlength="120" autocomplete="name" /></div>' +
        '<div class="field"><label for="ptl-fnote">Anything we should know? <span class="muted">(optional)</span></label><input type="text" id="ptl-fnote" maxlength="1000" /></div>' +
        '<div id="ptl-ferr" class="err hidden" role="alert"></div><div class="ptl-acts"><a class="btn primary" href="#" id="ptl-send">Send file</a></div>' +
        (inn.length ? '<div class="ptl-sub" style="margin-top:16px">You sent</div><ul class="ptl-files">' + inn.map((f) => li(f, false)).join("") + "</ul>" : "");
    }

    function salesHtml(s) {
      const season = (j) => (j.season ? j.season.charAt(0).toUpperCase() + j.season.slice(1) + " " + j.season_year : "");
      return "<h2>Sales and payouts</h2>" +
        '<div class="ptl-tiles"><div class="ptl-tile"><span>Sales</span><b>' + money(s.sales) + '</b></div><div class="ptl-tile"><span>Your share</span><b>' + money(s.due) + "</b></div>" +
        '<div class="ptl-tile"><span>Paid to you</span><b>' + money(s.paid) + '</b></div><div class="ptl-tile"><span>Still owed</span><b>' + money(s.balance) + "</b></div></div>" +
        '<table><thead><tr><th>Job</th><th class="r hide-sm">Orders</th><th class="r">Sales</th><th class="r">Your share</th><th class="r">Paid</th></tr></thead><tbody>' +
        s.jobs.map((j) => "<tr><td>" + esc(j.name) + '<br><span class="muted">' + esc(season(j)) + "</span></td>" +
          '<td class="r hide-sm">' + (j.orders == null ? "" : esc(j.orders)) + '</td><td class="r">' + (j.sales == null ? '<span class="muted">Not in yet</span>' : money(j.sales)) + "</td>" +
          '<td class="r">' + money(j.due) + (j.fixed ? "" : j.pct ? '<br><span class="muted">' + esc(Number(j.pct)) + "%</span>" : "") + '</td><td class="r">' + money(j.paid) + "</td></tr>").join("") + "</tbody></table>" +
        (s.payments.length ? '<div class="ptl-sub" style="margin-top:16px">Payments</div><table><tbody>' + s.payments.map((p) => "<tr><td>" + esc(shortDay(p.paid_on)) + "</td><td>" + esc(p.job) +
          '</td><td class="hide-sm muted">' + esc(p.method) + '</td><td class="r">' + money(p.amount) + "</td></tr>").join("") + "</tbody></table>" : "") +
        '<p class="muted" style="font-size:13px">Sales are before tax and update through the season as families order.</p>';
    }

    function wire() {
      // thumbnails
      box.querySelectorAll("img[data-thumb]").forEach(async (img) => { try { img.src = await signed(img.dataset.thumb); } catch (_e) { /* the button still opens it */ } });
      box.addEventListener("click", onClick);
      const send = $("send");
      if (send) send.addEventListener("click", (e) => { e.preventDefault(); upload(); });
    }
    async function onClick(e) {
      const jump = e.target.closest("[data-jump]");
      if (jump) { e.preventDefault(); const n = $(jump.dataset.jump); if (n) n.scrollIntoView({ behavior: "smooth" }); return; }
      const op = e.target.closest("[data-open],[data-dl]");
      if (op) {
        e.preventDefault();
        const w = window.open("", "_blank");
        try { const u = await signed(op.dataset.open || op.dataset.dl, op.dataset.dl ? op.dataset.name : null); if (w) w.location = u; else location.href = u; }
        catch (err) { if (w) w.close(); alert(cleanErr(err)); }
        return;
      }
      const ans = e.target.closest("[data-ans]");
      if (ans) { e.preventDefault(); answerForm(ans.closest("[data-proof]"), ans.dataset.ans); return; }
      const go = e.target.closest("[data-go]");
      if (go) { e.preventDefault(); answer(go.closest("[data-proof]"), go.dataset.go); }
    }
    function answerForm(card, kind) {
      const f = card.querySelector("[data-form]");
      f.innerHTML = '<div class="field"><label>Your name</label><input type="text" data-k="name" maxlength="120" autocomplete="name" /></div>' +
        '<div class="field"><label>' + (kind === "approve" ? 'Anything to add? <span class="muted">(optional)</span>' : "What should we change?") + '</label><textarea data-k="note" maxlength="2000"></textarea></div>' +
        '<div class="err hidden" role="alert" data-err></div><div class="ptl-acts"><a class="btn primary" href="#" data-go="' + kind + '">' + (kind === "approve" ? "Approve it" : "Send changes") + "</a></div>";
      f.querySelector("input").focus();
    }
    async function answer(card, kind) {
      const name = card.querySelector("[data-k=name]").value.trim(), note = card.querySelector("[data-k=note]").value.trim(), err = card.querySelector("[data-err]");
      const fail = (t) => { err.textContent = t; err.classList.remove("hidden"); };
      if (name.length < 2) return fail("Type your name.");
      if (kind === "changes" && !note) return fail("Tell us what to change.");
      const { error } = await sb.rpc("portal_public_proof", { p_token: token(), p_proof: card.dataset.proof, p_answer: kind, p_name: name, p_note: note });
      if (error) return fail(cleanErr(error));
      await load('<div class="ok">' + (kind === "approve" ? "<b>Thank you!</b> We have your OK." : "<b>Got it.</b> We&#8217;ll post a new version here and email you.") + "</div>");
      const c = box.querySelector('[data-proof="' + card.dataset.proof + '"]'); if (c) c.scrollIntoView({ block: "center" });
    }
    async function upload() {
      const f = $("file").files[0], err = $("ferr"), btn = $("send");
      const fail = (t) => { err.textContent = t; err.classList.remove("hidden"); };
      err.classList.add("hidden");
      if (!f) return fail("Pick a file first.");
      if (f.size > 25 * 1024 * 1024) return fail("That file is over 25 MB. Email it to us instead, or share a Dropbox or Google Drive link.");
      if (!$("from").value.trim()) return fail("Type your name so we know who sent it.");
      btn.textContent = "Sending…"; btn.style.pointerEvents = "none";
      try {
        const path = D.file_key + "/in/" + Date.now() + "-" + f.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
        const up = await sb.storage.from("portal").upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
        if (up.error) throw new Error("The file didn’t upload (" + cleanErr(up.error) + "). Try a PDF, Excel, Word, CSV or image file.");
        const { error } = await sb.rpc("portal_public_upload", { p_token: token(), p_path: path, p_name: f.name, p_size: f.size, p_from: $("from").value.trim(), p_note: $("fnote").value.trim() });
        if (error) throw error;
        await load('<div class="ok"><b>Thanks!</b> We have ' + esc(f.name) + ".</div>");
        window.scrollTo(0, 0);
      } catch (e2) {
        fail(cleanErr(e2)); btn.textContent = "Send file"; btn.style.pointerEvents = "";
      }
    }
    return { wanted, show };
  })();
  registerPublicPage(PortalPublic);
