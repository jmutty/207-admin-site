  // ================================================================ PARTNERS: Partner page (2026-10-23, tabs reworked 2026-10-24)
  // Everything about one league or school on one screen, at #partners/org/<org id>[/<tab>]: Overview, Contacts, Jobs, Sales,
  // Emails & hub, Agreement & rebooking, Notes & history. Rows on Partners, search, links in jobs and old
  // #partners/orgs/<id> links all open it. Book a job (top bar or this page) starts with the partner picked.
  // Each tab reads the same RPCs as its own page (admin_bookings, results_jobs, agreements_list, admin_outbox, ...)
  // and keeps this partner's rows, so every tab shows only what that person may see on that page.
  // The Contacts tab is the old Organizations side panel, moved in (Orgs.embed / Orgs.unembed).
  // 2026-10-23: Contacts comes right after Overview (Jeremiah).
  // Old tab addresses still work: /galleries and /payouts open Sales.
  // Groups (2026-10-24, Jeremiah's "Link and share"): a partner can be part of one group (a school under its district,
  // RSU 22; a league under a bigger league) through prospect_orgs.parent_id, one level deep. The group gets a
  // Schools / Teams tab and its members' jobs on Overview and Jobs; each member shows "Part of <group>", the group's
  // contacts on its Contacts tab and the group's agreement when that agreement covers its members. Nothing is copied.
  //
  // Other modules add a tab from their own file, the same way as job tabs:
  //   if (typeof registerOrgTab === "function") registerOrgTab({ id: "x", label: "X", order: 55, module: "inventory", render: (org, el, data) => { ... } });
  // Built-in orders: overview 10, jobs 20, sales 30, contacts 40, emails 50, agreements 60, history 90.
  function registerOrgTab(t) { (registerOrgTab.list || (registerOrgTab.list = [])).push(t); }
  // A link to a partner's page, for other modules: '<a href="' + orgLink(id) + '">'.
  function orgLink(id, tab) { return "#partners/org/" + encodeURIComponent(id) + (tab ? "/" + tab : ""); }

  // GotPhoto job id -> its booking (not cancelled), loaded once. Help requests and the Galleries drawer use it to
  // link the job page and the partner (2026-10-24). Function declarations, so earlier files can call them.
  function bookingsByGotphoto(force) {
    if (!canSee("bookings")) return Promise.resolve({});
    if (!bookingsByGotphoto.p || force) {
      bookingsByGotphoto.p = supabase.rpc("admin_bookings", { p_from: "2000-01-01", p_to: null }).then(({ data }) => {
        const m = {};
        (data || []).forEach((b) => { if (b.gotphoto_job_id && b.status !== "cancelled") m[String(b.gotphoto_job_id)] = b; });
        return m;
      }, () => ({}));
    }
    return bookingsByGotphoto.p;
  }
  // Fills every [data-gplinks="<gotphoto job id>"] under root with "Job page · <partner>" links when a booking matches.
  function fillJobLinks(root) {
    const nodes = [...(root || document).querySelectorAll("[data-gplinks]")];
    if (!nodes.length) return;
    bookingsByGotphoto().then((m) => nodes.forEach((n) => {
      const b = m[n.dataset.gplinks]; if (!b || !n.isConnected) return;
      n.innerHTML = '<a href="' + esc(jobLink(b.id)) + '">Job page</a>' + (b.org_id ? ' &middot; <a href="' + esc(orgLink(b.org_id)) + '">' + esc(b.org_name || "Partner") + "</a>" : "");
      n.classList.remove("hidden");
    }));
  }

  registerPage({ id: "org", group: "Work", section: "partners", module: "partners", hidden: true, navAs: "orgs",
                 tabs: [["org", "Partner"]], onShow: () => OrgPage.show() });

  const OrgPage = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .op-trail { margin: 0 0 8px; font-size: 13px; color: var(--muted); } .aca .op-trail a { color: var(--muted); }
    .aca .op-backtrail { margin: 0 0 10px; }
    .aca #aca-panel-org .jp-head h2 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .aca .op-rn { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .aca .op-rn input { font-size: 18px; font-weight: 600; min-width: min(420px, 70vw); }
    .aca .op-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; color: var(--muted); font-size: 13.5px; margin-top: 4px; }
    .aca .op-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 8px 40px; }
    .aca .op-need { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .aca .op-need li { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; padding: 9px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); font-size: 13.5px; }
    .aca .op-need li .tag { flex: 0 0 auto; font-size: 11.5px; font-weight: 700; padding: 1px 7px; border-radius: 3px; background: var(--warn-bg); color: var(--warn-fg); }
    .aca .op-need li.err .tag { background: var(--err-bg); color: var(--err-fg); }
    .aca .op-need li .t { flex: 1 1 220px; min-width: 0; }
    .aca .op-need li .b { flex: 0 0 auto; display: flex; gap: 6px; flex-wrap: wrap; }
    .aca .op-job { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 2px 14px; align-items: start; padding: 12px 14px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text); text-decoration: none; margin-bottom: 8px; }
    .aca .op-job:hover { border-color: var(--accent); }
    .aca .op-job .d { font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .aca .op-job .d small { display: block; font-weight: 400; color: var(--muted); font-size: 12.5px; }
    .aca .op-job .h { display: block; font-weight: 600; }
    .aca .op-job .s { display: block; color: var(--muted); font-size: 13px; margin-top: 3px; }
    .aca .op-sechd { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
    .aca .op-sechd a, .aca .op-sechd button.link { font-size: 13px; color: var(--muted); text-transform: none; letter-spacing: 0; font-weight: 400; }
    .aca .op-side .jp-sec { margin: 0 0 16px; padding-bottom: 14px; border-bottom: 1px solid var(--line2); }
    .aca .op-side .jp-sec:last-child { margin: 0; padding: 0; border: 0; }
    .aca .op-side .jp-sec h3 { font-size: 12px; }
    .aca .op-side .jp-dl { grid-template-columns: 104px minmax(0, 1fr); }
    .aca .op-side { background: var(--surface-2); border-radius: 4px; padding: 14px 16px; }
    .aca .op-line { display: flex; gap: 8px 14px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; font-size: 13.5px; }
    .aca .op-line .grow { flex: 1 1 auto; }
    .aca .op-table { width: 100%; font-size: 13.5px; border-collapse: collapse; }
    .aca .op-table th { text-align: left; font-size: 12px; color: var(--faint); font-weight: 600; padding: 7px 12px 7px 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
    .aca .op-table td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--line2); vertical-align: top; }
    .aca .op-table td.n, .aca .op-table th.n { text-align: right; font-variant-numeric: tabular-nums; }
    .aca .op-table .op-acts { display: flex; gap: 6px; flex-wrap: wrap; }
    .aca .op-table tr.op-prev td { background: var(--surface-2); padding: 10px 12px; }
    .aca .op-mails tbody tr[data-id] { cursor: pointer; }
    .aca .op-mails tbody tr[data-id]:hover td, .aca .op-mails tr.open td { background: var(--surface-2); }
    .aca .op-mails td { padding-top: 10px; padding-bottom: 10px; }
    .aca .op-mails td:first-child { padding-left: 8px; }
    .aca .op-mails .sl-chev { display: inline-block; transform: rotate(-45deg); margin: 0 8px 1px 0; width: 6px; height: 6px; }
    .aca .op-mails tr.open .sl-chev { transform: rotate(45deg); margin-bottom: 3px; }
    .aca .op-mails td.op-to { white-space: nowrap; }
    .aca .op-mails td.op-act { width: 1%; padding-top: 6px; padding-bottom: 6px; }
    .aca .op-wrap { overflow-x: auto; }
    .aca .op-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .aca .op-card { border: 1px solid var(--border); border-radius: 4px; background: var(--surface); padding: 12px 14px; font-size: 13.5px; }
    .aca button.op-card { text-align: left; cursor: pointer; font: inherit; color: inherit; width: 100%; height: auto; display: block; white-space: normal; }
    .aca button.op-card:hover { border-color: var(--accent); }
    .aca .op-card .h { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; margin-bottom: 8px; }
    .aca .op-card .nums { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; color: var(--muted); font-size: 12.5px; }
    .aca .op-card .nums b { display: block; color: var(--text); font-size: 17px; font-variant-numeric: tabular-nums; }
    .aca .op-intro { color: var(--muted); font-size: 13px; margin: 0 0 12px; max-width: 760px; }
    .aca .op-tl { list-style: none; margin: 0; padding: 0; font-size: 13.5px; }
    .aca .op-tl li { padding: 8px 0; border-bottom: 1px solid var(--line2); }
    .aca .op-tl li .h { display: flex; justify-content: space-between; gap: 10px; }
    .aca .op-tl li .h .muted { white-space: nowrap; font-size: 12.5px; }
    .aca .op-tl li .b { color: var(--muted); margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .aca .op-addnote { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 12px; }
    .aca .op-addnote textarea { flex: 1 1 auto; min-height: 60px; }
    .aca .op-merged { margin: 0 0 12px; padding: 10px 14px; border-radius: 4px; background: var(--warn-bg); color: var(--warn-fg); font-size: 13.5px; }
    .aca .op-merged a { color: inherit; font-weight: 600; }
    .aca .op-mg-list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 4px; margin-top: 6px; max-height: 260px; overflow-y: auto; }
    .aca .op-mg-list button { text-align: left; border: 0; border-bottom: 1px solid var(--line2); border-radius: 0; background: var(--surface); padding: 8px 12px; height: auto; white-space: normal; font-weight: 400; }
    .aca .op-mg-list button:last-child { border-bottom: 0; }
    .aca .op-gp-picked { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .aca .op-gp-sum { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 14px; }
    .aca .op-gp-sum .op-card { color: var(--muted); font-size: 13px; } .aca .op-gp-sum .op-card b { display: block; color: var(--text); font-size: 18px; font-variant-numeric: tabular-nums; }
    .aca .op-from { margin-top: 18px; border: 1px dashed var(--border); border-radius: 4px; padding: 12px 14px; font-size: 13.5px; }
    .aca .op-from h3 { margin-top: 0; }
    .aca .op-from ul { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .aca .op-covered { border-left: 3px solid var(--accent); background: var(--surface-2); padding: 8px 12px; border-radius: 0 4px 4px 0; margin-bottom: 14px; font-size: 13.5px; }
    .aca .op-mg-list button:hover { background: var(--surface-2); }
    .aca .op-mg-list .s { color: var(--muted); font-size: 12.5px; margin-left: 6px; }
    .aca .op-mg-pair { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 10px; align-items: center; margin: 4px 0 14px; }
    .aca .op-mg-pair > div { border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; font-size: 13.5px; min-width: 0; overflow-wrap: anywhere; }
    .aca .op-mg-pair > div.keep { border-color: var(--accent); }
    .aca .op-mg-pair .l { display: block; color: var(--faint); font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; margin-bottom: 2px; }
    .aca .op-mg-moves { margin: 0 0 12px; padding-left: 20px; font-size: 13.5px; }
    .aca .op-mg-moves li { margin: 2px 0; }
    @media (max-width: 760px) {
      .aca .op-mg-pair { grid-template-columns: minmax(0, 1fr); }
      .aca .op-grid { grid-template-columns: minmax(0, 1fr); }
      .aca .op-job { grid-template-columns: minmax(0, 1fr); }
      .aca .op-table.op-phone thead { display: none; }
      .aca .op-table.op-phone, .aca .op-table.op-phone tbody, .aca .op-table.op-phone tr, .aca .op-table.op-phone td { display: block; width: 100%; }
      .aca .op-table.op-phone tr { border: 1px solid var(--border); border-radius: 4px; padding: 8px 12px; margin-bottom: 8px; background: var(--surface); }
      .aca .op-table.op-phone td { border: 0; padding: 3px 0; }
      .aca .op-mails td.op-act .ra { justify-content: flex-start; padding-top: 4px; } .aca .op-mails .ra-more { width: 44px; } .aca .op-mails tr.open td, .aca .op-mails tbody tr[data-id]:hover td { background: transparent; }
      .aca .op-table.op-phone td.n { text-align: left; }
      .aca .op-table.op-phone td[data-l]::before { content: attr(data-l) ": "; color: var(--faint); font-size: 12px; }
      .aca .op-table.op-phone tr.op-prev { padding: 0; }
      .aca .op-addnote { flex-direction: column; align-items: stretch; }
    }`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    let O = null, curTab = "overview", seq = 0, loadingId = null, cache = {};
    // G: the group this partner is part of (parent) and the partners that are part of it (members)
    let G = { parent: null, members: [] };
    const MEMBER_COLS = "id,name,town,stage,audience,job_count,last_job_at,next_job_at,client_since,parent_id";
    const word = (n) => Orgs.memberWord(O, n);
    const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
    const root = () => el("panel-org");
    const parseHash = () => { const m = /^#partners\/org\/([0-9a-f-]{36})(?:\/([a-z0-9_-]+))?/i.exec(location.hash); return m ? { id: m[1], tab: m[2] || "" } : null; };
    const ALIAS = { galleries: "sales", payouts: "sales" };
    const today = () => T.today();
    const day = (d) => Fmt.day(d ? String(d).slice(0, 10) : "");
    const money = (v) => "$" + Math.round(num(v)).toLocaleString("en-US");
    const safe = (f) => { try { return f(); } catch (e) { return false; } };
    // The last day of the season a picture day falls in (winter = Dec-Feb, spring = Mar-May, summer = Jun-Jul, fall = Aug-Nov),
    // the same rule as results_season_end().
    function seasonEnd(d) {
      if (!d) return null;
      const y = +d.slice(0, 4), m = +d.slice(5, 7);
      if (m === 12) return (y + 1) + "-02-" + (((y + 1) % 4 === 0) ? "29" : "28");
      if (m <= 2) return y + "-02-" + ((y % 4 === 0) ? "29" : "28");
      if (m <= 5) return y + "-05-31";
      if (m <= 7) return y + "-07-31";
      return y + "-11-30";
    }
    // A link that leaves for a list page puts "‹ <partner>" at the top of that page (see placeTrail).
    const trailA = (href, text, style) => '<a href="' + esc(href) + '" data-trail="1"' + (style ? ' style="' + style + '"' : "") + ">" + text + "</a>";

    // ---------------------------------------------------------------- data, loaded once per partner and shared by the tabs
    // Each loader returns this partner's rows from the page-wide RPC (or [] without access). Results, rebooking and the
    // outbox are asked for this partner only (p_org, speed 2026-10-24); the filters below stay as a second check.
    function data(key) {
      if (cache[key]) return cache[key];
      const id = O.id, name = (O.name || "").toLowerCase();
      const run = {
        bookings: async () => {
          if (!canSee("bookings")) return [];
          const [b, p, s] = await Promise.all([sb.rpc("admin_bookings", { p_from: "2000-01-01", p_to: null }), sb.rpc("admin_booking_progress", { p_from: "2000-01-01", p_to: null }),
            sb.from("booking_stages").select("id,label,sort,type_key")]);
          if (b.error) throw b.error;
          const pm = {}; ((p && p.data) || []).forEach((x) => { pm[x.booking_id] = x; });
          const sm = {}; ((s && s.data) || []).forEach((x) => { sm[x.id] = x; });
          return (b.data || []).filter((x) => x.org_id === id).map((x) => Object.assign({}, x, { progress: pm[x.id] || null, stage: pm[x.id] && sm[pm[x.id].stage_id] ? sm[pm[x.id].stage_id].label : "" }))
            .sort((a, c) => String(c.picture_day || "").localeCompare(String(a.picture_day || "")));
        },
        results: async () => {
          if (!canSee("results")) return { jobs: [], terms: null };
          const [j, p] = await Promise.all([sb.rpc("results_jobs", { p_org: id }), sb.rpc("results_partners")]);
          if (j.error) throw j.error;
          return { jobs: (j.data || []).filter((x) => x.org_id === id), terms: ((p && p.data) || []).find((x) => x.id === id) || null };
        },
        rebook: async () => {
          if (!canSee("partners")) return null;
          const { data: d } = await sb.rpc("partner_rebook_list", { p_org: id });
          return (d || []).find((x) => x.org_id === id) || null;
        },
        reviews: async () => {
          if (!canSee("partners")) return [];
          const { data: d } = await sb.rpc("partner_reviews_list");
          return (d || []).filter((x) => x.org_id === id);
        },
        agreements: async () => {
          if (!canSee("agreements")) return [];
          const { data: d, error } = await sb.rpc("agreements_list");
          if (error) throw error;
          return (d || []).filter((x) => x.org_id === id);
        },
        outbox: async () => {
          if (!canSee("partners")) return [];
          const [{ data: d, error }, bks] = await Promise.all([sb.rpc("admin_outbox", { p_org: id }), data("bookings")]);
          if (error) throw error;
          const ids = new Set(bks.map((b) => b.id));
          return (d || []).filter((x) => x.org_id === id || (x.booking_id && ids.has(x.booking_id)) || (!x.org_id && (x.org || "").toLowerCase() === name));
        },
        hub: async () => {
          if (!canSee("hub")) return [];
          const [{ data: d }, bks] = await Promise.all([sb.rpc("admin_hub_activity"), data("bookings")]);
          const keys = new Set();
          bks.forEach((b) => { if (b.gotphoto_job_id) keys.add("sports:" + b.gotphoto_job_id); if (b.hub_school_id) keys.add("school:" + b.hub_school_id); });
          return (d || []).filter((x) => keys.has(x.hub + ":" + x.org_id) || (x.org || "").toLowerCase() === name);
        },
        // The members' booked jobs, for the group's Overview and Jobs tab.
        groupBookings: async () => {
          if (!canSee("bookings") || !G.members.length) return [];
          const ids = new Set(G.members.map((m) => m.id));
          const { data: d, error } = await sb.rpc("admin_bookings", { p_from: "2000-01-01", p_to: null });
          if (error) throw error;
          return (d || []).filter((x) => ids.has(x.org_id)).sort((a, c) => String(c.picture_day || "").localeCompare(String(a.picture_day || "")));
        },
        // The group's agreements, for a member page (shown when one covers its members).
        groupAgreements: async () => {
          if (!canSee("agreements") || !G.parent) return [];
          const { data: d } = await sb.rpc("agreements_list");
          return (d || []).filter((x) => x.org_id === G.parent.id);
        },
        groupContacts: async () => {
          if (!G.parent) return [];
          const { data: d } = await sb.from("prospect_contacts").select("id,first_name,last_name,email,phone,role,bounced_at,unsubscribed_at").eq("org_id", G.parent.id).order("is_primary", { ascending: false }).order("created_at");
          return d || [];
        },
        memberRebook: async () => {
          if (!canSee("partners")) return [];
          const ids = new Set(G.members.map((m) => m.id));
          const { data: d } = await sb.rpc("partner_rebook_list");
          return (d || []).filter((x) => ids.has(x.org_id));
        },
        memberSales: async () => {
          if (!canSee("results")) return null;
          const ids = new Set(G.members.map((m) => m.id));
          const { data: d } = await sb.rpc("results_jobs");
          const m = {}; (d || []).forEach((j) => { if (ids.has(j.org_id)) m[j.org_id] = (m[j.org_id] || 0) + num(j.sales); });
          return m;
        },
        contact: async () => {
          const { data: d } = await sb.from("prospect_contacts").select("first_name,last_name,email,phone,role,is_primary,bounced_at,unsubscribed_at").eq("org_id", id).order("is_primary", { ascending: false }).order("created_at").limit(5);
          return (d || []).find((c) => !c.bounced_at && !c.unsubscribed_at) || (d || [])[0] || null;
        },
        activity: async () => {
          const { data: d } = await sb.from("prospect_activities").select("id,kind,body,occurred_at,subject,meta").eq("org_id", id).order("occurred_at", { ascending: false }).limit(60);
          return d || [];
        },
      }[key];
      // A failing area shows its own error; the rest of the page still works.
      // The last copy (Snap) answers at once; when the fresh rows differ the tab is drawn again with them.
      // Not right after a fix made here (refresh()): then the tab waits for the fresh rows.
      const sk = "org:" + id + ":" + key, snap = fresh.has(key) ? null : Snap.get(sk), stamp = Saves.stamp();
      fresh.delete(key);
      const p = run().then((v) => {
        if (!O || O.id !== id || cache[key] !== shown) return v;
        if (Snap.put(sk, v) && snap !== null && Saves.stamp() === stamp) { cache[key] = Promise.resolve(v); repaint(); }
        return v;
      }, (e) => { if (snap === null && cache[key] === shown) cache[key] = null; throw e; });
      const shown = snap !== null ? Promise.resolve(snap) : p;
      if (snap !== null) p.catch(() => {});
      cache[key] = shown;
      return shown;
    }
    const fresh = new Set();
    let repaintQ = false;
    function repaint() {
      if (repaintQ) return; repaintQ = true;
      requestAnimationFrame(() => { repaintQ = false; if (!O || currentTab !== "org" || Saves.any()) return; const box = el("opBody"); const f = focusMark(box); pick(curTab); focusBack(box, f); });
    }
    const quiet = (p) => p.catch(() => null);
    // Everything we did for them: booked jobs, plus GotPhoto jobs matched to them that have no booking (older seasons).
    function allJobs(bks, res) {
      const live = (bks || []).filter((b) => b.status !== "cancelled");
      const gp = new Set(live.map((b) => String(b.gotphoto_job_id || "")).filter(Boolean));
      const extra = ((res && res.jobs) || []).filter((j) => !gp.has(String(j.id)));
      return { live, extra };
    }

    // ---------------------------------------------------------------- tabs
    function tabs() {
      const builtIn = [
        { id: "overview", label: "Overview", order: 10, render: renderOverview },
        { id: "jobs", label: "Jobs", order: 20, show: () => canSee("bookings") || canSee("results"), render: renderJobs },
        { id: "sales", label: "Sales", order: 30, module: "results", render: renderSales },
        { id: "contacts", label: "Contacts", order: 15, module: "partners", render: renderContacts },
        { id: "members", label: cap(word()) + " " + G.members.length, order: 17, show: () => G.members.length > 0, render: renderMembers },
        { id: "emails", label: "Emails & hub", order: 50, module: "partners", render: renderEmails },
        { id: "agreements", label: "Agreement & rebooking", order: 60, show: () => canSee("agreements") || canSee("partners"), render: renderAgreements },
        { id: "history", label: "Notes & history", order: 90, render: renderHistory },
      ];
      const extra = registerOrgTab.list || [];
      return builtIn.filter((b) => !extra.some((t) => t.id === b.id)).concat(extra)
        .filter((t) => (!t.module || canSee(t.module)) && (!t.show || safe(() => t.show(O))))
        .sort((a, b) => (a.order || 50) - (b.order || 50));
    }

    function show() {
      const h = parseHash();
      if (!h) { root().innerHTML = '<div class="empty">Open a partner from <a href="#partners/orgs">Partners</a> or search.</div>'; return; }
      const tab = ALIAS[h.tab] || h.tab || "overview";
      if (O && O.id === h.id) { if (tab !== curTab) pick(tab); else if (ALIAS[h.tab]) history.replaceState(null, "", orgLink(O.id, tab)); return; }
      if (loadingId === h.id) return;
      load(h.id, tab);
    }
    // Moving from one partner to another (a link on this page) doesn't change the app tab.
    window.addEventListener("hashchange", () => setTimeout(() => { if (/^#partners\/org\//.test(location.hash) && currentTab === "org") show(); }, 0));

    // The partner as last seen on this device shows at once (Snap), tabs included; fresh rows replace it when they differ.
    async function load(id, tab) {
      const my = ++seq, stamp = Saves.stamp(), snap = Snap.get("orgp:" + id);
      loadingId = id;
      Orgs.unembed();
      if (snap && snap.row && snap.row.id) { O = snap.row; G = snap.G || { parent: null, members: [] }; cache = {}; renderShell(); pick(tab || "overview"); }
      else root().innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const { data: row, error } = await (Early.take("org:" + id) || sb.from("prospect_orgs").select("*").eq("id", id).maybeSingle());
      if (my !== seq) return;
      loadingId = null;
      if (error && snap && error.code !== "42501") return; // offline or a hiccup: keep showing the last copy
      if (error || !row) {
        Snap.drop("orgp:" + id);
        root().innerHTML = '<div class="inline-error">' + esc(error ? (error.code === "42501" ? "You don't have access to partners. Ask Jeremiah to add the area on the Team page." : cleanErr(error)) : "That partner doesn't exist any more.") + "</div>";
        return;
      }
      const [par, mem] = await Promise.all([
        row.parent_id ? sb.from("prospect_orgs").select("id,name,audience").eq("id", row.parent_id).maybeSingle() : Promise.resolve({ data: null }),
        sb.from("prospect_orgs").select(MEMBER_COLS).eq("parent_id", id).is("merged_into", null).order("name")]);
      if (my !== seq) return;
      const g = { parent: (par && par.data) || null, members: (mem && mem.data) || [] };
      if (snap && Saves.stamp() !== stamp) return; // an edit started meanwhile: the screen is newer
      if (!Snap.put("orgp:" + id, { row, G: g }) && snap) return;
      O = row; G = g;
      if (!snap) cache = {};
      const f = focusMark(root()); renderShell(); pick(snap ? curTab : tab || "overview"); focusBack(root(), f);
    }

    function renderShell() {
      const facts = [
        O.audience === "school" ? "School" : O.audience === "league" ? "League" : "",
        (O.sports || []).join(", "), (O.seasons || []).join(", "),
        [O.town, O.county ? O.county + " County" : ""].filter(Boolean).join(", "),
        (O.services || []).map((s) => Orgs.SERVICE_NAME[s] || s).join(", "),
      ].filter(Boolean);
      const stCls = { client: "ok", booked: "ok", talking: "ok", contacting: "accent", not_now: "warn", do_not_contact: "err" }[O.stage] || "muted";
      root().innerHTML =
        '<p class="op-trail"><a href="#partners/orgs">Partners</a></p>' +
        '<div class="jp-head"><div><h2>' + esc(O.name) + (canEdit("partners") && !O.merged_into ? ' <button type="button" class="small quiet op-rename" data-o="rename" title="Change the partner\'s name">Rename</button>' : "") + '</h2><div class="op-meta"><span class="pill ' + stCls + '">' + esc(Orgs.stageName(O.stage)) +
        (O.client_since && (O.stage === "client" || O.stage === "booked") ? " since " + esc(String(O.client_since).slice(0, 4)) : "") + "</span>" +
        facts.map((f) => "<span>" + esc(f) + "</span>").join("") +
        (G.parent ? '<span>Part of <a href="' + esc(orgLink(G.parent.id)) + '">' + esc(G.parent.name) + "</a></span>" : "") +
        (G.members.length ? '<a href="' + esc(orgLink(O.id, "members")) + '" data-o="members">' + G.members.length + " " + esc(word(G.members.length)) + "</a>" : "") + (O.website ? '<a href="' + esc(/^https?:/.test(O.website) ? O.website : "https://" + O.website) + '" target="_blank" rel="noopener">website</a>' : "") + "</div></div>" +
        '<div class="acts">' + (O.merged_into ? "" : (canEdit("partners") ? (G.members.length ? '<button type="button" class="small" data-o="addmem">Add ' + esc(word()) + "</button>"
            : '<button type="button" class="small" data-o="partof" title="Put this partner under its district or league">Part of&#8230;</button>') + '<button type="button" class="small" data-o="merge">Merge into&#8230;</button>' : "") +
          (canEdit("bookings") ? '<button type="button" class="small primary" data-o="book">Book a job for them</button>' : "")) + "</div></div>" +
        (O.merged_into ? '<p class="op-merged">This partner was merged into another one, and everything moved there. <a href="' + esc(orgLink(O.merged_into)) + '">Open the partner we kept</a></p>' : "") +
        '<div class="jp-tabs" role="tablist" id="aca-opTabs"></div><div id="aca-opBody"></div>';
      root().querySelector(".jp-head").addEventListener("click", (e) => { if (e.target.closest('[data-o="book"]')) bookHere(); if (e.target.closest('[data-o="merge"]')) mergeInto(); if (e.target.closest('[data-o="rename"]')) renameStart();
        if (e.target.closest('[data-o="partof"]')) partOf(); if (e.target.closest('[data-o="addmem"]')) addMembers();
        const mt = e.target.closest('[data-o="members"]'); if (mt) { e.preventDefault(); pick("members"); } });
      el("opTabs").innerHTML = tabs().map((t) => '<button type="button" role="tab" data-t="' + esc(t.id) + '">' + esc(t.label) + "</button>").join("");
      el("opTabs").addEventListener("click", (e) => { const t = e.target.closest("button[data-t]"); if (t) pick(t.dataset.t); });
    }
    // Rename (2026-10-24): the name is the page heading, so it's changed right there. Enter saves, Esc puts it back.
    function renameStart() {
      const h = root().querySelector(".jp-head h2");
      h.innerHTML = '<span class="op-rn"><input type="text" id="aca-opName" value="' + esc(O.name) + '" aria-label="Partner name" />' +
        '<button type="button" class="small primary" data-rn="save">Save</button><button type="button" class="small" data-rn="cancel">Cancel</button></span>';
      const inp = el("opName"); inp.focus(); inp.select();
      const cancel = () => renderHead();
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); renameSave(); } else if (e.key === "Escape") cancel(); });
      h.querySelector('[data-rn="save"]').addEventListener("click", renameSave);
      h.querySelector('[data-rn="cancel"]').addEventListener("click", cancel);
    }
    async function renameSave() {
      const inp = el("opName"), v = inp.value.trim();
      if (!v) return toast("A partner needs a name.", true);
      if (v === O.name) return renderHead();
      inp.disabled = true;
      const { data, error } = await sb.from("prospect_orgs").update({ name: v, name_known: true }).eq("id", O.id).select("*").maybeSingle();
      if (error || !data) { inp.disabled = false; return toast("Not saved: " + (error ? cleanErr(error) : "you can't edit partners"), true); }
      toast("Renamed to " + v + ".");
      O = { ...data, name: v, name_known: true }; renderHead(); Orgs.changed(O.id);
    }
    // Draws the shell again for a new name but keeps the open tab (the tabs' own text uses the name too).
    function renderHead() { renderShell(); pick(curTab); }
    // A name changed from Edit details on Contacts updates the heading too.
    window.addEventListener("aca:partner-renamed", (e) => {
      if (!O || !e.detail || e.detail.id !== O.id) return;
      O = { ...O, name: e.detail.name };
      const h = root().querySelector(".jp-head h2");
      if (h && h.firstChild && h.firstChild.nodeType === 3) h.firstChild.nodeValue = O.name;
      const intro = el("opBody") && el("opBody").querySelector(".op-intro");
      if (intro && curTab === "contacts") intro.textContent = intro.textContent.replace(e.detail.old, O.name);
    });
    function current() { return O ? { id: O.id, name: O.name, town: O.town } : null; }
    // Book a job opens over this page; saving opens the new job's page, whose trail leads back here (2026-10-24).
    function bookHere() { const o = current(); Bookings.openNew(o); }

    // Merge into… (2026-10-24): two records for the same league or school. Pick the other one, choose which to keep,
    // see what moves, confirm. partner_merge moves everything and keeps the other record renamed, out of lists.
    function mergeInto() {
      const self = { id: O.id, name: O.name, town: O.town };
      let other = null, keepSelf = false, timer = null;
      const m = openModal('<div style="max-width:560px"><h2>Merge ' + esc(O.name) + "</h2>" +
        '<p class="op-intro">Use this when two partners are the same league or school. Find the other one, pick which name to keep, and everything moves onto it.</p>' +
        '<div id="aca-mgStep"></div></div>');
      const step = () => m.querySelector("#aca-mgStep");
      function pickStep() {
        other = null;
        step().innerHTML = '<div class="field"><label for="aca-mgQ">The other partner</label><input type="search" id="aca-mgQ" autocomplete="off" placeholder="Type a name or town" style="width:100%" /></div>' +
          '<div class="op-mg-list hidden" id="aca-mgList"></div>' +
          '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button></div>';
        const q = m.querySelector("#aca-mgQ"); q.focus();
        q.addEventListener("input", () => {
          clearTimeout(timer);
          const v = q.value.trim(), list = m.querySelector("#aca-mgList");
          if (v.length < 2) { list.classList.add("hidden"); return; }
          timer = setTimeout(async () => {
            const { data } = await sb.from("prospect_orgs").select("id, name, town, stage").is("merged_into", null).neq("id", self.id)
              .ilike("search_text", "%" + v.replace(/[%_]/g, "") + "%").order("name").limit(12);
            if (!q.isConnected || q.value.trim() !== v) return;
            list.classList.remove("hidden");
            list.innerHTML = (data || []).length ? data.map((o) => '<button type="button" data-org="' + esc(o.id) + '"><strong>' + esc(o.name) + "</strong>" +
              '<span class="s">' + esc([o.town, Orgs.stageName(o.stage)].filter(Boolean).join(", ")) + "</span></button>").join("")
              : '<div class="empty" style="padding:10px 12px">No partner matches.</div>';
            list.querySelectorAll("button[data-org]").forEach((b) => b.addEventListener("click", () => { other = data.find((o) => o.id === b.dataset.org); keepSelf = false; reviewStep(); }));
          }, 220);
        });
      }
      async function reviewStep() {
        const keep = keepSelf ? self : other, drop = keepSelf ? other : self;
        step().innerHTML = '<div class="empty"><span class="spin"></span>Checking what moves&#8230;</div>';
        const { data: p, error } = await sb.rpc("partner_merge_preview", { p_keep: keep.id, p_other: drop.id });
        if (!m.isConnected) return;
        if (error) { step().innerHTML = '<div class="inline-error">' + esc(cleanErr(error)) + '</div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="back">Back</button></div>'; return; }
        const n = (k) => Number(p[k] || 0), pl = (c, one, many) => c + " " + (c === 1 ? one : many);
        const moves = [
          n("jobs") && pl(n("jobs"), "job", "jobs"),
          n("contacts") && pl(n("contacts"), "contact", "contacts") + (n("same_people") ? " (" + pl(n("same_people"), "person is", "people are") + " already on " + keep.name + " with the same email, so they stay one person)" : ""),
          n("gotphoto_jobs") && pl(n("gotphoto_jobs"), "GotPhoto job", "GotPhoto jobs") + " for sales and payouts",
          n("agreements") && pl(n("agreements"), "agreement", "agreements"),
          n("reviews") && pl(n("reviews"), "review ask", "review asks"),
          (n("emails") || n("followups")) && "outreach emails and follow-ups",
          n("history") && pl(n("history"), "note and email in the history", "notes and emails in the history"),
          (p.gotphoto_names || []).length && "GotPhoto names (" + p.gotphoto_names.join(", ") + "), so future syncs land on " + keep.name,
          n("cal_dates") && pl(n("cal_dates"), "calendar date", "calendar dates"),
        ].filter(Boolean);
        step().innerHTML =
          '<div class="op-mg-pair"><div class="keep"><span class="l">Keep</span><strong>' + esc(keep.name) + "</strong>" + (keep.town ? '<div class="muted">' + esc(keep.town) + "</div>" : "") + "</div>" +
          '<button type="button" class="small quiet" data-m="swap" title="Keep the other one instead">&#8644; Swap</button>' +
          '<div><span class="l">Merge in, then hide</span><strong>' + esc(drop.name) + "</strong>" + (drop.town ? '<div class="muted">' + esc(drop.town) + "</div>" : "") + "</div></div>" +
          (p.blocked ? '<div class="inline-error">' + esc(p.blocked) + "</div>"
            : "<p>Moves from <strong>" + esc(drop.name) + "</strong> to <strong>" + esc(keep.name) + "</strong>:</p>" +
              (moves.length ? '<ul class="op-mg-moves">' + moves.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : '<p class="muted">Nothing is attached to it yet.</p>') +
              '<p class="op-intro">Town, website, WiFi and notes fill in where ' + esc(keep.name) + " has none. The further-along stage wins. " + esc(drop.name) +
              " isn't removed: it's renamed &ldquo;(merged into " + esc(keep.name) + ")&rdquo;, set to Do not contact and hidden from lists and search.</p>") +
          '<div class="modal-actions"><button type="button" class="small" data-m="back">Pick another</button><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button>' +
          (p.blocked ? "" : '<button type="button" class="primary" data-m="go">Merge</button>') + "</div>";
      }
      async function go(btn) {
        const keep = keepSelf ? self : other, drop = keepSelf ? other : self;
        btn.disabled = true;
        const { error } = await sb.rpc("partner_merge", { p_keep: keep.id, p_other: drop.id });
        if (error) { btn.disabled = false; toast(cleanErr(error), true); return; }
        m.close();
        toast("Merged " + drop.name + " into " + keep.name + ".");
        safe(() => Orgs.reload());
        O = null; // open the kept partner fresh, even when it's this one
        if (location.hash === orgLink(keep.id)) show(); else location.hash = orgLink(keep.id);
      }
      m.addEventListener("click", (ev) => {
        const t = ev.target.closest("[data-m]"); if (!t) return;
        const a = t.dataset.m;
        if (a === "cancel") m.close();
        else if (a === "back") pickStep();
        else if (a === "swap") { keepSelf = !keepSelf; reviewStep(); }
        else if (a === "go") go(t);
      });
      pickStep();
    }


    // ---------------------------------------------------------------- groups (2026-10-24)
    // Draws the page again after a link changed, on the same tab when it still exists.
    function reloadHere() { const id = O.id, t = curTab; O = null; load(id, t); safe(() => Orgs.reload()); }
    async function setParent(ids, parentId) {
      const { error } = await sb.from("prospect_orgs").update({ parent_id: parentId }).in("id", ids);
      if (error) throw error;
    }
    // Search box over partners for the group dialogs. filter(o) drops rows; pickFn(o) runs on a click.
    function orgSearch(m, opts) {
      let timer = null;
      const q = m.querySelector("#aca-gpQ"), list = m.querySelector("#aca-gpList");
      const draw = (rows, emptyText) => {
        list.classList.remove("hidden");
        list.innerHTML = rows.length ? rows.map((o) => '<button type="button" data-org="' + esc(o.id) + '"><strong>' + esc(o.name) + "</strong>" +
          '<span class="s">' + esc([o.town, Orgs.stageName(o.stage)].filter(Boolean).join(", ")) + "</span></button>").join("")
          : '<div class="empty" style="padding:10px 12px">' + esc(emptyText) + "</div>";
        list.querySelectorAll("button[data-org]").forEach((b) => b.addEventListener("click", () => opts.pick(rows.find((o) => o.id === b.dataset.org), b)));
      };
      const base = () => sb.from("prospect_orgs").select("id, name, town, stage, audience, parent_id").is("merged_into", null).neq("id", O.id);
      if (opts.suggest) opts.suggest(base).then((rows) => { if (!q.value.trim() && rows && rows.length) draw(rows.filter(opts.filter), ""); });
      q.addEventListener("input", () => {
        clearTimeout(timer);
        const v = q.value.trim();
        if (v.length < 2) { list.classList.add("hidden"); return; }
        timer = setTimeout(async () => {
          const { data } = await base().ilike("search_text", "%" + v.replace(/[%_]/g, "") + "%").order("name").limit(15);
          if (!q.isConnected || q.value.trim() !== v) return;
          draw((data || []).filter(opts.filter), "No partner matches.");
        }, 220);
      });
      q.focus();
    }
    // "Part of…": put this partner under a group, change it, or take it out. A partner with no group can also
    // become one from here (Add schools under it).
    function partOf() {
      const m = openModal('<div style="max-width:560px"><h2>' + esc(O.name) + " is part of&#8230;</h2>" +
        '<p class="op-intro">Pick its district or league. It stays its own partner; the group&#8217;s page lists it, and its contacts and agreement show here.</p>' +
        (G.parent ? '<div class="op-line"><span>Now part of <b>' + esc(G.parent.name) + '</b></span><span class="grow"></span><button type="button" class="small" data-g="off">Remove from ' + esc(G.parent.name) + "</button></div>" : "") +
        '<div class="field"><label for="aca-gpQ">' + (G.parent ? "Move it to another group" : "The group") + '</label><input type="search" id="aca-gpQ" autocomplete="off" placeholder="Type a name or town, like RSU 22" style="width:100%" /></div>' +
        '<div class="op-mg-list hidden" id="aca-gpList"></div>' +
        '<div class="modal-actions">' + (G.parent ? "" : '<button type="button" class="link" data-g="asgroup">Or make ' + esc(O.name) + " a group and add its " + esc(word()) + "</button>") +
        '<span class="grow"></span><button type="button" class="small" data-g="cancel">Cancel</button></div></div>');
      orgSearch(m, {
        filter: (o) => o.id !== O.id && !o.parent_id && (!G.parent || o.id !== G.parent.id),
        pick: async (o, b) => {
          b.disabled = true;
          try { await setParent([O.id], o.id); } catch (e) { b.disabled = false; return toast(cleanErr(e), true); }
          m.close(); toast(O.name + " is now part of " + o.name + "."); reloadHere();
        },
      });
      m.addEventListener("click", async (ev) => {
        const t = ev.target.closest("[data-g]"); if (!t) return;
        if (t.dataset.g === "cancel") m.close();
        if (t.dataset.g === "asgroup") { m.close(); addMembers(); }
        if (t.dataset.g === "off") {
          t.disabled = true;
          try { await setParent([O.id], null); } catch (e) { t.disabled = false; return toast(cleanErr(e), true); }
          m.close(); toast("Removed " + O.name + " from " + G.parent.name + "."); reloadHere();
        }
      });
    }
    // Add schools / teams under this partner: tick several, then Add. Partners in the same towns come first.
    function addMembers() {
      if (G.parent) return toast(O.name + " is part of " + G.parent.name + ", so it can't have its own " + word() + ". Remove it from " + G.parent.name + " first.", true);
      const picked = new Map();
      const m = openModal('<div style="max-width:560px"><h2>Add ' + esc(word()) + " to " + esc(O.name) + "</h2>" +
        '<p class="op-intro">Each one stays its own partner. Tick the ones that belong to ' + esc(O.name) + ", then Add.</p>" +
        '<div class="field"><label for="aca-gpQ">Find a partner</label><input type="search" id="aca-gpQ" autocomplete="off" placeholder="Type a name or town" style="width:100%" /></div>' +
        '<div class="op-mg-list hidden" id="aca-gpList"></div><div class="op-gp-picked" id="aca-gpPicked"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-g="cancel">Cancel</button><button type="button" class="primary" data-g="add" disabled>Add</button></div></div>');
      const drawPicked = () => {
        m.querySelector("#aca-gpPicked").innerHTML = [...picked.values()].map((o) => '<span class="og-atag">' + esc(o.name) + '<button type="button" data-un="' + esc(o.id) + '" aria-label="Take ' + esc(o.name) + ' off">&times;</button></span>').join("");
        const add = m.querySelector('[data-g="add"]'); add.disabled = !picked.size;
        add.textContent = picked.size ? "Add " + picked.size + " " + word(picked.size) : "Add";
      };
      const memberIds = new Set(G.members.map((x) => x.id));
      const towns = [...new Set([O.town].concat(G.members.map((x) => x.town)).filter(Boolean))];
      orgSearch(m, {
        filter: (o) => o.id !== O.id && !memberIds.has(o.id) && !picked.has(o.id),
        suggest: async (base) => {
          if (!towns.length) return [];
          const { data } = await base().in("town", towns).is("parent_id", null).order("name").limit(20);
          // the same kind (schools for a district) first
          return (data || []).sort((a, b) => (a.audience === O.audience ? 0 : 1) - (b.audience === O.audience ? 0 : 1));
        },
        pick: (o, b) => { picked.set(o.id, o); b.remove(); drawPicked(); },
      });
      m.addEventListener("click", async (ev) => {
        const u = ev.target.closest("[data-un]"); if (u) { picked.delete(u.dataset.un); drawPicked(); return; }
        const t = ev.target.closest("[data-g]"); if (!t) return;
        if (t.dataset.g === "cancel") m.close();
        if (t.dataset.g === "add") {
          t.disabled = true;
          try { await setParent([...picked.keys()], O.id); } catch (e) { t.disabled = false; return toast(cleanErr(e), true); }
          m.close(); toast("Added " + picked.size + " " + word(picked.size) + " to " + O.name + "."); curTab = "members"; reloadHere();
        }
      });
    }
    // The group's own tab: every member with its stage, jobs, picture days and rebooking.
    async function renderMembers(o, box) {
      loading(box);
      const [rebook, sales] = await Promise.all([quiet(data("memberRebook")), quiet(data("memberSales"))]);
      if (O !== o) return;
      const ed = canEdit("partners"), t = today();
      const due = {}; (rebook || []).forEach((r) => { if (r.open && r.status === "todo" && (!due[r.org_id] || r.due_on < due[r.org_id])) due[r.org_id] = r.due_on; });
      const clients = G.members.filter((x) => x.stage === "client" || x.stage === "booked").length;
      const jobs = G.members.reduce((n, x) => n + num(x.job_count), 0);
      const nDue = Object.keys(due).length;
      const totSales = sales ? Object.values(sales).reduce((n, v) => n + v, 0) : null;
      const pd = (d) => (d ? esc(day(d)) : '<span class="muted">&mdash;</span>');
      box.innerHTML = '<p class="op-intro">The ' + esc(word()) + " that are part of " + esc(O.name) + ". Each one is its own partner with its own contacts, jobs and emails. " +
        esc(O.name) + "&#8217;s contacts and agreement show on their pages." + (ed ? ' <button type="button" class="link" data-m="add">Add ' + esc(word()) + "</button>" : "") + "</p>" +
        '<div class="op-cards op-gp-sum">' +
          '<div class="op-card"><b>' + clients + " of " + G.members.length + "</b>" + esc(word(G.members.length)) + (clients === 1 ? " is a client" : " are clients") + "</div>" +
          '<div class="op-card"><b>' + jobs + "</b>" + (jobs === 1 ? "job" : "jobs") + " across them</div>" +
          '<div class="op-card"><b>' + nDue + "</b>due to rebook</div>" +
          (totSales != null ? '<div class="op-card"><b>' + esc(money(totSales)) + "</b>in sales, all jobs</div>" : "") + "</div>" +
        '<div class="op-wrap"><table class="op-table op-phone"><thead><tr><th>' + esc(cap(word(1))) + "</th><th>Town</th><th>Stage</th><th class=\"n\">Jobs</th><th>Last picture day</th><th>Next picture day</th><th>Rebook</th>" +
          (sales ? '<th class="n">Sales</th>' : "") + (ed ? "<th></th>" : "") + "</tr></thead><tbody>" +
        G.members.map((x) => '<tr><td data-l="' + esc(cap(word(1))) + '"><a href="' + esc(orgLink(x.id)) + '"><b>' + esc(x.name) + "</b></a></td>" +
          '<td data-l="Town">' + esc(x.town || "") + '</td><td data-l="Stage">' + esc(Orgs.stageName(x.stage)) + '</td><td data-l="Jobs" class="n">' + num(x.job_count) + "</td>" +
          '<td data-l="Last picture day">' + pd(x.last_job_at) + '</td><td data-l="Next picture day">' + (x.next_job_at && String(x.next_job_at) >= t ? pd(x.next_job_at) : '<span class="muted">Not booked</span>') + "</td>" +
          '<td data-l="Rebook">' + (due[x.id] ? '<span class="pill warn">Due ' + esc(day(due[x.id])) + "</span>" : '<span class="muted">&mdash;</span>') + "</td>" +
          (sales ? '<td data-l="Sales" class="n">' + esc(money(sales[x.id] || 0)) + "</td>" : "") +
          (ed ? '<td class="op-acts"><button type="button" class="small quiet" data-rm="' + esc(x.id) + '">Remove</button></td>' : "") + "</tr>").join("") +
        "</tbody></table></div>";
      box.onclick = async (e) => {
        if (e.target.closest('[data-m="add"]')) return addMembers();
        const r = e.target.closest("[data-rm]"); if (!r) return;
        const x = G.members.find((y) => y.id === r.dataset.rm); if (!x) return;
        r.disabled = true;
        try { await setParent([x.id], null); } catch (er) { r.disabled = false; return toast(cleanErr(er), true); }
        toast("Removed " + x.name + " from " + O.name + ".");
        if (G.members.length > 1) curTab = "members";
        reloadHere();
      };
    }

    function pick(id) {
      id = ALIAS[id] || id;
      const list = tabs();
      const t = list.find((x) => x.id === id) || list[0];
      curTab = t.id;
      const hash = orgLink(O.id, t.id === "overview" ? "" : t.id);
      if (location.hash !== hash) history.replaceState(null, "", hash);
      el("opTabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b.dataset.t === t.id ? "true" : "false"));
      Orgs.unembed();
      const body = el("opBody");
      body.innerHTML = "";
      body.onclick = null;
      try {
        const r = t.render(O, body, data);
        if (r && r.catch) r.catch((e) => { body.innerHTML = '<div class="inline-error">' + esc(cleanErr(e)) + "</div>"; });
      } catch (e) { body.innerHTML = '<div class="inline-error">' + esc(cleanErr(e)) + "</div>"; }
    }
    const goTab = (id) => pick(id);
    // After a fix made on this page: drop the cached rows and draw the tab again.
    function refresh(keys) { (keys || Object.keys(cache)).forEach((k) => { delete cache[k]; fresh.add(k); }); if (O && currentTab === "org") pick(curTab); }
    const loading = (box) => { box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>'; };

    // The shared actions behind buttons on several tabs. Resolves when done.
    async function recordPayment() {
      await Results.ensure();
      const owed = Results.jobs().filter((j) => j.org_id === O.id && j.state === "owed");
      if (!owed.length) return toast("Nothing is owed to " + O.name + " right now.");
      Results.openPay(owed.map((j) => j.id), owed.length === 1, () => refresh(["results"]));
    }
    async function changeTerms() { await Results.ensure(); Results.openTerms(O.id, () => refresh(["results"]), O.name); }
    async function copyStatement() { await Results.ensure(); Results.copyStatement(O.id); }
    function newAgreement() {
      // Schools get the agreement builder; leagues the plain agreement (sports version later).
      if (O.audience === "school" && typeof AgreementBuilder !== "undefined" && AgreementBuilder && typeof AgreementBuilder.open === "function")
        return AgreementBuilder.open(O.id, { onDone: () => refresh(["agreements"]) });
      return Follow.newAgreement(O.id);
    }
    function openAgreement(id) {
      return Follow.openAgreement(id);
    }
    async function emailVerb(row, v) {
      try { if (await Outbox.act(row, v, () => refresh(["outbox"]))) refresh(["outbox"]); }
      catch (e) { toast(cleanErr(e), true); }
    }

    // ---------------------------------------------------------------- overview
    async function renderOverview(o, box) {
      loading(box);
      const [bks, res, rebook, reviews, ags, outbox, hub, contact, acts, gbks, gags] = await Promise.all([
        quiet(data("bookings")), quiet(data("results")), quiet(data("rebook")), quiet(data("reviews")), quiet(data("agreements")),
        quiet(data("outbox")), quiet(data("hub")), quiet(data("contact")), quiet(data("activity")), quiet(data("groupBookings")), quiet(data("groupAgreements"))]);
      if (O !== o) return;
      const t = today();
      const within = (d, n) => d && T.daysBetween(t, String(d).slice(0, 10)) <= n;
      const edP = canEdit("partners"), edB = canEdit("bookings"), edR = canEdit("results");
      // [class, tag, text, [[button label, action], ...]]: each one can be fixed from here
      const needs = [];
      (ags || []).forEach((a) => {
        if (a.coi_expires && within(a.coi_expires, 30)) needs.push(["err", "Agreement", "The insurance certificate on file " + (a.coi_expires < t ? "expired " : "expires ") + day(a.coi_expires) + ".", [["Open the agreement", "ag:" + a.id]]]);
        if (a.status === "sent" || a.status === "viewed") needs.push(["warn", "Agreement", "“" + (a.title || "Agreement") + "” was sent " + day(a.sent_at) + " and isn’t signed yet.", [["Open the agreement", "ag:" + a.id]]]);
        if (a.status === "accepted" && a.renewal_date && within(a.renewal_date, 30)) needs.push(["warn", "Agreement", "The agreement renews " + day(a.renewal_date) + ".", canEdit("agreements") ? [["New agreement", "newag"]] : [["Open", "tab:agreements"]]]);
      });
      if (rebook && rebook.open && rebook.status === "todo") needs.push(["warn", "Rebook", "Due to rebook. Last picture day was " + day(rebook.last_date) + (rebook.last_job ? " (" + rebook.last_job + ")" : "") + ".", edP ? [["Draft rebook email", "rebook"]] : []]);
      (reviews || []).filter((r) => r.outcome === "open" && !r.email).forEach((r) => needs.push(["warn", "Review", "Ask for a review of " + (r.job || "the last job") + ".", edP ? [["Draft review ask", "review:" + r.id]] : []]));
      (outbox || []).filter((x) => x.status === "failed" || x.status === "bounced").forEach((x) => needs.push(["err", "Email", "“" + (x.subject || "An email") + "” " + (x.status === "bounced" ? "bounced" : "failed to send") + (x.to_name ? " to " + x.to_name : "") + ".",
        x.src === "booking" && x.status === "failed" && edB ? [["Send now", "send:" + x.id], ["Open the job", "job:" + x.booking_id]] : [["Open in the Outbox", "ob:" + x.id]]]));
      const toReview = (outbox || []).filter((x) => x.status === "needs_review").length;
      if (toReview) needs.push(["warn", "Outreach", toReview === 1 ? "An email is waiting for your OK." : toReview + " emails are waiting for your OK.", [["Review", "ob:"]]]);
      (hub || []).filter((h) => num(h.late_count) > 0).forEach((h) => needs.push(["err", "Hub", num(h.late_count) + (num(h.late_count) === 1 ? " hub message is" : " hub messages are") + " late for " + (h.org || "this partner") + ".", [["See the hub messages", "tab:emails"]]]));
      const owed = ((res && res.jobs) || []).filter((j) => j.state === "owed" && seasonEnd(j.picture_day) && seasonEnd(j.picture_day) < t);
      if (owed.length) needs.push(["warn", "Payout", money(owed.reduce((n, j) => n + num(j.balance), 0)) + " is owed for a season that is over.", edR ? [["Record payment", "pay"], ["Copy statement", "stmt"]] : [["Open Sales", "tab:sales"]]]);
      (bks || []).filter((b) => b.status !== "cancelled" && num(b.progress && b.progress.overdue)).forEach((b) => needs.push(["err", "Deliverable", (b.title || "A job") + " has " + num(b.progress.overdue) + " overdue deliverable" + (num(b.progress.overdue) === 1 ? "" : "s") + ".", [["Open the job", "job:" + b.id]]]));

      // A group's Coming up includes its members' jobs, each with the member's name.
      const upcoming = (bks || []).concat(gbks || []).filter((b) => b.status !== "cancelled" && String(b.picture_day || "") >= t).sort((a, b) => String(a.picture_day).localeCompare(String(b.picture_day)));
      const covering = (gags || []).find((a) => a.status === "accepted" && a.covers_members);
      const recent = (bks || []).filter((b) => b.status !== "cancelled" && String(b.picture_day || "") < t)[0];
      const jobs = (res && res.jobs) || [];
      const sales = jobs.reduce((n, j) => n + num(j.sales), 0);
      const aj = allJobs(bks, res);
      const glance = [
        ["Stage", Orgs.stageName(O.stage)],
        O.client_since ? ["Client since", day(O.client_since)] : null,
        ["Jobs with us", String(Math.max(num(O.job_count), aj.live.length + aj.extra.length))],
        O.last_job_at ? ["Last picture day", day(O.last_job_at)] : recent ? ["Last picture day", day(recent.picture_day)] : null,
        jobs.length ? ["Sales, all jobs", money(sales)] : null,
        res && canSee("results") ? ["Payout", payoutText(res.terms)] : null,
        Orgs.monthsText(O) ? ["Shoots in", Orgs.monthsText(O)] : null,
        Orgs.spText(O) ? ["School photos", Orgs.spText(O).replace(/^School photos: /, "")] : null,
        G.parent ? ["Part of", G.parent.name] : null,
        G.members.length ? [cap(word()), G.members.length + " (" + G.members.filter((x) => x.stage === "client" || x.stage === "booked").length + " clients)"] : null,
        !(ags || []).some((a) => a.status === "accepted") && covering ? ["Agreement", "Covered by " + G.parent.name + "'s"] : null,
      ].filter(Boolean);
      const others = (acts || []).filter((a) => a.kind !== "note"); // notes are in the box at the top
      const cName = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ") : "";
      // Coming up (2026-10-24 tidy): the date on the left, then the job, where, and how it's going, each on its own line.
      // The partner's name is left off the job name here since we're on their page; a member's job (on a group's page) starts with the member's name.
      const jobCard = (b) => {
        const t = b.start_at && typeof Fmt.time === "function" ? safe(() => Fmt.time(b.start_at)) : "";
        const name = b.title_label || String(b.title || "Job").replace(new RegExp("\\s*\u2022\\s*" + O.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), "") || "Job";
        const how = [b.stage ? b.stage : b.status === "tracked" ? "Tracking only" : "", b.status === "booked" && num(b.emails_total) ? num(b.emails_sent) + " of " + num(b.emails_total) + " booking emails sent" : ""].filter(Boolean).join(" \u00b7 ");
        return '<a class="op-job" href="' + jobLink(b.id) + '"><span class="d">' + esc(Fmt.days(b)) + (t ? "<small>" + esc(t) + "</small>" : "") + '</span><span><span class="h">' + (b.org_id && b.org_id !== O.id ? esc(b.org_name || "") + ": " : "") + esc(name) + "</span>" +
          (b.location ? '<span class="s">' + esc(b.location) + "</span>" : "") + (how ? '<span class="s">' + esc(how) + "</span>" : "") + "</span></a>";
      };
      // Notes first (2026-10-24, Jeremiah: notes easy to find wherever he looks at a client): this partner's notes and
      // the notes on their jobs, newest first, with an Add note box. All of them are on Notes & history.
      box.innerHTML = '<div id="aca-opNotesTop"></div><div class="op-grid"><div>' +
        '<div class="jp-sec"><h3>Needs you here</h3>' + (needs.length ? '<ul class="op-need">' + needs.map((n) => '<li class="' + n[0] + '"><span class="tag">' + esc(n[1]) + '</span><span class="t">' + esc(n[2]) +
          '</span><span class="b">' + n[3].map((x, i) => '<button type="button" class="small' + (i === 0 ? " primary" : "") + '" data-go="' + esc(x[1]) + '">' + esc(x[0]) + "</button>").join("") + "</span></li>").join("") + "</ul>"
          : '<div class="empty" style="padding:4px 0">Nothing needs you for ' + esc(O.name) + " right now.</div>") + "</div>" +
        '<div class="jp-sec"><h3>' + (upcoming.length ? "Coming up" : "Last job") + "</h3>" + (upcoming.length ? upcoming.slice(0, G.members.length ? 5 : 3).map(jobCard).join("") : recent ? jobCard(recent)
          : '<div class="empty" style="padding:4px 0">No jobs yet.' + (edB ? ' <button type="button" class="link" data-go="book">Book one</button>' : "") + "</div>") + "</div>" +
        (others.length ? '<div class="jp-sec"><h3 class="op-sechd"><span>Recent activity</span><a href="' + esc(orgLink(O.id, "history")) + '">All history &#8250;</a></h3><ul class="jp-rows">' +
          others.slice(0, 5).map((a) => '<li><span class="t">' + esc(actText(a)) + '</span><span class="r">' + esc(fmtAgo(a.occurred_at)) + "</span></li>").join("") + "</ul></div>" : "") +
        '</div><div><div class="op-side">' +
        (contact ? '<div class="jp-sec"><h3 class="op-sechd"><span>Main contact</span><a href="' + esc(orgLink(O.id, "contacts")) + '">All contacts &#8250;</a></h3><div style="font-size:13.5px"><b>' + esc(cName || contact.email) + "</b>" + (contact.role ? ", " + esc(contact.role) : "") +
          (contact.email ? '<div style="overflow-wrap:anywhere">' + esc(contact.email) + "</div>" : "") + (contact.phone ? "<div>" + esc(contact.phone) + "</div>" : "") + "</div></div>" : "") +
        '<div class="jp-sec jp-onsite" id="aca-opAddr"></div>' +
        '<div class="jp-sec jp-onsite" id="aca-opWifi"></div>' +
        '<div class="jp-sec"><h3>At a glance</h3><dl class="jp-dl">' + glance.map((g) => "<dt>" + esc(g[0]) + "</dt><dd>" + esc(g[1]) + "</dd>").join("") + "</dl></div>" +
        "</div></div></div>";
      renderAddress(); renderWifi();
      const noteJobs = aj.live.slice().sort((a, b) => String(b.picture_day || "").localeCompare(String(a.picture_day || ""))).slice(0, 12).map((b) => ({ id: b.id, title: b.title_label || b.title || "a job" }));
      Notes.box(el("opNotesTop"), { bookings: noteJobs, orgId: O.id, orgName: O.name, addTo: "org", max: 3, onAdd: () => { delete cache.activity; } });
      box.onclick = (e) => {
        const b = e.target.closest("[data-go]"); if (!b) return;
        const g = b.dataset.go, arg = g.slice(g.indexOf(":") + 1);
        if (g === "book") return bookHere();
        if (g === "rebook") return Follow.compose("rebook", O.id, () => refresh(["rebook", "outbox"]));
        if (g === "pay") return recordPayment();
        if (g === "stmt") return copyStatement();
        if (g === "newag") return newAgreement();
        if (g.startsWith("review:")) return Follow.compose("review", arg, () => refresh(["reviews", "outbox"]));
        if (g.startsWith("ag:")) return openAgreement(arg);
        if (g.startsWith("job:")) { location.hash = jobLink(arg); return; }
        if (g.startsWith("ob:")) return Outbox.focus(arg || null, O.id);
        if (g.startsWith("send:")) { const x = (outbox || []).find((r) => r.id === arg); if (x) { b.disabled = true; emailVerb(x, "sendnow"); } return; }
        if (g.startsWith("tab:")) return goTab(arg);
      };
    }
    // The partner's address (2026-10-24): where we shoot for them. The newest job's place lands here by itself, and
    // new bookings start with it. Saving here also moves upcoming jobs that still had the old one (org_address_save).
    function renderAddress(editing) {
      const box = el("opAddr"); if (!box) return;
      const can = canEdit("partners") || canEdit("bookings"), has = !!O.address;
      if (!has && !can) { box.remove(); return; }
      const head = "<h3>Address" + (can && !editing ? '<button type="button" class="small quiet" data-ad="edit">' + (has ? "Edit" : "Add") + "</button>" : "") + "</h3>";
      if (editing) {
        box.innerHTML = head + '<form id="aca-opAdForm"><label for="aca-opAdIn">Where</label><input type="text" id="aca-opAdIn" maxlength="300" value="' + esc(O.address || "") + '" placeholder="Search Google Maps or type it" />' +
          '<div class="row"><button type="submit" class="small primary">Save</button><button type="button" class="small" data-ad="cancel">Cancel</button></div></form>';
        if (typeof Places !== "undefined") Places.attach(el("opAdIn"), {});
        el("opAdIn").focus();
      } else box.innerHTML = head + (has ? '<div style="font-size:13.5px;overflow-wrap:anywhere" title="New bookings start here.">' + esc(O.address) + "</div>"
        : '<p class="muted" style="margin:0;font-size:13px">Not known yet.</p>');
      box.onclick = (e) => { const t = e.target.closest("[data-ad]"); if (t) renderAddress(t.dataset.ad === "edit"); };
      const f = el("opAdForm");
      if (f) f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector("[type=submit]"); btn.disabled = true;
        const addr = el("opAdIn").value.trim();
        const { data, error } = await sb.rpc("org_address_save", { p_org: O.id, p_address: addr });
        if (error) { btn.disabled = false; toast(cleanErr(error), true); return; }
        O.address = addr || null;
        const n = num(data && data.jobs);
        toast(n ? "Saved. " + n + (n === 1 ? " upcoming job" : " upcoming jobs") + " and the calendar got the new address." : "Saved.");
        renderAddress();
      };
    }
    // The partner's WiFi (2026-10-24): new bookings start with it, and WiFi saved on a job lands here, so it carries
    // from season to season. Saving here also updates upcoming jobs that still had the old one (org_wifi_save).
    function renderWifi(editing) {
      const box = el("opWifi"); if (!box) return;
      const can = canEdit("partners") || canEdit("bookings"), has = O.wifi_network || O.wifi_password;
      if (!has && !can) { box.remove(); return; }
      const head = "<h3>WiFi" + (can && !editing ? '<button type="button" class="small quiet" data-wf="edit">' + (has ? "Edit" : "Add") + "</button>" : "") + "</h3>";
      if (editing) {
        box.innerHTML = head + '<form id="aca-opWfForm"><label for="aca-opWfNet">Network</label><input type="text" id="aca-opWfNet" maxlength="120" value="' + esc(O.wifi_network || "") + '" />' +
          '<label for="aca-opWfPw">Password</label><input type="text" id="aca-opWfPw" maxlength="120" autocomplete="off" value="' + esc(O.wifi_password || "") + '" />' +
          '<div class="row"><button type="submit" class="small primary">Save</button><button type="button" class="small" data-wf="cancel">Cancel</button></div></form>';
        el("opWfNet").focus();
      } else box.innerHTML = head + (has ? '<dl class="jp-dl">' + (O.wifi_network ? "<dt>Network</dt><dd>" + esc(O.wifi_network) + "</dd>" : "") +
          (O.wifi_password ? '<dt>Password</dt><dd><span class="pw">' + esc(O.wifi_password) + "</span></dd>" : "") + '</dl>'
        : '<p class="muted" style="margin:0;font-size:13px">Not known yet.</p>');
      box.onclick = (e) => { const t = e.target.closest("[data-wf]"); if (t) renderWifi(t.dataset.wf === "edit"); };
      const f = el("opWfForm");
      if (f) f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector("[type=submit]"); btn.disabled = true;
        const net = el("opWfNet").value.trim(), pw = el("opWfPw").value.trim();
        const { data, error } = await sb.rpc("org_wifi_save", { p_org: O.id, p_network: net, p_password: pw });
        if (error) { btn.disabled = false; toast(cleanErr(error), true); return; }
        O.wifi_network = net || null; O.wifi_password = pw || null;
        const n = num(data && data.jobs);
        toast(n ? "Saved. " + n + (n === 1 ? " upcoming job" : " upcoming jobs") + " and the calendar got the new WiFi." : "Saved.");
        renderWifi();
      };
    }
    function payoutText(t) {
      if (!t || (t.payout_kind !== "deliverables" && t.payout_kind !== "none" && t.payout_pct == null)) return "None set";
      if (t.payout_kind === "deliverables") return "Deliverables" + (t.gets ? ": " + t.gets : "");
      if (t.payout_kind === "none") return "None";
      return num(t.payout_pct) + "% of sales";
    }
    // Plain words for every activity kind; one we don't know yet still reads as a sentence-case label.
    const KIND = { email_sent: "Email sent", history_email: "Earlier email", reply: "Reply", note: "Note", followup_set: "Follow-up set", followup_done: "Follow-up done",
      stage: "Stage changed", stage_change: "Stage changed", call: "Call", bounce: "Bounced", unsubscribe: "Unsubscribed", open: "Opened an email", email_opened: "Opened an email" };
    function kindName(k) { const s = String(k || "").replace(/_/g, " ").trim(); return KIND[k] || (s ? s[0].toUpperCase() + s.slice(1) : "Activity"); }
    function actText(a) {
      const k = kindName(a.kind);
      let body = (a.subject || a.body || "").replace(/\s+/g, " ").trim();
      const meta = a.meta || {};
      if ((a.kind === "stage_change" || a.kind === "stage") && (meta.from || meta.to)) body = (Orgs.stageName(meta.from) || meta.from || "") + " → " + (Orgs.stageName(meta.to) || meta.to || "");
      return k + (body ? ": " + (body.length > 120 ? body.slice(0, 120) + "…" : body) : "");
    }

    // ---------------------------------------------------------------- jobs
    async function renderJobs(o, box) {
      loading(box);
      const [bks, res, gbks] = await Promise.all([quiet(data("bookings")), quiet(data("results")), quiet(data("groupBookings"))]);
      if (O !== o) return;
      // A group shows its members' jobs too, unless "Only <group>'s own" is ticked.
      const withMembers = (gbks || []).length > 0 && !renderJobs.ownOnly;
      const all = (bks || []).concat(withMembers ? gbks : []), aj = allJobs(bks, res);
      const rows = all.map((b) => ({ d: String(b.picture_day || ""), html:
          '<tr><td data-l="Job"><a href="' + jobLink(b.id) + '"><b>' + esc(b.title || b.title_label || "Job") + "</b></a>" +
          (b.org_id !== O.id ? ' <a class="pill muted" href="' + esc(orgLink(b.org_id)) + '">' + esc(b.org_name || "Member") + "</a>" : "") + (b.status !== "booked" ? ' <span class="pill muted">' + esc(b.status === "tracked" ? "tracking only" : b.status) + "</span>" : "") +
          '<div class="muted" style="font-size:12.5px">' + esc(b.type_label || "") + '</div></td><td data-l="Picture day">' + esc(Fmt.days(b)) + '</td><td data-l="Stage">' + esc(b.stage || "") +
          (num(b.progress && b.progress.overdue) ? ' <span class="pill err">' + num(b.progress.overdue) + " overdue</span>" : "") + '</td><td data-l="Booking emails">' +
          (b.status === "booked" ? esc(num(b.emails_sent) + " of " + num(b.emails_total) + " sent") + (num(b.emails_failed) ? ' <span class="pill err">' + num(b.emails_failed) + " failed</span>" : "") : '<span class="muted">none</span>') +
          '</td><td data-l="Where">' + esc(b.location || "") + "</td></tr>" }))
        .concat(aj.extra.map((j) => ({ d: String(j.picture_day || ""), html:
          '<tr><td data-l="Job">' + trailA("#jobs/resjobs/job/" + O.id, "<b>" + esc(j.name || "GotPhoto job") + "</b>") + ' <span class="pill muted">GotPhoto only</span>' +
          '<div class="muted" style="font-size:12.5px">No booking in the app' + (j.sales != null ? " · " + money(j.sales) + " in sales" : "") + '</div></td><td data-l="Picture day">' + esc(day(j.picture_day, { weekday: "short" })) +
          '</td><td data-l="Stage">' + esc(j.gallery_status ? "Gallery " + j.gallery_status : "") + '</td><td data-l="Booking emails"><span class="muted">none</span></td><td data-l="Where"></td></tr>' })))
        .sort((a, b) => b.d.localeCompare(a.d));
      box.innerHTML = '<p class="op-intro">Every job for ' + esc(O.name) + (withMembers ? " and its " + esc(word()) : "") + ", newest first: booked, tracked, and older GotPhoto jobs with no booking. Click one to open it." + (canEdit("bookings") ? ' <button type="button" class="link" data-o="book">Book a job</button>' : "") + "</p>" +
        ((gbks || []).length ? '<label class="op-line" style="gap:6px"><input type="checkbox" id="aca-opOwnOnly"' + (renderJobs.ownOnly ? " checked" : "") + " /> Only " + esc(O.name) + "&#8217;s own jobs</label>" : "") +
        (rows.length ? '<div class="op-wrap"><table class="op-table op-phone"><thead><tr><th>Job</th><th>Picture day</th><th>Stage</th><th>Booking emails</th><th>Where</th></tr></thead><tbody>' + rows.map((r) => r.html).join("") + "</tbody></table></div>"
          : '<div class="empty">No jobs for ' + esc(O.name) + " yet.</div>");
      box.onclick = (e) => { if (e.target.closest('[data-o="book"]')) bookHere(); };
      const own = el("opOwnOnly"); if (own) own.onchange = () => { renderJobs.ownOnly = own.checked; renderJobs(o, box); };
    }

    // ---------------------------------------------------------------- sales (galleries and payouts, 2026-10-24)
    async function renderSales(o, box) {
      loading(box);
      const res = await data("results");
      if (O !== o) return;
      const ed = canEdit("results"), now = today();
      const t = res.terms, set = t && (t.payout_kind === "deliverables" || t.payout_kind === "none" || t.payout_pct != null);
      const owedJobs = res.jobs.filter((j) => j.state === "owed");
      const owed = owedJobs.reduce((n, j) => n + num(j.balance), 0);
      const seasons = {};
      res.jobs.forEach((j) => {
        const k = (j.season_year || "") + "|" + (j.season || "");
        const s = seasons[k] || (seasons[k] = { label: (j.season ? j.season[0].toUpperCase() + j.season.slice(1) : "") + " " + (j.season_year || ""), sales: 0, due: 0, paid: 0, balance: 0, last: null, end: seasonEnd(j.picture_day) });
        s.sales += num(j.sales); s.due += num(j.due); s.paid += num(j.paid); s.balance += num(j.balance);
        if (j.last_paid_on && (!s.last || j.last_paid_on > s.last)) s.last = j.last_paid_on;
      });
      const rows = Object.values(seasons).sort((a, b) => (b.end || "").localeCompare(a.end || ""));
      const jobs = res.jobs.slice().sort((a, b) => String(b.picture_day || "").localeCompare(String(a.picture_day || "")));
      box.innerHTML =
        '<div class="op-side op-line"><span><b>Payout:</b> ' + esc(set ? payoutText(t) : "none") + "</span>" +
          (ed ? '<button type="button" class="link small" data-s="terms">' + (set ? "Change" : "Set terms") + "</button>" : "") +
          '<span class="grow"></span>' +
          (owed > 0.005 ? '<span class="pill warn">' + money(owed) + " owed</span>" + (ed ? '<button type="button" class="small primary" data-s="pay">Record payment</button>' : "") : "") +
          (ed && res.jobs.length ? '<button type="button" class="small" data-s="stmt">Copy statement</button>' : "") +
          trailA("#jobs/resjobs/" + (owed > 0.005 ? "owed" : "season") + "/" + O.id, "All sales", "font-size:13px") + "</div>" +
        '<div class="jp-sec"><h3>By season</h3>' + (rows.length ? '<div class="op-wrap"><table class="op-table op-phone"><thead><tr><th>Season</th><th class="n">Sales</th><th class="n">Payout</th><th class="n">Paid</th><th>Status</th></tr></thead><tbody>' + rows.map((s) =>
          '<tr><td data-l="Season"><b>' + esc(s.label) + '</b></td><td class="n" data-l="Sales">' + money(s.sales) + '</td><td class="n" data-l="Payout">' + money(s.due) + '</td><td class="n" data-l="Paid">' + money(s.paid) + '</td><td data-l="Status">' +
          (s.balance > 0.005 ? (s.end && s.end < now ? '<span class="pill warn">' + money(s.balance) + " owed</span>" : '<span class="muted">' + money(s.balance) + " when the season is over</span>")
            : s.due > 0 ? '<span class="pill ok">Paid' + (s.last ? " " + esc(day(s.last)) : "") + "</span>" : '<span class="muted">Nothing owed</span>') + "</td></tr>").join("") + "</tbody></table></div>"
          : '<div class="empty" style="padding:4px 0">No sales recorded for ' + esc(O.name) + " yet.</div>") + "</div>" +
        (jobs.length ? '<div class="jp-sec"><h3>By job</h3><div class="op-cards">' + jobs.map((j) => '<div class="op-card"><div class="h"><span>' + esc(j.name) + '</span><span class="pill ' + (j.gallery_status === "published" ? "ok" : "muted") + '">' + esc(j.gallery_status || "") + "</span></div>" +
          '<div class="nums"><div><b>' + (j.sales == null ? "—" : money(j.sales)) + "</b>sales</div><div><b>" + (j.orders == null ? "—" : num(j.orders)) + "</b>orders</div><div><b>" + esc(day(j.picture_day, { year: undefined }) || "—") + "</b>picture day</div></div></div>").join("") + "</div>" +
          '<p class="op-intro" style="margin-top:10px">A gallery that belongs here but isn’t listed can be matched by hand on ' + trailA("#jobs/resjobs/job", "Sales by job") + ".</p></div>" : "");
      box.onclick = (e) => {
        const b = e.target.closest("[data-s]"); if (!b) return;
        if (b.dataset.s === "terms") changeTerms();
        if (b.dataset.s === "pay") recordPayment();
        if (b.dataset.s === "stmt") copyStatement();
      };
    }

    // ---------------------------------------------------------------- contacts (the old side panel, contacts first)
    async function renderContacts(o, box) {
      box.innerHTML = '<p class="op-intro">The people at ' + esc(O.name) + ", who gets booking emails and hub reminders, and the coaches on their jobs. Notes and the history are on Notes & history.</p><div id=\"aca-opPanel\"></div>" +
        (G.parent ? '<div class="op-from" id="aca-opFrom"></div>' : "");
      await Promise.all([Orgs.embed(o.id, el("opPanel")), G.parent ? renderFromGroup(o) : null]);
    }
    // A member's Contacts tab shows its group's people, read only: shown here, never copied (2026-10-24).
    async function renderFromGroup(o) {
      const cs = await quiet(data("groupContacts"));
      const box = el("opFrom"); if (O !== o || !box) return;
      const p = G.parent, who = (c) => [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Someone";
      box.innerHTML = "<h3>From " + esc(p.name) + '</h3><p class="op-intro" style="margin:0 0 8px">Shown here, not copied. They aren&#8217;t on ' + esc(O.name) + "&#8217;s booking emails unless you add them above.</p>" +
        ((cs || []).length ? "<ul>" + cs.map((c) => "<li><b>" + esc(who(c)) + "</b>" + (c.role ? ", " + esc(c.role) : "") +
          (c.email ? ' &middot; <span class="mono">' + esc(c.email) + "</span>" : "") + (c.phone ? " &middot; " + esc(c.phone) : "") +
          (c.bounced_at ? ' <span class="pill err">bounced</span>' : c.unsubscribed_at ? ' <span class="pill muted">unsubscribed</span>' : "") + "</li>").join("") + "</ul>"
          : '<p class="muted" style="margin:0 0 6px">' + esc(p.name) + " has no contacts yet.</p>") +
        '<a href="' + esc(orgLink(p.id, "contacts")) + '">Open ' + esc(p.name) + "&#8217;s contacts</a>";
    }

    // ---------------------------------------------------------------- emails & hub
    const OB_ST = { sent: ["ok", "Sent"], waiting: ["muted", "Waiting"], scheduled: ["muted", "Scheduled"], needs_review: ["warn", "Waiting for your OK"], held: ["warn", "Held"], failed: ["err", "Failed"], bounced: ["err", "Bounced"], skipped: ["muted", "Not sent"] };
    const OB_SRC = { booking: "Booking", outreach: "Outreach", hub: "Hub", partner: "Follow-up", digest: "Digest", makeup: "Makeup" };
    async function renderEmails(o, box) {
      loading(box);
      const [ob, hub] = await Promise.all([data("outbox"), quiet(data("hub"))]);
      if (O !== o) return;
      const rows = ob.slice().sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
      const byId = {}; rows.forEach((x) => { byId[x.id] = x; });
      box.innerHTML = '<p class="op-intro">What is going out to ' + esc(O.name) + " and what went out lately: booking emails, outreach, follow-ups and hub reminders. " +
        '<a href="#partners/outbox/' + esc(O.id) + '">Open in the Outbox</a>.</p>' +
        '<div class="jp-sec"><h3>Emails</h3>' + (rows.length ? '<div class="op-wrap"><table class="op-table op-phone op-mails"><thead><tr><th>When</th><th>Kind</th><th>Subject</th><th>To</th><th>Status</th><th></th></tr></thead><tbody>' + rows.map((x) => {
          const s = OB_ST[x.status] || ["muted", x.status || ""];
          // One main button (Send now or Resend), the rest in the ... menu; a click on the row opens the email.
          const verbs = Outbox.verbList(x, { inPartner: true });
          const main = verbs.length && ["osend", "sendnow", "resend"].includes(verbs[0].v) ? verbs.shift() : null;
          if (main) main.primary = ["failed", "needs_review", "bounced"].includes(x.status);
          return '<tr data-id="' + esc(x.id) + '" title="Click to read the email"><td data-l="When" style="white-space:nowrap">' + esc(x.at ? Fmt.day(x.at) : "") + '</td><td data-l="Kind">' + esc(OB_SRC[x.src] || x.src || "") + '</td><td data-l="Subject"><span class="sl-chev"></span>' + esc(x.subject || "") +
            (x.detail ? '<div class="muted" style="font-size:12.5px">' + esc(x.detail) + "</div>" : "") + '</td><td data-l="To" class="op-to">' + esc(x.to_name || x.to_email || "") + '</td><td data-l="Status"><span class="pill ' + s[0] + '">' + esc(s[1]) + "</span>" +
            (x.error ? '<div class="muted" style="font-size:12.5px">' + esc(x.error) + "</div>" : "") + '</td><td class="op-act">' + rowActs(main, verbs.concat([{ v: "preview", label: "Preview" }])) + "</td></tr>";
        }).join("") + "</tbody></table></div>" : '<div class="empty" style="padding:4px 0">Nothing in the Outbox for ' + esc(O.name) + ".</div>") + "</div>" +
        (canSee("hub") ? '<div class="jp-sec"><h3>Hub messages</h3>' + ((hub || []).length ? (hub || []).map((h) => '<div style="margin-bottom:12px"><div style="font-size:13.5px;margin-bottom:4px"><b>' + esc(h.org || "") + "</b> " +
          '<span class="muted">' + esc(h.hub === "school" ? "School hub" : "Sports hub") + (h.picture_day ? " · picture day " + esc(day(h.picture_day, { year: undefined })) : "") + "</span>" +
          (num(h.late_count) ? ' <span class="pill err">' + num(h.late_count) + " late</span>" : "") + "</div>" +
          ((h.sends || []).length ? '<table class="op-table"><tbody>' + h.sends.map((s) => "<tr><td>" + esc(s.title || "") + "</td><td>" + esc(s.date ? day(s.date, { year: undefined }) : "On booking") + '</td><td><span class="pill ' +
            ({ grabbed: "ok", late: "err", due: "accent", missed: "warn" }[s.status] || "muted") + '">' + esc({ grabbed: "Grabbed", late: "Late", due: "Due today", upcoming: "Not due yet", waiting: "Gallery not live yet", missed: "Not grabbed" }[s.status] || s.status) + "</span></td></tr>").join("") + "</tbody></table>" : "") +
          "</div>").join("") : '<div class="empty" style="padding:4px 0">No hub messages for ' + esc(O.name) + ".</div>") + "</div>" : "");
      box.onclick = async (e) => {
        const b = e.target.closest("button[data-v]");
        if (!b && (e.target.closest("button, a, .ra") || String(window.getSelection() || ""))) return;
        const tr = (b || e.target).closest("tr[data-id]"), x = tr && byId[tr.dataset.id]; if (!x) return;
        if (!b || b.dataset.v === "preview") {
          const open = tr.nextElementSibling && tr.nextElementSibling.classList.contains("op-prev");
          tr.classList.toggle("open", !open);
          if (open) { tr.nextElementSibling.remove(); return; }
          const p = document.createElement("tr"); p.className = "op-prev";
          p.innerHTML = '<td colspan="6"><div class="ob-mail"><span class="spin"></span>Loading&#8230;</div></td>';
          tr.after(p);
          Outbox.preview(x, p.querySelector(".ob-mail"));
          return;
        }
        b.disabled = true;
        await emailVerb(x, b.dataset.v);
        b.disabled = false;
      };
    }

    // ---------------------------------------------------------------- agreement & rebooking
    const AG_ST = { draft: ["muted", "Draft"], sent: ["accent", "Sent"], viewed: ["accent", "Viewed"], accepted: ["ok", "Signed"], declined: ["err", "Declined"], void: ["muted", "Withdrawn"] };
    async function renderAgreements(o, box) {
      loading(box);
      const [ags, rebook, gags] = await Promise.all([canSee("agreements") ? data("agreements") : Promise.resolve([]), quiet(data("rebook")), quiet(data("groupAgreements"))]);
      if (O !== o) return;
      const t = today();
      const cur = ags.find((a) => a.status === "accepted") || ags[0];
      // A member with no signed agreement of its own is covered by its group's when that one covers its members.
      const covering = !ags.some((a) => a.status === "accepted") && (gags || []).find((a) => a.status === "accepted" && a.covers_members);
      const signed = ags.find((a) => a.status === "accepted");
      const coverLine = covering ? '<div class="op-covered">Covered by ' + esc(G.parent.name) + "&#8217;s agreement: " + esc(covering.title || "Agreement") +
          (covering.renewal_date ? ", renews " + esc(day(covering.renewal_date)) : "") + '. <button type="button" class="link" data-ag="' + esc(covering.id) + '">Open it</button></div>' : "";
      const coverBox = G.members.length && signed ? '<label class="op-line" style="gap:6px;margin-top:10px"><input type="checkbox" id="aca-opCovers"' + (signed.covers_members ? " checked" : "") +
          (canEdit("agreements") ? "" : " disabled") + " /> " + esc(signed.title || "This agreement") + " covers all " + G.members.length + " " + esc(word(G.members.length)) + " (their pages show it when they have none of their own)</label>" : "";
      const curSt = cur ? (AG_ST[cur.status] || ["muted", cur.status])[1] : "";
      box.innerHTML = (canSee("agreements") ? '<div class="jp-sec"><h3>Agreement</h3><div class="op-line"><span>' + (cur ? "<b>" + esc(curSt) + "</b>: " + esc(cur.title || "Agreement") + (cur.renewal_date ? ", renews " + esc(day(cur.renewal_date)) : "") : covering ? "No agreement of its own." : "No agreement with " + esc(O.name) + " yet.") + '</span><span class="grow"></span>' +
          (canEdit("agreements") ? '<button type="button" class="small primary" data-a="new">New agreement</button>' : "") + trailA("#partners/agreements", "All agreements", "font-size:13px") + "</div>" +
        (ags.length ? '<div class="op-cards">' + ags.map((a) => {
          const s = AG_ST[a.status] || ["muted", a.status];
          const coiLate = a.coi_expires && T.daysBetween(t, a.coi_expires) <= 30;
          return '<button type="button" class="op-card" data-ag="' + esc(a.id) + '"><div class="h"><span>' + esc(a.title || "Agreement") + '</span><span class="pill ' + s[0] + '">' + esc(s[1]) + '</span></div><dl class="jp-dl">' +
            (a.picture_day ? "<dt>Picture day</dt><dd>" + esc(day(a.picture_day)) + "</dd>" : "") +
            (a.sent_at ? "<dt>Sent</dt><dd>" + esc(day(a.sent_at)) + (a.viewed_at ? ", opened " + esc(day(a.viewed_at)) : "") + "</dd>" : "") +
            (a.renewal_date ? "<dt>Renews</dt><dd>" + esc(day(a.renewal_date)) + "</dd>" : "") +
            (a.w9_status ? "<dt>W-9</dt><dd>" + esc(String(a.w9_status).replace(/_/g, " ")) + "</dd>" : "") +
            (a.coi_status ? "<dt>Insurance</dt><dd" + (coiLate ? ' style="color:var(--err-fg);font-weight:600"' : "") + ">" + esc(String(a.coi_status).replace(/_/g, " ")) + (a.coi_expires ? ", expires " + esc(day(a.coi_expires)) : "") + "</dd>" : "") +
            "</dl></button>";
        }).join("") + "</div>" : "") + coverBox + coverLine + "</div>" : "") +
        (canSee("partners") ? '<div class="jp-sec" style="margin-top:20px"><h3>Rebooking</h3>' + (rebook ? '<dl class="jp-dl"><dt>Last picture day</dt><dd>' + esc(day(rebook.last_date) || "—") + "</dd><dt>Ask by</dt><dd>" + esc(day(rebook.due_on) || "—") + "</dd><dt>Status</dt><dd>" +
          esc({ todo: "To do", asked: "Asked", booked: "Booked", not_this_year: "Not this year", lost: "Lost" }[rebook.status] || rebook.status || "") + "</dd></dl>" : '<p class="op-intro">Not on the rebook list yet: it fills in after their next picture day.</p>') +
          '<div class="op-line" style="margin-top:10px">' + (canEdit("partners") ? '<button type="button" class="small" data-a="rebook">Draft rebook email</button>' : "") + trailA("#partners/rebook", "Due to rebook, everyone", "font-size:13px") + "</div></div>" : "");
      box.onclick = (e) => {
        const c = e.target.closest("[data-ag]"); if (c) return openAgreement(c.dataset.ag);
        const b = e.target.closest("[data-a]"); if (!b) return;
        if (b.dataset.a === "new") newAgreement();
        if (b.dataset.a === "rebook") Follow.compose("rebook", O.id, () => refresh(["rebook", "outbox"]));
      };
      const cv = el("opCovers");
      if (cv) cv.onchange = async () => {
        cv.disabled = true;
        const { error } = await sb.rpc("agreement_set_covers", { p_id: signed.id, p_on: cv.checked });
        cv.disabled = false;
        if (error) { cv.checked = !cv.checked; return toast(cleanErr(error), true); }
        signed.covers_members = cv.checked;
        toast(cv.checked ? "Saved. Its " + word() + " show this agreement now." : "Saved. Its " + word() + " no longer show it.");
      };
    }

    // ---------------------------------------------------------------- notes & history
    async function renderHistory(o, box) {
      box.innerHTML = '<div class="op-grid"><div>' +
        '<div class="jp-sec"><h3>Notes and activity</h3>' + (canEdit("partners") ? '<div class="op-addnote"><textarea id="aca-opNote" placeholder="Add a note about ' + esc(O.name) + '&#8230;" aria-label="New note"></textarea><button type="button" class="small primary" data-h="save">Save note</button></div>' : "") +
        '<div id="aca-opTl"><div class="empty"><span class="spin"></span>Loading&#8230;</div></div></div>' +
        '<div class="jp-sec"><h3>Job notes</h3><p class="op-intro">Notes the crew and the office left on this partner’s jobs. Add one on the job’s Notes tab.</p><div id="aca-opNotes"><div class="empty"><span class="spin"></span>Loading&#8230;</div></div></div>' +
        '</div><div><div class="jp-sec"><h3>Changes</h3><p class="op-intro">Who changed this partner, and when. Newest first.</p><div id="aca-opHist"></div></div></div></div>';
      HistoryView.render("org", o.id, el("opHist"));
      box.onclick = async (e) => {
        const b = e.target.closest('[data-h="save"]'); if (!b) return;
        const text = el("opNote").value.trim(); if (!text) { el("opNote").focus(); return; }
        b.disabled = true;
        const { error } = await sb.from("prospect_activities").insert({ org_id: O.id, kind: "note", body: text });
        b.disabled = false;
        if (error) return toast("Note not saved: " + cleanErr(error), true);
        toast("Note saved");
        Notes.forget(null, O.id);
        refresh(["activity"]);
      };
      const [acts, bks] = await Promise.all([quiet(data("activity")), quiet(data("bookings"))]);
      if (O !== o) return;
      const tl = el("opTl");
      if (tl) tl.innerHTML = (acts || []).length ? '<ul class="op-tl">' + acts.map((a) => {
        const body = (a.kind === "stage_change" || a.kind === "stage") ? actText(a).replace(/^[^:]*:\s*/, "") : [a.subject, a.body].filter(Boolean).join("\n");
        return '<li><div class="h"><b>' + esc(kindName(a.kind)) + '</b><span class="muted">' + esc(day(a.occurred_at)) + "</span></div>" + (body ? '<div class="b">' + esc(body.length > 600 ? body.slice(0, 600) + "…" : body) + "</div>" : "") + "</li>";
      }).join("") + "</ul>" : '<div class="empty" style="padding:4px 0">No notes or activity yet.</div>';
      const recent = (bks || []).filter((b) => b.status !== "cancelled").slice(0, 8);
      const lists = await Promise.all(recent.map((b) => sb.rpc("job_notes_list", { p_booking: b.id }).then((r) => (r.data || []).map((n) => Object.assign({ job: b }, n)), () => [])));
      if (O !== o) return;
      const notes = lists.flat().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const box2 = el("opNotes"); if (!box2) return;
      box2.innerHTML = notes.length ? '<ul class="jp-notes">' + notes.slice(0, 30).map((n) => '<li><div class="h"><b>' + esc(n.author_name || "Someone") + '</b><span class="muted">' + esc(fmtAgo(n.created_at)) + ' · <a href="' +
        jobLink(n.job.id, "notes") + '">' + esc(n.job.title || "a job") + '</a></span></div><div class="b">' + esc(n.body) + "</div></li>").join("") + "</ul>"
        : '<div class="empty" style="padding:4px 0">No job notes yet.</div>';
    }

    // ---------------------------------------------------------------- "‹ <partner>" on the list page a link leads to
    let trail = null, trailTab = null;
    function placeTrail() {
      document.querySelectorAll(".op-backtrail").forEach((n) => n.remove());
      if (!trail || currentTab === "org") { trail = null; return; }
      const p = el("panel-" + currentTab); if (!p) return;
      const d = document.createElement("p"); d.className = "op-trail op-backtrail";
      d.innerHTML = '<a href="' + esc(orgLink(trail.id, trail.tab === "overview" ? "" : trail.tab)) + '">&#8249; ' + esc(trail.name) + "</a>";
      p.insertBefore(d, p.firstChild);
      trailTab = currentTab;
    }
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a[data-trail]");
      if (!a || !O || currentTab !== "org") return;
      trail = { id: O.id, name: O.name, tab: curTab };
      setTimeout(placeTrail, 60);
    }, true);
    window.addEventListener("hashchange", () => setTimeout(() => {
      if (trailTab && currentTab !== trailTab) { document.querySelectorAll(".op-backtrail").forEach((n) => n.remove()); trailTab = null; trail = null; }
    }, 0));

    return { show, current, open: (id, tab) => { location.hash = orgLink(id, tab); }, leave: () => Orgs.unembed(), refresh: () => refresh() };
  })();
