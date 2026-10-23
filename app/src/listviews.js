  // ================================================================ Saved views + bulk changes on Bookings and Inventory (2026-10-22)
  // Adds to pages other files own, through their filter controls, so those files stay as they are:
  //   Bookings        View picker (search, job type, stage, Upcoming/Past/Still owed/Cancelled) and "Change shown..."
  //                   to move the ticked bookings to a stage (booking_set_stage per booking, matched by stage name).
  //   Inventory Gear  View picker (filter text + chip) and "Change shown..." to move ticked items to a bin or kit,
  //                   or log a service for them today (inventory_service_log).
  // Views are SavedViews rows (pages "bookings" / "inventory").
  const ListViews = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .lv-tools { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .aca .lv-list { max-height: 300px; overflow: auto; border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px; margin: 0 0 12px; }
    .aca .lv-list label { display: flex; gap: 8px; align-items: center; padding: 5px 0; font-size: 13.5px; border-bottom: 1px solid var(--line2); }
    .aca .lv-list label:last-child { border-bottom: 0; }
    .aca .lv-list input { width: 16px; height: 16px; margin: 0; flex: none; }
    .aca .lv-modal .field select { width: 100%; }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

    // Call fn the first time the panel becomes the active tab.
    function onFirstShow(panelId, fn) {
      const p = el(panelId); if (!p) return;
      if (p.classList.contains("active")) { fn(); return; }
      const mo = new MutationObserver(() => { if (p.classList.contains("active")) { mo.disconnect(); fn(); } });
      mo.observe(p, { attributes: true, attributeFilter: ["class"] });
    }
    // A modal listing the rows shown now, all ticked, with the action controls under it.
    function pickRows(title, rows, controlsHtml, run) {
      const m = openModal('<div class="lv-modal"><h2>' + esc(title) + '</h2><p class="muted" style="margin-top:0">These are the ' + rows.length + ' shown with your filters. Untick any to leave out.</p>' +
        '<div class="lv-list">' + rows.map((r) => '<label><input type="checkbox" value="' + esc(r.id) + '" checked /> ' + esc(r.label) + "</label>").join("") + "</div>" + controlsHtml +
        '<div class="inline-error hidden" id="aca-lvErr"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button><button type="button" class="primary" data-m="go">Apply</button></div></div>');
      const err = (t) => { const e = el("lvErr"); e.textContent = t; e.classList.remove("hidden"); };
      m.addEventListener("click", async (ev) => {
        const b = ev.target.closest("[data-m]"); if (!b) return;
        if (b.dataset.m === "cancel") return m.close();
        const ids = [...m.querySelectorAll(".lv-list input:checked")].map((x) => x.value);
        if (!ids.length) return err("Tick at least one.");
        b.disabled = true;
        try { const msg = await run(ids, m); m.close(); toast(msg); } catch (e) { err(cleanErr(e)); b.disabled = false; }
      });
    }

    // ---------------------------------------------------------------- Bookings
    (function bookings() {
      const bar = el("bkScope") && el("bkScope").parentElement; if (!bar) return;
      const tools = document.createElement("span"); tools.className = "lv-tools"; bar.appendChild(tools);
      const scopeNow = () => { const b = el("bkScope").querySelector('button[aria-pressed="true"]'); return b ? b.dataset.scope : "upcoming"; };
      const views = SavedViews.mount(tools, { page: "bookings",
        builtins: [{ id: "b-owed", name: "Still owe the client something", config: { scope: "owed", stage: ":owed" } },
                   { id: "b-late", name: "Deliverables overdue", config: { scope: "owed", stage: ":overdue" } }],
        get: () => ({ q: el("bkSearch").value, type: el("bkType").value, stage: el("bkStage").value, scope: scopeNow() }),
        apply: (c) => {
          el("bkSearch").value = c.q || ""; el("bkType").value = c.type || "";
          const st = el("bkStage"); st.value = [...st.options].some((o) => o.value === c.stage) ? c.stage : "";
          const want = c.scope || "upcoming";
          if (want !== scopeNow()) { const b = el("bkScope").querySelector('button[data-scope="' + want + '"]'); if (b) b.click(); }
          else st.dispatchEvent(new Event("change"));
        } });
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "small"; btn.textContent = "Change shown…"; btn.id = "aca-lvBkBulk";
      tools.appendChild(btn);
      onFirstShow("panel-bookings", () => { views.ensure(); btn.classList.toggle("hidden", !canEdit("bookings")); });
      btn.addEventListener("click", async () => {
        const rows = [...el("bkBody").querySelectorAll("tr[data-id]")].map((tr) => ({ id: tr.dataset.id, label: ((tr.querySelector("strong") || {}).textContent || "") + " · " + ((tr.querySelector(".bk-date") || {}).textContent || "") }));
        if (!rows.length) return toast("No bookings are shown.", true);
        const labels = [...el("bkStage").options].map((o) => o.value).filter((v) => v && !v.startsWith(":"));
        if (!labels.length) return toast("No stages to move to.", true);
        pickRows("Move bookings to a stage", rows,
          '<div class="field"><label for="aca-lvStage">Stage</label><select id="aca-lvStage">' + labels.map((l) => '<option value="' + esc(l) + '">' + esc(l) + "</option>").join("") + "</select></div>",
          async (ids) => {
            const label = el("lvStage").value;
            const [{ data: bk, error: e1 }, { data: st, error: e2 }] = await Promise.all([sb.from("bookings").select("id, type_key").in("id", ids),
              sb.from("booking_stages").select("id, type_key, label, archived_at").eq("label", label)]);
            if (e1) throw e1; if (e2) throw e2;
            let moved = 0, skipped = 0;
            for (const b of bk || []) {
              const s = (st || []).find((x) => x.type_key === b.type_key && !x.archived_at);
              if (!s) { skipped++; continue; }
              const { data, error } = await sb.rpc("booking_set_stage", { p_booking: b.id, p_stage: s.id });
              if (error || (data && data.ok === false)) skipped++; else moved++;
            }
            Bookings.reload();
            return "Moved " + moved + (moved === 1 ? " booking" : " bookings") + " to " + label + "." + (skipped ? " " + skipped + " skipped (that job type has no such stage)." : "");
          });
      });
    })();

    // ---------------------------------------------------------------- Inventory: Gear tab
    (function gear() {
      const bar = el("invGearChips") && el("invGearChips").parentElement; if (!bar) return;
      const tools = document.createElement("span"); tools.className = "lv-tools"; bar.appendChild(tools);
      const chipNow = () => { const b = el("invGearChips").querySelector('[aria-pressed="true"]'); return b ? b.dataset.f : "all"; };
      const views = SavedViews.mount(tools, { page: "inventory",
        get: () => ({ q: el("invGearFilter").value, f: chipNow() }),
        apply: (c) => {
          el("invGearFilter").value = c.q || "";
          const b = el("invGearChips").querySelector('[data-f="' + (c.f || "all") + '"]');
          if (b) b.click(); else el("invGearFilter").dispatchEvent(new Event("input"));
        } });
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "small"; btn.textContent = "Change shown…"; btn.id = "aca-lvInvBulk";
      tools.appendChild(btn);
      onFirstShow("panel-invgear", () => { views.ensure(); btn.classList.toggle("hidden", !canEdit("inventory")); });
      btn.addEventListener("click", async () => {
        const rows = [...el("invGearBody").querySelectorAll("tr[data-item]")].map((tr) => ({ id: tr.dataset.item, label: ((tr.querySelector("td.name") || {}).firstChild || {}).textContent || "Item" }));
        if (!rows.length) return toast("No items are shown.", true);
        const [{ data: bins }, { data: kits }] = await Promise.all([sb.from("inventory_bins").select("id, code, location").order("code"), sb.from("inventory_kits").select("id, name").order("name")]);
        pickRows("Change these items", rows,
          '<div class="field"><label for="aca-lvInvDo">What to do</label><select id="aca-lvInvDo"><option value="move">Move them to&#8230;</option><option value="service">Log a service today</option><option value="sensor">Log a sensor clean today</option></select></div>' +
          '<div class="field" id="aca-lvInvToF"><label for="aca-lvInvTo">Where</label><select id="aca-lvInvTo">' +
          (bins || []).map((b) => '<option value="b:' + esc(b.id) + '">Bin ' + esc(b.code) + (b.location ? " (" + esc(b.location) + ")" : "") + "</option>").join("") +
          (kits || []).map((k) => '<option value="k:' + esc(k.id) + '">Kit: ' + esc(k.name) + "</option>").join("") + "</select></div>",
          async (ids) => {
            const what = el("lvInvDo").value;
            if (what === "move") {
              const to = el("lvInvTo").value; if (!to) throw new Error("Pick a bin or kit.");
              const { error } = await sb.from("inventory_items").update({ bin_id: to.startsWith("b:") ? to.slice(2) : null, kit_id: to.startsWith("k:") ? to.slice(2) : null }).in("id", ids);
              if (error) throw error;
              Inventory.show("invgear");
              return "Moved " + ids.length + (ids.length === 1 ? " item." : " items.");
            }
            let n = 0;
            for (const id of ids) { const { error } = await sb.rpc("inventory_service_log", { p_item: id, p_done_on: todayStr(), p_kind: what, p_cost: null, p_note: "" }); if (!error) n++; }
            Inventory.show("invgear");
            return "Logged " + (what === "sensor" ? "a sensor clean" : "a service") + " for " + n + (n === 1 ? " item." : " items.");
          });
        const sync = () => el("lvInvToF").classList.toggle("hidden", el("lvInvDo").value !== "move");
        el("lvInvDo").addEventListener("change", sync); sync();
      });
    })();

    return {};
  })();
