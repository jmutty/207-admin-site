  // ================================================================ STAFF: Time clock, round two (2026-10-23)
  // Expenses tab (#staff/expenses): receipts with a photo, approved one by one with Time clock Edit. Pay rates modal
  // (Timesheets > Pay rates, Edit): hourly, a day rate, or per job (1099s) by employment type, job title or person. A Time tab on the job
  // page: who clocked how long on that job, miles, expenses and estimated cost.
  // RPCs: expense_list / expense_save / expense_remove / expense_review / timeclock_rates / timeclock_rate_save /
  // timeclock_rate_remove / timeclock_job (migration 20261023141500). Receipt photos: private bucket `receipts`.
  const TimeClockExtra = (function () {
    const T = StaffTime;
    const sb = supabase;
    const BUCKET = "receipts";
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const money = (v) => "$" + num(v).toFixed(2);
    const CAT = { supplies: "Supplies", meals: "Meals", parking: "Parking", tolls: "Tolls", gear: "Gear", other: "Other" };
    const STATUS = { submitted: ["warn", "Waiting"], approved: ["ok", "Approved"], rejected: ["err", "Sent back"] };
    const TYPE = { full_time: "Full time", salaried: "Salaried", part_time: "Part time", contractor: "1099" };
    const mErrIn = (m) => (t) => { const n = m.querySelector(".tc-merr"); n.textContent = t; n.classList.remove("hidden"); };

    const css = `
    .aca .tx-rcpt { width: 44px; height: 44px; object-fit: cover; border-radius: 4px; border: 1px solid var(--border); display: block; }
    .aca .tx-rcpt-big { max-width: 100%; max-height: 60vh; display: block; margin: 0 0 10px; border-radius: 4px; }
    .aca .tx-photo { display: flex; gap: 12px; align-items: center; margin: 0 0 12px; }
    .aca .tx-photo img { width: 72px; height: 72px; object-fit: cover; border-radius: 4px; border: 1px solid var(--border); }
    .aca .tx-acts { display: flex; gap: 6px; justify-content: flex-end; white-space: nowrap; }
    .aca .tx-why { display: block; color: var(--err-fg, var(--warn-fg)); font-size: 12.5px; }
    .aca .tx-rates td, .aca .tx-rates th { padding: 7px 8px; font-size: 13px; }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    // Shrink to at most 1600px on the long side as JPEG, so a receipt stays readable but small.
    async function shrink(file) {
      if (file.type === "application/pdf") return file;
      let src;
      try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch (_e) {
        src = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("That file isn't a photo this browser can open.")); i.src = URL.createObjectURL(file); });
      }
      const w = src.width, h = src.height, k = Math.min(1, 1600 / Math.max(w, h));
      const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("Could not read the photo."))), "image/jpeg", 0.82));
    }
    const urls = {};   // path -> signed url
    async function sign(paths) {
      const want = [...new Set(paths.filter((p) => p && !urls[p]))];
      if (!want.length) return;
      const { data } = await sb.storage.from(BUCKET).createSignedUrls(want, 3600);
      (data || []).forEach((d) => { if (d.signedUrl) urls[d.path] = d.signedUrl; });
    }
    const isPdf = (p) => /\.pdf$/i.test(p || "");

    // ---------------------------------------------------------------- Expenses
    const root = el("panel-expenses");
    root.innerHTML =
      '<div class="tc-bar"><button type="button" class="small" data-x="prev" aria-label="Month before">&lsaquo;</button><button type="button" class="small" data-x="this">This month</button>' +
      '<button type="button" class="small" data-x="next" aria-label="Month after">&rsaquo;</button><h2 id="aca-txTitle">Expenses</h2><span class="grow"></span>' +
      '<label class="hidden" id="aca-txWhoWrap" style="font-size:13px">Showing <select class="small" id="aca-txWho"><option value="me">Mine</option><option value="all">Everyone</option></select></label>' +
      '<button type="button" class="primary small" data-x="add">Add expense</button><button type="button" class="small" data-x="csv">Download CSV</button></div>' +
      '<div id="aca-txErr" class="inline-error hidden"></div><div id="aca-txBody"><p class="empty">Loading&#8230;</p></div>';
    let month = null, xWho = null, xl = null;
    const monthStart = (day) => day.slice(0, 8) + "01";
    const addMonths = (day, n) => { const d = new Date(monthStart(day) + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

    async function loadExpenses() {
      if (!month) month = monthStart(T.today());
      clearError("txErr");
      el("txWhoWrap").classList.toggle("hidden", !canEdit("timeclock"));
      if (xWho == null) xWho = canEdit("timeclock") ? "all" : "me";
      el("txWho").value = xWho;
      el("txTitle").textContent = new Date(month + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
      try {
        const { data, error } = await sb.rpc("expense_list", { p_month: month, p_all: xWho === "all" });
        if (error) throw error;
        xl = data;
        await sign((xl.expenses || []).map((x) => x.receipt_path).filter((p) => p && !isPdf(p)));
        renderExpenses();
      } catch (e) { showError("txErr", "Could not load expenses: " + cleanErr(e)); }
    }
    function rowHtml(x, all) {
      const s = STATUS[x.status] || ["muted", x.status];
      const thumb = x.receipt_path ? (isPdf(x.receipt_path) ? '<span class="pill muted">PDF</span>' : urls[x.receipt_path] ? '<img class="tx-rcpt" alt="Receipt" src="' + esc(urls[x.receipt_path]) + '" />' : "") : '<span class="muted" style="font-size:12px">no receipt</span>';
      const acts = xl.can_edit && x.status !== "approved" ? '<button type="button" class="small" data-ok="' + esc(x.id) + '">Approve</button>' + (x.status === "submitted" ? '<button type="button" class="small" data-back="' + esc(x.id) + '">Send back</button>' : "") : "";
      return '<tr class="tc-row" data-exp="' + esc(x.id) + '"><td>' + thumb + '</td><td style="white-space:nowrap">' + esc(T.fmtDay(x.day)) + "</td>" + (all ? "<td>" + esc(T.shortName(x.name)) + "</td>" : "") +
        "<td>" + esc(CAT[x.category] || x.category) + (x.job_title ? '<span class="s" style="display:block;color:var(--muted);font-size:12px">' + esc(x.job_title) + "</span>" : "") +
        (x.note ? '<span class="s" style="display:block;color:var(--muted);font-size:12px">' + esc(x.note) + "</span>" : "") + "</td>" +
        '<td class="tc-num">' + money(x.amount) + '</td><td><span class="pill ' + s[0] + '">' + s[1] + "</span>" + (x.status === "rejected" && x.review_note ? '<span class="tx-why">' + esc(x.review_note) + "</span>" : "") +
        (x.status === "approved" && x.reviewed_by ? '<span class="s" style="display:block;color:var(--muted);font-size:12px">by ' + esc(T.shortName(x.reviewed_by)) + "</span>" : "") + "</td>" +
        '<td><div class="tx-acts">' + acts + "</div></td></tr>";
    }
    function renderExpenses() {
      const all = xWho === "all", list = xl.expenses || [];
      const inMonth = list.filter((x) => x.day >= month && x.day < addMonths(month, 1));
      const waiting = all ? list.filter((x) => x.status === "submitted" && !(x.day >= month && x.day < addMonths(month, 1))) : [];
      const sum = (l, st) => l.filter((x) => !st || x.status === st).reduce((n, x) => n + num(x.amount), 0);
      const head = '<div class="table-wrap"><table class="tc-week"><thead><tr><th></th><th>Day</th>' + (all ? "<th>Person</th>" : "") + '<th>For</th><th class="tc-num">Amount</th><th>Status</th><th></th></tr></thead><tbody>';
      el("txBody").innerHTML =
        '<p class="tc-sum">' + (inMonth.length ? money(sum(inMonth)) + " this month · " + money(sum(inMonth, "approved")) + " approved · " + money(sum(inMonth, "submitted")) + " waiting." : "No expenses this month.") +
        " Add a photo of the receipt. Approved expenses are paid back with payroll; mileage is separate (Mileage tab).</p>" +
        (waiting.length ? '<h3 style="margin:16px 0 8px;font-size:14px">Waiting from other months</h3>' + head + waiting.map((x) => rowHtml(x, all)).join("") + "</tbody></table></div>" : "") +
        (inMonth.length ? (waiting.length ? '<h3 style="margin:20px 0 8px;font-size:14px">This month</h3>' : "") + head + inMonth.map((x) => rowHtml(x, all)).join("") + "</tbody></table></div>" : "");
    }
    root.addEventListener("click", async (ev) => {
      const ok = ev.target.closest("[data-ok]"), back = ev.target.closest("[data-back]");
      if (ok || back) {
        ev.stopPropagation();
        const id = (ok || back).dataset[ok ? "ok" : "back"];
        let note = "";
        if (back) { note = prompt("Why is it going back? They will see this."); if (!note || !note.trim()) return; }
        (ok || back).disabled = true;
        try {
          const { error } = await sb.rpc("expense_review", { p_id: id, p_status: ok ? "approved" : "rejected", p_note: note || "" });
          if (error) throw error;
          toast(ok ? "Approved." : "Sent back."); loadExpenses(); TimeClock.loadAttention();
        } catch (e) { (ok || back).disabled = false; toast(cleanErr(e), true); }
        return;
      }
      const tr = ev.target.closest("[data-exp]");
      if (tr) return openExpense(xl.expenses.find((x) => x.id === tr.dataset.exp));
      const b = ev.target.closest("[data-x]"); if (!b) return;
      const v = b.dataset.x;
      if (v === "prev") month = addMonths(month, -1);
      else if (v === "next") month = addMonths(month, 1);
      else if (v === "this") month = monthStart(T.today());
      else if (v === "add") return openExpense(null);
      else if (v === "csv") return expensesCsv();
      loadExpenses();
    });
    el("txWho").addEventListener("change", () => { xWho = el("txWho").value; loadExpenses(); });

    function expensesCsv() {
      TimeClock.download("207-expenses-" + month.slice(0, 7) + ".csv", [["Date", "Name", "Amount", "For", "Job", "Note", "Status", "Reviewed by", "Review note"]]
        .concat((xl.expenses || []).map((x) => [x.day, x.name, num(x.amount).toFixed(2), CAT[x.category] || x.category, x.job_title || "", x.note, (STATUS[x.status] || [0, x.status])[1], x.reviewed_by || "", x.review_note || ""])));
    }

    async function openExpense(x) {
      const isNew = !x;
      const mine = !x || x.user_id === xl.me;
      const locked = x && x.status === "approved";
      if (x && !mine && !xl.can_edit) return;
      const people = isNew && xl.can_edit ? await TimeClock.people() : [];
      const jobs = xl.jobs || [];
      if (x && x.receipt_path && !urls[x.receipt_path]) await sign([x.receipt_path]);
      const m = openModal('<div class="tc-modal"><h2>' + (isNew ? "Add an expense" : locked ? "Expense" : "Change expense") + "</h2>" +
        (locked ? '<p class="tc-warn" style="background:var(--ok-bg);color:var(--ok-fg)">Approved' + (x.reviewed_by ? " by " + esc(x.reviewed_by) : "") + "." + (xl.can_edit ? " Reopen it to change it." : "") + "</p>" : "") +
        (x && x.status === "rejected" ? '<p class="tc-warn">Sent back: ' + esc(x.review_note) + " Fix it and save to send it again.</p>" : "") +
        (people.length ? '<div class="field"><label for="aca-txP">Person</label><select id="aca-txP">' + people.map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === xl.me ? " selected" : "") + ">" + esc(p.name) + "</option>").join("") + "</select></div>" : "") +
        '<div class="field"><label>Receipt</label><div class="tx-photo" id="aca-txPhoto"></div></div>' +
        '<div class="row2"><div class="field"><label for="aca-txA">Amount ($)</label><input type="number" id="aca-txA" min="0.01" max="10000" step="0.01" inputmode="decimal" value="' + esc(x ? x.amount : "") + '"' + (locked ? " disabled" : "") + " /></div>" +
          '<div class="field"><label for="aca-txD">Day</label><input type="date" id="aca-txD" value="' + esc(x ? x.day : T.today()) + '"' + (locked ? " disabled" : "") + " /></div></div>" +
        '<div class="field"><label for="aca-txC">What for</label><select id="aca-txC"' + (locked ? " disabled" : "") + ">" + Object.keys(CAT).map((k) => '<option value="' + k + '"' + (x && x.category === k ? " selected" : "") + ">" + CAT[k] + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="aca-txB">Job</label><select id="aca-txB"' + (locked ? " disabled" : "") + '><option value="">No job (say what in the note)</option>' +
          jobs.map((j) => '<option value="' + esc(j.booking_id) + '" data-day="' + esc(j.day) + '"' + (x && x.booking_id === j.booking_id && x.day === j.day ? " selected" : "") + ">" + esc(T.fmtDay(j.day) + " · " + j.title) + "</option>").join("") +
          (x && x.booking_id && !jobs.some((j) => j.booking_id === x.booking_id && j.day === x.day) ? '<option value="' + esc(x.booking_id) + '" selected>' + esc(x.job_title) + "</option>" : "") + "</select></div>" +
        '<div class="field"><label for="aca-txN">Note</label><input type="text" id="aca-txN" maxlength="300" placeholder="Batteries for the flashes, lunch for the crew…" value="' + esc(x ? x.note : "") + '"' + (locked ? " disabled" : "") + " /></div>" +
        '<div class="inline-error hidden tc-merr"></div>' +
        '<div class="modal-actions">' + (x && !locked ? '<button type="button" class="small warn" data-m="remove">Remove</button>' : "") +
          (locked && xl.can_edit ? '<button type="button" class="small" data-m="reopen">Reopen</button>' : "") + '<span class="grow"></span><button type="button" class="small" data-m="cancel">' + (locked ? "Close" : "Cancel") + "</button>" +
          (locked ? "" : '<button type="button" class="primary" data-m="save">' + (isNew ? "Add" : "Save") + "</button>") + "</div></div>");
      const mErr = mErrIn(m);
      let blob = null, ext = "jpg", removed = false;
      const box = el("txPhoto");
      const draw = (url, pdf) => {
        box.innerHTML = (pdf ? '<span class="pill muted">PDF</span>' + (url ? ' <a href="' + esc(url) + '" target="_blank" rel="noopener">Open</a>' : "") : url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener"><img alt="Receipt" src="' + esc(url) + '" /></a>' : "") +
          (locked ? "" : '<div><input type="file" accept="image/*,application/pdf" class="hidden" /><button type="button" class="small" data-pick>' + (url || pdf ? "Change" : "Add a photo") + "</button>" +
            (url || pdf ? ' <button type="button" class="small quiet" data-rm>Remove</button>' : '<div class="muted" style="font-size:12px">On a phone this opens the camera.</div>') + "</div>");
        const inp = box.querySelector("input[type=file]");
        if (!inp) return;
        box.querySelector("[data-pick]").addEventListener("click", () => inp.click());
        inp.addEventListener("change", async () => {
          const f = inp.files && inp.files[0]; if (!f) return;
          try { blob = await shrink(f); ext = f.type === "application/pdf" ? "pdf" : "jpg"; removed = false; draw(ext === "pdf" ? "" : URL.createObjectURL(blob), ext === "pdf"); }
          catch (e) { toast(cleanErr(e), true); }
        });
        const rm = box.querySelector("[data-rm]");
        if (rm) rm.addEventListener("click", () => { blob = null; removed = true; draw("", false); });
      };
      draw(x && x.receipt_path && !isPdf(x.receipt_path) ? urls[x.receipt_path] : (x && isPdf(x.receipt_path) ? urls[x.receipt_path] || "" : ""), !!(x && isPdf(x.receipt_path)));
      el("txB").addEventListener("change", () => { const o = el("txB").selectedOptions[0]; if (o && o.dataset.day) el("txD").value = o.dataset.day; });
      m.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "cancel") return m.close();
        if (b.dataset.m === "reopen") {
          b.disabled = true;
          try { const { error } = await sb.rpc("expense_review", { p_id: x.id, p_status: "submitted", p_note: "" }); if (error) throw error; m.close(); toast("Reopened."); loadExpenses(); }
          catch (e) { mErr(cleanErr(e)); b.disabled = false; }
          return;
        }
        if (b.dataset.m === "remove") {
          if (!confirm("Remove this expense?")) return;
          b.disabled = true;
          try {
            const { data, error } = await sb.rpc("expense_remove", { p_id: x.id }); if (error) throw error;
            if (data && data.receipt_path) sb.storage.from(BUCKET).remove([data.receipt_path]);
            m.close(); toast("Removed."); loadExpenses();
          } catch (e) { mErr(cleanErr(e)); b.disabled = false; }
          return;
        }
        const user = el("txP") ? el("txP").value : x ? x.user_id : xl.me;
        const p = { id: x ? x.id : null, user_id: user, day: el("txD").value, amount: el("txA").value, category: el("txC").value, booking_id: el("txB").value || null, note: el("txN").value.trim() };
        if (!p.day) return mErr("Pick the day.");
        if (!(parseFloat(p.amount) > 0)) return mErr("Enter the amount.");
        if (!p.booking_id && !p.note) return mErr("Say what it was for in the note.");
        if (isNew && !blob && !confirm("Add it without a photo of the receipt?")) return;
        b.disabled = true;
        let uploaded = null;
        try {
          if (blob) {
            uploaded = user + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
            const { error } = await sb.storage.from(BUCKET).upload(uploaded, blob, { contentType: ext === "pdf" ? "application/pdf" : "image/jpeg", upsert: false });
            if (error) throw error;
            p.receipt_path = uploaded;
          } else if (removed) p.receipt_path = null;
          const { error } = await sb.rpc("expense_save", { p });
          if (error) throw error;
          if ((uploaded || removed) && x && x.receipt_path) sb.storage.from(BUCKET).remove([x.receipt_path]);
          m.close(); toast(isNew ? "Added. A manager will approve it." : "Saved.");
          if (monthStart(p.day) !== month) month = monthStart(p.day);
          loadExpenses();
        } catch (e) {
          if (uploaded) sb.storage.from(BUCKET).remove([uploaded]);
          mErr(cleanErr(e)); b.disabled = false;
        }
      });
    }

    // ---------------------------------------------------------------- Pay rates (Edit)
    // Pay rates: one dialog, opened from Timesheets (Pay rates) and from Settings > Team & pay.
    async function openRates(opts) {
      opts = opts || {};
      const m = openModal('<div class="tc-modal" style="max-width:760px"><h2>Pay rates</h2>' +
        '<p class="muted" style="font-size:13px;margin:0 0 12px">For estimated pay on timesheets and the payroll CSV. A person’s own rate wins, then their job title’s, then their employment type’s (both set on the Team page). Hourly people get 1.5x after the overtime hours, unless they are salaried or 1099.</p>' +
        '<div id="aca-prtBody"><p class="empty">Loading&#8230;</p></div><div class="inline-error hidden tc-merr"></div>' +
        '<div class="modal-actions"><button type="button" class="small" data-m="add">Add a rate</button><span class="grow"></span><button type="button" class="primary" data-m="cancel">Done</button></div></div>');
      const mErr = mErrIn(m);
      let d = null;
      const scopeTxt = (r) => (r.scope === "type" ? TYPE[r.scope_key] || r.scope_key : r.scope === "title" ? "Job title: " + r.scope_key : r.name || "Someone");
      const rateTxt = (r) => (r.basis === "day" ? money(r.rate) + " a day" + (r.half_day_rate != null ? ", " + money(r.half_day_rate) + " a half day" : "") : r.basis === "job" ? money(r.rate) + " a job" : money(r.rate) + " an hour");
      async function load() {
        try {
          const { data, error } = await sb.rpc("timeclock_rates");
          if (error) throw error;
          d = data;
          el("prtBody").innerHTML = (d.rates.length ? '<div class="table-wrap"><table class="tx-rates"><thead><tr><th>For</th><th>Rate</th><th></th></tr></thead><tbody>' +
              d.rates.map((r) => '<tr class="tc-row" data-rate="' + esc(r.id) + '"><td>' + esc(scopeTxt(r)) + "</td><td>" + esc(rateTxt(r)) + '</td><td class="tc-num"><button type="button" class="small quiet">Change</button></td></tr>').join("") + "</tbody></table></div>"
              : '<p class="empty">No rates yet.</p>') +
            '<h3 style="margin:18px 0 6px;font-size:14px">Who gets what</h3><div class="table-wrap"><table class="tx-rates"><thead><tr><th>Person</th><th>Type</th><th>Job title</th><th>Rate</th></tr></thead><tbody>' +
            d.people.map((p) => "<tr><td>" + esc(p.name) + "</td><td>" + esc(TYPE[p.employment_type] || "") + "</td><td>" + esc(p.job_title || "") + "</td><td>" +
              (p.rate ? esc(rateTxt(p.rate)) + ' <span class="muted" style="font-size:12px">(' + esc(p.rate.source === "person" ? "own" : p.rate.source === "title" ? "title" : "type") + ")</span>" : '<span class="muted">none</span>') +
              ' <button type="button" class="small quiet" data-own="' + esc(p.user_id) + '">Set own</button></td></tr>').join("") + "</tbody></table></div>";
        } catch (e) { mErr(cleanErr(e)); }
      }
      function edit(r, preset) {
        const titles = d.titles || [];
        const people = d.people || [];
        const v = r || preset || { scope: "type", scope_key: "part_time", basis: "hourly", rate: "", half_day_rate: null };
        const keyField = (scope, key) => (scope === "type" ? '<select id="aca-prtK">' + Object.keys(TYPE).map((k) => '<option value="' + k + '"' + (k === key ? " selected" : "") + ">" + TYPE[k] + "</option>").join("") + "</select>"
          : scope === "title" ? '<input type="text" id="aca-prtK" list="aca-prtTitles" maxlength="80" value="' + esc(key || "") + '" /><datalist id="aca-prtTitles">' + titles.map((t) => '<option value="' + esc(t) + '"></option>').join("") + "</datalist>"
          : '<select id="aca-prtK">' + people.map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === key ? " selected" : "") + ">" + esc(p.name) + "</option>").join("") + "</select>");
        const f = openModal('<div class="tc-modal"><h2>' + (r ? "Change rate" : "Add a rate") + "</h2>" +
          '<div class="row2"><div class="field"><label for="aca-prtS">For</label><select id="aca-prtS"><option value="type">An employment type</option><option value="title">A job title</option><option value="person">One person</option></select></div>' +
          '<div class="field"><label for="aca-prtK">Which</label><span id="aca-prtKw">' + keyField(v.scope, v.scope_key) + "</span></div></div>" +
          '<div class="row3"><div class="field"><label for="aca-prtB">Paid by</label><select id="aca-prtB"><option value="hourly">The hour</option><option value="day">The day</option><option value="job">The job (1099)</option></select></div>' +
          '<div class="field"><label for="aca-prtR">Rate ($)</label><input type="number" id="aca-prtR" min="0" max="10000" step="0.01" value="' + esc(v.rate) + '" /></div>' +
          '<div class="field" id="aca-prtHw"><label for="aca-prtH">Half day ($, optional)</label><input type="number" id="aca-prtH" min="0" max="10000" step="0.01" value="' + esc(v.half_day_rate == null ? "" : v.half_day_rate) + '" /></div></div>' +
          '<p class="muted" style="font-size:12.5px" id="aca-prtHint"></p><div class="inline-error hidden tc-merr"></div>' +
          '<div class="modal-actions">' + (r ? '<button type="button" class="small warn" data-m="remove">Remove</button>' : "") + '<span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="save">Save</button></div></div>');
        const fErr = mErrIn(f);
        el("prtS").value = v.scope; el("prtB").value = v.basis;
        const sync = () => {
          const day = el("prtB").value === "day";
          el("prtHw").classList.toggle("hidden", !day);
          el("prtHint").textContent = day ? "A day with time clocked pays the day rate; under " + num(d.half_day_hours) + " hours pays the half-day rate when one is set (change the hours in Settings)."
            : el("prtB").value === "job" ? "Each job they clock time to pays this once, however many days it runs. For 1099s paid per job." : "";
        };
        sync();
        el("prtB").addEventListener("change", sync);
        el("prtS").addEventListener("change", () => { el("prtKw").innerHTML = keyField(el("prtS").value, ""); });
        f.addEventListener("click", async (ev) => {
          const b = ev.target.closest("[data-m]"); if (!b) return;
          if (b.dataset.m === "cancel") return f.close();
          b.disabled = true;
          try {
            const { error } = b.dataset.m === "remove" ? await sb.rpc("timeclock_rate_remove", { p_id: r.id })
              : await sb.rpc("timeclock_rate_save", { p: { id: r ? r.id : null, scope: el("prtS").value, scope_key: el("prtK").value, basis: el("prtB").value, rate: el("prtR").value, half_day_rate: el("prtH").value } });
            if (error) throw error;
            f.close(); toast(b.dataset.m === "remove" ? "Removed." : "Saved."); load();
          } catch (e) { fErr(cleanErr(e)); b.disabled = false; }
        });
      }
      m.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-m]");
        if (b && b.dataset.m === "cancel") { m.close(); if (opts.onClose) opts.onClose(); else TimeClock.loadWeek(); return; }
        if (!d) return;
        if (b && b.dataset.m === "add") return edit(null);
        const own = ev.target.closest("[data-own]");
        if (own) { const r = d.rates.find((x) => x.scope === "person" && x.scope_key === own.dataset.own); return edit(r || null, r ? null : { scope: "person", scope_key: own.dataset.own, basis: "hourly", rate: "", half_day_rate: null }); }
        const row = ev.target.closest("[data-rate]");
        if (row) edit(d.rates.find((x) => x.id === row.dataset.rate));
      });
      load();
    }

    // ---------------------------------------------------------------- the job page: Time tab
    function renderJob(booking, box) {
      box.innerHTML = '<p class="empty">Loading&#8230;</p>';
      sb.rpc("timeclock_job", { p_booking: booking.id || booking.booking_id || booking }).then(({ data, error }) => {
        if (error) { box.innerHTML = '<p class="inline-error">' + esc(cleanErr(error)) + "</p>"; return; }
        const people = data.people || [];
        if (!people.length) { box.innerHTML = '<p class="empty">Nobody has clocked time on this job yet.</p>'; return; }
        const half = num(data.half_day_hours) * 60;
        const cost = (p) => {
          if (!p.rate) return null;
          const wage = p.rate.basis === "day" ? num(p.days) * num(p.rate.rate) : p.rate.basis === "job" ? num(p.rate.rate) : num(p.minutes) / 60 * num(p.rate.rate);
          return wage + num(p.miles) * num(data.mileage_rate) + num(p.expenses);
        };
        const tot = people.reduce((n, p) => ({ min: n.min + num(p.minutes), mi: n.mi + num(p.miles), ex: n.ex + num(p.expenses), cost: cost(p) == null ? n.cost : n.cost + cost(p) }), { min: 0, mi: 0, ex: 0, cost: 0 });
        box.innerHTML = '<div class="table-wrap"><table class="tc-week"><thead><tr><th>Person</th><th class="tc-num">Hours</th><th class="tc-num">Miles</th><th class="tc-num">Expenses</th>' + (data.can_edit ? '<th class="tc-num">Est. cost</th>' : "") + "</tr></thead><tbody>" +
          people.map((p) => '<tr><td class="name">' + esc(p.name) + (p.open ? ' <span class="pill warn">Clocked in</span>' : "") + '</td><td class="tc-num">' + TimeClock.hm(p.minutes) + '</td><td class="tc-num">' + (num(p.miles) ? num(p.miles).toFixed(1) : "") +
            '</td><td class="tc-num">' + (num(p.expenses) ? money(p.expenses) : "") + "</td>" + (data.can_edit ? '<td class="tc-num">' + (cost(p) == null ? '<span class="muted">no rate</span>' : money(cost(p))) + "</td>" : "") + "</tr>").join("") +
          (people.length > 1 ? '<tr><td class="name">Total</td><td class="tc-num"><b>' + TimeClock.hm(tot.min) + '</b></td><td class="tc-num">' + tot.mi.toFixed(1) + '</td><td class="tc-num">' + money(tot.ex) + "</td>" + (data.can_edit ? '<td class="tc-num"><b>' + money(tot.cost) + "</b></td>" : "") + "</tr>" : "") +
          "</tbody></table></div>" + (data.can_edit ? '<p class="tc-sum" style="margin-top:8px">Est. cost = pay rate for the time on this job (no overtime split; day rate per day' + (half ? "" : "") + ") + mileage + approved expenses.</p>" : "");
      });
    }
    // registerJobTab is the job page's (jobpage.js, hoisted); without a job page in the build this does nothing.
    if (typeof registerJobTab === "function") registerJobTab({ id: "time", label: "Time", order: 65, module: "timeclock", render: renderJob });

    return { loadExpenses, openRates, renderJob };
  })();
