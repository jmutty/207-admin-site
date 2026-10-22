  // ================================================================ INVENTORY (2026-10-21)
  // Bins (numbered spaces), what is in them, serial numbers, kits, one photo each, and who has what.
  // Tables and views: inventory_bins / _kits / _items (+ _v views with place and holder), inventory_out_v.
  // RPCs: inventory_search, inventory_people, inventory_check_out, inventory_return, inventory_history.
  // Photos: private storage bucket `inventory`, shrunk in the browser, shown through signed URLs.
  // Gear (2026-10-22): purchase date, price, value today and a service interval per item, a service log
  // (inventory_service_log / _remove; anyone with View can log a sensor clean) and the insurance list (CSV).
  // View = search and check things out to yourself; Edit = change everything (the database enforces both).
  registerPage({ id: "inventory", group: "Operations", section: "ops", module: "inventory", title: "Inventory",
                 tabs: [["inventory", "Find"], ["invbins", "Bins"], ["invkits", "Kits"], ["invout", "Checked out"], ["invgear", "Gear"]],
                 onShow: (tab) => Inventory.show(tab) });
  registerAttention("gearServiceDue", { module: "inventory", level: "soon", name: "gear service",
    one: "A piece of gear is due for service in the next two weeks.", many: "{n} pieces of gear are due for service in the next two weeks." });
  registerTodayLoader("inventory", () => Inventory.loadAttention());

  const Inventory = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const BUCKET = "inventory";
    const css = `
  .aca input.inv-q { flex: 1 1 100%; height: 40px; font-size: 16px; }
  .aca .inv-bin { display: inline-flex; align-items: center; justify-content: center; min-width: 58px; height: 28px; padding: 0 8px; border: 1.5px solid var(--text); border-radius: 4px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; background: var(--surface); }
  .aca .inv-bin.none { border-style: dashed; border-color: var(--faint); color: var(--faint); font-weight: 600; }
  .aca .inv-res { display: grid; grid-template-columns: auto 44px minmax(0, 1fr); gap: 12px; align-items: center; width: 100%; padding: 10px 4px; border: 0; border-bottom: 1px solid var(--line2); border-radius: 0; background: transparent; text-align: left; font-weight: 400; white-space: normal; height: auto; }
  .aca .inv-res:hover:not(:disabled) { background: var(--surface-2); }
  .aca .inv-res b { font-size: 14.5px; }
  .aca .inv-res .muted { font-size: 12.5px; }
  .aca .inv-thumb { width: 44px; height: 44px; border-radius: 4px; object-fit: cover; background: var(--surface-2); display: block; }
  .aca span.inv-thumb { border: 1px solid var(--line2); }
  .aca .inv-h { margin: 16px 0 2px; font-size: 12px; font-weight: 600; color: var(--faint); }
  .aca .inv-out { color: var(--accent); font-weight: 600; }
  .aca .inv-photo { display: flex; gap: 12px; align-items: center; margin: 0 0 14px; flex-wrap: wrap; }
  .aca .inv-photo img { width: 160px; max-height: 160px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); }
  .aca .inv-photo .muted { font-size: 12.5px; }
  .aca .inv-big { width: 100%; max-height: 320px; object-fit: contain; border-radius: 6px; background: var(--surface-2); margin: 0 0 12px; }
  .aca .inv-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .aca .inv-list { margin: 4px 0 0; border-top: 1px solid var(--line2); }
  .aca .inv-li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; cursor: pointer; }
  .aca .inv-li:hover { background: var(--surface-2); }
  .aca .inv-li .grow { flex: 1; min-width: 0; }
  .aca .inv-status { padding: 10px 12px; border-radius: 4px; background: var(--surface-2); margin: 0 0 14px; font-size: 13.5px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .aca .inv-status .grow { flex: 1; }
  .aca .inv-hist { margin: 6px 0 0; padding: 0; list-style: none; font-size: 12.5px; line-height: 20px; color: var(--muted); }
  .aca .modal textarea.inv-note { width: 100%; height: 64px; padding: 6px 10px; resize: vertical; }
  .aca .modal .field select { width: 100%; }
  .aca .inv-care { margin: 0 0 14px; font-size: 13.5px; line-height: 21px; }
  .aca .inv-late { color: var(--err-fg); font-weight: 600; }
  .aca .inv-gear-sum { margin: 0 0 4px; font-size: 13.5px; color: var(--muted); }
  .aca .inv-gear-sum b { color: var(--text); }
  .aca td.money, .aca th.money { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  @media (max-width: 700px) { .aca .inv-sm-hide { display: none; } }
  @media (max-width: 700px) { .aca .inv-row2 { grid-template-columns: 1fr; } .aca .inv-res { grid-template-columns: auto minmax(0, 1fr); } .aca .inv-res .inv-thumb { display: none; } }
`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    let bins = [], kits = [], people = null, listsAt = 0;
    const edit = () => canEdit("inventory");
    const me = () => ACCESS.user_id;

    // ---------------------------------------------------------------- photos
    const urlCache = {};   // path -> { url, at }
    async function signed(paths) {
      const want = [...new Set(paths.filter((p) => p && !(urlCache[p] && Date.now() - urlCache[p].at < 50 * 60e3)))];
      if (want.length) {
        const { data } = await sb.storage.from(BUCKET).createSignedUrls(want, 3600);
        (data || []).forEach((d) => { if (d.signedUrl) urlCache[d.path] = { url: d.signedUrl, at: Date.now() }; });
      }
    }
    const photoUrl = (p) => (p && urlCache[p] ? urlCache[p].url : "");
    const thumb = (p) => (photoUrl(p) ? '<img class="inv-thumb" alt="" loading="lazy" src="' + esc(photoUrl(p)) + '" />' : '<span class="inv-thumb"></span>');

    // Shrink to at most 1400px on the long side as JPEG (about 150-300 KB), so the free 1 GB goes a long way.
    async function shrink(file) {
      let src;
      try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
      catch (_e) {
        src = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("That file isn't a photo this browser can open.")); i.src = URL.createObjectURL(file); });
      }
      const w = src.width, h = src.height, k = Math.min(1, 1400 / Math.max(w, h));
      const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("Could not read the photo."))), "image/jpeg", 0.8));
    }

    // The photo block inside an edit form. Returns { apply(kind, id, oldPath) -> new path or null/undefined }.
    function photoField(m, current) {
      let blob = null, removed = false;
      const box = m.querySelector(".inv-photo");
      const draw = (url) => {
        box.innerHTML = (url ? '<img alt="" src="' + esc(url) + '" />' : "") +
          (edit() ? '<div><input type="file" accept="image/*" class="hidden" /><button type="button" class="small" data-pick>' + (url ? "Change photo" : "Add photo") + "</button>" +
            (url ? ' <button type="button" class="small quiet" data-rm>Remove</button>' : "") +
            '<div class="muted">' + (url ? "" : "Optional. On a phone this can open the camera.") + "</div></div>" : "");
        const inp = box.querySelector("input[type=file]");
        if (inp) box.querySelector("[data-pick]").addEventListener("click", () => inp.click());
        if (inp) inp.addEventListener("change", async () => {
          const f = inp.files && inp.files[0];
          if (!f) return;
          try { blob = await shrink(f); removed = false; draw(URL.createObjectURL(blob)); }
          catch (e) { toast(cleanErr(e), true); }
        });
        const rm = box.querySelector("[data-rm]");
        if (rm) rm.addEventListener("click", () => { blob = null; removed = true; draw(""); });
      };
      draw(photoUrl(current));
      return {
        // undefined = unchanged; null = removed; string = new path (uploaded)
        async upload(kind, id) {
          if (blob) {
            const path = kind + "/" + id + "/" + Date.now() + ".jpg";
            const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
            if (error) throw error;
            return path;
          }
          return removed ? null : undefined;
        },
      };
    }
    const dropPhoto = (p) => { if (p) sb.storage.from(BUCKET).remove([p]); };

    // ---------------------------------------------------------------- shared lists
    async function loadLists(force) {
      if (!force && Date.now() - listsAt < 15e3) return;
      const [b, k] = await Promise.all([sb.from("inventory_bins_v").select("*").order("code"), sb.from("inventory_kits_v").select("*").order("name")]);
      if (b.error) throw b.error;
      if (k.error) throw k.error;
      bins = sortBins(b.data || []); kits = k.data || []; listsAt = Date.now();
    }
    // "A-2" before "A-10"
    const sortBins = (a) => a.slice().sort((x, y) => String(x.code).localeCompare(String(y.code), undefined, { numeric: true, sensitivity: "base" }));
    async function loadPeople() {
      if (people) return people;
      const { data, error } = await sb.rpc("inventory_people");
      if (error) throw error;
      return (people = data || []);
    }
    const binTag = (code) => (code ? '<span class="inv-bin">' + esc(code) + "</span>" : '<span class="inv-bin none">No bin</span>');
    const dueTxt = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "");
    const overdue = (d) => d && d < new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const outLine = (r) => r.holder_name ? '<span class="inv-out">Out with ' + esc(r.holder_name) + (r.out_with_kit ? " (with the kit)" : "") + "</span>" +
      (r.due_on ? ' <span class="muted">due ' + esc(dueTxt(r.due_on)) + (overdue(r.due_on) ? ", late" : "") + "</span>" : "") : "";

    // ---------------------------------------------------------------- gear helpers
    const money = (v) => (v == null || v === "" ? "" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 }));
    const monthTxt = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "");
    const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const soonStr = () => { const t = new Date(todayStr() + "T12:00:00"); t.setDate(t.getDate() + 14); return t.toISOString().slice(0, 10); };
    const serviceDue = (r) => r.next_service_on && r.next_service_on <= soonStr();
    const KIND = { service: "Service", sensor: "Sensor clean", repair: "Repair", other: "Other" };

    // ---------------------------------------------------------------- Find
    let qSeq = 0, qTimer = null;
    el("invQ").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(search, 180); });
    el("invQ").addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(qTimer); search(); } });

    async function search() {
      const q = el("invQ").value.trim();
      const seq = ++qSeq;
      clearError("invErr");
      if (!q) return mine(seq);
      const { data, error } = await sb.rpc("inventory_search", { p_q: q });
      if (seq !== qSeq) return;
      if (error) { showError("invErr", cleanErr(error)); return; }
      const d = data || {}, items = d.items || [], ks = d.kits || [], bs = d.bins || [];
      await signed(items.map((r) => r.photo_path).concat(ks.map((r) => r.photo_path), bs.map((r) => r.photo_path)));
      if (seq !== qSeq) return;
      el("invResults").innerHTML = !items.length && !ks.length && !bs.length
        ? '<p class="empty">Nothing matches &ldquo;' + esc(q) + '&rdquo;. Try fewer words, or part of a word.</p>'
        : (items.length ? '<div class="inv-h">Items</div>' + items.map(itemRow).join("") : "") +
          (ks.length ? '<div class="inv-h">Kits</div>' + ks.map(kitRow).join("") : "") +
          (bs.length ? '<div class="inv-h">Bins</div>' + bs.map(binRow).join("") : "");
    }
    // With nothing typed: what the signed-in person has checked out.
    async function mine(seq) {
      const { data, error } = await sb.from("inventory_out_v").select("*").eq("holder_user", me()).order("out_at", { ascending: false });
      if (seq !== qSeq) return;
      if (error) { el("invResults").innerHTML = ""; return; }
      el("invResults").innerHTML = data && data.length
        ? '<div class="inv-h">Checked out to you</div>' + data.map((r) => '<button type="button" class="inv-res" data-' + (r.kit_id ? "kit" : "item") + '="' + esc(r.kit_id || r.item_id) + '">' +
            binTag(r.bin_code) + '<span class="inv-thumb"></span><span><b>' + esc(r.what) + "</b>" + (r.serial ? ' <span class="muted">S/N ' + esc(r.serial) + "</span>" : "") +
            '<br><span class="muted">Since ' + esc(fmtAgo(r.out_at)) + (r.due_on ? ", due " + esc(dueTxt(r.due_on)) : "") + "</span></span></button>").join("")
        : '<p class="empty">Start typing to find something.</p>';
    }
    const itemRow = (r) => '<button type="button" class="inv-res" data-item="' + esc(r.id) + '">' + binTag(r.bin_code) + thumb(r.photo_path) +
      "<span><b>" + esc(r.name) + "</b>" + (num(r.qty) !== 1 ? ' <span class="muted">&times; ' + num(r.qty) + "</span>" : "") +
      (r.serial ? ' <span class="muted">S/N ' + esc(r.serial) + "</span>" : "") +
      '<br><span class="muted">' + [r.bin_location, r.kit_name ? "in " + r.kit_name : ""].filter(Boolean).map(esc).join(" &middot; ") + "</span> " + outLine(r) + "</span></button>";
    const kitRow = (r) => '<button type="button" class="inv-res" data-kit="' + esc(r.id) + '">' + binTag(r.bin_code) + thumb(r.photo_path) +
      "<span><b>" + esc(r.name) + '</b> <span class="muted">' + num(r.item_count) + (num(r.item_count) === 1 ? " item" : " items") + "</span>" +
      '<br><span class="muted">' + esc(r.bin_location || "") + "</span> " + outLine(r) + "</span></button>";
    const binRow = (r) => '<button type="button" class="inv-res" data-bin="' + esc(r.id) + '">' + binTag(r.code) + thumb(r.photo_path) +
      "<span><b>" + esc(r.location || "Bin " + r.code) + '</b><br><span class="muted">' + esc(r.preview || "Empty") + "</span></span></button>";

    el("invResults").addEventListener("click", (e) => openFrom(e.target.closest("[data-item],[data-kit],[data-bin]")));
    function openFrom(b) {
      if (!b) return;
      if (b.dataset.item) openItem(b.dataset.item);
      else if (b.dataset.kit) openKit(b.dataset.kit);
      else if (b.dataset.bin) openBin(b.dataset.bin);
    }
    // After any change: refresh whatever is on screen.
    function refresh() { listsAt = 0; show(current); }

    // ---------------------------------------------------------------- Bins tab
    async function loadBins() {
      clearError("invBinErr");
      try { await loadLists(true); } catch (e) { showError("invBinErr", "Could not load bins: " + cleanErr(e)); return; }
      await signed(bins.map((b) => b.photo_path));
      renderBins();
    }
    function renderBins() {
      const f = el("invBinFilter").value.trim().toLowerCase();
      const rows = bins.filter((b) => !f || [b.code, b.location, b.note, b.preview].join(" ").toLowerCase().includes(f));
      el("invBinBody").innerHTML = rows.length ? rows.map((b) => '<tr data-bin="' + esc(b.id) + '" style="cursor:pointer"><td>' + binTag(b.code) + "</td><td>" + esc(b.location) + "</td>" +
        "<td>" + (b.preview ? esc(b.preview) + (num(b.item_count) > 6 ? ' <span class="muted">+' + (num(b.item_count) - 6) + " more</span>" : "") : '<span class="muted">Empty</span>') +
        (num(b.kit_count) ? ' <span class="muted">&middot; ' + num(b.kit_count) + (num(b.kit_count) === 1 ? " kit" : " kits") + "</span>" : "") + "</td>" +
        "<td>" + (b.photo_path ? thumb(b.photo_path) : "") + "</td></tr>").join("")
        : '<tr><td colspan="4" class="empty">' + (bins.length ? "No bins match." : "No bins yet." + (edit() ? " Add your first one with Add bin." : "")) + "</td></tr>";
    }
    el("invBinFilter").addEventListener("input", renderBins);
    el("invBinBody").addEventListener("click", (e) => openFrom(e.target.closest("[data-bin]")));
    el("invBinAdd").addEventListener("click", () => editBin(null));

    // ---------------------------------------------------------------- Kits tab
    async function loadKits() {
      clearError("invKitErr");
      try { await loadLists(true); } catch (e) { showError("invKitErr", "Could not load kits: " + cleanErr(e)); return; }
      el("invKitBody").innerHTML = kits.length ? kits.map((k) => '<tr data-kit="' + esc(k.id) + '" style="cursor:pointer"><td class="name">' + esc(k.name) + "</td><td>" + binTag(k.bin_code) +
        (k.bin_location ? ' <span class="muted">' + esc(k.bin_location) + "</span>" : "") + "</td><td>" + num(k.item_count) + "</td>" +
        "<td>" + (k.holder_name ? '<span class="pill warn">Out with ' + esc(k.holder_name) + "</span>" : '<span class="pill ok">In</span>') + "</td></tr>").join("")
        : '<tr><td colspan="4" class="empty">No kits yet.' + (edit() ? " Add one, then add items to it." : "") + "</td></tr>";
    }
    el("invKitBody").addEventListener("click", (e) => openFrom(e.target.closest("[data-kit]")));
    el("invKitAdd").addEventListener("click", () => editKit(null));

    // ---------------------------------------------------------------- Checked out tab
    async function loadOut() {
      clearError("invOutErr");
      const { data, error } = await sb.from("inventory_out_v").select("*").order("out_at");
      if (error) { showError("invOutErr", cleanErr(error)); return; }
      const rows = data || [];
      const late = rows.filter((r) => overdue(r.due_on)).length;
      el("invOutCount").textContent = rows.length ? rows.length + " out" + (late ? ", " + late + " late" : "") : "";
      el("invOutBody").innerHTML = rows.length ? rows.map((r) => '<tr><td class="name"><a href="#" data-' + (r.kit_id ? "kit" : "item") + '="' + esc(r.kit_id || r.item_id) + '">' + esc(r.what) + "</a>" +
        (r.kit_id ? ' <span class="muted">kit</span>' : "") + (r.serial ? '<div class="muted" style="font-size:12.5px">S/N ' + esc(r.serial) + "</div>" : "") + "</td>" +
        "<td>" + esc(r.holder_name) + "</td><td>" + esc(fmtAgo(r.out_at)) + "</td>" +
        "<td>" + (r.due_on ? (overdue(r.due_on) ? '<span class="pill err">' + esc(dueTxt(r.due_on)) + "</span>" : esc(dueTxt(r.due_on))) : '<span class="muted">&mdash;</span>') + "</td>" +
        "<td>" + binTag(r.bin_code) + "</td>" +
        "<td>" + (edit() || r.holder_user === me() ? '<button type="button" class="small" data-ret="' + num(r.id) + '">Return</button>' : "") + "</td></tr>").join("")
        : '<tr><td colspan="6" class="empty">Everything is in.</td></tr>';
    }
    el("invOutBody").addEventListener("click", async (e) => {
      const r = e.target.closest("[data-ret]");
      if (r) { r.disabled = true; await giveBack(Number(r.dataset.ret)); return; }
      const a = e.target.closest("[data-item],[data-kit]");
      if (a) { e.preventDefault(); openFrom(a); }
    });

    async function giveBack(id, m) {
      const { error } = await sb.rpc("inventory_return", { p_checkout: id });
      if (error) { toast(cleanErr(error), true); return false; }
      toast("Checked back in.");
      if (m) m.close();
      refresh();
      return true;
    }

    // ---------------------------------------------------------------- check out
    async function checkOut(what, onDone) {
      let ppl = [];
      if (edit()) { try { ppl = await loadPeople(); } catch (e) { toast(cleanErr(e), true); return; } }
      const m = openModal("<h2>Check out " + esc(what.name) + "</h2>" +
        (edit()
          ? '<div class="field"><label for="aca-invWho">Who has it</label><select id="aca-invWho">' +
              ppl.map((p) => '<option value="' + esc(p.user_id) + '"' + (p.user_id === me() ? " selected" : "") + ">" + esc(p.name) + (p.user_id === me() ? " (you)" : "") + "</option>").join("") +
              '<option value="">Someone else&#8230;</option></select></div>' +
            '<div class="field hidden" id="aca-invWhoOther"><label for="aca-invWhoName">Their name</label><input type="text" id="aca-invWhoName" maxlength="120" /></div>'
          : '<p>This checks it out to you, ' + esc(ACCESS.name || "") + ".</p>") +
        '<div class="field"><label for="aca-invDue">Due back <span class="muted">(optional)</span></label><input type="date" id="aca-invDue" /></div>' +
        '<div class="field"><label for="aca-invCoNote">Note <span class="muted">(optional)</span></label><input type="text" id="aca-invCoNote" maxlength="500" placeholder="Hampden picture day" /></div>' +
        '<div class="inline-error hidden" id="aca-invCoErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-invCoCancel">Cancel</button><button type="button" class="primary" id="aca-invCoSave">Check out</button></div>');
      const err = (t) => { const n = el("invCoErr"); n.textContent = t; n.classList.remove("hidden"); };
      if (edit()) el("invWho").addEventListener("change", () => el("invWhoOther").classList.toggle("hidden", el("invWho").value !== ""));
      el("invCoCancel").addEventListener("click", () => m.close());
      el("invCoSave").addEventListener("click", async () => {
        const holder = edit() ? el("invWho").value || null : me();
        const name = edit() && !holder ? el("invWhoName").value.trim() : null;
        if (edit() && !holder && !name) return err("Type who has it.");
        el("invCoSave").disabled = true;
        const { data, error } = await sb.rpc("inventory_check_out", { p_item: what.item || null, p_kit: what.kit || null, p_holder: holder, p_holder_name: name,
          p_due: el("invDue").value || null, p_note: el("invCoNote").value.trim() });
        el("invCoSave").disabled = false;
        if (error) return err(cleanErr(error));
        m.close();
        toast("Checked out to " + ((data && data.holder_name) || "you") + ".");
        if (onDone) onDone();
        refresh();
      });
    }

    // The "who has it" strip at the top of an item or kit.
    function statusStrip(r, what) {
      if (r.holder_name) {
        const canRet = (edit() || r.holder_user === me()) && !(what.item && r.out_with_kit);
        return '<div class="inv-status"><span class="grow">' + outLine(r) + '<br><span class="muted">Since ' + esc(fmtDate(r.out_at)) + "</span></span>" +
          (canRet ? '<button type="button" class="small" data-ret="' + num(r.checkout_id) + '">Return</button>' : "") + "</div>";
      }
      return '<div class="inv-status"><span class="grow"><span class="pill ok">In</span> ' + (r.bin_code ? "Bin " + esc(r.bin_code) : "") + "</span>" +
        '<button type="button" class="small" data-co>Check out' + (edit() ? "" : " to me") + "</button></div>";
    }
    function wireStatus(m, what) {
      const co = m.querySelector("[data-co]"), ret = m.querySelector(".inv-status [data-ret]");
      if (co) co.addEventListener("click", () => { m.close(); checkOut(what); });
      if (ret) ret.addEventListener("click", () => giveBack(Number(ret.dataset.ret), m));
    }
    async function history(m, what) {
      const { data } = await sb.rpc("inventory_history", { p_item: what.item || null, p_kit: what.kit || null, p_limit: 10 });
      const box = m.querySelector(".inv-hist");
      if (!box) return;
      box.innerHTML = data && data.length ? data.map((h) => "<li>" + esc(h.holder_name) + (h.with_kit ? " (with the kit)" : "") + ": " + esc(fmtDate(h.out_at)) +
        (h.returned_at ? " to " + esc(fmtDate(h.returned_at)) : " <b>still out</b>") + (h.note ? " &middot; " + esc(h.note) : "") + "</li>").join("") : "<li>Never checked out.</li>";
    }

    // ---------------------------------------------------------------- bin
    async function openBin(id) {
      try { await loadLists(); } catch (e) { toast(cleanErr(e), true); return; }
      const [b, it] = await Promise.all([sb.from("inventory_bins_v").select("*").eq("id", id).single(), sb.from("inventory_items_v").select("*").eq("bin_id", id).order("name")]);
      if (b.error || !b.data) { toast(cleanErr(b.error || "That bin is gone."), true); return; }
      const bin = b.data, items = (it.data || []).filter((r) => !r.kit_id), binKits = kits.filter((k) => k.bin_id === id);
      await signed([bin.photo_path].concat(items.map((r) => r.photo_path)));
      const m = openModal("<h2>" + binTag(bin.code) + " " + esc(bin.location || "") + "</h2>" +
        (bin.photo_path ? '<img class="inv-big" alt="" src="' + esc(photoUrl(bin.photo_path)) + '" />' : "") +
        (bin.note ? "<p>" + esc(bin.note) + "</p>" : "") +
        '<div class="inv-h">In this bin</div><div class="inv-list">' +
        (items.length || binKits.length ? items.map((r) => '<div class="inv-li" data-item="' + esc(r.id) + '"><span class="grow"><b>' + esc(r.name) + "</b>" +
            (num(r.qty) !== 1 ? ' <span class="muted">&times; ' + num(r.qty) + "</span>" : "") + (r.serial ? ' <span class="muted">S/N ' + esc(r.serial) + "</span>" : "") + "</span>" + outLine(r) + "</div>").join("") +
          binKits.map((k) => '<div class="inv-li" data-kit="' + esc(k.id) + '"><span class="grow"><b>' + esc(k.name) + '</b> <span class="muted">kit, ' + num(k.item_count) + " items</span></span>" +
            (k.holder_name ? '<span class="inv-out">Out with ' + esc(k.holder_name) + "</span>" : "") + "</div>").join("")
          : '<p class="empty">Nothing in this bin yet.</p>') + "</div>" +
        '<div class="modal-actions">' + (edit() ? '<button type="button" class="small" id="aca-invBinEdit">Edit bin</button><button type="button" class="small" id="aca-invBinItem">Add item</button>' : "") +
        '<span class="grow"></span><button type="button" class="primary" id="aca-invBinClose">Done</button></div>');
      el("invBinClose").addEventListener("click", () => m.close());
      m.querySelector(".inv-list").addEventListener("click", (e) => { const r = e.target.closest("[data-item],[data-kit]"); if (r) { m.close(); openFrom(r); } });
      if (!edit()) return;
      el("invBinEdit").addEventListener("click", () => { m.close(); editBin(bin); });
      el("invBinItem").addEventListener("click", () => { m.close(); editItem(null, { bin_id: id }); });
    }

    function editBin(bin) {
      const isNew = !bin;
      bin = bin || { code: "", location: "", note: "", photo_path: null, item_count: 0, kit_count: 0 };
      const m = openModal("<h2>" + (isNew ? "Add a bin" : "Edit bin " + esc(bin.code)) + "</h2>" +
        '<div class="inv-row2"><div class="field"><label for="aca-invBCode">Bin or space number</label><input type="text" id="aca-invBCode" maxlength="30" placeholder="A-03" value="' + esc(bin.code) + '" /></div>' +
        '<div class="field"><label for="aca-invBLoc">Where it is</label><input type="text" id="aca-invBLoc" maxlength="120" placeholder="Studio, back shelf" value="' + esc(bin.location) + '" /></div></div>' +
        '<div class="field"><label for="aca-invBNote">Note</label><textarea id="aca-invBNote" class="inv-note" maxlength="1000">' + esc(bin.note) + "</textarea></div>" +
        '<div class="inv-photo"></div>' +
        '<div class="inline-error hidden" id="aca-invBErr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" id="aca-invBDel">Delete bin</button>') +
        '<span class="grow"></span><button type="button" class="small" id="aca-invBCancel">Cancel</button><button type="button" class="primary" id="aca-invBSave">' + (isNew ? "Add bin" : "Save") + "</button></div>");
      const err = (t) => { const n = el("invBErr"); n.textContent = t; n.classList.remove("hidden"); };
      const photo = photoField(m, bin.photo_path);
      el("invBCancel").addEventListener("click", () => m.close());
      el("invBSave").addEventListener("click", async () => {
        const code = el("invBCode").value.trim();
        if (!code) return err("Give the bin a number or name.");
        el("invBSave").disabled = true;
        try {
          const id = bin.id || crypto.randomUUID();
          const p = await photo.upload("bins", id);
          const row = { code, location: el("invBLoc").value.trim(), note: el("invBNote").value.trim() };
          if (p !== undefined) row.photo_path = p;
          const { error } = isNew ? await sb.from("inventory_bins").insert(Object.assign({ id }, row)) : await sb.from("inventory_bins").update(row).eq("id", id);
          if (error) throw error.code === "23505" ? new Error("There's already a bin " + code + ".") : error;
          if (p !== undefined && bin.photo_path) dropPhoto(bin.photo_path);
          m.close();
          toast(isNew ? "Added bin " + code + "." : "Saved.");
          refresh();
        } catch (e) { err(cleanErr(e)); } finally { if (el("invBSave")) el("invBSave").disabled = false; }
      });
      if (isNew) return;
      el("invBDel").addEventListener("click", async () => {
        if (num(bin.item_count) || num(bin.kit_count)) return err("Move or delete what's in this bin first.");
        if (!confirm("Delete bin " + bin.code + "?")) return;
        const { error } = await sb.from("inventory_bins").delete().eq("id", bin.id);
        if (error) return err(error.code === "23503" ? "Move or delete what's in this bin first." : cleanErr(error));
        dropPhoto(bin.photo_path);
        m.close(); toast("Deleted."); refresh();
      });
    }

    // ---------------------------------------------------------------- item
    async function openItem(id) {
      const { data: r, error } = await sb.from("inventory_items_v").select("*").eq("id", id).single();
      if (error || !r) { toast(cleanErr(error || "That item is gone."), true); return; }
      await signed([r.photo_path]);
      const what = { item: r.id, name: r.name };
      const m = openModal("<h2>" + esc(r.name) + (num(r.qty) !== 1 ? ' <span class="muted">&times; ' + num(r.qty) + "</span>" : "") + "</h2>" +
        (r.photo_path ? '<img class="inv-big" alt="" src="' + esc(photoUrl(r.photo_path)) + '" />' : "") +
        '<p style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' + binTag(r.bin_code) + " " + esc(r.bin_location || "") + (r.kit_name ? ' <span class="muted">in kit ' + esc(r.kit_name) + "</span>" : "") + "</p>" +
        (r.serial ? "<p>Serial number <b>" + esc(r.serial) + "</b></p>" : "") +
        (r.note ? "<p>" + esc(r.note) + "</p>" : "") +
        careBlock(r) +
        statusStrip(r, what) +
        '<div class="inv-h">History</div><ul class="inv-hist"><li>Loading&#8230;</li></ul>' +
        '<div class="inv-h">Service</div><ul class="inv-hist" id="aca-invSvc"><li>Loading&#8230;</li></ul>' +
        '<div class="modal-actions">' + (edit() ? '<button type="button" class="small" id="aca-invIEdit">Edit item</button>' : "") +
        '<button type="button" class="small" id="aca-invISvc">Log service</button>' +
        '<span class="grow"></span><button type="button" class="primary" id="aca-invIClose">Done</button></div>');
      el("invIClose").addEventListener("click", () => m.close());
      wireStatus(m, what);
      history(m, what);
      serviceLog(r);
      el("invISvc").addEventListener("click", () => { m.close(); logService(r); });
      if (edit()) el("invIEdit").addEventListener("click", () => { m.close(); editItem(r); });
    }

    // Purchase, value and service lines on an item.
    function careBlock(r) {
      const bits = [];
      if (r.purchased_on || r.purchase_price != null) bits.push("Bought" + (r.purchased_on ? " " + esc(monthTxt(r.purchased_on)) : "") + (r.purchase_price != null ? " for " + esc(money(r.purchase_price)) : ""));
      if (r.value != null) bits.push("Worth " + esc(money(r.value)) + (num(r.qty) > 1 ? " each (" + esc(money(Number(r.value) * num(r.qty))) + " for " + num(r.qty) + ")" : ""));
      if (r.service_every_months) bits.push("Service every " + num(r.service_every_months) + (num(r.service_every_months) === 1 ? " month" : " months") +
        (r.next_service_on ? ', next <span class="' + (serviceDue(r) ? "inv-late" : "") + '">' + esc(dueTxt(r.next_service_on)) + (r.next_service_on < todayStr() ? ", overdue" : "") + "</span>" : ""));
      else if (r.last_service_on) bits.push("Last serviced " + esc(dueTxt(r.last_service_on)));
      return bits.length ? '<p class="inv-care">' + bits.join("<br>") + "</p>" : "";
    }
    async function serviceLog(r) {
      const { data } = await sb.from("inventory_service").select("*").eq("item_id", r.id).order("done_on", { ascending: false }).limit(12);
      const box = el("invSvc");
      if (!box) return;
      box.innerHTML = data && data.length ? data.map((h) => "<li>" + esc(dueTxt(h.done_on)) + ": " + esc(KIND[h.kind] || h.kind) + (h.cost != null ? " &middot; " + esc(money(h.cost)) : "") +
        (h.note ? " &middot; " + esc(h.note) : "") + (edit() || h.created_by === me() ? ' <button type="button" class="link small" data-svc-rm="' + num(h.id) + '">remove</button>' : "") + "</li>").join("") : "<li>Nothing logged yet.</li>";
      box.onclick = async (e) => {
        const b = e.target.closest("[data-svc-rm]"); if (!b) return;
        if (!confirm("Remove this service entry?")) return;
        const { error } = await sb.rpc("inventory_service_remove", { p_id: Number(b.dataset.svcRm) });
        if (error) { toast(cleanErr(error), true); return; }
        toast("Removed."); serviceLog(r); refresh();
      };
    }
    function logService(r) {
      const m = openModal("<h2>Log service: " + esc(r.name) + "</h2>" +
        '<div class="inv-row2"><div class="field"><label for="aca-invSvKind">What was done</label><select id="aca-invSvKind">' +
          Object.keys(KIND).map((k) => '<option value="' + k + '">' + KIND[k] + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="aca-invSvDay">When</label><input type="date" id="aca-invSvDay" value="' + esc(todayStr()) + '" /></div></div>' +
        '<div class="inv-row2"><div class="field"><label for="aca-invSvCost">Cost <span class="muted">(optional)</span></label><input type="number" id="aca-invSvCost" min="0" step="0.01" placeholder="0.00" /></div>' +
        '<div class="field"><label for="aca-invSvNote">Note <span class="muted">(optional)</span></label><input type="text" id="aca-invSvNote" maxlength="500" placeholder="Canon service center" /></div></div>' +
        '<p class="muted" style="font-size:12.5px">A service or sensor clean restarts the countdown to the next one. A repair doesn&#39;t.</p>' +
        '<div class="inline-error hidden" id="aca-invSvErr"></div>' +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-invSvCancel">Cancel</button><button type="button" class="primary" id="aca-invSvSave">Log it</button></div>');
      const err = (t) => { const n = el("invSvErr"); n.textContent = t; n.classList.remove("hidden"); };
      el("invSvCancel").addEventListener("click", () => { m.close(); openItem(r.id); });
      el("invSvSave").addEventListener("click", async () => {
        const day = el("invSvDay").value, costTxt = el("invSvCost").value.trim();
        if (!day) return err("Pick the day it was done.");
        if (costTxt !== "" && !(Number(costTxt) >= 0)) return err("Cost should be a number.");
        el("invSvSave").disabled = true;
        const { error } = await sb.rpc("inventory_service_log", { p_item: r.id, p_done_on: day, p_kind: el("invSvKind").value, p_cost: costTxt === "" ? null : Number(costTxt), p_note: el("invSvNote").value.trim() });
        el("invSvSave").disabled = false;
        if (error) return err(cleanErr(error));
        m.close(); toast("Logged."); refresh(); openItem(r.id);
      });
    }

    async function editItem(r, preset) {
      try { await loadLists(); } catch (e) { toast(cleanErr(e), true); return; }
      const isNew = !r;
      r = r || Object.assign({ name: "", qty: 1, serial: "", note: "", bin_id: null, kit_id: null, photo_path: null }, preset || {});
      const place = r.kit_id ? "k:" + r.kit_id : r.bin_id ? "b:" + r.bin_id : "";
      const m = openModal("<h2>" + (isNew ? "Add an item" : "Edit " + esc(r.name)) + "</h2>" +
        '<div class="field"><label for="aca-invIName">What it is</label><input type="text" id="aca-invIName" maxlength="120" placeholder="Canon R6 body" value="' + esc(r.name) + '" /></div>' +
        '<div class="inv-row2"><div class="field"><label for="aca-invIQty">How many</label><input type="number" id="aca-invIQty" min="0" max="100000" value="' + num(r.qty) + '" /></div>' +
        '<div class="field"><label for="aca-invISerial">Serial number <span class="muted">(optional)</span></label><input type="text" id="aca-invISerial" maxlength="80" value="' + esc(r.serial) + '" /></div></div>' +
        '<div class="field"><label for="aca-invIPlace">Where it lives</label><select id="aca-invIPlace"><option value="">No bin yet</option>' +
          '<optgroup label="Bins">' + bins.map((b) => '<option value="b:' + esc(b.id) + '"' + (place === "b:" + b.id ? " selected" : "") + ">" + esc(b.code) + (b.location ? " · " + esc(b.location) : "") + "</option>").join("") + "</optgroup>" +
          (kits.length ? '<optgroup label="In a kit">' + kits.map((k) => '<option value="k:' + esc(k.id) + '"' + (place === "k:" + k.id ? " selected" : "") + ">" + esc(k.name) + (k.bin_code ? " (bin " + esc(k.bin_code) + ")" : "") + "</option>").join("") + "</optgroup>" : "") +
        "</select></div>" +
        '<div class="inv-h">Purchase and care <span class="muted">(optional, for the insurance list and service reminders)</span></div>' +
        '<div class="inv-row2"><div class="field"><label for="aca-invIBought">Bought on</label><input type="date" id="aca-invIBought" value="' + esc(r.purchased_on || "") + '" /></div>' +
        '<div class="field"><label for="aca-invIPrice">Price paid (each)</label><input type="number" id="aca-invIPrice" min="0" step="0.01" placeholder="0.00" value="' + esc(r.purchase_price == null ? "" : String(r.purchase_price)) + '" /></div></div>' +
        '<div class="inv-row2"><div class="field"><label for="aca-invIValue">Worth today (each)</label><input type="number" id="aca-invIValue" min="0" step="0.01" placeholder="Replacement value" value="' + esc(r.value == null ? "" : String(r.value)) + '" /></div>' +
        '<div class="field"><label for="aca-invIEvery">Service every (months)</label><input type="number" id="aca-invIEvery" min="1" max="120" placeholder="e.g. 12" value="' + esc(r.service_every_months == null ? "" : String(r.service_every_months)) + '" /></div></div>' +
        '<div class="field"><label for="aca-invINote">Note</label><textarea id="aca-invINote" class="inv-note" maxlength="1000">' + esc(r.note) + "</textarea></div>" +
        '<div class="inv-photo"></div>' +
        '<div class="inline-error hidden" id="aca-invIErr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" id="aca-invIDel">Delete item</button>') +
        '<span class="grow"></span><button type="button" class="small" id="aca-invICancel">Cancel</button>' +
        (isNew ? '<button type="button" class="small" id="aca-invIMore">Add and add another</button>' : "") +
        '<button type="button" class="primary" id="aca-invISave">' + (isNew ? "Add item" : "Save") + "</button></div>");
      const err = (t) => { const n = el("invIErr"); n.textContent = t; n.classList.remove("hidden"); };
      const photo = photoField(m, r.photo_path);
      el("invICancel").addEventListener("click", () => m.close());
      async function save(again) {
        const name = el("invIName").value.trim(), qty = parseInt(el("invIQty").value, 10), pl = el("invIPlace").value;
        if (!name) return err("Say what the item is.");
        if (!(qty >= 0)) return err("How many should be a number (0 or more).");
        const amt = (id) => { const t = el(id).value.trim(); return t === "" ? null : Number(t); };
        const price = amt("invIPrice"), value = amt("invIValue"), every = amt("invIEvery");
        if ((price != null && !(price >= 0)) || (value != null && !(value >= 0))) return err("Prices should be numbers (0 or more).");
        if (every != null && !(every >= 1 && every <= 120 && every % 1 === 0)) return err("Service every 1 to 120 months, or leave it empty.");
        el("invISave").disabled = true;
        try {
          const id = r.id || crypto.randomUUID();
          const p = await photo.upload("items", id);
          const row = { name, qty, serial: el("invISerial").value.trim(), note: el("invINote").value.trim(),
                        bin_id: pl.startsWith("b:") ? pl.slice(2) : null, kit_id: pl.startsWith("k:") ? pl.slice(2) : null,
                        purchased_on: el("invIBought").value || null, purchase_price: price, value, service_every_months: every };
          if (p !== undefined) row.photo_path = p;
          const { error } = isNew ? await sb.from("inventory_items").insert(Object.assign({ id }, row)) : await sb.from("inventory_items").update(row).eq("id", id);
          if (error) throw error.code === "23505" ? new Error("Another item already has serial number " + row.serial + ".") : error;
          if (p !== undefined && r.photo_path) dropPhoto(r.photo_path);
          m.close();
          toast(isNew ? "Added " + name + "." : "Saved.");
          refresh();
          if (again) editItem(null, { bin_id: row.bin_id, kit_id: row.kit_id });
        } catch (e) { err(cleanErr(e)); } finally { if (el("invISave")) el("invISave").disabled = false; }
      }
      el("invISave").addEventListener("click", () => save(false));
      if (isNew) { el("invIMore").addEventListener("click", () => save(true)); return; }
      el("invIDel").addEventListener("click", async () => {
        if (!confirm("Delete " + r.name + "? Its check-out history goes with it.")) return;
        const { error } = await sb.from("inventory_items").delete().eq("id", r.id);
        if (error) return err(cleanErr(error));
        dropPhoto(r.photo_path);
        m.close(); toast("Deleted."); refresh();
      });
    }

    // ---------------------------------------------------------------- kit
    async function openKit(id) {
      const [k, it] = await Promise.all([sb.from("inventory_kits_v").select("*").eq("id", id).single(), sb.from("inventory_items_v").select("*").eq("kit_id", id).order("name")]);
      if (k.error || !k.data) { toast(cleanErr(k.error || "That kit is gone."), true); return; }
      const kit = k.data, items = it.data || [];
      await signed([kit.photo_path]);
      const what = { kit: kit.id, name: kit.name };
      const m = openModal("<h2>" + esc(kit.name) + ' <span class="muted">kit</span></h2>' +
        (kit.photo_path ? '<img class="inv-big" alt="" src="' + esc(photoUrl(kit.photo_path)) + '" />' : "") +
        '<p style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">Lives in ' + binTag(kit.bin_code) + " " + esc(kit.bin_location || "") + "</p>" +
        (kit.note ? "<p>" + esc(kit.note) + "</p>" : "") +
        statusStrip(kit, what) +
        '<div class="inv-h">In this kit</div><div class="inv-list">' +
        (items.length ? items.map((r) => '<div class="inv-li" data-item="' + esc(r.id) + '"><span class="grow"><b>' + esc(r.name) + "</b>" +
            (num(r.qty) !== 1 ? ' <span class="muted">&times; ' + num(r.qty) + "</span>" : "") + (r.serial ? ' <span class="muted">S/N ' + esc(r.serial) + "</span>" : "") + "</span>" +
            (r.holder_name && !r.out_with_kit ? outLine(r) : "") + "</div>").join("") : '<p class="empty">Nothing in this kit yet.</p>') + "</div>" +
        '<div class="inv-h">History</div><ul class="inv-hist"><li>Loading&#8230;</li></ul>' +
        '<div class="modal-actions">' + (edit() ? '<button type="button" class="small" id="aca-invKEdit">Edit kit</button><button type="button" class="small" id="aca-invKItem">Add item</button>' : "") +
        '<span class="grow"></span><button type="button" class="primary" id="aca-invKClose">Done</button></div>');
      el("invKClose").addEventListener("click", () => m.close());
      wireStatus(m, what);
      history(m, what);
      m.querySelector(".inv-list").addEventListener("click", (e) => { const r = e.target.closest("[data-item]"); if (r) { m.close(); openFrom(r); } });
      if (!edit()) return;
      el("invKEdit").addEventListener("click", () => { m.close(); editKit(kit); });
      el("invKItem").addEventListener("click", () => { m.close(); editItem(null, { kit_id: kit.id }); });
    }

    async function editKit(kit) {
      try { await loadLists(); } catch (e) { toast(cleanErr(e), true); return; }
      const isNew = !kit;
      kit = kit || { name: "", bin_id: null, note: "", photo_path: null };
      const m = openModal("<h2>" + (isNew ? "Add a kit" : "Edit " + esc(kit.name)) + "</h2>" +
        '<div class="field"><label for="aca-invKName">Kit name</label><input type="text" id="aca-invKName" maxlength="120" placeholder="Sports kit 1" value="' + esc(kit.name) + '" /></div>' +
        '<div class="field"><label for="aca-invKBin">Home bin</label><select id="aca-invKBin"><option value="">No bin yet</option>' +
          bins.map((b) => '<option value="' + esc(b.id) + '"' + (kit.bin_id === b.id ? " selected" : "") + ">" + esc(b.code) + (b.location ? " · " + esc(b.location) : "") + "</option>").join("") + "</select></div>" +
        '<div class="field"><label for="aca-invKNote">Note</label><textarea id="aca-invKNote" class="inv-note" maxlength="1000">' + esc(kit.note) + "</textarea></div>" +
        '<div class="inv-photo"></div>' +
        '<div class="inline-error hidden" id="aca-invKErr"></div>' +
        '<div class="modal-actions">' + (isNew ? "" : '<button type="button" class="small warn" id="aca-invKDel">Delete kit</button>') +
        '<span class="grow"></span><button type="button" class="small" id="aca-invKCancel">Cancel</button><button type="button" class="primary" id="aca-invKSave">' + (isNew ? "Add kit" : "Save") + "</button></div>");
      const err = (t) => { const n = el("invKErr"); n.textContent = t; n.classList.remove("hidden"); };
      const photo = photoField(m, kit.photo_path);
      el("invKCancel").addEventListener("click", () => m.close());
      el("invKSave").addEventListener("click", async () => {
        const name = el("invKName").value.trim();
        if (!name) return err("Give the kit a name.");
        el("invKSave").disabled = true;
        try {
          const id = kit.id || crypto.randomUUID();
          const p = await photo.upload("kits", id);
          const row = { name, bin_id: el("invKBin").value || null, note: el("invKNote").value.trim() };
          if (p !== undefined) row.photo_path = p;
          const { error } = isNew ? await sb.from("inventory_kits").insert(Object.assign({ id }, row)) : await sb.from("inventory_kits").update(row).eq("id", id);
          if (error) throw error.code === "23505" ? new Error("There's already a kit called " + name + ".") : error;
          if (p !== undefined && kit.photo_path) dropPhoto(kit.photo_path);
          m.close();
          toast(isNew ? "Added " + name + ". Now add items to it." : "Saved.");
          refresh();
          if (isNew) openKit(id);
        } catch (e) { err(cleanErr(e)); } finally { if (el("invKSave")) el("invKSave").disabled = false; }
      });
      if (isNew) return;
      el("invKDel").addEventListener("click", async () => {
        if (!confirm("Delete the kit " + kit.name + "? Its items stay, in the kit's bin.")) return;
        const { error } = await sb.from("inventory_kits").delete().eq("id", kit.id);
        if (error) return err(cleanErr(error));
        dropPhoto(kit.photo_path);
        m.close(); toast("Deleted. Its items are in its bin now."); refresh();
      });
    }

    // ---------------------------------------------------------------- Gear tab
    let gear = [], gearFilter = "all";
    async function loadGear() {
      clearError("invGearErr");
      const { data, error } = await sb.from("inventory_items_v").select("*").order("name");
      if (error) { showError("invGearErr", "Could not load gear: " + cleanErr(error)); return; }
      gear = data || [];
      renderGear();
    }
    function renderGear() {
      const f = el("invGearFilter").value.trim().toLowerCase();
      const valued = gear.filter((r) => r.value != null || r.purchase_price != null);
      const total = gear.reduce((n, r) => n + (r.value != null ? Number(r.value) * num(r.qty) : 0), 0);
      const due = gear.filter(serviceDue).length;
      el("invGearSum").innerHTML = valued.length ? "Worth <b>" + esc(money(total)) + "</b> across " + valued.length + (valued.length === 1 ? " item" : " items") + " with a value" +
        (due ? ' &middot; <span class="inv-late">' + due + " due for service</span>" : "") : "Add a value, price or service interval to an item (Edit item) and it shows here.";
      document.querySelectorAll("#aca-invGearChips [data-f]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === gearFilter)));
      const rows = gear.filter((r) => (gearFilter === "all" ? r.value != null || r.purchase_price != null || r.service_every_months || r.serial
          : gearFilter === "due" ? serviceDue(r) : gearFilter === "novalue" ? r.value == null : true) &&
        (!f || [r.name, r.serial, r.bin_code, r.kit_name, r.note].join(" ").toLowerCase().includes(f)));
      el("invGearBody").innerHTML = rows.length ? rows.map((r) => '<tr data-item="' + esc(r.id) + '" style="cursor:pointer"><td class="name">' + esc(r.name) +
        (num(r.qty) !== 1 ? ' <span class="muted">&times; ' + num(r.qty) + "</span>" : "") + (r.serial ? '<div class="muted" style="font-size:12.5px">S/N ' + esc(r.serial) + "</div>" : "") + "</td>" +
        '<td class="inv-sm-hide">' + esc(monthTxt(r.purchased_on)) + '</td><td class="money inv-sm-hide">' + esc(money(r.purchase_price)) + '</td><td class="money">' + esc(money(r.value)) +
        (r.value != null && num(r.qty) > 1 ? '<div class="muted" style="font-size:12px">' + esc(money(Number(r.value) * num(r.qty))) + " total</div>" : "") + "</td>" +
        "<td>" + (r.next_service_on ? (serviceDue(r) ? '<span class="pill err">' + esc(dueTxt(r.next_service_on)) + "</span>" : esc(dueTxt(r.next_service_on))) : '<span class="muted">&mdash;</span>') + "</td>" +
        "<td>" + binTag(r.bin_code) + "</td></tr>").join("")
        : '<tr><td colspan="6" class="empty">' + (gearFilter === "due" ? "Nothing is due for service." : gear.length ? "Nothing matches." : "No items yet.") + "</td></tr>";
    }
    el("invGearFilter").addEventListener("input", renderGear);
    el("invGearChips").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { gearFilter = b.dataset.f; renderGear(); } });
    el("invGearBody").addEventListener("click", (e) => openFrom(e.target.closest("[data-item]")));
    // The insurance list: every item with a value or a price, as a CSV the insurer can open in Excel.
    el("invGearExport").addEventListener("click", async () => {
      if (!gear.length) await loadGear();
      const rows = gear.filter((r) => r.value != null || r.purchase_price != null);
      if (!rows.length) { toast("No item has a value or price yet. Add them with Edit item.", true); return; }
      const cell = (v) => { let t = v == null ? "" : String(v); if (/^[=+\-@]/.test(t)) t = "'" + t; return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      const head = ["Item", "Serial number", "Quantity", "Value each", "Total value", "Purchased on", "Price paid each", "Bin", "Where", "Kit", "Note"];
      const lines = [head].concat(rows.map((r) => [r.name, r.serial, num(r.qty), r.value, r.value != null ? (Number(r.value) * num(r.qty)).toFixed(2) : "", r.purchased_on, r.purchase_price,
        r.bin_code, r.bin_location, r.kit_name, r.note]));
      const total = rows.reduce((n, r) => n + (r.value != null ? Number(r.value) * num(r.qty) : 0), 0);
      lines.push([], ["Total", "", "", "", total.toFixed(2)]);
      const csv = "\ufeff" + lines.map((l) => l.map(cell).join(",")).join("\r\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      a.download = "207-photo-gear-insurance-" + todayStr() + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("Exported " + rows.length + (rows.length === 1 ? " item" : " items") + ", worth " + money(total) + ".");
    });

    async function loadAttention() {
      try {
        const { data: d, error } = await sb.rpc("inventory_attention");
        if (error) throw error;
        setAttention("gearServiceDue", num(d && d.service_due), "Gear due for service", "invgear");
      } catch (_e) { /* Today reports it as unchecked */ }
    }

    // ---------------------------------------------------------------- tabs
    let current = "inventory";
    function show(tab) {
      current = tab;
      document.querySelectorAll(".aca .inv-edit").forEach((b) => b.classList.toggle("hidden", !edit()));
      if (tab === "inventory") { search(); if (window.matchMedia("(pointer: fine)").matches) el("invQ").focus(); }
      else if (tab === "invbins") loadBins();
      else if (tab === "invkits") loadKits();
      else if (tab === "invout") loadOut();
      else if (tab === "invgear") loadGear();
    }

    return { show, loadAttention };
  })();
