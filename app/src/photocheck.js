  // ================================================================ JOBS: Photographed check (2026-10-22, Airstudio plan E)
  // After a picture day, compare the roster with who GotPhoto says was photographed. The roster is GotPhoto's own
  // (the job's codes) or an uploaded file; the photographed list is a GotPhoto export read here in the browser.
  // Rows match by student ID, then access code, then email, then name (narrowed by class or team when a name is on
  // the roster twice). Whoever is left still needs a photo: school jobs add them to Retakes (Names List flags them
  // on retake day) and email the school the list; league jobs show makeup bookings and email each coach their
  // missing players. View = see it; Edit = upload, mark, add to retakes, send.
  // RPCs (supabase/migrations/20261022235500_photocheck_shootlog.sql): pa_list, pa_get, pa_roster_gotphoto,
  // pa_roster_upload, pa_photographed, pa_mark, pa_to_retakes, pa_email_preview, pa_send, pa_settings_save, pa_attention.
  registerPage({ id: "photocheck", label: "Photographed check", group: "Jobs", section: "jobs", module: "photocheck",
                 tabs: [["photocheck", "Photographed check"]], onShow: () => PhotoCheck.show() });
  registerAttention("paToCheck", { module: "photocheck", level: "soon", name: "photographed checks",
    one: "A picture day from the last two weeks has no photographed check yet.", many: "{n} picture days from the last two weeks have no photographed check yet." });
  registerTodayLoader("photocheck", () => PhotoCheck.loadAttention());

  // Spreadsheet files saved as CSV (or tab-separated). Shared with the shoot log.
  const RosterFile = (function () {
    // Text -> rows of cells. Handles quotes, doubled quotes and newlines inside quotes; picks , ; or tab.
    function parse(text) {
      text = String(text || "").replace(/^﻿/, "");
      const first = text.split(/\r?\n/, 1)[0] || "";
      const delim = [",", ";", "\t"].reduce((b, d) => (first.split(d).length > first.split(b).length ? d : b), ",");
      const rows = []; let row = [], cell = "", q = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
          if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
          else cell += c;
        } else if (c === '"') q = true;
        else if (c === delim) { row.push(cell); cell = ""; }
        else if (c === "\n" || c === "\r") {
          if (c === "\r" && text[i + 1] === "\n") i++;
          row.push(cell); cell = "";
          if (row.some((x) => x.trim() !== "")) rows.push(row);
          row = [];
        } else cell += c;
      }
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      return rows;
    }
    // Which column holds what, guessed from the headers. -1 = none.
    const WANT = {
      first: ["firstname", "first", "givenname", "studentfirstname", "childfirstname", "subjectfirstname", "playerfirstname", "athletefirstname"],
      last: ["lastname", "last", "surname", "familyname", "studentlastname", "childlastname", "subjectlastname", "playerlastname", "athletelastname"],
      name: ["name", "fullname", "studentname", "subjectname", "childname", "player", "playername", "athlete", "athletename", "student"],
      group: ["group", "class", "team", "teamname", "teacher", "homeroom", "grade", "subjectgroup", "groupname", "classname"],
      id: ["studentid", "id", "identifier", "subjectid", "externalid", "studentnumber", "idnumber", "personid", "externalidentifier", "subjectidentifier"],
      email: ["email", "emailaddress", "parentemail", "guardianemail", "email1"],
      code: ["accesscode", "code", "password", "galleryaccesscode", "photocode", "galleryaccess", "galleryaccesspassword"],
      photos: ["photos", "images", "photocount", "imagecount", "numberofphotos", "numberofimages", "photographed", "pictures", "imagesassigned", "numphotos", "photo"],
    };
    const key = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    function guess(headers) {
      const ks = headers.map(key), out = {};
      Object.keys(WANT).forEach((f) => {
        let i = ks.findIndex((k) => WANT[f].includes(k));
        if (i < 0 && f === "email") i = ks.findIndex((k) => k.includes("email"));
        out[f] = i;
      });
      if (out.first >= 0 && out.last >= 0) out.name = -1;
      return out;
    }
    // One person from a row, given the column map: {first, last, group, id, email, code}.
    function person(row, map) {
      const v = (f) => (map[f] >= 0 ? String(row[map[f]] || "").trim() : "");
      let first = v("first"), last = v("last");
      const full = v("name");
      if (!first && !last && full) {
        if (full.includes(",")) { last = full.split(",")[0].trim(); first = full.split(",").slice(1).join(",").trim(); }
        else { const w = full.split(/\s+/); last = w.length > 1 ? w.pop() : ""; first = w.join(" "); }
      }
      return { first, last, group: v("group"), id: v("id"), email: v("email"), code: v("code") };
    }
    // A photo-count column: 0, blank, no or false = not photographed.
    const shot = (row, map) => map.photos < 0 || !/^\s*(0+|no|n|false|)\s*$/i.test(String(row[map.photos] || ""));
    return { parse, guess, person, shot };
  })();

  const PhotoCheck = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .pa-list { width: 100%; }
    .aca .pa-list td { vertical-align: top; padding: 10px 8px 10px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; }
    .aca .pa-list th { text-align: left; font-size: 12px; color: var(--faint); font-weight: 600; padding: 8px 8px 6px 0; border-bottom: 1px solid var(--border); }
    .aca .pa-list tr.go { cursor: pointer; } .aca .pa-list tr.go:hover td { background: var(--surface-2); }
    .aca .pa-list .sub, .aca .pa-ppl .sub { display: block; color: var(--muted); font-size: 12.5px; }
    .aca .pa-head h2 { margin: 4px 0 2px; font-size: 19px; font-weight: 600; }
    .aca .pa-meta { margin: 0 0 18px; color: var(--muted); font-size: 13.5px; }
    .aca .pa-banner { margin: 0 0 18px; padding: 9px 12px; border-radius: 4px; background: var(--warn-bg); color: var(--warn-fg); font-size: 13px; }
    .aca .pa-step { margin-bottom: 30px; }
    .aca .pa-step h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; color: var(--head); }
    .aca .pa-step > p.muted { margin: 0 0 10px; font-size: 13px; max-width: 80ch; }
    .aca .pa-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .aca .pa-row select { max-width: 320px; }
    .aca .pa-ppl { width: 100%; }
    .aca .pa-ppl td { padding: 7px 8px 7px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; vertical-align: top; }
    .aca .pa-ppl td.r { text-align: right; white-space: nowrap; }
    .aca .pa-grp td { font-weight: 600; font-size: 12.5px; color: var(--muted); padding-top: 14px; }
    .aca .pa-log { margin: 6px 0 0; padding: 0; list-style: none; font-size: 13px; }
    .aca .pa-log li { padding: 5px 0; border-bottom: 1px solid var(--line2); display: flex; gap: 10px; flex-wrap: wrap; }
    .aca .pa-note { white-space: pre-wrap; background: var(--surface-2); border-radius: 4px; padding: 8px 10px; font-size: 13px; margin: 6px 0; }
    .aca .pa-map { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 8px 12px; align-items: center; margin: 12px 0; }
    .aca .pa-map select { width: 100%; }
    .aca .pa-pre { white-space: pre-wrap; background: var(--surface-2); border-radius: 4px; padding: 12px; font-size: 13px; max-height: 50vh; overflow: auto; }
    @media (max-width: 700px) {
      .aca .pa-list .hide-sm, .aca .pa-ppl .hide-sm { display: none; }
      .aca .pa-map { grid-template-columns: 1fr; gap: 2px; }
      .aca .pa-ppl td.r { white-space: normal; }
    }`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    let D = null; // pa_get for the open check
    let filter = "missing";
    const root = () => el("panel-photocheck");
    const openId = () => { const m = /^#jobs\/photocheck\/([^/?]+)/.exec(location.hash); return m ? m[1] : null; };
    const fmtDayIso = (d) => (d ? T.fmtDay(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "");
    const plural = (n, one, many) => num(n) + " " + (num(n) === 1 ? one : many || one + "s");
    const isSchool = () => D && D.booking.audience === "school";

    function show() { const id = openId(); if (id) open(id); else list(); }

    // ---------------------------------------------------------------- the list
    async function list() {
      D = null;
      const r = root();
      r.innerHTML = '<div class="card"><div class="card-head"><div><h2>Photographed check</h2><p>Booked picture days from the last four months. After the day, load the roster and GotPhoto&#8217;s photographed list to see who still needs a photo. School students go to Retakes; league players go to their coaches and Makeups.</p></div></div><div id="aca-paList"><div class="empty"><span class="spin"></span>Loading&#8230;</div></div></div>';
      const { data, error } = await sb.rpc("pa_list");
      const box = el("paList");
      if (!box) return;
      if (error) { box.innerHTML = '<div class="inline-error">' + esc(cleanErr(error)) + "</div>"; return; }
      const rows = data || [];
      if (!rows.length) { box.innerHTML = '<div class="empty">No booked picture days in the last four months.</div>'; return; }
      box.innerHTML = '<table class="pa-list"><thead><tr><th>Date</th><th>Job</th><th>Check</th><th class="hide-sm">Shoot log</th></tr></thead><tbody>' +
        rows.map((b) => {
          const n = num(b.roster), shot = num(b.photographed);
          const check = !b.shot_at ? (n ? '<span class="pill">Roster in, no photographed list yet</span>' : b.job_id ? '<span class="pill muted">Not started</span>' : '<span class="pill muted">No GotPhoto job</span>')
            : n - shot ? '<span class="pill warn">' + plural(n - shot, "still needs a photo", "still need a photo") + "</span>" : '<span class="pill ok">Everyone photographed</span>';
          return '<tr class="go" data-open="' + esc(b.booking_id) + '"><td class="tnum">' + esc(fmtDayIso(b.picture_day)) + "</td>" +
            "<td><b>" + esc(b.title) + '</b><span class="sub">' + esc(b.audience === "school" ? "School" : "League") + (b.retake_day ? ", retake day " + esc(fmtDayIso(b.retake_day)) : "") + "</span></td>" +
            "<td>" + check + (b.shot_at ? '<span class="sub">' + shot + " of " + n + " photographed" + (b.retakes_at ? ", added to Retakes" : "") + "</span>" : "") + "</td>" +
            '<td class="hide-sm">' + (b.logged ? '<span class="pill ok">Logged</span>' : '<span class="muted">&#8212;</span>') + "</td></tr>";
        }).join("") + "</tbody></table>";
      box.querySelectorAll("[data-open]").forEach((tr) => tr.addEventListener("click", () => {
        history.replaceState(null, "", "#jobs/photocheck/" + tr.dataset.open); open(tr.dataset.open);
      }));
    }

    // ---------------------------------------------------------------- one check
    async function open(id, keepScroll) {
      const r = root();
      if (!D || D.booking.id !== id) r.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const y = window.scrollY;
      const { data, error } = await sb.rpc("pa_get", { p_booking: id });
      if (error) { r.innerHTML = '<p><button type="button" class="link" id="aca-paBack">&#8592; Photographed check</button></p><div class="inline-error">' + esc(cleanErr(error)) + "</div>"; el("paBack").onclick = back; return; }
      D = data;
      render();
      if (keepScroll) window.scrollTo(0, y);
    }
    function back() { history.replaceState(null, "", "#jobs/photocheck"); list(); }
    const reload = () => open(D.booking.id, true);

    function render() {
      const b = D.booking, a = D.audit, edit = canEdit("photocheck");
      const ppl = D.people || [], missing = ppl.filter((p) => !p.photographed);
      const s = D.sending || {};
      let h = '<p style="margin:0 0 8px"><button type="button" class="link" id="aca-paBack">&#8592; Photographed check</button></p>' +
        '<div class="pa-head"><h2>' + esc(b.title) + "</h2></div>" +
        '<p class="pa-meta">' + esc(fmtDayIso(b.picture_day)) + (b.location ? " &#183; " + esc(b.location) : "") +
        (b.retake_day ? " &#183; retake day " + esc(fmtDayIso(b.retake_day)) : "") + "</p>";
      if (b.status !== "booked") h += '<div class="pa-banner">This job is ' + esc(b.status) + ". Only booked jobs send anything.</div>";

      // 1. roster
      h += '<div class="pa-step"><h3>1. The roster</h3><p class="muted">Everyone who should have been photographed. GotPhoto&#8217;s roster has each person&#8217;s access code, which Retakes and Names List need.</p>';
      h += '<div class="pa-row">' + (a && a.roster_at ? '<span class="pill ok">' + plural(ppl.length, "person", "people") + " from " + (a.roster_source === "gotphoto" ? "GotPhoto" : esc(a.roster_name || "a file")) + "</span> <span class=\"muted\">" + esc(fmtAgo(a.roster_at)) + "</span>"
        : '<span class="pill muted">No roster yet</span>') + "</div>";
      if (D.job) h += '<p class="muted" style="margin:0;font-size:13px">GotPhoto job: ' + esc(D.job.name || D.job.id) + ", " + plural(D.job.codes, "code") + ".</p>";
      else h += '<p class="muted" style="margin:0;font-size:13px">This booking isn&#8217;t linked to a GotPhoto job, so upload the roster as a file.</p>';
      if (edit) h += '<div class="pa-row">' + (D.job && num(D.job.codes) ? '<button type="button" class="small' + (a && a.roster_at ? "" : " primary") + '" id="aca-paGp">' + (a && a.roster_source === "gotphoto" ? "Reload from GotPhoto" : "Use GotPhoto&#8217;s roster") + "</button>" : "") +
        '<button type="button" class="small" id="aca-paRosterFile">Upload a roster file</button></div>';
      h += "</div>";

      // 2. photographed
      h += '<div class="pa-step"><h3>2. Who was photographed</h3><p class="muted">In GotPhoto, export the job&#8217;s people list once the photos are matched, and save it as CSV. If it has a photo count column, rows with 0 count as not photographed; otherwise every row counts as photographed. People you mark by hand stay marked when you upload again.</p>';
      h += '<div class="pa-row">' + (a && a.shot_at ? '<span class="pill ok">' + esc(a.shot_name || "File") + "</span> <span class=\"muted\">" + plural(a.shot_rows, "row") + ", " + esc(fmtAgo(a.shot_at)) + "</span>" : '<span class="pill muted">Not uploaded yet</span>') +
        (edit && ppl.length ? '<button type="button" class="small' + (a && a.shot_at ? "" : " primary") + '" id="aca-paShotFile">Upload the photographed list</button>' : "") + "</div>";
      if (a && a.shot_at) {
        const un = a.unmatched || [];
        h += '<div class="tiles"><div class="tile"><div class="n">' + ppl.length + '</div><div class="l">On the roster</div></div>' +
          '<div class="tile"><div class="n">' + (ppl.length - missing.length) + '</div><div class="l">Photographed</div></div>' +
          '<div class="tile"><div class="n">' + missing.length + '</div><div class="l">Still need a photo</div></div>' +
          '<div class="tile"><div class="n">' + un.length + '</div><div class="l">In the file, not on the roster</div>' + (un.length ? '<div class="s"><button type="button" class="link" id="aca-paUn">See them</button></div>' : "") + "</div></div>";
      }
      h += "</div>";

      // crew log
      const logs = (D.logs || []).filter((l) => l.absences || l.issues);
      if (logs.length) {
        h += '<div class="pa-step"><h3>From the shoot log</h3>' + logs.map((l) => '<p class="muted" style="margin:6px 0 0;font-size:12.5px">' + esc(T.fmtDay(l.day)) + ", " + esc(l.by_name || "") + "</p>" +
          (l.absences ? '<div class="pa-note"><b>Absent:</b> ' + esc(l.absences) + "</div>" : "") + (l.issues ? '<div class="pa-note"><b>Issues:</b> ' + esc(l.issues) + "</div>" : "")).join("") + "</div>";
      }

      // 3. people
      if (ppl.length) {
        const q = (el("paSearch") && el("paSearch").value) || "";
        h += '<div class="pa-step"><h3>3. ' + (a && a.shot_at ? "Who still needs a photo" : "Everyone on the roster") + "</h3>" +
          '<div class="pa-row"><select id="aca-paFilter" aria-label="Show"><option value="missing"' + (filter === "missing" ? " selected" : "") + ">Still need a photo (" + missing.length + ")</option>" +
          '<option value="all"' + (filter === "all" ? " selected" : "") + ">Everyone (" + ppl.length + ")</option></select>" +
          '<input type="search" id="aca-paSearch" placeholder="Find a name" value="' + esc(q) + '" style="width:200px" /></div><div id="aca-paPeople"></div></div>';
      }

      // 4. next steps
      if (a && a.shot_at && missing.length) {
        h += '<div class="pa-step"><h3>4. Next steps</h3>';
        if (b.status === "booked" && !s.enabled) h += '<div class="pa-banner"><b>Booking emails are switched off.</b> Emails you send here wait until they are switched back on (Settings &#8250; Sending).</div>';
        else if (b.status === "booked" && s.test_mode) h += '<div class="pa-banner"><b>Test mode.</b> Every email goes to ' + esc(s.test_recipient || "the test address") + " with a [TEST] subject.</div>";
        if (isSchool()) {
          const toAdd = missing.filter((p) => p.code && !p.retake).length;
          h += '<p class="muted" style="margin:0 0 6px;font-size:13px"><b>Retakes.</b> Each student becomes a retake request, so Names List flags them when it opens the job on retake day, and they show on the Retakes page with &#8220;Not photographed&#8221;.' +
            (missing.some((p) => !p.code) ? " Students without an access code (from an uploaded roster) can&#8217;t be added." : "") + "</p>";
          if (edit) h += '<div class="pa-row"><button type="button" class="small' + (toAdd ? " primary" : "") + '" id="aca-paRetakes"' + (toAdd ? "" : " disabled") + ">" +
            (toAdd ? "Add " + plural(toAdd, "student") + " to Retakes" : a.retakes_at ? "Added to Retakes " + esc(fmtAgo(a.retakes_at)) : "Nobody to add") + "</button>" +
            (canSee("parents") ? '<button type="button" class="small quiet" id="aca-paGoRetakes">Open Retakes</button>' : "") + "</div>";
          h += '<p class="muted" style="margin:14px 0 6px;font-size:13px"><b>Tell the school.</b> The list by class, with the retake day, so they can let families know or tell you who has left.</p>';
          if (edit) {
            const opts = (D.contacts || []).map((c) => '<option value="' + esc(c.id) + '">' + esc((c.name || c.email) + (c.role ? " (" + c.role + ")" : "") + " – " + c.email) + "</option>").join("");
            h += '<div class="pa-row"><select id="aca-paContact" aria-label="Send the list to">' + opts + '<option value="">Someone else&#8230;</option></select>' +
              '<input type="email" id="aca-paOther" class="hidden" placeholder="name@school.org" aria-label="Their email" style="width:240px" />' +
              '<button type="button" class="small" id="aca-paPrevSchool">Preview</button><button type="button" class="primary small" id="aca-paSendSchool">Email the list</button></div>';
          }
        } else {
          const booked = missing.filter((p) => p.makeup).length;
          const keys = (D.teams || []).filter((t) => t.coach_email).map((t) => t.key);
          const reach = missing.filter((p) => keys.includes(String(p.group || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))).length;
          h += '<p class="muted" style="margin:0 0 6px;font-size:13px"><b>Makeups.</b> ' + (booked ? plural(booked, "player has", "players have") + " a makeup booked already (shown in the list)." : "Nobody missing has a makeup booked yet.") +
            " Makeup bookings for this job show up next to the player as families book them.</p>";
          h += '<p class="muted" style="margin:14px 0 6px;font-size:13px"><b>Tell the coaches.</b> Each coach gets their own team&#8217;s missing players and how to book a makeup. Coaches come from Picture days, matched by team name' +
            ((D.teams || []).length ? ": " + plural(reach, "missing player is", "missing players are") + " on a team with a coach email." : ", and this job has no teams there.") + "</p>";
          if (edit) {
            h += '<div class="pa-row"><button type="button" class="small" id="aca-paPrevCoach">Preview</button><button type="button" class="primary small" id="aca-paSendCoach"' + (reach ? "" : " disabled") + ">Email the coaches</button></div>" +
              '<div class="pa-row"><label for="aca-paMakeup" class="muted" style="font-size:13px">Makeup booking link</label><input type="url" id="aca-paMakeup" value="' + esc(D.makeup_link || "") + '" placeholder="https://&#8230; (blank: families reply to the email)" style="width:340px" />' +
              '<button type="button" class="small quiet" id="aca-paMakeupSave">Save</button></div>';
          }
        }
        h += "</div>";
      }

      if ((D.emails || []).length) {
        const stat = { waiting: '<span class="pill">Waiting</span>', sent: '<span class="pill ok">Sent</span>', failed: '<span class="pill err">Failed</span>', cancelled: '<span class="pill muted">Cancelled</span>' };
        h += '<div class="pa-step"><h3>Emails</h3><ul class="pa-log">' + D.emails.map((e) => "<li>" + (stat[e.status] || esc(e.status)) +
          "<span>" + esc(e.kind === "school" ? "List" : (e.team || "Team")) + " to " + esc(e.to_name ? e.to_name + " <" + e.to_email + ">" : e.to_email) + "</span>" +
          '<span class="muted">' + esc(fmtDate(e.sent_at || e.created_at)) + (e.test_mode ? " (test)" : "") + (e.error ? " &#183; " + esc(e.error) : "") + "</span></li>").join("") + "</ul></div>";
      }
      root().innerHTML = h;
      renderPeople();
      wire(edit);
    }

    function renderPeople() {
      const box = el("paPeople"); if (!box) return;
      const edit = canEdit("photocheck");
      const q = (el("paSearch").value || "").trim().toLowerCase();
      const rows = (D.people || []).filter((p) => (filter === "all" || !p.photographed) && (!q || (p.first + " " + p.last + " " + p.group).toLowerCase().includes(q)));
      if (!rows.length) { box.innerHTML = '<div class="empty">' + (q ? "Nobody matches." : filter === "missing" && D.audit && D.audit.shot_at ? "Everyone on the roster was photographed." : "Nobody here.") + "</div>"; return; }
      let last = null, html = '<table class="pa-ppl"><tbody>';
      const how = { id: "matched by ID", code: "matched by code", email: "matched by email", name: "matched by name", staff: "set by hand" };
      rows.slice(0, 1500).forEach((p) => {
        if (p.group !== last) { last = p.group; html += '<tr class="pa-grp"><td colspan="3">' + esc(p.group || "No class or team") + "</td></tr>"; }
        const tags = [p.photographed ? '<span class="pill ok">Photographed</span>' : D.audit && D.audit.shot_at ? '<span class="pill warn">Needs a photo</span>' : "",
          p.makeup ? '<span class="pill accent">Makeup ' + esc(T.fmtDay(T.local(p.makeup.at).day)) + (p.makeup.sent_at ? ", photos sent" : "") + "</span>" : "",
          p.retake ? '<span class="pill accent">On Retakes</span>' : ""].filter(Boolean).join(" ");
        html += "<tr><td><b>" + esc((p.first + " " + p.last).trim() || "(no name)") + '</b><span class="sub">' + esc([p.identifier && "ID " + p.identifier, p.code].filter(Boolean).join(" · ")) +
          (p.matched_by ? (p.identifier || p.code ? " · " : "") + esc(how[p.matched_by] || "") : "") + "</span></td><td>" + tags + "</td>" +
          '<td class="r">' + (edit && D.audit && D.audit.shot_at ? '<button type="button" class="small quiet" data-mark="' + esc(p.id) + '" data-to="' + (p.photographed ? "0" : "1") + '">' +
            (p.photographed ? "Not photographed" : "Was photographed") + "</button>" : "") + "</td></tr>";
      });
      html += "</tbody></table>" + (rows.length > 1500 ? '<p class="muted">Showing the first 1,500. Search to narrow it down.</p>' : "");
      box.innerHTML = html;
      box.querySelectorAll("[data-mark]").forEach((btn) => btn.addEventListener("click", async () => {
        btn.disabled = true;
        const { error } = await sb.rpc("pa_mark", { p_person: btn.dataset.mark, p_photographed: btn.dataset.to === "1" });
        if (error) { toast(cleanErr(error), true); btn.disabled = false; return; }
        reload();
      }));
    }

    function wire(edit) {
      el("paBack").onclick = back;
      const f = el("paFilter"); if (f) f.onchange = () => { filter = f.value; renderPeople(); };
      const s = el("paSearch"); if (s) s.oninput = renderPeople;
      const un = el("paUn");
      if (un) un.onclick = () => {
        const m = openModal('<h2>In the file, not on the roster</h2><p class="muted">These rows from the photographed list matched nobody. Usually a spelling difference or a student added late. Mark the right person by hand if you find them.</p>' +
          '<div class="pa-pre">' + (D.audit.unmatched || []).map((x) => esc([x.name, x.group, x.id && "ID " + x.id].filter(Boolean).join(", "))).join("\n") + '</div><div class="modal-actions"><button type="button" class="primary" data-x>Close</button></div>');
        m.querySelector("[data-x]").onclick = () => m.close();
      };
      const gr = el("paGoRetakes"); if (gr) gr.onclick = () => showTab("retakes");
      if (!edit) return;
      const gp = el("paGp");
      if (gp) gp.onclick = async () => {
        gp.disabled = true;
        const { data, error } = await sb.rpc("pa_roster_gotphoto", { p_booking: D.booking.id });
        if (error) { toast(cleanErr(error), true); gp.disabled = false; return; }
        toast("Roster loaded: " + plural(data.people, "person", "people"));
        reload();
      };
      const rf = el("paRosterFile"); if (rf) rf.onclick = () => upload("roster");
      const sf = el("paShotFile"); if (sf) sf.onclick = () => upload("shot");
      const rt = el("paRetakes");
      if (rt) rt.onclick = async () => {
        if (!confirm("Add the students who still need a photo to Retakes? Names List will flag them on retake day.")) return;
        rt.disabled = true;
        const { data, error } = await sb.rpc("pa_to_retakes", { p_booking: D.booking.id });
        if (error) { toast(cleanErr(error), true); rt.disabled = false; return; }
        toast(plural(data.added, "student") + " added to Retakes" + (num(data.already) ? ", " + num(data.already) + " already there" : ""));
        reload();
      };
      const sel = el("paContact");
      if (sel) { const other = () => el("paOther").classList.toggle("hidden", sel.value !== ""); sel.onchange = other; other(); }
      const target = () => (sel && sel.value ? { p_contact: sel.value, p_email: null } : { p_contact: null, p_email: el("paOther") ? el("paOther").value.trim() : "" });
      const preview = async (kind) => {
        const { data, error } = await sb.rpc("pa_email_preview", Object.assign({ p_booking: D.booking.id, p_kind: kind }, kind === "school" ? target() : {}));
        if (error) { toast(cleanErr(error), true); return; }
        const items = data || [];
        const m = openModal("<h2>" + (kind === "school" ? "What the school gets" : plural(items.length, "coach email")) + "</h2>" + items.map((x) =>
          "<p><b>To:</b> " + esc(x.to_email) + "<br><b>Subject:</b> " + esc(x.subject) + '</p><div class="pa-pre">' + esc(x.text) + "</div>").join("") +
          '<div class="modal-actions"><button type="button" class="primary" data-x>Close</button></div>');
        m.querySelector("[data-x]").onclick = () => m.close();
      };
      const send = async (kind, btn) => {
        btn.disabled = true;
        try {
          const { data, error } = await sb.rpc("pa_send", Object.assign({ p_booking: D.booking.id, p_kind: kind }, kind === "school" ? target() : {}));
          if (error) throw error;
          toast(plural(data.queued, "email") + (data.sending_enabled ? " on the way" : " queued. Booking emails are off, so they wait."));
          reload();
        } catch (e) { toast(cleanErr(e), true); btn.disabled = false; }
      };
      const ps = el("paPrevSchool"); if (ps) ps.onclick = () => preview("school");
      const ss = el("paSendSchool"); if (ss) ss.onclick = () => send("school", ss);
      const pc = el("paPrevCoach"); if (pc) pc.onclick = () => preview("coach");
      const sc = el("paSendCoach"); if (sc) sc.onclick = () => { if (confirm("Email each coach their team's missing players?")) send("coach", sc); };
      const ms = el("paMakeupSave");
      if (ms) ms.onclick = async () => {
        const { error } = await sb.rpc("pa_settings_save", { p_makeup_link: el("paMakeup").value.trim() });
        if (error) { toast(cleanErr(error), true); return; }
        toast("Makeup link saved. Coach emails use it from now on.");
        D.makeup_link = el("paMakeup").value.trim();
      };
    }

    // A file -> pick the columns -> save. kind: "roster" (everyone) or "shot" (who was photographed).
    function upload(kind) {
      const isShot = kind === "shot";
      const m = openModal('<div class="pa-modal"><h2>' + (isShot ? "The photographed list" : "A roster file") + "</h2>" +
        '<p class="muted">' + (isShot ? "GotPhoto&#8217;s export of the job&#8217;s people, saved as CSV." : "A spreadsheet of everyone, saved as CSV. One row per person.") + " Excel: File &#8250; Save As &#8250; CSV.</p>" +
        '<div class="field"><input type="file" id="aca-paFile" accept=".csv,.tsv,.txt,text/csv,text/plain" /></div><div id="aca-paMapBox"></div>' +
        '<div class="inline-error hidden" id="aca-paFileErr"></div><div class="modal-actions"><button type="button" class="quiet" id="aca-paFileCancel">Cancel</button>' +
        '<button type="button" class="primary" id="aca-paFileSave" disabled>Use this file</button></div></div>');
      let rows = null, name = "";
      const FIELDS = [["first", "First name"], ["last", "Last name"], ["name", "Full name"], ["group", "Class or team"], ["id", "Student ID"], ["email", "Email"], ["code", "Access code"]].concat(isShot ? [["photos", "Photo count"]] : []);
      const mapOf = () => { const o = {}; FIELDS.forEach(([f]) => { const s = el("paMap-" + f); o[f] = s ? +s.value : -1; }); return o; };
      const count = () => {
        const map = mapOf(), ppl = rows.slice(1).filter((r) => !isShot || RosterFile.shot(r, map)).map((r) => RosterFile.person(r, map)).filter((p) => p.first || p.last || p.id || p.code || p.email);
        el("paMapCount").textContent = plural(ppl.length, isShot ? "person photographed" : "person", isShot ? "people photographed" : "people") +
          (ppl[0] ? ". First: " + [ppl[0].first, ppl[0].last].join(" ").trim() + (ppl[0].group ? ", " + ppl[0].group : "") : "");
        el("paFileSave").disabled = !ppl.length || (!isShot && !ppl.some((p) => p.first || p.last));
        return ppl;
      };
      el("paFileCancel").onclick = () => m.close();
      el("paFile").onchange = async (e) => {
        clearError("paFileErr");
        const file = e.target.files[0]; if (!file) return;
        if (/\.(xlsx?|numbers|ods)$/i.test(file.name)) { showError("paFileErr", "Save it as CSV first (File › Save As › CSV), then pick that file."); return; }
        name = file.name;
        rows = RosterFile.parse(await file.text());
        if (rows.length < 2) { showError("paFileErr", "That file has no rows under the header."); el("paMapBox").innerHTML = ""; return; }
        const g = RosterFile.guess(rows[0]);
        const opts = (sel) => '<option value="-1">(none)</option>' + rows[0].map((hd, i) => '<option value="' + i + '"' + (i === sel ? " selected" : "") + ">" + esc(hd || "Column " + (i + 1)) + "</option>").join("");
        el("paMapBox").innerHTML = '<p class="muted" style="margin:10px 0 0;font-size:13px">Which column is which. Matching tries Student ID, then access code, then email, then the name.</p><div class="pa-map">' +
          FIELDS.map(([f, label]) => '<label for="aca-paMap-' + f + '">' + label + '</label><select id="aca-paMap-' + f + '">' + opts(g[f]) + "</select>").join("") +
          '</div><p id="aca-paMapCount" class="muted" style="font-size:13px"></p>';
        el("paMapBox").querySelectorAll("select").forEach((s) => { s.onchange = count; });
        count();
      };
      el("paFileSave").onclick = async () => {
        const ppl = count(); if (!ppl.length) return;
        el("paFileSave").disabled = true;
        const { data, error } = isShot
          ? await sb.rpc("pa_photographed", { p_booking: D.booking.id, p_rows: ppl, p_name: name })
          : await sb.rpc("pa_roster_upload", { p_booking: D.booking.id, p_rows: ppl, p_name: name });
        if (error) { showError("paFileErr", cleanErr(error)); el("paFileSave").disabled = false; return; }
        m.close();
        toast(isShot ? num(data.matched) + " matched, " + plural(data.missing, "still needs a photo", "still need a photo") + (num(data.unmatched) ? ", " + num(data.unmatched) + " not on the roster" : "")
                     : "Roster saved: " + plural(data.people, "person", "people"));
        filter = "missing";
        reload();
      };
    }

    // Job page tab: the counts and a link here.
    async function renderJobTab(booking, box) {
      const id = (booking && (booking.id || booking.booking_id)) || booking;
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const { data, error } = await sb.rpc("pa_get", { p_booking: id });
      if (error) { box.innerHTML = '<div class="inline-error">' + esc(cleanErr(error)) + "</div>"; return; }
      const ppl = data.people || [], miss = ppl.filter((p) => !p.photographed).length, a = data.audit;
      box.innerHTML = "<p>" + (!a || !a.roster_at ? "No roster loaded yet." : !a.shot_at ? plural(ppl.length, "person", "people") + " on the roster. The photographed list isn&#8217;t uploaded yet."
        : (ppl.length - miss) + " of " + ppl.length + " photographed. " + (miss ? plural(miss, "still needs a photo", "still need a photo") + "." : "Everyone is done.")) +
        '</p><p><a href="#jobs/photocheck/' + esc(id) + '">Open the photographed check</a></p>';
    }

    async function loadAttention() {
      const { data, error } = await sb.rpc("pa_attention");
      if (error || !data) return;
      setAttention("paToCheck", num(data.to_check), "", "photocheck");
    }

    return { show, loadAttention, renderJobTab };
  })();
