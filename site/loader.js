// Loads the current 207 Admin build. Speed (2026-10-24): current.json (never cached) names the build's versioned
// file, which never changes once uploaded, so the phone keeps it (browser cache + sw.js) and only downloads the app
// again after a deploy. With no answer from current.json in 2.5 s (offline, a slow network) the last build this
// device used loads instead; with neither, the old always-fresh address (see admin-page/deploy.sh).
(function () {
  var BASE = "https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/";
  var KEY = "aca-build", done = false;
  function last() { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
  function load(js) {
    if (done) return; done = true;
    var s = document.createElement("script");
    s.src = js ? BASE + js : BASE + "207-admin.js?v=" + Math.floor(Date.now() / 60000);
    if (js) s.onerror = function () { done = false; load(""); };
    document.body.appendChild(s);
  }
  // The service worker (sw.js) keeps the app's files on this device; it also shows push notifications.
  if ("serviceWorker" in navigator) { try { navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () {}); } catch (e) {} }
  var timer = setTimeout(function () { load(last()); }, 2500);
  fetch(BASE + "current.json?t=" + Date.now(), { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
    clearTimeout(timer);
    var js = c && typeof c.js === "string" && /^v\/207-admin\.[0-9a-f]{12}\.js$/.test(c.js) ? c.js : "";
    if (js) { try { localStorage.setItem(KEY, js); } catch (e) {} }
    load(js || last());
  }, function () { clearTimeout(timer); load(last()); });
})();
