  // ================================================================ PARTNERS: Organizations (Prospects CRM)
  // Stage 2 of docs/plans/2026-09-27-prospects-crm-design.md. One row per league/school; click a row for the
  // side panel with everything about it (details, contacts, emails, follow-ups, timeline). Every field saves
  // on change. List search/filter/sort run in the browser (the whole list is ~1k rows); the list fields
  // (last contact, last result, next action, search_text) are kept current by triggers (migration T06).
  // Sending is untouched here: enrolling still goes through the Prospects tab until stage 3.
  registerAttention("rolesCheck", { module: "partners", level: "soon", name: "who's main",
    one: "A partner uses two of our services and one person is main for both. Check who's main for each.",
    many: "{n} partners use two of our services with one person main for both. Check who's main for each." });
  const Orgs = (function () {
  const sb = supabase;
  const $ = (id) => document.getElementById("aca-" + id);
  const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");

  const STAGES = [["new", "New"], ["contacting", "Prospecting"], ["talking", "Active lead"], ["booked", "Booked"], ["client", "Client"], ["past_client", "Past client"],
    ["no_reply", "No reply"], ["not_now", "Follow up later"], ["do_not_contact", "Do not contact"]];
  const STAGE_NAME = Object.fromEntries(STAGES);
  const STAGE_ORDER = Object.fromEntries(STAGES.map((s, i) => [s[0], i]));
  const STAGE_CLS = { new: "muted", contacting: "accent", talking: "ok", booked: "ok", client: "ok", past_client: "muted", no_reply: "muted", not_now: "warn", do_not_contact: "err" };
  const CONTACT_CHIP = { queued: ["Queued", "accent"], sent: ["Sent", "accent"], replied: ["Replied", "ok"], bounced: ["Bounced", "err"],
    unsubscribed: ["Unsubscribed", "err"], stopped: ["Stopped", "muted"], no_reply: ["No reply", "muted"], not_emailed: ["Not emailed", "muted"] };
  const SEASONS = ["fall", "winter", "spring", "summer", "year-round"];
  const FLAGS = [["due7", "Due this week"], ["followup", "Follow-up due"], ["ready", "Waiting for your OK"], ["needs_new", "Needs new contact"],
    ["never", "Never contacted"], ["cooldown", "Cool-down active"], ["opened", "Opened, no reply"], ["rolecheck", "Check who's main"]];
  // Pipeline chips (2026-10-12): one click per group, each with its own address (#partners/orgs/<group>)
  const GROUPS = [
    ["clients", "Clients", ["client", "booked"], { key: "next", dir: 1 }],
    ["active", "Active lead", ["talking"], { key: "last", dir: -1 }],
    ["prospecting", "Prospecting", ["contacting"], { key: "last", dir: -1 }],
    ["later", "Follow up later", ["not_now"], { key: "next", dir: 1 }],
    ["cold", "Cold", ["no_reply", "new"], { key: "last", dir: -1 }],
    ["past", "Past clients", ["past_client"], { key: "last", dir: -1 }],
    ["", "Everyone", null, null]];
  const GROUP_OF = Object.fromEntries(GROUPS.map((g) => [g[0], g]));
  const BUILTIN_VIEWS = [
    { id: "b-action", name: "Action clients", config: { service: "action", sort: { key: "next", dir: 1 } } },
    { id: "b-sp-comp", name: "Schools with another photographer", config: { audience: "school", sp: "competitor", sort: { key: "next", dir: 1 } } },
    { id: "b-due", name: "Due this week", config: { flag: "due7", sort: { key: "next", dir: 1 } } },
    { id: "b-fu", name: "Follow-ups", config: { flag: "followup", sort: { key: "next", dir: 1 } } },
  ];
  // What we do for a client (2026-09-27): team & individual portraits, action coverage, school photos, events
  const SERVICES = [["portraits", "Team & individual"], ["action", "Action"], ["school_photos", "School photos"], ["events", "Events"]];
  const SERVICE_NAME = Object.fromEntries(SERVICES);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthsText = (o) => (o.shoot_months || []).map((m) => MONTHS[m - 1]).join(", ");
  const DEFAULT_STATE = { q: "", group: "", stage: "", sport: "", season: "", audience: "", sp: "", month: "", service: "", svs: "", county: "", towns: [], flag: "", sort: { key: "next", dir: 1 } };
  const COUNTIES = ["Androscoggin", "Aroostook", "Cumberland", "Franklin", "Hancock", "Kennebec", "Knox", "Lincoln", "Oxford", "Penobscot",
    "Piscataquis", "Sagadahoc", "Somerset", "Waldo", "Washington", "York"];
  // School photos status (schools only), separate from the main stage (2026-09-27)
  const SP = [["client", "Client"], ["prospect", "Prospect"], ["competitor", "With another photographer"], ["not_interested", "Not interested"]];
  const SP_NAME = Object.fromEntries(SP);
  // Main contact per service (2026-10-24, migration 20261024170000): each service has its own status on the partner
  // (service_status; missing = Not offered) and each person is Main, Copy in or Not involved for it (service_roles;
  // missing = Not involved). Book a job, Email someone, Enroll and rebooking pick people by the service.
  const SVC_ST = [["client", "Client"], ["prospect", "Prospect"], ["past_client", "Past client"], ["competitor", "With another photographer"], ["not_interested", "Not interested"]];
  const SVC_ST_NAME = Object.fromEntries(SVC_ST);
  const SVC_CLS = { client: "ok", past_client: "muted", prospect: "accent", competitor: "warn", not_interested: "muted" };
  const ROLE_NAME = { main: "Main", copy: "Copy in", "": "Not involved" };
  const svcList = (o) => SERVICES.map((x) => x[0]).filter((k) => o && o.service_status && o.service_status[k]);
  const roleOf = (c, k) => (c && c.service_roles && c.service_roles[k]) || "";
  // The service a partner-page email is about by default: the first one we're a client for, else the first one.
  const defaultSvc = (o) => { const l = svcList(o); return l.find((k) => o.service_status[k] === "client") || l[0] || (o && o.audience === "school" ? "school_photos" : "portraits"); };
  const seqSvc = (o) => (o && o.audience === "school" ? "school_photos" : "portraits");
  let roleCheck = new Set();
  function spText(o) {
    if (o.audience !== "school" || !o.sp_status) return "";
    if (o.sp_status === "competitor") {
      const until = o.sp_until ? " until " + new Date(o.sp_until + "T12:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "";
      return "School photos: " + (o.sp_competitor || "another photographer") + until;
    }
    return "School photos: " + SP_NAME[o.sp_status];
  }
  const PAGE = 200;

  let orgs = [];            // list rows
  let byId = new Map();
  let contactStats = new Map(); // org_id -> { n, bounced, unsub, mains[], first }
  let followDue = new Map();    // org_id -> earliest open follow-up due_on
  let readyOrgs = new Set();    // org ids with a held (review) enrollment
  let sportList = [];
  let cooldownMonths = 6;
  let savedViews = [];
  let st = JSON.parse(JSON.stringify(DEFAULT_STATE));
  let shown = PAGE;
  let visible = [];         // filtered+sorted rows, for up/down stepping
  let selected = new Set();
  let openId = null;
  let panelData = null;
  let loaded = false, loading = null;
  let tlFilter = "all";
  const initialOpen = (location.hash.match(/orgs\/([0-9a-f-]{36})/i) || [])[1] || null;
  const groupInHash = () => { const m = location.hash.match(/orgs\/([a-z]+)/i); return m && GROUP_OF[m[1].toLowerCase()] && m[1].toLowerCase() !== "" ? m[1].toLowerCase() : null; };

  // ---------------------------------------------------------------- styles
  const css = `
  .aca .og-groups { display: flex; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; align-items: center; padding: 10px 16px 2px; }
  .aca .og-groups .chips button span { color: var(--faint); font-weight: 400; margin-left: 3px; }
  .aca .og-groups.og-paused { opacity: .5; }
  .aca .og-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .aca .og-bar input[type=search] { flex: 1 1 240px; min-width: 180px; font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; }
  .aca .og-bar select { flex: 0 1 auto; min-width: 150px; max-width: 240px; }
  .aca .og-flags { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--border); align-items: center; }
  .aca .og-count { margin-left: auto; font-size: 12.5px; color: var(--muted); }
  .aca .og-bulk { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 16px; background: var(--sel-bg); border-bottom: 1px solid var(--border); font-size: 13px; }
  .aca .og-bulk input[type=text] { width: 130px; }
  .aca table.og-table { table-layout: fixed; }
  .aca table.og-table th { cursor: pointer; user-select: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .aca table.og-table th.nosort { cursor: default; }
  .aca table.og-table th .arr { font-size: 10px; margin-left: 3px; }
  .aca table.og-table td { padding: 9px 12px; vertical-align: top; }
  .aca table.og-table th { padding: 9px 12px; }
  .aca table.og-table td.c-ck, .aca table.og-table th.nosort:first-child { cursor: pointer; }
  .aca table.og-table col.c-ck { width: 36px; } .aca table.og-table col.c-org { width: 21%; } .aca table.og-table col.c-stage { width: 10%; }
  .aca table.og-table col.c-sports { width: 13%; } .aca table.og-table col.c-town { width: 10%; } .aca table.og-table col.c-ct { width: 13%; }
  .aca table.og-table col.c-last { width: 7%; } .aca table.og-table col.c-res { width: 12%; } .aca table.og-table col.c-next { width: 14%; }
  /* long values wrap to two lines instead of being cut off (2026-09-27) */
  @media (min-width: 761px) {
    .aca table.og-table td .og-cell, .aca table.og-table td .og-sub:not(.og-mob) { white-space: normal; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
    .aca table.og-table td.og-cell { white-space: normal; word-break: break-word; }
    .aca table.og-table td .og-sub.og-mob { display: none; }
    .aca table.og-table td.c-org .og-name { white-space: normal; }
  }
  .aca tr.og-row { cursor: pointer; }
  .aca tr.og-row.open, .aca tr.og-row.open:hover { background: var(--sel-bg); box-shadow: inset 3px 0 0 var(--accent); }
  .aca .og-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aca .og-sub { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aca .og-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .aca .og-late { color: var(--err-fg); font-weight: 600; }
  .aca .og-more { padding: 12px 16px; text-align: center; }
  .aca .og-flag { font-size: 11px; padding: 0 6px; line-height: 1.5; margin-left: 4px; vertical-align: 1px; }
  @media (max-width: 900px) { .aca table.og-table { table-layout: auto; min-width: 820px; } }
  .aca .og-mob { display: none; }
  /* Filters live in a panel behind one button; active ones show as removable tags (2026-09-27) */
  .aca .og-bar { flex-wrap: wrap; }
  .aca .og-mtools { display: flex; gap: 8px; align-items: center; }
  .aca .og-mtools select { max-width: 260px; }
  .aca #aca-ogSortM { display: none; }
  .aca .og-ftoggle { font-weight: 600; display: inline-flex; gap: 6px; align-items: center; }
  .aca .og-ftoggle[aria-expanded="true"] { background: var(--sel-bg); border-color: var(--accent); color: var(--accent); }
  .aca .og-fsel { display: none; width: 100%; }
  .aca .og-fsel.open { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px 12px; padding: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; }
  .aca .og-f { min-width: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); font-weight: 600; }
  .aca .og-f select { width: 100%; min-width: 0; max-width: none; color: var(--text); font-weight: 400; }
  .aca .og-fdone { justify-content: flex-end; }
  .aca .og-paused { opacity: .45; }
  .aca .og-active { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; }
  .aca .og-active.hidden { display: none; }
  .aca .og-atag { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--accent); background: var(--sel-bg); color: var(--accent);
    border-radius: 999px; padding: 2px 4px 2px 10px; font-size: 12.5px; font-weight: 600; }
  .aca .og-atag button { border: none; background: transparent; color: inherit; padding: 0 6px; font-size: 14px; line-height: 1; }
  @media (max-width: 900px) { .aca .og-fsel.open { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  /* Phone (2026-09-27): each org is a card (name + stage, then sport/town/result, then what's next),
     filters fold behind one button, the column headers become a Sort menu, tap targets >= 44px. */
  @media (max-width: 760px) {
    .aca .og-head p { display: none; }
    .aca .og-head { flex-wrap: wrap; }
    .aca .og-bar { padding: 10px 12px; gap: 8px; }
    .aca .og-bar input[type=search] { flex: 1 1 100%; min-height: 44px; font-size: 16px; }
    .aca .og-mtools { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; width: 100%; }
    .aca #aca-ogSortM { display: block; }
    .aca .og-mtools #aca-ogView { grid-column: 1 / -1; max-width: none; }
    .aca .og-bar select { min-width: 0; max-width: none; width: 100%; }
    .aca .og-mtools #aca-ogViewDel { grid-column: 1 / -1; }
    .aca .og-fsel.open { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .aca .og-mtools > * { flex: 1 1 0; min-height: 44px; font-size: 15px; }
    .aca .og-ftoggle { font-weight: 600; }
    .aca .og-fsel.open { grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px; }
    .aca .og-fsel select { max-width: none; width: 100%; min-height: 44px; font-size: 15px; }
    .aca .og-flags { padding: 6px 12px; }
    .aca .og-flags .chips, .aca .og-flags #aca-ogReset { display: none; }
    .aca .og-fopen .og-flags .chips { display: flex; flex-wrap: wrap; width: 100%; }
    .aca .og-fopen .og-flags #aca-ogReset { display: inline; }
    .aca .og-flags .chips button { white-space: nowrap; padding: 6px 12px; font-size: 13px; }
    .aca .og-groups { padding: 8px 12px 0; gap: 6px; flex-wrap: nowrap; flex-direction: column; align-items: stretch; }
    .aca .og-groups .chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
    .aca .og-groups .chips button { white-space: nowrap; padding: 4px 10px; font-size: 13px; min-height: 32px; }
    .aca .og-flags .og-count, .aca .og-flags #aca-ogReset { white-space: nowrap; }
    .aca table.og-table { table-layout: auto; min-width: 0; }
    .aca table.og-table thead, .aca table.og-table colgroup { display: none; }
    .aca table.og-table tbody { display: block; }
    .aca tr.og-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto;
      grid-template-areas: "ck org stage" "ck next next"; column-gap: 8px; row-gap: 6px; padding: 12px 12px 12px 6px; border-bottom: 1px solid var(--border); }
    .aca tr.og-row > td { display: block; padding: 0; border: none; }
    .aca tr.og-row > td.c-ck { grid-area: ck; display: flex; align-items: flex-start; justify-content: center; padding-top: 2px; }
    .aca tr.og-row .og-ck { width: 22px; height: 22px; }
    .aca tr.og-row > td.c-org { grid-area: org; min-width: 0; }
    .aca tr.og-row > td.c-stage { grid-area: stage; justify-self: end; }
    .aca tr.og-row > td.c-next { grid-area: next; min-width: 0; overflow: hidden; display: -webkit-box !important; -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: normal; }
    .aca tr.og-row > td.c-next .og-sub { white-space: normal; }
    .aca .og-list-wrap, .aca #aca-panel-orgs .table-wrap { overflow-x: hidden; }
    .aca tr.og-row > td.c-sports, .aca tr.og-row > td.c-town, .aca tr.og-row > td.c-ct, .aca tr.og-row > td.c-last, .aca tr.og-row > td.c-res { display: none; }
    .aca tr.og-row .og-name { font-size: 15px; white-space: normal; }
    .aca tr.og-row .og-dsk { display: none; }
    .aca tr.og-row .og-mob { display: block; white-space: normal; }
    .aca tr.og-row > td.c-next:has(.muted:only-child) { display: none; }
    .aca tr.og-row > td.c-next .og-cell, .aca tr.og-row > td.c-next .og-sub { display: inline; font-size: 12.5px; }
    .aca tr.og-row > td.c-next .og-cell::before { content: "Next: "; color: var(--muted); font-weight: 400; }
    .aca tr.og-row > td.c-next .og-cell:empty { display: none; }
    .aca tr.og-row > td.c-next .og-sub { margin-left: 4px; }
    .aca .og-bulk { position: sticky; bottom: 0; z-index: 5; box-shadow: 0 -2px 8px rgba(16,24,40,.08); }
    .aca .og-more button { min-height: 44px; width: 100%; }
    .aca .og-panel .og-actions button, .aca .og-panel select { min-height: 40px; }
  }

  .aca .og-panel { position: fixed; top: var(--og-top, 0px); right: 0; bottom: 0; width: min(600px, 100vw); border-top: 1px solid var(--border); background: var(--surface); border-left: 1px solid var(--border);
    box-shadow: -8px 0 28px rgba(16,24,40,.16); z-index: 9990; display: flex; flex-direction: column; }
  .aca .og-panel.hidden { display: none; }
  .aca .og-panel.og-inline { position: static; width: auto; max-width: 860px; border: 0; background: transparent; box-shadow: none; z-index: auto; overflow: visible; }
  .aca .og-panel.og-inline .og-pnav { display: none; }
  .aca .og-panel.og-inline .og-ptop .og-title { font-size: 15px; font-weight: 600; }
  .aca .og-panel.og-inline .og-phead { position: static; padding-left: 0; padding-right: 0; background: transparent; }
  .aca .og-panel.og-inline .og-pbody { padding-left: 0; padding-right: 0; overflow: visible; }
  .aca #aca-ogPanel.og-inline .og-phead { position: static; padding-left: 0; padding-right: 0; background: transparent; }
  .aca .og-phead { padding: 14px 18px 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
  .aca .og-ptop { display: flex; align-items: center; gap: 8px; }
  .aca .og-ptop input.og-title { flex: 1; min-width: 0; font-size: 17px; font-weight: 700; border: 1px solid transparent; background: transparent; padding: 3px 6px; margin-left: -6px; border-radius: 6px; color: var(--text); font-family: inherit; }
  .aca .og-ptop input.og-title:hover, .aca .og-ptop input.og-title:focus { border-color: var(--border); background: var(--surface); }
  .aca .og-pnav { display: flex; gap: 4px; }
  .aca .og-pmeta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; }
  .aca .og-svcs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .aca .og-svc { display: inline-flex; align-items: center; gap: 2px; padding-right: 2px; font-size: 12.5px; }
  .aca .og-svcs select { font: inherit; font-size: 12.5px; font-weight: 600; border: 0; background-color: transparent; color: inherit; padding: 0 2px; min-height: 0; height: auto; width: auto; min-width: 0; max-width: 15em; field-sizing: content; }
  .aca .og-svcs .og-svcadd { color: var(--muted); font-weight: 400; border: 1px dashed var(--border); border-radius: 999px; padding: 1px 8px; }
  .aca .og-roletags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .aca .og-roles { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 12px; color: var(--muted); }
  .aca .og-roles label { display: inline-flex; gap: 4px; align-items: center; }
  .aca .og-roles select { font: inherit; font-size: 12px; padding: 1px 4px; min-height: 0; height: auto; width: auto; }
  .aca .og-rolecheck { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; padding: 8px 10px; margin: 0 0 10px; border-radius: 6px; background: var(--surface-2); font-size: 13px; }
  .aca .og-pbody { flex: 1; overflow: auto; padding: 4px 18px 60px; }
  .aca tr.og-row { scroll-margin-top: calc(var(--og-top, 0px) + 50px); scroll-margin-bottom: 40px; }
  .aca .og-sec { padding: 14px 0; border-bottom: 1px solid var(--border); }
  .aca .og-sec:last-child { border-bottom: none; }
  .aca .og-sec h3 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .aca .og-grid { display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; align-items: center; font-size: 13px; }
  .aca .og-grid > label { color: var(--muted); font-size: 12.5px; }
  .aca .og-grid input[type=text], .aca .og-grid select, .aca .og-grid textarea { width: 100%; }
  .aca .og-panel textarea { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; resize: vertical; min-height: 60px; }
  .aca .og-main { font-weight: 500; }
  .aca .og-towns details { position: relative; }
  .aca table.og-table td.c-town .og-cell, .aca table.og-table td.c-town .og-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; word-break: normal; display: block; }
  .aca .og-towns summary { cursor: pointer; list-style: none; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--surface, #fff); font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .aca .og-towns summary::after { content: "\\25BE"; color: var(--muted); float: right; }
  .aca .og-townlist { position: absolute; z-index: 20; left: 0; right: 0; min-width: 200px; max-height: 280px; overflow: auto; background: var(--surface, #fff); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px rgba(16,24,40,.12); padding: 6px; margin-top: 4px; }
  .aca .og-townlist label { display: flex; gap: 8px; align-items: center; padding: 4px 6px; font-size: 13.5px; font-weight: 400; cursor: pointer; }
  .aca .og-townlist label .muted { margin-left: auto; font-size: 12px; }
  .aca table.og-table td.c-ct .og-main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; word-break: normal; }
  .aca .og-role { font-size: 12px; font-weight: 500; color: var(--text); background: var(--sel-bg); border-radius: 4px; padding: 1px 6px; margin-left: 2px; }
  .aca .og-qwho { display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .aca .og-qwho label { display: flex; gap: 6px; align-items: center; font-weight: 400; }
  .aca .og-qcount { white-space: normal; margin: 8px 0; }
  .aca .og-qskip { display: inline; } .aca .og-qskip[open] { display: block; margin-top: 4px; } .aca .og-qskip div { margin-top: 2px; }
  .aca .og-sp { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 6px; align-items: center; }
  .aca .og-sp select { grid-column: 1 / -1; }
  @media (max-width: 760px) { .aca .og-sp { grid-template-columns: 1fr; } }
  .aca .og-seasons { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .aca .og-seasons label { display: inline-flex; gap: 4px; align-items: center; font-size: 12.5px; }
  .aca .og-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .aca .og-ctab { width: 100%; font-size: 13px; }
  .aca .og-ctab td { padding: 6px 4px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  .aca .og-ctab input { width: 100%; padding: 4px 6px !important; font: inherit; font-size: 13px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 4px; }
  .aca .og-ctab tr.og-cedit { display: none; }
  .aca .og-ctab tr.og-cedit.open { display: table-row; }
  .aca .og-ctab tr.og-cedit > td { padding: 10px 8px 12px; background: var(--sel-bg); }
  .aca .og-ctab tr.og-caddlink > td { padding: 8px 4px; border-bottom: 0; }
  .aca .og-cgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; max-width: 560px; }
  .aca .og-cgrid label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
  .aca .og-cgrid label.wide, .aca .og-cgrid-foot { grid-column: 1 / -1; }
  .aca .og-cgrid-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 2px; }
  @media (max-width: 760px) { .aca .og-cgrid { grid-template-columns: 1fr; } }
  .aca .og-ctab select { font-size: 12px; padding: 3px 4px; max-width: 100px; }
  .aca .og-cname { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; }
  .aca .og-mail { border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; margin-bottom: 8px; font-size: 13px; }
  .aca .og-mail .og-actions { margin-top: 8px; }
  .aca .og-fu { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; padding: 6px 0; font-size: 13px; }
  .aca .og-fuadd { display: grid; grid-template-columns: 150px 1fr auto; gap: 6px; margin-top: 6px; }
  .aca .og-tlf { display: flex; gap: 6px; }
  .aca .og-tl { list-style: none; margin: 0; padding: 0; }
  .aca .og-tl li { padding: 9px 0 9px 14px; border-left: 2px solid var(--border); margin-left: 4px; position: relative; font-size: 13px; }
  .aca .og-tl li::before { content: ""; position: absolute; left: -6px; top: 14px; width: 10px; height: 10px; border-radius: 50%; background: var(--surface); border: 2px solid var(--hidden-fg); }
  .aca .og-tl li.k-reply::before { border-color: var(--ok-fg); background: var(--ok-bg); }
  .aca .og-tl li.k-bounce::before, .aca .og-tl li.k-unsubscribe::before { border-color: var(--err-fg); background: var(--err-bg); }
  .aca .og-tl li.k-note::before { border-color: var(--accent); background: var(--sel-bg); }
  .aca .og-tl li.k-email_sent::before, .aca .og-tl li.k-history_email::before { border-color: var(--accent); }
  .aca .og-tlh { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }
  .aca .og-tlh .when { font-weight: 400; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .aca .og-tlb { color: var(--text); margin-top: 2px; white-space: pre-wrap; word-break: break-word; }
  .aca .og-tlb.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
  .aca .og-tlm { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .aca .og-note { display: flex; gap: 6px; margin-bottom: 10px; }
  .aca .og-note textarea { flex: 1; min-height: 44px; }
  .aca .og-modal-wrap { position: fixed; inset: 0; top: var(--og-top, 0px); background: rgba(16,24,40,.45); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 9995; }
  .aca .og-modal { background: var(--surface); border-radius: var(--radius); box-shadow: 0 10px 30px rgba(16,24,40,.25); width: 100%; max-width: 460px; padding: 20px 22px; }
  .aca .og-modal h2 { margin: 0 0 12px; font-size: 16px; font-family: inherit; }
  .aca .og-modal { max-height: calc(100vh - var(--og-top, 0px) - 32px); overflow: auto; }
  .aca .og-modal.wide { max-width: 720px; }
  .aca .og-modal textarea { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; width: 100%; }
  .aca textarea.og-edbody { min-height: 300px; margin-top: 12px; font-size: 14px; line-height: 1.55; resize: vertical; }
  .aca .og-enc { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .aca .og-enc label { display: flex; gap: 8px; align-items: baseline; }
  .aca .og-enr { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 0 10px; font-size: 13px; }
  .aca .og-em { border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; margin-bottom: 8px; font-size: 13px; }
  .aca .og-em.sent { border-style: dashed; }
  .aca .og-em .og-actions { margin-top: 6px; }
  .aca .og-emh { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 600; }
  .aca .og-emb { color: var(--muted); font-size: 12.5px; margin-top: 4px; white-space: pre-line; }
  .aca details.og-sent summary { cursor: pointer; font-size: 13px; font-weight: 600; margin: 4px 0 8px; }
  .aca .og-snip { margin-top: 12px; }
  .aca .og-snip select { max-width: 100%; }
  .aca .og-sendstate { padding: 10px 16px 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; }
  .aca .og-imprev { max-height: 300px; overflow: auto; margin-top: 8px; }
  .aca .og-track { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; }
  .aca .og-ready { padding: 12px 16px 16px; }
  /* "Follow up later" pill: date stacked under the label so it fits the Stage column */
  .aca .pill.og-fpill { display: inline-flex; flex-direction: column; align-items: flex-start; line-height: 1.25; padding: 3px 9px; white-space: nowrap; }
  .aca .og-fpill .og-fdate { font-size: 11px; font-weight: 700; }
  .aca table.og-table td.c-stage { overflow: hidden; }
  @media (max-width: 760px) {
    .aca .og-heldhead { flex-direction: column; align-items: stretch; gap: 10px; padding: 10px 12px 0; }
    .aca .og-heldhead p { display: none; }
    .aca .og-heldhead .og-actions button { min-height: 44px; flex: 1 1 auto; }
    .aca .og-sendstate { padding: 10px 12px 0; font-size: 12.5px; }
    .aca .og-ready { padding: 10px 10px 12px; }
    .aca .og-rcard { padding: 12px; }
    .aca .og-rcard .og-emh { flex-direction: column; align-items: flex-start; gap: 2px; }
    .aca .og-rcard .og-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .aca .og-rcard .og-actions button { min-height: 44px; white-space: normal; }
    .aca .og-rcard .og-actions button.primary { grid-column: 1 / -1; }
    .aca .og-rbody { max-height: 240px; font-size: 14px; }
    .aca .og-modal-wrap { padding: 8px; align-items: flex-start; }
    .aca .og-modal { padding: 16px 14px; }
    .aca .og-modal .og-actions button { min-height: 44px; flex: 1 1 auto; }
    .aca textarea.og-edbody { min-height: 45vh; font-size: 16px; }
    .aca .og-modal input[type=text], .aca .og-modal input[type=date], .aca .og-modal input[type=datetime-local], .aca .og-modal select { font-size: 16px; min-height: 40px; }
  }
  .aca .og-rcard { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
  .aca .og-lbl { font-size: 11px; padding: 0 6px; line-height: 1.5; margin-left: 2px; vertical-align: 1px; font-weight: 600; }
  .aca .og-ladd { margin-top: 8px; padding: 10px 8px 12px; background: var(--sel-bg); border-radius: 6px; }
  .aca .og-ladd textarea { width: 100%; }
  .aca .og-panel.og-inline .og-details.hidden { display: none; }
  .aca .og-rcard.og-focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--sel-bg); }
  .aca .og-held { border-bottom: 1px solid var(--border); margin-bottom: 4px; }
  .aca .og-held.hidden { display: none; }
  .aca .og-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .aca .og-grid2 input { min-width: 0; }
  .aca .og-heldhead { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; padding: 12px 16px 0; }
  .aca .og-heldhead h3 { margin: 0 0 4px; font-size: 15px; }
  .aca .og-heldhead p { margin: 0; max-width: 680px; }
  .aca .og-rname { font-size: 14.5px; font-weight: 700; color: var(--text); }
  .aca .og-rsubj { font-weight: 600; font-size: 13px; margin-top: 6px; }
  .aca .og-rbody { white-space: pre-wrap; font-size: 13px; line-height: 1.5; margin: 6px 0 10px; max-height: 170px; overflow: auto; background: var(--surface-2); border-radius: 8px; padding: 8px 10px; }
  .aca .og-modal .field input, .aca .og-modal .field select { width: 100%; }
  html.aca-sheet-open, body.aca-sheet-open { overflow: hidden; }
  @media (max-width: 900px) {
    .aca #aca-ogPanel .og-phead { position: sticky; top: 0; z-index: 3; background: var(--surface); padding: 6px 14px 8px; gap: 4px 8px; flex-direction: row; flex-wrap: wrap; align-items: center; }
    .aca #aca-ogPanel .og-ptop { flex: 1 0 100%; }
    .aca #aca-ogPanel .og-pmeta { flex: 0 0 auto; }
    .aca #aca-ogPanel .og-pmeta .muted { display: none; }
    .aca #aca-ogPanel .og-phead .og-actions { flex: 1 1 0; min-width: 0; }
    .aca #aca-ogPanel .og-ptop input.og-title { font-size: 16px; min-height: 40px; }
    .aca #aca-ogPanel .og-pnav { gap: 0; }
    .aca #aca-ogPanel .og-pnav button { min-width: 40px; min-height: 40px; }
    .aca #aca-ogPanel .og-pmeta { flex-wrap: nowrap; gap: 8px; font-size: 12.5px; }
    .aca #aca-ogPanel .og-pmeta select { flex: 0 0 auto; min-height: 36px; }
    .aca #aca-ogPanel .og-pmeta .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .aca #aca-ogPanel .og-phead .og-actions { flex-wrap: nowrap; overflow-x: auto; gap: 6px; }
    .aca #aca-ogPanel .og-phead .og-actions button { flex: 0 0 auto; white-space: nowrap; min-height: 36px; }
  }
  @media (max-width: 760px) { .aca .og-panel { width: 100vw; border-left: none; } .aca .og-grid { grid-template-columns: 1fr; } .aca .og-fuadd { grid-template-columns: 1fr; } }`;
  const styleTag = document.createElement("style");
  styleTag.textContent = css;
  document.head.appendChild(styleTag);

  // ---------------------------------------------------------------- helpers
  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }
  const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  function fmtDay(iso) {
    if (!iso) return "";
    const d = new Date(String(iso).length === 10 ? iso + "T12:00:00" : iso);
    if (isNaN(d)) return "";
    return Fmt.day(d);
  }
  function fmtWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : Fmt.dayTime(d.toISOString());
  }
  const who = (c) => c ? ([c.first_name, c.last_name].filter(Boolean).join(" ") || c.email) : "";
  function gmailLink(id, history) {
    const acct = history ? "jmutty@gmail.com" : "jmutty@207photo.com";
    return "https://mail.google.com/mail/?authuser=" + encodeURIComponent(acct) + "#all/" + encodeURIComponent(id);
  }
  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < 1000) return out;
    }
  }
  const ORG_COLS = "id,name,name_known,audience,stage,sports,seasons,seasons_manual,town,county,website,notes,source,personal_line,last_contact_at,last_result,last_opened_at,next_action_at,next_action,needs_new_contact,search_text,created_at,stage_changed_at,gotphoto_names,client_since,last_job_at,next_job_at,job_count,sp_status,sp_competitor,sp_until,sp_note,shoot_months,services,service_status,roles_checked_at";

  // ---------------------------------------------------------------- panel markup (section lives in partners.html)
  const panelEl = el("panel-orgs");
  panelEl.innerHTML = `
    <div class="card">
      <div class="card-head og-head">
        <div>
          <h2>Partners</h2>
          <p>Every league and school you work with or plan to email. Click a row to open the partner page.</p>
        </div>
        <div class="og-actions"><button type="button" class="primary small" id="aca-ogAdd">+ Add partner</button>
          <button type="button" class="small" id="aca-ogImport">Import</button>
          <button type="button" class="small" id="aca-ogRefresh">Refresh</button></div>
      </div>
      <div class="og-groups">
        <div class="chips" id="aca-ogGroups" role="group" aria-label="Pipeline"></div>
        <div class="chips og-aud" id="aca-ogAudChips" role="group" aria-label="Type"><button type="button" data-aud="" aria-pressed="true">All</button><button type="button" data-aud="league" aria-pressed="false">Leagues</button><button type="button" data-aud="school" aria-pressed="false">Schools</button></div>
      </div>
      <div class="og-bar">
        <input type="search" id="aca-ogQ" placeholder="Search names, towns, people, emails, notes, sports, seasons&hellip;" aria-label="Search partners" />
        <div class="og-mtools">
          <button type="button" class="og-ftoggle" id="aca-ogFToggle" aria-expanded="false">Filters <span class="pill accent hidden" id="aca-ogFCount"></span></button>
          <select id="aca-ogSortM" aria-label="Sort by">
            <option value="next:1">Sort: Next up</option><option value="last:-1">Sort: Last contact (newest)</option>
            <option value="name:1">Sort: Name A&ndash;Z</option><option value="stage:1">Sort: Stage</option><option value="county:1">Sort: County</option><option value="result:1">Sort: Result</option>
          </select>
          <select id="aca-ogView" aria-label="Saved views"></select>
          <button type="button" class="small hidden" id="aca-ogViewDel">Delete view</button>
        </div>
        <div class="og-fsel" id="aca-ogFSel">
          <label class="og-f"><span>Stage</span><select id="aca-ogStage"><option value="">Any</option>${STAGES.map((s) => `<option value="${s[0]}">${s[1]}</option>`).join("")}</select></label>
          <label class="og-f"><span>Sport</span><select id="aca-ogSport"><option value="">Any</option></select></label>
          <label class="og-f"><span>Season</span><select id="aca-ogSeason"><option value="">Any</option>${SEASONS.map((s) => `<option value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></label>
          <label class="og-f"><span>Type</span><select id="aca-ogAud"><option value="">Leagues + schools</option><option value="league">Leagues</option><option value="school">Schools</option></select></label>
          <label class="og-f"><span>Service</span><select id="aca-ogService"><option value="">Any</option>${SERVICES.map((x) => `<option value="${x[0]}">${x[1]}</option>`).join("")}</select></label>
          <label class="og-f"><span>Service status</span><select id="aca-ogSvs"><option value="">Any</option>${SVC_ST.map((x) => `<option value="${x[0]}">${x[1]}</option>`).join("")}</select></label>
          <label class="og-f"><span>Shoots in</span><select id="aca-ogMonth"><option value="">Any month</option>${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}</select></label>
          <label class="og-f"><span>County</span><select id="aca-ogCounty"><option value="">Any</option>${COUNTIES.map((c) => `<option value="${c}">${c}</option>`).join("")}<option value="__none">Not set</option></select></label>
          <div class="og-f og-towns"><span>Towns</span><details id="aca-ogTownsBox"><summary id="aca-ogTownsSum">All towns</summary><div class="og-townlist" id="aca-ogTownList"></div></details></div>
          <label class="og-f"><span>School photos</span><select id="aca-ogSp"><option value="">Any</option>${SP.map((x) => `<option value="${x[0]}">${x[1]}</option>`).join("")}<option value="__none">Not set</option></select></label>
          <div class="og-f og-fdone"><button type="button" class="small" id="aca-ogFClose">Done</button></div>
        </div>
        <div class="og-active hidden" id="aca-ogActive"></div>
      </div>
      <div class="og-flags">
        <div class="chips" id="aca-ogFlags">${FLAGS.map((f) => `<button type="button" data-flag="${f[0]}" aria-pressed="false">${f[1]} <span data-n="${f[0]}"></span></button>`).join("")}</div>
        <button type="button" class="link" id="aca-ogReset">Clear filters</button>
        <span class="og-count" id="aca-ogCount"></span>
      </div>
      <div class="og-bulk hidden" id="aca-ogBulk">
        <strong id="aca-ogBulkN"></strong>
        <button type="button" class="small primary" id="aca-ogBulkMail">Email&hellip;</button>
        <button type="button" class="small" id="aca-ogBulkApprove" title="Approve the held outreach emails of the ticked partners">Approve selected</button>
        <select id="aca-ogBulkStage" class="small"><option value="">Set stage&hellip;</option>${STAGES.map((s) => `<option value="${s[0]}">${s[1]}</option>`).join("")}</select>
        <input type="text" id="aca-ogBulkSport" list="aca-ogSports" placeholder="Add a sport" />
        <input type="date" id="aca-ogBulkFu" title="Follow-up date" />
        <button type="button" class="small primary" id="aca-ogBulkGo">Apply</button>
        <button type="button" class="link" id="aca-ogBulkClear">Clear selection</button>
      </div>
      <datalist id="aca-ogSports"></datalist>
      <div id="aca-ogErr" class="inline-error hidden" style="margin-top:12px"></div>
      <div class="table-wrap">
        <table class="og-table">
          <colgroup><col class="c-ck"><col class="c-org"><col class="c-stage"><col class="c-sports"><col class="c-town"><col class="c-ct"><col class="c-last"><col class="c-res"><col class="c-next"></colgroup>
          <thead><tr id="aca-ogHead">
            <th class="nosort"><input type="checkbox" id="aca-ogAll" aria-label="Select all shown" /></th>
            <th data-k="name" data-b="name">Partner</th><th data-k="stage" data-b="stage">Stage</th><th data-k="sports" data-b="sports">Sports</th><th data-k="county" data-b="county">County</th>
            <th data-k="contacts" data-b="contacts">Contacts</th><th data-k="last" data-b="last" title="Last contact">Last</th><th data-k="result" data-b="result">Result</th><th data-k="next" data-b="next">Next up</th>
          </tr></thead>
          <tbody id="aca-ogBody"><tr><td colspan="9" class="empty">Loading&hellip;</td></tr></tbody>
        </table>
      </div>
      <div class="og-more hidden" id="aca-ogMoreWrap"><button type="button" class="small" id="aca-ogMore">Show more</button></div>
    </div>
    <aside class="og-panel hidden" id="aca-ogPanel" aria-label="Partner details"></aside>`;

  // ---------------------------------------------------------------- data
  async function load(force) {
    if (loading) return loading;
    if (loaded && !force) { render(); return; }
    loading = (async () => {
      try {
        const [rows, contacts, fus, held, sets, views, rc] = await Promise.all([
          fetchAll(() => sb.from("prospect_orgs").select(ORG_COLS).is("merged_into", null).order("name")),  // merged duplicates stay out
          fetchAll(() => sb.from("prospect_contacts").select("org_id,first_name,last_name,email,is_primary,created_at,bounced_at,unsubscribed_at,stopped_at").order("id")),
          fetchAll(() => sb.from("prospect_followups").select("org_id,due_on").eq("status", "open").order("id")),
          sb.from("prospect_scheduled_emails").select("org_id").eq("status", "held").eq("needs_review", true),
          sb.from("prospect_settings").select("cooldown_months").maybeSingle(),
          sb.from("prospect_saved_views").select("id,name,config,sort_order").order("sort_order").order("created_at"),
          sb.rpc("prospect_roles_to_check"),
        ]);
        roleCheck = new Set(((rc && rc.data) || []).map((r) => (typeof r === "string" ? r : r.prospect_roles_to_check)));
        orgs = rows;
        byId = new Map(orgs.map((o) => [o.id, o]));
        contactStats = new Map();
        contacts.forEach((c) => addContactStat(c));
        followDue = new Map();
        fus.forEach((f) => { if (f.org_id && (!followDue.has(f.org_id) || f.due_on < followDue.get(f.org_id))) followDue.set(f.org_id, f.due_on); });
        readyOrgs = new Set(((held && held.data) || []).map((r) => r.org_id));
        cooldownMonths = (sets && sets.data && sets.data.cooldown_months) || 6;
        savedViews = (views && views.data) || [];
        const sp = new Set();
        orgs.forEach((o) => (o.sports || []).forEach((s) => sp.add(s)));
        ["baseball", "basketball", "cheer", "cross country", "field hockey", "football", "gymnastics", "hockey", "lacrosse", "skiing",
          "soccer", "softball", "swimming", "track", "volleyball", "wrestling"].forEach((s) => sp.add(s));
        sportList = [...sp].sort();
        loaded = true;
        el("ogErr").classList.add("hidden");
        fillSelects();
        fillTowns();
        render();
        if (initialOpen && !openId && byId.has(initialOpen) && !load.didInitial) { load.didInitial = true; openOrg(initialOpen); }
        if (!load.didGroup) {
          load.didGroup = true; const g = groupInHash();
          // Admins open on the Clients view once there are clients (2026-10-24); a group in the address still wins
          if (g) setGroup(g, true);
          else if (ACCESS.is_admin && !/orgs\/everyone/i.test(location.hash) && orgs.some((o) => GROUP_OF.clients[2].includes(o.stage))) setGroup("clients", true);
        }
      } catch (e) {
        el("ogErr").textContent = "Could not load partners: " + cleanErr(e);
        el("ogErr").classList.remove("hidden");
      } finally { loading = null; }
    })();
    return loading;
  }
  function addContactStat(c) {
    const s = contactStats.get(c.org_id) || { n: 0, bounced: 0, unsub: 0, mains: [], first: null };
    s.n++; if (c.bounced_at) s.bounced++; if (c.unsubscribed_at) s.unsub++;
    // main contacts: every starred one that still works; with none, the first working contact stands in
    if (!c.bounced_at && !c.unsubscribed_at && !c.stopped_at) {
      if (c.is_primary) s.mains.push(c);
      if (!s.first || c.created_at < s.first.created_at) s.first = c;
    }
    contactStats.set(c.org_id, s);
  }
  async function reloadOrg(id) {
    const { data, error } = await sb.from("prospect_orgs").select(ORG_COLS).eq("id", id).maybeSingle();
    if (error || !data) return;
    const i = orgs.findIndex((o) => o.id === id);
    if (i >= 0) orgs[i] = data; else orgs.push(data);
    byId.set(id, data);
    // same columns and rules as load(), so the list's Contacts column (main contacts) updates without a page refresh
    const { data: cs } = await sb.from("prospect_contacts").select("org_id,first_name,last_name,email,is_primary,created_at,bounced_at,unsubscribed_at,stopped_at").eq("org_id", id).order("id");
    contactStats.delete(id);
    (cs || []).forEach((c) => addContactStat(c));
    const { data: fu } = await sb.from("prospect_followups").select("due_on").eq("org_id", id).eq("status", "open").order("due_on").limit(1);
    if (fu && fu.length) followDue.set(id, fu[0].due_on); else followDue.delete(id);
    render();
  }

  function fillSelects() {
    const sportSel = el("ogSport");
    sportSel.innerHTML = '<option value="">Any</option><option value="__none">No sport tagged</option>' +
      sportList.map((s) => `<option value="${esc(s)}">${esc(s[0].toUpperCase() + s.slice(1))}</option>`).join("");
    sportSel.value = st.sport;
    el("ogSports").innerHTML = sportList.map((s) => `<option value="${esc(s)}">`).join("");
    const vs = el("ogView");
    vs.innerHTML = '<option value="">Views&hellip;</option>' +
      '<optgroup label="Built in">' + BUILTIN_VIEWS.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join("") + "</optgroup>" +
      (savedViews.length ? '<optgroup label="Saved">' + savedViews.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("") + "</optgroup>" : "") +
      '<option value="__save">Save current view&hellip;</option>';
  }

  // ---------------------------------------------------------------- filter + sort
  function flagOf(o, f) {
    const today = todayStr();
    if (f === "followup") return followDue.has(o.id) && followDue.get(o.id) <= today;
    if (f === "due7") {
      if (!o.next_action_at) return false;
      return new Date(o.next_action_at).getTime() <= Date.now() + 7 * 864e5;
    }
    if (f === "ready") return readyOrgs.has(o.id);
    if (f === "needs_new") return !!o.needs_new_contact;
    if (f === "rolecheck") return roleCheck.has(o.id);
    if (f === "never") return !o.last_contact_at;
    if (f === "opened") return !!o.last_opened_at && o.last_result !== "Replied";
    if (f === "cooldown") {
      if (!o.last_contact_at) return false;
      const d = new Date(o.last_contact_at); d.setMonth(d.getMonth() + cooldownMonths);
      return d.getTime() > Date.now();
    }
    return true;
  }
  // Search is global: while there's search text, filters and quick buttons are paused (Jeremiah 2026-09-27)
  const filtersActive = () => !!(st.stage || st.sport || st.season || st.audience || st.service || st.svs || st.month || st.sp || st.county || (st.towns || []).length || st.flag);
  function matches(o) {
    if (st.q) return searchHit(o);
    if (st.group && GROUP_OF[st.group] && !GROUP_OF[st.group][2].includes(o.stage)) return false;
    if (st.stage && o.stage !== st.stage) return false;
    if (st.audience && o.audience !== st.audience) return false;
    if (st.sport === "__none" && (o.sports || []).length) return false;
    if (st.sport && st.sport !== "__none" && !(o.sports || []).includes(st.sport)) return false;
    if (st.season && !(o.seasons || []).includes(st.season)) return false;
    if (st.month && !(o.shoot_months || []).includes(+st.month)) return false;
    if (st.service && !(o.services || []).includes(st.service) && !(o.service_status || {})[st.service]) return false;
    // status for the picked service (any service when none is picked)
    if (st.svs && !(st.service ? (o.service_status || {})[st.service] === st.svs : Object.values(o.service_status || {}).includes(st.svs))) return false;
    if (st.sp === "__none" && (o.audience !== "school" || o.sp_status)) return false;
    if (st.sp && st.sp !== "__none" && (o.audience !== "school" || o.sp_status !== st.sp)) return false;
    if (st.county === "__none" && o.county) return false;
    if (st.county && st.county !== "__none" && o.county !== st.county) return false;
    if ((st.towns || []).length && !st.towns.includes(o.town || "")) return false;
    if (st.flag && !flagOf(o, st.flag)) return false;
    return true;
  }
  function searchHit(o) {
    const hay = (o.search_text || "") + " " + (o.name || "").toLowerCase();
    return st.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  const SORTS = {
    name: (o) => (o.name || "").toLowerCase(),
    stage: (o) => STAGE_ORDER[o.stage] ?? 99,
    sports: (o) => (o.sports || [])[0] || "￿",
    town: (o) => (o.town || "￿").toLowerCase(),
    county: (o) => (o.county || "￿") + "|" + (o.town || "￿").toLowerCase(),
    contacts: (o) => (contactStats.get(o.id) || { n: 0 }).n,
    last: (o) => lastAt(o),
    result: (o) => o.last_result || "￿",
    next: (o) => nextAt(o),
    lastjob: (o) => o.last_job_at || null,
    nextjob: (o) => o.next_job_at || null,
  };
  // next action = the earlier of a follow-up date and the next scheduled email (triggers keep next_action_at)
  // "Last" = the most recent contact of any kind: an email, or (for clients) a picture day
  function lastAt(o) {
    const a = o.last_contact_at ? new Date(o.last_contact_at).getTime() : 0;
    const b = o.last_job_at ? new Date(o.last_job_at + "T12:00:00").getTime() : 0;
    return Math.max(a, b) || null;
  }
  function nextAt(o) { return o.next_action_at ? new Date(o.next_action_at).getTime() : null; }
  function sorted(list) {
    const f = SORTS[st.sort.key] || SORTS.name, dir = st.sort.dir;
    return list.map((o) => [f(o), o]).sort((a, b) => {
      const x = a[0], y = b[0];
      if (x === y) return (a[1].name || "").localeCompare(b[1].name || "");
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * dir;
    }).map((p) => p[1]);
  }

  // ---------------------------------------------------------------- list
  // "Follow up later" shows its reminder date right on the pill: "Follow up · Aug 2027".
  function stagePill(s, o) {
    if (s === "not_now" && o && followDue.has(o.id)) {
      const d = new Date(followDue.get(o.id) + "T12:00:00");
      const when = d.getFullYear() === new Date().getFullYear()
        ? Fmt.day(followDue.get(o.id))
        : d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
      const late = followDue.get(o.id) <= todayStr();
      return `<span class="pill og-fpill ${late ? "err" : "warn"}" title="Follow up on ${esc(fmtDay(followDue.get(o.id)))}">Follow up<span class="og-fdate">${esc(when)}</span></span>`;
    }
    return `<span class="pill ${STAGE_CLS[s] || "muted"}">${esc(STAGE_NAME[s] || s)}</span>`;
  }
  // Moving an org to "Follow up later" asks when (and why) in the same step. Resolves {due, note} or null.
  function askFollowLater(o) {
    const d = (m) => { const x = new Date(); x.setMonth(x.getMonth() + m); return x.toLocaleDateString("en-CA"); };
    const nextYear = `${new Date().getFullYear() + 1}-01-15`;
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      modal(`
        <h2>Follow up later: ${esc(o.name)}</h2>
        <p class="og-sub" style="white-space:normal;margin:0 0 10px">They leave Active lead and come back to you on this date: in Follow-up due, on Today, and in the morning email.</p>
        <div class="og-actions" style="margin-bottom:10px">
          ${[["1 month", d(1)], ["3 months", d(3)], ["6 months", d(6)], ["Next year (mid-Jan)", nextYear]].map((q) => `<button type="button" class="small" data-pick="${q[1]}">${q[0]}</button>`).join("")}
        </div>
        <div class="og-grid">
          <label for="aca-ogFlDate">Remind me on</label><input type="date" id="aca-ogFlDate" value="${d(3)}" />
          <label for="aca-ogFlNote">About</label><input type="text" id="aca-ogFlNote" placeholder="e.g. Interested for 2027, call about spring dates" />
        </div>
        <div class="og-actions" style="margin-top:14px"><button type="button" class="primary" data-v="ok">Save</button><button type="button" data-v="close">Cancel</button></div>`)
        .then(() => finish(null));
      const box = modal.last;
      box.addEventListener("click", (e) => {
        const b = e.target.closest("button"); if (!b) return;
        if (b.dataset.pick) { el("ogFlDate").value = b.dataset.pick; return; }
        if (b.dataset.v === "close") { box.close(null); return; }
        if (b.dataset.v === "ok") {
          const due = el("ogFlDate").value;
          if (!due) { el("ogFlDate").focus(); return; }
          const v = { due, note: el("ogFlNote").value.trim() || null };
          finish(v); box.close(v);
        }
      });
    });
  }
  function contactsCell(o) {
    const s = contactStats.get(o.id);
    if (!s || !s.n) return '<span class="muted">None</span>';
    const bits = [];
    if (s.bounced) bits.push(`${s.bounced} bounced`);
    if (s.unsub) bits.push(`${s.unsub} unsub.`);
    const mains = s.mains.length ? s.mains : s.first ? [s.first] : [];
    // one line per main contact (up to 2), whole names, never broken mid-word
    const shown = mains.slice(0, 2), more = s.n - shown.length;
    const main = mains.length ? shown.map((c) => `<div class="og-main" title="Main contact: ${esc(who(c))}${c.role ? ", " + esc(c.role) : ""} <${esc(c.email)}>">${esc(who(c))}</div>`).join("")
      : '<span class="muted">No working email</span>';
    return `${main}${mains.length && more > 0 ? `<div class="og-sub">+${more} more</div>` : ""}${bits.length ? `<div class="og-sub">${esc(bits.join(", "))}</div>` : ""}`;
  }
  function nextCell(o) {
    if (!o.next_action) return '<span class="muted">&mdash;</span>';
    const late = o.next_action_at && new Date(o.next_action_at).getTime() < Date.now() - 864e5 / 2 && /^Follow up/.test(o.next_action);
    return `<div class="og-cell${late ? " og-late" : ""}">${esc(o.next_action_at ? fmtDay(o.next_action_at) : "")}</div><div class="og-sub" title="${esc(o.next_action)}">${esc(o.next_action)}</div>`;
  }
  function render() {
    const list = sorted(orgs.filter(matches));
    visible = list;
    el("ogCount").textContent = st.q && filtersActive()
      ? `${list.length} found in all ${orgs.length} (filters paused while searching)`
      : `${list.length} of ${orgs.length}`;
    el("ogFlags").classList.toggle("og-paused", !!st.q);
    el("ogGroups").parentElement.classList.toggle("og-paused", !!st.q);
    const inAud = (o) => !st.audience || o.audience === st.audience;
    el("ogGroups").innerHTML = GROUPS.map((g) => `<button type="button" data-group="${g[0]}" aria-pressed="${st.group === g[0]}">${g[1]} <span>${g[2] ? orgs.filter((o) => inAud(o) && g[2].includes(o.stage)).length : orgs.filter(inAud).length}</span></button>`).join("");
    el("ogAudChips").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String((st.audience || "") === b.dataset.aud)));
    el("ogActive").classList.toggle("og-paused", !!st.q);
    FLAGS.forEach((f) => {
      const n = orgs.filter((o) => flagOf(o, f[0])).length;
      const span = el("ogFlags").querySelector(`[data-n="${f[0]}"]`);
      if (span) span.textContent = n ? `(${n})` : "";
    });
    el("ogFlags").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(st.flag === b.dataset.flag)));
    // Clients view (2026-10-24): the columns a client needs: main contact, last and next picture day
    const cl = st.group === "clients";
    const LABEL = { name: "Partner", stage: "Stage", sports: "Sports", county: "County", contacts: cl ? "Main contact" : "Contacts",
      last: cl ? "Last picture day" : "Last", result: cl ? "Next picture day" : "Result", next: "Next up" };
    el("ogHead").querySelectorAll("th[data-b]").forEach((th) => {
      const b = th.dataset.b;
      th.dataset.k = cl && b === "last" ? "lastjob" : cl && b === "result" ? "nextjob" : b;
      const on = th.dataset.k === st.sort.key;
      th.innerHTML = esc(LABEL[b]) + (on ? `<span class="arr">${st.sort.dir > 0 ? "&#9650;" : "&#9660;"}</span>` : "");
    });
    const jobDay = (d) => d ? esc(fmtDay(new Date(d + "T12:00:00").toISOString())) : "";
    const rows = list.slice(0, shown);
    el("ogBody").innerHTML = rows.length ? rows.map((o) => {
      const sub = [o.audience === "school" ? "School" : "League", spText(o), o.name_known === false ? "name from email handle" : ""].filter(Boolean).join(" \u00b7 ");
      const flags = ((o.services || []).includes("action") ? '<span class="pill accent og-flag" title="We shoot action for them">Action</span>' : "") + (o.needs_new_contact ? '<span class="pill err og-flag">Needs contact</span>' : "") +
        (readyOrgs.has(o.id) ? '<span class="pill warn og-flag">Waiting for your OK</span>' : "");
      const mmeta = [(o.sports || []).join(", "), o.county ? o.county + (o.town ? " (" + o.town + ")" : "") : o.town, o.last_result, spText(o)].filter(Boolean).join(" \u00b7 ");
      return `<tr class="og-row${o.id === openId ? " open" : ""}" data-id="${esc(o.id)}">
        <td class="c-ck"><input type="checkbox" class="og-ck" ${selected.has(o.id) ? "checked" : ""} aria-label="Select ${esc(o.name)}" /></td>
        <td class="c-org"><div class="og-name" title="${esc(o.name)}">${esc(o.name)}${flags}</div><div class="og-sub og-dsk">${esc(sub)}</div>
          <div class="og-sub og-mob">${esc(mmeta || sub)}</div><span class="nt-line" data-nt-org="${esc(o.id)}"></span></td>
        <td class="c-stage">${stagePill(o.stage, o)}</td>
        <td class="c-sports"><div class="og-cell" title="${esc((o.sports || []).join(", "))}">${esc((o.sports || []).join(", ")) || '<span class="muted">&mdash;</span>'}</div><div class="og-sub" title="${esc(monthsText(o) ? "Shoots: " + monthsText(o) : "")}">${esc(monthsText(o) || (o.seasons || []).join(", "))}</div></td>
        <td class="c-town"><div class="og-cell">${o.county ? esc(o.county) : '<span class="muted">&mdash;</span>'}</div>${o.town ? `<div class="og-sub" title="${esc(o.town)}">${esc(o.town)}</div>` : ""}</td>
        <td class="og-cell c-ct">${contactsCell(o)}</td>
        ${cl ? `<td class="og-cell c-last" title="Last picture day">${jobDay(o.last_job_at) || '<span class="muted">None yet</span>'}</td>
        <td class="og-cell c-res" title="Next picture day">${jobDay(o.next_job_at) || '<span class="muted">Not booked</span>'}</td>`
    : `<td class="og-cell c-last" title="${esc(o.last_job_at && lastAt(o) === new Date(o.last_job_at + "T12:00:00").getTime() ? "Last picture day" : "Last email")}">${lastAt(o) ? esc(fmtDay(new Date(lastAt(o)).toISOString())) : '<span class="muted">Never</span>'}</td>
        <td class="og-cell c-res">${esc(o.last_result || "")}</td>`}
        <td class="c-next">${nextCell(o)}</td></tr>`;
    }).join("") : `<tr><td colspan="9" class="empty">${loaded ? emptyText() : "Loading&hellip;"}</td></tr>`;
    Notes.fillLines(el("ogBody")); // each partner's newest note under the name, 2026-10-24
    el("ogMoreWrap").classList.toggle("hidden", list.length <= shown);
    el("ogMore").textContent = `Show ${Math.min(PAGE, list.length - shown)} more`;
    el("ogAll").checked = rows.length > 0 && rows.every((o) => selected.has(o.id));
    renderBulk();
    syncMobile();
    renderActive();
  }
  // With nothing filtered, an empty group says what belongs in it instead of "clear the filters" (2026-10-24)
  function emptyText() {
    if (st.q || filtersActive()) return "Nothing matches. Try clearing the filters.";
    if (st.group === "clients") return "No clients yet. A partner shows up here once they book a picture day.";
    const g = GROUP_OF[st.group];
    return g && g[0] ? `No partners in ${esc(g[1])} right now.` : "No partners yet. Use + Add partner to add the first one.";
  }
  function renderBulk() {
    el("ogBulk").classList.toggle("hidden", !selected.size);
    el("ogBulkN").textContent = `${selected.size} selected`;
  }
  function syncControls() {
    el("ogQ").value = st.q; el("ogStage").value = st.stage; el("ogSport").value = st.sport;
    el("ogSeason").value = st.season; el("ogAud").value = st.audience; el("ogSp").value = st.sp || ""; el("ogMonth").value = st.month || ""; el("ogService").value = st.service || ""; el("ogSvs").value = st.svs || "";
    el("ogCounty").value = st.county || "";
    fillTowns();
  }
  // Towns: the towns we have orgs in, inside the chosen county (all counties when none is chosen)
  function fillTowns() {
    const pick = new Set(st.towns || []);
    const towns = [...new Set(orgs.filter((o) => o.town && (!st.county || st.county === "__none" || o.county === st.county)).map((o) => o.town))]
      .sort((a, b) => a.localeCompare(b));
    el("ogTownList").innerHTML = towns.length ? towns.map((t) => `<label><input type="checkbox" value="${esc(t)}" ${pick.has(t) ? "checked" : ""} /> ${esc(t)}
      <span class="muted">${orgs.filter((o) => o.town === t).length}</span></label>`).join("") : '<span class="muted">No towns</span>';
    el("ogTownsSum").textContent = pick.size ? (pick.size === 1 ? [...pick][0] : `${pick.size} towns`) : (st.county && st.county !== "__none" ? `All towns in ${st.county}` : "All towns");
  }
  // Phone: filters fold behind one button (count shows what's active); column headers become a Sort menu.
  function syncMobile() {
    const n = [st.stage, st.sport, st.season, st.audience, st.sp, st.month, st.service, st.svs, st.county].filter(Boolean).length + ((st.towns || []).length ? 1 : 0);
    el("ogFCount").textContent = n; el("ogFCount").classList.toggle("hidden", !n);
    const v = st.sort.key + ":" + st.sort.dir, sel = el("ogSortM");
    if (![...sel.options].some((o) => o.value === v)) sel.insertAdjacentHTML("beforeend", `<option value="${esc(v)}">Sort: ${esc(st.sort.key)}</option>`);
    sel.value = v;
  }
  const FILTER_KEYS = [["stage", "ogStage", "Stage"], ["sport", "ogSport", "Sport"], ["season", "ogSeason", "Season"], ["audience", "ogAud", "Type"],
    ["service", "ogService", "Service"], ["svs", "ogSvs", "Service status"], ["month", "ogMonth", "Shoots in"], ["sp", "ogSp", "School photos"], ["county", "ogCounty", "County"]];
  function renderActive() {
    const tags = FILTER_KEYS.filter(([k]) => st[k]).map(([k, id, label]) => {
      const sel = el(id), opt = sel && [...sel.options].find((o) => o.value === String(st[k]));
      return `<span class="og-atag">${esc(label)}: ${esc(opt ? opt.textContent : st[k])}<button type="button" data-clear="${k}" aria-label="Remove ${esc(label)} filter">&times;</button></span>`;
    });
    if ((st.towns || []).length) tags.push(`<span class="og-atag">Town${st.towns.length > 1 ? "s" : ""}: ${esc(st.towns.join(", "))}<button type="button" data-clear="towns" aria-label="Remove town filter">&times;</button></span>`);
    el("ogActive").innerHTML = tags.join("");
    el("ogActive").classList.toggle("hidden", !tags.length);
  }
  el("ogActive").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-clear]"); if (!b) return;
    st[b.dataset.clear] = b.dataset.clear === "towns" ? [] : "";
    if (b.dataset.clear === "county") st.towns = [];
    shown = PAGE; syncControls(); render();
  });
  el("ogFClose").addEventListener("click", () => { el("ogFSel").classList.remove("open"); el("ogFToggle").setAttribute("aria-expanded", "false"); panelEl.classList.remove("og-fopen"); });
  el("ogFToggle").addEventListener("click", () => {
    const open = !el("ogFSel").classList.contains("open");
    el("ogFSel").classList.toggle("open", open); el("ogFToggle").setAttribute("aria-expanded", String(open));
    panelEl.classList.toggle("og-fopen", open);
  });
  el("ogSortM").addEventListener("change", () => {
    const [k, d] = el("ogSortM").value.split(":"); st.sort = { key: k, dir: +d }; render();
  });
  function applyConfig(cfg) {
    st = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), JSON.parse(JSON.stringify(cfg || {})));
    shown = PAGE;
    syncControls();
    render();
  }

  let qTimer;
  el("ogQ").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = el("ogQ").value.trim(); shown = PAGE; render(); }, 120); });
  el("ogCounty").addEventListener("change", () => { st.county = el("ogCounty").value; st.towns = []; shown = PAGE; fillTowns(); render(); });
  el("ogTownList").addEventListener("change", () => {
    st.towns = [...el("ogTownList").querySelectorAll("input:checked")].map((i) => i.value);
    shown = PAGE; fillTowns(); render();
  });
  [["ogStage", "stage"], ["ogSport", "sport"], ["ogSeason", "season"], ["ogAud", "audience"], ["ogSp", "sp"], ["ogMonth", "month"], ["ogService", "service"], ["ogSvs", "svs"]].forEach(([id, k]) =>
    el(id).addEventListener("change", () => { st[k] = el(id).value; shown = PAGE; render(); }));
  el("ogFlags").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-flag]"); if (!b) return;
    st.flag = st.flag === b.dataset.flag ? "" : b.dataset.flag; shown = PAGE; render();
  });
  function setGroup(g, viaHash) {
    const def = GROUP_OF[g] ? GROUP_OF[g] : GROUP_OF[""];
    st.group = def[0]; st.stage = ""; st.q = "";
    if (def[3]) st.sort = { ...def[3] };
    syncControls(); render();
    if (!viaHash && !openId) history.replaceState(null, "", "#partners/orgs" + (def[0] ? "/" + def[0] : ""));
  }
  el("ogGroups").addEventListener("click", (e) => { const b = e.target.closest("button[data-group]"); if (b) setGroup(b.dataset.group); });
  el("ogAudChips").addEventListener("click", (e) => { const b = e.target.closest("button[data-aud]"); if (!b) return; st.audience = b.dataset.aud; syncControls(); render(); });
  el("ogReset").addEventListener("click", () => { el("ogView").value = ""; el("ogViewDel").classList.add("hidden"); applyConfig({}); });
  el("ogHead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]"); if (!th) return;
    const k = th.dataset.k;
    st.sort = st.sort.key === k ? { key: k, dir: -st.sort.dir } : { key: k, dir: (k === "last" ? -1 : 1) };
    render();
  });
  el("ogMore").addEventListener("click", () => { shown += PAGE; render(); });
  el("ogRefresh").addEventListener("click", () => load(true));
  el("ogBody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr.og-row"); if (!tr) return;
    if (e.target.closest(".og-ck")) {
      const ck = e.target.closest(".og-ck");
      if (ck.checked) selected.add(tr.dataset.id); else selected.delete(tr.dataset.id);
      renderBulk(); return;
    }
    // the whole checkbox cell is the hit area, not just the little box
    const cell = e.target.closest("td.c-ck");
    if (cell) {
      const ck = cell.querySelector(".og-ck"); ck.checked = !ck.checked;
      if (ck.checked) selected.add(tr.dataset.id); else selected.delete(tr.dataset.id);
      renderBulk(); return;
    }
    openOrg(tr.dataset.id);
  });
  el("ogAll").closest("th").addEventListener("click", (e) => {
    if (e.target.id === "aca-ogAll") return;
    el("ogAll").checked = !el("ogAll").checked; el("ogAll").dispatchEvent(new Event("change"));
  });
  el("ogAll").addEventListener("change", () => {
    visible.slice(0, shown).forEach((o) => { if (el("ogAll").checked) selected.add(o.id); else selected.delete(o.id); });
    render();
  });

  // saved views
  el("ogView").addEventListener("change", async () => {
    const v = el("ogView").value;
    el("ogViewDel").classList.add("hidden");
    if (!v) return;
    if (v === "__save") {
      el("ogView").value = "";
      const name = (prompt("Name this view (it saves the search, filters and sort):") || "").trim();
      if (!name) return;
      const { data, error } = await sb.from("prospect_saved_views").insert({ name, config: st, sort_order: savedViews.length }).select("id,name,config,sort_order").single();
      if (error) { toast("Could not save the view: " + cleanErr(error), true); return; }
      savedViews.push(data); fillSelects(); el("ogView").value = data.id; el("ogViewDel").classList.remove("hidden");
      toast("View saved");
      return;
    }
    const view = BUILTIN_VIEWS.find((x) => x.id === v) || savedViews.find((x) => x.id === v);
    if (!view) return;
    applyConfig(view.config);
    el("ogView").value = v;
    if (!v.startsWith("b-")) el("ogViewDel").classList.remove("hidden");
  });
  el("ogViewDel").addEventListener("click", async () => {
    const v = el("ogView").value;
    const view = savedViews.find((x) => x.id === v);
    if (!view || !confirm(`Delete the view "${view.name}"?`)) return;
    const { error } = await sb.from("prospect_saved_views").delete().eq("id", v);
    if (error) { toast(cleanErr(error), true); return; }
    savedViews = savedViews.filter((x) => x.id !== v); fillSelects(); el("ogViewDel").classList.add("hidden");
  });

  // bulk
  el("ogBulkClear").addEventListener("click", () => { selected.clear(); render(); });
  el("ogBulkGo").addEventListener("click", async () => {
    const ids = [...selected];
    const stage = el("ogBulkStage").value, sport = el("ogBulkSport").value.trim().toLowerCase(), fu = el("ogBulkFu").value;
    if (!stage && !sport && !fu) { toast("Pick a stage, a sport, or a follow-up date first", true); return; }
    const parts = [stage && `set stage to ${STAGE_NAME[stage]}`, sport && `add "${sport}"`, fu && `set a follow-up for ${fmtDay(fu)}`].filter(Boolean);
    if (!confirm(`For ${ids.length} partner${ids.length === 1 ? "" : "s"}: ${parts.join(", ")}?`)) return;
    const btn = el("ogBulkGo"); btn.disabled = true;
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        if (stage) { const { error } = await sb.from("prospect_orgs").update({ stage }).in("id", chunk); if (error) throw error; }
        if (sport) {
          for (const id of chunk) {
            const o = byId.get(id); if (!o || (o.sports || []).includes(sport)) continue;
            const { error } = await sb.from("prospect_orgs").update({ sports: [...(o.sports || []), sport] }).eq("id", id); if (error) throw error;
          }
        }
        if (fu) {
          const { data: cs } = await sb.from("prospect_contacts").select("org_id,email,bounced_at,unsubscribed_at").in("org_id", chunk);
          const rows = chunk.map((id) => ({ org_id: id, org_name: (byId.get(id) || {}).name || "", due_on: fu,
            emails: (cs || []).filter((c) => c.org_id === id && !c.bounced_at && !c.unsubscribed_at).map((c) => c.email) }));
          const { error } = await sb.from("prospect_followups").insert(rows); if (error) throw error;
        }
      }
      toast(`Updated ${ids.length} partner${ids.length === 1 ? "" : "s"}`);
      selected.clear();
      el("ogBulkStage").value = ""; el("ogBulkSport").value = ""; el("ogBulkFu").value = "";
      await load(true);
    } catch (e) { toast("Stopped partway: " + cleanErr(e), true); await load(true); }
    finally { btn.disabled = false; }
  });

  // approve selected: schedule the held (review) outreach of the ticked orgs, sequences and quick drafts alike (2026-10-17)
  el("ogBulkApprove").addEventListener("click", async () => {
    const ids = [...selected].filter((id) => readyOrgs.has(id));
    if (!ids.length) { toast("None of the ticked partners has an email waiting for review", true); return; }
    const { data, error } = await sb.from("prospect_scheduled_emails").select("id,org_id,enrollment_id").eq("status", "held").eq("needs_review", true).in("org_id", ids);
    if (error) { toast(cleanErr(error), true); return; }
    const enrs = [...new Set((data || []).filter((r) => r.enrollment_id).map((r) => r.enrollment_id))];
    const quick = (data || []).filter((r) => !r.enrollment_id).map((r) => r.id);
    const names = ids.map((id) => (byId.get(id) || {}).name).filter(Boolean);
    if (!confirm(`Approve outreach for ${ids.length} partner${ids.length === 1 ? "" : "s"}? ${enrs.length} sequence${enrs.length === 1 ? "" : "s"}${quick.length ? ` and ${quick.length} quick email${quick.length === 1 ? "" : "s"}` : ""}. First emails go out in the next send window (to send right away, use Send now on each one in the Outbox).\n\n${names.join(", ")}`)) return;
    const btn = el("ogBulkApprove"); btn.disabled = true;
    let ok = 0;
    try {
      for (const id of enrs) { const { error: e1 } = await sb.rpc("prospect_approve", { p_enrollment: id }); if (e1) toast(cleanErr(e1), true); else ok++; }
      if (quick.length) { const { error: e2 } = await sb.rpc("prospect_approve_quick", { p_ids: quick }); if (e2) toast(cleanErr(e2), true); else ok++; }
      toast(`Added ${ok} to the queue. They go out in the next send window.`);
      selected.clear(); await load(true);
    } finally { btn.disabled = false; }
  });

  // quick email: one message to the ticked orgs' main contacts (or everyone); drafts wait in the Outbox
  el("ogBulkMail").addEventListener("click", () => openQuickMail([...selected]));
  async function openQuickMail(ids) {
    if (!ids.length) return;
    modal(`
      <h2>Email ${ids.length} partner${ids.length === 1 ? "" : "s"}</h2>
      <div class="og-grid">
        <label>Send to</label><div class="og-qwho"><label><input type="radio" name="aca-ogQWho" value="main" checked /> Main contacts</label><label><input type="radio" name="aca-ogQWho" value="all" /> Everyone at the org</label></div>
        <label for="aca-ogQSubj">Subject</label><input type="text" id="aca-ogQSubj" placeholder="Spring picture day for {{league|your league}}" />
      </div>
      <p class="og-sub og-qcount" id="aca-ogQCount">Checking&hellip;</p>
      ${snippetPicker("ogQBody")}
      <textarea id="aca-ogQBody" class="og-edbody" placeholder="{{hi|Hi there}},&#10;&#10;&hellip;"></textarea>
      <p class="og-sub" style="white-space:normal;margin:4px 0 12px">Fill-ins: <code>{{hi|Hi there}}</code> (Hi + first name), <code>{{first_name}}</code>, <code>{{league|your league}}</code>, <code>{{town}}</code>, <code>{{sport}}</code>, <code>{{quote}}</code> (a matching testimonial). Text after <code>|</code> is used when it's blank. ${esc(SIG_NOTE)}</p>
      <p class="og-sub" style="white-space:normal;margin:0 0 12px"><strong>Send now</strong> sends one email per person right away. <strong>Add to queue</strong> sends them in the next send window. <strong>Save for review</strong> keeps them in the Outbox for your OK. Sending moves new and no-reply orgs to Prospecting (clients stay Clients).</p>
      <div id="aca-ogQErr" class="inline-error hidden" style="margin:0 0 12px"></div>
      <div class="og-actions"><button type="button" class="primary" data-v="now" disabled>Send now</button><button type="button" data-v="queue" disabled>Add to queue</button><button type="button" data-v="go" disabled>Save for review</button><button type="button" data-v="close">Cancel</button></div>`, true);
    const box = modal.last;
    fillSnippetPickers(box, byId.get(ids[0]));
    const whoVal = () => (box.querySelector('input[name="aca-ogQWho"]:checked') || {}).value || "main";
    const err = (m) => { el("ogQErr").textContent = m; el("ogQErr").classList.remove("hidden"); };
    let last = null;
    const check = async () => {
      const { data, error } = await sb.rpc("prospect_quick_draft", { p_orgs: ids, p_who: whoVal(), p_subject: "", p_body: "", p_dry: true });
      if (error) { el("ogQCount").textContent = ""; return err(cleanErr(error)); }
      last = data;
      const sk = data.skipped || [];
      const why = {}; sk.forEach((x) => { (why[x.why] = why[x.why] || []).push(x.name); });
      el("ogQCount").innerHTML = `<strong>${num(data.emails)} email${data.emails === 1 ? "" : "s"} to ${num(data.orgs)} partner${data.orgs === 1 ? "" : "s"}</strong>` +
        (sk.length ? ` &middot; ${sk.length} skipped <details class="og-qskip"><summary>why</summary>${Object.entries(why).map(([w, ns]) =>
          `<div><strong>${esc(w)} (${ns.length}):</strong> ${esc(ns.join(", "))}</div>`).join("")}</details>` : "");
      box.querySelectorAll('[data-v="go"], [data-v="queue"], [data-v="now"]').forEach((x) => { x.disabled = !data.emails; });
    };
    box.querySelectorAll('input[name="aca-ogQWho"]').forEach((r) => r.addEventListener("change", check));
    check();
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      if (b.dataset.v === "close") return box.close(false);
      const subj = el("ogQSubj").value.trim(), body = el("ogQBody").value.trim();
      if (!subj || !body) return err("Add a subject and a message.");
      if (!last || !last.emails) return err("Nobody to email in this selection.");
      const how = b.dataset.v;
      if (how === "now" && !confirm(`Send ${last.emails} email${last.emails === 1 ? "" : "s"} right now?`)) return;
      b.disabled = true;
      const { data, error } = await sb.rpc("prospect_quick_draft", { p_orgs: ids, p_who: whoVal(), p_subject: subj, p_body: body, p_dry: false });
      if (error) { b.disabled = false; return err(cleanErr(error)); }
      box.close(true);
      selected.clear();
      if (how === "go") toast(`${data.emails} draft${data.emails === 1 ? "" : "s"} waiting in the Outbox`);
      else {
        // the drafts exist now (held); approve them the same way the Outbox would
        try {
          const { data: rows, error: e2 } = await sb.from("prospect_scheduled_emails").select("id").eq("batch_id", data.batch).eq("status", "held");
          if (e2) throw e2;
          const qids = (rows || []).map((r) => r.id);
          if (how === "now") await sendNow(qids);
          else { const { error: e3 } = await sb.rpc("prospect_approve_quick", { p_ids: qids }); if (e3) throw e3; toast(QUEUED); }
        } catch (e2) { toast("The drafts are in the Outbox, but: " + cleanErr(e2), true); }
      }
      await load(true); loadReady(true); loadAttention();
    });
  }

  // add org
  el("ogAdd").addEventListener("click", () => {
    measureTop();
    const wrap = document.createElement("div");
    wrap.className = "og-modal-wrap";
    wrap.innerHTML = `<div class="og-modal" role="dialog" aria-modal="true" aria-labelledby="aca-ogAddTitle">
      <h2 id="aca-ogAddTitle">Add a partner</h2>
      <div class="field"><label for="aca-ogNewName">Name</label><input type="text" id="aca-ogNewName" autocomplete="off" /></div>
      <div class="field"><label for="aca-ogNewAud">Type</label><select id="aca-ogNewAud"><option value="league">League</option><option value="school">School</option></select></div>
      <div class="field"><label for="aca-ogNewSport">Sports (comma separated)</label><input type="text" id="aca-ogNewSport" list="aca-ogSports" autocomplete="off" /></div>
      <div class="field"><label for="aca-ogNewTown">Town</label><input type="text" id="aca-ogNewTown" autocomplete="off" /></div>
      <div class="field"><label for="aca-ogNewFirst">Main contact (optional)</label>
        <div class="og-grid2"><input type="text" id="aca-ogNewFirst" placeholder="First name" aria-label="Contact first name" autocomplete="off" />
        <input type="text" id="aca-ogNewLast" placeholder="Last name" aria-label="Contact last name" autocomplete="off" /></div>
        <input type="email" id="aca-ogNewEmail" placeholder="email@example.org" aria-label="Contact email" autocomplete="off" style="margin-top:6px" /></div>
      <div id="aca-ogNewErr" class="inline-error hidden" style="margin:0 0 12px"></div>
      <div class="og-actions"><button type="button" class="primary" data-v="1">Add and open</button><button type="button" data-v="0">Cancel</button></div></div>`;
    const close = () => { document.removeEventListener("keydown", onKey); wrap.remove(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    wrap.addEventListener("click", async (e) => {
      if (e.target === wrap) return close();
      const b = e.target.closest("button[data-v]"); if (!b) return;
      if (b.dataset.v === "0") return close();
      const name = el("ogNewName").value.trim();
      const err = (m) => { el("ogNewErr").textContent = m; el("ogNewErr").classList.remove("hidden"); };
      if (!name) return err("Give it a name.");
      const email = el("ogNewEmail").value.trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err("That email doesn't look right.");
      const dupe = orgs.find((o) => o.name.toLowerCase() === name.toLowerCase());
      if (dupe) { close(); toast("That partner is already here"); openOrg(dupe.id); return; }
      b.disabled = true;
      try {
        const id = await quickAdd({ name, audience: el("ogNewAud").value, town: el("ogNewTown").value.trim(),
          sports: el("ogNewSport").value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
          contact: { first_name: el("ogNewFirst").value.trim(), last_name: el("ogNewLast").value.trim(), email } });
        close();
        openOrg(id);
      } catch (e2) { b.disabled = false; err(cleanErr(e2)); }
    });
    document.addEventListener("keydown", onKey);
    document.querySelector(".aca").appendChild(wrap);
    Places.attach(el("ogNewTown"), { kind: "town" });
    el("ogNewName").focus();
  });

  // Adds a partner (and, when given, its main contact) and resolves to the new id; an existing partner with the
  // same name resolves to that one's id instead. Other pages (Bookings, Today) call it as Orgs.quickAdd (2026-10-24).
  async function quickAdd(opt) {
    opt = opt || {};
    const name = String(opt.name || "").trim();
    if (!name) throw new Error("Give the partner a name.");
    if (!loaded) await load();
    const dupe = orgs.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (dupe) return dupe.id;
    const { data, error } = await sb.from("prospect_orgs").insert({ name, audience: opt.audience === "school" ? "school" : "league",
      sports: opt.sports || [], town: (opt.town || "").trim() || null, source: opt.source || "Partners tab" }).select("id").single();
    if (error) throw error;
    const c = opt.contact || {};
    const email = String(c.email || "").trim();
    if (email) {
      const r = await sb.from("prospect_contacts").insert({ org_id: data.id, first_name: (c.first_name || "").trim() || null,
        last_name: (c.last_name || "").trim() || null, email, is_primary: true });
      if (r.error) toast("Partner added, but the contact was not: " + cleanErr(r.error), true);
    }
    await reloadOrg(data.id);
    return data.id;
  }

  // ---------------------------------------------------------------- side panel
  const panel = el("ogPanel");
  // The site's sticky header (and the WordPress admin bar when logged in) sit on top of the page, so the
  // panel starts below whatever is pinned to the top of the window. Re-measured on scroll/resize because
  // the header shrinks once you scroll.
  function measureTop() {
    // Bars can stack (admin bar, then the site header under it), so probe just below each one found.
    let top = 0;
    for (let pass = 0; pass < 4; pass++) {
      const y = top + 2, before = top;
      [0.25, 0.5, 0.75].forEach((fx) => {
        (document.elementsFromPoint(window.innerWidth * fx, y) || []).forEach((n) => {
          for (let x = n; x && x !== document.body && x !== document.documentElement; x = x.parentElement) {
            if (x.classList && x.classList.contains("aca")) break;
            const pos = getComputedStyle(x).position;
            if (pos === "fixed" || pos === "sticky") {
              const r = x.getBoundingClientRect();
              if (r.top <= y && r.bottom > y && r.bottom < window.innerHeight / 2) top = Math.max(top, r.bottom);
            }
          }
        });
      });
      if (top === before) break;
    }
    document.querySelector(".aca").style.setProperty("--og-top", Math.round(top) + "px");
  }
  let measureQueued = false;
  const queueMeasure = () => { if (measureQueued || (!openId && !document.querySelector(".aca .og-modal-wrap"))) return; measureQueued = true; requestAnimationFrame(() => { measureQueued = false; measureTop(); }); };
  window.addEventListener("scroll", queueMeasure, { passive: true });
  window.addEventListener("resize", queueMeasure);

  // A row (or a link, search, a new organization) opens the organization's own page (2026-10-23); the side panel
  // markup below now lives inside that page's Contacts & outreach tab (embed / unembed).
  function openOrg(id) {
    if (!id) return;
    location.hash = "#partners/org/" + id;
  }
  let inline = false, detailsOpen = false, linked = null;
  const panelHome = panel.parentNode;
  async function embed(id, box) {
    await load(false);
    if (!byId.has(id)) await reloadOrg(id);
    inline = true; detailsOpen = false; linked = null;
    openId = id;
    box.appendChild(panel);
    panel.classList.add("og-inline");
    panel.classList.remove("hidden");
    panel.innerHTML = '<div class="og-pbody"><div class="empty"><span class="spin"></span>Loading&hellip;</div></div>';
    await loadPanel(id);
  }
  function unembed() {
    if (!inline) return;
    inline = false; openId = null; panelData = null;
    panel.classList.remove("og-inline");
    panel.classList.add("hidden");
    panelHome.appendChild(panel);
  }
  function closePanel(keepHash) {
    openId = null; panelData = null;
    panel.classList.add("hidden");
    document.documentElement.classList.remove("aca-sheet-open"); document.body.classList.remove("aca-sheet-open");
    document.querySelectorAll(".aca tr.og-row.open").forEach((tr) => tr.classList.remove("open"));
    if (!keepHash) history.replaceState(null, "", "#partners/orgs");
  }
  function step(dir) {
    const i = visible.findIndex((o) => o.id === openId);
    const next = visible[i + dir];
    if (!next) return;
    if (visible.indexOf(next) >= shown) { shown += PAGE; render(); }
    openOrg(next.id);
  }
  async function loadPanel(id) {
    try {
      const [c, cs, a, f, p, m] = await Promise.all([
        sb.from("prospect_contacts").select("*").eq("org_id", id).order("is_primary", { ascending: false }).order("created_at"),
        sb.from("prospect_contact_status").select("*").eq("org_id", id),
        sb.from("prospect_activities").select("*").eq("org_id", id).order("occurred_at", { ascending: false }).limit(300),
        sb.from("prospect_followups").select("*").eq("org_id", id).order("due_on"),
        sb.from("prospect_pipeline").select("*").eq("org_id", id).order("started_at", { ascending: false }),
        sb.from("prospect_scheduled_emails").select("*").eq("org_id", id).order("send_at"),
      ]);
      const err = c.error || cs.error || a.error || f.error || p.error || m.error;
      if (err) throw err;
      if (openId !== id) return;
      panelData = { id, contacts: c.data || [], status: new Map((cs.data || []).map((s) => [s.contact_id, s])),
        acts: a.data || [], fus: f.data || [], enr: p.data || [], emails: m.data || [] };
      renderPanel();
      if (inline && !linked) loadLinked(id).then((l) => { if (openId === id && inline) { linked = l; renderPanel(); } }, () => {});
    } catch (e) {
      if (openId === id) panel.innerHTML = `<div class="og-pbody"><div class="inline-error" style="margin:16px 0">Could not load: ${esc(cleanErr(e))}</div><button type="button" class="small" data-act="close">Close</button></div>`;
    }
  }

  function renderPanel() {
    const o = byId.get(openId), d = panelData;
    if (!o || !d) return;
    const i = visible.findIndex((x) => x.id === o.id);
    const cById = new Map(d.contacts.map((c) => [c.id, c]));
    // On the partner page (inline) the name is the page heading, so the panel drops its own name field and arrows;
    // Contacts come first and the details sit behind "Edit details"; the timeline lives on Notes & history there (2026-10-24).
    const top = `
        <div class="og-ptop">
          <input class="og-title" data-f="name" value="${esc(o.name)}" aria-label="Partner name" />
          <div class="og-pnav">
            <button type="button" class="small" data-act="prev" ${i <= 0 ? "disabled" : ""} title="Previous (up arrow)" aria-label="Previous">&#9650;</button>
            <button type="button" class="small" data-act="next" ${i < 0 || i >= visible.length - 1 ? "disabled" : ""} title="Next (down arrow)" aria-label="Next">&#9660;</button>
            <button type="button" class="small" data-act="history" title="Who changed what">History</button>
            <button type="button" class="small" data-act="close" title="Close (Esc)" aria-label="Close">&#10005;</button>
          </div>
        </div>`;
    const sec = { details: `
        <div class="og-sec og-details${inline && !detailsOpen ? " hidden" : ""}" id="aca-ogDetails">
          <h3>Details${inline ? ' <button type="button" class="small" data-act="details">Done</button>' : ""}</h3>
          <div class="og-grid">
            ${inline ? '<label>Name</label><input type="text" data-f="name" value="' + esc(o.name) + '" aria-label="Partner name" />' : ""}
            <label>Type</label><select data-f="audience"><option value="league" ${o.audience === "league" ? "selected" : ""}>League</option><option value="school" ${o.audience === "school" ? "selected" : ""}>School</option></select>
            ${o.audience === "school" ? `<label>School photos</label><div class="og-sp">
              <span class="muted">${esc(o.sp_status ? SP_NAME[o.sp_status] : "Not offered")} <span class="og-sub">(set it at the top)</span></span>
              ${o.sp_status === "competitor" ? `<input type="text" data-f="sp_competitor" value="${esc(o.sp_competitor || "")}" placeholder="Who (e.g. Lifetouch)" aria-label="Other photographer" />
                <label class="og-sub" style="display:flex;gap:6px;align-items:center;white-space:nowrap">until <input type="date" data-f="sp_until" value="${esc(o.sp_until || "")}" aria-label="Contract ends" /></label>` : ""}
              <input type="text" data-f="sp_note" value="${esc(o.sp_note || "")}" placeholder="Note (optional)" aria-label="School photos note" style="grid-column:1/-1" /></div>` : ""}
            <label>Services</label><div class="og-seasons">${SERVICES.map((x) => `<label><input type="checkbox" data-service="${x[0]}" ${(o.services || []).includes(x[0]) ? "checked" : ""} /> ${x[1]}</label>`).join("")}</div>
            <label>Sports</label><input type="text" data-f="sports" list="aca-ogSports" value="${esc((o.sports || []).join(", "))}" placeholder="soccer, football" />
            <label>Seasons</label><div class="og-seasons">${SEASONS.map((s) => `<label><input type="checkbox" data-season="${s}" ${(o.seasons || []).includes(s) ? "checked" : ""} /> ${s}</label>`).join("")}
              <span class="muted" style="font-size:12px">${o.seasons_manual ? `Set by hand &middot; <button type="button" class="link" data-act="autoseason">use sport</button>` : "From the sport"}</span></div>
            <label>Town</label><input type="text" data-f="town" value="${esc(o.town || "")}" placeholder="e.g. Bangor (or Bangor/Brewer)" />
            <label>County</label><select data-f="county" aria-label="County"><option value="">Not set</option>${COUNTIES.map((c) => `<option value="${c}" ${o.county === c ? "selected" : ""}>${c}</option>`).join("")}</select>
            <label>Website</label><input type="text" data-f="website" value="${esc(o.website || "")}" />
            <label>Notes</label><textarea data-f="notes" rows="3">${esc(o.notes || "")}</textarea>
            ${o.job_count || o.next_job_at || (o.shoot_months || []).length ? `<label>Client</label><span>${esc([
              o.job_count ? o.job_count + " GotPhoto job" + (o.job_count === 1 ? "" : "s") : "",
              o.client_since ? "since " + fmtDay(o.client_since) : "",
              o.last_job_at ? "last " + fmtDay(o.last_job_at) : "",
              o.next_job_at ? "next picture day " + fmtDay(o.next_job_at) : "",
              monthsText(o) ? "shoots in " + monthsText(o) : ""].filter(Boolean).join(" \u00b7 "))}${(o.gotphoto_names || []).length
              ? `<div class="og-sub" style="white-space:normal">GotPhoto names: ${esc(o.gotphoto_names.join(", "))}</div>` : ""}</span>` : ""}
            <label>Source</label><span class="muted">${esc([o.source, "added " + fmtDay(o.created_at)].filter(Boolean).join(" \u00b7 "))}</span>
          </div>
        </div>`, contacts: `
        <div class="og-sec">
          <h3>Contacts <span>${d.contacts.length}</span></h3>
          ${contactsHtml(d)}${inline ? linkedHtml() : ""}
        </div>`, emails: `
        <div class="og-sec">
          <h3>Emails</h3>
          ${emailsHtml(d, cById)}
        </div>`, fus: `
        <div class="og-sec" id="aca-ogFuSec">
          <h3>Follow-ups</h3>
          ${followupsHtml(d)}
        </div>`, tl: `
        <div class="og-sec">
          <h3>Timeline <span class="og-tlf chips">${[["all", "All"], ["email", "Emails"], ["reply", "Replies"], ["note", "Notes"]].map((f) =>
            `<button type="button" data-tlf="${f[0]}" aria-pressed="${tlFilter === f[0]}">${f[1]}</button>`).join("")}</span></h3>
          <div class="og-note"><textarea id="aca-ogNoteText" placeholder="Add a note&hellip;"></textarea><button type="button" class="small" data-act="savenote">Save</button></div>
          ${timelineHtml(d, cById)}
        </div>` };
    const order = inline ? ["contacts", "details", "fus", "emails"] : ["details", "contacts", "emails", "fus", "tl"];
    const fm = focusMark(panel);
    panel.innerHTML = `
      <div class="og-phead">
        ${inline ? "" : top}
        <div class="og-pmeta">
          <select data-f="stage" aria-label="Stage">${STAGES.map((s) => `<option value="${s[0]}" ${s[0] === o.stage ? "selected" : ""}>${s[1]}</option>`).join("")}</select>
          ${o.needs_new_contact ? '<span class="pill err">Needs a new contact</span>' : ""}
          ${o.next_action ? `<span class="muted">Next: <strong>${esc(o.next_action_at ? fmtDay(o.next_action_at) : "")}</strong> ${esc(o.next_action)}</span>` : ""}
        </div>
        ${svcStatusHtml(o)}
        <div class="og-actions">
          <button type="button" class="small primary" data-act="enroll">Enroll</button>
          <button type="button" class="small" data-act="email">Email someone</button>
          <button type="button" class="small" data-act="note">Add note</button>
          <button type="button" class="small" data-act="fu">Follow-up</button>
          <button type="button" class="small" data-act="addc">Add contact</button>
          ${inline ? `<button type="button" class="small" data-act="details" aria-expanded="${detailsOpen}">Edit details</button>` : ""}
        </div>
      </div>
      <div class="og-pbody">
