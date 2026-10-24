  // ================================================================ DIRECTOR JOURNEY (ws/director, 2026-10-24)
  // What a league or school director gets from us, beyond the booking email series
  // (migration 20261024060000_director_journey.sql):
  //   DirectorFields  the booking's team times and ordering dates (free shipping, 20% off, order by; worked out from
  //                   the picture day unless typed, 2026-10-24), in Book a job and Edit booking
  //                   (booking_director_get / booking_director_save), plus the day-of phone and rain plan rows in
  //                   Settings > Sending (booking_settings.day_of_phone / weather_plan). Since 2026-10-24 (adaptive
  //                   emails) also Shooting (indoors / outdoors / either: weather checks and the rain paragraph),
  //                   Student data received (schools: the two-week email stops asking), and the picture day
  //                   emergency contact rows (booking_settings.emergency_name / _phone / _email).
  //   DayPublic       the read-only "Your picture day" page, admin.207photo.com/#day/<token> (anon booking_public).
  //                   No forms, no uploads: everything on it comes from the booking.
  const DirectorFields = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const st = document.createElement("style");
    st.textContent = `
  .aca .bk-dir-dates { display: flex; gap: 8px 14px; flex-wrap: wrap; align-items: center; }
  .aca .bk-dir-dates label { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; }
  .aca #aca-bkTeamTimes { width: 100%; font-family: inherit; }`;
    document.head.appendChild(st);

    // The rows for the booking form's og-grid (label + field pairs). Values arrive with fill() for an existing booking.
    function formHtml() {
      datesAuto = true; lastCtx = null; shootKey = ""; clearTimeout(shootTimer); // a fresh form
      return '<label for="aca-bkTeamTimes">Team times</label><div><textarea id="aca-bkTeamTimes" rows="3" maxlength="4000" placeholder="9:00 U10 Blue&#10;9:15 U10 Red"></textarea>' +
        '<div class="bk-sub">Optional. One line per team, pasted as is. It goes in the two-week email and on their picture day page.</div></div>' +
        '<label>Ordering</label><div><div class="bk-dir-dates"><label>Free shipping ends <input type="date" id="aca-bkFreeShip" /></label><label>20% off ends <input type="date" id="aca-bkDiscEnds" /></label><label>Order by <input type="date" id="aca-bkOrderBy" /></label></div>' +
          '<div class="bk-sub" id="aca-bkDatesNote"></div>' +
          '<div class="bk-sub">The director sees the 20% date and the order date in the emails and on their page. Free shipping is for us only.</div><div class="bk-sub" id="aca-bkDayLink"></div></div>' +
        '<label for="aca-bkShoot">Shooting</label><div><select id="aca-bkShoot"><option value="">Automatic</option>' +
          '<option value="outdoors">Outdoors</option><option value="indoors">Indoors</option><option value="either">Indoors or outdoors</option></select> <span class="bk-sub" id="aca-bkShootNote"></span>' +
          '<div class="bk-sub">Automatic is indoors. Only a fall or spring sports job can be outdoors: it follows this partner&rsquo;s last job of that season. Outdoors or either: we check the forecast from three days out and the director gets the rain paragraph.</div></div>' +
        '<label>Student data</label><div><label style="display:inline-flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="aca-bkSchoolData" /> Received (schools)</label>' +
          '<div class="bk-sub">Once checked, the two-week email stops asking for it.</div></div>';
    }
    async function fill(id) {
      try {
        const { data, error } = await sb.rpc("booking_director_get", { p_id: id });
        if (error || !data || !el("bkTeamTimes")) return;
        el("bkTeamTimes").value = data.team_times || "";
        datesAuto = data.dates_auto !== false;
        el("bkOrderBy").value = data.order_deadline || "";
        el("bkDiscEnds").value = data.discount_ends || "";
        el("bkFreeShip").value = data.free_ship_ends || "";
        el("bkOrderBy").dataset.ready = "1";
        if (datesAuto && lastCtx) autoDates(lastCtx); else datesNote();
        el("bkShoot").value = data.shoot_setting || "";
        el("bkSchoolData").checked = !!data.school_data;
        el("bkShoot").dataset.ready = "1";
        if (data.day_link) el("bkDayLink").innerHTML = 'Their picture day page: <a href="' + esc(data.day_link) + '" target="_blank" rel="noopener">open</a> &middot; <button type="button" class="link" data-dircopy="' + esc(data.day_link) + '">copy link</button>';
        const c = el("bkDayLink").querySelector("[data-dircopy]");
        if (c) c.addEventListener("click", async () => { try { await navigator.clipboard.writeText(c.dataset.dircopy); c.textContent = "copied"; } catch (_e) { toast(c.dataset.dircopy); } });
      } catch (_e) { /* the form still works without them */ }
    }
    const read = () => el("bkTeamTimes") ? { team_times: el("bkTeamTimes").value.trim(), order_deadline: el("bkOrderBy").value || "", discount_ends: el("bkDiscEnds").value || "",
      free_ship_ends: el("bkFreeShip").value || "", dates_auto: datesAuto,
      shoot_setting: el("bkShoot").value || "", school_data: el("bkSchoolData").checked, _ready: el("bkShoot").dataset.ready === "1", _datesReady: el("bkOrderBy").dataset.ready === "1" } : null;
    const isEmpty = (v) => !v || (!v.team_times && !v.order_deadline && !v.discount_ends && !v.free_ship_ends && !v.shoot_setting && !v.school_data);

    // ---- Ordering dates (2026-10-24): worked out from the launch, the day after the last picture day
    // (booking_order_dates in 20261024230000_booking_autofill.sql; keep the two in step).
    //   sports   free shipping to launch + 3, 20% off to launch + 14, order by launch + 30
    //   schools  free shipping to launch + 14, 20% off to launch + 1 month, order by May 31 (the gallery archives June 1)
    // Typing a date stops it for this booking; "Work them out again" turns it back on.
    let datesAuto = true, lastCtx = null, shootKey = "", shootTimer = null;
    const ymd = (y, m, d) => y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    const plusDays = (s, n) => { const t = new Date(s + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
    const plusMonth = (s) => { const [y, m, d] = s.split("-").map(Number); const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      return ymd(ny, nm, Math.min(d, new Date(Date.UTC(ny, nm, 0)).getUTCDate())); };
    function orderDates(audience, lastDay) {
      if (!lastDay) return null;
      const launch = plusDays(lastDay, 1);
      if (audience === "school") { const [y, m] = lastDay.split("-").map(Number); return { free: plusDays(launch, 14), disc: plusMonth(launch), order: ymd(y + (m >= 6 ? 1 : 0), 5, 31) }; }
      return { free: plusDays(launch, 3), disc: plusDays(launch, 14), order: plusDays(launch, 30) };
    }
    function datesNote() {
      const n = el("bkDatesNote"); if (!n) return;
      n.innerHTML = datesAuto ? "Worked out from the day after the last picture day. They follow the picture day if it moves."
        : 'Typed by hand, so they stay put. <button type="button" class="link" data-dirauto="1">Work them out again</button>';
      const b = n.querySelector("[data-dirauto]");
      if (b) b.addEventListener("click", () => { datesAuto = true; if (lastCtx) autoDates(lastCtx); else datesNote(); });
    }
    function wireDates() {
      ["bkFreeShip", "bkDiscEnds", "bkOrderBy"].forEach((k) => { const x = el(k); if (x && !x.dataset.wired) { x.dataset.wired = "1"; const typed = () => { datesAuto = false; datesNote(); }; x.addEventListener("input", typed); x.addEventListener("change", typed); } });
    }
    // ctx: { audience, lastDay, orgId, typeKey, firstDay, label, bookingId }. Called by the booking form whenever
    // the type, days, title or organization change.
    function autoDates(ctx) {
      lastCtx = ctx; wireDates();
      if (!el("bkOrderBy")) return;
      if (datesAuto) {
        const o = orderDates(ctx.audience, ctx.lastDay);
        el("bkFreeShip").value = o ? o.free : ""; el("bkDiscEnds").value = o ? o.disc : ""; el("bkOrderBy").value = o ? o.order : "";
      }
      datesNote();
      // What "Automatic" shooting comes to, next to the dropdown.
      const key = [ctx.orgId, ctx.typeKey, ctx.firstDay, ctx.label].join("|");
      if (key === shootKey) return;
      shootKey = key; clearTimeout(shootTimer);
      const note = el("bkShootNote"); if (note) note.textContent = "";
      if (!ctx.orgId || !ctx.typeKey || !ctx.firstDay) return;
      shootTimer = setTimeout(async () => {
        try {
          const { data, error } = await sb.rpc("booking_shoot_auto", { p_org: ctx.orgId, p_type: ctx.typeKey, p_day: ctx.firstDay, p_label: ctx.label || "", p_exclude: ctx.bookingId || null });
          if (error || shootKey !== key || !el("bkShootNote")) return;
          el("bkShootNote").textContent = "Automatic comes to " + (data === "outdoors" ? "outdoors" : data === "either" ? "indoors or outdoors" : "indoors") + ".";
        } catch (_e) { /* just the hint */ }
      }, 300);
    }
    // Saved after booking_create / booking_update (their signatures stay as they are). Returns "" or the reason it failed.
    async function save(id, v, isNew) {
      if (!v || !id || (isNew && isEmpty(v))) return "";
      if (!v.dates_auto) {
        if (v.free_ship_ends && v.discount_ends && v.free_ship_ends > v.discount_ends) return "free shipping can't end after the 20% off";
        if (v.order_deadline && ((v.discount_ends && v.discount_ends > v.order_deadline) || (v.free_ship_ends && v.free_ship_ends > v.order_deadline))) return "the discount can't end after the order deadline";
      }
      v = Object.assign({}, v);
      // an existing booking whose values never loaded keeps what it has (blank would make Shooting automatic again,
      // and the dates would be worked out again)
      if (!isNew && !v._ready) { delete v.shoot_setting; delete v.school_data; }
      if (!isNew && !v._datesReady) { delete v.order_deadline; delete v.discount_ends; delete v.free_ship_ends; delete v.dates_auto; }
      if (v.dates_auto) { delete v.order_deadline; delete v.discount_ends; delete v.free_ship_ends; }
      delete v._ready; delete v._datesReady;
      try {
        const { error } = await sb.rpc("booking_director_save", { p_id: id, p: v });
        if (error) throw error;
        return "";
      } catch (e) { return cleanErr(e); }
    }

    // Settings > Sending, "Booking emails: from and signature": two more rows for the kv grid.
    function sendingHtml(bs) {
      return '<label for="aca-ssDayPhone">Picture day phone</label><div><input type="text" id="aca-ssDayPhone" value="' + esc(bs.day_of_phone == null ? "(207) 558-3185" : bs.day_of_phone) + '" placeholder="(207) 558-3185" />' +
          '<span class="muted" style="font-size:12.5px;display:block;margin-top:2px">Directors see it in their emails and on their picture day page, for problems that morning.</span></div>' +
        '<label for="aca-ssWeather">Rain plan</label><div><textarea id="aca-ssWeather" rows="2">' + esc(bs.weather_plan || "") + "</textarea>" +
          '<span class="muted" style="font-size:12.5px;display:block;margin-top:2px">One or two sentences for outdoor picture days, in the two-week email.</span></div>' +
        '<label for="aca-ssEmName">Emergency contact</label><div><div class="bk-dir-dates"><input type="text" id="aca-ssEmName" value="' + esc(bs.emergency_name || "") + '" placeholder="Name" />' +
          '<input type="text" id="aca-ssEmPhone" value="' + esc(bs.emergency_phone || "") + '" placeholder="Cell" /><input type="email" id="aca-ssEmEmail" value="' + esc(bs.emergency_email || "") + '" placeholder="Email" /></div>' +
          '<span class="muted" style="font-size:12.5px;display:block;margin-top:2px">On every picture day plan and the picture day page, whoever booked the job, with &ldquo;call more than twice to ring through&rdquo;. Leave the cell blank to leave it out.</span></div>';
    }
    const sendingRead = () => el("ssDayPhone") ? { day_of_phone: el("ssDayPhone").value.trim(), weather_plan: el("ssWeather").value.trim(),
      emergency_name: el("ssEmName").value.trim(), emergency_phone: el("ssEmPhone").value.trim(), emergency_email: el("ssEmEmail").value.trim() } : {};

    return { formHtml, fill, read, save, autoDates, sendingHtml, sendingRead };
  })();

  // ================================================================ PUBLIC: Your picture day (no sign-in)
  //   https://admin.207photo.com/#day/<token>   read-only; the database answers only for this token.
  const DayPublic = (function () {
    const route = () => /^#day\/([0-9a-f]{20,64})\/?$/.exec(location.hash);
    const LOGO = "https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/icons/apple-touch-icon.png";
    const longDay = (d) => (d ? new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }) : "");
    const tel = (p) => "tel:" + String(p || "").replace(/[^0-9+]/g, "");
    let box = null;
    function show() {
      const st = document.createElement("style");
      st.textContent = `
      .aca .dyp { max-width: 600px; margin: 0 auto; padding: 24px 16px 64px; font-size: 15px; line-height: 22px; color: var(--text); }
      .aca .dyp-top { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
      .aca .dyp-top img { width: 44px; height: 44px; border-radius: 10px; border: 1px solid var(--border); flex: 0 0 44px; }
      .aca .dyp-top b { display: block; font-size: 13px; color: var(--accent); font-weight: 700; letter-spacing: .02em; }
      .aca .dyp h1 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 700; overflow-wrap: anywhere; }
      .aca .dyp-when { margin: 0 0 14px; padding: 16px; border-radius: 8px; background: var(--accent); color: var(--accent-text); }
      .aca .dyp-when .t { font-size: 19px; line-height: 26px; font-weight: 700; }
      .aca .dyp-when .s { font-size: 14px; opacity: .92; margin-top: 4px; overflow-wrap: anywhere; }
      .aca .dyp-when a { color: inherit; }
      .aca .dyp-acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
      .aca .dyp-acts a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 16px; border-radius: 6px; background: var(--surface); color: var(--accent); font-weight: 700; text-decoration: none; flex: 1 1 140px; }
      .aca .dyp-sec { margin: 0 0 12px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
      .aca .dyp-sec h2 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); font-weight: 700; }
      .aca .dyp-sec p { margin: 0 0 8px; } .aca .dyp-sec p:last-child { margin-bottom: 0; }
      .aca .dyp-sec ul { margin: 0; padding-left: 20px; } .aca .dyp-sec li { margin: 0 0 6px; overflow-wrap: anywhere; }
      .aca .dyp-sec .m { color: var(--muted); font-size: 13.5px; }
      .aca .dyp-note { margin: 0 0 14px; padding: 12px 14px; border-radius: 6px; background: var(--warn-bg); color: var(--warn-fg); }
      .aca .dyp-foot { margin-top: 18px; color: var(--muted); font-size: 13px; text-align: center; }`;
      document.head.appendChild(st);
      ["welcomeView", "loginView", "dashView"].forEach((v) => { const n = el(v); if (n) n.classList.add("hidden"); });
      box = document.createElement("div"); box.className = "dyp"; box.id = "aca-dayPublic";
      document.querySelector(".aca").appendChild(box);
      document.title = "Your picture day | 207 Photo";
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      load(route()[1]);
    }
    const top = (title) => '<div class="dyp-top"><img src="' + LOGO + '" alt="" /><div><b>207 Photo &middot; Your picture day</b><h1>' + esc(title) + "</h1></div></div>";
    const sec = (title, inner) => inner ? '<section class="dyp-sec"><h2>' + esc(title) + "</h2>" + inner + "</section>" : "";
    const list = (items) => items.length ? "<ul>" + items.map((x) => "<li>" + x + "</li>").join("") + "</ul>" : "";
    async function load(token) {
      let data = null;
      try { const r = await supabase.rpc("booking_public", { p_token: token }); data = r.error ? null : r.data; } catch (_e) { data = null; }
      if (!data || !data.found) {
        box.innerHTML = top("This link isn’t working") + "<p>The picture day may have been moved to a new link. Reply to any of our emails, or call us, and we’ll send it again.</p>";
        return;
      }
      render(data);
    }
    function render(d) {
      const c = d.contact || {}, days = d.days || [];
      let h = top(d.org || "Picture day");
      if (d.cancelled) {
        box.innerHTML = h + '<div class="dyp-note"><b>This picture day was cancelled.</b> If you would like a new date, reply to our email' + (c.phone ? ' or call <a href="' + esc(tel(c.phone)) + '">' + esc(c.phone) + "</a>" : "") + ".</div>";
        return;
      }
      h += '<div class="dyp-when"><div class="t">' + days.map((x) => esc(longDay(x.day)) + (x.start ? "<br>" + esc(x.start) + (x.end ? " to " + esc(x.end) : "") : "") + (x.label ? " &middot; " + esc(x.label) : "")).join("<br><br>") + "</div>" +
        '<div class="s">' + (d.time_set ? "" : "We&#8217;ll confirm the time with you.<br>") + (d.location ? 'Where: <a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(d.location) + '" target="_blank" rel="noopener">' + esc(d.location) + "</a>" : "We&#8217;ll confirm the spot with you.") + "</div>" +
        '<div class="dyp-acts">' + (d.calendar_link ? '<a href="' + esc(d.calendar_link) + '" id="aca-dyCal">Add to your calendar</a>' : "") + (c.phone ? '<a href="' + esc(tel(c.phone)) + '">Call ' + esc(c.phone) + "</a>" : "") + "</div></div>";
      h += sec("Your contact at 207 Photo", "<p><b>" + esc(c.name || "207 Photo") + "</b>" + (c.email ? '<br><a href="mailto:' + esc(c.email) + '">' + esc(c.email) + "</a>" : "") +
        (c.phone ? '<br>Picture day phone: <a href="' + esc(tel(c.phone)) + '">' + esc(c.phone) + "</a>" : "") + '</p><p class="m">Questions any time: reply to any of our emails.</p>');
      const onDay = [];
      if (d.arrival) onDay.push("We arrive by <b>" + esc(d.arrival) + "</b> to set up.");
      if (d.needs) onDay.push("What we need: " + esc(d.needs));
      onDay.push("Please send us the name and mobile number of your on-site contact for the day (just reply to our email).");
      h += sec("On picture day", list(onDay) + (d.weather ? "<p style=\"margin-top:10px\"><b>If the weather looks bad:</b> " + esc(d.weather) + "</p>" : ""));
      const em = d.emergency;
      if (em && em.phone) h += sec("Picture day emergency", "<p>If something goes wrong and you can&#8217;t reach us, call <b>" + esc(em.name || "Jeremiah") + '</b> directly at <a href="' + esc(tel(em.phone)) + '">' + esc(em.phone) + "</a>" +
        (em.email ? ' (or email <a href="mailto:' + esc(em.email) + '">' + esc(em.email) + "</a>)" : "") + ".</p><p class=\"m\">That phone screens calls. If it goes to voicemail, call again right away: calling more than twice in a row rings through.</p>");
      if ((d.team_times || []).length) h += sec("Team times", list(d.team_times.map(esc)));
      const before = [];
      if (d.roster) before.push(esc(d.roster));
      if (d.flyer) before.push(esc(d.flyer).replace(/(207photo\.com\/(?:sportsadmin|schooladmin))/, '<a href="' + esc(d.hub_link || "https://" + d.hub) + '" target="_blank" rel="noopener">$1</a>'));
      h += sec("Before picture day", list(before));
      h += sec("How it works for families", list((d.families || []).map(esc)));
      const get = [];
      if (d.terms) get.push(esc(d.terms));
      (d.deliverables || []).forEach((x) => get.push(esc(x.label) + (x.done ? (x.link ? ': <a href="' + esc(x.link) + '" target="_blank" rel="noopener">open</a>' : " (delivered)") : ' <span class="m">(coming after the gallery is live)</span>')));
      h += sec("What your program gets", list(get));
      if (d.retake) h += sec(d.audience === "school" ? "Makeup day" : "Missed the day?", "<p>" + esc(d.retake).replace(/207photo\.com\/makeups/, '<a href="https://207photo.com/makeups" target="_blank" rel="noopener">207photo.com/makeups</a>') + "</p>");
      if (d.agreement) h += sec("Agreement", '<p><a href="' + esc(d.agreement.link) + '" target="_blank" rel="noopener">' + (d.agreement.status === "accepted" ? "Your agreement (accepted" + (d.agreement.accepted_at ? " " + esc(longDay(d.agreement.accepted_at)) : "") + ")" : "Read and accept the agreement") + "</a></p>");
      h += '<p class="dyp-foot">This page updates as we go. Bookmark it, or forward it to your board.</p>';
      box.innerHTML = h;
    }
    return { wanted: () => !!route(), show };
  })();
  registerPublicPage(DayPublic);
