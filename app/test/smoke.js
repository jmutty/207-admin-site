// Offline smoke test: loads test/harness.html (fake Supabase, no network) as the owner and as a limited
// staff member, clicks every menu item, and checks access gating. Run after `python3 build.py`:
//   node test/smoke.js            (needs Playwright; in Claude Code cloud: NODE_PATH=/opt/node-tools/node_modules)
// Exits non-zero on any page error or failed check.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) failures++; };

async function open(browser, port, query, hash) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("dialog", (d) => d.accept());
  await page.goto(`http://127.0.0.1:${port}/test/harness.html${query}${hash || ""}`);
  await page.waitForSelector("#aca-nav button[data-tab]");
  await page.waitForTimeout(400);
  return { page, errors };
}
const rail = (page) => page.$$eval("#aca-nav button[data-tab]", (bs) => bs.map((b) => b.dataset.tab));
const visible = (page, sel) => page.$eval(sel, (n) => !n.closest(".hidden") && !n.classList.contains("hidden"));
const shown = (page, sel) => page.$eval(sel, (n) => !n.classList.contains("hidden")); // ignores a closed menu around it

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});

  console.log("Owner (full access)");
  {
    const { page, errors } = await open(browser, port, "");
    const items = await rail(page);
    // ws/settings: the new Settings tabs (settingsmore) are their own entry until the shell's MENU lists them under Settings
    check(JSON.stringify(items) === JSON.stringify(["today", "myday", "orgs", "jobs", "parents", "schedule", "tasks", "people", "timepay", "inventory", "sending"]), "menu has every page: " + items.join(","));
    const FIRST = { jobs: "bookings", parents: "requests", people: "team", timepay: "clock", settingsmore: "teamemails" };
    for (const t of items) {
      await page.click(`#aca-nav button[data-tab="${t}"]`);
      await page.waitForTimeout(150);
      check(await page.$eval(`#aca-panel-${FIRST[t] || t}`, (n) => n.classList.contains("active")), `opens ${t}`);
      check(!(await visible(page, "#aca-viewOnly")), `${t}: no view-only notice`);
    }
    const tabsOf = async (t) => { await page.click(`#aca-nav button[data-tab="${t}"]`); await page.waitForTimeout(100); return page.$$eval("#aca-pagetabs button[data-tab]", (bs) => bs.map((b) => b.dataset.tab)); };
    check(JSON.stringify(await tabsOf("myday")) === JSON.stringify(["myday", "crew"]), "My day: my day and my jobs");
    check(JSON.stringify(await tabsOf("orgs")) === JSON.stringify(["orgs", "outbox", "rebook", "reviews", "agreements"]), "Partners: the lists across partners (Outreach to review is in the Outbox, no Payouts tab)");
    check((await page.textContent('#aca-nav button[data-tab="orgs"]')).startsWith("Partners") && (await page.textContent("#aca-pagetabs")).includes("All partners"), "Organizations is called Partners");
    check(JSON.stringify(await tabsOf("jobs")) === JSON.stringify(["bookings", "jobs", "resjobs"]), "Jobs: all jobs, galleries, one Sales tab (Hub activity is on each job)");
    check((await page.textContent('#aca-pagetabs button[data-tab="resjobs"]')).startsWith("Sales"), "the money tab is called Sales");
    check(JSON.stringify(await tabsOf("parents")) === JSON.stringify(["requests", "makeups", "retakes", "searchlog", "settings", "blocks"]), "Parents: one page with tabs");
    check((await page.textContent("#aca-pagetabs")).includes("Search rules") && (await page.textContent("#aca-pagetabs")).includes("Blocked"), "Parents: Search rules and Blocked");
    check(JSON.stringify(await tabsOf("schedule")) === JSON.stringify(["schedule", "openjobs", "timeoff"]), "Schedule: open jobs, time off");
    check((await page.textContent("#aca-pagetabs")).includes("Open jobs"), "Schedule: the tab is called Open jobs");
    check(JSON.stringify(await tabsOf("tasks")) === JSON.stringify([]) && await page.$eval("#aca-panel-tasks", (n) => n.classList.contains("active")), "Tasks: tasks only");
    check(JSON.stringify(await tabsOf("people")) === JSON.stringify(["team", "clearances", "onboarding"]), "People: team, clearances, onboarding");
    check(JSON.stringify(await tabsOf("sending")) === JSON.stringify(["sending", "teamemails", "jobtypes", "teampay", "company", "library", "delivery", "calc"]), "Settings: Sending, Team emails, Job types, Team & pay, Company, Email library, Bounced, Job calculator: " + (await tabsOf("sending")).join(","));
    check((await page.textContent("#aca-nav")).includes("Work") && !(await page.textContent("#aca-nav")).includes("Outreach"), "Partners, Jobs and Parents sit under Work");
    await page.click('#aca-nav button[data-tab="today"]');
    await page.waitForTimeout(300);
    const areas = await page.$$eval("#aca-todayList .today-area .today-an", (ns) => ns.map((n) => n.textContent));
    check(areas.length >= 2 && areas.every((a) => ["My work", "Partners", "Jobs", "Parents", "Team", "Gear", "System", "Other"].includes(a)), "Today: counts per area: " + areas.join(","));
    const shut = await page.$("#aca-todayList .today-area:not(.open)");
    if (shut) { await shut.click(); }
    check(!shut || await page.$eval("#aca-todayList .today-area .today-ah[aria-expanded=true]", (n) => !!n), "the caret opens an area");
    check(await visible(page, "#aca-bookBtn") && !(await visible(page, "#aca-syncNowBtn")), "Book a job shown; Sync GotPhoto now is no longer in the account menu");
    // Team: add a person
    await page.click('#aca-nav button[data-tab="people"]');
    await page.waitForSelector("#aca-teamBody [data-edit]");
    check((await page.$$("#aca-teamBody tr")).length === 5, "team list shows 5 people");
    check((await page.$$eval("#aca-teamBody .tm-role", (n) => n.map((x) => x.textContent))).join(",").includes("Second shooter,Check-in"), "team list shows each person's crew roles");
    await page.click("#aca-teamAdd");
    await page.fill("#aca-tmName", "New Person");
    await page.fill("#aca-tmEmail", "new@207photo.com");
    await page.check('input[name="tm-bookings"][value="edit"]', { force: true });
    await page.check('input[name="tm-scheduling"][value="view"]', { force: true });
    await page.click("#aca-tmSave");
    await page.waitForSelector("#aca-tmPw");
    check((await page.textContent("#aca-tmPw")) === "k7mp-2qrx-h8vt-w3nd", "temporary password shown once");
    const call = await page.evaluate(() => window.__teamCalls[0]);
    check(call.action === "create" && call.permissions.bookings === "edit" && call.permissions.scheduling === "view" && !call.permissions.parents, "create sends only the chosen modules");
    await page.click("#aca-tmDone");
    // Edit someone: full access hides the grid; save goes to team_save
    await page.click('[data-edit="u2"]');
    await page.check("#aca-tmAdmin");
    check(!(await visible(page, "#aca-tmGrid")), "full access hides the module grid");
    await page.uncheck("#aca-tmAdmin");
    // ws/settings: the grid is folded under Change access, named like the menu; modules with no page are hidden
    check(!(await page.$eval("#aca-tmMore", (d) => d.open)), "access grid starts folded");
    await page.click("#aca-tmMore > summary");
    check(!(await page.$('input[name="tm-taskboard"]')), "a module with no page (Task board) is not offered");
    check((await page.textContent("#aca-tmGrid")).includes("Open jobs") && (await page.textContent("#aca-tmGrid")).includes("Timesheets"), "grid uses the menu's words");
    await page.selectOption("#aca-tmCopyFrom", "u6");
    check(await page.isChecked('input[name="tm-timeclock"][value="view"]') && await page.isChecked('input[name="tm-bookings"][value="none"]'), "Copy access from someone");
    await page.click('[data-preset="office"]');
    check(await page.isChecked('input[name="tm-bookings"][value="edit"]'), "Office preset");
    await page.check('input[name="tm-parents"][value="edit"]', { force: true });
    await page.click("#aca-tmCancel");
    check(!(await page.$eval(".tm-logcard", (d) => d.open)), "Recent changes starts folded shut");
    const logTxt = await page.textContent("#aca-teamLog");
    check(logTxt.includes("added Sam Helper · welcome email sent, crew roles") && (await page.$$("#aca-teamLog li")).length === 2, "one save reads as one Recent changes entry");
    check((await page.textContent("#aca-teamBody")).includes("Custom") && !(await page.isVisible(".tm-accsum > div")), "access is a summary; the full list folds open");
    await page.click('[data-edit="u2"]');
    await page.click("#aca-tmMore > summary");
    await page.selectOption("#aca-tmCopyFrom", "u6");
    await page.click('[data-preset="office"]');
    await page.check('input[name="tm-parents"][value="edit"]', { force: true });
    await page.fill("#aca-tmHome", "60 main");
    await page.waitForSelector("#aca-tmHome-places:not(.hidden) button[data-i]");
    await page.click("#aca-tmHome-places button[data-i]");
    await page.waitForFunction(() => document.querySelector("#aca-tmHome").value === "60 Main Rd N, Hampden, ME 04444");
    check(true, "Home address suggests Google Maps addresses and a pick fills the full address");
    await page.fill("#aca-tmHome", "Bangor");
    await page.click("#aca-tmSave");
    await page.waitForTimeout(200);
    const save = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "team_save").pop());
    check(save && save[1].p_permissions.parents === "edit" && save[1].p_permissions.bookings === "edit" && save[1].p_is_admin === false, "edit saves through team_save");
    check(save && save[1].p_permissions.taskboard === undefined, "a hidden module the person did not have stays off");
    const home = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "team_set_home").pop());
    check(home && home[1].p_home === "Bangor" && home[1].p_user_id === "u2", "a home address (or just the town) saves from the Team page");
    // Remove: only offered for deactivated people
    await page.click('[data-edit="u2"]');
    check(!(await page.$("#aca-tmRemove")), "no Remove button for an active person");
    await page.click("#aca-tmCancel");
    await page.click('[data-edit="u3"]');
    await page.click("#aca-tmRemove");
    await page.waitForTimeout(200);
    const rm = await page.evaluate(() => window.__teamCalls.pop());
    check(rm.action === "remove" && rm.user_id === "u3", "Remove sends the remove action");
    // Cmd-K finds Team
    await page.keyboard.press("Control+k");
    await page.fill("#aca-gsInput", "team");
    await page.waitForTimeout(250);
    check((await page.textContent("#aca-gsList")).includes("Team"), "Cmd-K lists the Team page");
    await page.keyboard.press("Escape");
    // Notifications (account menu)
    await page.click("#aca-whoBtn");
    await page.click("#aca-notifBtn");
    await page.waitForSelector("[data-topic]");
    check((await page.$$(".pn-mode")).length === 3, "Notifications lists the kinds this person can get");
    // Headless Chromium reports notifications as blocked; a real browser offers "Turn on".
    check(await page.isVisible("#aca-pnOn") || (await page.textContent("#aca-pnBody")).includes("blocked"), "shows this device's notification state");
    check((await page.textContent("#aca-pnBody")).includes("iPhone"), "lists their other devices");
    check((await page.$$('.pn-mode input[data-topic="help_request"]')).length === 3, "each kind: Push now, Morning email or Off");
    await page.click('.pn-mode input[data-topic="help_request"][value="email"] + span');
    await page.waitForTimeout(150);
    const pref = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "push_set_mode").pop());
    check(pref && pref[1].p_topic === "help_request" && pref[1].p_mode === "email", "moving a kind to the morning email saves it");
    await page.click("#aca-pnDone");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Bookings: stages and deliverables (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#jobs/bookings");
    const lastRpc = (n) => page.evaluate((n) => window.__rpcCalls.filter((c) => c[0] === n).pop(), n);
    await page.waitForSelector("#aca-bkBody tr.bk-row");
    const row1 = await page.textContent('#aca-bkBody tr[data-id="bk1"] .bk-c-stage');
    check(row1.includes("In production") && row1.includes("1 of 3 delivered") && row1.includes("1 overdue"), "list shows the stage and deliverables: " + row1.trim());
    check((await page.textContent('#aca-bkBody tr[data-id="bk2"] .bk-c-stage')).includes("Booked"), "list shows Booked for a new job");
    const bk2When = await page.textContent('#aca-bkBody tr[data-id="bk2"] .bk-date');
    check(/^\d+\/\d+, \d+\/\d+, \d+\/\d+$/.test(bk2When.trim()), "a multi-day job lists each of its three dates, not a range: " + bk2When);
    await page.selectOption("#aca-bkStage", ":overdue");
    check((await page.$$("#aca-bkBody tr.bk-row")).length === 1, "Deliverables overdue filter");
    await page.selectOption("#aca-bkStage", "Booked");
    check((await page.$$("#aca-bkBody tr.bk-row")).length === 1, "stage filter by name");
    await page.selectOption("#aca-bkStage", "");
    // ws/jobs: All jobs heading and toolbar, the checklist chip; a row opens the job page (no preview)
    check((await page.textContent("#aca-panel-bookings .card-head h2")) === "All jobs", "heading says All jobs");
    check(await page.$eval("#aca-panel-bookings .bk-tools", (n) => n.firstElementChild.id) === "aca-bkNew", "+ Book a job comes first");
    check(!(await page.$("#aca-bkMore")) && !(await page.$("#aca-bkTrack")) && !(await page.$("#aca-bkJobTypes")), "no Track a job or Job types link beside Book a job (Job types is in Settings)");
    check((await page.textContent('#aca-bkBody tr[data-id="bk3"] .bk-c-stage')).includes("Checklist: 2 to do, 1 late"), "checklist chip on the row");
    await page.selectOption("#aca-bkStage", ":checklate");
    check((await page.$$("#aca-bkBody tr.bk-row")).length === 1, "Checklist steps late filter");
    await page.selectOption("#aca-bkStage", "");
    await page.click('#aca-bkBody tr[data-id="bk1"]');
    await page.waitForSelector("#aca-jpTabs button");
    check(page.url().endsWith("#jobs/job/bk1") && await page.$eval("#aca-bkPanel", (n) => n.classList.contains("hidden")), "a row goes straight to the job page, no preview");
    // Email the job's contacts from the job page (2026-10-23)
    await page.waitForSelector("#aca-jpMails h3");
    check((await page.textContent("#aca-jpMails")).includes("Gym change"), "Overview lists emails sent from this job");
    await page.click('#aca-jpMails a[data-mail]');
    check(await page.isVisible("#aca-jpMails .jp-mailbody"), "an email opens to show what it said");
    await page.click('.jp-head button[data-j="email"]');
    await page.waitForSelector("#aca-ogJeTo");
    check(await page.isChecked('#aca-ogJeTo input[value="c1"]') && await page.isDisabled('#aca-ogJeTo input[value="c3"]'), "Email: the job's contacts are ticked, a bounced one can't be");
    check((await page.inputValue("#aca-ogJeSubj")).includes("Winter Sports"), "Email: subject starts as the job name");
    await page.fill("#aca-ogJeBody", "Hi Chris, quick question.");
    await page.click('.og-modal button[data-v="now"]');
    await page.waitForTimeout(250);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "job_email_send" && c[1].p_booking === "bk1" && c[1].p_now === true && c[1].p_contacts.join() === "c1")), "Send now calls job_email_send for the ticked people");
    check(!(await page.$("#aca-ogJeTo")), "the composer closes once sent");
    // Remove someone from a job's emails, on Overview and on the Booking tab (2026-10-23)
    await page.waitForSelector("#aca-jpBody button[data-rmc]");
    check((await page.$$("#aca-jpBody button[data-rmc]")).length === 2, "Overview: Remove next to each person who gets the emails");
    await page.click('#aca-jpBody button[data-rmc="c3"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "booking_contact_remove" && c[1].p_contact === "c3" && c[1].p_booking === "bk1")), "Overview Remove calls booking_contact_remove");
    await page.waitForSelector("#aca-jpTabs button");
    await page.click('#aca-jpTabs button[data-t="booking"]');
    await page.waitForSelector("#aca-bkDetail .bk-stages");
    check((await page.$$('#aca-bkDetail button[data-v="whorm"]')).length === 2, "Booking tab: Remove next to each person who gets the emails");
    check((await page.textContent("#aca-bkDetail")).includes("not emailed"), "Booking tab: a stopped contact is marked not emailed");
    await page.click('#aca-bkDetail button[data-v="whorm"][data-cid="c3"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "booking_contact_remove").length === 2), "Booking tab Remove calls booking_contact_remove");
    await page.waitForSelector("#aca-bkDetail .bk-stages");
    check((await page.$$("#aca-bkDetail .bk-stages li")).length === 6, "Booking tab shows the type's six stages");
    check((await page.textContent("#aca-bkDetail .bk-stages li.cur")).includes("In production"), "current stage highlighted");
    check((await page.$$("#aca-bkDetail .bk-stages li.done")).length === 2, "earlier stages ticked");
    check((await page.$$('#aca-panel-job button[data-j="edit"]')).length === 1 && !(await page.$('#aca-bkDetail [data-v="edit"]')), "one Edit button: Edit booking in the header");
    check((await page.$$("#aca-bkDetail .bk-gp")).length <= 1, "one GotPhoto create block");
    check(!(await page.$('#aca-bkDetail a[href*="config_jobs/create"]')), "no link to GotPhoto's retired create page");
    const gpMake = await page.$('#aca-bkDetail button[data-v="gpmake"]');
    if (gpMake) {
      await gpMake.click();
      await page.waitForSelector("#aca-gpcprice");
      check((await page.$eval("#aca-gpcaccess", (n) => n.options[n.selectedIndex].text)) === "Each person: QR-Tagging \u2013 with list of names" &&
        (await page.$eval("#aca-gpcprice", (n) => n.value)) === "pp-fall", "check screen shows what the GotPhoto job would get");
      await page.selectOption("#aca-gpcprice", "pp-spring");
      await page.click('.og-modal [data-v="make"]');
      await page.waitForTimeout(300);
      check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "gp_type_defaults_save" && c[1].p.price_profile_id === "pp-spring" && c[1].p.labels.price_profile_id === "Spring Sports 2027" && c[1].p.access_type === "qr_tagging" && c[1].p.password_source === "qr_code_list")), "a changed price list on the check screen becomes the job type's default");
      check(await page.evaluate(() => (window.__gpjobCalls || []).some((u) => u.includes("/admin/gpjob?booking=bk1") && !u.includes("dry"))), "Create in GotPhoto calls admin /gpjob for the booking");
    }
    await page.click('#aca-bkDetail button[data-next="1"]');
    await page.waitForTimeout(150);
    const mv = await lastRpc("booking_set_stage");
    check(mv && mv[1].p_stage === "st-sports_data-3" && mv[1].p_booking === "bk1", "Move to Job launched");
    await page.waitForSelector("#aca-bkDetail .bk-dlv li");
    check((await page.$$("#aca-bkDetail .bk-dlv li")).length === 3 && (await page.textContent("#aca-bkDetail .bk-dlv")).includes("overdue"), "deliverables listed with overdue");
    await page.click('#aca-bkDetail input[data-dlv="bd1"]');
    await page.waitForTimeout(150);
    const tick = await lastRpc("booking_deliverable_update");
    check(tick && tick[1].p_id === "bd1" && tick[1].p.status === "done", "ticking marks it delivered");
    const opts = await page.$$eval("#aca-bkDlvPick option", (os) => os.map((o) => o.textContent));
    check(opts.some((o) => o.includes("Thank-you card")) && !opts.some((o) => o.includes("Team composites")), "saved picks leave out ones already on the job");
    await page.fill("#aca-bkDlvNew", "Coach banner 2");
    await page.click('#aca-bkDetail button[data-v="dlvnew"]');
    await page.waitForTimeout(150);
    const add = await lastRpc("booking_deliverables_add");
    check(add && add[1].p_items[0].label === "Coach banner 2" && add[1].p_items[0].save === true, "typed deliverable added and saved for the type");
    await page.waitForSelector('#aca-bkDetail button[data-v="dlvedit"][data-dlv="bd2"]');
    await page.click('#aca-bkDetail button[data-v="dlvedit"][data-dlv="bd2"]');
    await page.selectOption("#aca-bkDeStatus", "skipped");
    await page.click('.og-modal button[data-v="save"]');
    await page.waitForTimeout(150);
    const ed = await lastRpc("booking_deliverable_update");
    check(ed && ed[1].p_id === "bd2" && ed[1].p.status === "skipped" && ed[1].p.label === "Coach banner", "edit dialog saves");
    await page.click('#aca-nav button[data-tab="jobs"]');
    await page.waitForSelector("#aca-bkBody tr.bk-row");

    // Book a job: saved deliverables for the type, "every job" ones pre-ticked, typed ones kept
    await page.click("#aca-bkNew");
    await page.waitForSelector("#aca-bkFDlv");
    check(await page.isChecked('#aca-bkFDlv input[data-fdt="dt3"]') && !(await page.isChecked('#aca-bkFDlv input[data-fdt="dt4"]')), "school: Yearbook files pre-ticked, Thank-you card offered");
    await page.click('#aca-bkTypes input[value="sports_data"]', { force: true });
    check(await page.isChecked('#aca-bkFDlv input[data-fdt="dt1"]') && !(await page.$('#aca-bkFDlv input[data-fdt="dt3"]')), "switching type swaps the picks");
    await page.fill("#aca-bkFDlvNew", "Coach gift");
    await page.click('button[data-v="fdlvadd"]');
    await page.fill("#aca-bkOrgQ", "Brewer");
    await page.waitForSelector("#aca-bkOrgList button[data-org]");
    await page.click("#aca-bkOrgList button[data-org]");
    await page.waitForTimeout(150);
    // Date and time pickers: calendar for the day, typed start, end defaults to start + 2 hours
    await page.click("#aca-bkDays .dp-face");
    for (let i = 0; i < 36 && !(await page.$('.dp-cal [data-d="2026-12-05"]')); i++) await page.click('.dp-cal [data-m="' + (new Date() < new Date(2026, 11, 5) ? 1 : -1) + '"]');
    await page.click('.dp-cal [data-d="2026-12-05"]');
    check(await page.$eval("#aca-bkDays .bk-d-day", (n) => n.value) === "2026-12-05" && /^\s*12\/5\s*$/.test(await page.textContent("#aca-bkDays .dp-face")), "calendar sets the day");
    // A school booking: the access code box gets the suggested registration code (initials + school year)
    await page.click('#aca-bkTypes input[value="school"]', { force: true });
    await page.waitForTimeout(100);
    check((await page.$eval("#aca-bkCode", (n) => n.value)) === "BTBC2627", "a school booking suggests the registration code: " + (await page.$eval("#aca-bkCode", (n) => n.value)));
    await page.click('#aca-bkTypes input[value="sports_data"]', { force: true });
    await page.waitForTimeout(100);
    // Ordering dates work themselves out from the day after picture day (sports: +3 / +14 / +30)
    const od = await page.$eval("#aca-bkOrderBy", (n) => [document.getElementById("aca-bkFreeShip").value, document.getElementById("aca-bkDiscEnds").value, n.value].join(" "));
    check(od === "2026-12-09 2026-12-20 2027-01-05", "sports order dates from the launch: " + od);
    check(await page.$eval("#aca-bkLoc", (n) => n.value) === "Brewer Auditorium, 318 Wilson St, Brewer, ME", "location starts at the partner's address");
    await page.$eval("#aca-bkDiscEnds", (n) => { n.value = "2026-12-22"; n.dispatchEvent(new Event("input", { bubbles: true })); });
    check(/Typed by hand/.test(await page.textContent("#aca-bkDatesNote")), "typing a date stops the automatic dates");
    await page.click('#aca-bkDatesNote [data-dirauto]');
    check(await page.$eval("#aca-bkDiscEnds", (n) => n.value) === "2026-12-20", "Work them out again puts them back");
    await page.waitForFunction(() => /indoors/.test(document.getElementById("aca-bkShootNote").textContent));
    check(true, "the Shooting hint says what Automatic comes to");
    await page.fill("#aca-bkDays .bk-dayrow .dp-time >> nth=0", "930");
    await page.keyboard.press("Enter");
    const tm = await page.$eval("#aca-bkDays .bk-dayrow", (r) => [r.querySelector(".bk-d-start").value, r.querySelector(".bk-d-end").value, r.querySelectorAll(".dp-time")[1].value]);
    check(tm[0] === "09:30" && tm[1] === "11:30" && tm[2] === "11:30 AM", "typed start 930 -> 9:30 AM, end defaults to 11:30 AM: " + tm.join(" / "));
    await page.fill("#aca-bkDays .bk-dayrow .dp-time >> nth=1", "1p");
    await page.keyboard.press("Tab");
    await page.fill("#aca-bkDays .bk-dayrow .dp-time >> nth=0", "10");
    await page.keyboard.press("Enter");
    check(await page.$eval("#aca-bkDays .bk-d-end", (n) => n.value) === "13:30", "moving the start keeps the length");
    await page.click("#aca-bkDays .bk-dayrow .dp-time >> nth=0");
    await page.click('.dp-list button[data-t="10:15"]');
    await page.keyboard.press("Tab");
    check(await page.$eval("#aca-bkDays .bk-d-start", (n) => n.value) === "10:15" && await page.$eval("#aca-bkDays .dp-time", (n) => n.value) === "10:15 AM", "a start picked from the list sticks after leaving the box");
    await page.fill("#aca-bkDays .bk-dayrow .dp-time >> nth=0", "10");
    await page.keyboard.press("Enter");
    await page.click('.bk-form button[data-v="addday"]');
    check(await page.$eval("#aca-bkDays .bk-d-start", (n) => n.value) === "10:00", "adding a day keeps the first day's times");
    await page.click('.bk-form button[data-v="rmday"][data-i="1"]');
    await page.waitForSelector("#aca-bkCrew .bk-crew", { state: "attached" });
    check((await page.$$("#aca-bkCrew .bk-crew")).length === 3, "Who's shooting lists the team");
    await page.click("#aca-bkCrewSum");
    await page.check("#aca-bkCrew .bk-crew >> nth=1");
    check((await page.textContent("#aca-bkCrewSum")) === "Sam H.", "the dropdown shows who's picked");
    await page.waitForSelector("#aca-bkCrew .bk-crewnote", { timeout: 3000 }).catch(() => {});
    check((await page.textContent("#aca-bkCrew")).includes("Posing") && (await page.textContent("#aca-bkCrew")).includes("Busy"), "Who's shooting notes roles and who is busy that day: " + (await page.textContent("#aca-bkCrew")));
    await page.click("#aca-bkLoc");
    check(!(await page.$eval("#aca-bkCrewDd", (n) => n.open)), "the dropdown closes when you click elsewhere");
    await page.fill("#aca-bkLoc", "doughty");
    await page.waitForSelector("#aca-bkLoc-places:not(.hidden) button[data-i]");
    check((await page.$$("#aca-bkLoc-places button[data-i]")).length === 2, "typing a location shows Google Maps suggestions");
    await page.click("#aca-bkLoc-places button[data-i] >> nth=0");
    await page.waitForFunction(() => document.querySelector("#aca-bkLoc").value === "James F. Doughty Middle School, 143 Fifth St, Bangor, ME 04401");
    const calls = await page.evaluate(() => window.__placeCalls);
    check(calls.length === 2 && calls[0].session && calls[0].session === calls[1].session && calls[1].place_id === "ChIJdoughty0000001", "picking one fetches its address in the same session");
    check(await page.$eval("#aca-bkLoc-places", (n) => n.classList.contains("hidden")) && /google\.com\/maps/.test(await page.$eval("#aca-bkLocNote a", (a) => a.href)), "the list closes and a map link shows");
    // ws/director: team times and the order dates
    check(await page.isVisible("#aca-bkTeamTimes") && !!(await page.$("#aca-bkOrderBy")) && !!(await page.$("#aca-bkDiscEnds")), "Book a job has team times, order by and discount ends");
    await page.fill("#aca-bkTeamTimes", "9:00 U10 Blue\n9:15 U10 Red");
    await page.$eval("#aca-bkOrderBy", (n) => { n.value = "2026-12-20"; n.dispatchEvent(new Event("change", { bubbles: true })); });
    check(await page.isChecked("#aca-bkGpAfter") && !(await page.$('#aca-bkGp a[data-gpname]')), "Book a job offers to create the GotPhoto job after booking (no manual link)");
    await page.click('.bk-form button[data-v="save"]');
    await page.waitForFunction(() => window.__rpcCalls.some((c) => c[0] === "booking_create"));
    await page.waitForSelector("#aca-bkDetail .bk-stages");
    check(page.url().endsWith("#jobs/job/bk1/booking"), "after booking, the new job's page opens (Booking tab)");
    await page.waitForSelector("#aca-gpcprice", { timeout: 5000 }).catch(() => {});
    check(!!(await page.$("#aca-gpcprice")), "after booking, the GotPhoto check screen opens");
    await page.click('.og-modal button[data-v="close"]').catch(() => {});
    check((await lastRpc("booking_create"))[1].p.location === "James F. Doughty Middle School, 143 Fifth St, Bangor, ME 04401", "the picked address is saved as the location");
    const dsv = await lastRpc("booking_director_save");
    check(dsv && dsv[1].p_id === "bk1" && dsv[1].p.team_times === "9:00 U10 Blue\n9:15 U10 Red" && dsv[1].p.order_deadline === "2026-12-20" && dsv[1].p.dates_auto === false && dsv[1].p.discount_ends === "2026-12-20", "team times and a typed order date saved with the booking (dates no longer automatic)");
    check(!(await lastRpc("booking_create"))[1].p.team_times, "booking_create gets the same fields as before");
    await page.waitForFunction(() => window.__rpcCalls.some((c) => c[0] === "booking_deliverables_add"), null, { timeout: 3000 }).catch(() => {});
    const bk = await lastRpc("booking_deliverables_add");
    check(bk && bk[1].p_booking === "bk1" && bk[1].p_items.some((x) => x.template_id === "dt1") && bk[1].p_items.some((x) => x.label === "Coach gift" && x.save), "booking adds the picked deliverables");
    const crewSave = await lastRpc("schedule_save");
    check(crewSave && crewSave[1].p.kind === "job" && crewSave[1].p.booking_id === "bk1" && crewSave[1].p.user_id === "u2", "the crew picked when booking goes on the schedule");

    // Stages & deliverables per job type (Settings > Job types)
    await page.evaluate(() => { location.hash = "#system/jobtypes"; });
    await page.waitForSelector('#aca-panel-jobtypes button[data-st="stages"][data-k="school"]');
    await page.click('#aca-panel-jobtypes button[data-st="stages"][data-k="school"]');
    await page.waitForSelector("#aca-bkJtBody [data-st]");
    check((await page.$$("#aca-bkJtBody [data-st]")).length === 6, "job type dialog lists the stages");
    check((await page.textContent("#aca-bkJtBody")).includes("days after the job is launched"), "due days count from launch");
    await page.fill('#aca-bkJtBody [data-st="2"] input[type=text]', "Editing");
    await page.click('#aca-bkJtBody button[data-v="add"][data-l="tp"]');
    await page.fill('#aca-bkJtBody [data-tp="1"] input[type=text]', "Panoramic");
    await page.click('.bk-form button[data-v="save"]');
    await page.waitForTimeout(200);
    const w = await page.evaluate(() => window.__writes.filter((x) => x[0] === "booking_stages" || x[0] === "deliverable_templates"));
    check(w.some((x) => x[0] === "booking_stages" && x[1] === "update" && x[2].label === "Editing") && w.some((x) => x[0] === "deliverable_templates" && x[1] === "insert" && x[2].label === "Panoramic" && x[2].type_key === "school"),
      "job type dialog saves stage names and new deliverables");
    await page.click('.bk-form .bk-factions button[data-v="close"]');


    await page.click('#aca-nav button[data-tab="today"]');
    await page.waitForTimeout(150);
    check((await page.textContent("#aca-todayList")).includes("past its due date"), "Today lists the overdue deliverable");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Bookings: a track-only job");
  {
    const { page, errors } = await open(browser, port, "?tracked=1", "#jobs/bookings/bk1");
    await page.waitForSelector("#aca-bkDetail .bk-stages");
    check(page.url().endsWith("#jobs/job/bk1/booking"), "an old booking link opens the job page's Booking tab");
    const txt = await page.textContent("#aca-bkDetail");
    check(txt.includes("Tracking only") && !txt.includes("Calendar") && !txt.includes("Emails") && !(await page.$('#aca-panel-job [data-j="edit"]')), "Booking tab shows tracking only: no calendar, emails or edit");
    check(!!(await page.$("#aca-bkDetail .bk-dlv")), "deliverables still there");
    await page.click('#aca-bkDetail button[data-v="makereal"]');
    await page.waitForSelector("#aca-bkMrPlan .bk-emails");
    const mr = await page.textContent("#aca-bkMrPlan");
    check(mr.includes("Not needed: already sent from 17hats") && mr.includes("One week before"), "Make it a real booking: shows the dry-run email list");
    check(await page.evaluate(() => { const x = document.querySelector('input[data-sent="1"]'); return x.checked && x.disabled && document.getElementById("aca-bkMrSt").value === "17:00" && document.getElementById("aca-bkMrEv").value === "ev9"
      && document.querySelector('input[data-who="c1"]').checked && document.querySelector('input[data-who="c2"]').disabled; }), "Start here ticked as sent by 17hats, calendar event + time + director filled in");
    await page.click('.og-modal button[data-v="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "booking_make_real" && c[1].p_dry_run === false && c[1].p.google_event_id === "ev9" && c[1].p.contact_ids.join() === "c1")), "Make it a real booking saves with the linked event");
    await page.click('#aca-bkDetail button[data-v="untrack"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "booking_untrack" && c[1].p_id === "bk1")), "Stop tracking");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Bookings view only");
  {
    const { page, errors } = await open(browser, port, "?as=viewer", "#jobs/bookings/bk1");
    await page.waitForSelector("#aca-bkDetail .bk-stages");
    check(await page.$$eval("#aca-bkDetail .bk-stages button", (bs) => bs.every((b) => b.disabled)), "stages read-only");
    check(!(await page.$('#aca-bkDetail button[data-next]')) && !(await page.$("#aca-bkDlvNew")) && !(await page.$('#aca-bkDetail button[data-v="dlvedit"]')), "no move / add / edit controls");
    check(await page.$$eval("#aca-bkDetail input[data-dlv]", (cs) => cs.every((c) => c.disabled)), "deliverable ticks disabled");
    check(!(await page.$('#aca-panel-job [data-j="edit"]')) && !(await page.$('#aca-bkDetail [data-v="sendnow"]')) && !(await page.$('#aca-bkDetail [data-v="cancel"]')), "no Edit booking, Send now or Cancel for view-only");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Inventory (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#ops/inventory");
    check(await page.$eval("#aca-panel-inventory", (n) => n.classList.contains("active")), "#ops/inventory opens Find");
    await page.waitForSelector("#aca-invResults .inv-res");
    check(!(await page.textContent("#aca-invResults")).includes("Checked out to you"), "nothing checked out to the owner");
    // ws/settings B30: before typing, what's out and what's late (late first)
    check((await page.textContent("#aca-invResults .inv-h")).includes("Out now: 2, 1 late") && (await page.textContent("#aca-invResults .inv-res")).includes("Out with Gus Shooter"), "B30: Find shows what's out, late first, until you type");
    await page.fill("#aca-invQ", "canon");
    await page.waitForFunction(() => window.__rpcCalls.some((c) => c[0] === "inventory_search"));
    await page.waitForSelector("#aca-invResults .inv-h >> text=Items");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "inventory_search" && c[1].p_q === "canon")), "typing searches");
    check((await page.textContent("#aca-invResults [data-item=\"ii2\"]")).includes("A-01"), "result shows the bin to look in");
    check((await page.textContent("#aca-invResults [data-item=\"ii2\"]")).includes("Out with Sam Helper"), "result shows who has it");
    await page.click("#aca-invResults [data-item=\"ii1\"]");
    await page.waitForSelector(".modal [data-co]");
    await page.click(".modal [data-co]");
    await page.waitForSelector("#aca-invWho");
    check(await page.$eval("#aca-invWho", (s) => s.value) === "u1", "check out defaults to me");
    await page.selectOption("#aca-invWho", "");
    await page.fill("#aca-invWhoName", "Pat (freelancer)");
    await page.click("#aca-invCoSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "inventory_check_out" && c[1].p_item === "ii1" && c[1].p_holder === null && c[1].p_holder_name === "Pat (freelancer)")), "checks out to a typed name");
    // Bins: list, open, add an item there
    await page.click('#aca-pagetabs button[data-tab="invbins"]');
    await page.waitForSelector("#aca-invBinBody tr[data-bin]");
    check((await page.$$("#aca-invBinBody tr[data-bin]")).length === 2, "bins list shows 2 bins");
    check(await visible(page, "#aca-invBinAdd"), "Add bin shown");
    await page.click('#aca-invBinBody tr[data-bin="ib1"]');
    await page.waitForSelector("#aca-invBinItem");
    await page.click("#aca-invBinItem");
    await page.waitForSelector("#aca-invIName");
    check(await page.$eval("#aca-invIPlace", (s) => s.value) === "b:ib1", "Add item starts in that bin");
    await page.fill("#aca-invIName", "Gaffer tape");
    await page.fill("#aca-invISerial", "");
    await page.click("#aca-invISave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => (window.__writes || []).some((w) => w[0] === "inventory_items" && w[1] === "insert" && w[2].name === "Gaffer tape" && w[2].bin_id === "ib1")), "adds an item to the bin");
    await page.click("#aca-invBinAdd");
    await page.fill("#aca-invBCode", "B-02");
    await page.click("#aca-invBSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => (window.__writes || []).some((w) => w[0] === "inventory_bins" && w[1] === "insert" && w[2].code === "B-02")), "adds a bin");
    // Kits and Checked out
    await page.click('#aca-pagetabs button[data-tab="invkits"]');
    await page.waitForSelector("#aca-invKitBody tr[data-kit]");
    check((await page.textContent("#aca-invKitBody")).includes("Out with Gus Shooter"), "kit shows who has it");
    await page.click('#aca-pagetabs button[data-tab="invout"]');
    await page.waitForSelector("#aca-invOutBody [data-ret]");
    check((await page.$$("#aca-invOutBody [data-ret]")).length === 2, "owner can return everything");
    check((await page.textContent("#aca-invOutCount")).includes("1 late"), "counts late returns");
    check((await page.$$('#aca-invOutBody td:nth-child(2) a[data-item], #aca-invOutBody td:nth-child(2) a[data-kit]')).length === 2, "ws/settings: who has it is a link to the item");
    await page.click('#aca-invOutBody [data-ret="2"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "inventory_return" && c[1].p_checkout === 2)), "Return");
    // Gear: value, service due, insurance export, item care, log a service, edit purchase fields
    await page.click('#aca-pagetabs button[data-tab="invgear"]');
    await page.waitForSelector("#aca-invGearBody tr[data-item]");
    check((await page.textContent("#aca-invGearSum")).includes("$2,100"), "gear: total worth (1,800 + 300): " + (await page.textContent("#aca-invGearSum")));
    check((await page.textContent("#aca-invGearSum")).includes("1 due for service"), "gear: counts service due");
    check((await page.$$("#aca-invGearBody tr[data-item]")).length === 2, "gear: lists items with a value or serial");
    await page.click('#aca-invGearChips [data-f="due"]');
    check((await page.$$("#aca-invGearBody tr[data-item]")).length === 1, "gear: Service due filter");
    check((await page.textContent("#aca-invGearBody")).includes("overdue since"), "B32: a past service date says overdue since");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#aca-invGearExport")]);
    const csv = fs.readFileSync(await dl.path(), "utf8");
    check(dl.suggestedFilename().startsWith("207-photo-gear-insurance-") && csv.includes("Canon R6 body,SN-12345,1,1800,1800.00") && csv.includes("Total,,,,2100.00"), "gear: insurance CSV has items and total");
    await page.click('#aca-invGearBody tr[data-item="ii2"]');
    await page.waitForSelector("#aca-invISvc");
    const care = await page.textContent(".modal .inv-care");
    check(care.includes("$2,499") && care.includes("$1,800") && care.includes("overdue since"), "item shows bought, worth and overdue service: " + care);
    await page.waitForFunction(() => document.querySelector("#aca-invSvc") && document.querySelector("#aca-invSvc").textContent.includes("Sensor clean"));
    check(true, "item shows its service log");
    await page.click("#aca-invISvc");
    await page.waitForSelector("#aca-invSvKind");
    await page.selectOption("#aca-invSvKind", "service");
    await page.fill("#aca-invSvCost", "120");
    await page.click("#aca-invSvSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "inventory_service_log" && c[1].p_item === "ii2" && c[1].p_kind === "service" && c[1].p_cost === 120)), "logs a service");
    await page.waitForSelector("#aca-invIEdit");
    await page.click("#aca-invIEdit");
    await page.waitForSelector("#aca-invIValue");
    check(await page.$eval("#aca-invIValue", (n) => n.value) === "1800", "edit item shows the value");
    await page.fill("#aca-invIValue", "1650");
    await page.fill("#aca-invIEvery", "6");
    await page.click("#aca-invISave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => (window.__writes || []).some((w) => w[0] === "inventory_items" && w[1] === "update" && w[2].value === 1650 && w[2].service_every_months === 6 && w[2].purchase_price === 2499)), "saves value and service interval");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Gear repairs and past due (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#ops/inventory");
    check(!(await page.$('#aca-pagetabs button[data-tab="invjobs"]')) && !(await page.$("#aca-invScan")) && !(await page.$("#aca-invLabels")), "no gear-per-job tab, scan or labels");
    await page.fill("#aca-invQ", "light");
    await page.waitForSelector("#aca-invResults .inv-bad");
    check((await page.textContent("#aca-invResults")).includes("At repair"), "search results show repair");
    await page.click("#aca-invResults .inv-res:has(.inv-bad)");
    await page.waitForSelector(".modal .inv-cond");
    check((await page.textContent(".modal .inv-cond")).includes("At repair") && !!(await page.$('.modal [data-cond="ok"]')), "at repair with Mark fixed");
    await page.click('.modal [data-cond="ok"]');
    await page.waitForSelector("#aca-invCdCost");
    await page.fill("#aca-invCdCost", "45");
    await page.click("#aca-invCdSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "inventory_condition_set" && c[1].p_condition === "ok" && c[1].p_cost === 45)), "marks it fixed with the cost");
    await page.keyboard.press("Escape");
    await page.goto(page.url().replace(/#.*/, "#today"));
    await page.waitForTimeout(600);
    const today = await page.textContent("#aca-panel-today");
    check(!today.includes("missing gear") && today.includes("past due back"), "Today: past due, no missing gear");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Staff records (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#staff/clearances");
    await page.waitForSelector("#aca-srBody [data-u]");
    check(await page.$eval("#aca-panel-clearances", (n) => n.classList.contains("active")), "#staff/clearances opens");
    check(await visible(page, "#aca-srSchoolCard") && (await page.textContent("#aca-srSchool")).includes("Alex Assistant"), "school-job warning names who isn't cleared");
    check((await page.$$("#aca-srBody tr")).length === 3, "clearances grid: one row per person");
    check((await page.textContent("#aca-srHead")).includes("for schools"), "school-required kinds are marked");
    check((await page.textContent('#aca-srBody [data-u="u2"][data-t="background"]')).includes("Runs out soon"), "Sam's check runs out soon");
    check((await page.textContent('#aca-srBody [data-u="u5"][data-t="background"]')).includes("Missing"), "missing school clearance shows");
    await page.click('#aca-srBody [data-u="u5"][data-t="background"]');
    await page.waitForSelector("#aca-srRef");
    await page.evaluate(() => { document.getElementById("aca-srDone").value = "2026-10-01"; });   // date picker face; the value is what counts
    await page.click('.sr-quick [data-y="2"]');
    check(await page.$eval("#aca-srExp", (n) => n.value) === "2028-10-01", "+2 years fills the end date");
    await page.fill("#aca-srRef", "BC-900");
    await page.click("#aca-srCSave");
    await page.waitForTimeout(150);
    const cs = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "staff_clearance_save").pop());
    check(cs && cs[1].p.user_id === "u5" && cs[1].p.type_key === "background" && cs[1].p.expires_on === "2028-10-01" && cs[1].p.reference === "BC-900", "saves a clearance");
    await page.click("#aca-srTypes");
    await page.waitForSelector("#aca-srNewType");
    await page.fill("#aca-srNewType", "Mandated reporter");
    await page.click("#aca-srTSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "staff_clearance_type_save" && c[1].p.label === "Mandated reporter")), "adds a kind of clearance");
    // Onboarding
    await page.click('#aca-pagetabs button[data-tab="onboarding"]');
    await page.waitForSelector("#aca-srOb [data-person]");
    check((await page.$$("#aca-srOb [data-person]")).length === 2, "onboarding shows the two people on it");
    check(await page.$eval('#aca-srOb [data-person="u2"] [data-step="sp2"]', (n) => n.checked && n.disabled), "a clearance step ticks itself");
    await page.click('#aca-srOb [data-person="u2"] [data-step="sp4"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "staff_onboarding_check" && c[1].p_user === "u2" && c[1].p_step === "sp4" && c[1].p_done === true)), "ticks a step");
    await page.click("#aca-srStart");
    await page.waitForSelector("#aca-srWho");
    await page.click("#aca-srWGo");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "staff_onboarding_set" && c[1].p_user === "u1" && c[1].p_on === true)), "starts someone on the checklist");
    await page.click("#aca-srSteps");
    await page.waitForSelector("#aca-srStepList [data-id]");
    await page.click('#aca-srStepList [data-id="sp3"] [data-up]');
    await page.waitForTimeout(250);
    const moved = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "staff_onboarding_step_save").map((c) => [c[1].p.id, c[1].p.sort]));
    check(JSON.stringify(moved) === JSON.stringify([["sp3", 20], ["sp2", 30]]), "moves a step up: " + JSON.stringify(moved));
    await page.waitForSelector("#aca-srStepAdd");
    await page.click("#aca-srStepAdd");
    await page.waitForSelector("#aca-srSTitle");
    await page.fill("#aca-srSTitle", "Sign the photo release");
    await page.check("#aca-srSSelf");
    await page.click("#aca-srSSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "staff_onboarding_step_save" && c[1].p.title === "Sign the photo release" && c[1].p.self_check === true && c[1].p.id === null)), "adds a step");
    await page.waitForSelector("#aca-srStepDone");
    await page.click("#aca-srStepDone");   // back on the step list after adding
    // Today
    await page.click('#aca-nav button[data-tab="today"]');
    await page.waitForTimeout(300);
    const today = await page.textContent("#aca-panel-today");
    check(today.includes("isn't cleared") && today.includes("gear is due for service"), "Today: school clearance and gear service lines");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Staff records (staff, view = own)");
  {
    const { page, errors } = await open(browser, port, "?as=staff", "#staff/clearances");
    await page.waitForSelector("#aca-srBody [data-u]");
    check((await page.$$("#aca-srBody tr")).length === 1, "sees only their own row");
    check(!(await visible(page, "#aca-srTypes")) && !(await visible(page, "#aca-viewOnly")), "no Kinds button and no view-only notice");
    check(await page.$eval('#aca-srBody [data-u="u2"][data-t="background"]', (n) => n.disabled), "cannot edit their clearance");
    await page.click('#aca-pagetabs button[data-tab="onboarding"]');
    await page.waitForSelector('#aca-srOb [data-person="u2"]');
    check((await page.textContent("#aca-srOb h3")).includes("Your checklist"), "shows their checklist");
    check(await page.$eval('#aca-srOb [data-step="sp4"]', (n) => n.disabled) && !(await page.$eval('#aca-srOb [data-step="sp3"]', (n) => n.disabled)), "can tick only their own steps");
    check(!(await visible(page, "#aca-srStart")), "no Start someone");
    await page.click('#aca-srOb [data-step="sp3"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "staff_onboarding_check" && c[1].p_step === "sp3")), "ticks the training videos");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Inventory view only");
  {
    const { page, errors } = await open(browser, port, "?as=gear");
    const items = await rail(page);
    check(JSON.stringify(items) === JSON.stringify(["today", "myday", "inventory"]), "menu: Today, My day and Inventory: " + items.join(","));
    await page.click('#aca-nav button[data-tab="inventory"]');
    await page.waitForSelector("#aca-invResults .inv-h");
    check((await page.textContent("#aca-invResults")).includes("Checked out to you"), "Find starts with what they have");
    await page.click('#aca-pagetabs button[data-tab="invbins"]');
    await page.waitForSelector("#aca-invBinBody tr[data-bin]");
    check(!(await visible(page, "#aca-invBinAdd")), "no Add bin");
    await page.click('#aca-invBinBody tr[data-bin="ib1"]');
    await page.waitForSelector("#aca-invBinClose");
    check(!(await page.$("#aca-invBinEdit")) && !(await page.$("#aca-invBinItem")), "bin is read-only");
    await page.click("#aca-invBinClose");
    await page.click('#aca-pagetabs button[data-tab="invout"]');
    await page.waitForSelector("#aca-invOutBody tr");
    await page.waitForTimeout(150);
    check((await page.$$("#aca-invOutBody [data-ret]")).length === 1, "can return only their own");
    await page.click('#aca-pagetabs button[data-tab="inventory"]');
    await page.fill("#aca-invQ", "batteries");
    await page.waitForSelector("#aca-invResults [data-item=\"ii1\"]");
    await page.click("#aca-invResults [data-item=\"ii1\"]");
    await page.waitForSelector(".modal [data-co]");
    check((await page.textContent(".modal [data-co]")).includes("to me"), "Check out to me");
    check(!(await page.$("#aca-invIEdit")), "no Edit item");
    await page.click(".modal [data-co]");
    await page.waitForSelector("#aca-invCoSave");
    check(!(await page.$("#aca-invWho")), "no choosing who");
    await page.click("#aca-invCoSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "inventory_check_out" && c[1].p_holder === "u5")), "checks out to themselves");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Sales (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#jobs/seasons");
    await page.waitForSelector("#aca-panel-resjobs .tiles");
    check(await page.$eval("#aca-panel-resjobs", (n) => n.classList.contains("active")), "#jobs/seasons opens Sales, by season");
    check(await page.$eval('#aca-rsViews [data-view="season"]', (b) => b.getAttribute("aria-pressed") === "true"), "By season is picked");
    check((await page.textContent("#aca-rsViews")).includes("Owed to partners"), "Owed to partners shows while something is owed");
    check(await page.$eval("#aca-rsSeason", (s) => s.value) === "fall:2026", "starts on the latest season");
    const tiles = await page.textContent("#aca-panel-resjobs .tiles");
    check(tiles.includes("$11,000") && tiles.includes("vs $9,500"), "sales against the same season last year: " + tiles.replace(/\s+/g, " ").slice(0, 120));
    check(tiles.includes("+16%"), "change shown");
    const orgs = await page.textContent("#aca-rsView table");
    check(orgs.includes("Old Town Soccer") === false && orgs.includes("No partner"), "jobs without a partner are grouped");
    check(orgs.includes("Island Cheer") && orgs.includes("new"), "a new partner says new");
    check(!!(await page.$('#aca-rsView a[href^="#partners/org/11111111-1111-1111-1111-111111111111"]')), "partner names link to the partner page");
    await page.selectOption("#aca-rsSeason", "year:2026");
    await page.waitForTimeout(100);
    check((await page.textContent("#aca-panel-resjobs .tiles")).includes("$16,400"), "whole year adds every season");

    await page.goto(`http://127.0.0.1:${port}/test/harness.html#jobs/payouts`);
    await page.waitForSelector("#aca-panel-resjobs .rs-org");
    check(await page.$eval('#aca-rsViews [data-view="owed"]', (b) => b.getAttribute("aria-pressed") === "true"), "#jobs/payouts opens Owed to partners");
    const pay = await page.textContent("#aca-rsView");
    check(pay.includes("$760.00 owed on 4 jobs"), "owed total: " + pay.replace(/\s+/g, " ").slice(0, 140));
    check((await page.$$("#aca-rsView .rs-org")).length === 2, "one block per partner owed");
    await page.click('#aca-rsView .rs-org >> nth=0 >> [data-emailst]');
    await page.waitForTimeout(200);
    const est = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "partner_statement_queue").pop());
    check(est && /picture day statement/.test(est[1].p_subject) && est[1].p_body.includes("{{paid_line}}") && est[1].p_body.includes("your share"), "Email statement drops the statement in the outbox, held");
    check((await page.textContent("#aca-toast")).includes("held for you"), "says it is held for review");
    await page.click('#aca-rsView [data-payall="r1,r8"]');
    await page.waitForSelector("#aca-rsPayRef");
    await page.fill("#aca-rsPayRef", "1101");
    await page.click(".modal [data-go]");
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "results_pay" && c[1].p_jobs.join() === "r1,r8" && c[1].p_method === "Check" && c[1].p_ref === "1101" && c[1].p_amount === undefined)), "records a payment for what is owed");
    await page.click('#aca-rsView [data-f="paid"]');
    await page.waitForTimeout(100);
    check((await page.textContent("#aca-rsView")).includes("Brewer Travel | Fall 2025"), "Paid filter lists paid jobs");
    await page.click("#aca-rsAddTerms");
    await page.waitForSelector("#aca-rsTOrg");
    check(await page.$eval("#aca-rsTOrg", (s) => [...s.options].map((o) => o.textContent).join()) === "Island Cheer & Tumbling", "add terms offers partners without terms");
    check(await page.$eval("#aca-rsTKind", (s) => [...s.options].map((o) => o.value).join()) === "percent,deliverables,none", "terms: a percent, deliverables or nothing");
    await page.selectOption("#aca-rsTKind", "deliverables");
    check(await page.isVisible("#aca-rsTGets") && !(await page.isVisible("#aca-rsTPct")), "deliverables ask what they get");
    await page.selectOption("#aca-rsTKind", "percent");
    await page.fill("#aca-rsTPct", "7.5");
    await page.click(".modal [data-go]");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "results_set_terms" && c[1].p_pct === 7.5 && c[1].p_kind === "percent" && c[1].p_org === "44444444-4444-4444-4444-444444444444")), "saves a partner's share");

    await page.click('#aca-rsViews [data-view="job"]');
    await page.waitForSelector('#aca-rsView tr[data-job="r9"]');
    check(page.url().includes("#jobs/resjobs/job"), "By job has its own address");
    check((await page.textContent('#aca-rsView tr[data-job="r9"]')).includes("typed in"), "typed-in sales are marked");
    await page.fill("#aca-rsQ", "hancock");
    await page.waitForTimeout(100);
    check((await page.$$("#aca-rsView tbody tr[data-job]")).length === 3, "search narrows the list");
    await page.click('#aca-rsView tr[data-job="r2"] td.name');
    await page.waitForSelector("#aca-rsJSales");
    await page.fill("#aca-rsJSales", "3300");
    await page.selectOption("#aca-rsJOrg", "11111111-1111-1111-1111-111111111111");
    await page.click(".modal [data-go]");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "results_save" && c[1].p_job === "r2" && c[1].p.manual_sales === "3300" && c[1].p.org_id === "11111111-1111-1111-1111-111111111111")), "saves typed sales and a partner");
    await page.click("#aca-rsRefresh");
    await page.waitForTimeout(250);
    check(await page.evaluate(() => window.__salesCalls === 1), "Refresh sales calls the admin function");

    // one partner's owed jobs, with a trail back to the partner
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#jobs/resjobs/owed/11111111-1111-1111-1111-111111111111`);
    await page.waitForSelector("#aca-panel-resjobs .rs-trail");
    check((await page.textContent("#aca-panel-resjobs .rs-trail")).includes("Brewer Travel Basketball Club") && (await page.$$("#aca-rsView .rs-org")).length === 1, "a partner's owed jobs, with a trail back to the partner");

    await page.click('#aca-nav button[data-tab="today"]');
    await page.waitForTimeout(250);
    check((await page.textContent("#aca-panel-today")).includes("partner payouts are owed"), "Today says payouts are owed");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Sales view only");
  {
    const { page, errors } = await open(browser, port, "?as=money");
    const r = await rail(page);
    check(r.includes("jobs") && !r.includes("parents"), "menu: Sales under Jobs: " + r.join(","));
    check((await page.textContent('#aca-nav button[data-tab="jobs"]')).startsWith("Sales"), "an entry is named after the only tab they have");
    await page.click('#aca-nav button[data-tab="jobs"]');
    await page.waitForSelector("#aca-panel-resjobs .tiles");
    await page.click('#aca-rsViews [data-view="owed"]');
    await page.waitForSelector("#aca-rsView .rs-org");
    check(!(await page.$("#aca-rsView [data-payall]")) && !(await page.$("#aca-rsAddTerms")), "no Record payment, no terms editing");
    check(!!(await page.$("#aca-rsView [data-copy]")), "can still copy a statement");
    await page.click('#aca-rsViews [data-view="job"]');
    await page.waitForSelector('#aca-rsView tr[data-job="r1"]');
    check(!(await page.$("#aca-rsRefresh")), "no Refresh sales");
    await page.click('#aca-rsView tr[data-job="r1"] td.name');
    await page.waitForSelector("#aca-rsJSales");
    check(await page.$eval("#aca-rsJSales", (i) => i.disabled) && !(await page.$(".modal [data-go]")), "job is read-only");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Schedule + Assignments (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#staff/schedule");
    // Schedule views (2026-10-24): week cards, Google Calendar tick, Problems, 2 weeks, month, Send changes, phone calendar, map
    await page.waitForSelector("#aca-scGrid .scc-card");
    check(await page.$eval("#aca-panel-schedule", (n) => n.classList.contains("active")), "schedule opens from its link");
    check((await page.$$("#aca-scGrid .scc-head")).length === 7 && (await page.$$("#aca-scGrid .scc-card.scc-job")).length === 4 && !(await page.$("#aca-scGrid .sc-b")), "week: a card per bar, not bars to scale");
    check((await page.textContent("#aca-scGrid .scc-card.scc-job")).includes("9am") && (await page.textContent("#aca-scGrid")).includes("Rain 70%"), "cards have the time; an outdoor job shows its weather");
    check((await page.$$("#aca-scGrid .scc-head .sc-pill.bad")).length >= 1, "day headers say how many people are still needed");
    check((await page.$$("#aca-scGrid .sc-chip.gcal")).length === 1 && (await page.textContent("#aca-scGcalAge")).includes("12 min ago"), "Google Calendar events on, with when it last synced");
    await page.uncheck("#aca-scGcal");
    check((await page.$$("#aca-scGrid .sc-chip.gcal")).length === 0 && (await page.$$("#aca-scGrid .scc-card.scc-off")).length >= 2, "untick Google Calendar: the events hide (\"Alex Off\" stays time off)");
    check(await page.evaluate(() => localStorage.getItem("aca-sc-gcal") === "0"), "the tick is remembered");
    await page.check("#aca-scGcal");
    check((await page.textContent("#aca-scProbBtn")).includes("problem"), "Problems button counts: " + (await page.textContent("#aca-scProbBtn")));
    await page.click("#aca-scProbBtn");
    const probs = await page.textContent("#aca-scProblems");
    check(probs.includes("Island Cheer & Tumbling has nobody on it yet") && probs.includes("no start time"), "Problems lists jobs with nobody and no start time: " + probs.slice(0, 200));
    await page.click("#aca-scProbBtn");
    check(!(await visible(page, "#aca-scProblems")), "Problems folds away");
    await page.selectOption("#aca-scColor", "person");
    check(await page.$eval("#aca-scGrid .scc-card.scc-job", (n) => n.style.getPropertyValue("--cc") !== "") && await visible(page, "#aca-scColKey") && (await page.textContent("#aca-scColKey")).includes("Sam H."), "Color by person, with a key");
    await page.selectOption("#aca-scColor", "kind");
    // map beside the week
    await page.check("#aca-scMapOn");
    await page.waitForSelector("#aca-scMap .sc-mapsvg");
    const mc = await page.evaluate(() => window.__mapCalls && window.__mapCalls[0]);
    check(mc && mc.days === 7 && mc.image === true && mc.markers.length >= 4, "map asks for the week's jobs: " + JSON.stringify(mc && { days: mc.days, n: mc.markers.length }));
    check((await page.textContent("#aca-scMap")).includes("Maps Static API") && (await page.textContent("#aca-scMap .sc-maplist")).includes("Hampden Academy"), "no Google picture yet: pins drawn here, says what to turn on, lists the jobs");
    const gb = await page.$eval("#aca-panel-schedule .sc-scroll", (n) => n.getBoundingClientRect()), mb = await page.$eval("#aca-scMap", (n) => n.getBoundingClientRect());
    check(mb.top >= gb.bottom && Math.abs(mb.width - gb.width) < 2 && await page.$eval("#aca-scMap .sc-mapsvg", (n) => n.getBoundingClientRect().width > 600), "the map is under the schedule, as wide as it");
    await page.uncheck("#aca-scMapOn");
    check(!(await visible(page, "#aca-scMap")), "map off");
    // Ctrl-click works on job cards (jobs that already have people) and month chips, not just Jobs not assigned
    await page.click("#aca-scGrid .scc-card[data-bk] >> nth=0", { modifiers: ["Control"] });
    await page.click('#aca-scGrid .sc-jobs [data-booking="bk3"]', { modifiers: ["Control"] });
    check(!(await page.$(".modal")) && (await page.$$("#aca-scGrid .sel")).length >= 2 && (await page.textContent("#aca-scBulk")).includes("2 jobs picked"), "Ctrl-click a job card and an open job: both picked");
    await page.click("[data-bulkclear]");
    // View schedule: pick a person, see their next two weeks as they'd get it, send it
    await page.waitForSelector("#aca-scChg:not(.hidden)");
    check((await page.textContent("#aca-scChg")).includes("View schedule (2 changed)"), "View schedule says how many people have changes");
    await page.click("#aca-scChg");
    await page.waitForSelector("#aca-scVwWho");
    const vwOpts = await page.$$eval("#aca-scVwWho option", (os) => os.map((o) => o.textContent));
    check(vwOpts.length === 3 && vwOpts[0].includes("changed") && vwOpts[1].includes("changed") && !vwOpts[2].includes("changed"), "everyone on the team is in the list, people with changes first: " + vwOpts.join(" | "));
    await page.waitForSelector(".sc-vwday");
    const vwDays = await page.$$eval(".sc-vwday", (ds) => ds.map((d) => d.textContent));
    check(vwDays.length === 3 && vwDays[0].startsWith("Tue10/27Changed") && vwDays[0].includes("Taken off: Brewer Youth Soccer") && !vwDays.join().includes("onfirm") && !(await page.textContent("#aca-scVwInfo")).includes("to confirm") && vwDays[1].includes("Leave Studio 1:50pm") && !!(await page.$(".sc-vwday.chg .sc-vwitem.k-job")) && !!(await page.$(".sc-vwitem.k-off")), "shows their two weeks day by day, with changed days and what was taken off, and no confirm marks while confirmations are off: " + vwDays[0]);
    check((await page.textContent("#aca-scVwInfo")).includes("To: sam@example.com") && (await page.textContent("#aca-scVwInfo")).includes("17.5 hours") && await page.$eval(".sc-vwframe", (f) => f.getAttribute("sandbox") === "" && f.srcdoc.includes("next two weeks")), "says who it goes to, and the email itself is there in a sandboxed frame");
    await page.selectOption("#aca-scVwWho", "u1");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_view_preview").map((c) => c[1].p_user).join() === "u2,u1"), "picking another person shows theirs");
    await page.click('.sc-modal [data-m="send"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "schedule_view_send" && c[1].p_user === "u1")) && !!(await page.$(".sc-viewmodal")), "sends it to that person and stays open for the next one");
    await page.click('.sc-modal [data-m="cancel"]');
    // phone calendar
    await page.click('#aca-panel-schedule [data-v="cal"]');
    await page.waitForSelector("#aca-scCalUrl");
    check((await page.$eval("#aca-scCalUrl", (n) => n.value)).endsWith("/functions/v1/staff-ics?t=" + "a".repeat(40)) && (await page.getAttribute('.sc-modal a.primary', "href")).startsWith("webcal://"), "phone calendar: a webcal link and a link to copy");
    await page.click('.sc-modal [data-m="cancel"]');
    // 2 weeks and month
    await page.click('input[name="aca-scView"][value="weeks2"] + span');
    await page.waitForSelector("#aca-scGrid.scc-grid.two");
    check((await page.$$("#aca-scGrid .scc-head")).length === 14 && await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "schedule_week" && c[1].p_days === 14)), "2 weeks: 14 days loaded and shown");
    await page.click('input[name="aca-scView"][value="month"] + span');
    await page.waitForSelector("#aca-scGrid .scm-day");
    const md = (await page.$$("#aca-scGrid .scm-day")).length;
    check(md % 7 === 0 && md >= 28 && (await page.$$("#aca-scGrid .scm-chip.need")).length >= 1 && (await page.$$("#aca-scGrid .scm-chip.ok")).length >= 1, "month: whole weeks, jobs that need people in red, covered ones: " + md);
    check(!(await visible(page, "#aca-scJump")) && await visible(page, "#aca-scNeedOnly"), "month: no week jump, a Needs people tick");
    await page.click("#aca-scGrid .scm-chip.ok[data-booking] >> nth=0", { modifiers: ["Meta"] });
    check(!(await page.$(".modal")) && (await page.$$("#aca-scGrid .scm-chip.sel")).length === 1 && (await page.textContent("#aca-scBulk")).includes("1 job picked"), "month: Cmd-click picks a job");
    await page.click("[data-bulkclear]");
    await page.check("#aca-scNeedOnly");
    check((await page.$$("#aca-scGrid .scm-chip.ok")).length === 0 && (await page.$$("#aca-scGrid .scm-chip.gcal")).length === 0, "Needs people shows only jobs that still need people");
    await page.uncheck("#aca-scNeedOnly");
    await page.click("#aca-scGrid .scm-wt[data-mweek] >> nth=0");
    await page.waitForTimeout(150);
    check(await page.isChecked('input[name="aca-scView"][value="week"]'), "a month's week total opens that week");
    // the rest of these checks use the bars drawn to scale
    await page.click('#aca-panel-schedule [data-v="today"]'); await page.waitForTimeout(150);
    await page.check("#aca-scScale");
    await page.waitForSelector("#aca-scGrid .sc-b");
    await page.evaluate(() => { window.__rpcCalls.length = 0; });
    await page.click('[data-v="studio"]');
    await page.fill("#aca-scAddr", "60 main");
    await page.waitForSelector("#aca-scAddr-places:not(.hidden) button[data-i]");
    await page.click("#aca-scAddr-places button[data-i]");
    await page.waitForFunction(() => document.querySelector("#aca-scAddr").value === "60 Main Rd N, Hampden, ME 04444");
    check(true, "the studio address searches Google Maps and fills the full address");
    await page.click('.sc-modal [data-m="cancel"]');
    check((await page.$$("#aca-scGrid .sc-head")).length === 8, "week view: 7 days Sunday to Saturday");
    check((await page.textContent("#aca-scGrid .sc-head:nth-child(2)")).startsWith("Sun"), "the week starts on Sunday");
    check((await page.$$("#aca-scGrid .sc-b.sc-k-drive")).length === 7 && (await page.$$("#aca-scGrid .sc-b.sc-k-job")).length >= 2, "job bars with drive time on both sides (a batched first stop has none back)");
    check((await page.$$("#aca-scGrid .sc-b.sc-k-setup")).length === 8, "every job bar has setup before and teardown after");
    check((await page.$$("#aca-scGrid .sc-b.trip")).length === 1 && (await page.$$("#aca-scGrid .sc-b.batched.sc-k-job")).length === 2, "a batched trip: both jobs marked, a dashed line between them");
    check((await page.$$("#aca-scGrid .sc-b.sc-k-off")).length === 3, "time off spans two days, plus \"Alex Off\" from Google Calendar");
    // ws/settings B3: reloading the week does not add the calendar's "Alex Off" bar again
    await page.click('#aca-panel-schedule [data-v="next"]'); await page.waitForTimeout(100);
    await page.click('#aca-panel-schedule [data-v="prev"]'); await page.waitForTimeout(150);
    check((await page.$$("#aca-scGrid .sc-b.sc-k-off")).length === 3 && await page.evaluate(() => !window.__RPC.schedule_week.entries.some((e) => String(e.id).startsWith("gcal:"))), "B3: the RPC result is not changed");
    check((await page.$$("#aca-scGrid .sc-chip.gcal")).length === 1 && (await page.textContent("#aca-scGrid")).includes("From Google Calendar"), "calendar events that aren't bookings get their own lane");
    await page.click("#aca-scGrid .sc-chip.gcal");
    await page.waitForSelector("#aca-scT");
    check(await page.$eval("#aca-scT", (n) => n.value) === "Studio makeup session" && await page.$eval("#aca-scS", (n) => n.value) === "10:00" && await page.$eval("#aca-scE", (n) => n.value) === "12:00", "a calendar event opens Add time with its title and times");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    const g = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").pop()[1].p);
    check(g.gcal_event_id === "ev1@google.com" && g.kind === "studio", "the bar is tied to the calendar event: " + JSON.stringify(g));
    await page.evaluate(() => { window.__rpcCalls.length = 0; });
    check((await page.$$("#aca-scGrid .sc-b.clash")).length > 0, "overlapping bars are flagged");
    check((await page.textContent("#aca-scGrid")).includes("40 h") && (await page.textContent("#aca-scGrid")).includes("under"), "hours against the weekly target");
    check(await visible(page, "#aca-scWarn"), "asks for the studio address");
    check((await page.$$("#aca-scGrid .sc-chip.none")).length === 3, "jobs with nobody on them stand out");
    check((await page.textContent("#aca-scGrid")).includes("Jobs not assigned") && (await page.$$("#aca-scGrid .sc-chip[data-booking]")).length === (await page.$$("#aca-scGrid .sc-chip.none")).length + (await page.$$("#aca-scGrid .sc-chip.tracked")).length + (await page.$$("#aca-scGrid .sc-chip.part")).length, "only jobs that still need people sit in Jobs not assigned");
    await page.click("#aca-scGrid .sc-b.sc-k-job:not(.drive)");
    await page.waitForSelector('.sc-modal [data-m="more"]');
    await page.click('.sc-modal [data-m="more"]');
    check(await page.isVisible(".sc-modal .sc-pick"), "a job bar's More people opens the people picker");
    await page.click('.sc-modal [data-m="cancel"]');
    // put someone on a job
    await page.click("#aca-scGrid .sc-chip.none");
    await page.waitForSelector(".sc-modal .sc-pick input[type=checkbox]");
    // ws/settings: B8 times and drive folded; Offer to part-timers
    check(!(await page.$eval("#aca-scTimes", (d) => d.open)) && (await page.textContent("#aca-scTimesTxt")).includes("drive"), "B8: Times and drive folded, with a one-line summary");
    check((await page.getAttribute('.sc-modal [data-m="offer"]', "href")).startsWith("#staff/openjobs/bk"), "assign dialog: Ask who's available");
    await page.click("#aca-scTimes > summary");
    await page.click('.sc-modal [data-m="drive"]');
    await page.waitForTimeout(150);
    check(await page.$eval(".sc-modal .sc-db", (n) => n.value) === "25", "drive time looked up and rounded up to 25");
    await page.check(".sc-modal .sc-pick input[type=checkbox] >> nth=0");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    const saved = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").map((c) => c[1].p));
    check(saved.length === 1 && saved[0].kind === "job" && saved[0].drive_before_min === 25 && /T\d\d:00:00.000Z$/.test(saved[0].starts_at), "saves a job bar with drive time");
    // ws/settings B9: the bar dialog has the batch button
    await page.click("#aca-scGrid .sc-b.sc-k-job:not(.drive):not(.batched)");
    await page.waitForSelector('.sc-modal [data-m="batch"]');
    check((await page.textContent('.sc-modal [data-m="batch"]')).includes("Batch with another job"), "B9: Batch with another job in the bar's dialog");
    await page.click('.sc-modal [data-m="cancel"]');
    // ws/settings B1: 8 weeks view; a job jumps to its week and opens the assign dialog
    await page.click('input[name="aca-scView"][value="weeks8"] + span');
    await page.waitForSelector("#aca-scWeeks .sc-w8row");
    check((await page.$$("#aca-scWeeks .sc-w8row")).length === 8 && !(await page.isVisible("#aca-scGrid")) && (await page.textContent("#aca-scTitle")) === "Next 8 weeks", "B1: 8 weeks view, one row a week");
    check((await page.textContent("#aca-scWeeks")).includes("not assigned") && await page.isVisible("#aca-scPeak"), "8 weeks: jobs not assigned and busiest days");
    await page.click("#aca-scWeeks [data-w8b] >> nth=0");
    await page.waitForSelector(".sc-modal .sc-pick");
    check(await page.isChecked('input[name="aca-scView"][value="week"]') && (await page.$$("#aca-scGrid .sc-head.hl")).length === 1, "a job in the 8 weeks view opens its week, day outlined, and its assign dialog");
    await page.click('.sc-modal [data-m="cancel"]');
    check(!(await page.$eval("#aca-scMore", (n) => n.open)) && !(await page.isVisible("#aca-scPeak")), "back on the week, hours and busiest days are folded away");
    await page.click("#aca-scMore > summary");
    await page.click("#aca-scPeak [data-peak] >> nth=0");
    await page.waitForTimeout(150);
    check(await page.isChecked('input[name="aca-scView"][value="week"]') && (await page.$$("#aca-scGrid .sc-head.hl")).length === 1, "a Busiest day jumps to its week");
    await page.click('#aca-panel-schedule [data-v="today"]');
    await page.waitForTimeout(150);
    // Crew (2026-10-23): answers on the bars, people needed, capacity, the crew picker, settings, the weekly email
    await page.evaluate(() => { window.__rpcCalls.length = 0; });
    check((await page.$$("#aca-scGrid .sc-b .sc-cf.ok")).length === 1 && (await page.$$("#aca-scGrid .sc-b .sc-cf.wait")).length === 1, "job bars show confirmed and still waiting");
    check((await page.$$("#aca-scGrid .sc-b.sc-k-asked")).length === 1, "a time off request nobody answered shows on their row");
    check((await page.$$("#aca-scGrid .sc-cap:not(.sc-name)")).length === 7 && (await page.textContent("#aca-scGrid")).includes("free"), "capacity strip under the days");
    await page.waitForSelector("#aca-scPeak tr button[data-peak]");
    check((await page.$$("#aca-scPeak tbody tr")).length === 3 && (await page.textContent("#aca-scPeak")).includes("short"), "busiest days ahead, short ones flagged");
    const part = await page.textContent("#aca-scGrid .sc-chip.part");
    check(part.includes("2 of 3") && part.includes("Alex A. can't make it"), "a job short of people stays in Jobs not assigned with who said no: " + part);
    await page.check("#aca-scWait");
    check((await page.$$("#aca-scGrid .sc-name b")).filter(Boolean).length >= 1 && !(await page.textContent("#aca-scGrid")).includes("Jeremiah") && (await page.textContent("#aca-scGrid")).includes("Sam"), "Still waiting shows only people who haven't answered");
    await page.uncheck("#aca-scWait");
    await page.click("#aca-scGrid .sc-chip.part");
    await page.waitForSelector(".sc-modal .sc-pick .s");
    const pick = await page.textContent(".sc-modal .sc-pick");
    check(pick.includes("Alex") && pick.includes("Said they can't make it") && pick.includes("Busy") && pick.includes("Posing") && !pick.includes("Sam"), "crew picker: roles, busy, said no; people on it are listed above: " + pick);
    check(await page.$eval(".sc-modal .sc-pick .sc-role", (n) => n.value) === "r3", "their first role is picked");
    check((await page.textContent(".sc-modal .sc-onit")).includes("Confirmed") && (await page.textContent(".sc-modal .sc-onit")).includes("Waiting"), "who is on it, with their answers");
    check(!(await page.$('.sc-modal [data-m="ask"]')), "confirming is off: no Ask to confirm, assigning just assigns");
    await page.click('.sc-modal [data-m="cancel"]');
    await page.click("#aca-scGrid .sc-chip.part");
    await page.waitForSelector(".sc-modal .sc-pick .s");
    await page.fill("#aca-scNeed", "4");
    await page.check(".sc-modal .sc-pick input[type=checkbox] >> nth=0");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    const cs = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").map((c) => c[1].p));
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "crew_needed_set" && c[1].p_booking === "bk1" && c[1].p_needed === 4)), "people needed saves");
    check(cs.length === 1 && cs[0].user_id === "u5" && cs[0].role_id === "r3", "puts them on with their role: " + JSON.stringify(cs));
    // The drive boxes follow who is ticked: one person from home shows their own minutes
    await page.waitForSelector(".modal-wrap", { state: "detached" }).catch(() => {});
    await page.click('.sc-jobs [data-booking="bk4"]');
    await page.waitForSelector('.sc-modal .sc-pick input[value="u2"]');
    await page.waitForTimeout(100);
    await page.check('.sc-modal .sc-pick input[value="u2"]');
    check((await page.inputValue(".sc-modal .sc-db")) === "45" && (await page.textContent(".sc-modal .sc-drivemsg")).includes("41 min from home"), "ticking someone who drives from home shows their drive: " + (await page.inputValue(".sc-modal .sc-db")));
    await page.check('.sc-modal .sc-pick input[value="u1"]');
    check((await page.textContent(".sc-modal .sc-drivemsg")).includes("Each person gets their own drive"), "several ticked: each gets their own");
    await page.click('.sc-modal [data-m="cancel"]');
    // Bulk assign: Ctrl-click several jobs, then put the same person on all of them
    const openIds = await page.$$eval(".sc-jobs .sc-chip[data-booking]", (xs) => [...new Set(xs.map((x) => x.dataset.booking))].filter((x) => x !== "bk3").slice(0, 2));
    for (const id of openIds) await page.click('.sc-jobs [data-booking="' + id + '"]', { modifiers: ["Control"] });
    check(!(await page.$(".modal")) && (await page.$$(".sc-jobs .sc-chip.sel")).length === 2 && (await page.textContent("#aca-scBulk")).includes("2 jobs picked"), "Ctrl-click picks several jobs");
    await page.click("[data-bulkgo]");
    await page.waitForSelector("#aca-scBulkPick input");
    check((await page.$$(".sc-bulkjobs li")).length === 2, "bulk dialog lists the picked jobs");
    const firstUid = await page.$eval("#aca-scBulkPick input", (x) => x.value);
    await page.check("#aca-scBulkPick input >> nth=0");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(400);
    const bs = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").map((c) => c[1].p)).then((x) => x.slice(1));
    check(bs.every((p) => p.user_id === firstUid && p.kind === "job") && bs.map((p) => p.booking_id).sort().join() === openIds.filter((x) => x !== "bk1").sort().join(), "bulk assign puts them on every picked job they aren't already on (u1 is on bk1): " + openIds.join() + " -> " + JSON.stringify(bs.map((p) => p.booking_id)));
    check(!(await page.$(".modal")) && (await page.$eval("#aca-scBulk", (n) => n.classList.contains("hidden"))), "picks clear after assigning");
    await page.click('[data-v="crewset"]');
    await page.waitForSelector("#aca-scRoles li[data-id]");
    check((await page.$$("#aca-scRoles li[data-id]")).length === 4 && !(await page.isChecked("#aca-scCfOn")) && !(await page.isChecked("#aca-scWkOn")), "crew settings: roles, asking off to start, weekly email off");
    await page.fill("#aca-scRoleNew", "Lighting");
    await page.click('.sc-modal [data-m="addrole"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "crew_role_save" && c[1].p.label === "Lighting")), "adds a role");
    await page.check("#aca-scWkOn");
    await page.selectOption("#aca-scWkD", "4");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "crew_settings_save" && c[1].p.week_email_auto === true && c[1].p.week_email_dow === 4 && c[1].p.week_email_hour === 15)), "turns on the weekly email for Thursdays");
    await page.click('[data-v="weekmail"]');
    await page.waitForSelector("#aca-scWkList .sc-pick li");
    check((await page.textContent("#aca-scWkList")).includes("1 to confirm") && (await page.textContent("#aca-scWkList")).includes("sent"), "Email the week previews who gets what");
    await page.uncheck("#aca-scWkList input >> nth=0");
    await page.click('.sc-modal [data-m="send"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "week_email_send" && c[1].p_users.join() === "u2" && /^\d{4}-\d\d-\d\d$/.test(c[1].p_start))), "sends the week to the people picked");
    await page.click("#aca-scGrid .sc-b.sc-k-job:not(.drive)");
    await page.waitForSelector("#aca-scRole");
    check(await page.$eval("#aca-scRole", (n) => n.value) === "r1", "a job bar's editor has its role");
    await page.selectOption("#aca-scRole", "r2");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").pop()[1].p.role_id === "r2"), "changes the role");
    // a Part time / 1099 person drives from home
    await page.evaluate(() => { window.__rpcCalls.length = 0; window.__driveCalls = []; });
    await page.click('#aca-scGrid .sc-chip.none[data-booking="bk2"]');
    await page.waitForSelector('#aca-scPick li input[value="u5"]');
    await page.check('#aca-scPick li input[value="u5"]');
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__driveCalls.some((b) => b.booking_id === "bk2" && b.user_id === "u5")), "a Part time / 1099 person's drive is looked up from their home");
    // batch a job with another one that day (right-click the bar)
    await page.evaluate(() => { window.__rpcCalls.length = 0; window.__driveCalls = []; });
    await page.click('#aca-scGrid .sc-b.sc-k-job[data-entry="se1"]', { button: "right" });
    await page.waitForSelector('.sc-menu [data-mm="batch"]');
    check((await page.textContent(".sc-menu")).includes("Batch with another job"), "right-click a job bar: the batching menu");
    await page.click('.sc-menu [data-mm="batch"]');
    await page.waitForSelector(".sc-modal .sc-trip");
    const tripText = await page.textContent(".sc-modal .sc-trip");
    check(tripText.includes("Leave the studio") && tripText.includes("drive to Hampden Rec") && tripText.includes("Set up (30 min)") && tripText.includes("Back at the studio"), "the trip: studio, job to job, back");
    check(await page.evaluate(() => window.__driveCalls.some((b) => b.from_booking_id === "bk1" && b.booking_id === "bk4")), "asks for the drive from the first job to the next");
    check(await page.isChecked(".sc-modal .sc-crew"), "the rest of the crew comes along by default");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(200);
    const bsaves = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_batch_save").map((c) => c[1].p.entries));
    const bput = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").map((c) => c[1].p));
    check(bput.length === 2 && bput.every((x) => x.booking_id === "bk4"), "both people are put on the second job");
    check(bsaves.length === 2 && bsaves[0][0].drive_before_min === 25 && bsaves[0][0].drive_after_min === 0 && bsaves[0][1].drive_before_min === 15 && bsaves[0][1].drive_after_min === 25 && bsaves[0][0].batch_id === bsaves[0][1].batch_id,
      "saved as one trip: studio -> first (25), first -> second (15), second -> studio (25): " + JSON.stringify(bsaves[0]));
    await page.click('#aca-scGrid .sc-b.sc-k-job[data-entry="se8"]', { button: "right" });
    await page.click('.sc-menu [data-mm="trip"]');
    await page.waitForSelector(".sc-modal .sc-trip");
    check((await page.textContent(".sc-modal .sc-trip")).includes("Wait"), "See the trip: the wait between jobs");
    await page.evaluate(() => { window.__rpcCalls.length = 0; });
    await page.click('.sc-modal [data-m="unbatch"]');
    await page.waitForTimeout(200);
    const ub = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_batch_save").map((c) => c[1].p.entries)[0]);
    check(ub && ub.length === 2 && ub.every((r) => r.batch_id === null && r.drive_before_min === 25 && r.drive_after_min === 25), "taking a stop out: both go back to round trips from the studio");
    // add time from an empty spot (day view)
    await page.click('input[name="aca-scView"][value="day"] + span');
    await page.waitForTimeout(150);
    check((await page.$$("#aca-scGrid .sc-head")).length === 2, "day view: one day");
    // a day Alex (third row) is not off: Monday of this week
    await page.evaluate(() => { const b = document.querySelector('#aca-panel-schedule [data-v="today"]'); b.click(); });
    await page.waitForTimeout(100);
    for (let i = 0; i < 7 && !(await page.textContent("#aca-scTitle")).startsWith("Monday"); i++) { await page.click('#aca-panel-schedule [data-v="prev"]'); await page.waitForTimeout(100); }
    await page.click("#aca-scGrid .sc-cell >> nth=2", { position: { x: 30, y: 10 } });
    await page.waitForSelector("#aca-scT");
    await page.fill("#aca-scT", "Editing");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    const w = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").pop()[1].p);
    check(w.kind === "studio" && w.title === "Editing" && w.user_id === "u5", "adds studio time (the default) for the clicked person: " + JSON.stringify(w));
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "schedule_attention")), "Today checks for jobs with nobody on them");
    const legend = await page.textContent("#aca-panel-schedule .sc-legend");
    check(legend.includes("On site job") && legend.includes("Studio") && legend.includes("Admin"), "legend: On site job, Studio, Admin");
    check((await page.$$("#aca-scJump option")).length >= 9, "jump up to two months ahead");
    // My day
    await page.click('#aca-nav button[data-tab="myday"]');
    await page.waitForSelector("#aca-asBody .as-task");
    check((await page.textContent("#aca-asBody")).includes("Leave the studio"), "my day says when to leave");
    check(await page.$eval("#aca-asTasks .as-task", (n) => n.textContent.includes("Urgent")), "urgent task on top");
    await page.click("#aca-asBody .as-task:nth-of-type(2) input");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "assignment_check" && c[1].p_done === true)), "checks a task off");
    check((await page.textContent("#aca-asBody")).includes("Second shooter") && await page.$eval('#aca-asBody a.pill[href^="#crew/"]', (n) => n.textContent === "Confirm"), "my day: role and a Confirm link");
    // Tasks
    await page.click('#aca-nav button[data-tab="tasks"]');
    await page.waitForSelector("#aca-asTBody tr.as-row");
    check((await page.$$("#aca-asTBody tr.as-row")).length === 4, "task list: " + (await page.$$("#aca-asTBody tr.as-row")).length);
    check(await page.$eval("#aca-asTBody tr.as-row", (n) => !!n.querySelector("input[data-check]")), "one-time tasks come first, with a box to tick");
    await page.click("#aca-asTBody tr.as-row input[data-check]");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => (window.__rpcCalls.filter((c) => c[0] === "assignment_check").pop() || [])[1].p_done === true), "ticks a one-time task off from the list");
    check((await page.textContent("#aca-asTBody")).includes("Weekdays"), "repeat described in words");
    await page.click("#aca-asAdd");
    await page.selectOption("#aca-atWho", "u2");
    await page.fill("#aca-atTitle", "Sweep the studio");
    await page.click('input[name="aca-atRep"][value="weekly"] + span');
    await page.selectOption("#aca-atDow", "5");
    await page.click('input[name="aca-atPri"][value="urgent"] + span');
    await page.click('.as-modal [data-m="save"]');
    await page.waitForTimeout(150);
    const t = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "assignment_save").pop()[1].p);
    check(t.repeat === "weekly" && t.weekdays[0] === 5 && t.priority === "urgent" && t.user_id === "u2", "adds a weekly urgent task");
    // ws/settings: the two daily settings live in Settings > Team emails; Tasks keeps a one-line shortcut
    check(await visible(page, "#aca-asSetCard") && (await page.textContent("#aca-asSetTxt")).includes("8pm"), "tasks: shortcut line says the evening notification is at 8pm");
    await page.click("#aca-asSetBtn");
    await page.waitForSelector("#aca-asPlanHour");
    check(await page.$eval("#aca-asPlanHour", (n) => n.value) === "20", "evening notification at 8pm");
    check(await page.$eval("#aca-asMailHour", (n) => n.value) === "7" && await page.$eval("#aca-asMailOn", (n) => n.checked), "morning email at 7am");
    await page.click('.as-modal [data-m="cancel"]');
    // Team: weekly hours
    await page.click('#aca-nav button[data-tab="people"]');
    await page.waitForSelector("#aca-teamBody [data-edit]");
    check((await page.textContent("#aca-teamBody")).includes("40 h/week"), "team list shows weekly hours");
    check((await page.textContent("#aca-teamBody")).includes("Owner \u00b7 Salaried"), "team list shows job title and employment type");
    await page.click("#aca-teamAdd");
    await page.selectOption("#aca-tmType", "part_time");
    check(await page.isChecked('input[name="tm-assignments"][value="view"]') && await page.isChecked('input[name="tm-openjobs"][value="view"]') && await page.isChecked('input[name="tm-staffrecords"][value="view"]') &&
      await page.isChecked('input[name="tm-timeclock"][value="view"]') && await page.isChecked('input[name="tm-bookings"][value="none"]'), "part time: My day, Time clock, My records and Open jobs preset");
    await page.click("#aca-tmCancel");
    await page.click('#aca-teamBody [data-edit="u2"]');
    await page.waitForTimeout(100);
    check((await page.inputValue("#aca-tmRate")) === "200" && (await page.inputValue("#aca-tmBasis")) === "day", "pay shows their own rate");
    await page.fill("#aca-tmRate", "220");
    await page.fill("#aca-tmHours", "28");
    await page.fill("#aca-tmTitle", "Second shooter");
    await page.selectOption("#aca-tmType", "contractor");
    check((await page.textContent("#aca-tmTypeNote")).includes("Open jobs"), "1099 explains offers + payroll");
    await page.click("#aca-tmSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "team_set_hours" && c[1].p_hours === 28 && c[1].p_user_id === "u2")), "saves weekly hours");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "timeclock_rate_save" && c[1].p.scope === "person" && c[1].p.scope_key === "u2" && c[1].p.id === "r3" && c[1].p.rate === "220" && c[1].p.basis === "day")), "pay writes their own rate row");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "team_set_profile" && c[1].p_user_id === "u2" && c[1].p_type === "contractor" && c[1].p_title === "Second shooter")), "saves job title and employment type");
    await page.click('#aca-teamBody [data-edit="u2"]');
    await page.waitForSelector("#aca-tmRoles input");
    check(await page.isChecked('#aca-tmRoles input[value="r2"]') && !(await page.isChecked('#aca-tmRoles input[value="r1"]')), "team editor: their crew roles");
    await page.check('#aca-tmRoles input[value="r1"]');
    await page.click("#aca-tmSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "team_set_roles" && c[1].p_user_id === "u2" && c[1].p_roles.slice().sort().join() === "r1,r2,r4")), "saves crew roles");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Job checklists (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#jobs/checklists");
    check(await page.$eval("#aca-panel-checklists", (n) => n.classList.contains("active")), "#jobs/checklists opens Jobs");
    await page.waitForSelector("#aca-wfJobs .wf-job");
    check((await page.$$("#aca-wfJobs .wf-job")).length === 1, "shows only jobs with tasks to do");
    check((await page.textContent("#aca-wfJobs")).includes("1 overdue"), "flags the overdue task");
    await page.selectOption("#aca-wfShow", "all");
    check((await page.$$("#aca-wfJobs .wf-job")).length === 2, "All jobs shows the finished one too");
    await page.evaluate(() => { location.hash = "#jobs/wfsteps"; }); // Settings > Job types once the settings stream adds it
    await page.waitForSelector("#aca-wfSteps tr.wf-row");
    check((await page.textContent("#aca-wfSteps")).includes("7 days before picture day"), "step says when it is due");
    check((await page.textContent("#aca-wfSteps")).includes("Sports: league with parent contacts"), "steps grouped by job type");
    await page.click("#aca-wfAdd");
    await page.waitForSelector("#aca-wsTitle");
    await page.fill("#aca-wsTitle", "Print the team list");
    await page.selectOption("#aca-wsType", "school");
    await page.fill("#aca-wsDays", "2");
    await page.selectOption("#aca-wsDir", "before");
    await page.click('.modal [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "workflow_step_save" && c[1].p.title === "Print the team list" && c[1].p.type_key === "school" && c[1].p.anchor === "picture_day" && c[1].p.offset_days === -2 && c[1].p.assign_to === "crew")), "adds a step 2 days before picture day");
    await page.click('#aca-wfSteps tr.wf-row[data-id="ws3"]');
    await page.waitForSelector("#aca-wsTitle");
    check(await page.$eval("#aca-wsDir", (n) => n.value) === "booked" && await page.$eval("#aca-wsTo", (n) => n.value) === "person", "opens a step with its settings");
    await page.click('.modal [data-m="remove"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "workflow_step_archive" && c[1].p_id === "ws3")), "removes a step");
    await page.click('#aca-nav button[data-tab="today"]');
    await page.waitForTimeout(300);
    check((await page.textContent("#aca-panel-today")).includes("job checklist task is overdue"), "Today flags the overdue checklist task");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Did families hear? (Parents tab, Today task)");
  {
    const { page, errors } = await open(browser, port, "", "#today");
    await page.waitForSelector('#aca-todayList .today-item[data-key="followRoster"]');
    const row = await page.$('#aca-todayList .today-item[data-key="followRoster"]');
    check((await row.textContent()).includes("Brewer Travel Basketball Club") && (await row.textContent()).includes("no roster two weeks out"), "Today: the roster task names its job");
    check(await row.getAttribute("data-jobtab") === "hub", "Today: it opens the job's Hub tab");
    await page.evaluate(() => { location.hash = "#jobs/job/bk1/parents"; });
    await page.waitForSelector("#aca-jpBody .pr-tbl");
    const txt = await page.textContent("#aca-jpBody");
    check(page.url().endsWith("#jobs/job/bk1/hub"), "the old Parents link lands on the Hub tab");
    check(txt.includes("Shooting: Outdoors") && txt.includes("Coach emails: 0") && txt.includes("Roster with parent emails: not yet") && txt.includes("What we have from the league"), "Hub tab: shooting, coaches, roster");
    check(txt.includes("too early to count") && txt.includes("Not yet"), "Hub tab: an early copy doesn't count");
    check(txt.includes("40% rain, gusts to 12 mph") && txt.includes("Hub message: One week before"), "Hub tab: the weather check and the link opened");
    await page.click("[data-pr-roster]");
    await page.waitForTimeout(300);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "booking_run_roster_only" && c[1].p_booking === "bk1")), "Keep date runs the job as Roster Only");
    check(!errors.length, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Job page (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#jobs/bookings");
    await page.waitForSelector('#aca-bkBody tr[data-id="bk1"]');
    await page.click('#aca-bkBody tr[data-id="bk1"]');
    await page.waitForSelector("#aca-jpTabs button");
    check(await page.$eval("#aca-panel-job", (n) => n.classList.contains("active")), "clicking the row opens the job page");
    check(!(await page.$('#aca-nav button[data-tab="job"]')), "the job page is not in the menu");
    const tabs = await page.$$eval("#aca-jpTabs button", (bs) => bs.map((b) => b.dataset.t));
    check(JSON.stringify(tabs) === JSON.stringify(["overview", "booking", "hub", "crew", "checklist", "results", "gotphoto", "time", "notes", "history"]), "tabs: " + tabs.join(","));
    await page.click('#aca-jpTabs button[data-t="hub"]');
    await page.waitForSelector("#aca-jpBody .pr-tbl");
    const hubTxt = await page.textContent("#aca-jpBody");
    check(hubTxt.includes("By pat@hll.org \u00b7 email, text") && hubTxt.includes("Reminders go to: Chris Snowdeal") && hubTxt.includes("Did they grab it?") &&
      !!(await page.$('#aca-jpBody a[href="https://207photo.com/sportsadmin/#job=gp1"]')), "Hub tab: who grabbed each message, reminders, their hub link");
    await page.click('#aca-jpTabs button[data-t="overview"]');
    await page.waitForTimeout(150);
    const ov = await page.textContent("#aca-jpBody");
    check(ov.includes("Sam Helper") && ov.includes("40 min drive") && ov.includes("Chris Snowdeal"), "overview shows crew and contacts");
    check(ov.includes("Use the side door") && ov.includes("HLL-Guest") && ov.includes("On-site details"), "On-site details on Overview: WiFi and For the crew");
    await page.waitForSelector("#aca-jpLatest .jp-notes li", { timeout: 3000 }).catch(() => {});
    check((await page.textContent("#aca-jpLatest")).includes("Parking is behind the gym") && !!(await page.$("#aca-jpLatest #aca-jpNote")), "latest job notes and an Add box top Overview");
    await page.click('#aca-jpOnsite [data-os="edit"]');
    await page.fill("#aca-jpOsPw", "newpass");
    await page.click('#aca-jpOsForm [type=submit]');
    await page.waitForTimeout(200);
    check((await page.textContent("#aca-jpOnsite")).includes("newpass") && !(await page.$("#aca-jpOsForm")), "On-site details save in place");
    check(!(await page.$('#aca-panel-job [data-j="booking"]')), "no Open the booking button");
    // Edit booking: the crew is there to change, and moving the day says what moves with it
    await page.click('#aca-panel-job button[data-j="edit"]');
    await page.waitForSelector("#aca-bkCrew .bk-crew", { state: "attached" });
    await page.waitForFunction(() => { const x = document.querySelector('#aca-bkCrew .bk-crew[value="u2"]'); return x && x.checked; }, null, { timeout: 3000 }).catch(() => {});
    check((await page.textContent(".bk-form h2")) === "Edit booking" && await page.isChecked('#aca-bkCrew .bk-crew[value="u2"]'), "Edit booking shows who's on the job");
    await page.$eval("#aca-bkDays .bk-d-day", (n) => { n.value = "2027-01-09"; n.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.waitForSelector("#aca-bkMoveNote:not(.hidden)");
    const mvn = await page.textContent("#aca-bkMoveNote");
    check(mvn.includes("Moving the day") && mvn.includes("Sam H.") && mvn.includes("Google Calendar") && /email/.test(mvn), "moving the day says what moves: " + mvn);
    await page.click("#aca-bkCrewSum");
    await page.uncheck('#aca-bkCrew .bk-crew[value="u2"]');
    await page.click('.bk-form button[data-v="save"]');
    await page.waitForFunction(() => window.__rpcCalls.some((c) => c[0] === "schedule_remove"), null, { timeout: 3000 }).catch(() => {});
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "booking_update") && window.__rpcCalls.some((c) => c[0] === "schedule_remove" && c[1].p_id === "se2")), "unticking takes them off the job");
    await page.waitForSelector("#aca-jpTabs button");
    await page.click('#aca-jpTabs button[data-t="checklist"]');
    check(page.url().endsWith("#jobs/job/bk1/checklist"), "a tab goes in the address");
    await page.waitForSelector("#aca-jpBody .tb-jt");
    check((await page.textContent("#aca-jpBody")).includes("days late"), "checklist marks the late task");
    check(!(await page.textContent("#aca-jpBody")).includes("Emails to the partner"), "no partner emails on the checklist");
    const give = await page.$("#aca-jpBody select[data-give]");
    if (give) { await give.selectOption("u2"); await page.waitForTimeout(150); }
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "task_bulk" && c[1].p.user_id === "u2")), "a step can be given to someone else");
    await page.click('#aca-jpTabs button[data-t="results"]');
    check((await page.textContent("#aca-jpBody")).includes("$1,234.50 from 40 orders"), "results show sales");
    await page.click('#aca-jpTabs button[data-t="notes"]');
    await page.waitForSelector(".jp-notes li[data-n]");
    check((await page.textContent(".jp-booknote")).includes("For the crew") && (await page.textContent(".jp-booknote")).includes("Use the side door"), "booking notes top the Notes tab");
    check((await page.$eval(".jp-notes .at", (n) => n.textContent)) === "@Sam Helper", "a mention is highlighted");
    await page.click("#aca-jpNote");
    await page.keyboard.type("Ask @sa");
    await page.waitForSelector("#aca-jpSug:not(.hidden) button");
    await page.keyboard.press("Enter");
    await page.keyboard.type("about the ladder");
    check((await page.$eval("#aca-jpNote", (n) => n.value)) === "Ask @Sam Helper about the ladder", "picking from the @ list inserts the name");
    check((await page.textContent("#aca-jpMent")).includes("Will notify Sam Helper"), "says who will be notified");
    await page.click("#aca-jpAdd");
    await page.waitForTimeout(200);
    const add = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "job_note_add").pop());
    check(add && add[1].p_booking === "bk1" && JSON.stringify(add[1].p_mentions) === '["u2"]', "the note is saved with its mention: " + JSON.stringify(add && add[1]));
    await page.click('#aca-jpTabs button[data-t="history"]');
    await page.waitForSelector(".hv-list li");
    const hv = await page.textContent(".hv-list");
    check(hv.includes("Brewer High") && hv.includes("put Sam Helper on the crew") && hv.includes("moved the job to Booked"), "history reads in words");
    const [csv] = await Promise.all([page.waitForEvent("download"), (async () => { await page.click('[data-j="dl"]'); await page.click('[data-d="crew"]'); })()]);
    check(fs.readFileSync(await csv.path(), "utf8").startsWith("Name,Day,Start,End"), "crew CSV downloads");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Main contact per service (owner)");
  {
    const HG = "22222222-2222-2222-2222-222222222222";
    const { page, errors } = await open(browser, port, "", "#partners/org/" + HG + "/contacts");
    await page.waitForSelector("#aca-opBody .og-svcs");
    const head = await page.textContent("#aca-opBody .og-svcs");
    check(head.includes("Team & individual") && head.includes("School photos") && !!(await page.$('#aca-opBody select[data-svcadd]')), "the partner shows a status per service, plus + Service");
    const rowText = async (cid) => page.textContent(`#aca-opBody tr[data-cid="${cid}"] .og-cview`);
    check((await rowText("c6")).includes("Team & individual main") && (await rowText("c7")).includes("School photos pitch to") && (await rowText("c8")).includes("Team & individual copy in"),
      "contacts say who's main for which service (pitch to while it's a prospect)");
    check(await page.$eval('#aca-opBody tr[data-cid="c6"] select[data-role="school_photos"]', (x) => x.value) === "", "the AD is Not involved in school photos");
    await page.selectOption('#aca-opBody tr[data-cid="c8"] select[data-role="school_photos"]', "main");
    await page.waitForTimeout(200);
    const w = await page.evaluate(() => (window.__writes || []).filter((x) => x[0] === "prospect_contacts" && x[1] === "update").pop());
    check(w && w[2].service_roles && w[2].service_roles.school_photos === "main" && w[2].service_roles.portraits === "copy", "changing a dropdown saves that service only: " + JSON.stringify(w && w[2]));
    await page.click('#aca-opBody [data-act="email"]');
    await page.waitForSelector("#aca-ogOoTo");
    const ticked = () => page.$$eval("#aca-ogOoTo input:checked", (xs) => xs.map((x) => x.value).join(","));
    check(!!(await page.$('#aca-ogOoSvc button[data-svc="school_photos"]')) && (await ticked()) === "c6", "Email someone starts on the service we're a client for: the AD is ticked: " + (await ticked()));
    await page.click('#aca-ogOoSvc button[data-svc="school_photos"]');
    check((await ticked()) === "c7", "About school photos ticks the principal instead");
    await page.evaluate(() => document.querySelectorAll(".modal-wrap, .og-modal-wrap").forEach((n) => n.remove()));
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  {
    const { page, errors } = await open(browser, port, "", "#jobs/bookings");
    await page.waitForSelector("#aca-bkBody tr.bk-row");
    await page.click("#aca-bkNew");
    await page.waitForSelector("#aca-bkOrgQ");
    await page.click('#aca-bkTypes input[value="sports_data"]', { force: true });
    await page.fill("#aca-bkOrgQ", "Hancock Grammar");
    await page.waitForSelector("#aca-bkOrgList button:not([data-addorg])");
    await page.click("#aca-bkOrgList button:not([data-addorg])");
    await page.waitForSelector('#aca-bkContacts input[data-cid="c6"]');
    const on = () => page.$$eval("#aca-bkContacts input[data-cid]:checked", (xs) => xs.map((x) => x.dataset.cid).sort().join(","));
    check((await on()) === "c6,c8", "a sports job ticks the Team & individual main and copy-ins: " + (await on()));
    await page.click('#aca-bkTypes input[value="school"]', { force: true });
    await page.waitForTimeout(150);
    check((await on()) === "c7", "School Photos ticks the person we pitched: " + (await on()));
    check(!!(await page.$('#aca-bkContacts input[name="bkRuns"]')) && (await page.textContent("#aca-bkContacts")).includes("Who runs school picture day"), "first school photos booking asks who runs picture day");
    await page.check('#aca-bkContacts input[name="bkRuns"][value="c8"]');
    await page.waitForTimeout(100);
    check((await page.$$eval("#aca-bkContacts input[data-cid]:checked", (xs) => xs.map((x) => x.dataset.cid).join(","))) === "c7,c8", "the secretary is ticked and the principal stays copied in");
    await page.uncheck("#aca-bkKeepPitched");
    await page.waitForTimeout(100);
    check((await on()) === "c8", "unticking Keep takes the principal off");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Partner page (owner)");
  {
    const BR = "11111111-1111-1111-1111-111111111111";
    const { page, errors } = await open(browser, port, "", "#partners/orgs");
    await page.waitForSelector(`#aca-panel-orgs [data-id="${BR}"]`);
    await page.click(`#aca-panel-orgs [data-id="${BR}"]`);
    await page.waitForSelector("#aca-opTabs button");
    check(await page.$eval("#aca-panel-org", (n) => n.classList.contains("active")), "clicking a partner opens its page");
    check(page.url().includes("#partners/org/" + BR), "the address is #partners/org/<id>");
    check(await page.$eval('#aca-nav button[data-tab="orgs"]', (b) => b.getAttribute("aria-selected") === "true"), "Partners stays lit in the menu");
    const tabs = await page.$$eval("#aca-opTabs button", (bs) => bs.map((b) => b.dataset.t));
    check(JSON.stringify(tabs) === JSON.stringify(["overview", "contacts", "jobs", "sales", "emails", "agreements", "history"]), "tabs: " + tabs.join(","));
    const labels = await page.$$eval("#aca-opTabs button", (bs) => bs.map((b) => b.textContent));
    check(labels.join("|") === "Overview|Contacts|Jobs|Sales|Emails & hub|Agreement & rebooking|Notes & history", "tab names: " + labels.join("|"));
    await page.waitForSelector(".op-need, .jp-sec .empty");
    check((await page.textContent("#aca-opBody")).includes("Needs you here"), "overview lists what needs you here");
    check(!!(await page.$(`#aca-opBody a[href="#jobs/job/bk1"]`)) || (await page.textContent("#aca-opBody")).includes("Winter Sports"), "overview shows the next job");
    check(!!(await page.$("#aca-opBody .op-grid")), "overview grid has a class (one column on a phone)");
    const ov = await page.textContent("#aca-opBody");
    check(ov.includes("Stage changed: New") && !/stage_change|email_sent/.test(ov), "activity kinds read as words");
    check(ov.includes("Jobs with us") && ov.includes("Payout") && ov.includes("10% of sales"), "at a glance: jobs and payout");
    check(!!(await page.$('#aca-opBody .op-need [data-go="pay"]')), "a payout owed for an ended season has Record payment right there");
    await page.click('#aca-opBody .op-need [data-go="pay"]');
    await page.waitForSelector("#aca-rsPayRef");
    check(true, "Record payment opens from the overview");
    await page.evaluate(() => document.querySelectorAll(".modal-wrap").forEach((n) => n.remove()));
    await page.click('#aca-opTabs button[data-t="jobs"]');
    await page.waitForSelector("#aca-opBody .op-table, #aca-opBody .empty");
    check((await page.textContent("#aca-opBody")).includes("Winter Sports"), "Jobs tab lists this partner's jobs");
    check((await page.textContent("#aca-opBody")).includes("Brewer Travel | Fall 2025") && (await page.textContent("#aca-opBody")).includes("GotPhoto only"), "Jobs tab includes GotPhoto jobs with no booking");
    await page.click('#aca-opTabs button[data-t="sales"]');
    await page.waitForSelector("#aca-opBody .op-card, #aca-opBody .empty");
    const sales = await page.textContent("#aca-opBody");
    check(sales.includes("Brewer Travel | Fall 2026"), "Sales tab lists its galleries");
    check(/Payout:\s*10% of sales/.test(sales) && !!(await page.$('#aca-opBody [data-s="terms"]')) && (await page.textContent('#aca-opBody [data-s="terms"]')) === "Change", "payout line: 10% of sales, Change");
    check(!!(await page.$('#aca-opBody [data-s="pay"]')) && !!(await page.$('#aca-opBody [data-s="stmt"]')), "Record payment and Copy statement on the Sales tab");
    await page.click('#aca-opBody [data-s="terms"]');
    await page.waitForSelector("#aca-rsTPct");
    check(await page.$eval("#aca-rsTPct", (i) => i.value) === "10", "Change opens the terms");
    await page.evaluate(() => document.querySelectorAll(".modal-wrap").forEach((n) => n.remove()));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#partners/org/${BR}/payouts`);
    await page.waitForSelector("#aca-opTabs button");
    check(await page.$eval('#aca-opTabs button[data-t="sales"]', (b) => b.getAttribute("aria-selected") === "true") && page.url().endsWith("/sales"), "an old /payouts address opens Sales");
    await page.click('#aca-opTabs button[data-t="contacts"]');
    await page.waitForSelector("#aca-opPanel #aca-ogPanel.og-inline");
    check((await page.textContent("#aca-opPanel")).includes("Chris"), "Contacts shows the people");
    check(!(await page.isVisible('#aca-opPanel [data-act="close"]')) && !(await page.$("#aca-opPanel .og-ptop")), "no close, arrows or second name on the page");
    check(!(await page.isVisible("#aca-ogDetails")) && !!(await page.$('#aca-opPanel [data-act="details"]')), "details sit behind Edit details");
    await page.click('#aca-opPanel .og-actions [data-act="details"]');
    check(await page.isVisible("#aca-ogDetails"), "Edit details opens them");
    const secs = await page.$$eval("#aca-opPanel .og-sec h3", (hs) => hs.map((h) => h.textContent.trim()));
    check(/^Contacts/.test(secs[0]), "contacts come first: " + secs.join(" / "));
    await page.waitForSelector("#aca-opPanel .og-lbl");
    check((await page.textContent("#aca-opPanel")).includes("gets booking emails") && (await page.textContent("#aca-opPanel")).includes("coach"), "booking email and coach contacts are labelled");

    await page.click('#aca-opTabs button[data-t="emails"]');
    await page.waitForSelector("#aca-opBody .op-table, #aca-opBody .empty");
    check(!!(await page.$('#aca-opBody a[href="#partners/outbox/' + BR + '"]')), "Emails & hub links to the Outbox for this partner");
    check(!!(await page.$('#aca-opBody tr[data-id="ob2"] [data-v="sendnow"]')) && !!(await page.$('#aca-opBody tr[data-id="ob2"] [data-v="bskip"]')), "a failed booking email has Send now and Don't send");
    await page.click('#aca-opBody tr[data-id="ob2"] [data-v="preview"]');
    await page.waitForSelector("#aca-opBody tr.op-prev .ob-mail:not(:has(.spin))");
    check((await page.textContent("#aca-opBody tr.op-prev")).includes("Picture day is coming up"), "Preview shows the email");
    await page.click('#aca-opBody tr[data-id="ob2"] [data-v="bskip"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "booking_email_skip" && c[1].p_email === "ob2")), "Don't send skips the booking email");

    await page.click('#aca-opTabs button[data-t="agreements"]');
    await page.waitForSelector('#aca-opBody [data-a="new"]');
    check(!!(await page.$('#aca-opBody [data-a="rebook"]')), "Agreement & rebooking: New agreement and Draft rebook email");
    await page.click('#aca-opBody [data-a="new"]');
    await page.waitForTimeout(300);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "agreement_save" && c[1].p_id === null && c[1].p.org_id === "11111111-1111-1111-1111-111111111111")), "New agreement starts one for this partner without asking which");
    await page.evaluate(() => document.querySelectorAll(".modal-wrap").forEach((n) => n.remove()));

    await page.click('#aca-opTabs button[data-t="history"]');
    await page.waitForSelector("#aca-opHist .hv-list li, #aca-opHist .empty");
    check(!!(await page.$("#aca-opNotes")) && !!(await page.$("#aca-opHist .hv-list li")), "Notes & history tab shows the changes");
    await page.waitForSelector("#aca-opTl .op-tl li");
    check((await page.textContent("#aca-opTl")).includes("Met Chris at the fall tourney"), "notes are on Notes & history");
    await page.fill("#aca-opNote", "Wants a spring date");
    await page.click('#aca-opBody [data-h="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => (window.__writes || []).some((w) => w[0] === "prospect_activities" && w[1] === "insert" && w[2].kind === "note" && w[2].body === "Wants a spring date")), "adds a note");
    await page.click("#aca-bookBtn");
    await page.waitForTimeout(300);
    await page.waitForSelector("#aca-bkOrgPick strong");
    check((await page.textContent("#aca-bkOrgPick")).includes("Brewer Travel Basketball Club"), "Book a job from an organization page starts with that organization");
    await page.waitForFunction(() => { const x = document.querySelector('#aca-bkTypes input[value="sports_data"]'); return x && x.checked; }, null, { timeout: 3000 }).catch(() => {});
    check(await page.isChecked('#aca-bkTypes input[value="sports_data"]'), "a league starts on a sports job type");
    check(!(await page.$eval("#aca-bkOrgPick a", (a) => a.target)), "open organization stays in this tab");
    await page.keyboard.press("Escape");
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#jobs/job/bk1`);
    await page.waitForSelector(".jp-trail");
    check((await page.textContent(".jp-trail")).includes("Brewer Travel Basketball Club") && !!(await page.$(`.jp-trail a[href^="#partners/org/${BR}"]`)), "a job page leads back to its partner");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("One Outbox (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#partners/ready");
    await page.waitForSelector("#aca-obHeld .og-rcard");
    check(await page.$eval("#aca-panel-outbox", (n) => n.classList.contains("active")), "#partners/ready opens the Outbox");
    const card = await page.textContent("#aca-obHeld .og-rcard");
    check(card.includes("Island Cheer") && card.includes("Looks like your teams are already practicing"), "outreach waiting for an OK shows as a card with its body");
    const verbs = await page.$$eval("#aca-obHeld .og-rcard button", (bs) => bs.map((b) => b.textContent.trim()));
    check(["Send now", "Add to queue", "Edit", "Don\u2019t send"].every((v) => verbs.includes(v) || verbs.includes(v.replace("\u2019", "'"))), "card verbs: " + verbs.join(", "));
    await page.click('#aca-obHeld .og-rcard button[data-rgo="sendnow"]');
    await page.waitForFunction(() => window.__rpcCalls.some((c) => c[0] === "prospect_send_now"));
    const sn = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "prospect_send_now").pop());
    check(Array.isArray(sn[1].p_ids) && sn[1].p_ids.length > 0, "Send now on a held card sends that email right away: " + JSON.stringify(sn[1]));
    check(!(await page.$('#aca-obBody [data-id="ob1"], #aca-obList [data-id="ob1"]')), "the same email is not listed twice");
    check(!(await page.$("#aca-ogPause")) && !(await page.$("#aca-ogTest")), "no pause, test or tracking switches here");
    check(!!(await page.$('#aca-panel-outbox a[href="#system/sending"]')), "sending switches link to Settings");
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#partners/outbox/44444444-4444-4444-4444-444444444444`);
    await page.waitForSelector("#aca-obTrail a");
    check((await page.textContent("#aca-obTrail")).includes("Island Cheer") && (await page.textContent("#aca-obOrgTag")).includes("Island Cheer"), "one partner's Outbox, with a trail back");
    // Every kind of row opens its panel with the email in it (a stray variable left it blank, 2026-10-23).
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#partners/outbox`);
    await page.waitForSelector("#aca-obChips");
    await page.click('#aca-obChips button[data-f="all"]');
    for (const id of ["ob2", "ob3", "ob4", "ob5", "ob6", "digest"]) {
      await page.$eval('#aca-obBody tr[data-id="' + id + '"]', (n) => n.click());
      await page.waitForTimeout(100);
      const box = await page.$("#aca-obPanel:not(.hidden) #aca-obPreview");
      check(!!box && (await box.textContent()).trim().length > 0 && !(await box.textContent()).includes("Loading"), "Outbox row " + id + " shows its email in the panel");
    }
    // a queued outreach email can go right away too
    await page.$eval('#aca-obBody tr[data-id="ob5"]', (n) => n.click());
    await page.click('#aca-obPanel button[data-v="osend"]');
    await page.waitForFunction(() => window.__rpcCalls.some((c) => c[0] === "prospect_send_now" && c[1].p_ids.includes("ob5")));
    check(true, "Send now on a scheduled outreach row in the Outbox");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Partners list (owner)");
  {
    const { page, errors } = await open(browser, port, "?clients=1", "#partners/orgs");
    await page.waitForSelector("#aca-ogBody tr.og-row");
    check(await page.$eval('#aca-ogGroups [data-group="clients"]', (b) => b.getAttribute("aria-pressed") === "true"), "admins open on Clients");
    const heads = await page.$$eval("#aca-ogHead th[data-b]", (ts) => ts.map((t) => t.textContent.trim()));
    check(heads.includes("Main contact") && heads.includes("Last picture day") && heads.includes("Next picture day") && heads[0] === "Partner", "client columns: " + heads.join(","));
    check((await page.textContent("#aca-panel-orgs .og-head h2")) === "Partners" && (await page.textContent("#aca-ogAdd")).includes("Add partner"), "says Partners");
    await page.click('#aca-ogGroups [data-group="past"]');
    check((await page.textContent("#aca-ogBody")).includes("No partners in Past clients"), "an empty group says so plainly");
    await page.click("#aca-ogAdd");
    await page.fill("#aca-ogNewName", "Orono Rec");
    await page.fill("#aca-ogNewFirst", "Dana");
    await page.fill("#aca-ogNewEmail", "dana@orono.org");
    await page.click('.og-modal [data-v="1"]');
    await page.waitForTimeout(250);
    const w = await page.evaluate(() => window.__writes || []);
    check(w.some((x) => x[0] === "prospect_orgs" && x[1] === "insert" && x[2].name === "Orono Rec" && x[2].source === "Partners tab"), "Add partner adds the partner");
    check(w.some((x) => x[0] === "prospect_contacts" && x[1] === "insert" && x[2].email === "dana@orono.org" && x[2].first_name === "Dana" && x[2].is_primary === true), "and its main contact");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  {
    const { page, errors } = await open(browser, port, "?clients=1", "#partners/orgs");
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForSelector("#aca-ogBody tr.og-row");
    check(!(await page.isVisible("#aca-ogFlags")), "phone: the flag chips fold behind Filters");
    await page.click("#aca-ogFToggle");
    check(await page.isVisible("#aca-ogFlags"), "phone: Filters shows them");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= 392), "phone: no sideways scroll");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Hub activity is gone, Parents (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#jobs/hubact");
    await page.waitForTimeout(300);
    check(await page.$eval("#aca-panel-bookings", (n) => n.classList.contains("active")) && !(await page.$("#aca-panel-hubact")), "#jobs/hubact lands on All jobs");
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#parents/blocks`);
    await page.waitForSelector("#aca-panel-blocks #aca-slIpCard");
    check(!(await page.$("#aca-panel-searchlog #aca-slIpForm")) && !!(await page.$("#aca-panel-blocks #aca-slIpForm")), "blocked and trusted addresses live on the Blocked tab");
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#parents/searchlog`);
    await page.waitForSelector("#aca-panel-searchlog h2");
    check((await page.textContent("#aca-panel-searchlog h2")).includes("Find My Photos activity"), "the Find My Photos tab is the activity log");
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#parents/requests`);
    await page.waitForSelector("#aca-reqBody .js-resolve");
    check((await page.textContent("#aca-reqBody .js-resolve")) === "Mark handled", "help requests say Mark handled");
    await page.waitForSelector('#aca-reqBody tr.req-searches[data-id="2"] .rq-affirm');
    check((await page.textContent('#aca-reqBody tr.req-searches[data-id="1"] .rq-affirm')).includes("Parent/guardian") &&
      (await page.textContent('#aca-reqBody tr.req-searches[data-id="2"] .rq-affirm')).includes("Not confirmed"), "each help request shows whether the parent/guardian box was ticked");
    await page.waitForSelector('#aca-reqBody [data-gplinks]:not(.hidden) a');
    check(!!(await page.$('#aca-reqBody [data-gplinks] a[href="#jobs/job/bk1"]')) && !!(await page.$('#aca-reqBody [data-gplinks] a[href^="#partners/org/11111111"]')), "a help request links its job page and partner");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Sign-ins on Team");
  {
    const { page, errors } = await open(browser, port, "", "#team/team");
    await page.click('#aca-nav button[data-tab="people"]');
    await page.waitForSelector('[data-edit="u2"]');
    await page.click('[data-edit="u2"]');
    await page.click("#aca-tmSignins");
    await page.waitForSelector(".hv-table");
    check((await page.textContent(".hv-table")).includes("Safari on iPhone"), "sign-ins list the device");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("My jobs + Time off (staff)");
  {
    const { page, errors } = await open(browser, port, "?as=staff", "#staff/crew");
    await page.waitForSelector("#aca-crMine .cr-card");
    check((await page.$$("#aca-crMine .cr-card")).length === 2 && (await page.textContent("#aca-crMine")).includes("Second shooter") && (await page.textContent("#aca-crMine")).includes("Confirmed"), "my jobs with role and answer");
    check((await page.textContent("#aca-panel-today")).length >= 0 && await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "crew_attention")), "Today checks for jobs to confirm");
    await page.click("#aca-crMine [data-yes]");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "crew_answer" && c[1].p_answer === "confirm" && c[1].p_token === "c".repeat(32))), "Confirm from My jobs");
    await page.click("#aca-crMine [data-no] >> nth=1");
    await page.fill("#aca-crWhy", "Sick");
    await page.click('.modal [data-m="go"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "crew_answer" && c[1].p_answer === "decline" && c[1].p_reason === "Sick")), "Can't make it, with a reason");
    await page.click('#aca-pagetabs button[data-tab="timeoff"]');
    await page.waitForSelector("#aca-toMine .cr-card");
    check(!(await visible(page, "#aca-toWaitSec")) && !(await visible(page, "#aca-toTeamSec")), "staff: no approval queue, no team list");
    await page.check("#aca-toHours");
    await page.fill("#aca-toNote", "Dentist");
    await page.click("#aca-toSend");
    await page.waitForTimeout(150);
    const tr = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "time_off_request").pop()[1].p);
    check(tr.first_day === tr.last_day && tr.start_time === "09:00" && tr.end_time === "12:00" && tr.note === "Dentist", "asks for some hours off: " + JSON.stringify(tr));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "fits a phone screen");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Time off approvals (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#staff/timeoff");
    await page.waitForSelector("#aca-toWait .cr-card");
    check((await page.textContent("#aca-toWait")).includes("Family wedding") && (await page.textContent("#aca-toWait")).includes("On a job"), "the request, with the job they're on that day");
    // ws/settings B6: approvers see Waiting first and their own time off folded
    check(!(await page.isVisible("#aca-toSend")) && await page.isVisible("#aca-toOwnBtn"), "B6: their own time off is behind a button");
    await page.click("#aca-toOwnBtn");
    check(await page.isVisible("#aca-toSend"), "the button opens their own requests and the form");
    // B7: the clash is a link to the job on the Schedule
    await page.click("#aca-toWait [data-approve]");
    await page.waitForSelector(".modal [data-tojob]");
    await page.click(".modal [data-tojob]");
    await page.waitForSelector(".sc-modal .sc-pick");
    check(await page.$eval("#aca-panel-schedule", (n) => n.classList.contains("active")) && (await page.textContent(".sc-modal h2")).includes("Ellsworth"), "B7: the job they're on opens on the Schedule with its crew");
    await page.click('.sc-modal [data-m="cancel"]');
    await page.evaluate(() => { location.hash = "#staff/timeoff"; });
    await page.waitForSelector("#aca-toWait [data-approve]");
    await page.click("#aca-toWait [data-approve]");
    await page.fill("#aca-toDec", "Have fun");
    await page.click('.modal [data-m="go"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "time_off_decide" && c[1].p_id === "to1" && c[1].p_approve === true && c[1].p_note === "Have fun")), "approves with a note");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Crew confirm link (no sign-in)");
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#crew/${"c".repeat(32)}/yes`);
    await page.waitForSelector("#crp-yes");
    check(!(await page.isVisible("#aca-loginView")) && !(await page.$("#aca-nav button[data-tab]")), "no sign-in, no menu");
    check((await page.textContent("#aca-crewPublic")).includes("Second shooter") && (await page.textContent("#aca-crewPublic")).includes("Jeremiah Mutty (Lead)"), "the job, their role and who else is on it");
    await page.click("#crp-yes");
    await page.waitForSelector("#aca-crewPublic .ok");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "crew_answer" && c[1].p_answer === "confirm")), "Confirm takes one tap");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "fits a phone screen");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Staff (bookings edit, parents view)");
  {
    const { page, errors } = await open(browser, port, "?as=staff", "#partners/orgs");
    const items = await rail(page);
    check(JSON.stringify(items) === JSON.stringify(["today", "myday", "mytime", "myrecords", "jobs", "parents", "schedule"]), "menu limited to their pages: " + items.join(","));
    check(await page.$eval("#aca-panel-today", (n) => n.classList.contains("active")), "a link to a page they can't see lands on Today");
    const calls = await page.evaluate(() => window.__rpcCalls.map((c) => c[0]));
    const forbidden = calls.filter((n) => /^(admin_outbox|admin_hub|admin_lookup|prospect_|admin_morning|team_|admin_job)/.test(n));
    check(forbidden.length === 0, "never calls RPCs for other modules" + (forbidden.length ? ": " + forbidden.join(",") : ""));
    check(!(await visible(page, "#aca-syncNowBtn")) && !(await visible(page, "#aca-syncStatus")), "Sync now and the sync line hidden");
    check(await visible(page, "#aca-bookBtn"), "Book a job shown (bookings edit)");
    check(!(await visible(page, "#aca-todayOutBox")) && !(await visible(page, "#aca-todayDigestBox")) && await visible(page, "#aca-todayUpBox"), "Today shows only Coming up");
    await page.waitForSelector("#aca-todayMine .as-task");
    check((await page.textContent("#aca-todayMine")).includes("Your assignments"), "Today shows their assignments");
    await page.click("#aca-todayMine .as-task input >> nth=0");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "assignment_check")), "a task checks off from Today");
    await page.click('#aca-nav button[data-tab="parents"]');
    check(await visible(page, "#aca-viewOnly"), "view-only notice on a view module");
    await page.click('#aca-nav button[data-tab="jobs"]');
    check(!(await visible(page, "#aca-viewOnly")), "no notice on an edit module");
    await page.evaluate(() => { location.hash = "#system/team"; });
    await page.waitForTimeout(200);
    check(!(await page.$eval("#aca-panel-team", (n) => n.classList.contains("active"))), "Team page not reachable by URL");
    await page.keyboard.press("Control+k");
    await page.fill("#aca-gsInput", "or");
    await page.waitForTimeout(250);
    const gs = await page.textContent("#aca-gsList");
    check(!gs.includes("Organizations") && !gs.includes("Outbox"), "Cmd-K hides pages they can't see");
    await page.keyboard.press("Escape");
    await page.click('#aca-nav button[data-tab="schedule"]');
    await page.waitForSelector("#aca-scGrid .scc-card");
    check(!(await shown(page, '#aca-panel-schedule [data-v="add"]')) && await visible(page, "#aca-viewOnly"), "schedule is view-only for them");
    await page.click("#aca-scGrid .scc-card.scc-job");
    check(await page.isVisible(".sc-modal") && !(await page.$(".sc-modal [data-m=save]")), "a bar opens its details, not an editor");
    await page.click('.sc-modal [data-m="ok"]');
    check(await visible(page, '#aca-panel-schedule [data-v="addflex"]'), "staff: Add flex time shown");
    await page.click("#aca-scGrid .scc-card.scc-flex");
    await page.waitForSelector("#aca-scT");
    check((await page.$$('.sc-modal input[name="aca-scK"]')).length === 1 && (await page.$$("#aca-scP option")).length === 1 && await page.isVisible('.sc-modal [data-m="remove"]'), "staff: their flex bar opens an editor limited to flex time for themselves");
    await page.evaluate(() => { const s = document.getElementById("aca-scS"), e = document.getElementById("aca-scE"); s.value = "13:00"; e.value = "15:00"; s.dispatchEvent(new Event("change", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    const f = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").pop()[1].p);
    check(f.kind === "flex" && f.user_id === "u2" && f.id === "se6", "staff: moves their flex time: " + JSON.stringify(f));
    await page.click("#aca-scGrid .scc-card.scc-off");
    check(await page.isVisible(".sc-modal") && !(await page.$(".sc-modal [data-m=save]")), "staff: someone else's time off is read only");
    await page.click('.sc-modal [data-m="ok"]');
    await page.click('#aca-nav button[data-tab="myday"]');
    await page.waitForSelector("#aca-asBody .as-task");
    check(!(await shown(page, "#aca-asWhoWrap")), "my day: only their own");
    await page.waitForSelector("#aca-asMailMine");
    await page.waitForTimeout(100);
    await page.click("#aca-asMailMine");
    await page.waitForTimeout(100);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "day_email_mine" && c[1].p_on === false)), "my day: they can switch their morning email off");
    await page.click('#aca-pagetabs button[data-tab="tasks"]');
    await page.waitForTimeout(200);
    check(!(await shown(page, "#aca-asAdd")) && !(await shown(page, "#aca-asSetCard")), "tasks: no add, no settings");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Open jobs (part-timer)");
  {
    const { page, errors } = await open(browser, port, "?as=parttime");
    const items = await rail(page);
    check(JSON.stringify(items) === JSON.stringify(["today", "myday"]), "menu: Today and My day (with Open jobs): " + items.join(","));
    check((await page.textContent("#aca-panel-today")).includes("offered to you"), "Today says a job is waiting");
    await page.click('#aca-nav button[data-tab="myday"]');
    await page.click('#aca-pagetabs button[data-tab="openjobs"]');
    await page.waitForSelector("#aca-ojMine .oj-card");
    check(!(await visible(page, "#aca-viewOnly")), "no view-only notice");
    check(!(await visible(page, "#aca-ojOffer")) && !(await visible(page, "#aca-ojPosted")), "no manager controls");
    check((await page.$$("#aca-ojMine [data-take]")).length === 1 && (await page.$$("#aca-ojMine [data-pass]")).length === 1, "open offer has Take it + Pass; filled one has neither");
    check((await page.textContent("#aca-ojMine")).includes("35 min drive") && (await page.textContent("#aca-ojMine")).includes("You said: Busy"), "shows drive and past answer");
    await page.click('#aca-ojMine [data-pass="of1"]');
    await page.fill("#aca-ojReason", "Too far");
    await page.click('.modal [data-m="pass"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "openjobs_answer" && c[1].p_offer === "of1" && c[1].p_accept === false && c[1].p_reason === "Too far")), "Pass sends the reason");
    await page.click('#aca-ojMine [data-take="of1"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "openjobs_answer" && c[1].p_offer === "of1" && c[1].p_accept === true)), "Take it");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Partner follow-through (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#partners/rebook");
    check(await page.$eval("#aca-panel-rebook", (n) => n.classList.contains("active")), "#partners/rebook opens Rebooking");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "partner_rebook_attention") && window.__rpcCalls.some((c) => c[0] === "agreements_attention")), "Today asks about rebooking and agreements");
    await page.waitForSelector("#aca-pfRbBody .pf-item[data-org]");
    check((await page.textContent("#aca-pfRbBody")).includes("Brewer Travel") && !(await page.textContent("#aca-pfRbBody")).includes("Hancock"), "Time to rebook shows the due client only");
    check((await page.textContent("#aca-pfRbBody")).includes("Agreement renews"), "shows the agreement renewal date");
    await page.click('#aca-pfRbChips button[data-k="soon"]');
    check((await page.textContent("#aca-pfRbBody")).includes("Hancock"), "Coming up shows the later one");
    await page.click('#aca-pfRbChips button[data-k="now"]');
    await page.click('#aca-pfRbBody [data-do="draft"]');
    await page.waitForSelector("#aca-pfCmSubj");
    check(await page.$eval("#aca-pfCmSubj", (n) => n.value) === "Brewer Travel Basketball Club 2027", "rebook email is filled in");
    check(await page.$eval("#aca-pfCmTo", (n) => n.options.length) === 2, "both contacts offered");
    await page.click("#aca-pfCmHold");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "partner_queue" && c[1].p_kind === "rebook" && c[1].p_contact === "c1" && c[1].p_approve === false)), "Hold for review queues it unapproved");
    await page.click('#aca-pfRbBody [data-do="draft"]');
    await page.waitForSelector("#aca-pfCmNow");
    check((await page.$$eval(".modal-actions button", (bs) => bs.map((b) => b.textContent.trim()))).join("|").includes("Add to queue|Send now"), "rebook email offers Add to queue and Send now");
    await page.click("#aca-pfCmNow");
    await page.waitForFunction(() => window.__rpcCalls.some((c) => c[0] === "prospect_send_now"));
    check(await page.evaluate(() => { const q = window.__rpcCalls.filter((c) => c[0] === "partner_queue").pop(); const n = window.__rpcCalls.filter((c) => c[0] === "prospect_send_now").pop(); return q[1].p_approve === true && n[1].p_ids[0] === "m10"; }), "Send now approves it and sends that email right away");

    await page.evaluate(() => { location.hash = "#partners/reviews"; });
    await page.waitForSelector('#aca-pfRvBody .pf-item[data-id="rv2"]');
    check((await page.textContent('#aca-pfRvBody .pf-item[data-id="rv1"]')).includes("Waiting for your review"), "a drafted request shows it waits for review");
    check(!!(await page.$('#aca-pfRvBody .pf-item[data-id="rv2"] [data-do="draft"]')), "a track-only job can be drafted by hand");
    await page.click('#aca-pfRvBody .pf-item[data-id="rv1"] [data-do="log"]');
    await page.waitForSelector("#aca-pfRvOut");
    await page.selectOption("#aca-pfRvOut", "quote");
    await page.fill("#aca-pfRvQuote", "Smoothest picture day ever.");
    await page.fill("#aca-pfRvBy", "Chris, president");
    await page.click("#aca-pfRvSaveBtn");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "partner_review_log" && c[1].p_outcome === "quote" && c[1].p_save_quote === true && c[1].p_quote === "Smoothest picture day ever.")), "logs a quote and saves it to the library");

    await page.evaluate(() => { location.hash = "#partners/agreements"; });
    await page.waitForSelector('#aca-pfAgBody .pf-item[data-id="ag1"]');
    check((await page.textContent("#aca-pfAgBody")).includes("Requested") && (await page.textContent("#aca-pfAgBody")).includes("Expires"), "list shows W-9 and insurance");
    await page.click('#aca-pfAgBody .pf-item[data-id="ag1"] > div:nth-child(2)');
    await page.waitForSelector("#aca-pfAgTitle");
    await page.fill("#aca-pfAgPrice", "Packages from $29.");
    await page.click("#aca-pfAgSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "agreement_save" && c[1].p_id === "ag1" && c[1].p.pricing === "Packages from $29." && c[1].p.coi_path === "ag1/coi-1.pdf")), "saves the agreement and keeps the file");
    await page.click("#aca-pfAgNew");
    await page.waitForSelector('#aca-pfAgPick button[data-org]');
    await page.click('#aca-pfAgPick button[data-org]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "agreement_save" && c[1].p_id === null && c[1].p.org_id === "11111111-1111-1111-1111-111111111111")), "New agreement starts one for the picked org");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Open jobs (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#staff/openjobs");
    await page.waitForSelector("#aca-ojPosted .oj-card");
    check(await visible(page, "#aca-ojOffer") && (await page.textContent("#aca-ojOffer")).includes("Ask who"), "Ask who's available shown");
    const posted = await page.textContent("#aca-ojPosted");
    check(posted.includes("Available") && posted.includes("Can\u2019t make it") && posted.includes("Out of town") && posted.includes("No notifications on"), "answers + reasons shown");
    await page.click('#aca-ojPosted [data-pick="u6"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "openjobs_pick" && c[1].p_offer === "of1" && c[1].p_user === "u6")), "the manager picks who gets it");
    await page.click("#aca-ojOffer");
    await page.waitForSelector('#aca-ojJob option[value="bk2"]', { state: "attached" });
    await page.selectOption("#aca-ojJob", "bk2");
    await page.waitForSelector("#aca-ojCands .oj-cand");
    check(await page.evaluate(() => (window.__offerDriveCalls || []).some((c) => c.booking_id === "bk2")), "asks for drive times");
    const ticked = await page.$$eval(".oj-cand:checked", (xs) => xs.map((x) => x.value));
    check(JSON.stringify(ticked) === JSON.stringify(["u6"]), "only in-range, free part-timers start ticked: " + ticked.join(","));
    check(await page.$eval('.oj-cand[value="u9"]', (x) => x.disabled), "no-access person can't be picked");
    await page.check('.oj-cand[value="u8"]');
    await page.selectOption("#aca-ojSpots", "2");
    await page.fill("#aca-ojPay", "$200");
    await page.click('.modal [data-m="send"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "openjobs_post" && c[1].p.booking_id === "bk2" && c[1].p.spots === 2 && c[1].p.pay === "$200" && c[1].p.user_ids.join() === "u6,u8")), "sends the offer");
    check(!(await page.$(".modal")), "dialog closes");
    // ws/settings: Part-timers & 1099 is read-only; Edit opens the person's Team record
    await page.click("#aca-ojPeople");
    await page.waitForSelector(".oj-ppl tr[data-u]");
    check(!(await page.$(".oj-ppl select, .oj-ppl input")), "part-timers list is read-only");
    await page.click('.oj-ppl tr[data-u="u6"] [data-editp]');
    await page.waitForSelector("#aca-tmDrive");
    check(await page.$eval("#aca-panel-team", (n) => n.classList.contains("active")) && (await page.inputValue("#aca-tmName")) === "Pat Parttime", "Edit opens their Team record");
    await page.fill("#aca-tmDrive", "45");
    await page.click("#aca-tmSave");
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "team_set_max_drive" && c[1].p_user_id === "u6" && c[1].p_min === 45)), "longest drive saves from the Team record");
    await page.evaluate(() => { location.hash = "#staff/openjobs"; });
    await page.waitForSelector("#aca-ojPosted .oj-card");
    check(await page.$eval("#aca-ojPostedSec", (n) => !!n.nextElementSibling && n.nextElementSibling.id === "aca-ojMineSec"), "B10: offers you sent come first");
    check((await page.textContent("#aca-ojPosted")).includes("Email them instead"), "B11: no notifications offers an email instead");
    await page.close();
    const p2 = await open(browser, port, "", "#staff/openjobs/bk1");
    await p2.page.waitForSelector("#aca-ojCands .oj-cand");
    check(await p2.page.$eval("#aca-ojJob", (s) => s.value) === "bk1", "#staff/openjobs/<booking> opens the offer on that job");
    check(errors.length === 0 && p2.errors.length === 0, "no page errors" + (errors.concat(p2.errors).length ? ": " + errors.concat(p2.errors).join(" | ") : ""));
    await p2.page.close();
  }
  console.log("Public agreement page (no sign-in)");
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#agree/a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2`);
    await page.waitForSelector("#aca-agName");
    check((await page.textContent("#aca-agBody")).includes("between 207 Photo and Brewer Travel"), "shows the agreement text");
    check(!(await page.isVisible("#aca-loginView")) && !(await page.$("#aca-nav button[data-tab]")), "no sign-in, no menu");
    await page.fill("#aca-agName", "Chris Snowdeal");
    await page.click("#aca-agGo");
    await page.waitForTimeout(100);
    check(!(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "agreement_accept"))), "must tick the box first");
    await page.check("#aca-agOk");
    await page.click("#aca-agGo");
    await page.waitForSelector(".ag-done");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "agreement_accept" && c[1].p_token === "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2" && c[1].p_name === "Chris Snowdeal")), "accepts with the typed name");
    check((await page.textContent(".ag-done")).includes("Chris Snowdeal"), "says who accepted");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "fits a phone screen");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Settings > Sending: picture day phone and rain plan (ws/director)");
  {
    const { page, errors } = await open(browser, port, "");
    await page.click('#aca-nav button[data-tab="sending"]');
    await page.waitForSelector("#aca-ssDayPhone");
    check(await page.$eval("#aca-ssDayPhone", (n) => n.value) === "(207) 558-3185" && (await page.$eval("#aca-ssWeather", (n) => n.value)).includes("backup date"), "shows the picture day phone and the rain plan");
    await page.fill("#aca-ssDayPhone", "(207) 555-0100");
    await page.click("#aca-ssSave");
    await page.waitForTimeout(200);
    check(await page.evaluate(() => (window.__writes || []).some((w) => w[0] === "booking_settings" && w[1] === "update" && w[2].day_of_phone === "(207) 555-0100" && "weather_plan" in w[2])), "saves them with the booking sender settings");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Your picture day page (no sign-in, ws/director)");
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#day/d1a2b3c4d5e6f708192a3b4c5d6e7f8091a2`);
    await page.waitForSelector("#aca-dayPublic .dyp-when");
    const txt = await page.textContent("#aca-dayPublic");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "booking_public" && c[1].p_token === "d1a2b3c4d5e6f708192a3b4c5d6e7f8091a2")), "asks for this token only");
    check(txt.includes("Brewer Travel Basketball Club") && txt.includes("5:00 PM to 7:00 PM") && txt.includes("Brewer Auditorium"), "shows the partner, the time and the place");
    check(txt.includes("We arrive by 4:30 PM") && txt.includes("(207) 558-3185") && txt.includes("on-site contact"), "day-of: arrival, phone, on-site contact ask");
    check(txt.includes("5:15 U10 Red") && txt.includes("If the weather looks bad"), "team times and the rain plan");
    check(txt.includes("Picture day emergency") && txt.includes("(207) 299-3928") && txt.includes("calling more than twice"), "the emergency contact, with how to ring through");
    check(txt.includes("How it works for families") && txt.includes("no order forms") && txt.includes("10% of online sales"), "families block and the program's terms");
    check(await page.$eval('#aca-dayPublic a[href="https://www.dropbox.com/sh/x"]', (a) => !!a) && txt.includes("Coach banner"), "delivered files link out, the rest are listed as coming");
    check(await page.$eval("#aca-dyCal", (a) => a.href.includes("/functions/v1/booking-ics?t=d1a2b3c4d5e6f708192a3b4c5d6e7f8091a2")), "Add to your calendar downloads the .ics");
    check(await page.$eval('#aca-dayPublic a[href*="#agree/"]', (a) => a.textContent.includes("accept")), "agreement link and status");
    check(!(await page.isVisible("#aca-loginView")) && !(await page.$("#aca-nav button[data-tab]")) && !(await page.$("#aca-dayPublic input, #aca-dayPublic textarea, #aca-dayPublic form")), "no sign-in, no menu, no forms");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "fits a phone screen");
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?daycancel=1#day/d1a2b3c4d5e6f708192a3b4c5d6e7f8091a2`);
    await page.waitForSelector("#aca-dayPublic .dyp-note");
    check((await page.textContent("#aca-dayPublic")).includes("was cancelled"), "a cancelled booking says so");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  // ws/agreement (2026-10-24)
  console.log("Agreement builder (school agreements)");
  {
    const { page, errors } = await open(browser, port, "", "#partners/agreements");
    await page.waitForSelector('#aca-pfAgBody .pf-item[data-id="ag2"]');
    check(await page.$('#aca-pfAgBody .pf-item[data-id="ag2"] [data-do="builder"]') && !(await page.$('#aca-pfAgBody .pf-item[data-id="ag1"] [data-do="builder"]')), "Edit in builder only on builder agreements");
    await page.click("#aca-pfAgNew");
    await page.waitForSelector('#aca-pfAgPick button[data-aud="school"]');
    check((await page.textContent(".modal")).includes("Schools open the agreement builder"), "picker says schools open the builder");
    await page.click('#aca-pfAgPick button[data-aud="school"]');
    await page.waitForSelector("#aca-abForm");
    const prev = () => page.textContent("#aca-abPrev");
    let p = await prev();
    check(p.includes("SCHOOL PHOTOGRAPHY SERVICE AGREEMENT") && p.includes("Hancock Grammar School") && p.includes("Pat Lee") && p.includes("Principal"), "preview prefilled with the school and main contact");
    check(p.includes("8. EXCLUSIVITY") && p.includes("12. SIGNATURES") && !p.includes("FUNDRAISING"), "default choices: Exclusivity is section 8");
    check(p.includes("$75 per hour") && p.includes("$10,000") && p.includes("Penobscot County"), "standard terms fill in");
    check(await page.$eval('[data-val="CONTACT_PHONE"]', (n) => n.value) === "207-555-0144" && await page.$eval('[data-val="FALL"]', (n) => !!n.value) && await page.$eval('[data-val="RETAKE"]', (n) => !!n.value), "contact phone, picture day and retake day from the job");
    check(!(await page.$eval("#aca-abStd", (n) => n.open)) && (await page.textContent("#aca-abStd summary")).includes("Using our standard terms"), "standard terms start collapsed");
    await page.uncheck('[data-on="STAFF_PORTRAITS"]');
    await page.check('[data-on="REBATE_PCT"]');
    await page.fill('[data-val="REBATE_PCT"]', "10");
    await page.waitForTimeout(250);
    p = await prev();
    check(!p.includes("Individual digital staff portraits"), "an unticked service disappears");
    check(p.includes("8. FUNDRAISING AND REBATE") && p.includes("9. EXCLUSIVITY") && p.includes("10 percent of net sales"), "a rebate adds section 8 and renumbers");
    check((await page.textContent("#aca-abApplyTxt")).includes("set this partner\u2019s payout to 10% of sales") && await page.$eval("#aca-abApply", (n) => n.checked), "Apply to jobs and payout terms is on and says what it does");
    await page.click("#aca-abView");
    await page.waitForSelector(".ag-text.ab-doc");
    check((await page.textContent(".ag-text.ab-doc")).includes("9. EXCLUSIVITY"), "Preview as the school sees it");
    await page.click("#aca-abVClose");
    await page.click("#aca-abSend");
    await page.waitForSelector("#aca-pfCmSubj");
    const sv = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "agreement_builder_save").pop());
    check(sv && sv[1].p_id === null && sv[1].p_org === "22222222-2222-2222-2222-222222222222" && sv[1].p_builder.on.REBATE_PCT === true && !sv[1].p_builder.on.STAFF_PORTRAITS &&
          sv[1].p_html.includes('class="ab-sec"') && sv[1].p_text.includes("8. FUNDRAISING AND REBATE") && sv[1].p.title === "School Photography Service Agreement 2026-2027" && sv[1].p.booking_id === "bk2", "Send saves the choices, HTML and text");
    const ap = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "agreement_builder_apply").pop());
    check(ap && ap[1].p_id === "ag9" && ap[1].p_deliverables.includes("Yearbook files") && !ap[1].p_deliverables.includes("Staff portraits"), "then applies the ticked deliverables to the jobs");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "partner_compose" && c[1].p_kind === "agreement" && c[1].p_ref === "ag9")), "then the usual agreement email (held or approved)");
    await page.click("#aca-pfCmCancel");
    // Edit an existing one: its saved choices come back.
    await page.click('#aca-pfAgBody .pf-item[data-id="ag2"] [data-do="builder"]');
    await page.waitForSelector("#aca-abForm");
    check(await page.$eval('[data-val="BUILDINGS"]', (n) => n.value) === "Main building" && await page.$eval('[data-val="RATIO"]', (n) => n.value) === "250" &&
          !(await page.$eval('[data-on="RETAKE"]', (n) => n.checked)), "Edit in builder brings back the saved choices");
    check((await page.textContent("#aca-abStd summary")).includes("Changed for this school: Photographers"), "says which standard terms were changed");
    await page.click("#aca-abSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "agreement_builder_save" && c[1].p_id === "ag2")) && !(await page.$("#aca-abForm")), "Save draft keeps it a draft");
    // Phone
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click("#aca-pfAgNew");
    await page.waitForSelector('#aca-pfAgPick button[data-aud="school"]');
    await page.click('#aca-pfAgPick button[data-aud="school"]');
    await page.waitForSelector("#aca-abForm");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector(".ab-modal").scrollWidth <= document.querySelector(".ab-modal").clientWidth + 1), "builder fits a phone (form above the preview)");
    check(await page.evaluate(() => document.querySelector("#aca-abPrev").getBoundingClientRect().top > document.querySelector("#aca-abForm").getBoundingClientRect().bottom - 1), "on a phone the preview is under the form");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Public agreement page: a builder agreement");
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#agree/b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2`);
    await page.waitForSelector("#aca-agName");
    check(await page.$eval("#aca-agBody h2.ab-sec", (n) => n.textContent) === "8. EXCLUSIVITY" && await page.$eval("#aca-agBody h2.ab-sec", (n) => getComputedStyle(n).color) === "rgb(225, 98, 57)", "shows the agreement as built, orange headings");
    check(await page.evaluate(() => window.__pwn === undefined && !document.querySelector(".ag-text script, .ag-text img, .ag-text a, .ag-text [style], .ag-text .evil, .ag-text [onerror]")), "only the builder's markup survives");
    check((await page.textContent("#aca-agBody")).includes("link text"), "text of dropped tags is kept");
    await page.fill("#aca-agName", "Pat Lee");
    await page.fill("#aca-agEmail", "pat@nowhere");
    await page.check("#aca-agOk");
    await page.click("#aca-agGo");
    await page.waitForTimeout(100);
    check(!(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "agreement_accept"))), "a bad email is caught before accepting");
    await page.fill("#aca-agEmail", "plee@hancock.k12.me.us");
    await page.click("#aca-agGo");
    await page.waitForSelector(".ag-done");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "agreement_accept" && c[1].p_email === "plee@hancock.k12.me.us" && c[1].p_name === "Pat Lee")), "accepts with the email for their copy");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "fits a phone screen");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Time clock: staff on a phone");
  {
    const { page, errors } = await open(browser, port, "?as=staff", "#staff/clock");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForSelector("#aca-tcBody .tc-pick button");
    check(await page.$eval("#aca-panel-clock", (n) => n.classList.contains("active")), "#staff/clock opens the clock");
    check(!(await visible(page, "#aca-viewOnly")), "clock: no view-only notice for staff");
    check((await page.textContent("#aca-tcBody .tc-pick button.mine")).includes("Hampden Academy"), "their scheduled job is listed first and marked");
    check((await page.textContent("#aca-tcBody")).includes("Your location is saved"), "says the location is saved");
    check((await page.textContent("#aca-tcBody")).includes("stopped at midnight"), "says a clock was stopped at midnight");
    await page.context().grantPermissions(["geolocation"]);
    await page.context().setGeolocation({ latitude: 44.7449, longitude: -68.837, accuracy: 15 });
    await page.fill("#aca-tcNote", "Running late");
    await page.click("#aca-tcBody .tc-pick button.mine");
    await page.waitForTimeout(400);
    const ci = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "timeclock_in").pop());
    check(ci && ci[1].p_kind === "job" && ci[1].p_booking === "bk1" && ci[1].p_note === "Running late", "clocks in to the job: " + JSON.stringify(ci && ci[1]));
    check(ci && ci[1].p_loc && ci[1].p_loc.lat === 44.7449 && ci[1].p_loc.acc === 15, "with the phone's location");
    await page.click('#aca-tcBody [data-in="studio"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "timeclock_in" && c[1].p_kind === "studio" && c[1].p_booking === null)), "clocks in to Studio");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= 392), "clock: no sideways scroll on a phone");
    await page.click('#aca-pagetabs button[data-tab="timesheets"]');
    await page.waitForSelector("#aca-tsBody .tc-person");
    check(!(await shown(page, "#aca-tsWhoWrap")) && !(await shown(page, '#aca-panel-timesheets [data-w="payroll"]')), "timesheets: their own only, no payroll");
    check((await page.textContent("#aca-tsBody")).includes("Approved"), "approved week shows approved");
    check(!(await page.$("#aca-tsBody [data-approve]")), "no approve button for staff");
    await page.click('#aca-panel-timesheets [data-w="add"]');
    await page.waitForSelector(".tc-modal");
    check(!(await page.$("#aca-tpP")), "add time: no person picker for staff");
    await page.click('.tc-modal input[name="aca-tpK"][value="admin"]', { force: true });
    await page.click('.tc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    const ps = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "timepunch_save").pop());
    check(ps && ps[1].p.kind === "admin" && ps[1].p.clock_in && ps[1].p.clock_out && ps[1].p.user_id === "u2", "adds their own forgotten time: " + JSON.stringify(ps && ps[1].p));
    await page.click('#aca-pagetabs button[data-tab="mileage"]');
    await page.waitForSelector("#aca-miBody table");
    check(!(await shown(page, "#aca-miWhoWrap")), "mileage: their own only");
    await page.waitForTimeout(300);
    check(await page.evaluate(() => (window.__driveCalls || []).some((b) => b.booking_id === "bk3")), "a trip without miles is looked up on Google");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "mileage_refresh")), "and filled in");
    await page.click('#aca-panel-mileage [data-v="add"]');
    await page.waitForSelector(".tc-modal");
    await page.fill("#aca-mtM", "8");
    await page.click('.tc-modal [data-m="save"]');
    await page.waitForTimeout(100);
    check(await page.isVisible(".tc-modal .tc-merr") && !(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "mileage_save"))), "a trip without a job needs a note");
    await page.fill("#aca-mtN", "Bank deposit");
    await page.click('.tc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "mileage_save" && c[1].p.miles === "8" && c[1].p.note === "Bank deposit")), "adds a trip by hand");
    await page.click('#aca-pagetabs button[data-tab="expenses"]');
    await page.waitForSelector("#aca-txBody table");
    check(!(await shown(page, "#aca-txWhoWrap")) && !(await page.$("#aca-txBody [data-ok]")), "expenses: their own, no approve buttons");
    check((await page.textContent("#aca-txBody")).includes("Need the receipt"), "a sent-back expense shows why");
    await page.click('#aca-panel-expenses [data-x="add"]');
    await page.waitForSelector("#aca-txA");
    await page.setInputFiles("#aca-txPhoto input[type=file]", path.join(ROOT, "logo.png"));
    await page.waitForSelector("#aca-txPhoto img");
    await page.fill("#aca-txA", "23.40");
    await page.selectOption("#aca-txC", "parking");
    await page.fill("#aca-txN", "Bangor garage");
    await page.click('.tc-modal [data-m="save"]');
    await page.waitForTimeout(300);
    const xs = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "expense_save").pop());
    const up = await page.evaluate(() => (window.__writes || []).filter((w) => w[0] === "storage" && w[1] === "upload").pop());
    check(up && /^u2\//.test(up[2]) && xs && xs[1].p.receipt_path === up[2] && xs[1].p.amount === "23.40" && xs[1].p.category === "parking", "adds an expense with the receipt in their folder: " + JSON.stringify(xs && xs[1].p));
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Time clock: owner");
  {
    const { page, errors } = await open(browser, port, "?clockedin=1", "#today");
    await page.waitForSelector("#aca-todayClock [data-tc]");
    check((await page.textContent("#aca-todayClock")).includes("Hampden Academy"), "Today shows what they are clocked in to");
    await page.click('#aca-todayClock [data-tc="out"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "timeclock_out")), "Clock out from Today");
    check((await page.textContent("#aca-todayList")).includes("timesheet from last week"), "Today: last week's timesheet waits for approval");
    await page.click('#aca-nav button[data-tab="timepay"]');
    await page.waitForSelector("#aca-tcTimer");
    check(await page.isVisible('#aca-tcBody [data-c="out"]'), "clocked in: big Clock out button");
    await page.click('#aca-tcBody [data-c="switch"]');
    check(await page.isVisible("#aca-tcBody .tc-pick"), "Switch shows what to switch to");
    await page.click('#aca-pagetabs button[data-tab="timesheets"]');
    // ws/settings: under Team > Time & pay, Timesheets opens on Everyone
    await page.waitForSelector("#aca-tsBody tr.tc-row");
    check(await page.$eval("#aca-tsWho", (n) => n.value) === "all", "timesheets open on Everyone for Edit");
    check((await page.$$("#aca-tsBody tr.tc-row")).length === 2, "everyone: one row per person");
    check(!(await page.textContent("#aca-tsBody thead")).includes("Scheduled"), "everyone: no Scheduled column");
    check(!!(await page.$('#aca-tsBody td.tc-act [data-approve="u1"][data-on="1"]')), "shows who is not approved, with Approve in the status cell");
    check(await page.$$eval("#aca-tsBody [data-approve]", (bs) => bs.every((b) => b.getBoundingClientRect().right <= document.documentElement.clientWidth)), "Approve / Unapprove not clipped at 1280");
    await page.click('#aca-tsBody [data-approve="u1"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "timesheet_approve" && c[1].p_user === "u1" && c[1].p_approve === true)), "approves a week");
    await page.click('#aca-tsBody tr.tc-row[data-person="u2"] td.name');
    await page.waitForSelector('#aca-tsBody [data-punch="tp3"]');
    check((await page.textContent('#aca-tsBody [data-punch="tp3"]')).includes("edited"), "a typed-in punch is marked edited");
    await page.click('#aca-panel-timesheets [data-w="payroll"]');
    await page.waitForSelector('.tc-modal [data-m="csv"]:not([disabled])');
    check((await page.textContent(".tc-modal")).includes("Not approved yet: Jeremiah M."), "payroll warns about unapproved weeks");
    check(await page.$eval("#aca-prE", (n) => n.selectedOptions[0].textContent.includes("last week")), "payroll: its own period, last finished week by default");
    check(await page.evaluate(() => { const c = window.__rpcCalls.filter((x) => x[0] === "timesheet_payroll").pop(); return c && c[1].p_weeks === 1; }), "payroll loads one week");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click('.tc-modal [data-m="csv"]')]);
    const csv = fs.readFileSync(await dl.path(), "utf8");
    check(/^Name,Email,Type,Period start,Period end,Regular hours,Overtime hours,Total hours,Miles,Mileage pay,Expenses,Est\. wages,Est\. total,Weeks approved\r\nJeremiah Mutty,jmutty@207photo.com,Full time,.*,40\.00,3\.50,43\.50,26\.1,18\.27,12\.75,1078\.75,1109\.77,0 of 1\r\n/.test(csv), "payroll CSV: " + csv.split("\r\n")[1]);
    check(!csv.includes("Riley"), "1099 contractor left out of the payroll CSV");
    check((await page.textContent(".tc-modal")).includes("1099 contractors"), "contractors listed separately");
    const [dlc] = await Promise.all([page.waitForEvent("download"), page.click('.tc-modal [data-m="cont"]')]);
    const csvc = fs.readFileSync(await dlc.path(), "utf8");
    check(/^Name,Email,Job title,Period start,Period end,Hours,Miles,Mileage pay,Expenses,Est\. fees,Est\. total,Weeks approved\r\nRiley Second,riley@example\.com,Second shooter,.*,5\.00,40\.0,28\.00,0\.00,,,1 of 1\r\n$/.test(csvc), "1099 CSV: " + csvc.split("\r\n")[1]);
    await page.click('.tc-modal [data-m="approveall"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "timesheet_approve" && c[1].p_user === "u1" && c[1].p_week === document.querySelector("#aca-prE").value)), "payroll: Approve all approves the period");
    await page.click('.tc-modal [data-m="cancel"]');
    await page.click('#aca-panel-timesheets [data-w="settings"]');
    await page.waitForSelector("#aca-tsR");
    await page.fill("#aca-tsR", "0.725");
    await page.click('.tc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "timeclock_settings_save" && c[1].p_rate === 0.725 && c[1].p_overtime === 40)), "changes the mileage rate");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "timeclock_settings_save" && c[1].p.gps_on === true && c[1].p.remind_before_min === 15 && c[1].p.ot_warn_hours === 4)), "and keeps the reminder / location / overtime settings");
    await page.click('#aca-panel-timesheets [data-w="rates"]');
    await page.waitForSelector("#aca-prtBody table");
    check((await page.textContent("#aca-prtBody")).includes("$200.00 a day, $120.00 a half day"), "pay rates: day and half-day rate shown");
    await page.click('.tc-modal [data-m="add"]');
    await page.waitForSelector("#aca-prtR");
    await page.selectOption("#aca-prtS", "title");
    await page.fill("#aca-prtK", "Second shooter");
    await page.fill("#aca-prtR", "30");
    await page.click('.modal-wrap:last-child [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "timeclock_rate_save" && c[1].p.scope === "title" && c[1].p.scope_key === "Second shooter" && c[1].p.rate === "30" && c[1].p.basis === "hourly")), "adds a rate for a job title");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.click('#aca-pagetabs button[data-tab="expenses"]');
    await page.waitForSelector('#aca-txBody [data-ok="x1"]');
    await page.click('#aca-txBody [data-ok="x1"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "expense_review" && c[1].p_id === "x1" && c[1].p_status === "approved")), "approves an expense");
    await page.click('#aca-pagetabs button[data-tab="mileage"]');
    await page.waitForSelector("#aca-miBody table");
    await page.click('#aca-panel-mileage [data-v="sched"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "mileage_from_schedule")), "Add from schedule");
    const [dl2] = await Promise.all([page.waitForEvent("download"), page.click('#aca-panel-mileage [data-v="csv"]')]);
    const mcsv = fs.readFileSync(await dl2.path(), "utf8");
    check(mcsv.startsWith("Date,Name,Job or where,Address,Miles,Amount,Note,Source") && mcsv.includes("26.1,18.27"), "mileage CSV");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Settings tabs (owner, ws/settings)");
  {
    const { page, errors } = await open(browser, port, "", "#system/teamemails");
    await page.waitForSelector("#aca-stTopics select[data-deftopic]");
    check((await page.textContent("#aca-stDaily")).includes("8pm") && (await page.textContent("#aca-stDaily")).includes("7am"), "Team emails: your-day notification and morning email");
    check((await page.textContent("#aca-stCrew")).includes("Fridays at 3pm"), "Team emails: weekly schedule email in 12-hour time");
    check((await page.textContent("#aca-stClock")).includes("15 minutes before"), "Team emails: clock reminders");
    check((await page.$$("#aca-stTopics select[data-deftopic]")).length === 4 && (await page.textContent("#aca-stTopics")).includes("account menu"), "Team emails: every notification kind with its default; each person can change theirs");
    await page.selectOption('#aca-stTopics select[data-deftopic="crew_ask"]', "email");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "push_topic_set_default" && c[1].p_topic === "crew_ask" && c[1].p_mode === "email")), "changes a notification default");
    check(await page.isChecked("#aca-stDgOn") && (await page.textContent("#aca-stDgTo")).includes("test@207photo.com"), "morning digest moved here");
    await page.click('#aca-stCrew [data-st="crew"]');
    await page.waitForSelector("#aca-scWkH");
    check(!(await page.$("#aca-scRoles")) && (await page.$eval("#aca-scWkH", (n) => n.selectedOptions[0].textContent)) === "3pm", "the Schedule's crew dialog, emails half, 12-hour times");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "crew_settings_save" && c[1].p.week_email_hour === 15)), "saves through crew_settings_save");
    await page.click('#aca-stDaily [data-st="daily"]');
    await page.waitForSelector("#aca-asPlanHour");
    await page.selectOption("#aca-asMailHour", "6");
    await page.click('.as-modal [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "day_email_settings_save" && c[1].p_hour === 6)), "morning email hour saves from Settings");
    // Job types
    await page.click('#aca-pagetabs button[data-tab="jobtypes"], #aca-nav button[data-tab="jobtypes"]').catch(() => page.evaluate(() => { location.hash = "#system/jobtypes"; }));
    await page.evaluate(() => { location.hash = "#system/jobtypes"; });
    await page.waitForSelector("#aca-stJt-sports_data");
    const jtx = await page.textContent("#aca-stJt-sports_data");
    check(jtx.includes("Picture day done") && jtx.includes("Team composites") && jtx.includes("Sports with data"), "a job type card: stages, deliverables, its booking emails");
    check(!!(await page.$("#aca-stJt-all")) && !!(await page.$("#aca-stAuto")), "every-job-type card and the auto-track switch");
    check(jtx.includes("GotPhoto defaults") && jtx.includes("Sport (Other)") && (await page.textContent("#aca-stJt-school")).includes("K-12 School"), "GotPhoto defaults on each job type card");
    await page.click('#aca-stJt-sports_data [data-st="gpdef"]');
    await page.waitForFunction(() => { const s = document.querySelector("#aca-stGpprice_profile_id"); return s && [...s.options].some((o) => o.text === "Fall Sports 2026"); });
    check(true, "GotPhoto defaults lists the price profiles from GotPhoto");
    await page.selectOption("#aca-stGpprice_profile_id", "pp-fall");
    await page.selectOption("#aca-stGpprepay", "false");
    await page.selectOption("#aca-stGpaccess", "qr_tagging|qr_code_list");
    await page.click('.modal [data-m="save"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "gp_type_defaults_save" && c[1].p_type === "sports_data" && c[1].p.price_profile_id === "pp-fall" && c[1].p.labels.price_profile_id === "Fall Sports 2026" && c[1].p.prepay === "false")), "saves the GotPhoto defaults with the profile name");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "gp_type_defaults_save" && c[1].p.access_type === "qr_tagging" && c[1].p.password_source === "qr_code_list")), "Photo access for each person, with list of names saves both GotPhoto fields");
    await page.click('#aca-stJt-sports_data [data-st="stages"]');
    await page.waitForSelector('#aca-bkJtTypes button[aria-pressed="true"]');
    check(await page.$eval('#aca-bkJtTypes button[aria-pressed="true"]', (b) => b.dataset.jt) === "sports_data", "Stages & deliverables opens on that job type");
    await page.click('.bk-form [data-v="close"] >> visible=true');
    await page.click('#aca-stJtTop [data-st="addtype"]');
    await page.fill("#aca-stNtName", "Dance recital");
    await page.click('.modal [data-m="save"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "booking_type_add" && c[1].p_label === "Dance recital" && c[1].p_copy_from === "school")), "adds a job type from an existing one");
    // Team & pay
    await page.evaluate(() => { location.hash = "#system/teampay"; });
    await page.waitForSelector("#aca-stRoles .st-chips span");
    check((await page.textContent("#aca-stRoles")).includes("Second shooter") && (await page.textContent("#aca-stKinds")).includes("SafeSport"), "Team & pay: crew roles and kinds of clearance");
    check((await page.textContent("#aca-stRates")).includes("Part time") && (await page.textContent("#aca-stRules")).includes("Overtime after 40"), "Team & pay: pay rate defaults and time clock rules");
    await page.click('#aca-stKinds [data-st="kinds"]');
    await page.waitForSelector("#aca-srTypeList");
    check((await page.textContent(".sr-listh")).includes("Warn (days)"), "the same Kinds of clearance dialog, with a header row");
    await page.click("#aca-srTCancel");
    await page.click('#aca-stRoles [data-st="roles"]');
    await page.waitForSelector("#aca-scRoles li");
    check(!(await page.$("#aca-scWkH")), "crew roles open the roles half of the Schedule's dialog");
    await page.click('.sc-modal [data-m="cancel"]');
    // Company
    await page.evaluate(() => { location.hash = "#system/company"; });
    await page.waitForSelector("#aca-stStudio");
    check((await page.textContent("#aca-stStudio")).includes("not set") && await page.isVisible("#aca-syncNowBtn2") && await page.isVisible("#aca-mfaStatus"), "Company: studio, sync and sign-in security");
    await page.click('#aca-stStudio [data-st="studio"]');
    await page.waitForSelector("#aca-scAddr");
    await page.click('.sc-modal [data-m="cancel"]');
    await page.evaluate(() => { location.hash = "#system/health"; });
    await page.waitForTimeout(300);
    check(await page.$eval("#aca-panel-company", (n) => n.classList.contains("active")), "an old Sync link lands on Company");
    // Sending: switches save right away; the Outreach block; Send window
    await page.evaluate(() => { location.hash = "#system/sending"; });
    await page.waitForSelector('[data-sw="legacy"]');
    check(!(await page.textContent("#aca-panel-sending")).includes("Quiet hours") && (await page.textContent("#aca-panel-sending")).includes("Send window"), "Quiet hours is now Send window");
    check(!!(await page.$('[data-sw="otest"]')) && !!(await page.$('[data-sw="track"]')), "Outreach test mode and track opens live in Sending");
    await page.click('[data-sw="legacy"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => (window.__writes || []).some((w) => w[0] === "booking_settings" && w[1] === "update" && w[2].legacy_hub_reminders === false)), "a switch saves the moment it is flipped");
    // Email library: no second sending editor; partner emails
    await page.evaluate(() => { location.hash = "#system/library"; });
    await page.waitForSelector("#aca-bkLibPBody [data-ptpl]");
    check((await page.$$("#aca-bkLibPBody [data-ptpl]")).length === 3, "Partner emails: rebook, review request, agreement");
    await page.click('#aca-bkLibPBody [data-ptpl="review"]');
    await page.waitForSelector("#aca-pfTpLink");
    check(true, "opens the Partners review template dialog");
    await page.click("#aca-pfTpCancel");
    await page.click("#aca-bkLibSettings");
    await page.waitForTimeout(200);
    check(await page.$eval("#aca-panel-sending", (n) => n.classList.contains("active")) && !(await page.$("#aca-bsQ1")), "Sending settings button goes to Settings > Sending (no second dialog)");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Settings tabs on a phone (390px)");
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    for (const tab of ["teamemails", "jobtypes", "teampay", "company", "sending"]) {
      await page.goto(`http://127.0.0.1:${port}/test/harness.html#system/${tab}`);
      await page.waitForSelector("#aca-panel-" + tab + ".active .card, #aca-panel-" + tab + ".active .ss");
      await page.waitForTimeout(300);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), tab + ": no sideways scroll at 390px");
    }
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Schedule on a phone (390px, ws/settings)");
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#staff/schedule`);
    await page.waitForSelector("#aca-scGrid.sc-list .scl-day");
    check(await page.isChecked('input[name="aca-scView"][value="list"]') && (await page.$$("#aca-scGrid .scl-day")).length === 2, "a phone opens on the list: today and tomorrow");
    check((await page.$$("#aca-scGrid button.scl-item[data-entry]")).length > 0 && await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the list shows people's jobs and fits the phone");
    await page.click('input[name="aca-scView"][value="week"] + span');
    await page.waitForSelector("#aca-scGrid .scc-head");
    await page.waitForTimeout(200);
    check(!(await page.isVisible("#aca-panel-schedule .sc-legend")) && await page.isVisible('#aca-panel-schedule [data-v="key"]'), "B2: colors folded behind a button");
    check(await page.isVisible("#aca-scSwipe"), "B2: week view says to swipe for more days");
    await page.$eval("#aca-panel-schedule .sc-scroll", (n) => { n.scrollLeft = 200; n.dispatchEvent(new Event("scroll")); });
    await page.waitForTimeout(100);
    check(!(await page.isVisible("#aca-scSwipe")), "the hint goes once they swipe");
    await page.click('input[name="aca-scView"][value="month"] + span');
    await page.waitForSelector("#aca-scGrid .scm-day");
    await page.waitForTimeout(200);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1) && await page.$eval("#aca-scGrid .scm-chip", (n) => n.getBoundingClientRect().width < 12), "month fits a phone, jobs as colored dots");
    await page.click("#aca-scGrid .scm-day.today");
    await page.waitForSelector("#aca-scGrid.sc-list");
    check(await page.isChecked('input[name="aca-scView"][value="list"]'), "tapping a day in the month opens its list");
    await page.click('input[name="aca-scView"][value="weeks8"] + span');
    await page.waitForSelector("#aca-scWeeks .sc-w8row");
    await page.waitForTimeout(300);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1) && await page.isVisible("#aca-scPeak"), "8 weeks fits a phone, with busiest days");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Settings > Bounced (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#system/delivery");
    await page.waitForSelector("#aca-emBody tr.em-row");
    check(await page.$eval("#aca-pagetabs", (n) => n.textContent.includes("Email library") && n.textContent.includes("Bounced")), "an old link lands on Settings > Bounced");
    check(await page.evaluate(() => window.__rpcCalls.find((c) => c[0] === "email_list")[1].p_filter === "problems"), "starts on what bounced");
    check(!(await page.$('#aca-panel-delivery input[value="opened"]')) && !(await page.$('#aca-pagetabs button[data-tab="emailreport"]')), "no opens filter and no report");
    check((await page.$$("#aca-emBody tr.em-row")).length === 6, "every recorded email listed");
    check((await page.textContent("#aca-emBody")).includes("Invalid `to` field."), "a failure shows Resend's reason");
    check(await page.isVisible("#aca-emHandled"), "Mark all handled for Edit");
    await page.click('#aca-emBody tr.em-row[data-id="5"]');
    await page.waitForSelector(".modal iframe.em-frame");
    check(await page.$eval(".modal iframe.em-frame", (f) => f.getAttribute("sandbox") === "" && f.srcdoc.includes("makeup photos")), "the email as sent, in a sandboxed frame");
    await page.fill("#aca-emTo", "parent2@example.com");
    await page.click('.modal [data-m="resend"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "email_resend" && c[1].p_id === 5 && c[1].p_to === "parent2@example.com")), "resends to a corrected address");
    await page.click('#aca-panel-delivery input[value="all"]', { force: true });
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "email_list" && c[1].p_filter === "all")), "Everything sent filter");
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#today`);
    await page.waitForTimeout(800);
    check((await page.textContent("#aca-todayList")).includes("bounced in the last two weeks"), "Today: bounced emails");
    check((await page.textContent("#aca-todayList")).includes("expense is waiting"), "Today: an expense waiting");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Staff with a temporary password");
  {
    const { page, errors } = await open(browser, port, "?as=staff&temp=1");
    check(await page.isVisible("#aca-pwForm"), "asked to choose a password");
    await page.fill("#aca-pw1", "short");
    await page.fill("#aca-pw2", "short");
    await page.click("#aca-pwSave");
    await page.waitForTimeout(150);
    check(await page.isVisible("#aca-pwForm") && !(await page.evaluate(() => window.__writes && window.__writes.some((w) => w[0] === "auth"))), "rejects a short password");
    await page.fill("#aca-pw1", "correct horse battery");
    await page.fill("#aca-pw2", "correct horse battery");
    await page.click("#aca-pwSave");
    await page.waitForTimeout(200);
    check(!(await page.isVisible("#aca-pwForm")), "dialog closes after saving");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "me_password_changed")), "clears the temporary-password flag");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Job checklists: waits for, groups, reminders (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#jobs/wfsteps");
    await page.waitForSelector("#aca-wfSteps tr.wf-row");
    check((await page.textContent("#aca-wfSteps")).includes("Waits until Cards uploaded is checked off."), "a step reads back what it waits for");
    check((await page.textContent("#aca-wfSteps")).includes("If it is 1 day late, a push and email to Jeremiah M."), "reads back the late rule");
    check((await page.textContent("#aca-wfGroups")).includes("Editing team"), "groups are listed");
    await page.click('#aca-wfSteps tr.wf-row[data-id="ws4"]');
    await page.waitForSelector("#aca-wsTitle");
    check(await page.$eval("#aca-wsTo", (n) => n.value) === "group" && await visible(page, "#aca-wsGroup"), "group step opens with its group");
    check(await page.$eval("#aca-wsWaits", (n) => n.value) === "ws5", "opens with what it waits for");
    check(!(await page.$("#aca-wsPartSubj")) && !(await page.$("#aca-wsPartOn")), "no partner email on a step");
    await page.fill("#aca-wsRem", "3");
    check((await page.textContent("#aca-wsSay")).includes("A push 3 days before it is due."), "the sentence follows the form");
    await page.click('.modal [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "workflow_step_save" && c[1].p.id === "ws4" && c[1].p.assign_to === "group" && c[1].p.group_id === "g1" &&
      c[1].p.waits_for === "ws5" && c[1].p.remind_days === 3 && c[1].p.late_days === 1 && c[1].p.late_user_id === "u1" && c[1].p.partner_email === false)), "saves the rules (no partner email)");
    await page.click("#aca-wfGAdd");
    await page.fill("#aca-wgName", "Packing crew");
    await page.check('.wf-people input[value="u1"]');
    await page.click('.modal [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "staff_group_save" && c[1].p.name === "Packing crew" && c[1].p.members.includes("u1"))), "adds a group");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Saved views + bulk on Bookings and Inventory (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#jobs/bookings");
    await page.waitForSelector("#aca-bkBody tr[data-id]");
    check(await shown(page, "#aca-lvBkBulk"), "Bookings: Change shown is there");
    await page.selectOption('#aca-panel-bookings .sv-bar select', "b-owed");
    await page.waitForTimeout(200);
    check(await page.$eval('#aca-bkScope button[data-scope="owed"]', (n) => n.getAttribute("aria-pressed") === "true"), "a built-in view switches to Still owed");
    await page.click('#aca-bkScope button[data-scope="upcoming"]');
    await page.waitForSelector("#aca-bkBody tr[data-id]");
    await page.click("#aca-lvBkBulk");
    await page.waitForSelector(".lv-modal");
    const n = (await page.$$(".lv-list input:checked")).length;
    check(n > 0, "lists the shown bookings, ticked");
    await page.click('.lv-modal [data-m="go"]');
    await page.waitForTimeout(300);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "booking_set_stage")), "moves them to the stage");
    await page.goto(page.url().replace(/#.*$/, "") + "#ops/invgear");
    await page.waitForTimeout(400);
    await page.waitForSelector("#aca-invGearBody tr[data-item]");
    await page.click("#aca-lvInvBulk");
    await page.waitForSelector(".lv-modal");
    await page.click('.lv-modal [data-m="go"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => (window.__writes || []).some((w) => w[0] === "inventory_items" && w[1] === "update" && w[2].bin_id === "bin1")), "Inventory: moves the shown items to a bin");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  // ws/shell (2026-10-24): menu reshape redirects, Back, Today names jobs, badges per tab, search, phone chrome, new hire.
  console.log("Shell: links, Back, Today, search (owner)");
  {
    const { page, errors } = await open(browser, port, "");
    const active = (id) => page.$eval("#aca-panel-" + id, (n) => n.classList.contains("active"));
    const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await page.waitForTimeout(200); };
    await go("#partners/ready");
    check(await active("outbox"), "#partners/ready lands on the Outbox");
    await go("#jobs/schools");
    check(await active("bookings"), "#jobs/schools lands on All jobs");
    await go("#system/health");
    check(await active("company"), "#system/health opens Settings > Company");
    await go("#sales");
    check(await active("resjobs"), "#sales opens Jobs > Sales");
    await go("#partners");
    check(await active("orgs"), "#partners opens All partners");
    await go("#system/team");
    check(await active("team") && page.url().endsWith("#team/team"), "#system/team opens People > Team, written as #team/team: " + page.url().replace(/.*#/, "#"));
    // Back: a new page adds a history entry, a tab inside a page doesn't
    await page.click('#aca-nav button[data-tab="today"]');
    await page.waitForTimeout(150);
    await page.click('#aca-nav button[data-tab="jobs"]');
    await page.waitForTimeout(150);
    await page.click('#aca-pagetabs button[data-tab="resjobs"]');
    await page.waitForTimeout(150);
    await page.goBack();
    await page.waitForTimeout(300);
    check(await active("today"), "Back from a tab on Jobs goes to the page before (Today)");
    // a job page has its own tabs: no Jobs tab strip above it
    await go("#jobs/job/bk1");
    await page.waitForSelector("#aca-jpTabs button");
    check(!(await visible(page, "#aca-pagetabs")), "a job page hides the Jobs tab strip");
    check(await page.$eval('#aca-nav button[data-tab="jobs"]', (b) => b.getAttribute("aria-selected") === "true"), "Jobs stays lit in the menu");
    // badges: the page's tabs add up to the menu's number
    await page.click('#aca-nav button[data-tab="jobs"]');
    await page.waitForTimeout(400);
    const navN = Number(await page.textContent("#aca-nav-jobs")) || 0;
    const tabN = await page.$$eval("#aca-pagetabs .n", (ns) => ns.reduce((k, n) => k + (Number(n.textContent) || 0), 0));
    check(navN > 1 && navN === tabN, "Jobs badge " + navN + " = its tabs' badges " + tabN);
    // Today names the job on a Jobs line and opens it
    await page.click('#aca-nav button[data-tab="today"]');
    await page.waitForSelector('#aca-todayList [data-job="bk3"]');
    const jobsArea = await page.textContent('#aca-todayList .today-area[data-area="Jobs"]');
    check(jobsArea.includes("Island Cheer & Tumbling") && jobsArea.includes("nobody to email") && jobsArea.includes("an email failed to send"), "Today: Jobs lines name the job: " + jobsArea.replace(/\s+/g, " ").slice(0, 160));
    check(!jobsArea.includes("hub row") && !jobsArea.includes("reply all"), "Today: no jargon");
    const warnDot = await page.$eval("#aca-todayList .today-dot.warn", (n) => getComputedStyle(n).backgroundColor).catch(() => "");
    const errDot = await page.$eval("#aca-todayList .today-dot.err", (n) => getComputedStyle(n).backgroundColor).catch(() => "");
    check(warnDot && errDot && warnDot !== errDot, "waiting and broken dots differ: " + warnDot + " vs " + errDot);
    if (!(await page.isVisible('#aca-todayList [data-job="bk3"]'))) await page.click('#aca-todayList .today-area[data-area="Jobs"] .today-ah');
    await page.click('#aca-todayList [data-job="bk3"] >> nth=0');
    await page.waitForTimeout(300);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "job_get" && c[1].p_booking === "bk3")) && await active("job"), "a named line opens that job: " + page.url().replace(/.*#/, "#"));
    await page.goBack();
    await page.waitForTimeout(300);
    check(await active("today"), "Back from the job returns to Today");
    check(!(await page.textContent("#aca-todayClock").catch(() => "")).includes("Clock out") && !(await page.$("#aca-todayClock button.primary")), "Today: clocked out, Clock in is a quiet line");
    // search: settings by name, stage names, a year back
    await page.keyboard.press("Control+k");
    check((await page.getAttribute("#aca-gsInput", "placeholder")) === "Search jobs, partners, galleries, settings and pages", "search placeholder says what you can find");
    await page.fill("#aca-gsInput", "pay rates");
    await page.waitForTimeout(300);
    let gs = await page.textContent("#aca-gsList");
    check(gs.includes("Settings") && gs.includes("Pay rates") && gs.includes("Team & pay"), "Cmd-K finds a setting by name: " + gs.replace(/\s+/g, " ").slice(0, 120));
    await page.fill("#aca-gsInput", "brewer");
    await page.waitForTimeout(400);
    gs = await page.textContent("#aca-gsList");
    check(gs.includes("Partners") && gs.includes("Prospecting") && !gs.includes("contacting"), "Cmd-K shows stage names, not keys");
    const call = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "admin_bookings").pop());
    check(call && call[1].p_from < new Date(Date.now() - 300 * 864e5).toISOString().slice(0, 10), "Cmd-K looks for jobs a year back: " + (call && call[1].p_from));
    await page.keyboard.press("Escape");
    // account menu: no Sync now; Notifications has "Morning email goes to you"
    await page.click("#aca-whoBtn");
    check(!(await page.isVisible("#aca-syncNowBtn")), "no Sync GotPhoto now in the account menu");
    await page.click("#aca-notifBtn");
    await page.waitForSelector("#aca-pnDigestOn");
    check(await page.$eval("#aca-pnDigestOn", (c) => c.checked), "Morning email goes to you: on");
    await page.click("#aca-pnDigestOn");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "me_digest_set" && c[1].p_on === false)), "unticking takes them off the morning email");
    await page.click("#aca-pnDone");
    // the sync line opens Settings (Company, or Sync until Company exists)
    await page.click("#aca-syncStatus");
    await page.waitForTimeout(200);
    check(await active("health") || await page.$eval("#aca-panel-company", (n) => n.classList.contains("active")).catch(() => false), "the sync line opens Settings");
    // shared phone-table style: rows become labelled cards under 700px
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { const d = document.createElement("div"); d.className = "table-wrap cards"; d.id = "aca-cardTest";
      d.innerHTML = "<table><thead><tr><th>Who</th><th>When</th><th></th></tr></thead><tbody><tr><td>Sam</td><td>Mon</td><td class='act'><button>Open</button></td></tr></tbody></table>";
      document.getElementById("aca-panel-health").appendChild(d); });
    await page.waitForTimeout(100);
    check(await page.$eval("#aca-cardTest td", (td) => td.getAttribute("data-label") === "Who" && getComputedStyle(td).display === "block" && getComputedStyle(td.closest("tr")).display === "block"), "table-wrap cards: rows stack as labelled cards on a phone");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Shell: phone chrome (owner, 390px)");
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html`);
    await page.waitForSelector("#aca-nav button[data-tab]", { state: "attached" });
    await page.waitForTimeout(500);
    check(await page.isVisible("#aca-bookBtn") && (await page.textContent("#aca-bookBtn .bk-plus")) === "+" && !(await page.isVisible("#aca-bookBtn .bk-txt")), "Book a job is a + in the top bar");
    check((await page.textContent("#aca-whoBtn .who-i")) === "JM" && await page.isVisible("#aca-whoBtn .who-i") && !(await page.isVisible("#aca-whoBtn .who-f")), "the account button shows initials, so the search box keeps its width");
    const order = await page.evaluate(() => { const l = document.getElementById("aca-todayList").getBoundingClientRect().top, m = document.getElementById("aca-todayClock"); return m ? l < m.getBoundingClientRect().top : true; });
    check(order, "Today on a phone: what needs you comes before the clock");
    await page.evaluate(() => { location.hash = "#jobs/bookings"; });
    await page.waitForTimeout(250);
    check(await page.$eval("#aca-pagetabs", (n) => n.scrollWidth <= n.clientWidth + 1), "the page tab strip wraps instead of running off the edge");
    await page.evaluate(() => { location.hash = "#jobs/job/bk1"; });
    await page.waitForSelector("#aca-jpTabs button");
    check(await page.$eval("#aca-jpTabs", (n) => getComputedStyle(n).flexWrap === "nowrap" && getComputedStyle(n).overflowX === "auto"), "job page tabs are one row you swipe on a phone");
    check(await page.$eval("html", (n) => n.scrollWidth <= n.clientWidth + 1), "the job page never scrolls sideways on a phone");
    await page.click("#aca-whoBtn");
    await page.click("#aca-notifBtn");
    await page.waitForSelector(".modal-wrap.sheet .modal");
    check(await page.$eval(".modal-wrap.sheet", (n) => getComputedStyle(n).alignItems === "flex-end"), "Notifications is a bottom sheet on a phone");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= 391), "no sideways scroll");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Shell: part-timer and staff");
  {
    const { page, errors } = await open(browser, port, "?as=parttime");
    check((await page.textContent('#aca-nav button[data-tab="myday"]')).startsWith("My jobs"), "an entry without its first tab is named after the first one they have (My jobs)");
    check(!(await visible(page, "#aca-syncStatus")), "no sync line for someone without galleries or settings");
    check(await page.$eval('#aca-todayList .today-area[data-area="My work"]', (n) => n.classList.contains("open")).catch(() => false), "My work starts open");
    const lead = await page.textContent("#aca-todayLead");
    check(/waiting on you|yours/.test(lead) && !/broken/.test(lead), "the lead speaks to them: " + lead.slice(0, 80));
    await page.keyboard.press("Control+k");
    check((await page.getAttribute("#aca-gsInput", "placeholder")) === "Search your jobs and pages", "placeholder: only what they can search");
    await page.fill("#aca-gsInput", "hampden");
    await page.waitForTimeout(400);
    const gs = await page.textContent("#aca-gsList");
    check(gs.includes("Your jobs") && gs.includes("Hampden Academy"), "crew find their own jobs: " + gs.replace(/\s+/g, " ").slice(0, 100));
    await page.keyboard.press("Escape");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  {
    const { page, errors } = await open(browser, port, "?as=staff");
    await page.click("#aca-whoBtn");
    await page.waitForTimeout(150);
    const help = await page.textContent("#aca-whoHelp");
    check(await visible(page, "#aca-whoHelp") && help.includes("Jeremiah Mutty") && help.includes("207-555-0142"), "account menu: Help with the admin's name and phone: " + help);
    const area = await page.$$eval("#aca-todayList .today-area .today-an", (ns) => ns.map((n) => n.textContent));
    check(area[0] === "My work", "their own items come first: " + area.join(","));
    const mine = await page.textContent('#aca-todayList .today-area[data-area="My work"]').catch(() => "");
    check(mine.includes("You were put on"), "\"You were put on a job\" sits under My work");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Shell: new hire, notifications, forgot password");
  {
    const { page, errors } = await open(browser, port, "?as=staff&temp=1&nodevice=1");
    await page.waitForSelector("#aca-pw1");
    await page.fill("#aca-pw1", "correct horse battery");
    await page.fill("#aca-pw2", "correct horse battery");
    await page.click("#aca-pwSave");
    await page.waitForSelector(".modal .pn-why");
    check((await page.textContent(".modal .pn-why")).includes("jobs offered to you"), "after the new password, Notifications opens with a reason");
    await page.click("#aca-pnDone");
    await page.waitForTimeout(300);
    check(await visible(page, "#aca-todayNotif") && (await page.textContent("#aca-todayNotif")).includes("Turn on notifications"), "Today: a card until notifications are on");
    await page.click('#aca-todayNotif [data-n="later"]');
    check(!(await visible(page, "#aca-todayNotif")), "Not now hides the card");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html?signedout=1`);
    await page.waitForSelector("#aca-forgotBtn");
    await page.click("#aca-forgotBtn");
    check(await page.isVisible("#aca-loginError"), "Forgot password asks for the email first");
    await page.fill("#aca-email", "sam@207photo.com");
    await page.click("#aca-forgotBtn");
    await page.waitForSelector("#aca-forgotNote:not(.hidden)");
    const w = await page.evaluate(() => (window.__writes || []).find((x) => x[1] === "resetPasswordForEmail"));
    check(w && w[2] === "sam@207photo.com" && /harness\.html$/.test(w[3]), "sends the reset email with a link back to the app");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#crew/${"c".repeat(32)}`);
    await page.waitForSelector("#crp-home");
    check(await page.isVisible("#crp-home"), "signed in on this device: the confirm page offers Open 207 Admin");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  // ws/jobs (2026-10-24): Book a job adds a new league inline; crew reach their job from My jobs, My day and Open jobs.
  console.log("Book a job: a new league inline (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#jobs/bookings");
    await page.waitForSelector("#aca-bkBody tr.bk-row");
    await page.click("#aca-bkNew");
    await page.waitForSelector("#aca-bkOrgQ");
    await page.click('#aca-bkTypes input[value="sports_data"]', { force: true });
    await page.fill("#aca-bkOrgQ", "Lincoln Lacrosse");
    await page.waitForSelector("#aca-bkOrgList button[data-addorg]");
    check((await page.textContent("#aca-bkOrgList button[data-addorg]")).includes("as a new league"), "offers to add it as a new league");
    await page.click("#aca-bkOrgList button[data-addorg]");
    await page.waitForSelector("#aca-bkOrgPick strong");
    const w = await page.evaluate(() => (window.__writes || []).filter((x) => x[0] === "prospect_orgs" && x[1] === "insert").pop());
    check(w && w[2].name === "Lincoln Lacrosse" && w[2].audience === "league" && w[2].source === "Book a job", "adds the partner (source Book a job) and picks it: " + JSON.stringify(w && w[2]));
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  console.log("Crew reach their job (staff, part-timer)");
  {
    const { page, errors } = await open(browser, port, "?as=staff", "#staff/crew");
    await page.waitForSelector("#aca-crMine .cr-card");
    check(!!(await page.$('#aca-crMine .cr-card h4 a[href="#jobs/job/bk1"]')), "My jobs: the title opens the job page");
    const card = await page.textContent("#aca-crMine .cr-card");
    check(card.includes("Checklist: 2 open, 1 late") && card.includes("from home"), "My jobs: checklist line and leave from home: " + card);
    await page.click('#aca-pagetabs button[data-tab="myday"]');
    await page.waitForSelector("#aca-asBody .as-plan");
    check(!!(await page.$('#aca-asBody .as-plan a[href="#jobs/job/bk1"]')), "My day: a job row opens the job page");
    check((await page.textContent("#aca-asBody")).includes("My checklist steps") && !!(await page.$('#aca-asSteps a[href="#jobs/job/bk3/checklist"]')), "My day: my checklist steps, each with its job");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }
  {
    const { page, errors } = await open(browser, port, "?as=parttime", "#staff/openjobs");
    await page.waitForSelector("#aca-ojMine .oj-card");
    check(!!(await page.$('#aca-ojMine [data-offer="of1"] h4 a[href="#jobs/job/bk1"]')) && !(await page.$('#aca-ojMine [data-offer="of2"] h4 a')), "Open jobs: an open offer's title opens the job");
    await page.click('#aca-ojMine [data-offer="of1"] h4 a');
    await page.waitForSelector("#aca-jpTabs button");
    const tabs = await page.$$eval("#aca-jpTabs button", (bs) => bs.map((b) => b.dataset.t));
    check(JSON.stringify(tabs) === JSON.stringify(["overview", "checklist", "notes"]), "crew without a job area: Overview, Checklist, Notes: " + tabs.join(","));
    check(!(await page.$('#aca-panel-job [data-j="edit"]')), "no Edit booking for crew");
    await page.click('#aca-jpTabs button[data-t="checklist"]');
    await page.waitForSelector("#aca-jpBody .tb-jt, #aca-jpBody .empty");
    check(!(await page.textContent("#aca-jpBody")).includes("Assignments"), "says My day, not Assignments");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
