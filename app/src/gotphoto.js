  // ================================================================ GotPhoto automations (2026-10-24)
  // What the gotphoto-tasks edge function brings back from GotPhoto's API, and the one button that writes to it
  // (migration 20261024160000_gotphoto_tasks.sql):
  //   - a GotPhoto tab on the job page: live or not (with Launch), photos per gallery and tagging, families registered
  //     and ordered, the dates we send GotPhoto, and the last few writes. RPCs gp_job_panel, gp_job_launch.
  //   - a "Families in GotPhoto" line on the Hub tab (parents-reach.js calls GpTasks.familiesLine).
  //   - Today: jobs with no photos in GotPhoto three days after picture day (gp_photos_missing).
  //   - Settings > Company: the switches (gp_task_settings_get / _save).
  const GpTasks = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .gp-sec { margin: 0 0 22px; max-width: 820px; }
    .aca .gp-sec h3 { margin: 0 0 6px; font-size: 13px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--head); }
    .aca .gp-sec .note { color: var(--muted); font-size: 13px; margin: 0 0 8px; }
    .aca .gp-live { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 14px; }
    .aca .gp-tbl { width: 100%; font-size: 13.5px; border-collapse: collapse; }
    .aca .gp-tbl td, .aca .gp-tbl th { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--line2); vertical-align: top; }
    .aca .gp-tbl th { font-size: 12px; color: var(--faint); font-weight: 600; }
    .aca .gp-tbl .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .aca .gp-big { display: flex; gap: 28px; flex-wrap: wrap; margin: 2px 0 6px; }
    .aca .gp-big div { display: grid; } .aca .gp-big b { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; } .aca .gp-big span { color: var(--muted); font-size: 12.5px; }
    .aca .gp-sw { display: grid; gap: 10px; padding: 12px 16px 16px; }
    .aca .gp-sw label { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; } .aca .gp-sw label span { color: var(--muted); font-size: 13px; display: block; }`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    const day = (d) => Fmt.day(d ? String(d).slice(0, 10) : "");
    const when = (ts) => (ts ? fmtAgo(ts) : "");
    const plus1 = (d) => { const x = new Date(String(d).slice(0, 10) + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
    const ACTION = { launch: "Launch", dates: "Dates sent" };

    // ---------------------------------------------------------------- job page tab
    async function render(bk, box) {
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const { data: d, error } = await sb.rpc("gp_job_panel", { p_booking: bk.id });
      if (error) { box.innerHTML = '<div class="inline-error">' + esc(cleanErr(error)) + "</div>"; return; }
      if (!d.linked) {
        box.innerHTML = '<div class="empty">This job isn&#8217;t linked to a GotPhoto job yet.' + (d.can_edit ? " Link it with Edit booking." : "") + "</div>";
        return;
      }
      const live = d.status === "published";
      const open = (d.actions || []).find((a) => !a.done_at);
      const launching = open && open.action === "launch";
      const gals = (d.galleries || []).filter((g) => g.photos > 0 || (d.galleries || []).length <= 12);
      const reg = d.registered, buy = d.buyers;
      let h = '<div class="gp-sec"><h3>Gallery</h3><div class="gp-live">' +
        (live ? '<span class="pill ok">Live</span> ' + (d.activated_at ? "since " + esc(day(d.activated_at)) : "")
          : '<span class="pill warn">Not live</span>' + (launching ? ' <span class="muted">Launching&#8230;</span>' : "")) +
        (!live && d.can_edit && !launching ? ' <button type="button" class="small primary" data-gp="launch">Launch in GotPhoto</button>' : "") +
        ' <span class="muted">' + esc(d.name || "") + " &middot; job " + esc(d.job_id) + "</span></div>" +
        (!live && d.can_edit ? '<p class="note" style="margin-top:6px">Launch sets the job to selling in GotPhoto, the same as releasing it there. Families can see their photos right away.</p>' : "") + "</div>";

      h += '<div class="gp-sec"><h3>Photos</h3>' + (d.galleries_at
        ? (num(d.photo_count)
          ? '<div class="gp-big"><div><b>' + num(d.photo_count).toLocaleString() + "</b><span>photos in " + num((d.galleries || []).filter((g) => g.photos > 0).length) + " galleries</span></div>" +
            (d.tagging_done === true ? '<div><b>&#10003;</b><span>tagging finished</span></div>' : d.tagging_done === false && d.access_type !== "single_password" ? "<div><b>&#8230;</b><span>tagging not finished</span></div>" : "") + "</div>" +
            '<table class="gp-tbl"><thead><tr><th>Gallery</th><th class="n">Photos</th><th>Tagged</th></tr></thead><tbody>' +
            gals.map((g) => "<tr><td>" + esc(g.name) + '</td><td class="n">' + num(g.photos).toLocaleString() + "</td><td>" + (g.photos ? (g.tagged ? "yes" : '<span class="muted">not yet</span>') : "") + "</td></tr>").join("") + "</tbody></table>"
          : '<p class="note">No photos uploaded yet.</p>') +
          '<p class="note" style="margin-top:6px">Checked ' + esc(when(d.galleries_at)) + (d.first_photo_at ? ". First photos seen " + esc(when(d.first_photo_at)) : "") + ".</p>"
        : '<p class="note">Not checked yet. Photos are checked every 20 minutes around picture day.</p>') + "</div>";

      if (live || reg != null) {
        h += '<div class="gp-sec"><h3>Families</h3>' + (reg != null
          ? '<div class="gp-big"><div><b>' + num(reg) + "</b><span>registered on their code</span></div><div><b>" + num(buy) + "</b><span>ordered" +
            (num(reg) ? " (" + Math.round(100 * num(buy) / num(reg)) + "%)" : "") + "</span></div></div>" +
            '<p class="note">From GotPhoto, checked ' + esc(when(d.customers_at)) + ". Registered families get GotPhoto&#8217;s own reminder emails.</p>"
          : '<p class="note">Not checked yet.</p>') + "</div>";
      }

      h += '<div class="gp-sec"><h3>Dates we send GotPhoto</h3><p class="note">' + (d.push_dates
        ? "When the picture day or order deadline changes on this booking, GotPhoto gets the new date. The order deadline sets GotPhoto&#8217;s archive date: the job stops selling the day after."
        : "Off in Settings &rsaquo; Company, so date changes here don&#8217;t reach GotPhoto.") + "</p>" +
        '<table class="gp-tbl"><tbody><tr><td>Picture day</td><td>' + esc(day(d.picture_day) || "not set") + '</td><td class="muted">GotPhoto shoot date</td></tr>' +
        "<tr><td>Order deadline</td><td>" + esc(day(d.order_deadline) || "not set") + '</td><td class="muted">' + (d.order_deadline ? "archives " + esc(day(plus1(d.order_deadline))) : "") + "</td></tr></tbody></table></div>";

      if ((d.actions || []).length) {
        h += '<div class="gp-sec"><h3>Sent to GotPhoto</h3><table class="gp-tbl"><tbody>' + d.actions.map((a) => "<tr><td>" + esc(ACTION[a.action] || a.action) +
          (a.action === "dates" ? ' <span class="muted">' + esc([a.payload.shoot ? "shoot " + day(a.payload.shoot) : "", a.payload.archive ? "archive " + day(a.payload.archive) : ""].filter(Boolean).join(", ")) + "</span>" : "") +
          "</td><td>" + (a.done_at ? (a.ok ? '<span class="pill ok">done</span>' : '<span class="pill err">failed</span> <span class="muted">' + esc(a.error || "") + "</span>")
            : a.error ? '<span class="pill warn">retrying</span> <span class="muted">' + esc(a.error) + "</span>" : '<span class="pill muted">waiting</span>') +
          '</td><td class="n muted">' + esc(when(a.done_at || a.requested_at)) + "</td></tr>").join("") + "</tbody></table></div>";
      }
      box.innerHTML = h;
      box.onclick = async (e) => {
        const b = e.target.closest("button[data-gp=launch]"); if (!b) return;
        if (!confirm("Launch " + (d.name || "this job") + " in GotPhoto now? Families can see and order their photos right away.")) return;
        b.disabled = true;
        const { data: r, error: err } = await sb.rpc("gp_job_launch", { p_booking: bk.id });
        if (err || !r || !r.ok) {
          b.disabled = false;
          const why = err ? cleanErr(err) : ({ forbidden: "you need edit access to Bookings", no_job: "the job isn't linked to GotPhoto", already_live: "it's already live" }[r && r.error] || (r && r.error));
          toast("Not launched: " + why, true); return;
        }
        toast("Launching in GotPhoto&#8230;".replace("&#8230;", "…"));
        // The function runs right away; look again a few times so the tab shows the result.
        for (let i = 0; i < 8; i++) {
          await new Promise((res) => setTimeout(res, 3000));
          const { data: again } = await sb.rpc("gp_job_panel", { p_booking: bk.id });
          if (again && (again.status === "published" || (again.actions || []).some((a) => a.action === "launch" && a.done_at))) break;
        }
        render(bk, box);
      };
    }
    if (typeof registerJobTab === "function") registerJobTab({ id: "gotphoto", label: "GotPhoto", order: 62, module: "bookings", render });

    // ---------------------------------------------------------------- Hub tab line
    async function familiesLine(bkId) {
      try {
        const { data: d } = await sb.rpc("gp_job_panel", { p_booking: bkId });
        if (!d || !d.linked || d.registered == null) return "";
        return "<span>Families registered in GotPhoto: <b>" + num(d.registered) + "</b></span><span>Ordered: <b>" + num(d.buyers) + "</b>" +
          (num(d.registered) ? " (" + Math.round(100 * num(d.buyers) / num(d.registered)) + "%)" : "") + "</span>";
      } catch (_e) { return ""; }
    }

    // ---------------------------------------------------------------- Today
    if (typeof registerAttention === "function") {
      registerAttention("photosMissing", { module: "bookings", level: "warn", name: "photos not up",
        one: "A job has no photos in GotPhoto three days after picture day.", many: "{n} jobs have no photos in GotPhoto three days after picture day." });
      registerTodayLoader("bookings", loadAttention);
    }
    async function loadAttention() {
      try {
        const { data, error } = await sb.rpc("gp_photos_missing");
        if (error) throw error;
        const list = Array.isArray(data) ? data : [];
        setAttention("photosMissing", list.length, "job(s) with no photos in GotPhoto yet", "bookings", "warn", null,
          list.map((j) => ({ id: j.id, title: j.title, day: j.day, tab: "gotphoto" })));
      } catch (_e) { /* the line just doesn't show */ }
    }

    // ---------------------------------------------------------------- Settings > Company
    const SWITCHES = [
      ["orders_from_api", "Read orders from GotPhoto", "New paid orders come in from GotPhoto every 10 minutes for the photo release page. The Gmail script can keep running: the same order is never stored twice."],
      ["makeup_coupons", "Make a coupon for each makeup", "A makeup that arrives without a coupon gets one made in GotPhoto: $30 off products and $10 off shipping, one use."],
      ["makeup_auto_send", "Send the makeup email by itself", "When the athlete&#8217;s photos are found in the team&#8217;s job, the &#8220;photos are ready&#8221; email goes out without waiting for you."],
      ["push_dates", "Send booking dates to GotPhoto", "A changed picture day or order deadline updates the GotPhoto job (shoot date, and archive the day after the order deadline)."],
      ["link_parents", "Add parents to their code", "After you send a code from Help requests, the parent is added to that code in GotPhoto, so GotPhoto&#8217;s reminder emails reach them."],
    ];
    async function loadSettings() {
      const box = el("gpTasksBody"); if (!box) return;
      const { data: d, error } = await sb.rpc("gp_task_settings_get");
      if (error || !d) { box.innerHTML = ""; return; }
      const last = d.last_run || {};
      box.innerHTML = '<div class="card"><div class="card-head"><div><h2>GotPhoto automations</h2><p>Checked every 10 minutes' +
        (last.at ? ", last " + esc(fmtAgo(last.at)) + (last.ok === false ? ' <span class="pill warn">something failed</span>' : "") : "") + "." +
        (d.orders_last && d.orders_last.at ? " Last order brought in " + esc(fmtAgo(d.orders_last.at)) + "." : "") + "</p></div></div>" +
        '<div class="gp-sw">' + SWITCHES.map((s) => '<label><input type="checkbox" data-gpsw="' + s[0] + '"' + (d[s[0]] ? " checked" : "") + (d.can_edit ? "" : " disabled") +
          " /><div><b>" + s[1] + "</b><span>" + s[2] + "</span></div></label>").join("") + "</div></div>";
      box.onchange = async (e) => {
        const c = e.target.closest("input[data-gpsw]"); if (!c) return;
        c.disabled = true;
        const { data: r, error: err } = await sb.rpc("gp_task_settings_save", { p: { [c.dataset.gpsw]: c.checked } });
        c.disabled = false;
        if (err || !r || !r.ok) { c.checked = !c.checked; toast("Not saved: " + (err ? cleanErr(err) : r && r.error), true); return; }
        toast("Saved.");
      };
    }

    return { render, familiesLine, loadSettings, loadAttention };
  })();
