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
    check(JSON.stringify(items) === JSON.stringify(["today", "bookings", "jobs", "hubact", "calc", "requests", "makeups", "retakes", "searchlog", "orgs", "outbox", "library", "sending", "team"]), "menu has every page: " + items.join(","));
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

  console.log("Staff (bookings edit, parents view)");
  {
    const { page, errors } = await open(browser, port, "?as=staff", "#partners/orgs");
    const items = await rail(page);
    check(JSON.stringify(items) === JSON.stringify(["today", "bookings", "calc", "requests", "makeups", "retakes"]), "menu limited to their pages: " + items.join(","));
    check(await page.$eval("#aca-panel-today", (n) => n.classList.contains("active")), "a link to a page they can't see lands on Today");
    const calls = await page.evaluate(() => window.__rpcCalls.map((c) => c[0]));
    const forbidden = calls.filter((n) => /^(admin_outbox|admin_hub|admin_lookup|prospect_|admin_morning|team_|admin_job)/.test(n));
    check(forbidden.length === 0, "never calls RPCs for other modules" + (forbidden.length ? ": " + forbidden.join(",") : ""));
    check(!(await shown(page, "#aca-syncNowBtn")), "Sync now hidden");
    check(await visible(page, "#aca-bookBtn"), "Book a job shown (bookings edit)");
    check(!(await visible(page, "#aca-todayOutBox")) && !(await visible(page, "#aca-todayDigestBox")) && await visible(page, "#aca-todayUpBox"), "Today shows only Coming up");
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
