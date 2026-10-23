  // ================================================================ STAFF: Staff records (2026-10-22)
  // Clearances: background checks, SafeSport, school fingerprinting and any other kind, with the date done and
  // the date it runs out. A kind marked "needed for schools" must be current for everyone on the schedule for a
  // booked school job; the page, Today and a morning push (staff_records_push) warn when it isn't.
  // Onboarding: the checklist every new person goes through (everyone added to the team from now on starts on
  // it). Steps tied to a clearance tick themselves; "they can tick it" steps the person ticks on their phone.
  // View = your own records; Edit = everyone's. RPCs: staff_records / staff_clearance_save / _remove /
  // staff_clearance_type_save / staff_onboarding_set / _check / _step_save / staff_records_attention.
  registerPage({ id: "clearances", group: "Staff", section: "staff", module: "staffrecords", title: "Staff records", selfService: true, // View = your own records
                 tabs: [["clearances", "Clearances"], ["onboarding", "Onboarding"]], onShow: (tab) => StaffRecords.show(tab) });
  registerAttention("staffSchoolClearance", { module: "staffrecords", level: "err", name: "school clearances",
    one: "Someone on a school job in the next 30 days isn't cleared.", many: "{n} people on school jobs in the next 30 days aren't cleared." });
  registerAttention("staffClearanceExpiring", { module: "staffrecords", level: "soon", name: "clearances running out",
    one: "A staff clearance runs out soon or has run out.", many: "{n} staff clearances run out soon or have run out." });
  registerAttention("staffOnboarding", { module: "staffrecords", level: "soon", name: "onboarding",
    one: "A new person is still working through onboarding.", many: "{n} new people are still working through onboarding." });
  registerTodayLoader("staffrecords", () => StaffRecords.loadAttention());

  const StaffRecords = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .sr-grid td.sr-cell { white-space: nowrap; }
    .aca .sr-grid td.sr-cell button { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; height: auto; padding: 2px 0; border: 0; background: transparent; font-weight: 400; text-align: left; }
    .aca .sr-grid td.sr-cell button:hover:not(:disabled) { background: transparent; text-decoration: underline; text-decoration-color: var(--accent); }
    .aca .sr-grid td.sr-cell button:disabled { color: inherit; opacity: 1; cursor: default; }
    .aca .sr-grid td.sr-cell .muted { display: block; font-size: 12px; }
    .aca .sr-grid th small { display: block; font-weight: 400; color: var(--accent); }
    .aca .sr-warn { list-style: none; margin: 8px 0 0; padding: 0; }
    .aca .sr-warn li { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; padding: 9px 0; border-bottom: 1px solid var(--line2); font-size: 14px; }
    .aca .sr-warn li .d { min-width: 92px; font-weight: 600; }
    .aca .sr-warn li .grow { flex: 1; min-width: 0; }
    .aca .sr-person { padding: 14px 0 6px; border-bottom: 1px solid var(--border); }
    .aca .sr-person-h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .aca .sr-person-h h3 { margin: 0; font-size: 15px; }
    .aca .sr-person-h .grow { flex: 1; }
    .aca .sr-bar { flex: 0 0 120px; height: 6px; border-radius: 3px; background: var(--line2); overflow: hidden; }
    .aca .sr-bar i { display: block; height: 100%; background: var(--ok-fg); }
    .aca .sr-steps { list-style: none; margin: 6px 0 0; padding: 0; }
    .aca .sr-steps li { display: flex; gap: 10px; align-items: flex-start; padding: 7px 0; font-size: 14px; }
    .aca .sr-steps input { margin-top: 3px; width: 18px; height: 18px; flex: none; }
    .aca .sr-steps li.done .t { color: var(--muted); text-decoration: line-through; }
    .aca .sr-steps .s { display: block; color: var(--muted); font-size: 12.5px; }
    .aca .sr-quick { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .aca .sr-modal .field input[type=text], .aca .sr-modal .field input[type=url], .aca .sr-modal .field select, .aca .sr-modal .field textarea { width: 100%; }
    .aca .sr-modal textarea { height: 60px; padding: 6px 10px; }
    .aca .sr-modal .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .aca .sr-list { margin: 6px 0 12px; border-top: 1px solid var(--line2); }
    .aca .sr-list > div { display: flex; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; }
    .aca .sr-list > div .grow { flex: 1; min-width: 0; }
    .aca .sr-listh { margin-bottom: -12px; border-top: 0; } .aca .sr-listh > div { color: var(--muted); font-weight: 600; padding: 2px 0; }
    @media (max-width: 700px) {
      .aca .sr-modal .row2 { grid-template-columns: 1fr; } .aca .sr-bar { flex-basis: 70px; }
      .aca .sr-grid thead { display: none; }
      .aca .sr-grid tr { display: block; padding: 8px 0; border-bottom: 1px solid var(--line2); }
      .aca .sr-grid td { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border: 0; }
      .aca .sr-grid td.sr-cell::before { content: attr(data-label); color: var(--muted); font-size: 13px; padding-top: 2px; white-space: normal; }
      .aca .sr-grid td.sr-cell button { align-items: flex-end; text-align: right; }
    }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    let data = null;
    const dayTxt = (d, o) => (d ? T.fmtDay(d, Object.assign({ weekday: undefined, year: "numeric" }, o || {})) : "");
    const typeOf = (k) => (data.types || []).find((t) => t.key === k);
    const personOf = (u) => (data.people || []).find((p) => p.user_id === u);
    const STATE = { ok: ["ok", "Current"], soon: ["warn", "Runs out soon"], expired: ["err", "Ran out"], missing: ["err", "Missing"] };

    // ---------------------------------------------------------------- panels
    el("panel-clearances").innerHTML =
      '<div class="card hidden" id="aca-srSchoolCard"><div class="card-head"><div><h2>School jobs</h2><p>Booked school jobs in the next 30 days with someone on the schedule whose school clearance is missing or runs out before that day.</p></div></div>' +
      '<ul class="sr-warn" id="aca-srSchool"></ul></div>' +
      '<div class="card"><div class="card-head"><div><h2>Clearances</h2><p id="aca-srClearIntro">Background checks, SafeSport and the rest, with when each one runs out. Kinds marked <b>for schools</b> must be current for anyone on a school job.</p></div>' +
      '<button type="button" class="small sr-edit" id="aca-srTypes">Kinds of clearance</button></div>' +
      '<div id="aca-srErr" class="inline-error hidden"></div><div class="table-wrap"><table class="sr-grid"><thead id="aca-srHead"></thead><tbody id="aca-srBody"><tr><td class="empty">Loading&#8230;</td></tr></tbody></table></div></div>';
    el("panel-onboarding").innerHTML =
      '<div class="card"><div class="card-head"><div><h2>Onboarding</h2><p id="aca-srObIntro">The checklist each new person works through. Everyone you add on the Team page starts on it. Steps tied to a clearance tick themselves when it is on file.</p></div>' +
      '<span class="sr-edit" style="display:flex;gap:8px"><button type="button" class="small" id="aca-srSteps">Edit steps</button><button type="button" class="primary" id="aca-srStart">Start someone who&#39;s already on the team</button></span></div>' +
      '<div id="aca-srObErr" class="inline-error hidden"></div><div id="aca-srOb"><p class="empty">Loading&#8230;</p></div></div>';

    async function load() {
      const { data: d, error } = await sb.rpc("staff_records");
      if (error) throw error;
      data = d || { types: [], steps: [], people: [], school: [] };
      document.querySelectorAll(".aca .sr-edit").forEach((n) => n.classList.toggle("hidden", !data.can_edit));
    }
    let current = "clearances";
    async function show(tab) {
      current = tab;
      const errId = tab === "onboarding" ? "srObErr" : "srErr";
      clearError(errId);
      try { await load(); } catch (e) { showError(errId, "Could not load staff records: " + cleanErr(e)); return; }
      if (tab === "onboarding") renderOnboarding(); else renderClearances();
    }
    const refresh = () => show(current);

    // ---------------------------------------------------------------- Clearances
    function renderClearances() {
      const types = data.types || [], people = data.people || [];
      el("srClearIntro").innerHTML = data.can_edit
        ? "Background checks, SafeSport and the rest, with when each one runs out. Kinds marked <b>for schools</b> must be current for anyone on a school job. Click a box to fill it in."
        : "Your clearances on file. When you renew one, send the office a copy so it can be updated here.";
      const school = data.school || [];
      el("srSchoolCard").classList.toggle("hidden", !school.length);
      el("srSchool").innerHTML = school.map((p) => '<li><span class="d">' + esc(T.fmtDay(p.day)) + '</span><span class="grow"><b>' + esc(p.name) + "</b> on " + esc(p.title) +
        '<br><span class="muted">' + esc(p.type_label) + ": " + (p.problem === "missing" ? "none on file" : "ran out " + esc(dayTxt(p.expires_on))) + "</span></span>" +
        (data.can_edit ? '<button type="button" class="small" data-u="' + esc(p.user_id) + '" data-t="' + esc(p.type_key) + '">Update</button>' : "") + "</li>").join("");
      el("srHead").innerHTML = "<tr><th>Person</th>" + types.map((t) => "<th>" + esc(t.label) + (t.school_required ? "<small>for schools</small>" : "") + "</th>").join("") + "</tr>";
      el("srBody").innerHTML = people.length ? people.map((p) => '<tr><td class="name">' + esc(p.name) + "</td>" + types.map((t) => {
        const c = (p.clearances || []).find((x) => x.type_key === t.key);
        const st = c ? STATE[c.state] : t.school_required ? STATE.missing : ["muted", "None"];
        const sub = c ? (c.expires_on ? (c.state === "expired" ? "ran out " : "until ") + dayTxt(c.expires_on) : c.done_on ? "done " + dayTxt(c.done_on) + ", no end date" : "no end date") : "";
        return '<td class="sr-cell" data-label="' + esc(t.label) + '"><button type="button" data-u="' + esc(p.user_id) + '" data-t="' + esc(t.key) + '"' + (data.can_edit ? "" : " disabled") + '><span class="pill ' + st[0] + '">' + st[1] + "</span>" +
          (sub ? '<span class="muted">' + esc(sub) + "</span>" : "") + "</button></td>";
      }).join("") + "</tr>").join("") : '<tr><td class="empty">Nobody yet.</td></tr>';
    }
    el("panel-clearances").addEventListener("click", (e) => {
      const b = e.target.closest("[data-u][data-t]");
      if (b && data && data.can_edit) editClearance(b.dataset.u, b.dataset.t);
    });
    el("srTypes").addEventListener("click", () => editTypes());

    function editClearance(userId, typeKey) {
      const p = personOf(userId), t = typeOf(typeKey);
      if (!p || !t) return;
      const c = (p.clearances || []).find((x) => x.type_key === typeKey) || { done_on: "", expires_on: "", reference: "", note: "" };
      const has = (p.clearances || []).some((x) => x.type_key === typeKey);
      const m = openModal('<div class="sr-modal"><h2>' + esc(t.label) + ": " + esc(p.name) + "</h2>" +
        '<div class="row2"><div class="field"><label for="aca-srDone">Done on</label><input type="date" id="aca-srDone" value="' + esc(c.done_on || "") + '" /></div>' +
        '<div class="field"><label for="aca-srExp">Runs out</label><input type="date" id="aca-srExp" value="' + esc(c.expires_on || "") + '" />' +
        '<div class="sr-quick"><button type="button" class="small" data-y="1">+1 year</button><button type="button" class="small" data-y="2">+2</button><button type="button" class="small" data-y="3">+3</button><button type="button" class="small quiet" data-y="0">Never</button></div></div></div>' +
        '<div class="field"><label for="aca-srRef">Certificate or reference number <span class="muted">(optional)</span></label><input type="text" id="aca-srRef" maxlength="120" value="' + esc(c.reference) + '" /></div>' +
        '<div class="field"><label for="aca-srNote">Note <span class="muted">(optional)</span></label><textarea id="aca-srNote" maxlength="500">' + esc(c.note) + "</textarea></div>" +
        '<div class="inline-error hidden" id="aca-srCErr"></div>' +
        '<div class="modal-actions">' + (has ? '<button type="button" class="small warn" id="aca-srCDel">Remove</button>' : "") +
        '<span class="grow"></span><button type="button" class="small" id="aca-srCCancel">Cancel</button><button type="button" class="primary" id="aca-srCSave">Save</button></div></div>');
      const err = (x) => { const n = el("srCErr"); n.textContent = x; n.classList.remove("hidden"); };
      m.querySelector(".sr-quick").addEventListener("click", (e) => {
        const b = e.target.closest("[data-y]"); if (!b) return;
        const y = +b.dataset.y;
        if (!y) { el("srExp").value = ""; return; }
        const from = el("srDone").value || T.today();
        el("srExp").value = (+from.slice(0, 4) + y) + from.slice(4);
      });
      el("srCCancel").addEventListener("click", () => m.close());
      el("srCSave").addEventListener("click", async () => {
        const done = el("srDone").value, exp = el("srExp").value;
        if (done && exp && exp < done) return err("It can't run out before it was done.");
        el("srCSave").disabled = true;
        const { error } = await sb.rpc("staff_clearance_save", { p: { user_id: userId, type_key: typeKey, done_on: done || null, expires_on: exp || null,
          reference: el("srRef").value.trim(), note: el("srNote").value.trim() } });
        el("srCSave").disabled = false;
        if (error) return err(cleanErr(error));
        m.close(); toast("Saved."); refresh();
      });
      if (!has) return;
      el("srCDel").addEventListener("click", async () => {
        if (!confirm("Remove " + p.name + "'s " + t.label + "?")) return;
        const { error } = await sb.rpc("staff_clearance_remove", { p_user: userId, p_type: typeKey });
        if (error) return err(cleanErr(error));
        m.close(); toast("Removed."); refresh();
      });
    }

    // Kinds of clearance and Onboarding steps: one dialog each, opened from Records / Onboarding and from
    // Settings > Team & pay (openKinds / openSteps make sure the records are loaded and say when something changed).
    let afterChange = null;
    const changed = () => { if (afterChange) afterChange(); };
    async function openKinds(opts) {
      afterChange = (opts && opts.onSaved) || null;
      try { await load(); } catch (e) { toast(cleanErr(e), true); return; }
      editTypes();
    }
    async function openSteps(opts) {
      afterChange = (opts && opts.onSaved) || null;
      try { await load(); } catch (e) { toast(cleanErr(e), true); return; }
      editSteps();
    }
    function editTypes() {
      const m = openModal('<div class="sr-modal"><h2>Kinds of clearance</h2><p class="muted">Tick <b>For schools</b> when every person on a school job needs it. "Warn" is how many days ahead it shows as running out.</p>' +
        ((data.types || []).length ? '<div class="sr-list sr-listh" aria-hidden="true"><div><span class="grow">Kind</span><span style="font-size:12px">For schools</span><span style="font-size:12px;width:96px">Warn (days)</span><span style="width:70px"></span></div></div>' : "") +
        '<div class="sr-list" id="aca-srTypeList">' + (data.types || []).map((t) => '<div data-k="' + esc(t.key) + '"><input type="text" class="grow" maxlength="80" value="' + esc(t.label) + '" aria-label="Name" />' +
          '<label style="white-space:nowrap;font-size:13px"><input type="checkbox" data-school' + (t.school_required ? " checked" : "") + " /> For schools</label>" +
          '<label style="white-space:nowrap;font-size:13px">Warn <input type="number" min="0" max="365" style="width:64px" data-warn value="' + num(t.warn_days) + '" aria-label="Warn days ahead" /></label>' +
          '<button type="button" class="small quiet" data-rm aria-label="Remove">Remove</button></div>').join("") + "</div>" +
        '<div class="field"><label for="aca-srNewType">Add a kind</label><input type="text" id="aca-srNewType" maxlength="80" placeholder="Mandated reporter training" /></div>' +
        '<div class="inline-error hidden" id="aca-srTErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-srTCancel">Cancel</button><button type="button" class="primary" id="aca-srTSave">Save</button></div></div>');
      const err = (x) => { const n = el("srTErr"); n.textContent = x; n.classList.remove("hidden"); };
      const removed = new Set();
      el("srTypeList").addEventListener("click", (e) => {
        const b = e.target.closest("[data-rm]"); if (!b) return;
        const row = b.closest("[data-k]");
        if (!confirm("Remove this kind of clearance? What's on file for it stays, but it stops showing and counting.")) return;
        removed.add(row.dataset.k); row.remove();
      });
      el("srTCancel").addEventListener("click", () => m.close());
      el("srTSave").addEventListener("click", async () => {
        el("srTSave").disabled = true;
        try {
          for (const k of removed) {
            const t = typeOf(k);
            const { error } = await sb.rpc("staff_clearance_type_save", { p: { key: k, label: t.label, archived: true } });
            if (error) throw error;
          }
          for (const row of m.querySelectorAll("[data-k]")) {
            const t = typeOf(row.dataset.k), label = row.querySelector("input[type=text]").value.trim();
            const school = row.querySelector("[data-school]").checked, warn = parseInt(row.querySelector("[data-warn]").value, 10);
            if (!label) throw new Error("Every kind needs a name.");
            if (!(warn >= 0 && warn <= 365)) throw new Error("Warn is 0 to 365 days.");
            if (label === t.label && school === t.school_required && warn === num(t.warn_days)) continue;
            const { error } = await sb.rpc("staff_clearance_type_save", { p: { key: t.key, label, school_required: school, warn_days: warn } });
            if (error) throw error;
          }
          const add = el("srNewType").value.trim();
          if (add) { const { error } = await sb.rpc("staff_clearance_type_save", { p: { label: add } }); if (error) throw error; }
          m.close(); toast("Saved."); refresh(); changed();
        } catch (e) { err(cleanErr(e)); } finally { if (el("srTSave")) el("srTSave").disabled = false; }
      });
    }

    // ---------------------------------------------------------------- Onboarding
    function stepsFor(p) {
      const done = {}; ((p.onboarding && p.onboarding.done) || []).forEach((d) => { done[d.step_id] = d; });
      return (data.steps || []).map((s) => ({ s, d: done[s.id] || null }));
    }
    function personBlock(p) {
      const rows = stepsFor(p), n = rows.filter((r) => r.d).length, total = rows.length, finished = p.onboarding.finished_at;
      return '<div class="sr-person" data-person="' + esc(p.user_id) + '"><div class="sr-person-h"><h3>' + esc(p.is_me && !data.can_edit ? "Your checklist" : p.name) + "</h3>" +
        '<span class="muted" style="font-size:12.5px">' + (finished ? "Finished " + esc(dayTxt(T.local(finished).day)) : "Started " + esc(dayTxt(p.onboarding.started_on))) + "</span>" +
        '<span class="grow"></span><span class="sr-bar" title="' + n + " of " + total + '"><i style="width:' + (total ? Math.round((100 * n) / total) : 100) + '%"></i></span>' +
        '<span style="font-size:13px;font-weight:600">' + n + " of " + total + "</span>" +
        (data.can_edit ? '<button type="button" class="small quiet" data-stop>Take off</button>' : "") + "</div>" +
        '<ul class="sr-steps">' + rows.map(({ s, d }) => {
          const auto = d && d.auto, mine = data.can_edit || (p.is_me && s.self_check);
          return '<li class="' + (d ? "done" : "") + '"><input type="checkbox" data-step="' + esc(s.id) + '"' + (d ? " checked" : "") + (auto || !mine || s.clearance_key && !d ? " disabled" : "") + ' aria-label="' + esc(s.title) + '" />' +
            '<span><span class="t">' + esc(s.title) + "</span>" + (s.link ? ' <a href="' + esc(s.link) + '" target="_blank" rel="noopener">Open</a>' : "") +
            '<span class="s">' + esc(auto ? "Done: on file under Clearances" : d ? "Ticked by " + (d.done_by || "someone") + ", " + dayTxt(T.local(d.done_at).day) : s.clearance_key ? "Ticks itself when " + ((typeOf(s.clearance_key) || {}).label || "the clearance") + " is on file" : s.detail || (s.self_check && p.is_me && !data.can_edit ? "You can tick this one" : "")) + "</span></span></li>";
        }).join("") + "</ul></div>";
    }
    function renderOnboarding() {
      const on = (data.people || []).filter((p) => p.onboarding);
      const open = on.filter((p) => !p.onboarding.finished_at), done = on.filter((p) => p.onboarding.finished_at);
      el("srObIntro").textContent = data.can_edit
        ? "The checklist each new person works through. Everyone you add on the Team page starts on it. Steps tied to a clearance tick themselves when it is on file."
        : "Your first steps at 207 Photo. Tick the ones marked for you as you finish them; the office ticks the rest.";
      if (!data.can_edit) {
        const me = on[0];
        el("srOb").innerHTML = me ? personBlock(me) : '<p class="empty">You have no onboarding checklist. You are all set.</p>';
        return;
      }
      el("srOb").innerHTML = (open.length ? open.map(personBlock).join("") : '<p class="empty">Nobody is onboarding right now. New people start automatically when you add them on the Team page.</p>') +
        (done.length ? '<details style="margin-top:14px"><summary class="muted" style="cursor:pointer;font-size:13px">Finished (' + done.length + ")</summary>" + done.map(personBlock).join("") + "</details>" : "");
    }
    el("srOb").addEventListener("change", async (e) => {
      const box = e.target.closest("[data-step]"); if (!box) return;
      const u = box.closest("[data-person]").dataset.person;
      box.disabled = true;
      const { data: r, error } = await sb.rpc("staff_onboarding_check", { p_user: u, p_step: box.dataset.step, p_done: box.checked });
      if (error) { box.checked = !box.checked; box.disabled = false; toast(cleanErr(error), true); return; }
      if (r && r.finished) toast(((personOf(u) || {}).is_me && !data.can_edit ? "You're" : ((personOf(u) || {}).name || "They") + " is") + " done with onboarding.");
      refresh();
    });
    el("srOb").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-stop]"); if (!b) return;
      const p = personOf(b.closest("[data-person]").dataset.person);
      if (!confirm("Take " + p.name + " off the onboarding checklist? Their ticks are cleared.")) return;
      const { error } = await sb.rpc("staff_onboarding_set", { p_user: p.user_id, p_on: false });
      if (error) { toast(cleanErr(error), true); return; }
      toast("Taken off."); refresh();
    });
    el("srStart").addEventListener("click", () => {
      const off = (data.people || []).filter((p) => !p.onboarding);
      if (!off.length) { toast("Everyone on the team is already on the checklist."); return; }
      const m = openModal('<div class="sr-modal"><h2>Start someone on onboarding</h2><p class="muted">For someone who joined before the checklist existed. New people start on their own.</p>' +
        '<div class="field"><label for="aca-srWho">Who</label><select id="aca-srWho">' + off.map((p) => '<option value="' + esc(p.user_id) + '">' + esc(p.name) + "</option>").join("") + "</select></div>" +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-srWCancel">Cancel</button><button type="button" class="primary" id="aca-srWGo">Start</button></div></div>');
      el("srWCancel").addEventListener("click", () => m.close());
      el("srWGo").addEventListener("click", async () => {
        const { error } = await sb.rpc("staff_onboarding_set", { p_user: el("srWho").value, p_on: true });
        if (error) { toast(cleanErr(error), true); return; }
        m.close(); toast("Started."); refresh();
      });
    });

    el("srSteps").addEventListener("click", () => editSteps());
    function editSteps() {
      const steps = data.steps || [];
      const m = openModal('<div class="sr-modal"><h2>Onboarding steps</h2><div class="sr-list" id="aca-srStepList">' +
        steps.map((s, i) => '<div data-id="' + esc(s.id) + '"><span class="grow"><b>' + esc(s.title) + "</b>" +
          '<span class="muted" style="display:block;font-size:12px">' + esc([s.self_check ? "they can tick it" : "", s.clearance_key ? "from " + ((typeOf(s.clearance_key) || {}).label || "a clearance") : "", s.link ? "has a link" : ""].filter(Boolean).join(" · ")) + "</span></span>" +
          '<button type="button" class="small quiet" data-up' + (i ? "" : " disabled") + ' aria-label="Move up">&uarr;</button><button type="button" class="small quiet" data-down' + (i < steps.length - 1 ? "" : " disabled") + ' aria-label="Move down">&darr;</button>' +
          '<button type="button" class="small" data-edit>Edit</button></div>').join("") + "</div>" +
        '<div class="modal-actions"><button type="button" class="small" id="aca-srStepAdd">Add step</button><span class="grow"></span><button type="button" class="primary" id="aca-srStepDone">Done</button></div></div>');
      el("srStepDone").addEventListener("click", () => { m.close(); changed(); });
      el("srStepAdd").addEventListener("click", () => { m.close(); editStep(null); });
      el("srStepList").addEventListener("click", async (e) => {
        const row = e.target.closest("[data-id]"); if (!row) return;
        const i = steps.findIndex((s) => s.id === row.dataset.id), s = steps[i];
        if (e.target.closest("[data-edit]")) { m.close(); editStep(s); return; }
        const j = e.target.closest("[data-up]") ? i - 1 : e.target.closest("[data-down]") ? i + 1 : -1;
        if (j < 0 || j >= steps.length) return;
        // Renumber in tens so a swap never ties.
        const order = steps.slice(); order.splice(i, 1); order.splice(j, 0, s);
        try {
          for (let k = 0; k < order.length; k++) {
            if (order[k].sort === (k + 1) * 10) continue;
            const o = order[k];
            const { error } = await sb.rpc("staff_onboarding_step_save", { p: { id: o.id, title: o.title, detail: o.detail, link: o.link, self_check: o.self_check, clearance_key: o.clearance_key, sort: (k + 1) * 10 } });
            if (error) throw error;
          }
          m.close(); await load(); renderOnboarding(); editSteps();
        } catch (er) { toast(cleanErr(er), true); }
      });
    }
    function editStep(s) {
      const isNew = !s;
      s = s || { title: "", detail: "", link: "", self_check: false, clearance_key: null };
      const m = openModal('<div class="sr-modal"><h2>' + (isNew ? "Add a step" : "Edit step") + "</h2>" +
        '<div class="field"><label for="aca-srSTitle">Step</label><input type="text" id="aca-srSTitle" maxlength="120" value="' + esc(s.title) + '" placeholder="Watch the training videos" /></div>' +
        '<div class="field"><label for="aca-srSDetail">Details <span class="muted">(optional)</span></label><textarea id="aca-srSDetail" maxlength="1000">' + esc(s.detail) + "</textarea></div>" +
        '<div class="field"><label for="aca-srSLink">Link <span class="muted">(optional: videos, a form, a guide)</span></label><input type="url" id="aca-srSLink" value="' + esc(s.link) + '" placeholder="https://" /></div>' +
        '<label class="tm-full"><input type="checkbox" id="aca-srSSelf"' + (s.self_check ? " checked" : "") + ' /> <span><b>They can tick it</b><br><span class="muted">The new person ticks it themselves, for example after watching a video.</span></span></label>' +
        '<div class="field"><label for="aca-srSClear">Ticks itself from a clearance</label><select id="aca-srSClear"><option value="">No</option>' +
          (data.types || []).map((t) => '<option value="' + esc(t.key) + '"' + (s.clearance_key === t.key ? " selected" : "") + ">" + esc(t.label) + "</option>").join("") + "</select></div>" +
        '<div class="inline-error hidden" id="aca-srSErr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" id="aca-srSDel">Remove step</button>') +
        '<span class="grow"></span><button type="button" class="small" id="aca-srSCancel">Cancel</button><button type="button" class="primary" id="aca-srSSave">' + (isNew ? "Add step" : "Save") + "</button></div></div>");
      const err = (x) => { const n = el("srSErr"); n.textContent = x; n.classList.remove("hidden"); };
      const back = async () => { m.close(); await load(); renderOnboarding(); editSteps(); };
      el("srSCancel").addEventListener("click", back);
      el("srSSave").addEventListener("click", async () => {
        const title = el("srSTitle").value.trim(), link = el("srSLink").value.trim();
        if (!title) return err("Give the step a name.");
        if (link && !/^https?:\/\//.test(link)) return err("The link should start with https://");
        el("srSSave").disabled = true;
        const { error } = await sb.rpc("staff_onboarding_step_save", { p: { id: s.id || null, title, detail: el("srSDetail").value.trim(), link,
          self_check: el("srSSelf").checked, clearance_key: el("srSClear").value || null, sort: s.sort || null } });
        el("srSSave").disabled = false;
        if (error) return err(cleanErr(error));
        toast(isNew ? "Added." : "Saved."); back();
      });
      if (isNew) return;
      el("srSDel").addEventListener("click", async () => {
        if (!confirm("Remove the step “" + s.title + "” from the checklist?")) return;
        const { error } = await sb.rpc("staff_onboarding_step_save", { p: { id: s.id, title: s.title, detail: s.detail, link: s.link, self_check: s.self_check, clearance_key: s.clearance_key, archived: true } });
        if (error) return err(cleanErr(error));
        toast("Removed."); back();
      });
    }

    // ---------------------------------------------------------------- Today
    async function loadAttention() {
      try {
        const { data: d, error } = await sb.rpc("staff_records_attention");
        if (error) throw error;
        setAttention("staffSchoolClearance", num(d && d.school), "People on school jobs who aren't cleared", "clearances");
        setAttention("staffClearanceExpiring", num(d && d.expiring), "Clearances running out", "clearances");
        setAttention("staffOnboarding", num(d && d.onboarding), "People onboarding", "onboarding");
      } catch (_e) { /* Today reports it as unchecked */ }
    }

    return { show, loadAttention, openKinds, openSteps };
  })();