${order.map((k) => sec[k]).join("")}
      </div>`;
    focusBack(panel, fm);
    const town = panel.querySelector('input[data-f="town"]'); if (town) Places.attach(town, { kind: "town" });
  }

  // ---------------------------------------------------------------- one contacts list on the partner page (2026-10-24)
  // Four places hold people for a partner: these contacts, the contacts picked on each booking (booking emails),
  // the hub's send-day reminder list, and the coaches captured on a booking. The partner page shows them in one list
  // with labels; adding or removing writes to the place that owns it (no merge of the stores).
  async function loadLinked(id) {
    const o = byId.get(id), name = ((o && o.name) || "").toLowerCase();
    const out = { booking: new Map(), hub: [], coaches: [], bookings: [], hubAdd: [] };
    let bks = [];
    if (canSee("bookings")) {
      const { data } = await sb.rpc("admin_bookings", { p_from: "2000-01-01", p_to: null });
      bks = (data || []).filter((b) => b.org_id === id && b.status !== "cancelled");
    }
    const since = new Date(Date.now() - 120 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const live = bks.filter((b) => b.status === "booked" && String(b.picture_day || "") >= since)
      .sort((a, b) => String(a.picture_day || "").localeCompare(String(b.picture_day || "")));
    out.bookings = live.map((b) => ({ id: b.id, title: b.title_label || b.title || "Job" }));
    live.forEach((b) => (b.contacts || []).forEach((c) => { if (!out.booking.has(c.id)) out.booking.set(c.id, []); out.booking.get(c.id).push(b.title_label || b.title || "a job"); }));
    if (canSee("bookings") && live.length) {
      const det = await Promise.all(live.slice(0, 4).map((b) => sb.rpc("admin_booking_detail", { p_id: b.id }).then((r) => r.data, () => null)));
      det.forEach((d, i) => d && (d.coaches || []).forEach((c) => out.coaches.push({ id: c.id, email: c.email, name: c.name || "", job: out.bookings[i].title, booking: live[i].id })));
    }
    if (canSee("hub")) {
      const { data } = await sb.rpc("admin_hub_activity");
      const keys = new Set();
      bks.forEach((b) => { if (b.gotphoto_job_id) keys.add("sports:" + b.gotphoto_job_id); if (b.hub_school_id) keys.add("school:" + b.hub_school_id); });
      const booked = new Set(); live.forEach((b) => { if (b.gotphoto_job_id) booked.add("sports:" + b.gotphoto_job_id); if (b.hub_school_id) booked.add("school:" + b.hub_school_id); });
      (data || []).filter((x) => keys.has(x.hub + ":" + x.org_id) || (x.org || "").toLowerCase() === name).forEach((x) => {
        // Rows with a booking send reminders through the booking's emails, so their old hub signups get nothing
        // and aren't listed (2026-10-23); hand-added ones are for older hub rows.
        if (booked.has(x.hub + ":" + x.org_id)) return;
        out.hubAdd.push({ hub: x.hub, org_id: x.org_id, org: x.org });
        (x.watchers || []).forEach((w) => out.hub.push({ id: w.id, hub: x.hub, email: w.email, name: w.name || "", org: x.org }));
      });
    }
    return out;
  }
  function contactLabels(c) {
    if (!linked) return "";
    const L = [];
    if (linked.booking.has(c.id)) L.push(`<span class="pill ok og-lbl" title="${esc("Picked on " + linked.booking.get(c.id).join(", "))}">gets booking emails</span>`);
    if (linked.hub.some((w) => (w.email || "").toLowerCase() === (c.email || "").toLowerCase())) L.push('<span class="pill accent og-lbl">gets hub reminders</span>');
    if (linked.coaches.some((w) => (w.email || "").toLowerCase() === (c.email || "").toLowerCase())) L.push('<span class="pill muted og-lbl">coach</span>');
    return L.length ? " " + L.join(" ") : "";
  }
  function linkedHtml() {
    if (!linked) return '<p class="og-sub" style="white-space:normal;margin:8px 0 0">Checking booking emails, hub reminders and coaches&hellip;</p>';
    const known = new Set(panelData.contacts.map((c) => (c.email || "").toLowerCase()));
    const ed = canEdit("hub"), edB = canEdit("bookings");
    const rows = [];
    linked.hub.filter((w) => !known.has((w.email || "").toLowerCase())).forEach((w) => rows.push(`<tr><td colspan="2"><div><strong>${esc(w.name || w.email)}</strong> <span class="pill accent og-lbl">gets hub reminders</span></div>
      <div class="og-sub">${esc(w.email)}${w.org ? " &middot; " + esc(w.org) : ""}</div></td><td></td>
      <td>${ed ? `<button type="button" class="small" data-act="lrmhub" data-hub="${esc(w.hub)}" data-wid="${esc(w.id)}" data-email="${esc(w.email)}" title="Stop reminders for ${esc(w.email)}">Remove</button>` : ""}</td></tr>`));
    const seenCoach = new Set();
    linked.coaches.forEach((c) => {
      const k = (c.email || "").toLowerCase() + "|" + c.booking; if (seenCoach.has(k)) return; seenCoach.add(k);
      rows.push(`<tr><td colspan="2"><div><strong>${esc(c.name || c.email)}</strong> <span class="pill muted og-lbl">coach</span></div>
        <div class="og-sub">${esc(c.email)} &middot; ${esc(c.job)}</div></td><td></td>
        <td>${edB ? `<button type="button" class="small" data-act="lrmcoach" data-coach="${esc(c.id)}" data-email="${esc(c.email)}" title="Stop coach emails for ${esc(c.email)}">Remove</button>` : ""}</td></tr>`);
    });
    const adds = [];
    if (edB && linked.bookings.length) adds.push(`<button type="button" class="link" data-act="laddcoach">+ Add coach emails</button>`);
    if (ed && linked.hubAdd.length) adds.push(`<button type="button" class="link" data-act="laddhub">+ Add a hub reminder contact</button>`);
    if (!rows.length && !adds.length) return "";
    return `<div class="og-linked"><div class="og-sub" style="white-space:normal;margin:12px 0 4px">Also getting emails for ${esc((byId.get(openId) || {}).name || "this partner")}: hub reminder contacts and coaches from their jobs.</div>
      ${rows.length ? `<table class="og-ctab"><tbody>${rows.join("")}</tbody></table>` : ""}
      <div class="og-actions" style="margin-top:6px">${adds.join(" ")}</div>
      <div class="og-ladd hidden" id="aca-ogLAdd"></div></div>`;
  }
  async function linkedClick(b) {
    const act = b.dataset.act, box = el("ogLAdd");
    const again = async () => { linked = await loadLinked(openId).catch(() => linked); renderPanel(); };
    if (act === "lrmhub") {
      if (!confirm("Stop hub reminder emails for " + b.dataset.email + "?")) return;
      b.disabled = true;
      const { data, error } = await sb.rpc("admin_hub_watcher_remove", { p_hub: b.dataset.hub, p_id: b.dataset.wid });
      if (error || !(data && data.ok)) { b.disabled = false; toast("Could not remove: " + (error ? cleanErr(error) : (data && data.error) || "not found"), true); return; }
      toast(b.dataset.email + " will not get reminders."); return again();
    }
    if (act === "lrmcoach") {
      if (!confirm("Stop coach emails for " + b.dataset.email + "?")) return;
      b.disabled = true;
      const { data, error } = await sb.rpc("booking_coach_remove", { p_id: b.dataset.coach });
      if (error || (data && data.ok === false)) { b.disabled = false; toast(error ? cleanErr(error) : data.error, true); return; }
      toast("Removed. Paste them on the job to add them back."); return again();
    }
    if (act === "laddcoach") {
      box.classList.remove("hidden");
      box.innerHTML = `<div class="og-cgrid">${linked.bookings.length > 1 ? `<label class="wide"><span>Job</span><select id="aca-ogLJob">${linked.bookings.map((x) => `<option value="${esc(x.id)}">${esc(x.title)}</option>`).join("")}</select></label>` : ""}
        <label class="wide"><span>Coach emails (paste any text with addresses in it)</span><textarea id="aca-ogLText" rows="2"></textarea></label>
        <div class="og-cgrid-foot"><button type="button" class="link" data-act="lcancel">Cancel</button><button type="button" class="small primary" data-act="lsavecoach">Add coaches</button></div></div>`;
      el("ogLText").focus(); return;
    }
    if (act === "laddhub") {
      box.classList.remove("hidden");
      box.innerHTML = `<div class="og-cgrid">${linked.hubAdd.length > 1 ? `<label class="wide"><span>Hub</span><select id="aca-ogLHub">${linked.hubAdd.map((x, i) => `<option value="${i}">${esc(x.org)} (${x.hub === "school" ? "school hub" : "sports hub"})</option>`).join("")}</select></label>` : ""}
        <label><span>Name</span><input id="aca-ogLName" /></label><label><span>Email</span><input id="aca-ogLEmail" placeholder="email@example.org" /></label>
        <div class="og-cgrid-foot"><button type="button" class="link" data-act="lcancel">Cancel</button><button type="button" class="small primary" data-act="lsavehub">Add contact</button></div></div>`;
      el("ogLEmail").focus(); return;
    }
    if (act === "lcancel") { box.classList.add("hidden"); box.innerHTML = ""; return; }
    if (act === "lsavecoach") {
      const text = el("ogLText").value.trim(); if (!text) return toast("Paste at least one email first.", true);
      const booking = el("ogLJob") ? el("ogLJob").value : linked.bookings[0].id;
      b.disabled = true;
      const { data, error } = await sb.rpc("booking_coaches_add", { p_booking: booking, p_text: text, p_source: "manual" });
      b.disabled = false;
      if (error) return toast(cleanErr(error), true);
      toast(data && data.added ? "Added " + data.added + " coach email" + (data.added === 1 ? "" : "s") + "." : "Nothing new. Our own addresses, no-reply senders and this partner's contacts are left out.", !(data && data.added));
      return again();
    }
    if (act === "lsavehub") {
      const email = el("ogLEmail").value.trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Add a valid email", true);
      const t = linked.hubAdd[el("ogLHub") ? Number(el("ogLHub").value) : 0];
      b.disabled = true;
      const { data, error } = await sb.rpc("admin_hub_watcher_add", { p_hub: t.hub, p_org_id: t.org_id, p_email: email, p_name: el("ogLName").value.trim() || null });
      b.disabled = false;
      if (error || !(data && data.ok)) return toast("Could not add: " + (error ? cleanErr(error) : (data && data.error) || "unknown error"), true);
      toast(email + " will get the reminder emails."); return again();
    }
  }
  // Header: one status per service the partner uses or is pitched for, plus "+ Service" for the rest.
  function svcStatusHtml(o) {
    const on = svcList(o), off = SERVICES.filter((x) => !on.includes(x[0]));
    return `<div class="og-svcs">${on.map((k) => `<label class="og-svc pill ${SVC_CLS[o.service_status[k]] || "muted"}" title="${esc(SERVICE_NAME[k])}: ${esc(SVC_ST_NAME[o.service_status[k]] || "")}">${esc(SERVICE_NAME[k])}
        <select data-svcst="${k}" aria-label="${esc(SERVICE_NAME[k])} status">${SVC_ST.map((x) => `<option value="${x[0]}" ${o.service_status[k] === x[0] ? "selected" : ""}>${x[1]}</option>`).join("")}<option value="">Not offered</option></select></label>`).join("")}
      ${off.length ? `<select class="og-svcadd" data-svcadd aria-label="Add a service"><option value="">+ Service</option>${off.map((x) => `<option value="${x[0]}">${x[1]}</option>`).join("")}</select>` : ""}</div>`;
  }
  // "★ School photos main", "pitch to" while the service is still a prospect, "copy in".
  function roleTagsHtml(o, c) {
    const t = svcList(o).filter((k) => roleOf(c, k)).map((k) => {
      const r = roleOf(c, k), st0 = o.service_status[k];
      const word = r === "main" ? (st0 === "client" || st0 === "past_client" ? "main" : "pitch to") : "copy in";
      return `<span class="pill ${r === "main" ? "accent" : "muted"} og-lbl">${r === "main" ? "&#9733; " : ""}${esc(SERVICE_NAME[k])} ${word}</span>`;
    });
    return t.length ? `<div class="og-roletags">${t.join(" ")}</div>` : "";
  }
  function roleSelectsHtml(o, c) {
    const on = svcList(o);
    if (!on.length) return "";
    return `<div class="og-roles">${on.map((k) => `<label><span>${esc(SERVICE_NAME[k])}</span><select data-role="${k}" aria-label="${esc(SERVICE_NAME[k])} for ${esc(who(c))}">${["main", "copy", ""].map((r) =>
      `<option value="${r}" ${roleOf(c, k) === r ? "selected" : ""}>${ROLE_NAME[r]}</option>`).join("")}</select></label>`).join("")}</div>`;
  }
  function contactsHtml(d) {
    const o = byId.get(openId) || {};
    const check = roleCheck.has(o.id) ? `<div class="og-rolecheck">${esc(o.name)} uses ${svcList(o).filter((k) => ["client", "past_client"].includes(o.service_status[k])).map((k) => SERVICE_NAME[k]).join(" and ")}, and one person is main for more than one. Set who's main for each below.
        <button type="button" class="small" data-act="rolesok">Looks right</button></div>` : "";
    const rows = d.contacts.map((c) => {
      const s = d.status.get(c.id) || {};
      const chip = CONTACT_CHIP[s.status] || ["", "muted"];
      let label = chip[0];
      if (s.status === "sent" && s.steps_total) label = `Sent ${s.steps_sent} of ${s.steps_total}`;
      if (s.status === "queued" && s.next_send_at) label = `Queued ${fmtDay(s.next_send_at)}`;
      const acts = [["", "&hellip;"], ["edit", "Edit details"], c.stopped_at ? ["resume", "Resume emails"] : ["stop", "Stop emails"],
        ["bounced", "Mark bounced"], ["unsubscribed", "Mark unsubscribed"],
        ...(c.bounced_at || c.unsubscribed_at || c.stopped_at ? [["clear_flags", "Clear flags"]] : []),
        ["remove", "Remove"]];
      const fullName = [c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)";
      return `<tr data-cid="${esc(c.id)}">
        <td class="og-cview" colspan="2"><div><strong>${esc(fullName)}</strong>${c.role ? ' <span class="muted">' + esc(c.role) + "</span>" : ""}${inline ? contactLabels(c) : ""}</div>
          <div class="og-sub">${esc(c.email)}${c.phone ? " \u00b7 " + esc(c.phone) : ""}</div>
          ${roleTagsHtml(o, c)}${roleSelectsHtml(o, c)}</td>

        <td style="white-space:nowrap"><span class="pill ${chip[1]}">${esc(label)}</span>${c.history_only ? '<div class="og-sub" title="From your earlier email history. Not emailed by sequences unless you list them when enrolling.">history</div>' : ""}</td>
        <td><select data-cact aria-label="Contact actions">${acts.map((a) => `<option value="${a[0]}">${a[1]}</option>`).join("")}</select></td></tr>
        <tr class="og-cedit" data-cid="${esc(c.id)}"><td colspan="4"><div class="og-cgrid">
          <label><span>First name</span><input data-cf="first_name" value="${esc(c.first_name || "")}" /></label>
          <label><span>Last name</span><input data-cf="last_name" value="${esc(c.last_name || "")}" /></label>
          <label class="wide"><span>Email</span><input data-cf="email" value="${esc(c.email)}" /></label>
          <label><span>Role</span><input data-cf="role" value="${esc(c.role || "")}" placeholder="President, coach, office&hellip;" /></label>
          <label><span>Phone</span><input data-cf="phone" value="${esc(c.phone || "")}" /></label>
          <div class="og-cgrid-foot"><span class="muted">Each field saves when you leave it.</span><button type="button" class="small" data-act="cdone">Done</button></div>
        </div></td></tr>`;
    }).join("");
    return check + `<table class="og-ctab"><tbody>${rows || '<tr><td class="muted" colspan="4">No contacts yet.</td></tr>'}
      <tr class="og-caddlink" id="aca-ogCAddLink"><td colspan="4"><button type="button" class="link" data-act="addc">+ Add a contact</button></td></tr>
      <tr class="og-cedit og-cadd" id="aca-ogCAdd"><td colspan="4"><div class="og-cgrid">
        <label><span>First name</span><input id="aca-ogCFirst" /></label>
        <label><span>Last name</span><input id="aca-ogCLast" /></label>
        <label class="wide"><span>Email</span><input id="aca-ogCEmail" placeholder="email@example.org" /></label>
        <label><span>Role</span><input id="aca-ogCRole" placeholder="President, coach, office&hellip;" /></label>
        <label><span>Phone</span><input id="aca-ogCPhone" /></label>
        <div class="og-cgrid-foot"><button type="button" class="link" data-act="addc_cancel">Cancel</button><button type="button" class="small primary" data-act="savec">Add contact</button></div>
      </div></td></tr></tbody></table>`;
  }
  // ---------------------------------------------------------------- emails (stage 3: prospect_scheduled_emails)
  const PENDING = ["held", "scheduled", "sending", "failed"];
  function emailLabel(x, cById) {
    const c = cById.get(x.contact_id);
    return `${x.step_no ? "Email " + x.step_no : "One-off email"} to ${esc(c ? who(c) : "")}`;
  }
  function emailChip(x) {
    if (x.status === "held") return x.needs_review ? '<span class="pill warn">Waiting for your review</span>' : '<span class="pill muted">After review</span>';
    if (x.status === "sending") return '<span class="pill accent">Sending now</span>';
    if (x.status === "scheduled") return `<span class="pill accent">${esc(fmtWhen(x.send_at))}</span>${x.error ? ' <span class="pill err" title="' + esc(x.error) + '">Retrying</span>' : ""}`;
    if (x.status === "sent") return `<span class="pill ok">Sent ${esc(fmtDay(x.sent_at))}</span>${x.test_mode ? ' <span class="pill muted">test</span>' : ""}`;
    return `<span class="pill muted">${esc(x.status[0].toUpperCase() + x.status.slice(1))}</span>`;
  }
  function emailsHtml(d, cById) {
    const pending = d.emails.filter((x) => PENDING.includes(x.status)).sort((a, b) => (a.send_at || "") < (b.send_at || "") ? -1 : 1);
    const sent = d.emails.filter((x) => x.status === "sent").sort((a, b) => a.sent_at < b.sent_at ? 1 : -1);
    const other = d.emails.filter((x) => x.status === "skipped" || x.status === "stopped");
    const enr = d.enr.filter((e) => e.enrollment_status === "active" || e.enrollment_status === "paused");
    let h = enr.map((e) => {
      const held = e.enrollment_status === "paused" && e.end_reason === "held for review";
      return `<div class="og-enr"><div><strong>${esc(e.sequence_name)}</strong> ${held ? '<span class="pill warn">Waiting for your review</span>' : e.enrollment_status === "active" ? '<span class="pill accent">Sending</span>' : '<span class="pill muted">Paused</span>'}</div>
        <div class="og-actions">${held ? `<button type="button" class="small primary" data-sendnow="${esc(e.enrollment_id)}">Send now</button><button type="button" class="small" data-approve="${esc(e.enrollment_id)}">Add to queue</button>` : ""}
          ${e.enrollment_status === "active" ? `<button type="button" class="small" data-enr="${esc(e.enrollment_id)}" data-do="pause">Pause</button>` : ""}
          ${e.enrollment_status === "paused" && !held ? `<button type="button" class="small" data-enr="${esc(e.enrollment_id)}" data-do="resume">Resume</button>` : ""}
          <button type="button" class="small" data-enr="${esc(e.enrollment_id)}" data-do="stop">Stop</button></div></div>`;
    }).join("");
    h += pending.length ? pending.map((x) => `<div class="og-em" data-eid="${esc(x.id)}">
        <div class="og-emh"><span>${emailLabel(x, cById)}</span>${emailChip(x)}</div>
        <div class="og-sub" title="${esc(x.subject || "")}">${x.step_no > 1 ? "Re: " : ""}${esc(x.subject || "")}${x.edited ? " &middot; edited" : ""}</div>
        <div class="og-emb">${esc((x.body || "").slice(0, 160))}${(x.body || "").length > 160 ? "&hellip;" : ""}</div>
        <div class="og-actions">${x.status === "scheduled" || x.status === "failed" ? `<button type="button" class="small" data-esend="${esc(x.id)}">Send now</button>` : ""}<button type="button" class="small" data-eedit="${esc(x.id)}">Edit</button>
          <button type="button" class="small" data-eskip="${esc(x.id)}">Skip</button></div></div>`).join("")
      : (enr.length ? "" : '<p class="muted" style="margin:0 0 8px;font-size:13px">Nothing scheduled. Use <strong>Enroll</strong> or <strong>Email someone</strong> above.</p>');
    if (sent.length) {
      h += `<details class="og-sent"><summary>Sent (${sent.length})</summary>${sent.map((x) => `<div class="og-em sent">
          <div class="og-emh"><span>${emailLabel(x, cById)}</span>${emailChip(x)}</div>
          <div class="og-sub">${esc(x.subject || "")}${x.open_count ? ` &middot; <strong>opened${x.open_count > 1 ? " &times;" + num(x.open_count) : ""}</strong>` : ""}
            ${x.gmail_thread_id ? ` &middot; <a href="${esc(gmailLink(x.gmail_thread_id, false))}" target="_blank" rel="noopener">Gmail</a>` : ""}</div>
          <div class="og-actions"><button type="button" class="link" data-eview="${esc(x.id)}">View</button></div></div>`).join("")}</details>`;
    }
    if (other.length) h += `<p class="muted" style="margin:6px 0 0;font-size:12px">${other.length} skipped or stopped email${other.length === 1 ? "" : "s"} not shown.</p>`;
    return h;
  }

  // ---------------------------------------------------------------- modal helper
  function modal(html, wide) {
    measureTop();
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "og-modal-wrap";
      wrap.innerHTML = `<div class="og-modal${wide ? " wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
      const box = wrap.firstElementChild;
      const close = (v) => { document.removeEventListener("keydown", onKey); wrap.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === "Escape") close(null); };
      wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(null); });
      document.addEventListener("keydown", onKey);
      document.querySelector(".aca").appendChild(wrap);
      resolve.box = box;
      box.close = close;
      setTimeout(() => { const f = box.querySelector("[autofocus], textarea, input, select"); if (f) f.focus(); }, 0);
      modal.last = box;
    });
  }
  const toLocalInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  // "Insert a quote or snippet" menu above an email body; the org's sport comes first. Filled after the
  // dialog opens (snippets load async), inserted at the cursor.
  let snippetsCache = null;
  function snippetPicker(target) {
    return `<div class="og-snip"><select data-snip-for="${target}" aria-label="Insert a quote or snippet"><option value="">Insert a quote or snippet&hellip;</option></select></div>`;
  }
  async function fillSnippetPickers(box, org) {
    const sels = box.querySelectorAll("select[data-snip-for]");
    if (!sels.length) return;
    { // always fresh: Library edits should show up right away
      const { data } = await sb.from("prospect_snippets").select("id,kind,title,body,sports,audience,is_active").eq("is_active", true).order("title");
      snippetsCache = data || [];
    }
    const sp = (org && org.sports) || [];
    const list = snippetsCache.filter((s) => !s.audience || !org || s.audience === org.audience)
      .map((s) => [s, (s.sports || []).filter((x) => sp.includes(x)).length]).sort((a, b) => b[1] - a[1]);
    sels.forEach((sel) => {
      sel.innerHTML = '<option value="">Insert a quote or snippet&hellip;</option>' + list.map(([s, m]) =>
        `<option value="${esc(s.id)}">${m ? "\u2605 " : ""}${esc(s.title)} (${esc(s.kind)}${(s.sports || []).length ? ", " + esc(s.sports.join("/")) : ""})</option>`).join("");
      sel.addEventListener("change", () => {
        const s = snippetsCache.find((x) => x.id === sel.value); sel.value = "";
        if (!s) return;
        const ta = el(sel.dataset.snipFor);
        const a = ta.selectionStart ?? ta.value.length, b2 = ta.selectionEnd ?? a;
        const before = ta.value.slice(0, a), after = ta.value.slice(b2);
        const pad = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
        ta.value = before + pad + s.body + (after && !after.startsWith("\n") ? "\n\n" : "") + after;
        ta.focus();
      });
    });
  }
  const SIG_NOTE = "Your signature and the not-interested line are added at the bottom automatically.";
  // Send now or Add to queue (2026-10-23): wherever an outreach email is approved, both choices. Add to queue is the
  // old approve (it waits for the next send window); Send now sends these emails right away, at any hour.
  async function sendNow(ids) {
    const { data, error } = await sb.rpc("prospect_send_now", { p_ids: ids });
    if (error) throw error;
    if (data && data.ok === false) throw new Error(data.error || "Could not send.");
    toast(data.paused ? "Approved, but sending is switched off in Settings > Sending, so it waits until you turn it back on."
      : (data.sending > 1 ? `Sending ${data.sending} emails now.` : "Sending now.") + (data.test_mode ? " Test mode is on, so it goes to the test address." : ""));
    return data;
  }
  const QUEUED = "Added to the queue. It goes out in the next send window.";

  // Edit one email. Resolves true when something changed.
  async function openEditor(x, contact, orgName, onDone) {
    const sent = x.status === "sent";
    const threaded = !!x.step_no && x.step_no > 1;
    const p = modal(`
      <h2>${sent ? "Sent email" : "Edit email"} <span class="muted" style="font-weight:400;font-size:13px">${esc(orgName)}</span></h2>
      <div class="og-grid">
        <label>To</label><span>${esc(contact ? who(contact) + (contact.role ? ", " + contact.role : "") + " <" + contact.email + ">" : "")}</span>
        <label for="aca-ogEdSubj">Subject</label><input type="text" id="aca-ogEdSubj" value="${esc((threaded ? "Re: " : "") + (x.subject || ""))}" ${sent || threaded ? "disabled" : ""} />
        ${threaded && !sent ? '<span></span><span class="og-sub" style="white-space:normal">Follow-ups reply in the same Gmail thread, so they keep the first email&#39;s subject.</span>' : ""}
        <label for="aca-ogEdWhen">${sent ? "Sent" : "Send"}</label><input type="datetime-local" id="aca-ogEdWhen" value="${esc(toLocalInput(sent ? x.sent_at : x.send_at))}" ${sent ? "disabled" : ""} />
      </div>
      ${x.status === "held" ? '<p class="og-sub" style="white-space:normal;margin:8px 0 0">This email is waiting for your review. <strong>Save</strong> keeps it waiting; <strong>Add to queue</strong> sends it in the next send window; <strong>Send now</strong> sends it right away. The rest of a sequence follows on its own.</p>' : ""}
      ${sent ? "" : snippetPicker("ogEdBody")}
      <textarea id="aca-ogEdBody" class="og-edbody" ${sent ? "readonly" : ""}>${esc(x.body || "")}</textarea>
      <p class="og-sub" style="white-space:normal;margin:4px 0 12px">${esc(SIG_NOTE)}</p>
      <div id="aca-ogEdErr" class="inline-error hidden" style="margin:0 0 12px"></div>
      <div class="og-actions">
        ${sent ? '<button type="button" data-v="close">Close</button>' : `
        <button type="button" class="primary" data-v="sendnow">Send now</button>
        ${x.status === "held" ? '<button type="button" data-v="approve">Add to queue</button>' : ""}
        <button type="button" data-v="save">Save</button>
        <button type="button" data-v="skip">Skip this email</button>
        <button type="button" data-v="close">Cancel</button>`}
      </div>`, true);
    const box = modal.last;
    fillSnippetPickers(box, byId.get(x.org_id));
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      const v = b.dataset.v;
      if (v === "close") return box.close(false);
      const err = (m) => { el("ogEdErr").textContent = m; el("ogEdErr").classList.remove("hidden"); };
      b.disabled = true;
      try {
        if (v === "skip") {
          if (!confirm("Skip this email? The rest of the sequence carries on without it.")) { b.disabled = false; return; }
          const { error } = await sb.from("prospect_scheduled_emails").update({ status: "skipped" }).eq("id", x.id);
          if (error) throw error;
          toast("Skipped"); box.close(true); if (onDone) onDone(); return;
        }
        const body = el("ogEdBody").value.replace(/\s+$/, "");
        if (!body.trim()) { b.disabled = false; return err("The email can't be empty."); }
        const patch = { body };
        if (body !== x.body) patch.edited = true;
        if (!threaded) {
          const subj = el("ogEdSubj").value.trim();
          if (!subj) { b.disabled = false; return err("Add a subject."); }
          if (subj !== x.subject) { patch.subject = subj; patch.edited = true; }
        }
        const when = el("ogEdWhen").value;
        if (when && when !== toLocalInput(x.send_at)) {
          const d = new Date(when);
          if (isNaN(d)) { b.disabled = false; return err("That date doesn't look right."); }
          patch.send_at = d.toISOString(); patch.date_manual = true;
        }
        const { error } = await sb.from("prospect_scheduled_emails").update(patch).eq("id", x.id);
        if (error) throw error;
        if (v === "sendnow") await sendNow([x.id]);
        else if (v === "approve") {
          const { error: e2 } = x.enrollment_id ? await sb.rpc("prospect_approve", { p_enrollment: x.enrollment_id })
            : await sb.rpc("prospect_approve_quick", { p_ids: [x.id] });
          if (e2) throw e2;
          toast(QUEUED);
        } else toast("Saved");
        box.close(true); if (onDone) onDone();
      } catch (e2) { b.disabled = false; err(cleanErr(e2)); }
    });
    return p;
  }

  // Enroll this org in a sequence. Email 1 always waits in the Outbox for your OK.
  async function openEnroll(o) {
    const { data: ranked, error: rErr } = await sb.rpc("prospect_sequence_rank", { p_org: o.id });
    if (rErr) { toast(cleanErr(rErr), true); return; }
    const seqs = ranked || [];
    const mailable = panelData.contacts.filter((c) => !c.bounced_at && !c.unsubscribed_at && !c.stopped_at);
    if (!seqs.length) { toast(`No turned-on ${o.audience} sequence right now. Add or turn one on in Library.`, true); return; }
    if (!mailable.length) { toast("Add a contact with a working email first.", true); return; }
    const anyFresh = mailable.some((c) => !c.history_only);
    const anyMain = mailable.some((c) => c.is_primary);
    // Outreach goes to the sequence's service: its main and copy-ins. Not involved stays unticked (2026-10-24).
    const svc = seqSvc(o), roled = panelData.contacts.some((c) => Object.keys(c.service_roles || {}).length);
    const svcSet = mailable.some((c) => roleOf(c, svc));
    const ticked = (c) => roled ? ["main", "copy"].includes(roleOf(c, svc)) : anyMain ? !!c.is_primary : (!c.history_only || !anyFresh && c === mailable[0]);
    const roleNote = (c) => roleOf(c, svc) === "main" ? ` &middot; ${esc(SERVICE_NAME[svc])} main` : roleOf(c, svc) === "copy" ? " &middot; copy in" : roled ? ` &middot; not on ${esc(SERVICE_NAME[svc])}` : c.is_primary ? " &middot; main" : "";
    modal(`
      <h2>Enroll ${esc(o.name)}</h2>
      <div class="field"><label for="aca-ogEnSeq">Sequence</label><select id="aca-ogEnSeq">${seqs.map((q, i) => `<option value="${esc(q.key)}">${esc(q.name)}${q.reason ? " (" + esc(q.reason) + ")" : ""}${i === 0 && seqs.length > 1 ? " \u2605 best match" : ""}</option>`).join("")}</select>
        <span class="og-sub" style="white-space:normal">Sorted for ${esc((o.sports || []).join(", ") || "this org")}: same sport first, then same season, then general.</span></div>
      <div class="field"><label>Who gets it</label><div class="og-enc">${mailable.map((c) => `<label><input type="checkbox" value="${esc(c.id)}" ${ticked(c) ? "checked" : ""} />
        ${esc(who(c))}${c.role ? ` <span class="og-role">${esc(c.role)}</span>` : ""} <span class="muted">${esc(c.email)}${roleNote(c)}${c.history_only ? " &middot; from earlier emails" : ""}</span></label>`).join("")}</div>
        <span class="og-sub" style="white-space:normal">${roled && !svcSet ? `Nobody is set for ${esc(SERVICE_NAME[svc])} here yet. Tick who we should pitch; the first one becomes the ${esc(SERVICE_NAME[svc])} main. ` : ""}Everyone ticked gets each email in the same send window, addressed to them. A reply from anyone stops them all.</span></div>
      <div class="field"><label for="aca-ogEnLine">Custom opening line (optional)</label><textarea id="aca-ogEnLine" rows="2" placeholder="Leave blank for the sequence's default opener">${esc(o.personal_line || "")}</textarea></div>
      <p class="og-sub" style="white-space:normal;margin:0 0 12px">Nothing sends yet: email 1 waits in the <strong>Outbox</strong> so you can read and edit it first.</p>
      <div id="aca-ogEnErr" class="inline-error hidden" style="margin:0 0 12px"></div>
      <div class="og-actions"><button type="button" class="primary" data-v="go">Create emails</button><button type="button" data-v="close">Cancel</button></div>`);
    const box = modal.last;
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      if (b.dataset.v === "close") return box.close(false);
      const ids = [...box.querySelectorAll(".og-enc input:checked")].map((i) => i.value);
      const err = (m) => { el("ogEnErr").textContent = m; el("ogEnErr").classList.remove("hidden"); };
      if (!ids.length) return err("Tick at least one person.");
      b.disabled = true;
      try {
        const emails = mailable.filter((c) => ids.includes(c.id)).map((c) => c.email);
        const prior = await Prior.priorContact(o.name_known === false ? null : o.name, emails);
        // the org's own history matches itself; that is still worth seeing before a new series
        if (prior.matches.length && !(await Prior.confirmPrior(o.name, prior))) { b.disabled = false; return; }
        const { data, error } = await sb.rpc("prospect_enroll_org", { p_org: o.id, p_contacts: ids, p_sequence_key: el("ogEnSeq").value,
          p_personal_line: el("ogEnLine").value.trim() || null });
        if (error) throw error;
        // nobody was on the service: the people we pitch become its main (the first) and copy-ins
        if (!mailable.some((c) => roleOf(c, svc) === "main")) {
          for (const [i, id] of ids.entries()) {
            const c = mailable.find((x) => x.id === id); if (!c || roleOf(c, svc)) continue;
            await sb.from("prospect_contacts").update({ service_roles: { ...(c.service_roles || {}), [svc]: i === 0 ? "main" : "copy" } }).eq("id", id);
          }
        }
        box.close(true);
        toast(`${data.emails} emails created. Email 1 is waiting in the Outbox.`);
        await reloadOrg(o.id); await loadPanel(o.id); loadReady(true);
      } catch (e2) { b.disabled = false; err(cleanErr(e2)); }
    });
  }

  // One email to one person, outside any sequence. Sends on schedule (no review step).
  function openOneOff(o) {
    const mailable = panelData.contacts.filter((c) => !c.bounced_at && !c.unsubscribed_at);
    if (!mailable.length) { toast("Add a contact with a working email first.", true); return; }
    const d = new Date(Date.now() + 3600e3); d.setMinutes(0, 0, 0);
    // "About" a service: its main is ticked (2026-10-24). A partner nobody has sorted yet keeps the Main stars.
    const svcs = svcList(o), roled = panelData.contacts.some((c) => Object.keys(c.service_roles || {}).length);
    const toList = (svc) => mailable.map((c, i) => {
      const r = roleOf(c, svc), on = roled && svc ? r === "main" : (mailable.some((x) => x.is_primary) ? c.is_primary : i === 0);
      const note = roled && svc ? (r === "main" ? " &middot; main" : r === "copy" ? " &middot; copy in" : " &middot; not on this service") : c.is_primary ? " &middot; main" : "";
      return `<label><input type="checkbox" value="${esc(c.id)}" ${on ? "checked" : ""} />
          ${esc(who(c))}${c.role ? ` <span class="og-role">${esc(c.role)}</span>` : ""} <span class="muted">${esc(c.email)}${note}</span></label>`;
    }).join("") + (roled && svc && !mailable.some((c) => roleOf(c, svc) === "main") ? `<span class="og-sub" style="white-space:normal">Nobody is the ${esc(SERVICE_NAME[svc])} main here yet. Tick who it's for.</span>` : "");
    const svc0 = svcs.length ? defaultSvc(o) : "";
    modal(`
      <h2>Email someone at ${esc(o.name)}</h2>
      <div class="og-grid">
        ${svcs.length > 1 ? `<label>About</label><div class="chips" id="aca-ogOoSvc">${svcs.map((k) => `<button type="button" data-svc="${k}" aria-pressed="${k === svc0}">${esc(SERVICE_NAME[k])}</button>`).join("")}</div>` : ""}
        <label>To</label><div class="og-enc" id="aca-ogOoTo">${toList(svc0)}</div>
        <label for="aca-ogOoSubj">Subject</label><input type="text" id="aca-ogOoSubj" />
        <label for="aca-ogOoWhen">Send</label><input type="datetime-local" id="aca-ogOoWhen" value="${esc(toLocalInput(d.toISOString()))}" />
      </div>
      ${snippetPicker("ogOoBody")}
      <textarea id="aca-ogOoBody" class="og-edbody" placeholder="Hi &hellip;"></textarea>
      <p class="og-sub" style="white-space:normal;margin:4px 0 12px">${esc(SIG_NOTE)} <strong>Send now</strong> sends it right away. <strong>Schedule</strong> sends it at the time above, or in the next send window after it.</p>
      <div id="aca-ogOoErr" class="inline-error hidden" style="margin:0 0 12px"></div>
      <div class="og-actions"><button type="button" class="primary" data-v="now">Send now</button><button type="button" data-v="go">Schedule</button><button type="button" data-v="close">Cancel</button></div>`, true);
    const box = modal.last;
    fillSnippetPickers(box, o);
    box.addEventListener("click", async (e) => {
      const sv = e.target.closest("button[data-svc]");
      if (sv) { box.querySelectorAll("button[data-svc]").forEach((x) => x.setAttribute("aria-pressed", String(x === sv))); el("ogOoTo").innerHTML = toList(sv.dataset.svc); return; }
      const b = e.target.closest("button[data-v]"); if (!b) return;
      if (b.dataset.v === "close") return box.close(false);
      const err = (m) => { el("ogOoErr").textContent = m; el("ogOoErr").classList.remove("hidden"); };
      const subj = el("ogOoSubj").value.trim(), body = el("ogOoBody").value.trim(), when = el("ogOoWhen").value;
      if (!subj || !body) return err("Add a subject and a message.");
      const at = when ? new Date(when) : new Date();
      const ids = [...el("ogOoTo").querySelectorAll("input:checked")].map((i) => i.value);
      const to = mailable.filter((x) => ids.includes(x.id));
      if (!to.length) return err("Tick at least one person.");
      const now = b.dataset.v === "now";
      if (!confirm(`Send this to ${to.map((c) => `${who(c)} (${c.email})`).join(", ")} ${now ? "right now" : at.getTime() <= Date.now() + 60e3 ? "in the next send window" : "on " + fmtWhen(at.toISOString()) + " (or the next send window after it)"}?`)) return;
      b.disabled = true;
      const made = [];
      for (const c of to) {
        const { data: eid, error } = await sb.rpc("prospect_schedule_oneoff", { p_contact: c.id, p_subject: subj, p_body: body, p_send_at: now ? null : at.toISOString() });
        if (error) { b.disabled = false; return err(`${who(c)}: ${cleanErr(error)}`); }
        made.push(eid);
      }
      box.close(true);
      if (now) { try { await sendNow(made); } catch (e2) { toast(cleanErr(e2), true); } }
      else toast(to.length > 1 ? `${to.length} emails scheduled` : "Email scheduled");
      await reloadOrg(o.id); await loadPanel(o.id);
    });
  }

  // The same composer for other pages (2026-10-23: the job page's Email button). people: [{id, name, email, role,
  // why (set = can't be emailed, shown greyed), checked}]. send(ids, subject, body, now) does the work and resolves
  // when it's done; a thrown error shows in the dialog. Resolves true once sent.
  function emailPeople(opts) {
    const people = opts.people || [];
    const ok = people.filter((p) => !p.why);
    if (!ok.length) { toast(people.length ? "Nobody on this job can be emailed right now." : "Add a contact with Edit booking first.", true); return Promise.resolve(false); }
    const p = modal(`
      <h2>${esc(opts.title || "Email")}</h2>
      <div class="og-grid">
        <label>To</label><div class="og-enc" id="aca-ogJeTo">${people.map((c) => `<label${c.why ? ' class="muted"' : ""}><input type="checkbox" value="${esc(c.id)}" ${c.why ? "disabled" : c.checked !== false ? "checked" : ""} />
          ${esc(c.name || c.email || "")}${c.role ? ` <span class="og-role">${esc(c.role)}</span>` : ""} <span class="muted">${esc(c.email || "")}${c.why ? " &middot; " + esc(c.why) : ""}</span></label>`).join("")}</div>
        <label for="aca-ogJeSubj">Subject</label><input type="text" id="aca-ogJeSubj" value="${esc(opts.subject || "")}" />
      </div>
      ${snippetPicker("ogJeBody")}
      <textarea id="aca-ogJeBody" class="og-edbody" placeholder="Hi &hellip;"></textarea>
      <p class="og-sub" style="white-space:normal;margin:4px 0 12px">${esc(SIG_NOTE)} Each person gets their own email. <strong>Send now</strong> sends it right away. <strong>Add to queue</strong> sends it in the next send window.</p>
      <div id="aca-ogJeErr" class="inline-error hidden" style="margin:0 0 12px"></div>
      <div class="og-actions"><button type="button" class="primary" data-v="now">Send now</button><button type="button" data-v="queue">Add to queue</button><button type="button" data-v="close">Cancel</button></div>`, true);
    const box = modal.last;
    fillSnippetPickers(box, opts.org || null);
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      if (b.dataset.v === "close") return box.close(false);
      const err = (m) => { el("ogJeErr").textContent = m; el("ogJeErr").classList.remove("hidden"); };
      const subj = el("ogJeSubj").value.trim(), body = el("ogJeBody").value.trim();
      if (!subj || !body) return err("Add a subject and a message.");
      const ids = [...el("ogJeTo").querySelectorAll("input:checked")].map((i) => i.value);
      const to = ok.filter((x) => ids.includes(x.id));
      if (!to.length) return err("Tick at least one person.");
      const now = b.dataset.v === "now";
      if (!confirm(`Send this to ${to.map((c) => (c.name ? `${c.name} (${c.email})` : c.email)).join(", ")} ${now ? "right now" : "in the next send window"}?`)) return;
      box.querySelectorAll("button[data-v]").forEach((x) => { x.disabled = true; });
      try { await opts.send(to.map((c) => c.id), subj, body, now); }
      catch (e2) { box.querySelectorAll("button[data-v]").forEach((x) => { x.disabled = false; }); return err(cleanErr(e2)); }
      box.close(true);
    });
    return p;
  }

  // ---------------------------------------------------------------- Held outreach (2026-10-24: part of the Outbox)
  // "Outreach to review" used to be its own tab. The same cards (who, subject, the whole email) now sit at the top of
  // the Outbox (outbox.js calls mountHeld), with the Outbox's verbs: Send now / Add to queue / Edit / Don't send.
  // #partners/ready still works: it opens the Outbox. Pause sending, test mode and open tracking live in Settings > Sending.
  el("panel-ready").innerHTML = '<div class="card"><div class="empty">Outreach to review is part of the <a href="#partners/outbox">Outbox</a> now.</div></div>';
  const heldEl = document.createElement("div");
  heldEl.className = "og-held hidden";
  heldEl.innerHTML = `
      <div class="og-heldhead">
        <div><h3>Waiting for your OK <span class="muted" id="aca-ogHeldN"></span></h3>
          <p class="og-sub" style="white-space:normal">New outreach and follow-up emails wait here. Read them, edit anything, then Send now (right away) or Add to queue (the next send window). The rest of a sequence follows on its own.</p></div>
        <div class="og-actions"><button type="button" class="small primary" id="aca-ogApproveAll">Add all to queue</button></div>
      </div>
      <div class="og-sendstate" id="aca-ogSendState"></div>
      <div id="aca-ogReadyErr" class="inline-error hidden" style="margin-top:12px"></div>
      <div id="aca-ogReadyBody" class="og-ready"></div>`;
  const H = (id) => heldEl.querySelector("#aca-" + id);
  let readyRows = [];
  let readyContacts = new Map();
  let heldOrg = "", heldFocus = "";
  // Renders the held cards into box (the Outbox), only this organization's when org is set. Resolves to how many emails wait.
  async function mountHeld(box, opts) {
    opts = opts || {};
    heldOrg = opts.org || ""; heldFocus = opts.focus || "";
    if (heldEl.parentNode !== box) box.appendChild(heldEl);
    await loadReady(true);
    return shownHeld().length;
  }
  const shownHeld = () => readyRows.filter((r) => !heldOrg || r.org_id === heldOrg);
  async function loadReady(quiet) {
    try {
      const rows = await sb.from("prospect_scheduled_emails").select("*").eq("status", "held").eq("needs_review", true).order("created_at");
      if (rows.error) throw rows.error;
      readyRows = rows.data || [];
      const ids = [...new Set(readyRows.map((r) => r.contact_id))];
      readyContacts = new Map();
      if (ids.length) {
        const { data } = await sb.from("prospect_contacts").select("*").in("id", ids);
        (data || []).forEach((c) => readyContacts.set(c.id, c));
      }
      if (!loaded) await load(false);
      renderReady();
      loadSendState();
      H("ogReadyErr").classList.add("hidden");
    } catch (e) {
      readyRows = [];
      renderReady();
      if (!quiet) { H("ogReadyErr").textContent = "Could not load: " + cleanErr(e); H("ogReadyErr").classList.remove("hidden"); }
    }
  }
  // a card per sequence, or per org for single drafts (no sequence behind them)
  const readyKey = (r) => r.enrollment_id || "q:" + (r.batch_id || r.id) + ":" + r.org_id;
  function renderReady() {
    const byEnr = new Map();
    const all = new Set(readyRows.map(readyKey)).size;
    shownHeld().forEach((r) => { const k = readyKey(r); if (!byEnr.has(k)) byEnr.set(k, []); byEnr.get(k).push(r); });
    heldEl.classList.toggle("hidden", !byEnr.size);
    H("ogHeldN").textContent = byEnr.size ? String(byEnr.size) : "";
    H("ogApproveAll").textContent = byEnr.size > 1 ? `Add all ${byEnr.size} to queue` : "Add all to queue";
    H("ogApproveAll").classList.toggle("hidden", byEnr.size < 2 || !canEdit("partners"));
    const ed = canEdit("partners");
    H("ogReadyBody").innerHTML = [...byEnr.entries()].map(([enr, rows]) => {
      const o = byId.get(rows[0].org_id) || { name: "(partner)" };
      const first = rows[0];
      const focus = heldFocus && rows.some((r) => r.id === heldFocus || r.enrollment_id === heldFocus);
      return `<div class="og-rcard${focus ? " og-focus" : ""}" data-enr="${esc(enr)}" data-ids="${esc(rows.map((r) => r.id).join(","))}">
        <div class="og-emh"><span><a class="og-rname" href="#partners/org/${esc(first.org_id)}">${esc(o.name)}</a>
          <span class="muted" style="font-weight:400"> &middot; ${rows.map((r) => { const c = readyContacts.get(r.contact_id); return esc(who(c) + (c && c.role ? " (" + c.role + ")" : "")); }).join(", ")}</span></span>
          <span class="muted" style="font-size:12px;font-weight:400">${first.enrollment_id ? "" : "single email &middot; "}added ${esc(fmtDay(first.created_at))}</span></div>
        <div class="og-rsubj">${esc(first.subject || "")}</div>
        <div class="og-rbody">${esc(first.body || "")}</div>
        ${ed ? `<div class="og-actions">
          <button type="button" class="small primary" data-rgo="sendnow">Send now</button>
          <button type="button" class="small" data-rgo="approve">Add to queue</button>
          ${rows.map((r) => `<button type="button" class="small" data-redit="${esc(r.id)}">Edit${rows.length > 1 ? " (" + esc(who(readyContacts.get(r.contact_id))) + ")" : ""}</button>`).join("")}
          <button type="button" class="small" data-rgo="stop">Don't send</button></div>` : ""}</div>`;
    }).join("");
    setAttention("prospects", all, all === 1 ? "league waiting for your review" : "leagues waiting for your review", "outbox", "warn");
    const f = heldFocus && H("ogReadyBody").querySelector(".og-focus");
    if (f && f.scrollIntoView) setTimeout(() => f.scrollIntoView({ block: "center" }), 50);
  }
  H("ogApproveAll").addEventListener("click", async () => {
    const list = shownHeld();
    const enrs = [...new Set(list.filter((r) => r.enrollment_id).map((r) => r.enrollment_id))];
    const quick = list.filter((r) => !r.enrollment_id).map((r) => r.id);
    const cards = new Set(list.map(readyKey)).size;
    if (!cards || !confirm(`Add all ${cards} to the queue? ${quick.length ? `${quick.length} single email${quick.length === 1 ? "" : "s"} and ` : ""}${enrs.length} sequence${enrs.length === 1 ? "" : "s"}. First emails go out in the next send window.`)) return;
    let ok = 0;
    for (const id of enrs) { const { error } = await sb.rpc("prospect_approve", { p_enrollment: id }); if (error) toast(cleanErr(error), true); else ok++; }
    if (quick.length) {
      const { data, error } = await sb.rpc("prospect_approve_quick", { p_ids: quick });
      if (error) toast(cleanErr(error), true); else ok += (data && data.orgs) || quick.length;
    }
    toast(`Added ${ok} to the queue. They go out in the next send window.`); heldChanged();
  });
  // After an approve / edit / don't send: the cards, the partners list and the Outbox table all refresh.
  function heldChanged() { loadReady(true); load(true); if (typeof Outbox !== "undefined" && Outbox.refresh) Outbox.refresh(); }
  heldEl.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const card = b.closest("[data-enr]");
    if (b.dataset.redit) {
      const x = readyRows.find((r) => r.id === b.dataset.redit);
      const o = byId.get(x.org_id) || { name: "" };
      openEditor(x, readyContacts.get(x.contact_id), o.name, heldChanged);
      return;
    }
    const quickIds = card && card.dataset.enr.startsWith("q:") ? readyRows.filter((r) => readyKey(r) === card.dataset.enr).map((r) => r.id) : null;
    if (b.dataset.rgo === "approve") {
      b.disabled = true;
      const { error } = quickIds ? await sb.rpc("prospect_approve_quick", { p_ids: quickIds })
        : await sb.rpc("prospect_approve", { p_enrollment: card.dataset.enr });
      if (error) { b.disabled = false; toast(cleanErr(error), true); return; }
      toast(QUEUED); heldChanged(); return;
    }
    if (b.dataset.rgo === "sendnow") {
      b.disabled = true;
      try { await sendNow(card.dataset.ids.split(",")); } catch (err) { b.disabled = false; toast(cleanErr(err), true); return; }
      heldChanged(); return;
    }
    if (b.dataset.rgo === "stop") {
      if (!confirm(quickIds ? "Don't send this email? The draft is cancelled." : "Don't send this sequence? Its emails are cancelled (you can enroll again later).")) return;
      const { error } = quickIds ? await sb.from("prospect_scheduled_emails").update({ status: "stopped", needs_review: false }).in("id", quickIds)
        : await sb.rpc("prospect_set_status", { p_enrollment_id: card.dataset.enr, p_action: "stop" });
      if (error) { toast(cleanErr(error), true); return; }
      toast("Cancelled"); heldChanged();
    }
  });
  // Edit one scheduled outreach email from anywhere (the Outbox's Edit): the same editor the cards use.
  async function editEmail(id, onDone) {
    const { data: x, error } = await sb.from("prospect_scheduled_emails").select("*").eq("id", id).maybeSingle();
    if (error || !x) { toast(error ? cleanErr(error) : "That email isn't there any more.", true); return; }
    const { data: c } = await sb.from("prospect_contacts").select("*").eq("id", x.contact_id).maybeSingle();
    if (!loaded) await load(false);
    const o = byId.get(x.org_id) || { name: "" };
    openEditor(x, c || null, o.name, () => { heldChanged(); if (onDone) onDone(); });
  }

  function followupsHtml(d) {
    const open = d.fus.filter((f) => f.status === "open");
    const today = todayStr();
    return (open.length ? open.map((f) => `<div class="og-fu" data-fu="${esc(f.id)}">
        <div><strong class="${f.due_on < today ? "og-late" : ""}">${esc(fmtDay(f.due_on))}</strong> ${esc(f.note || "")}</div>
        <div class="og-actions" style="flex-wrap:nowrap"><button type="button" class="small" data-fua="snooze">+2 weeks</button><button type="button" class="small" data-fua="done">Done</button></div></div>`).join("")
      : '<p class="muted" style="margin:0;font-size:13px">No follow-up set.</p>') +
      `<div class="og-fuadd hidden" id="aca-ogFuAdd"><input type="date" id="aca-ogFuDate" /><input type="text" id="aca-ogFuNote" placeholder="What to follow up about" /><button type="button" class="small primary" data-act="savefu">Save</button></div>`;
  }
  const KIND = { email_sent: "Emailed", history_email: "Earlier outreach", reply: "Reply", bounce: "Bounced", unsubscribe: "Unsubscribed",
    note: "Note", stage_change: "Stage changed", followup_set: "Follow-up set", followup_done: "Follow-up done", open: "Opened" };
  function timelineHtml(d, cById) {
    const acts = d.acts.filter((a) => tlFilter === "all" ||
      (tlFilter === "email" && (a.kind === "email_sent" || a.kind === "history_email")) ||
      (tlFilter === "reply" && a.kind === "reply") || (tlFilter === "note" && a.kind === "note"));
    if (!acts.length) return '<p class="muted" style="margin:0;font-size:13px">Nothing here yet.</p>';
    return '<ul class="og-tl">' + acts.map((a) => {
      const c = a.contact_id ? cById.get(a.contact_id) : null;
      const meta = a.meta || {};
      let title = KIND[a.kind] || a.kind;
      if (a.kind === "email_sent") title = `Email ${meta.step || ""} sent${c ? " to " + who(c) : ""}`;
      if (a.kind === "reply" && c) title = "Reply from " + who(c);
      if (a.kind === "stage_change") title = `${STAGE_NAME[meta.from] || meta.from || ""} → ${STAGE_NAME[meta.to] || meta.to || ""}`;
      const history = a.kind === "history_email" || !!meta.history;
      const threads = history && Array.isArray(meta.thread_ids) ? meta.thread_ids : (a.gmail_thread_id ? [a.gmail_thread_id] : []);
      const links = threads.slice(0, 3).map((t, i) => `<a href="${esc(gmailLink(t, history))}" target="_blank" rel="noopener">Gmail${threads.length > 1 ? " " + (i + 1) : ""}</a>`).join(" &middot; ");
      const body = a.kind === "stage_change" ? (meta.auto ? "Automatic" + (a.body ? ": " + a.body : "") : "Changed by you") : (a.body || "");
      return `<li class="k-${esc(a.kind)}" data-aid="${esc(a.id)}"><div class="og-tlh"><span>${esc(title)}</span><span class="when">${esc(fmtDay(a.occurred_at))}</span></div>
        ${a.subject ? `<div class="og-tlm">${esc(a.subject)}</div>` : ""}
        ${body ? `<div class="og-tlb${body.length > 180 ? " clamp" : ""}">${esc(body)}</div>` : ""}
        ${links || a.kind === "note" ? `<div class="og-tlm">${links}${a.kind === "note" ? `${links ? " &middot; " : ""}<button type="button" class="link" data-note="edit">Edit</button> &middot; <button type="button" class="link" data-note="del">Delete</button>` : ""}</div>` : ""}</li>`;
    }).join("") + "</ul>";
  }

  // ---------------------------------------------------------------- panel edits
  // The change shows at once and the write runs behind it; a failed save puts the old values back (2026-10-24).
  async function saveOrg(patch, quiet) {
    const id = openId, o = byId.get(id), before = {};
    Object.keys(patch).forEach((k) => { before[k] = o[k]; });
    Object.assign(o, patch);
    redrawOrg(id);
    const r = await Saves.run("org:" + id, () => sb.from("prospect_orgs").update(patch).eq("id", id), () => {
      Object.assign(byId.get(id) || o, before); redrawOrg(id);
    });
    if (!r) return false;
    if (!quiet) toast("Saved");
    // the partner page heading and other open screens follow a rename (2026-10-24)
    if (patch.name && patch.name !== before.name) window.dispatchEvent(new CustomEvent("aca:partner-renamed", { detail: { id, name: patch.name, old: before.name } }));
    refreshOrg(id);
    return true;
  }
  function redrawOrg(id) { if (openId === id) renderPanel(); render(); }
  // What the database works out by itself (stage history, client since, the timeline) comes in quietly once the
  // last save for this partner is done, so a second quick change isn't flipped back by the first one's reload.
  function refreshOrg(id) {
    if (Saves.busy("org:" + id)) return;
    reloadOrg(id).then(() => { if (openId === id && !Saves.busy("org:" + id)) return loadPanel(id); });
  }
  panel.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.dataset.f) {
      const f = t.dataset.f, o = byId.get(openId);
      let v = t.value;
      if (f === "name") { v = v.trim(); if (!v) { t.value = o.name; return; } }
      if (f === "sports") v = v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      else if (f !== "stage" && f !== "audience") v = v.trim() || null;
      // a contract end date gets a reminder in January of that year (booking season), unless one is open
      if (f === "sp_until" && v && !panelData.fus.some((x) => x.status === "open")) {
        const due = v.slice(0, 4) + "-01-15";
        const emails = panelData.contacts.filter((c) => !c.bounced_at && !c.unsubscribed_at).map((c) => c.email);
        await sb.from("prospect_followups").insert({ org_id: o.id, org_name: o.name, emails, due_on: due,
          note: `School photos: contract with ${o.sp_competitor || "another photographer"} ends ${fmtDay(v)}. Reach out before they re-sign.` });
        toast("Reminder set for Jan 15, " + v.slice(0, 4));
      }
      if (f === "stage" && v === "do_not_contact" && !confirm(`Mark ${o.name} as Do not contact? Nothing will be sent to them and they can't be enrolled.`)) { t.value = o.stage; return; }
      if (f === "stage" && v === "not_now") {
        const fl = await askFollowLater(o);
        if (!fl) { t.value = o.stage; return; }
        const emails = panelData.contacts.filter((c) => !c.bounced_at && !c.unsubscribed_at).map((c) => c.email);
        // one reminder per org: an open follow-up is moved to the new date, else a new one is made
        const open = panelData.fus.find((x) => x.status === "open");
        const { error: fe } = open
          ? await sb.from("prospect_followups").update({ due_on: fl.due, note: fl.note || open.note, notified_for: null, updated_at: new Date().toISOString() }).eq("id", open.id)
          : await sb.from("prospect_followups").insert({ org_id: o.id, org_name: o.name, emails, due_on: fl.due, note: fl.note });
        if (fe) { toast(cleanErr(fe), true); t.value = o.stage; return; }
        await sb.from("prospect_activities").insert({ org_id: o.id, kind: "followup_set", body: `Follow up ${fmtDay(fl.due)}${fl.note ? ": " + fl.note : ""}` });
      }
      if (f === "name" && v !== o.name) { /* names used in emails when name_known */ }
      const patch = { [f]: v };
      if (f === "name") patch.name_known = true;
      await saveOrg(patch);
      return;
    }
    if (t.dataset.svcst !== undefined || t.hasAttribute("data-svcadd")) {
      const o = byId.get(openId), k = t.dataset.svcst || t.value, v = t.dataset.svcst !== undefined ? t.value : "prospect";
      if (!k) return;
      const next = { ...(o.service_status || {}) };
      if (v) next[k] = v; else {
        const who2 = panelData.contacts.filter((c) => roleOf(c, k)).length;
        if (!confirm(`Mark ${SERVICE_NAME[k]} as not offered for ${o.name}?${who2 ? ` ${who2} ${who2 === 1 ? "person is" : "people are"} set for it; they keep that, hidden, in case you turn it back on.` : ""}`)) { renderPanel(); return; }
        delete next[k];
      }
      await saveOrg({ service_status: next });
      return;
    }
    if (t.dataset.role !== undefined) {
      const tr = t.closest("tr[data-cid]"), c = panelData.contacts.find((x) => x.id === tr.dataset.cid), k = t.dataset.role;
      const roles = { ...(c.service_roles || {}) }, was = c.service_roles, v = t.value, id = openId;
      if (v) roles[k] = v; else delete roles[k];
      c.service_roles = roles; renderPanel();
      const r = await Saves.run("org:" + id, () => sb.from("prospect_contacts").update({ service_roles: roles }).eq("id", c.id),
        () => { c.service_roles = was; if (openId === id) renderPanel(); });
      if (!r) return;
      toast(v === "main" ? `${who(c)} is the ${SERVICE_NAME[k]} main` : v === "copy" ? `${who(c)} is copied in on ${SERVICE_NAME[k]}` : `${who(c)} is not involved in ${SERVICE_NAME[k]}`);
      refreshOrg(id);
      return;
    }
    if (t.dataset.service) {
      const services = [...panel.querySelectorAll("input[data-service]")].filter((x) => x.checked).map((x) => x.dataset.service);
      await saveOrg({ services });
      return;
    }
    if (t.dataset.season) {
      const seasons = [...panel.querySelectorAll("input[data-season]")].filter((x) => x.checked).map((x) => x.dataset.season);
      await saveOrg({ seasons, seasons_manual: true });
      return;
    }
    if (t.dataset.cf) {
      const tr = t.closest("tr[data-cid]");
      const f = t.dataset.cf;
      let v = t.value.trim();
      if (f === "email") {
        v = v.toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { toast("That email doesn't look right", true); renderPanel(); return; }
      }
      const c = panelData.contacts.find((x) => x.id === tr.dataset.cid), was = c ? c[f] : null, id = openId;
      if (c) c[f] = v || null;
      const r = await Saves.run("org:" + id, async () => {
        const res = await sb.from("prospect_contacts").update({ [f]: v || null }).eq("id", tr.dataset.cid);
        if (res.error && /duplicate|unique/i.test(res.error.message)) res.error = { message: "that email is already on this partner" };
        return res;
      }, () => { if (c) c[f] = was; if (openId === id) renderPanel(); });
      if (!r) return;
      toast("Saved");
      if (f === "email") refreshOrg(id);
      return;
    }
    if (t.hasAttribute("data-cact")) {
      const act = t.value; t.value = "";
      if (!act) return;
      const tr = t.closest("tr[data-cid]");
      if (act === "edit") { tr.classList.add("editing"); const er = tr.nextElementSibling; if (er && er.classList.contains("og-cedit")) { er.classList.add("open"); const i = er.querySelector("input[data-cf]"); if (i) i.focus(); } return; }
      const c = panelData.contacts.find((x) => x.id === tr.dataset.cid);
      const words = { stop: "Stop all emails to", resume: "Allow emails again to", bounced: "Mark as bounced (and stop emails to)", unsubscribed: "Mark as unsubscribed (and stop emails to)", clear_flags: "Clear the bounced/unsubscribed/stopped flags on", remove: "Remove", primary: "", unprimary: "" };
      // Stopping someone also takes them off the booking emails of their booked jobs (2026-10-23).
      const jobs = linked && /^(stop|bounced|unsubscribed|remove)$/.test(act) ? (linked.booking.get(c.id) || []) : [];
      const also = jobs.length ? `\n\nThis also takes them off the booking emails for ${jobs.join(", ")}.` : "";
      if (!/primary/.test(act) && !confirm(`${words[act]} ${who(c)}?${also}`)) return;
      const { data, error } = await sb.rpc("prospect_contact_action", { p_contact: c.id, p_action: act });
      if (error) { toast(cleanErr(error), true); return; }
      const bks = (data && data.bookings) || [], empty = bks.filter((x) => x.nobody_left).map((x) => x.title);
      if (empty.length) toast(`Nobody gets the booking emails for ${empty.join(", ")} now. Add someone with Edit booking on the job.`, true);
      else toast(act === "primary" ? `${who(c)} is now a main contact` : act === "unprimary" ? `${who(c)} is no longer a main contact`
        : bks.length ? `Done. ${who(c)} is off the booking emails too.` : act === "resume" ? "Done. Add them on a job's Edit booking if they should get its emails." : "Done");
      if (bks.length) linked = null;
      await reloadOrg(openId); await loadPanel(openId);
      if (/primary/.test(act)) load(true);
    }
  });
  panel.addEventListener("click", async (e) => {
    const b = e.target.closest("button, .og-tlb.clamp");
    if (!b) return;
    if (b.classList.contains("og-tlb")) { b.classList.remove("clamp"); return; }
    const act = b.dataset.act;
    if (act === "cdone") { renderPanel(); return; }
    if (act === "details") {
      detailsOpen = !detailsOpen;
      const d = el("ogDetails"); if (d) { d.classList.toggle("hidden", !detailsOpen); if (detailsOpen) d.scrollIntoView({ block: "start", behavior: "smooth" }); }
      panel.querySelectorAll('[data-act="details"][aria-expanded]').forEach((x) => x.setAttribute("aria-expanded", String(detailsOpen)));
      return;
    }
    if (act && act[0] === "l" && /^l(rm|add|save|cancel)/.test(act)) return linkedClick(b);
    const o = byId.get(openId);
    if (act === "close") return inline ? null : closePanel(false);
    if (act === "history" && o) return HistoryView.open("org", o.id, "History: " + o.name);
    if (act === "prev") return step(-1);
    if (act === "next") return step(1);
    if (act === "note") { const n = el("ogNoteText"); n.scrollIntoView({ block: "center" }); n.focus(); return; }
    if (act === "fu") { el("ogFuAdd").classList.remove("hidden"); el("ogFuSec").scrollIntoView({ block: "center" }); el("ogFuDate").focus(); return; }
    if (act === "addc") { el("ogCAdd").classList.add("open"); el("ogCAddLink").classList.add("hidden"); el("ogCFirst").focus(); return; }
    if (act === "addc_cancel") { el("ogCAdd").classList.remove("open"); el("ogCAddLink").classList.remove("hidden"); return; }
    if (act === "autoseason") return saveOrg({ seasons_manual: false });
    if (act === "rolesok") { const ok = await saveOrg({ roles_checked_at: new Date().toISOString() }, true); if (ok) { roleCheck.delete(o.id); toast("Thanks. Off the check list."); loadAttention(); renderPanel(); } return; }
    if (act === "enroll") return openEnroll(o);
    if (act === "email") return openOneOff(o);
    const reloadHere = async () => { await reloadOrg(o.id); if (openId === o.id) await loadPanel(o.id); loadReady(true); };
    if (b.dataset.approve) {
      if (!confirm(`Add ${o.name}'s sequence to the queue? Email 1 goes out in the next send window.`)) return;
      b.disabled = true;
      const { error } = await sb.rpc("prospect_approve", { p_enrollment: b.dataset.approve });
      if (error) { b.disabled = false; toast(cleanErr(error), true); return; }
      toast(QUEUED); return reloadHere();
    }
    if (b.dataset.sendnow) {
      b.disabled = true;
      try { await sendNow(panelData.emails.filter((y) => y.enrollment_id === b.dataset.sendnow && y.status === "held").map((y) => y.id)); }
      catch (err) { b.disabled = false; toast(cleanErr(err), true); return; }
      return reloadHere();
    }
    if (b.dataset.esend) {
      if (!confirm("Send this email now instead of waiting for its time?")) return;
      b.disabled = true;
      try { await sendNow([b.dataset.esend]); } catch (err) { b.disabled = false; toast(cleanErr(err), true); return; }
      return reloadHere();
    }
    if (b.dataset.eedit || b.dataset.eview) {
      const x = panelData.emails.find((y) => y.id === (b.dataset.eedit || b.dataset.eview));
      return openEditor(x, panelData.contacts.find((c) => c.id === x.contact_id), o.name, reloadHere);
    }
    if (b.dataset.eskip) {
      if (!confirm("Skip this email? The rest of the sequence carries on without it.")) return;
      const { error } = await sb.from("prospect_scheduled_emails").update({ status: "skipped" }).eq("id", b.dataset.eskip);
      if (error) { toast(cleanErr(error), true); return; }
      toast("Skipped"); return reloadHere();
    }
    if (act === "savenote") {
      const text = el("ogNoteText").value.trim(); if (!text) return;
      b.disabled = true;
      const { error } = await sb.from("prospect_activities").insert({ org_id: o.id, kind: "note", body: text });
      b.disabled = false;
      if (error) { toast("Note not saved: " + cleanErr(error), true); return; }
      await reloadOrg(o.id); await loadPanel(o.id); return;
    }
    if (act === "savec") {
      const email = el("ogCEmail").value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("Add a valid email", true); return; }
      b.disabled = true;
      const { error } = await sb.from("prospect_contacts").insert({ org_id: o.id, email, first_name: el("ogCFirst").value.trim() || null,
        last_name: el("ogCLast").value.trim() || null, role: el("ogCRole").value.trim() || null, phone: el("ogCPhone").value.trim() || null,
        is_primary: !panelData.contacts.length });
      b.disabled = false;
      if (error) { toast(/duplicate|unique/i.test(error.message) ? "That person is already a contact here" : cleanErr(error), true); return; }
      toast("Contact added"); await reloadOrg(o.id); await loadPanel(o.id); return;
    }
    if (act === "savefu") {
      const due = el("ogFuDate").value; if (!due) { toast("Pick a date", true); return; }
      const note = el("ogFuNote").value.trim() || null;
      const emails = panelData.contacts.filter((c) => !c.bounced_at && !c.unsubscribed_at).map((c) => c.email);
      b.disabled = true;
      const { error } = await sb.from("prospect_followups").insert({ org_id: o.id, org_name: o.name, emails, due_on: due, note });
      if (!error) await sb.from("prospect_activities").insert({ org_id: o.id, kind: "followup_set", body: `For ${fmtDay(due)}${note ? ": " + note : ""}` });
      b.disabled = false;
      if (error) { toast(cleanErr(error), true); return; }
      toast("Follow-up set"); await reloadOrg(o.id); await loadPanel(o.id); return;
    }
    if (b.dataset.fua) {
      const id = b.closest("[data-fu]").dataset.fu;
      const f = panelData.fus.find((x) => x.id === id);
      let patch;
      if (b.dataset.fua === "done") patch = { status: "done", done_at: new Date().toISOString() };
      else { const dt = new Date(Math.max(Date.now(), new Date(f.due_on + "T12:00:00").getTime()) + 14 * 864e5); patch = { due_on: dt.toLocaleDateString("en-CA", { timeZone: "America/New_York" }) }; }
      const { error } = await sb.from("prospect_followups").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) { toast(cleanErr(error), true); return; }
      if (b.dataset.fua === "done") await sb.from("prospect_activities").insert({ org_id: o.id, kind: "followup_done", body: f.note || null });
      await reloadOrg(o.id); await loadPanel(o.id); return;
    }
    if (b.dataset.enr) {
      const verb = { pause: "Pause", resume: "Resume", stop: "Stop" }[b.dataset.do];
      if (!confirm(`${verb} the emails to ${o.name}?`)) return;
      const { error } = await sb.rpc("prospect_set_status", { p_enrollment_id: b.dataset.enr, p_action: b.dataset.do });
      if (error) { toast(cleanErr(error), true); return; }
      toast(verb === "Stop" ? "Stopped" : verb + "d"); await reloadOrg(o.id); await loadPanel(o.id); return;
    }
    if (b.dataset.tlf) { tlFilter = b.dataset.tlf; renderPanel(); return; }
    if (b.dataset.note) {
      const li = b.closest("[data-aid]"); const a = panelData.acts.find((x) => x.id === li.dataset.aid);
      if (b.dataset.note === "del") {
        if (!confirm("Delete this note?")) return;
        const { error } = await sb.from("prospect_activities").delete().eq("id", a.id);
        if (error) { toast(cleanErr(error), true); return; }
      } else {
        const text = prompt("Edit note:", a.body || "");
        if (text === null || !text.trim()) return;
        const { error } = await sb.from("prospect_activities").update({ body: text.trim(), updated_at: new Date().toISOString() }).eq("id", a.id);
        if (error) { toast(cleanErr(error), true); return; }
      }
      await reloadOrg(o.id); await loadPanel(o.id);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!openId || inline || panel.classList.contains("hidden")) return;
    if (document.querySelector(".aca .og-modal-wrap, .aca .pr-modal-wrap")) return;
    const typing = e.target.closest && e.target.closest("input, textarea, select");
    if (e.key === "Escape" && !typing) { closePanel(false); return; }
    if (typing) return;
    if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
    if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  });
  window.addEventListener("hashchange", () => {
    const m = location.hash.match(/orgs\/([0-9a-f-]{36})/i);
    if (m && m[1] !== openId && loaded) openOrg(m[1]);
    const g = groupInHash(); if (g && loaded && st.group !== g) setGroup(g, true);
  });

  // ---------------------------------------------------------------- import (paste a spreadsheet)
  // Replaces the old Prospects tab's "Add many leagues". Adds orgs + contacts; optionally enrolls each in its
  // best-matching sequence. Enrolled emails are held for review, so an import never sends anything.
  function openImport() {
    measureTop();
    modal(`
      <h2>Import partners</h2>
      <p class="og-sub" style="white-space:normal;margin:0 0 8px">Copy rows from a spreadsheet (header row included) and paste below, or paste CSV.
        Columns: <strong>League, Sport, Town, Website, First name, Last name, Email, Role, Custom opener</strong>. Only Email is required.
        Put each person at the same org on their own row with the same org name.
        Start from the template: <a href="https://docs.google.com/spreadsheets/d/1JwOQCRiT0ObPvh941PWWuGGl7mqAEQmpjTYm7w2RjrY/copy" target="_blank" rel="noopener">open a fresh copy in Google Sheets</a>
        or <button type="button" class="link" data-v="tpl">download it as a CSV</button>.</p>
      <div class="og-grid" style="margin-bottom:8px"><label for="aca-ogImAud">These are</label>
        <select id="aca-ogImAud"><option value="league">Leagues</option><option value="school">Schools</option></select></div>
      <textarea id="aca-ogImText" class="og-edbody" style="min-height:160px;font-size:12.5px;white-space:pre" placeholder="League&#9;Sport&#9;Town&#9;Website&#9;First name&#9;Last name&#9;Email&#9;Role"></textarea>
      <div class="og-actions" style="margin-top:8px"><button type="button" class="small" data-v="check">Check rows</button><span class="og-sub" id="aca-ogImMsg"></span></div>
      <div id="aca-ogImPrev" class="og-imprev"></div>
      <label class="og-track" style="margin:10px 0"><input type="checkbox" id="aca-ogImEnroll" checked /> Also enroll each in its best-matching sequence (email 1 waits in the Outbox; nothing sends)</label>
      <div id="aca-ogImErr" class="inline-error hidden" style="margin:0 0 12px"></div>
      <div class="og-actions"><button type="button" class="primary" data-v="go" disabled>Import</button><button type="button" data-v="close">Cancel</button></div>`, true);
    const box = modal.last;
    let groups = [];
    const err = (m) => { el("ogImErr").textContent = m; el("ogImErr").classList.remove("hidden"); };
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      const v = b.dataset.v;
      if (v === "close") return box.close(false);
      if (v === "tpl") {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([Prior.TEMPLATE_CSV], { type: "text/csv;charset=utf-8" }));
        a.download = "207-partners-template.csv"; document.body.appendChild(a); a.click(); a.remove();
        return;
      }
      if (v === "check") {
        el("ogImErr").classList.add("hidden");
        const { groups: gs, problems } = Prior.buildGroups(el("ogImText").value);
        if (problems.length) return err(problems.join(" "));
        groups = gs.filter((g) => g.contacts.length);
        b.disabled = true; el("ogImMsg").textContent = "Checking earlier contact…";
        for (const g of groups) {
          const existing = g.league && orgs.find((o) => o.name.toLowerCase() === g.league.toLowerCase());
          g.existing = existing ? existing.name : null;
          try { g.prior = await Prior.priorContact(g.league || null, g.contacts.map((c) => c.email)); } catch (_e) { g.prior = null; }
          g.soon = !!(g.prior && g.prior.matches.some((m) => m.within_cooldown));
          g.include = !g.soon;
        }
        b.disabled = false;
        el("ogImMsg").textContent = `${groups.length} partner${groups.length === 1 ? "" : "s"} found${gs.length > groups.length ? `, ${gs.length - groups.length} skipped (no usable email)` : ""}.`;
        el("ogImPrev").innerHTML = groups.length ? `<table class="og-ctab"><tbody>${groups.map((g, i) => `<tr>
            <td><input type="checkbox" data-inc="${i}" ${g.include ? "checked" : ""} aria-label="Include" /></td>
            <td><strong>${esc(g.league || "(no name)")}</strong><div class="og-sub">${esc([g.sport, g.town].filter(Boolean).join(", "))}</div></td>
            <td class="og-sub" style="white-space:normal">${g.contacts.map((c) => esc(c.email)).join("<br>")}</td>
            <td>${g.existing ? '<span class="pill muted">Already here: adds contacts</span>' : '<span class="pill accent">New</span>'}
              ${g.prior && g.prior.matches.length ? `<div><span class="pill ${g.soon ? "warn" : "ok"}">${g.soon ? "Contacted recently" : "Contacted before"}</span></div>` : ""}
              ${g.issues.length ? `<div class="og-sub" style="white-space:normal;color:var(--err-fg)">${esc(g.issues.join("; "))}</div>` : ""}</td></tr>`).join("")}</tbody></table>
            <p class="og-sub" style="white-space:normal">Rows contacted inside the cool-down start unticked. Tick them to include anyway.</p>` : "";
        box.querySelector('[data-v="go"]').disabled = !groups.length;
        return;
      }
      if (v === "go") {
        box.querySelectorAll("input[data-inc]").forEach((i) => { groups[+i.dataset.inc].include = i.checked; });
        const pick = groups.filter((g) => g.include);
        if (!pick.length) return err("Nothing ticked.");
        const enroll = el("ogImEnroll").checked;
        if (!confirm(`Import ${pick.length} partner${pick.length === 1 ? "" : "s"}${enroll ? " and create their emails for review" : ""}? Nothing is sent.`)) return;
        b.disabled = true;
        const payload = pick.map((g) => ({ name: g.league || null, audience: el("ogImAud").value, sport: g.sport, town: g.town, website: g.website,
          opener: g.opener || null, contacts: g.contacts }));
        const { data, error } = await sb.rpc("prospect_import_orgs", { p_groups: payload, p_enroll: enroll });
        if (error) { b.disabled = false; return err(cleanErr(error)); }
        box.close(true);
        const notes = (data.notes || []);
        alert(`Imported: ${data.added} new, ${data.matched} matched to existing, ${data.contacts} new contacts${enroll ? `, ${data.enrolled} enrolled (waiting in the Outbox)` : ""}.` +
          (notes.length ? "\n\nNotes:\n- " + notes.join("\n- ") : ""));
        await load(true); loadReady(true);
      }
    });
  }
  el("ogImport").addEventListener("click", openImport);

  // ---------------------------------------------------------------- sending status (moved from the old tab)
  let sendSettings = null;
  async function loadSendState() {
    const tz = "America/New_York";
    const midnight = new Date(new Date().toLocaleString("en-US", { timeZone: tz })); midnight.setHours(0, 0, 0, 0);
    const offset = new Date().getTime() - new Date(new Date().toLocaleString("en-US", { timeZone: tz })).getTime();
    const [sets, sent, errs] = await Promise.all([
      sb.from("prospect_settings").select("*").maybeSingle(),
      sb.from("prospect_send_log").select("id", { count: "exact", head: true }).eq("ok", true).gte("sent_at", new Date(midnight.getTime() + offset).toISOString()),
      sb.from("prospect_send_log").select("sent_at,error").eq("ok", false).gte("sent_at", new Date(Date.now() - 864e5).toISOString()).order("sent_at", { ascending: false }).limit(1),
    ]);
    sendSettings = sets.data || null;
    if (!sendSettings) return;
    Prior.setSettings(sendSettings);
    const s = sendSettings;
    H("ogSendState").innerHTML = [
      s.paused ? '<span class="pill warn">Outreach sending is paused</span>' : s.test_mode ? `<span class="pill warn">Test mode: emails go to ${esc(s.test_recipient)}</span>` : '<span class="pill ok">Sending is on</span>',
      `<span class="muted">${sent.count || 0} sent today, up to ${esc(s.daily_cap)} a day, ${esc(Prior.scheduleText(s))}.</span>`,
      (errs.data || []).length ? `<span class="pill err" title="${esc(errs.data[0].error)}">A send failed ${esc(fmtWhen(errs.data[0].sent_at))}; it retries in an hour</span>` : "",
      canSee("settings") ? '<a href="#system/sending">Change in Settings &rsaquo; Sending</a>' : "",
    ].join(" ");
  }

  // ---------------------------------------------------------------- Today / section badges (light queries only)
  async function loadAttention() {
    const today = todayStr();
    const [fu, held, rc] = await Promise.all([
      sb.from("prospect_followups").select("org_id", { count: "exact", head: true }).eq("status", "open").lte("due_on", today),
      sb.from("prospect_scheduled_emails").select("id,org_id,enrollment_id,batch_id").eq("status", "held").eq("needs_review", true),
      sb.rpc("prospect_roles_to_check"),
    ]);
    if (!rc.error) {
      const nr = (rc.data || []).length;
      setAttention("rolesCheck", nr, nr === 1 ? "partner to check who's main" : "partners to check who's main", "orgs", "soon", () => showFlag("rolecheck"));
    }
    if (fu.error || held.error) return;
    const n = fu.count || 0;
    setAttention("followups", n, n === 1 ? "prospect follow-up due" : "prospect follow-ups due", "orgs", "warn", () => showFlag("followup"));
    const r = new Set((held.data || []).map(readyKey)).size;
    setAttention("prospects", r, r === 1 ? "league waiting for your review" : "leagues waiting for your review", "outbox", "warn");
  }
  async function showFlag(flag) {
    await load(false);
    el("ogView").value = ""; el("ogViewDel").classList.add("hidden");
    applyConfig({ flag, sort: { key: "next", dir: 1 } });
  }

  return { load: () => load(false), reload: () => load(true), quickAdd, loadReady: () => loadReady(true), mountHeld, editEmail, sendNow, emailPeople, measureTop: () => measureTop(), loadAttention, showFlag, open: (id) => (GROUP_OF[id] && id ? setGroup(id, true) : openOrg(id)), hide: () => { if (openId && !inline) closePanel(true); },
    embed, unembed, get: (id) => byId.get(id) || null, changed: (id) => reloadOrg(id), stageName: (s) => STAGE_NAME[s] || s || "", spText, monthsText, SERVICE_NAME };
  })();
