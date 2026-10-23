  // ================================================================ GEAR PER JOB (2026-10-23)
  // A gear list per job type (gear_templates) that every booked job gets its own copy of (booking_gear). A line is got
  // once something is checked out for the job against it, or ticked packed. A job in the next two days with a line
  // not got is flagged (here, the Inventory Jobs tab and Today). Scan to check out fills lines as labels are read.
  // RPCs: gear_templates_list / gear_template_save / gear_template_archive, job_gear, job_gear_check_out,
  // job_gear_pack, job_gear_line_add / _remove, job_gear_jobs. Module 'inventory': View = use it, Edit = change lists.
  const JobGear = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const addDays = (d, n) => { const t = new Date(d + "T12:00:00"); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };
    const dayTxt = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "");
    const soon = (d) => d && d >= todayStr() && d <= addDays(todayStr(), 2);
    const edit = () => canEdit("inventory");
    const me = () => ACCESS.user_id;
    const css = `
  .aca .jg-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 8px; }
  .aca .jg-head .grow { flex: 1; }
  .aca .jg-list { border-top: 1px solid var(--line2); }
  .aca .jg-line { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 2px; border-bottom: 1px solid var(--line2); font-size: 14px; }
  .aca .jg-dot { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--faint); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; }
  .aca .jg-line.got .jg-dot { border-color: var(--ok-fg, #1a7f37); background: var(--ok-fg, #1a7f37); color: #fff; }
  .aca .jg-line.got b { color: var(--muted); }
  .aca .jg-sub { display: block; font-size: 12.5px; color: var(--muted); }
  .aca .jg-warn { display: block; font-size: 12.5px; color: var(--err-fg); font-weight: 600; }
  .aca .jg-acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .aca .jg-h { margin: 14px 0 2px; font-size: 12px; font-weight: 600; color: var(--faint); }
  .aca .jg-type { margin: 0 0 14px; }
  .aca .jg-type h3 { margin: 0 0 4px; font-size: 14.5px; display: flex; align-items: center; gap: 8px; }
  .aca .jg-type h3 .grow { flex: 1; }
  .aca .jg-tl { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; }
  .aca .jg-tl .grow { flex: 1; min-width: 0; }
  @media (max-width: 700px) { .aca .jg-line { grid-template-columns: 26px minmax(0, 1fr); } .aca .jg-acts { grid-column: 2; justify-content: flex-start; } }
`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    let people = null;
    async function loadPeople() {
      if (people) return people;
      const { data, error } = await sb.rpc("inventory_people");
      if (error) throw error;
      return (people = data || []);
    }
    // Who it goes out to: you, or (Edit) anyone on the team.
    const whoField = (ppl) => edit()
      ? '<div class="field"><label for="aca-jgWho">Checking out to</label><select id="aca-jgWho">' +
          ppl.map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === me() ? " selected" : "") + ">" + esc(p.name) + (p.user_id === me() ? " (you)" : "") + "</option>").join("") + "</select></div>"
      : "";
    const whoValue = () => (el("jgWho") ? el("jgWho").value || null : null);

    // ---------------------------------------------------------------- one job
    // Draws the job's gear into box. booking: an id or an object with .id. Used by the job page and the Jobs tab.
    async function render(booking, box) {
      const id = booking && typeof booking === "object" ? booking.id || booking.booking_id : booking;
      if (!box) return;
      if (!canSee("inventory")) { box.innerHTML = '<p class="empty">You need Inventory access to see the gear for this job.</p>'; return; }
      box.innerHTML = '<p class="empty"><span class="spin"></span>Loading gear&#8230;</p>';
      const { data: D, error } = await sb.rpc("job_gear", { p_booking: id });
      if (error) { box.innerHTML = '<p class="inline-error">' + esc(cleanErr(error)) + "</p>"; return; }
      const b = D.booking, lines = D.lines || [], extras = D.extras || [];
      const got = lines.filter((l) => l.got).length, booked = b.status === "booked";
      const missing = booked && soon(b.picture_day) && got < lines.length;
      const line = (l) => '<div class="jg-line' + (l.got ? " got" : "") + '" data-line="' + esc(l.id) + '"><span class="jg-dot">' + (l.got ? "&#10003;" : "") + "</span>" +
        "<span><b>" + esc(l.label) + "</b>" + (num(l.qty) > 1 ? ' <span class="muted">&times; ' + num(l.qty) + "</span>" : "") +
        (l.note ? '<span class="jg-sub">' + esc(l.note) + "</span>" : "") +
        (l.checkout_id ? '<span class="jg-sub">' + (l.returned_at ? "Back from " : "Out with ") + esc(l.holder_name || "") +
            (l.out_what && l.out_what !== l.label ? " (" + esc(l.out_what) + ")" : "") + "</span>"
          : l.packed_at ? '<span class="jg-sub">Packed by ' + esc(l.packed_by || "someone") + "</span>" : "") +
        (l.warn ? '<span class="jg-warn">' + esc(l.warn) + "</span>" : "") + "</span>" +
        '<span class="jg-acts">' +
          (booked && !l.got && (l.kit_id || l.item_id) ? '<button type="button" class="small" data-co>Check out</button>' : "") +
          (booked && !l.got ? '<button type="button" class="small" data-pack>Packed</button>' : "") +
          (l.packed_at ? '<button type="button" class="small quiet" data-unpack>Undo</button>' : "") +
          (D.can_edit && !l.got ? '<button type="button" class="small quiet" data-rm title="Take off this job">&times;</button>' : "") +
        "</span></div>";
      box.innerHTML = '<div class="jg-head"><span class="grow"><b>' + got + " of " + lines.length + "</b> got" +
          (missing ? ' &nbsp;<span class="pill err">Missing gear</span>' : "") + (!booked ? ' &nbsp;<span class="pill">' + esc(b.status) + "</span>" : "") + "</span>" +
          (booked ? '<button type="button" class="primary small" data-scan>Scan to check out</button>' : "") +
          (D.can_edit && booked ? '<button type="button" class="small" data-add>Add a line</button>' : "") + "</div>" +
        (lines.length ? '<div class="jg-list">' + lines.map(line).join("") + "</div>"
          : '<p class="empty">No gear list for this job yet.' + (D.can_edit ? " Make one for its job type under Inventory, Jobs, or add a line here." : "") + "</p>") +
        (extras.length ? '<div class="jg-h">Also out for this job</div><div class="jg-list">' + extras.map((x) =>
          '<div class="jg-line got"><span class="jg-dot">&#10003;</span><span><b>' + esc(x.what) + '</b><span class="jg-sub">' + (x.returned_at ? "Back from " : "Out with ") + esc(x.holder_name) + "</span></span><span></span></div>").join("") + "</div>" : "");

      const again = () => render(id, box);
      const lineOf = (n) => lines.find((l) => l.id === n.closest("[data-line]").dataset.line);
      box.onclick = async (e) => {
        const t = e.target.closest("button");
        if (!t) return;
        if (t.hasAttribute("data-scan")) return scanOut(b, again);
        if (t.hasAttribute("data-add")) return addLine(b, again);
        const l = lineOf(t);
        if (!l) return;
        if (t.hasAttribute("data-co")) return checkOutLine(b, l, again);
        t.disabled = true;
        if (t.hasAttribute("data-pack") || t.hasAttribute("data-unpack")) {
          const { error: er } = await sb.rpc("job_gear_pack", { p_line: l.id, p_packed: t.hasAttribute("data-pack") });
          if (er) toast(cleanErr(er), true);
        } else if (t.hasAttribute("data-rm")) {
          if (!confirm("Take " + l.label + " off this job? The gear list for the job type doesn't change.")) { t.disabled = false; return; }
          const { error: er } = await sb.rpc("job_gear_line_remove", { p_line: l.id });
          if (er) toast(cleanErr(er), true);
        }
        again();
      };
    }

    async function checkOutLine(b, l, done) {
      let ppl = [];
      if (edit()) { try { ppl = await loadPeople(); } catch (e) { toast(cleanErr(e), true); return; } }
      const m = openModal("<h2>Check out " + esc(l.label) + "</h2><p>For " + esc(b.title) + ", " + esc(dayTxt(b.picture_day)) + ". Due back the day after.</p>" +
        (edit() ? whoField(ppl) : "<p>This checks it out to you, " + esc(ACCESS.name || "") + ".</p>") +
        '<div class="inline-error hidden" id="aca-jgCoErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-jgCoCancel">Cancel</button><button type="button" class="primary" id="aca-jgCoGo">Check out</button></div>');
      el("jgCoCancel").addEventListener("click", () => m.close());
      el("jgCoGo").addEventListener("click", async () => {
        el("jgCoGo").disabled = true;
        const { data, error } = await sb.rpc("job_gear_check_out", { p_booking: b.id, p_item: null, p_kit: null, p_line: l.id, p_holder: whoValue() });
        if (error) { const n = el("jgCoErr"); n.textContent = cleanErr(error); n.classList.remove("hidden"); el("jgCoGo").disabled = false; return; }
        m.close(); toast("Checked out to " + ((data && data.holder_name) || "you") + "."); done();
      });
    }

    // Scan labels one after another: each goes out for this job and fills its line.
    async function scanOut(b, done) {
      let ppl = [];
      if (edit()) { try { ppl = await loadPeople(); } catch (e) { toast(cleanErr(e), true); return; } }
      InvQR.scan({ title: "Check out for " + b.title, continuous: true, top: whoField(ppl),
        hint: "Scan each kit or item as you pack it. It goes out for this job, due back the day after picture day.",
        onClose: done,
        async onCode(text) {
          const r = await InvQR.resolve(text);
          if (r.kind === "bin") return { ok: false, msg: "That's the label for bin " + r.row.code + ". Scan the item or kit." };
          const { data, error } = await sb.rpc("job_gear_check_out", { p_booking: b.id, p_item: r.kind === "item" ? r.id : null, p_kit: r.kind === "kit" ? r.id : null, p_holder: whoValue() });
          if (error) return { ok: false, msg: r.name + ": " + cleanErr(error) };
          return { ok: true, msg: "✓ " + r.name + (data.line_id ? "" : " (not on the list, out for the job anyway)") };
        } });
    }

    async function addLine(b, done) {
      lineForm({ title: "Add to " + b.title, booking: true }, async (row) => {
        const { error } = await sb.rpc("job_gear_line_add", { p: Object.assign({ booking_id: b.id }, row) });
        if (error) throw error;
        done();
      });
    }

    // ---------------------------------------------------------------- a line form (job type list or one job)
    async function lineForm(o, save) {
      let kits = [], items = [];
      try {
        const [k, i] = await Promise.all([sb.from("inventory_kits_v").select("id,name,bin_code").order("name"), sb.from("inventory_items_v").select("id,name,serial,kit_name,bin_code").order("name")]);
        if (k.error) throw k.error; if (i.error) throw i.error;
        kits = k.data || []; items = i.data || [];
      } catch (e) { toast(cleanErr(e), true); return; }
      const r = o.line || {};
      const kind = r.kit_id ? "kit" : r.item_id ? "item" : r.id ? "words" : kits.length ? "kit" : "words";
      const m = openModal("<h2>" + esc(o.title) + "</h2>" +
        (o.types ? '<div class="field"><label for="aca-jgLType">Job type</label><select id="aca-jgLType"><option value="">Every job</option>' +
          o.types.map((t) => '<option value="' + esc(t.key) + '"' + (r.type_key === t.key ? " selected" : "") + ">" + esc(t.label) + "</option>").join("") + "</select></div>" : "") +
        '<div class="field"><label for="aca-jgLKind">What</label><select id="aca-jgLKind"><option value="kit">A kit</option><option value="item">An item</option><option value="words">Something else (just words)</option></select></div>' +
        '<div class="field" data-k="kit"><label for="aca-jgLKit">Kit</label><select id="aca-jgLKit">' + kits.map((k) => '<option value="' + esc(k.id) + '"' + (r.kit_id === k.id ? " selected" : "") + ">" + esc(k.name) + (k.bin_code ? " (bin " + esc(k.bin_code) + ")" : "") + "</option>").join("") + "</select></div>" +
        '<div class="field" data-k="item"><label for="aca-jgLItem">Item</label><select id="aca-jgLItem">' + items.map((i) => '<option value="' + esc(i.id) + '"' + (r.item_id === i.id ? " selected" : "") + ">" + esc(i.name) +
          (i.serial ? " · S/N " + esc(i.serial) : "") + (i.kit_name ? " (in " + esc(i.kit_name) + ")" : i.bin_code ? " (bin " + esc(i.bin_code) + ")" : "") + "</option>").join("") + "</select></div>" +
        '<div class="field" data-k="words"><label for="aca-jgLLabel">What to bring</label><input type="text" id="aca-jgLLabel" maxlength="120" placeholder="AA batteries" value="' + esc(r.label || "") + '" /></div>' +
        '<div class="inv-row2"><div class="field"><label for="aca-jgLQty">How many</label><input type="number" id="aca-jgLQty" min="1" max="1000" value="' + num(r.qty || 1) + '" /></div>' +
        '<div class="field"><label for="aca-jgLNote">Note <span class="muted">(optional)</span></label><input type="text" id="aca-jgLNote" maxlength="300" value="' + esc(r.note || "") + '" /></div></div>' +
        '<div class="inline-error hidden" id="aca-jgLErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-jgLCancel">Cancel</button><button type="button" class="primary" id="aca-jgLSave">' + (r.id ? "Save" : "Add") + "</button></div>");
      const sel = el("jgLKind");
      const sync = () => m.querySelectorAll("[data-k]").forEach((f) => f.classList.toggle("hidden", f.dataset.k !== sel.value));
      sel.value = kind; sel.addEventListener("change", sync); sync();
      if (!kits.length) sel.querySelector('option[value="kit"]').disabled = true;
      if (!items.length) sel.querySelector('option[value="item"]').disabled = true;
      el("jgLCancel").addEventListener("click", () => m.close());
      el("jgLSave").addEventListener("click", async () => {
        const k = sel.value, qty = parseInt(el("jgLQty").value, 10);
        const row = { kit_id: k === "kit" ? el("jgLKit").value : null, item_id: k === "item" ? el("jgLItem").value : null,
                      label: k === "words" ? el("jgLLabel").value.trim() : "", qty, note: el("jgLNote").value.trim() };
        if (o.types) row.type_key = el("jgLType").value || null;
        const err = (t) => { const n = el("jgLErr"); n.textContent = t; n.classList.remove("hidden"); };
        if (k === "words" && !row.label) return err("Say what to bring.");
        if (!(qty >= 1 && qty <= 1000)) return err("How many: 1 to 1000.");
        el("jgLSave").disabled = true;
        try { await save(row); m.close(); toast("Saved."); }
        catch (e) { err(cleanErr(e)); el("jgLSave").disabled = false; }
      });
    }

    // ---------------------------------------------------------------- Inventory > Jobs tab
    async function loadJobs() {
      clearError("jgErr");
      const [j, t] = await Promise.all([sb.rpc("job_gear_jobs", { p_days: 30 }), sb.rpc("gear_templates_list")]);
      if (j.error || t.error) { showError("jgErr", cleanErr(j.error || t.error)); return; }
      const jobs = j.data || [];
      el("jgJobsBody").innerHTML = jobs.length ? jobs.map((r) => {
        const all = num(r.lines), got = num(r.got), short = all - got;
        return '<tr data-job="' + esc(r.booking_id) + '" style="cursor:pointer"><td class="tnum">' + esc(dayTxt(r.picture_day)) + '</td><td class="name">' + esc(r.title) +
          '<div class="muted" style="font-size:12.5px">' + esc(r.type_label || "") + "</div></td><td>" +
          (!all ? '<span class="muted">No list</span>' : short ? '<span class="pill ' + (soon(r.picture_day) ? "err" : "warn") + '">' + got + " of " + all + "</span>" : '<span class="pill ok">All ' + all + "</span>") +
          "</td><td>" + (num(r.out) ? num(r.out) + " out" : '<span class="muted">&mdash;</span>') + "</td></tr>";
      }).join("") : '<tr><td colspan="4" class="empty">No booked jobs in the next 30 days.</td></tr>';
      renderLists(t.data || {});
    }

    function renderLists(T) {
      const lines = T.lines || [], types = [{ key: null, label: "Every job" }].concat(T.types || []);
      el("jgListAdd").classList.toggle("hidden", !T.can_edit);
      el("jgLists").innerHTML = types.map((ty) => {
        const ls = lines.filter((l) => (l.type_key || null) === ty.key);
        return '<div class="jg-type"><h3><span class="grow">' + esc(ty.label) + "</span>" +
          (T.can_edit ? '<button type="button" class="small" data-add-type="' + esc(ty.key || "") + '">Add</button>' : "") + "</h3>" +
          (ls.length ? ls.map((l) => '<div class="jg-tl" data-tl="' + esc(l.id) + '"><span class="grow"><b>' + esc(l.name) + "</b>" + (num(l.qty) > 1 ? ' <span class="muted">&times; ' + num(l.qty) + "</span>" : "") +
              ' <span class="muted">' + (l.kit_id ? "kit" : l.item_id ? "item" : "") + (l.note ? " · " + esc(l.note) : "") + "</span></span>" +
              (T.can_edit ? '<button type="button" class="small" data-tl-edit>Edit</button><button type="button" class="small quiet" data-tl-rm>Remove</button>' : "") + "</div>").join("")
            : '<p class="muted" style="font-size:13px;margin:4px 0">Nothing yet.</p>') + "</div>";
      }).join("");
      el("jgLists").onclick = async (e) => {
        const a = e.target.closest("[data-add-type]");
        if (a) return editTemplate(T, { type_key: a.dataset.addType || null });
        const row = e.target.closest("[data-tl]");
        if (!row) return;
        const l = lines.find((x) => x.id === row.dataset.tl);
        if (e.target.closest("[data-tl-edit]")) return editTemplate(T, l);
        if (e.target.closest("[data-tl-rm]")) {
          if (!confirm("Remove " + l.name + " from the list? Jobs that already have it checked out or packed keep it.")) return;
          const { error } = await sb.rpc("gear_template_archive", { p_id: l.id });
          if (error) { toast(cleanErr(error), true); return; }
          toast("Removed."); loadJobs();
        }
      };
      el("jgListAdd").onclick = () => editTemplate(T, {});
    }
    function editTemplate(T, l) {
      lineForm({ title: l.id ? "Edit " + l.name : "Add to a gear list", types: T.types || [], line: l }, async (row) => {
        const { error } = await sb.rpc("gear_template_save", { p: Object.assign(l.id ? { id: l.id } : {}, row) });
        if (error) throw error;
        loadJobs();
      });
    }

    function openJob(id, title) {
      const m = openModal("<h2>" + esc(title || "Gear for this job") + '</h2><div id="aca-jgModalBody"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="primary" id="aca-jgModalDone">Done</button></div>', { onClose: () => loadJobs() });
      el("jgModalDone").addEventListener("click", () => m.close());
      render(id, el("jgModalBody"));
    }
    el("jgJobsBody").addEventListener("click", (e) => {
      const r = e.target.closest("[data-job]");
      if (r) openJob(r.dataset.job, r.querySelector(".name").firstChild.textContent);
    });

    return { render, loadJobs };
  })();

  // The job page (one screen per job) shows a Gear tab when it exists.
  Promise.resolve().then(() => {
    if (typeof registerJobTab === "function") {
      registerJobTab({ id: "gear", label: "Gear", module: "inventory", order: 40, render: (booking, box) => JobGear.render(booking, box) });
    }
  });
