
  // ---- Date and time pickers (2026-10-21)
  // Every <input type="date"> and <input type="time"> in the app gets a friendlier face: a button that
  // opens a month calendar, and a time box you can type into ("930", "2p", "14:15") or pick from a
  // 15-minute list. The real input stays in the page, hidden, and is still the source of truth, so the
  // code that reads .value, sets .value or listens for input/change keeps working unchanged.
  // Start/end pairs: give the end input data-dp-after="<selector of its start, within the same parent>".
  // Setting the start then fills an empty end with start + 2 hours (data-dp-len, in minutes), and moving
  // a start that already has an end keeps the same length. The end list shows each time's length.
  const Pickers = (() => {
    const css = `
  .aca .dp-native { display: none !important; }
  .aca button.dp-face { font-weight: 400; justify-content: flex-start; gap: 8px; min-width: 150px; padding: 0 10px; border-color: var(--border); color: var(--text); }
  .aca button.dp-face.dp-empty { color: var(--faint); }
  .aca button.dp-face svg, .aca .dp-tbox svg { flex: 0 0 auto; color: var(--muted); }
  .aca .dp-tbox { position: relative; display: inline-flex; align-items: center; vertical-align: middle; }
  .aca .dp-tbox svg { position: absolute; left: 9px; pointer-events: none; }
  .aca .dp-tbox input.dp-time[type=text] { width: 108px; padding-left: 30px; }
  .aca td button.dp-face { width: 100%; min-width: 0; }
  .aca button.dp-face[aria-expanded=true], .aca .dp-tbox input.dp-time[aria-expanded=true] { border-color: var(--accent); }
  .aca .dp-pop { position: fixed; z-index: 9997; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 8px 28px rgba(31,30,27,.16); font-size: 13px; }
  .aca .dp-cal { width: 272px; padding: 10px; }
  .aca .dp-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .aca .dp-head strong { font-size: 14px; }
  .aca .dp-head button { width: 30px; padding: 0; justify-content: center; border-color: transparent; font-size: 16px; }
  .aca .dp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .aca .dp-grid .dp-wd { text-align: center; color: var(--faint); font-size: 11px; font-weight: 600; padding: 2px 0 4px; }
  .aca .dp-grid button { height: 34px; padding: 0; justify-content: center; border-color: transparent; font-weight: 400; font-variant-numeric: tabular-nums; }
  .aca .dp-grid button.dp-out { color: var(--faint); }
  .aca .dp-grid button.dp-today { border-color: var(--accent); }
  .aca .dp-grid button.dp-sel, .aca .dp-grid button.dp-sel:hover:not(:disabled) { background: var(--accent); color: var(--accent-text); font-weight: 600; }
  .aca .dp-grid button:disabled { opacity: .3; }
  .aca .dp-foot { display: flex; justify-content: space-between; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line2); }
  .aca .dp-list { width: 190px; max-height: 260px; overflow-y: auto; padding: 4px; }
  .aca .dp-list button { display: flex; width: 100%; justify-content: space-between; border-color: transparent; font-weight: 400; font-variant-numeric: tabular-nums; }
  .aca .dp-list button span { color: var(--faint); }
  .aca .dp-list button.dp-hi { background: var(--surface-2); }
  .aca .dp-list button.dp-sel { color: var(--accent); font-weight: 600; }
  @media (max-width: 760px) {
    .aca button.dp-face { min-height: 40px; font-size: 16px; }
    .aca .dp-tbox input.dp-time[type=text] { width: 124px; }
    .aca .dp-grid button { height: 40px; font-size: 15px; }
    .aca .dp-list button { min-height: 40px; font-size: 15px; }
  }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    const ICON_CAL = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5 1.5v3M11 1.5v3"/></svg>';
    const ICON_CLOCK = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.6"/></svg>';
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const raw = (inp) => VALUE.get.call(inp);
    const pad = (n) => String(n).padStart(2, "0");
    const ymd = (dt) => dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate());
    const parseYmd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
    const fmtDate = (s) => { const dt = parseYmd(s); return dt ? dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : ""; };
    const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; };
    const toHhmm = (min) => pad(Math.floor(min / 60)) + ":" + pad(min % 60);
    const fmtTime = (s) => { const m = toMin(s); if (m == null) return ""; const h = Math.floor(m / 60); return ((h % 12) || 12) + ":" + pad(m % 60) + " " + (h < 12 ? "AM" : "PM"); };
    const fmtLen = (n) => n < 60 ? n + " min" : (n % 60 ? (n / 60).toFixed(n % 30 ? 2 : 1) : n / 60) + (n === 60 ? " hr" : " hrs");

    // Typed time -> "HH:MM" or null. Without am/pm, 7 through 11 read as morning and 12 through 6 as
    // afternoon; an end time reads as the first one after its start.
    function parseTime(txt, afterMin) {
      const t = String(txt || "").trim().toLowerCase().replace(/\s+/g, "");
      if (!t) return "";
      if (t === "noon") return "12:00";
      if (t === "midnight") return "00:00";
      const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?(a|p|am|pm|a\.m\.|p\.m\.)?$/.exec(t);
      if (!m) return null;
      let h = +m[1]; const mi = m[2] ? +m[2] : 0;
      if (mi > 59 || h > 23) return null;
      if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3][0] === "p" ? 12 : 0); }
      else if (h >= 1 && h <= 12) {
        const am = h % 12, pm = am + 12;
        if (afterMin != null) h = am * 60 + mi > afterMin ? am : pm;
        else h = h >= 7 && h <= 11 ? h : pm;
      }
      return toHhmm(Math.min(h * 60 + mi, 23 * 60 + 59));
    }

    function commit(inp, v) {
      const before = raw(inp);
      VALUE.set.call(inp, v); sync(inp);
      if (raw(inp) === before) return;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      if (inp._dpEnd) followStart(inp._dpEnd, toMin(before), toMin(raw(inp)));
    }
    // The start moved: fill an empty end, keep an existing length, or fix an end that is now before the start.
    function followStart(end, was, now) {
      if (now == null || end.disabled) return;
      const len = Number(end.dataset.dpLen) || 120, cur = toMin(raw(end));
      let next = now + len;
      if (cur != null && was != null && cur > was) next = now + (cur - was);
      else if (cur != null && cur > now && was == null) return;
      commit(end, toHhmm(Math.min(next, 23 * 60 + 55)));
    }

    function sync(inp) {
      const f = inp._dpFace; if (!f) return;
      const v = raw(inp);
      if (inp.type === "date") {
        f.querySelector("span").textContent = fmtDate(v) || inp.dataset.dpPlaceholder || "Pick a date";
        f.classList.toggle("dp-empty", !v);
      } else if (document.activeElement !== f.input) f.input.value = fmtTime(v);
      (f.input || f).disabled = inp.disabled;
    }

    // ---- the popover (one at a time)
    let pop = null;
    function closePop(focusBack) {
      if (!pop) return;
      const p = pop; pop = null;
      p.el.remove(); p.face.setAttribute("aria-expanded", "false");
      window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place);
      if (focusBack) p.face.focus();
    }
    function place() {
      if (!pop) return;
      if (!pop.face.isConnected) return closePop();
      const r = pop.face.getBoundingClientRect(), w = pop.el.offsetWidth, h = pop.el.offsetHeight;
      const vw = document.documentElement.clientWidth, vh = window.innerHeight;
      let top = r.bottom + 4; if (top + h > vh - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
      pop.el.style.top = Math.max(8, top) + "px";
      pop.el.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + "px";
    }
    function openPop(face, cls, label) {
      closePop();
      const box = document.createElement("div");
      box.className = "dp-pop " + cls; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", label);
      box.addEventListener("mousedown", (e) => e.preventDefault()); // a click inside keeps focus where it is (the time box stays focused)
      (document.querySelector(".aca") || document.body).appendChild(box);
      pop = { el: box, face };
      face.setAttribute("aria-expanded", "true");
      window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
      return box;
    }
    document.addEventListener("mousedown", (e) => { if (pop && !pop.el.contains(e.target) && !pop.face.contains(e.target)) closePop(); }, true);

    // ---- calendar
    function openCal(inp) {
      const face = inp._dpFace;
      const box = openPop(face, "dp-cal", "Choose a date");
      const min = parseYmd(inp.min), max = parseYmd(inp.max), today = ymd(new Date());
      let focus = parseYmd(raw(inp)) || new Date();
      function draw(keepFocus) {
        const y = focus.getFullYear(), mo = focus.getMonth(), first = new Date(y, mo, 1);
        const start = new Date(y, mo, 1 - first.getDay()), sel = raw(inp), f = ymd(focus);
        let cells = "";
        for (let i = 0; i < 42; i++) {
          const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), k = ymd(dt);
          if (i === 35 && dt.getMonth() !== mo) break;
          const off = (min && dt < min) || (max && dt > max);
          cells += '<button type="button" data-d="' + k + '" tabindex="' + (k === f ? 0 : -1) + '"' + (off ? " disabled" : "") +
            ' class="' + [dt.getMonth() !== mo ? "dp-out" : "", k === today ? "dp-today" : "", k === sel ? "dp-sel" : ""].join(" ").trim() + '"' +
            ' aria-label="' + dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) + '"' + (k === sel ? ' aria-pressed="true"' : "") + ">" + dt.getDate() + "</button>";
        }
        box.innerHTML = '<div class="dp-head"><button type="button" data-m="-1" aria-label="Previous month">&lsaquo;</button><strong>' + MONTHS[mo] + " " + y +
          '</strong><button type="button" data-m="1" aria-label="Next month">&rsaquo;</button></div><div class="dp-grid">' +
          ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => '<div class="dp-wd" aria-hidden="true">' + d + "</div>").join("") + cells +
          '</div><div class="dp-foot"><button type="button" class="small quiet" data-t="today">Today</button>' + (inp.required ? "" : '<button type="button" class="small quiet" data-t="clear">Clear</button>') + "</div>";
        place();
        if (keepFocus) { const b = box.querySelector('[data-d="' + f + '"]'); if (b) b.focus(); }
      }
      const move = (days, months) => { focus = months ? new Date(focus.getFullYear(), focus.getMonth() + months, Math.min(focus.getDate(), 28)) : new Date(focus.getFullYear(), focus.getMonth(), focus.getDate() + days); draw(true); };
      box.addEventListener("click", (e) => {
        const b = e.target.closest("button"); if (!b || b.disabled) return;
        if (b.dataset.m) return move(0, +b.dataset.m);
        if (b.dataset.d) { commit(inp, b.dataset.d); return closePop(true); }
        if (b.dataset.t === "today") { focus = new Date(); if ((!min || focus >= min) && (!max || focus <= max)) { commit(inp, ymd(focus)); return closePop(true); } return draw(true); }
        if (b.dataset.t === "clear") { commit(inp, ""); closePop(true); }
      });
      box.addEventListener("keydown", (e) => {
        const k = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
        if (k && e.target.dataset.d) { e.preventDefault(); return move(k, 0); }
        if (e.key === "PageUp" || e.key === "PageDown") { e.preventDefault(); return move(0, e.key === "PageUp" ? -1 : 1); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(true); }
        if (e.key === "Tab") closePop();
      });
      draw(true);
    }

    // ---- time list
    function startMin(inp) { const s = inp._dpStart; return s ? toMin(raw(s)) : null; }
    function openList(inp) {
      const face = inp._dpFace, f = face.input;
      const box = openPop(f, "dp-list", "Choose a time");
      const s = startMin(inp), from = s != null ? s + 15 : 0, sel = toMin(raw(inp));
      let html = "";
      for (let m = from; m < 24 * 60; m += 15) html += '<button type="button" tabindex="-1" data-t="' + toHhmm(m) + '"' + (m === sel ? ' class="dp-sel"' : "") + ">" + fmtTime(toHhmm(m)) + (s != null ? "<span>" + fmtLen(m - s) + "</span>" : "") + "</button>";
      box.innerHTML = html || '<div class="empty" style="padding:8px">No later times today.</div>';
      box.addEventListener("click", (e) => { const b = e.target.closest("button[data-t]"); if (b) { commit(inp, b.dataset.t); closePop(); f.select(); } });
      place();
      hilite(inp, sel != null ? sel : s != null ? s + 120 : 8 * 60, true);
    }
    // Highlight the list row nearest a time and scroll it into view.
    function hilite(inp, min, center) {
      if (!pop || pop.face !== inp._dpFace.input || min == null) return;
      const bs = [...pop.el.querySelectorAll("button[data-t]")]; if (!bs.length) return;
      let best = bs[0];
      bs.forEach((b) => { if (Math.abs(toMin(b.dataset.t) - min) < Math.abs(toMin(best.dataset.t) - min)) best = b; b.classList.remove("dp-hi"); });
      best.classList.add("dp-hi");
      const L = pop.el;
      if (center) L.scrollTop = best.offsetTop - L.clientHeight / 2 + best.offsetHeight / 2;
      else if (best.offsetTop < L.scrollTop || best.offsetTop + best.offsetHeight > L.scrollTop + L.clientHeight) best.scrollIntoView({ block: "nearest" });
    }

    function enhance(inp) {
      if (inp._dpFace || inp.closest(".dp-pop")) return;
      inp.classList.add("dp-native");
      Object.defineProperty(inp, "value", { configurable: true, get() { return raw(this); }, set(v) { VALUE.set.call(this, v); sync(this); } });
      const label = inp.getAttribute("aria-label") || inp.title || "";
      if (inp.type === "date") {
        const b = document.createElement("button");
        b.type = "button"; b.className = "dp-face" + (inp.classList.contains("small") ? " small" : "");
        b.setAttribute("aria-haspopup", "dialog"); b.setAttribute("aria-expanded", "false");
        if (label) b.setAttribute("aria-label", label + ", choose a date");
        if (inp.title) b.title = inp.title;
        if (inp.style.width) b.style.width = inp.style.width;
        b.innerHTML = ICON_CAL + "<span></span>";
        b.addEventListener("click", () => { if (pop && pop.face === b) closePop(); else openCal(inp); });
        b.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); openCal(inp); } });
        inp._dpFace = b; inp.after(b);
      } else {
        const w = document.createElement("span"), t = document.createElement("input");
        w.className = "dp-tbox"; w.innerHTML = ICON_CLOCK;
        t.type = "text"; t.className = "dp-time"; t.autocomplete = "off"; t.spellcheck = false;
        t.placeholder = inp.dataset.dpPlaceholder || "Time";
        t.setAttribute("aria-haspopup", "listbox"); t.setAttribute("aria-expanded", "false");
        if (label) t.setAttribute("aria-label", label);
        if (inp.title) t.title = inp.title;
        w.appendChild(t); w.input = t;
        inp._dpFace = w; inp.after(w);
        if (inp.dataset.dpAfter) {
          const s = inp.parentElement && inp.parentElement.querySelector(inp.dataset.dpAfter);
          if (s && s !== inp) { inp._dpStart = s; s._dpEnd = inp; }
        }
        const done = () => {
          const v = parseTime(t.value, startMin(inp));
          if (v === null) { t.value = fmtTime(raw(inp)); return; }
          commit(inp, v); t.value = fmtTime(v);
        };
        t.addEventListener("focus", () => { t.select(); openList(inp); });
        t.addEventListener("click", () => { if (!pop || pop.face !== t) openList(inp); });
        t.addEventListener("input", () => { const v = parseTime(t.value, startMin(inp)); if (v) hilite(inp, toMin(v)); });
        t.addEventListener("blur", () => { done(); setTimeout(() => { if (pop && pop.face === t && document.activeElement !== t) closePop(); }, 0); });
        t.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const h = pop && pop.face === t && pop.el.querySelector(".dp-hi");
            if (h && parseTime(t.value, startMin(inp)) === null) commit(inp, h.dataset.t); else done();
            t.value = fmtTime(raw(inp)); closePop(); t.select();
          }
          else if (e.key === "Escape" && pop && pop.face === t) { e.preventDefault(); e.stopPropagation(); t.value = fmtTime(raw(inp)); closePop(); }
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!pop || pop.face !== t) return openList(inp);
            const bs = [...pop.el.querySelectorAll("button[data-t]")], i = bs.findIndex((b) => b.classList.contains("dp-hi"));
            const n = bs[Math.max(0, Math.min(bs.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
            if (n) { t.value = fmtTime(n.dataset.t); hilite(inp, toMin(n.dataset.t)); }
          } else if (e.key === "Tab") closePop();
        });
      }
      sync(inp);
    }
    function scan(node) {
      if (!node.querySelectorAll) return;
      if (node.matches && node.matches("input[type=date], input[type=time]")) enhance(node);
      node.querySelectorAll("input[type=date], input[type=time]").forEach(enhance);
    }
    const appRoot = document.querySelector(".aca") || document.body;
    // A <label for> on a hidden input would focus nothing: send it to the face instead.
    appRoot.addEventListener("click", (e) => {
      const l = e.target.closest && e.target.closest("label[for]"); if (!l) return;
      const inp = document.getElementById(l.htmlFor); if (!inp || !inp._dpFace) return;
      e.preventDefault(); (inp._dpFace.input || inp._dpFace).focus();
    });
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach(scan))).observe(appRoot, { childList: true, subtree: true });
    scan(appRoot);
    return { parseTime, enhance };
  })();
