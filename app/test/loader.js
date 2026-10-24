// site/loader.js + site/sw.js (speed, 2026-10-24): the loader asks current.json which build to load, the service
// worker keeps that build on the device, and a reload doesn't download it again. Supabase and jsdelivr are faked.
//   NODE_PATH=/opt/node-tools/node_modules node test/loader.js
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const SITE = path.join(__dirname, "..", "..", "site");
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const f = path.join(SITE, decodeURIComponent(req.url.split("?")[0]) === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(SITE) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});

let failures = 0;
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) failures++; };
const STORE = "https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/";

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ serviceWorkers: "allow" });
  const hits = {}; let current = { js: "v/207-admin.aaaaaaaaaaaa.js" }, currentOk = true;
  const count = (k) => { hits[k] = (hits[k] || 0) + 1; };
  await ctx.route("https://cdn.jsdelivr.net/**", (r) => { count("supabase-js"); r.fulfill({ status: 200, contentType: "application/javascript", body: "window.supabase = {};" }); });
  await ctx.route(STORE + "**", (r) => {
    const u = r.request().url().slice(STORE.length).split("?")[0];
    count(u);
    if (u === "current.json") return currentOk ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) }) : r.abort();
    const m = /^v\/207-admin\.([0-9a-f]{12})\.js$/.exec(u);
    if (m) return r.fulfill({ status: 200, contentType: "application/javascript", body: "window.__build = '" + m[1] + "';" });
    if (u === "207-admin.js") return r.fulfill({ status: 200, contentType: "application/javascript", body: "window.__build = 'old';" });
    r.fulfill({ status: 404, body: "" });
  });
  // index.html pins supabase-js with an integrity hash the fake can't match: drop it for the test.
  await ctx.route(`http://127.0.0.1:${port}/`, async (r) => {
    const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8").replace(/ integrity="[^"]*"/, "");
    r.fulfill({ status: 200, contentType: "text/html", body: html });
  });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  const build = async () => { await page.waitForFunction(() => window.__build, null, { timeout: 5000 }).catch(() => {}); return page.evaluate(() => window.__build); };

  await page.goto(`http://127.0.0.1:${port}/`);
  check((await build()) === "aaaaaaaaaaaa", "first visit loads the build current.json names");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(300);
  await page.reload(); // the first visit ran before the service worker was installed; this one stores the build
  check((await build()) === "aaaaaaaaaaaa", "reload: same build");
  const before = hits["v/207-admin.aaaaaaaaaaaa.js"];
  await page.waitForTimeout(300);
  await page.reload(); await build();
  await page.reload(); await build();
  check(hits["v/207-admin.aaaaaaaaaaaa.js"] === before, "two more visits: the build comes from the device (" + before + " downloads in all)");
  check(hits["current.json"] === 4, "current.json asked every visit (" + hits["current.json"] + ")");

  current = { js: "v/207-admin.bbbbbbbbbbbb.js" };
  await page.reload();
  check((await build()) === "bbbbbbbbbbbb", "after a deploy the next visit loads the new build");

  currentOk = false;
  await page.reload();
  check((await build()) === "bbbbbbbbbbbb", "current.json unreachable: the last build this device used loads");
  check(hits["v/207-admin.bbbbbbbbbbbb.js"] === 1, "  ... from the device, not the network (" + hits["v/207-admin.bbbbbbbbbbbb.js"] + ")");

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  check((await build()) === "old", "nothing known and no current.json: the old address loads");

  check(!errors.length, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})();
