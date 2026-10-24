  // ================================================================ PARTNER FOLLOW-THROUGH (2026-10-22)
  // Outreach > Rebooking, Reviews and Agreements, plus the public agreement page (#agree/<token>, no sign-in).
  // Database: supabase/migrations/20261022210500_partner_followthrough.sql.
  //   Rebooking   partner_rebook_list / _set; the email via partner_compose + partner_queue (kind 'rebook').
  //   Reviews     rows made by a trigger when a job reaches Deliverables sent; partner_reviews_list / partner_review_log.
  //   Agreements  agreements_list / agreement_get / _save / _set_status / _orgs; agreement_public / _accept for the page.
  // Every email lands in the outreach pipeline (the Outbox): "Hold for review", "Add to queue" or "Send now".
  // 2026-10-24 (ws/partners): partner names link to the partner page, "Review it" opens that email in the Outbox,
  // and the tables turn into cards under 700px.
  // 2026-10-23: the tables became grid rows with one main button each (the rest in a ... menu), cards on phones.
  registerPage({ id: "rebook", group: "Outreach", section: "partners", module: "partners", tabs: [["rebook", "Due to rebook"]], onShow: () => Follow.showRebook() });
  registerPage({ id: "reviews", group: "Outreach", section: "partners", module: "partners", tabs: [["reviews", "Reviews"]], onShow: () => Follow.showReviews() });
  registerPage({ id: "agreements", group: "Outreach", section: "partners", module: "agreements", tabs: [["agreements", "Agreements"]], onShow: () => Follow.showAgreements() });
  registerAttention("rebookDue", { module: "partners", level: "soon", name: "rebooking",
    one: "A past client is due to rebook. Last year's date is coming up.", many: "{n} past clients are due to rebook. Last year's dates are coming up." });
  registerAttention("agreementsRenew", { module: "agreements", level: "soon", name: "agreement renewals",
    one: "An agreement renews within 30 days.", many: "{n} agreements renew within 30 days." });
  registerAttention("agreementsCoi", { module: "agreements", level: "warn", name: "insurance certificates",
    one: "An insurance certificate on file expires within 30 days.", many: "{n} insurance certificates on file expire within 30 days." });
  registerTodayLoader("partners", () => Follow.loadRebookAttention());
  registerTodayLoader("agreements", () => Follow.loadAgreementAttention());

  const Follow = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
  .aca .pf-acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .aca .pf-head-btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .aca .pf-due { color: var(--accent); font-weight: 600; }
  .aca .modal textarea.pf-body { width: 100%; min-height: 220px; resize: vertical; }
  .aca .modal textarea.pf-terms { width: 100%; min-height: 300px; resize: vertical; font-size: 13px; }
  .aca .modal textarea.pf-short { width: 100%; min-height: 64px; resize: vertical; }
  .aca .modal .field input[type=text], .aca .modal .field select { width: 100%; }
  .aca .pf-rcpts { border: 1px solid var(--line2); border-radius: 6px; max-height: 240px; overflow: auto; }
  .aca .pf-rcpt { display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 7px 10px; border-bottom: 1px solid var(--line2); }
  .aca .pf-rcpt:last-child { border-bottom: 0; }
  .aca .pf-rcpts + .pf-help { margin-top: 6px; }
  .aca .pf-rcpt.off .pf-rcpt-who { opacity: .6; }
  .aca .pf-rcpt-who { min-width: 0; font-size: 14px; line-height: 20px; }
  .aca .pf-rcpt-who .pf-sub { display: inline; white-space: normal; }
  .aca .pf-rcpt-who .pill { margin-left: 4px; }
  .aca .pf-seg { display: inline-flex; flex: none; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .aca .pf-seg label { position: relative; padding: 4px 10px; font-size: 13px; line-height: 18px; cursor: pointer; border-left: 1px solid var(--border); white-space: nowrap; }
  .aca .pf-seg label:first-child { border-left: 0; }
  .aca .pf-seg label.on { background: var(--accent); color: #fff; font-weight: 600; }
  .aca .pf-seg input { position: absolute; opacity: 0; pointer-events: none; }
  .aca .pf-seg label:focus-within { outline: 2px solid var(--accent); outline-offset: -2px; }
  .aca .pf-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .aca .pf-row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0 12px; }
  .aca .pf-warn { padding: 8px 12px; border-radius: 4px; background: var(--surface-2); font-size: 13px; margin: 0 0 12px; }
  .aca .pf-help { font-size: 12.5px; color: var(--muted); margin: -6px 0 12px; line-height: 18px; }
  .aca .pf-help code { font-size: 12px; }
  .aca .pf-sec { margin: 18px 0 8px; font-size: 12px; font-weight: 600; color: var(--faint); text-transform: uppercase; letter-spacing: .04em; }
  .aca .pf-doc { white-space: pre-wrap; font-size: 13.5px; line-height: 20px; padding: 12px 14px; border: 1px solid var(--line2); border-radius: 4px; background: var(--surface-2); max-height: 340px; overflow: auto; }
  .aca .pf-file { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; margin: -6px 0 14px; }
  .aca .pf-orgpick { max-height: 280px; overflow: auto; border-top: 1px solid var(--line2); }
  .aca .pf-orgpick button { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--line2); border-radius: 0; background: transparent; padding: 8px 4px; height: auto; font-weight: 400; }
  .aca .pf-orgpick button:hover { background: var(--surface-2); }
  .aca .ag-card { max-width: 680px; }
  .aca .ag-text { white-space: pre-wrap; font-size: 14.5px; line-height: 22px; margin: 14px 0 18px; padding: 16px 18px; border: 1px solid var(--line2); border-radius: 4px; background: var(--surface-2); }
  .aca .ag-done { padding: 12px 14px; border-radius: 4px; background: var(--surface-2); margin: 0 0 12px; font-size: 14.5px; line-height: 21px; }
  .aca .ag-check { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 14px; font-size: 14px; line-height: 20px; }
  .aca .ag-check input { margin-top: 3px; }
  @media (max-width: 700px) { .aca .pf-rcpts { max-height: none; } .aca .pf-rcpt { flex-direction: column; align-items: stretch; } .aca .pf-seg { align-self: flex-start; } }
  @media (max-width: 700px) { .aca .pf-row2, .aca .pf-row3 { grid-template-columns: 1fr; } .aca .pf-acts { justify-content: flex-start; } }
  /* 2026-10-23: the three lists are rows on a grid (not tables). One main button per row; the rest sit in a ... menu. Phones get a card. */
  .aca .pf-list { border-top: 1px solid var(--border); }
  .aca .pf-lhead, .aca .pf-item { display: grid; grid-template-columns: var(--pf-cols); gap: 0 20px; align-items: center; }
  .aca .pf-lhead { padding: 10px 8px; font-size: 12.5px; color: var(--faint); border-bottom: 1px solid var(--border); }
  .aca .pf-item { padding: 12px 8px; border-bottom: 1px solid var(--line2); min-height: 64px; }
  .aca .pf-item.pf-click { cursor: pointer; }
  .aca .pf-item:hover { background: var(--surface-2); }
  .aca .pf-item > * { min-width: 0; }
  .aca .pf-name { font-size: 15px; font-weight: 600; line-height: 21px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aca .pf-name a { color: inherit; text-decoration: none; }
  .aca .pf-name a:hover { text-decoration: underline; }
  .aca .pf-sub { font-size: 13px; line-height: 19px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aca .pf-sub a { color: inherit; }
  .aca .pf-main { font-size: 14px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aca .pf-when { font-size: 14.5px; font-weight: 600; line-height: 20px; font-variant-numeric: tabular-nums; }
  .aca .pf-when + .pf-sub.pf-soon { color: var(--accent); font-weight: 600; }
  .aca .pf-tag { display: inline-block; margin-top: 3px; font-size: 11.5px; font-weight: 600; line-height: 17px; padding: 0 7px; border-radius: 3px; background: var(--warn-bg); color: var(--warn-fg); white-space: nowrap; }
  .aca .pf-tag.quiet { background: var(--surface-2); color: var(--muted); }
  .aca .pf-item .pf-acts { flex-wrap: nowrap; align-items: center; position: relative; }
  .aca .pf-item .pf-acts .pill { margin-right: 4px; }
  .aca .pf-more { width: 34px; padding: 0; font-size: 18px; line-height: 1; letter-spacing: 1px; }
  .aca .pf-menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 190px; padding: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.12); }
  .aca .pf-menu button { display: block; width: 100%; text-align: left; border: 0; background: transparent; height: auto; padding: 9px 10px; font-weight: 400; border-radius: 4px; }
  .aca .pf-menu button:hover { background: var(--surface-2); }
  .aca .pf-quote { font-style: italic; font-size: 13px; line-height: 18px; color: var(--muted); margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; max-width: none; }
  .aca .pf-docs { display: contents; }
  .aca .pf-item button.link { height: auto; padding: 0; margin-top: 2px; border: 0; background: none; font-size: 13px; font-weight: 600; color: var(--accent); }
  .aca .pf-docs > div[data-l]::before { display: none; }
  .aca .pf-list .pf-empty { padding: 28px 8px; color: var(--muted); font-size: 14px; }
  .aca .pf-rb { --pf-cols: minmax(0, 1.5fr) 110px minmax(0, 1.2fr) 290px; }
  .aca .pf-rv { --pf-cols: minmax(0, 1.5fr) 190px minmax(0, 1.4fr) 220px; }
  .aca .pf-ag { --pf-cols: minmax(0, 1.8fr) 170px 100px 130px 110px; }
  @media (max-width: 700px) {
    .aca .pf-lhead { display: none; }
    .aca .pf-list { border-top: 0; }
    .aca .pf-list > [id] { display: flex; flex-direction: column; gap: 10px; }
    .aca .pf-item { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "name when" "info info" "acts acts"; gap: 6px 12px; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
    .aca .pf-item:hover { background: var(--surface); }
    .aca .pf-item > :nth-child(1) { grid-area: name; }
    .aca .pf-item > :nth-child(2) { grid-area: when; text-align: right; }
    .aca .pf-item > :nth-child(3) { grid-area: info; }
    .aca .pf-item > .pf-acts { grid-area: acts; justify-content: flex-start; margin-top: 4px; }
    .aca .pf-item > .pf-acts:empty { display: none; }
    .aca .pf-item > .pf-acts > button.primary, .aca .pf-item > .pf-acts > button:first-of-type:not(.pf-more) { flex: 1 1 auto; }
    .aca .pf-item .pf-acts button { min-height: 42px; }
    .aca .pf-more { width: 44px; }
    .aca .pf-name, .aca .pf-sub { white-space: normal; }
    .aca .pf-item > .pf-acts > button { justify-content: center; text-align: center; }
    .aca .card:has(.pf-list) .chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-right: -16px; padding-right: 16px; }
    .aca .card:has(.pf-list) .chips button { flex: 0 0 auto; }
    .aca .pf-rv .pf-item, .aca .pf-ag .pf-item { grid-template-areas: "name name" "when when" "info info" "acts acts"; }
    .aca .pf-rv .pf-item > :nth-child(2), .aca .pf-ag .pf-item > :nth-child(2) { text-align: left; }
    .aca .pf-ag .pf-item { grid-template-areas: "name name" "when when" "docs docs"; }
    .aca .pf-ag .pf-docs { display: flex; flex-wrap: wrap; gap: 4px 16px; grid-area: docs; padding-top: 6px; border-top: 1px solid var(--line2); margin-top: 4px; }
    .aca .pf-docs > div[data-l]::before { display: inline; content: attr(data-l) " "; color: var(--faint); font-size: 12.5px; }
    .aca .pf-docs > div[data-l] { display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap; }
    .aca .pf-list .pf-empty { border: 1px dashed var(--border); border-radius: 10px; text-align: center; }
  }
  @media print { .aca .ag-print-hide { display: none !important; } .aca .ag-text { border: 0; background: none; padding: 0; } }
`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    const TZ = "America/New_York";
    const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    // "2026-05-10" -> "May 10, 2026" (dates without a time never shift a day)
    const day = (d) => Fmt.day(d ? String(d).slice(0, 10) : "");
    const inDays = (n) => (n === 0 ? "today" : n > 0 ? "in " + n + (n === 1 ? " day" : " days") : Math.abs(n) + (n === -1 ? " day ago" : " days ago"));
    const pill = (cls, text) => '<span class="pill ' + cls + '">' + esc(text) + "</span>";
    function chips(id, defs, cur, onPick) {
      const box = el(id);
      box.innerHTML = defs.map((d) => '<button type="button" data-k="' + esc(d[0]) + '" aria-pressed="' + (d[0] === cur) + '"' + (d[3] ? ' class="warn"' : "") + ">" +
        esc(d[1]) + (d[2] !== null && d[2] !== undefined ? " (" + num(d[2]) + ")" : "") + "</button>").join("");
      box.onclick = (e) => { const b = e.target.closest("button[data-k]"); if (b) onPick(b.dataset.k); };
    }
    function emailPill(e) {
      if (!e) return "";
      const s = e.status;
      if (s === "review") return pill("warn", "Waiting for your review");
      if (s === "held") return pill("muted", "Held");
      if (s === "scheduled" || s === "sending") return pill("accent", "Scheduled " + day(e.at, true));
      if (s === "sent") return pill("ok", "Sent " + day(e.at, true));
      if (s === "failed") return pill("err", "Failed");
      return pill("muted", "Not sent");
    }
    const waiting = (e) => e && ["review", "held", "scheduled", "sending"].includes(e.status);
    // "Review it": the Outbox, on that email, narrowed to its partner.
    const goReview = (email, orgId) => Outbox.focus(email && email.id, orgId);
    const goOrg = (id) => { if (!canSee("partners") || !id) return; location.hash = orgLink(id); };
    const orgCell = (id, name) => (canSee("partners") && id ? '<a href="' + orgLink(id) + '" data-do="org">' + esc(name || "") + "</a>" : esc(name || ""));
    // The ... button on a row: the less common actions, so each row shows one main button.
    const moreBtn = (items) => '<button type="button" class="small pf-more" data-do="more" aria-haspopup="true" aria-expanded="false" aria-label="More" title="More">&#8943;</button>' +
      '<div class="pf-menu hidden" role="menu">' + items.map((x) => '<button type="button" role="menuitem" data-do="' + x[0] + '">' + esc(x[1]) + "</button>").join("") + "</div>";
    function closeMenus(except) {
      document.querySelectorAll(".aca .pf-menu:not(.hidden)").forEach((m) => { if (m !== except) { m.classList.add("hidden"); m.previousElementSibling.setAttribute("aria-expanded", "false"); } });
    }
    function toggleMenu(btn) {
      const m = btn.nextElementSibling, open = m.classList.contains("hidden");
      closeMenus(m);
      m.classList.toggle("hidden", !open);
      btn.setAttribute("aria-expanded", String(open));
      if (open) m.querySelector("button").focus();
    }
    document.addEventListener("click", (e) => { if (!e.target.closest(".pf-acts")) closeMenus(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });

    let settings = null;
    async function loadSettings(force) {
      if (settings && !force) return settings;
      const { data, error } = await sb.from("partner_followup_settings").select("*").maybeSingle();
      if (error) throw error;
      settings = data || {};
      return settings;
    }

    // ---------------------------------------------------------------- compose (shared by all three)
    // kind: rebook | review | agreement; ref: org id | review id | agreement id; due: which rebook row (none = the next open one).
    async function compose(kind, ref, onDone, due) {
      const dueArg = kind === "rebook" && due ? { p_due: due } : {};
      const { data: c0, error } = await sb.rpc("partner_compose", { p_kind: kind, p_ref: ref, p_contact: null, ...dueArg });
      if (error) return toast(cleanErr(error), true);
      let c = c0 || {}, edited = false;
      const title = { rebook: "Rebook email", review: "Ask for a review", agreement: "Email the agreement" }[kind];
      const m = openModal("<h2>" + esc(title) + ": " + esc(c.org || "") + "</h2>" +
        '<div class="pf-warn' + (c.warning ? "" : " hidden") + '" id="aca-pfCmWarn">' + esc(c.warning || "") + "</div>" +
        ((c.contacts || []).length
          ? '<div class="field"><label>Who gets it</label><div class="pf-rcpts" id="aca-pfCmTo"></div>' +
            '<p class="pf-help" id="aca-pfCmWho"></p></div>'
          : '<p class="inline-error">Nobody to email. Add a contact on the partner page first.</p>') +
        '<div class="field"><label for="aca-pfCmSubj">Subject</label><input type="text" id="aca-pfCmSubj" maxlength="200" /></div>' +
        '<div class="field"><label for="aca-pfCmBody">Message</label><textarea id="aca-pfCmBody" class="pf-body"></textarea></div>' +
        '<p class="pf-help">Your outreach signature is added when it sends. <strong>Send now</strong> sends it right away; <strong>Add to queue</strong> sends it in the next send window; <strong>Hold for review</strong> keeps it in the Outbox for your OK.</p>' +
        '<div class="inline-error hidden" id="aca-pfCmErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-pfCmCancel">Cancel</button>' +
        '<button type="button" id="aca-pfCmHold">Hold for review</button><button type="button" id="aca-pfCmGo">Add to queue</button><button type="button" class="primary" id="aca-pfCmNow">Send now</button></div>');
      const fill = () => { el("pfCmSubj").value = c.subject || ""; el("pfCmBody").value = c.body || ""; edited = false; };
      fill();
      ["pfCmSubj", "pfCmBody"].forEach((id) => el(id).addEventListener("input", () => { edited = true; }));
      // Recipients (2026-10-24): one To, any number in CC, filled in from the partner's contact lines (rebook: the
      // service of last year's job, Main in To, Copy in in CC) or the booking's people. Each person can be moved by hand.
      const people = c.contacts || [];
      let toId = c.to_id || c.contact_id || (people[0] && people[0].id) || "";
      const cc = new Set((c.cc_ids || []).filter((id) => id !== toId));
      const svc = c.service || "", svcName = c.service_name || "";
      const roleTag = (x) => {
        const r = svc && x.roles ? x.roles[svc] : "";
        return (r === "main" ? '<span class="pill accent">' + esc(svcName) + " main</span>" : r === "copy" ? '<span class="pill muted">' + esc(svcName) + " copy in</span>" : "") +
          (x.stopped ? '<span class="pill muted">emails stopped</span>' : "");
      };
      const drawTo = () => {
        const box = el("pfCmTo");
        if (!box) return;
        box.innerHTML = people.map((x) => {
          const v = x.id === toId ? "to" : cc.has(x.id) ? "cc" : "";
          const opt = (val, label) => '<label class="' + (v === val ? "on" : "") + '"><input type="radio" name="pfCm-' + esc(x.id) + '" value="' + val + '" data-cid="' + esc(x.id) + '"' + (v === val ? " checked" : "") + " />" + label + "</label>";
          return '<div class="pf-rcpt' + (v ? "" : " off") + '"><div class="pf-rcpt-who"><strong>' + esc(x.name) + "</strong>" +
            (x.name !== x.email ? ' <span class="pf-sub">' + esc(x.email) + "</span>" : "") + (x.role ? ' <span class="pf-sub">' + esc(x.role) + "</span>" : "") + " " + roleTag(x) + "</div>" +
            '<div class="pf-seg" role="radiogroup" aria-label="' + esc(x.name) + '">' + opt("to", "To") + opt("cc", "CC") + opt("", "Leave out") + "</div></div>";
        }).join("");
        const n = cc.size;
        el("pfCmWho").textContent = (svc && kind === "rebook"
          ? "Filled in from the " + svcName + " contacts on the partner page: Main in To, Copy in in CC, Not involved left out. "
          : "") + (toId ? "One email" + (n ? ", " + n + " copied in." : ".") : "Pick who it goes To.");
      };
      drawTo();
      if (el("pfCmTo")) el("pfCmTo").addEventListener("change", async (e) => {
        const t = e.target.closest("input[data-cid]");
        if (!t) return;
        const id = t.dataset.cid, was = toId;
        cc.delete(id);
        if (t.value === "to") { if (toId && toId !== id) cc.add(toId); toId = id; }
        else { if (t.value === "cc") cc.add(id); if (toId === id) { toId = [...cc][0] || ""; cc.delete(toId); } }
        drawTo();
        if (toId === was || !toId || edited) return; // keep what they typed; only the greeting would change
        const { data } = await sb.rpc("partner_compose", { p_kind: kind, p_ref: ref, p_contact: toId, ...dueArg });
        if (data && !edited) { c = { ...c, subject: data.subject, body: data.body }; fill(); }
      });
      const err = (t) => { const n = el("pfCmErr"); n.textContent = t; n.classList.remove("hidden"); };
      el("pfCmCancel").addEventListener("click", () => m.close());
      const send = async (approve, now) => {
        if (!el("pfCmTo")) return err("Nobody to email.");
        if (!toId) return err("Pick who it goes To.");
        const btns = [el("pfCmHold"), el("pfCmGo"), el("pfCmNow")]; btns.forEach((b) => { b.disabled = true; });
        const { data: q, error: e2 } = await sb.rpc("partner_queue_cc", { p_kind: kind, p_ref: ref, p_contact: toId, p_cc: [...cc],
          p_subject: el("pfCmSubj").value, p_body: el("pfCmBody").value, p_approve: approve, ...dueArg });
        btns.forEach((b) => { b.disabled = false; });
        if (e2) return err(cleanErr(e2));
        m.close();
        if (now) { try { await Orgs.sendNow([q.email_id]); } catch (e3) { toast("It's in the queue, but: " + cleanErr(e3), true); } }
        else toast(approve ? "Added to the queue. It goes out in the next send window." : "Saved. It's waiting in the Outbox for your OK.");
        if (onDone) onDone();
      };
      el("pfCmHold").addEventListener("click", () => send(false));
      el("pfCmGo").addEventListener("click", () => send(true));
      el("pfCmNow").addEventListener("click", () => send(true, true));
    }

    // ---------------------------------------------------------------- templates
    const HELP = {
      common: "<code>{{hi|Hi there}}</code> <code>{{first_name}}</code> <code>{{league}}</code> <code>{{town}}</code> <code>{{sport}}</code> <code>{{sender_first_name}}</code>",
      rebook: "<code>{{last_date}}</code> <code>{{last_season}}</code> <code>{{year}}</code>",
      review: "<code>{{review_link}}</code> <code>{{job}}</code> <code>{{picture_day}}</code>",
      agreement: "<code>{{agreement_link}}</code> (required) <code>{{title}}</code> <code>{{picture_day}}</code> <code>{{job}}</code>",
      terms: "<code>{{league}}</code> <code>{{picture_day}}</code> <code>{{job}}</code> <code>{{pricing}}</code> <code>{{payout}}</code> <code>{{renewal_date}}</code>",
    };
    async function editTemplates(kind) {
      let s;
      try { s = await loadSettings(true); } catch (e) { return toast(cleanErr(e), true); }
      const ta = (id, v, cls) => '<textarea id="aca-' + id + '" class="' + (cls || "pf-body") + '">' + esc(v || "") + "</textarea>";
      const tx = (id, v, ph) => '<input type="text" id="aca-' + id + '" value="' + esc(v || "") + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : "") + " />";
      let body = "";
      if (kind === "rebook") {
        body = '<div class="field"><label for="aca-pfTpLead">Show a client this many days before last year&#8217;s date</label><input type="number" id="aca-pfTpLead" min="14" max="240" value="' + num(s.rebook_lead_days) + '" /></div>' +
          '<div class="field"><label for="aca-pfTpSubj">Subject</label>' + tx("pfTpSubj", s.rebook_subject) + "</div>" +
          '<div class="field"><label for="aca-pfTpBody">Message</label>' + ta("pfTpBody", s.rebook_body) + "</div>" +
          '<p class="pf-help">Fill-ins: ' + HELP.common + " " + HELP.rebook + ". <code>{{name|fallback}}</code> uses the fallback when it&#8217;s blank.</p>";
      } else if (kind === "review") {
        body = '<label class="ag-check"><input type="checkbox" id="aca-pfTpAuto"' + (s.review_auto ? " checked" : "") + " /> <span>Draft a request by itself when a booked job reaches Deliverables sent (it still waits for your review)</span></label>" +
          '<div class="field"><label for="aca-pfTpLink">Google review link</label>' + tx("pfTpLink", s.review_link, "https://g.page/r/...") + "</div>" +
          '<p class="pf-help">In Google Business Profile, choose <b>Ask for reviews</b> and copy the link.</p>' +
          '<div class="field"><label for="aca-pfTpSubj">Subject</label>' + tx("pfTpSubj", s.review_subject) + "</div>" +
          '<div class="field"><label for="aca-pfTpBody">Message</label>' + ta("pfTpBody", s.review_body) + "</div>" +
          '<p class="pf-help">Fill-ins: ' + HELP.common + " " + HELP.review + ".</p>";
      } else {
        body = '<div class="field"><label for="aca-pfTpSubj">Email subject</label>' + tx("pfTpSubj", s.agreement_subject) + "</div>" +
          '<div class="field"><label for="aca-pfTpBody">Email message</label>' + ta("pfTpBody", s.agreement_body, "pf-short") + "</div>" +
          '<p class="pf-help">Fill-ins: ' + HELP.common + " " + HELP.agreement + ".</p>" +
          '<div class="field"><label for="aca-pfTpTerms">Default terms for new agreements</label>' + ta("pfTpTerms", s.agreement_terms, "pf-terms") + "</div>" +
          '<p class="pf-help">Fill-ins: ' + HELP.terms + ". Changing this only affects agreements you start from now on. Have someone you trust read it over before you rely on it.</p>";
      }
      const m = openModal("<h2>" + { rebook: "Rebook email", review: "Review request", agreement: "Agreement email and default terms" }[kind] + "</h2>" + body +
        '<div class="inline-error hidden" id="aca-pfTpErr"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-pfTpCancel">Cancel</button><button type="button" class="primary" id="aca-pfTpSave">Save</button></div>');
      if (!canEdit(kind === "agreement" ? "agreements" : "partners")) { m.querySelectorAll("input, textarea").forEach((n) => { n.disabled = true; }); el("pfTpSave").classList.add("hidden"); }
      el("pfTpCancel").addEventListener("click", () => m.close());
      el("pfTpSave").addEventListener("click", async () => {
        const v = (id) => el(id).value;
        const patch = kind === "rebook" ? { rebook_lead_days: Math.round(Number(v("pfTpLead"))) || 75, rebook_subject: v("pfTpSubj"), rebook_body: v("pfTpBody") }
          : kind === "review" ? { review_auto: el("pfTpAuto").checked, review_link: v("pfTpLink").trim(), review_subject: v("pfTpSubj"), review_body: v("pfTpBody") }
          : { agreement_subject: v("pfTpSubj"), agreement_body: v("pfTpBody"), agreement_terms: v("pfTpTerms") };
        if (kind === "agreement" && !patch.agreement_body.includes("{{agreement_link")) { const n = el("pfTpErr"); n.textContent = "Keep {{agreement_link}} in the email, or they have nothing to click."; n.classList.remove("hidden"); return; }
        patch.updated_at = new Date().toISOString(); patch.updated_by = ACCESS.user_id || null;
        el("pfTpSave").disabled = true;
        const { error } = await sb.from("partner_followup_settings").update(patch).eq("id", true);
        el("pfTpSave").disabled = false;
        if (error) { const n = el("pfTpErr"); n.textContent = cleanErr(error); n.classList.remove("hidden"); return; }
        settings = null;
        m.close();
        toast("Saved.");
        if (kind === "rebook") loadRebook();
      });
    }

    // ---------------------------------------------------------------- rebooking
    let rbRows = [], rbFilter = "now", rbWired = false;
    const rbGroup = (r) => (r.status === "skipped" || (r.status === "later" && r.later_until > todayStr())) ? "parked"
      : (r.status === "emailed" || r.waiting) ? "emailed" : r.open ? "now" : "soon";
    async function showRebook() {
      if (!rbWired) {
        rbWired = true;
        el("pfRbTpl").addEventListener("click", () => editTemplates("rebook"));
        el("pfRbBody").addEventListener("click", rebookClick);
      }
      loadRebook();
    }
    async function loadRebook() {
      const [{ data, error }, s] = await Promise.all([sb.rpc("partner_rebook_list"), loadSettings().catch(() => ({}))]);
      if (error) { showError("pfRbErr", cleanErr(error)); return; }
      clearError("pfRbErr");
      rbRows = Array.isArray(data) ? data : [];
      if (s && s.rebook_lead_days) el("pfRbLead").textContent = "Last year's clients show up here " + num(s.rebook_lead_days) + " days before last year's picture day, once per season, with a ready rebook email. A booking or GotPhoto job near that date takes them off the list.";
      renderRebook();
      setAttention("rebookDue", rbRows.filter((r) => rbGroup(r) === "now").length, "Due to rebook", "rebook");
    }
    function renderRebook() {
      const n = (g) => rbRows.filter((r) => rbGroup(r) === g).length;
      chips("pfRbChips", [["now", "Time to rebook", n("now"), n("now") > 0], ["soon", "Coming up", n("soon")], ["emailed", "Emailed", n("emailed")], ["parked", "Later or not this year", n("parked")]],
        rbFilter, (k) => { rbFilter = k; renderRebook(); });
      const rows = rbRows.filter((r) => rbGroup(r) === rbFilter);
      const ed = canEdit("partners");
      el("pfRbBody").innerHTML = rows.length ? rows.map((r) => {
        const parked = r.status === "skipped" || (r.status === "later" && r.later_until > todayStr());
        const st = r.status === "skipped" ? pill("muted", "Not this year")
          : parked ? pill("muted", "Later: " + day(r.later_until, true))
          : r.email && r.email.status !== "review" ? emailPill(r.email) : r.waiting ? pill("muted", "Another email is waiting") : "";
        const main = !ed ? "" : parked ? '<button type="button" class="small" data-do="todo">Back on the list</button>'
          : r.email && r.email.status === "review" ? '<button type="button" class="small primary" data-do="review">Review the email</button>'
          : waiting(r.email) ? "" : r.contact ? '<button type="button" class="small primary" data-do="draft">Draft email</button>'
          : '<button type="button" class="small" disabled title="No contact with a working email">Draft email</button>';
        const more = !ed || parked ? "" : moreBtn([["later", "Remind me later"], ["skip", "Not this year"]]);
        const what = r.last_job || (num(r.job_count) > 1 ? num(r.job_count) + " jobs with us" : "");
        const soon = num(r.days) <= 14;
        return '<div class="pf-item" data-org="' + esc(r.org_id) + '" data-due="' + esc(r.due_on) + '">' +
          '<div><div class="pf-name">' + orgCell(r.org_id, r.name) + '</div><div class="pf-sub">' + esc([r.town, what].filter(Boolean).join(" · ")) + "</div>" +
            (r.agreement && r.agreement.renewal_date ? '<span class="pf-tag">Agreement renews ' + esc(day(r.agreement.renewal_date, true)) + "</span>" : "") + "</div>" +
          '<div title="' + esc("Last picture day " + day(r.last_date)) + '"><div class="pf-when">' + esc(day(r.due_on, true)) + '</div><div class="pf-sub' + (soon ? " pf-soon" : "") + '">' + esc(inDays(num(r.days))) + "</div></div>" +
          "<div>" + (r.contact ? '<div class="pf-main">' + esc(r.contact.name) + "</div>" + (r.contact.name !== r.contact.email ? '<div class="pf-sub">' + esc(r.contact.email) + "</div>" : "")
            : '<div class="pf-sub">No working email' + (canSee("partners") ? ' · <a href="' + orgLink(r.org_id) + '" data-do="org">add a contact</a>' : "") + "</div>") +
            (r.status === "skipped" && r.note ? '<div class="pf-sub">' + esc(r.note) + "</div>" : "") + "</div>" +
          '<div class="pf-acts">' + st + main + more + "</div></div>";
      }).join("") : '<div class="pf-empty">' + { now: "Nobody is due to rebook right now.", soon: "Nobody coming up in the next few months.", emailed: "No rebook emails yet.", parked: "Nothing set aside." }[rbFilter] + "</div>";
    }
    async function rebookClick(e) {
      const b = e.target.closest("[data-do]"), tr = e.target.closest(".pf-item[data-org]");
      if (!b || !tr) return;
      const org = tr.dataset.org, due = tr.dataset.due, act = b.dataset.do;
      if (act === "org") return;
      if (act === "more") return toggleMenu(b);
      closeMenus();
      if (act === "review") { const r = rbRows.find((x) => x.org_id === org && x.due_on === due); return goReview(r && r.email, org); }
      if (act === "draft") return compose("rebook", org, loadRebook, due);
      if (act === "todo") return setRebook(org, due, "todo", null, "");
      if (act === "skip") {
        const note = prompt("Not this year. Why? (optional, for next year)", "");
        if (note === null) return;
        return setRebook(org, due, "skipped", null, note);
      }
      if (act === "later") {
        const m = openModal('<h2>Remind me later</h2><div class="field"><label for="aca-pfLater">Show it again on</label><input type="date" id="aca-pfLater" min="' + esc(todayStr()) + '" /></div>' +
          '<div class="inline-error hidden" id="aca-pfLaterErr"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-pfLaterCancel">Cancel</button><button type="button" class="primary" id="aca-pfLaterSave">Save</button></div>');
        const d = new Date(); d.setDate(d.getDate() + 21); el("pfLater").value = d.toLocaleDateString("en-CA", { timeZone: TZ });
        el("pfLaterCancel").addEventListener("click", () => m.close());
        el("pfLaterSave").addEventListener("click", async () => {
          const ok = await setRebook(org, due, "later", el("pfLater").value, null, "pfLaterErr");
          if (ok) m.close();
        });
      }
    }
    async function setRebook(org, due, status, until, note, errId) {
      const { error } = await sb.rpc("partner_rebook_set", { p_org: org, p_due: due, p_status: status, p_until: until, p_note: note });
      if (error) { if (errId) { const n = el(errId); n.textContent = cleanErr(error); n.classList.remove("hidden"); } else toast(cleanErr(error), true); return false; }
      loadRebook();
      return true;
    }
    async function loadRebookAttention() {
      try {
        const { data, error } = await sb.rpc("partner_rebook_attention");
        if (error) throw error;
        setAttention("rebookDue", num(data && data.due), "Due to rebook", "rebook");
      } catch (_e) { /* Today reports it as unchecked */ }
    }

    // ---------------------------------------------------------------- reviews
    let rvRows = [], rvFilter = "open", rvWired = false;
    const OUTCOMES = [["open", "Nothing yet"], ["reviewed", "Left a review"], ["quote", "Gave us a quote"], ["declined", "Said no"], ["no_reply", "No reply"], ["skipped", "Not asking"]];
    const OUTCOME_NAME = Object.fromEntries(OUTCOMES);
    async function showReviews() {
      if (!rvWired) {
        rvWired = true;
        el("pfRvTpl").addEventListener("click", () => editTemplates("review"));
        el("pfRvBody").addEventListener("click", reviewClick);
      }
      loadReviews();
    }
    async function loadReviews() {
      const { data, error } = await sb.rpc("partner_reviews_list", { p_days: 400 });
      if (error) { showError("pfRvErr", cleanErr(error)); return; }
      clearError("pfRvErr");
      rvRows = Array.isArray(data) ? data : [];
      renderReviews();
    }
    function renderReviews() {
      const n = (f) => rvRows.filter(f).length;
      const isOpen = (r) => r.outcome === "open", isWin = (r) => r.outcome === "reviewed" || r.outcome === "quote";
      chips("pfRvChips", [["open", "Waiting to hear", n(isOpen)], ["won", "Reviews and quotes", n(isWin)], ["all", "All", rvRows.length]], rvFilter, (k) => { rvFilter = k; renderReviews(); });
      const rows = rvRows.filter(rvFilter === "open" ? isOpen : rvFilter === "won" ? isWin : () => true);
      const ed = canEdit("partners");
      el("pfRvBody").innerHTML = rows.length ? rows.map((r) => {
        const req = r.email ? emailPill(r.email) : '<span class="pf-sub">' + esc(r.note || (r.booking_status === "tracked" ? "Track-only job, nothing drafted" : "Not drafted")) + "</span>";
        const back = r.outcome === "open" ? '<span class="pf-sub">Nothing yet</span>'
          : pill(r.outcome === "reviewed" || r.outcome === "quote" ? "ok" : "muted", OUTCOME_NAME[r.outcome] || r.outcome) + (r.saved_quote ? ' <span class="pf-tag quiet">In the Email library</span>' : "") +
            (r.quote ? '<div class="pf-quote">&#8220;' + esc(r.quote) + "&#8221;" + (r.quote_by ? " &#8212; " + esc(r.quote_by) : "") + "</div>" : "");
        const canDraft = !waiting(r.email) && !(r.email && r.email.status === "sent") && r.outcome === "open" && r.booking_status !== "cancelled";
        const logMain = r.outcome === "open" && r.email && r.email.status === "sent";
        const acts = !ed ? "" : r.email && r.email.status === "review" ? '<button type="button" class="small primary" data-do="review">Review the email</button><button type="button" class="small" data-do="log">Log</button>'
          : canDraft ? '<button type="button" class="small" data-do="draft">Draft request</button><button type="button" class="small" data-do="log">Log</button>'
          : '<button type="button" class="small' + (logMain ? " primary" : "") + '" data-do="log">' + (r.outcome === "open" ? "Log what came back" : "Edit") + "</button>";
        const job = r.booking_id && typeof jobLink === "function" ? '<a href="' + jobLink(r.booking_id) + '">' + esc(r.job || "Job") + "</a>" : esc(r.job || "Job");
        return '<div class="pf-item" data-id="' + esc(r.id) + '" data-org="' + esc(r.org_id) + '">' +
          '<div><div class="pf-name">' + orgCell(r.org_id, r.org) + '</div><div class="pf-sub">' + job + " · " + esc(day(r.picture_day)) + (r.booking_status === "tracked" ? " · track-only" : "") + "</div></div>" +
          "<div>" + req + "</div><div>" + back + '</div><div class="pf-acts">' + acts + "</div></div>";
      }).join("") : '<div class="pf-empty">' + (rvFilter === "open" ? "Nothing waiting. Jobs show up here when they reach Deliverables sent." : "Nothing here yet.") + "</div>";
    }
    function reviewClick(e) {
      const b = e.target.closest("[data-do]"), tr = e.target.closest(".pf-item[data-id]");
      if (!b || !tr) return;
      const r = rvRows.find((x) => x.id === tr.dataset.id);
      if (!r) return;
      if (b.dataset.do === "org") return;
      if (b.dataset.do === "review") return goReview(r.email, r.org_id);
      if (b.dataset.do === "draft") return compose("review", r.id, loadReviews);
      if (b.dataset.do === "log") logReview(r);
    }
    function logReview(r) {
      const m = openModal("<h2>What came back from " + esc(r.org) + "</h2>" +
        '<div class="field"><label for="aca-pfRvOut">Result</label><select id="aca-pfRvOut">' + OUTCOMES.map((o) => '<option value="' + o[0] + '"' + (o[0] === r.outcome ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("") + "</select></div>" +
        '<div id="aca-pfRvQBox"><div class="field"><label for="aca-pfRvQuote">Their words</label><textarea id="aca-pfRvQuote" class="pf-short">' + esc(r.quote || "") + "</textarea></div>" +
        '<div class="field"><label for="aca-pfRvBy">Who said it</label><input type="text" id="aca-pfRvBy" maxlength="160" value="' + esc(r.quote_by || "") + '" placeholder="Dana Smith, league president" /></div>' +
        (r.saved_quote ? '<p class="pf-help">Already in the Email library.</p>' : '<label class="ag-check"><input type="checkbox" id="aca-pfRvSave" checked /> <span>Add it to the Email library as a quote for outreach emails</span></label>') + "</div>" +
        '<div class="field"><label for="aca-pfRvNote">Note <span class="muted">(optional)</span></label><input type="text" id="aca-pfRvNote" maxlength="500" value="' + esc(r.note || "") + '" /></div>' +
        '<div class="inline-error hidden" id="aca-pfRvErr2"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-pfRvCancel">Cancel</button><button type="button" class="primary" id="aca-pfRvSaveBtn">Save</button></div>');
      const sync = () => el("pfRvQBox").classList.toggle("hidden", !["quote", "reviewed"].includes(el("pfRvOut").value));
      el("pfRvOut").addEventListener("change", sync); sync();
      el("pfRvCancel").addEventListener("click", () => m.close());
      el("pfRvSaveBtn").addEventListener("click", async () => {
        const out = el("pfRvOut").value, keepQ = ["quote", "reviewed"].includes(out);
        const { error } = await sb.rpc("partner_review_log", { p_id: r.id, p_outcome: out, p_quote: keepQ ? el("pfRvQuote").value : "", p_quote_by: keepQ ? el("pfRvBy").value : "",
          p_note: el("pfRvNote").value, p_save_quote: keepQ && !!(el("pfRvSave") && el("pfRvSave").checked && el("pfRvQuote").value.trim()) });
        if (error) { const n = el("pfRvErr2"); n.textContent = cleanErr(error); n.classList.remove("hidden"); return; }
        m.close();
        toast("Saved.");
        loadReviews();
      });
    }

    // ---------------------------------------------------------------- agreements
    let agRows = [], agFilter = "open", agWired = false;
    const DOC = [["not_needed", "Not needed"], ["needed", "Needed"], ["requested", "Requested"], ["on_file", "On file"]];
    const DOC_NAME = Object.fromEntries(DOC);
    const agLink = (token) => "https://admin.207photo.com/#agree/" + token;
    async function showAgreements() {
      if (!agWired) {
        agWired = true;
        el("pfAgTpl").addEventListener("click", () => editTemplates("agreement"));
        el("pfAgNew").addEventListener("click", () => newAgreement());
        el("pfAgBody").addEventListener("click", (e) => {
          const b = e.target.closest("[data-do=org]"), tr = e.target.closest(".pf-item[data-id]");
          if (b && tr) return;
          // ws/agreement (2026-10-24): builder agreements open in the builder
          if (e.target.closest("[data-do=builder]") && tr && hasBuilder()) return AgreementBuilder.open(tr.dataset.org, { id: tr.dataset.id, onDone: loadAgreements });
          if (tr) openAgreement(tr.dataset.id);
        });
      }
      document.querySelectorAll(".pf-agedit").forEach((n) => n.classList.toggle("hidden", !canEdit("agreements")));
      loadAgreements();
    }
    async function loadAgreements() {
      const { data, error } = await sb.rpc("agreements_list");
      if (error) { showError("pfAgErr", cleanErr(error)); return; }
      clearError("pfAgErr");
      agRows = Array.isArray(data) ? data : [];
      renderAgreements();
    }
    function agStatus(a) {
      if (a.status === "accepted") return pill("ok", "Accepted " + day(a.accepted_at, true)) + '<div class="pf-sub">' + esc(a.accepted_name ? "by " + a.accepted_name : "") + "</div>";
      if (a.status === "sent") return (a.email && a.email.status === "review" ? pill("warn", "Email waiting for your review") : pill("accent", "Sent " + day(a.sent_at, true))) +
        '<div class="pf-sub">' + (a.viewed_at ? "Opened " + esc(day(a.viewed_at, true)) : "Not opened yet") + "</div>";
      if (a.status === "void") return pill("muted", "Void");
      return pill("muted", "Draft");
    }
    function docCell(status, extra) {
      return status === "not_needed" ? '<span class="pf-sub">Not needed</span>' : pill(status === "on_file" ? "ok" : status === "requested" ? "accent" : "warn", DOC_NAME[status] || status) + (extra || "");
    }
    function renderAgreements() {
      const n = (f) => agRows.filter(f).length;
      const isOpen = (a) => a.status === "draft" || a.status === "sent";
      chips("pfAgChips", [["open", "In progress", n(isOpen)], ["accepted", "Accepted", n((a) => a.status === "accepted")], ["all", "All", agRows.length]], agFilter, (k) => { agFilter = k; renderAgreements(); });
      const rows = agRows.filter(agFilter === "open" ? isOpen : agFilter === "accepted" ? (a) => a.status === "accepted" : () => true);
      const soon = new Date(Date.now() + 30 * 864e5).toLocaleDateString("en-CA", { timeZone: TZ });
      el("pfAgBody").innerHTML = rows.length ? rows.map((a) => '<div class="pf-item pf-click" data-id="' + esc(a.id) + '" data-org="' + esc(a.org_id) + '">' +
        '<div><div class="pf-name">' + orgCell(a.org_id, a.org) + '</div><div class="pf-sub">' + esc([a.title, a.picture_day ? "Picture day " + day(a.picture_day, true) : a.booking_label].filter(Boolean).join(" · ")) + "</div>" +
          (a.has_builder && hasBuilder() && canEdit("agreements") && (a.status === "draft" || a.status === "sent") ? '<button type="button" class="link" data-do="builder">Edit in builder</button>' : "") + "</div>" +
        "<div>" + agStatus(a) + "</div>" +
        '<div class="pf-docs"><div data-l="W-9">' + docCell(a.w9_status) + "</div>" +
        '<div data-l="Insurance">' + docCell(a.coi_status, a.coi_expires ? '<div class="pf-sub' + (a.coi_expires <= soon ? " pf-due" : "") + '">Expires ' + esc(day(a.coi_expires, true)) + "</div>" : "") + "</div>" +
        '<div data-l="Renews">' + (a.renewal_date ? '<span class="pf-main' + (a.renewal_date <= soon && a.status === "accepted" ? " pf-due" : "") + '">' + esc(day(a.renewal_date, true)) + "</span>" : '<span class="pf-sub">&#8212;</span>') + "</div></div></div>").join("")
        : '<div class="pf-empty">' + (agFilter === "open" ? "No agreements in progress." + (canEdit("agreements") ? " Start one with New agreement." : "") : "None yet.") + "</div>";
    }
    // ws/agreement (2026-10-24): the school agreement builder (agreement-builder.js), when it's in the bundle.
    const hasBuilder = () => typeof AgreementBuilder !== "undefined" && typeof AgreementDoc !== "undefined";
    // With an org id (the partner page) it starts the agreement for that partner without asking (2026-10-24).
    async function newAgreement(orgId) {
      if (typeof orgId === "string" && orgId) {
        const { data, error } = await sb.rpc("agreement_save", { p_id: null, p: { org_id: orgId } });
        if (error) return toast(cleanErr(error), true);
        if (el("pfAgBody")) loadAgreements();
        return openAgreement(data && data.id);
      }
      const m = openModal('<h2>New agreement</h2><div class="field"><label for="aca-pfAgQ">Partner</label><input type="text" id="aca-pfAgQ" placeholder="Type a name or town&#8230;" autocomplete="off" /></div>' +
        (hasBuilder() ? '<p class="pf-help">Schools open the agreement builder. Leagues get the plain agreement for now.</p>' : "") +
        '<div class="pf-orgpick" id="aca-pfAgPick"></div><div class="inline-error hidden" id="aca-pfAgNErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-pfAgNCancel">Cancel</button></div>');
      let timer = null, seq = 0;
      const search = async () => {
        const my = ++seq;
        const { data, error } = await sb.rpc("agreement_orgs", { p_q: el("pfAgQ").value.trim() });
        if (my !== seq) return;
        if (error) { el("pfAgPick").innerHTML = '<p class="inline-error">' + esc(cleanErr(error)) + "</p>"; return; }
        el("pfAgPick").innerHTML = (data || []).map((o) => '<button type="button" data-org="' + esc(o.id) + '" data-aud="' + esc(o.audience || "") + '"><b>' + esc(o.name) + "</b>" + (o.town ? ' <span class="muted">' + esc(o.town) + "</span>" : "") +
          (o.audience === "school" && hasBuilder() ? ' <span class="pill accent">School</span>' : "") + "</button>").join("") || '<p class="muted">No matches.</p>';
      };
      el("pfAgQ").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 200); });
      el("pfAgNCancel").addEventListener("click", () => m.close());
      el("pfAgPick").addEventListener("click", async (e) => {
        const b = e.target.closest("button[data-org]");
        if (!b) return;
        if (b.dataset.aud === "school" && hasBuilder()) { m.close(); return AgreementBuilder.open(b.dataset.org, { onDone: loadAgreements }); }
        b.disabled = true;
        const { data, error } = await sb.rpc("agreement_save", { p_id: null, p: { org_id: b.dataset.org } });
        if (error) { b.disabled = false; const n = el("pfAgNErr"); n.textContent = cleanErr(error); n.classList.remove("hidden"); return; }
        m.close();
        loadAgreements();
        openAgreement(data && data.id);
      });
      search();
    }

    // Upload a W-9 or insurance certificate to the private `agreements` bucket; returns the path.
    async function upload(agId, what, file) {
      const ext = (file.name.match(/\.([a-z0-9]{2,5})$/i) || [, "pdf"])[1].toLowerCase();
      const path = agId + "/" + what + "-" + Date.now() + "." + ext;
      const { error } = await sb.storage.from("agreements").upload(path, file, { contentType: file.type || "application/pdf", upsert: false });
      if (error) throw error;
      return path;
    }
    async function openFile(path) {
      const { data, error } = await sb.storage.from("agreements").createSignedUrl(path, 300);
      if (error || !data) return toast(cleanErr(error || "Could not open the file."), true);
      window.open(data.signedUrl, "_blank", "noopener");
    }

    async function openAgreement(id) {
      if (!id) return;
      const { data: a, error } = await sb.rpc("agreement_get", { p_id: id });
      if (error || !a) return toast(cleanErr(error || "Not found."), true);
      const ed = canEdit("agreements"), locked = a.status === "accepted" || a.status === "void";
      const built = !!a.builder && hasBuilder();   // ws/agreement: made in the agreement builder
      if (built) AgreementDoc.ensureCss();
      const dis = (cond) => (cond ? " disabled" : "");
      const docSel = (id2, v) => '<select id="aca-' + id2 + '"' + dis(!ed) + ">" + DOC.map((d) => '<option value="' + d[0] + '"' + (d[0] === v ? " selected" : "") + ">" + d[1] + "</option>").join("") + "</select>";
      const fileRow = (what, path) => '<div class="pf-file" data-what="' + what + '">' + (path ? '<button type="button" class="small" data-open="' + esc(path) + '">Open file</button>' : '<span class="muted">No file</span>') +
        (ed ? '<input type="file" accept="application/pdf,image/*" class="hidden" /><button type="button" class="small" data-up>' + (path ? "Replace file" : "Upload file") + "</button>" : "") + "</div>";
      const m = openModal("<h2>" + esc(a.org) + "</h2>" +
        (a.status === "accepted" ? '<div class="ag-done">' + pill("ok", "Accepted") + " by <b>" + esc(a.accepted_name) + "</b>" + (a.accepted_title ? ", " + esc(a.accepted_title) : "") + ", " + esc(fmtDate(a.accepted_at)) + "</div>"
          : a.status === "sent" ? '<div class="ag-done">' + pill("accent", "Sent") + " " + esc(day(a.sent_at)) + (a.viewed_at ? ". They opened it " + esc(fmtDate(a.viewed_at)) + "." : ". Not opened yet.") +
            (a.email && a.email.status !== "sent" ? " " + emailPill(a.email) : "") + "</div>" : a.status === "void" ? '<div class="ag-done">' + pill("muted", "Void") + "</div>" : "") +
        '<div class="pf-row2"><div class="field"><label for="aca-pfAgTitle">Title</label><input type="text" id="aca-pfAgTitle" maxlength="120" value="' + esc(a.title) + '"' + dis(!ed || locked) + " /></div>" +
        '<div class="field"><label for="aca-pfAgBk">Booking <span class="muted">(optional)</span></label><select id="aca-pfAgBk"' + dis(!ed || locked) + '><option value="">None</option>' +
          (a.bookings || []).map((b) => '<option value="' + esc(b.id) + '" data-day="' + esc(b.picture_day || "") + '" data-label="' + esc(b.label) + '"' + (b.id === a.booking_id ? " selected" : "") + ">" + esc(b.label + " " + day(b.picture_day)) + "</option>").join("") + "</select></div></div>" +
        '<div class="pf-row2"><div class="field"><label for="aca-pfAgDay">Picture day</label><input type="date" id="aca-pfAgDay" value="' + esc(a.picture_day || "") + '"' + dis(!ed || locked) + " /></div>" +
        '<div class="field"><label for="aca-pfAgJob">What we provide</label><input type="text" id="aca-pfAgJob" maxlength="200" value="' + esc(a.job) + '" placeholder="Team and individual photos"' + dis(!ed || locked) + " /></div></div>" +
        '<div class="field"><label for="aca-pfAgPrice">Pricing</label><textarea id="aca-pfAgPrice" class="pf-short"' + dis(!ed || locked) + ' placeholder="Families order online. Packages from $25.">' + esc(a.pricing) + "</textarea></div>" +
        '<div class="field"><label for="aca-pfAgPay">Payout or donation</label><textarea id="aca-pfAgPay" class="pf-short"' + dis(!ed || locked) + ' placeholder="15% of online sales, paid to the league within 30 days of the order deadline.">' + esc(a.payout) + "</textarea></div>" +
        (built
          ? (locked ? '<div class="pf-sec">What they accepted</div>' : '<div class="pf-sec">Agreement</div>') +
            '<div class="pf-doc ab-doc">' + AgreementDoc.sanitize((locked && a.accepted_html) || a.doc_html || "") + "</div>" +
            '<p class="pf-help">' + (ed && !locked ? '<button type="button" class="link" id="aca-pfAgBuild">Edit in builder</button>' : "") +
              (ed && a.status === "accepted" ? '<button type="button" class="link" id="aca-pfAgNext">Start next year&#8217;s from this one</button>' : "") +
              (a.copy_note ? " " + esc(a.copy_note) : "") + "</p>"
          : locked
          ? '<div class="pf-sec">What they accepted</div><div class="pf-doc">' + esc(a.rendered) + "</div>"
          : '<div class="field"><label for="aca-pfAgTerms">Wording</label><textarea id="aca-pfAgTerms" class="pf-terms"' + dis(!ed) + ">" + esc(a.terms) + "</textarea></div>" +
            '<p class="pf-help">Fill-ins: ' + HELP.terms + '. <button type="button" class="link" id="aca-pfAgPrev">Preview what they&#8217;ll see</button></p>') +
        '<div class="pf-sec">Paperwork</div>' +
        '<div class="pf-row2"><div class="field"><label for="aca-pfAgW9">W-9</label>' + docSel("pfAgW9", a.w9_status) + '</div><div class="field"><label for="aca-pfAgW9At">Date</label><input type="date" id="aca-pfAgW9At" value="' + esc(a.w9_at || "") + '"' + dis(!ed) + " /></div></div>" +
        fileRow("w9", a.w9_path) +
        '<div class="pf-row3"><div class="field"><label for="aca-pfAgCoi">Insurance certificate</label>' + docSel("pfAgCoi", a.coi_status) + '</div><div class="field"><label for="aca-pfAgCoiAt">Date</label><input type="date" id="aca-pfAgCoiAt" value="' + esc(a.coi_at || "") + '"' + dis(!ed) + " /></div>" +
        '<div class="field"><label for="aca-pfAgCoiExp">Expires</label><input type="date" id="aca-pfAgCoiExp" value="' + esc(a.coi_expires || "") + '"' + dis(!ed) + " /></div></div>" +
        fileRow("coi", a.coi_path) +
        '<div class="pf-row2"><div class="field"><label for="aca-pfAgRenew">Renewal date</label><input type="date" id="aca-pfAgRenew" value="' + esc(a.renewal_date || "") + '"' + dis(!ed) + " /></div>" +
        '<div class="field"><label for="aca-pfAgNote">Note</label><input type="text" id="aca-pfAgNote" maxlength="500" value="' + esc(a.note) + '"' + dis(!ed) + " /></div></div>" +
        '<div class="inline-error hidden" id="aca-pfAgEErr"></div>' +
        '<div class="modal-actions">' +
          (ed && a.status !== "void" ? '<button type="button" class="small" id="aca-pfAgVoid">Void</button>' : "") +
          (ed && a.status === "sent" ? '<button type="button" class="small" id="aca-pfAgUnsend">Back to draft</button>' : "") +
          '<span class="grow"></span>' +
          (a.status === "sent" || a.status === "accepted" ? '<button type="button" class="small" id="aca-pfAgView">Open their page</button>' : "") +
          (ed && !locked ? '<button type="button" class="small" id="aca-pfAgCopy">Copy link</button><button type="button" id="aca-pfAgEmail">Save and email it</button>' : "") +
          (ed ? '<button type="button" class="primary" id="aca-pfAgSave">Save</button>' : '<button type="button" class="small" id="aca-pfAgClose">Close</button>') +
        "</div>");
      const err = (t) => { const n = el("pfAgEErr"); n.textContent = t; n.classList.remove("hidden"); };
      const paths = { w9: a.w9_path || "", coi: a.coi_path || "" };
      if (el("pfAgClose")) el("pfAgClose").addEventListener("click", () => m.close());
      // Picking a booking fills in its date and job.
      el("pfAgBk").addEventListener("change", () => {
        const o = el("pfAgBk").selectedOptions[0];
        if (o && o.dataset.day) { el("pfAgDay").value = o.dataset.day; if (!el("pfAgJob").value) el("pfAgJob").value = o.dataset.label || ""; }
      });
      m.querySelectorAll(".pf-file").forEach((box) => {
        const what = box.dataset.what, inp = box.querySelector("input[type=file]"), up = box.querySelector("[data-up]"), op = box.querySelector("[data-open]");
        if (op) op.addEventListener("click", () => openFile(op.dataset.open));
        if (!up) return;
        up.addEventListener("click", () => inp.click());
        inp.addEventListener("change", async () => {
          const f = inp.files && inp.files[0];
          if (!f) return;
          if (f.size > 10 * 1024 * 1024) return err("That file is over 10 MB.");
          up.disabled = true; up.textContent = "Uploading…";
          try {
            paths[what] = await upload(a.id, what, f);
            up.textContent = "Uploaded: " + f.name;
            const sel = el(what === "w9" ? "pfAgW9" : "pfAgCoi"), at = el(what === "w9" ? "pfAgW9At" : "pfAgCoiAt");
            sel.value = "on_file"; if (!at.value) at.value = todayStr();
          } catch (e) { up.disabled = false; up.textContent = "Upload file"; err(cleanErr(e)); }
        });
      });
      const gather = () => {
        const p = { renewal_date: el("pfAgRenew").value, note: el("pfAgNote").value, w9_status: el("pfAgW9").value, w9_at: el("pfAgW9At").value, w9_path: paths.w9,
          coi_status: el("pfAgCoi").value, coi_at: el("pfAgCoiAt").value, coi_expires: el("pfAgCoiExp").value, coi_path: paths.coi };
        if (!locked) Object.assign(p, { title: el("pfAgTitle").value, booking_id: el("pfAgBk").value, picture_day: el("pfAgDay").value, job: el("pfAgJob").value,
          pricing: el("pfAgPrice").value, payout: el("pfAgPay").value }, el("pfAgTerms") ? { terms: el("pfAgTerms").value } : {});
        return p;
      };
      const save = async () => {
        const { error: e2 } = await sb.rpc("agreement_save", { p_id: a.id, p: gather() });
        if (e2) { err(cleanErr(e2)); return false; }
        return true;
      };
      if (el("pfAgSave")) el("pfAgSave").addEventListener("click", async () => { if (await save()) { m.close(); toast("Saved."); loadAgreements(); } });
      if (el("pfAgPrev")) el("pfAgPrev").addEventListener("click", async () => {
        if (!(await save())) return;
        const { data: fresh } = await sb.rpc("agreement_get", { p_id: a.id });
        openModal("<h2>What they&#8217;ll see</h2><div class=\"pf-doc\" style=\"max-height:none\">" + esc((fresh && fresh.rendered) || "") + "</div>");
      });
      if (el("pfAgEmail")) el("pfAgEmail").addEventListener("click", async () => {
        if (!(await save())) return;
        m.close();
        compose("agreement", a.id, loadAgreements);
        loadAgreements();
      });
      if (el("pfAgCopy")) el("pfAgCopy").addEventListener("click", async () => {
        if (!(await save())) return;
        if (a.status === "draft") {
          if (!confirm("Copy the link and mark this agreement as sent? Anyone with the link can read and accept it.")) return;
          const { error: e3 } = await sb.rpc("agreement_set_status", { p_id: a.id, p_status: "sent" });
          if (e3) return err(cleanErr(e3));
        }
        try { await navigator.clipboard.writeText(agLink(a.token)); toast("Link copied."); } catch (_e) { prompt("Copy this link:", agLink(a.token)); }
        m.close();
        loadAgreements();
      });
      if (el("pfAgView")) el("pfAgView").addEventListener("click", () => window.open(agLink(a.token), "_blank", "noopener"));
      if (el("pfAgBuild")) el("pfAgBuild").addEventListener("click", async () => { if (!(await save())) return; m.close(); AgreementBuilder.open(a.org_id, { id: a.id, onDone: loadAgreements }); });
      if (el("pfAgNext")) el("pfAgNext").addEventListener("click", () => { m.close(); AgreementBuilder.open(a.org_id, { copyFrom: a.id, onDone: loadAgreements }); });
      const setStatus = async (s, q) => {
        if (q && !confirm(q)) return;
        const { error: e4 } = await sb.rpc("agreement_set_status", { p_id: a.id, p_status: s });
        if (e4) return err(cleanErr(e4));
        m.close(); toast("Saved."); loadAgreements();
      };
      if (el("pfAgVoid")) el("pfAgVoid").addEventListener("click", () => setStatus("void", "Void this agreement? The link stops working and any email still waiting is skipped."));
      if (el("pfAgUnsend")) el("pfAgUnsend").addEventListener("click", () => setStatus("draft", "Back to draft? The link stops working until you send it again."));
    }
    async function loadAgreementAttention() {
      try {
        const { data, error } = await sb.rpc("agreements_attention");
        if (error) throw error;
        setAttention("agreementsRenew", num(data && data.renew), "Agreements to renew", "agreements");
        setAttention("agreementsCoi", num(data && data.coi), "Insurance certificates expiring", "agreements");
      } catch (_e) { /* Today reports it as unchecked */ }
    }

    // editTemplates: also opened from Settings > Email library > Partner emails (ws/settings).
    return { showRebook, showReviews, showAgreements, loadRebookAttention, loadAgreementAttention, compose, newAgreement, openAgreement, editTemplates };
  })();

  // ---------------------------------------------------------------- the public agreement page
  // https://admin.207photo.com/#agree/<token>: what the league or school sees. No sign-in; the database only
  // answers for this token (agreement_public / agreement_accept, granted to anon).
  const Agree = (function () {
    const token = () => ((location.hash.match(/^#agree\/([0-9a-f]{20,64})\b/) || [])[1] || "");
    const wanted = () => !!token();
    const longDay = (d) => (d ? new Date(String(d).slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "");
    async function show() {
      ["welcomeView", "loginView", "dashView"].forEach((id) => { const n = el(id); if (n) n.classList.add("hidden"); });
      let view = el("agreeView");
      if (!view) {
        view = document.createElement("div");
        view.id = "aca-agreeView"; view.className = "login-wrap";
        view.innerHTML = '<div class="login-card ag-card"><div class="wl-top"><img src="https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/icons/apple-touch-icon.png" alt="" class="wl-logo" />' +
          '<div><h1 id="aca-agTitle">207 Photo</h1><p class="sub" id="aca-agSub"></p></div></div><div id="aca-agBody"><p class="muted">Loading&#8230;</p></div></div>';
        document.querySelector(".aca").appendChild(view);
      }
      document.title = "Agreement | 207 Photo";
      const { data, error } = await supabase.rpc("agreement_public", { p_token: token() });
      if (error || !data || !data.found) {
        el("agBody").innerHTML = "<p>This link isn&#8217;t working. It may have been replaced by a newer one. Reply to our email and we&#8217;ll send a fresh link.</p>";
        return;
      }
      el("agTitle").textContent = data.title || "Agreement";
      el("agSub").textContent = (data.org || "") + (data.picture_day ? " · Picture day " + longDay(data.picture_day) : "");
      render(data);
    }
    function render(d) {
      const done = d.status === "accepted";
      el("agBody").innerHTML = (done ? '<div class="ag-done"><b>Accepted</b> by ' + esc(d.accepted_name) + (d.accepted_title ? ", " + esc(d.accepted_title) : "") +
          " on " + esc(longDay(d.accepted_at)) + ". Thank you! " + (d.copy_now === "scheduled" || d.copy_now === "review" ? "We&#8217;ll email you a copy, and you can print one now." : "Keep a copy with the Print button.") + "</div>" : "") +
        (d.html && typeof AgreementDoc !== "undefined" ? (AgreementDoc.ensureCss(), '<div class="ag-text ab-doc">' + AgreementDoc.sanitize(d.html) + "</div>") : '<div class="ag-text">' + esc(d.text) + "</div>") +
        (done ? '<div class="modal-actions ag-print-hide"><button type="button" class="small" id="aca-agPrint">Print or save a copy</button></div>'
          : '<form id="aca-agForm" class="ag-print-hide" autocomplete="on">' +
            '<div class="field"><label for="aca-agName">Your full name</label><input type="text" id="aca-agName" autocomplete="name" maxlength="120" required /></div>' +
            '<div class="field"><label for="aca-agRole">Your role <span class="muted">(optional)</span></label><input type="text" id="aca-agRole" autocomplete="organization-title" maxlength="120" placeholder="President, athletic director&#8230;" /></div>' +
            '<div class="field"><label for="aca-agEmail">Your email, for your copy <span class="muted">(optional)</span></label><input type="email" id="aca-agEmail" autocomplete="email" maxlength="200" placeholder="We&#8217;ll email you a copy" /></div>' +
            '<label class="ag-check"><input type="checkbox" id="aca-agOk" /> <span>I have read this agreement and accept it for ' + esc(d.org || "our organization") + ". Typing my name counts as my signature.</span></label>" +
            '<button type="submit" class="primary" id="aca-agGo">Accept agreement</button>' +
            '<div class="login-error hidden" id="aca-agErr" role="alert"></div>' +
            '<p class="muted" style="font-size:12.5px;margin:12px 0 8px">Questions or changes? Just reply to our email before accepting.</p>' +
            '<button type="button" class="small" id="aca-agPrint">Print or save a copy</button></form>');
      el("agPrint").addEventListener("click", () => window.print());
      if (done) return;
      el("agForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errBox = el("agErr"), fail = (t) => { errBox.textContent = t; errBox.classList.remove("hidden"); };
        const name = el("agName").value.trim();
        if (name.length < 3) return fail("Type your full name.");
        if (!el("agOk").checked) return fail("Tick the box to accept.");
        const email = el("agEmail").value.trim();
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("That email doesn't look right. Fix it, or leave it blank.");
        el("agGo").disabled = true;
        const { data, error } = await supabase.rpc("agreement_accept", Object.assign({ p_token: token(), p_name: name, p_title: el("agRole").value.trim() }, email ? { p_email: email } : {}));
        el("agGo").disabled = false;
        if (error || !data || !data.ok) return fail((data && data.error) || "Something went wrong. Please try again, or reply to our email.");
        d.status = "accepted"; d.accepted_name = data.accepted_name; d.accepted_title = el("agRole").value.trim(); d.accepted_at = data.accepted_at; d.copy_now = data.copy;
        render(d);
        window.scrollTo(0, 0);
      });
    }
    return { wanted, show };
  })();
