// 207 Admin (formerly Access Code Admin) -- the internal admin page at 207photo.com/207-admin/.
//
// READABLE SOURCE, split by section (2026-09-26 restructure). build-embed.sh concatenates, in order:
//   shell-top.js        client, helpers, auth, section router, attention/Today
//   jobs.js             JOBS: Jobs (+ drawer), Search settings, Blocked names
//   parents.js          PARENTS: Help requests, Makeups
//   partners-prospect-tools.js, partners-orgs.js, partners-library.js, partners-hub.js
//                       PARTNERS: Organizations, Ready to send, Library
//   system.js           SYSTEM: Search log, Sync log (+ data quality), header sync status
//   shell-end.js        auth listener + init()
// into ONE function body (shared scope), base64-encodes it, and drops it into shell.html + the
// section *.html partials to make wordpress-embed.html. Each part on its own is not valid JS.
// base64 is there so WordPress's content filters (wptexturize) cannot corrupt the script.
//
// Security model: the page uses ONLY the public anon key. All data access is gated by
// Postgres RLS + the visitor's own Supabase Auth login. "Sync now" POSTs to the `admin`
// Edge Function's /sync route, which validates the JWT and holds the sync secret server-side.
(function boot() {
  if (!window.supabase || !window.supabase.createClient) { setTimeout(boot, 60); return; }

  const SUPABASE_URL = "https://socluffmclkdljtmiexw.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable__ApsyWQ--LsPA8D7Lixn2A_6YrNyKTd";
  const ADMIN_FN_URL = "https://socluffmclkdljtmiexw.supabase.co/functions/v1/admin";

  const BOOT_URL = location.hash + location.search; // before supabase-js reads (and clears) a recovery link
  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Searchable match fields ('team'/'group' are gone: the team/class dropdown is
  // data-driven and configured only through its label). Order here = display order
  // whenever a per-job override is saved.
  const MATCH_FIELD_OPTIONS = [
    { key: "first_name",  label: "First name" },
    { key: "last_name",   label: "Last name" },
    { key: "teacher",     label: "Teacher" },
    { key: "identifier",  label: "Student ID / identifier" },
    { key: "birthdate",   label: "Birthdate" },
    { key: "institution", label: "School / institution" },
    { key: "city",        label: "Home town / city" },
    { key: "state",       label: "Home state" },
    { key: "zip",         label: "Home ZIP code" },
  ];
  // Global default widget labels — mirror effective_search_config() in Postgres.
  const DEFAULT_LABELS = {
    first_name: "Student / athlete first name", last_name: "Last name",
    teacher: "Teacher's last name", identifier: "ID number",
    birthdate: "Student's date of birth", institution: "School name",
    city: "Home town / city", state: "Home state", zip: "Home ZIP code",
  };
  const DEFAULT_GROUP_LABEL = "Team / class";
  const GROUP_DISPLAY_LABELS = {
    full: "the full value (e.g. \u201c1 - Boone\u201d)",
    before_dash: "only the part before the dash (e.g. \u201c1\u201d)",
  };
  const SEARCH_KEY_LABELS = {
    first_name: "first", last_name: "last", teacher: "teacher", identifier: "ID",
    birthdate: "DOB", institution: "school", city: "city", state: "state", zip: "ZIP",
    group: "team/class",
  };

  // ---- helpers ----
  // All element ids in the page markup are prefixed "aca-" to avoid theme collisions.
  const el = (id) => document.getElementById("aca-" + id);

  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }
  // numbers that come from RPCs are rendered through this so a changed return type can never inject markup
  const num = (v) => Number(v) || 0;
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
      timeZoneName: "short",
    });
  }
  function fmtAgo(iso) {
    if (!iso) return "never";
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  // One date format for lists (consistency rule, 2026-10-24): days read "Wed, Nov 18", times "2:10pm", both
  // "Wed, Nov 18, 2:10pm". The full date with the year (fmtDate above) is only for history and logs.
  // A bare "YYYY-MM-DD" is a calendar day (no time zone shift); anything else is a moment shown in Maine time.
  const Fmt = (function () {
    const TZ = "America/New_York";
    const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    function day(v) {
      if (!v) return "";
      const d = isDay(v) ? new Date(v + "T12:00:00Z") : new Date(v);
      if (isNaN(d)) return String(v);
      return d.toLocaleDateString("en-US", { timeZone: isDay(v) ? "UTC" : TZ, weekday: "short", month: "short", day: "numeric" });
    }
    function time(v) {
      if (!v) return "";
      const d = new Date(v);
      if (isNaN(d)) return "";
      return d.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).replace(/\s*([AP])M$/i, (_m, p) => p.toLowerCase() + "m");
    }
    // "15:00" (a time of day from settings) -> "3:00pm"
    function hhmm(t) {
      const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); if (!m) return "";
      const h = +m[1];
      return ((h + 11) % 12 + 1) + ":" + m[2] + (h < 12 ? "am" : "pm");
    }
    return { day, time, hhmm, dayTime: (v) => [day(v), time(v)].filter(Boolean).join(", ") };
  })();

  function showError(id, msg) {
    const node = el(id);
    if (!node) return;
    node.textContent = msg;
    node.classList.remove("hidden");
  }
  function clearError(id) { const n = el(id); if (n) n.classList.add("hidden"); }

  let toastTimer;
  function toast(msg, isErr = false) {
    const t = el("toast");
    t.textContent = msg;
    t.classList.toggle("err", isErr);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---- auth flow ----
  // Pages for people outside 207 Photo, opened from a link with a token and shown instead of sign-in.
  // A module calls registerPublicPage({ wanted: () => bool, show: () => void }) (pictureday-public.js).
  const PUBLIC_PAGES = [];
  function registerPublicPage(p) { PUBLIC_PAGES.push(p); }
  // Back from a "Forgot password" email: Supabase signs the person in with a recovery session, then the app
  // asks for a new password (the same dialog as after a temporary password). Read before supabase-js tidies the URL.
  let RECOVERY = /type=recovery/.test(BOOT_URL);
  async function init() {
    if (Welcome.wanted()) { Welcome.show(init); return; } // #welcome: getting the phone app (welcome.js)
    if (Agree.wanted()) { Agree.show(); return; } // #agree/<token>: a partner accepting their agreement (partners-follow.js)
    const pub = PUBLIC_PAGES.find((p) => p.wanted());
    if (pub) { pub.show(); return; }
    const { data: { session } } = await supabase.auth.getSession();
    if (session) afterSignIn(session);
    else showLogin();
  }

  function showLogin() {
    el("loginView").classList.remove("hidden");
    el("loginForm").classList.remove("hidden");
    el("codeForm").classList.add("hidden");
    el("dashView").classList.add("hidden");
  }

  // Second step after the password: the database refuses admin data until this SESSION is trusted
  // (public.admin_session_ok). A remembered browser trusts it silently with its device token;
  // otherwise a 6-digit code is emailed and checked by admin_verify_code.
  const DEVICE_KEY = "aca-device";
  function deviceToken() { try { return localStorage.getItem(DEVICE_KEY) || ""; } catch (_) { return ""; } }
  function deviceLabel() {
    const ua = navigator.userAgent;
    const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";
    const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
    return os + " · " + br;
  }
  async function afterSignIn(session) {
    try {
      const { data: ok, error } = await supabase.rpc("admin_session_ok");
      if (error) throw error;
      if (ok) { showDashboard(session); return; }
      const tok = deviceToken();
      if (tok) {
        const { data: used } = await supabase.rpc("admin_use_device", { p_token: tok });
        if (used) { showDashboard(session); return; }
        try { localStorage.removeItem(DEVICE_KEY); } catch (_) {}
      }
      await sendCode(true);
      showCodeForm();
    } catch (err) {
      // older database without the trust step: fall through
      showDashboard(session);
    }
  }
  async function sendCode(first) {
    const hint = el("codeHint"), errBox = el("codeError");
    const { data, error } = await supabase.rpc("admin_send_code");
    if (error) { errBox.textContent = error.message; errBox.classList.remove("hidden"); return; }
    if (data && data.ok) {
      hint.textContent = (first ? "We sent a 6-digit code to " : "New code sent to ") + (data.to || "your email") + ". It expires in 10 minutes.";
    } else if (data && data.error === "wait") {
      hint.textContent = "A code was sent less than a minute ago. Check your email (and spam), or resend in " + data.seconds + " s.";
    } else {
      errBox.textContent = "Could not send the code (" + ((data && data.error) || "unknown") + ").";
      errBox.classList.remove("hidden");
    }
  }
  function showCodeForm() {
    el("loginView").classList.remove("hidden");
    el("dashView").classList.add("hidden");
    el("loginForm").classList.add("hidden");
    el("codeForm").classList.remove("hidden");
    el("codeError").classList.add("hidden");
    el("code").value = "";
    el("code").focus();
  }
  el("codeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = el("codeBtn"), errBox = el("codeError");
    errBox.classList.add("hidden");
    btn.disabled = true;
    try {
      const { data, error } = await supabase.rpc("admin_verify_code", { p_code: el("code").value.trim() });
      if (error) throw error;
      if (!data || !data.ok) {
        const why = (data && data.error) || "wrong";
        throw new Error(why === "wrong" ? "That code isn't right (" + data.left + " tries left)." :
                        why === "expired" ? "That code expired. Click Resend code." :
                        why === "too_many" ? "Too many tries. Click Resend code for a new one." :
                        "Please request a new code.");
      }
      if (el("remember").checked) {
        const { data: tok } = await supabase.rpc("admin_remember_device", { p_label: deviceLabel() });
        if (tok) { try { localStorage.setItem(DEVICE_KEY, tok); } catch (_) {} }
      }
      const { data: { session } } = await supabase.auth.getSession();
      showDashboard(session);
    } catch (err) {
      errBox.textContent = err.message || "That code didn't work.";
      errBox.classList.remove("hidden");
      el("code").value = "";
      el("code").focus();
    } finally { btn.disabled = false; }
  });
  el("codeResend").addEventListener("click", () => sendCode(false));
  el("codeCancel").addEventListener("click", async () => { await supabase.auth.signOut(); location.reload(); });

  async function showDashboard(session) {
    el("loginView").classList.add("hidden");
    el("dashView").classList.remove("hidden");
    // Which modules this person may use (access.js). Everything below only loads what they can see.
    await loadAccess(session);
    renderRail();
    applyAccessChrome();
    // Categories + rules first: the Jobs table's "why" column needs them.
    if (canSeeAny(["galleries", "findmyphotos"])) await ensureRules();
    if (canSeeAny(["galleries", "findmyphotos", "parents"])) loadJobs();
    if (canSee("findmyphotos")) loadBlocks();
    // Everything Today summarizes. Today shows "Checking..." until these settle.
    todayFirst = Promise.all(todayLoaders(true)).catch(() => {}).then(markUnchecked);
    foldHelp();
    showTab(tabFromHash() || "today");
    startTodayRefresh();
    loadHelpContacts();
    if (ACCESS.must_change_password || RECOVERY) openPasswordDialog(true, RECOVERY);
    else NotifCard.load();
  }
  // The rail's "Synced 2 min ago" line is for people who look after galleries or settings; it opens Settings > Company.
  const seesSync = () => canSeeAny(["galleries", "settings"]);
  // The loaders behind Today's attention list, limited to the modules this person can see.
  function todayLoaders(first) {
    const L = seesSync() ? [loadSyncStatus()] : [];
    if (canSee("parents")) L.push(loadRequests(), loadMakeups(), loadRetakes());
    if (canSee("hub")) L.push(loadHubActivity());
    if (canSee("settings")) L.push(first ? loadHealth() : loadDataQuality());
    if (canSee("partners")) L.push(Orgs.loadAttention(), Outbox.loadToday());
    if (canSee("bookings")) L.push(Bookings.loadAttention(), loadComingUp());
    TODAY_LOADERS.forEach(([m, fn]) => { if (canSee(m)) L.push(fn()); });
    return L;
  }

  el("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = el("loginBtn");
    const errBox = el("loginError");
    errBox.classList.add("hidden");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    const email = el("email").value.trim();
    const password = el("password").value;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    btn.textContent = "Sign in";
    if (error) {
      errBox.textContent = error.message || "Sign-in failed. Check your email and password.";
      errBox.classList.remove("hidden");
      return;
    }
    el("password").value = "";
    afterSignIn(data.session);
  });

  // Forgot password (2026-10-24): Supabase emails a link back to this page; the link signs them in with a
  // recovery session and the app asks for a new password (RECOVERY above). The link's address must be in
  // Supabase Auth > URL configuration > Redirect URLs.
  el("forgotBtn").addEventListener("click", async () => {
    const email = el("email").value.trim(), errBox = el("loginError"), note = el("forgotNote");
    errBox.classList.add("hidden");
    if (!email || !/@/.test(email)) { errBox.textContent = "Type your email above first, then click Forgot password."; errBox.classList.remove("hidden"); el("email").focus(); return; }
    el("forgotBtn").disabled = true;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    el("forgotBtn").disabled = false;
    if (error) { errBox.textContent = error.message || "Could not send the email. Try again in a minute."; errBox.classList.remove("hidden"); return; }
    note.textContent = "If " + email + " has an account, a link to choose a new password is on its way. Open it on this device.";
    note.classList.remove("hidden");
  });

  el("signOutBtn").addEventListener("click", async () => {
    await supabase.auth.signOut();
    location.reload();
  });


  // ================= Pages + router (2026-10-12 redesign; one registry 2026-10-21) =================
  // RAIL is the single list of pages: it builds the menu, the router, Cmd-K's page list and the access
  // checks. Each item is one menu entry; `tabs` are the panels it shows as a tab strip (first = default);
  // `module` is its key in public.app_modules (null = everyone signed in); `section` is the hash prefix.
  // Hashes keep the old "#section/tab[/id]" shape so links in emails and the modules' own
  // replaceState calls (#jobs/bookings/<id>, #partners/orgs/<id>) keep working.
  // New modules add themselves from their own src file with registerPage({...}): see docs/ADDING-A-MODULE.md.
  const RAIL = [
    { id: "today",     group: "",         section: "today",    module: null,           tabs: [["today", "Today"]] },
    { id: "bookings",  group: "Jobs",     section: "jobs",     module: "bookings",     tabs: [["bookings", "Bookings"]] },
    { id: "jobs",      group: "Jobs",     section: "jobs",     module: "galleries",    tabs: [["jobs", "Galleries"]] },
    { id: "calc",      group: "System",   section: "system",    module: "bookings",     tabs: [["calc", "Job calculator"]] },
    { id: "requests",  group: "Parents",  section: "parents",  module: "parents",      tabs: [["requests", "Help requests"]] },
    { id: "makeups",   group: "Parents",  section: "parents",  module: "parents",      tabs: [["makeups", "Makeups"]] },
    { id: "retakes",   group: "Parents",  section: "parents",  module: "parents",      tabs: [["retakes", "Retakes"]] },
    { id: "searchlog", group: "Parents",  section: "parents",  module: "findmyphotos", title: "Find My Photos", tabs: [["searchlog", "Activity"], ["settings", "Search rules"], ["blocks", "Blocked"]] },
    { id: "orgs",      group: "Partners", section: "partners", module: "partners",     tabs: [["orgs", "All partners"]],
      search: [["Clients", "clients"], ["Active leads", "active"], ["Prospecting", "prospecting"], ["Cold leads", "cold"], ["Follow up later", "later"], ["Past clients", "past"]] },
    { id: "outbox",    group: "Partners", section: "partners", module: "partners",     title: "Outbox", tabs: [["outbox", "Outbox"]] }, // #partners/ready: outbox.js sends it to the Outbox (ws/partners)
    { id: "library",   group: "Partners", section: "partners", module: "partners",     tabs: [["library", "Email library"]] },
    { id: "sending",   group: "System",   section: "system",   module: "settings",     title: "Settings", tabs: [["sending", "Sending"], ["health", "Sync"], ["signin", "Sign-in"]] },
  ];
  // MENU (polish pass, 2026-10-23; reshaped 2026-10-24 to the walkthrough's menu) is the menu itself: groups, then
  // entries, each a list of tabs from RAIL items (so one entry can hold tabs of several modules, each still checked
  // against its own module). "tab=Label" renames a tab here; "tab@self" shows it only to people who can't edit its
  // module (their own view), "tab@edit" only to people who can, "@admin" only to full-access people; "@self:timeoff"
  // checks another module. A tab in no entry gets an entry of its own from its RAIL item (group = item.group), unless
  // it is in MOVED below. A tab listed here that no module has registered yet is skipped, so a page can join the
  // menu before its module is merged. An entry whose first tab this person can't see is named after the first one
  // they can (a part-timer's "My day" without the My day tab reads "My jobs").
  const MENU = [
    ["", [["today", "Today", ["today"]]]],
    ["My work", [["myday", "My day", ["myday", "crew=My jobs", "tasks@self=My tasks", "openjobs@self=Open jobs", "timeoff@self:timeoff"]],
                 ["mytime", "My time", ["clock@self", "timesheets@self", "mileage@self", "expenses@self"]],
                 ["myrecords", "My records", ["clearances@self", "onboarding@self"]]]],
    // Partner first (2026-10-23): everything about one league or school is on its own page (#partners/org/<id>,
    // orgpage.js), so the cross-partner lists sit under three entries. The fourth item is the Today area.
    // 2026-10-24: Organizations is now Partners; Outreach to review lives in the Outbox; Seasons, Sales by job and
    // Payouts are one Jobs > Sales tab (resjobs). 2026-10-25: Hub activity is on each job's Parents tab.
    ["Work", [["orgs", "Partners", ["orgs=All partners", "outbox=Outbox", "rebook=Due to rebook", "reviews", "agreements"], "Partners"],
              ["jobs", "Jobs", ["bookings=All jobs", "jobs=Galleries", "resjobs=Sales"], "Jobs"],
              ["parents", "Parents", ["requests", "makeups", "retakes", "searchlog=Find My Photos", "settings=Search rules", "blocks=Blocked"], "Parents"]]],
    ["Team", [["schedule", "Schedule", ["schedule", "openjobs@edit=Open jobs", "timeoff@edit:timeoff=Time off"]],
              ["tasks", "Tasks", ["tasks@edit"]],
              ["people", "People", ["team", "clearances@edit=Clearances", "onboarding@edit"]],
              ["timepay", "Time & pay", ["clock@edit=Who's in", "timesheets@edit", "mileage@edit", "expenses@edit"]]]],
    ["Gear", [["inventory", "Inventory", ["inventory", "invbins", "invkits", "invout", "invgear"]]]],
    // Settings (2026-10-24): per job type and "when emails go out" live here. Sync and Sign-in fold into Company.
    ["System", [["sending", "Settings", ["sending", "teamemails=Team emails", "jobtypes=Job types", "teampay=Team & pay", "company=Company",
                                          "library=Email library", "delivery=Bounced", "calc@admin=Job calculator"]]]],
  ];
  // Tabs that moved in the 2026-10-24 reshape. Old links (#jobs/payouts, #partners/ready, #system/health...) land on
  // the first of these that's in this person's menu. If none is yet (its module isn't merged), the old page still
  // opens on its own, outside the menu.
  const MOVED = { payouts: ["resjobs"], seasons: ["resjobs"], ready: ["outbox"], schools: ["bookings"], hubact: ["bookings"], checklists: ["bookings"],
    wfsteps: ["jobtypes"], health: ["company"], signin: ["company"] };
  // ...except these, whose pages still work on their own until their module hides or drops them (Seasons and Payouts
  // become Jobs > Sales; Job checklists becomes a column on All jobs). Until then their links open the old page.
  const KEEP_UNTIL_RETIRED = new Set(["seasons", "payouts", "checklists", "wfsteps"]);
  // Words that stand for a page on their own in a link: #partners, #sales, #settings-like #system, #gear, #me.
  const ALIASES = { partners: "orgs", organizations: "orgs", prospects: "orgs", outreach: "outbox", sales: "resjobs", payouts: "resjobs",
    people: "team", gear: "inventory", ops: "inventory", system: "sending", me: "myday", staff: "myday", work: "orgs" };
  // The hash section each menu entry writes (old sections still read fine: #staff/clock, #system/team).
  const ENTRY_SECTION = { myday: "me", mytime: "me", myrecords: "me", schedule: "team", tasks: "team", people: "team", timepay: "team",
    inventory: "gear", sending: "system", orgs: "partners", jobs: "jobs", parents: "parents" };
  function registerPage(item) { RAIL.push(item); }
  const itemOf = (tab) => RAIL.find((it) => it.tabs.some((t) => t[0] === tab));
  const sectionOf = (tab) => { const it = itemOf(tab); return it ? { id: it.section } : null; };
  // "openjobs@self:timeoff=Open jobs" -> { tab, cond, module, label }
  function parseSpec(s) {
    const [head, label] = s.split("=");
    const [tab, c] = head.split("@");
    const [cond, module] = (c || "").split(":");
    return { tab, cond: cond || "", module, label };
  }
  function specShows(sp) {
    const it = itemOf(sp.tab);
    if (!it || it.hidden || !canSee(it.module)) return false;
    const m = sp.module || it.module;
    if (sp.cond === "admin") return !!ACCESS.is_admin;
    if (sp.cond === "edit") return !!m && canEdit(m);
    if (sp.cond === "self") return !m || !canEdit(m);
    return true;
  }
  // The menu as this person sees it: [{ group, id, title, tabs: [[tab, label], ...] }], empty entries left out.
  function menuEntries() {
    const out = [], listed = new Set(Object.keys(MOVED));
    const order = MENU.map((g) => g[0]);
    MENU.forEach(([group, entries]) => entries.forEach(([id, title, specs, area]) => {
      const tabs = [], all = specs.map(parseSpec);
      all.forEach((sp) => {
        listed.add(sp.tab);
        const it = itemOf(sp.tab); if (!it || !specShows(sp)) return; // not registered yet, or not for this person
        tabs.push([sp.tab, sp.label || it.tabs.find((t) => t[0] === sp.tab)[1]]);
      });
      if (!tabs.length) return;
      const named = tabs[0][0] === all[0].tab || !itemOf(all[0].tab) ? title : tabs[0][1];
      out.push({ group, id, title: named, tabs, area: area || group });
    }));
    RAIL.forEach((it) => {
      if (it.hidden || !canSee(it.module)) return;
      const tabs = it.tabs.filter((t) => !listed.has(t[0]));
      if (!tabs.length) return;
      const group = (it.group || "").replace("Outreach", "Work");
      if (!order.includes(group)) order.splice(order.length - 1, 0, group);
      out.push({ group, id: it.id, title: it.label || it.title || tabs[0][1], tabs, area: group });
    });
    return order.filter((g, i) => order.indexOf(g) === i).flatMap((g) => out.filter((e) => e.group === g));
  }
  let MENU_NOW = [];
  const entryOf = (tab) => MENU_NOW.find((e) => e.tabs.some((t) => t[0] === tab));
  const pageOf = (id) => { const e = MENU_NOW.find((x) => x.id === id); return e && e.tabs.length > 1 ? e : null; };
  // The tab to show for a key: itself when it's in this person's menu (or a page outside the menu, like a job),
  // otherwise where it moved to.
  function liveTab(tab) {
    const it = itemOf(tab);
    return it && !it.hidden && KEEP_UNTIL_RETIRED.has(tab) && !entryOf(tab) ? tab : homeTab(tab);
  }
  // Where a tab sits in the menu (for badges, Today's areas and names), even while its old page still opens on its own.
  function homeTab(tab) {
    const it = itemOf(tab);
    if (it && (it.hidden || entryOf(tab))) return tab;
    return (MOVED[tab] || []).find((t) => entryOf(t)) || tab;
  }
  // Open the first of these pages this person has (Settings > Company, else the old Sync tab...).
  function showFirst(tabs) { const t = tabs.map(liveTab).find((x) => entryOf(x) || (itemOf(x) && MOVED[x] && canSee(itemOf(x).module))); if (t) showTab(t); }
  // the menu entry a tab belongs to
  function railItemOf(tab) { const e = entryOf(homeTab(tab)); return e ? e.id : tab; }
  // a tab's name as Today and search show it ("Find My Photos", not "Activity")
  function tabName(tab) {
    tab = homeTab(tab);
    const e = entryOf(tab);
    if (e) return e.tabs[0][0] === tab || e.tabs.length === 1 ? e.title : e.tabs.find((t) => t[0] === tab)[1];
    const it = itemOf(tab);
    if (!it) return "";
    return it.title && it.tabs[0][0] === tab ? it.title : it.tabs.find((t) => t[0] === tab)[1];
  }
  function renderRail() {
    MENU_NOW = menuEntries();
    let last = null;
    el("nav").innerHTML = MENU_NOW.map((e) => {
      const head = e.group === last ? "" : e.group === "System" ? '<h4 class="sp" aria-hidden="true"></h4>' : e.group ? "<h4>" + esc(e.group) + "</h4>" : "";
      last = e.group;
      return head + '<button type="button" data-tab="' + esc(e.id) + '" aria-selected="false">' + esc(e.title) + '<span class="n" id="aca-nav-' + esc(e.id) + '"></span></button>';
    }).join("");
  }
  const lastTab = {}; // rail item -> last inner tab shown
  let currentTab = null, currentPage = null;
  let searchLogLoaded = false;

  // fromHash: the address already changed (a link, Back/Forward), so only tidy it, never add a history entry.
  function showTab(name, fromHash) {
    name = liveTab(name);
    const sec = sectionOf(name);
    if (!sec) return;
    const it = itemOf(name);
    const alone = !it.hidden && !entryOf(name) && !!MOVED[name]; // moved, with nowhere to land yet: the old page, outside the menu
    if (!canSee(it.module) || (!it.hidden && !alone && MENU_NOW.length && !entryOf(name))) { if (name !== "today") showTab("today"); return; }
    currentTab = name;
    // A page outside the menu (a job, a partner) lights up the entry it belongs to.
    const item = (it.hidden && it.navAs) || railItemOf(name);
    if (!it.hidden && !alone) lastTab[item] = name;
    document.querySelectorAll("#aca-nav button[data-tab]").forEach((b) =>
      b.setAttribute("aria-selected", b.dataset.tab === item ? "true" : "false"));
    // A job or partner page has its own tabs; the list's tab strip above it would be a third row of tabs.
    renderPageTabs(it.hidden || alone ? null : item, name);
    document.querySelectorAll(".aca section.panel").forEach((p) => p.classList.remove("active"));
    el("panel-" + name).classList.add("active");
    // Browser Back (2026-10-24): moving to another page adds a history entry; switching tabs inside a page replaces it.
    const page = it.hidden || alone ? name : item;
    const hash = name === "today" ? "#today" : "#" + ((!it.hidden && ENTRY_SECTION[item]) || sec.id) + "/" + name;
    // An old or alias address for this page (#system/team, #staff/clock) is tidied to the menu's (#team/team, #me/clock);
    // one that goes deeper (#jobs/bookings/<id>, #partners/orgs/clients) is the module's and stays as it is.
    if (tabFromHash() !== name || !location.hash || (location.hash !== hash && location.hash.split("/").length <= 2)) {
      if (!fromHash && currentPage && currentPage !== page) history.pushState(null, "", hash); else history.replaceState(null, "", hash);
    }
    currentPage = page;
    closeRail();
    if (name === "searchlog" && !searchLogLoaded) loadSearchLog();
    if (name === "orgs") Orgs.load(); else Orgs.hide();
    if (name === "bookings") Bookings.load(); else Bookings.hide();
    if (name === "ready") Orgs.loadReady();
    if (name === "outbox") Outbox.load(); else Outbox.hide();
    if (name === "sending") SendingSettings.load();
    if (name === "retakes") loadRetakes();
    if (name === "library") { Orgs.measureTop(); Library.load(); BookingLibrary.load(); }
    if (name === "today") refreshToday();
    if (name === "calc") JobCalc.load();
    if (it.onShow) it.onShow(name);
    el("viewOnly").textContent = "You have view-only access here. " + askWho("Ask", "if you need to make changes.");
    el("viewOnly").classList.toggle("hidden", !it.module || canEdit(it.module) || it.selfService);
    window.scrollTo(0, 0);
  }
  function renderPageTabs(item, name) {
    const strip = el("pagetabs");
    const page = item && pageOf(item);
    if (!page) { strip.classList.add("hidden"); strip.innerHTML = ""; return; }
    strip.innerHTML = '<h1>' + esc(page.title) + '</h1><div class="pt-row">' + page.tabs.map((t) => '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (t[0] === name) + '">' + esc(t[1]) + '<span class="n" id="aca-ptab-' + t[0] + '"></span></button>').join("") + "</div>";
    strip.classList.remove("hidden");
    renderAttention();
  }
  el("pagetabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });
  // "#partners/outbox", "#prospects" (old add-on link), "#partners/org/<id>", "#jobs/payouts" (moved), "#sales", or "#today".
  function tabFromHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ""));
    const segs = h.split("/").filter(Boolean).slice(0, 2).reverse();
    for (const s0 of segs) {
      const s = !itemOf(s0) && ALIASES[s0] ? ALIASES[s0] : s0;
      if (itemOf(s)) return s;
      const to = (MOVED[s] || []).find((t) => itemOf(t));
      if (to) return to;
    }
    return null;
  }
  el("nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) { const e = MENU_NOW.find((x) => x.id === b.dataset.tab); if (e) showTab(lastTab[e.id] || e.tabs[0][0]); }
  });
  window.addEventListener("hashchange", () => { const t = tabFromHash(); if (t && liveTab(t) !== currentTab) showTab(t, true); });

  // Rail on narrow screens: a drawer behind the menu button.
  function closeRail() { el("shell").classList.remove("railopen"); }
  el("menuBtn").addEventListener("click", () => el("shell").classList.toggle("railopen"));
  el("railbg").addEventListener("click", closeRail);
  // Account menu
  el("whoBtn").addEventListener("click", (e) => { e.stopPropagation(); const m = el("whoMenu"); m.classList.toggle("hidden"); el("whoBtn").setAttribute("aria-expanded", String(!m.classList.contains("hidden"))); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#aca-whoMenu, #aca-whoBtn")) { el("whoMenu").classList.add("hidden"); el("whoBtn").setAttribute("aria-expanded", "false"); } });
  // On a partner's page, Book a job starts with that partner picked. On a phone it is the + in the top bar.
  el("bookBtn").addEventListener("click", () => { const org = currentTab === "org" ? OrgPage.current() : null; showTab("bookings"); Bookings.openNew(org); });
  // The rail's sync line opens Settings > Company (or the Sync tab until Company exists).
  el("syncStatus").addEventListener("click", () => { if (seesSync()) showFirst(["company", "health"]); });
  el("syncStatus").addEventListener("keydown", (e) => { if (e.key === "Enter" && seesSync()) showFirst(["company", "health"]); });

  // Help (2026-10-24): who to ask, by name, with a phone and email people can copy (help_contacts).
  // askWho("Ask", "to add the area on the Team page.") -> "Ask Jeremiah to add the area on the Team page."
  let HELP = [];
  async function loadHelpContacts() {
    try {
      const { data, error } = await supabase.rpc("help_contacts");
      if (error) throw error;
      HELP = Array.isArray(data) ? data : [];
    } catch (_e) { HELP = []; }
    const box = el("whoHelp"); if (!box) return;
    const others = HELP.filter((h) => (h.email || "").toLowerCase() !== (ACCESS.email || "").toLowerCase());
    box.innerHTML = others.length ? '<div class="h">Help</div>' + others.map((h) => '<div class="p"><b>' + esc(h.name || h.email) + "</b>" +
      (h.phone ? '<span><a href="tel:' + esc(String(h.phone).replace(/[^0-9+]/g, "")) + '">' + esc(h.phone) + "</a></span>" : "") +
      (h.email ? '<span><a href="mailto:' + esc(h.email) + '">' + esc(h.email) + "</a></span>" : "") + "</div>").join("") : "";
    box.classList.toggle("hidden", !others.length);
  }
  function askWho(verb, rest) {
    const first = HELP.find((h) => (h.email || "").toLowerCase() !== (ACCESS.email || "").toLowerCase()) || HELP[0];
    const name = first && first.name ? String(first.name).split(/\s+/)[0] : "";
    return verb + " " + (name || "someone with full access") + " " + rest;
  }

  // Long help paragraphs under each heading fold behind "How this page works".
  function foldHelp() {
    document.querySelectorAll(".aca .card-head p").forEach((p) => {
      if (p.dataset.folded || p.closest("#aca-panel-library") || p.textContent.trim().length < 140) return;
      p.dataset.folded = "1";
      const body = document.createElement("div"); body.className = "howbody hidden"; body.innerHTML = p.innerHTML;
      p.innerHTML = '<button type="button" class="link howlink">How this page works</button>';
      p.after(body);
      p.querySelector("button").addEventListener("click", () => body.classList.toggle("hidden"));
    });
  }

  // Phone tables (2026-10-24). Opt in with <div class="table-wrap cards">: under 700px each row becomes a card, each cell
  // labelled with its column name (copied from the header here, so modules don't write data-label by hand). A cell with
  // class "act" holds the row's buttons and goes full width at the bottom of the card. CSS: ".table-wrap.cards" in shell.html.
  function labelCardTables() {
    document.querySelectorAll(".aca .table-wrap.cards table").forEach((t) => {
      const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
      if (!heads.length) return;
      t.querySelectorAll("tbody tr").forEach((tr) => {
        let col = 0;
        [...tr.children].forEach((td) => {
          const span = +td.getAttribute("colspan") || 1;
          if (span === 1 && !td.hasAttribute("data-label") && heads[col]) td.setAttribute("data-label", heads[col]);
          col += span;
        });
      });
    });
  }
  // Phone tab strips (2026-10-23): page tabs and job/partner tabs are one row you swipe. Keep the open tab in view and
  // fade whichever edge has more tabs past it (CSS: ".pt-row.more-r" in shell.html).
  function tabStripEdges(s) {
    const more = s.scrollWidth > s.clientWidth + 2;
    s.classList.toggle("more-l", more && s.scrollLeft > 2);
    s.classList.toggle("more-r", more && s.scrollLeft + s.clientWidth < s.scrollWidth - 2);
  }
  function revealTabStrips() {
    document.querySelectorAll(".aca .pt-row, .aca .jp-tabs").forEach((s) => {
      const on = s.querySelector('[aria-selected="true"]');
      if (on && on.dataset.shown !== "1" && s.scrollWidth > s.clientWidth) {
        on.dataset.shown = "1";
        const l = on.offsetLeft - s.offsetLeft, r = l + on.offsetWidth;
        if (l < s.scrollLeft || r > s.scrollLeft + s.clientWidth) s.scrollLeft = Math.max(0, l - (s.clientWidth - on.offsetWidth) / 2);
      }
      tabStripEdges(s);
    });
  }
  document.addEventListener("scroll", (e) => { const s = e.target; if (s.classList && (s.classList.contains("pt-row") || s.classList.contains("jp-tabs"))) tabStripEdges(s); }, true);
  window.addEventListener("resize", revealTabStrips);
  let cardsQueued = false;
  new MutationObserver(() => { if (cardsQueued) return; cardsQueued = true; requestAnimationFrame(() => { cardsQueued = false; labelCardTables(); revealTabStrips(); }); })
    .observe(document.querySelector(".aca"), { childList: true, subtree: true });

  // ================= Attention (rail badges + Today) =================
  // Each module reports "things that need Jeremiah" with setAttention() next to its own badge code.
  // Today sorts them into three groups by level: err = Fix now, warn = Waiting on you, soon = Check soon.
  const ATTENTION_ORDER = ["bookingFailed", "syncFailed", "bookingNoContact", "bookingNeedsTime", "bookingNeedsCode", "bookingNeedsJob", "bookingNeedsCoaches", "prospects", "requests", "makeups", "retakeDayTomorrow", "followups", "retakesNew", "hubLate", "bookingCalendar", "bookingNeedsTimeLater", "dataQuality"];
  // The module each item belongs to; people without it neither load nor see the item.
  const ATTENTION_MODULE = { bookingFailed: "bookings", bookingNoContact: "bookings", bookingNeedsTime: "bookings", bookingNeedsTimeLater: "bookings", bookingCalendar: "bookings",
    bookingNeedsCode: "bookings", bookingNeedsJob: "bookings", bookingNeedsCoaches: "bookings", prospects: "partners", followups: "partners", requests: "parents", makeups: "parents",
    retakeDayTomorrow: "parents", retakesNew: "parents", hubLate: "hub", syncFailed: "settings", dataQuality: "settings" };
  const attentionKeys = () => ATTENTION_ORDER.filter((k) => canSee(ATTENTION_MODULE[k]));
  // Items that are the person's own ("You were put on a job", "A job was offered to you"): Today shows them under
  // My work whatever page they open, so the Team area keeps approvals and staffing. registerAttention(key, { mine: true }).
  const MINE = new Set(["crewMine", "openJobsWaiting"]);
  // For new modules: registerAttention("shiftsUncovered", { module: "scheduling", level: "warn", name: "shift coverage",
  //   one: "A shift has nobody on it.", many: "{n} shifts have nobody on it." }); then setAttention(key, count, label, tab).
  // New modules add their Today check with registerTodayLoader("<module>", () => Thing.loadAttention()).
  const TODAY_LOADERS = [];
  function registerTodayLoader(module, fn) { TODAY_LOADERS.push([module, fn]); }
  function registerAttention(key, d) {
    ATTENTION_ORDER.push(key);
    ATTENTION_MODULE[key] = d.module;
    SENTENCES[key] = [d.one, d.many];
    if (d.level) LEVEL_OVERRIDE[key] = d.level;
    if (d.mine) MINE.add(key);
    ATTENTION_NAMES[key] = d.name || key;
  }
  const LEVEL_OVERRIDE = { bookingNeedsCoaches: "soon", retakesNew: "soon", followups: "soon", hubLate: "soon", bookingCalendar: "soon", dataQuality: "soon", bookingNeedsTimeLater: "soon" };
  // Sentences. [one, many]; {n} = count. Plain words: a new hire reads these too (no "hub row", "AD", "reply all").
  const SENTENCES = {
    bookingFailed:    ["A booking email failed to send.", "{n} booking emails failed to send."],
    syncFailed:       ["GotPhoto sync has been down for over an hour. Codes on Find My Photos may be out of date.", "GotPhoto sync has been down for over an hour."],
    bookingNoContact: ["A booking has nobody to email. Add a contact and the admin emails go out.", "{n} bookings have nobody to email."],
    bookingNeedsTime: ["A booking needs its start and end time. Emails that mention the time are waiting.", "{n} bookings need their start and end times."],
    bookingNeedsTimeLater: ["A booking has no time yet. No rush: it is more than three weeks out.", "{n} bookings have no time yet. No rush, they are more than three weeks out."],
    bookingNeedsCode: ["A school booking needs the school's access code before parents can find their photos.", "{n} school bookings need the school's access code before parents can find their photos."],
    bookingNeedsJob:  ["A sports booking isn't linked to its GotPhoto gallery yet.", "{n} sports bookings aren't linked to their GotPhoto galleries yet."],
    bookingNeedsCoaches: ["A sports booking is a week out with no coach email addresses yet. Ask the league to send them, or paste them on the booking.", "{n} sports bookings are a week out with no coach email addresses yet."],
    prospects:        ["An outreach email is waiting for your review.", "{n} outreach emails are waiting for your review."],
    requests:         ["A parent asked for help finding a code.", "{n} parents asked for help finding a code."],
    makeups:          ["A makeup to confirm and send.", "{n} makeups to confirm and send."],
    retakesNew:       ["A new retake request since yesterday.", "{n} new retake requests since yesterday."],
    followups:        ["A prospect follow-up is due.", "{n} prospect follow-ups are due."],
    hubLate:          ["A job's hub message is late: the team or school hasn't grabbed it.", "{n} jobs have late hub messages: the teams or schools haven't grabbed them."],
    bookingCalendar:  ["A booking is out of step with Google Calendar.", "{n} bookings are out of step with Google Calendar."],
    dataQuality:      ["A published gallery is missing search fields.", "{n} published galleries are missing search fields."],
  };
  // What's wrong, in a few words, on a line that names its job ("Island Cheer · Mon, Oct 26: nobody to email").
  const JOB_REASON = { bookingFailed: "an email failed to send", bookingNoContact: "nobody to email", bookingNeedsTime: "needs its start and end time",
    bookingNeedsTimeLater: "no time yet (no rush)", bookingCalendar: "out of step with Google Calendar", bookingNeedsCode: "needs the school's access code",
    bookingNeedsJob: "not linked to its GotPhoto gallery yet", bookingNeedsCoaches: "no coach email addresses yet", bookingDeliverablesOverdue: "a deliverable is overdue",
    photosMissing: "no photos in GotPhoto yet" };
  const GROUPS = [["err", "Fix now"], ["warn", "Waiting on you"], ["soon", "Check soon"]];
  const attention = {}; // key -> { count, label, tab, level, onGo, jobs }
  // jobs (optional, 2026-10-24): [{ id, title, day, tab? }] the bookings behind the count (tab: which job tab Open lands on). When they account for the whole
  // count, Today shows one line per job that opens that job instead of one count line that opens the list.
  function setAttention(key, count, label, tab, level, onGo, jobs) {
    attention[key] = { count: count || 0, label, tab, level: LEVEL_OVERRIDE[key] || level || "warn", onGo, key, jobs: Array.isArray(jobs) ? jobs : null };
    renderAttention();
  }
  function sentence(a) {
    const s = SENTENCES[a.key];
    if (!s) return a.label;
    return (a.count === 1 ? s[0] : s[1]).replace("{n}", a.count);
  }
  const todayOpen = new Set(), todayShut = new Set();
  try { JSON.parse(localStorage.getItem("aca-today-open") || "[]").forEach((x) => todayOpen.add(x)); JSON.parse(localStorage.getItem("aca-today-shut") || "[]").forEach((x) => todayShut.add(x)); } catch (_e) { /* private mode */ }
  const areaOf = (a) => { if (MINE.has(a.key)) return "My work"; const e = entryOf(homeTab(a.tab)); return (e && e.area) || "Other"; };
  function renderAttention() {
    // Badges: one number per menu entry and one per tab, each the sum of what's in it; red when anything in it is broken.
    const perItem = {}, perTab = {};
    const add = (box, k, a) => { box[k] = box[k] || { n: 0, bad: false }; box[k].n += a.count; if (a.level === "err") box[k].bad = true; };
    Object.values(attention).forEach((a) => {
      if (!a.count || !a.tab) return;
      add(perItem, railItemOf(a.tab), a);
      add(perTab, homeTab(a.tab), a);
    });
    document.querySelectorAll("#aca-pagetabs .n[id^='aca-ptab-']").forEach((n) => {
      const v = perTab[n.id.slice(9)];
      n.textContent = v ? v.n : ""; n.className = "n" + (v && v.bad ? " bad" : "");
    });
    document.querySelectorAll("#aca-nav button[data-tab]").forEach((b) => {
      const n = el("nav-" + b.dataset.tab); if (!n) return;
      const v = perItem[b.dataset.tab];
      n.textContent = v ? v.n : ""; n.className = "n" + (v && v.bad ? " bad" : "");
    });
    const items = attentionKeys().filter((k) => attention[k] && attention[k].count).map((k) => attention[k]);
    const pending = attentionKeys().filter((k) => !attention[k]).length;
    const total = items.reduce((n, a) => n + a.count, 0);
    const todayBadge = el("nav-today");
    if (!todayBadge) return;
    todayBadge.textContent = total || ""; todayBadge.className = "n" + (items.some((a) => a.level === "err") ? " bad" : "");
    const list = el("todayList");
    if (!items.length) {
      list.innerHTML = pending ? '<div class="empty"><span class="spin"></span>Checking everything&#8230;</div>' : '<div class="today-clear">All clear. Nothing needs you right now.</div>';
    } else {
      // Counts per area (the menu groups), each with a caret to see what's in it (polish pass 2026-10-23).
      // Areas with something broken start open, and so does My work (it's the person's own); the rest remember how they were left.
      const LV = { err: 0, warn: 1, soon: 2 };
      const order = MENU.flatMap(([g, entries]) => entries.map((x) => x[3] || g)).filter((g, i, all) => g && all.indexOf(g) === i).concat(["Other"]);
      const areas = order.map((name) => ({ name, rows: items.filter((a) => areaOf(a) === name).sort((x, y) => LV[x.level] - LV[y.level]) })).filter((x) => x.rows.length);
      const dot = (lv) => '<span class="today-dot ' + lv + '" title="' + esc(GROUPS.find((g) => g[0] === lv)[1]) + '"></span>';
      const row = (a) => {
        const jobs = a.jobs && a.jobs.length && a.jobs.length === a.count ? a.jobs : null;
        if (jobs) return jobs.map((j) => '<button type="button" class="today-item" data-job="' + esc(j.id) + '"' + (j.tab ? ' data-jobtab="' + esc(j.tab) + '"' : "") + ' data-key="' + esc(a.key) + '">' +
          '<span class="today-n">' + dot(a.level) + '</span><span class="today-l"><b>' + esc(j.title || "A job") + "</b>" + (j.day ? ' <span class="today-where">' + esc(Fmt.day(j.day)) + "</span>" : "") +
          ": " + esc(JOB_REASON[a.key] || sentence(a)) + '</span><span class="today-go">Open</span></button>').join("");
        return '<button type="button" class="today-item" data-go="' + esc(a.tab) + '" data-key="' + esc(a.key || "") + '">' +
          '<span class="today-n">' + dot(a.level) + esc(a.count) + '</span><span class="today-l">' + esc(sentence(a)) + ' <span class="today-where">' + esc(tabName(a.tab)) + '</span></span>' +
          '<span class="today-go">Open</span></button>';
      };
      list.innerHTML = '<div class="today-areas">' + areas.map((ar) => {
        const worst = ar.rows[0].level;
        const open = todayOpen.has(ar.name) || (!todayShut.has(ar.name) && (worst === "err" || ar.name === "My work"));
        const n = ar.rows.reduce((k, a) => k + a.count, 0);
        return '<div class="today-area' + (open ? " open" : "") + '" data-area="' + esc(ar.name) + '"><button type="button" class="today-ah" aria-expanded="' + open + '">' +
          '<span class="caret" aria-hidden="true">&#9656;</span><span class="today-an">' + esc(ar.name) + "</span>" + dot(worst) +
          '<span class="today-ac">' + n + "</span></button>" +
          '<div class="today-ab">' + ar.rows.map(row).join("") + "</div></div>";
      }).join("") + "</div>" + (pending ? '<div class="empty"><span class="spin"></span>Still checking a few things&#8230;</div>' : "");
    }
    renderLead(items, pending);
  }
  el("todayList").addEventListener("click", (e) => {
    const h = e.target.closest(".today-ah");
    if (h) {
      const box = h.parentElement, name = box.dataset.area, open = !box.classList.contains("open");
      box.classList.toggle("open", open); h.setAttribute("aria-expanded", String(open));
      if (open) { todayOpen.add(name); todayShut.delete(name); } else { todayOpen.delete(name); todayShut.add(name); }
      try { localStorage.setItem("aca-today-open", JSON.stringify([...todayOpen])); localStorage.setItem("aca-today-shut", JSON.stringify([...todayShut])); } catch (_e) { /* private mode */ }
      return;
    }
    const j = e.target.closest("[data-job]");
    if (j) { location.hash = jobLink(j.dataset.job, j.dataset.jobtab || "booking"); return; } // the job page (its Booking tab, or the tab the item names)
    const b = e.target.closest("[data-go]");
    if (!b) return;
    showTab(b.dataset.go);
    const a = attention[b.dataset.key];
    if (a && a.onGo) a.onGo();
  });

  // The lead sentence: "Two things are broken, seven are waiting on you, and the next picture day is Thursday with X."
  // For someone without full access it separates their own things from the office's: "Seven things need the office; two are yours."
  let nextUp = null; // from Bookings: [{picture_day, org, title, start, status}]
  const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const num2 = (n) => (n < WORDS.length ? WORDS[n] : String(n));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  function renderLead(items, pending) {
    const d = new Date();
    el("todayTitle").textContent = d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" });
    const sum = (f) => items.filter(f).reduce((n, a) => n + a.count, 0);
    const broken = sum((a) => a.level === "err");
    const waiting = sum((a) => a.level === "warn");
    const soon = sum((a) => a.level === "soon");
    let s;
    if (!ACCESS.is_admin) {
      const mine = sum((a) => a.level !== "soon" && areaOf(a) === "My work");
      const office = broken + waiting - mine;
      s = office ? cap(num2(office)) + (office === 1 ? " thing needs the office" : " things need the office") + (mine ? "; " + num2(mine) + (mine === 1 ? " is yours" : " are yours") : "; nothing is waiting on you")
        : mine ? cap(num2(mine)) + (mine === 1 ? " thing is waiting on you" : " things are waiting on you") : "Nothing is waiting on you";
    } else {
      const parts = [];
      if (broken) parts.push(num2(broken) + (broken === 1 ? " thing is broken" : " things are broken"));
      if (waiting) parts.push(num2(waiting) + (waiting === 1 ? " is waiting on you" : " are waiting on you"));
      if (!broken && !waiting) parts.push(soon ? "nothing is broken and nothing is waiting on you" : "nothing needs you");
      s = cap(parts.join(", "));
    }
    let next = "";
    if (nextUp && nextUp.length) {
      const b = nextUp[0];
      const days = Math.round((new Date(b.picture_day + "T12:00:00") - new Date(todayStrNY() + "T12:00:00")) / 864e5);
      const when = days === 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? new Date(b.picture_day + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" }) : Fmt.day(b.picture_day);
      next = ", and the next picture day is <b>" + esc(when) + " with " + esc(b.org_name || b.title || "") + "</b>";
    }
    el("todayLead").innerHTML = s + next + ". " + (pending ? '<span class="muted">Still checking a few things.</span>' : '<span class="muted">Checked ' + esc(Fmt.time(new Date())) + ".</span>");
  }
  const todayStrNY = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  async function loadComingUp() {
    try {
      const from = todayStrNY();
      const to = new Date(Date.now() + 60 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const { data, error } = await supabase.rpc("admin_bookings", { p_from: from, p_to: to });
      if (error) throw error;
      nextUp = (data || []).filter((b) => b.status === "booked").sort((a, b) => String(a.picture_day).localeCompare(String(b.picture_day))).slice(0, 4);
      el("todayUp").innerHTML = nextUp.length ? nextUp.map((b) => {
        const d = new Date(b.picture_day + "T12:00:00");
        const st = b.status_text ? '<div class="pill ' + esc(b.status_class || "muted") + '">' + esc(b.status_text) + "</div>" : "";
        return '<div class="today-up" data-booking="' + esc(b.id) + '"><div class="d">' + esc(d.toLocaleDateString("en-US", { weekday: "short" })) + '<small>' + esc(d.toLocaleDateString("en-US", { month: "short", day: "numeric" })) + '</small></div>' +
          '<div>' + esc(b.org_name || b.title || "") + '<div class="s">' + esc([b.type_label, b.location].filter(Boolean).join(", ")) + "</div>" + st + "</div></div>";
      }).join("") + '<p><a href="#jobs/bookings">All jobs</a></p>' : "<p>No picture days booked in the next 60 days. <a href=\"#jobs/bookings\">Book a job</a></p>";
    } catch (e) {
      el("todayUp").innerHTML = '<p class="muted">Could not load bookings.</p>';
    }
    renderAttention();
  }
  el("todayUp").addEventListener("click", (e) => {
    const r = e.target.closest("[data-booking]"); if (!r) return;
    location.hash = jobLink(r.dataset.booking); // straight to the job page
  });

  // "Turn on notifications on this phone" (2026-10-24): a card at the top of Today until this person has a device
  // with notifications on. Not now hides it on this device for two weeks.
  const NotifCard = (function () {
    const KEY = "aca-notif-card";
    const snoozed = () => { try { return Number(localStorage.getItem(KEY) || 0) > Date.now(); } catch (_e) { return false; } };
    async function load() {
      const box = el("todayNotif"); if (!box) return;
      if (snoozed()) { box.classList.add("hidden"); return; }
      const st = await Push.status();
      if (!st || st.devices > 0) { box.classList.add("hidden"); return; }
      const phone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent);
      box.innerHTML = '<div class="tn-t"><b>Turn on notifications on this ' + (phone ? "phone" : "computer") + '</b><span>So you hear about jobs offered to you and changes to your schedule.</span></div>' +
        '<div class="tn-b"><button type="button" class="small" data-n="on">Turn on</button><button type="button" class="small quiet" data-n="later" aria-label="Not now">Not now</button></div>';
      box.classList.remove("hidden");
    }
    const box0 = el("todayNotif");
    if (box0) box0.addEventListener("click", (e) => {
      const b = e.target.closest("[data-n]"); if (!b) return;
      if (b.dataset.n === "on") Push.open({ onClose: load });
      else { try { localStorage.setItem(KEY, String(Date.now() + 14 * 864e5)); } catch (_e) { /* private mode */ } box0.classList.add("hidden"); }
    });
    return { load };
  })();

  // Today re-checks the attention sources when opened, when the window regains focus, and every
  // 5 minutes while it is on screen. Other tabs are NOT reloaded on a timer (a reload would wipe a
  // half-filled form).
  let todayBusy = false;
  let todayFirst = null; // the initial load; Today waits for it instead of loading everything twice
  async function refreshToday() {
    if (!todayFirst || todayBusy) return;
    todayBusy = true;
    try {
      await todayFirst;
      await Promise.all(todayLoaders(false));
    } catch (_e) { /* each loader shows its own error on its tab */ }
    finally { todayBusy = false; markUnchecked(); }
  }
  // A loader that failed never reports; say so instead of "Checking..." forever.
  const ATTENTION_NAMES = { bookingFailed: "bookings (failed emails)", bookingNoContact: "bookings (no contact)", bookingNeedsTime: "bookings (time)", bookingNeedsTimeLater: "bookings (time, later)", bookingCalendar: "bookings (calendar)", bookingNeedsCode: "bookings (access code)", bookingNeedsJob: "bookings (GotPhoto job)", bookingNeedsCoaches: "bookings (coach emails)",
    followups: "prospect follow-ups", prospects: "outreach to review", hubLate: "hub activity", requests: "help requests",
    makeups: "makeups", retakesNew: "retake requests", retakeDayTomorrow: "retake requests", dataQuality: "gallery search fields", syncFailed: "sync status" };
  function markUnchecked() {
    const missing = attentionKeys().filter((k) => !attention[k] || attention[k].unchecked);
    el("todayUnchecked").textContent = missing.length
      ? "Could not check " + missing.map((k) => ATTENTION_NAMES[k]).join(", ") + ". Open that page to see the error."
      : "";
    el("todayUnchecked").classList.toggle("hidden", !missing.length);
    if (missing.length) { missing.forEach((k) => { attention[k] = { count: 0, unchecked: true }; }); renderAttention(); }
  }
  let todayTimer = null, lastFocusReload = 0;
  function startTodayRefresh() {
    if (todayTimer) return;
    todayTimer = setInterval(() => {
      if (document.hidden) return;
      if (canSee("partners")) Orgs.loadAttention();
      if (canSee("bookings")) Bookings.loadAttention();
      if (currentTab === "today") refreshToday();
    }, 5 * 60 * 1000);
    // Coming back to the window after a minute away re-checks Today (replaces the Refresh buttons).
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || Date.now() - lastFocusReload < 60 * 1000) return;
      lastFocusReload = Date.now();
      if (canSee("partners")) Orgs.loadAttention();
      if (canSee("bookings")) Bookings.loadAttention();
      if (currentTab === "today") refreshToday();
    });
  }

  // ================= Global search (Cmd-K) =================
  // Pages, settings by name, galleries (loaded jobs), partners (a search_text lookup) and jobs (a year back).
  // Pages come from the menu (only those this person can see); partner sub-lists from the orgs item's `search`.
  function gsPages() {
    const out = [];
    MENU_NOW.forEach((e) => {
      e.tabs.forEach((t) => { out.push([t[0], tabName(t[0])]); if (tabName(t[0]) !== t[1]) out.push([t[0], t[1]]); });
      const it = itemOf(e.tabs[0][0]);
      (it.search || []).forEach((x) => out.push([e.tabs[0][0], x[0], x[1]]));
    });
    return out;
  }
  // Settings by name (2026-10-24): "pay rates" finds Settings > Team & pay. Each lists where it lives, first available
  // wins, so a setting is still found before the Settings tabs exist: it opens the page that holds it today.
  const SETTINGS_INDEX = [
    ["Pay rates", ["teampay", "timesheets"], "wages hourly day rate"], ["Crew roles", ["teampay", "schedule"], "lead second shooter"],
    ["Kinds of clearance", ["teampay", "clearances"], "background check"], ["Onboarding steps", ["teampay", "onboarding"], ""],
    ["Time clock rules", ["teampay", "timesheets"], "overtime midnight gps location"], ["Mileage rate", ["teampay", "mileage"], "miles"],
    ["Stages", ["jobtypes", "bookings"], "job stages"], ["Deliverables", ["jobtypes", "bookings"], ""], ["Job types", ["jobtypes", "bookings"], ""],
    ["Checklist steps", ["jobtypes", "wfsteps"], "workflow job checklist"], ["Booking emails", ["jobtypes", "library"], "email sequence"],
    ["Studio address", ["company", "schedule"], "home base"], ["Setup and teardown times", ["company", "schedule"], "set up tear down drive"],
    ["Sign-in", ["company", "signin"], "devices codes login"], ["Sync status", ["company", "health"], "gotphoto"],
    ["Morning email", ["teamemails", "sending"], "digest today page by email"], ["Who gets the morning email", ["teamemails", "sending"], "digest recipients"],
    ["Your-day email", ["teamemails", "tasks"], "day email"], ["Evening notification", ["teamemails", "tasks"], "evening push"],
    ["Weekly schedule email", ["teamemails", "schedule"], ""], ["Confirm asks", ["teamemails", "schedule"], "crew confirm"],
    ["Clock reminders", ["teamemails", "timesheets"], "clock in reminder"], ["Send window", ["sending"], "quiet hours do not disturb"],
    ["Send window", ["sending"], "quiet hours sending hours"], ["Sending on or off", ["sending"], "pause test mode"], ["Email templates", ["library"], "email library"],
    ["Job calculator", ["calc"], "assumptions"],
  ];
  function gsSettings(ql) {
    const out = [];
    SETTINGS_INDEX.forEach(([label, targets, words]) => {
      if (!(label + " " + words).toLowerCase().includes(ql)) return;
      const t = targets.find((x) => entryOf(x)); if (!t) return;
      const e = entryOf(t), tab = e.tabs.find((x) => x[0] === t);
      out.push({ tab: t, k: label, m: e.title + (e.tabs.length > 1 ? " › " + tab[1] : "") });
    });
    return out.slice(0, 5);
  }
  // What this person can find, for the placeholder: "Search jobs, partners, galleries, settings and pages".
  function gsPlaceholder() {
    const parts = [canSee("bookings") ? "jobs" : "your jobs", canSee("partners") ? "partners" : "", canSee("galleries") ? "galleries" : "",
      MENU_NOW.some((e) => e.id === "sending") ? "settings" : ""].filter(Boolean);
    return "Search " + parts.join(", ") + " and pages";
  }
  let gsWrap = null, gsTimer = null, gsCur = 0;
  function openSearch() {
    if (gsWrap) return;
    gsWrap = document.createElement("div");
    gsWrap.className = "gs-wrap";
    gsWrap.innerHTML = '<div class="gs" role="dialog" aria-label="Search everything"><input type="text" id="aca-gsInput" placeholder="' + esc(gsPlaceholder()) + '" autocomplete="off" /><div class="gs-list" id="aca-gsList"></div></div>';
    document.querySelector(".aca").appendChild(gsWrap);
    gsWrap.addEventListener("click", (e) => { if (e.target === gsWrap) closeSearch(); const b = e.target.closest("button.gs-item"); if (b) go(b); });
    const inp = el("gsInput");
    inp.addEventListener("input", () => { clearTimeout(gsTimer); gsTimer = setTimeout(() => runSearch(inp.value.trim()), 120); });
    inp.addEventListener("keydown", (e) => {
      const btns = gsWrap.querySelectorAll("button.gs-item");
      if (e.key === "Escape") { closeSearch(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); gsCur = (gsCur + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % Math.max(1, btns.length); btns.forEach((b, i) => b.classList.toggle("cur", i === gsCur)); btns[gsCur] && btns[gsCur].scrollIntoView({ block: "nearest" }); return; }
      if (e.key === "Enter") { const b = btns[gsCur] || btns[0]; if (b) go(b); }
    });
    inp.focus();
    runSearch("");
    function go(b) {
      const t = b.dataset.tab, id = b.dataset.id;
      closeSearch();
      if (t === "job" && id) { JobPage.open(id); return; }
      showTab(t);
      if (t === "jobs" && id) showJobsFor({}, { select: id });
      if (t === "orgs" && id) { if (/^[a-z]+$/.test(id)) history.replaceState(null, "", "#partners/orgs/" + id); Orgs.load(); Orgs.open(id); }
      if (t === "bookings" && id) Bookings.openId(id);
    }
  }
  function closeSearch() { if (gsWrap) { gsWrap.remove(); gsWrap = null; } }
  const yearAgoNY = () => new Date(Date.now() - 365 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  async function runSearch(q) {
    const list = el("gsList"); if (!list) return;
    gsCur = 0;
    const ql = q.toLowerCase();
    const groups = [];
    const pages = gsPages().filter((p) => !ql || p[1].toLowerCase().includes(ql)).slice(0, ql ? 4 : 8);
    if (pages.length) groups.push(["Pages", pages.map((p) => ({ tab: p[0], id: p[2] || "", k: p[1], m: p[2] ? "Partners" : "" }))]);
    if (ql.length >= 2) {
      const sets = gsSettings(ql);
      if (sets.length) groups.push(["Settings", sets]);
      const jobs = allJobs.filter((j) => (j.name || "").toLowerCase().includes(ql)).slice(0, 6);
      if (jobs.length) groups.push(["Galleries", jobs.map((j) => ({ tab: "jobs", id: j.gotphoto_job_id, k: j.name, m: [j.job_type, j.status].filter(Boolean).join(", ") }))]);
      try {
        const none = Promise.resolve({ data: [] });
        // Jobs: a year back too (last fall's job, to check its gallery or payout). Crew without Bookings find their own jobs.
        const [{ data: orgs }, { data: bks }, { data: mine }] = await Promise.all([
          canSee("partners") ? supabase.from("prospect_orgs").select("id,name,town,stage").ilike("search_text", "%" + ql.replace(/[%_]/g, "") + "%").order("name").limit(6) : none,
          canSee("bookings") ? supabase.rpc("admin_bookings", { p_from: yearAgoNY(), p_to: null }) : none,
          canSee("bookings") ? none : supabase.rpc("crew_mine"),
        ]);
        if (el("gsInput") && el("gsInput").value.trim().toLowerCase() !== ql) return; // stale
        if (orgs && orgs.length) groups.push(["Partners", orgs.map((o) => ({ tab: "orgs", id: o.id, k: o.name, m: [o.town, Orgs.stageName(o.stage)].filter(Boolean).join(", ") }))]);
        const today = todayStrNY();
        const b2 = (bks || []).filter((b) => ((b.org_name || "") + " " + (b.title || "")).toLowerCase().includes(ql))
          .sort((x, y) => { const a = String(x.picture_day || ""), b = String(y.picture_day || ""), fa = a >= today, fb = b >= today;
            return fa !== fb ? (fa ? -1 : 1) : fa ? a.localeCompare(b) : b.localeCompare(a); }) // upcoming first, then the most recent
          .slice(0, 6);
        if (b2.length) groups.push(["Jobs", b2.map((b) => ({ tab: "job", id: b.id, k: b.title || b.org_name, m: Fmt.day(b.picture_day) + (String(b.picture_day) < today ? " (past)" : "") }))]);
        const m2 = (Array.isArray(mine) ? mine : []).filter((j) => (j.title || "").toLowerCase().includes(ql)).slice(0, 6);
        if (m2.length) groups.push(["Your jobs", m2.map((j) => ({ tab: "job", id: j.booking_id, k: j.title, m: j.days && j.days[0] ? Fmt.dayTime(j.days[0].starts_at) : "" }))]);
      } catch (_e) { /* search is best effort */ }
    }
    if (!groups.length) { list.innerHTML = '<div class="gs-empty">' + (ql ? "Nothing matches “" + esc(q) + "”." : "Type to search.") + "</div>"; return; }
    list.innerHTML = groups.map((g) => '<div class="gs-h">' + g[0] + "</div>" + g[1].map((it) => '<button type="button" class="gs-item" data-tab="' + esc(it.tab) + '"' + (it.id ? ' data-id="' + esc(it.id) + '"' : "") + '><span class="k">' + esc(it.k) + '</span><span class="m">' + esc(it.m) + "</span></button>").join("")).join("");
    const first = list.querySelector("button.gs-item"); if (first) first.classList.add("cur");
  }
  el("gsOpen").addEventListener("click", openSearch);
  el("gsOpen").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSearch(); } });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (gsWrap) closeSearch(); else openSearch(); }
  });
