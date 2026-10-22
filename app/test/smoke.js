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
    check(JSON.stringify(items) === JSON.stringify(["today", "bookings", "jobs", "hubact", "calc", "pictureday", "seasons", "checklists", "requests", "makeups", "retakes", "searchlog", "orgs", "outbox", "library", "rebook", "reviews", "agreements", "schedule", "myday", "clock", "clearances", "openjobs", "crew", "inventory", "sending", "team"]), "menu has every page: " + items.join(","));
    for (const t of items) {
      await page.click(`#aca-nav button[data-tab="${t}"]`);
      await page.waitForTimeout(150);
      check(await page.$eval(`#aca-panel-${t}`, (n) => n.classList.contains("active")), `opens ${t}`);
      check(!(await visible(page, "#aca-viewOnly")), `${t}: no view-only notice`);
    }
    check(await visible(page, "#aca-bookBtn") && await shown(page, "#aca-syncNowBtn"), "Book a job + Sync now shown");
    // Team: add a person
    await page.click('#aca-nav button[data-tab="team"]');
    await page.waitForSelector("#aca-teamBody [data-edit]");
    check((await page.$$("#aca-teamBody tr")).length === 3, "team list shows 3 people");
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
    await page.check('input[name="tm-parents"][value="edit"]', { force: true });
    await page.click("#aca-tmSave");
    await page.waitForTimeout(200);
    const save = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "team_save").pop());
    check(save && save[1].p_permissions.parents === "edit" && save[1].p_permissions.bookings === "edit" && save[1].p_is_admin === false, "edit saves through team_save");
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
    check((await page.$$("[data-topic]")).length === 3, "Notifications lists the kinds this person can get");
    // Headless Chromium reports notifications as blocked; a real browser offers "Turn on".
    check(await page.isVisible("#aca-pnOn") || (await page.textContent("#aca-pnBody")).includes("blocked"), "shows this device's notification state");
    check((await page.textContent("#aca-pnBody")).includes("iPhone"), "lists their other devices");
    await page.uncheck('[data-topic="help_request"]');
    await page.waitForTimeout(150);
    const pref = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "push_set_pref").pop());
    check(pref && pref[1].p_topic === "help_request" && pref[1].p_enabled === false, "switching a kind off saves it");
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
    await page.selectOption("#aca-bkStage", ":overdue");
    check((await page.$$("#aca-bkBody tr.bk-row")).length === 1, "Deliverables overdue filter");
    await page.selectOption("#aca-bkStage", "Booked");
    check((await page.$$("#aca-bkBody tr.bk-row")).length === 1, "stage filter by name");
    await page.selectOption("#aca-bkStage", "");
    await page.click('#aca-bkBody tr[data-id="bk1"]');
    await page.waitForSelector("#aca-bkPanel .bk-stages");
    check((await page.$$("#aca-bkPanel .bk-stages li")).length === 6, "panel shows the type's six stages");
    check((await page.textContent("#aca-bkPanel .bk-stages li.cur")).includes("In production"), "current stage highlighted");
    check((await page.$$("#aca-bkPanel .bk-stages li.done")).length === 2, "earlier stages ticked");
    await page.click('#aca-bkPanel button[data-next="1"]');
    await page.waitForTimeout(150);
    const mv = await lastRpc("booking_set_stage");
    check(mv && mv[1].p_stage === "st-sports_data-3" && mv[1].p_booking === "bk1", "Move to Job launched");
    check((await page.$$("#aca-bkPanel .bk-dlv li")).length === 3 && (await page.textContent("#aca-bkPanel .bk-dlv")).includes("overdue"), "deliverables listed with overdue");
    await page.click('#aca-bkPanel input[data-dlv="bd1"]');
    await page.waitForTimeout(150);
    const tick = await lastRpc("booking_deliverable_update");
    check(tick && tick[1].p_id === "bd1" && tick[1].p.status === "done", "ticking marks it delivered");
    const opts = await page.$$eval("#aca-bkDlvPick option", (os) => os.map((o) => o.textContent));
    check(opts.some((o) => o.includes("Thank-you card")) && !opts.some((o) => o.includes("Team composites")), "saved picks leave out ones already on the job");
    await page.fill("#aca-bkDlvNew", "Coach banner 2");
    await page.click('#aca-bkPanel button[data-v="dlvnew"]');
    await page.waitForTimeout(150);
    const add = await lastRpc("booking_deliverables_add");
    check(add && add[1].p_items[0].label === "Coach banner 2" && add[1].p_items[0].save === true, "typed deliverable added and saved for the type");
    await page.click('#aca-bkPanel button[data-v="dlvedit"][data-dlv="bd2"]');
    await page.selectOption("#aca-bkDeStatus", "skipped");
    await page.click('.og-modal button[data-v="save"]');
    await page.waitForTimeout(150);
    const ed = await lastRpc("booking_deliverable_update");
    check(ed && ed[1].p_id === "bd2" && ed[1].p.status === "skipped" && ed[1].p.label === "Coach banner", "edit dialog saves");
    await page.click('#aca-bkPanel button[data-v="close"]');

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
    check(await page.$eval("#aca-bkDays .bk-d-day", (n) => n.value) === "2026-12-05" && /Dec 5, 2026/.test(await page.textContent("#aca-bkDays .dp-face")), "calendar sets the day");
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
    await page.click('.bk-form button[data-v="save"]');
    await page.waitForFunction(() => window.__rpcCalls.some((c) => c[0] === "booking_create"));
    await page.waitForSelector("#aca-bkPanel .bk-stages");
    check((await lastRpc("booking_create"))[1].p.location === "James F. Doughty Middle School, 143 Fifth St, Bangor, ME 04401", "the picked address is saved as the location");
    const bk = await lastRpc("booking_deliverables_add");
    check(bk && bk[1].p_booking === "bk1" && bk[1].p_items.some((x) => x.template_id === "dt1") && bk[1].p_items.some((x) => x.label === "Coach gift" && x.save), "booking adds the picked deliverables");
    const crewSave = await lastRpc("schedule_save");
    check(crewSave && crewSave[1].p.kind === "job" && crewSave[1].p.booking_id === "bk1" && crewSave[1].p.user_id === "u2", "the crew picked when booking goes on the schedule");

    // Stages & deliverables per job type
    await page.click('#aca-bkPanel button[data-v="close"]');
    await page.click("#aca-bkJobTypes");
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

    // Track a job: GotPhoto jobs not on the screen; nothing is sent for them
    await page.click("#aca-bkTrack");
    await page.waitForSelector('#aca-bkTrList [data-pick="g10"]');
    check((await page.textContent('#aca-bkTrList [data-job="g10"]')).includes("Hancock Grammar School"), "track picker shows the matched organization");
    await page.check('#aca-bkTrList [data-pick="g10"]');
    await page.check('#aca-bkTrList [data-pick="g11"]');
    await page.click('.bk-form button[data-v="track"]');
    check((await page.textContent("#aca-bkTrErr")).includes("organization"), "asks for the organization the sync could not match");
    await page.fill('#aca-bkTrList [data-orgq="g11"]', "Island");
    await page.waitForSelector('#aca-bkTrList [data-orgpick]');
    await page.click('#aca-bkTrList [data-orgpick]');
    await page.click('.bk-form button[data-v="track"]');
    await page.waitForTimeout(200);
    const tr = await lastRpc("booking_track_jobs");
    check(tr && tr[1].p_items.length === 2 && tr[1].p_items.some((x) => x.gotphoto_job_id === "g11" && x.org_id === "44444444-4444-4444-4444-444444444444" && x.type_key === "sports_data"), "tracks the picked GotPhoto jobs");
    await page.click("#aca-bkTrack");
    await page.waitForSelector("#aca-bkTrAuto");
    await page.check("#aca-bkTrAuto");
    await page.waitForTimeout(150);
    const au = await lastRpc("booking_set_auto_track");
    check(au && au[1].p_on === true, "auto-track switch saves");
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
    await page.waitForSelector("#aca-bkPanel .bk-stages");
    const txt = await page.textContent("#aca-bkPanel");
    check(txt.includes("Tracking only") && !txt.includes("Calendar") && !txt.includes("Emails") && !(await page.$('#aca-bkPanel button[data-v="edit"]')), "panel shows tracking only: no calendar, emails or edit");
    check(!!(await page.$("#aca-bkPanel .bk-dlv")), "deliverables still there");
    await page.click('#aca-bkPanel button[data-v="untrack"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "booking_untrack" && c[1].p_id === "bk1")), "Stop tracking");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Bookings view only");
  {
    const { page, errors } = await open(browser, port, "?as=viewer", "#jobs/bookings/bk1");
    await page.waitForSelector("#aca-bkPanel .bk-stages");
    check(await page.$$eval("#aca-bkPanel .bk-stages button", (bs) => bs.every((b) => b.disabled)), "stages read-only");
    check(!(await page.$('#aca-bkPanel button[data-next]')) && !(await page.$("#aca-bkDlvNew")) && !(await page.$('#aca-bkPanel button[data-v="dlvedit"]')), "no move / add / edit controls");
    check(await page.$$eval("#aca-bkPanel input[data-dlv]", (cs) => cs.every((c) => c.disabled)), "deliverable ticks disabled");
    check(!(await visible(page, "#aca-bkTrack")), "Track a job hidden");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Inventory (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#ops/inventory");
    check(await page.$eval("#aca-panel-inventory", (n) => n.classList.contains("active")), "#ops/inventory opens Find");
    await page.waitForSelector("#aca-invResults .empty");
    check(!(await page.textContent("#aca-invResults")).includes("Checked out to you"), "nothing checked out to the owner");
    await page.fill("#aca-invQ", "canon");
    await page.waitForSelector("#aca-invResults [data-item]");
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
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#aca-invGearExport")]);
    const csv = fs.readFileSync(await dl.path(), "utf8");
    check(dl.suggestedFilename().startsWith("207-photo-gear-insurance-") && csv.includes("Canon R6 body,SN-12345,1,1800,1800.00") && csv.includes("Total,,,,2100.00"), "gear: insurance CSV has items and total");
    await page.click('#aca-invGearBody tr[data-item="ii2"]');
    await page.waitForSelector("#aca-invISvc");
    const care = await page.textContent(".modal .inv-care");
    check(care.includes("$2,499") && care.includes("$1,800") && care.includes("overdue"), "item shows bought, worth and overdue service: " + care);
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
    check(JSON.stringify(items) === JSON.stringify(["today", "crew", "inventory"]), "menu: Today, My jobs and Inventory: " + items.join(","));
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

  console.log("Season results (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#jobs/seasons");
    await page.waitForSelector("#aca-panel-seasons .tiles");
    check(await page.$eval("#aca-panel-seasons", (n) => n.classList.contains("active")), "#jobs/seasons opens Seasons");
    check(await page.$eval("#aca-rsSeason", (s) => s.value) === "fall:2026", "starts on the latest season");
    const tiles = await page.textContent("#aca-panel-seasons .tiles");
    check(tiles.includes("$11,000") && tiles.includes("vs $9,500"), "sales against the same season last year: " + tiles.replace(/\s+/g, " ").slice(0, 120));
    check(tiles.includes("+16%"), "change shown");
    const orgs = await page.textContent("#aca-panel-seasons table");
    check(orgs.includes("Old Town Soccer") === false && orgs.includes("No organization"), "jobs without an organization are grouped");
    check(orgs.includes("Island Cheer") && orgs.includes("new"), "a new partner says new");
    await page.selectOption("#aca-rsSeason", "year:2026");
    await page.waitForTimeout(100);
    check((await page.textContent("#aca-panel-seasons .tiles")).includes("$16,400"), "whole year adds every season");

    await page.click('#aca-pagetabs button[data-tab="payouts"]');
    await page.waitForSelector("#aca-panel-payouts .rs-org");
    const pay = await page.textContent("#aca-panel-payouts");
    check(pay.includes("$760.00 owed on 4 jobs"), "owed total: " + pay.replace(/\s+/g, " ").slice(0, 140));
    check((await page.$$("#aca-panel-payouts .rs-org")).length === 2, "one block per partner owed");
    await page.click('#aca-panel-payouts [data-payall="r1,r8"]');
    await page.waitForSelector("#aca-rsPayRef");
    await page.fill("#aca-rsPayRef", "1101");
    await page.click(".modal [data-go]");
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "results_pay" && c[1].p_jobs.join() === "r1,r8" && c[1].p_method === "Check" && c[1].p_ref === "1101" && c[1].p_amount === undefined)), "records a payment for what is owed");
    await page.click('#aca-panel-payouts [data-f="paid"]');
    await page.waitForTimeout(100);
    check((await page.textContent("#aca-panel-payouts")).includes("Brewer Travel | Fall 2025"), "Paid filter lists paid jobs");
    await page.click("#aca-rsAddTerms");
    await page.waitForSelector("#aca-rsTOrg");
    check(await page.$eval("#aca-rsTOrg", (s) => [...s.options].map((o) => o.textContent).join()) === "Island Cheer & Tumbling", "add terms offers partners without terms");
    await page.fill("#aca-rsTPct", "7.5");
    await page.click(".modal [data-go]");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "results_set_terms" && c[1].p_pct === 7.5 && c[1].p_org === "44444444-4444-4444-4444-444444444444")), "saves a partner's share");

    await page.click('#aca-pagetabs button[data-tab="resjobs"]');
    await page.waitForSelector('#aca-panel-resjobs tr[data-job="r9"]');
    check((await page.textContent('#aca-panel-resjobs tr[data-job="r9"]')).includes("typed in"), "typed-in sales are marked");
    await page.fill("#aca-rsQ", "hancock");
    await page.waitForTimeout(100);
    check((await page.$$("#aca-panel-resjobs tbody tr[data-job]")).length === 3, "search narrows the list");
    await page.click('#aca-panel-resjobs tr[data-job="r2"]');
    await page.waitForSelector("#aca-rsJSales");
    await page.fill("#aca-rsJSales", "3300");
    await page.selectOption("#aca-rsJOrg", "11111111-1111-1111-1111-111111111111");
    await page.click(".modal [data-go]");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "results_save" && c[1].p_job === "r2" && c[1].p.manual_sales === "3300" && c[1].p.org_id === "11111111-1111-1111-1111-111111111111")), "saves typed sales and an organization");
    await page.click("#aca-rsRefresh");
    await page.waitForTimeout(250);
    check(await page.evaluate(() => window.__salesCalls === 1), "Refresh sales calls the admin function");

    await page.click('#aca-nav button[data-tab="today"]');
    await page.waitForTimeout(250);
    check((await page.textContent("#aca-panel-today")).includes("partner payouts are owed"), "Today says payouts are owed");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Season results view only");
  {
    const { page, errors } = await open(browser, port, "?as=money");
    check(JSON.stringify(await rail(page)) === JSON.stringify(["today", "seasons", "crew"]), "menu: Today, Season results and My jobs");
    await page.click('#aca-nav button[data-tab="seasons"]');
    await page.waitForSelector("#aca-panel-seasons .tiles");
    await page.click('#aca-pagetabs button[data-tab="payouts"]');
    await page.waitForSelector("#aca-panel-payouts .rs-org");
    check(!(await page.$("#aca-panel-payouts [data-payall]")) && !(await page.$("#aca-rsAddTerms")), "no Record payment, no terms editing");
    check(!!(await page.$("#aca-panel-payouts [data-copy]")), "can still copy a statement");
    await page.click('#aca-pagetabs button[data-tab="resjobs"]');
    await page.waitForSelector('#aca-panel-resjobs tr[data-job="r1"]');
    check(!(await page.$("#aca-rsRefresh")), "no Refresh sales");
    await page.click('#aca-panel-resjobs tr[data-job="r1"]');
    await page.waitForSelector("#aca-rsJSales");
    check(await page.$eval("#aca-rsJSales", (i) => i.disabled) && !(await page.$(".modal [data-go]")), "job is read-only");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Schedule + Assignments (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#staff/schedule");
    await page.waitForSelector("#aca-scGrid .sc-b");
    check(await page.$eval("#aca-panel-schedule", (n) => n.classList.contains("active")), "schedule opens from its link");
    await page.click('[data-v="studio"]');
    await page.fill("#aca-scAddr", "60 main");
    await page.waitForSelector("#aca-scAddr-places:not(.hidden) button[data-i]");
    await page.click("#aca-scAddr-places button[data-i]");
    await page.waitForFunction(() => document.querySelector("#aca-scAddr").value === "60 Main Rd N, Hampden, ME 04444");
    check(true, "the studio address searches Google Maps and fills the full address");
    await page.click('.sc-modal [data-m="cancel"]');
    check((await page.$$("#aca-scGrid .sc-head")).length === 8, "week view: 7 days Sunday to Saturday");
    check((await page.textContent("#aca-scGrid .sc-head:nth-child(2)")).startsWith("Sun"), "the week starts on Sunday");
    check((await page.$$("#aca-scGrid .sc-b.sc-k-drive")).length === 4 && (await page.$$("#aca-scGrid .sc-b.sc-k-job")).length >= 2, "job bars with drive time on both sides");
    check((await page.$$("#aca-scGrid .sc-b.sc-k-off")).length === 3, "time off spans two days, plus \"Alex Off\" from Google Calendar");
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
    check((await page.$$("#aca-scGrid .sc-chip.none")).length === 2, "jobs with nobody on them stand out");
    check((await page.textContent("#aca-scGrid")).includes("Jobs not assigned") && (await page.$$("#aca-scGrid .sc-chip[data-booking]")).length === (await page.$$("#aca-scGrid .sc-chip.none")).length + (await page.$$("#aca-scGrid .sc-chip.tracked")).length + (await page.$$("#aca-scGrid .sc-chip.part")).length, "only jobs short of people sit in Jobs not assigned");
    await page.click("#aca-scGrid .sc-b.sc-k-job:not(.drive)");
    await page.waitForSelector('.sc-modal [data-m="more"]');
    await page.click('.sc-modal [data-m="more"]');
    check(await page.isVisible(".sc-modal .sc-pick"), "a job bar's More people opens the people picker");
    await page.click('.sc-modal [data-m="cancel"]');
    // put someone on a job
    await page.click("#aca-scGrid .sc-chip.none");
    await page.waitForSelector(".sc-modal .sc-pick input[type=checkbox]");
    await page.click('.sc-modal [data-m="drive"]');
    await page.waitForTimeout(150);
    check(await page.$eval(".sc-modal .sc-db", (n) => n.value) === "25", "drive time looked up and rounded up to 25");
    await page.check(".sc-modal .sc-pick input[type=checkbox] >> nth=0");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    const saved = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").map((c) => c[1].p));
    check(saved.length === 1 && saved[0].kind === "job" && saved[0].drive_before_min === 25 && /T\d\d:00:00.000Z$/.test(saved[0].starts_at), "saves a job bar with drive time");
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
    await page.click('.sc-modal [data-m="ask"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "crew_ask_now" && c[1].p_booking === "bk1" && c[1].p_user === "u2")), "Ask again sends the ask now");
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
    await page.click('[data-v="crewset"]');
    await page.waitForSelector("#aca-scRoles li[data-id]");
    check((await page.$$("#aca-scRoles li[data-id]")).length === 4 && await page.isChecked("#aca-scCfOn") && !(await page.isChecked("#aca-scWkOn")), "crew settings: roles, asking on, weekly email off");
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
    // My day
    await page.click('#aca-nav button[data-tab="myday"]');
    await page.waitForSelector("#aca-asBody .as-task");
    check((await page.textContent("#aca-asBody")).includes("Leave the studio"), "my day says when to leave");
    check(await page.$eval("#aca-asBody .as-task", (n) => n.textContent.includes("Urgent")), "urgent task on top");
    await page.click("#aca-asBody .as-task:nth-of-type(2) input");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "assignment_check" && c[1].p_done === true)), "checks a task off");
    check((await page.textContent("#aca-asBody")).includes("Second shooter") && await page.$eval('#aca-asBody a.pill[href^="#crew/"]', (n) => n.textContent === "Confirm"), "my day: role and a Confirm link");
    // Tasks
    await page.click('#aca-pagetabs button[data-tab="tasks"]');
    await page.waitForSelector("#aca-asTBody tr.as-row");
    check((await page.$$("#aca-asTBody tr.as-row")).length === 4, "task list");
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
    check(await visible(page, "#aca-asSetCard") && await page.$eval("#aca-asPlanHour", (n) => n.value) === "20", "evening notification at 8pm");
    await page.waitForTimeout(100);
    check(await page.$eval("#aca-asMailHour", (n) => n.value) === "7" && await page.$eval("#aca-asMailOn", (n) => n.checked), "morning email at 7am");
    // Team: weekly hours
    await page.click('#aca-nav button[data-tab="team"]');
    await page.waitForSelector("#aca-teamBody [data-edit]");
    check((await page.textContent("#aca-teamBody")).includes("40 h/week"), "team list shows weekly hours");
    check((await page.textContent("#aca-teamBody")).includes("Owner \u00b7 Salaried"), "team list shows job title and employment type");
    await page.click('#aca-teamBody [data-edit="u2"]');
    await page.fill("#aca-tmHours", "28");
    await page.fill("#aca-tmTitle", "Second shooter");
    await page.selectOption("#aca-tmType", "contractor");
    check((await page.textContent("#aca-tmTypeNote")).includes("Open jobs"), "1099 explains offers + payroll");
    await page.click("#aca-tmSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "team_set_hours" && c[1].p_hours === 28 && c[1].p_user_id === "u2")), "saves weekly hours");
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
    await page.click('#aca-pagetabs button[data-tab="wfsteps"]');
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
  console.log("Picture day planner (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#jobs/pictureday");
    await page.waitForSelector("#aca-pdList tr[data-open]");
    check((await page.$$("#aca-pdList tr[data-open]")).length === 2, "list shows two picture days");
    check((await page.textContent("#aca-pdList")).includes("1 want to move"), "list says a coach wants to move");
    await page.click('#aca-pdList tr[data-open="bk1"]');
    await page.waitForSelector(".pd-board");
    check(page.url().endsWith("#jobs/pictureday/bk1"), "opening one puts it in the address");
    check((await page.$$(".pd-col")).length === 3, "board: two courts plus No time yet");
    check((await page.textContent(".pd-board")).includes("After 10 works better"), "board shows the coach's note");
    check((await page.textContent(".pd-dl")).includes("Home jerseys"), "form answers shown");
    await page.click("#aca-pdLayout");
    await page.waitForTimeout(200);
    const lay = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "pd_save_slots").pop());
    check(lay && lay[1].p_slots.length === 1 && lay[1].p_slots[0].id === "pt3" && /T13:10:00\.000Z$|T14:10:00\.000Z$/.test(lay[1].p_slots[0].slot_at) && lay[1].p_slots[0].field === "Court 1",
      "lay out: the team without a time gets the next free slot (9:10, Court 1): " + JSON.stringify(lay && lay[1].p_slots));
    await page.click("#aca-pdSendSlots");
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "pd_send_slots" && c[1].p_teams === null)), "email coaches sends to everyone not told yet");
    await page.selectOption("#aca-pdContact", "c2");
    await page.click("#aca-pdSendForm");
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "pd_send_intake" && c[1].p_contact === "c2")), "form goes to the chosen contact");
    await page.click('[data-team="pt2"]');
    await page.waitForSelector("#aca-pdtName");
    await page.fill(".pd-modal .dp-time", "1020");
    await page.press(".pd-modal .dp-time", "Tab");
    await page.click("#aca-pdtSave");
    await page.waitForTimeout(200);
    const save = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "pd_save_team").pop());
    check(save && save[1].p.id === "pt2" && /T14:20:00\.000Z$|T15:20:00\.000Z$/.test(save[1].p.slot_at), "editing a team saves its new time");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "pd_attention")), "Today asks for coach answers");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Picture day: the organization's form (no sign-in)");
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#plan/${"a".repeat(36)}`);
    await page.waitForSelector("#pdp-send");
    check(!(await page.isVisible("#aca-loginView")) && !(await page.isVisible("#aca-dashView")), "no sign-in, no admin");
    check((await page.textContent(".pdp h1")) === "Brewer Travel Basketball Club", "shows the organization");
    check((await page.$$("#pdp-teams .pdp-team")).length === 1, "teams already on file are filled in");
    await page.click("#pdp-pasteBtn");
    await page.fill("#pdp-pasteText", "Team\tCoach\tEmail\nU10 Red\tAlex Coach\talex@example.org\t\t11\nU12 Green, Pat, pat@example.org");
    await page.click("#pdp-pasteGo");
    check((await page.$$("#pdp-teams .pdp-team")).length === 3, "a pasted list adds a row per team (header skipped)");
    await page.fill("#pdp-onName", "Chris");
    await page.fill("#pdp-fields", "Court 1\nCourt 2");
    await page.click("#pdp-send");
    await page.waitForSelector(".pdp .ok");
    const sub = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "pd_public_submit").pop());
    check(sub && sub[1].p.teams.length === 3 && sub[1].p.teams[0].id === "pt1" && sub[1].p.teams[1].coach_email === "alex@example.org" && sub[1].p.teams[1].players === "11", "sends the teams, keeping the existing team's id");
    check(sub && JSON.stringify(sub[1].p.fields) === '["Court 1","Court 2"]', "sends the fields one per line");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Picture day: a coach's time (no sign-in)");
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/harness.html#slot/${"c".repeat(36)}`);
    await page.waitForSelector("#pdp-yes");
    check((await page.textContent(".pdp-big")).includes("Court 1"), "shows the field");
    await page.click("#pdp-move");
    await page.click("#pdp-moveGo");
    check(await page.isVisible("#pdp-err"), "asking to move needs a note");
    await page.click("#pdp-yes");
    await page.waitForSelector(".pdp .ok");
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "pd_public_slot_reply" && c[1].p_answer === "confirm")), "confirm is sent");
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
    check(JSON.stringify(items) === JSON.stringify(["today", "bookings", "calc", "requests", "makeups", "retakes", "schedule", "myday", "clock", "clearances", "crew"]), "menu limited to their pages: " + items.join(","));
    check(await page.$eval("#aca-panel-today", (n) => n.classList.contains("active")), "a link to a page they can't see lands on Today");
    const calls = await page.evaluate(() => window.__rpcCalls.map((c) => c[0]));
    const forbidden = calls.filter((n) => /^(admin_outbox|admin_hub|admin_lookup|prospect_|admin_morning|team_|admin_job)/.test(n));
    check(forbidden.length === 0, "never calls RPCs for other modules" + (forbidden.length ? ": " + forbidden.join(",") : ""));
    check(!(await shown(page, "#aca-syncNowBtn")), "Sync now hidden");
    check(await visible(page, "#aca-bookBtn"), "Book a job shown (bookings edit)");
    check(!(await visible(page, "#aca-todayOutBox")) && !(await visible(page, "#aca-todayDigestBox")) && await visible(page, "#aca-todayUpBox"), "Today shows only Coming up");
    await page.waitForSelector("#aca-todayMine .as-task");
    check((await page.textContent("#aca-todayMine")).includes("Your assignments"), "Today shows their assignments");
    await page.click("#aca-todayMine .as-task input >> nth=0");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "assignment_check")), "a task checks off from Today");
    await page.click('#aca-nav button[data-tab="requests"]');
    check(await visible(page, "#aca-viewOnly"), "view-only notice on a view module");
    await page.click('#aca-nav button[data-tab="bookings"]');
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
    await page.waitForSelector("#aca-scGrid .sc-b");
    check(!(await shown(page, '#aca-panel-schedule [data-v="add"]')) && await visible(page, "#aca-viewOnly"), "schedule is view-only for them");
    await page.click("#aca-scGrid .sc-b.sc-k-job");
    check(await page.isVisible(".sc-modal") && !(await page.$(".sc-modal [data-m=save]")), "a bar opens its details, not an editor");
    await page.click('.sc-modal [data-m="ok"]');
    check(await visible(page, '#aca-panel-schedule [data-v="addflex"]'), "staff: Add flex time shown");
    await page.click("#aca-scGrid .sc-b.sc-k-flex");
    await page.waitForSelector("#aca-scT");
    check((await page.$$('.sc-modal input[name="aca-scK"]')).length === 1 && (await page.$$("#aca-scP option")).length === 1 && await page.isVisible('.sc-modal [data-m="remove"]'), "staff: their flex bar opens an editor limited to flex time for themselves");
    await page.evaluate(() => { const s = document.getElementById("aca-scS"), e = document.getElementById("aca-scE"); s.value = "13:00"; e.value = "15:00"; s.dispatchEvent(new Event("change", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    const f = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").pop()[1].p);
    check(f.kind === "flex" && f.user_id === "u2" && f.id === "se6", "staff: moves their flex time: " + JSON.stringify(f));
    await page.click("#aca-scGrid .sc-b.sc-k-off");
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
    check(JSON.stringify(items) === JSON.stringify(["today", "openjobs", "crew"]), "menu: Today, Open jobs and My jobs: " + items.join(","));
    check((await page.textContent("#aca-panel-today")).includes("offered to you"), "Today says a job is waiting");
    await page.click('#aca-nav button[data-tab="openjobs"]');
    await page.waitForSelector("#aca-ojMine .oj-card");
    check(!(await visible(page, "#aca-viewOnly")), "no view-only notice");
    check(!(await visible(page, "#aca-ojOffer")) && !(await visible(page, "#aca-ojPosted")), "no manager controls");
    check((await page.$$("#aca-ojMine [data-take]")).length === 1 && (await page.$$("#aca-ojMine [data-pass]")).length === 1, "open offer has Take it + Pass; filled one has neither");
    check((await page.textContent("#aca-ojMine")).includes("35 min drive") && (await page.textContent("#aca-ojMine")).includes("You passed"), "shows drive and past answer");
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
    await page.waitForSelector("#aca-pfRbBody tr[data-org]");
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

    await page.evaluate(() => { location.hash = "#partners/reviews"; });
    await page.waitForSelector('#aca-pfRvBody tr[data-id="rv2"]');
    check((await page.textContent('#aca-pfRvBody tr[data-id="rv1"]')).includes("Waiting for your review"), "a drafted request shows it waits for review");
    check(!!(await page.$('#aca-pfRvBody tr[data-id="rv2"] [data-do="draft"]')), "a track-only job can be drafted by hand");
    await page.click('#aca-pfRvBody tr[data-id="rv1"] [data-do="log"]');
    await page.waitForSelector("#aca-pfRvOut");
    await page.selectOption("#aca-pfRvOut", "quote");
    await page.fill("#aca-pfRvQuote", "Smoothest picture day ever.");
    await page.fill("#aca-pfRvBy", "Chris, president");
    await page.click("#aca-pfRvSaveBtn");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "partner_review_log" && c[1].p_outcome === "quote" && c[1].p_save_quote === true && c[1].p_quote === "Smoothest picture day ever.")), "logs a quote and saves it to the library");

    await page.evaluate(() => { location.hash = "#partners/agreements"; });
    await page.waitForSelector('#aca-pfAgBody tr[data-id="ag1"]');
    check((await page.textContent("#aca-pfAgBody")).includes("Requested") && (await page.textContent("#aca-pfAgBody")).includes("Expires"), "list shows W-9 and insurance");
    await page.click('#aca-pfAgBody tr[data-id="ag1"] td:nth-child(2)');
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
    check(await visible(page, "#aca-ojOffer"), "Offer a job shown");
    const posted = await page.textContent("#aca-ojPosted");
    check(posted.includes("Took it") || (posted.includes("Passed") && posted.includes("Out of town") && posted.includes("No notifications on")), "answers + reasons shown");
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
    await page.click("#aca-ojPeople");
    await page.waitForSelector(".oj-ppl tr[data-u]");
    await page.selectOption('.oj-ppl tr[data-u="u2"] .oj-type', "contractor");
    await page.waitForTimeout(100);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "team_set_profile" && c[1].p_user_id === "u2" && c[1].p_type === "contractor")), "sets someone to 1099 (gets offers)");
    await page.fill('.oj-ppl tr[data-u="u2"] .oj-home', "5 Birch St, Brewer ME");
    await page.selectOption('.oj-ppl tr[data-u="u2"] .oj-max', "45");
    await page.waitForTimeout(100);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "openjobs_person_save" && c[1].p_user === "u2" && c[1].p_max_drive === 45)), "saves their longest drive");
    await page.click('.modal [data-m="done"]');
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
  console.log("Time clock: staff on a phone");
  {
    const { page, errors } = await open(browser, port, "?as=staff", "#staff/clock");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForSelector("#aca-tcBody .tc-pick button");
    check(await page.$eval("#aca-panel-clock", (n) => n.classList.contains("active")), "#staff/clock opens the clock");
    check(!(await visible(page, "#aca-viewOnly")), "clock: no view-only notice for staff");
    check((await page.textContent("#aca-tcBody .tc-pick button.mine")).includes("Hampden Academy"), "their scheduled job is listed first and marked");
    await page.fill("#aca-tcNote", "Running late");
    await page.click("#aca-tcBody .tc-pick button.mine");
    await page.waitForTimeout(150);
    const ci = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "timeclock_in").pop());
    check(ci && ci[1].p_kind === "job" && ci[1].p_booking === "bk1" && ci[1].p_note === "Running late", "clocks in to the job: " + JSON.stringify(ci && ci[1]));
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
    await page.click('#aca-nav button[data-tab="clock"]');
    await page.waitForSelector("#aca-tcTimer");
    check(await page.isVisible('#aca-tcBody [data-c="out"]'), "clocked in: big Clock out button");
    await page.click('#aca-tcBody [data-c="switch"]');
    check(await page.isVisible("#aca-tcBody .tc-pick"), "Switch shows what to switch to");
    await page.click('#aca-pagetabs button[data-tab="timesheets"]');
    await page.waitForSelector("#aca-tsBody .tc-person");
    await page.selectOption("#aca-tsWho", "all");
    await page.waitForSelector("#aca-tsBody tr.tc-row");
    check((await page.$$("#aca-tsBody tr.tc-row")).length === 2, "everyone: one row per person");
    check((await page.textContent("#aca-tsBody")).includes("Not approved"), "shows who is not approved");
    await page.click('#aca-tsBody [data-approve="u1"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "timesheet_approve" && c[1].p_user === "u1" && c[1].p_approve === true)), "approves a week");
    await page.click('#aca-tsBody tr.tc-row[data-person="u2"] td.name');
    await page.waitForSelector('#aca-tsBody [data-punch="tp3"]');
    check((await page.textContent('#aca-tsBody [data-punch="tp3"]')).includes("edited"), "a typed-in punch is marked edited");
    await page.click('#aca-panel-timesheets [data-w="payroll"]');
    await page.waitForSelector('.tc-modal [data-m="csv"]:not([disabled])');
    check((await page.textContent(".tc-modal")).includes("Not approved yet: Jeremiah M."), "payroll warns about unapproved weeks");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click('.tc-modal [data-m="csv"]')]);
    const csv = fs.readFileSync(await dl.path(), "utf8");
    check(/^Name,Email,Type,Period start,Period end,Regular hours,Overtime hours,Total hours,Miles,Mileage pay,Weeks approved\r\nJeremiah Mutty,jmutty@207photo.com,Full time,.*,40\.00,3\.50,43\.50,26\.1,18\.27,0 of 1\r\n/.test(csv), "payroll CSV: " + csv.split("\r\n")[1]);
    check(!csv.includes("Riley"), "1099 contractor left out of the payroll CSV");
    check((await page.textContent(".tc-modal")).includes("1099 contractors"), "contractors listed separately");
    const [dlc] = await Promise.all([page.waitForEvent("download"), page.click('.tc-modal [data-m="cont"]')]);
    const csvc = fs.readFileSync(await dlc.path(), "utf8");
    check(/^Name,Email,Job title,Period start,Period end,Hours,Miles,Mileage pay,Weeks approved\r\nRiley Second,riley@example\.com,Second shooter,.*,5\.00,40\.0,28\.00,1 of 1\r\n$/.test(csvc), "1099 CSV: " + csvc.split("\r\n")[1]);
    await page.click('.tc-modal [data-m="cancel"]');
    await page.click('#aca-panel-timesheets [data-w="settings"]');
    await page.waitForSelector("#aca-tsR");
    await page.fill("#aca-tsR", "0.725");
    await page.click('.tc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "timeclock_settings_save" && c[1].p_rate === 0.725 && c[1].p_overtime === 40)), "changes the mileage rate");
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

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
