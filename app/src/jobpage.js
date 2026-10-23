  // ================================================================ JOBS: Job page (2026-10-23)
  // Everything about one booking on one screen, at #jobs/job/<booking id>[/<tab>]: Overview, Checklist,
  // Results, Notes (with @mentions that push to the person) and History. It is not in the menu; it opens from the
  // booking panel, a schedule bar, Cmd-K and links in notifications. Anyone with a job area (Bookings, Scheduling,
  // Job checklists, Season results) can open it, and so can anyone on the job's crew; each tab shows
  // only what that person may see. RPCs: job_get, job_people, job_notes_list, job_note_add / _edit / _remove,
  // history_get, signins_get (migration 20261023010000_job_page.sql).
  //
  // Other modules add a tab from their own file (guarded, so load order never matters):
  //   if (typeof registerJobTab === "function") registerJobTab({ id: "gear", label: "Gear", order: 40, module: "inventory",
  //     show: (job) => true, render: (booking, el, job) => { el.innerHTML = "..."; } });
  // `module` (optional) hides the tab from people who can't see that area; `show(job)` (optional) can hide it per job.
  // `job` is the job_get() result; render may be async. Built-in orders: overview 10, checklist 30,
  // results 60, notes 80, history 90. Others: booking 12 (bookings.js), crew 15, time 65.
  // One job screen (2026-10-24): every way into a job opens this page (Bookings.openId / jobLink); the old booking
  // panel is the Booking tab; Edit booking is the header's main button. Crew who have no job area see Overview,
  // Notes and the Checklist (when they have steps on it).
  function registerJobTab(t) { (registerJobTab.list || (registerJobTab.list = [])).push(t); }
  // A link to a job page, for other modules: '<a href="' + jobLink(id) + '">'.
  function jobLink(id, tab) { return "#jobs/job/" + encodeURIComponent(id) + (tab ? "/" + tab : ""); }

  registerPage({ id: "job", group: "Jobs", section: "jobs", module: null, hidden: true, selfService: true, navAs: "jobs",
                 tabs: [["job", "Job"]], onShow: () => JobPage.show() });

  // ---------------------------------------------------------------- history, shared with Organizations and Team
  const HistoryView = (function () {
    const LABELS = {
      picture_day: "Picture day", start_at: "Start", end_at: "End", location: "Location", notes: "Notes", status: "Status",
      title_override: "Name", title_label: "Name", access_code: "Access code", retake_day: "Retake day", gotphoto_job_id: "GotPhoto job",
      contact_ids: "Contacts", type_key: "Job type", duration_min: "Length (minutes)", time_set: "Time set", end_set: "End time set",
      cancelled_at: "Cancelled", hub_school_id: "Hub school", org_id: "Organization", sequence_id: "Email sequence",
      day: "Day", label: "Label", removed: "Removed", sort: "Order", user_id: "Person", kind: "Kind", drive_before_min: "Drive there (min)",
      drive_after_min: "Drive back (min)", starts_at: "Starts", ends_at: "Ends", title: "Title", note: "Note", booking_id: "Job",
      name: "Name", audience: "Audience", sport: "Sport", town: "Town", website: "Website", stage: "Stage", next_action_at: "Follow up on",
      next_action: "Next step", sports: "Sports", seasons: "Seasons", services: "Services", county: "County", client_since: "Client since",
      sp_status: "School pictures", sp_competitor: "Current photographer", sp_until: "Contract until", sp_note: "School pictures note",
      personal_line: "Personal line", name_known: "Name known", needs_new_contact: "Needs a new contact", cal_dates: "Calendar dates",
      shoot_months: "Shoot months", last_result: "Last result", gotphoto_names: "GotPhoto names", source: "Source", history_source: "History source",
      wifi_network: "WiFi network", wifi_password: "WiFi password", clock_in: "Clock in", clock_out: "Clock out", job_title: "Job", miles: "Miles", auto: "Automatic", user_name: "Person", created_by: "Added by",
    };
    const WHAT = { bookings: "the job", booking_days: "a day", schedule_entries: "the crew", prospect_orgs: "the organization",
                   time_punches: "a time punch", mileage_trips: "a mileage trip", stage: "the stage", job_email: "an email" };
    const SKIP = ["id", "created_at", "updated_at", "created_by", "token", "contact_ids_text"];
    let names = {};
    const isTs = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v);
    const isDay = (v) => typeof v === "string" && /^\d{4}-\d\d-\d\d$/.test(v);
    const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v);
    function val(k, v) {
      if (v === null || v === undefined || v === "") return '<span class="muted">blank</span>';
      if (typeof v === "boolean") return v ? "yes" : "no";
      if (Array.isArray(v)) return v.length ? esc(v.map((x) => (isUuid(x) && names[x]) || (isUuid(x) ? "one" : x)).join(", ")) : '<span class="muted">none</span>';
      if (isTs(v)) return esc(Fmt.dayTime(v));
      if (isDay(v)) return esc(Fmt.day(v));
      if (isUuid(v)) return esc(names[v] || "someone");
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return esc(s.length > 160 ? s.slice(0, 160) + "\u2026" : s);
    }
    function line(h) {
      const ch = h.changes || {};
      const what = WHAT[h.tbl] || h.tbl;
      if (h.tbl === "stage") return "moved the job to <b>" + esc((ch.stage || [])[1] || "") + "</b>";
      // Email from the job page (2026-10-23)
      if (h.tbl === "job_email") return "emailed <b>" + esc((ch.to || [])[1] || "someone") + "</b>: " + esc((ch.subject || [])[1] || "") +
        ((ch.how || [])[1] === "queue" ? ' <span class="muted">(added to the queue)</span>' : "");
      if (h.tbl === "schedule_entries" && (h.action === "added" || h.action === "removed")) {
        const who = ch.user_id ? ch.user_id[h.action === "added" ? 1 : 0] : null;
        return (h.action === "added" ? "put <b>" : "took <b>") + esc((who && names[who]) || "someone") + "</b> " + (h.action === "added" ? "on" : "off") + " the crew";
      }
      const keys = Object.keys(ch).filter((k) => !SKIP.includes(k));
      if (h.action === "added") return "added " + esc(what);
      if (h.action === "removed") return "removed " + esc(what);
      if (!keys.length) return "changed " + esc(what);
      return "changed " + esc(what) + '<ul class="hv-ch">' + keys.map((k) => "<li>" + esc(LABELS[k] || k.replace(/_/g, " ")) + ": " +
        (h.action === "changed" ? val(k, ch[k][0]) + " &#8594; " : "") + val(k, ch[k][1]) + "</li>").join("") + "</ul>";
    }
    async function render(kind, id, box, nameMap) {
      names = nameMap || {};
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const { data, error } = await supabase.rpc("history_get", { p_kind: kind, p_id: id });
      if (error) { box.innerHTML = '<div class="inline-error">' + esc(String(error.message || error).replace(/^P0001:\s*/, "")) + "</div>"; return; }
      const rows = data || [];
      if (!rows.length) { box.innerHTML = '<div class="empty">No changes recorded yet. History starts from 23 October 2026.</div>'; return; }
      box.innerHTML = '<ul class="hv-list">' + rows.map((h) => '<li><span class="hv-at" title="' + esc(new Date(h.at).toLocaleString()) + '">' + esc(fmtAgo(h.at)) +
        '</span><span class="hv-what"><b>' + esc(h.who || "Someone") + "</b> " + line(h) + "</span></li>").join("") + "</ul>";
    }
    function open(kind, id, title, nameMap) {
      const m = openModal('<div class="hv-modal"><h2>' + esc(title || "History") + '</h2><div id="aca-hvBody"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-x>Close</button></div></div>');
      m.parentNode.style.zIndex = 10000;   // above the Organizations side panel
      m.querySelector("[data-x]").onclick = () => m.close();
      render(kind, id, el("hvBody"), nameMap);
    }
    // Sign-ins for one person (Team page).
    async function signins(uid, title) {
      const m = openModal('<div class="hv-modal"><h2>' + esc(title || "Sign-ins") + '</h2><p class="muted" style="margin:0 0 10px;font-size:13px">Each time someone finished signing in (with the emailed code or a remembered device). Recorded from 23 October 2026.</p><div id="aca-hvBody"></div><div class="modal-actions"><span class="grow"></span><button type="button" class="small" data-x>Close</button></div></div>');
      m.parentNode.style.zIndex = 10000;
      m.querySelector("[data-x]").onclick = () => m.close();
      const box = el("hvBody");
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const { data, error } = await supabase.rpc("signins_get", { p_user: uid });
      if (error) { box.innerHTML = '<div class="inline-error">' + esc(error.message) + "</div>"; return; }
      const rows = data || [];
      if (!rows.length) { box.innerHTML = '<div class="empty">No sign-ins recorded yet.</div>'; return; }
      box.innerHTML = '<table class="hv-table"><thead><tr><th>When</th><th>How</th><th>Device</th><th>Where</th></tr></thead><tbody>' + rows.map((s) =>
        "<tr><td>" + esc(Fmt.dayTime(s.at)) + "</td><td>" +
        esc(s.via === "device" ? "Remembered device" : s.via === "code" ? "Emailed code" : s.via || "") + "</td><td>" + esc(device(s.user_agent)) + "</td><td>" +
        esc([s.country, s.ip].filter(Boolean).join(" \u00b7 ") || "unknown") + "</td></tr>").join("") + "</tbody></table>";
    }
    function device(ua) {
      ua = ua || "";
      if (!ua) return "unknown";
      const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
      const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
      return [br, os].filter(Boolean).join(" on ") || ua.slice(0, 40);
    }
    return { render, open, signins };
  })();

  const JobPage = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .jp-trail { margin: 0 0 8px; font-size: 13px; color: var(--muted); } .aca .jp-trail a { color: var(--muted); } .aca .jp-trail a:last-of-type { color: var(--head); font-weight: 600; }
    .aca .jp-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin: 2px 0 6px; }
    .aca .jp-head h2 { margin: 0; font-size: 20px; font-weight: 600; line-height: 26px; }
    .aca .jp-head .s { color: var(--muted); font-size: 13.5px; margin-top: 2px; }
    .aca .jp-head .acts { display: flex; gap: 6px; flex-wrap: wrap; }
    .aca .jp-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin: 12px 0 18px; overflow-x: auto; scrollbar-width: none; }
    .aca .jp-tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; height: 34px; padding: 0 12px; color: var(--muted); font-weight: 600; white-space: nowrap; }
    .aca .jp-tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
    .aca .jp-tabs button .n { color: var(--faint); font-weight: 400; margin-left: 4px; }
    .aca .jp-stages { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 4px 0 18px; padding: 0; list-style: none; font-size: 13px; }
    .aca .jp-stages li { color: var(--faint); } .aca .jp-stages li.on { color: var(--ok-fg); font-weight: 600; } .aca .jp-stages li.cur { color: var(--text); }
    .aca .jp-stages li::before { content: "\\25CB  "; } .aca .jp-stages li.on::before { content: "\\25CF  "; }
    .aca .jp-stage1 { display: none; margin: 4px 0 14px; font-size: 13.5px; color: var(--muted); } .aca .jp-stage1 b { color: var(--text); font-weight: 600; }
    .aca .jp-booknote { max-width: 760px; margin: 0 0 18px; padding: 10px 12px; border-left: 3px solid var(--accent); background: var(--surface-2); border-radius: 0 6px 6px 0; }
    .aca .jp-booknote h4 { margin: 0 0 4px; font-size: 12px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--muted); }
    .aca .jp-booknote div { white-space: pre-wrap; font-size: 14px; overflow-wrap: anywhere; }
    .aca .jp-latest { max-width: 980px; margin: 0 0 20px; padding: 10px 14px 12px; background: var(--warn-bg); border-radius: 6px; }
    .aca .jp-latest .hd { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 4px; }
    .aca .jp-latest .hd h3 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--head); }
    .aca .jp-latest .hd a { font-size: 13px; color: var(--muted); }
    .aca .jp-latest .jp-notes { margin: 0 0 8px; max-width: none; } .aca .jp-latest .jp-notes li { padding: 6px 0; border-bottom-color: transparent; }
    .aca .jp-latest .jp-compose { max-width: none; } .aca .jp-latest .jp-compose textarea { min-height: 38px; height: 38px; background: var(--surface); }
    .aca .jp-latest .jp-compose textarea:focus { height: 76px; } .aca .jp-latest .jp-compose .row { margin-top: 6px; } .aca .jp-latest .jp-suggest { top: 42px; }
    .aca .jp-onsite h3 { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .aca .jp-onsite h3 button { text-transform: none; letter-spacing: 0; }
    .aca .jp-onsite .pw { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
    .aca .jp-onsite .oncal { margin: 8px 0 0; font-size: 12.5px; color: var(--muted); }
    .aca .jp-onsite form { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px 12px; align-items: start; font-size: 13.5px; max-width: 560px; }
    .aca .jp-onsite form label { padding-top: 6px; color: var(--muted); }
    .aca .jp-onsite form input, .aca .jp-onsite form textarea { width: 100%; min-width: 0; font: inherit; padding: 6px 9px; }
    .aca .jp-onsite form textarea { min-height: 70px; }
    .aca .jp-onsite form .row { grid-column: 2; display: flex; gap: 6px; }
    .aca .jp-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px 40px; }
    .aca .jp-sec { margin: 0 0 22px; min-width: 0; }
    .aca .jp-mails li { flex-wrap: wrap; } .aca .jp-mails a[data-mail] { color: inherit; text-decoration: none; font-weight: 600; }
    .aca .jp-mailbody { display: none; flex-basis: 100%; white-space: pre-wrap; font-size: 13px; color: var(--muted); padding: 6px 0 2px; }
    .aca .jp-mails li.open .jp-mailbody { display: block; }
    .aca .jp-sec h3 { margin: 0 0 6px; font-size: 13px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--head); }
    .aca .jp-dl { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 5px 12px; margin: 0; font-size: 13.5px; }
    .aca .jp-dl dt { color: var(--muted); } .aca .jp-dl dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .aca .jp-rows { list-style: none; margin: 0; padding: 0; font-size: 13.5px; }
    .aca .jp-rows li { display: flex; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--line2); }
    .aca .jp-rows li .r { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .aca .jp-rows li.done .t { text-decoration: line-through; color: var(--muted); }
    .aca .jp-rows .late { color: var(--err-fg); font-weight: 600; }
    .aca .jp-links { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .aca .jp-dl-menu { position: relative; display: inline-block; }
    .aca .jp-dl-menu > div { position: absolute; right: 0; top: 34px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 4px; min-width: 210px; z-index: 20; }
    .aca .jp-dl-menu > div button { display: block; width: 100%; text-align: left; border: 0; background: transparent; font-weight: 400; }
    .aca .jp-dl-menu > div button:hover { background: var(--surface-2); }
    .aca .jp-notes { list-style: none; margin: 0 0 16px; padding: 0; max-width: 760px; }
    .aca .jp-notes li { padding: 10px 0; border-bottom: 1px solid var(--line2); }
    .aca .jp-notes .h { display: flex; gap: 10px; align-items: baseline; font-size: 13px; }
    .aca .jp-notes .h b { font-size: 13.5px; } .aca .jp-notes .h .muted { font-size: 12.5px; }
    .aca .jp-notes .h .grow { flex: 1; }
    .aca .jp-notes .b { margin-top: 3px; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .aca .jp-notes .b .at { color: var(--accent); font-weight: 600; }
    .aca .jp-compose { max-width: 760px; position: relative; }
    .aca .jp-compose textarea { width: 100%; min-height: 76px; padding: 8px 10px; font: inherit; }
    .aca .jp-compose .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
    .aca .jp-compose .row .muted { font-size: 12.5px; flex: 1; }
    .aca .jp-suggest { position: absolute; left: 0; top: 80px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 4px; min-width: 220px; max-height: 220px; overflow: auto; z-index: 20; }
    .aca .jp-suggest button { display: flex; width: 100%; justify-content: space-between; gap: 10px; border: 0; background: transparent; font-weight: 400; text-align: left; }
    .aca .jp-suggest button.cur, .aca .jp-suggest button:hover { background: var(--surface-2); }
    .aca .jp-suggest button .muted { font-size: 12px; }
    .aca .hv-list { list-style: none; margin: 0; padding: 0; max-width: 820px; font-size: 13.5px; }
    .aca .hv-list li { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--line2); }
    .aca .hv-at { color: var(--muted); font-size: 12.5px; }
    .aca .hv-what { min-width: 0; overflow-wrap: anywhere; }
    .aca .hv-ch { margin: 3px 0 0; padding-left: 18px; color: var(--muted); font-size: 13px; }
    .aca .hv-modal { min-width: min(640px, 86vw); } .aca .hv-modal #aca-hvBody { max-height: 62vh; overflow: auto; }
    .aca .hv-table { width: 100%; font-size: 13px; } .aca .hv-table td, .aca .hv-table th { text-align: left; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line2); vertical-align: top; }
    .aca .hv-table th { font-size: 12px; color: var(--faint); font-weight: 600; }
    @media (max-width: 760px) {
      .aca .jp-grid { grid-template-columns: 1fr; }
      .aca .jp-stages { display: none; } .aca .jp-stage1 { display: block; }
      .aca .jp-head .acts { width: 100%; } .aca .jp-head .acts button.primary { flex: 1 1 auto; min-height: 40px; }
      .aca .jp-dl { grid-template-columns: 1fr; gap: 0; } .aca .jp-dl dd { margin-bottom: 6px; }
      .aca .jp-latest .jp-notes li + li { display: none; }
      .aca .jp-onsite form { grid-template-columns: 1fr; gap: 2px; } .aca .jp-onsite form .row { grid-column: 1; margin-top: 6px; }
      .aca .hv-list li { grid-template-columns: 1fr; gap: 0; }
      .aca .jp-rows li { flex-wrap: wrap; gap: 0 10px; } .aca .jp-rows li .r { white-space: normal; }
    }`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    let J = null, people = null, curTab = "overview", seq = 0, loadingId = null;
    const root = () => el("panel-job");
    const parseHash = () => { const m = /^#jobs\/job\/([0-9a-z-]{3,40})(?:\/([a-z0-9_-]+))?/i.exec(location.hash); return m ? { id: m[1], tab: m[2] || "" } : null; };
    const fmtDayIso = (d) => Fmt.day(d);
    const timeOf = (ts) => (ts ? T.fmtTs(ts) : "");
    const money = (v) => "$" + num(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Built-in tabs, then everyone else's, in order. A registered tab with a
    // built-in's id replaces that built-in.
    function tabs() {
      const builtIn = [
        { id: "overview", label: "Overview", order: 10, render: renderOverview },
        { id: "checklist", label: "Checklist", order: 30, show: (j) => !!j.tasks && (j.tasks.length || canSee("workflows")), count: (j) => (j.tasks || []).filter((t) => !t.done).length, render: renderChecklist },
        { id: "results", label: "Sales", order: 60, module: "results", render: renderResults }, // "Sales" = money (ws/partners 2026-10-24)
        { id: "notes", label: "Notes", order: 80, count: (j) => num(j.notes_count), render: renderNotes },
        { id: "history", label: "History", order: 90, show: (j) => jobArea(j), render: renderHistory },
      ];
      const extra = registerJobTab.list || [];
      return builtIn.filter((b) => !extra.some((t) => t.id === b.id)).concat(extra)
        .filter((t) => (!t.module || canSee(t.module)) && (!t.show || safe(() => t.show(J))))
        .sort((a, b) => (a.order || 50) - (b.order || 50));
    }
    const safe = (f) => { try { return f(); } catch (e) { return false; } };
    // Someone with a job area (not only on the crew).
    const jobArea = (j) => { const c = (j && j.can) || {}; return !!(c.bookings || c.scheduling || c.workflows || c.results || c.pictureday); };

    function show() {
      const h = parseHash();
      if (!h) { root().innerHTML = '<div class="empty">Open a job from All jobs, My jobs, the Schedule or search.</div>'; return; }
      if (J && J.booking.id === h.id) { if (h.tab && h.tab !== curTab) pick(h.tab); return; }
      if (loadingId === h.id) return;
      load(h.id, h.tab);
    }
    // Moving from one job to another (a link inside a job page, a notification) doesn't change the app tab.
    window.addEventListener("hashchange", () => setTimeout(() => { if (/^#jobs\/job\//.test(location.hash) && currentTab === "job") show(); }, 0));

    async function load(id, tab) {
      const my = ++seq;
      loadingId = id;
      root().innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const { data, error } = await sb.rpc("job_get", { p_booking: id });
      if (my !== seq) return;
      loadingId = null;
      if (error || !data) {
        root().innerHTML = '<div class="inline-error">' + esc(error ? (error.code === "42501" ? "You don't have access to this job. " + askWho("Ask", "to add the area on the Team page.") : cleanErr(error)) : "That job doesn't exist any more.") + "</div>";
        return;
      }
      J = data; people = null;
      renderShell();
      pick(tab || "overview");
    }
    const reload = async () => { const { data } = await sb.rpc("job_get", { p_booking: J.booking.id }); if (data) { J = data; renderShell(); pick(curTab); } };

    function dayLine(b) {
      const days = (J.days || []).length > 1 ? J.days : null;
      const t = b.time_set ? " \u00b7 " + timeOf(b.start_at) + (b.end_set ? "\u2013" + timeOf(b.end_at) : "") : " \u00b7 time not set";
      return days ? days.map((d) => Fmt.day(d.day) + (d.label ? " (" + d.label + ")" : "")).join(", ") : fmtDayIso(b.picture_day) + t;
    }

    function renderShell() {
      const b = J.booking, c = J.can;
      const status = b.status === "booked" ? "" : ' <span class="pill muted">' + esc(b.status === "tracked" ? "tracking only" : b.status) + "</span>";
      root().innerHTML =
        // A job lives inside its organization (2026-10-23): the trail leads back to the organization's page.
        '<p class="jp-trail">' + (b.org_id && canSee("partners") ? '<a href="#partners/orgs">Partners</a> &#8250; <a href="' + orgLink(b.org_id, "jobs") + '">' + esc(b.org_name || "Organization") + "</a> &#8250; Jobs"
          : '<a href="#jobs/bookings" id="aca-jpBack">&#8592; ' + (canSee("bookings") ? "All jobs" : "Back") + "</a>") + "</p>" +
        '<div class="jp-head"><div><h2>' + esc(b.title) + status + '</h2><div class="s">' + esc(dayLine(b)) + " \u00b7 " + esc(b.type_label || "") +
        (b.location ? " \u00b7 " + esc(b.location) : "") + "</div></div>" +
        // Edit booking is the page's main action (one Edit button; the Booking tab has none).
        '<div class="acts">' + (c.bookings_edit && b.status === "booked" && typeof Bookings !== "undefined" ? '<button type="button" class="small primary" data-j="edit">Edit booking</button>' : "") +
        (canMail() ? '<button type="button" class="small" data-j="email">Email</button>' : "") +
        '<span class="jp-dl-menu"><button type="button" class="small" data-j="dl">Download &#9662;</button></span></div></div>' +
        (J.stages && J.stages.length ? '<ul class="jp-stages">' + J.stages.map((s) => '<li class="' + (s.reached ? "on" : "") + (J.stage && J.stage.label === s.label ? " cur" : "") + '">' + esc(s.label) + "</li>").join("") + "</ul>" +
          // On a phone the row of stages is one line: "In production, 3 of 6".
          '<p class="jp-stage1">' + stageLine() + "</p>" : "") +
        '<div class="jp-tabs" role="tablist" id="aca-jpTabs"></div><div id="aca-jpBody"></div>';
      if (el("jpBack")) el("jpBack").onclick = (e) => { e.preventDefault(); if (canSee("bookings")) showTab("bookings"); else history.back(); };
      root().querySelector(".jp-head").addEventListener("click", onHeadClick);
      el("jpTabs").innerHTML = tabs().map((t) => {
        const n = t.count ? safe(() => t.count(J)) : 0;
        return '<button type="button" role="tab" data-t="' + esc(t.id) + '">' + esc(t.label) + (n ? '<span class="n">' + num(n) + "</span>" : "") + "</button>";
      }).join("");
      el("jpTabs").addEventListener("click", (e) => { const t = e.target.closest("button[data-t]"); if (t) pick(t.dataset.t); });
    }

    function onHeadClick(e) {
      const t = e.target.closest("[data-j]"); if (!t) return;
      if (t.dataset.j === "edit") Bookings.edit(J.booking.id);
      if (t.dataset.j === "email") emailContacts(t);
      if (t.dataset.j === "dl") {
        const wrap = t.parentNode, open = wrap.querySelector("div");
        if (open) { open.remove(); return; }
        const d = document.createElement("div");
        d.innerHTML = '<button type="button" data-d="sheet">Job sheet (print or PDF)</button><button type="button" data-d="crew">Crew list (CSV)</button>' +
          ((J.tasks || []).length ? '<button type="button" data-d="tasks">Checklist (CSV)</button>' : "");
        wrap.appendChild(d);
        d.addEventListener("click", (ev) => { const b = ev.target.closest("[data-d]"); if (!b) return; d.remove(); download(b.dataset.d); });
        setTimeout(() => document.addEventListener("click", function off(ev) { if (!wrap.contains(ev.target)) { d.remove(); document.removeEventListener("click", off); } }), 0);
      }
    }

    function stageLine() {
      const list = J.stages || [], i = J.stage ? list.findIndex((s) => s.label === J.stage.label) : -1;
      return i < 0 ? "No stage yet" : "<b>" + esc(list[i].label) + "</b>, " + (i + 1) + " of " + list.length;
    }
    function pick(id) {
      if (id === "parents") id = "hub"; // the Parents tab became Hub (2026-10-25); old links still land there
      const list = tabs();
      const t = list.find((x) => x.id === id) || list[0];
      curTab = t.id;
      const hash = jobLink(J.booking.id, t.id === "overview" ? "" : t.id);
      if (location.hash !== hash) history.replaceState(null, "", hash);
      el("jpTabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b.dataset.t === t.id ? "true" : "false"));
      const body = el("jpBody");
      body.innerHTML = "";
      try {
        const r = t.render(J.booking, body, J);
        if (r && r.catch) r.catch((e) => { body.innerHTML = '<div class="inline-error">' + esc(cleanErr(e)) + "</div>"; });
      } catch (e) { body.innerHTML = '<div class="inline-error">' + esc(cleanErr(e)) + "</div>"; }
    }

    // ---------------------------------------------------------------- overview
    function renderOverview(b, box) {
      const c = J.can;
      const crew = J.crew || [];
      const facts = [
        ["When", dayLine(b)], ["Where", b.location || ""], ["Type", b.type_label || ""],
        b.retake_day ? ["Retake day", fmtDayIso(b.retake_day, { weekday: "short", month: "short" })] : null,
        c.bookings && b.access_code ? ["Access code", b.access_code] : null,
        J.stage ? ["Stage", J.stage.label + " (" + fmtAgo(J.stage.at) + ")"] : null,
        J.deliverables && J.deliverables.length ? ["Deliverables", J.deliverables.filter((d) => d.status !== "todo").length + " of " + J.deliverables.length + " delivered"] : null,
      ].filter(Boolean);
      const contacts = J.contacts || [];
      // Remove takes someone off this job's emails (2026-10-23); Edit booking adds people.
      const rm = c.bookings_edit && b.status === "booked" && contacts.length > 1;
      box.innerHTML = '<div class="jp-latest" id="aca-jpLatest"></div><div class="jp-grid"><div>' +
        '<div class="jp-sec jp-onsite" id="aca-jpOnsite"></div>' +
        '<div class="jp-sec"><h3>The job</h3><dl class="jp-dl">' + facts.map((f) => "<dt>" + esc(f[0]) + "</dt><dd>" + esc(f[1] || "\u2014") + "</dd>").join("") +
        "<dt>Organization</dt><dd>" + (canSee("partners") ? '<a href="' + orgLink(b.org_id) + '">' + esc(b.org_name) + "</a>" : esc(b.org_name)) + (b.org_town ? ", " + esc(b.org_town) : "") + "</dd></dl></div>" +
        (contacts.length ? '<div class="jp-sec"><h3>Who gets the emails</h3><ul class="jp-rows">' + contacts.map((p) => "<li><span>" + esc(p.name || p.email || "") +
          (p.role ? ' <span class="muted">' + esc(p.role) + "</span>" : "") + '</span><span class="r">' + esc([p.email, p.phone].filter(Boolean).join(" \u00b7 ")) +
          (rm && p.contact_id ? ' <button type="button" class="small quiet" data-rmc="' + esc(p.contact_id) + '" data-who="' + esc(p.name || p.email || "") + '">Remove</button>' : "") + "</span></li>").join("") + "</ul></div>" : "") +
        (canSee("bookings") || canSee("partners") ? '<div class="jp-sec" id="aca-jpMails"></div>' : "") +
        "</div><div>" +
        '<div class="jp-sec"><h3>Crew</h3>' + (crew.length ? '<ul class="jp-rows">' + crew.map((p) => "<li><span>" + esc(p.name) + (p.note ? ' <span class="muted">' + esc(p.note) + "</span>" : "") +
          '</span><span class="r">' + esc(T.fmtDay(T.local(p.starts_at).day, { weekday: "short" }) + ", " + timeOf(p.starts_at) + "\u2013" + timeOf(p.ends_at)) +
          (p.drive_before_min ? " \u00b7 " + num(p.drive_before_min) + " min drive" : "") + "</span></li>").join("") + "</ul>"
          : '<div class="empty" style="padding:4px 0">Nobody is on this job yet.' + (canSee("scheduling") ? ' <a href="#staff/schedule">Open the schedule</a>.' : "") + "</div>") + "</div>" +
        "</div></div>";
      loadMails(b.id);
      renderOnsite(b);
      renderLatest(b);
      box.onclick = async (e) => {
        const em = e.target.closest("[data-mail]");
        if (em) { e.preventDefault(); em.closest("li").classList.toggle("open"); return; }
        if (e.target.closest("button[data-j=email]")) return emailContacts(e.target.closest("button"));
        const t = e.target.closest("button[data-rmc]"); if (!t) return;
        if (!confirm("Stop this job's emails to " + t.dataset.who + "? Emails that already went out stay sent.")) return;
        t.disabled = true;
        const { error } = await sb.rpc("booking_contact_remove", { p_booking: b.id, p_contact: t.dataset.rmc });
        if (error) { t.disabled = false; toast(cleanErr(error), true); return; }
        toast(t.dataset.who + " is off this job's emails.");
        load(b.id, "overview");
      };
    }
    // ---------------------------------------------------------------- email the job's contacts (2026-10-23)
    // The header's Email button writes to the people under "Who gets the emails", with the partner page's composer
    // (Orgs.emailPeople). The emails go out from Gmail like "Email someone" (prospect-sender), are listed under
    // "Emails from this job" on Overview and land in History. RPCs job_email_send, job_emails (migration 20261024151700).
    const canMail = () => J && J.booking.status !== "cancelled" && (J.contacts || []).length > 0 && (canEdit("bookings") || canEdit("partners")) && typeof Orgs !== "undefined";
    async function emailContacts(btn) {
      const b = J.booking;
      if (btn) btn.disabled = true;
      const { data, error } = await sb.rpc("job_emails", { p_booking: b.id });
      if (btn) btn.disabled = false;
      if (error) { toast(cleanErr(error), true); return; }
      const sent = await Orgs.emailPeople({
        title: "Email about " + b.title, subject: b.title,
        people: (data.contacts || []).map((c) => ({ id: c.id, name: c.name, email: c.email, role: c.role, why: c.why })),
        send: async (ids, subject, body, now) => {
          const r = await sb.rpc("job_email_send", { p_booking: b.id, p_contacts: ids, p_subject: subject, p_body: body, p_now: now });
          if (r.error) throw r.error;
          const d = r.data || {};
          toast(now ? (d.paused ? "Saved, but sending is switched off in Settings > Sending, so it waits until you turn it back on."
            : (d.emails > 1 ? "Sending " + d.emails + " emails now." : "Sending now.") + (d.test_mode ? " Test mode is on, so it goes to the test address." : ""))
            : "Added to the queue. It goes out in the next send window.");
        },
      });
      if (sent && J && J.booking.id === b.id && curTab === "overview") loadMails(b.id);
    }
    async function loadMails(id) {
      const box = el("jpMails"); if (!box) return;
      const { data, error } = await sb.rpc("job_emails", { p_booking: id });
      const box2 = el("jpMails"); if (!box2 || !J || J.booking.id !== id) return;
      if (error) { box2.innerHTML = ""; return; }
      const list = data.emails || [];
      const btn = canMail() ? ' <button type="button" class="small" data-j="email" style="margin-left:8px;text-transform:none;letter-spacing:0">Email</button>' : "";
      const when = (x) => x.status === "sent" ? "sent " + fmtAgo(x.sent_at) + (x.opened_at ? ", opened" : "") + (x.test_mode ? " (test)" : "")
        : x.status === "sending" ? "sending" : x.status === "scheduled" ? "in the queue"
        : x.status === "failed" ? "didn\u2019t send" : x.status;
      box2.innerHTML = '<h3>Emails from this job' + btn + "</h3>" + (list.length ? '<ul class="jp-rows jp-mails">' + list.map((x) =>
        '<li><span class="t"><a href="#" data-mail="1">' + esc(x.subject || "(no subject)") + "</a> " + '<span class="muted">to ' + esc(x.to_name || x.to_email || "someone") +
        (x.by ? " \u00b7 by " + esc(x.by) : "") + '</span></span><span class="r">' + esc(when(x)) + "</span>" +
        '<div class="jp-mailbody">' + esc(x.body || "") + "</div></li>").join("") + "</ul>"
        : '<p class="muted" style="font-size:13px;margin:0">Nothing sent from this job yet.' + (btn ? " Use Email to write to the people above." : "") + "</p>");
    }
    // On-site details (2026-10-24): WiFi and "For the crew" (bookings.notes). All of it goes on the Google Calendar
    // event, and the WiFi is kept on the partner for next season. RPC job_onsite_save (migration 20261024152700).
    const canOnsite = () => J.can.bookings_edit && J.booking.status !== "cancelled";
    function renderOnsite(b, editing) {
      const box = el("jpOnsite"); if (!box) return;
      const has = b.wifi_network || b.wifi_password || b.notes;
      if (!has && !canOnsite()) { box.remove(); return; }
      const head = '<h3>On-site details' + (canOnsite() && !editing ? '<button type="button" class="small quiet" data-os="edit">' + (has ? "Edit" : "Add") + "</button>" : "") + "</h3>";
      if (editing) {
        box.innerHTML = head + '<form id="aca-jpOsForm"><label for="aca-jpOsNet">WiFi network</label><input type="text" id="aca-jpOsNet" maxlength="120" value="' + esc(b.wifi_network || "") + '" />' +
          '<label for="aca-jpOsPw">WiFi password</label><input type="text" id="aca-jpOsPw" maxlength="120" autocomplete="off" value="' + esc(b.wifi_password || "") + '" />' +
          '<label for="aca-jpOsNotes">For the crew</label><div><textarea id="aca-jpOsNotes" maxlength="4000" placeholder="Parking, who to ask for, door codes, timing">' + esc(b.notes || "") + "</textarea>" +
          '<div class="muted" style="font-size:12.5px;margin-top:3px">All of this goes on the calendar event. The WiFi is kept on the partner for next season.</div></div>' +
          '<div class="row"><button type="submit" class="small primary">Save</button><button type="button" class="small" data-os="cancel">Cancel</button></div></form>';
        el("jpOsNet").focus();
      } else if (!has) {
        box.innerHTML = head + '<p class="muted" style="margin:0;font-size:13px">No WiFi or crew notes yet. Schools often send their WiFi after booking; add it here and it goes on the calendar event.</p>';
      } else {
        const rows = [];
        if (b.wifi_network) rows.push("<dt>WiFi network</dt><dd>" + esc(b.wifi_network) + "</dd>");
        if (b.wifi_password) rows.push('<dt>WiFi password</dt><dd><span class="pw">' + esc(b.wifi_password) + '</span> <button type="button" class="link small" data-os="copy">Copy</button></dd>');
        if (b.notes) rows.push("<dt>For the crew</dt><dd>" + esc(b.notes) + "</dd>");
        box.innerHTML = head + '<dl class="jp-dl">' + rows.join("") + "</dl>" + (b.status === "booked" ? '<p class="oncal">On the Google Calendar event.</p>' : "");
      }
      box.onclick = async (e) => {
        const t = e.target.closest("[data-os]"); if (!t) return;
        if (t.dataset.os === "edit") renderOnsite(J.booking, true);
        if (t.dataset.os === "cancel") renderOnsite(J.booking);
        if (t.dataset.os === "copy") {
          try { await navigator.clipboard.writeText(b.wifi_password); toast("Password copied."); }
          catch (err) { const r = document.createRange(); r.selectNodeContents(box.querySelector(".pw")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("Selected. Copy it with your keyboard."); }
        }
      };
      const f = el("jpOsForm");
      if (f) f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector("[type=submit]"); btn.disabled = true;
        const p = { wifi_network: el("jpOsNet").value.trim(), wifi_password: el("jpOsPw").value.trim(), notes: el("jpOsNotes").value.trim() };
        const { data, error } = await sb.rpc("job_onsite_save", { p_booking: b.id, p });
        if (error) { btn.disabled = false; toast(cleanErr(error), true); return; }
        Object.assign(J.booking, { wifi_network: p.wifi_network || null, wifi_password: p.wifi_password || null, notes: p.notes || null });
        toast(data && data.calendar ? "Saved. The calendar event updates in a minute." : "Saved.");
        renderOnsite(J.booking);
      };
    }
    // The newest job notes at the top of Overview (two; one on a phone), with the same composer as the Notes tab.
    async function renderLatest(b) {
      const box = el("jpLatest"); if (!box) return;
      const { data } = await sb.rpc("job_notes_list", { p_booking: b.id });
      if (!el("jpLatest") || J.booking.id !== b.id || curTab !== "overview") return;
      const notes = (data || []).slice(-2).reverse();
      const n = num(J.notes_count);
      box.innerHTML = '<div class="hd"><h3>' + (notes.length ? "Latest notes" : "Job notes") + "</h3>" + (n > notes.length ? '<a href="' + jobLink(b.id, "notes") + '">All ' + n + " notes &#8250;</a>" : "") + "</div>" +
        (notes.length ? '<ul class="jp-notes">' + notes.map((x) => noteHtml(Object.assign({}, x, { mine: false, can_remove: false }))).join("") + "</ul>" : "") +
        '<div class="jp-compose"><textarea id="aca-jpNote" aria-label="New note" maxlength="4000" placeholder="Add a note. Type @ to mention someone."></textarea>' +
        '<div class="jp-suggest hidden" id="aca-jpSug"></div>' +
        '<div class="row"><span class="muted" id="aca-jpMent"></span><button type="button" class="small primary" id="aca-jpAdd">Add note</button></div></div>';
      loadPeople().then(() => { if (el("jpNote")) wireCompose(() => renderLatest(J.booking)); });
    }
    function dueTxt(day) {
      const d = T.daysBetween(T.today(), day);
      const s = T.fmtDay(day);
      return d < 0 ? '<span class="late">' + esc(s) + " (" + -d + " days late)</span>" : esc(s);
    }

    // ---------------------------------------------------------------- checklist
    function renderChecklist(b, box) {
      const tasks = J.tasks || [];
      box.innerHTML = '<div class="jp-sec"><h3>Checklist</h3>' + (tasks.length ? '<ul class="jp-rows">' + tasks.map((t) => '<li class="' + (t.done ? "done" : "") + '"><span class="t">' +
        esc(t.title) + (t.priority === "urgent" ? ' <span class="pill err">urgent</span>' : "") + '</span><span class="r">' + esc(t.who || "") + (t.due_on ? " \u00b7 " + (t.done ? esc(T.fmtDay(t.due_on)) : dueTxt(t.due_on)) : "") +
        (t.done ? " \u00b7 done" : "") + "</span></li>").join("") + "</ul>" : '<div class="empty">No checklist tasks on this job.</div>') +
        '<p class="muted" style="font-size:13px;margin:10px 0 0">People tick their own steps off on My day.' + (canSee("workflows") ? ' Change the steps in <a href="#system/jobtypes">Settings &rsaquo; Job types</a>.' : "") + "</p></div>";
    }

    // ---------------------------------------------------------------- results
    function renderResults(b, box) {
      const r = J.results;
      if (!b.gotphoto_job_id) { box.innerHTML = '<div class="empty">This job isn\u2019t linked to a GotPhoto job yet, so there are no sales to show.</div>'; return; }
      if (!r) { box.innerHTML = '<div class="empty">No sales recorded for this job yet.</div>'; return; }
      box.innerHTML = '<div class="jp-sec"><h3>Sales and payout</h3><dl class="jp-dl">' +
        "<dt>Sales</dt><dd>" + money(r.sales) + " from " + num(r.orders) + " orders</dd>" +
        "<dt>Partner share</dt><dd>" + (r.pct != null ? num(r.pct) + "% = " : "") + money(r.due) + "</dd>" +
        "<dt>Paid</dt><dd>" + money(r.paid) + "</dd><dt>Still owed</dt><dd>" + money(r.balance) + "</dd>" +
        (r.gallery_status ? "<dt>Gallery</dt><dd>" + esc(r.gallery_status) + "</dd>" : "") + "</dl>" +
        '<div class="jp-links"><a class="small" style="display:inline-block;padding:4px 9px;border:1px solid var(--border);border-radius:4px" href="#jobs/resjobs/job">All sales</a></div></div>';
    }

    // ---------------------------------------------------------------- notes
    async function loadPeople() {
      if (people) return people;
      const { data } = await sb.rpc("job_people", { p_booking: J.booking.id });
      people = data || [];
      return people;
    }
    function noteHtml(n) {
      // Escape first, then highlight "@Name" for the people actually mentioned.
      let body = esc(n.body);
      (n.mentions || []).map((m) => m.name).sort((a, b) => b.length - a.length).forEach((name) => {
        const e = esc("@" + name);
        body = body.split(e).join('<span class="at">' + e + "</span>");
      });
      return '<li data-n="' + num(n.id) + '"><div class="h"><b>' + esc(n.author_name || "Someone") + '</b><span class="muted" title="' + esc(new Date(n.created_at).toLocaleString()) + '">' +
        esc(fmtAgo(n.created_at)) + (n.edited_at ? " \u00b7 edited" : "") + '</span><span class="grow"></span>' +
        (n.mine ? '<button type="button" class="link small" data-e="edit">Edit</button>' : "") +
        (n.can_remove ? '<button type="button" class="link small" data-e="rm">Remove</button>' : "") +
        '</div><div class="b">' + body + "</div></li>";
    }
    async function renderNotes(b, box) {
      box.innerHTML = (b.notes ? '<div class="jp-booknote"><h4>For the crew (on the calendar)</h4><div>' + esc(b.notes) + "</div></div>" : "") +
        '<div class="jp-sec"><h3>Notes</h3><p class="muted" style="margin:0 0 10px;font-size:13px;max-width:760px">Anything the crew or the office should know about this job: parking, who to ask for, what went wrong last year. Type @ to mention someone; they get a notification.</p>' +
        '<ul class="jp-notes" id="aca-jpNotes"><li class="empty"><span class="spin"></span>Loading&#8230;</li></ul>' +
        '<div class="jp-compose"><textarea id="aca-jpNote" aria-label="New note" maxlength="4000" placeholder="Write a note. Type @ to mention someone."></textarea>' +
        '<div class="jp-suggest hidden" id="aca-jpSug"></div>' +
        '<div class="row"><span class="muted" id="aca-jpMent"></span><button type="button" class="primary" id="aca-jpAdd">Add note</button></div></div></div>';
      const [{ data, error }] = await Promise.all([sb.rpc("job_notes_list", { p_booking: b.id }), loadPeople()]);
      const list = el("jpNotes"); if (!list) return;
      if (error) { list.innerHTML = '<li class="inline-error">' + esc(cleanErr(error)) + "</li>"; return; }
      const notes = data || [];
      list.innerHTML = notes.length ? notes.map(noteHtml).join("") : '<li class="empty">No notes yet.</li>';
      list.onclick = (e) => onNoteAction(e, notes);
      wireCompose();
    }

    // The composer: "@" opens a list of people on this job; picking one inserts "@Name ".
    function wireCompose(after) {
      const ta = el("jpNote"), sug = el("jpSug");
      const picked = new Map(); // name -> user_id
      let cur = 0, matches = [];
      const mentioned = () => [...picked.entries()].filter(([name]) => ta.value.includes("@" + name)).map(([, id]) => id);
      const showMent = () => {
        const n = [...picked.keys()].filter((name) => ta.value.includes("@" + name));
        el("jpMent").textContent = n.length ? "Will notify " + n.join(", ") + "." : "";
      };
      function query() {
        const upto = ta.value.slice(0, ta.selectionStart);
        const m = /(^|\s)@([^\s@]{0,30})$/.exec(upto);
        return m ? m[2].toLowerCase() : null;
      }
      function update() {
        const q = query();
        if (q === null) { sug.classList.add("hidden"); showMent(); return; }
        matches = (people || []).filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q)).slice(0, 8);
        if (!matches.length) { sug.classList.add("hidden"); return; }
        cur = Math.min(cur, matches.length - 1);
        sug.innerHTML = matches.map((p, i) => '<button type="button" data-i="' + i + '" class="' + (i === cur ? "cur" : "") + '"><span>' + esc(p.name) + "</span>" +
          (p.crew ? '<span class="muted">on the crew</span>' : "") + "</button>").join("");
        sug.classList.remove("hidden");
        showMent();
      }
      function choose(i) {
        const p = matches[i]; if (!p) return;
        const pos = ta.selectionStart, before = ta.value.slice(0, pos).replace(/@([^\s@]{0,30})$/, "@" + p.name + " "), after = ta.value.slice(pos);
        ta.value = before + after; ta.selectionStart = ta.selectionEnd = before.length;
        picked.set(p.name, p.user_id);
        sug.classList.add("hidden"); ta.focus(); showMent();
      }
      ta.addEventListener("input", () => { cur = 0; update(); });
      ta.addEventListener("keydown", (e) => {
        if (sug.classList.contains("hidden")) {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el("jpAdd").click(); }
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); cur = (cur + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length; update(); }
        else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(cur); }
        else if (e.key === "Escape") { sug.classList.add("hidden"); }
      });
      sug.addEventListener("mousedown", (e) => { const b = e.target.closest("button[data-i]"); if (b) { e.preventDefault(); choose(+b.dataset.i); } });
      ta.addEventListener("blur", () => setTimeout(() => sug.classList.add("hidden"), 150));
      el("jpAdd").onclick = async () => {
        const body = ta.value.trim();
        if (!body) { toast("Write something first.", true); return; }
        const btn = el("jpAdd"); btn.disabled = true;
        const { data, error } = await sb.rpc("job_note_add", { p_booking: J.booking.id, p_body: body, p_mentions: mentioned() });
        btn.disabled = false;
        if (error || !data.ok) { toast(error ? cleanErr(error) : data.error, true); return; }
        const n = mentioned().length;
        toast(n ? "Added. " + n + (n === 1 ? " person was" : " people were") + " notified." : "Added.");
        J.notes_count = num(J.notes_count) + 1;
        refreshCounts();
        if (after) after(); else renderNotes(J.booking, el("jpBody"));
      };
    }
    async function onNoteAction(e, notes) {
      const b = e.target.closest("[data-e]"); if (!b) return;
      const li = b.closest("li[data-n]"); const n = notes.find((x) => String(x.id) === li.dataset.n); if (!n) return;
      if (b.dataset.e === "rm") {
        if (!confirm("Remove this note?")) return;
        const { data, error } = await sb.rpc("job_note_remove", { p_id: n.id });
        if (error || !data.ok) { toast(error ? cleanErr(error) : data.error, true); return; }
        toast("Removed."); J.notes_count = Math.max(0, num(J.notes_count) - 1); refreshCounts(); renderNotes(J.booking, el("jpBody"));
      }
      if (b.dataset.e === "edit") {
        const div = li.querySelector(".b");
        div.innerHTML = '<textarea style="width:100%;min-height:70px;padding:6px 10px;font:inherit" maxlength="4000"></textarea><div style="display:flex;gap:6px;margin-top:6px"><button type="button" class="small primary" data-s>Save</button><button type="button" class="small" data-c>Cancel</button></div>';
        const ta = div.querySelector("textarea"); ta.value = n.body; ta.focus();
        div.querySelector("[data-c]").onclick = () => renderNotes(J.booking, el("jpBody"));
        div.querySelector("[data-s]").onclick = async () => {
          const { data, error } = await sb.rpc("job_note_edit", { p_id: n.id, p_body: ta.value });
          if (error || !data.ok) { toast(error ? cleanErr(error) : data.error, true); return; }
          toast("Saved."); renderNotes(J.booking, el("jpBody"));
        };
      }
    }
    function refreshCounts() {
      const list = tabs();
      el("jpTabs").querySelectorAll("button[data-t]").forEach((btn) => {
        const t = list.find((x) => x.id === btn.dataset.t); if (!t || !t.count) return;
        const n = safe(() => t.count(J));
        let s = btn.querySelector(".n");
        if (!n) { if (s) s.remove(); return; }
        if (!s) { s = document.createElement("span"); s.className = "n"; btn.appendChild(s); }
        s.textContent = num(n);
      });
    }

    // ---------------------------------------------------------------- history
    async function renderHistory(b, box) {
      box.innerHTML = '<div class="jp-sec"><h3>History</h3><p class="muted" style="margin:0 0 10px;font-size:13px">Changes to this job, its days and its crew, and every stage move. Newest first.</p><div id="aca-jpHist"></div></div>';
      const ppl = await loadPeople();
      const names = {}; ppl.forEach((p) => { names[p.user_id] = p.name; }); (J.crew || []).forEach((p) => { names[p.user_id] = p.name; });
      HistoryView.render("job", b.id, el("jpHist"), names);
    }

    // ---------------------------------------------------------------- downloads
    function csvCell(v) { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    function saveCsv(name, rows) {
      const blob = new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\n")], { type: "text/csv" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    const fileBase = () => (J.booking.title || "job").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() + "-" + (J.booking.picture_day || "");
    function download(kind) {
      const b = J.booking;
      if (kind === "crew") {
        saveCsv(fileBase() + "-crew.csv", [["Name", "Day", "Start", "End", "Drive there (min)", "Note"]].concat((J.crew || []).map((p) =>
          [p.name, T.local(p.starts_at).day, timeOf(p.starts_at), timeOf(p.ends_at), num(p.drive_before_min), p.note || ""])));
        return;
      }
      if (kind === "tasks") {
        saveCsv(fileBase() + "-checklist.csv", [["Task", "Who", "Due", "Priority", "Done"]].concat((J.tasks || []).map((t) => [t.title, t.who, t.due_on || "", t.priority || "", t.done ? "yes" : "no"])));
        return;
      }
      // Job sheet: a plain page the browser can print or save as PDF.
      const row = (k, v) => (v ? "<tr><th>" + esc(k) + "</th><td>" + esc(v) + "</td></tr>" : "");
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(b.title) + "</title><style>" +
        "body{font:14px/1.45 -apple-system,Segoe UI,sans-serif;margin:32px;color:#1f1e1b}h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#a63f19;margin:22px 0 6px}" +
        "table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 10px 5px 0;border-bottom:1px solid #e6e2db;vertical-align:top}th{width:140px;color:#6b675f;font-weight:600}.s{color:#6b675f}</style></head><body>" +
        "<h1>" + esc(b.title) + '</h1><div class="s">' + esc(dayLine(b)) + "</div>" +
        "<h2>The job</h2><table>" + row("Where", b.location) + row("Type", b.type_label) + row("Organization", b.org_name + (b.org_town ? ", " + b.org_town : "")) +
        row("Retake day", b.retake_day ? fmtDayIso(b.retake_day) : "") + row("Access code", J.can.bookings ? b.access_code : "") + row("Stage", J.stage ? J.stage.label : "") + "</table>" +
        (b.wifi_network || b.wifi_password || b.notes ? "<h2>On site</h2><table>" + row("WiFi network", b.wifi_network) + row("WiFi password", b.wifi_password) + row("For the crew", b.notes) + "</table>" : "") +
        ((J.contacts || []).length ? "<h2>Contacts</h2><table>" + J.contacts.map((p) => "<tr><th>" + esc(p.name || "") + "</th><td>" + esc([p.role, p.email, p.phone].filter(Boolean).join(" \u00b7 ")) + "</td></tr>").join("") + "</table>" : "") +
        "<h2>Crew</h2><table>" + ((J.crew || []).map((p) => "<tr><th>" + esc(p.name) + "</th><td>" + esc(timeOf(p.starts_at) + "\u2013" + timeOf(p.ends_at) + (p.note ? " \u00b7 " + p.note : "")) + "</td></tr>").join("") || "<tr><td>Nobody yet</td></tr>") + "</table>" +
        ((J.tasks || []).length ? "<h2>Checklist</h2><table>" + J.tasks.map((t) => "<tr><th>" + (t.done ? "&#9745;" : "&#9744;") + " " + esc(t.due_on ? T.fmtDay(t.due_on) : "") + "</th><td>" + esc(t.title) + ' <span class="s">' + esc(t.who || "") + "</span></td></tr>").join("") + "</table>" : "") +
        "<script>window.onload=function(){window.print()}<\/script></body></html>";
      const w = window.open("", "_blank");
      if (!w) { toast("Allow pop-ups to open the job sheet.", true); return; }
      w.document.write(html); w.document.close();
    }

    return { show, reload, open: (id, tab) => { location.hash = jobLink(id, tab); } };
  })();
