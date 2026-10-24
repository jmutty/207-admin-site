// 207 Admin service worker: shows push notifications and opens the right page when one is tapped.
// Payload: {title, body, url, tag} (push-sender).
// Speed (2026-10-24): files that never change once published are kept on the device: the app's versioned builds
// (admin-app/v/207-admin.<hash>.js, see loader.js), supabase-js at its pinned version, and the font files. Everything
// else (this page, current.json, the data) always comes from the network. The newest 3 builds are kept.
const ICON = "https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/icons/admin-icon-192.png";
const CACHE = "aca-files-1";
const KEEP = [
  /^https:\/\/socluffmclkdljtmiexw\.supabase\.co\/storage\/v1\/object\/public\/admin-app\/v\/207-admin\.[0-9a-f]{12}\.js$/,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@\d+\.\d+\.\d+\//,
  /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
];
const BUILD = /\/admin-app\/v\/207-admin\.[0-9a-f]{12}\.js$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(Promise.all([self.clients.claim(),
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("aca-files-") && k !== CACHE).map((k) => caches.delete(k))))])));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !KEEP.some((r) => r.test(req.url))) return;
  e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
    // opaque (no-cors script tags) or ok: worth keeping; an error page is not
    if (res.ok || res.type === "opaque") {
      e.waitUntil(c.put(req, res.clone()).then(() => (BUILD.test(req.url) ? trimBuilds(c) : null)).catch(() => {}));
    }
    return res;
  }))));
});
// Keep the 3 newest builds (by when they were stored; keys() lists them in insertion order).
function trimBuilds(c) {
  return c.keys().then((ks) => { const b = ks.filter((k) => BUILD.test(k.url)); return Promise.all(b.slice(0, Math.max(0, b.length - 3)).map((k) => c.delete(k))); });
}

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_e) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "207 Admin", {
    body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag, icon: ICON, badge: ICON, data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
    const w = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (w) { w.postMessage({ go: url }); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
