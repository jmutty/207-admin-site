// Last-seen pages (speed, 2026-10-24): a page opened before draws at once from this device's copy (Snap) while
// the fresh rows load, and a different person signing in never sees the last person's copy. Run after build.py:
//   NODE_PATH=/opt/node-tools/node_modules node test/snap.js
// The harness is opened once normally (fills the copies), then with ?slow=3000 (every read waits 3 s): within a
// second each page must show its content, not "Loading".
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
const ORG = "11111111-1111-1111-1111-111111111111";
const PAGES = [
  ["Today", "#today", "#aca-todayList", (t) => /Open/.test(t) && !/Checking everything/.test(t)],
  ["All jobs", "#jobs/bookings", "#aca-bkBody", (t) => t.length > 40 && !/Loading/.test(t)],
  ["Job page", "#jobs/job/bk1", "#aca-panel-job", (t) => /Overview/.test(t) && !/Loading/.test(t)],
  ["Partners", "#partners/orgs", "#aca-ogBody", (t) => t.length > 40 && !/Loading/.test(t)],
  ["Partner page", "#partners/org/" + ORG, "#aca-panel-org", (t) => /Overview/.test(t) && !/^\s*Loading/.test(t)],
  ["Schedule", "#staff/schedule", "#aca-scGrid", (t) => t.length > 40 && !/Loading/.test(t)],
];

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const url = (q, h) => `http://127.0.0.1:${port}/test/harness.html${q}${h}`;
  const watch = (page) => { page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); };

  console.log("First visit fills the copies");
  for (const [name, hash] of PAGES) {
    const page = await ctx.newPage(); watch(page);
    await page.goto(url("", hash));
    await page.waitForSelector("#aca-nav button[data-tab]");
    await page.waitForTimeout(1200);
    await page.close();
  }
  const keys = await (async () => { const p = await ctx.newPage(); await p.goto(url("", "#today")); await p.waitForTimeout(800);
    const k = await p.evaluate(() => Object.keys(localStorage).filter((x) => x.startsWith("aca-snap:u1:"))); await p.close(); return k; })();
  check(PAGES.length <= keys.length, "copies saved: " + keys.map((k) => k.slice(12)).join(", "));

  console.log("Second visit, every read 3 s slow: each page draws from its copy");
  for (const [name, hash, sel, ok] of PAGES) {
    const page = await ctx.newPage(); watch(page);
    await page.goto(url("?slow=3000", hash));
    await page.waitForSelector("#aca-nav button[data-tab]");
    await page.waitForTimeout(900);
    const t = await page.$eval(sel, (n) => n.innerText).catch(() => "");
    check(ok(t), name + " shows at once: " + JSON.stringify(t.slice(0, 70)));
    if (name === "Today") check(/Still checking/.test(await page.$eval("#aca-todayList", (n) => n.innerText)), "Today says it is still checking");
    await page.waitForTimeout(3600); // the fresh rows arrive and replace the copy
    const t2 = await page.$eval(sel, (n) => n.innerText).catch(() => "");
    check(ok(t2), name + " still right after the fresh rows");
    await page.close();
  }

  console.log("Another person on this device never sees the copies");
  {
    const page = await ctx.newPage(); watch(page);
    await page.addInitScript(() => { // the mock's session, as someone else
      const orig = Object.getOwnPropertyDescriptor(window, "supabase");
      let v; Object.defineProperty(window, "supabase", { configurable: true, get: () => v, set: (x) => { v = { createClient: () => { const c = x.createClient(); const gs = c.auth.getSession;
        c.auth.getSession = async () => { const r = await gs(); if (r.data.session) r.data.session.user.id = "u9"; return r; }; return c; } }; } });
      void orig;
    });
    await page.goto(url("", "#today"));
    await page.waitForSelector("#aca-nav button[data-tab]");
    await page.waitForTimeout(800);
    const left = await page.evaluate(() => Object.keys(localStorage).filter((x) => x.startsWith("aca-snap:u1:")).length);
    check(left === 0, "the last person's copies are cleared (" + left + " left)");
    await page.close();
  }

  console.log("Sign out clears the copies");
  {
    const page = await ctx.newPage(); watch(page);
    await page.goto(url("", "#today"));
    await page.waitForSelector("#aca-nav button[data-tab]");
    await page.waitForTimeout(800);
    await page.click("#aca-whoBtn"); await page.click("#aca-signOutBtn").catch(() => {});
    await page.waitForTimeout(500);
    const left = await page.evaluate(() => Object.keys(localStorage).filter((x) => x.startsWith("aca-snap:")).length);
    check(left <= 1, "nothing left after Sign out (" + left + ")"); // the reload may save the new visit's who-marker
    await page.close();
  }

  check(!errors.length, "no page errors" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})();
