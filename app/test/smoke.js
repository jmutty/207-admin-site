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
    check(JSON.stringify(items) === JSON.stringify(["today", "bookings", "jobs", "hubact", "calc", "requests", "makeups", "retakes", "searchlog", "orgs", "outbox", "library", "schedule", "myday", "inventory", "sending", "team"]), "menu has every page: " + items.join(","));
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
    await page.click('.bk-form button[data-v="addday"]');
    check(await page.$eval("#aca-bkDays .bk-d-start", (n) => n.value) === "10:00", "adding a day keeps the first day's times");
    await page.click('.bk-form button[data-v="rmday"][data-i="1"]');
    await page.waitForSelector("#aca-bkCrew .bk-crew", { state: "attached" });
    check((await page.$$("#aca-bkCrew .bk-crew")).length === 3, "Who's shooting lists the team");
    await page.click("#aca-bkCrewSum");
    await page.check("#aca-bkCrew .bk-crew >> nth=1");
    check((await page.textContent("#aca-bkCrewSum")) === "Sam H.", "the dropdown shows who's picked");
    await page.click("#aca-bkLoc");
    check(!(await page.$eval("#aca-bkCrewDd", (n) => n.open)), "the dropdown closes when you click elsewhere");
    await page.click('.bk-form button[data-v="save"]');
    await page.waitForFunction(() => window.__rpcCalls.some((c) => c[0] === "booking_create"));
    await page.waitForSelector("#aca-bkPanel .bk-stages");
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
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Inventory view only");
  {
    const { page, errors } = await open(browser, port, "?as=gear");
    const items = await rail(page);
    check(JSON.stringify(items) === JSON.stringify(["today", "inventory"]), "menu: Today and Inventory: " + items.join(","));
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

  console.log("Schedule + Assignments (owner)");
  {
    const { page, errors } = await open(browser, port, "", "#staff/schedule");
    await page.waitForSelector("#aca-scGrid .sc-b");
    check(await page.$eval("#aca-panel-schedule", (n) => n.classList.contains("active")), "schedule opens from its link");
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
    check((await page.textContent("#aca-scGrid")).includes("Jobs not assigned") && (await page.$$("#aca-scGrid .sc-chip[data-booking]")).length === (await page.$$("#aca-scGrid .sc-chip.none")).length + (await page.$$("#aca-scGrid .sc-chip.tracked")).length, "only jobs nobody is on sit in Jobs not assigned");
    await page.click("#aca-scGrid .sc-b.sc-k-job:not(.drive)");
    await page.waitForSelector('.sc-modal [data-m="more"]');
    await page.click('.sc-modal [data-m="more"]');
    check(await page.isVisible(".sc-modal .sc-people"), "a job bar's More people opens the people picker");
    await page.click('.sc-modal [data-m="cancel"]');
    // put someone on a job
    await page.click("#aca-scGrid .sc-chip.none");
    await page.waitForSelector(".sc-modal .sc-people input");
    await page.click('.sc-modal [data-m="drive"]');
    await page.waitForTimeout(150);
    check(await page.$eval(".sc-modal .sc-db", (n) => n.value) === "25", "drive time looked up and rounded up to 25");
    await page.check(".sc-modal .sc-people input >> nth=0");
    await page.click('.sc-modal [data-m="save"]');
    await page.waitForTimeout(150);
    const saved = await page.evaluate(() => window.__rpcCalls.filter((c) => c[0] === "schedule_save").map((c) => c[1].p));
    check(saved.length === 1 && saved[0].kind === "job" && saved[0].drive_before_min === 25 && /T\d\d:00:00.000Z$/.test(saved[0].starts_at), "saves a job bar with drive time");
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
    await page.click('#aca-teamBody [data-edit="u2"]');
    await page.fill("#aca-tmHours", "28");
    await page.click("#aca-tmSave");
    await page.waitForTimeout(150);
    check(await page.evaluate(() => window.__rpcCalls.some((c) => c[0] === "team_set_hours" && c[1].p_hours === 28 && c[1].p_user_id === "u2")), "saves weekly hours");
    check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await page.close();
  }

  console.log("Staff (bookings edit, parents view)");
  {
    const { page, errors } = await open(browser, port, "?as=staff", "#partners/orgs");
    const items = await rail(page);
    check(JSON.stringify(items) === JSON.stringify(["today", "bookings", "calc", "requests", "makeups", "retakes", "schedule", "myday"]), "menu limited to their pages: " + items.join(","));
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
