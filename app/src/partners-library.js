  // ================================================================ PARTNERS: Library (Prospects CRM stage 4)
  // Email sequences (tagged by sport / season / audience) and reusable snippets + quotes.
  // Editing a sequence changes FUTURE enrollments only: every enrolled org already has its own copy
  // of its emails (prospect_scheduled_emails). {{quote}} fills from the snippets (migration T09).
  const Library = (function () {
  const sb = supabase;
  const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
  const SEASONS = ["fall", "winter", "spring", "summer", "year-round"];
  const PLACEHOLDERS = [
    ["{{hi|Hey there}}", "“Hi Chris”, or the fallback after | when there is no first name"],
    ["{{first_name}}", "the contact's first name"],
    ["{{league|your league}}", "the organization's name (fallback when the name isn't known)"],
    ["{{sport}}", "the org's sport"], ["{{town}}", "the org's town"],
    ["{{personal_line|default opener}}", "the custom opening line typed when enrolling, else the default"],
    ["{{quote}}", "a quote from the library that matches the org's sport (rotates)"],
    ["{{quote2}}", "a second, different quote (the next best match), for a later email"],
  ];

  const css = `
  .aca .lb-table td, .aca .lb-table th { padding: 9px 14px; font-size: 13px; vertical-align: top; }
  .aca .lb-sub { font-size: 12px; color: var(--muted); }
  .aca .lb-body { white-space: pre-line; font-size: 12.5px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; max-width: 520px; }
  .aca .lb-help { font-size: 12.5px; padding: 10px 16px 14px; color: var(--muted); }
  .aca .lb-help code { font-size: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px; padding: 0 4px; color: var(--text); }
  .aca .lb-step { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-top: 10px; }
  .aca .lb-step-h { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; }
  .aca .lb-step textarea { min-height: 180px; margin-top: 8px; font-size: 13.5px; line-height: 1.5; }
  .aca .lb-step input[type=number] { width: 64px; }
  .aca .lb-att { font-size: 12px; margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
  /* Phone: each sequence/snippet is a card (name + on/off, tags, then full-width buttons) */
  @media (max-width: 760px) {
    .aca #aca-panel-library .card-head { flex-direction: column; align-items: stretch; gap: 10px; }
    .aca #aca-panel-library .card-head p { font-size: 12px; }
    .aca #aca-panel-library .card-head .og-actions button { min-height: 44px; width: 100%; }
    .aca .lb-table thead { display: none; }
    .aca .lb-table, .aca .lb-table tbody { display: block; }
    .aca .lb-table tr.lb-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "main st" "tags tags" "n n" "act act";
      gap: 4px 8px; padding: 12px; border-bottom: 1px solid var(--border); }
    .aca .lb-table tr.lb-row > td { display: block; padding: 0; border: none; }
    .aca .lb-table td.lb-main { grid-area: main; min-width: 0; }
    .aca .lb-table td.lb-st { grid-area: st; justify-self: end; }
    .aca .lb-table td.lb-tags { grid-area: tags; color: var(--muted); font-size: 12.5px; }
    .aca .lb-table td.lb-n { grid-area: n; color: var(--muted); font-size: 12.5px; }
    .aca .lb-table td.lb-act { grid-area: act; display: flex !important; gap: 8px; margin-top: 6px; }
    .aca .lb-table td.lb-act button { flex: 1 1 0; min-height: 44px; }
    .aca .lb-body { max-width: none; }
    .aca .lb-help { padding: 10px 12px 14px; }
    .aca .lb-step-h { flex-direction: column; align-items: flex-start; }
    .aca .lb-step .og-actions { flex-wrap: wrap; }
    .aca .lb-step textarea { min-height: 40vh; font-size: 16px; }
    .aca .lb-step input[type=text] { font-size: 16px; }
  }`;
  const styleTag = document.createElement("style");
  styleTag.textContent = css;
  document.head.appendChild(styleTag);

  const root = el("panel-library");
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div><h2>Email sequences</h2>
          <p>Tag each sequence with the sports and seasons it's written for. When you enroll an org, the best match is picked first (same sport, then same season, then general ones with no sport). Changes apply to future enrollments; orgs already enrolled keep their own copy, which you edit from their panel.</p></div>
        <div class="og-actions"><button type="button" class="small primary" id="aca-lbNewSeq">+ New sequence</button></div>
      </div>
      <div id="aca-lbSeqErr" class="inline-error hidden" style="margin-top:12px"></div>
      <div class="table-wrap"><table class="lb-table"><thead><tr><th>Sequence</th><th>For</th><th>Emails</th><th>Status</th><th></th></tr></thead>
        <tbody id="aca-lbSeqBody"><tr><td colspan="5" class="empty">Loading&hellip;</td></tr></tbody></table></div>
      <div class="lb-help"><strong>Placeholders</strong> you can use in any sequence email:
        ${PLACEHOLDERS.map((p) => `<div><code>${esc(p[0])}</code> ${esc(p[1])}</div>`).join("")}</div>
    </div>
    <div class="card">
      <div class="card-head">
        <div><h2>Quotes and snippets</h2>
          <p>Testimonials and reusable paragraphs. Tag them by sport so <code>{{quote}}</code> and the editor's Insert menu offer the right one. A quote tagged soccer goes to soccer leagues first; untagged ones are the fallback.</p></div>
        <div class="og-actions"><button type="button" class="small primary" id="aca-lbNewSn">+ New snippet</button></div>
      </div>
      <div id="aca-lbSnErr" class="inline-error hidden" style="margin-top:12px"></div>
      <div class="table-wrap"><table class="lb-table"><thead><tr><th>Snippet</th><th>For</th><th>Used</th><th>Status</th><th></th></tr></thead>
        <tbody id="aca-lbSnBody"><tr><td colspan="5" class="empty">Loading&hellip;</td></tr></tbody></table></div>
    </div>`;

  let seqs = [], steps = [], snippets = [], enrollCounts = new Map();
  async function load() {
    try {
      const [q, st, sn, en] = await Promise.all([
        sb.from("prospect_sequences").select("*").order("name"),
        sb.from("prospect_sequence_steps").select("*").order("step_no"),
        sb.from("prospect_snippets").select("*").order("title"),
        sb.from("prospect_enrollments").select("sequence_id"),
      ]);
      const err = q.error || st.error || sn.error || en.error;
      if (err) throw err;
      seqs = q.data || []; steps = st.data || []; snippets = sn.data || [];
      enrollCounts = new Map();
      (en.data || []).forEach((r) => enrollCounts.set(r.sequence_id, (enrollCounts.get(r.sequence_id) || 0) + 1));
      render();
      el("lbSeqErr").classList.add("hidden");
    } catch (e) { el("lbSeqErr").textContent = "Could not load: " + cleanErr(e); el("lbSeqErr").classList.remove("hidden"); }
  }
  const tags = (x) => [x.audience ? (x.audience === "school" ? "Schools" : "Leagues") : "Leagues + schools",
    (x.sports || []).length ? x.sports.join(", ") : "any sport", (x.seasons || []).join(", ")].filter(Boolean).join(" · ");
  function render() {
    el("lbSeqBody").innerHTML = seqs.length ? seqs.map((q) => {
      const n = steps.filter((s) => s.sequence_id === q.id).length;
      return `<tr class="lb-row"><td class="lb-main"><strong>${esc(q.name)}</strong><div class="lb-sub">${esc(q.key)}${enrollCounts.get(q.id) ? " &middot; used by " + enrollCounts.get(q.id) + " org" + (enrollCounts.get(q.id) === 1 ? "" : "s") : ""}</div></td>
        <td class="lb-tags">${esc(tags(q))}</td><td class="lb-n">${n} email${n === 1 ? "" : "s"}</td>
        <td class="lb-st">${q.is_active ? '<span class="pill ok">On</span>' : '<span class="pill muted">Off</span>'}</td>
        <td class="lb-act" style="white-space:nowrap"><button type="button" class="small" data-seq="${esc(q.id)}">Edit</button> <button type="button" class="small" data-dup="${esc(q.id)}">Duplicate</button></td></tr>`;
    }).join("") : '<tr><td colspan="5" class="empty">No sequences yet.</td></tr>';
    el("lbSnBody").innerHTML = snippets.length ? snippets.map((s) => `<tr class="lb-row"><td class="lb-main"><strong>${esc(s.title)}</strong> <span class="pill muted">${esc(s.kind)}</span><div class="lb-body">${esc(s.body)}</div></td>
        <td class="lb-tags">${esc(tags(s))}</td><td class="lb-n">used ${num(s.used_count)}&times;</td>
        <td class="lb-st">${s.is_active ? '<span class="pill ok">On</span>' : '<span class="pill muted">Off</span>'}</td>
        <td class="lb-act"><button type="button" class="small" data-sn="${esc(s.id)}">Edit</button></td></tr>`).join("")
      : '<tr><td colspan="5" class="empty">No snippets yet.</td></tr>';
  }

  // ---- shared bits
  function dialog(html) {
    const wrap = document.createElement("div");
    wrap.className = "og-modal-wrap";
    wrap.innerHTML = `<div class="og-modal wide" role="dialog" aria-modal="true">${html}</div>`;
    const box = wrap.firstElementChild;
    const onKey = (e) => { if (e.key === "Escape" && confirm("Close without saving?")) close(); };
    const close = () => { document.removeEventListener("keydown", onKey); wrap.remove(); };
    box.close = close;
    document.addEventListener("keydown", onKey);
    document.querySelector(".aca").appendChild(wrap);
    return box;
  }
  const seasonBoxes = (sel) => `<div class="og-seasons">${SEASONS.map((s) => `<label><input type="checkbox" data-season value="${s}" ${(sel || []).includes(s) ? "checked" : ""} /> ${s}</label>`).join("")}</div>`;
  const readSeasons = (box) => [...box.querySelectorAll("input[data-season]:checked")].map((i) => i.value);
  const readSports = (v) => v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + Math.random().toString(36).slice(2, 6);

  // ---- sequence editor
  function openSequence(q) {
    const isNew = !q;
    q = q || { name: "", audience: "league", sports: [], seasons: [], is_active: false };
    let list = isNew ? [{ step_no: 1, delay_business_days: 0, subject: "{{league|Your league}} picture day", body: "{{hi|Hey there}}!\n\n", attachments: [] }]
      : steps.filter((s) => s.sequence_id === q.id).map((s) => ({ ...s }));
    const box = dialog(`
      <h2>${isNew ? "New sequence" : "Edit sequence"}</h2>
      <div class="og-grid">
        <label for="aca-lbName">Name</label><input type="text" id="aca-lbName" value="${esc(q.name)}" />
        <label for="aca-lbAud">For</label><select id="aca-lbAud"><option value="league" ${q.audience === "league" ? "selected" : ""}>Leagues</option><option value="school" ${q.audience === "school" ? "selected" : ""}>Schools</option></select>
        <label for="aca-lbSports">Sports</label><input type="text" id="aca-lbSports" list="aca-ogSports" value="${esc((q.sports || []).join(", "))}" placeholder="Leave empty for a general sequence" />
        <label>Seasons</label>${seasonBoxes(q.seasons)}
        <label for="aca-lbFrom">Offer between</label><span><input type="date" id="aca-lbFrom" value="${esc(q.enroll_from || "")}" /> and <input type="date" id="aca-lbTo" value="${esc(q.enroll_to || "")}" /> <span class="lb-sub">(optional)</span></span>
        <label for="aca-lbOn">Turned on</label><span><input type="checkbox" id="aca-lbOn" ${q.is_active ? "checked" : ""} /> <span class="lb-sub">Only turned-on sequences are offered when enrolling.</span></span>
      </div>
      <div id="aca-lbSteps"></div>
      <div class="og-actions" style="margin-top:10px"><button type="button" class="small" data-v="add">+ Add email</button></div>
      <p class="lb-sub" style="margin:10px 0">Your signature and the not-interested line are added automatically. Follow-up emails reply in the same Gmail thread, so only email 1 has a subject.</p>
      <div id="aca-lbErr" class="inline-error hidden" style="margin:0 0 12px"></div>
      <div class="og-actions"><button type="button" class="primary" data-v="save">Save</button><button type="button" data-v="close">Cancel</button>
        ${isNew ? "" : '<button type="button" data-v="delete" style="margin-left:auto">Delete sequence</button>'}</div>`);
    const renderSteps = () => {
      el("lbSteps").innerHTML = list.map((s, i) => `<div class="lb-step" data-i="${i}">
        <div class="lb-step-h"><span>Email ${i + 1}</span>
          <span class="og-actions" style="flex-wrap:nowrap">${i ? `<label class="lb-sub" style="font-weight:400">sends <input type="number" min="0" data-f="delay_business_days" value="${num(s.delay_business_days)}" /> business days after email ${i}</label>` : '<span class="lb-sub" style="font-weight:400">sends in the first send window after approval</span>'}
          ${list.length > 1 ? `<button type="button" class="small" data-rm="${i}">Remove</button>` : ""}</span></div>
        ${i === 0 ? `<input type="text" data-f="subject" value="${esc(s.subject || "")}" placeholder="Subject" style="width:100%;margin-top:8px" />` : ""}
        <textarea data-f="body">${esc(s.body || "")}</textarea>
        ${(s.attachments || []).length ? `<div class="lb-att">${s.attachments.map((a, k) => `<span class="pill muted">${esc(a.filename)} <button type="button" class="link" data-att="${i}:${k}" title="Remove attachment">&#10005;</button></span>`).join("")}</div>` : ""}
      </div>`).join("");
    };
    const pull = () => el("lbSteps").querySelectorAll(".lb-step").forEach((d) => {
      const s = list[+d.dataset.i];
      d.querySelectorAll("[data-f]").forEach((f) => { s[f.dataset.f] = f.dataset.f === "delay_business_days" ? Math.max(0, parseInt(f.value, 10) || 0) : f.value; });
    });
    renderSteps();
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const err = (m) => { el("lbErr").textContent = m; el("lbErr").classList.remove("hidden"); };
      if (b.dataset.v === "close") return box.close();
      if (b.dataset.v === "add") { pull(); list.push({ delay_business_days: 3, subject: null, body: "{{hi|Hey there}}, ", attachments: [] }); renderSteps(); return; }
      if (b.dataset.rm) { pull(); if (confirm(`Remove email ${+b.dataset.rm + 1}?`)) { list.splice(+b.dataset.rm, 1); renderSteps(); } return; }
      if (b.dataset.att) { pull(); const [i, k] = b.dataset.att.split(":").map(Number); list[i].attachments = list[i].attachments.filter((_, j) => j !== k); renderSteps(); return; }
      if (b.dataset.v === "delete") {
        if (enrollCounts.get(q.id)) return err("Orgs have been enrolled in this sequence, so it stays for their history. Turn it off instead.");
        if (!confirm(`Delete "${q.name}"?`)) return;
        const { error } = await sb.from("prospect_sequences").delete().eq("id", q.id);
        if (error) return err(cleanErr(error));
        box.close(); toast("Deleted"); load(); return;
      }
      if (b.dataset.v !== "save") return;
      pull();
      const name = el("lbName").value.trim();
      if (!name) return err("Give the sequence a name.");
      if (!list.length || !list[0].subject || !list[0].subject.trim()) return err("Email 1 needs a subject.");
      if (list.some((s) => !String(s.body || "").trim())) return err("Every email needs some text.");
      const row = { name, audience: el("lbAud").value, sports: readSports(el("lbSports").value), seasons: readSeasons(box),
        season: readSeasons(box)[0] || null, enroll_from: el("lbFrom").value || null, enroll_to: el("lbTo").value || null, is_active: el("lbOn").checked };
      b.disabled = true;
      try {
        let id = q.id;
        if (isNew) {
          const { data, error } = await sb.from("prospect_sequences").insert({ ...row, key: slug(name) }).select("id").single();
          if (error) throw error; id = data.id;
        } else {
          const { error } = await sb.from("prospect_sequences").update(row).eq("id", id);
          if (error) throw error;
        }
        // steps: move kept ones out of the way (unique step_no), delete removed, then write final order
        const keep = new Set(list.filter((s) => s.id).map((s) => s.id));
        const removed = steps.filter((s) => s.sequence_id === id && !keep.has(s.id)).map((s) => s.id);
        if (removed.length) { const { error } = await sb.from("prospect_sequence_steps").delete().in("id", removed); if (error) throw error; }
        for (const [i, s] of list.entries()) if (s.id) { const { error } = await sb.from("prospect_sequence_steps").update({ step_no: 1000 + i }).eq("id", s.id); if (error) throw error; }
        for (const [i, s] of list.entries()) {
          const v = { step_no: i + 1, delay_business_days: i ? s.delay_business_days : 0, subject: i ? null : s.subject.trim(), body: s.body, attachments: s.attachments || [] };
          const { error } = s.id ? await sb.from("prospect_sequence_steps").update(v).eq("id", s.id)
            : await sb.from("prospect_sequence_steps").insert({ ...v, sequence_id: id });
          if (error) throw error;
        }
        box.close(); toast("Sequence saved"); load();
      } catch (e2) { b.disabled = false; err(cleanErr(e2)); }
    });
  }
  async function duplicate(q) {
    const name = prompt("Name for the copy (e.g. the same sequence for another sport):", "Copy of " + q.name);
    if (!name || !name.trim()) return;
    const { id: _id, key: _k, created_at: _c, updated_at: _u, ...rest } = q;
    const { data, error } = await sb.from("prospect_sequences").insert({ ...rest, name: name.trim(), key: slug(name), is_active: false }).select("*").single();
    if (error) { toast(cleanErr(error), true); return; }
    const rows = steps.filter((s) => s.sequence_id === q.id).map((s) => ({ sequence_id: data.id, step_no: s.step_no, delay_business_days: s.delay_business_days, subject: s.subject, body: s.body, attachments: s.attachments || [] }));
    if (rows.length) { const { error: e2 } = await sb.from("prospect_sequence_steps").insert(rows); if (e2) { toast(cleanErr(e2), true); return; } }
    toast("Copied (turned off until you're ready)");
    await load();
    openSequence(seqs.find((x) => x.id === data.id));
  }

  // ---- snippet editor
  function openSnippet(s) {
    const isNew = !s;
    s = s || { kind: "quote", title: "", body: "", attribution: "", sports: [], seasons: [], audience: "league", is_active: true };
    const box = dialog(`
      <h2>${isNew ? "New snippet" : "Edit snippet"}</h2>
      <div class="og-grid">
        <label for="aca-snKind">Type</label><select id="aca-snKind"><option value="quote" ${s.kind === "quote" ? "selected" : ""}>Quote (used by {{quote}})</option><option value="paragraph" ${s.kind === "paragraph" ? "selected" : ""}>Paragraph</option></select>
        <label for="aca-snTitle">Title</label><input type="text" id="aca-snTitle" value="${esc(s.title)}" placeholder="Who it's from, e.g. Bangor Soccer Club" />
        <label for="aca-snAttr">From</label><input type="text" id="aca-snAttr" value="${esc(s.attribution || "")}" placeholder="Name and role (for your reference)" />
        <label for="aca-snAud">For</label><select id="aca-snAud"><option value="" ${!s.audience ? "selected" : ""}>Leagues + schools</option><option value="league" ${s.audience === "league" ? "selected" : ""}>Leagues</option><option value="school" ${s.audience === "school" ? "selected" : ""}>Schools</option></select>
        <label for="aca-snSports">Sports</label><input type="text" id="aca-snSports" list="aca-ogSports" value="${esc((s.sports || []).join(", "))}" placeholder="Empty = any sport" />
        <label>Seasons</label>${seasonBoxes(s.seasons)}
        <label for="aca-snOn">Turned on</label><span><input type="checkbox" id="aca-snOn" ${s.is_active ? "checked" : ""} /></span>
      </div>
      <textarea id="aca-snBody" class="og-edbody" style="min-height:160px" placeholder="The text exactly as it should appear in the email">${esc(s.body)}</textarea>
      <div id="aca-snErr" class="inline-error hidden" style="margin:10px 0"></div>
      <div class="og-actions" style="margin-top:10px"><button type="button" class="primary" data-v="save">Save</button><button type="button" data-v="close">Cancel</button>
        ${isNew ? "" : '<button type="button" data-v="delete" style="margin-left:auto">Delete</button>'}</div>`);
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      const err = (m) => { el("snErr").textContent = m; el("snErr").classList.remove("hidden"); };
      if (b.dataset.v === "close") return box.close();
      if (b.dataset.v === "delete") {
        if (!confirm(`Delete "${s.title}"?`)) return;
        const { error } = await sb.from("prospect_snippets").delete().eq("id", s.id);
        if (error) return err(cleanErr(error));
        box.close(); toast("Deleted"); load(); return;
      }
      const row = { kind: el("snKind").value, title: el("snTitle").value.trim(), attribution: el("snAttr").value.trim() || null,
        audience: el("snAud").value || null, sports: readSports(el("snSports").value), seasons: readSeasons(box),
        is_active: el("snOn").checked, body: el("snBody").value.trim(), updated_at: new Date().toISOString() };
      if (!row.title || !row.body) return err("Add a title and the text.");
      b.disabled = true;
      const { error } = isNew ? await sb.from("prospect_snippets").insert(row) : await sb.from("prospect_snippets").update(row).eq("id", s.id);
      if (error) { b.disabled = false; return err(cleanErr(error)); }
      box.close(); toast("Saved"); load();
    });
  }

  el("lbNewSeq").addEventListener("click", () => openSequence(null));
  el("lbNewSn").addEventListener("click", () => openSnippet(null));
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.seq) openSequence(seqs.find((q) => q.id === b.dataset.seq));
    if (b.dataset.dup) duplicate(seqs.find((q) => q.id === b.dataset.dup));
    if (b.dataset.sn) openSnippet(snippets.find((s) => s.id === b.dataset.sn));
  });

  return { load };
  })();
