  // ================================================================ TEAM (2026-10-21)
  // People and what they can see. Full-access people add teammates and choose None / View / Edit per
  // module (public.app_modules). Accounts are created by the `team` edge function (it needs the service
  // key); everything else is SQL: team_list / team_save / team_audit_list, all checked with is_admin()
  // and logged in team_audit. This file is also the example for new modules: one registerPage() call,
  // one panel in a src/*.html partial, one IIFE holding the page's state.
  registerPage({ id: "team", group: "System", section: "system", module: "team", tabs: [["team", "Team"]], onShow: () => Team.load() });

  const Team = (function () {
    const TEAM_FN_URL = SUPABASE_URL + "/functions/v1/team";
    let modules = [], people = [];
    const LEVEL_WORD = { view: "view", edit: "edit" };

    async function teamFn(body) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { location.reload(); throw new Error("Signed out."); }
      const r = await fetch(TEAM_FN_URL, { method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || "HTTP " + r.status);
      return j;
    }

    async function load() {
      clearError("teamErr");
      try {
        const [m, p] = await Promise.all([
          supabase.from("app_modules").select("key,label,section,description,sort,status,admin_only").order("sort"),
          supabase.rpc("team_list"),
        ]);
        if (m.error) throw m.error;
        if (p.error) throw p.error;
        modules = (m.data || []).filter((x) => !x.admin_only);
        people = p.data || [];
        // Crew roles (crew.js): what each person can do on a job. Optional, so the page still works without them.
        const cr = await supabase.rpc("crew_roles_list");
        crewRoles = cr.error || !cr.data ? { roles: [], members: {} } : cr.data;
        render();
      } catch (e) {
        showError("teamErr", "Could not load the team: " + (e.message || e));
        el("teamBody").innerHTML = '<tr><td colspan="5" class="empty">Unavailable.</td></tr>';
      }
      loadLog();
    }

    // Employment type (2026-10-23): Part time and 1099 get Open jobs offers; Salaried and 1099 get no overtime.
    const TYPES = [["full_time", "Full time"], ["salaried", "Salaried"], ["part_time", "Part time"], ["contractor", "1099 contractor"]];
    const typeLabel = (t) => (TYPES.find((x) => x[0] === t) || [null, ""])[1];

    function accessText(p) {
      if (p.is_admin) return "<b>Full access</b>";
      const parts = modules.filter((m) => p.modules[m.key]).map((m) => esc(m.label) + ' <span class="muted">(' + LEVEL_WORD[p.modules[m.key]] + ")</span>");
      return parts.length ? parts.join(", ") : '<span class="muted">Nothing yet</span>';
    }

    function render() {
      el("teamBody").innerHTML = people.length ? people.map((p) =>
        "<tr" + (p.active ? "" : ' class="muted"') + '><td class="name">' + esc(p.name || p.email) + (p.is_me ? ' <span class="muted">(you)</span>' : "") +
        '<div class="muted" style="font-size:12.5px">' + [p.job_title, typeLabel(p.employment_type)].filter(Boolean).map(esc).join(" &middot; ") + ((p.job_title || p.employment_type) ? "<br>" : "") + esc(p.email) + (p.weekly_hours != null ? " &middot; " + esc(String(Number(p.weekly_hours))) + " h/week" : "") + "</div></td>" +
        "<td>" + accessText(p) + "</td>" +
        "<td>" + esc(p.last_sign_in_at ? fmtAgo(p.last_sign_in_at) : "never") + "</td>" +
        "<td>" + (!p.active ? '<span class="pill muted">Deactivated</span>' : p.must_change_password ? '<span class="pill warn">Temporary password</span>' : '<span class="pill ok">Active</span>') + "</td>" +
        '<td><button type="button" class="small" data-edit="' + esc(p.user_id) + '">Edit</button></td></tr>').join("")
        : '<tr><td colspan="5" class="empty">Nobody yet.</td></tr>';
    }
    el("teamBody").addEventListener("click", (e) => { const b = e.target.closest("[data-edit]"); if (b) openEditor(people.find((p) => p.user_id === b.dataset.edit)); });
    el("teamAdd").addEventListener("click", () => openEditor(null));

    // Module grid: one row per module, None / View / Edit. Planned modules can be granted ahead of launch.
    function grid(current) {
      const sections = [];
      modules.forEach((m) => { if (!sections.includes(m.section)) sections.push(m.section); });
      return sections.map((s) => '<div class="tm-sec">' + esc(s) + "</div>" + modules.filter((m) => m.section === s).map((m) => {
        const lv = current[m.key] || "none";
        return '<div class="tm-row"><div><b>' + esc(m.label) + "</b>" + (m.status === "planned" ? ' <span class="pill muted">Coming soon</span>' : "") +
          '<div class="muted">' + esc(m.description) + '</div></div><div class="seg" role="radiogroup" aria-label="' + esc(m.label) + '">' +
          ["none", "view", "edit"].map((l) => '<label><input type="radio" name="tm-' + esc(m.key) + '" value="' + l + '"' + (lv === l ? " checked" : "") + " /><span>" + l[0].toUpperCase() + l.slice(1) + "</span></label>").join("") +
          "</div></div>";
      }).join("")).join("");
    }

    let crewRoles = { roles: [], members: {} };
    function openEditor(p) {
      const isNew = !p;
      p = p || { name: "", email: "", is_admin: false, active: true, modules: {}, weekly_hours: null, employment_type: null, job_title: "" };
      const m = openModal(
        "<h2>" + (isNew ? "Add a person" : "Edit " + esc(p.name || p.email)) + "</h2>" +
        '<div class="field"><label for="aca-tmName">Name</label><input type="text" id="aca-tmName" maxlength="120" value="' + esc(p.name) + '" /></div>' +
        '<div class="field"><label for="aca-tmEmail">Email</label><input type="email" id="aca-tmEmail" value="' + esc(p.email) + '"' + (isNew ? "" : " disabled") + " /></div>" +
        (isNew ? '<label class="tm-full"><input type="checkbox" id="aca-tmWelcome" checked /> <span><b>Email them a welcome</b><br><span class="muted">Their temporary password, how to sign in, and a link that puts 207 Admin on their phone.</span></span></label>' : "") +
        '<div class="tm-two"><div class="field"><label for="aca-tmTitle">Job title</label><input type="text" id="aca-tmTitle" maxlength="80" value="' + esc(p.job_title || "") + '" placeholder="e.g. Lead photographer" /></div>' +
        '<div class="field"><label for="aca-tmType">Employment type</label><select id="aca-tmType"><option value="">Not set</option>' + TYPES.map((t) => '<option value="' + t[0] + '"' + (p.employment_type === t[0] ? " selected" : "") + ">" + t[1] + "</option>").join("") + "</select></div></div>" +
        '<p class="muted" id="aca-tmTypeNote" style="font-size:12.5px;margin:-6px 0 12px"></p>' +
        '<div class="field"><label for="aca-tmHours">Default hours per week</label><input type="number" id="aca-tmHours" min="0" max="80" step="0.5" style="width:110px" value="' + esc(p.weekly_hours == null ? "" : String(Number(p.weekly_hours))) + '" placeholder="e.g. 32" />' +
        '<span class="muted" style="font-size:12.5px">The Schedule shows how many hours they are scheduled against this each week. Leave empty if it doesn&#39;t apply.</span></div>' +
        ((crewRoles.roles || []).length ? '<div class="field"><label>Crew roles</label><div id="aca-tmRoles" style="display:flex;flex-wrap:wrap;gap:4px 16px">' + crewRoles.roles.map((r) =>
          '<label style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" value="' + esc(r.id) + '"' + (((crewRoles.members || {})[p.user_id] || []).includes(r.id) ? " checked" : "") + " /> " + esc(r.label) + "</label>").join("") +
          '</div><span class="muted" style="font-size:12.5px">What they can do on a job. The Schedule&#39;s crew picker shows these and suggests the first one. Roles are set up under Crew settings on the Schedule.</span></div>' : "") +
        '<label class="tm-full"><input type="checkbox" id="aca-tmAdmin"' + (p.is_admin ? " checked" : "") + (p.is_me ? " disabled" : "") + ' /> <span><b>Full access</b><br><span class="muted">Everything, including Settings and this Team page. For owners and managers only.</span></span></label>' +
        '<div id="aca-tmGrid" class="tm-grid' + (p.is_admin ? " hidden" : "") + '">' + grid(p.modules) + "</div>" +
        '<div class="inline-error hidden" id="aca-tmErr"></div>' +
        '<div class="modal-actions">' +
        (isNew || p.is_me ? "" : '<button type="button" class="small" id="aca-tmReset">Reset password</button><button type="button" class="small" id="aca-tmActive">' + (p.active ? "Deactivate" : "Reactivate") + "</button>" +
          (p.active ? "" : '<button type="button" class="small warn" id="aca-tmRemove">Remove</button>')) +
        '<span class="grow"></span><button type="button" class="small" id="aca-tmCancel">Cancel</button><button type="button" class="primary" id="aca-tmSave">' + (isNew ? "Add and create login" : "Save") + "</button></div>");
      const err = (t) => { const n = el("tmErr"); n.textContent = t; n.classList.remove("hidden"); };
      el("tmAdmin").addEventListener("change", () => el("tmGrid").classList.toggle("hidden", el("tmAdmin").checked));
      const typeNote = () => { el("tmTypeNote").textContent = ({ full_time: "Hourly, with overtime on the time clock.", salaried: "Hours are tracked, but no overtime on the time clock.",
        part_time: "Gets Open jobs offers near them (and Open jobs access). Overtime applies.", contractor: "Gets Open jobs offers near them (and Open jobs access). No overtime; kept out of the payroll CSV and listed separately." })[el("tmType").value] || ""; };
      el("tmType").addEventListener("change", typeNote); typeNote();
      el("tmCancel").addEventListener("click", () => m.close());
      const picked = () => { const o = {}; modules.forEach((x) => { const r = m.querySelector('input[name="tm-' + x.key + '"]:checked'); if (r && r.value !== "none") o[x.key] = r.value; }); return o; };

      el("tmSave").addEventListener("click", async () => {
        const name = el("tmName").value.trim(), email = el("tmEmail").value.trim(), isAdmin = el("tmAdmin").checked;
        if (!name) return err("Enter a name.");
        if (isNew && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Enter a valid email address.");
        const hoursTxt = el("tmHours").value.trim(), hours = hoursTxt === "" ? null : Number(hoursTxt);
        if (hours != null && !(hours >= 0 && hours <= 80)) return err("Hours per week is 0 to 80.");
        const hoursChanged = hours !== (p.weekly_hours == null ? null : Number(p.weekly_hours));
        const setHours = async (uid) => { if (!hoursChanged) return; const { error } = await supabase.rpc("team_set_hours", { p_user_id: uid, p_hours: hours }); if (error) throw error; };
        const type = el("tmType").value || null, title = el("tmTitle").value.trim();
        const setProfile = async (uid) => { if (type === (p.employment_type || null) && title === (p.job_title || "")) return; const { error } = await supabase.rpc("team_set_profile", { p_user_id: uid, p_type: type || "", p_title: title }); if (error) throw error; };
        const roleIds = el("tmRoles") ? [...el("tmRoles").querySelectorAll("input:checked")].map((x) => x.value) : null;
        const roles0 = ((crewRoles.members || {})[p.user_id] || []).slice().sort().join();
        const setRoles = async (uid) => { if (!roleIds || roleIds.slice().sort().join() === roles0) return; const { error } = await supabase.rpc("team_set_roles", { p_user_id: uid, p_roles: roleIds }); if (error) throw error; };
        el("tmSave").disabled = true;
        try {
          if (isNew) {
            const r = await teamFn({ action: "create", email, name, is_admin: isAdmin, permissions: isAdmin ? {} : picked(), send_welcome: el("tmWelcome").checked });
            try { await setHours(r.user_id); await setProfile(r.user_id); await setRoles(r.user_id); } catch (_e) { toast("Added, but the hours, job title, type or roles did not save. Edit them on the Team page.", true); }
            m.close();
            showPassword({ user_id: r.user_id, name, email }, r.temp_password, true, r);
          } else {
            const { error } = await supabase.rpc("team_save", { p_user_id: p.user_id, p_name: name, p_is_admin: isAdmin, p_permissions: isAdmin ? {} : picked() });
            if (error) throw error;
            await setHours(p.user_id);
            await setProfile(p.user_id);
            await setRoles(p.user_id);
            m.close();
            toast("Saved. " + (name || email) + " sees the change the next time they load the page.");
          }
          load();
        } catch (e) { err(e.message || String(e)); } finally { el("tmSave") && (el("tmSave").disabled = false); }
      });

      if (isNew || p.is_me) return;
      el("tmReset").addEventListener("click", async () => {
        if (!confirm("Give " + (p.name || p.email) + " a new temporary password? Their current password stops working.")) return;
        try { const r = await teamFn({ action: "reset_password", user_id: p.user_id }); m.close(); showPassword(p, r.temp_password, false, null); load(); }
        catch (e) { err(e.message || String(e)); }
      });
      el("tmActive").addEventListener("click", async () => {
        if (p.active && !confirm("Deactivate " + (p.name || p.email) + "? They are signed out of everything and can't sign in until you reactivate them.")) return;
        try { await teamFn({ action: "set_active", user_id: p.user_id, active: !p.active }); m.close(); toast(p.active ? "Deactivated." : "Reactivated."); load(); }
        catch (e) { err(e.message || String(e)); }
      });
      if (p.active) return;
      el("tmRemove").addEventListener("click", async () => {
        if (!confirm("Remove " + (p.name || p.email) + " from the team? Their login is deleted and they drop off this list. The change log keeps their name. This can't be undone; to bring them back, add them again.")) return;
        try { await teamFn({ action: "remove", user_id: p.user_id }); m.close(); toast("Removed."); load(); }
        catch (e) { err(e.message || String(e)); }
      });
    }

    // sent: the create result ({emailed, email_error}) when a welcome email was asked for, else null.
    function showPassword(person, pw, isNew, sent) {
      const name = person.name, email = person.email;
      const emailed = !!(sent && sent.emailed), failed = !!(sent && !sent.emailed && sent.email_error);
      const m = openModal("<h2>" + (isNew ? esc(name) + " can sign in now" : "New temporary password") + "</h2>" +
        (emailed ? '<p><span class="pill ok">Welcome email sent</span></p><p>We emailed <b>' + esc(email) + "</b> this temporary password, how to sign in, and the link that puts 207 Admin on their phone. It is also shown here, only once, in case they need it.</p>"
          : (failed ? '<div class="inline-error">The welcome email did not send: ' + esc(sent.email_error) + "</div>" : "") +
            "<p>Give " + esc(name || email) + " this temporary password. It is shown only once. They sign in at <b>admin.207photo.com</b> with <b>" + esc(email) +
            "</b>, enter the 6-digit code emailed to them, then choose their own password.</p>") +
        '<div class="tm-pw"><code id="aca-tmPw">' + esc(pw) + '</code><button type="button" class="small" id="aca-tmCopy">Copy</button></div>' +
        '<div class="modal-actions">' + (emailed ? "" : '<button type="button" class="small" id="aca-tmMail">Email it to them</button>') +
        '<span class="grow"></span><button type="button" class="primary" id="aca-tmDone">Done</button></div>', { locked: true });
      el("tmCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(pw); toast("Copied."); } catch (_e) { toast("Select the password and copy it.", true); } });
      el("tmDone").addEventListener("click", () => m.close());
      if (emailed) return;
      el("tmMail").addEventListener("click", async () => {
        const b = el("tmMail"); b.disabled = true;
        try { await teamFn({ action: "send_welcome", user_id: person.user_id, temp_password: pw }); b.textContent = "Emailed"; toast("Emailed " + email + "."); loadLog(); }
        catch (e) { b.disabled = false; toast(e.message || String(e), true); }
      });
    }

    const ACTIONS = { added: "added", updated: "changed access for", deactivated: "deactivated", reactivated: "reactivated", removed: "removed", temp_password_set: "set a temporary password for", temp_password_cleared: "cleared the temporary password for", hours_set: "changed the weekly hours for", profile_set: "changed the job title or employment type for", roles_set: "changed the crew roles for", welcome_sent: "emailed sign-in details to" };
    async function loadLog() {
      const { data, error } = await supabase.rpc("team_audit_list", { p_limit: 30 });
      el("teamLog").innerHTML = error ? '<span class="inline-error">' + esc(error.message) + "</span>"
        : !data || !data.length ? '<p class="muted">No changes yet.</p>'
        : "<ul class=\"tm-log\">" + data.map((r) => "<li><span class=\"muted\">" + esc(fmtDate(r.at)) + "</span> " + esc(r.actor || "Someone") + " " + esc(ACTIONS[r.action] || r.action) + " " + esc(r.target || "") + "</li>").join("") + "</ul>";
    }

    return { load };
  })();

