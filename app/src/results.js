  // ================================================================ JOBS > Sales (2026-10-22 "Season results"; one quiet Sales page 2026-10-24)
  // Sales per GotPhoto job (read hourly by the gotphoto-sales edge function, or typed in), each partner's
  // share and what has been paid, and each season against the same season last year.
  // RPCs: results_jobs (every job with its numbers; also refreshes names, picture days and organizations),
  // results_partners, results_payments, results_attention, results_save, results_set_terms, results_pay,
  // results_payment_remove. "Refresh sales" = admin function POST /sales. Migration 20261022213000.
  // Seasons: winter Dec-Feb (December counts toward the next year), spring Mar-May, summer Jun-Jul, fall Aug-Nov.
  // View = see the numbers; Edit = type in sales, set partner terms, record payments (the database enforces both).
  // One page (2026-10-24): #jobs/resjobs with a By season / By job switch, and an "Owed to partners" view that only shows up
  // when a partner is owed (payouts are rare). #jobs/resjobs/<season|job|owed>[/<partner id>]; the old #jobs/seasons and
  // #jobs/payouts open the matching view. Partner pages use Results.openTerms / openPay for their one-line payout note.
  registerPage({ id: "sales", group: "Jobs", section: "jobs", module: "results", title: "Sales",
                 tabs: [["resjobs", "Sales"]], onShow: () => Results.show() });
  registerPage({ id: "salesseasons", group: "Jobs", section: "jobs", module: "results", hidden: true, navAs: "jobs",
                 tabs: [["seasons", "Sales"]], onShow: () => Results.goto("season") });
  registerPage({ id: "salespayouts", group: "Jobs", section: "jobs", module: "results", hidden: true, navAs: "jobs",
                 tabs: [["payouts", "Sales"]], onShow: () => Results.goto("owed") });
  registerAttention("payoutsOwed", { module: "results", level: "soon", name: "partner payouts",
    one: "A partner payout is owed for a season that is over.", many: "{n} partner payouts are owed for seasons that are over." });
  registerTodayLoader("results", () => Results.loadAttention());

  const Results = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
  .aca .rs-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 0 6px; }
  .aca .rs-bar h2 { margin: 0 8px 0 0; font-size: 17px; font-weight: 600; }
  .aca .rs-bar h3 { margin: 0 8px 0 0; font-size: 15px; font-weight: 600; }
  .aca .rs-bar .grow { flex: 1; }
  .aca .rs-views { margin: 4px 0 10px; }
  .aca .rs-views button.rs-owedchip[aria-pressed="false"] { border-color: var(--warn-fg); color: var(--warn-fg); }
  .aca .rs-trail { margin: 0 0 8px; font-size: 13px; color: var(--muted); } .aca .rs-trail a { color: var(--muted); }
  .aca .rs-tag { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--accent); background: var(--sel-bg); color: var(--accent); border-radius: 999px; padding: 2px 4px 2px 10px; font-size: 12.5px; font-weight: 600; }
  .aca .rs-tag button { border: none; background: transparent; color: inherit; padding: 0 6px; font-size: 14px; line-height: 1; height: auto; }
  .aca .rs-sub { margin: 0 0 4px; color: var(--muted); font-size: 13px; }
  .aca .rs-up { color: var(--ok-fg); font-weight: 600; }
  .aca .rs-down { color: var(--err-fg); font-weight: 600; }
  .aca .rs-h { margin: 22px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
  .aca .rs-t td.r, .aca .rs-t th.r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .aca .rs-t tr.click { cursor: pointer; }
  .aca .rs-t tr.click:hover td { background: var(--surface-2); }
  .aca .rs-t td .s { display: block; color: var(--muted); font-size: 12.5px; font-weight: 400; }
  .aca .rs-t tfoot td { font-weight: 600; border-bottom: 0; }
  .aca .rs-org { margin: 0 0 18px; border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px 4px; background: var(--surface); }
  .aca .rs-orgh { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .aca .rs-orgh b { font-size: 15px; }
  .aca .rs-orgh .grow { flex: 1; }
  .aca .rs-orgh .owed { font-weight: 600; color: var(--accent); }
  .aca .rs-src { font-size: 12.5px; color: var(--muted); margin: 0 0 12px; }
  .aca .rs-pay { list-style: none; margin: 0 0 6px; padding: 0; font-size: 13.5px; }
  .aca .rs-pay li { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--line2); }
  .aca .rs-pay li .grow { flex: 1; }
  .aca .rs-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .aca .modal .field select, .aca .modal .field textarea { width: 100%; }
  .aca .modal textarea.rs-note { height: 60px; padding: 6px 10px; resize: vertical; }
  @media (max-width: 700px) { .aca .rs-row2 { grid-template-columns: 1fr; } .aca .rs-t .hide-sm { display: none; } .aca .rs-views button { min-height: 40px; } }
`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    let jobs = [], partners = [], settings = null, loadedAt = 0, loading = null;
    let seasonPick = "", payFilter = "owed", jobQ = "", jobSeason = "", jobOnlyMissing = false;
    let view = "season", payOrg = "", jobOrg = "";
    const edit = () => canEdit("results");
    const SEASONS = { winter: 1, spring: 2, summer: 3, fall: 4 };
    const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
    const seasonLabel = (season, year) => cap(season) + " " + year;
    const dollars = (n) => (n < 0 ? "-$" : "$") + Math.round(Math.abs(n)).toLocaleString("en-US");
    const cents = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtD = (d, y) => (d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", Object.assign({ timeZone: "UTC", month: "short", day: "numeric" }, y ? { year: "numeric" } : {})) : "");
    const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const KINDS = [["sport", "Sports"], ["school", "School"], ["event", "Events"], ["studio", "Studio"], ["other", "Other"]];
    const kindOf = (j) => { const p = String(j.job_type || "").split("_")[0]; return KINDS.some((k) => k[0] === p) ? p : "other"; };
    const kindLabel = (k) => (KINDS.find((x) => x[0] === k) || KINDS[4])[1];
    const STATE = { owed: ["Owed", "warn"], paid: ["Paid", "ok"], waiting: ["Waiting for sales", "muted"], none: ["No payout", "muted"] };
    const pill = (s) => '<span class="pill ' + STATE[s][1] + '">' + STATE[s][0] + "</span>";
    const change = (now, before) => {
      if (!before) return now ? '<span class="muted">new</span>' : "";
      const p = Math.round((now - before) / before * 100);
      return '<span class="' + (p >= 0 ? "rs-up" : "rs-down") + '">' + (p >= 0 ? "+" : "") + p + "%</span>";
    };
    // A partner's name, linked to their page (the partner page needs the partners module).
    const orgA = (id, name) => (id && canSee("partners") ? '<a href="' + orgLink(id) + '" data-orglink>' + esc(name) + "</a>" : esc(name));

    // ---------------------------------------------------------------- data
    async function load(force) {
      if (!force && jobs.length && Date.now() - loadedAt < 60e3) return true;
      if (loading) return loading;
      loading = (async () => {
        const [j, p, s] = await Promise.all([sb.rpc("results_jobs"), sb.rpc("results_partners"), sb.from("results_settings").select("*").maybeSingle()]);
        loading = null;
        if (j.error) throw j.error;
        jobs = Array.isArray(j.data) ? j.data : [];
        partners = Array.isArray(p.data) ? p.data : [];
        settings = s.data || null;
        loadedAt = Date.now();
        return true;
      })();
      try { return await loading; } catch (e) { loading = null; throw e; }
    }
    const n = (v) => Number(v) || 0;
    function agg(list) {
      const a = { jobs: list.length, sales: 0, orders: 0, due: 0, paid: 0, balance: 0, missing: 0 };
      list.forEach((j) => { if (j.sales == null) a.missing++; a.sales += n(j.sales); a.orders += n(j.orders); a.due += n(j.due); a.paid += n(j.paid); a.balance += n(j.balance); });
      return a;
    }
    const partnerOf = (id) => partners.find((p) => p.id === id);
    const nameOf = (id) => { const p = partnerOf(id); if (p) return p.name; const j = jobs.find((x) => x.org_id === id); return j ? j.org_name || "" : ""; };

    // ---------------------------------------------------------------- the page: one card, a view switch, a trail back to a partner
    const parseHash = () => { const m = /^#jobs\/resjobs\/(season|job|owed)(?:\/([0-9a-f-]{36}))?/i.exec(location.hash); return m ? { view: m[1].toLowerCase(), org: m[2] || "" } : null; };
    async function show() {
      const root = el("panel-resjobs");
      const h = parseHash();
      if (h) { view = h.view; if (view === "owed") payOrg = h.org; if (view === "job") jobOrg = h.org; }
      else { view = "season"; payOrg = ""; }
      if (!jobs.length) root.innerHTML = '<p class="empty">Loading&#8230;</p>';
      try { await load(); } catch (e) { root.innerHTML = '<p class="inline-error">' + esc(cleanErr(e)) + "</p>"; return; }
      render();
    }
    // The old addresses and other pages land on one view: "season", "job" or "owed" (optionally one partner).
    function goto(v, org) {
      history.replaceState(null, "", "#jobs/resjobs/" + v + (org ? "/" + org : ""));
      if (currentTab === "resjobs") show(); else showTab("resjobs");
    }
    window.addEventListener("hashchange", () => setTimeout(() => { if (currentTab === "resjobs" && /^#jobs\/resjobs/.test(location.hash)) show(); }, 0));
    function setView(v) {
      view = v;
      history.replaceState(null, "", "#jobs/resjobs" + (v === "season" ? "" : "/" + v + (v === "owed" && payOrg ? "/" + payOrg : v === "job" && jobOrg ? "/" + jobOrg : "")));
      render();
    }
    function render() {
      const root = el("panel-resjobs");
      const owedAll = agg(jobs.filter((j) => j.state === "owed"));
      if (view === "owed" && !owedAll.jobs && !partners.some(hasTerms) && !payOrg) view = "season";
      const trailOrg = view === "owed" ? payOrg : view === "job" ? jobOrg : "";
      const chip = (k, l, cls) => '<button type="button" data-view="' + k + '" aria-pressed="' + (view === k) + '"' + (cls ? ' class="' + cls + '"' : "") + ">" + l + "</button>";
      root.innerHTML = (trailOrg && canSee("partners") ? '<p class="rs-trail"><a href="' + orgLink(trailOrg, "sales") + '">&lsaquo; ' + esc(nameOf(trailOrg) || "Partner") + "</a></p>" : "") +
        '<div class="card"><div class="rs-bar"><h2>Sales</h2><span class="grow"></span>' + (edit() ? '<button type="button" class="small" id="aca-rsRefresh">Refresh sales from GotPhoto</button>' : "") + "</div>" +
        '<div class="chips rs-views" id="aca-rsViews" role="group" aria-label="Show">' + chip("season", "By season") + chip("job", "By job") +
          (owedAll.jobs || view === "owed" ? chip("owed", "Owed to partners" + (owedAll.jobs ? " &middot; " + dollars(owedAll.balance) : ""), "rs-owedchip") : "") + "</div>" +
        '<div id="aca-rsView"></div></div>';
      el("rsViews").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view); });
      const r = el("rsRefresh"); if (r) r.addEventListener("click", () => refreshSales(r));
      if (view === "owed") renderPayouts(); else if (view === "job") renderJobs(); else renderSeasons();
    }
    const rerender = () => { if (currentTab === "resjobs") render(); };

    // ---------------------------------------------------------------- By season
    function seasonOptions() {
      const keys = new Map();
      jobs.forEach((j) => { if (j.season && j.picture_day <= today()) keys.set(j.season + ":" + j.season_year, [j.season, j.season_year]); });
      const list = [...keys.values()].sort((a, b) => b[1] - a[1] || SEASONS[b[0]] - SEASONS[a[0]]);
      const years = [...new Set(list.map((x) => x[1]))];
      return { list, years };
    }
    function inPick(j, pick, yearBack) {
      const [s, y] = pick.split(":");
      if (s === "year") return j.season_year === Number(y) - yearBack;
      return j.season === s && j.season_year === Number(y) - yearBack;
    }
    function sourceLine() {
      if (!settings || !settings.last_run_at) return "Sales from GotPhoto have not been read yet. Typed-in sales show right away.";
      return "Sales read from GotPhoto " + esc(fmtAgo(settings.last_run_at)) + (settings.last_run_ok === false ? ' <span class="pill err">last read failed</span> ' + esc(settings.last_run_error || "") : "") + ".";
    }
    function renderSeasons() {
      const root = el("rsView");
      const { list, years } = seasonOptions();
      if (!list.length) { root.innerHTML = '<p class="empty">No jobs have gone on sale yet.</p>'; return; }
      if (!seasonPick || !(list.some((x) => x[0] + ":" + x[1] === seasonPick) || years.some((y) => "year:" + y === seasonPick))) seasonPick = list[0][0] + ":" + list[0][1];
      const [ps, py] = seasonPick.split(":");
      const label = ps === "year" ? py + ", every season" : seasonLabel(ps, py);
      const lastLabel = ps === "year" ? String(py - 1) : seasonLabel(ps, py - 1);
      const now = jobs.filter((j) => inPick(j, seasonPick, 0)), before = jobs.filter((j) => inPick(j, seasonPick, 1));
      const A = agg(now), B = agg(before);
      const aov = (x) => (x.orders ? x.sales / x.orders : 0);
      const tile = (num, l, s) => '<div class="tile"><div class="n tnum">' + num + '</div><div class="l">' + l + '</div><div class="s">' + s + "</div></div>";

      // by partner (either season), biggest first
      const orgs = new Map();
      const put = (j, k) => { const id = j.org_id || ""; if (!orgs.has(id)) orgs.set(id, { id, name: j.org_name || "No partner", now: [], before: [] }); orgs.get(id)[k].push(j); };
      now.forEach((j) => put(j, "now")); before.forEach((j) => put(j, "before"));
      const orgRows = [...orgs.values()].map((o) => Object.assign(o, { a: agg(o.now), b: agg(o.before) }))
        .sort((x, y) => (x.id === "") - (y.id === "") || y.a.sales - x.a.sales || y.b.sales - x.b.sales);
      const kinds = KINDS.map(([k, l]) => ({ k, l, a: agg(now.filter((j) => kindOf(j) === k)), b: agg(before.filter((j) => kindOf(j) === k)) })).filter((x) => x.a.jobs || x.b.jobs);

      root.innerHTML =
        '<div class="rs-bar"><h3>' + esc(label) + '</h3><select id="aca-rsSeason" class="small" aria-label="Season">' +
          list.map((x) => '<option value="' + esc(x[0] + ":" + x[1]) + '"' + (x[0] + ":" + x[1] === seasonPick ? " selected" : "") + ">" + esc(seasonLabel(x[0], x[1])) + "</option>").join("") +
          years.map((y) => '<option value="year:' + y + '"' + ("year:" + y === seasonPick ? " selected" : "") + ">" + y + " (whole year)</option>").join("") + "</select>" +
          '<span class="grow"></span></div>' +
        '<p class="rs-sub">Compared with ' + esc(lastLabel) + ". " + sourceLine() + (A.missing ? " " + A.missing + (A.missing === 1 ? " job has" : " jobs have") + " no sales yet." : "") + "</p>" +
        '<div class="tiles">' +
          tile(dollars(A.sales), "Sales", change(A.sales, B.sales) + " vs " + dollars(B.sales)) +
          tile(A.orders.toLocaleString("en-US"), "Orders", change(A.orders, B.orders) + " vs " + B.orders.toLocaleString("en-US")) +
          tile(dollars(aov(A)), "Average order", "was " + dollars(aov(B))) +
          tile(dollars(A.due), "Partner share", A.balance > 0.005 ? '<span class="rs-up" style="color:var(--accent)">' + cents(A.balance) + " still owed</span>" : A.due ? "all paid" : "none this season") +
        "</div>" +
        '<div class="rs-h">By partner</div>' +
        '<div class="table-wrap"><table class="rs-t"><thead><tr><th>Partner</th><th class="r">Jobs</th><th class="r">Sales</th><th class="r hide-sm">' + esc(lastLabel) + '</th><th class="r">Change</th><th class="r hide-sm">Orders</th><th class="r">Share</th></tr></thead><tbody>' +
          orgRows.map((o) => '<tr class="click" data-org="' + esc(o.id) + '" title="See these jobs"><td class="name">' + orgA(o.id, o.name) +
            (!o.now.length ? '<span class="s">Not on the books this season</span>' : "") + '</td><td class="r">' + o.a.jobs + '</td><td class="r">' + dollars(o.a.sales) +
            '</td><td class="r hide-sm">' + (o.before.length ? dollars(o.b.sales) : "") + '</td><td class="r">' + change(o.a.sales, o.b.sales) +
            '</td><td class="r hide-sm">' + o.a.orders + '</td><td class="r">' + (o.a.due ? cents(o.a.due) : "") + (o.a.balance > 0.005 ? '<span class="s">' + cents(o.a.balance) + " owed</span>" : "") + "</td></tr>").join("") +
        '</tbody></table></div>' +
        '<div class="rs-h">By kind of job</div>' +
        '<div class="table-wrap"><table class="rs-t"><thead><tr><th>Kind</th><th class="r">Jobs</th><th class="r">Sales</th><th class="r hide-sm">' + esc(lastLabel) + '</th><th class="r">Change</th><th class="r">Per job</th></tr></thead><tbody>' +
          kinds.map((x) => "<tr><td>" + esc(x.l) + '</td><td class="r">' + x.a.jobs + (x.b.jobs ? '<span class="s">was ' + x.b.jobs + "</span>" : "") + '</td><td class="r">' + dollars(x.a.sales) +
            '</td><td class="r hide-sm">' + dollars(x.b.sales) + '</td><td class="r">' + change(x.a.sales, x.b.sales) + '</td><td class="r">' + (x.a.jobs ? dollars(x.a.sales / x.a.jobs) : "") + "</td></tr>").join("") +
        "</tbody></table></div>";
      el("rsSeason").addEventListener("change", (e) => { seasonPick = e.target.value; renderSeasons(); });
      root.querySelectorAll("tr[data-org]").forEach((tr) => tr.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        jobOrg = tr.dataset.org || ""; jobQ = tr.dataset.org ? "" : "No partner"; jobSeason = seasonPick;
        setView("job");
      }));
    }

    // ---------------------------------------------------------------- Owed to partners (was Partner payouts)
    function renderPayouts() {
      const root = el("rsView");
      const want = (j) => (payFilter === "all" ? j.state !== "none" : j.state === payFilter) && (!payOrg || (j.org_id || "") === payOrg);
      const groups = new Map();
      jobs.filter(want).forEach((j) => { const id = j.org_id || ""; if (!groups.has(id)) groups.set(id, { id, name: j.org_name || "No partner", list: [] }); groups.get(id).list.push(j); });
      const list = [...groups.values()].map((g) => Object.assign(g, { a: agg(g.list) })).sort((x, y) => y.a.balance - x.a.balance || x.name.localeCompare(y.name));
      const owedAll = agg(jobs.filter((j) => j.state === "owed" && (!payOrg || (j.org_id || "") === payOrg)));
      const termed = partners.filter(hasTerms).filter((p) => !payOrg || p.id === payOrg);
      const chip = (k, l) => '<button type="button" data-f="' + k + '" aria-pressed="' + (payFilter === k) + '">' + l + "</button>";

      root.innerHTML =
        '<p class="rs-sub">' + (owedAll.jobs ? "<b>" + cents(owedAll.balance) + "</b> owed on " + owedAll.jobs + (owedAll.jobs === 1 ? " job" : " jobs") + ". " : "Nothing owed right now. ") +
          "A partner gets a percent of sales before tax, deliverables instead (like action photos), or nothing; set it under Terms below or on the partner&#8217;s Sales tab. Payouts show on Today once the season is over. Orders that come in after you pay show up as owed again for the difference.</p>" +
        '<div class="toolbar"><div class="chips">' + chip("owed", "Owed") + chip("waiting", "Waiting for sales") + chip("paid", "Paid") + chip("all", "All") + "</div>" +
          (payOrg ? '<span class="rs-tag">Only ' + esc(nameOf(payOrg) || "this partner") + ' <button type="button" data-allorgs aria-label="Show every partner">&times;</button></span>' : "") + "</div>" +
        (list.length ? list.map((g) => {
          const ids = g.list.filter((j) => j.state === "owed").map((j) => j.id);
          const p = partnerOf(g.id);
          return '<div class="rs-org" data-org="' + esc(g.id) + '"><div class="rs-orgh"><b>' + orgA(g.id, g.name) + "</b>" +
            '<span class="muted">' + (p && hasTerms(p) ? esc(termsText(p)) : g.id ? "no terms" : "") + '</span><span class="grow"></span>' +
            (g.a.balance > 0.005 ? '<span class="owed">' + cents(g.a.balance) + " owed</span>" : "") +
            '<button type="button" class="small quiet" data-copy="' + esc(g.id) + '">Copy statement</button>' +
            (edit() && g.id ? '<button type="button" class="small quiet" data-emailst="' + esc(g.id) + '">Email statement</button>' : "") +
            (edit() && ids.length ? '<button type="button" class="small primary" data-payall="' + esc(ids.join(",")) + '">Record payment</button>' : "") + "</div>" +
            '<div class="table-wrap"><table class="rs-t"><thead><tr><th>Job</th><th class="r hide-sm">Sales</th><th class="r">Share</th><th class="r hide-sm">Paid</th><th class="r">Owed</th><th></th></tr></thead><tbody>' +
            g.list.map((j) => '<tr class="click" data-job="' + esc(j.id) + '"><td class="name">' + esc(j.name) + '<span class="s">' + esc(fmtD(j.picture_day, true)) + " &middot; " + esc(seasonLabel(j.season, j.season_year)) + "</span></td>" +
              '<td class="r hide-sm">' + (j.sales == null ? "&mdash;" : dollars(n(j.sales))) + '</td><td class="r">' + cents(n(j.due)) + (j.pct_source !== "none" && j.payout_amount == null ? '<span class="s">' + esc(n(j.pct)) + "%</span>" : "") +
              '</td><td class="r hide-sm">' + (n(j.paid) ? cents(n(j.paid)) + '<span class="s">' + esc(fmtD(j.last_paid_on, true)) + "</span>" : "") + '</td><td class="r">' + (n(j.balance) ? cents(n(j.balance)) : "") + '</td><td class="jstate">' + pill(j.state) + "</td></tr>").join("") +
            "</tbody></table></div></div>";
        }).join("") : '<p class="empty">' + (payFilter === "owed" ? "Nothing is owed." : "Nothing here.") + "</p>") +
        '<div class="rs-h">Terms</div>' +
        '<div class="table-wrap"><table class="rs-t"><thead><tr><th>Partner</th><th>They get</th><th class="hide-sm">Note</th><th></th></tr></thead><tbody>' +
          (termed.length ? termed.map((p) => "<tr><td class=\"name\">" + orgA(p.id, p.name) + "</td><td>" + esc(termsText(p)) + '</td><td class="hide-sm muted">' + esc(p.note) + "</td><td class=\"jstate\">" +
            (edit() ? '<button type="button" class="small" data-terms="' + esc(p.id) + '">Change</button>' : "") + "</td></tr>").join("")
            : '<tr><td colspan="4" class="empty">No partner terms yet.</td></tr>') +
        "</tbody></table></div>" +
        (edit() ? '<div class="toolbar"><button type="button" id="aca-rsAddTerms">Add a partner&#8217;s terms</button></div>' : "");

      root.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => { payFilter = b.dataset.f; renderPayouts(); }));
      root.querySelectorAll("[data-allorgs]").forEach((b) => b.addEventListener("click", () => { payOrg = ""; setView("owed"); }));
      root.querySelectorAll("tr[data-job]").forEach((tr) => tr.addEventListener("click", () => openJob(tr.dataset.job)));
      root.querySelectorAll("[data-payall]").forEach((b) => b.addEventListener("click", () => openPay(b.dataset.payall.split(","))));
      root.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => copyStatement(b.dataset.copy)));
      root.querySelectorAll("[data-emailst]").forEach((b) => b.addEventListener("click", () => emailStatement(b.dataset.emailst)));
      root.querySelectorAll("[data-terms]").forEach((b) => b.addEventListener("click", () => openTerms(b.dataset.terms)));
      const add = el("rsAddTerms"); if (add) add.addEventListener("click", () => openTerms(null));
    }

    // Plain text for an email to the partner: every job this year and last with a payout, paid and owed.
    // season ("fall-2026", optional) keeps one season's jobs.
    function statementJobs(orgId, season) {
      return jobs.filter((j) => (j.org_id || "") === orgId && j.state !== "none" && (!season || j.season + "-" + j.season_year === season))
        .sort((a, b) => String(a.picture_day).localeCompare(String(b.picture_day)));
    }
    function copyStatement(orgId) {
      const list = statementJobs(orgId);
      const name = (list[0] && list[0].org_name) || "No partner";
      const a = agg(list);
      const lines = [name + ": picture day results from 207 Photo", ""].concat(list.map((j) =>
        seasonLabel(j.season, j.season_year) + ": " + j.name + " (picture day " + fmtD(j.picture_day, true) + ")\n" +
        "  " + (j.orders == null ? "" : n(j.orders) + " orders, ") + (j.sales == null ? "sales not in yet" : cents(n(j.sales)) + " in sales") +
        ", your share " + cents(n(j.due)) + (n(j.paid) ? ", paid " + cents(n(j.paid)) + " on " + fmtD(j.last_paid_on, true) : "") +
        (n(j.balance) > 0.005 ? ", " + cents(n(j.balance)) + " to come" : ""))).concat(["", "Total share " + cents(a.due) + ", paid " + cents(a.paid) + (a.balance > 0.005 ? ", " + cents(a.balance) + " to come." : ".")]);
      const text = lines.join("\n");
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast("Statement copied. Paste it into an email."), () => {
        const m = openModal('<h2>Statement</h2><textarea class="rs-note" style="height:240px;width:100%" readonly>' + esc(text) + '</textarea><div class="modal-actions"><button type="button" class="primary" data-x>Close</button></div>');
        m.querySelector("[data-x]").addEventListener("click", m.close);
      });
    }

    // "Email statement" (ws/director 2026-10-24): the same statement plus the latest payment ("Check for $380.00 mailed on
    // March 2, 2026"), dropped into the outbox HELD for review (partner_statement_queue). Exported as Results.emailStatement.
    async function emailStatement(orgId, season) {
      try { await load(); } catch (e) { toast(cleanErr(e), true); return null; }
      const list = statementJobs(orgId, season);
      if (!list.length) { toast("No jobs with a payout for this partner" + (season ? " that season." : "."), true); return null; }
      const name = list[0].org_name || "your program";
      const sl = season ? seasonLabel(season.split("-")[0], season.split("-")[1]) : "";
      const a = agg(list);
      const lines = list.map((j) =>
        seasonLabel(j.season, j.season_year) + ": " + j.name + " (picture day " + fmtD(j.picture_day, true) + ")\n" +
        "  " + (j.orders == null ? "" : n(j.orders) + " orders, ") + (j.sales == null ? "sales not in yet" : cents(n(j.sales)) + " in sales") +
        ", your share " + cents(n(j.due)) + (n(j.paid) ? ", paid " + cents(n(j.paid)) + " on " + fmtD(j.last_paid_on, true) : "") +
        (n(j.balance) > 0.005 ? ", " + cents(n(j.balance)) + " to come" : ""));
      const body = "{{hi|Hi there}},\n\nHere is your picture day statement from 207 Photo" + (sl ? " for " + sl : "") + ".\n\n" + lines.join("\n") +
        "\n\nTotal share " + cents(a.due) + ", paid " + cents(a.paid) + (a.balance > 0.005 ? ", " + cents(a.balance) + " to come." : ".") +
        "\n\n{{paid_line}}\n\nThank you for having us! Any questions, just reply.";
      const { data, error } = await sb.rpc("partner_statement_queue", { p_org: orgId, p_subject: name + ": picture day statement" + (sl ? ", " + sl : ""), p_body: body });
      if (error) { toast(cleanErr(error), true); return null; }
      toast("The statement for " + name + " is in the outbox, held for you to check and send" + (data && data.to ? " (to " + data.to + ")." : "."));
      return data;
    }

    function openPay(ids, single, onDone) {
      const list = ids.map((id) => jobs.find((j) => j.id === id)).filter(Boolean);
      const total = list.reduce((s, j) => s + n(j.balance), 0);
      const METHODS = ["Check", "ACH", "Venmo", "Cash", "Other"];
      const m = openModal("<h2>Record payment</h2>" +
        "<p>" + (list.length === 1 ? esc(list[0].name) + " &middot; " + cents(total) + " owed" : list.length + " jobs for " + esc(list[0].org_name || "No partner") + " &middot; " + cents(total) + " owed in all") + "</p>" +
        '<div class="rs-row2"><div class="field"><label for="aca-rsPayOn">Paid on</label><input type="date" id="aca-rsPayOn" value="' + today() + '" /></div>' +
        (single ? '<div class="field"><label for="aca-rsPayAmt">Amount</label><input type="number" id="aca-rsPayAmt" min="0.01" step="0.01" value="' + total.toFixed(2) + '" /></div>' : "<div></div>") + "</div>" +
        '<div class="field"><label>How</label><div class="seg" role="radiogroup" aria-label="How">' + METHODS.map((x, i) => '<label><input type="radio" name="aca-rsPayM" value="' + x + '"' + (i === 0 ? " checked" : "") + " /><span>" + x + "</span></label>").join("") + "</div></div>" +
        '<div class="field"><label for="aca-rsPayRef">Check number or reference</label><input type="text" id="aca-rsPayRef" maxlength="80" /></div>' +
        '<p id="aca-rsPayErr" class="inline-error hidden"></p>' +
        '<div class="modal-actions"><button type="button" data-x>Cancel</button><button type="button" class="primary" data-go>Record ' + (single ? "payment" : cents(total)) + "</button></div>");
      m.querySelector("[data-x]").addEventListener("click", m.close);
      m.querySelector("[data-go]").addEventListener("click", async (e) => {
        const amt = single ? parseFloat(el("rsPayAmt").value) : null;
        const args = { p_jobs: ids, p_paid_on: el("rsPayOn").value || null, p_method: (m.querySelector('input[name="aca-rsPayM"]:checked') || {}).value || "", p_ref: el("rsPayRef").value.trim() };
        if (single && amt !== Math.round(total * 100) / 100) args.p_amount = amt;
        e.target.disabled = true;
        const { data, error } = await sb.rpc("results_pay", args);
        e.target.disabled = false;
        if (error) { const b = el("rsPayErr"); b.textContent = cleanErr(error); b.classList.remove("hidden"); return; }
        m.close(); toast("Recorded " + cents(n(data && data.total)) + ".");
        await load(true); rerender(); loadAttention(); if (onDone) onDone();
      });
    }

    // Partner terms (polish pass 2026-10-23): a percent of sales, deliverables instead (like action photos), or nothing.
    const TERM_KINDS = { percent: "A percent of sales", deliverables: "Deliverables instead (like action photos)", none: "Nothing" };
    const hasTerms = (p) => p.payout_pct != null || !!p.payout_kind;
    const termsText = (p) => (p.payout_kind === "deliverables" ? (p.gets ? p.gets : "Deliverables") + ", no money" : p.payout_kind === "none" ? "Nothing" : n(p.payout_pct) + "% of sales");

    function openTerms(orgId, onDone, orgName) {
      const p = orgId ? (partnerOf(orgId) || { id: orgId, name: orgName || nameOf(orgId) || "This partner", note: "" }) : null;
      const choices = partners.filter((x) => !hasTerms(x));
      const kind = (p && p.payout_kind) || "percent";
      const m = openModal("<h2>" + (p ? esc(p.name) + "&#8217;s terms" : "Add a partner&#8217;s terms") + "</h2>" +
        (p ? "" : '<div class="field"><label for="aca-rsTOrg">Partner</label><select id="aca-rsTOrg">' + choices.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name) + "</option>").join("") + "</select></div>") +
        '<div class="field"><label for="aca-rsTKind">They get</label><select id="aca-rsTKind">' + Object.keys(TERM_KINDS).map((k) => '<option value="' + k + '"' + (k === kind ? " selected" : "") + ">" + TERM_KINDS[k] + "</option>").join("") + "</select></div>" +
        '<div class="field" id="aca-rsTPctF"><label for="aca-rsTPct">Share of sales before tax (%)</label><input type="number" id="aca-rsTPct" min="0" max="100" step="0.5" value="' + esc(p && p.payout_pct != null ? n(p.payout_pct) : 10) + '" /></div>' +
        '<div class="field" id="aca-rsTGetsF"><label for="aca-rsTGets">What they get</label><input type="text" id="aca-rsTGets" maxlength="200" placeholder="Action photos for the program" value="' + esc(p ? p.gets || "" : "") + '" /></div>' +
        '<div class="field"><label for="aca-rsTNote">Note</label><input type="text" id="aca-rsTNote" maxlength="500" placeholder="Partner Plan, paid after the gallery closes" value="' + esc(p ? p.note : "") + '" /></div>' +
        '<p id="aca-rsTErr" class="inline-error hidden"></p>' +
        '<div class="modal-actions">' + (p && hasTerms(p) ? '<button type="button" class="quiet" data-rm>Remove</button><span class="grow"></span>' : "") + '<button type="button" data-x>Cancel</button><button type="button" class="primary" data-go>Save</button></div>');
      m.querySelector("[data-x]").addEventListener("click", m.close);
      const sync = () => { const k = el("rsTKind").value; el("rsTPctF").classList.toggle("hidden", k !== "percent"); el("rsTGetsF").classList.toggle("hidden", k !== "deliverables"); };
      el("rsTKind").addEventListener("change", sync); sync();
      const save = async (pct, remove) => {
        const org = p ? p.id : el("rsTOrg").value, k = el("rsTKind").value;
        const { error } = await sb.rpc("results_set_terms", { p_org: org, p_pct: remove ? null : k === "percent" ? pct : 0, p_note: el("rsTNote").value.trim(),
          p_kind: remove ? null : k, p_gets: k === "deliverables" ? el("rsTGets").value.trim() : "" });
        if (error) { const b = el("rsTErr"); b.textContent = cleanErr(error); b.classList.remove("hidden"); return; }
        m.close(); toast(remove ? "Removed." : "Saved."); await load(true); rerender(); if (onDone) onDone();
      };
      m.querySelector("[data-go]").addEventListener("click", () => { const v = el("rsTPct").value; save(v === "" ? 0 : parseFloat(v), false); });
      const rm = m.querySelector("[data-rm]"); if (rm) rm.addEventListener("click", () => save(null, true));
    }

    // ---------------------------------------------------------------- By job
    function renderJobs() {
      const root = el("rsView");
      const { list, years } = seasonOptions();
      const words = jobQ.toLowerCase().split(/\s+/).filter(Boolean);
      const shown = jobs.filter((j) => (!jobSeason || inPick(j, jobSeason, 0)) && (!jobOnlyMissing || j.sales == null) && (!jobOrg || j.org_id === jobOrg) &&
        words.every((w) => (j.name + " " + (j.org_name || "No partner")).toLowerCase().includes(w)));
      const a = agg(shown);
      root.innerHTML =
        '<p class="rs-sub">' + sourceLine() + (settings && settings.gp_field_used ? " Amount field: " + esc(settings.gp_field_used) + "." : "") + " Open a job to type in its sales, change its partner or share, or record a payment.</p>" +
        '<div class="toolbar"><input type="text" id="aca-rsQ" placeholder="Search jobs or partners&#8230;" aria-label="Search jobs" value="' + esc(jobQ) + '" />' +
          '<select id="aca-rsJS" class="small" aria-label="Season"><option value="">Every season</option>' +
          list.map((x) => '<option value="' + esc(x[0] + ":" + x[1]) + '"' + (x[0] + ":" + x[1] === jobSeason ? " selected" : "") + ">" + esc(seasonLabel(x[0], x[1])) + "</option>").join("") +
          years.map((y) => '<option value="year:' + y + '"' + ("year:" + y === jobSeason ? " selected" : "") + ">" + y + "</option>").join("") + "</select>" +
          '<div class="chips"><button type="button" id="aca-rsMiss" aria-pressed="' + jobOnlyMissing + '">No sales yet</button></div>' +
          (jobOrg ? '<span class="rs-tag">Only ' + esc(nameOf(jobOrg) || "this partner") + ' <button type="button" id="aca-rsJOrgX" aria-label="Show every partner">&times;</button></span>' : "") + "</div>" +
        '<div class="table-wrap"><table class="rs-t"><thead><tr><th>Job</th><th class="hide-sm">Partner</th><th class="r">Sales</th><th class="r hide-sm">Orders</th><th class="r">Share</th><th></th></tr></thead><tbody>' +
          (shown.length ? shown.slice(0, 400).map((j) => '<tr class="click" data-job="' + esc(j.id) + '"><td class="name">' + esc(j.name) + '<span class="s">' + esc(fmtD(j.picture_day, true)) +
            (j.season ? " &middot; " + esc(seasonLabel(j.season, j.season_year)) : "") + (j.gp_error ? ' &middot; <span style="color:var(--err-fg)">sales read failed</span>' : "") + "</span></td>" +
            '<td class="hide-sm">' + (j.org_name ? orgA(j.org_id, j.org_name) : '<span class="muted">none</span>') + '</td><td class="r">' + (j.sales == null ? "&mdash;" : dollars(n(j.sales))) + (j.manual_sales != null ? '<span class="s">typed in</span>' : "") +
            '</td><td class="r hide-sm">' + (j.orders == null ? "" : n(j.orders)) + '</td><td class="r">' + (n(j.due) ? cents(n(j.due)) : "") + '</td><td class="jstate">' + (j.state !== "none" ? pill(j.state) : "") + "</td></tr>").join("")
            : '<tr><td colspan="6" class="empty">No jobs match.</td></tr>') +
        "</tbody>" + (shown.length > 1 ? '<tfoot><tr><td>' + shown.length + ' jobs</td><td class="hide-sm"></td><td class="r">' + dollars(a.sales) + '</td><td class="r hide-sm">' + a.orders + '</td><td class="r">' + cents(a.due) + "</td><td></td></tr></tfoot>" : "") +
        "</table></div>" + (shown.length > 400 ? '<p class="rs-sub">Showing the newest 400. Search or pick a season to narrow it down.</p>' : "");
      const q = el("rsQ");
      q.addEventListener("input", () => { jobQ = q.value; const pos = q.selectionStart; renderJobs(); const q2 = el("rsQ"); q2.focus(); q2.setSelectionRange(pos, pos); });
      el("rsJS").addEventListener("change", (e) => { jobSeason = e.target.value; renderJobs(); });
      el("rsMiss").addEventListener("click", () => { jobOnlyMissing = !jobOnlyMissing; renderJobs(); });
      const x = el("rsJOrgX"); if (x) x.addEventListener("click", () => { jobOrg = ""; setView("job"); });
      root.querySelectorAll("tr[data-job]").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("a")) openJob(tr.dataset.job); }));
    }

    async function refreshSales(btn) {
      btn.disabled = true; btn.textContent = "Reading sales…";
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const resp = await fetch(ADMIN_FN_URL + "/sales", { method: "POST", headers: { Authorization: "Bearer " + session.access_token } });
        let body = {}; try { body = await resp.json(); } catch (_) {}
        if (!resp.ok || body.ok === false) toast(body.error || ("Sales refresh failed (" + resp.status + ")."), true);
        else toast("Read sales for " + n(body.jobs) + (n(body.jobs) === 1 ? " job" : " jobs") + (n(body.left) ? ", " + n(body.left) + " still to read (it carries on every hour)." : "."));
      } catch (e) { toast(cleanErr(e), true); }
      await load(true).catch(() => {}); rerender();
    }

    async function openJob(id) {
      const j = jobs.find((x) => x.id === id);
      if (!j) return;
      const can = edit(), dis = can ? "" : " disabled";
      const p = partnerOf(j.org_id);
      const terms = p && hasTerms(p) ? esc(termsText(p)) + " (" + esc(p.name) + "&#8217;s terms)" : "none";
      const gp = j.gp_synced_at ? (j.gp_sales == null ? "no sales" : dollars(n(j.gp_sales)) + ", " + n(j.gp_orders) + " orders") + ", read " + esc(fmtAgo(j.gp_synced_at)) : "not read yet";
      const m = openModal("<h2>" + esc(j.name) + "</h2>" +
        '<p class="rs-src">' + [fmtD(j.picture_day, true) ? "Picture day " + esc(fmtD(j.picture_day, true)) : "", j.season ? esc(seasonLabel(j.season, j.season_year)) : "",
          esc(kindLabel(kindOf(j))) + (j.booking_type ? " (" + esc(j.booking_type) + ")" : ""), j.gallery_status === "archived" ? "gallery closed" : j.gallery_status === "published" ? "gallery selling" : esc(j.gallery_status || "")].filter(Boolean).join(" &middot; ") + "</p>" +
        '<div class="field"><label for="aca-rsJOrg">Partner</label><select id="aca-rsJOrg"' + dis + '><option value="">' + (j.org_set ? "Match by name" : "Matched by name: " + esc(j.org_name || "none found")) + "</option>" +
          partners.map((x) => '<option value="' + esc(x.id) + '"' + (j.org_set && x.id === j.org_id ? " selected" : "") + ">" + esc(x.name) + "</option>").join("") + "</select></div>" +
        '<p class="rs-src">From GotPhoto: ' + gp + (j.gp_error ? ' <span style="color:var(--err-fg)">(' + esc(j.gp_error) + ")</span>" : "") + "</p>" +
        '<div class="rs-row2"><div class="field"><label for="aca-rsJSales">Sales before tax (typed in)</label><input type="number" id="aca-rsJSales" min="0" step="0.01" placeholder="use GotPhoto" value="' + esc(j.manual_sales == null ? "" : j.manual_sales) + '"' + dis + " /></div>" +
          '<div class="field"><label for="aca-rsJOrders">Orders (typed in)</label><input type="number" id="aca-rsJOrders" min="0" step="1" placeholder="use GotPhoto" value="' + esc(j.manual_orders == null ? "" : j.manual_orders) + '"' + dis + " /></div></div>" +
        '<p class="rs-src">Partner share: ' + terms + ". Set a percent or a fixed amount here to use something else for this job.</p>" +
        '<div class="rs-row2"><div class="field"><label for="aca-rsJPct">Share for this job (%)</label><input type="number" id="aca-rsJPct" min="0" max="100" step="0.5" placeholder="partner&#8217;s terms" value="' + esc(j.payout_pct == null ? "" : j.payout_pct) + '"' + dis + " /></div>" +
          '<div class="field"><label for="aca-rsJAmt">Or a fixed amount ($)</label><input type="number" id="aca-rsJAmt" min="0" step="0.01" placeholder="percent of sales" value="' + esc(j.payout_amount == null ? "" : j.payout_amount) + '"' + dis + " /></div></div>" +
        '<div class="field"><label for="aca-rsJNote">Note</label><textarea id="aca-rsJNote" class="rs-note" maxlength="1000"' + dis + ">" + esc(j.note || "") + "</textarea></div>" +
        '<div class="rs-h" style="margin-top:4px">Payout &middot; ' + cents(n(j.due)) + " " + pill(j.state) + "</div>" +
        '<ul class="rs-pay" id="aca-rsJPays"><li class="muted">Loading&#8230;</li></ul>' +
        '<p id="aca-rsJErr" class="inline-error hidden"></p>' +
        '<div class="modal-actions">' + (can && n(j.balance) > 0.005 ? '<button type="button" data-pay>Record payment</button>' : "") + '<span class="grow"></span><button type="button" data-x>' + (can ? "Cancel" : "Close") + "</button>" +
          (can ? '<button type="button" class="primary" data-go>Save</button>' : "") + "</div>");
      m.querySelector("[data-x]").addEventListener("click", m.close);
      const pay = m.querySelector("[data-pay]"); if (pay) pay.addEventListener("click", () => { m.close(); openPay([j.id], true); });
      const { data: pays } = await sb.rpc("results_payments", { p_job: j.id });
      const ul = el("rsJPays");
      if (ul) {
        ul.innerHTML = (pays || []).length ? pays.map((x) => '<li><span class="grow">' + cents(n(x.amount)) + " on " + esc(fmtD(x.paid_on, true)) + (x.method ? " by " + esc(x.method.toLowerCase()) : "") + (x.ref ? " #" + esc(x.ref) : "") +
          (x.by ? ' <span class="muted">(' + esc(x.by) + ")</span>" : "") + "</span>" + (can ? '<button type="button" class="small quiet" data-undo="' + esc(x.id) + '">Undo</button>' : "") + "</li>").join("") : '<li class="muted">Nothing paid yet.</li>';
        ul.querySelectorAll("[data-undo]").forEach((b) => b.addEventListener("click", async () => {
          if (!confirm("Remove this payment?")) return;
          const { error } = await sb.rpc("results_payment_remove", { p_id: Number(b.dataset.undo) });
          if (error) { toast(cleanErr(error), true); return; }
          m.close(); toast("Payment removed."); await load(true); rerender(); loadAttention(); openJob(id);
        }));
      }
      const go = m.querySelector("[data-go]");
      if (go) go.addEventListener("click", async () => {
        const v = (k) => el(k).value.trim();
        const orgPick = v("rsJOrg");
        const patch = { manual_sales: v("rsJSales"), manual_orders: v("rsJOrders"), payout_pct: v("rsJPct"), payout_amount: v("rsJAmt"), note: el("rsJNote").value };
        if (orgPick) patch.org_id = orgPick; else if (j.org_set) patch.org_auto = true;
        go.disabled = true;
        const { error } = await sb.rpc("results_save", { p_job: j.id, p: patch });
        go.disabled = false;
        if (error) { const b = el("rsJErr"); b.textContent = cleanErr(error); b.classList.remove("hidden"); return; }
        m.close(); toast("Saved."); await load(true); rerender(); loadAttention();
      });
    }

    // ---------------------------------------------------------------- Today
    async function loadAttention() {
      const { data } = await sb.rpc("results_attention");
      if (!data) return;
      setAttention("payoutsOwed", n(data.owed), cents(n(data.total)) + " owed to partners", "payouts");
    }

    // For the partner page's Sales tab: the same numbers, terms dialog and Record payment.
    return { show, goto, loadAttention, emailStatement, ensure: () => load(), jobs: () => jobs, partner: (id) => partnerOf(id), hasTerms, termsText, openTerms, openPay, copyStatement };
  })();
