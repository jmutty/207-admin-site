  // ================================================================ INVENTORY QR LABELS AND SCANNING (2026-10-23)
  // A label holds https://admin.207photo.com/#ops/inventory/{i|k|b}/<uuid> (item, kit, bin). Any phone camera opens
  // it; inside the app, Scan reads it with the camera (BarcodeDetector where the browser has it, else jsQR).
  // Both QR libraries load from jsDelivr only when needed (the page's CSP already allows it), pinned with SRI.
  // Labels print on Avery 5160 / 8160 sheets (30 per page, 2-5/8" x 1"), or plain paper.
  const InvQR = (function () {
    const LIBS = {
      qrcode: ["https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js", "sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k"],
      jsQR: ["https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js", "sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx"],
    };
    const loading = {};
    function lib(name) {
      if (window[name]) return Promise.resolve(window[name]);
      if (!loading[name]) loading[name] = new Promise((ok, bad) => {
        const s = document.createElement("script");
        s.src = LIBS[name][0]; s.integrity = LIBS[name][1]; s.crossOrigin = "anonymous";
        s.onload = () => (window[name] ? ok(window[name]) : bad(new Error("Could not load the QR reader.")));
        s.onerror = () => { delete loading[name]; bad(new Error("Could not load the QR reader. Check the connection and try again.")); };
        document.head.appendChild(s);
      });
      return loading[name];
    }

    const BASE = "https://admin.207photo.com/";
    const link = (kind, id) => BASE + "#ops/inventory/" + kind + "/" + id;
    const KINDS = { i: "item", k: "kit", b: "bin" };
    function parse(text) {
      const m = /#ops\/inventory\/([ikb])\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(text || ""));
      return m ? { kind: KINDS[m[1].toLowerCase()], id: m[2].toLowerCase() } : null;
    }
    // A scanned label, or a typed serial number or bin code: { kind, id, name } or an Error with a reason.
    async function resolve(text) {
      const p = parse(text);
      const q = String(text || "").trim();
      if (p) {
        const view = p.kind === "item" ? "inventory_items_v" : p.kind === "kit" ? "inventory_kits_v" : "inventory_bins_v";
        const { data, error } = await supabase.from(view).select("*").eq("id", p.id).maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("That label is for something that was deleted.");
        return Object.assign({ row: data, name: data.name || "Bin " + data.code }, p);
      }
      if (!q) throw new Error("Nothing read.");
      const { data, error } = await supabase.rpc("inventory_search", { p_q: q });
      if (error) throw error;
      const lc = q.toLowerCase();
      const items = (data && data.items) || [], bins = (data && data.bins) || [], kits = (data && data.kits) || [];
      const exact = items.filter((r) => String(r.serial || "").toLowerCase() === lc);
      const bin = bins.filter((r) => String(r.code || "").toLowerCase() === lc);
      const kit = kits.filter((r) => String(r.name || "").toLowerCase() === lc);
      const one = exact.length === 1 ? ["item", exact[0]] : bin.length === 1 ? ["bin", bin[0]] : kit.length === 1 ? ["kit", kit[0]]
        : items.length === 1 && !kits.length && !bins.length ? ["item", items[0]] : null;
      if (!one) throw new Error(items.length + kits.length + bins.length ? "More than one thing matches “" + q + "”. Type the serial number, or use Find." : "Nothing matches “" + q + "”.");
      return { kind: one[0], id: one[1].id, row: one[1], name: one[1].name || "Bin " + one[1].code };
    }

    // ---------------------------------------------------------------- the camera
    // opts: { title, hint, top (extra html above the camera), continuous, onCode(text) -> Promise<{ok, msg}>, onClose }
    function scan(opts) {
      let stream = null, stopped = false, busy = false, last = "", lastAt = 0, timer = null;
      const m = openModal('<h2>' + esc(opts.title || "Scan a label") + "</h2>" + (opts.top || "") +
        '<div class="iq-cam"><video playsinline muted autoplay></video><div class="iq-aim"></div></div>' +
        '<p class="iq-msg muted" aria-live="polite">' + esc(opts.hint || "Point the camera at a QR label.") + "</p>" +
        '<ul class="iq-log"></ul>' +
        '<div class="field iq-type"><label for="aca-iqType">Or type a serial number or bin code</label><div class="iq-row"><input type="text" id="aca-iqType" autocomplete="off" /><button type="button" class="small" id="aca-iqGo">Go</button></div></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="primary" id="aca-iqDone">Done</button></div>',
        { onClose: () => { stop(); if (opts.onClose) opts.onClose(); } });
      if (window.matchMedia("(pointer: coarse)").matches && document.activeElement) document.activeElement.blur();   // no phone keyboard over the camera
      const video = m.querySelector("video"), msg = m.querySelector(".iq-msg"), log = m.querySelector(".iq-log");
      const say = (t, bad) => { msg.textContent = t; msg.classList.toggle("inline-error", !!bad); msg.classList.toggle("muted", !bad); };
      el("iqDone").addEventListener("click", () => m.close());
      const typed = () => { const v = el("iqType").value.trim(); if (v) { el("iqType").value = ""; got(v, true); } };
      el("iqGo").addEventListener("click", typed);
      el("iqType").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); typed(); } });   // no Enter reaching the next modal's button

      async function got(text, fromTyping) {
        if (busy) return;
        if (!fromTyping && text === last && Date.now() - lastAt < 3000) return;   // the same label still in view
        last = text; lastAt = Date.now(); busy = true;
        if (navigator.vibrate) navigator.vibrate(60);
        try {
          const r = (await opts.onCode(text)) || {};
          if (r.msg) { say(r.msg, r.ok === false); log.insertAdjacentHTML("afterbegin", '<li class="' + (r.ok === false ? "bad" : "") + '">' + esc(r.msg) + "</li>"); }
          if (r.ok !== false && !opts.continuous) { m.close(); return; }
        } catch (e) {
          const t = String((e && (e.message || e.details)) || e).replace(/^P0001:\s*/, "");
          say(t, true); log.insertAdjacentHTML("afterbegin", '<li class="bad">' + esc(t) + "</li>");
        } finally { busy = false; }
      }
      function stop() {
        stopped = true; clearTimeout(timer);
        if (stream) stream.getTracks().forEach((t) => t.stop());
      }
      (async function start() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say("This browser can't use the camera here. Type the serial number instead.", true); return; }
        try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }); }
        catch (e) { say(e && e.name === "NotAllowedError" ? "Camera blocked. Allow the camera for this site in Settings, or type the serial number." : "No camera found. Type the serial number instead.", true); return; }
        if (stopped) { stop(); return; }
        video.srcObject = stream;
        try { await video.play(); } catch (_e) { /* autoplay attribute covers it */ }
        let detect;
        try {
          if ("BarcodeDetector" in window && (await window.BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
            const bd = new window.BarcodeDetector({ formats: ["qr_code"] });
            detect = async () => { const r = await bd.detect(video); return r.length ? r[0].rawValue : null; };
          }
        } catch (_e) { detect = null; }
        if (!detect) {
          let reader;
          try { reader = await lib("jsQR"); } catch (e) { say(e.message, true); return; }
          const c = document.createElement("canvas"), cx = c.getContext("2d", { willReadFrequently: true });
          detect = async () => {
            const w = video.videoWidth, h = video.videoHeight;
            if (!w || !h) return null;
            const k = Math.min(1, 720 / Math.max(w, h));
            c.width = Math.round(w * k); c.height = Math.round(h * k);
            cx.drawImage(video, 0, 0, c.width, c.height);
            const r = reader(cx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: "dontInvert" });
            return r ? r.data : null;
          };
        }
        const tick = async () => {
          if (stopped) return;
          if (!busy && video.readyState >= 2) { try { const t = await detect(); if (t) await got(t); } catch (_e) { /* next frame */ } }
          if (!stopped) timer = setTimeout(tick, 180);
        };
        tick();
      })();
      return m;
    }

    // ---------------------------------------------------------------- labels
    // things: [{ kind: "i"|"k"|"b", id, title, sub }]. start: first empty label on the sheet (1-30).
    async function print(things, start) {
      if (!things.length) { toast("Nothing to print.", true); return; }
      const w = window.open("", "_blank");   // open first: a pop-up opened after an await gets blocked
      if (!w) { toast("Allow pop-ups to print labels.", true); return; }
      let qrcode;
      try { qrcode = await lib("qrcode"); } catch (e) { w.close(); toast(e.message, true); return; }
      const svg = (text) => { const q = qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); };
      const blanks = Math.max(0, Math.min(29, (parseInt(start, 10) || 1) - 1));
      const cells = new Array(blanks).fill('<div class="l"></div>').concat(things.map((t) =>
        '<div class="l"><div class="q">' + svg(link(t.kind, t.id)) + '</div><div class="t"><b>' + esc(t.title) + "</b>" + (t.sub ? "<span>" + esc(t.sub) + "</span>" : "") + "<i>207 Photo</i></div></div>"));
      const pages = [];
      for (let i = 0; i < cells.length; i += 30) pages.push('<div class="p">' + cells.slice(i, i + 30).join("") + "</div>");
      w.document.open();
      w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Inventory labels</title><style>' +
        "@page{size:letter;margin:0}*{box-sizing:border-box}body{margin:0;font:9pt/1.15 Arial,Helvetica,sans-serif;color:#000}" +
        ".p{width:8.5in;height:11in;padding:.5in .19in 0;display:grid;grid-template-columns:repeat(3,2.625in);grid-auto-rows:1in;column-gap:.125in;page-break-after:always}" +
        ".l{display:flex;align-items:center;gap:.08in;padding:.06in .1in;overflow:hidden}.q{flex:0 0 .82in;height:.82in}.q svg{width:100%;height:100%;display:block}" +
        ".t{min-width:0;display:flex;flex-direction:column;gap:2px}.t b{font-size:10pt;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}" +
        ".t span{font-size:8.5pt}.t i{font-style:normal;font-size:7pt;color:#555}" +
        "@media screen{body{background:#eee}.p{background:#fff;margin:12px auto;box-shadow:0 1px 4px rgba(0,0,0,.2)}.l{outline:1px dashed #ccc}}" +
        "</style></head><body>" + pages.join("") + "</body></html>");
      w.document.close();
      setTimeout(() => w.print(), 400);
    }

    // Pick what to print: bins, kits, items (all, or only those with a serial number).
    async function labelsDialog(preset) {
      const m = openModal("<h2>Print QR labels</h2>" +
        '<p class="muted" style="font-size:13px">For Avery 5160 or 8160 sheets (30 labels, 2-5/8" &times; 1"). Print at 100%, not &ldquo;fit to page&rdquo;. A phone camera opens the item from the label, and Scan in the app reads it too.</p>' +
        '<div class="field"><label><input type="checkbox" id="aca-iqLBins" checked /> Every bin</label></div>' +
        '<div class="field"><label><input type="checkbox" id="aca-iqLKits" checked /> Every kit</label></div>' +
        '<div class="field"><label for="aca-iqLItems">Items</label><select id="aca-iqLItems"><option value="serial">Items with a serial number</option><option value="all">Every item</option><option value="">No items</option></select></div>' +
        '<div class="field"><label for="aca-iqLStart">Start at label <span class="muted">(to use a part-used sheet; 1 = top left)</span></label><input type="number" id="aca-iqLStart" min="1" max="30" value="1" /></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-iqLCancel">Cancel</button><button type="button" class="primary" id="aca-iqLGo">Print</button></div>');
      if (preset) el("iqLItems").value = preset;
      el("iqLCancel").addEventListener("click", () => m.close());
      el("iqLGo").addEventListener("click", async () => {
        const wantItems = el("iqLItems").value, start = el("iqLStart").value;
        const [b, k, i] = await Promise.all([
          el("iqLBins").checked ? supabase.from("inventory_bins_v").select("id,code,location").order("code") : { data: [] },
          el("iqLKits").checked ? supabase.from("inventory_kits_v").select("id,name,bin_code").order("name") : { data: [] },
          wantItems ? supabase.from("inventory_items_v").select("id,name,serial,bin_code,kit_name").order("name") : { data: [] }]);
        const err = b.error || k.error || i.error;
        if (err) { toast(String(err.message || err), true); return; }
        const things = (b.data || []).map((r) => ({ kind: "b", id: r.id, title: "Bin " + r.code, sub: r.location }))
          .concat((k.data || []).map((r) => ({ kind: "k", id: r.id, title: r.name, sub: "Kit" + (r.bin_code ? " · bin " + r.bin_code : "") })))
          .concat((i.data || []).filter((r) => wantItems === "all" || r.serial).map((r) => ({ kind: "i", id: r.id, title: r.name,
            sub: r.serial ? "S/N " + r.serial : r.kit_name ? "In " + r.kit_name : r.bin_code ? "Bin " + r.bin_code : "" })));
        m.close();
        print(things, start);
      });
    }

    const css = `
  .aca .iq-cam { position: relative; width: 100%; aspect-ratio: 4 / 3; background: #111; border-radius: 6px; overflow: hidden; margin: 0 0 10px; }
  .aca .iq-cam video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .aca .iq-aim { position: absolute; inset: 18% 22%; border: 3px solid rgba(255,255,255,.85); border-radius: 10px; box-shadow: 0 0 0 999px rgba(0,0,0,.25); pointer-events: none; }
  .aca .iq-msg { margin: 0 0 6px; font-size: 14px; min-height: 20px; }
  .aca .iq-log { margin: 0 0 10px; padding: 0; list-style: none; font-size: 12.5px; line-height: 19px; max-height: 120px; overflow: auto; color: var(--muted); }
  .aca .iq-log li.bad { color: var(--err-fg); }
  .aca .iq-row { display: flex; gap: 8px; } .aca .iq-row input { flex: 1; min-width: 0; }
`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    return { scan, resolve, parse, print, labelsDialog, link };
  })();
