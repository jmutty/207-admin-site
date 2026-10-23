  // ================================================================ Saved views (2026-10-22)
  // A "View" picker for list pages: save the filters you have set under a name, private or shared with everyone
  // who can see the page, and pick it again later. Rows live in public.saved_views (RLS: your own, plus shared
  // ones; migration 20261022234500). Organizations has its own (prospect_saved_views).
  //   SavedViews.mount(hostEl, { page: "taskboard" | "bookings" | "inventory", get: () => config, apply: (config) => {}, builtins: [{ id, name, config }] })
  // returns { ensure() (call it when the page is shown), refresh(), clear() }. The last view picked on each page is remembered on this device.
  const SavedViews = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .sv-bar { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .aca .sv-bar select { max-width: 220px; }
    .aca .sv-bar .link { font-size: 13px; }
    .aca .sv-modal .field input[type=text] { width: 100%; }
    .aca .sv-modal .chk { display: flex; gap: 8px; align-items: center; font-size: 13.5px; margin: 4px 0 12px; }
    .aca .sv-modal .chk input { width: 16px; height: 16px; margin: 0; }`;
    const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);
    const remember = (page, id) => { try { localStorage.setItem("aca-view-" + page, id || ""); } catch (_e) { /* private mode */ } };
    const recall = (page) => { try { return localStorage.getItem("aca-view-" + page) || ""; } catch (_e) { return ""; } };
    let n = 0;

    function mount(host, o) {
      const id = "sv" + (++n), builtins = o.builtins || [];
      let views = [], me = null;
      const wrap = document.createElement("span");
      wrap.className = "sv-bar";
      wrap.innerHTML = '<select class="small" id="aca-' + id + 'Pick" aria-label="Saved view"><option value="">View&#8230;</option></select>' +
        '<button type="button" class="link" id="aca-' + id + 'Save">Save view</button><button type="button" class="link hidden" id="aca-' + id + 'Del">Delete</button>';
      host.appendChild(wrap);
      const pick = el(id + "Pick"), del = el(id + "Del");

      function fill() {
        const cur = pick.value;
        const mine = views.filter((v) => v.user_id === me), shared = views.filter((v) => v.user_id !== me);
        const opt = (v, label) => '<option value="' + esc(v.id) + '">' + esc(label || v.name) + "</option>";
        pick.innerHTML = '<option value="">View&#8230;</option>' +
          (builtins.length ? '<optgroup label="Built in">' + builtins.map((v) => opt(v)).join("") + "</optgroup>" : "") +
          (mine.length ? '<optgroup label="Mine">' + mine.map((v) => opt(v, v.name + (v.shared ? " (shared)" : ""))).join("") + "</optgroup>" : "") +
          (shared.length ? '<optgroup label="Shared by the team">' + shared.map((v) => opt(v)).join("") + "</optgroup>" : "");
        pick.value = [...pick.options].some((x) => x.value === cur) ? cur : "";
        del.classList.toggle("hidden", !mine.some((v) => v.id === pick.value));
      }
      async function refresh() {
        try {
          me = (typeof ACCESS !== "undefined" && ACCESS.user_id) || null;
          const { data, error } = await sb.from("saved_views").select("id, user_id, name, config, shared, sort").eq("page", o.page).order("sort").order("name");
          if (error) throw error;
          views = data || [];
          fill();
          const last = recall(o.page);
          if (last && !pick.value && [...pick.options].some((x) => x.value === last)) { pick.value = last; choose(false); }
        } catch (_e) { /* the picker just stays empty */ }
      }
      function choose(save) {
        const v = builtins.find((x) => x.id === pick.value) || views.find((x) => x.id === pick.value);
        del.classList.toggle("hidden", !(v && v.user_id === me));
        if (save !== false) remember(o.page, pick.value);
        if (v) o.apply(JSON.parse(JSON.stringify(v.config || {})));
      }
      pick.addEventListener("change", () => choose(true));
      del.addEventListener("click", async () => {
        const v = views.find((x) => x.id === pick.value);
        if (!v || !confirm("Delete the view “" + v.name + "”?")) return;
        const { error } = await sb.from("saved_views").delete().eq("id", v.id);
        if (error) return toast(cleanErr(error), true);
        views = views.filter((x) => x.id !== v.id); pick.value = ""; remember(o.page, ""); fill(); toast("Deleted.");
      });
      el(id + "Save").addEventListener("click", () => {
        const cur = views.find((x) => x.id === pick.value && x.user_id === me);
        const m = openModal('<div class="sv-modal"><h2>Save this view</h2><p class="muted" style="margin-top:0">Saves the filters you have set now, so you can pick them again from the View list.</p>' +
          '<div class="field"><label for="aca-svName">Name</label><input type="text" id="aca-svName" maxlength="60" value="' + esc(cur ? cur.name : "") + '" placeholder="My open tasks due this week" /></div>' +
          '<label class="chk"><input type="checkbox" id="aca-svShared"' + (cur && cur.shared ? " checked" : "") + " /> Share it with everyone who can see this page</label>" +
          '<div class="inline-error hidden" id="aca-svErr"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-m="cancel">Cancel</button>' +
          '<button type="button" class="primary" data-m="save">Save</button></div></div>');
        const err = (t) => { const e = el("svErr"); e.textContent = t; e.classList.remove("hidden"); };
        m.addEventListener("click", async (ev) => {
          const b = ev.target.closest("[data-m]"); if (!b) return;
          if (b.dataset.m === "cancel") return m.close();
          const name = el("svName").value.trim(), shared = el("svShared").checked;
          if (!name) return err("Give the view a name.");
          b.disabled = true;
          try {
            const same = views.find((x) => x.user_id === me && x.name.toLowerCase() === name.toLowerCase());
            const row = { page: o.page, name, config: o.get(), shared };
            const res = same ? await sb.from("saved_views").update(row).eq("id", same.id).select("id, user_id, name, config, shared, sort").single()
                             : await sb.from("saved_views").insert(Object.assign(row, { sort: views.length })).select("id, user_id, name, config, shared, sort").single();
            if (res.error) throw res.error;
            const v = res.data || {};
            if (!v.user_id) v.user_id = me;
            views = views.filter((x) => x.id !== v.id).concat([v]);
            fill(); pick.value = v.id; remember(o.page, v.id); del.classList.remove("hidden");
            m.close(); toast(shared ? "Saved and shared." : "Saved.");
          } catch (e) { err(cleanErr(e)); b.disabled = false; }
        });
      });
      let loaded = false;
      // Load on first show of the page (the person is signed in by then).
      const ensure = () => { if (!loaded) { loaded = true; refresh(); } };
      return { refresh, ensure, clear: () => { pick.value = ""; remember(o.page, ""); del.classList.add("hidden"); } };
    }
    return { mount };
  })();
