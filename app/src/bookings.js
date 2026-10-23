  // ================================================================ JOBS: Bookings (replaces 17hats, 2026-10-11)
  // Book a job = one action: the booking row (source of truth), the Google Calendar event (edge fn calendar-write,
  // poked by the RPC), the admin email series (booking_emails, sent by edge fn booking-sender through Gmail) and,
  // for schools with an access code, the hub school row + reminder signups. Every write goes through an RPC.
  // Spec: docs/plans/2026-10-11-bookings-replace-17hats-design.md
  const Bookings = (function () {
  const sb = supabase;
  const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
  const TZ = "America/New_York";
  const CAL_ID = "c_6ebcc7d860d22ba4fce1c9209625b21373e17578ff0b35c2d62483e780ed11e8@group.calendar.google.com";

  const css = `
  .aca .bk-banner { margin: 0 16px 10px; padding: 9px 12px; border-radius: 8px; font-size: 13px; background: var(--warn-bg); color: var(--warn-fg); }
  .aca .bk-banner.test { background: var(--sel-bg); color: var(--accent); }
  .aca .bk-table td, .aca .bk-table th { padding: 10px 12px; font-size: 13px; vertical-align: top; }
  /* Fixed column widths: short columns sized to their content, Emails a share, Job takes the rest (2026-10-21) */
  .aca .bk-table { table-layout: fixed; min-width: 1000px; }
  .aca .bk-table th.bk-c-when { width: 140px; } .aca .bk-table th.bk-c-stage { width: 160px; } .aca .bk-table th.bk-c-who { width: 140px; }
  .aca .bk-table th.bk-c-mail { width: 22%; } .aca .bk-table th.bk-c-cal { width: 150px; }
  .aca .bk-table td.bk-c-when .bk-sub, .aca .bk-table td.bk-c-mail .bk-sub { white-space: nowrap; }
  .aca .bk-table td.bk-c-job strong { line-height: 1.35; }
  .aca .bk-table td.bk-c-who { overflow-wrap: anywhere; }
  .aca .bk-table td.bk-c-mail { line-height: 1.6; } .aca .bk-table td.bk-c-mail .pill { margin: 0 6px 0 4px; }
  .aca .bk-table td.bk-c-stage .pill + .bk-sub { margin-top: 2px; }
  .aca .bk-table tr.bk-row { cursor: pointer; }
  .aca .bk-table tr.bk-row:hover td { background: var(--surface-2); }
  .aca .bk-date { font-weight: 700; white-space: nowrap; }
  .aca .bk-sub { font-size: 12px; color: var(--muted); }
  .aca .bk-type { font-size: 12px; color: var(--muted); }
  .aca .bk-fold { padding: 8px 16px 14px; }
  .aca .bk-fold summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  .aca .bk-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .aca .bk-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
  .aca .bk-card input { position: absolute; opacity: 0; }
  .aca .bk-card.sel { border-color: var(--accent); background: var(--sel-bg); }
  .aca .bk-card strong { font-size: 13px; }
  .aca .bk-card span { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .aca .bk-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .aca .bk-chips button[aria-pressed="true"] { background: var(--sel-bg); border-color: var(--accent); color: var(--accent); }
  .aca .bk-orgs { border: 1px solid var(--border); border-radius: 8px; max-height: 200px; overflow: auto; margin-top: 6px; }
  .aca .bk-orgs button { display: block; width: 100%; text-align: left; border: none; border-bottom: 1px solid var(--border); border-radius: 0; background: var(--surface); padding: 8px 10px; white-space: normal; }
  .aca .bk-orgs button:last-child { border-bottom: none; }
  .aca .bk-orgpick { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .aca .bk-contacts label { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; font-size: 13px; }
  .aca .bk-contacts label.off { color: var(--muted); }
  .aca .bk-contacts input[type=checkbox] { margin-top: 3px; }
  .aca .bk-crew-dd { position: relative; display: inline-block; min-width: 240px; }
  .aca .bk-crew-dd summary { list-style: none; cursor: pointer; border: 1px solid var(--border); border-radius: 8px; padding: 7px 30px 7px 10px; background: var(--surface); font-size: 14px; position: relative; }
  .aca .bk-crew-dd summary::-webkit-details-marker { display: none; }
  .aca .bk-crew-dd summary::after { content: "\\25BE"; position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: var(--muted); }
  .aca .bk-crew-dd summary.none { color: var(--muted); }
  .aca .bk-crew-dd > .bk-contacts { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 4px); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 4px 10px; box-shadow: 0 6px 20px rgba(0,0,0,.12); max-height: 240px; overflow: auto; }
  .aca .bk-addc { display: grid; grid-template-columns: 1fr 1fr 1.4fr 1fr auto; gap: 6px; margin-top: 6px; }
  .aca .bk-addc input { width: 100%; }
  .aca .bk-preview { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 12.5px; margin-top: 12px; }
  .aca .bk-preview ul { margin: 6px 0 0 18px; padding: 0; }
  .aca .bk-preview.folded .bk-prevbody { display: none; }
  .aca .bk-preview.folded .bk-mailtog .sl-chev { transform: rotate(-45deg); margin-top: 0; }
  .aca .bk-sec { padding: 14px 16px; border-bottom: 1px solid var(--border); }
  .aca .bk-sec h3 { margin: 0 0 8px; font-size: 13px; }
  .aca .bk-mailtog { border: 0; background: transparent; height: auto; padding: 0; font: inherit; font-size: 13px; font-weight: 600; gap: 6px; }
  .aca .bk-mailsec.folded .bk-mailtog .sl-chev { transform: rotate(-45deg); margin-top: 0; }
  .aca .bk-mailsec.folded .bk-mailbody { display: none; }
  .aca .bk-gp { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
  .aca .bk-gp a.btn { text-decoration: none; font-size: 13px; font-weight: 600; border: 1px solid #d9d4cb; background: var(--surface); color: var(--text); border-radius: 4px; padding: 0 10px; height: 28px; display: inline-flex; align-items: center; white-space: nowrap; }
  .aca .bk-gp a.btn:hover { background: var(--surface-2); }
  .aca .bk-gp code { font: inherit; background: var(--sel-bg); padding: 1px 5px; border-radius: 3px; }
  .aca .bk-facts { display: grid; grid-template-columns: 110px 1fr; gap: 4px 12px; font-size: 13px; }
  .aca .bk-facts > span:nth-child(odd) { color: var(--muted); font-size: 12.5px; }
  .aca .bk-emails td { padding: 7px 8px; font-size: 12.5px; vertical-align: top; }
  .aca .bk-emails td.bk-act { white-space: nowrap; }
  .aca .bk-emails td.bk-act button { margin-left: 4px; }
  .aca .bk-mail { font-size: 14px; line-height: 1.55; max-width: 640px; }
  .aca .bk-mail p { margin: 0 0 12px; } .aca .bk-mail ul { margin: 0 0 12px 20px; padding: 0; } .aca .bk-mail blockquote { margin: 0 0 12px; padding: 8px 12px; border-left: 3px solid var(--accent); background: var(--surface-2); }
  .aca .bk-mail-head { color: var(--muted); font-size: 12.5px; margin-bottom: 12px; }
  .aca .bk-mail-head strong { color: var(--text); font-size: 15px; display: block; margin-top: 2px; }
  .aca .bk-step-list { font-size: 12.5px; color: var(--muted); margin: 4px 0 0; padding-left: 18px; }
  .aca .bk-fhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .aca .bk-fhead h2 { margin: 0 0 12px; }
  .aca .bk-fhead .bk-fx { display: none; margin-bottom: 12px; }
  /* Stages + deliverables (2026-10-21) */
  /* Stage stepper: one row of dots joined by a line, label under each, never wraps onto a second row */
  .aca .bk-stages { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); list-style: none; margin: 6px -4px 14px; padding: 0; }
  .aca .bk-stages li { position: relative; display: flex; justify-content: center; }
  .aca .bk-stages li + li::before { content: ""; position: absolute; top: 7px; left: calc(-50% + 9px); right: calc(50% + 9px); height: 2px; background: var(--border); }
  .aca .bk-stages li.done::before, .aca .bk-stages li.cur::before { background: var(--ok-fg); }
  .aca .bk-stages button { flex-direction: column; justify-content: flex-start; gap: 6px; height: auto; padding: 0 4px; border: 0; background: transparent; font-size: 12px; font-weight: 600; line-height: 1.25; color: var(--muted); text-align: center; white-space: normal; }
  .aca .bk-stages button::before { content: ""; width: 16px; height: 16px; box-sizing: border-box; border-radius: 50%; border: 2px solid var(--border); background: var(--surface); flex: 0 0 auto; }
  .aca .bk-stages button:hover:not(:disabled) { background: transparent; color: var(--text); }
  .aca .bk-stages button:hover:not(:disabled)::before { border-color: var(--accent); }
  .aca .bk-stages li.done button { color: var(--text); }
  .aca .bk-stages li.done button::before { background: var(--ok-fg); border-color: var(--ok-fg); }
  .aca .bk-stages li.cur button { color: var(--accent); font-weight: 700; }
  .aca .bk-stages li.cur button::before { border-color: var(--accent); background: var(--accent); box-shadow: 0 0 0 3px var(--sel-bg); }
  .aca .bk-stages button:disabled { opacity: 1; cursor: default; }
  .aca .bk-hist summary { cursor: pointer; font-size: 12.5px; color: var(--muted); margin-top: 6px; }
  .aca .bk-hist ul { margin: 6px 0 0; padding-left: 18px; font-size: 12.5px; }
  .aca .bk-dlv { list-style: none; margin: 0; padding: 0; }
  .aca .bk-dlv li { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .aca .bk-dlv li:last-child { border-bottom: none; }
  .aca .bk-dlv li > div { flex: 1; min-width: 0; }
  .aca .bk-dlv li input[type=checkbox] { margin-top: 3px; }
  .aca .bk-dlv li.closed strong { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--muted); }
  .aca .bk-dlvadd { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
  .aca .bk-dlvadd select, .aca .bk-dlvadd input[type=text] { flex: 1 1 200px; min-width: 0; }
  .aca .bk-jt-rows { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 10px; }
  .aca .bk-jt-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .aca .bk-jt-row input[type=text] { flex: 1 1 200px; min-width: 0; }
  .aca .bk-jt-row input[type=number] { width: 70px; }
  .aca .bk-jt h3 { margin: 14px 0 2px; font-size: 13px; }
  /* All jobs toolbar (2026-10-24): Book a job first, then "..." (Track a job), then a small Job types link */
  .aca .bk-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .aca .bk-more { position: relative; display: inline-block; }
  .aca .bk-menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 4px; min-width: 180px; box-shadow: 0 6px 20px rgba(0,0,0,.12); }
  .aca .bk-menu.hidden { display: none; }
  .aca .bk-menu button { display: block; width: 100%; text-align: left; border: 0; background: transparent; font-weight: 400; }
  .aca .bk-menu button:hover { background: var(--surface-2); }
  .aca .bk-chk { font-size: 12px; color: var(--muted); margin-top: 2px; } .aca .bk-chk .late { color: var(--err-fg); font-weight: 600; }
  /* Short preview on All jobs; everything else is on the job page */
  .aca .bk-pv .bk-facts { margin-top: 4px; }
  .aca .bk-pv-acts { display: flex; gap: 8px; flex-wrap: wrap; }
  .aca .bk-pv-acts a.primary { text-decoration: none; display: inline-flex; align-items: center; height: 32px; padding: 0 14px; border-radius: 4px; background: var(--accent); color: #fff; font-weight: 600; }
  /* Booking tab on the job page: the stage ladder folds to one line on phones */
  .aca .bk-stage1 { display: none; font-size: 13.5px; align-items: center; gap: 8px; flex-wrap: wrap; margin: 2px 0 8px; }
  .aca .bk-tab .bk-sec { padding-left: 0; padding-right: 0; }
  .aca .bk-tab .bk-sec:last-child { border-bottom: none; }
  .aca .bk-tab .og-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .aca .bk-move-note { margin-top: 6px; padding: 8px 10px; border-radius: 6px; background: var(--sel-bg); font-size: 12.5px; line-height: 1.5; }
  .aca .bk-move-note.hidden { display: none; }
  /* Book a job form: labels sit at the top of their row; the picture day row keeps date and times together */
  .aca .bk-form .og-grid { align-items: start; }
  .aca .bk-form .og-grid > label { padding-top: 8px; }
  .aca .bk-form .og-grid > label.bk-card { padding-top: 10px; }
  .aca .bk-form .bk-dayhead { display: flex; gap: 6px; font-size: 11.5px; color: var(--muted); margin: 0 0 2px; }
  .aca .bk-form .bk-dayhead span:first-child { width: 150px; } .aca .bk-form .bk-dayhead span.t { width: 108px; } .aca .bk-form .bk-dayhead span.to { width: 14px; }
  @media (max-width: 900px) {
    .aca #aca-bkPanel { position: fixed; top: var(--og-top, 0px); left: 0; right: 0; bottom: 0; width: 100vw; max-width: none; overflow: auto; -webkit-overflow-scrolling: touch; z-index: 60; background: var(--surface); }
    .aca #aca-bkPanel.hidden { display: none; }
    .aca #aca-bkPanel > :first-child { position: sticky; top: 0; z-index: 2; background: var(--surface); }
    .aca #aca-bkPanel .bk-pv-acts a, .aca #aca-bkPanel .bk-pv-acts button { min-height: 40px; }
  }
  @media (max-width: 760px) {
    .aca .og-modal-wrap:has(.bk-form) { padding: 0; align-items: stretch; }
    .aca .og-modal.bk-form { max-width: none; width: 100%; height: 100%; max-height: none; border-radius: 0; padding: 0 14px; overflow: auto; -webkit-overflow-scrolling: touch; }
    .aca .bk-form .bk-fhead { position: sticky; top: 0; z-index: 3; background: var(--surface); padding: 12px 0 0; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
    .aca .bk-form .bk-fhead h2 { margin: 0 0 12px; }
    .aca .bk-form .bk-fhead .bk-fx { display: inline-flex; align-items: center; justify-content: center; min-width: 40px; min-height: 40px; margin: 0 0 8px; }
    .aca .bk-form .bk-factions { position: sticky; bottom: 0; z-index: 3; background: var(--surface); border-top: 1px solid var(--border); margin: 12px -14px 0 !important; padding: 10px 14px; display: flex; gap: 8px; }
    .aca .bk-form input[type=text], .aca .bk-form input[type=date], .aca .bk-form input[type=time], .aca .bk-form input[type=email], .aca .bk-form textarea, .aca .bk-form select { font-size: 16px; min-height: 40px; }
    .aca .bk-form button.link, .aca .bk-form button.small { min-height: 40px; }
    .aca .bk-form .bk-dayrow { row-gap: 8px; }
    .aca .bk-form .bk-dayrow .dp-face { flex: 1 1 100%; min-width: 0; }
    .aca .bk-form .bk-dayrow .dp-tbox { flex: 1 1 0; min-width: 0; }
    .aca .bk-form .bk-dayrow .dp-tbox input.dp-time[type=text] { width: 100%; }
    .aca .bk-form .bk-dayrow .bk-d-label { flex: 1 1 100% !important; min-width: 0 !important; }
    .aca .bk-form #aca-bkCode { width: 100% !important; }
    .aca #aca-panel-bookings .card-head { flex-direction: column; align-items: stretch; gap: 10px; }
    .aca #aca-panel-bookings .card-head .bk-tools > button.primary { min-height: 44px; flex: 1 1 auto; }
    .aca #aca-panel-bookings .card-head .bk-tools #aca-bkMore { min-height: 44px; min-width: 48px; }
    .aca .bk-tab .bk-stages { display: none; } .aca .bk-tab .bk-stages.open { display: grid; }
    .aca .bk-tab .bk-stage1 { display: flex; }
    .aca .bk-tab .bk-stage-next { display: none; } .aca .bk-tab .bk-stages.open ~ .bk-stage-next { display: inline-flex; }
    .aca .bk-form .bk-dayhead { display: none; }
    .aca .bk-table thead { display: none; }
    .aca .bk-table, .aca .bk-table tbody { display: block; }
    .aca .bk-table tr.bk-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "when cal" "job job" "stage stage" "who who" "mail mail"; gap: 3px 8px; padding: 12px; border-bottom: 1px solid var(--border); }
    .aca .bk-table tr.bk-row > td { display: block; padding: 0; border: none; }
    .aca .bk-table td.bk-c-when { grid-area: when; } .aca .bk-table td.bk-c-cal { grid-area: cal; justify-self: end; }
    .aca .bk-table td.bk-c-job { grid-area: job; } .aca .bk-table td.bk-c-stage { grid-area: stage; } .aca .bk-table td.bk-c-who { grid-area: who; } .aca .bk-table td.bk-c-mail { grid-area: mail; }
    .aca .bk-stages { grid-auto-flow: row; grid-auto-columns: auto; margin: 6px 0 12px; }
    .aca .bk-stages li { justify-content: flex-start; }
    .aca .bk-stages li + li::before { top: -12px; left: 7px; right: auto; width: 2px; height: 24px; }
    .aca .bk-stages button { flex-direction: row; gap: 10px; min-height: 40px; padding: 0; text-align: left; font-size: 13px; }
    .aca .bk-table { min-width: 0; table-layout: auto; }
    .aca .bk-cards { grid-template-columns: 1fr; }
    .aca .bk-addc { grid-template-columns: 1fr 1fr; }
    .aca .bk-facts { grid-template-columns: 1fr; }
    .aca .bk-emails td.bk-act { white-space: normal; } .aca .bk-emails td.bk-act button { min-height: 40px; margin: 2px 4px 2px 0; }
  }`;
  const styleTag = document.createElement("style"); styleTag.textContent = css; document.head.appendChild(styleTag);

  const root = el("panel-bookings");
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div><h2>All jobs</h2>
          <p>Book a job once: the calendar event, the admin email series and (for schools) the hub row are created for you. Click a job for a quick look, then Open for its page: stage, deliverables, emails, crew and checklist.</p></div>
        <div class="og-actions bk-tools"><button type="button" class="small primary" id="aca-bkNew">+ Book a job</button>
          <span class="bk-more" id="aca-bkMoreWrap"><button type="button" class="small" id="aca-bkMore" aria-haspopup="true" aria-expanded="false" aria-label="More">&#8230;</button>
            <span class="bk-menu hidden" id="aca-bkMenu" role="menu"><button type="button" role="menuitem" id="aca-bkTrack">Track a job</button></span></span>
          <button type="button" class="link small" id="aca-bkJobTypes">Job types</button></div>
      </div>
      <div id="aca-bkBanner" class="bk-banner hidden"></div>
      <div class="toolbar">
        <input type="text" id="aca-bkSearch" placeholder="Search by organization&#8230;" aria-label="Search bookings" />
        <select id="aca-bkType" class="small" aria-label="Job type"><option value="">All types</option></select>
        <select id="aca-bkStage" class="small" aria-label="Stage"><option value="">Any stage</option><option value=":owed">Owes deliverables</option><option value=":overdue">Deliverables overdue</option></select>
        <div class="chips bk-chips" id="aca-bkScope" role="group">
          <button type="button" data-scope="upcoming" aria-pressed="true">Upcoming</button>
          <button type="button" data-scope="past" aria-pressed="false">Past 60 days</button>
          <button type="button" data-scope="owed" aria-pressed="false">Still owed</button>
          <button type="button" data-scope="cancelled" aria-pressed="false">Cancelled</button>
        </div>
      </div>
      <div id="aca-bkErr" class="inline-error hidden"></div>
      <div class="table-wrap"><table class="bk-table"><thead><tr><th class="bk-c-when">When</th><th class="bk-c-job">Job</th><th class="bk-c-stage">Stage</th><th class="bk-c-who">Contacts</th><th class="bk-c-mail">Emails</th><th class="bk-c-cal">Calendar</th></tr></thead>
        <tbody id="aca-bkBody"><tr><td colspan="6" class="empty">Loading&#8230;</td></tr></tbody></table></div>
    </div>
    <div class="og-panel hidden" id="aca-bkPanel" aria-label="Booking details"></div>`;

  let types = [], steps = [], rows = [], loaded = false, scope = "upcoming", openId = null, pollTimer = null, checklist = {};
  // Stages per job type and saved deliverables (2026-10-21; see supabase/migrations/20261021200000_booking_stages_deliverables.sql)
  let stagesAll = [], templates = [];
  const typeStages = (k) => stagesAll.filter((s) => s.type_key === k && !s.archived_at).sort((a, b) => a.sort - b.sort);
  const stageOf = (id) => stagesAll.find((s) => s.id === id);
  const typeTemplates = (k) => templates.filter((t) => !t.archived_at && (!t.type_key || t.type_key === k)).sort((a, b) => (a.type_key ? 0 : 1) - (b.type_key ? 0 : 1) || a.sort - b.sort || a.label.localeCompare(b.label));
  const STAGE_AUTO = { booked: "Ticks itself when the job is booked.", picture_day: "Ticks itself the morning after the last picture day.",
    gallery_live: "Ticks itself when the GotPhoto gallery goes live.", deliverables_done: "Ticks itself when every deliverable is done or skipped." };
  const byType = (k) => types.find((t) => t.key === k) || {};
  const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const fmtDay = (ymd, long) => { if (!ymd) return ""; const d = new Date(ymd + "T12:00:00Z"); return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: long ? "long" : "short", month: long ? "long" : "short", day: "numeric" }); };
  // GotPhoto "Create new job" screen, with the shoot date pre-filled (GotPhoto's own calendar passes shot_at the same way).
  const gpCreateUrl = (b) => "https://app.gotphoto.com/config_jobs/create?shot_at=" + encodeURIComponent(b.picture_day || "");
  // The job name the sync will match: it looks for the organization's name at the front, the rest is your usual pattern.
  const gpJobName = (b) => {
    const y = (b.picture_day || "").slice(0, 4), m = +((b.picture_day || "").slice(5, 7));
    const season = b.type_key === "school" && y ? (m >= 7 ? y + "-" + (+y + 1) : (+y - 1) + "-" + y) : y;
    return [b.org_name, b.title_label || b.type_label, season].filter(Boolean).join(" | ");
  };
  // A saved custom title splits back into the typed part and whether the organization was kept with it.
  // Reads both orders: "Org \u2022 typed" (now) and "typed \u2022 Org" (titles saved before the organization moved to the front).
  const ovParts = (d) => { const ov = (d && d.title_override || "").trim(); const org = d && d.org_name || ""; const head = org + " \u2022 ", tail = " \u2022 " + org;
    if (ov && org && ov.startsWith(head)) return { text: ov.slice(head.length), keep: true };
    if (ov && org && ov.endsWith(tail)) return { text: ov.slice(0, -tail.length), keep: true };
    return { text: ov, keep: !ov }; };
  const gpCreateBlock = (b) => '<div class="bk-gp"><a class="btn small" href="' + esc(gpCreateUrl(b)) + '" target="_blank" rel="noopener">Create the job in GotPhoto</a>' +
    '<span class="bk-sub">Name it <code>' + esc(gpJobName(b)) + '</code> <button type="button" class="link" data-v="copyname" data-name="' + esc(gpJobName(b)) + '">copy</button></span></div>';
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) : "";
  const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const hhmmToLabel = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; return ((h % 12) || 12) + ":" + String(m).padStart(2, "0") + " " + ap; };
  const gcalLink = (eventId) => eventId ? "https://calendar.google.com/calendar/event?eid=" + btoa(eventId + " " + CAL_ID).replace(/=+$/, "") : "";

  // ---- light Markdown -> HTML (same rules as functions/booking-sender/md.ts; display only)
  function mdInline(s) {
    const links = [];
    let t = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, txt, url) => { links.push('<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(txt) + "</a>"); return "\u0000" + (links.length - 1) + "\u0000"; });
    t = esc(t).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[\s(])((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|org|net|edu|us)(?:\/[^\s<]*)?)/gi, (m, pre, u) => {
      const trail = (u.match(/[.,;:!?)]+$/) || [""])[0]; const core = trail ? u.slice(0, -trail.length) : u;
      return pre + '<a href="' + (/^https?:\/\//i.test(core) ? core : "https://" + core) + '" target="_blank" rel="noopener">' + core + "</a>" + trail;
    });
    return t.replace(/\u0000(\d+)\u0000/g, (_m, i) => links[Number(i)]);
  }
  function mdToHtml(md) {
    return String(md || "").replace(/\r\n/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).map((b) => {
      const out = []; let list = [];
      const flush = () => { if (list.length) { out.push("<ul>" + list.map((l) => "<li>" + mdInline(l) + "</li>").join("") + "</ul>"); list = []; } };
      b.split("\n").forEach((l) => { if (/^- /.test(l)) list.push(l.slice(2)); else if (/^> ?/.test(l)) { flush(); out.push("<blockquote>" + mdInline(l.replace(/^> ?/, "")) + "</blockquote>"); } else { flush(); out.push("<p>" + mdInline(l) + "</p>"); } });
      flush(); return out.join("");
    }).join("");
  }
  // {{key|fallback}} filler for client-side previews (the server uses prospect_render; same rules)
  function fill(tpl, vars) {
    return String(tpl || "").replace(/\{\{([^{}|]+)(?:\|([^{}]*))?\}\}/g, (_m, k, fb) => { const v = (vars[k.trim()] || "").trim(); return v || (fb || ""); });
  }

  // ---- data
  async function ensureMeta() {
    if (types.length) return;
    const [t, s, q] = await Promise.all([
      sb.from("booking_types").select("*").order("sort_order"),
      sb.from("booking_steps").select("*").eq("is_active", true).order("step_no"),
      sb.from("booking_sequences").select("id, type_key, is_active").eq("is_active", true), loadTracking()]);
    if (t.error) throw t.error;
    types = t.data || [];
    const active = new Set((q.data || []).map((x) => x.id));
    steps = (s.data || []).filter((x) => active.has(x.sequence_id));
    seqType = {}; (q.data || []).forEach((x) => { seqType[x.id] = x.type_key; }); // the form's schedule preview needs this too
    const sel = el("bkType"); sel.innerHTML = '<option value="">All types</option>' + types.map((x) => '<option value="' + esc(x.key) + '">' + esc(x.label) + "</option>").join("");
  }
  // Stages and saved deliverables change in the Stages & deliverables dialog and when a typed deliverable is saved.
  async function loadTracking() {
    const [st, tp] = await Promise.all([sb.from("booking_stages").select("*").order("sort"), sb.from("deliverable_templates").select("*").is("archived_at", null).order("sort")]);
    stagesAll = st.data || []; templates = tp.data || [];
    const sel = el("bkStage"), cur = sel.value, seen = new Set();
    const labels = stagesAll.filter((x) => !x.archived_at).sort((a, b) => a.sort - b.sort).map((x) => x.label).filter((l) => !seen.has(l) && seen.add(l));
    sel.innerHTML = '<option value="">Any stage</option>' + labels.map((l) => '<option value="' + esc(l) + '">' + esc(l) + "</option>").join("") +
      '<option value=":owed">Owes deliverables</option><option value=":overdue">Deliverables overdue</option>' +
      (canSee("workflows") ? '<option value=":checklist">Checklist steps to do</option><option value=":checklate">Checklist steps late</option>' : "");
    sel.value = cur;
  }
  let seqType = {}; // sequence id -> type key
  const seqOf = (id) => seqType[id];

  async function load(force) {
    el("bkMoreWrap").classList.toggle("hidden", !canEdit("bookings"));
    if (loaded && !force && currentTabIs()) { render(); return; }
    clearError("bkErr");
    try {
      await ensureMeta();
      const { data: seqs } = await sb.from("booking_sequences").select("id, type_key");
      seqType = {}; (seqs || []).forEach((q) => { seqType[q.id] = q.type_key; });
      const today = todayStr();
      const from = scope === "upcoming" ? today : addDays(today, scope === "owed" ? -400 : -60);
      const to = scope === "upcoming" ? null : (scope === "past" ? addDays(today, -1) : null);
      // Checklist steps per job (Job checklists, 2026-10-24): "2 to do, 1 late" under the stage.
      const none = Promise.resolve({ data: [] });
      const [{ data, error }, prog, wf] = await Promise.all([sb.rpc("admin_bookings", { p_from: from, p_to: to }), sb.rpc("admin_booking_progress", { p_from: from, p_to: to }),
        canSee("workflows") ? sb.rpc("workflow_jobs", { p_from: from }).then((r) => r, () => ({ data: [] })) : none]);
      if (error) throw error;
      const pm = {}; (prog.data || []).forEach((x) => { pm[x.booking_id] = x; });
      checklist = {}; (Array.isArray(wf.data) ? wf.data : []).forEach((x) => { checklist[x.booking_id] = x; });
      rows = (data || []).map((b) => Object.assign(b, { progress: pm[b.id] || null }));
      loaded = true;
      render();
      // Old links (emails, notifications, bookmarks) to #jobs/bookings/<id> open the job page's Booking tab.
      const seg = location.hash.replace(/^#/, "").split("/");
      if (seg[0] === "jobs" && seg[1] === "bookings" && seg[2]) openJob(seg[2], "booking", true);
    } catch (e) { showError("bkErr", cleanErr(e)); el("bkBody").innerHTML = '<tr><td colspan="6" class="empty">Could not load bookings.</td></tr>'; }
  }
  const currentTabIs = () => el("panel-bookings").classList.contains("active");

  // "Mon, Oct 20" or "Mon, Oct 20 to Tue, Oct 21"
  function whenRange(b) {
    const ds = (b.days || []).map((x) => x.day).filter(Boolean);
    if (ds.length < 2) return fmtDay(b.picture_day);
    return fmtDay(ds[0]) + " to " + fmtDay(ds[ds.length - 1]);
  }
  function dayTimes(b, x) {
    const has = x.sort === 0 ? b.time_set !== false : !!x.start_at;
    const hasEnd = x.sort === 0 ? b.end_set !== false : !!x.end_at;
    if (!has) return "time not set";
    return fmtTime(x.start_at) + (hasEnd ? " to " + fmtTime(x.end_at) : "");
  }
  function daysLine(b) {
    const ds = (b.days || []);
    if (ds.length < 2) return esc(fmtDay(b.picture_day, true)) + ", " + esc(b.time_set === false ? "time not set" : fmtTime(b.start_at) + (b.end_set === false ? "" : " to " + fmtTime(b.end_at)));
    return ds.map((x) => esc(fmtDay(x.day)) + " " + esc(dayTimes(b, x)) + (x.label ? " (" + esc(x.label) + ")" : "")).join("; ");
  }
  function calPill(b) {
    if (b.status === "tracked") return '<span class="pill muted">No calendar event</span>';
    const m = { pending: ["muted", "Calendar: writing\u2026"], synced: ["ok", "On calendar"], error: ["err", "Calendar error"], moved: ["warn", "Moved in Google"], missing: ["err", "Missing in Google"], deleted: ["muted", "Removed"] };
    const [cls, txt] = m[b.calendar_status] || ["muted", b.calendar_status];
    return '<span class="pill ' + cls + '">' + esc(txt) + "</span>";
  }
  function mailSummary(b) {
    if (b.status === "cancelled") return '<span class="pill muted">Cancelled</span>';
    if (b.status === "tracked") return '<span class="pill muted">Tracking only, no emails</span>';
    const parts = [num(b.emails_sent) + " of " + num(b.emails_total) + " sent"];
    if (num(b.emails_failed)) parts.push('<span class="pill err">' + num(b.emails_failed) + " failed</span>");
    if (num(b.emails_waiting_time)) parts.push('<span class="pill warn">waiting for the time</span>');
    if (num(b.emails_waiting_coaches)) parts.push('<span class="pill muted">waiting for coaches</span>');
    if (num(b.emails_waiting_gallery)) parts.push('<span class="pill muted">waiting for the gallery</span>');
    if (num(b.emails_waiting) - num(b.emails_waiting_time) - num(b.emails_waiting_coaches) - num(b.emails_waiting_gallery) > 0) parts.push('<span class="pill warn">' + (b.audience === "school" ? "needs access code" : "needs GotPhoto job") + "</span>");
    if (b.next_send_at) parts.push('<span class="bk-sub">next ' + esc(fmtWhen(b.next_send_at)) + "</span>");
    return parts.join(" ");
  }
  // Stage pill + "2 of 3 delivered" for the list.
  function stageCell(b) {
    if (b.status === "cancelled") return "";
    const p = b.progress || {}, s = stageOf(p.stage_id), list = typeStages(b.type_key);
    const last = list.length && s && s.id === list[list.length - 1].id;
    const out = [s ? '<span class="pill ' + (last ? "ok" : "accent") + '">' + esc(s.label) + "</span>" : '<span class="pill muted">No stage</span>'];
    if (num(p.deliverables_total)) {
      const done = num(p.deliverables_total) - num(p.deliverables_open);
      out.push('<div class="bk-sub">' + done + " of " + num(p.deliverables_total) + " delivered" + (num(p.overdue) ? ' <span class="pill err">' + num(p.overdue) + " overdue</span>" : num(p.deliverables_open) && p.next_due ? ", next due " + esc(fmtDay(p.next_due)) : "") + "</div>");
    }
    out.push(checklistChip(b));
    return out.join("");
  }
  // "Checklist: 2 to do, 1 late" (Job checklists live here now, 2026-10-24).
  function checklistChip(b) {
    const c = checklist[b.id]; if (!c || !c.tasks || !c.tasks.length) return "";
    const open = num(c.open_count), late = num(c.overdue_count);
    return '<div class="bk-chk">Checklist: ' + (open ? open + " to do" + (late ? ', <span class="late">' + late + " late</span>" : "") : "all done") + "</div>";
  }
  function render() {
    const q = el("bkSearch").value.trim().toLowerCase(), tk = el("bkType").value;
    let list = rows.filter((b) => (scope === "cancelled" ? b.status === "cancelled" : b.status !== "cancelled"));
    if (tk) list = list.filter((b) => b.type_key === tk);
    const sk = el("bkStage").value, prog = (b) => b.progress || {};
    if (scope === "owed") list = list.filter((b) => num(prog(b).deliverables_open) > 0);
    if (sk === ":owed") list = list.filter((b) => num(prog(b).deliverables_open) > 0);
    else if (sk === ":overdue") list = list.filter((b) => num(prog(b).overdue) > 0);
    else if (sk === ":checklist") list = list.filter((b) => checklist[b.id] && num(checklist[b.id].open_count) > 0);
    else if (sk === ":checklate") list = list.filter((b) => checklist[b.id] && num(checklist[b.id].overdue_count) > 0);
    else if (sk) list = list.filter((b) => (stageOf(prog(b).stage_id) || {}).label === sk);
    if (q) list = list.filter((b) => (b.org_name + " " + b.title + " " + (b.org_town || "")).toLowerCase().includes(q));
    const body = el("bkBody");
    if (!list.length) { body.innerHTML = '<tr><td colspan="6" class="empty">' + (scope === "upcoming" && !sk ? "No upcoming bookings. Click <strong>Book a job</strong> to add one." : scope === "owed" ? "Nothing owed. Every deliverable is done or skipped." : "Nothing here.") + "</td></tr>"; return; }
    body.innerHTML = list.map((b) => '<tr class="bk-row" data-id="' + esc(b.id) + '">' +
      '<td class="bk-c-when"><div class="bk-date">' + esc(whenRange(b)) + '</div><div class="bk-sub">' + (b.time_set === false ? '<span class="pill warn">time not set</span>' : esc(fmtTime(b.start_at)) + (b.end_set === false ? "" : " to " + esc(fmtTime(b.end_at)))) + "</div></td>" +
      '<td class="bk-c-job"><div><strong>' + esc(b.title) + '</strong></div><div class="bk-type">' + esc(b.type_label) + (b.location ? " \u00b7 " + esc(b.location) : "") + "</div></td>" +
      '<td class="bk-c-stage">' + stageCell(b) + "</td>" +
      '<td class="bk-c-who">' + ((b.contacts || []).map((c) => esc(c.name || c.email)).join(", ") || (b.status === "tracked" ? '<span class="bk-sub">&mdash;</span>' : '<span class="pill err">no contact</span>')) + "</td>" +
      '<td class="bk-c-mail">' + mailSummary(b) + "</td>" +
      '<td class="bk-c-cal">' + calPill(b) + "</td></tr>").join("");
  }
  el("bkSearch").addEventListener("input", render);
  el("bkType").addEventListener("change", render);
  el("bkStage").addEventListener("change", render);
  el("bkScope").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-scope]"); if (!b) return;
    scope = b.dataset.scope;
    el("bkScope").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    load(true);
  });
  el("bkBody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) openDetail(tr.dataset.id); });

  // ---- attention (Today + Jobs badge)
  registerAttention("bookingDeliverablesOverdue", { module: "bookings", level: "warn", name: "overdue deliverables",
    one: "A deliverable is past its due date.", many: "{n} deliverables are past their due date." });
  const showOwed = (filter) => { scope = "owed"; el("bkScope").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.scope === "owed" ? "true" : "false")); el("bkStage").value = filter || ""; load(true); };
  // The bookings behind each Today count, read from the list's own fields (admin_bookings, a month back for failed
  // emails). Today names them only when they match the server's count exactly, so a mismatch falls back to one count line.
  async function attentionJobs() {
    const out = {};
    try {
      const ymd = (d) => d.toLocaleDateString("en-CA", { timeZone: TZ });
      const today = ymd(new Date()), in7 = ymd(new Date(Date.now() + 7 * 864e5)), in21 = ymd(new Date(Date.now() + 21 * 864e5));
      const { data } = await sb.rpc("admin_bookings", { p_from: ymd(new Date(Date.now() - 30 * 864e5)), p_to: null });
      const add = (k, b) => (out[k] = out[k] || []).push({ id: b.id, title: b.org_name ? b.org_name + (b.title_label ? " · " + b.title_label : "") : b.title, day: b.picture_day });
      (data || []).filter((b) => b.status === "booked").forEach((b) => {
        const day = String(b.picture_day || ""), ahead = day >= today;
        const rest = num(b.emails_waiting) - num(b.emails_waiting_time) - num(b.emails_waiting_coaches) - num(b.emails_waiting_gallery);
        if (num(b.emails_failed)) add("bookingFailed", b);
        if (!ahead) return;
        if (!(b.contacts || []).length) add("bookingNoContact", b);
        if (["moved", "missing", "error"].includes(b.calendar_status)) add("bookingCalendar", b);
        if (b.time_set === false) add(day <= in21 ? "bookingNeedsTime" : "bookingNeedsTimeLater", b);
        if (rest > 0) add(b.audience === "school" ? "bookingNeedsCode" : "bookingNeedsJob", b);
        if (num(b.emails_waiting_coaches) && day <= in7) add("bookingNeedsCoaches", b);
      });
    } catch (_e) { /* the count lines still show */ }
    return out;
  }
  async function loadAttention() {
    sb.rpc("admin_deliverables_attention").then(({ data }) => {
      setAttention("bookingDeliverablesOverdue", num((data || {}).overdue), "deliverable(s) overdue", "bookings", "warn", () => showOwed(":overdue"));
    }, () => {});
    try {
      const [{ data, error }, J] = await Promise.all([sb.rpc("admin_bookings_attention"), attentionJobs()]);
      if (error) throw error;
      const a = data || {};
      const up = () => { scope = "upcoming"; load(true); };
      // Each line on Today names its job and opens it (shell stream, 2026-10-24): J[key] are the bookings behind each count.
      setAttention("bookingFailed", num(a.send_failed), "booking email(s) failed to send", "bookings", "err", up, J.bookingFailed);
      setAttention("bookingCalendar", num(a.calendar), "booking(s) out of step with Google Calendar", "bookings", "warn", up, J.bookingCalendar);
      setAttention("bookingNeedsCode", num(a.needs_code), "school booking(s) waiting for an access code", "bookings", "warn", up, J.bookingNeedsCode);
      setAttention("bookingNeedsJob", num(a.needs_job), "sports booking(s) waiting for the GotPhoto job", "bookings", "warn", up, J.bookingNeedsJob);
      setAttention("bookingNeedsCoaches", num(a.needs_coaches), "sports booking(s) a week out with no coach emails", "bookings", "soon", up, J.bookingNeedsCoaches);
      setAttention("bookingNoContact", num(a.no_contact), "booking(s) with nobody to email", "bookings", "err", up, J.bookingNoContact);
      setAttention("bookingNeedsTime", num(a.needs_time), "booking(s) need their start and end time", "bookings", "warn", up, J.bookingNeedsTime);
      setAttention("bookingNeedsTimeLater", num(a.needs_time_later), "booking(s) without a time yet", "bookings", "soon", up, J.bookingNeedsTimeLater);
      const ban = el("bkBanner");
      if (a.sending_enabled === false) { ban.className = "bk-banner"; ban.innerHTML = '<strong>Booking emails are off.</strong> They are scheduled and waiting: nothing goes out until you switch Booking emails on in <a href="#system/sending">Settings &rsaquo; Sending</a>.'; }
      else if (a.test_mode) { ban.className = "bk-banner test"; ban.innerHTML = "<strong>Test mode.</strong> Every booking email goes to the test address with a [TEST] subject."; }
      else ban.className = "bk-banner hidden";
    } catch (_e) { /* badge stays unknown; the tab shows its own error */ }
  }

  // ---- dialogs
  function dialog(html, wide) {
    const wrap = document.createElement("div");
    wrap.className = "og-modal-wrap";
    wrap.innerHTML = '<div class="og-modal' + (wide ? " wide" : "") + '" role="dialog" aria-modal="true">' + html + "</div>";
    const box = wrap.firstElementChild;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const close = () => { document.removeEventListener("keydown", onKey); wrap.remove(); };
    box.close = close;
    document.addEventListener("keydown", onKey);
    document.querySelector(".aca").appendChild(wrap);
    Orgs.measureTop();
    return box;
  }

  // "2026-11-05 09:00-11:00|..." to compare picture days before and after an edit (days only with onlyDays).
  const dayKey = (ds, onlyDays) => (ds || []).map((x) => x.day + (onlyDays ? "" : " " + (x.start_time || "") + "-" + (x.end_time || ""))).sort().join("|");
  const shortNm = (n) => { const w = String(n || "").trim().split(/\s+/); return w.length > 1 ? w[0] + " " + w[w.length - 1][0] + "." : w[0] || ""; };
  // Take people off a job: their bars for it on the Schedule (around the old and the new days) come off.
  async function takeOff(id, uids, days, oldDays) {
    const all = days.concat(oldDays || []).map((x) => x.day).filter(Boolean).sort();
    const from = all[0], to = all[all.length - 1];
    const span = Math.min(42, Math.round((new Date(to + "T12:00:00Z") - new Date(from + "T12:00:00Z")) / 864e5) + 1);
    const { data: w, error } = await sb.rpc("schedule_week", { p_start: from, p_days: span });
    if (error) throw error;
    const ids = ((w && w.entries) || []).filter((e) => e.booking_id === id && e.kind === "job" && uids.includes(e.user_id)).map((e) => e.id);
    for (const eid of ids) { const { error: e2 } = await sb.rpc("schedule_remove", { p_id: eid }); if (e2) throw e2; }
    return ids.length;
  }

  // ---- Book a job / Edit booking
  // presetOrg ({ id, name, town }): Book a job from an organization's page starts with it picked (2026-10-23).
  async function openForm(existing, presetOrg) {
    try { await ensureMeta(); } catch (e) { toast(cleanErr(e), true); return; }
    const isNew = !existing;
    const d = existing || {};
    let org = isNew ? null : { id: d.org_id, name: d.org_name, town: d.org_town };
    let contacts = isNew ? [] : (d.org_contacts || []);
    let typeKey = d.type_key || (types[0] && types[0].key) || "", typeTouched = !isNew;
    const chosen = new Set(isNew ? [] : (d.contact_ids || []));
    // The organization link opens its page in this tab; the form closes (it can be reopened there).
    const orgLinkHtml = (o) => '<a href="#partners/org/' + esc(o.id) + '" class="bk-sub" data-v="orglink">open organization</a>';
    const canCrew = canEdit("scheduling") && typeof Schedule !== "undefined";
    const box = dialog(`
      <div class="bk-fhead"><h2>${isNew ? "Book a job" : "Edit booking"}</h2><button type="button" class="bk-fx" data-v="close" aria-label="Close">\u2715</button></div>
      <div class="og-grid">
        <label>Organization</label>
        <div>
          <div class="bk-orgpick" id="aca-bkOrgPick">${org ? '<strong>' + esc(org.name) + '</strong> ' + orgLinkHtml(org) + (isNew ? ' <button type="button" class="link" data-v="changeorg">change</button>' : "") : '<input type="text" id="aca-bkOrgQ" placeholder="Type the league or school name" autocomplete="off" style="width:100%" />'}</div>
          <div class="bk-orgs hidden" id="aca-bkOrgList"></div>
        </div>
        <label>Job type${isNew ? "" : ' <span class="bk-sub">(fixed once booked)</span>'}</label>
        <div class="bk-cards" id="aca-bkTypes">${types.map((t) => '<label class="bk-card' + (t.key === typeKey ? " sel" : "") + (isNew || t.key === typeKey ? "" : " hidden") + '"><input type="radio" name="bkType" value="' + esc(t.key) + '"' + (t.key === typeKey ? " checked" : "") + (isNew ? "" : " disabled") + ' /><strong>' + esc(t.label) + "</strong><span>" + esc(t.description) + "</span></label>").join("")}</div>
        <label>Picture day${(d.days || []).length > 1 ? "s" : ""}</label>
        <div><div class="bk-dayhead" aria-hidden="true"><span>Day</span><span class="t">Start</span><span class="to"></span><span class="t">End</span><span>Label</span></div><div id="aca-bkDays"></div>
          <button type="button" class="link" data-v="addday" style="margin-top:6px">+ Add another day</button>
          <div class="bk-sub" style="margin-top:4px">Times can wait: emails that mention one hold until it is set. Label a day only when each day is a different group.</div>
          <div class="bk-move-note hidden" id="aca-bkMoveNote" role="status"></div></div>
        <label>Calendar title</label>
        <div><div class="bk-chips" id="aca-bkLabels"></div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px"><input type="text" id="aca-bkTitle" placeholder="Or type your own, e.g. Football" value="${esc(ovParts(d).text)}" style="flex:1;min-width:200px" />
            <label class="bk-sub" style="display:inline-flex;gap:6px;align-items:center;white-space:nowrap"><input type="checkbox" id="aca-bkKeepOrg" ${ovParts(d).keep ? "checked" : ""} /> keep the organization before it</label></div>
          <div class="bk-sub" id="aca-bkTitlePrev" style="margin-top:6px"></div>
          <div id="aca-bkGp"></div></div>
        <label for="aca-bkLoc">Location</label>
        <div class="bk-loc"><input type="text" id="aca-bkLoc" value="${esc(d.location || "")}" placeholder="Search Google Maps or type where we set up" style="width:100%" />
          <div class="bk-sub" id="aca-bkLocNote" style="margin-top:4px"></div></div>
        ${canCrew && d.status !== "tracked" ? `<label>Who's shooting</label>
        <div><details class="bk-crew-dd" id="aca-bkCrewDd"><summary id="aca-bkCrewSum">Nobody yet</summary><div class="bk-contacts" id="aca-bkCrew"><span class="bk-sub">Loading the team&#8230;</span></div></details>
          <div class="bk-sub">${isNew ? "Optional. They go on the Schedule for each day with a time (with drive time when it can be looked up)." : "Tick to add someone to every day with a time; untick to take them off this job. Change one person's times on the Schedule."}</div></div>` : ""}
        <label>Who gets the emails</label>
        <div><div class="bk-contacts" id="aca-bkContacts"><span class="bk-sub">Pick an organization first.</span></div>
          <div class="bk-addc hidden" id="aca-bkAddC"><input type="text" id="aca-bkCFirst" placeholder="First" /><input type="text" id="aca-bkCLast" placeholder="Last" /><input type="email" id="aca-bkCEmail" placeholder="email@school.org" /><input type="text" id="aca-bkCRole" placeholder="Role (AD, secretary)" /><button type="button" class="small" data-v="addc">Add</button></div>
          <button type="button" class="link hidden" id="aca-bkAddCBtn" data-v="showaddc">+ Add a contact</button></div>
        <label for="aca-bkCode" class="bk-school">Access code</label>
        <span class="bk-school"><input type="text" id="aca-bkCode" value="${esc(d.access_code || "")}" placeholder="GotPhoto registration code" style="width:180px" /> <span class="bk-sub">Creates the school on 207photo.com/schooladmin. Create the job in GotPhoto (link above), then put its code here. Leave empty for now and email 0 waits for it.</span></span>
        <label for="aca-bkRetake" class="bk-school">Retake day</label><span class="bk-school"><input type="date" id="aca-bkRetake" value="${esc(d.retake_day || "")}" /> <span class="bk-sub">optional</span></span>
        ${DirectorFields.formHtml()}
        <label for="aca-bkNotes">Notes</label><textarea id="aca-bkNotes" rows="2" placeholder="Internal notes (also on the calendar event)">${esc(d.notes || "")}</textarea>
        ${isNew ? `<label>Deliverables</label>
        <div><div class="bk-contacts" id="aca-bkFDlv"></div>
          <div class="bk-dlvadd"><input type="text" id="aca-bkFDlvNew" maxlength="120" placeholder="Add one, e.g. Team composites" /><button type="button" class="small" data-v="fdlvadd">Add</button></div>
          <label class="bk-sub" style="display:inline-flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="aca-bkFDlvSave" checked /> <span id="aca-bkFDlvSaveL">Save new ones for future jobs of this type</span></label>
          <div class="bk-sub">What you owe the client after the job. Optional: you can add these on the booking later.</div></div>` : ""}
      </div>
      <div class="bk-preview" id="aca-bkPrev"></div>
      <div id="aca-bkFormErr" class="inline-error hidden" style="margin:10px 0 0"></div>
      <div class="og-actions bk-factions" style="margin-top:12px"><button type="button" class="primary" data-v="save">${isNew ? "Book it" : "Save changes"}</button><button type="button" data-v="close">Cancel</button></div>`, true);
    box.classList.add("bk-form");
    if (!isNew) DirectorFields.fill(d.id); // team times, order dates, picture day page link (director.js)

    const err = (m) => { el("bkFormErr").textContent = m; el("bkFormErr").classList.remove("hidden"); };
    // One or more days. Day rows come from the booking's days (edit) or one blank row (new). Times optional.
    const hhmmOf = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }) : "");
    const dayRows = isNew ? [{ day: "", start_time: "", end_time: "", label: "" }]
      : ((d.days || []).length ? d.days : [{ day: d.picture_day, start_at: d.start_at, end_at: d.end_at, sort: 0 }]).map((x) => ({
          day: x.day, start_time: (x.sort === 0 ? d.time_set !== false : !!x.start_at) ? hhmmOf(x.start_at) : "",
          end_time: (x.sort === 0 ? d.end_set !== false : !!x.end_at) ? hhmmOf(x.end_at) : "", label: x.label || "" }));
    function renderDays() {
      el("bkDays").innerHTML = dayRows.map((r, i) => '<div class="bk-dayrow" data-i="' + i + '" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px">' +
        '<input type="date" class="bk-d-day" value="' + esc(r.day || "") + '" aria-label="Day ' + (i + 1) + '" /> ' +
        '<input type="time" class="bk-d-start" value="' + esc(r.start_time || "") + '" step="300" aria-label="Start" /> <span class="bk-sub">to</span> ' +
        '<input type="time" class="bk-d-end" value="' + esc(r.end_time || "") + '" step="300" aria-label="End" data-dp-after=".bk-d-start" /> ' +
        '<input type="text" class="bk-d-label" value="' + esc(r.label || "") + '" placeholder="' + (dayRows.length > 1 ? "Which teams this day" : "Label (optional)") + '" maxlength="60" style="flex:1 1 160px;min-width:120px" />' +
        (dayRows.length > 1 ? '<button type="button" class="small quiet" data-v="rmday" data-i="' + i + '" aria-label="Remove day ' + (i + 1) + '">&times;</button>' : "") + "</div>").join("");
    }
    function readDays() {
      const out = [];
      el("bkDays").querySelectorAll(".bk-dayrow").forEach((row, i) => {
        const r = { day: row.querySelector(".bk-d-day").value, start_time: row.querySelector(".bk-d-start").value, end_time: row.querySelector(".bk-d-end").value, label: row.querySelector(".bk-d-label").value.trim() };
        dayRows[i] = r; if (r.day) out.push(r);
      });
      return out.sort((a, b2) => a.day.localeCompare(b2.day));
    }
    const firstDay = () => { const ds = readDays(); return ds.length ? ds[0].day : ""; };
    const isSchool = () => byType(typeKey).audience === "school";
    function renderLabels() {
      const labels = byType(typeKey).title_labels || [];
      const cur = d.title_label && labels.includes(d.title_label) ? d.title_label : (labels[0] || "");
      el("bkLabels").innerHTML = labels.map((l) => '<button type="button" class="small" data-label="' + esc(l) + '" aria-pressed="' + (l === cur ? "true" : "false") + '">' + esc(l) + "</button>").join("");
      box.querySelectorAll(".bk-school").forEach((x) => x.classList.toggle("hidden", !isSchool()));
    }
    const pickedLabel = () => { const b = el("bkLabels").querySelector('button[aria-pressed="true"]'); return b ? b.dataset.label : ""; };
    // The exact calendar title, the way the calendar function writes it (title_override, else "Organization \u2022 Label").
    // The typed title, with the organization kept in front of it unless the box is unticked.
    function composedOverride() {
      const ov = el("bkTitle").value.trim(); if (!ov) return "";
      return el("bkKeepOrg").checked && org ? org.name + " \u2022 " + ov : ov;
    }
    function renderTitle() {
      const box2 = el("bkTitlePrev"); if (!box2) return;
      const ov = el("bkTitle").value.trim();
      const t = ov ? (el("bkKeepOrg").checked ? (org ? org.name : "(organization)") + " \u2022 " + ov : ov) : [org ? org.name : "(organization)", pickedLabel() || byType(typeKey).label].join(" \u2022 ");
      box2.innerHTML = "On the calendar: <strong>" + esc(t) + "</strong>" + (dayRows.length > 1 ? ' <span class="muted">(each extra day adds its own label after it)</span>' : "");
      const gp = el("bkGp"), day = firstDay();
      if (gp && !isNew) { gp.innerHTML = ""; return; }
      if (gp) gp.innerHTML = org && day ? gpCreateBlock({ org_name: org.name, title_label: pickedLabel(), type_key: typeKey, type_label: byType(typeKey).label, picture_day: day })
        : '<div class="bk-sub" style="margin-top:6px">Pick the organization and the day to get the GotPhoto link.</div>';
    }
    function renderContacts() {
      const list = el("bkContacts");
      if (!org) { list.innerHTML = '<span class="bk-sub">Pick an organization first.</span>'; el("bkAddCBtn").classList.add("hidden"); return; }
      el("bkAddCBtn").classList.remove("hidden");
      if (!contacts.length) { list.innerHTML = '<span class="bk-sub">No contacts on file for ' + esc(org.name) + ' yet. Add one below.</span>'; return; }
      list.innerHTML = contacts.map((c) => {
        const ok = c.emailable !== false && !!c.email;
        const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
        return '<label class="' + (ok ? "" : "off") + '"><input type="checkbox" data-cid="' + esc(c.id) + '"' + (chosen.has(c.id) && ok ? " checked" : "") + (ok ? "" : " disabled") + ' /><span>' +
          (name ? "<strong>" + esc(name) + "</strong> " : "") + esc(c.email || "(no email)") + (c.role ? ' <span class="bk-sub">' + esc(c.role) + "</span>" : "") + (c.is_primary ? ' <span class="pill accent">Main</span>' : "") + (ok ? "" : ' <span class="pill muted">not emailable</span>') + "</span></label>";
      }).join("");
    }
    // Deliverables picked while booking (new bookings only): saved ones for the type, "every job" ones pre-ticked, plus typed ones.
    let fdType = null; const fdPicked = new Set(), fdNew = [];
    function renderFormDlv() {
      const box3 = el("bkFDlv"); if (!box3) return;
      const list = typeTemplates(typeKey);
      if (fdType !== typeKey) { fdType = typeKey; fdPicked.clear(); list.filter((x) => x.auto_add).forEach((x) => fdPicked.add(x.id)); }
      el("bkFDlvSaveL").textContent = "Save new ones for future " + (byType(typeKey).label || "") + " jobs";
      box3.innerHTML = list.map((x) => '<label><input type="checkbox" data-fdt="' + esc(x.id) + '"' + (fdPicked.has(x.id) ? " checked" : "") + " /><span>" + esc(x.label) +
          (x.due_days != null ? ' <span class="bk-sub">due ' + x.due_days + " days after launch</span>" : "") + (x.type_key ? "" : ' <span class="bk-sub">all types</span>') + "</span></label>").join("") +
        fdNew.map((l, i) => '<label><input type="checkbox" checked data-fdn="' + i + '" /><span>' + esc(l) + ' <span class="pill accent">new</span></span></label>').join("") ||
        '<span class="bk-sub">No saved deliverables for this job type yet. Type one below and it is kept for next time.</span>';
    }
    function renderPreview() {
      renderTitle();
      const pd = firstDay();
      const list = steps.filter((s) => seqOf(s.sequence_id) === typeKey);
      const n = [...el("bkContacts").querySelectorAll("input:checked")].length;
      if (!pd || !list.length) { el("bkPrev").innerHTML = '<strong>Emails:</strong> pick a picture day to see the schedule.'; return; }
      const today = todayStr();
      const items = list.flatMap((s) => {
        if (s.kind === "coach" && s.trigger === "gallery_live") return { k: "3|" + String(s.offset_days).padStart(4, "0"), h: "<li><strong>" + esc(s.label) + '</strong> <span class="pill accent">coach</span>: ' + (s.offset_days ? s.offset_days + " days after the gallery goes live" : "when the gallery goes live") + " (to the coaches on file)</li>" };
        if (s.kind === "hub" && s.trigger === "gallery_live") return { k: "3|" + String(s.offset_days).padStart(4, "0"), h: "<li><strong>" + esc(s.label) + '</strong> <span class="pill accent">hub</span>: ' + (s.offset_days ? s.offset_days + " days after the gallery goes live" : "when the gallery goes live") + "</li>" };
        if (s.kind === "hub" && s.trigger === "retake_day") return { k: "2|" + (isSchool() && el("bkRetake").value ? addDays(el("bkRetake").value, -s.offset_days) : "9999"), h: "<li><strong>" + esc(s.label) + '</strong> <span class="pill accent">hub</span>: ' + s.offset_days + " day" + (s.offset_days === 1 ? "" : "s") + " before retake day" + (isSchool() && el("bkRetake").value ? " (" + esc(fmtDay(addDays(el("bkRetake").value, -s.offset_days))) + ")" : " (needs a retake day)") + "</li>" };
        if (s.trigger === "booking") return { k: "0|0", h: "<li><strong>" + esc(s.label) + "</strong>: " + (isNew ? "right after you book (after the undo window)" : "already scheduled") + "</li>" };
        if (s.offset_days === 0) return { k: "0|", h: "<li><strong>" + esc(s.label) + "</strong>: " + (isSchool() ? (el("bkCode").value.trim() ? (isNew ? "about 10 minutes after you book" : "already scheduled") : "waits for the access code, then 10 minutes later") : (isNew ? "10 minutes after the GotPhoto job exists (it links itself within 5 minutes of the job being created)" : "already scheduled")) + "</li>" };
        // the hub "day before" reminder goes once per night; everything else once, keyed off the first day
        const nights = s.kind === "hub" && s.hub_key === "day" && s.trigger === "picture_day" ? readDays().filter((d) => d.day) : [{ day: pd }];
        return nights.map((n) => {
          const day = addDays(n.day, -s.offset_days);
          const past = day < today;
          return { k: "1|" + day, h: "<li><strong>" + esc(s.label) + "</strong>" + (nights.length > 1 ? " (" + esc(fmtDay(n.day)) + (n.label ? ", " + esc(n.label) : "") + ")" : "") + (s.kind === "hub" ? ' <span class="pill accent">hub</span>' : s.kind === "coach" ? ' <span class="pill accent">coach</span>' : "") + ": " + esc(fmtDay(day)) + " at " + esc(hhmmToLabel(s.send_time)) + (s.kind === "coach" ? " (to the coaches on file)" : "") + (past ? ' <span class="pill muted">already past, skipped</span>' : "") + (s.covered_by_gotphoto ? ' <span class="bk-sub">(skipped when GotPhoto emails the families)</span>' : "") + "</li>" };
        });
      });
      items.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
      let folded = true; try { folded = localStorage.getItem("aca-bkformmail") !== "open"; } catch (e) {}
      el("bkPrev").classList.toggle("folded", folded);
      el("bkPrev").innerHTML = '<button type="button" class="bk-mailtog" data-v="prevfold" aria-expanded="' + !folded + '"><span class="sl-chev"></span> ' + items.length + " email" + (items.length === 1 ? "" : "s") + "</button> to " + (n || "no") + " contact" + (n === 1 ? "" : "s") + (n > 1 ? " (first one To, the rest Cc)" : "") + '<div class="bk-prevbody"><ul>' + items.map((x) => x.h).join("") + "</ul>" +
        (isSchool() ? '<div style="margin-top:6px"><strong>Hub:</strong> ' + (el("bkCode").value.trim() ? "school row + reminder signups are created now." : "school row is created when you add the access code.") + "</div>" : "") + "</div>";
    }
    // Pick a job type as if it was clicked.
    function setType(k) {
      if (!k || k === typeKey) return;
      typeKey = k;
      box.querySelectorAll('#aca-bkTypes input[name="bkType"]').forEach((x) => { x.checked = x.value === k; });
      box.querySelectorAll(".bk-card").forEach((c) => c.classList.toggle("sel", c.querySelector("input").checked));
      renderLabels(); renderPreview(); renderFormDlv();
    }
    // A league gets the first sports type, a school the school type, unless a type was already clicked (2026-10-24).
    async function typeForOrg(o) {
      if (!isNew || typeTouched) return;
      let aud = o.audience;
      if (aud === undefined) { try { const { data } = await sb.from("prospect_orgs").select("audience").eq("id", o.id).maybeSingle(); aud = data && data.audience; } catch (_e) { aud = null; } }
      if (typeTouched || org !== o || !aud) return;
      const want = aud === "school" ? "school" : "sports";
      const hit = types.find((t) => t.audience === want);
      if (hit) setType(hit.key);
    }
    async function pickOrg(o) {
      org = o; chosen.clear();
      typeForOrg(o);
      el("bkOrgPick").innerHTML = "<strong>" + esc(o.name) + "</strong> " + orgLinkHtml(o) + ' <button type="button" class="link" data-v="changeorg">change</button>';
      el("bkOrgList").classList.add("hidden");
      if (!el("bkLoc").value) { el("bkLoc").value = o.town || ""; el("bkLoc").dataset.auto = "1"; }
      // Last time's place, when we have been there before.
      sb.from("bookings").select("location").eq("org_id", o.id).neq("location", "").order("picture_day", { ascending: false }).limit(1).then(({ data: last }) => {
        const loc = last && last[0] && last[0].location;
        if (loc && org === o && (!el("bkLoc").value || el("bkLoc").dataset.auto === "1")) { el("bkLoc").value = loc; el("bkLoc").dataset.auto = "1"; el("bkLocNote").textContent = "Same place as last time."; }
      }, () => {});
      const { data } = await sb.from("prospect_contacts").select("id, first_name, last_name, email, role, is_primary, bounced_at, unsubscribed_at, stopped_at, history_only").eq("org_id", o.id);
      contacts = (data || []).filter((c) => !c.history_only).map((c) => ({ ...c, emailable: !!c.email && !c.bounced_at && !c.unsubscribed_at && !c.stopped_at }))
        .sort((a, b) => (b.is_primary - a.is_primary) || String(a.first_name || "").localeCompare(String(b.first_name || "")));
      contacts.forEach((c) => { if (c.is_primary && c.emailable) chosen.add(c.id); });
      if (!chosen.size) contacts.filter((c) => c.emailable).forEach((c) => chosen.add(c.id));
      renderContacts(); renderPreview();
      if (!contacts.length && o.added) { el("bkAddC").classList.remove("hidden"); el("bkAddCBtn").classList.add("hidden"); }
    }
    // "Add 'Lincoln Lacrosse' as a new league" right in the picker (2026-10-24): the partner is created and picked.
    // Uses Orgs.quickAdd when the Partners page offers it; otherwise the same insert as its Add dialog.
    const newKind = () => (byType(typeKey).audience === "school" ? "school" : "league");
    const townOf = (loc) => { const p = String(loc || "").split(",").map((x) => x.trim()).filter(Boolean); return p.length >= 3 ? p[p.length - 2] : p[0] || ""; };
    async function addOrg(name, btn) {
      name = String(name || "").trim(); if (!name) return;
      const aud = newKind(), town = townOf(el("bkLoc").value) || null;
      btn.disabled = true;
      try {
        let o = null;
        if (typeof Orgs !== "undefined" && typeof Orgs.quickAdd === "function") {
          const res = await Orgs.quickAdd({ name, audience: aud, town, source: "Book a job" });
          const row = res && (res.data || res);
          if (res && res.error) throw res.error;
          if (row && row.id) o = { id: row.id, name: row.name || name, town: row.town === undefined ? town : row.town, audience: row.audience || aud };
        }
        if (!o) {
          const { data, error } = await sb.from("prospect_orgs").insert({ name, audience: aud, sports: [], town, source: "Book a job" }).select("id, name, town, audience").single();
          if (error) throw error;
          o = { id: data.id, name: data.name || name, town: data.town === undefined ? town : data.town, audience: data.audience || aud };
        }
        o.added = true;
        toast("Added " + o.name + " as a new " + aud + ".");
        await pickOrg(o);
      } catch (e2) { btn.disabled = false; err(/duplicate|unique/i.test(cleanErr(e2)) ? "There is already a partner with that name. Pick it from the list." : cleanErr(e2)); }
    }
    Places.attach(el("bkLoc"), { note: el("bkLocNote"), hint: "Goes on the calendar event and is used for drive times." });
    let searchTimer = null;
    box.addEventListener("input", (e) => {
      if (e.target.id === "aca-bkOrgQ") {
        clearTimeout(searchTimer);
        const q = e.target.value.trim();
        if (q.length < 2) { el("bkOrgList").classList.add("hidden"); return; }
        searchTimer = setTimeout(async () => {
          const { data } = await sb.from("prospect_orgs").select("id, name, town, stage, audience").ilike("search_text", "%" + q.replace(/[%_]/g, "") + "%").order("name").limit(12);
          const list = el("bkOrgList"); if (!el("bkOrgQ") || el("bkOrgQ").value.trim() !== q) return; // typed on since
          list.classList.remove("hidden");
          const exact = (data || []).some((o) => o.name.trim().toLowerCase() === q.toLowerCase());
          list.innerHTML = (data || []).map((o) => '<button type="button" data-org="' + esc(o.id) + '"><strong>' + esc(o.name) + "</strong>" + (o.town ? ' <span class="bk-sub">' + esc(o.town) + "</span>" : "") + (o.stage === "client" ? ' <span class="pill ok">Client</span>' : "") + "</button>").join("") +
            (exact ? "" : '<button type="button" class="bk-addorg" data-addorg="' + esc(q) + '">' + ((data || []).length ? "" : '<span class="bk-sub">No match. </span>') + "+ Add <strong>&lsquo;" + esc(q) + "&rsquo;</strong> as a new " + newKind() + "</button>");
          list.querySelectorAll("button[data-org]").forEach((b) => b.addEventListener("click", () => pickOrg((data || []).find((o) => o.id === b.dataset.org))));
          const add = list.querySelector("button[data-addorg]"); if (add) add.addEventListener("click", () => addOrg(add.dataset.addorg, add));
        }, 220);
      }
      if (["aca-bkCode", "aca-bkRetake"].includes(e.target.id) || e.target.classList.contains("bk-d-day") || e.target.classList.contains("bk-d-label")) renderPreview();
      if (e.target.closest && e.target.closest("#aca-bkDays")) renderMoveNote();
      if (e.target.id === "aca-bkTitle" || e.target.id === "aca-bkKeepOrg") renderTitle();
    });
    box.addEventListener("change", (e) => {
      if (e.target.name === "bkType") {
        typeKey = e.target.value; typeTouched = true;
        box.querySelectorAll(".bk-card").forEach((c) => c.classList.toggle("sel", c.querySelector("input").checked));
        renderLabels(); renderPreview(); renderFormDlv();
      }
      if (e.target.dataset && e.target.dataset.fdt) { if (e.target.checked) fdPicked.add(e.target.dataset.fdt); else fdPicked.delete(e.target.dataset.fdt); }
      if (e.target.dataset && e.target.dataset.fdn) { if (!e.target.checked) { fdNew.splice(Number(e.target.dataset.fdn), 1); renderFormDlv(); } }
      if (e.target.dataset && e.target.dataset.cid) { if (e.target.checked) chosen.add(e.target.dataset.cid); else chosen.delete(e.target.dataset.cid); renderPreview(); }
      if (e.target.closest && e.target.closest("#aca-bkDays")) renderMoveNote();
    });
    box.addEventListener("click", async (e) => {
      if (e.target.closest('a[data-v="orglink"]')) { box.close(); return; }
      const lb = e.target.closest("button[data-label]");
      if (lb) { el("bkLabels").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === lb ? "true" : "false")); renderTitle(); return; }
      const b = e.target.closest("button[data-v]"); if (!b) return;
      const v = b.dataset.v;
      if (v === "close") return box.close();
      if (v === "prevfold") { const open = el("bkPrev").classList.toggle("folded") === false; b.setAttribute("aria-expanded", String(open)); try { localStorage.setItem("aca-bkformmail", open ? "open" : "closed"); } catch (e2) {} return; }
      if (v === "copyname") { try { await navigator.clipboard.writeText(b.dataset.name); b.textContent = "copied"; setTimeout(() => { b.textContent = "copy"; }, 1500); } catch (er) { toast("Couldn't copy: " + b.dataset.name, true); } return; }
      if (v === "addday") { readDays(); dayRows.push({ day: "", start_time: "", end_time: "", label: "" }); renderDays(); return; }
      if (v === "rmday") { const i = Number(b.dataset.i); if (dayRows.length > 1) { readDays(); dayRows.splice(i, 1); renderDays(); renderPreview(); renderMoveNote(); } return; }
      if (v === "changeorg") { org = null; contacts = []; chosen.clear(); el("bkOrgPick").innerHTML = '<input type="text" id="aca-bkOrgQ" placeholder="Type the league or school name" autocomplete="off" style="width:100%" />'; renderContacts(); el("bkOrgQ").focus(); return; }
      if (v === "fdlvadd") {
        const l = el("bkFDlvNew").value.trim(); if (!l) return;
        const hit = typeTemplates(typeKey).find((x) => x.label.trim().toLowerCase() === l.toLowerCase());
        if (hit) fdPicked.add(hit.id); else if (!fdNew.some((x) => x.toLowerCase() === l.toLowerCase())) fdNew.push(l);
        el("bkFDlvNew").value = ""; renderFormDlv(); el("bkFDlvNew").focus(); return;
      }
      if (v === "showaddc") { el("bkAddC").classList.remove("hidden"); b.classList.add("hidden"); el("bkCFirst").focus(); return; }
      if (v === "addc") {
        const email = el("bkCEmail").value.trim().toLowerCase();
        if (!org) return err("Pick an organization first.");
        if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return err("That does not look like an email address.");
        b.disabled = true;
        const { data, error } = await sb.from("prospect_contacts").insert({ org_id: org.id, email, first_name: el("bkCFirst").value.trim() || null, last_name: el("bkCLast").value.trim() || null, role: el("bkCRole").value.trim() || null }).select("*").single();
        b.disabled = false;
        if (error) return err(cleanErr(error));
        contacts.push({ ...data, emailable: true }); chosen.add(data.id);
        ["bkCFirst", "bkCLast", "bkCEmail", "bkCRole"].forEach((id) => { el(id).value = ""; });
        clearError("bkFormErr"); renderContacts(); renderPreview(); return;
      }
      if (v === "save") {
        clearError("bkFormErr");
        if (!org) return err("Pick an organization.");
        const days = readDays();
        if (!days.length) return err("Pick the picture day.");
        if (!chosen.size) return err("Tick at least one contact with an email address.");
        const noEnd = days.filter((x) => x.start_time && !x.end_time);
        if (noEnd.length && !confirm("No end time on " + noEnd.map((x) => fmtDay(x.day)).join(", ") + ". We use the end time to know when to pack up. Save without it?")) return;
        const badEnd = days.filter((x) => x.start_time && x.end_time && x.end_time <= x.start_time);
        if (badEnd.length) return err("The end time has to be after the start time (" + fmtDay(badEnd[0].day) + ").");
        const p = { org_id: org.id, type_key: typeKey, picture_day: days[0].day, days,
          title_label: pickedLabel(), title_override: composedOverride(), location: el("bkLoc").value.trim(), notes: el("bkNotes").value.trim(),
          contact_ids: [...chosen], access_code: isSchool() ? el("bkCode").value.trim() : "", retake_day: isSchool() ? (el("bkRetake").value || "") : "" };
        if (isNew && rows.some((r) => r.org_id === org.id && r.picture_day === p.picture_day && r.type_key === typeKey && r.status !== "cancelled")
            && !confirm("There is already a " + byType(typeKey).label + " booking for " + org.name + " on that day. Book another one anyway?")) return;
        b.disabled = true;
        try {
          const { data, error } = isNew ? await sb.rpc("booking_create", { p }) : await sb.rpc("booking_update", { p_id: d.id, p });
          if (error) throw error;
          const typed = isNew ? el("bkFDlvNew").value.trim() : "";
          const ticked = el("bkCrew") && crewReady ? [...el("bkCrew").querySelectorAll(".bk-crew:checked")].map((x) => x.value) : [];
          // New: everyone ticked goes on. Edit: the ticked people who weren't on it go on, the unticked come off.
          const crew = isNew || !crewNow ? (isNew ? ticked : []) : ticked.filter((u) => !crewNow.some((c) => c.user_id === u));
          const crewOff = !isNew && crewNow && crewReady ? crewNow.filter((c) => !ticked.includes(c.user_id)).map((c) => c.user_id) : [];
          const moved = !isNew && dayKey(days) !== dayKey(origDays);
          const items = isNew ? [...fdPicked].map((id) => ({ template_id: id })).concat(fdNew.concat(typed ? [typed] : []).map((label) => ({ label, save: el("bkFDlvSave").checked }))) : [];
          const dir = DirectorFields.read();
          box.close();
          const dirErr = await DirectorFields.save(isNew ? data.id : d.id, dir, isNew);
          let dlvErr = "";
          if (items.length) { try { await addDeliverables(data.id, items); } catch (e3) { dlvErr = cleanErr(e3); } }
          let crewMsg = "";
          if (crewOff.length) {
            try { const n = await takeOff(d.id, crewOff, days, origDays); crewMsg += n ? " Took " + crewOff.length + (crewOff.length === 1 ? " person" : " people") + " off the job." : ""; }
            catch (e5) { crewMsg += " The crew was not changed: " + cleanErr(e5) + "."; }
          }
          if (crew.length) {
            try {
              const sr = await Schedule.staffBooking(data.id, days[0].day, days[days.length - 1].day, crew);
              crewMsg = sr.untimed.length ? " " + (sr.added ? "On the schedule for the days with a time; " : "") + "add the crew on the Schedule once " + sr.untimed.map(fmtDay).join(", ") + (sr.untimed.length > 1 ? " have times." : " has a time.") : " Crew is on the schedule.";
            } catch (e4) { crewMsg = " The crew was not put on the schedule: " + cleanErr(e4) + "."; }
          }
          if (dirErr) crewMsg += " The team times and order dates were not saved (" + dirErr + "); open Edit booking to try again.";
          toast((dlvErr ? "Booked, but the deliverables were not added: " + dlvErr + ". Add them on the booking." : isNew ? "Booked. Writing the calendar event\u2026" :
            "Saved." + (moved ? " The Schedule, the calendar event and the unsent emails move with it." : "")) + crewMsg, !!dlvErr || !!dirErr || /not put|not changed/.test(crewMsg));
          // After booking, the new job's page (its trail leads back to the partner); after an edit, the page you were on.
          if (isNew) { pollNew = data.id; await load(true); openJob(data.id, "booking"); }
          else { load(true); if (typeof JobPage !== "undefined" && currentTab === "job") JobPage.reload(); }
        } catch (e2) { b.disabled = false; err(cleanErr(e2)); }
      }
    });
    box.addEventListener("click", (e) => { const dd = el("bkCrewDd"); if (dd && dd.open && !dd.contains(e.target)) dd.open = false; });
    renderLabels(); renderDays(); renderFormDlv();
    // Edit: the crew as it is now (the job page's data) and the days as they were, for the "what moves" note.
    let crewNow = null, crewReady = false;
    const origDays = isNew ? [] : readDays();
    const crewLoad = isNew ? Promise.resolve() : sb.rpc("job_get", { p_booking: d.id }).then(({ data }) => {
      const seen = new Set();
      crewNow = ((data && data.crew) || []).filter((c) => c.user_id && !seen.has(c.user_id) && seen.add(c.user_id)).map((c) => ({ user_id: c.user_id, name: c.name }));
      renderMoveNote();
    }, () => {});
    function renderMoveNote() {
      const note = el("bkMoveNote"); if (!note || isNew) return;
      const now = readDays(), dayMoved = dayKey(now, true) !== dayKey(origDays, true), timeMoved = !dayMoved && dayKey(now) !== dayKey(origDays);
      if (!now.length || (!dayMoved && !timeMoved)) { note.classList.add("hidden"); return; }
      const unsent = (d.emails || []).filter((e) => ["scheduled", "waiting", "failed"].includes(e.status)).length;
      const sent = (d.emails || []).filter((e) => e.status === "sent").length;
      const names = (crewNow || []).map((c) => shortNm(c.name));
      const bits = dayMoved ? [
        names.length ? "the crew on the Schedule (" + esc(names.join(", ")) + ") moves to the new day with the same times, and they're asked to confirm again" : "nobody is on the Schedule for it yet",
        "the Google Calendar event moves",
        unsent ? unsent + " email" + (unsent === 1 ? " that hasn't" : "s that haven't") + " gone out yet " + (unsent === 1 ? "is" : "are") + " rescheduled from the new day" : "no emails are waiting to go out",
        "checklist steps keep their spacing from picture day"] : [
        "the Google Calendar event and emails that mention the time follow",
        names.length ? "the crew's times on the Schedule stay as they are, so check them there" : "nobody is on the Schedule for it yet"];
      note.innerHTML = "<strong>" + (dayMoved ? "Moving the day:" : "Changing the time:") + "</strong> " + bits.join("; ") + "." + (dayMoved && sent ? " Emails already sent stay sent." : "");
      note.classList.remove("hidden");
    } Promise.all([Schedule.team(), crewLoad]).then(([ppl]) => {
      const on = (uid) => !!(crewNow && crewNow.some((c) => c.user_id === uid));
      // Someone on the job who isn't on the team list any more still shows, so unticking them works.
      (crewNow || []).forEach((c) => { if (!ppl.some((x) => x.user_id === c.user_id)) ppl = ppl.concat([{ user_id: c.user_id, name: c.name }]); });
      el("bkCrew").innerHTML = ppl.length ? ppl.map((x) => '<label class="bk-contact"><input type="checkbox" class="bk-crew" value="' + esc(x.user_id) + '" data-name="' + esc(x.name) + '"' + (on(x.user_id) ? " checked" : "") + " /> " + esc(x.name) + "</label>").join("") : '<span class="bk-sub">Nobody on the team yet.</span>';
      crewReady = true;
      const sync = () => {
        const names = [...el("bkCrew").querySelectorAll(".bk-crew:checked")].map((x) => x.dataset.name);
        el("bkCrewSum").textContent = names.length ? names.join(", ") : "Nobody yet";
        el("bkCrewSum").classList.toggle("none", !names.length);
      };
      el("bkCrew").addEventListener("change", sync); sync();
      // Opening the list notes who is off or busy that day, their roles and the drive from home (crew.js CrewPick).
      let noted = "";
      el("bkCrewDd").addEventListener("toggle", async () => {
        if (!el("bkCrewDd").open || typeof CrewPick === "undefined") return;
        const day = (box.querySelector(".bk-d-day") || {}).value || "", loc = el("bkLoc").value.trim(), key = day + "|" + loc;
        if (!day || key === noted) return;
        noted = key;
        try {
          const cp = await CrewPick.options(null, day, loc || null);
          el("bkCrew").querySelectorAll(".bk-crew").forEach((x) => {
            const p = cp.people.find((y) => y.user_id === x.value); if (!p) return;
            const [line, lvl, rn] = CrewPick.describe(p, cp);
            let n = x.parentNode.querySelector(".bk-crewnote");
            if (!n) { n = document.createElement("span"); n.className = "bk-sub bk-crewnote"; n.style.cssText = "display:block;margin-left:24px"; x.parentNode.appendChild(n); x.parentNode.style.flexWrap = "wrap"; }
            n.textContent = (rn.length ? rn.join(", ") + " \u00b7 " : "") + (loc ? line : line.replace(/ ?\u00b7? ?(no home address.*|drive from home unknown|\d+ min from home)$/, ""));
            n.style.color = lvl === "bad" ? "var(--err-fg)" : lvl === "warn" ? "#8a6100" : "";
          });
        } catch (_e) { noted = ""; }
      });
    }).catch(() => { el("bkCrew").innerHTML = '<span class="bk-sub">Could not load the team. ' + (isNew ? "Add people on the Schedule after booking." : "Change the crew on the Schedule.") + "</span>"; });
    if (!isNew) { renderContacts(); renderPreview(); }
    else if (presetOrg) { renderPreview(); pickOrg(presetOrg); }
    else { renderPreview(); setTimeout(() => { const q = el("bkOrgQ"); if (q) q.focus(); }, 50); }
  }
  el("bkNew").addEventListener("click", () => openForm(null));

  // ---- Stages & deliverables per job type (2026-10-21). Edits go straight to booking_stages / deliverable_templates
  // (bookings edit). Removing archives: past bookings keep their history and their copies of deliverables.
  // Stages & deliverables: one dialog, opened from All jobs and from Settings > Job types (k = the job type to
  // start on; opts.onSaved runs after a save).
  async function openJobTypes(k, opts) {
    opts = opts || {};
    try { await ensureMeta(); await loadTracking(); } catch (e) { toast(cleanErr(e), true); return; }
    const can = canEdit("bookings");
    let tk = typeof k === "string" && (k === "" || types.some((t) => t.key === k)) ? k : (types[0] || {}).key || "";
    let st = [], tp = [];  // working copies for the chosen type: { id?, label, sort, auto?, due_days?, auto_add?, gone? }
    const box = dialog(`<div class="bk-fhead"><h2>Stages &amp; deliverables</h2><button type="button" class="bk-fx" data-v="close" aria-label="Close">\u2715</button></div>
      <div class="bk-sub" style="margin-bottom:10px">Each job type has its own stages and its own saved deliverables. Changes apply from now on: past bookings keep their history and their own copies.</div>
      <div class="bk-chips" id="aca-bkJtTypes" role="group">${types.map((t) => '<button type="button" class="small" data-jt="' + esc(t.key) + '">' + esc(t.label) + "</button>").join("")}<button type="button" class="small" data-jt="">All job types</button></div>
      <div class="bk-jt" id="aca-bkJtBody"></div>
      <div id="aca-bkJtErr" class="inline-error hidden" style="margin:10px 0 0"></div>
      <div class="og-actions bk-factions" style="margin-top:12px">${can ? '<button type="button" class="primary" data-v="save">Save</button>' : ""}<button type="button" data-v="close">${can ? "Cancel" : "Close"}</button></div>`, true);
    box.classList.add("bk-form");
    const dis = can ? "" : " disabled";
    let dirty = false;
    box.addEventListener("input", () => { dirty = true; });
    function pick(k) {
      tk = k; dirty = false;
      st = tk ? typeStages(tk).map((x) => ({ ...x })) : [];
      tp = templates.filter((x) => !x.archived_at && (x.type_key || "") === tk).sort((a, b) => a.sort - b.sort).map((x) => ({ ...x }));
      el("bkJtTypes").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.jt === tk ? "true" : "false"));
      draw();
    }
    const live = (list) => list.filter((x) => !x.gone);
    function read() {
      box.querySelectorAll("[data-st]").forEach((r) => { const x = live(st)[Number(r.dataset.st)]; x.label = r.querySelector("input[type=text]").value; });
      box.querySelectorAll("[data-tp]").forEach((r) => { const x = live(tp)[Number(r.dataset.tp)]; x.label = r.querySelector("input[type=text]").value;
        const n = r.querySelector("input[type=number]").value; x.due_days = n === "" ? null : Number(n); x.auto_add = r.querySelector("input[type=checkbox]").checked; });
    }
    function draw() {
      const tl = (byType(tk).label || "every job type");
      el("bkJtBody").innerHTML = (tk ? "<h3>Stages</h3>" + '<div class="bk-sub">In order. A job moves through these on its booking. Ones marked automatic tick themselves.</div><div class="bk-jt-rows">' +
          live(st).map((x, i, a) => '<div class="bk-jt-row" data-st="' + i + '"><span class="bk-sub" style="width:18px">' + (i + 1) + '.</span><input type="text" maxlength="60" value="' + esc(x.label) + '"' + dis + " />" +
            (x.auto ? '<span class="pill muted" title="' + esc(STAGE_AUTO[x.auto]) + '">automatic</span>' : "") +
            (can ? '<button type="button" class="small quiet" data-v="up" data-l="st" data-i="' + i + '"' + (i ? "" : " disabled") + ' aria-label="Move up">&uarr;</button><button type="button" class="small quiet" data-v="down" data-l="st" data-i="' + i + '"' + (i < a.length - 1 ? "" : " disabled") + ' aria-label="Move down">&darr;</button>' +
              '<button type="button" class="small quiet" data-v="rm" data-l="st" data-i="' + i + '" aria-label="Remove">&times;</button>' : "") + "</div>").join("") + "</div>" +
          (can ? '<button type="button" class="link" data-v="add" data-l="st">+ Add a stage</button>' : "") : "") +
        "<h3>Saved deliverables" + (tk ? "" : " for every job type") + "</h3>" + '<div class="bk-sub">Offered when booking a ' + esc(tl) + ' job. Due = days after the job is launched on GotPhoto (no due date until then). "Every job" ones come pre-ticked.</div><div class="bk-jt-rows">' +
          (live(tp).map((x, i, a) => '<div class="bk-jt-row" data-tp="' + i + '"><input type="text" maxlength="120" value="' + esc(x.label) + '"' + dis + ' />' +
            '<span class="bk-sub">due</span><input type="number" min="0" max="365" value="' + (x.due_days == null ? "" : esc(x.due_days)) + '" placeholder="days"' + dis + ' aria-label="Due days after launch" />' +
            '<label class="bk-sub" style="display:inline-flex;gap:4px;align-items:center"><input type="checkbox"' + (x.auto_add ? " checked" : "") + dis + " /> every job</label>" +
            (can ? '<button type="button" class="small quiet" data-v="up" data-l="tp" data-i="' + i + '"' + (i ? "" : " disabled") + ' aria-label="Move up">&uarr;</button><button type="button" class="small quiet" data-v="down" data-l="tp" data-i="' + i + '"' + (i < a.length - 1 ? "" : " disabled") + ' aria-label="Move down">&darr;</button>' +
              '<button type="button" class="small quiet" data-v="rm" data-l="tp" data-i="' + i + '" aria-label="Remove">&times;</button>' : "") + "</div>").join("") || '<div class="bk-sub">None saved yet. Add one here, or type one on a booking and keep "Save it for future jobs" ticked.</div>') + "</div>" +
        (can ? '<button type="button" class="link" data-v="add" data-l="tp">+ Add a deliverable</button>' : "");
    }
    async function save() {
      read();
      const bad = live(st).concat(live(tp)).find((x) => !String(x.label || "").trim());
      if (bad) throw new Error("Every stage and deliverable needs a name (or remove the empty one).");
      if (tk && !live(st).length) throw new Error("Keep at least one stage.");
      const now = new Date().toISOString(), w = [];
      st.forEach((x, i) => { const sort = (live(st).indexOf(x) + 1) * 10;
        if (x.gone) { if (x.id) w.push(sb.from("booking_stages").update({ archived_at: now }).eq("id", x.id)); }
        else if (x.id) w.push(sb.from("booking_stages").update({ label: x.label.trim(), sort }).eq("id", x.id));
        else w.push(sb.from("booking_stages").insert({ type_key: tk, label: x.label.trim(), sort })); });
      // archive first so a re-added name doesn't collide with the one being removed
      for (const x of tp.filter((y) => y.gone && y.id)) { const { error } = await sb.from("deliverable_templates").update({ archived_at: now }).eq("id", x.id); if (error) throw error; }
      live(tp).forEach((x, i) => { const row = { label: x.label.trim(), due_days: x.due_days, auto_add: !!x.auto_add, sort: (i + 1) * 10 };
        w.push(x.id ? sb.from("deliverable_templates").update(row).eq("id", x.id) : sb.from("deliverable_templates").insert(Object.assign(row, { type_key: tk || null }))); });
      const res = await Promise.all(w), err = res.find((r) => r && r.error);
      if (err) throw err.error;
    }
    box.addEventListener("click", async (e) => {
      const jt = e.target.closest("button[data-jt]");
      if (jt) { if (jt.dataset.jt === tk || (dirty && !confirm("Discard the changes you made to " + (byType(tk).label || "every job type") + "?"))) return; return pick(jt.dataset.jt); }
      const b = e.target.closest("button[data-v]"); if (!b) return;
      const v = b.dataset.v;
      if (v === "close") { if (dirty && can && !confirm("Close without saving your changes?")) return; return box.close(); }
      if (v === "save") {
        clearError("bkJtErr"); b.disabled = true;
        try { await save(); await loadTracking(); toast("Saved."); pick(tk); render(); if (host && host.isConnected) refreshDetail(); if (opts.onSaved) opts.onSaved(); }
        catch (e2) { showError("bkJtErr", /duplicate key|unique/i.test(cleanErr(e2)) ? "Two saved deliverables have the same name." : cleanErr(e2)); }
        b.disabled = false; return;
      }
      read();
      const list = b.dataset.l === "st" ? st : tp, l = live(list), i = Number(b.dataset.i);
      if (v === "add") list.push(b.dataset.l === "st" ? { label: "" } : { label: "", due_days: null, auto_add: false });
      if (v === "rm") { const x = l[i]; if (x.id) x.gone = true; else list.splice(list.indexOf(x), 1); }
      dirty = true;
      if (v === "up" || v === "down") { const j = v === "up" ? i - 1 : i + 1; const a = list.indexOf(l[i]), c = list.indexOf(l[j]); [list[a], list[c]] = [list[c], list[a]]; }
      draw();
      if (v === "add") { const rows = box.querySelectorAll("[data-" + b.dataset.l + "] input[type=text]"); if (rows.length) rows[rows.length - 1].focus(); }
    });
    pick(tk);
  }
  el("bkJobTypes").addEventListener("click", () => openJobTypes());
  el("bkTrack").addEventListener("click", () => { menu(false); openTrack(); });
  const menu = (on) => { el("bkMenu").classList.toggle("hidden", !on); el("bkMore").setAttribute("aria-expanded", String(on)); };
  el("bkMore").addEventListener("click", (e) => { e.stopPropagation(); menu(el("bkMenu").classList.contains("hidden")); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#aca-bkMoreWrap")) menu(false); });

  // ---- one job screen (2026-10-24). Every way into a job opens its page (jobpage.js). What used to be this
  // page's side panel is the job page's Booking tab (mountTab below); All jobs keeps a short preview with Open.
  function openJob(id, tab, replace) {
    if (openId) closeDetail();
    const h = jobLink(id, tab);
    if (replace) history.replaceState(null, "", h); else history.pushState(null, "", h);
    showTab("job");
  }
  // The short preview on All jobs: what the row says, bigger, and Open.
  function openDetail(id) {
    const b = rows.find((r) => r.id === id);
    if (!b) { openJob(id); return; }
    openId = id;
    const panel = el("bkPanel");
    panel.classList.remove("hidden");
    if (window.innerWidth <= 900) { document.documentElement.classList.add("aca-sheet-open"); document.body.classList.add("aca-sheet-open"); }
    Orgs.measureTop();
    const who = (b.contacts || []).map((c) => esc(c.name || c.email)).join(", ");
    panel.innerHTML = '<div class="bk-sec bk-pv" style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">' +
        '<div><h3 style="font-size:15px">' + esc(b.title) + '</h3><div class="bk-sub">' + daysLine(b) + " · " + esc(b.type_label || "") + (b.status !== "booked" ? ' · <span class="pill muted">' + esc(b.status === "tracked" ? "tracking only" : b.status) + "</span>" : "") + "</div>" +
        '<div class="bk-sub"><a href="#partners/org/' + esc(b.org_id) + '">' + esc(b.org_name || "") + "</a>" + (b.location ? " · " + esc(b.location) : "") + "</div></div>" +
        '<button type="button" data-v="close" aria-label="Close">✕</button></div>' +
      '<div class="bk-sec"><div class="bk-facts">' +
        (b.status === "cancelled" ? "" : "<span>Stage</span><span>" + stageCell(b) + "</span>") +
        "<span>Emails</span><span>" + mailSummary(b) + "</span>" +
        "<span>Calendar</span><span>" + calPill(b) + "</span>" +
        "<span>Contacts</span><span>" + (who || (b.status === "tracked" ? "&mdash;" : '<span class="pill err">no contact</span>')) + "</span></div></div>" +
      '<div class="bk-sec bk-pv-acts"><a class="primary" href="' + esc(jobLink(id)) + '" data-v="open">Open</a><button type="button" data-v="close">Close</button></div>';
  }
  el("bkPanel").addEventListener("click", (e) => {
    if (e.target.closest('[data-v="close"]')) { closeDetail(); return; }
    if (e.target.closest('a[data-v="open"]')) { e.preventDefault(); openJob(openId); }
  });
  function closeDetail() {
    document.documentElement.classList.remove("aca-sheet-open"); document.body.classList.remove("aca-sheet-open");
    openId = null;
    el("bkPanel").classList.add("hidden");
    if (/^#jobs\/bookings\//.test(location.hash)) history.replaceState(null, "", "#jobs/bookings");
  }

  // ---- the job page's Booking tab: stage, deliverables, calendar, GotPhoto / hub, coaches, contacts, emails.
  // Other modules add a section with Bookings.addSection({ id, after: "contacts", html: (b, ctx) => "...", wire: (box, b, ctx) => {} })
  // (b = admin_booking_detail, ctx = { live, refresh }); `after` names a built-in section: stage, deliverables, calendar,
  // gotphoto, coaches, contacts, emails (default contacts).
  const extraSections = [];
  let host = null, tabId = null, detail = null, tracking = null, pollNew = null;
  async function mountTab(box, id) {
    box.innerHTML = '<div class="bk-tab" id="aca-bkDetail"><div class="empty"><span class="spin"></span>Loading…</div></div>';
    const me = box.firstElementChild;
    host = me; tabId = id; detail = null;
    wireHost(me);
    await refreshDetail();
    clearTimeout(pollTimer);
    const poll = pollNew === id; pollNew = null;
    if (poll || (detail && detail.calendar_status === "pending")) {
      let n = 0;
      const tick = async () => { if (host !== me || !me.isConnected) return; await refreshDetail(); if ((detail && detail.calendar_status !== "pending") || ++n > 12) { load(true); return; } pollTimer = setTimeout(tick, 2500); };
      pollTimer = setTimeout(tick, 2500);
    }
  }
  async function refreshDetail() {
    const me = host, id = tabId; if (!me) return;
    const [{ data, error }, tr] = await Promise.all([sb.rpc("admin_booking_detail", { p_id: id }), sb.rpc("admin_booking_tracking", { p_id: id })]);
    if (host !== me) return;
    tracking = tr.error ? null : tr.data;
    if (error || !data) { me.innerHTML = '<div class="inline-error" style="margin:16px 0">' + esc(error ? cleanErr(error) : "Booking not found.") + "</div>"; return; }
    detail = data; renderDetail();
  }
  // Stage moves and cancelling change the job page's header too, so the whole page reloads.
  const reloadJob = () => { if (typeof JobPage !== "undefined" && currentTab === "job") return JobPage.reload(); return refreshDetail(); };
  const statusPill = (e) => {
    const m = { scheduled: ["muted", "Scheduled"], waiting: ["warn", "Waiting"], sending: ["accent", "Sending…"], sent: ["ok", "Sent"], skipped: ["muted", "Skipped"], failed: ["err", "Failed"], cancelled: ["muted", "Cancelled"] };
    const [c, t] = m[e.status] || ["muted", e.status]; return '<span class="pill ' + c + '">' + t + "</span>";
  };
  function renderDetail() {
    const b = detail, isSchool = b.audience === "school", live = b.status === "booked", tracked = b.status === "tracked";
    let mailFolded = true; try { mailFolded = localStorage.getItem("aca-bkmailfold") !== "open"; } catch (e) {}
    const calBtns = [];
    if (b.google_event_id && b.calendar_status !== "deleted") calBtns.push('<a class="small" href="' + esc(gcalLink(b.google_event_id)) + '" target="_blank" rel="noopener" style="display:inline-block;padding:4px 9px;border:1px solid var(--border);border-radius:8px">Open in Google Calendar</a>');
    if (live && (b.calendar_status === "moved" || b.calendar_status === "missing")) calBtns.push('<button type="button" class="small" data-v="adopt"' + (b.mirror ? "" : " disabled") + '>Use the calendar date' + (b.mirror ? " (" + esc(fmtDay(b.mirror.start_date)) + ")" : "") + "</button>");
    if (live && ["error", "moved", "missing"].includes(b.calendar_status)) calBtns.push('<button type="button" class="small" data-v="rewrite">Rewrite the event</button>');
    const rank = (e) => e.trigger === "retake_day" ? 1000 - (e.offset_days || 0) : e.trigger === "gallery_live" ? 500 + (e.offset_days || 0) : (e.offset_days || 0) === 0 ? -1000 : -(e.offset_days || 0);
    const when = (e) => e.sent_at || e.send_at || null;
    // one timeline: admin emails and hub reminders together, in the order the client receives them
    const emails = (b.emails || []).slice().sort((x, y) => (when(x) && when(y) ? String(when(x)).localeCompare(String(when(y))) : 0) || rank(x) - rank(y) || (x.step_no || 0) - (y.step_no || 0));
    const can = canEdit("bookings");
    const parts = [];
    if (b.time_set === false && live) parts.push(["time", '<div class="bk-sec"><span class="pill warn">time not set</span> <span class="bk-sub">Emails that mention the time are waiting. Set the times with Edit booking at the top.</span></div>']);
    parts.push(["stage", stageBlock(b)], ["deliverables", dlvBlock(b)]);
    if (tracked) parts.push(["tracked", trackedBlock(b)]);
    else {
      parts.push(["calendar", `<div class="bk-sec"><h3>Calendar</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${calPill(b)}${calBtns.join("")}</div>
        ${b.calendar_error ? '<div class="bk-sub" style="margin-top:6px;color:var(--err-fg)">' + esc(b.calendar_error) + "</div>" : ""}
        ${b.calendar_status === "pending" && !b.google_event_id ? '<div class="bk-sub" style="margin-top:6px">The event is written by the calendar function within a minute. If this never changes, the Google service account is not set up yet (see the to-do list).</div>' : ""}
      </div>`]);
      // One GotPhoto block: the sports job link, or the school's hub row (each holds the one "Create the job in GotPhoto" link).
      parts.push(["gotphoto", !isSchool ? '<div class="bk-sec"><h3>GotPhoto job (sports hub)</h3>' + (b.gotphoto_job ? '<div class="bk-sub">Linked to <strong>' + esc(b.gotphoto_job.name) + '</strong> (' + esc(b.gotphoto_job.status || "") + '). The team shows on 207photo.com/sportsadmin.' + (live && can ? ' <button type="button" class="link" data-v="unlinkjob">unlink</button>' : "") + "</div>" :
        (live ? '<div class="bk-sub">Not linked yet, so email 0 waits (the hub lists teams from GotPhoto jobs). Once the job exists in GotPhoto it links itself within 5 minutes' + (can ? ", or pick it here." : ".") + "</div>" + gpCreateBlock(b) +
          (can ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><select id="aca-bkDJob" class="small" style="max-width:360px"><option value="">' + ((b.job_candidates || []).length ? "Pick the GotPhoto job…" : "No matching job in the sync yet") + '</option>' +
          (b.job_candidates || []).map((j) => '<option value="' + esc(j.gotphoto_job_id) + '">' + esc(j.name) + (j.picture_day ? " (" + esc(fmtDay(j.picture_day)) + ")" : "") + "</option>").join("") + '</select><button type="button" class="small primary" data-v="linkjob">Link</button></div>' : "") : '<div class="bk-sub">No GotPhoto job linked.</div>')) + "</div>"
        : '<div class="bk-sec"><h3>School hub</h3>' + (b.hub_school ? '<div class="bk-sub">On 207photo.com/schooladmin as <strong>' + esc(b.hub_school.name) + "</strong>, code <strong>" + esc(b.hub_school.access_code) + "</strong>" + (b.hub_school.retake_day ? ", retake " + esc(fmtDay(b.hub_school.retake_day)) : "") + ". Reminder signups were added for the contacts.</div>" + (can ? hubRowTools(b.hub_school) : "") :
        (live ? '<div class="bk-sub">Not on the hub yet. Email 0 waits until the school exists there. Create the job in GotPhoto first, then enter its access code here.</div>' + gpCreateBlock(b) + (can ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><input type="text" id="aca-bkDCode" placeholder="GotPhoto access code" style="width:170px" /><input type="date" id="aca-bkDRetake" title="Retake day (optional)" /><button type="button" class="small primary" data-v="setcode">Create on the hub</button></div>' : "") : '<div class="bk-sub">Not on the hub.</div>')) + "</div>"]);
      if (!isSchool) parts.push(["coaches", '<div class="bk-sec"><h3>Coaches</h3>' + coachesBlock(b, live && can) + "</div>"]);
      parts.push(["contacts", '<div class="bk-sec"><h3>Who gets the emails</h3>' + ((b.contacts || []).map((c) => "<div>" + esc(c.name || "") + ' <span class="bk-sub">' + esc(c.email || "") + "</span></div>").join("") || '<span class="pill err">Nobody to email</span>') + "</div>"]);
      parts.push(["emails", `<div class="bk-sec bk-mailsec${mailFolded ? " folded" : ""}"><h3><button type="button" class="bk-mailtog" data-v="mailfold" aria-expanded="${!mailFolded}"><span class="sl-chev"></span> Emails</button> <span class="bk-sub">${mailSummary(b)}</span></h3>
        <div class="table-wrap bk-mailbody"><table class="bk-emails"><tbody>${emails.map((e, i) => '<tr><td><strong>' + esc((i + 1) + ". " + (e.label || "")) + ((b.days || []).length > 1 && e.day_index != null && b.days[e.day_index] ? " (" + esc(fmtDay(b.days[e.day_index].day)) + (b.days[e.day_index].label ? ", " + esc(b.days[e.day_index].label) : "") + ")" : "") + '</strong>' + (e.kind === "hub" ? ' <span class="pill accent">Hub</span>' : e.kind === "coach" ? ' <span class="pill accent">Coach</span>' : "") + (e.is_resend ? ' <span class="pill muted">resend</span>' : "") +
          '<div class="bk-sub">to ' + (e.kind === "coach" ? esc((e.to_emails || []).join(", ") || "the coaches on file (none yet)") : esc(e.to_name || "") + " " + esc(e.to_email || "")) + ((e.cc_emails || []).length ? ' <span class="muted">cc ' + esc((e.cc_emails || []).join(", ")) + "</span>" : "") + "</div>" +
          (e.status === "sent" ? '<div class="bk-sub">sent ' + esc(fmtWhen(e.sent_at)) + "</div>" : e.send_at && e.status === "scheduled" ? '<div class="bk-sub">' + esc(fmtWhen(e.send_at)) + "</div>" : "") +
          (e.reason && e.status !== "sent" ? '<div class="bk-sub">' + esc(e.reason) + "</div>" : "") + (e.error ? '<div class="bk-sub" style="color:var(--err-fg)">' + esc(e.error) + "</div>" : "") + "</td>" +
          "<td>" + statusPill(e) + "</td>" +
          '<td class="bk-act"><button type="button" class="small" data-em="' + esc(e.id) + '" data-v="preview">Preview</button>' +
          (live && can && ["scheduled", "waiting", "failed", "skipped"].includes(e.status) ? '<button type="button" class="small" data-em="' + esc(e.id) + '" data-v="sendnow">Send now</button>' : "") +
          (live && can && e.status === "sent" ? '<button type="button" class="small" data-em="' + esc(e.id) + '" data-v="resend">Resend</button>' : "") + "</td></tr>").join("") || '<tr><td class="empty">No emails.</td></tr>'}</tbody></table></div>
      </div>`]);
    }
    // Sections other modules add (team times and the like), each after the one it names.
    const ctx = { live, refresh: () => refreshDetail() };
    extraSections.forEach((x) => {
      let html = ""; try { html = x.html(b, ctx) || ""; } catch (e2) { html = ""; }
      if (!html) return;
      const at = parts.findIndex((p) => p[0] === (x.after || "contacts"));
      parts.splice(at < 0 ? parts.length : at + 1, 0, ["x:" + x.id, '<div data-xsec="' + esc(x.id) + '">' + html + "</div>"]);
    });
    // The one action that isn't Edit booking sits at the end of the tab (not floating over it).
    if (live && can) parts.push(["actions", '<div class="bk-sec og-actions"><button type="button" data-v="cancel">Cancel booking</button></div>']);
    host.innerHTML = parts.map((p) => p[1]).join("");
    extraSections.forEach((x) => { const box = host.querySelector('[data-xsec="' + CSS.escape(x.id) + '"]'); if (box && x.wire) { try { x.wire(box, b, ctx); } catch (e3) { /* that module's problem, not this tab's */ } } });
  }
  // Track-only jobs (2026-10-21): on the screen for stages and deliverables, with no emails, calendar event or hub row.
  function trackedBlock(b) {
    const can = canEdit("bookings");
    return '<div class="bk-sec"><h3>Tracking only</h3><div class="bk-sub">This job did not go through Book a job. It is here for its stages and deliverables only: no emails, no calendar event and no hub reminders come from it.</div>' +
      (b.gotphoto_job ? '<div class="bk-sub" style="margin-top:6px">GotPhoto job <strong>' + esc(b.gotphoto_job.name) + "</strong>" + (b.gotphoto_job.gp_activated_at ? ", gallery live since " + esc(fmtWhen(b.gotphoto_job.gp_activated_at)) : ", gallery not live yet") + "</div>" : "") +
      (can ? '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
        (b.picture_day >= todayIso() ? '<button type="button" class="small primary" data-v="makereal">Make it a real booking</button>' : "") +
        '<button type="button" class="small" data-v="untrack">Stop tracking</button></div>' : "") + "</div>";
  }
  function todayIso() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  // Moving off 17hats (2026-10-23): a track-only job becomes a booking on its job type's emails. 17hats already sent
  // Start here (and maybe more), so those are ticked and marked "Not needed"; the calendar event that day is linked
  // instead of a second one being made. The list underneath is a dry run of exactly what Admin will send, and when.
  async function openMakeReal(id) {
    const { data: s, error } = await sb.rpc("booking_make_real_suggest", { p_id: id });
    if (error) return toast(cleanErr(error), true);
    const usable = s.contacts.filter((c) => c.usable), ev = s.events.find((x) => x.matches) || null;
    const box = dialog(`<div class="bk-fhead"><h2>Make it a real booking</h2><button type="button" class="bk-fx" data-v="close" aria-label="Close">✕</button></div>
      <div class="bk-sub" style="margin-bottom:10px"><strong>${esc(s.org)}</strong>, ${esc(fmtDay(s.picture_day))}. Admin takes over this job's emails from 17hats. Turn off its 17hats workflow the same day.</div>
      ${s.has_sequence ? "" : '<div class="inline-error">This job type has no active email sequence.</div>'}
      <div class="og-grid">
        <span>Director</span><span id="aca-bkMrWho">${s.contacts.map((c, i) => '<label style="display:block"><input type="checkbox" data-who="' + esc(c.id) + '"' + (c.usable ? (c === usable[0] ? " checked" : "") : " disabled") + " /> " + esc(c.name || c.email) + (c.name ? ' <span class="bk-sub">' + esc(c.email) + "</span>" : "") + (c.usable ? "" : ' <span class="pill muted">bounced or stopped</span>') + "</label>").join("") || '<span class="inline-error">No contacts on this partner. Add the director on the partner page first.</span>'}</span>
        <label for="aca-bkMrEv">Calendar</label><select id="aca-bkMrEv"><option value="">Make a new event</option>${s.events.map((x) => '<option value="' + esc(x.id) + '" data-st="' + esc(x.start_time || "") + '" data-en="' + esc(x.end_time || "") + '"' + (x === ev ? " selected" : "") + ">Use " + esc(x.title) + " (" + esc(x.start_time || "") + ")</option>").join("")}</select>
        <label for="aca-bkMrSt">Start</label><input type="time" id="aca-bkMrSt" value="${esc(ev ? ev.start_time : "")}" />
        <label for="aca-bkMrEn">End</label><input type="time" id="aca-bkMrEn" value="${esc(ev ? ev.end_time : "")}" />
        <span>17hats already sent</span><span>${s.steps.map((st) => '<label style="display:block"><input type="checkbox" data-sent="' + esc(st.step_no) + '"' + (st.offset_days === 0 ? " checked disabled" : "") + " /> " + esc(st.subject.replace(/\{\{\s*\w+\s*\}\}/g, "…")) + ' <span class="bk-sub">' + (st.offset_days === 0 ? "at booking" : esc(fmtDay(st.send_day)) + (st.passed ? ", date passed" : "")) + "</span></label>").join("")}</span>
      </div>
      <h3 style="font-size:14px;margin:14px 0 6px">What Admin will send</h3>
      <div id="aca-bkMrPlan" class="bk-sub"><span class="spin"></span>Working it out&#8230;</div>
      <div id="aca-bkMrErr" class="inline-error hidden" style="margin:10px 0 0"></div>
      <div class="og-actions" style="margin-top:12px"><button type="button" class="primary" data-v="save" disabled>Make it a real booking</button><button type="button" data-v="close">Cancel</button></div>`, true);
    box.classList.add("bk-form");
    const args = () => ({ contact_ids: [...box.querySelectorAll("input[data-who]:checked")].map((x) => x.dataset.who), start_time: el("bkMrSt").value,
      end_time: el("bkMrEn").value, google_event_id: el("bkMrEv").value, sent_steps: [...box.querySelectorAll("input[data-sent]:checked")].map((x) => +x.dataset.sent) });
    const row = (m) => "<tr><td>" + (m.status === "scheduled" ? esc(fmtWhen(m.send_at)) : '<span class="pill muted">' + esc(m.status === "waiting" ? "waiting" : "won't send") + "</span>") + "</td><td>" + esc(m.subject || "Step " + m.step_no) +
      (m.status === "scheduled" ? "" : '<div class="bk-sub">' + esc(m.reason || "") + "</div>") + "</td><td>" + esc((m.to || []).concat(m.cc || []).join(", ")) + "</td></tr>";
    let seq = 0;
    async function preview() {
      const mine = ++seq, err = el("bkMrErr"), save = box.querySelector('button[data-v="save"]');
      err.classList.add("hidden"); save.disabled = true;
      const { data, error: e2 } = await sb.rpc("booking_make_real", { p_id: id, p: args(), p_dry_run: true });
      if (mine !== seq) return;
      if (e2) { el("bkMrPlan").innerHTML = ""; err.textContent = cleanErr(e2); err.classList.remove("hidden"); return; }
      const list = data.emails.slice().sort((a, b2) => (a.status === "scheduled") === (b2.status === "scheduled") ? 0 : a.status === "scheduled" ? -1 : 1);
      el("bkMrPlan").innerHTML = '<div class="table-wrap"><table class="bk-emails"><tbody>' + list.map(row).join("") + "</tbody></table></div>";
      save.disabled = false;
    }
    box.addEventListener("change", (e) => {
      if (e.target.id === "aca-bkMrEv") { const o = e.target.selectedOptions[0]; if (o && o.dataset.st) { el("bkMrSt").value = o.dataset.st; el("bkMrEn").value = o.dataset.en; } }
      preview();
    });
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      if (b.dataset.v === "close") return box.close();
      if (b.dataset.v !== "save") return;
      b.disabled = true;
      const { error: e3 } = await sb.rpc("booking_make_real", { p_id: id, p: args(), p_dry_run: false });
      if (e3) { b.disabled = false; el("bkMrErr").textContent = cleanErr(e3); el("bkMrErr").classList.remove("hidden"); return; }
      box.close(); toast("It's a real booking now. Turn off its 17hats workflow."); load(true); loadAttention(); await refreshDetail();
    });
    preview();
  }
  async function openTrack() {
    const can = canEdit("bookings");
    const box = dialog(`<div class="bk-fhead"><h2>Track a job</h2><button type="button" class="bk-fx" data-v="close" aria-label="Close">\u2715</button></div>
      <div class="bk-sub" style="margin-bottom:10px">Put jobs that did not go through Book a job on this screen, to track their stages and deliverables. Nothing is sent for them: no emails, no calendar event, no hub reminders.</div>
      <div class="toolbar" style="padding:0;margin-bottom:8px"><input type="text" id="aca-bkTrQ" placeholder="Filter GotPhoto jobs&#8230;" /></div>
      <div id="aca-bkTrList" class="bk-jt-rows" style="max-height:46vh;overflow:auto"><div class="empty"><span class="spin"></span>Loading GotPhoto jobs&#8230;</div></div>
      <details style="margin-top:10px"><summary class="bk-sub" style="cursor:pointer">Add a job that is not in GotPhoto</summary>
        <div class="bk-jt-row" style="margin-top:8px"><span id="aca-bkTrMOrg"></span><select id="aca-bkTrMType" class="small">${types.map((t) => '<option value="' + esc(t.key) + '">' + esc(t.label) + "</option>").join("")}</select>
          <input type="date" id="aca-bkTrMDay" class="small" aria-label="Picture day" /><input type="text" id="aca-bkTrMTitle" placeholder="Title (optional)" /><button type="button" class="small" data-v="manual">Track it</button></div></details>
      <label class="bk-sub" style="display:flex;gap:6px;align-items:center;margin-top:12px"><input type="checkbox" id="aca-bkTrAuto"${can ? "" : " disabled"} /> Add new GotPhoto jobs to tracking by themselves (hourly, when the organization is clear)</label>
      <div id="aca-bkTrErr" class="inline-error hidden" style="margin:10px 0 0"></div>
      <div class="og-actions bk-factions" style="margin-top:12px">${can ? '<button type="button" class="primary" data-v="track" disabled>Track selected</button>' : ""}<button type="button" data-v="close">Close</button></div>`, true);
    box.classList.add("bk-form");
    let jobs = [];
    const picked = new Set(), orgFor = {}, typeFor = {};
    // A small organization search that sets orgFor[key] (key = job id, or "manual").
    const orgPicker = (key, cur) => cur ? '<span class="bk-sub"><strong>' + esc(cur.name) + '</strong> <button type="button" class="link" data-v="orgchange" data-k="' + esc(key) + '">change</button></span>'
      : '<span style="position:relative;display:inline-block;flex:1 1 200px"><input type="text" data-orgq="' + esc(key) + '" placeholder="Organization&#8230;" autocomplete="off" style="width:100%" /><span class="bk-orgs hidden" data-orgl="' + esc(key) + '" style="position:absolute;z-index:5;left:0;right:0"></span></span>';
    const typeSel = (key, k) => '<select class="small" data-type="' + esc(key) + '"' + (can ? "" : " disabled") + ">" + types.map((t) => '<option value="' + esc(t.key) + '"' + (t.key === k ? " selected" : "") + ">" + esc(t.label) + "</option>").join("") + "</select>";
    function draw() {
      const q = el("bkTrQ").value.trim().toLowerCase();
      const list = jobs.filter((j) => !q || (j.name + " " + (j.org_name || "")).toLowerCase().includes(q));
      el("bkTrList").innerHTML = list.map((j) => '<div class="bk-jt-row" data-job="' + esc(j.gotphoto_job_id) + '"><input type="checkbox" data-pick="' + esc(j.gotphoto_job_id) + '"' + (picked.has(j.gotphoto_job_id) ? " checked" : "") + (can ? "" : " disabled") + ' aria-label="Track ' + esc(j.name) + '" />' +
          '<span style="flex:1 1 220px;min-width:0"><strong>' + esc(j.name) + '</strong><span class="bk-sub"> ' + esc(fmtDay(j.picture_day)) + (j.status === "published" ? "" : " &middot; " + esc(j.status)) + "</span></span>" +
          orgPicker(j.gotphoto_job_id, orgFor[j.gotphoto_job_id]) + typeSel(j.gotphoto_job_id, typeFor[j.gotphoto_job_id]) + "</div>").join("") ||
        '<div class="bk-sub">' + (jobs.length ? "No GotPhoto job matches that." : "Every GotPhoto job from the last six months and the next year is already on this screen.") + "</div>";
      const tb = box.querySelector('button[data-v="track"]'); if (tb) { tb.disabled = !picked.size; tb.textContent = picked.size ? "Track " + picked.size + " job" + (picked.size === 1 ? "" : "s") : "Track selected"; }
    }
    function drawManual() { el("bkTrMOrg").outerHTML = '<span id="aca-bkTrMOrg" style="display:contents">' + orgPicker("manual", orgFor.manual) + "</span>"; }
    let searchTimer = null;
    box.addEventListener("input", (e) => {
      if (e.target.id === "aca-bkTrQ") return draw();
      const key = e.target.dataset && e.target.dataset.orgq; if (!key) return;
      clearTimeout(searchTimer);
      const q = e.target.value.trim(), out = box.querySelector('[data-orgl="' + CSS.escape(key) + '"]');
      if (q.length < 2) { out.classList.add("hidden"); return; }
      searchTimer = setTimeout(async () => {
        const { data } = await sb.from("prospect_orgs").select("id, name, town").ilike("search_text", "%" + q.replace(/[%_]/g, "") + "%").order("name").limit(8);
        out.classList.remove("hidden");
        out.innerHTML = (data || []).map((o) => '<button type="button" data-orgpick="' + esc(o.id) + '" data-name="' + esc(o.name) + '" data-k="' + esc(key) + '"><strong>' + esc(o.name) + "</strong>" + (o.town ? ' <span class="bk-sub">' + esc(o.town) + "</span>" : "") + "</button>").join("") ||
          '<div class="empty">No match. Add it under Organizations first.</div>';
      }, 220);
    });
    box.addEventListener("change", async (e) => {
      const t = e.target;
      if (t.dataset.pick) { if (t.checked) picked.add(t.dataset.pick); else picked.delete(t.dataset.pick); draw(); }
      if (t.dataset.type) typeFor[t.dataset.type] = t.value;
      if (t.id === "aca-bkTrAuto") {
        t.disabled = true; const { error } = await sb.rpc("booking_set_auto_track", { p_on: t.checked }); t.disabled = false;
        if (error) { t.checked = !t.checked; return toast(cleanErr(error), true); }
        toast(t.checked ? "New GotPhoto jobs will be added to tracking." : "Automatic tracking is off.");
      }
    });
    box.addEventListener("click", async (e) => {
      const op = e.target.closest("button[data-orgpick]");
      if (op) { orgFor[op.dataset.k] = { id: op.dataset.orgpick, name: op.dataset.name }; if (op.dataset.k === "manual") drawManual(); else draw(); return; }
      const b = e.target.closest("button[data-v]"); if (!b) return;
      const v = b.dataset.v;
      if (v === "close") return box.close();
      if (v === "orgchange") { delete orgFor[b.dataset.k]; if (b.dataset.k === "manual") drawManual(); else draw(); return; }
      if (v !== "track" && v !== "manual") return;
      clearError("bkTrErr");
      let items;
      if (v === "track") {
        const missing = [...picked].filter((id) => !orgFor[id]);
        if (missing.length) return showError("bkTrErr", "Pick the organization for " + missing.length + " of the selected jobs first.");
        items = [...picked].map((id) => ({ gotphoto_job_id: id, org_id: orgFor[id].id, type_key: typeFor[id] }));
      } else {
        if (!orgFor.manual) return showError("bkTrErr", "Pick the organization.");
        if (!el("bkTrMDay").value) return showError("bkTrErr", "Pick the picture day.");
        items = [{ org_id: orgFor.manual.id, type_key: el("bkTrMType").value, picture_day: el("bkTrMDay").value, title_label: el("bkTrMTitle").value.trim() }];
      }
      b.disabled = true;
      try {
        const { data, error } = await sb.rpc("booking_track_jobs", { p_items: items }); if (error) throw error; if (!data.ok) throw new Error(data.error);
        box.close(); toast("Tracking " + data.added + " job" + (data.added === 1 ? "" : "s") + ". Nothing is sent for them."); load(true);
      } catch (e2) { b.disabled = false; showError("bkTrErr", cleanErr(e2)); }
    });
    drawManual();
    try {
      const [{ data, error }, st] = await Promise.all([sb.rpc("admin_trackable_jobs", {}), sb.from("booking_tracking_settings").select("*").maybeSingle()]);
      if (error) throw error;
      jobs = data || [];
      jobs.forEach((j) => { if (j.org_id) orgFor[j.gotphoto_job_id] = { id: j.org_id, name: j.org_name }; typeFor[j.gotphoto_job_id] = j.type_key; });
      el("bkTrAuto").checked = !!(st.data && st.data.auto_track);
      draw();
    } catch (e) { el("bkTrList").innerHTML = '<div class="inline-error">' + esc(cleanErr(e)) + "</div>"; }
  }
  // Stage (2026-10-21): the job type's stages as a row of steps; click one to move the job there.
  function stageBlock(b) {
    const t = tracking; if (!t) return "";
    const can = canEdit("bookings") && b.status !== "cancelled";
    const list = (t.stages || []).filter((s) => !s.archived || s.id === t.stage_id);
    const cur = list.find((s) => s.id === t.stage_id), curSort = cur ? cur.sort : -Infinity;
    const next = list.find((s) => !s.archived && s.sort > curSort);
    const ev = t.events || [];
    const live1 = list.filter((s) => !s.archived), pos = cur ? live1.findIndex((s) => s.id === cur.id) + 1 : 0;
    return '<div class="bk-sec"><h3>Stage' + (cur ? ' <span class="bk-sub">' + esc(cur.label) + (t.stage_at ? " since " + esc(fmtDay(new Date(t.stage_at).toLocaleDateString("en-CA", { timeZone: TZ }))) : "") + "</span>" : "") + "</h3>" +
      (b.status === "cancelled" ? '<div class="bk-sub">Cancelled bookings are not tracked.</div>' : "") +
      '<div class="bk-stage1"><span>' + (cur ? esc(cur.label) + (pos ? ", " + pos + " of " + live1.length : "") : "No stage yet") + "</span>" +
        (can ? '<button type="button" class="small" data-v="stagemove" aria-expanded="false">Move</button>' : "") + "</div>" +
      '<ol class="bk-stages">' + list.map((s) => '<li class="' + (s.id === t.stage_id ? "cur" : s.sort < curSort ? "done" : "") + '"><button type="button" data-v="stage" data-stage="' + esc(s.id) + '"' +
        (STAGE_AUTO[s.auto] ? ' title="' + esc(STAGE_AUTO[s.auto]) + '"' : "") + (can && s.id !== t.stage_id ? "" : " disabled") + ">" + esc(s.label) + "</button></li>").join("") + "</ol>" +
      (can && next ? '<button type="button" class="small primary bk-stage-next" data-v="stage" data-stage="' + esc(next.id) + '" data-next="1">Move to ' + esc(next.label) + "</button>" : "") +
      (ev.length ? '<details class="bk-hist"><summary>History (' + ev.length + ")</summary><ul>" + ev.map((e) => "<li><strong>" + esc(e.label) + "</strong> " + esc(fmtWhen(e.at)) +
        " &middot; " + (e.auto ? "automatic" : esc(e.by || "someone")) + (e.note ? ' <span class="bk-sub">' + esc(e.note) + "</span>" : "") + "</li>").join("") + "</ul></details>" : "") + "</div>";
  }
  // Deliverables (2026-10-21): what is owed to the client, ticked off as it goes out.
  const dueBits = (d) => {
    if (d.status !== "todo") return d.done_at ? '<span class="bk-sub">' + (d.status === "skipped" ? "skipped " : "delivered ") + esc(fmtWhen(d.done_at)) + (d.done_by_name ? " by " + esc(d.done_by_name) : "") + "</span>" : "";
    if (!d.due_date) return d.due_days != null ? '<span class="bk-sub">due ' + num(d.due_days) + " days after launch</span>" : "";
    return d.due_date < todayStr() ? '<span class="pill err">overdue, was due ' + esc(fmtDay(d.due_date)) + "</span>" : '<span class="bk-sub">due ' + esc(fmtDay(d.due_date)) + "</span>";
  };
  function dlvBlock(b) {
    const t = tracking; if (!t) return "";
    const can = canEdit("bookings") && b.status !== "cancelled";
    const ds = t.deliverables || [], closed = ds.filter((d) => d.status !== "todo").length;
    const have = new Set(ds.map((d) => d.template_id).filter(Boolean)), haveL = new Set(ds.map((d) => d.label.trim().toLowerCase()));
    const picks = (t.templates || []).filter((x) => !have.has(x.id) && !haveL.has(x.label.trim().toLowerCase()));
    return '<div class="bk-sec"><h3>Deliverables' + (ds.length ? ' <span class="bk-sub">' + closed + " of " + ds.length + " delivered</span>" : "") + "</h3>" +
      (ds.length ? '<ul class="bk-dlv">' + ds.map((d) => '<li class="' + (d.status !== "todo" ? "closed" : "") + '"><input type="checkbox" data-dlv="' + esc(d.id) + '" aria-label="Delivered: ' + esc(d.label) + '"' +
          (d.status !== "todo" ? " checked" : "") + (can ? "" : " disabled") + " /><div><strong>" + esc(d.label) + "</strong> " + (d.status === "skipped" ? '<span class="pill muted">Skipped</span> ' : "") + dueBits(d) +
          (d.link ? ' &middot; <a href="' + esc(d.link) + '" target="_blank" rel="noopener">link</a>' : "") + (d.note ? '<div class="bk-sub">' + esc(d.note) + "</div>" : "") + "</div>" +
          (can ? '<button type="button" class="link" data-v="dlvedit" data-dlv="' + esc(d.id) + '">edit</button>' : "") + "</li>").join("") + "</ul>"
        : '<div class="bk-sub">Nothing to deliver yet.' + (can ? " Add what you owe " + esc(b.org_name) + " after the job." : "") + "</div>") +
      (can ? (picks.length ? '<div class="bk-dlvadd"><select id="aca-bkDlvPick" class="small" aria-label="Saved deliverable"><option value="">Pick a saved deliverable&#8230;</option>' +
          picks.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.label) + (x.due_days != null ? " (due " + x.due_days + " days after launch)" : "") + (x.type_key ? "" : " &middot; all types") + "</option>").join("") +
          '</select><button type="button" class="small" data-v="dlvpick">Add</button></div>' : "") +
        '<div class="bk-dlvadd"><input type="text" id="aca-bkDlvNew" maxlength="120" placeholder="' + (picks.length ? "Or type a new one" : "Type a deliverable, e.g. Team composites") + '" />' +
        '<input type="date" id="aca-bkDlvDue" class="small" aria-label="Due date (optional)" title="Due date (optional)" /><button type="button" class="small" data-v="dlvnew">Add</button></div>' +
        '<label class="bk-sub" style="display:inline-flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="aca-bkDlvSave" checked /> Save it for future ' + esc(b.type_label) + " jobs</label>" : "") + "</div>";
  }
  // Edit one deliverable: name, due date, link, note, or mark it skipped.
  function openDlvEdit(d) {
    const box = dialog(`<h2 style="margin:0 0 12px">Edit deliverable</h2>
      <div class="og-grid">
        <label for="aca-bkDeLabel">Name</label><input type="text" id="aca-bkDeLabel" maxlength="120" value="${esc(d.label)}" />
        <label for="aca-bkDeDue">Due</label><input type="date" id="aca-bkDeDue" value="${esc(d.due_date || "")}" />
        <label for="aca-bkDeStatus">Status</label><select id="aca-bkDeStatus"><option value="todo">To do</option><option value="done">Delivered</option><option value="skipped">Skipped (not needed)</option></select>
        <label for="aca-bkDeLink">Link</label><input type="text" id="aca-bkDeLink" value="${esc(d.link || "")}" placeholder="Where it went, e.g. the Dropbox folder" />
        <label for="aca-bkDeNote">Note</label><textarea id="aca-bkDeNote" rows="2">${esc(d.note || "")}</textarea>
      </div>
      <div id="aca-bkDeErr" class="inline-error hidden" style="margin:10px 0 0"></div>
      <div class="og-actions" style="margin-top:12px"><button type="button" class="primary" data-v="save">Save</button><button type="button" data-v="close">Cancel</button><button type="button" data-v="remove" style="margin-left:auto">Remove</button></div>`);
    el("bkDeStatus").value = d.status;
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-v]"); if (!b) return;
      if (b.dataset.v === "close") return box.close();
      try {
        b.disabled = true;
        if (b.dataset.v === "remove") {
          if (!confirm("Remove " + d.label + " from this booking?")) { b.disabled = false; return; }
          const { error } = await sb.rpc("booking_deliverable_remove", { p_id: d.id }); if (error) throw error;
        } else {
          const { data, error } = await sb.rpc("booking_deliverable_update", { p_id: d.id, p: { label: el("bkDeLabel").value.trim(), due_date: el("bkDeDue").value || "",
            status: el("bkDeStatus").value, link: el("bkDeLink").value.trim(), note: el("bkDeNote").value.trim() } });
          if (error) throw error; if (!data.ok) throw new Error(data.error);
        }
        box.close(); await refreshDetail(); load(true); loadAttention();
      } catch (e2) { b.disabled = false; el("bkDeErr").textContent = cleanErr(e2); el("bkDeErr").classList.remove("hidden"); }
    });
  }
  async function addDeliverables(id, items) {
    const { data, error } = await sb.rpc("booking_deliverables_add", { p_booking: id, p_items: items });
    if (error) throw error; if (!data.ok) throw new Error(data.error);
    if (items.some((x) => x.save)) await loadTracking();
    return data.added;
  }
  // Coaches (sports, 2026-10-17): captured from the AD's Reply All by booking-sender every 15 minutes, or pasted here.
  // Coach steps (kind "coach") go to this list, in their own Gmail thread, with no SMS and no consent forms.
  function coachesBlock(b, live) {
    const list = b.coaches || [];
    return (list.length ? list.map((c) => '<div>' + (c.name ? "<strong>" + esc(c.name) + "</strong> " : "") + '<span class="bk-sub">' + esc(c.email) + '</span> <span class="pill muted">' + (c.source === "reply" ? "from reply" : "added") + "</span>" +
        (live ? ' <button type="button" class="link" data-v="coachrm" data-coach="' + esc(c.id) + '">remove</button>' : "") + "</div>").join("") :
      '<div class="bk-sub">' + (live ? "No coach emails yet. The coach checklist and gallery emails wait until there are some." : "No coach emails.") + "</div>") +
      '<div class="bk-sub" style="margin-top:6px">Added automatically when the AD replies all to email 1 with coaches CC\'d (checked every 15 minutes). Coaches get email only: a checklist two days before picture day, the gallery link when photos are online, and a last call.</div>' +
      (live ? '<div style="margin-top:8px"><textarea id="aca-bkCoachText" rows="2" style="width:100%" placeholder="Paste coach emails (one per line or comma separated)"></textarea>' +
        '<div style="margin-top:6px"><button type="button" class="small" data-v="coachadd">Add coaches</button></div></div>' : "");
  }
  // The hub row used to have its own Schools tab. Dates come from the booking; the code, retake day and
  // visibility are edited here (2026-10-12). Writes go straight to comm_hub_schools, like the old tab did.
  function hubRowTools(h) {
    return '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">' +
      '<span class="sw' + (h.active === false ? "" : " on") + '" role="switch" aria-checked="' + (h.active !== false) + '" tabindex="0" data-v="hubvis" aria-label="Shown on the hub"><span class="knob"></span></span>' +
      '<span class="bk-sub">' + (h.active === false ? "Hidden from the hub" : "Shown on the hub") + '</span>' +
      '<button type="button" class="small" data-v="hubedit" style="margin-left:auto">Change code or retake day</button></div>' +
      '<div class="hidden" id="aca-bkHubEdit" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><input type="text" id="aca-bkHCode" value="' + esc(h.access_code || "") + '" placeholder="Access code" style="width:150px" />' +
      '<input type="date" id="aca-bkHRetake" value="' + esc(h.retake_day || "") + '" title="Retake day (optional)" /><button type="button" class="small primary" data-v="hubsave">Save</button><button type="button" class="small" data-v="hubcancel">Cancel</button></div>';
  }
  // The Booking tab's controls; listeners go on each new tab element (the job page rebuilds it per visit).
  function wireHost(h) {
  h.addEventListener("click", async (e) => {
    const sw = e.target.closest('[data-v="hubvis"]'); if (!sw || !detail || !detail.hub_school) return;
    const on = sw.getAttribute("aria-checked") !== "true";
    sw.classList.add("busy");
    const { error } = await sb.from("comm_hub_schools").update({ active: on }).eq("id", detail.hub_school.id);
    sw.classList.remove("busy");
    if (error) return toast(cleanErr(error), true);
    toast(on ? "Shown on the hub." : "Hidden from the hub."); refreshDetail();
  });
  h.addEventListener("change", async (e) => {
    const cb = e.target.closest("input[data-dlv]"); if (!cb || !detail) return;
    cb.disabled = true;
    const { data, error } = await sb.rpc("booking_deliverable_update", { p_id: cb.dataset.dlv, p: { status: cb.checked ? "done" : "todo" } });
    if (error || !data.ok) { cb.disabled = false; cb.checked = !cb.checked; return toast(error ? cleanErr(error) : data.error, true); }
    await refreshDetail(); load(true); loadAttention();
  });
  h.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-v]"); if (!b) return;
    const v = b.dataset.v, em = b.dataset.em;
    try {
      if (v === "stagemove") { const ol = h.querySelector(".bk-stages"); if (ol) b.setAttribute("aria-expanded", String(ol.classList.toggle("open"))); return; }
      if (v === "mailfold") { const sec = b.closest(".bk-mailsec"); const open = sec.classList.toggle("folded") === false; b.setAttribute("aria-expanded", String(open)); try { localStorage.setItem("aca-bkmailfold", open ? "open" : "closed"); } catch (e2) {} return; }
      if (v === "copyname") { try { await navigator.clipboard.writeText(b.dataset.name); b.textContent = "copied"; setTimeout(() => { b.textContent = "copy"; }, 1500); } catch (er) { toast("Couldn't copy: " + b.dataset.name, true); } return; }
      if (v === "hubedit") { el("bkHubEdit").classList.remove("hidden"); el("bkHubEdit").style.display = "flex"; return; }
      if (v === "hubcancel") { el("bkHubEdit").classList.add("hidden"); return; }
      if (v === "hubsave") {
        const code = el("bkHCode").value.trim(); if (!code) return toast("Type the access code first.", true);
        b.disabled = true;
        const { error } = await sb.from("comm_hub_schools").update({ access_code: code, retake_day: el("bkHRetake").value || null }).eq("id", detail.hub_school.id);
        if (error) throw error;
        toast("Hub row updated."); await refreshDetail(); return;
      }
      if (v === "stage") {
        const s = ((tracking || {}).stages || []).find((x) => x.id === b.dataset.stage); if (!s) return;
        if (!b.dataset.next && !confirm("Move this job to " + s.label + "?")) return;
        b.disabled = true; const { data, error } = await sb.rpc("booking_set_stage", { p_booking: detail.id, p_stage: s.id }); if (error) throw error; if (!data.ok) throw new Error(data.error);
        toast("Moved to " + s.label + "."); load(true); await reloadJob(); return;
      }
      if (v === "makereal") { await openMakeReal(detail.id); return; }
      if (v === "untrack") {
        if (!confirm("Stop tracking this job? It leaves All jobs (its stage history and deliverables are kept).")) return;
        b.disabled = true; const { data, error } = await sb.rpc("booking_untrack", { p_id: detail.id }); if (error) throw error; if (!data.ok) throw new Error("This job is not track-only.");
        toast("No longer tracked."); load(true); loadAttention(); if (currentTab === "job") showTab("bookings"); return;
      }
      if (v === "dlvedit") { const d = ((tracking || {}).deliverables || []).find((x) => x.id === b.dataset.dlv); if (d) openDlvEdit(d); return; }
      if (v === "dlvpick") {
        const id = el("bkDlvPick").value; if (!id) return toast("Pick a saved deliverable first.", true);
        b.disabled = true; await addDeliverables(detail.id, [{ template_id: id }]); await refreshDetail(); load(true); loadAttention(); return;
      }
      if (v === "dlvnew") {
        const label = el("bkDlvNew").value.trim(); if (!label) return toast("Type the deliverable first.", true);
        b.disabled = true; const n = await addDeliverables(detail.id, [{ label, due_date: el("bkDlvDue").value || "", save: el("bkDlvSave").checked }]);
        if (!n) toast("That one is already on this booking.", true);
        await refreshDetail(); load(true); loadAttention(); return;
      }
      if (v === "coachadd") {
        const text = (el("bkCoachText").value || "").trim(); if (!text) return toast("Paste at least one email first.", true);
        b.disabled = true; const { data, error } = await sb.rpc("booking_coaches_add", { p_booking: detail.id, p_text: text, p_source: "manual" }); if (error) throw error;
        toast(data.added ? "Added " + data.added + " coach email" + (data.added === 1 ? "" : "s") + "." : (data.seen ? "Nothing new. Our own addresses, no-reply senders and the org's contacts are left out." : "No email address found in that text."), !data.added);
      }
      if (v === "coachrm") { b.disabled = true; const { data, error } = await sb.rpc("booking_coach_remove", { p_id: b.dataset.coach }); if (error) throw error; if (!data.ok) throw new Error(data.error); toast("Removed. The capture will not add them back; paste them to restore."); }
      if (v === "preview") {
        const { data, error } = await sb.rpc("booking_email_preview", { p_email: em });
        if (error) throw error;
        const box = dialog('<div class="bk-mail-head">To ' + esc(data.kind === "coach" ? ((data.to_emails || []).join(", ") || "the coaches on file (none yet)") : (data.to_name ? data.to_name + " " : "") + (data.to_email || "")) + "<strong>" + esc(data.subject) + '</strong></div><div class="bk-mail">' + mdToHtml(data.body) + "</div>" +
          '<div class="og-actions" style="margin-top:14px"><button type="button" data-v="close">Close</button></div>', true);
        box.addEventListener("click", (ev) => { if (ev.target.closest('button[data-v="close"]')) box.close(); });
        return;
      }
      if (v === "sendnow") { if (!confirm("Send this email now?")) return; b.disabled = true; const { data, error } = await sb.rpc("booking_send_now", { p_email: em }); if (error) throw error; if (!data.ok) throw new Error(data.error); toast(data.sending_enabled ? "Sending\u2026" : "Queued. Sending is turned off, so it waits."); }
      if (v === "resend") { if (!confirm("Send this email again to the same person?")) return; b.disabled = true; const { data, error } = await sb.rpc("booking_resend", { p_email: em }); if (error) throw error; if (!data.ok) throw new Error(data.error); toast(data.sending_enabled ? "Resending\u2026" : "Queued. Sending is turned off, so it waits."); }
      if (v === "setcode") { const code = el("bkDCode").value.trim(); if (!code) return toast("Type the access code first.", true); b.disabled = true; const { data, error } = await sb.rpc("booking_set_access_code", { p_id: detail.id, p_code: code, p_retake: el("bkDRetake").value || null }); if (error) throw error; if (!data.ok) throw new Error(data.error); toast("School created on the hub."); }
      if (v === "linkjob") { const job = el("bkDJob").value; if (!job) return toast("Pick the job first.", true); b.disabled = true; const { data, error } = await sb.rpc("booking_link_job", { p_id: detail.id, p_job: job }); if (error) throw error; if (!data.ok) throw new Error(data.error); toast("Linked. Email 0 goes out in about 10 minutes."); }
      if (v === "unlinkjob") { if (!confirm("Unlink the GotPhoto job? Email 0 waits again if it has not gone out.")) return; const { error } = await sb.rpc("booking_link_job", { p_id: detail.id, p_job: null }); if (error) throw error; toast("Unlinked."); }
      if (v === "adopt") { b.disabled = true; const { data, error } = await sb.rpc("booking_adopt_calendar_date", { p_id: detail.id }); if (error) throw error; if (!data.ok) throw new Error(data.error); toast("Picture day is now " + fmtDay(data.picture_day) + ". Emails rescheduled."); }
      if (v === "rewrite") { b.disabled = true; const { error } = await sb.rpc("booking_rewrite_calendar", { p_id: detail.id }); if (error) throw error; toast("Rewriting the event\u2026"); pollNew = detail.id; mountTab(h.parentNode, detail.id); return; }
      if (v === "cancel") {
        if (!confirm("Cancel this booking? Unsent emails stop and the calendar event is removed.")) return;
        b.disabled = true; const { data, error } = await sb.rpc("booking_cancel", { p_id: detail.id }); if (error) throw error; if (!data.ok) throw new Error(data.error);
        toast("Booking cancelled."); load(true); loadAttention(); await reloadJob(); return;
      }
      await refreshDetail(); load(true); loadAttention();
    } catch (e2) { toast(cleanErr(e2), true); b.disabled = false; }
  });
  }

  // Edit booking (the job page's header button): the full booking, then the same form as Book a job.
  async function editId(id) {
    const { data, error } = await sb.rpc("admin_booking_detail", { p_id: id });
    if (error || !data) { toast(error ? cleanErr(error) : "Booking not found.", true); return; }
    openForm(data);
  }
  // The job page's Booking tab (order 12: after Overview, before Crew). Registered once every file has run.
  const addJobTab = () => registerJobTab({ id: "booking", label: "Booking", order: 12, module: "bookings", render: (bk, box) => mountTab(box, bk.id) });
  if (typeof registerJobTab === "function") addJobTab(); else setTimeout(() => { if (typeof registerJobTab === "function") addJobTab(); }, 0);

  // open / openId: a job opens on its page (2026-10-24; tab optional, e.g. "booking" for its emails). preview: All jobs' short drawer.
  return { load: () => load(false), reload: () => load(true), loadAttention, open: (id, tab) => openJob(id, tab), openId: (id, tab) => openJob(id, tab), preview: (id) => openDetail(id),
           edit: editId, openNew: (org) => openForm(null, org || null), hide: () => { if (openId) closeDetail(); }, addSection: (x) => { if (x && x.id && x.html) extraSections.push(x); }, mdToHtml, fill,
    // Settings > Job types (ws/settings): the same dialog; forget cached job types after one is added.
    openJobTypes, resetTypes: () => { types = []; } };
  })();
