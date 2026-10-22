// 207 Admin (formerly Access Code Admin) -- the internal admin page at 207photo.com/207-admin/.
//
// READABLE SOURCE, split by section (2026-09-26 restructure). build-embed.sh concatenates, in order:
//   shell-top.js        client, helpers, auth, section router, attention/Today
//   jobs.js             JOBS: Jobs (+ drawer), Search settings, Blocked names
//   parents.js          PARENTS: Help requests, Makeups
//   partners-prospect-tools.js, partners-orgs.js, partners-library.js, partners-hub.js
//                       PARTNERS: Organizations, Ready to send, Library, Schools, Hub activity
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
    if (canSee("hub")) loadSchools();
    // Everything Today summarizes. Today shows "Checking..." until these settle.
    todayFirst = Promise.all(todayLoaders(true)).catch(() => {}).then(markUnchecked);
    foldHelp();
    showTab(tabFromHash() || "today");
    startTodayRefresh();
    if (ACCESS.must_change_password) openPasswordDialog(true);
  }
  // The loaders behind Today's attention list, limited to the modules this person can see.
  function todayLoaders(first) {
    const L = [loadSyncStatus()];
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
  const RAIL_GROUPS = ["", "Jobs", "Parents", "Outreach", "Staff", "Operations", "System"];
  const RAIL = [
    { id: "today",     group: "",         section: "today",    module: null,           tabs: [["today", "Today"]] },
    { id: "bookings",  group: "Jobs",     section: "jobs",     module: "bookings",     tabs: [["bookings", "Bookings"]] },
    { id: "jobs",      group: "Jobs",     section: "jobs",     module: "galleries",    tabs: [["jobs", "Galleries"]] },
    { id: "hubact",    group: "Jobs",     section: "jobs",     module: "hub",          title: "Hub activity", tabs: [["hubact", "Activity"], ["schools", "Schools on the hub"]] },
    { id: "calc",      group: "Jobs",     section: "jobs",     module: "bookings",     tabs: [["calc", "Job calculator"]] },
    { id: "requests",  group: "Parents",  section: "parents",  module: "parents",      tabs: [["requests", "Help requests"]] },
    { id: "makeups",   group: "Parents",  section: "parents",  module: "parents",      tabs: [["makeups", "Makeups"]] },
    { id: "retakes",   group: "Parents",  section: "parents",  module: "parents",      tabs: [["retakes", "Retakes"]] },
    { id: "searchlog", group: "Parents",  section: "parents",  module: "findmyphotos", title: "Find My Photos", tabs: [["searchlog", "Activity"], ["settings", "Search rules"], ["blocks", "Blocked names"]] },
    { id: "orgs",      group: "Outreach", section: "partners", module: "partners",     tabs: [["orgs", "Organizations"]],
      search: [["Clients", "clients"], ["Active leads", "active"], ["Prospecting", "prospecting"], ["Cold leads", "cold"], ["Follow up later", "later"], ["Past clients", "past"]] },
    { id: "outbox",    group: "Outreach", section: "partners", module: "partners",     title: "Outbox", tabs: [["outbox", "Everything"], ["ready", "Outreach to review"]] },
    { id: "library",   group: "Outreach", section: "partners", module: "partners",     tabs: [["library", "Email library"]] },
    { id: "sending",   group: "System",   section: "system",   module: "settings",     title: "Settings", tabs: [["sending", "Sending"], ["health", "Sync"], ["signin", "Sign-in"]] },
  ];
  function registerPage(item) { RAIL.push(item); }
  const itemOf = (tab) => RAIL.find((it) => it.tabs.some((t) => t[0] === tab));
  const railLabel = (it) => it.label || it.title || it.tabs[0][1];
  const sectionOf = (tab) => { const it = itemOf(tab); return it ? { id: it.section } : null; };
  // the rail item a tab belongs to
  function railItemOf(tab) { const it = itemOf(tab); return it ? it.id : tab; }
  // a tab's name as Today and search show it ("Find My Photos", not "Activity")
  function tabName(tab) {
    const it = itemOf(tab);
    if (!it) return "";
    return it.title && it.tabs[0][0] === tab ? it.title : it.tabs.find((t) => t[0] === tab)[1];
  }
  const pageOf = (id) => { const it = RAIL.find((x) => x.id === id); return it && it.tabs.length > 1 ? it : null; };
  function renderRail() {
    const groups = RAIL_GROUPS.concat(RAIL.map((it) => it.group || "").filter((g) => !RAIL_GROUPS.includes(g)));
    el("nav").innerHTML = groups.filter((g, i) => groups.indexOf(g) === i).map((g) => {
      const items = RAIL.filter((it) => (it.group || "") === g && canSee(it.module));
      if (!items.length) return "";
      return (g === "System" ? '<h4 class="sp" aria-hidden="true"></h4>' : g ? "<h4>" + esc(g) + "</h4>" : "") +
        items.map((it) => '<button type="button" data-tab="' + esc(it.id) + '" aria-selected="false">' + esc(railLabel(it)) + '<span class="n" id="aca-nav-' + esc(it.id) + '"></span></button>').join("");
    }).join("");
  }
  const lastTab = {}; // rail item -> last inner tab shown
  let currentTab = null;
  let searchLogLoaded = false;

  function showTab(name) {
    const sec = sectionOf(name);
    if (!sec) return;
    const it = itemOf(name);
    if (!canSee(it.module)) { if (name !== "today") showTab("today"); return; }
    currentTab = name;
    const item = railItemOf(name);
    lastTab[item] = name;
    document.querySelectorAll("#aca-nav button[data-tab]").forEach((b) =>
      b.setAttribute("aria-selected", b.dataset.tab === item ? "true" : "false"));
    renderPageTabs(item, name);
    document.querySelectorAll(".aca section.panel").forEach((p) => p.classList.remove("active"));
    el("panel-" + name).classList.add("active");
    const hash = name === "today" ? "#today" : "#" + sec.id + "/" + name;
    if (location.hash !== hash && !location.hash.startsWith(hash + "/")) history.replaceState(null, "", hash);
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
    el("viewOnly").classList.toggle("hidden", !it.module || canEdit(it.module) || it.selfService);
    window.scrollTo(0, 0);
  }
  function renderPageTabs(item, name) {
    const strip = el("pagetabs");
    const page = pageOf(item);
    if (!page) { strip.classList.add("hidden"); strip.innerHTML = ""; return; }
    strip.innerHTML = '<h1>' + esc(page.title) + '</h1>' + page.tabs.map((t) => '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (t[0] === name) + '">' + esc(t[1]) + '<span class="n" id="aca-ptab-' + t[0] + '"></span></button>').join("");
    strip.classList.remove("hidden");
    renderAttention();
  }
  el("pagetabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });
  // "#partners/prospects", "#prospects" (old add-on link), "#partners/orgs/<org id>", "#system/health", or "#today".
  function tabFromHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ""));
    const segs = h.split("/").filter(Boolean).map((s) => (s === "prospects" ? "orgs" : s));
    return segs.slice(0, 2).reverse().find((s) => sectionOf(s)) || null;
  }
  el("nav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) { const item = b.dataset.tab; showTab(lastTab[item] || item); }
  });
  window.addEventListener("hashchange", () => { const t = tabFromHash(); if (t && t !== currentTab) showTab(t); });

  // Rail on narrow screens: a drawer behind the menu button.
  function closeRail() { el("shell").classList.remove("railopen"); }
  el("menuBtn").addEventListener("click", () => el("shell").classList.toggle("railopen"));
  el("railbg").addEventListener("click", closeRail);
  // Account menu
  el("whoBtn").addEventListener("click", (e) => { e.stopPropagation(); const m = el("whoMenu"); m.classList.toggle("hidden"); el("whoBtn").setAttribute("aria-expanded", String(!m.classList.contains("hidden"))); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#aca-whoMenu, #aca-whoBtn")) { el("whoMenu").classList.add("hidden"); el("whoBtn").setAttribute("aria-expanded", "false"); } });
  el("bookBtn").addEventListener("click", () => { showTab("bookings"); Bookings.openNew(); });

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

  // ================= Attention (rail badges + Today) =================
  // Each module reports "things that need Jeremiah" with setAttention() next to its own badge code.
  // Today sorts them into three groups by level: err = Fix now, warn = Waiting on you, soon = Check soon.
  const ATTENTION_ORDER = ["bookingFailed", "syncFailed", "bookingNoContact", "bookingNeedsTime", "bookingNeedsCode", "bookingNeedsJob", "bookingNeedsCoaches", "prospects", "requests", "makeups", "retakeDayTomorrow", "followups", "retakesNew", "hubLate", "bookingCalendar", "bookingNeedsTimeLater", "dataQuality"];
  // The module each item belongs to; people without it neither load nor see the item.
  const ATTENTION_MODULE = { bookingFailed: "bookings", bookingNoContact: "bookings", bookingNeedsTime: "bookings", bookingNeedsTimeLater: "bookings", bookingCalendar: "bookings",
    bookingNeedsCode: "bookings", bookingNeedsJob: "bookings", bookingNeedsCoaches: "bookings", prospects: "partners", followups: "partners", requests: "parents", makeups: "parents",
    retakeDayTomorrow: "parents", retakesNew: "parents", hubLate: "hub", syncFailed: "settings", dataQuality: "settings" };
  const attentionKeys = () => ATTENTION_ORDER.filter((k) => canSee(ATTENTION_MODULE[k]));
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
    ATTENTION_NAMES[key] = d.name || key;
  }
  const LEVEL_OVERRIDE = { bookingNeedsCoaches: "soon", retakesNew: "soon", followups: "soon", hubLate: "soon", bookingCalendar: "soon", dataQuality: "soon", bookingNeedsTimeLater: "soon" };
  // Sentences. [one, many]; {n} = count.
  const SENTENCES = {
    bookingFailed:    ["A booking email failed to send.", "{n} booking emails failed to send."],
    syncFailed:       ["GotPhoto sync is failing. It retries every 5 minutes; codes on Find My Photos may be stale.", "GotPhoto sync is failing."],
    bookingNoContact: ["A booking has nobody to email. Add a contact and the admin emails go out.", "{n} bookings have nobody to email."],
    bookingNeedsTime: ["A booking needs its start and end time. Emails that mention the time are waiting.", "{n} bookings need their start and end times."],
    bookingNeedsTimeLater: ["A booking has no time yet. No rush: it is more than three weeks out.", "{n} bookings have no time yet. No rush, they are more than three weeks out."],
    bookingNeedsCode: ["A school booking needs its access code before the hub row can be created.", "{n} school bookings need their access code."],
    bookingNeedsJob:  ["A sports booking is waiting for its GotPhoto job.", "{n} sports bookings are waiting for their GotPhoto job."],
    bookingNeedsCoaches: ["A sports booking is a week out with no coach emails. Ask the AD to reply all with the coaches, or paste them on the booking.", "{n} sports bookings are a week out with no coach emails."],
    prospects:        ["An outreach email is waiting for your review.", "{n} outreach emails are waiting for your review."],
    requests:         ["A parent asked for help finding a code.", "{n} parents asked for help finding a code."],
    makeups:          ["A makeup to confirm and send.", "{n} makeups to confirm and send."],
    retakesNew:       ["A new retake request since yesterday.", "{n} new retake requests since yesterday."],
    followups:        ["A prospect follow-up is due.", "{n} prospect follow-ups are due."],
    hubLate:          ["A team or school hasn't grabbed its hub message yet.", "{n} teams or schools haven't grabbed their hub messages yet."],
    bookingCalendar:  ["A booking is out of step with Google Calendar.", "{n} bookings are out of step with Google Calendar."],
    dataQuality:      ["A published gallery is missing search fields.", "{n} published galleries are missing search fields."],
  };
  const GROUPS = [["err", "Fix now", "#c62828"], ["warn", "Waiting on you", "#bf4a1f"], ["soon", "Check soon", "#b9b4aa"]];
  const attention = {}; // key -> { count, label, tab, level }
  function setAttention(key, count, label, tab, level, onGo) {
    attention[key] = { count: count || 0, label, tab, level: LEVEL_OVERRIDE[key] || level || "warn", onGo, key };
    renderAttention();
  }
  function sentence(a) {
    const s = SENTENCES[a.key];
    if (!s) return a.label;
    return (a.count === 1 ? s[0] : s[1]).replace("{n}", a.count);
  }
  function renderAttention() {
    // rail: one number per item; red when anything in it is an error
    const perItem = {};
    Object.values(attention).forEach((a) => {
      if (!a.count || !a.tab) return;
      const item = railItemOf(a.tab);
      perItem[item] = perItem[item] || { n: 0, bad: false };
      perItem[item].n += a.count; if (a.level === "err") perItem[item].bad = true;
      const pt = el("ptab-" + a.tab);
      if (pt) { pt.textContent = a.count; pt.className = "n" + (a.level === "err" ? " bad" : ""); }
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
      list.innerHTML = GROUPS.map((g) => {
        const rows = items.filter((a) => a.level === g[0]);
        if (!rows.length) return "";
        return '<div class="today-grp"><h2><span class="gd" style="background:' + g[2] + '"></span>' + g[1] + ' <span class="c">' + rows.reduce((n, a) => n + a.count, 0) + "</span></h2>" +
          rows.map((a) => '<button type="button" class="today-item" data-go="' + esc(a.tab) + '" data-key="' + esc(a.key || "") + '">' +
            '<span class="today-n">' + esc(a.count) + '</span><span class="today-l">' + esc(sentence(a)) + ' <span class="today-where">' + esc(tabName(a.tab)) + '</span></span>' +
            '<span class="today-go">Open</span></button>').join("") + "</div>";
      }).join("") + (pending ? '<div class="empty"><span class="spin"></span>Still checking a few things&#8230;</div>' : "");
    }
    renderLead(items, pending);
  }
  el("todayList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (!b) return;
    showTab(b.dataset.go);
    const a = attention[b.dataset.key];
    if (a && a.onGo) a.onGo();
  });

  // The lead sentence: "Two things are broken, seven are waiting on you, and the next picture day is Thursday with X."
  let nextUp = null; // from Bookings: [{picture_day, org, title, start, status}]
  const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const num2 = (n) => (n < WORDS.length ? WORDS[n] : String(n));
  function renderLead(items, pending) {
    const d = new Date();
    el("todayTitle").textContent = d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" });
    const broken = items.filter((a) => a.level === "err").reduce((n, a) => n + a.count, 0);
    const waiting = items.filter((a) => a.level === "warn").reduce((n, a) => n + a.count, 0);
    const soon = items.filter((a) => a.level === "soon").reduce((n, a) => n + a.count, 0);
    const parts = [];
    if (broken) parts.push(num2(broken) + (broken === 1 ? " thing is broken" : " things are broken"));
    if (waiting) parts.push(num2(waiting) + (waiting === 1 ? " is waiting on you" : " are waiting on you"));
    if (!broken && !waiting) parts.push(soon ? "nothing is broken and nothing is waiting on you" : "nothing needs you");
    let s = parts.join(", ");
    s = s.charAt(0).toUpperCase() + s.slice(1);
    let next = "";
    if (nextUp && nextUp.length) {
      const b = nextUp[0];
      const days = Math.round((new Date(b.picture_day + "T12:00:00") - new Date(todayStrNY() + "T12:00:00")) / 864e5);
      const when = days === 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? new Date(b.picture_day + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" }) : new Date(b.picture_day + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
      next = ", and the next picture day is <b>" + esc(when) + " with " + esc(b.org_name || b.title || "") + "</b>";
    }
    el("todayLead").innerHTML = s + next + ". " + (pending ? '<span class="muted">Still checking a few things.</span>' : '<span class="muted">Checked ' + new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + ".</span>");
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
      }).join("") + '<p><a href="#jobs/bookings">All bookings</a></p>' : "<p>No picture days booked in the next 60 days. <a href=\"#jobs/bookings\">Book a job</a></p>";
    } catch (e) {
      el("todayUp").innerHTML = '<p class="muted">Could not load bookings.</p>';
    }
    renderAttention();
  }
  el("todayUp").addEventListener("click", (e) => {
    const r = e.target.closest("[data-booking]"); if (!r) return;
    showTab("bookings"); Bookings.openId(r.dataset.booking);
  });

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
  // Pages, galleries (loaded jobs), organizations (a search_text lookup), bookings and schools.
  // Pages come from RAIL (only those this person can see); org sub-lists from the orgs item's `search`.
  function gsPages() {
    const out = [];
    RAIL.filter((it) => canSee(it.module)).forEach((it) => {
      it.tabs.forEach((t) => out.push([t[0], tabName(t[0])]));
      (it.search || []).forEach((x) => out.push([it.tabs[0][0], x[0], x[1]]));
    });
    return out;
  }
  let gsWrap = null, gsTimer = null, gsCur = 0, gsItems = [];
  function openSearch() {
    if (gsWrap) return;
    gsWrap = document.createElement("div");
    gsWrap.className = "gs-wrap";
    gsWrap.innerHTML = '<div class="gs" role="dialog" aria-label="Search everything"><input type="text" id="aca-gsInput" placeholder="Search jobs, organizations, schools, parents, pages" autocomplete="off" /><div class="gs-list" id="aca-gsList"></div></div>';
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
      showTab(t);
      if (t === "jobs" && id) showJobsFor({}, { select: id });
      if (t === "orgs" && id) { if (/^[a-z]+$/.test(id)) history.replaceState(null, "", "#partners/orgs/" + id); Orgs.load(); Orgs.open(id); }
      if (t === "bookings" && id) Bookings.openId(id);
    }
  }
  function closeSearch() { if (gsWrap) { gsWrap.remove(); gsWrap = null; } }
  async function runSearch(q) {
    const list = el("gsList"); if (!list) return;
    gsCur = 0;
    const ql = q.toLowerCase();
    const groups = [];
    const pages = gsPages().filter((p) => !ql || p[1].toLowerCase().includes(ql)).slice(0, ql ? 4 : 8);
    if (pages.length) groups.push(["Pages", pages.map((p) => ({ tab: p[0], id: p[2] || "", k: p[1], m: p[2] ? "Organizations" : "" }))]);
    if (ql.length >= 2) {
      const jobs = allJobs.filter((j) => (j.name || "").toLowerCase().includes(ql)).slice(0, 6);
      if (jobs.length) groups.push(["Galleries", jobs.map((j) => ({ tab: "jobs", id: j.gotphoto_job_id, k: j.name, m: [j.job_type, j.status].filter(Boolean).join(", ") }))]);
      try {
        const none = Promise.resolve({ data: [] });
        const [{ data: orgs }, { data: bks }] = await Promise.all([
          canSee("partners") ? supabase.from("prospect_orgs").select("id,name,town,stage").ilike("search_text", "%" + ql.replace(/[%_]/g, "") + "%").order("name").limit(6) : none,
          canSee("bookings") ? supabase.rpc("admin_bookings", { p_from: todayStrNY(), p_to: null }) : none,
        ]);
        if (el("gsInput") && el("gsInput").value.trim().toLowerCase() !== ql) return; // stale
        if (orgs && orgs.length) groups.push(["Organizations", orgs.map((o) => ({ tab: "orgs", id: o.id, k: o.name, m: [o.town, o.stage].filter(Boolean).join(", ") }))]);
        const b2 = (bks || []).filter((b) => ((b.org_name || "") + " " + (b.title || "")).toLowerCase().includes(ql)).slice(0, 5);
        if (b2.length) groups.push(["Bookings", b2.map((b) => ({ tab: "bookings", id: b.id, k: b.title || b.org_name, m: fmtDay2(b.picture_day) }))]);
      } catch (_e) { /* search is best effort */ }
    }
    if (!groups.length) { list.innerHTML = '<div class="gs-empty">' + (ql ? "Nothing matches “" + esc(q) + "”." : "Type to search.") + "</div>"; return; }
    list.innerHTML = groups.map((g) => '<div class="gs-h">' + g[0] + "</div>" + g[1].map((it) => '<button type="button" class="gs-item" data-tab="' + esc(it.tab) + '"' + (it.id ? ' data-id="' + esc(it.id) + '"' : "") + '><span class="k">' + esc(it.k) + '</span><span class="m">' + esc(it.m) + "</span></button>").join("")).join("");
    const first = list.querySelector("button.gs-item"); if (first) first.classList.add("cur");
  }
  const fmtDay2 = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
  el("gsOpen").addEventListener("click", openSearch);
  el("gsOpen").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSearch(); } });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (gsWrap) closeSearch(); else openSearch(); }
  });
