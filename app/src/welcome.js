  // ================================================================ WELCOME: GET THE PHONE APP (2026-10-22)
  // https://admin.207photo.com/#welcome, linked from the welcome email new staff get (SQL team_send_welcome).
  // Shown before sign-in, in a browser tab only (the home-screen app goes straight to sign-in).
  //   Android / desktop Chrome: a one-tap Install button (beforeinstallprompt), menu steps if the browser gives none.
  //   iPhone: an app can't install itself there, so pictures of the taps: Share, Add to Home Screen, Add.
  const Welcome = (function () {
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(ua);
    const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    // iPhone browsers other than Safari: Chrome / Firefox / Edge can add to the home screen too (iOS 16.4+);
    // an app's built-in browser (Gmail, Outlook, Facebook) can't, and has no "Safari/" in its user agent.
    const iosOther = isIOS && /CriOS|FxiOS|EdgiOS/.test(ua);
    const iosInApp = isIOS && !iosOther && !/Safari\//.test(ua);
    let deferred = null, installed = false, onPrompt = null;
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; if (onPrompt) onPrompt(); });
    window.addEventListener("appinstalled", () => { installed = true; deferred = null; if (onPrompt) onPrompt(); });

    const wanted = () => /^#welcome\b/.test(location.hash) && !standalone();

    // Small pictures of what they tap. Icons are drawn like iOS's own (Share, Add to Home Screen).
    const SHARE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8 9H6.5A1.5 1.5 0 0 0 5 10.5v9A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 17.5 9H16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12 15V3M8 6.5 12 2.6l4 3.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const PLUS = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    const DOTS = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>';
    const KEBAB = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>';
    const icon = (svg) => '<span class="wl-ic">' + svg + "</span>";
    const step = (n, html, pic) => '<li class="wl-step"><span class="wl-n">' + n + '</span><div class="wl-body">' + html + (pic ? '<div class="wl-pic" aria-hidden="true">' + pic + "</div>" : "") + "</div></li>";

    // Safari's bottom bar (iOS 26: back, address, more; older: share in the middle).
    const PIC_BAR = '<div class="wl-bar"><span class="wl-addr">admin.207photo.com</span><span class="wl-hot">' + DOTS + '</span></div>' +
      '<div class="wl-or">or, on older iPhones</div><div class="wl-bar"><span>&#8249;</span><span>&#8250;</span><span class="wl-hot">' + SHARE + "</span><span>&#9783;</span><span>&#10697;</span></div>";
    const PIC_SHEET = '<div class="wl-sheet"><div class="wl-row">Copy</div><div class="wl-row">Add to Favorites</div><div class="wl-row wl-hotrow">Add to Home Screen ' + PLUS + '</div><div class="wl-row">Find on Page</div></div>';
    const PIC_ADD = '<div class="wl-sheet"><div class="wl-head"><span>Cancel</span><b>Add to Home Screen</b><span class="wl-hottxt">Add</span></div>' +
      '<div class="wl-app"><img src="https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/icons/apple-touch-icon.png" alt="" /><span>207 Admin</span></div>' +
      '<div class="wl-row">Open as Web App <span class="wl-tog"></span></div></div>';
    const PIC_HOME = '<div class="wl-home"><span class="wl-dot"></span><span class="wl-dot"></span><span class="wl-appic"><img src="https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/icons/apple-touch-icon.png" alt="" /><small>207 Admin</small></span><span class="wl-dot"></span></div>';

    function iosSteps() {
      const tip = iosInApp
        ? '<div class="wl-tip"><b>Open this page in Safari first.</b> You are in another app&#8217;s browser, which can&#8217;t add to your home screen. Tap ' + icon(SHARE) + ' or ' + icon(DOTS) + ' and pick <b>Open in Safari</b>, or copy the link and paste it into Safari.<button type="button" class="small" id="aca-wlCopy">Copy link</button></div>'
        : iosOther ? '<div class="wl-tip">In Chrome, the Share button ' + icon(SHARE) + ' is at the top right, next to the address. The other steps are the same.</div>' : "";
      return tip + '<ol class="wl-steps">' +
        step(1, "Tap " + icon(DOTS) + " at the bottom right, then " + icon(SHARE) + " <b>Share</b>.", PIC_BAR) +
        step(2, "Scroll down and tap <b>Add to Home Screen</b> " + icon(PLUS) + ". Tap <b>More</b> or <b>Edit Actions</b> if it isn&#8217;t in the list.", PIC_SHEET) +
        step(3, "Tap <b>Add</b> at the top right.", PIC_ADD) +
        step(4, "Open <b>207 Admin</b> from your home screen and sign in with the email and temporary password we sent you.", PIC_HOME) +
        step(5, NOTIF_STEP) + "</ol>";
    }
    // The last step everywhere (2026-10-24): notifications only work in the home-screen app, so they're turned on there.
    const NOTIF_STEP = "When it asks, tap <b>Turn on for this device</b> so you hear about jobs offered to you and changes to your schedule. " +
      "(Later: tap your name at the top right, then <b>Notifications</b>.)";
    function androidSteps() {
      return '<ol class="wl-steps">' +
        step(1, "In Chrome, tap " + icon(KEBAB) + " at the top right.") +
        step(2, "Tap <b>Add to home screen</b> or <b>Install app</b>, then <b>Install</b>.") +
        step(3, "Open <b>207 Admin</b> from your home screen and sign in with the email and temporary password we sent you.", PIC_HOME) +
        step(4, NOTIF_STEP) + "</ol>" +
        '<p class="wl-small">Samsung Internet: tap &#9776;, then <b>Add page to</b> &#8594; <b>Home screen</b>.</p>';
    }

    function render() {
      const box = el("wlBody");
      if (installed) {
        box.innerHTML = '<div class="wl-done"><span class="pill ok">Installed</span><p>Open <b>207 Admin</b> from your home screen and sign in with the email and temporary password we sent you.</p></div>';
        return;
      }
      if (deferred) {
        box.innerHTML = '<p class="wl-lead">One tap puts 207 Admin on your ' + (isAndroid ? "home screen" : "computer") + ".</p>" +
          '<button type="button" class="primary wl-install" id="aca-wlInstall">Install 207 Admin</button>' +
          '<p class="wl-small">Then open it from your ' + (isAndroid ? "home screen" : "apps") + " and sign in with the email and temporary password we sent you.</p>";
        el("wlInstall").addEventListener("click", async () => {
          const d = deferred; if (!d) return;
          d.prompt();
          const { outcome } = await d.userChoice.catch(() => ({ outcome: "dismissed" }));
          if (outcome === "accepted") { installed = true; deferred = null; }
          render();
        });
        return;
      }
      if (isIOS) box.innerHTML = '<p class="wl-lead">Four taps put 207 Admin on your home screen, like any other app.</p>' + iosSteps();
      else if (isAndroid) box.innerHTML = '<p class="wl-lead">Put 207 Admin on your home screen, like any other app.</p>' + androidSteps();
      else box.innerHTML = '<p class="wl-lead"><b>Open this on your phone.</b> Open the welcome email on your phone and tap the link there, and this page shows you the taps for your phone.</p>' +
        '<p class="wl-small">On this computer you can sign in at <b>admin.207photo.com</b> any time.</p>';
      const c = el("wlCopy");
      if (c) c.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText("https://admin.207photo.com/#welcome"); c.textContent = "Copied"; } catch (_e) { c.textContent = "admin.207photo.com/#welcome"; }
      });
    }

    // Shows the page; done() carries on to sign-in (the "already set up" link).
    function show(done) {
      el("welcomeView").classList.remove("hidden");
      el("loginView").classList.add("hidden");
      el("dashView").classList.add("hidden");
      render();
      onPrompt = render;
      el("wlSkip").addEventListener("click", () => {
        onPrompt = null;
        history.replaceState(null, "", location.pathname + location.search);
        el("welcomeView").classList.add("hidden");
        done();
      });
    }

    return { wanted, show };
  })();
