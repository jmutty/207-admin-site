  // ================================================================ ORGANIZATIONS: Organization page (2026-10-23)
  // Everything about one league or school on one screen, at #partners/org/<org id>[/<tab>]: Overview, Jobs, Galleries,
  // Contacts & outreach, Emails & hub, Agreements, Payouts, Notes & history. Rows on Organizations, search, links in
  // jobs and old #partners/orgs/<id> links all open it. Book a job (top bar or this page) starts with the organization picked.
  // Each tab reads the same RPCs as its own page (admin_bookings, results_jobs, agreements_list, admin_outbox, ...)
  // and keeps this organization's rows, so every tab shows only what that person may see on that page.
  // The Contacts & outreach tab is the old Organizations side panel, moved in (Orgs.embed / Orgs.unembed).
  //
  // Other modules add a tab from their own file, the same way as job tabs:
  //   if (typeof registerOrgTab === "function") registerOrgTab({ id: "x", label: "X", order: 55, module: "inventory", render: (org, el, data) => { ... } });
  // Built-in orders: overview 10, jobs 20, galleries 30, contacts 40, emails 50, agreements 60, payouts 70, history 90.
  function registerOrgTab(t) { (registerOrgTab.list || (registerOrgTab.list = [])).push(t); }
  // A link to an organization's page, for other modules: '<a href="' + orgLink(id) + '">'.
  function orgLink(id, tab) { return "#partners/org/" + encodeURIComponent(id) + (tab ? "/" + tab : ""); }

  registerPage({ id: "org", group: "Work", section: "partners", module: "partners", hidden: true, navAs: "orgs",
                 tabs: [["org", "Organization"]], onShow: () => OrgPage.show() });

  const OrgPage = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .op-trail { margin: 0 0 8px; font-size: 13px; color: var(--muted); } .aca .op-trail a { color: var(--muted); }
    .aca .op-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; color: var(--muted); font-size: 13.5px; margin-top: 4px; }
    .aca .op-need { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .aca .op-need li { display: flex; gap: 10px; align-items: baseline; padding: 9px 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); font-size: 13.5px; }
    .aca .op-need li .tag { flex: 0 0 auto; font-size: 11.5px; font-weight: 700; padding: 1px 7px; border-radius: 3px; background: var(--warn-bg); color: var(--warn-fg); }
    .aca .op-need li.err .tag { background: var(--err-bg); color: var(--err-fg); }
    .aca .op-need li .t { flex: 1 1 auto; min-width: 0; }
    .aca .op-need li button { flex: 0 0 auto; }
    .aca .op-job { display: block; padding: 12px 14px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text); text-decoration: none; margin-bottom: 8px; }
    .aca .op-job:hover { border-color: var(--accent); }
    .aca .op-job .h { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-weight: 600; }
    .aca .op-job .h .muted { font-weight: 400; }
    .aca .op-job .s { color: var(--muted); font-size: 13px; margin-top: 4px; }
    .aca .op-side { background: var(--surface-2); border-radius: 4px; padding: 14px 16px; }
    .aca .op-table { width: 100%; font-size: 13.5px; border-collapse: collapse; }
    .aca .op-table th { text-align: left; font-size: 12px; color: var(--faint); font-weight: 600; padding: 7px 12px 7px 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
    .aca .op-table td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--line2); vertical-align: top; }
    .aca .op-table td.n, .aca .op-table th.n { text-align: right; font-variant-numeric: tabular-nums; }
    .aca .op-wrap { overflow-x: auto; }
    .aca .op-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .aca .op-card { border: 1px solid var(--border); border-radius: 4px; background: var(--surface); padding: 12px 14px; font-size: 13.5px; }
    .aca .op-card .h { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; margin-bottom: 8px; }
    .aca .op-card .nums { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; color: var(--muted); font-size: 12.5px; }
    .aca .op-card .nums b { display: block; color: var(--text); font-size: 17px; font-variant-numeric: tabular-nums; }
    .aca .op-intro { color: var(--muted); font-size: 13px; margin: 0 0 12px; max-width: 760px; }`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    let O = null, curTab = "overview", seq = 0, loadingId = null, cache = {};
    const root = () => el("panel-org");
    const parseHash = () => { const m = /^#partners\/org\/([0-9a-f-]{36})(?:\/([a-z0-9_-]+))?/i.exec(location.hash); return m ? { id: m[1], tab: m[2] || "" } : null; };
    const today = () => T.today();
    const day = (d, o) => (d ? T.fmtDay(String(d).slice(0, 10), Object.assign({ month: "short", day: "numeric", year: "numeric" }, o || {})) : "");
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

    // ---------------------------------------------------------------- data, loaded once per organization and shared by the tabs
    // Each loader returns this organization's rows from the page-wide RPC (or [] without access).
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
          const [j, p] = await Promise.all([sb.rpc("results_jobs"), sb.rpc("results_partners")]);
          if (j.error) throw j.error;
          return { jobs: (j.data || []).filter((x) => x.org_id === id), terms: ((p && p.data) || []).find((x) => x.id === id) || null };
        },
        rebook: async () => {
          if (!canSee("partners")) return null;
          const { data: d } = await sb.rpc("partner_rebook_list");
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
          const [{ data: d, error }, bks] = await Promise.all([sb.rpc("admin_outbox"), data("bookings")]);
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
        contact: async () => {
          const { data: d } = await sb.from("prospect_contacts").select("first_name,last_name,email,phone,role,is_primary,bounced_at,unsubscribed_at").eq("org_id", id).order("is_primary", { ascending: false }).order("created_at").limit(5);
          return (d || []).find((c) => !c.bounced_at && !c.unsubscribed_at) || (d || [])[0] || null;
        },
        activity: async () => {
          const { data: d } = await sb.from("prospect_activities").select("kind,body,occurred_at,subject").eq("org_id", id).order("occurred_at", { ascending: false }).limit(8);
          return d || [];
        },
      }[key];
      // A failing area shows its own error; the rest of the page still works.
      cache[key] = run().catch((e) => { cache[key] = null; throw e; });
      return cache[key];
    }
    const quiet = (p) => p.catch(() => null);

    // ---------------------------------------------------------------- tabs
    function tabs() {
      const builtIn = [
        { id: "overview", label: "Overview", order: 10, render: renderOverview },
        { id: "jobs", label: "Jobs", order: 20, module: "bookings", render: renderJobs },
        { id: "galleries", label: "Galleries", order: 30, module: "results", render: renderGalleries },
        { id: "contacts", label: "Contacts & outreach", order: 40, module: "partners", render: renderContacts },
        { id: "emails", label: "Emails & hub", order: 50, module: "partners", render: renderEmails },
        { id: "agreements", label: "Agreements", order: 60, module: "agreements", render: renderAgreements },
        { id: "payouts", label: "Payouts", order: 70, module: "results", render: renderPayouts },
        { id: "history", label: "Notes & history", order: 90, render: renderHistory },
      ];
      const extra = registerOrgTab.list || [];
      return builtIn.filter((b) => !extra.some((t) => t.id === b.id)).concat(extra)
        .filter((t) => (!t.module || canSee(t.module)) && (!t.show || safe(() => t.show(O))))
        .sort((a, b) => (a.order || 50) - (b.order || 50));
    }

    function show() {
      const h = parseHash();
      if (!h) { root().innerHTML = '<div class="empty">Open an organization from <a href="#partners/orgs">Organizations</a> or search.</div>'; return; }
      if (O && O.id === h.id) { if ((h.tab || "overview") !== curTab) pick(h.tab || "overview"); return; }
      if (loadingId === h.id) return;
      load(h.id, h.tab);
    }
    // Moving from one organization to another (a link on this page) doesn't change the app tab.
    window.addEventListener("hashchange", () => setTimeout(() => { if (/^#partners\/org\//.test(location.hash) && currentTab === "org") show(); }, 0));

    async function load(id, tab) {
      const my = ++seq;
      loadingId = id;
      Orgs.unembed();
      root().innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const { data: row, error } = await sb.from("prospect_orgs").select("*").eq("id", id).maybeSingle();
      if (my !== seq) return;
      loadingId = null;
      if (error || !row) {
        root().innerHTML = '<div class="inline-error">' + esc(error ? (error.code === "42501" ? "You don't have access to organizations. Ask Jeremiah to add the area on the Team page." : cleanErr(error)) : "That organization doesn't exist any more.") + "</div>";
        return;
      }
      O = row; cache = {};
      renderShell();
      pick(tab || "overview");
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
        '<p class="op-trail"><a href="#partners/orgs">Organizations</a></p>' +
        '<div class="jp-head"><div><h2>' + esc(O.name) + '</h2><div class="op-meta"><span class="pill ' + stCls + '">' + esc(Orgs.stageName(O.stage)) +
        (O.client_since && (O.stage === "client" || O.stage === "booked") ? " since " + esc(String(O.client_since).slice(0, 4)) : "") + "</span>" +
        facts.map((f) => "<span>" + esc(f) + "</span>").join("") + (O.website ? '<a href="' + esc(/^https?:/.test(O.website) ? O.website : "https://" + O.website) + '" target="_blank" rel="noopener">website</a>' : "") + "</div></div>" +
        '<div class="acts">' + (canEdit("bookings") ? '<button type="button" class="small primary" data-o="book">Book a job for them</button>' : "") + "</div></div>" +
        '<div class="jp-tabs" role="tablist" id="aca-opTabs"></div><div id="aca-opBody"></div>';
      root().querySelector(".jp-head").addEventListener("click", (e) => { if (e.target.closest('[data-o="book"]')) bookHere(); });
      el("opTabs").innerHTML = tabs().map((t) => '<button type="button" role="tab" data-t="' + esc(t.id) + '">' + esc(t.label) + "</button>").join("");
      el("opTabs").addEventListener("click", (e) => { const t = e.target.closest("button[data-t]"); if (t) pick(t.dataset.t); });
    }
    function current() { return O ? { id: O.id, name: O.name, town: O.town } : null; }
    function bookHere() { const o = current(); showTab("bookings"); Bookings.openNew(o); }

    function pick(id) {
      const list = tabs();
      const t = list.find((x) => x.id === id) || list[0];
      curTab = t.id;
      const hash = orgLink(O.id, t.id === "overview" ? "" : t.id);
      if (location.hash !== hash) history.replaceState(null, "", hash);
      el("opTabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b.dataset.t === t.id ? "true" : "false"));
      Orgs.unembed();
      const body = el("opBody");
      body.innerHTML = "";
      try {
        const r = t.render(O, body, data);
        if (r && r.catch) r.catch((e) => { body.innerHTML = '<div class="inline-error">' + esc(cleanErr(e)) + "</div>"; });
      } catch (e) { body.innerHTML = '<div class="inline-error">' + esc(cleanErr(e)) + "</div>"; }
    }
    const goTab = (id) => pick(id);
    const loading = (box) => { box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>'; };

    // ---------------------------------------------------------------- overview
    async function renderOverview(o, box) {
      loading(box);
      const [bks, res, rebook, reviews, ags, outbox, hub, contact, acts] = await Promise.all([
        quiet(data("bookings")), quiet(data("results")), quiet(data("rebook")), quiet(data("reviews")), quiet(data("agreements")),
        quiet(data("outbox")), quiet(data("hub")), quiet(data("contact")), quiet(data("activity"))]);
      if (O !== o) return;
      const t = today(), soon = T.addDays ? T.addDays(t, 30) : null;
      const within = (d, n) => d && T.daysBetween(t, String(d).slice(0, 10)) <= n;
      const needs = [];
      (ags || []).forEach((a) => {
        if (a.coi_expires && within(a.coi_expires, 30)) needs.push(["err", "Agreement", "The insurance certificate on file " + (a.coi_expires < t ? "expired " : "expires ") + day(a.coi_expires) + ".", "agreements"]);
        if (a.status === "sent" || a.status === "viewed") needs.push(["warn", "Agreement", "“" + (a.title || "Agreement") + "” was sent " + day(a.sent_at) + " and isn’t signed yet.", "agreements"]);
        if (a.status === "accepted" && a.renewal_date && within(a.renewal_date, 30)) needs.push(["warn", "Agreement", "The agreement renews " + day(a.renewal_date) + ".", "agreements"]);
      });
      if (rebook && rebook.open && rebook.status === "todo") needs.push(["warn", "Rebook", "Due to rebook. Last picture day was " + day(rebook.last_date) + (rebook.last_job ? " (" + rebook.last_job + ")" : "") + ".", "@rebook"]);
      (reviews || []).filter((r) => r.outcome === "open" && !r.email).forEach((r) => needs.push(["warn", "Review", "Ask for a review of " + (r.job || "the last job") + ".", "@reviews"]));
      (outbox || []).filter((x) => x.status === "failed" || x.status === "bounced").forEach((x) => needs.push(["err", "Email", "“" + (x.subject || "An email") + "” " + (x.status === "bounced" ? "bounced" : "failed to send") + (x.to_name ? " to " + x.to_name : "") + ".", "emails"]));
      const toReview = (outbox || []).filter((x) => x.status === "needs_review").length;
      if (toReview) needs.push(["warn", "Outreach", toReview === 1 ? "An outreach email is waiting for your review." : toReview + " outreach emails are waiting for your review.", "emails"]);
      (hub || []).filter((h) => num(h.late_count) > 0).forEach((h) => needs.push(["err", "Hub", num(h.late_count) + (num(h.late_count) === 1 ? " hub message is" : " hub messages are") + " late for " + (h.org || "this organization") + ".", "emails"]));
      const owed = ((res && res.jobs) || []).filter((j) => j.state === "owed" && seasonEnd(j.picture_day) && seasonEnd(j.picture_day) < t);
      if (owed.length) needs.push(["warn", "Payout", money(owed.reduce((n, j) => n + num(j.balance), 0)) + " is owed for a season that is over.", "payouts"]);
      (bks || []).filter((b) => b.status !== "cancelled" && num(b.progress && b.progress.overdue)).forEach((b) => needs.push(["err", "Deliverable", (b.title || "A job") + " has " + num(b.progress.overdue) + " overdue deliverable" + (num(b.progress.overdue) === 1 ? "" : "s") + ".", "job:" + b.id]));

      const upcoming = (bks || []).filter((b) => b.status !== "cancelled" && String(b.picture_day || "") >= t).sort((a, b) => String(a.picture_day).localeCompare(String(b.picture_day)));
      const recent = (bks || []).filter((b) => b.status !== "cancelled" && String(b.picture_day || "") < t)[0];
      const jobs = (res && res.jobs) || [];
      const sales = jobs.reduce((n, j) => n + num(j.sales), 0);
      const terms = res && res.terms;
      const termsText = !terms ? "" : terms.payout_kind === "deliverables" ? "Deliverables" + (terms.gets ? ": " + terms.gets : "") : terms.payout_kind === "none" ? "None" : terms.payout_pct != null ? num(terms.payout_pct) + "% of sales" : "";
      const glance = [
        ["Stage", Orgs.stageName(O.stage)],
        O.client_since ? ["Client since", day(O.client_since)] : null,
        ["Jobs with us", String(Math.max(num(O.job_count), (bks || []).filter((b) => b.status !== "cancelled").length))],
        O.last_job_at ? ["Last picture day", day(O.last_job_at)] : recent ? ["Last picture day", day(recent.picture_day)] : null,
        jobs.length ? ["Sales, all jobs", money(sales)] : null,
        termsText ? ["Payout terms", termsText] : null,
        Orgs.monthsText(O) ? ["Shoots in", Orgs.monthsText(O)] : null,
        Orgs.spText(O) ? ["School photos", Orgs.spText(O).replace(/^School photos: /, "")] : null,
      ].filter(Boolean);
      const cName = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ") : "";
      const jobCard = (b) => '<a class="op-job" href="' + jobLink(b.id) + '"><div class="h"><span>' + esc(b.title || b.title_label || "Job") + '</span><span class="muted">' + esc(day(b.picture_day, { weekday: "short" })) +
        (b.location ? " · " + esc(b.location) : "") + '</span></div><div class="s">' + esc([b.stage ? "Stage: " + b.stage : b.status === "tracked" ? "Tracking only" : "",
          b.status === "booked" ? num(b.emails_sent) + " of " + num(b.emails_total) + " booking emails sent" : ""].filter(Boolean).join(" · ")) + "</div></a>";
      box.innerHTML = '<div class="jp-grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr)"><div>' +
        '<div class="jp-sec"><h3>Needs you here</h3>' + (needs.length ? '<ul class="op-need">' + needs.map((n, i) => '<li class="' + n[0] + '"><span class="tag">' + esc(n[1]) + '</span><span class="t">' + esc(n[2]) +
          '</span><button type="button" class="link small" data-go="' + esc(n[3]) + '">Open</button></li>').join("") + "</ul>" : '<div class="empty" style="padding:4px 0">Nothing needs you for ' + esc(O.name) + " right now.</div>") + "</div>" +
        '<div class="jp-sec"><h3>' + (upcoming.length ? "Coming up" : "Last job") + "</h3>" + (upcoming.length ? upcoming.slice(0, 3).map(jobCard).join("") : recent ? jobCard(recent)
          : '<div class="empty" style="padding:4px 0">No jobs yet.' + (canEdit("bookings") ? ' <button type="button" class="link" data-go="book">Book one</button>' : "") + "</div>") + "</div>" +
        ((acts || []).length ? '<div class="jp-sec"><h3>Recent activity</h3><ul class="jp-rows">' + acts.slice(0, 6).map((a) => '<li><span class="t">' + esc(actText(a)) + '</span><span class="r">' + esc(fmtAgo(a.occurred_at)) + "</span></li>").join("") + "</ul></div>" : "") +
        '</div><div><div class="op-side">' +
        (contact ? '<div class="jp-sec" style="margin-bottom:14px"><h3>Main contact</h3><div style="font-size:13.5px"><b>' + esc(cName || contact.email) + "</b>" + (contact.role ? ", " + esc(contact.role) : "") +
          (contact.email ? '<div class="mono" style="overflow-wrap:anywhere">' + esc(contact.email) + "</div>" : "") + (contact.phone ? "<div>" + esc(contact.phone) + "</div>" : "") + "</div></div>" : "") +
        '<div class="jp-sec" style="margin:0"><h3>At a glance</h3><dl class="jp-dl">' + glance.map((g) => "<dt>" + esc(g[0]) + "</dt><dd>" + esc(g[1]) + "</dd>").join("") + "</dl></div>" +
        "</div></div></div>";
      box.onclick = (e) => {
        const b = e.target.closest("[data-go]"); if (!b) return;
        const g = b.dataset.go;
        if (g === "book") return bookHere();
        if (g.startsWith("job:")) { location.hash = jobLink(g.slice(4)); return; }
        if (g.startsWith("@")) { showTab(g.slice(1)); return; }
        goTab(g);
      };
    }
    function actText(a) {
      const k = { email_sent: "Email sent", reply: "Reply", note: "Note", followup_set: "Follow-up set", followup_done: "Follow-up done", stage: "Stage changed", call: "Call", bounce: "Bounced" }[a.kind] || String(a.kind || "").replace(/_/g, " ");
      const body = (a.subject || a.body || "").replace(/\s+/g, " ").trim();
      return k + (body ? ": " + (body.length > 120 ? body.slice(0, 120) + "…" : body) : "");
    }

    // ---------------------------------------------------------------- jobs
    async function renderJobs(o, box) {
      loading(box);
      const bks = await data("bookings");
      if (O !== o) return;
      box.innerHTML = '<p class="op-intro">Every job booked or tracked for ' + esc(O.name) + ', newest first. Click one to open it.' + (canEdit("bookings") ? ' <button type="button" class="link" data-o="book">Book a job</button>' : "") + "</p>" +
        (bks.length ? '<div class="op-wrap"><table class="op-table"><thead><tr><th>Job</th><th>Picture day</th><th>Stage</th><th>Booking emails</th><th>Where</th></tr></thead><tbody>' + bks.map((b) =>
          "<tr><td><a href=\"" + jobLink(b.id) + '"><b>' + esc(b.title || b.title_label || "Job") + "</b></a>" + (b.status !== "booked" ? ' <span class="pill muted">' + esc(b.status === "tracked" ? "tracking only" : b.status) + "</span>" : "") +
          '<div class="muted" style="font-size:12.5px">' + esc(b.type_label || "") + "</div></td><td>" + esc(day(b.picture_day, { weekday: "short" })) + "</td><td>" + esc(b.stage || "") +
          (num(b.progress && b.progress.overdue) ? ' <span class="pill err">' + num(b.progress.overdue) + " overdue</span>" : "") + "</td><td>" +
          (b.status === "booked" ? esc(num(b.emails_sent) + " of " + num(b.emails_total) + " sent") + (num(b.emails_failed) ? ' <span class="pill err">' + num(b.emails_failed) + " failed</span>" : "") : '<span class="muted">none</span>') +
          "</td><td>" + esc(b.location || "") + "</td></tr>").join("") + "</tbody></table></div>"
          : '<div class="empty">No jobs for ' + esc(O.name) + " yet.</div>");
      box.onclick = (e) => { if (e.target.closest('[data-o="book"]')) bookHere(); };
    }

    // ---------------------------------------------------------------- galleries
    async function renderGalleries(o, box) {
      loading(box);
      const res = await data("results");
      if (O !== o) return;
      const jobs = res.jobs.slice().sort((a, b) => String(b.picture_day || "").localeCompare(String(a.picture_day || "")));
      box.innerHTML = '<p class="op-intro">GotPhoto galleries matched to ' + esc(O.name) + ", with sales and orders. A gallery that belongs here but isn’t listed can be matched by hand on <a href=\"#jobs/resjobs\">Sales by job</a>.</p>" +
        (jobs.length ? '<div class="op-cards">' + jobs.map((j) => '<div class="op-card"><div class="h"><span>' + esc(j.name) + '</span><span class="pill ' + (j.gallery_status === "published" ? "ok" : "muted") + '">' + esc(j.gallery_status || "") + "</span></div>" +
          '<div class="nums"><div><b>' + (j.sales == null ? "—" : money(j.sales)) + "</b>sales</div><div><b>" + (j.orders == null ? "—" : num(j.orders)) + "</b>orders</div><div><b>" + esc(day(j.picture_day, { year: undefined }) || "—") + "</b>picture day</div></div></div>").join("") + "</div>"
          : '<div class="empty">No galleries matched to ' + esc(O.name) + " yet.</div>");
    }

    // ---------------------------------------------------------------- contacts & outreach (the old side panel)
    async function renderContacts(o, box) {
      box.innerHTML = '<p class="op-intro">The people here, the outreach emails, follow-ups and notes. Booking emails and hub messages pick their contacts from this list.</p><div id="aca-opPanel"></div>';
      await Orgs.embed(o.id, el("opPanel"));
    }

    // ---------------------------------------------------------------- emails & hub
    const OB_ST = { sent: ["ok", "Sent"], waiting: ["muted", "Waiting"], scheduled: ["muted", "Scheduled"], needs_review: ["warn", "Needs your review"], held: ["warn", "Held"], failed: ["err", "Failed"], bounced: ["err", "Bounced"], skipped: ["muted", "Skipped"] };
    const OB_SRC = { booking: "Booking", outreach: "Outreach", hub: "Hub", partner: "Follow-up", digest: "Digest" };
    async function renderEmails(o, box) {
      loading(box);
      const [ob, hub] = await Promise.all([data("outbox"), quiet(data("hub"))]);
      if (O !== o) return;
      const rows = ob.slice().sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
      box.innerHTML = '<p class="op-intro">What is going out to ' + esc(O.name) + ' and what went out lately: booking emails, outreach, follow-ups and hub reminders. <a href="#partners/outbox">The whole outbox</a>.</p>' +
        '<div class="jp-sec"><h3>Emails</h3>' + (rows.length ? '<div class="op-wrap"><table class="op-table"><thead><tr><th>When</th><th>Kind</th><th>Subject</th><th>To</th><th>Status</th></tr></thead><tbody>' + rows.map((x) => {
          const s = OB_ST[x.status] || ["muted", x.status || ""];
          return "<tr><td style=\"white-space:nowrap\">" + esc(x.at ? T.fmtDay(String(x.at).slice(0, 10), { month: "short", day: "numeric" }) : "") + "</td><td>" + esc(OB_SRC[x.src] || x.src || "") + "</td><td>" + esc(x.subject || "") +
            (x.detail ? '<div class="muted" style="font-size:12.5px">' + esc(x.detail) + "</div>" : "") + "</td><td>" + esc(x.to_name || x.to_email || "") + '</td><td><span class="pill ' + s[0] + '">' + esc(s[1]) + "</span>" +
            (x.error ? '<div class="muted" style="font-size:12.5px">' + esc(x.error) + "</div>" : "") + "</td></tr>";
        }).join("") + "</tbody></table></div>" : '<div class="empty" style="padding:4px 0">Nothing in the outbox for ' + esc(O.name) + ".</div>") + "</div>" +
        (canSee("hub") ? '<div class="jp-sec"><h3>Hub messages</h3>' + ((hub || []).length ? (hub || []).map((h) => '<div style="margin-bottom:12px"><div style="font-size:13.5px;margin-bottom:4px"><b>' + esc(h.org || "") + "</b> " +
          '<span class="muted">' + esc(h.hub === "school" ? "School hub" : "Sports hub") + (h.picture_day ? " · picture day " + esc(day(h.picture_day, { year: undefined })) : "") + "</span>" +
          (num(h.late_count) ? ' <span class="pill err">' + num(h.late_count) + " late</span>" : "") + "</div>" +
          ((h.sends || []).length ? '<table class="op-table"><tbody>' + h.sends.map((s) => "<tr><td>" + esc(s.title || "") + "</td><td>" + esc(s.date ? day(s.date, { year: undefined }) : "On booking") + '</td><td><span class="pill ' +
            ({ grabbed: "ok", late: "err", due: "accent", missed: "warn" }[s.status] || "muted") + '">' + esc({ grabbed: "Grabbed", late: "Late", due: "Due today", upcoming: "Not due yet", waiting: "Gallery not live yet", missed: "Not grabbed" }[s.status] || s.status) + "</span></td></tr>").join("") + "</tbody></table>" : "") +
          "</div>").join("") + '<a href="#jobs/hubact" style="font-size:13px">Hub activity for everyone</a>' : '<div class="empty" style="padding:4px 0">No hub messages for ' + esc(O.name) + ".</div>") + "</div>" : "");
    }

    // ---------------------------------------------------------------- agreements
    const AG_ST = { draft: ["muted", "Draft"], sent: ["accent", "Sent"], viewed: ["accent", "Viewed"], accepted: ["ok", "Signed"], declined: ["err", "Declined"], void: ["muted", "Withdrawn"] };
    async function renderAgreements(o, box) {
      loading(box);
      const [ags, rebook] = await Promise.all([data("agreements"), quiet(data("rebook"))]);
      if (O !== o) return;
      const t = today();
      box.innerHTML = '<p class="op-intro">Agreements, W-9 and insurance for ' + esc(O.name) + '. Write or send one on <a href="#partners/agreements">Agreements</a>.</p>' +
        (ags.length ? '<div class="op-cards">' + ags.map((a) => {
          const s = AG_ST[a.status] || ["muted", a.status];
          const coiLate = a.coi_expires && T.daysBetween(t, a.coi_expires) <= 30;
          return '<div class="op-card"><div class="h"><span>' + esc(a.title || "Agreement") + '</span><span class="pill ' + s[0] + '">' + esc(s[1]) + '</span></div><dl class="jp-dl">' +
            (a.picture_day ? "<dt>Picture day</dt><dd>" + esc(day(a.picture_day)) + "</dd>" : "") +
            (a.sent_at ? "<dt>Sent</dt><dd>" + esc(day(a.sent_at)) + (a.viewed_at ? ", opened " + esc(day(a.viewed_at)) : "") + "</dd>" : "") +
            (a.renewal_date ? "<dt>Renews</dt><dd>" + esc(day(a.renewal_date)) + "</dd>" : "") +
            (a.w9_status ? "<dt>W-9</dt><dd>" + esc(String(a.w9_status).replace(/_/g, " ")) + "</dd>" : "") +
            (a.coi_status ? "<dt>Insurance</dt><dd" + (coiLate ? ' style="color:var(--err-fg);font-weight:600"' : "") + ">" + esc(String(a.coi_status).replace(/_/g, " ")) + (a.coi_expires ? ", expires " + esc(day(a.coi_expires)) : "") + "</dd>" : "") +
            "</dl></div>";
        }).join("") + "</div>" : '<div class="empty">No agreements with ' + esc(O.name) + " yet.</div>") +
        (rebook ? '<div class="jp-sec" style="margin-top:20px"><h3>Rebooking</h3><dl class="jp-dl"><dt>Last picture day</dt><dd>' + esc(day(rebook.last_date) || "—") + "</dd><dt>Ask by</dt><dd>" + esc(day(rebook.due_on) || "—") + "</dd><dt>Status</dt><dd>" +
          esc({ todo: "To do", asked: "Asked", booked: "Booked", not_this_year: "Not this year", lost: "Lost" }[rebook.status] || rebook.status || "") + '</dd></dl><a href="#partners/rebook" style="font-size:13px">Due to rebook, everyone</a></div>' : "");
    }

    // ---------------------------------------------------------------- payouts
    async function renderPayouts(o, box) {
      loading(box);
      const res = await data("results");
      if (O !== o) return;
      const t = res.terms;
      const termsText = !t || (t.payout_kind !== "deliverables" && t.payout_kind !== "none" && t.payout_pct == null) ? "No terms set: their jobs pay nothing unless a job has its own percent."
        : t.payout_kind === "deliverables" ? "Deliverables instead of money" + (t.gets ? ": " + t.gets : "") + "."
        : t.payout_kind === "none" ? "Nothing." : num(t.payout_pct) + "% of sales, paid by check once the season is over.";
      const seasons = {};
      res.jobs.forEach((j) => {
        const k = (j.season_year || "") + "|" + (j.season || "");
        const s = seasons[k] || (seasons[k] = { label: (j.season ? j.season[0].toUpperCase() + j.season.slice(1) : "") + " " + (j.season_year || ""), year: num(j.season_year), season: j.season, sales: 0, due: 0, paid: 0, balance: 0, last: null, end: seasonEnd(j.picture_day) });
        s.sales += num(j.sales); s.due += num(j.due); s.paid += num(j.paid); s.balance += num(j.balance);
        if (j.last_paid_on && (!s.last || j.last_paid_on > s.last)) s.last = j.last_paid_on;
      });
      const rows = Object.values(seasons).sort((a, b) => (b.end || "").localeCompare(a.end || ""));
      const now = today();
      box.innerHTML = '<div class="op-side" style="margin-bottom:16px;display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between;align-items:center"><span><b>Terms:</b> ' + esc(termsText) + "</span>" +
        '<a href="#jobs/payouts" style="font-size:13px">' + (canEdit("results") ? "Change terms or record a payment" : "All partner payouts") + "</a></div>" +
        (rows.length ? '<div class="op-wrap"><table class="op-table"><thead><tr><th>Season</th><th class="n">Sales</th><th class="n">Payout</th><th class="n">Paid</th><th>Status</th></tr></thead><tbody>' + rows.map((s) =>
          "<tr><td><b>" + esc(s.label) + '</b></td><td class="n">' + money(s.sales) + '</td><td class="n">' + money(s.due) + '</td><td class="n">' + money(s.paid) + "</td><td>" +
          (s.balance > 0.005 ? (s.end && s.end < now ? '<span class="pill warn">' + money(s.balance) + " owed</span>" : '<span class="muted">' + money(s.balance) + " when the season is over</span>")
            : s.due > 0 ? '<span class="pill ok">Paid' + (s.last ? " " + esc(day(s.last)) : "") + "</span>" : '<span class="muted">Nothing owed</span>') + "</td></tr>").join("") + "</tbody></table></div>"
          : '<div class="empty">No sales recorded for ' + esc(O.name) + " yet.</div>");
    }

    // ---------------------------------------------------------------- notes & history
    async function renderHistory(o, box) {
      box.innerHTML = '<div class="jp-grid"><div class="jp-sec"><h3>Job notes</h3><p class="op-intro">Notes the crew and the office left on this organization’s jobs. Add one on the job’s Notes tab.</p><div id="aca-opNotes"><div class="empty"><span class="spin"></span>Loading&#8230;</div></div></div>' +
        '<div class="jp-sec"><h3>Changes</h3><p class="op-intro">Who changed this organization, and when. Newest first.</p><div id="aca-opHist"></div></div></div>';
      HistoryView.render("org", o.id, el("opHist"));
      const bks = (await quiet(data("bookings"))) || [];
      if (O !== o) return;
      const recent = bks.filter((b) => b.status !== "cancelled").slice(0, 8);
      const lists = await Promise.all(recent.map((b) => sb.rpc("job_notes_list", { p_booking: b.id }).then((r) => (r.data || []).map((n) => Object.assign({ job: b }, n)), () => [])));
      const notes = lists.flat().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const box2 = el("opNotes"); if (!box2) return;
      box2.innerHTML = notes.length ? '<ul class="jp-notes">' + notes.slice(0, 30).map((n) => '<li><div class="h"><b>' + esc(n.author_name || "Someone") + '</b><span class="muted">' + esc(fmtAgo(n.created_at)) + ' · <a href="' +
        jobLink(n.job.id, "notes") + '">' + esc(n.job.title || "a job") + '</a></span></div><div class="b">' + esc(n.body) + "</div></li>").join("") + "</ul>"
        : '<div class="empty" style="padding:4px 0">No job notes yet.</div>';
    }

    return { show, current, open: (id, tab) => { location.hash = orgLink(id, tab); }, leave: () => Orgs.unembed() };
  })();
