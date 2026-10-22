  // ================================================================ JOBS > Season setup (2026-10-23)
  // Put a season of jobs on the Bookings screen at once: import a spreadsheet (CSV), or copy last season's
  // jobs forward (from Bookings, and from GotPhoto jobs that were never on Bookings). Jobs can have several
  // dates (a two-day league weekend is one job). Everything added here is TRACK-ONLY (status 'tracked'):
  // stages, deliverables and the schedule, and nothing is ever sent. Book a job is still how a job gets emails.
  // RPCs: jobsetup_lookup / jobsetup_history / jobsetup_copy_candidates (view); jobsetup_import (dry run, then
  // for real) / jobsetup_undo / jobsetup_set_days / jobsetup_copy_one (edit). Migration 20261023091500.
  // On the job page (jobpage.js, when present) a "Dates" tab changes a tracked job's dates and copies a job
  // forward. #jobs/setup/<booking id> opens the same thing here.
  registerPage({ id: "setup", label: "Season setup", group: "Jobs", section: "jobs", module: "jobsetup", title: "Season setup",
                 tabs: [["setup", "Season setup"]], onShow: () => JobSetup.load() });

  const JobSetup = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const TZ = "America/New_York";
    const css = `
  .aca .js-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0 0 18px; }
  .aca .js-note { margin: 0 0 18px; padding: 10px 12px; background: var(--surface-2); border-radius: 4px; color: var(--muted); font-size: 13px; max-width: 80ch; line-height: 19px; }
  .aca .js-h { margin: 22px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
  .aca .js-t td { vertical-align: top; font-size: 13.5px; }
  .aca .js-t td .s, .aca .js-s { display: block; color: var(--muted); font-size: 12.5px; font-weight: 400; }
  .aca .js-t input[type=text], .aca .js-t select { width: 100%; min-width: 150px; }
  .aca .js-t tr.off td { opacity: .55; }
  .aca .modal.js-wide { max-width: 1040px; }
  .aca .js-scroll { max-height: 52vh; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
  .aca .js-scroll table { margin: 0; }
  .aca .js-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0 0 10px; }
  .aca .js-row label { font-size: 13px; color: var(--muted); }
  .aca .js-days { list-style: none; margin: 0 0 10px; padding: 0; }
  .aca .js-days li { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid var(--line2); }
  .aca .js-days input[type=text] { width: 160px; }
  .aca .js-cols { font-size: 12.5px; color: var(--muted); margin: 6px 0 0; line-height: 18px; }
  .aca .js-cols code { font-size: 12px; }
  @media (max-width: 700px) { .aca .js-t .hide-sm { display: none; } .aca .js-t input[type=text], .aca .js-t select { min-width: 110px; } }
`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    const root = el("panel-setup");
    const edit = () => canEdit("jobsetup");
    let lookup = null;   // {types, orgs, can_edit}
    const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const fmtDay = (ymd, year) => ymd ? new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", Object.assign({ timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }, year ? { year: "numeric" } : {})) : "";
    const fmtShort = (ymd, year) => ymd ? new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", Object.assign({ timeZone: "UTC", month: "short", day: "numeric" }, year ? { year: "numeric" } : {})) : "";
    const hm = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return ((h % 12) || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + (h >= 12 ? "pm" : "am"); };
    const dayText = (d) => fmtDay(d.day) + (d.start_time ? " " + hm(d.start_time) + (d.end_time ? "–" + hm(d.end_time) : "") : "") + (d.label ? " (" + d.label + ")" : "");
    const daysText = (days, year) => (days || []).map((d, i) => i === 0 && year ? fmtDay(d.day, true) + (d.start_time ? " " + hm(d.start_time) + (d.end_time ? "–" + hm(d.end_time) : "") : "") + (d.label ? " (" + d.label + ")" : "") : dayText(d)).join("; ");
    const norm = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
    const jobHref = (id) => (typeof jobLink === "function" ? jobLink(id) : "#jobs/bookings/" + id);   // the job page when it is in the build
    const plural = (n, one, many) => n + " " + (n === 1 ? one : (many || one + "s"));

    async function ensureLookup(force) {
      if (lookup && !force) return lookup;
      const { data, error } = await sb.rpc("jobsetup_lookup");
      if (error) throw error;
      lookup = data;
      // "Name" or, when two organizations share a name, "Name (Town)"
      const seen = {};
      lookup.orgs.forEach((o) => { seen[norm(o.name)] = (seen[norm(o.name)] || 0) + 1; });
      lookup.orgs.forEach((o) => { o.pick = seen[norm(o.name)] > 1 && o.town ? o.name + " (" + o.town + ")" : o.name; });
      return lookup;
    }
    const orgById = (id) => lookup && lookup.orgs.find((o) => o.id === id);
    const orgByPick = (txt) => lookup && lookup.orgs.find((o) => o.pick === txt);
    const typeLabel = (k) => ((lookup && lookup.types.find((t) => t.key === k)) || { label: k || "" }).label;
    const orgDatalist = () => '<datalist id="aca-jsOrgs">' + lookup.orgs.map((o) => '<option value="' + esc(o.pick) + '"></option>').join("") + "</datalist>";
    const typeSelect = (cur, attrs) => '<select class="small" ' + attrs + ">" + (cur ? "" : '<option value="">Job type&#8230;</option>') +
      lookup.types.map((t) => '<option value="' + esc(t.key) + '"' + (t.key === cur ? " selected" : "") + ">" + esc(t.label) + "</option>").join("") + "</select>";

    // ---------------------------------------------------------------- page
    async function load() {
      root.innerHTML = '<div class="pagehead"><div><h1>Season setup</h1><p>Put a season of jobs on the Bookings screen at once: import a spreadsheet, or copy last season&rsquo;s jobs forward. A job can have several dates, like a two-day league weekend.</p></div></div>' +
        '<div class="js-note">Jobs added here are <b>tracking only</b>. They show on Bookings and the Schedule with their stages and deliverables, and nothing is sent for them: no emails, no calendar event, no hub reminders. When an organization should get the booking emails, book it with Book a job as usual.</div>' +
        '<div class="js-bar' + (edit() ? "" : " hidden") + '"><button type="button" class="primary" id="aca-jsImport">Import a spreadsheet</button><button type="button" id="aca-jsCopy">Copy last season</button></div>' +
        '<div id="aca-jsErr" class="inline-error hidden"></div>' +
        '<h3 class="js-h">Imports and copies</h3><div id="aca-jsHist"><p class="empty"><span class="spin"></span>Loading&#8230;</p></div>';
      el("jsImport").addEventListener("click", openImport);
      el("jsCopy").addEventListener("click", openCopy);
      const m = location.hash.match(/^#jobs\/setup\/([0-9a-f-]{36})/i);
      if (m) { history.replaceState(null, "", "#jobs/setup"); openDates(m[1]); }
      await loadHistory();
    }

    async function loadHistory() {
      const { data, error } = await sb.rpc("jobsetup_history", { p_limit: 30 });
      if (error) { el("jsHist").innerHTML = '<p class="inline-error">' + esc(cleanErr(error)) + "</p>"; return; }
      const rows = data || [];
      el("jsHist").innerHTML = rows.length ? '<div class="table-wrap"><table class="js-t"><thead><tr><th>What</th><th class="hide-sm">When</th><th>Jobs</th><th class="hide-sm">Dates</th><th></th></tr></thead><tbody>' +
        rows.map((h) => "<tr><td><b>" + esc(h.label || (h.kind === "csv" ? "Spreadsheet" : "Copy")) + '</b><span class="s">' + (h.kind === "csv" ? "Spreadsheet import" : "Copied forward") + (h.undone_at ? " &middot; undone " + esc(fmtAgo(h.undone_at)) : "") + "</span></td>" +
          '<td class="hide-sm">' + esc(fmtAgo(h.created_at)) + (h.by ? '<span class="s">' + esc(h.by) + "</span>" : "") + "</td>" +
          "<td>" + esc(plural(h.added, "job")) + ' added<span class="s">' + [h.tracked ? h.tracked + " tracking" : "", h.booked ? h.booked + " booked since" : "", h.cancelled ? h.cancelled + " set aside" : "", h.skipped ? h.skipped + " skipped" : ""].filter(Boolean).join(" &middot; ") + "</span></td>" +
          '<td class="hide-sm">' + (h.first_day ? esc(fmtShort(h.first_day) + (h.last_day && h.last_day !== h.first_day ? " – " + fmtShort(h.last_day, true) : ", " + h.first_day.slice(0, 4))) : "") + "</td>" +
          '<td style="text-align:right">' + (edit() && h.tracked > 0 ? '<button type="button" class="small" data-undo="' + esc(h.id) + '" data-n="' + esc(h.tracked) + '">Undo</button>' : "") + "</td></tr>").join("") +
        "</tbody></table></div>" : '<p class="empty">Nothing imported or copied yet.</p>';
      el("jsHist").querySelectorAll("[data-undo]").forEach((b) => b.addEventListener("click", () => undo(b.dataset.undo, Number(b.dataset.n))));
    }

    async function undo(id, n) {
      if (!confirm("Set aside the " + plural(n, "job") + " from this batch that are still tracking only? Jobs booked since stay as they are.")) return;
      const { data, error } = await sb.rpc("jobsetup_undo", { p_id: id });
      if (error) return toast(cleanErr(error), true);
      toast("Set aside " + plural(data.cancelled, "job") + (data.kept ? "; kept " + data.kept + " booked" : "") + ".");
      loadHistory();
    }

    // ---------------------------------------------------------------- CSV reading
    function parseCSV(text) {
      text = String(text || "").replace(/^﻿/, "");
      const first = text.split(/\r?\n/, 1)[0] || "";
      const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? "\t" : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
      const rows = []; let row = [], cell = "", q = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
        if (c === '"' && cell === "") q = true;
        else if (c === delim) { row.push(cell); cell = ""; }
        else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
        else cell += c;
      }
      if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
      return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
    }
    // Which column is which, from the header row. Only organization and date are needed.
    const COLS = {
      org: ["organization", "organisation", "org", "league", "school", "client", "customer", "partner", "team", "name"],
      type: ["type", "jobtype", "kind", "service"],
      date: ["date", "dates", "pictureday", "picturedays", "day", "days", "shootdate", "startdate", "firstday"],
      end_date: ["enddate", "lastday", "through", "until date", "todate"],
      start: ["start", "starttime", "time", "from", "begins"],
      end: ["end", "endtime", "until", "ends", "finish"],
      title: ["title", "season", "label", "jobname"],
      location: ["location", "place", "address", "where", "field", "venue", "site"],
      notes: ["notes", "note", "comments", "comment"],
      gp: ["gotphoto", "gotphotojob", "gotphotojobid", "gotphotoid", "jobid"],
      day_labels: ["daylabels", "daylabel", "divisions"],
    };
    function mapHeader(head) {
      const cols = {};
      const h = head.map(norm);
      Object.keys(COLS).forEach((k) => {
        for (const name of COLS[k]) { const i = h.indexOf(norm(name)); if (i >= 0 && !Object.values(cols).includes(i)) { cols[k] = i; break; } }
      });
      return cols;
    }
    const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    function parseDate(s) {
      s = String(s || "").trim().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s*/i, "");
      if (!s) return null;
      let m, y, mo, d;
      if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
      else if ((m = s.match(/^([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i)) && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) { mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; d = +m[2]; y = +m[3]; }
      else if ((m = s.match(/^(\d{1,2})\s+([a-z]{3,})\.?,?\s+(\d{4})$/i)) && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) { d = +m[1]; mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1; y = +m[3]; }
      else return null;
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
      return dt.toISOString().slice(0, 10);
    }
    // "9", "9am", "9:30 AM", "13:00", "9:30a" -> "HH:MM"; "" -> ""; unreadable -> null
    function parseTime(s) {
      s = String(s || "").trim().toLowerCase().replace(/\./g, "");
      if (!s) return "";
      const m = s.match(/^(\d{1,2})(?::?(\d{2}))?\s*(a|am|p|pm)?$/);
      if (!m) return null;
      let h = +m[1]; const mi = +(m[2] || 0);
      if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (m[3][0] === "p" ? 12 : 0); }
      if (h > 23 || mi > 59) return null;
      return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
    }
    // A time cell can also be a range: "9am-1pm".
    function parseTimes(startCell, endCell) {
      let a = String(startCell || "").trim(), b = String(endCell || "").trim();
      const r = a.match(/^(.+?)\s*(?:-|–|to)\s*(.+)$/i);
      if (r && !b) { a = r[1]; b = r[2]; if (/[ap]m?$/i.test(b) && !/[ap]m?$/i.test(a)) a += b.match(/[ap]m?$/i)[0]; }
      return [parseTime(a), parseTime(b)];
    }
    function matchOrg(txt) {
      const q = norm(txt);
      if (!q) return null;
      const exact = lookup.orgs.filter((o) => norm(o.name) === q || norm(o.pick) === q || (o.gotphoto_names || []).some((g) => norm(g) === q));
      if (exact.length === 1) return exact[0];
      if (exact.length > 1) return null;
      const near = lookup.orgs.filter((o) => q.length >= 5 && (norm(o.name).includes(q) || q.includes(norm(o.name)) && norm(o.name).length >= 6));
      return near.length === 1 ? near[0] : null;
    }
    function matchType(txt, org) {
      const q = norm(txt);
      const types = lookup.types;
      const sports = types.filter((t) => t.audience === "sports");
      const exact = types.find((t) => norm(t.key) === q || norm(t.label) === q);
      if (exact) return exact.key;
      if (q.includes("roster") || q.includes("nodata")) { const r = sports.find((t) => /roster|nodata/.test(norm(t.key + t.label))); if (r) return r.key; }
      if (q.includes("school")) { const s = types.find((t) => t.audience === "school"); if (s) return s.key; }
      if (/sport|league|team|parent/.test(q) && sports.length) return sports[0].key;
      if (!q) { const want = org && org.audience === "school" ? "school" : "sports"; const t = types.find((x) => x.audience === want) || types[0]; return t ? t.key : ""; }
      return "";
    }
    // Rows -> jobs. Several dates in one cell are split on ";", "&" or "and"; an end date makes a range.
    function rowsToJobs(rows) {
      const cols = mapHeader(rows[0] || []);
      if (cols.org == null || cols.date == null) return { error: "The first row needs column names, with at least Organization and Date. Found: " + (rows[0] || []).join(", ") };
      const get = (r, k) => (cols[k] == null ? "" : String(r[cols[k]] == null ? "" : r[cols[k]]).trim());
      const jobs = rows.slice(1).map((r, i) => {
        const j = { line: i + 2, include: true, orgText: get(r, "org"), typeText: get(r, "type"), title_label: get(r, "title"), location: get(r, "location"), notes: get(r, "notes"), gotphoto_job_id: get(r, "gp"), err: "" };
        const org = matchOrg(j.orgText);
        j.org_id = org ? org.id : "";
        j.type_key = matchType(j.typeText, org);
        const parts = get(r, "date").split(/\s*(?:;|&|\band\b|\n)\s*/i).filter(Boolean);
        let days = parts.map(parseDate);
        if (!parts.length) j.err = "No date.";
        else if (days.some((d) => !d)) j.err = "Can't read the date “" + parts[days.findIndex((d) => !d)] + "”. Use 2027-04-24 or 4/24/2027.";
        const endDate = get(r, "end_date");
        if (!j.err && endDate) {
          const e = parseDate(endDate);
          if (!e) j.err = "Can't read the end date “" + endDate + "”.";
          else if (days.length === 1 && e >= days[0]) { const all = []; for (let d = days[0]; d <= e && all.length < 15; d = addDays(d, 1)) all.push(d); days = all; }
          else if (e < days[0]) j.err = "The end date is before the date.";
        }
        if (!j.err && days.length > 14) j.err = "More than 14 dates.";
        const [s, e] = parseTimes(get(r, "start"), get(r, "end"));
        if (!j.err && (s === null || e === null)) j.err = "Can't read the time “" + [get(r, "start"), get(r, "end")].filter(Boolean).join(" ") + "”. Use 9:00 or 9am.";
        if (!j.err && e && !s) j.err = "An end time needs a start time.";
        if (!j.err && s && e && e <= s) j.err = "The end time is before the start time.";
        const labels = get(r, "day_labels").split(/\s*;\s*/);
        j.days = j.err ? [] : days.map((d, k) => ({ day: d, start_time: s || "", end_time: e || "", label: (labels[k] || "").trim() }));
        if (!j.err && !j.org_id) j.err = "";   // shown as "pick the organization"
        return j;
      });
      return { cols, jobs };
    }
    const itemOf = (j) => ({ org_id: j.org_id, type_key: j.type_key, days: j.days, title_label: j.title_label, location: j.location, notes: j.notes, gotphoto_job_id: j.gotphoto_job_id });

    function sampleCsv() {
      const y = Number(today().slice(0, 4)) + 1;
      return "Organization,Type,Date,End date,Start,End,Title,Location,Notes\n" +
        "Hampden Little League,Sports,4/24/" + y + ",4/25/" + y + ",9:00,13:00,Spring Sports,Hampden Rec Field,Two-day weekend\n" +
        "Brewer High School,School,9/14/" + y + ",,8:00,14:00,School Photos,Brewer HS gym,\n" +
        "Orono Soccer,Sports Roster Only,\"9/20/" + y + "; 9/27/" + y + "\",,10am,12pm,Fall Sports,,Two Saturdays\n";
    }

    // ---------------------------------------------------------------- import
    async function openImport() {
      try { await ensureLookup(); } catch (e) { return toast(cleanErr(e), true); }
      const m = openModal('<h2>Import jobs from a spreadsheet</h2>' +
        '<div id="aca-jsImpBody"><p>Save the sheet as <b>CSV</b> (in Excel or Google Sheets: File, Download, CSV) and pick it here. One row per job; the first row names the columns.</p>' +
        '<div class="js-row"><input type="file" id="aca-jsFile" accept=".csv,.tsv,.txt,text/csv" /><a href="#" id="aca-jsSample" class="small">Download a sample</a></div>' +
        '<details><summary class="js-s" style="cursor:pointer">Or paste the rows</summary><textarea id="aca-jsPaste" style="width:100%;height:110px;margin-top:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px" placeholder="Organization,Type,Date,Start,End,Title"></textarea><button type="button" class="small" id="aca-jsPasteGo" style="margin-top:6px">Read these rows</button></details>' +
        '<p class="js-cols">Columns it understands: <b>Organization</b> and <b>Date</b> (needed); Type (School, Sports, Roster only); End date (makes a run of days); Start and End time; Title (Spring Sports); Location; Notes; GotPhoto job id; Day labels. ' +
        'A job with several dates: put them in one cell with <code>;</code> between (4/24/2027; 4/25/2027), or use End date. Nothing is added until you check the list and press Add.</p></div>' +
        '<div class="inline-error hidden" id="aca-jsImpErr"></div>' +
        '<div class="modal-actions" id="aca-jsImpActs"><button type="button" class="small" data-x="close">Cancel</button></div>');
      m.classList.add("js-wide");
      m.querySelector("[data-x=close]").addEventListener("click", () => m.close());
      el("jsSample").addEventListener("click", (e) => {
        e.preventDefault();
        const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([sampleCsv()], { type: "text/csv" })); a.download = "season-jobs-sample.csv"; a.click();
      });
      const read = (text, name) => {
        clearError("jsImpErr");
        const rows = parseCSV(text);
        if (rows.length < 2) return showError("jsImpErr", "That file has no rows under the column names.");
        if (rows.length > 501) return showError("jsImpErr", "At most 500 jobs at a time. Split the file.");
        const r = rowsToJobs(rows);
        if (r.error) return showError("jsImpErr", r.error);
        showPreview(m, r.jobs, name || "Pasted rows", r.cols);
      };
      el("jsFile").addEventListener("change", () => {
        const f = el("jsFile").files[0]; if (!f) return;
        const fr = new FileReader(); fr.onload = () => read(String(fr.result), f.name); fr.readAsText(f);
      });
      el("jsPasteGo").addEventListener("click", () => read(el("jsPaste").value, "Pasted rows"));
    }

    function showPreview(m, jobs, fileName, cols) {
      let seq = 0;
      const body = el("jsImpBody");
      const missing = ["type", "start", "title", "location"].filter((k) => cols[k] == null);
      body.innerHTML = '<p><b>' + esc(fileName) + "</b>: " + esc(plural(jobs.length, "row")) + ". Fix anything marked, untick rows you don't want, then add them." +
        (missing.length ? ' <span class="js-s">No ' + missing.map((k) => ({ type: "Type", start: "Start time", title: "Title", location: "Location" })[k]).join(", ") + " column, so those are left blank" + (cols.type == null ? " and the type is guessed from the organization" : "") + ".</span>" : "") + "</p>" +
        orgDatalist() + '<div class="js-scroll"><table class="js-t"><thead><tr><th></th><th>Organization</th><th>Type</th><th>Dates</th><th class="hide-sm">Title</th><th>Check</th></tr></thead><tbody id="aca-jsRows"></tbody></table></div>' +
        '<p class="js-s" id="aca-jsSum" style="margin-top:8px"></p>';
      el("jsImpActs").innerHTML = '<button type="button" class="small" data-x="close">Cancel</button><button type="button" class="primary" id="aca-jsAdd" disabled>Add jobs</button>';
      el("jsImpActs").querySelector("[data-x=close]").addEventListener("click", () => m.close());

      function rowHtml(j, i) {
        const r = j.check;
        let status;
        if (j.err) status = '<span class="pill err">Fix it</span><span class="s">' + esc(j.err) + "</span>";
        else if (!j.org_id) status = '<span class="pill warn">Pick the organization</span>' + (j.orgText ? '<span class="s">No match for “' + esc(j.orgText) + "”</span>" : "");
        else if (!j.type_key) status = '<span class="pill warn">Pick the job type</span>';
        else if (!j.include) status = '<span class="pill muted">Left out</span>';
        else if (!r) status = '<span class="pill muted">Checking&#8230;</span>';
        else if (r.ok) status = '<span class="pill ok">Ready</span>';
        else if (r.duplicate_of) status = '<span class="pill warn">Already on Bookings</span><span class="s"><a href="' + esc(jobHref(r.duplicate_of)) + '" target="_blank" rel="noopener">see that job</a></span>';
        else status = '<span class="pill err">Fix it</span><span class="s">' + esc(r.error || "") + "</span>";
        const o = orgById(j.org_id);
        return '<tr class="' + (j.include ? "" : "off") + '"><td><input type="checkbox" data-inc="' + i + '"' + (j.include ? " checked" : "") + ' aria-label="Include row ' + j.line + '" /><span class="s">' + j.line + "</span></td>" +
          '<td><input type="text" list="aca-jsOrgs" data-org="' + i + '" value="' + esc(o ? o.pick : j.orgText) + '" placeholder="Pick the organization" /></td>' +
          "<td>" + typeSelect(j.type_key, 'data-type="' + i + '"') + "</td>" +
          "<td>" + esc(daysText(j.days, true) || "—") + (j.days.length > 1 ? '<span class="s">' + j.days.length + " days, one job</span>" : "") + (j.location ? '<span class="s">' + esc(j.location) + "</span>" : "") + "</td>" +
          '<td class="hide-sm">' + esc(j.title_label || "") + "</td><td>" + status + "</td></tr>";
      }
      const ready = () => jobs.filter((j) => j.include && j.check && j.check.ok);
      function draw() {
        el("jsRows").innerHTML = jobs.map(rowHtml).join("");
        const n = ready().length, dup = jobs.filter((j) => j.include && j.check && j.check.duplicate_of).length;
        const fix = jobs.filter((j) => j.include && (j.err || !j.org_id || !j.type_key || (j.check && !j.check.ok && !j.check.duplicate_of))).length;
        el("jsSum").textContent = [n + " ready", dup ? dup + " already on Bookings (left out)" : "", fix ? fix + " to fix" : ""].filter(Boolean).join(" · ");
        el("jsAdd").disabled = !n;
        el("jsAdd").textContent = n ? "Add " + plural(n, "job") : "Add jobs";
      }
      // Dry run of every row that can be checked; the database says what is ready, a duplicate, or wrong.
      async function check() {
        const my = ++seq;
        const list = jobs.filter((j) => j.include && !j.err && j.org_id && j.type_key);
        jobs.forEach((j) => { j.check = null; });
        draw();
        if (!list.length) return;
        const { data, error } = await sb.rpc("jobsetup_import", { p_kind: "csv", p_label: fileName, p_items: list.map(itemOf), p_dry: true });
        if (my !== seq) return;
        if (error) { showError("jsImpErr", cleanErr(error)); return; }
        clearError("jsImpErr");
        (data.results || []).forEach((r) => { list[r.i].check = r; });
        draw();
      }
      el("jsRows").addEventListener("change", (e) => {
        const t = e.target;
        if (t.dataset.inc != null) jobs[+t.dataset.inc].include = t.checked;
        else if (t.dataset.org != null) { const o = orgByPick(t.value) || matchOrg(t.value); jobs[+t.dataset.org].org_id = o ? o.id : ""; jobs[+t.dataset.org].orgText = t.value; }
        else if (t.dataset.type != null) jobs[+t.dataset.type].type_key = t.value;
        else return;
        check();
      });
      el("jsAdd").addEventListener("click", async () => {
        const list = ready();
        if (!list.length) return;
        el("jsAdd").disabled = true; el("jsAdd").textContent = "Adding…";
        const { data, error } = await sb.rpc("jobsetup_import", { p_kind: "csv", p_label: fileName, p_items: list.map(itemOf), p_dry: false });
        if (error) { showError("jsImpErr", cleanErr(error)); draw(); return; }
        done(m, data);
      });
      draw();
      check();
    }

    function done(m, data) {
      const skipped = (data.results || []).filter((r) => !r.ok);
      el(m.querySelector("#aca-jsImpBody") ? "jsImpBody" : "jsCopyBody").innerHTML =
        "<p><b>Added " + esc(plural(data.added, "job")) + ".</b> They are on Bookings as tracking only, so nothing is sent for them. Undo the whole batch from Season setup if something is off.</p>" +
        (skipped.length ? "<p>Left out " + esc(plural(skipped.length, "job")) + ":</p><ul>" + skipped.slice(0, 20).map((r) => "<li>" + esc((r.title || "") + ": " + (r.error || "")) + "</li>").join("") + "</ul>" : "");
      const acts = m.querySelector(".modal-actions");
      acts.innerHTML = '<a class="btn small" href="#jobs/bookings">Open Bookings</a><button type="button" class="primary" data-x="close">Done</button>';
      acts.querySelector("[data-x=close]").addEventListener("click", () => m.close());
      acts.querySelector("a").addEventListener("click", () => m.close());
      loadHistory();
    }

    // ---------------------------------------------------------------- copy last season
    async function openCopy() {
      try { await ensureLookup(); } catch (e) { return toast(cleanErr(e), true); }
      const from = addDays(today(), -365), to = addDays(from, 120);
      const m = openModal('<h2>Copy last season forward</h2>' +
        '<div class="js-row"><label for="aca-jsFrom">Jobs from</label><input type="date" id="aca-jsFrom" value="' + from + '" /><label for="aca-jsTo">to</label><input type="date" id="aca-jsTo" value="' + to + '" />' +
        '<label for="aca-jsShift">moved</label><select id="aca-jsShift">' + [50, 51, 52, 53, 54].map((w) => '<option value="' + w * 7 + '"' + (w === 52 ? " selected" : "") + ">" + w + " weeks" + (w === 52 ? " (same weekday, a year on)" : "") + "</option>").join("") + "</select>" +
        '<button type="button" class="small" id="aca-jsShow">Show jobs</button></div>' +
        '<div id="aca-jsCopyBody"><p class="js-s">Lists the jobs on Bookings in those dates and the GotPhoto jobs that never were, with their new dates. Untick the ones that are not coming back: a copied job counts as rebooked, so its organization leaves the Rebooking list. Copies are tracking only; times, places and every day of a multi-day job come along.</p></div>' +
        '<div class="inline-error hidden" id="aca-jsCopyErr"></div>' +
        '<div class="modal-actions"><button type="button" class="small" data-x="close">Cancel</button><button type="button" class="primary" id="aca-jsCopyAdd" disabled>Copy jobs</button></div>');
      m.classList.add("js-wide");
      m.querySelector("[data-x=close]").addEventListener("click", () => m.close());
      let jobs = [], label = "";
      const shift = () => Number(el("jsShift").value);
      const ok = (j) => j.include && j.org_id && j.type_key;
      function rowHtml(j, i) {
        let status;
        if (j.copied_already) status = '<span class="pill muted">Copied already</span><span class="s"><a href="' + esc(jobHref(j.copied_already)) + '" target="_blank" rel="noopener">see the copy</a></span>';
        else if (j.duplicate_of) status = '<span class="pill warn">Already on Bookings</span><span class="s"><a href="' + esc(jobHref(j.duplicate_of)) + '" target="_blank" rel="noopener">see that job</a></span>';
        else if (!j.org_id) status = '<span class="pill warn">Pick the organization</span>';
        else if (!j.include) status = '<span class="pill muted">Left out</span>';
        else status = '<span class="pill ok">Will copy</span>';
        const o = orgById(j.org_id);
        return '<tr class="' + (j.include || !j.org_id ? "" : "off") + '"><td><input type="checkbox" data-inc="' + i + '"' + (j.include ? " checked" : "") + ' aria-label="Copy ' + esc(j.title) + '" /></td>' +
          "<td><b>" + esc(j.title) + "</b>" + (j.source === "gotphoto" ? '<span class="s">GotPhoto job, not on Bookings</span>' : j.status === "tracked" ? '<span class="s">tracking only</span>' : "") +
          (j.source === "gotphoto" || !j.org_id ? '<input type="text" list="aca-jsOrgs" data-org="' + i + '" value="' + esc(o ? o.pick : "") + '" placeholder="Pick the organization" style="margin-top:4px" />' : "") + "</td>" +
          "<td>" + (j.source === "gotphoto" ? typeSelect(j.type_key, 'data-type="' + i + '"') : esc(j.type_label)) + "</td>" +
          '<td class="hide-sm">' + esc((j.from_days || []).map((d) => fmtShort(d, false)).join(", ") + ", " + String((j.from_days || [""])[0]).slice(0, 4)) + "</td>" +
          "<td>" + esc(daysText(j.days, true)) + (j.days.length > 1 ? '<span class="s">' + j.days.length + " days, one job</span>" : "") + "</td><td>" + status + "</td></tr>";
      }
      function draw() {
        const n = jobs.filter(ok).length;
        el("jsCopyRows").innerHTML = jobs.map(rowHtml).join("");
        el("jsCopySum").textContent = plural(jobs.length, "job") + " found · " + n + " to copy";
        el("jsCopyAdd").disabled = !n;
        el("jsCopyAdd").textContent = n ? "Copy " + plural(n, "job") : "Copy jobs";
      }
      el("jsShow").addEventListener("click", async () => {
        clearError("jsCopyErr");
        const f = el("jsFrom").value, t = el("jsTo").value;
        if (!f || !t || t < f) return showError("jsCopyErr", "Pick the first and last day to copy from.");
        el("jsCopyBody").innerHTML = '<p class="empty"><span class="spin"></span>Finding jobs&#8230;</p>';
        const { data, error } = await sb.rpc("jobsetup_copy_candidates", { p_from: f, p_to: t, p_shift: shift() });
        if (error) { el("jsCopyBody").innerHTML = ""; return showError("jsCopyErr", cleanErr(error)); }
        jobs = (data || []).map((j) => Object.assign(j, { include: !j.copied_already && !j.duplicate_of && !!j.org_id }));
        label = fmtShort(f) + " – " + fmtShort(t, true) + " + " + (shift() / 7) + " weeks";
        el("jsCopyBody").innerHTML = jobs.length ? orgDatalist() + '<div class="js-scroll"><table class="js-t"><thead><tr><th></th><th>Job</th><th>Type</th><th class="hide-sm">Was</th><th>New dates</th><th></th></tr></thead><tbody id="aca-jsCopyRows"></tbody></table></div><p class="js-s" id="aca-jsCopySum" style="margin-top:8px"></p>'
          : '<p class="empty">No jobs in those dates, on Bookings or in GotPhoto.</p>';
        if (!jobs.length) { el("jsCopyAdd").disabled = true; return; }
        el("jsCopyRows").addEventListener("change", (e) => {
          const x = e.target;
          if (x.dataset.inc != null) jobs[+x.dataset.inc].include = x.checked;
          else if (x.dataset.org != null) { const o = orgByPick(x.value) || matchOrg(x.value); jobs[+x.dataset.org].org_id = o ? o.id : null; if (o) jobs[+x.dataset.org].include = true; }
          else if (x.dataset.type != null) jobs[+x.dataset.type].type_key = x.value;
          draw();
        });
        draw();
      });
      el("jsCopyAdd").addEventListener("click", async () => {
        const list = jobs.filter(ok);
        if (!list.length) return;
        el("jsCopyAdd").disabled = true; el("jsCopyAdd").textContent = "Copying…";
        const items = list.map((j) => ({ copied_from: j.copied_from || null, copied_from_job: j.copied_from_job || null, org_id: j.org_id, type_key: j.type_key, days: j.days,
                                         title_label: j.title_label, title_override: j.title_override, location: j.location }));
        const { data, error } = await sb.rpc("jobsetup_import", { p_kind: "copy", p_label: label, p_items: items, p_dry: false });
        if (error) { showError("jsCopyErr", cleanErr(error)); draw(); return; }
        done(m, data);
      });
      el("jsShow").click();
    }

    // ---------------------------------------------------------------- one job: dates + copy forward
    // b: the booking as admin_booking_detail / admin_bookings returns it. Renders into box.
    function renderJob(b, box, onChange) {
      const tracked = b.status === "tracked";
      const can = edit() && tracked;
      const firstTime = (b.time_set !== false) && b.start_at;
      const local = (iso) => iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }) : "";
      let days = (b.days && b.days.length ? b.days : [{ day: b.picture_day, start_at: firstTime ? b.start_at : null, end_at: firstTime && b.end_set !== false ? b.end_at : null, sort: 0 }])
        .map((d, i) => { const first = d.sort === 0 || (d.sort == null && i === 0);   // job_get's days carry no sort
          return { day: d.day, start_time: (first ? firstTime : d.start_at) ? local(first ? b.start_at : d.start_at) : "",
                   end_time: (first ? firstTime && b.end_set !== false : d.start_at && d.end_at) ? local(first ? b.end_at : d.end_at) : "", label: d.label || "" }; });
      const src = b.copied_from ? '<p class="js-s">Copied forward from <a href="' + esc(jobHref(b.copied_from)) + '">an earlier job</a>.</p>'
        : b.copied_from_job ? '<p class="js-s">Copied forward from last season&rsquo;s GotPhoto job.</p>' : b.import_id ? '<p class="js-s">Added by a Season setup import.</p>' : "";
      function draw() {
        box.innerHTML = '<h3 class="js-h" style="margin-top:0">' + (days.length > 1 ? days.length + " dates" : "Date") + "</h3>" + src +
          (can ? '<ul class="js-days">' + days.map((d, i) => '<li><input type="date" data-k="day" data-i="' + i + '" value="' + esc(d.day || "") + '" aria-label="Date" />' +
              '<input type="time" data-k="start_time" data-i="' + i + '" value="' + esc(d.start_time) + '" aria-label="Start" /><span class="js-s">to</span><input type="time" data-k="end_time" data-i="' + i + '" value="' + esc(d.end_time) + '" aria-label="End" />' +
              '<input type="text" data-k="label" data-i="' + i + '" value="' + esc(d.label) + '" placeholder="Label (Majors, rain date)" maxlength="80" />' +
              (days.length > 1 ? '<button type="button" class="small" data-rm="' + i + '" aria-label="Take this date off">✕</button>' : "") + "</li>").join("") + "</ul>" +
              '<div class="js-row"><button type="button" class="small" data-v="add">Add a date</button><button type="button" class="small primary" data-v="save">Save dates</button></div><div class="inline-error hidden" data-v="err"></div>'
            : '<ul class="js-days">' + days.map((d) => "<li>" + esc(dayText(d)) + "</li>").join("") + "</ul>" +
              (tracked ? "" : '<p class="js-s">' + (b.status === "booked" ? "Change a booked job&rsquo;s dates with Edit booking, so the emails and calendar follow." : "This job is " + esc(b.status) + ".") + "</p>")) +
          (edit() && b.status !== "cancelled" ? '<h3 class="js-h">Copy forward</h3><div class="js-row"><select data-v="shift">' + [52, 53, 51, 26, 13].map((w) => '<option value="' + w * 7 + '">' + w + " weeks later</option>").join("") +
              '</select><button type="button" class="small" data-v="copy">Copy this job</button></div><p class="js-s">Makes a tracking-only copy with the same organization, title, place, times and every date, moved forward. Nothing is sent.</p><div data-v="copied"></div>' : "");
      }
      box.onchange = (e) => { const t = e.target; if (t.dataset.k) days[+t.dataset.i][t.dataset.k] = t.value; };
      box.onclick = async (e) => {
        const t = e.target.closest("button"); if (!t) return;
        if (t.dataset.rm != null) { days.splice(+t.dataset.rm, 1); draw(); return; }
        const v = t.dataset.v;
        if (v === "add") { const last = days[days.length - 1]; days.push({ day: last && last.day ? addDays(last.day, 1) : "", start_time: last ? last.start_time : "", end_time: last ? last.end_time : "", label: "" }); draw(); return; }
        if (v === "save") {
          const errBox = box.querySelector("[data-v=err]");
          t.disabled = true;
          const { data, error } = await sb.rpc("jobsetup_set_days", { p_booking: b.id, p_days: days.filter((d) => d.day) });
          t.disabled = false;
          if (error) { errBox.textContent = cleanErr(error); errBox.classList.remove("hidden"); return; }
          errBox.classList.add("hidden");
          days.sort((x, y) => x.day.localeCompare(y.day));
          toast("Saved " + plural(data.days.length, "date") + ".");
          draw();
          if (onChange) onChange();
          return;
        }
        if (v === "copy") {
          t.disabled = true;
          const { data, error } = await sb.rpc("jobsetup_copy_one", { p_booking: b.id, p_shift: Number(box.querySelector("[data-v=shift]").value) });
          t.disabled = false;
          const out = box.querySelector("[data-v=copied]");
          if (error) { out.innerHTML = '<p class="inline-error">' + esc(cleanErr(error)) + "</p>"; return; }
          out.innerHTML = data.ok ? '<p><span class="pill ok">Copied</span> ' + esc(daysText(data.days, true)) + ' &middot; <a href="' + esc(jobHref(data.id)) + '">open the copy</a></p>'
            : '<p><span class="pill warn">Not copied</span> ' + esc(data.error || "") + (data.duplicate_of ? ' <a href="' + esc(jobHref(data.duplicate_of)) + '">see that job</a>' : "") + "</p>";
          if (data.ok) loadHistory();
        }
      };
      draw();
    }

    // #jobs/setup/<booking id>: the same, in a dialog (for when there is no job page).
    async function openDates(id) {
      const m = openModal('<h2>Job dates</h2><div id="aca-jsOne"><p class="empty"><span class="spin"></span>Loading&#8230;</p></div><div class="modal-actions"><button type="button" class="small" data-x="close">Close</button></div>');
      m.querySelector("[data-x=close]").addEventListener("click", () => m.close());
      const { data, error } = await sb.rpc("admin_booking_detail", { p_id: id });
      if (error || !data) { el("jsOne").innerHTML = '<p class="inline-error">' + esc(error ? cleanErr(error) : "Job not found.") + "</p>"; return; }
      m.querySelector("h2").textContent = data.title || "Job dates";
      renderJob(data, el("jsOne"));
    }

    // The job page's "Dates" tab (jobpage.js, PR #29: registerJobTab is a hoisted function declaration, so this
    // works whichever file comes first, and does nothing when the job page is not in the build).
    // render(booking, el, job): job = job_get(), whose dates are job.days.
    if (typeof registerJobTab === "function") registerJobTab({ id: "dates", label: "Dates", module: "jobsetup", order: 35,
      render: (b, box, job) => renderJob(Object.assign({}, b, job && job.days ? { days: job.days } : {}), box) });

    return { load, loadHistory, renderJob, openDates, _parse: { parseCSV, parseDate, parseTime, rowsToJobs } };
  })();
