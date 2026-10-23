  // ================================================================ ACCESS (2026-10-21)
  // Who is signed in and which modules they may use (public.my_access). The database enforces the same
  // rules in every policy and RPC (public.can / can_any), so this only decides what to show; a page someone
  // can't use is left out of the menu, Cmd-K and Today rather than shown empty.
  //   canSee("bookings")   -> view or edit        canEdit("bookings") -> edit
  // Full-access people (admin_users) can see and edit everything.
  let ACCESS = { is_admin: false, modules: {}, name: "", email: "", must_change_password: false };
  function canSee(m) { return !m || ACCESS.is_admin || ACCESS.modules[m] === "view" || ACCESS.modules[m] === "edit"; }
  function canEdit(m) { return !m || ACCESS.is_admin || ACCESS.modules[m] === "edit"; }
  const canSeeAny = (ms) => ms.some(canSee);

  async function loadAccess(session) {
    const email = (session && session.user && session.user.email) || "";
    const { data, error } = await supabase.rpc("my_access");
    if (error && (error.code === "PGRST202" || /could not find the function/i.test(error.message || ""))) {
      // Database from before the Team migration: only full admins could sign in at all.
      ACCESS = { is_admin: true, modules: {}, name: "", email, must_change_password: false };
    } else if (error || !data || typeof data !== "object" || Array.isArray(data)) {
      ACCESS = { is_admin: false, modules: {}, name: "", email, must_change_password: false };
      toast("Could not load your access: " + ((error && error.message) || "unexpected reply") + ". Try reloading.", true);
    } else {
      ACCESS = Object.assign({ modules: {} }, data);
    }
    if (!ACCESS.email) ACCESS.email = email;
  }

  // Header + Today pieces that belong to a module.
  function applyAccessChrome() {
    const name = ACCESS.name || (ACCESS.email || "").split("@")[0];
    el("whoami").innerHTML = (ACCESS.name ? "<b>" + esc(ACCESS.name) + "</b><br>" : "") + esc(ACCESS.email || "") +
      (ACCESS.is_admin ? "" : '<br><span class="muted">Limited access</span>');
    const words = name.split(/[\s._-]+/).filter(Boolean);
    el("whoBtn").querySelector(".who-i").textContent = words.slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "Me";
    el("whoBtn").querySelector(".who-f").textContent = words[0] ? words[0].charAt(0).toUpperCase() + words[0].slice(1) : "Me"; // phones show the first name
    el("bookBtn").classList.toggle("hidden", !canEdit("bookings"));
    el("syncNowBtn").classList.toggle("hidden", !canEdit("galleries"));
    el("syncStatus").classList.toggle("hidden", !seesSync());
    el("gsTop").placeholder = matchMedia("(max-width: 700px)").matches ? "Search" : gsPlaceholder();
    el("todayUpBox").classList.toggle("hidden", !canSee("bookings"));
    el("todayOutBox").classList.toggle("hidden", !canSee("partners"));
    el("todayDigestBox").classList.toggle("hidden", !canSee("settings"));
  }

  // ---- Modal (shared by Change password, Team, and new modules) ----
  // openModal(html, {onClose, locked, sheet}) -> the .modal element. locked = no click-outside / Escape close;
  // sheet = slides up from the bottom on a phone.
  function openModal(html, opts = {}) {
    const wrap = document.createElement("div");
    wrap.className = "modal-wrap" + (opts.sheet ? " sheet" : "");
    wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + "</div>";
    document.querySelector(".aca").appendChild(wrap);
    const modal = wrap.firstChild;
    function close() { wrap.remove(); document.removeEventListener("keydown", onKey); if (opts.onClose) opts.onClose(); }
    function onKey(e) { if (e.key === "Escape" && !opts.locked) close(); }
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (e) => { if (e.target === wrap && !opts.locked) close(); });
    modal.close = close;
    const first = modal.querySelector("input, select, textarea, button.primary");
    if (first) first.focus();
    return modal;
  }

  // ---- Change password (account menu; forced after a temporary password) ----
  // recovery: back from a "Forgot password" email.
  function openPasswordDialog(forced, recovery) {
    const m = openModal(
      "<h2>" + (recovery ? "Choose a new password" : forced ? "Choose your own password" : "Change password") + "</h2>" +
      (recovery ? '<p class="muted">You opened a password reset link. Pick a new password to continue.</p>'
        : forced ? '<p class="muted">You signed in with a temporary password. Pick one only you know to continue.</p>' : "") +
      '<form id="aca-pwForm" autocomplete="on">' +
      '<input type="text" name="username" autocomplete="username" value="' + esc(ACCESS.email || "") + '" class="hidden" readonly />' +
      '<div class="field"><label for="aca-pw1">New password</label><input type="password" id="aca-pw1" autocomplete="new-password" minlength="10" required /></div>' +
      '<div class="field"><label for="aca-pw2">Type it again</label><input type="password" id="aca-pw2" autocomplete="new-password" minlength="10" required /></div>' +
      '<p class="muted" style="margin:0 0 12px;font-size:12.5px">At least 10 characters. A few unrelated words works well.</p>' +
      '<div class="inline-error hidden" id="aca-pwErr"></div>' +
      '<div class="modal-actions">' + (forced ? '<button type="button" class="small" id="aca-pwOut">Sign out</button>' : '<button type="button" class="small" id="aca-pwCancel">Cancel</button>') +
      '<button type="submit" class="primary" id="aca-pwSave">Save password</button></div></form>', { locked: forced });
    const err = (t) => { const n = el("pwErr"); n.textContent = t; n.classList.remove("hidden"); };
    if (forced) el("pwOut").addEventListener("click", async () => { await supabase.auth.signOut(); location.reload(); });
    else el("pwCancel").addEventListener("click", () => m.close());
    el("pwForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const p1 = el("pw1").value, p2 = el("pw2").value;
      if (p1.length < 10) return err("Use at least 10 characters.");
      if (p1 !== p2) return err("The two passwords don't match.");
      el("pwSave").disabled = true;
      const { error } = await supabase.auth.updateUser({ password: p1 });
      el("pwSave").disabled = false;
      if (error) return err(error.message || "Could not change the password.");
      await supabase.rpc("me_password_changed");
      ACCESS.must_change_password = false;
      RECOVERY = false;
      m.close();
      toast("Password changed.");
      // A new hire's next step: notifications on this phone (offers, schedule changes). Asked once, right here.
      if (forced && !recovery) Push.ask("So you hear about jobs offered to you and changes to your schedule, turn on notifications on this phone.");
      else NotifCard.load();
    });
  }
  el("pwBtn").addEventListener("click", () => { el("whoMenu").classList.add("hidden"); openPasswordDialog(false); });

