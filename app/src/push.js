  // ================================================================ PUSH NOTIFICATIONS (2026-10-21)
  // Account menu -> Notifications. Turns phone / desktop notifications on for this device (service
  // worker /sw.js on admin.207photo.com + a Web Push subscription stored by push_subscribe), and lets the
  // person pick which kinds they get. Which kinds exist and who may get them is SQL (push_topics: one per
  // module); sending is the push-sender edge function. On iPhone this only works in the home-screen app.
  const Push = (function () {
    const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    let modal = null, settings = null;

    function keyBytes(b64) {
      const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
      return Uint8Array.from(s, (c) => c.charCodeAt(0));
    }
    async function registration() {
      try { return await navigator.serviceWorker.register("/sw.js", { scope: "/" }); } catch (_e) { return null; }
    }
    async function currentSub() {
      if (!supported()) return null;
      const reg = await navigator.serviceWorker.getRegistration("/");
      return reg ? reg.pushManager.getSubscription() : null;
    }
    async function loadSettings() {
      const { data, error } = await supabase.rpc("push_my_settings");
      if (error) throw error;
      settings = data;
    }

    async function open() {
      el("whoMenu").classList.add("hidden");
      modal = openModal('<h2>Notifications</h2><div id="aca-pnBody"><p class="muted">Loading&#8230;</p></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="primary" id="aca-pnDone">Done</button></div>', { onClose: () => { modal = null; } });
      el("pnDone").addEventListener("click", () => modal.close());
      render();
    }

    async function render() {
      const body = el("pnBody"); if (!body) return;
      try { await loadSettings(); } catch (e) { body.innerHTML = '<div class="inline-error">' + esc(e.message || e) + "</div>"; return; }
      const sub = await currentSub();
      const here = sub && settings.devices.some((d) => d.endpoint === sub.endpoint);
      let state;
      if (!supported()) {
        state = isIOS && !standalone()
          ? "<p>On iPhone, notifications work in the home-screen app. In Safari tap <b>Share</b> &#8594; <b>Add to Home Screen</b>, open <b>207 Admin</b> from your home screen, then come back here.</p>"
          : '<p class="muted">This browser can&#8217;t show notifications.</p>';
      } else if (Notification.permission === "denied") {
        state = "<p>Notifications are blocked for 207 Admin on this device. " + (isIOS ? "Allow them in iPhone <b>Settings &#8594; Notifications &#8594; 207 Admin</b>" : "Allow them in this site&#8217;s browser settings") + ", then come back here.</p>";
      } else if (here) {
        state = '<p><span class="pill ok">On for this device</span></p><div class="pn-row"><button type="button" class="small" id="aca-pnTest">Send a test</button><button type="button" class="small" id="aca-pnOff">Turn off on this device</button></div>';
      } else {
        state = "<p>Get a notification on this " + (isIOS || /Android/.test(navigator.userAgent) ? "phone" : "computer") + " when something needs you.</p>" +
          '<button type="button" class="primary" id="aca-pnOn">Turn on for this device</button>';
      }
      const topics = settings.topics.length
        ? '<h3 class="pn-h">What to notify you about</h3>' + settings.topics.map((t) =>
            '<label class="pn-topic"><input type="checkbox" data-topic="' + esc(t.key) + '"' + (t.enabled ? " checked" : "") + ' /><span><b>' + esc(t.label) + '</b><br><span class="muted">' + esc(t.description) + "</span></span></label>").join("")
        : '<p class="muted">None of your areas have notifications yet.</p>';
      const others = settings.devices.filter((d) => !sub || d.endpoint !== sub.endpoint);
      const devices = others.length
        ? '<h3 class="pn-h">Your other devices</h3>' + others.map((d) => '<div class="pn-dev"><span>' + esc(d.label || "Device") + ' <span class="muted">since ' + esc(fmtDate(d.created_at)) + '</span></span><button type="button" class="small" data-off="' + esc(d.id) + '">Turn off</button></div>').join("")
        : "";
      body.innerHTML = '<div class="inline-error hidden" id="aca-pnErr"></div>' + state + topics + devices;
      wire();
    }

    function fail(e) { const n = el("pnErr"); if (n) { n.textContent = e.message || String(e); n.classList.remove("hidden"); } }

    function wire() {
      const on = el("pnOn");
      if (on) on.addEventListener("click", async () => {
        on.disabled = true;
        try {
          // Ask first, straight from the tap (iPhone requires it).
          const perm = await Notification.requestPermission();
          if (perm !== "granted") { render(); return; }
          if (!settings.vapid_public) {
            await supabase.rpc("push_request_setup");
            await new Promise((r) => setTimeout(r, 4000));
            await loadSettings();
            if (!settings.vapid_public) throw new Error("Notifications are still being set up. Try again in a minute.");
          }
          const reg = await registration();
          if (!reg) throw new Error("This site isn't ready for notifications yet (no /sw.js). Ask someone with full access.");
          await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(settings.vapid_public) });
          const j = sub.toJSON();
          const { error } = await supabase.rpc("push_subscribe", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_label: deviceLabel() });
          if (error) throw error;
          toast("Notifications are on for this device.");
          render();
        } catch (e) { fail(e); on.disabled = false; }
      });
      const off = el("pnOff");
      if (off) off.addEventListener("click", async () => {
        try {
          const sub = await currentSub();
          if (sub) { await supabase.rpc("push_unsubscribe", { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
          toast("Notifications are off for this device.");
          render();
        } catch (e) { fail(e); }
      });
      const test = el("pnTest");
      if (test) test.addEventListener("click", async () => {
        const { data, error } = await supabase.rpc("push_test");
        if (error) return fail(error);
        toast(data && data.ok ? "Test sent. It should arrive in a few seconds." : data && data.error === "wait" ? "A test was just sent. Try again in a minute." : "Couldn't send a test.", !(data && data.ok));
      });
      el("pnBody").querySelectorAll("[data-topic]").forEach((c) => c.addEventListener("change", async () => {
        const { error } = await supabase.rpc("push_set_pref", { p_topic: c.dataset.topic, p_enabled: c.checked });
        if (error) { c.checked = !c.checked; fail(error); }
      }));
      el("pnBody").querySelectorAll("[data-off]").forEach((b) => b.addEventListener("click", async () => {
        const { error } = await supabase.rpc("push_unsubscribe", { p_id: b.dataset.off });
        if (error) return fail(error);
        render();
      }));
    }

    // Tapping a notification while the app is open: the service worker asks this page to go there.
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.go) { const h = new URL(e.data.go, location.origin).hash; if (h && h !== location.hash) location.hash = h; }
    });

    return { open };
  })();
  el("notifBtn").addEventListener("click", () => Push.open());

