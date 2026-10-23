  // ================================================================ JOBS > Job calculator (2026-10-17)
  // Book-it-or-pass for one job from athletes, miles, days and purchase rate. Estimate mode for a lead,
  // actual mode for a finished job (real sales + orders from GotPhoto). Cost defaults come from the
  // 2025 P&L, the 2025 GotPhoto order reconciliation (fees and lab per order) and the Captura credit price;
  // changed assumptions are kept in this browser (localStorage) so Jeremiah sets them once.
  const JobCalc = (function () {
  const KEY = "aca-jobcalc-assumptions";
  const DEFAULTS = { wage: 25, perHour: 60, setup: 1, speed: 45, mileRate: 0.725, labCost: 7.60, platform: 11, perImage: 1.00, overhead: 31, minProfit: 500, minPerHour: 100 };
  const ASSUME = Object.keys(DEFAULTS);
  // Averages from every 2025 job plus winter and spring 2026 (full gallery sales). rate = orders / athletes
  // on jobs with a real athlete count; aov = net sales per order; days = picture days per job; ath = typical roster.
  const TYPES = {
    hockey:   { label: "Youth hockey",                      rate: 55, aov: 66, days: 2, ath: 150, note: "Brewer runs 65% as a 7-year partner; a first-year league is nearer 50." },
    gym:      { label: "Gymnastics",                        rate: 72, aov: 76, days: 1, ath: 35 },
    cheer:    { label: "Cheer gym",                         rate: 47, aov: 61, days: 1, ath: 70 },
    wrestling:{ label: "Wrestling club",                    rate: 50, aov: 59, days: 1, ath: 30 },
    football: { label: "Youth football",                    rate: 43, aov: 53, days: 2, ath: 130 },
    soccer:   { label: "Soccer club",                       rate: 42, aov: 49, days: 2, ath: 300 },
    ll:       { label: "Little League / baseball-softball", rate: 30, aov: 54, days: 2, ath: 180 },
    recsport: { label: "Rec soccer / multi-sport",          rate: 34, aov: 49, days: 2, ath: 95 },
    recbb:    { label: "Rec basketball",                    rate: 32, aov: 42, days: 2, ath: 150 },
    swim:     { label: "Swim team",                         rate: 33, aov: 45, days: 2, ath: 60 },
    lax:      { label: "Lacrosse club",                     rate: 31, aov: 47, days: 2, ath: 185 },
    school:   { label: "School photos",                     rate: 30, aov: 61, days: 1, ath: 120, note: "Per student photographed. Siblings share an order, so families run about 35 to 40%. Small elementaries 35+, bigger and older grades 15 to 25." },
    fall:     { label: "School fall sports",                rate: 17, aov: 57, days: 2, ath: 120 },
    spring:   { label: "School spring sports",              rate: 14, aov: 60, days: 2, ath: 115 },
    winter:   { label: "School winter sports",              rate: 14, aov: 55, days: 2, ath: 100 },
    dance:    { label: "Dance (on-site $25 per couple)",    rate: 74, aov: 41, days: 1, ath: 75, fee: 25, note: "Subjects = paid couples. The $25 sitting fee is added to sales; GotPhoto orders are on top." }
  };
  let rendered = false;

  const css = `
  .aca .jc { display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start; }
  .aca .jc .col { flex: 1 1 360px; min-width: 0; }
  .aca .jc h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  .aca .jc h2 + p { margin: 0 0 12px; color: var(--muted); font-size: 13px; max-width: 70ch; }
  .aca .jc .blk { margin-bottom: 28px; }
  .aca .jc .kv { display: grid; grid-template-columns: minmax(0, 1fr) 150px; gap: 0 16px; align-items: center; max-width: 560px; }
  .aca .jc .kv label { padding: 8px 0; border-bottom: 1px solid var(--line2); font-size: 13px; }
  .aca .jc .kv label .m { display: block; color: var(--muted); font-size: 12.5px; font-weight: 400; }
  .aca .jc .kv .in { display: flex; align-items: center; gap: 6px; padding: 6px 0; border-bottom: 1px solid var(--line2); justify-content: flex-end; }
  .aca .jc .kv input[type=number] { width: 84px; text-align: right; }
  .aca .jc .kv .u { font-size: 12.5px; color: var(--faint); min-width: 44px; }
  .aca .jc .kv select { width: 100%; max-width: 150px; }
  .aca .jc .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .aca .jc .chips button { font-weight: 400; }
  .aca .jc .verdict { padding: 14px 0 12px; border-top: 3px solid var(--border); border-bottom: 1px solid var(--border); margin-bottom: 16px; }
  .aca .jc .verdict .big { font-size: 26px; line-height: 32px; font-weight: 700; }
  .aca .jc .verdict.ok { border-top-color: var(--ok-fg); } .aca .jc .verdict.ok .big { color: var(--ok-fg); }
  .aca .jc .verdict.warn { border-top-color: var(--accent); } .aca .jc .verdict.warn .big { color: var(--accent); }
  .aca .jc .verdict.err { border-top-color: var(--err-fg); } .aca .jc .verdict.err .big { color: var(--err-fg); }
  .aca .jc .verdict .why { color: var(--muted); font-size: 13px; margin-top: 4px; max-width: 60ch; }
  .aca .jc .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 16px; margin-bottom: 20px; }
  .aca .jc .stat .n { font-size: 20px; line-height: 26px; font-weight: 700; }
  .aca .jc .stat .l { font-size: 12px; color: var(--faint); font-weight: 600; }
  .aca .jc table td:last-child { text-align: right; font-weight: 600; white-space: nowrap; }
  .aca .jc tr.sub td { color: var(--muted); font-size: 12.5px; padding-top: 2px; border-bottom-color: transparent; }
  .aca .jc tr.sub td:last-child { font-weight: 400; }
  .aca .jc tr.total td { border-top: 2px solid var(--text); border-bottom: 0; font-weight: 700; font-size: 15px; }
  .aca .jc .be { color: var(--muted); font-size: 13px; max-width: 60ch; margin-top: 16px; }
  .aca .jc details { margin-top: 8px; }
  .aca .jc details summary { cursor: pointer; font-weight: 600; font-size: 13px; padding: 8px 0; list-style: none; }
  .aca .jc details summary::before { content: "+ "; color: var(--accent); }
  .aca .jc details[open] summary::before { content: "\\2013 "; }
  .aca .jc .acts { margin-top: 12px; display: flex; gap: 8px; }
  @media (max-width: 520px) { .aca .jc .stats { grid-template-columns: 1fr 1fr; } .aca .jc .kv { grid-template-columns: minmax(0, 1fr) 130px; } }`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  const money = (n) => (n < 0 ? "-$" : "$") + Math.round(Math.abs(n)).toLocaleString("en-US");
  const pct = (n) => Math.round(n) + "%";
  const q = (id) => document.getElementById("aca-jc-" + id);
  const num = (id) => { const v = parseFloat(q(id).value); return isNaN(v) ? 0 : v; };
  const row = (id, label, val, unit, hint, step, min) => '<label for="aca-jc-' + id + '">' + label + (hint ? '<span class="m">' + hint + '</span>' : '') + '</label>' +
    '<div class="in"><input type="number" id="aca-jc-' + id + '" value="' + val + '" step="' + (step || 1) + '" min="' + (min == null ? 0 : min) + '"><span class="u">' + (unit || '') + '</span></div>';

  // Assumptions are saved for everyone in admin_settings.calc_assumptions (ws/settings 2026-10-24); they used to be
  // per device (localStorage KEY). A device's old values are used once, when nothing is saved yet, and then saved.
  const fill = (o) => { if (o) ASSUME.forEach((k) => { if (o[k] != null) q(k).value = o[k]; }); };
  async function loadAssumptions() {
    let saved = null;
    try { const { data } = await supabase.from("admin_settings").select("calc_assumptions").maybeSingle(); saved = data && data.calc_assumptions; } catch (e) {}
    if (saved) { fill(saved); calc(); return; }
    let local = null; try { local = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) {}
    if (local) { fill(local); calc(); saveNow(); }
  }
  async function saveNow() {
    const o = {}; ASSUME.forEach((k) => { o[k] = num(k); });
    const { error } = await supabase.from("admin_settings").upsert({ id: true, calc_assumptions: o });
    const n = q("saved"); if (n) n.textContent = error ? "Could not save: " + (error.message || error) : "Saved for everyone.";
  }
  let saveTimer = null;
  function saveAssumptions() { clearTimeout(saveTimer); const n = q("saved"); if (n) n.textContent = "Saving\u2026"; saveTimer = setTimeout(saveNow, 600); }

  function render() {
    const root = el("panel-calc");
    root.innerHTML =
      '<div class="pagehead"><div><h1>Job calculator</h1><p>Type what you know about a job and get a book-it-or-pass answer. Use it on a new lead (estimate) or a finished job (real sales and orders from GotPhoto). Labor is charged at the hourly rate even for salaried time, so the verdict stays conservative. Set picture days a year to score a rec department as a partner, not a single trip. "Adds this week" treats Ryan&rsquo;s salaried hours as already paid when his week has room.</p></div></div>' +
      '<div class="jc"><div class="col">' +
        '<div class="blk"><h2>The job</h2><p>Pick the job type and the purchase rate, average order and picture days fill in from our own averages. Change anything.</p>' +
          '<div class="kv">' +
            '<label for="aca-jc-type">Job type<span class="m" id="aca-jc-typenote"></span></label><div class="in"><select id="aca-jc-type">' + Object.keys(TYPES).map((k) => '<option value="' + k + '">' + TYPES[k].label + '</option>').join("") + '</select></div>' +
            row("athletes", "Subjects", 150, "", "Athletes, students, or couples. Typical for this type: <span id=\"aca-jc-typeath\"></span>") +
            row("miles", "Miles from Hampden", 20, "mi", "One way.") +
            row("days", "Picture days", 1, "", "Separate trips. Setup and driving repeat each day.", 1, 1) +
            row("payout", "League payout", 0, "% sales", "0 if none. Partner Plan is 10.") +
            row("perks", "Perks given", 0, "$", "Plaques, banner.", 10) +
            row("extraHours", "Extra hours", 0, "hrs", "Makeups, team builds, a needy contact.", 0.5) +
            row("seasons", "Picture days a year with this partner", 1, "", "A rec department runs 3 seasons; add 1 if the town does a dance. Clubs and gyms are usually 1.", 1, 1) +
            row("procSec", "Backend time per subject", 60, "sec", "Sorting, naming, extraction, templates, QC. 60 = a minute each. A league you can batch runs closer to 30.", 15) +
            row("staffShare", "Share of the hours Ryan does", 60, "%", "Salaried. The rest is your own time, charged at the hourly rate.", 10) +
            '<label for="aca-jc-staffWeek">Ryan\'s week<span class="m">Salary is paid either way. Open hours cost nothing extra; a full week means this job displaces other work.</span></label><div class="in"><select id="aca-jc-staffWeek"><option value="open">Has open hours</option><option value="full">Fully booked</option></select></div>' +
          '</div></div>' +
        '<div class="blk"><h2>Sales</h2>' +
          '<div class="kv">' +
            '<label for="aca-jc-mode">What do you know?</label><div class="in"><select id="aca-jc-mode"><option value="est">Estimate (new lead)</option><option value="actual">Real numbers</option></select></div>' +
            '<div class="est" style="display:contents">' + row("rate", "Families who order", 50, "%", "Percent of subjects. Fills from the job type.") + row("aov", "Average order", 55, "$", "Net of tax. Fills from the job type.") + '</div>' +
            '<div class="actual" style="display:none">' + row("salesActual", "Sales before tax", 4400, "$", "From the GotPhoto job statistics.", 10) + row("ordersActual", "Orders", 80, "") + '</div>' +
          '</div></div>' +
        '<details><summary>Assumptions (saved for everyone) <span class="muted" id="aca-jc-saved" style="font-weight:400;font-size:12.5px"></span></summary><div class="kv" style="margin-top:8px">' +
          row("wage", "Hourly labor cost", 25, "$/hr") +
          row("perHour", "Subjects photographed per hour", 60, "", "", 5, 1) +
          row("setup", "Setup and teardown per day", 1, "hrs", "", 0.25) +
          row("speed", "Average driving speed", 45, "mph", "", 5, 10) +
          row("mileRate", "Mileage cost", 0.725, "$/mi", "IRS 2026 rate.", 0.005) +
          row("labCost", "Lab and shipping per order", 7.60, "$", "2025 GotPhoto reconciliation: $40,697 on 5,360 orders. Print orders cost about $10.30; 26% of orders are digital.", 0.1) +
          row("platform", "Platform and card fees", 11, "% sales", "2025: 7.3% GotPhoto service fee plus 3.6% card fees, $31,022 on $283,591.", 0.5) +
          row("perImage", "Per-subject costs", 1.00, "$", "Extraction $0.18 plus templates $0.78 (2025 P&amp;L).", 0.01) +
          row("overhead", "Overhead", 31, "% sales", "2025 P&amp;L, $312,823 sales. Counted: software, storage, website, internet and phone $13,512; salaried hours not on any job (about 865 hrs) $21,616; meals $20,086; studio rent, heat, trash and repairs $14,761; a $10,000 a year gear allowance; marketing, props, backdrops and uniforms $7,698; office supplies, postage, dues and interest $6,422; travel, conferences and education $3,774. Total $97,869 = 31%. Left out: prints, templates, job wages and auto (charged per job above), digital services, income taxes, health insurance, the 2025 gear purchases, entertainment and gifts, payroll taxes.", 0.5) +
          row("minProfit", "Minimum profit to book", 500, "$", "", 50) +
          row("minPerHour", "Minimum profit per hour", 100, "$/hr", "", 5) +
        '</div><div class="acts"><button type="button" class="small" id="aca-jc-reset">Reset to defaults</button></div></details>' +
      '</div><div class="col">' +
        '<div class="verdict ok" id="aca-jc-verdict" aria-live="polite"><div class="big" id="aca-jc-vt"></div><div class="why" id="aca-jc-vw"></div></div>' +
        '<div class="stats">' +
          '<div class="stat"><div class="n" id="aca-jc-sProfit"></div><div class="l">Profit</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sPerHour"></div><div class="l">Per labor hour</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sMargin"></div><div class="l">Margin</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sSales"></div><div class="l">Sales</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sPerAthlete"></div><div class="l">Profit per subject</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sHours"></div><div class="l">Total hours</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sYearProfit"></div><div class="l">Profit per year</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sYearContrib"></div><div class="l">Before overhead, per year</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sYearHours"></div><div class="l">Hours per year</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sAdds"></div><div class="l">Adds this week (cash, before overhead)</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sAddsYear"></div><div class="l">Adds per year</div></div>' +
          '<div class="stat"><div class="n" id="aca-jc-sOwnerHrs"></div><div class="l">Your own hours</div></div>' +
        '</div>' +
        '<h2>Where the money goes</h2>' +
        '<table><tbody>' +
          '<tr><td>Sales</td><td id="aca-jc-rSales"></td></tr><tr class="sub"><td id="aca-jc-rOrders" colspan="2"></td></tr>' +
          '<tr><td>Lab and shipping</td><td id="aca-jc-rLab"></td></tr>' +
          '<tr><td>Platform and card fees</td><td id="aca-jc-rFees"></td></tr>' +
          '<tr><td>Labor</td><td id="aca-jc-rLabor"></td></tr><tr class="sub"><td id="aca-jc-rHours" colspan="2"></td></tr>' +
          '<tr><td>Mileage</td><td id="aca-jc-rMiles"></td></tr>' +
          '<tr><td>League payout</td><td id="aca-jc-rPayout"></td></tr>' +
          '<tr><td>Perks</td><td id="aca-jc-rPerks"></td></tr>' +
          '<tr><td>Per-subject costs (extraction, templates)</td><td id="aca-jc-rImage"></td></tr>' +
          '<tr><td>Overhead share</td><td id="aca-jc-rOverhead"></td></tr>' +
          '<tr class="total"><td>Profit</td><td id="aca-jc-rProfit"></td></tr>' +
        '</tbody></table>' +
        '<p class="be" id="aca-jc-be"></p>' +
      '</div></div>';

    root.querySelectorAll("input,select").forEach((e) => e.addEventListener("input", () => { if (ASSUME.includes(e.id.replace("aca-jc-", ""))) saveAssumptions(); if (e.id === "aca-jc-mode") setMode(); calc(); }));
    q("type").addEventListener("change", () => { applyType(); calc(); });
    applyType();
    q("reset").addEventListener("click", () => { ASSUME.forEach((k) => { q(k).value = DEFAULTS[k]; }); saveAssumptions(); calc(); });
    loadAssumptions(); setMode(); calc();
    rendered = true;
  }

  function applyType() {
    const t = TYPES[q("type").value];
    q("rate").value = t.rate; q("aov").value = t.aov; q("days").value = t.days;
    q("typeath").textContent = t.ath + " subjects, " + t.rate + "% order, $" + t.aov + " average order";
    q("typenote").textContent = t.note || "";
  }
  function setMode() {
    const actual = q("mode").value === "actual";
    el("panel-calc").querySelector(".est").style.display = actual ? "none" : "contents";
    el("panel-calc").querySelector(".actual").style.display = actual ? "contents" : "none";
  }

  function calc() {
    const mode = q("mode").value;
    const athletes = num("athletes"), miles = num("miles"), days = Math.max(1, num("days"));
    const payoutPct = num("payout"), perks = num("perks"), extra = num("extraHours"), seasons = Math.max(1, num("seasons"));
    const staffShare = Math.min(100, Math.max(0, num("staffShare"))) / 100, staffOpen = q("staffWeek").value === "open";
    const wage = num("wage"), perHour = Math.max(1, num("perHour")), procSec = num("procSec"), setup = num("setup");
    const speed = Math.max(1, num("speed")), mileRate = num("mileRate"), labCost = num("labCost"), platform = num("platform");
    const perImage = num("perImage"), overheadPct = num("overhead"), minProfit = num("minProfit"), minPerHour = num("minPerHour");

    const fee = (TYPES[q("type").value].fee || 0) * athletes;   // on-site sitting fee (dances); card fee only, no GotPhoto fee
    let orders, gp, aov;
    if (mode === "actual") { gp = num("salesActual"); orders = num("ordersActual"); aov = orders ? gp / orders : 0; }
    else { aov = num("aov"); orders = athletes * num("rate") / 100; gp = orders * aov; }
    const sales = gp + fee;

    const photoHrs = athletes / perHour, procHrs = athletes * procSec / 3600, driveHrs = (miles * 2 / speed) * days, setupHrs = setup * days;
    const hours = photoHrs + procHrs + driveHrs + setupHrs + extra;
    const lab = orders * labCost, fees = gp * platform / 100 + fee * 0.03, labor = hours * wage, mileage = miles * 2 * days * mileRate;
    const payout = sales * payoutPct / 100, imageCost = athletes * perImage, overhead = sales * overheadPct / 100;
    const profit = sales - lab - fees - labor - mileage - payout - perks - imageCost - overhead;
    const perLaborHour = hours ? profit / hours : 0, margin = sales ? profit / sales * 100 : 0, perAthlete = athletes ? profit / athletes : 0;
    const yearProfit = profit * seasons, yearContrib = (profit + overhead) * seasons, yearHours = hours * seasons;
    // what the job adds in cash this week: Ryan's hours are free when his week has open time (salary already paid); your own hours always count
    const staffHrs = hours * staffShare, ownerHrs = hours - staffHrs, laborCash = ownerHrs * wage + (staffOpen ? 0 : staffHrs * wage);
    const adds = sales - lab - fees - laborCash - mileage - payout - perks - imageCost, addsYear = adds * seasons;

    let cls, text, why;
    if (sales <= 0) { cls = "err"; text = "Pass"; why = "No sales means no job."; }
    else if (profit >= minProfit && perLaborHour >= minPerHour) { cls = "ok"; text = "Book it"; why = "Clears both bars: " + money(profit) + " profit (min " + money(minProfit) + ") and " + money(perLaborHour) + " per hour (min " + money(minPerHour) + ")."; }
    else if (profit >= minProfit * 0.6 && perLaborHour >= minPerHour * 0.6) { cls = "warn"; text = "Borderline";
      why = (profit < minProfit ? "Profit " + money(profit) + " is under the " + money(minProfit) + " minimum. " : "") + (perLaborHour < minPerHour ? "Per-hour rate " + money(perLaborHour) + " is under the " + money(minPerHour) + " minimum. " : "") + "Worth it if the league can lift the purchase rate or it pairs with another job nearby."; }
    else { cls = "err"; text = "Pass"; why = "Only " + money(profit) + " profit at " + money(perLaborHour) + " per hour. " + (mode === "est" ? "Needs a much higher purchase rate or a bigger roster to work." : "Drop it next season unless the league commits to pushing the gallery link."); }
    if (text !== "Book it" && staffOpen && staffShare > 0 && adds >= minProfit && (ownerHrs === 0 || adds / ownerHrs >= minPerHour * 0.5)) { cls = "warn"; text = "Take it: covers payroll"; why = "Fully loaded it is " + money(profit) + ", but Ryan's " + staffHrs.toFixed(1) + " hours are already paid for this week, so the job adds " + money(adds) + " in cash" + (ownerHrs ? " for " + ownerHrs.toFixed(1) + " hours of your own time (" + money(adds / ownerHrs) + "/hr)" : "") + (seasons > 1 ? ", " + money(addsYear) + " over " + seasons + " picture days a year" : "") + ". Overhead and salary are covered by the season as a whole; this job helps pay for them."; }
    else if (seasons > 1 && text !== "Book it" && yearProfit >= minProfit && perLaborHour >= minPerHour * 0.5) { cls = "warn"; text = "Worth it as a partner"; why = "One picture day only clears " + money(profit) + ", but " + seasons + " a year is " + money(yearProfit) + " profit and " + money(yearContrib) + " before overhead, with no trip wasted. Rec partners also add dances and raise their purchase rate over time (Brewer: 50% in year one, 65% in year seven)."; }
    else if (seasons > 1) { why += " Over " + seasons + " picture days a year: " + money(yearProfit) + " profit, " + money(yearContrib) + " before overhead."; }
    q("verdict").className = "verdict " + cls; q("vt").textContent = text; q("vw").textContent = why;

    q("sProfit").textContent = money(profit); q("sPerHour").textContent = money(perLaborHour); q("sMargin").textContent = pct(margin);
    q("sSales").textContent = money(sales); q("sPerAthlete").textContent = money(perAthlete); q("sHours").textContent = hours.toFixed(1);
    q("sYearProfit").textContent = money(yearProfit); q("sYearContrib").textContent = money(yearContrib); q("sYearHours").textContent = yearHours.toFixed(0);
    q("sAdds").textContent = money(adds); q("sAddsYear").textContent = money(addsYear); q("sOwnerHrs").textContent = ownerHrs.toFixed(1) + " of " + hours.toFixed(1);
    q("rSales").textContent = money(sales);
    q("rOrders").textContent = Math.round(orders) + " orders at " + money(aov) + " average" + (mode === "est" ? " (" + num("rate") + "% of " + athletes + " subjects)" : "") + (fee ? " + " + money(fee) + " in sitting fees" : "");
    q("rLab").textContent = "-" + money(lab); q("rFees").textContent = "-" + money(fees); q("rLabor").textContent = "-" + money(labor);
    q("rHours").textContent = photoHrs.toFixed(1) + " photo + " + procHrs.toFixed(1) + " processing + " + setupHrs.toFixed(1) + " setup + " + driveHrs.toFixed(1) + " driving" + (extra ? " + " + extra + " extra" : "") + " hrs; Ryan " + staffHrs.toFixed(1) + " (" + (staffOpen ? "already paid this week" : "counted, week is full") + "), you " + ownerHrs.toFixed(1);
    q("rMiles").textContent = "-" + money(mileage); q("rPayout").textContent = "-" + money(payout); q("rPerks").textContent = "-" + money(perks);
    q("rImage").textContent = "-" + money(imageCost); q("rOverhead").textContent = "-" + money(overhead); q("rProfit").textContent = money(profit);

    const fixed = labor + mileage + perks + imageCost - fee * 0.97;
    const perOrderNet = aov * (1 - platform / 100 - payoutPct / 100 - overheadPct / 100) - labCost;
    let be;
    if (perOrderNet > 0 && athletes > 0) {
      const need = (fixed + minProfit) / perOrderNet, zero = fixed / perOrderNet;
      be = "To hit the " + money(minProfit) + " minimum this job needs " + Math.ceil(need) + " orders (" + pct(need / athletes * 100) + " of " + athletes + " subjects). It breaks even at " + Math.ceil(zero) + " orders (" + pct(zero / athletes * 100) + "). Each extra order is worth about " + money(perOrderNet) + ".";
    } else if (perOrderNet <= 0) be = "At this average order and fee level each order loses money. Raise the average order or cut the payout.";
    else be = "Enter a subject count to see break-even.";
    q("be").textContent = be;
  }

  function load() { if (!rendered) render(); }
  return { load };
  })();
