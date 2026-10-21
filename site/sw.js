// 207 Admin service worker: shows push notifications and opens the right page when one is tapped.
// No caching: the app always loads fresh from the network. Payload: {title, body, url, tag} (push-sender).
const ICON = "https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/icons/admin-icon-192.png";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

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
