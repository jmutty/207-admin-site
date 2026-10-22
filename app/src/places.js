
  // ---- Google Maps place search (2026-10-22)
  // Places.attach(input, opts) turns a text box into a Google Maps search: typing 3+ letters shows suggestions
  // under it, and a pick fills the box. The edge function place-search holds the key. Typing by hand still works;
  // if Google is unreachable or refuses, the box says so once (in opts.note) and stays a plain text box.
  //   opts.kind  "address" (default): fills "Name, full street address" (Place Details).
  //              "town": cities and towns only; fills just the town name.
  //   opts.note  optional element under the box: shows opts.hint, an "Open in Google Maps" link after a pick,
  //              and Google's refusal if there is one.
  // A pick fires "change" on the input (on the blur, and again once the full address arrives), so code that
  // saves on change keeps working.
  const Places = (() => {
    const css = `
  .aca .pl-wrap { position: relative; display: block; min-width: 0; }
  .aca .pl-list { position: absolute; z-index: 60; left: 0; right: 0; top: 100%; margin-top: 4px; max-height: 300px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); box-shadow: 0 6px 18px rgba(0,0,0,.12); }
  .aca .pl-list button { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; text-align: left; gap: 2px; width: 100%; height: auto; min-height: 48px; padding: 10px 12px; border: none; border-bottom: 1px solid var(--border); border-radius: 0; background: var(--surface); font-weight: 400; white-space: normal; }
  .aca .pl-list button strong { font-weight: 600; }
  .aca .pl-list button span { font-size: 12px; color: var(--muted); }
  .aca .pl-list button.on, .aca .pl-list button:hover { background: var(--surface-2); }
  .aca .pl-list .empty { padding: 10px 12px; font-size: 13px; color: var(--muted); }
  .aca .og-modal .pl-list { position: static; }   /* that dialog scrolls and would clip a floating list */
  .aca .pl-by { padding: 6px 12px; font-size: 11px; color: var(--muted); text-align: right; }
  `;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);
    const FN_URL = SUPABASE_URL + "/functions/v1/place-search";
    let refused = "";   // Google said no (e.g. the API is off): stop asking for the rest of the visit
    const mapLink = (loc) => '<a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(loc) + '" target="_blank" rel="noopener">Open in Google Maps</a>';
    const newSession = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : "");
    async function call(body) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Signed out.");
      const r = await fetch(FN_URL, { method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw Object.assign(new Error(j.error || "HTTP " + r.status), { status: r.status });
      return j;
    }

    function attach(input, opts) {
      opts = opts || {};
      const kind = opts.kind === "town" ? "town" : "address", note = opts.note || null, hint = opts.hint || "";
      const wrap = document.createElement("span"); wrap.className = "pl-wrap";
      input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
      const list = document.createElement("div"); list.className = "pl-list hidden"; list.setAttribute("role", "listbox");
      list.id = (input.id || "pl" + Math.random().toString(36).slice(2)) + "-places"; wrap.appendChild(list);
      Object.entries({ autocomplete: "off", spellcheck: "false", autocapitalize: "words", enterkeyhint: "search", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": list.id })
        .forEach(([k, v]) => input.setAttribute(k, v));
      let timer = null, seq = 0, places = [], active = -1, session = newSession();
      const say = (h) => { if (note) note.innerHTML = h; };
      if (note && !note.innerHTML.trim()) say(kind === "address" && input.value.trim() ? mapLink(input.value.trim()) : esc(hint));
      const close = () => { list.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); active = -1; };
      const paint = () => list.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === active));
      function show(q) {
        list.innerHTML = places.map((p, i) => '<button type="button" role="option" data-i="' + i + '"><strong>' + esc(p.name) + "</strong>" + (p.detail ? "<span>" + esc(p.detail) + "</span>" : "") + "</button>").join("") +
          (places.length ? "" : '<div class="empty">No Google Maps match for “' + esc(q) + '”. Keep typing, or leave it as typed.</div>') +
          '<div class="pl-by">Suggestions from Google Maps</div>';
        list.classList.remove("hidden"); input.setAttribute("aria-expanded", "true"); active = -1;
      }
      async function pick(i) {
        const p = places[i]; if (!p) return;
        close();
        // Set the value before leaving the box, so the browser's own "change" on blur carries the pick.
        input.value = kind === "town" ? p.name : p.name + (p.detail ? ", " + p.detail.replace(/, USA$/, "") : "");
        const first = input.value;
        input.blur();
        if (kind === "address") {
          say("Getting the address…");
          try {
            const g = await call({ place_id: p.id, session });
            const addr = (g.address || "").replace(/, USA$/, ""), name = g.name || p.name;
            if (addr) input.value = addr.toLowerCase().startsWith(name.toLowerCase()) ? addr : name + ", " + addr;
          } catch (e) { /* keep the suggestion text; it is still a good address */ }
          if (input.value !== first) input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        session = newSession();
        say(kind === "address" ? mapLink(input.value) : esc(hint));
      }
      // The town filled in for you elsewhere (data-auto) is a placeholder: the first tap selects it so typing replaces it.
      input.addEventListener("focus", () => { if (input.dataset.auto) { delete input.dataset.auto; const v = input.value; input.select(); setTimeout(() => { if (input.value === v) input.select(); }, 0); } });
      input.addEventListener("input", () => {
        clearTimeout(timer); delete input.dataset.auto;
        const q = input.value.trim();
        if (refused) { close(); return; }
        say(esc(hint));
        if (q.length < 3) { close(); return; }
        timer = setTimeout(async () => {
          const mine = ++seq;
          try {
            const j = await call({ q, session, kind });
            if (mine !== seq || input.value.trim() !== q) return;
            places = j.places || []; show(q);
          } catch (e) {
            if (mine !== seq) return;
            close(); refused = e.message; say(esc(refused));
          }
        }, 250);
      });
      input.addEventListener("keydown", (e) => {
        if (list.classList.contains("hidden") || !places.length) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : places.length - 1)) % places.length; paint(); }
        else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(active); }
        else if (e.key === "Escape") { e.stopPropagation(); close(); }
      });
      // Keep the input focused while a suggestion is tapped (iPhone fires blur before click), then close on blur.
      list.addEventListener("mousedown", (e) => e.preventDefault());
      list.addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) pick(Number(b.dataset.i)); });
      input.addEventListener("blur", () => setTimeout(close, 150));
      return { close };
    }
    return { attach, mapLink };
  })();
