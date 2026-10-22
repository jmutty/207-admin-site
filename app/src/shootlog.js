  // ================================================================ STAFF: Shoot log (2026-10-22, Airstudio plan L)
  // After a picture day the lead logs, from their phone: cards used, teams or classes shot, how many people,
  // absences and issues. Logging the job's last day ticks its "picture day" stage. An issue pushes to whoever
  // can see the Photographed check, and absences show there. A 7:30pm push reminds crew who haven't logged.
  // View = log the jobs you are on; Edit = everyone's. Link: #staff/shootlog/<booking id>/<day>.
  // RPCs (supabase/migrations/20261022235500_photocheck_shootlog.sql): sl_mine, sl_get, sl_save, sl_attention.
  registerPage({ id: "shootlog", group: "Staff", section: "staff", module: "shootlog", selfService: true, // View = log your own jobs
                 tabs: [["shootlog", "Shoot log"]], onShow: () => ShootLog.show() });
  registerAttention("slToLog", { module: "shootlog", level: "warn", name: "shoot logs",
    one: "Log your shoot: cards, teams shot, absences and any issues.", many: "{n} shoots of yours aren't logged yet." });
  registerTodayLoader("shootlog", () => ShootLog.loadAttention());

  const ShootLog = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .sg-wrap { max-width: 640px; }
    .aca .sg-item { display: flex; gap: 12px; align-items: center; width: 100%; height: auto; min-height: 56px; padding: 10px 12px; margin: 0 0 8px; text-align: left; font-weight: 400; white-space: normal;
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
    .aca .sg-item b { display: block; font-size: 14.5px; }
    .aca .sg-item .s { display: block; color: var(--muted); font-size: 12.5px; }
    .aca .sg-item .grow { flex: 1; min-width: 0; }
    .aca .sg-head h2 { margin: 4px 0 2px; font-size: 19px; font-weight: 600; }
    .aca .sg-meta { margin: 0 0 14px; color: var(--muted); font-size: 13.5px; }
    .aca .sg-days { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 14px; }
    .aca .sg-days button[aria-pressed="true"] { background: var(--text); color: var(--surface); border-color: var(--text); }
    .aca .sg-f { margin: 0 0 18px; }
    .aca .sg-f > label, .aca .sg-f > .lbl { display: block; font-weight: 600; font-size: 14px; margin: 0 0 6px; }
    .aca .sg-f .hint { display: block; font-weight: 400; color: var(--muted); font-size: 12.5px; }
    .aca .sg-f textarea { width: 100%; min-height: 72px; padding: 8px 10px; font-size: 15px; }
    .aca .sg-f input[type=text] { width: 100%; font-size: 15px; }
    .aca .sg-step { display: inline-flex; align-items: center; gap: 0; }
    .aca .sg-step button { min-width: 44px; min-height: 44px; font-size: 20px; padding: 0; }
    .aca .sg-step input { width: 72px; min-height: 44px; text-align: center; font-size: 17px; }
    .aca .sg-groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
    .aca .sg-groups label { display: flex; gap: 8px; align-items: center; padding: 9px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; cursor: pointer; background: var(--surface); }
    .aca .sg-groups input { width: 18px; height: 18px; flex: none; }
    .aca .sg-save { position: sticky; bottom: 0; padding: 10px 0; background: var(--bg, #fff); display: flex; gap: 8px; align-items: center; }
    .aca .sg-save button.primary { min-height: 46px; padding: 0 26px; font-size: 15px; }
    @media (max-width: 700px) { .aca .sg-save button.primary { flex: 1; } }`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    let D = null; // sl_get for the open job day
    const root = () => el("panel-shootlog");
    const openIds = () => { const m = /^#staff\/shootlog\/([^/?]+)(?:\/(\d{4}-\d{2}-\d{2}))?/.exec(location.hash); return m ? { id: m[1], day: m[2] || null } : null; };
    const dayName = (d) => T.fmtDay(d, { weekday: "short", month: "short", day: "numeric" });

    function show() { const o = openIds(); if (o) open(o.id, o.day); else list(); }

    async function list() {
      D = null;
      const r = root();
      r.innerHTML = '<div class="card sg-wrap"><div class="card-head"><div><h2>Shoot log</h2><p>After a picture day, log the cards you used, the teams or classes you shot, who was absent and anything that went wrong. It takes a minute and tells the office what to expect.</p></div></div><div id="aca-sgList"><div class="empty"><span class="spin"></span>Loading&#8230;</div></div></div>';
      const { data, error } = await sb.rpc("sl_mine");
      const box = el("sgList");
      if (!box) return;
      if (error) { box.innerHTML = '<div class="inline-error">' + esc(cleanErr(error)) + "</div>"; return; }
      const jobs = (data && data.jobs) || [];
      if (!jobs.length) { box.innerHTML = '<div class="empty">' + (data && data.can_edit ? "No booked jobs in the last two weeks." : "No jobs of yours in the last two weeks.") + "</div>"; return; }
      box.innerHTML = jobs.map((j) => '<button type="button" class="sg-item" data-id="' + esc(j.booking_id) + '" data-day="' + esc(j.day) + '"><span class="grow"><b>' + esc(j.title) + "</b>" +
        '<span class="s">' + esc(dayName(j.day)) + (j.location ? " &#183; " + esc(j.location) : "") + (data.can_edit && !j.mine ? " &#183; not yours" : "") + "</span></span>" +
        (j.logged_at ? '<span class="pill ok">Logged</span>' + (j.issues ? ' <span class="pill warn">Issue</span>' : "") : j.day === data.today ? '<span class="pill warn">Log today</span>' : '<span class="pill warn">Not logged</span>') + "</button>").join("");
      box.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => {
        history.replaceState(null, "", "#staff/shootlog/" + b.dataset.id + "/" + b.dataset.day); open(b.dataset.id, b.dataset.day);
      }));
    }

    async function open(id, day) {
      const r = root();
      r.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const { data, error } = await sb.rpc("sl_get", { p_booking: id, p_day: day || null });
      if (error) { r.innerHTML = '<p><button type="button" class="link" id="aca-sgBack">&#8592; Shoot log</button></p><div class="inline-error">' + esc(cleanErr(error)) + "</div>"; el("sgBack").onclick = back; return; }
      D = data;
      render();
    }
    function back() { history.replaceState(null, "", "#staff/shootlog"); list(); }

    const stepper = (id, v, max) => '<span class="sg-step"><button type="button" class="small" data-step="' + id + '" data-d="-1" aria-label="One fewer">&#8722;</button>' +
      '<input type="number" inputmode="numeric" id="aca-' + id + '" min="0" max="' + max + '" value="' + (v == null ? "" : num(v)) + '" /><button type="button" class="small" data-step="' + id + '" data-d="1" aria-label="One more">+</button></span>';

    function render() {
      const b = D.booking, l = D.log || {}, today = T.today();
      const future = D.day > today, ok = D.can_edit && b.status === "booked" && !future;
      const groups = D.groups || [], ticked = l.groups || [];
      let h = '<div class="sg-wrap"><p style="margin:0 0 8px"><button type="button" class="link" id="aca-sgBack">&#8592; Shoot log</button></p>' +
        '<div class="sg-head"><h2>' + esc(b.title) + "</h2></div>" +
        '<p class="sg-meta">' + esc(dayName(D.day)) + (b.location ? " &#183; " + esc(b.location) : "") + ((D.crew || []).length ? " &#183; " + esc(D.crew.join(", ")) : "") + "</p>";
      if ((D.days || []).length > 1) h += '<div class="sg-days">' + D.days.map((d) => '<button type="button" class="small" data-day="' + esc(d) + '" aria-pressed="' + (d === D.day) + '">' + esc(dayName(d)) + "</button>").join("") + "</div>";
      if (future) h += '<div class="pa-banner">This day hasn&#8217;t happened yet. Come back after the shoot.</div>';
      if (D.log) h += '<p class="muted" style="font-size:13px;margin:0 0 14px">Logged by ' + esc(l.by_name || "someone") + ", " + esc(fmtAgo(l.updated_at)) + ". Change anything and save again.</p>";
      h += '<div class="sg-f"><span class="lbl">Cards used</span>' + stepper("sgCards", l.cards, 99) + "</div>" +
        '<div class="sg-f"><label for="aca-sgLabels">Card labels <span class="hint">How you marked them, so the office can match them up</span></label><input type="text" id="aca-sgLabels" maxlength="300" value="' + esc(l.card_labels || "") + '" placeholder="A, B, C" /></div>';
      if (groups.length) {
        h += '<div class="sg-f"><span class="lbl">' + (b.audience === "school" ? "Classes" : "Teams") + ' shot <span class="hint" id="aca-sgGCount"></span></span><div class="sg-groups">' +
          groups.map((g, i) => '<label><input type="checkbox" data-g="' + i + '"' + (ticked.includes(g) ? " checked" : "") + " />" + esc(g) + "</label>").join("") + "</div></div>";
      } else {
        h += '<div class="sg-f"><span class="lbl">' + (b.audience === "school" ? "Classes" : "Teams") + " shot</span>" + stepper("sgGroups", l.groups_shot, 999) + "</div>";
      }
      h += '<div class="sg-f"><span class="lbl">People photographed <span class="hint">Roughly is fine</span></span>' + stepper("sgSubjects", l.subjects_shot, 9999) + "</div>" +
        '<div class="sg-f"><label for="aca-sgAbs">Absent <span class="hint">Names, one per line, with the team or class if you know it</span></label><textarea id="aca-sgAbs">' + esc(l.absences || "") + "</textarea></div>" +
        '<div class="sg-f"><label for="aca-sgIssues">Issues <span class="hint">Anything the office should know: gear, a late team, a parent complaint. This sends a notification.</span></label><textarea id="aca-sgIssues">' + esc(l.issues || "") + "</textarea></div>" +
        '<div class="sg-f"><label for="aca-sgNotes">Notes for next time</label><textarea id="aca-sgNotes">' + esc(l.notes || "") + "</textarea></div>" +
        '<div class="inline-error hidden" id="aca-sgErr"></div>' +
        (ok ? '<div class="sg-save"><button type="button" class="primary" id="aca-sgSave">' + (D.log ? "Save changes" : "Save the log") + "</button></div>" : "") + "</div>";
      root().innerHTML = h;
      el("sgBack").onclick = back;
      root().querySelectorAll("[data-day]").forEach((x) => x.addEventListener("click", () => {
        history.replaceState(null, "", "#staff/shootlog/" + b.id + "/" + x.dataset.day); open(b.id, x.dataset.day);
      }));
      root().querySelectorAll("[data-step]").forEach((x) => x.addEventListener("click", () => {
        const inp = el(x.dataset.step); inp.value = Math.max(0, Math.min(+inp.max, (+inp.value || 0) + +x.dataset.d));
      }));
      const gc = () => { const n = root().querySelectorAll("[data-g]:checked").length; const c = el("sgGCount"); if (c) c.textContent = n + " of " + groups.length; };
      root().querySelectorAll("[data-g]").forEach((x) => { x.onchange = gc; }); gc();
      if (!ok) { root().querySelectorAll("input,textarea,[data-step]").forEach((x) => { x.disabled = true; }); return; }
      el("sgSave").onclick = async () => {
        clearError("sgErr");
        const btn = el("sgSave"); btn.disabled = true;
        const val = (id) => (el(id) && el(id).value !== "" ? Math.max(0, +el(id).value || 0) : "");
        const p = { cards: val("sgCards"), card_labels: el("sgLabels").value, subjects_shot: val("sgSubjects"),
          groups: groups.filter((g, i) => root().querySelector('[data-g="' + i + '"]').checked), groups_shot: groups.length ? "" : val("sgGroups"),
          absences: el("sgAbs").value, issues: el("sgIssues").value, notes: el("sgNotes").value };
        const { data, error } = await sb.rpc("sl_save", { p_booking: b.id, p_day: D.day, p });
        if (error) { showError("sgErr", cleanErr(error)); btn.disabled = false; return; }
        toast(data.stage ? "Saved. The job is marked picture day done." : "Saved. Thank you!");
        loadAttention();
        open(b.id, D.day);
      };
    }

    // Job page tab: each day's log in a few lines.
    async function renderJobTab(booking, box) {
      const id = (booking && (booking.id || booking.booking_id)) || booking;
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const { data, error } = await sb.rpc("sl_get", { p_booking: id, p_day: null });
      if (error) { box.innerHTML = '<p class="muted">' + esc(cleanErr(error)) + "</p>"; return; }
      const l = data.log;
      box.innerHTML = (l ? "<p><b>" + esc(dayName(data.day)) + "</b>, logged by " + esc(l.by_name || "") + ": " + [l.cards != null ? num(l.cards) + " cards" : "", l.groups_shot != null ? num(l.groups_shot) + " teams or classes" : "",
          l.subjects_shot != null ? num(l.subjects_shot) + " people" : ""].filter(Boolean).join(", ") + "</p>" +
          (l.absences ? '<p class="muted" style="white-space:pre-wrap"><b>Absent:</b> ' + esc(l.absences) + "</p>" : "") + (l.issues ? '<p style="white-space:pre-wrap"><b>Issues:</b> ' + esc(l.issues) + "</p>" : "")
        : "<p>No log for " + esc(dayName(data.day)) + " yet.</p>") +
        '<p><a href="#staff/shootlog/' + esc(id) + "/" + esc(data.day) + '">Open the shoot log</a></p>';
    }

    async function loadAttention() {
      const { data, error } = await sb.rpc("sl_attention");
      if (error || !data) return;
      setAttention("slToLog", num(data.to_log), "", "shootlog");
    }

    return { show, loadAttention, renderJobTab };
  })();
