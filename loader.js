// Loads the current 207 Admin build. The ?v= minute stamp stops the storage CDN from serving a
// stale copy after a deploy (see admin-page/deploy.sh).
(function () {
  var s = document.createElement("script");
  s.src = "https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/207-admin.js?v=" + Math.floor(Date.now() / 60000);
  document.body.appendChild(s);
})();
