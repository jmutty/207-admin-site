  // ================================================================ SYSTEM section
  // Sub-tabs: Search log, Sync log (+ data quality). Also the header sync status.

  // ================= Header sync status =================
  async function loadSyncStatus() {
    const { data } = await supabase
      .from("sync_runs").select("started_at, finished_at, ok")
      .order("started_at", { ascending: false }).limit(1);
    const r = data && data[0];
    const node = el("syncStatus");
    // Today only flags it after an hour with no good sync: single failed runs fix themselves on the next try (2026-10-24)
    const { data: good } = r ? await supabase.from("sync_runs").select("started_at").eq("ok", true)
      .order("started_at", { ascending: false }).limit(1) : { data: null };
    const lastOk = good && good[0] ? good[0].started_at : null;
    const down = !!r && !!lastOk && Date.now() - new Date(lastOk).getTime() > 60 * 60 * 1000;
    setAttention("syncFailed", down ? 1 : 0, down ? "No good GotPhoto sync since " + fmtAgo(lastOk) : "", "company", "err");
    if (!r) { node.innerHTML = '<span class="dot"></span>No syncs yet'; return; }
    const cls = r.ok === true ? "ok" : (r.ok === false ? "err" : "");
    node.innerHTML = '<span class="dot ' + cls + '"></span>' +
      (r.ok === false ? "Last sync failed " : "Synced ") + esc(fmtAgo(r.started_at)) + ' · every 5 min';
  }


  // ================= Search log (lookup_events) =================
  let slDays = 30;
  let slRecent = [];
  let slMissesOnly = false;
  // Live: new searches (any job) appear at the top within a few seconds while this tab is open (2026-09-30)
  let slLive = true;
  try { slLive = localStorage.getItem("aca-slLive") !== "0"; } catch (e) {}
  let slLiveTimer = null, slNewIds = new Set(), slLastPoll = 0;
  // Job names for the log, independent of whether the Jobs tab has loaded yet (2026-09-30)
  const slNames = new Map();
  const slName = (id) => slNames.get(id) || jobName(id) || id;
  async function slFetchNames(rows) {
    const missing = [...new Set(rows.map((e) => e.gotphoto_job_id))].filter((id) => id && !slNames.has(id) && !jobName(id));
    if (!missing.length) return false;
    const { data } = await supabase.from("synced_jobs").select("gotphoto_job_id, name").in("gotphoto_job_id", missing);
    (data || []).forEach((j) => slNames.set(j.gotphoto_job_id, j.name));
    return !!(data && data.length);
  }
  let slOpenJob = null; // job expanded in the By job table

  async function loadSearchLog() {
    searchLogLoaded = true;
    clearError("slError");
    el("slRange").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(parseInt(b.dataset.days, 10) === slDays)));
    const [statsRes, recentRes] = await Promise.all([
      supabase.rpc("admin_search_stats", { p_days: slDays }),
      supabase.from("lookup_events").select("id, created_at, gotphoto_job_id, mode, outcome, search, ip, searcher")
        .order("created_at", { ascending: false }).limit(50),
    ]);
    if (statsRes.error) {
      showError("slError", "Could not load search stats: " + statsRes.error.message);
      el("slTiles").innerHTML = ""; el("slBars").innerHTML = ""; el("slBarLbl").innerHTML = "";
    } else {
      renderSearchStats(statsRes.data || {});
    }
    slRecent = (recentRes && recentRes.data) || [];
    loadIpBlocks();
    ((statsRes.data && statsRes.data.by_job) || []).forEach((r) => slNames.set(r.gotphoto_job_id, r.name));
    await slFetchNames(slRecent);
    slNewIds = new Set(); slLastPoll = Date.now();
    startLive();
    const body = el("slRecentBody");
    if (recentRes.error) {
      body.innerHTML = '<tr><td colspan="5" class="empty">Unavailable: ' + esc(recentRes.error.message) + '</td></tr>';
    } else if (!recentRes.data || !recentRes.data.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">No searches recorded yet. Every search on /find-my-photos from now on lands here.</td></tr>';
    } else {
      renderRecent();
    }
  }
  function renderRecent() {
    const rows = slMissesOnly ? slRecent.filter((e) => e.outcome !== "found") : slRecent;
    el("slMissOnly").setAttribute("aria-pressed", String(slMissesOnly));
    el("slLive").setAttribute("aria-pressed", String(slLive));
    el("slRecentBody").innerHTML = rows.length ? rows.map((e) =>
      '<tr' + (slNewIds.has(e.id) ? ' class="sl-new"' : '') + '><td class="muted" style="white-space:nowrap">' + fmtDate(e.created_at) + '</td>' +
      '<td><span class="lnk js-sl-job" data-job="' + esc(e.gotphoto_job_id) + '">' + esc(slName(e.gotphoto_job_id)) + '</span></td>' +
      '<td class="muted mono">' + esc(summarizeSearch(e.search) || (e.mode === "group" ? "(shared gallery code)" : "—")) + whoLine(e.searcher) + '</td>' +
      '<td>' + ipCell(e.ip) + '</td>' +
      '<td>' + outcomePill(e.outcome) + '</td></tr>'
    ).join("") : '<tr><td colspan="5" class="empty">No misses in the last 50 searches.</td></tr>';
  }

  function startLive() {
    clearInterval(slLiveTimer); slLiveTimer = null;
    liveLabel();
    if (slLive) slLiveTimer = setInterval(pollLive, 8000);
  }
  function liveLabel() {
    const n = el("slLiveNote"); if (!n) return;
    n.textContent = slLive ? "Live: checks every 8 seconds" : "Paused. Refresh the tab for new searches.";
  }
  async function pollLive() {
    if (!slLive || currentTab !== "searchlog" || document.hidden) return;
    const maxId = slRecent.reduce((m, e) => Math.max(m, e.id || 0), 0);
    const { data, error } = await supabase.from("lookup_events").select("id, created_at, gotphoto_job_id, mode, outcome, search, ip, searcher")
      .gt("id", maxId).order("id", { ascending: false }).limit(50);
    if (error || !data) return;
    const have = new Set(slRecent.map((e) => e.id));
    const fresh = data.filter((e) => !have.has(e.id));
    if (!fresh.length) return;
    fresh.forEach((e) => slNewIds.add(e.id));
    await slFetchNames(fresh);
    slRecent = fresh.concat(slRecent).slice(0, 200);
    renderRecent();
    el("slLiveNote").textContent = fresh.length + " new search" + (fresh.length === 1 ? "" : "es") + " just now";
    setTimeout(liveLabel, 6000);
  }

  // IP column: click to look the address up (older searches only kept a hash, so they show a dash)
  // the person searching (school galleries ask for name, email, phone)
  const whoLine = (w) => w ? '<div class="req-who">Searcher: ' + esc([w.name, w.email, w.phone].filter(Boolean).join(" · ")) + '</div>' : "";
  const ipCell = (ip) => ip ? '<span class="lnk mono js-ip" data-ip="' + esc(ip) + '" title="Show every search from this address">' + esc(ip) + '</span>' : '<span class="muted">&mdash;</span>';

  // ---- Drill-in: every search on one job, with the reason each miss failed (admin_job_searches)
  async function toggleJob(job, scroll) {
    const table = el("slJobsBody");
    const old = table.querySelector("tr.sl-detail");
    if (old) old.remove();
    table.querySelectorAll("tr.sl-open").forEach((r) => r.classList.remove("sl-open"));
    if (slOpenJob === job && !scroll) { slOpenJob = null; return; }
    slOpenJob = job;
    let row = table.querySelector('tr[data-job="' + CSS.escape(job) + '"]');
    if (!row) { // job not in the By job list for this range: add a stand-in row so the detail has a home
      table.insertAdjacentHTML("afterbegin", '<tr data-job="' + esc(job) + '"><td class="name" colspan="5"><button type="button" class="link js-sl-job" data-job="' + esc(job) + '">' + esc(slName(job)) + '</button></td></tr>');
      row = table.querySelector('tr[data-job="' + CSS.escape(job) + '"]');
    }
    row.classList.add("sl-open");
    row.insertAdjacentHTML("afterend", '<tr class="sl-detail"><td colspan="5"><div class="sl-dbox"><div class="empty">Loading searches&#8230;</div></div></td></tr>');
    const box = table.querySelector("tr.sl-detail .sl-dbox");
    if (scroll) {
      const card = row.closest(".sl-fold"); // open By job if it was folded away
      if (card && card.classList.contains("sl-closed")) card.querySelector(".sl-foldbtn").click();
      row.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const { data, error } = await supabase.rpc("admin_job_searches", { p_job: job, p_days: slDays });
    if (slOpenJob !== job) return;
    if (error) { box.innerHTML = '<div class="inline-error">Could not load: ' + esc(error.message) + '</div>'; return; }
    renderJobSearches(box, job, data || []);
  }
  function renderJobSearches(box, job, rows) {
    const misses = rows.filter((r) => r.outcome !== "found").length;
    const onlyMiss = box.dataset.all !== "1" && misses > 0;
    const shown = onlyMiss ? rows.filter((r) => r.outcome !== "found") : rows;
    box.innerHTML =
      '<div class="sl-dhead"><strong>' + rows.length + ' search' + (rows.length === 1 ? '' : 'es') + ' · ' + misses + ' not found</strong>' +
      '<span class="muted"> in the last ' + slDays + ' days</span>' +
      (misses && misses < rows.length ? ' <button type="button" class="link js-sl-all">' + (onlyMiss ? 'Show all searches' : 'Show only misses') + '</button>' : '') +
      ' <button type="button" class="link js-open-job" data-job="' + esc(job) + '">Open job settings</button></div>' +
      (shown.length ? '<table class="sl-dtable"><thead><tr><th>When</th><th>What they typed</th><th>IP</th><th>Result</th><th>Why it didn&#39;t match</th></tr></thead><tbody>' +
        shown.map((r) => '<tr><td class="muted" style="white-space:nowrap">' + fmtDate(r.at) + '</td>' +
          '<td class="mono">' + esc(summarizeSearch(r.search) || (r.mode === "group" ? "(shared gallery code)" : "—")) + whoLine(r.searcher) + '</td>' +
          '<td>' + ipCell(r.ip) + '</td>' +
          '<td>' + outcomePill(r.outcome) + '</td>' +
          '<td>' + (r.why ? esc(r.why) : '<span class="muted">&mdash;</span>') +
            (r.near ? '<div class="muted sl-near">Closest on roster: ' + esc(r.near) + '</div>' : '') + '</td></tr>').join("") +
        '</tbody></table>' : '<div class="empty">No searches in this range.</div>');
    box.querySelector(".js-sl-all")?.addEventListener("click", () => { box.dataset.all = onlyMiss ? "1" : ""; renderJobSearches(box, job, rows); });
  }

  function renderSearchStats(s) {
    const t = s.totals || {};
    const searches = t.searches || 0, found = t.found || 0;
    const rate = searches ? Math.round((found / searches) * 100) : null;
    el("slTiles").innerHTML =
      '<div class="tile"><div class="l">Searches</div><div class="n tnum">' + num(searches) + '</div><div class="s">last ' + esc(s.days || slDays) + ' days</div></div>' +
      '<div class="tile"><div class="l">Found their code</div><div class="n tnum" style="color:' + (rate === null ? 'inherit' : (rate >= 70 ? 'var(--ok-fg)' : 'var(--warn-fg)')) + '">' + (rate === null ? "—" : rate + "%") + '</div><div class="s">' + found + ' found · ' + (t.not_found || 0) + ' not found' + (t.cooldown ? ' · ' + t.cooldown + ' rate-limited' : '') + '</div></div>' +
      '<div class="tile"><div class="l">Visitors</div><div class="n tnum">' + (t.visitors || 0) + '</div><div class="s">distinct connections</div></div>' +
      '<div class="tile"><div class="l">Galleries searched</div><div class="n tnum">' + (t.jobs || 0) + '</div><div class="s">of ' + visibleIds.size + ' findable</div></div>';

    // One bar per day across the whole range, zero-filled.
    const byDay = new Map((s.by_day || []).map((d) => [d.d, d]));
    const days = s.days || slDays;
    const bars = [];
    let max = 1;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
      const row = byDay.get(key) || { searches: 0, found: 0 };
      bars.push({ key, searches: row.searches || 0, found: row.found || 0 });
      if ((row.searches || 0) > max) max = row.searches;
    }
    el("slBars").innerHTML = bars.map((b) =>
      '<div class="b" title="' + esc(b.key) + ': ' + b.searches + ' search' + (b.searches === 1 ? '' : 'es') + ', ' + b.found + ' found" style="height:' + Math.max(2, Math.round((b.searches / max) * 64)) + 'px">' +
      '<div class="f" style="height:' + (b.searches ? Math.round((b.found / b.searches) * 100) : 0) + '%"></div></div>'
    ).join("");
    el("slBarLbl").innerHTML = '<span>' + esc(bars[0].key) + '</span><span>bar = searches that day · blue = share found</span><span>' + esc(bars[bars.length - 1].key) + '</span>';

    const jb = el("slJobsBody");
    const rows = s.by_job || [];
    if (!rows.length) { jb.innerHTML = '<tr><td colspan="5" class="empty">No searches in this range.</td></tr>'; return; }
    slOpenJob = null;
    jb.innerHTML = rows.map((r) => {
      const pct = r.searches ? Math.round((r.found / r.searches) * 100) : 0;
      const cls = r.searches < 3 ? "muted" : (pct >= 70 ? "ok" : (pct >= 40 ? "warn" : "err"));
      return '<tr data-job="' + esc(r.gotphoto_job_id) + '"><td class="name"><button type="button" class="link js-sl-job" data-job="' + esc(r.gotphoto_job_id) + '" title="Show every search on this job">' + esc(r.name) + '</button></td>' +
        '<td class="tnum">' + num(r.searches) + '</td><td class="tnum">' + num(r.found) + '</td>' +
        '<td><span class="pill ' + cls + '">' + pct + '%</span></td>' +
        '<td class="muted">' + esc(fmtAgo(r.last_at)) + '</td></tr>';
    }).join("");
  }

  el("slRange").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-days]");
    if (!b) return;
    slDays = parseInt(b.dataset.days, 10);
    loadSearchLog();
  });
  el("panel-searchlog").addEventListener("click", (e) => {
    const drill = e.target.closest(".js-sl-job");
    if (drill) { const inRecent = !!drill.closest("#aca-slRecentBody, #aca-slIpOut"); toggleJob(drill.dataset.job, inRecent); return; }
    const open = e.target.closest(".js-open-job");
    if (open) showJobsFor({}, { select: open.dataset.job });
  });
  // By job / Recent searches fold open and closed; each remembers its state (2026-09-30)
  [...el("panel-searchlog").querySelectorAll(".sl-fold"), el("slIpCard")].forEach((card) => {
    const key = "aca-slFold-" + card.dataset.fold, btn = card.querySelector(".sl-foldbtn");
    const set = (open) => { card.classList.toggle("sl-closed", !open); btn.setAttribute("aria-expanded", String(open)); };
    try { set(localStorage.getItem(key) !== "0"); } catch (e) {}
    btn.addEventListener("click", () => {
      const open = card.classList.contains("sl-closed");
      set(open);
      try { localStorage.setItem(key, open ? "1" : "0"); } catch (e) {}
    });
  });
  // ---- Look up an IP address (admin_ip_searches hashes it the way the log does) (2026-10-05)
  el("slIpForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ip = el("slIp").value.trim(), out = el("slIpOut");
    if (!ip) return;
    out.innerHTML = '<div class="empty">Looking up&#8230;</div>';
    const { data, error } = await supabase.rpc("admin_ip_searches", { p_ip: ip });
    if (error) { out.innerHTML = '<div class="inline-error">' + esc(error.message) + '</div>'; return; }
    const rows = data.searches || [], a = data.attempts || {};
    (rows).forEach((r) => slNames.set(r.job, r.job_name));
    const found = rows.filter((r) => r.outcome === "found").length, jobs = new Set(rows.map((r) => r.job)).size;
    const b = data.block;
    const blockedTries = rows.filter((r) => r.outcome === "blocked").length;
    const blockUi = b
      ? '<div class="sl-blockbar err">Blocked ' + (b.until ? 'until ' + esc(fmtDate(b.until)) : 'permanently') + (b.note ? ' &middot; ' + esc(b.note) : '') +
        (blockedTries ? ' &middot; ' + blockedTries + ' search' + (blockedTries === 1 ? '' : 'es') + ' while blocked' : '') +
        (b.until ? ' <span class="sl-extend">Extend: <select class="sl-extdays" aria-label="Extend by"><option value="1">24 hours</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="">Permanently</option></select><button type="button" class="small" data-extend="' + esc(data.ip) + '" data-note="' + esc(b.note || '') + '">Extend</button></span>' : '') +
        ' <button type="button" class="small" data-unblock="' + esc(data.ip) + '">Unblock</button></div>'
      : '<div class="sl-blockbar">Block this address: <select id="aca-slBlkDays" aria-label="Block for"><option value="1">24 hours</option><option value="7">7 days</option><option value="30">30 days</option><option value="">Permanently</option></select>' +
        '<input type="text" id="aca-slBlkNote" placeholder="Note (optional)" maxlength="500" /><button type="button" class="small" data-block="' + esc(data.ip) + '">Block</button>' +
        '<span class="muted sl-blkhint">They&rsquo;ll just see &ldquo;no match&rdquo;. Phone carriers share addresses, so a block can catch other parents too.</span></div>';
    const t = data.trusted;
    const trustUi = '<div class="sl-blockbar' + (t ? ' ok' : '') + '">' + (t
      ? 'Trusted: no 3-children limit' + (t.note ? ' &middot; ' + esc(t.note) : '') + ' <button type="button" class="small" data-untrust="' + esc(data.ip) + '">Remove trust</button>'
      : 'Limit: 3 different children per gallery per day (siblings excepted). <button type="button" class="small" data-trust="' + esc(data.ip) + '">Trust this address</button>' +
        '<span class="muted sl-blkhint">For a school office or similar that looks up codes for many families.</span>') + '</div>';
    out.innerHTML = blockUi + trustUi + '<div class="sl-dhead"><strong>' + esc(data.ip) + '</strong><span>' +
      (rows.length ? rows.length + ' search' + (rows.length === 1 ? '' : 'es') + ' · ' + found + ' found · ' + jobs + (jobs === 1 ? ' gallery' : ' galleries') : 'No searches from this address') +
      (a.failed ? ' · <span class="pill warn">' + a.failed + ' failed attempt' + (a.failed === 1 ? '' : 's') + '</span>' : '') + '</span></div>' +
      (rows.length ? '<table class="sl-dtable"><thead><tr><th>When</th><th>Job</th><th>What they typed</th><th>Result</th></tr></thead><tbody>' +
        rows.map((r) => '<tr><td class="muted" style="white-space:nowrap">' + fmtDate(r.at) + '</td>' +
          '<td><span class="lnk js-sl-job" data-job="' + esc(r.job) + '">' + esc(r.job_name) + '</span></td>' +
          '<td class="mono">' + esc(summarizeSearch(r.search) || (r.mode === "group" ? "(shared gallery code)" : "—")) + whoLine(r.searcher) + '</td>' +
          '<td>' + outcomePill(r.outcome) + '</td></tr>').join("") + '</tbody></table>' : '');
  });
  // ---- Blocked addresses (lookup_ip_blocks) (2026-10-05)
  async function loadIpBlocks() {
    const box = el("slBlocks");
    const { data, error } = await supabase.from("lookup_ip_blocks").select("ip, note, until, created_at").order("created_at", { ascending: false });
    if (error) { box.innerHTML = '<div class="inline-error">' + esc(error.message) + '</div>'; return; }
    const now = Date.now(), live = (data || []).filter((b) => !b.until || new Date(b.until).getTime() > now);
    const tr = await supabase.from("lookup_ip_trusted").select("ip, note").order("created_at", { ascending: false });
    const trusted = (tr.data || []);
    el("slTrusted").innerHTML = trusted.length ? '<table class="sl-dtable"><tbody>' + trusted.map((t) =>
      '<tr><td class="mono"><span class="lnk js-ip" data-ip="' + esc(t.ip) + '">' + esc(t.ip) + '</span></td><td class="muted">' + esc(t.note || "") + '</td>' +
      '<td style="text-align:right"><button type="button" class="small" data-untrust="' + esc(t.ip) + '">Remove trust</button></td></tr>').join("") + '</tbody></table>'
      : '<div class="muted" style="font-size:13px">No trusted addresses.</div>';
    box.innerHTML = live.length ? '<table class="sl-dtable"><tbody>' + live.map((b) =>
      '<tr><td class="mono"><span class="lnk js-ip" data-ip="' + esc(b.ip) + '">' + esc(b.ip) + '</span></td>' +
      '<td>' + (b.until ? 'until ' + esc(fmtDate(b.until)) : 'permanent') + '</td><td class="muted">' + esc(b.note || "") + '</td>' +
      '<td style="text-align:right;white-space:nowrap">' + (b.until ? '<span class="sl-extend"><select class="sl-extdays" aria-label="Extend by"><option value="1">24 hours</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="">Permanently</option></select><button type="button" class="small" data-extend="' + esc(b.ip) + '" data-note="' + esc(b.note || '') + '">Extend</button></span> ' : '') +
      '<button type="button" class="small" data-unblock="' + esc(b.ip) + '">Unblock</button></td></tr>').join("") + '</tbody></table>'
      : '<div class="muted" style="font-size:13px">No addresses are blocked.</div>';
  }
  async function lookupIp(ip) {
    const card = el("slIpForm").closest(".sl-fold");
    if (card && card.classList.contains("sl-closed")) card.querySelector(".sl-foldbtn").click();
    el("slIp").value = ip; el("slIpForm").requestSubmit();
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // The address card sits on the Blocked tab (2026-10-24): it loads when that tab shows, and a job in a lookup
  // opens it on Find My Photos activity.
  new MutationObserver(() => { if (el("panel-blocks").classList.contains("active")) loadIpBlocks(); })
    .observe(el("panel-blocks"), { attributes: true, attributeFilter: ["class"] });
  el("slIpCard").addEventListener("click", (e) => {
    const drill = e.target.closest(".js-sl-job"); if (!drill) return;
    showTab("searchlog"); toggleJob(drill.dataset.job, true);
  });
  el("slIpCard").addEventListener("click", async (e) => {
    const blk = e.target.closest("[data-block]"), unb = e.target.closest("[data-unblock]"), ipl = e.target.closest(".js-ip");
    const tr = e.target.closest("[data-trust]"), untr = e.target.closest("[data-untrust]");
    if (tr || untr) {
      const ip = (tr || untr).dataset.trust || (tr || untr).dataset.untrust;
      let note = "";
      if (tr) { note = prompt("Trust " + ip + "? It can look up any number of children. Optional note (e.g. school office):", ""); if (note === null) return; }
      else if (!confirm("Remove trust from " + ip + "? The 3-children limit will apply again.")) return;
      const { error } = await supabase.rpc("admin_trust_ip", { p_ip: ip, p_note: note, p_trust: !!tr });
      if (error) { alert(error.message); return; }
      await loadIpBlocks(); lookupIp(ip); return;
    }
    if (ipl) return lookupIp(ipl.dataset.ip);
    if (blk) {
      const daysV = el("slBlkDays").value, days = daysV ? +daysV : null;
      if (!confirm("Block " + blk.dataset.block + (days ? " for " + el("slBlkDays").selectedOptions[0].text : " permanently") + "? Searches from it will get \u201cno match\u201d.")) return;
      blk.disabled = true;
      const { error } = await supabase.rpc("admin_block_ip", { p_ip: blk.dataset.block, p_note: el("slBlkNote").value, p_days: days });
      if (error) { blk.disabled = false; alert(error.message); return; }
      await loadIpBlocks(); lookupIp(blk.dataset.block);
    }
    const ext = e.target.closest("[data-extend]");
    if (ext) {
      // Extend = a fresh block from now (24 h / 7 d / 30 d / permanent); the note is kept.
      const sel = ext.parentElement.querySelector(".sl-extdays"), daysV = sel ? sel.value : "7", days = daysV ? +daysV : null;
      const label = sel ? sel.selectedOptions[0].text : "7 days";
      if (!confirm("Extend the block on " + ext.dataset.extend + (days ? " to " + label + " from now" : " permanently") + "?")) return;
      ext.disabled = true;
      const { error } = await supabase.rpc("admin_block_ip", { p_ip: ext.dataset.extend, p_note: ext.dataset.note || "", p_days: days });
      if (error) { ext.disabled = false; alert(error.message); return; }
      toast(days ? "Block extended to " + label + " from now." : "Block is now permanent.");
      await loadIpBlocks();
      if (el("slIp").value.trim() === ext.dataset.extend) lookupIp(ext.dataset.extend);
      return;
    }
    if (unb) {
      if (!confirm("Unblock " + unb.dataset.unblock + "?")) return;
      unb.disabled = true;
      const { error } = await supabase.rpc("admin_unblock_ip", { p_ip: unb.dataset.unblock });
      if (error) { unb.disabled = false; alert(error.message); return; }
      await loadIpBlocks();
      if (el("slIp").value.trim() === unb.dataset.unblock) lookupIp(unb.dataset.unblock);
    }
  });
  el("slMissOnly").addEventListener("click", () => { slMissesOnly = !slMissesOnly; renderRecent(); });
  el("slLive").addEventListener("click", () => {
    slLive = !slLive;
    try { localStorage.setItem("aca-slLive", slLive ? "1" : "0"); } catch (e) {}
    el("slLive").setAttribute("aria-pressed", String(slLive));
    startLive(); if (slLive) pollLive();
  });

  // ================= Sign-in security: remembered devices (2026-10-06) =================
  // Every new browser needs an emailed code once; "Remember this device" skips it for 90 days.
  // The database (public.admin_session_ok) is the gate, so a password-only session reads nothing.
  async function loadDevices() {
    const status = el("mfaStatus"), body = el("mfaBody");
    try {
      const { data, error } = await supabase.rpc("admin_devices_list");
      if (error) throw error;
      const mine = deviceToken();
      status.innerHTML = '<span class="pill ok">On</span>';
      if (!data || !data.length) {
        body.innerHTML = '<p class="muted" style="margin:0">No remembered devices. Every sign-in asks for an emailed code.</p>';
        return;
      }
      body.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Device</th><th>Remembered</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>' +
        data.map((d) => '<tr><td>' + esc(d.label || "Device")+'</td><td>' + esc(fmtDate(d.created_at)) + '</td><td>' + esc(d.last_used_at ? fmtDate(d.last_used_at) : "—") +
          '</td><td>' + esc(fmtDate(d.expires_at)) + '</td><td><button class="small" data-forget="' + esc(d.id) + '">Forget</button></td></tr>').join("") +
        '</tbody></table></div><p class="muted" style="margin:10px 0 0;font-size:12.5px">Forgetting a device makes it ask for an emailed code next time. This browser is ' + (mine ? "remembered" : "not remembered") + '.</p>';
      body.querySelectorAll("[data-forget]").forEach((b) => b.addEventListener("click", async () => {
        const { error: fe } = await supabase.rpc("admin_forget_device", { p_id: b.dataset.forget });
        if (fe) { toast(fe.message, true); return; }
        toast("Device forgotten.");
        loadDevices();
      }));
    } catch (e) {
      status.innerHTML = '<span class="pill muted">Unavailable</span>';
      body.innerHTML = '<span class="inline-error">' + esc(e.message || String(e)) + '</span>';
    }
  }

  // ================= Sync log =================
  async function loadHealth() {
    loadDevices();
    await Promise.all([loadRuns(), loadDataQuality()]);
  }

  async function loadRuns() {
    clearError("runsError");
    const { data, error } = await supabase
      .from("sync_runs")
      .select("trigger_source, started_at, finished_at, ok, jobs_updated, codes_upserted, error")
      .order("started_at", { ascending: false })
      .limit(12);
    const body = el("runsBody");
    if (error) {
      showError("runsError", "Could not load sync runs: " + error.message);
      body.innerHTML = '<tr><td colspan="6" class="empty">Unavailable.</td></tr>';
      return;
    }
    if (!data || data.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="empty">No syncs recorded yet.</td></tr>';
      return;
    }
    body.innerHTML = data.map((r) => {
      const secs = r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 100) / 10 : null;
      const status = r.ok === true
        ? '<span class="pill ok">OK' + (secs != null ? ' · ' + secs + 's' : '') + '</span>'
        : (r.ok === false ? '<span class="pill err">Failed</span>' : '<span class="pill muted">Running…</span>');
      return '<tr>' +
        '<td>' + esc(r.trigger_source) + '</td>' +
        '<td>' + fmtDate(r.started_at) + '</td>' +
        '<td>' + status + '</td>' +
        '<td class="tnum">' + esc(r.jobs_updated == null ? 0 : r.jobs_updated) + '</td>' +
        '<td class="tnum">' + esc(r.codes_upserted == null ? 0 : r.codes_upserted) + '</td>' +
        '<td class="muted">' + (r.error ? esc(r.error) : "—") + '</td>' +
        '</tr>';
    }).join("");
  }

  async function loadDataQuality() {
    clearError("dqError");
    const { data, error } = await supabase
      .from("synced_jobs")
      .select("gotphoto_job_id, name, missing_fields")
      .eq("status", "published")
      .limit(1000);
    const body = el("dqBody");
    if (error) {
      showError("dqError", "Could not load data-quality warnings: " + error.message);
      body.innerHTML = '<tr><td colspan="2" class="empty">Unavailable.</td></tr>';
      return;
    }
    const flagged = (data || []).filter((j) => Array.isArray(j.missing_fields) && j.missing_fields.length > 0);
    setAttention("dataQuality", flagged.length, flagged.length === 1 ? "published job is missing search fields" : "published jobs are missing search fields", "company", "warn");
    if (flagged.length === 0) {
      body.innerHTML = '<tr><td colspan="2" class="empty">No published jobs are missing required fields.</td></tr>';
      return;
    }
    body.innerHTML = flagged.map((j) =>
      '<tr><td class="name"><span class="lnk js-open-job" data-job="' + esc(j.gotphoto_job_id) + '">' + esc(j.name) + '</span></td><td>' +
      j.missing_fields.map((f) => '<span class="pill warn">' + esc(f) + '</span>').join(" ") +
      '</td></tr>'
    ).join("");
  }
  el("dqBody").addEventListener("click", (e) => {
    const open = e.target.closest(".js-open-job");
    if (open) showJobsFor({}, { select: open.dataset.job });
  });

  async function runSyncNow(btn) {
    const box = el("syncResult");
    const buttons = [el("syncNowBtn"), el("syncNowBtn2")];
    buttons.forEach((b) => { b.disabled = true; });
    btn.innerHTML = '<span class="spin"></span>Syncing…';
    box.classList.remove("hidden");
    box.innerHTML = '<span class="muted">Contacting GotPhoto and refreshing codes. This can take a moment…</span>';
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast("Session expired — please sign in again.", true); location.reload(); return; }
      const resp = await fetch(ADMIN_FN_URL + "/sync", { method: "POST", headers: { "Authorization": "Bearer " + session.access_token } });
      const text = await resp.text();
      let payload;
      try { payload = JSON.parse(text); } catch (_e) { payload = { raw: text }; }
      if (!resp.ok || payload.ok === false) {
        box.innerHTML = '<span class="pill err">Sync failed</span> <span class="row-msg err">' + esc(payload.error || ("HTTP " + resp.status)) + '</span>';
        toast("Sync failed.", true);
      } else if (payload.skipped) {
        box.innerHTML = '<span class="pill muted">Already running</span> <span class="row-msg">A sync was already in progress; it will pick up your changes.</span>';
        toast("A sync is already running.");
      } else {
        box.innerHTML = '<span class="pill ok">Sync complete</span> <span class="row-msg">' +
          'Jobs checked ' + esc(payload.jobs_checked == null ? 0 : payload.jobs_checked) +
          ' · Jobs updated ' + esc(payload.jobs_updated == null ? 0 : payload.jobs_updated) +
          ' · Codes upserted ' + esc(payload.codes_upserted == null ? 0 : payload.codes_upserted) +
          ' · Codes deleted ' + esc(payload.codes_deleted == null ? 0 : payload.codes_deleted) + '</span>';
        toast("Sync complete.");
      }
    } catch (e) {
      box.innerHTML = '<span class="pill err">Sync failed</span> <span class="row-msg err">' + esc(String(e)) + '</span>';
      toast("Sync failed.", true);
    } finally {
      buttons.forEach((b) => { b.disabled = false; b.textContent = "Sync now"; });
      loadRuns();
      loadDataQuality();
      loadSyncStatus();
      // A sync can add, remove, or republish jobs, so the jobs table is stale the
      // moment the run finishes.
      loadJobs();
    }
  }
  el("syncNowBtn").addEventListener("click", () => runSyncNow(el("syncNowBtn")));
  el("syncNowBtn2").addEventListener("click", () => runSyncNow(el("syncNowBtn2")));

