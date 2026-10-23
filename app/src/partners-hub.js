  // ================================================================ PARTNERS (schools + hub) part

  // ================= Schools (Communications Hub) =================
  // Rows behind the public Communications Hub at /schooladmin/. That page reads
  // comm_hub_schools directly with the anon key (active rows only) and merges
  // picture day, retake day, and the shared pre-registration code into its
  // ready-to-send email/text/flyer/social copy.
  //
  // Deliberately hand-maintained rather than derived from synced_jobs: retake day
  // has no GotPhoto equivalent, and access_code here is a school-wide
  // pre-registration code, not a job access code from synced_codes.
  let schoolsList = [];

  async function loadSchools() {
    clearError("schoolsError");
    const { data, error } = await supabase
      .from("comm_hub_schools")
      .select("id, name, picture_day, retake_day, access_code, active, sort_order")
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) {
      showError("schoolsError", "Could not load schools: " + error.message);
      el("schoolsBody").innerHTML = '<tr><td colspan="6" class="empty">Unavailable.</td></tr>';
      return;
    }
    schoolsList = data || [];
    renderSchools();
    if (hubActList.length) renderHubActivity();
  }

  function renderSchools() {
    const body = el("schoolsBody");
    const n = schoolsList.length;
    const live = schoolsList.filter((s) => s.active).length;
    el("schoolCount").textContent = n === 0 ? "" : n + (n === 1 ? " school" : " schools") + " · " + live + " on the hub";
    if (n === 0) {
      body.innerHTML = '<tr><td colspan="6" class="empty">No schools yet — add one above.</td></tr>';
      return;
    }
    body.innerHTML = schoolsList.map((s) =>
      '<tr data-school="' + esc(s.id) + '">' +
      '<td><input type="text" class="js-s-name" value="' + esc(s.name) + '" maxlength="120" aria-label="School name" /></td>' +
      '<td><input type="date" class="js-s-pd" value="' + esc(s.picture_day || "") + '" aria-label="Picture day" /></td>' +
      '<td><input type="date" class="js-s-rd" value="' + esc(s.retake_day || "") + '" aria-label="Retake day" /></td>' +
      '<td><input type="text" class="js-s-code" value="' + esc(s.access_code || "") + '" maxlength="40" aria-label="Access code" /></td>' +
      '<td><input type="checkbox" class="js-s-active"' + (s.active ? " checked" : "") + ' aria-label="Visible on the hub" /></td>' +
      '<td><button class="small primary js-s-save">Save</button> <button class="small js-s-del">Delete</button></td>' +
      '</tr>'
    ).join("");
  }

  // name, picture day, and access code are NOT NULL in the table; the hub also
  // skips any row missing a name or picture day, so block those client-side
  // rather than letting a row save into a state the hub silently ignores.
  function readSchoolRow(row) {
    const name = row.querySelector(".js-s-name").value.trim();
    const picture_day = row.querySelector(".js-s-pd").value;
    const access_code = row.querySelector(".js-s-code").value.trim();
    if (!name || !picture_day || !access_code) return null;
    return {
      name, picture_day, access_code,
      retake_day: row.querySelector(".js-s-rd").value || null,
      active: row.querySelector(".js-s-active").checked,
    };
  }

  el("addSchoolBtn").addEventListener("click", async () => {
    const name = el("newSchoolName").value.trim();
    const picture_day = el("newSchoolPd").value;
    const access_code = el("newSchoolCode").value.trim();
    if (!name || !picture_day || !access_code) { toast("Name, picture day, and access code are all required.", true); return; }
    const btn = el("addSchoolBtn");
    btn.disabled = true;
    const { error } = await supabase.from("comm_hub_schools").insert({ name, picture_day, access_code, retake_day: el("newSchoolRd").value || null });
    btn.disabled = false;
    if (error) { toast("Could not add school: " + error.message, true); return; }
    ["newSchoolName", "newSchoolPd", "newSchoolRd", "newSchoolCode"].forEach((id) => { el(id).value = ""; });
    toast("'" + name + "' added.");
    loadSchools();
  });

  el("schoolsBody").addEventListener("click", async (e) => {
    const saveBtn = e.target.closest(".js-s-save");
    const delBtn = e.target.closest(".js-s-del");
    if (!saveBtn && !delBtn) return;
    const row = e.target.closest("tr[data-school]");
    if (!row) return;
    const id = row.dataset.school;
    const current = schoolsList.find((s) => s.id === id);

    if (delBtn) {
      const label = current ? current.name : "this school";
      if (!confirm('Remove "' + label + '" from the Communications Hub? This cannot be undone — untick Visible instead to hide it temporarily.')) return;
      delBtn.disabled = true;
      const { error } = await supabase.from("comm_hub_schools").delete().eq("id", id);
      if (error) { delBtn.disabled = false; toast("Could not delete: " + error.message, true); return; }
      toast("'" + label + "' removed.");
      loadSchools();
      return;
    }

    const patch = readSchoolRow(row);
    if (!patch) { toast("Name, picture day, and access code are all required.", true); return; }
    saveBtn.disabled = true;
    const { error } = await supabase.from("comm_hub_schools")
      .update(Object.assign({}, patch, { updated_at: new Date().toISOString() })).eq("id", id);
    saveBtn.disabled = false;
    if (error) { toast("Could not save: " + error.message, true); return; }
    toast("'" + patch.name + "' saved.");
    loadSchools();
  });

  // ================= Hub activity =================
  // #jobs/schools used to be its own page; the school rows (with their access code and retake day) now sit in
  // Hub activity under the Schools filter, and the old address lands there (2026-10-24).
  registerPage({ id: "schools", group: "Jobs", section: "jobs", module: "hub", hidden: true, navAs: "hubact",
                 tabs: [["schools", "Hub activity"]], onShow: () => { setHubFilter("school"); showTab("hubact"); } });
  function setHubFilter(f) {
    hubActFilter = f;
    el("hubactChips").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.f === f ? "true" : "false"));
  }
  // A school row from before bookings: edit its dates, code and visibility in a small dialog.
  function editSchool(id) {
    const s = schoolsList.find((x) => x.id === id); if (!s) return;
    const m = openModal('<h2>' + esc(s.name) + "</h2>" +
      '<div class="field"><label for="aca-hsName">School name</label><input type="text" id="aca-hsName" maxlength="120" value="' + esc(s.name) + '" /></div>' +
      '<div class="field"><label for="aca-hsPd">Picture day</label><input type="date" id="aca-hsPd" value="' + esc(s.picture_day || "") + '" /></div>' +
      '<div class="field"><label for="aca-hsRd">Retake day (optional)</label><input type="date" id="aca-hsRd" value="' + esc(s.retake_day || "") + '" /></div>' +
      '<div class="field"><label for="aca-hsCode">Access code</label><input type="text" id="aca-hsCode" maxlength="40" value="' + esc(s.access_code || "") + '" /></div>' +
      '<div class="field"><label><input type="checkbox" id="aca-hsActive"' + (s.active ? " checked" : "") + " /> Visible on the hub</label></div>" +
      '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-hsCancel">Cancel</button><button type="button" class="primary" id="aca-hsSave">Save</button></div>');
    el("hsCancel").addEventListener("click", () => m.close());
    el("hsSave").addEventListener("click", async () => {
      const patch = { name: el("hsName").value.trim(), picture_day: el("hsPd").value, access_code: el("hsCode").value.trim(),
        retake_day: el("hsRd").value || null, active: el("hsActive").checked, updated_at: new Date().toISOString() };
      if (!patch.name || !patch.picture_day || !patch.access_code) { toast("Name, picture day, and access code are all required.", true); return; }
      el("hsSave").disabled = true;
      const { error } = await supabase.from("comm_hub_schools").update(patch).eq("id", id);
      el("hsSave").disabled = false;
      if (error) { toast("Could not save: " + error.message, true); return; }
      m.close(); toast("'" + patch.name + "' saved."); loadSchools();
    });
  }
  // Which parent messages each team / school has grabbed on /sportsadmin/ and /schooladmin/.
  // All of it (send dates, statuses, grabs, reminder signups) comes from the admin-only RPC
  // admin_hub_activity(); hub_events and the watcher tables are not readable any other way.
  // A copy means they grabbed the message, not that they sent it, so the label is "Grabbed".
  let hubActList = [];
  let hubActFilter = "all";
  const HUBACT_STATUS = {
    grabbed: ["ok", "Grabbed"],
    late: ["err", "Late"],
    due: ["accent", "Due today"],
    upcoming: ["muted", "Not due yet"],
    waiting: ["muted", "Gallery not live yet"],
    missed: ["warn", "Not grabbed"],
  };
  const HUBACT_FORMAT = { email: "email", text: "text", flyer: "flyer", social: "social post" };

  function hubActDay(iso) {
    if (!iso) return "";
    const d = new Date(String(iso).slice(0, 10) + "T12:00:00");
    if (isNaN(d)) return esc(iso);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  async function loadHubActivity() {
    clearError("hubactError");
    const { data, error } = await supabase.rpc("admin_hub_activity");
    if (error) {
      showError("hubactError", "Could not load hub activity: " + error.message);
      el("hubactBody").innerHTML = '<div class="empty">Unavailable.</div>';
      return;
    }
    hubActList = Array.isArray(data) ? data : [];
    // Which hub rows have a booking: their reminder contacts come from the booking, not from here (2026-10-12).
    hubBookings = {};
    try {
      const from = new Date(Date.now() - 90 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const { data: bk } = await supabase.rpc("admin_bookings", { p_from: from, p_to: null });
      (bk || []).forEach((b) => { if (b.status !== "booked") return; if (b.gotphoto_job_id) hubBookings["sports:" + b.gotphoto_job_id] = b; if (b.hub_school_id) hubBookings["school:" + b.hub_school_id] = b; });
    } catch (_e) { /* the list still works without it */ }
    renderHubActivity();
  }
  let hubBookings = {};

  function hubActSendRow(s) {
    const st = HUBACT_STATUS[s.status] || ["muted", s.status];
    let label = st[1];
    if (s.status === "due" && !s.date) label = "Send now";
    let detail = "";
    if (s.status === "grabbed") {
      const formats = (s.formats || []).map((f) => HUBACT_FORMAT[f] || f).join(", ");
      const who = (s.who || []).length ? " by " + s.who.join(", ") : "";
      detail = esc(formats) + " · " + fmtDate(s.last_at) + esc(who) +
        (s.grabs > 1 ? ' <span class="muted">(' + num(s.grabs) + " grabs)</span>" : "");
    } else if (s.status === "late") {
      detail = "Nobody grabbed it. Still worth sending.";
    } else if (s.status === "missed") {
      detail = '<span class="muted">Too late to send now.</span>';
    } else if (s.status === "waiting") {
      detail = '<span class="muted">Date is a guess until the gallery goes live.</span>';
    }
    if (s.reminded_at && s.status !== "grabbed") detail += ' <span class="muted">Reminder emailed ' + fmtDate(s.reminded_at) + ".</span>";
    const due = s.date ? hubActDay(s.date) + (s.estimate ? ' <span class="muted">(guess)</span>' : "") : "On booking";
    return '<tr class="' + esc(s.status) + '">' +
      '<td class="t">' + esc(s.title) + '</td>' +
      '<td class="d">' + due + '</td>' +
      '<td class="s"><span class="pill ' + st[0] + '">' + esc(label) + '</span></td>' +
      '<td>' + detail + '</td></tr>';
  }

  function renderHubActivity() {
    const lateOrgs = hubActList.filter((o) => o.late_count > 0).length;
    const badge = el("hubLateBadge");
    if (lateOrgs) { badge.textContent = lateOrgs; badge.classList.remove("hidden"); } else badge.classList.add("hidden");
    setAttention("hubLate", lateOrgs, lateOrgs === 1 ? "team or school to nudge: a hub message is late" : "teams and schools to nudge: hub messages are late", "hubact", "err");
    el("hubactCount").textContent = hubActList.length
      ? hubActList.length + " teams and schools · " + (lateOrgs ? lateOrgs + " to nudge" : "nobody to nudge")
      : "";
    const list = hubActList.filter((o) =>
      hubActFilter === "all" ? true : hubActFilter === "late" ? o.late_count > 0 : o.hub === hubActFilter);
    if (!list.length) {
      el("hubactBody").innerHTML = '<div class="empty">' +
        (hubActFilter === "late" ? "Nothing is late. Nobody to nudge." : "Nothing to show.") + '</div>';
      return;
    }
    el("hubactBody").innerHTML = list.map((o) => {
      const link = o.hub === "sports"
        ? "https://207photo.com/sportsadmin/#job=" + encodeURIComponent(o.org_id)
        : "https://207photo.com/schooladmin/#school=" + encodeURIComponent(o.org_id);
      const watchers = Array.isArray(o.watchers) ? o.watchers : [];
      // Reminder contacts: who gets the "today is a send day" emails. Add one by hand when the
      // 17hats intake missed them or a second person at the school wants them; x takes them off.
      const who = '<span class="hubact-who-label">' + (watchers.length ? "Gets reminders:" : '<span class="muted">Nobody gets reminders yet.</span>') + '</span> ' +
        watchers.map((w) => {
          const nm = splitName(w.name);
          return '<span class="hubact-contact" title="Added ' + esc(fmtDate(w.since)) + '. Click to edit.">' +
            '<button type="button" class="hubact-edit js-w-edit" data-wid="' + esc(w.id) + '" data-first="' + esc(nm[0]) + '" data-last="' + esc(nm[1]) + '" data-email="' + esc(w.email) + '">' + esc(w.name || "No name") + ' <span class="mono">' + esc(w.email) + '</span></button>' +
            '<button type="button" class="hubact-x js-w-remove" data-wid="' + esc(w.id) + '" data-email="' + esc(w.email) + '" aria-label="Stop reminders for ' + esc(w.email) + '" title="Stop reminders for this person">&times;</button></span>';
        }).join(" ") +
        ' <button type="button" class="small js-w-add" data-hub="' + esc(o.hub) + '" data-org="' + esc(o.org_id) + '">Add contact</button>' +
        '<form class="hubact-addform hidden" data-hub="' + esc(o.hub) + '" data-org="' + esc(o.org_id) + '">' +
          '<div class="hubact-form-head"><strong class="js-w-title">New reminder contact</strong><span class="muted js-w-note" data-add="Gets the send-day reminder emails for ' + esc(o.org) + '.">Gets the send-day reminder emails for ' + esc(o.org) + '.</span></div>' +
          '<div class="hubact-fields">' +
            '<label class="og-f"><span>First name</span><input type="text" name="first" maxlength="40" autocomplete="off" /></label>' +
            '<label class="og-f"><span>Last name</span><input type="text" name="last" maxlength="40" autocomplete="off" /></label>' +
            '<label class="og-f hubact-f-email"><span>Email</span><input type="email" name="email" required maxlength="120" autocomplete="off" /></label>' +
          '</div>' +
          '<div class="hubact-form-actions"><button type="submit" class="primary">Add contact</button><button type="button" class="js-w-cancel">Cancel</button></div>' +
        '</form>';
      // Each partner folds on its header; late ones start open, the rest closed, and a click is remembered.
      const fkey = "aca-hubfold:" + o.hub + ":" + o.org_id;
      let folded = o.late_count === 0; try { const v = localStorage.getItem(fkey); if (v !== null) folded = v === "1"; } catch (_) {}
      return '<div class="hubact-org' + (o.late_count > 0 ? " nudge" : "") + (folded ? " folded" : "") + '" data-fkey="' + esc(fkey) + '">' +
        '<div class="hubact-head" title="Click to fold or unfold">' +
          '<button type="button" class="hubact-chev" aria-label="Fold or unfold ' + esc(o.org) + '" aria-expanded="' + (!folded) + '"><span class="sl-chev"></span></button>' +
          '<span class="name">' + esc(o.org) + '</span>' +
          '<span class="pill ' + (o.hub === "sports" ? "accent" : "muted") + '">' + (o.hub === "sports" ? "Sports" : "School") + '</span>' +
          '<span class="muted">Picture day ' + hubActDay(o.picture_day) + '</span>' +
          (o.late_count > 0 ? '<span class="pill err">' + num(o.late_count) + " late</span>" : "") +
          schoolBits(o) +
          '<a href="' + esc(link) + '" target="_blank" rel="noopener" style="font-size:12.5px">open on the hub</a>' +
        '</div>' +
        '<table class="hubact-sends"><tbody>' + (o.sends || []).map(hubActSendRow).join("") + '</tbody></table>' +
        '<div class="hubact-who">' + who + '</div>' +
      '</div>';
    }).join("");
    // Rows with a booking: reminders follow the booking's contacts; the hand-add form is for legacy rows only.
    el("hubactBody").querySelectorAll(".hubact-org").forEach((node, i) => {
      const o = list[i]; const b = o && hubBookings[o.hub + ":" + o.org_id]; if (!b) return;
      node.querySelectorAll(".js-w-add, form.hubact-addform").forEach((x) => x.remove());
      const who = node.querySelector(".hubact-who"); if (!who) return;
      const names = (b.contacts || []).map((c) => c.name || c.email).filter(Boolean).join(", ");
      const nm = node.querySelector(".hubact-head .name");
      if (nm && b.org_id && typeof orgLink === "function") nm.innerHTML = '<a href="' + esc(orgLink(b.org_id)) + '">' + esc(o.org) + "</a>";
      const note = document.createElement("span"); note.className = "muted"; note.style.cssText = "flex-basis:100%;font-size:12.5px";
      note.innerHTML = "Booked" + (names ? ", reminders go to " + esc(names) : "") + '. <a href="' + esc(jobLink(b.id, "booking")) + '">Change contacts on the booking</a>';
      who.appendChild(note);
    });
  }

  // School rows: the access code parents type and the retake day, with Edit for rows that have no booking.
  function schoolBits(o) {
    if (o.hub !== "school") return "";
    const s = schoolsList.find((x) => x.id === o.org_id); if (!s) return "";
    return '<span class="muted">Access code <span class="mono">' + esc(s.access_code || "none") + "</span>" + (s.retake_day ? " · retakes " + hubActDay(s.retake_day) : "") + (s.active ? "" : " · hidden on the hub") + "</span>" +
      (hubBookings["school:" + o.org_id] || !canEdit("hub") ? "" : '<button type="button" class="link small js-s-edit" data-sid="' + esc(s.id) + '">Edit</button>');
  }
  el("hubactChips").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-f]");
    if (!btn) return;
    hubActFilter = btn.dataset.f;
    el("hubactChips").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
    renderHubActivity();
  });
  // The tables keep one name column (the reminder emails greet by its first word), so the panel
  // shows first + last and joins them with a space; an existing name splits at its first space.
  function splitName(name) {
    const t = String(name || "").trim();
    if (!t) return ["", ""];
    const i = t.indexOf(" ");
    return i < 0 ? [t, ""] : [t.slice(0, i), t.slice(i + 1).trim()];
  }
  function joinName(first, last) { return (String(first || "").trim() + " " + String(last || "").trim()).trim() || null; }
  function openContactForm(org, mode, w) {
    const form = org.querySelector(".hubact-addform");
    org.querySelectorAll(".hubact-contact.editing").forEach((c) => c.classList.remove("editing"));
    if (mode === "edit") { const chip = org.querySelector('.js-w-edit[data-wid="' + w.wid + '"]'); if (chip) chip.closest(".hubact-contact").classList.add("editing"); }
    form.classList.remove("hidden");
    form.dataset.mode = mode;
    form.dataset.wid = w ? w.wid : "";
    form.querySelector('[name="first"]').value = w ? w.first : "";
    form.querySelector('[name="last"]').value = w ? w.last : "";
    form.querySelector('[name="email"]').value = w ? w.email : "";
    form.querySelector('button[type="submit"]').textContent = mode === "edit" ? "Save changes" : "Add contact";
    form.querySelector(".js-w-title").textContent = mode === "edit" ? "Edit contact" : "New reminder contact";
    form.querySelector(".js-w-note").textContent = mode === "edit" ? "Reminder emails go to the address below." : form.querySelector(".js-w-note").dataset.add;
    form.querySelector(mode === "edit" ? '[name="first"]' : '[name="email"]').focus();
  }

  // Reminder contacts: add / edit / remove (admin-only RPCs; the list re-renders from the server).
  el("hubactBody").addEventListener("click", (e) => {
    const se = e.target.closest(".js-s-edit"); if (se) { editSchool(se.dataset.sid); return; }
    const head = e.target.closest(".hubact-head"); if (!head || e.target.closest("a")) return;
    const org = head.closest(".hubact-org"); const folded = org.classList.toggle("folded");
    head.querySelector(".hubact-chev").setAttribute("aria-expanded", String(!folded));
    try { localStorage.setItem(org.dataset.fkey, folded ? "1" : "0"); } catch (_) {}
  });
  el("hubactBody").addEventListener("click", async (e) => {
    const addBtn = e.target.closest(".js-w-add");
    const editBtn = e.target.closest(".js-w-edit");
    const cancel = e.target.closest(".js-w-cancel");
    const rm = e.target.closest(".js-w-remove");
    if (addBtn) {
      const org = addBtn.closest(".hubact-org"), form = org.querySelector(".hubact-addform");
      if (!form.classList.contains("hidden") && form.dataset.mode !== "edit") { form.classList.add("hidden"); return; }
      openContactForm(org, "add", null);
      return;
    }
    if (editBtn) {
      openContactForm(editBtn.closest(".hubact-org"), "edit", { wid: editBtn.dataset.wid, first: editBtn.dataset.first, last: editBtn.dataset.last, email: editBtn.dataset.email });
      return;
    }
    if (cancel) { const f = cancel.closest("form"); f.classList.add("hidden"); f.closest(".hubact-org").querySelectorAll(".hubact-contact.editing").forEach((c) => c.classList.remove("editing")); return; }
    if (rm) {
      const org = rm.closest(".hubact-org");
      const hub = org.querySelector(".js-w-add").dataset.hub;
      if (!confirm("Stop reminder emails for " + rm.dataset.email + "?")) return;
      rm.disabled = true;
      const { data, error } = await supabase.rpc("admin_hub_watcher_remove", { p_hub: hub, p_id: rm.dataset.wid });
      if (error || !(data && data.ok)) { rm.disabled = false; toast("Could not remove: " + (error ? error.message : (data && data.error) || "not found"), true); return; }
      toast(rm.dataset.email + " will not get reminders.");
      loadHubActivity();
    }
  });
  el("hubactBody").addEventListener("submit", async (e) => {
    const form = e.target.closest(".hubact-addform");
    if (!form) return;
    e.preventDefault();
    const email = form.querySelector('[name="email"]').value.trim();
    const name = joinName(form.querySelector('[name="first"]').value, form.querySelector('[name="last"]').value);
    if (!email) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const editing = form.dataset.mode === "edit";
    const { data, error } = editing
      ? await supabase.rpc("admin_hub_watcher_update", { p_hub: form.dataset.hub, p_id: form.dataset.wid, p_email: email, p_name: name })
      : await supabase.rpc("admin_hub_watcher_add", { p_hub: form.dataset.hub, p_org_id: form.dataset.org, p_email: email, p_name: name });
    btn.disabled = false;
    if (error || !(data && data.ok)) { toast("Could not " + (editing ? "save" : "add") + ": " + (error ? error.message : (data && data.error) || "unknown error"), true); return; }
    toast(editing ? "Saved." : email + (data.result === "restored" ? " is back on the reminder list." : " will get the reminder emails."));
    loadHubActivity();
  });

  el("hubactRefresh").addEventListener("click", () => {
    el("hubactBody").innerHTML = '<div class="empty">Loading…</div>';
    loadHubActivity();
  });

