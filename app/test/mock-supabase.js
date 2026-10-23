// Fake Supabase for layout/router testing only. No network.
(function () {
  const now = Date.now(), iso = (d) => new Date(now + d * 864e5).toISOString();
  const T = {
    lookup_requests: [{ id: 1, email: "parent@example.com", gotphoto_job_id: "1", status: "pending", created_at: iso(-1), typed: {}, search_data: { affirm: "yes", last_name: "jones" } },
                      { id: 2, email: "p2@example.com", gotphoto_job_id: "1", status: "pending", created_at: iso(-2), typed: {} }],
    sync_runs: [{ trigger_source: "cron", started_at: iso(-0.01), finished_at: iso(-0.009), ok: false, jobs_updated: 0, codes_upserted: 0, error: "timeout" }],
    synced_jobs: [{ gotphoto_job_id: "1", name: "Test Job", job_type: "sports", status: "published", code_count: 3, missing_fields: ["last_name"], shoot_at: iso(3) }],
    prospect_pipeline: [{ enrollment_id: "e1", org_id: "11111111-1111-1111-1111-111111111111", sequence_name: "Winter 2026 Leagues", enrollment_status: "active", org_name: "Brewer Travel Basketball Club", sport: "basketball", town: "Brewer", enrollment_status: "paused", current_step: 0, total_steps: 4, started_at: iso(-1), contact_details: "Chris S <c@x.org>, President", threads_started: 0, thread_count: 8 }],
    prospect_past_outreach: [{ id: "p9", org_name: "Scarborough Youth Football", sport: "football", town: "Scarborough", source: "Mailmeteor + Gmail", emails: ["president@scarboroughyouthfootball.com","secretary@scarboroughyouthfootbal.com","secretary@scarboroughyouthfootball.com"], last_contacted_at: iso(-31).slice(0,10), emails_sent: 4, replied: false, gmail_thread_ids: ["a","b","c"], unsubscribed_emails: [], bounced_emails: ["president@scarboroughyouthfootball.com","secretary@scarboroughyouthfootbal.com"] },
      { id: "p8", org_name: "Milo Elementary School", town: "Milo", source: "Mailmeteor + Gmail", contact_names: "Kristina Dumond", emails: ["kdumond@msad41.us"], last_contacted_at: iso(-47).slice(0,10), emails_sent: 5, replied: false, gmail_thread_ids: ["d"], unsubscribed_emails: ["kdumond@msad41.us"], bounced_emails: [] },
      { id: "p7", org_name: "Indian Island School", town: "Indian Island", source: "Mailmeteor + Gmail", contact_names: "Mingwun Dana", emails: ["mingwun.dana@example.org"], last_contacted_at: iso(-46).slice(0,10), emails_sent: 5, replied: true, reply_note: "I would love to touch base about next school year. Unfortunately this year won't be an option, but we can look at next year. Thank you! On Wed, Aug 12, 2026 at 9:06 AM Jeremiah wrote:", gmail_thread_ids: ["e"], unsubscribed_emails: [], bounced_emails: [] },{ id: "p1", org_name: "Presque Isle Youth Hockey", sport: "hockey", town: "Presque Isle", emails: ["coach@piyh.org"], contact_names: "Kim Jordan", last_contacted_at: iso(-30).slice(0,10), emails_sent: 2, replied: true, reply_note: "Asked us to check back in spring", gmail_thread_ids: ["18f00aa"], source: "Gmail import" },
                             { id: "p2", org_name: "Old Town Soccer", emails: ["x@ots.org","y@ots.org"], last_contacted_at: iso(-400).slice(0,10), emails_sent: 1, replied: false, gmail_thread_ids: [], unsubscribed_emails: ["x@ots.org"], bounced_emails: ["y@ots.org"] },
                             { id: "p3", org_name: "Hermon Rec", emails: ["rec@hermon.net"], last_contacted_at: iso(-20).slice(0,10), emails_sent: 3, replied: false, gmail_thread_ids: [] }],
    prospect_followups: [{ id: "f0", org_id: "22222222-2222-2222-2222-222222222222", org_name: "Hancock Grammar School", emails: [], due_on: iso(-1).slice(0,10), note: "Send times to discuss", status: "open", created_at: iso(-30) }, { id: "f1", org_name: "Indian Island School", emails: ["mingwun.dana@example.org"], due_on: iso(-2).slice(0,10), note: "Touch base about next school year", status: "open", created_at: iso(-60) },
                         { id: "f2", org_name: "South Bristol School", emails: ["katie@example.org"], due_on: iso(90).slice(0,10), note: "Contact Katie early in 2027", status: "open", created_at: iso(-20) }],
    prospect_orgs: [
      { id: "11111111-1111-1111-1111-111111111111", name: "Brewer Travel Basketball Club", name_known: true, audience: "league", stage: "contacting", service_status: { portraits: "prospect" }, sports: ["basketball"], seasons: ["winter"], town: "Brewer", website: "brewertravel.org", notes: "Met Chris at the fall tourney", source: "Claude in Chrome", last_contact_at: iso(-1), last_result: "In progress", next_action_at: iso(1), next_action: "Email 2 to Chris", needs_new_contact: false, search_text: "brewer travel basketball club brewer chris snowdeal csnowdeal75@gmail.com", created_at: iso(-3) },
      { id: "22222222-2222-2222-2222-222222222222", name: "Hancock Grammar School", name_known: true, audience: "school", stage: "talking", service_status: { portraits: "client", school_photos: "prospect" }, sports: [], seasons: ["fall", "spring", "winter"], town: "Hancock", last_contact_at: iso(-40), last_result: "Replied", next_action_at: iso(-1), next_action: "Follow up: They said: Send me some times we can discuss!", needs_new_contact: false, search_text: "hancock grammar school", created_at: iso(-2) },
      { id: "33333333-3333-3333-3333-333333333333", name: "scarboroughll", name_known: false, audience: "league", stage: "no_reply", sports: ["baseball"], seasons: ["spring"], town: null, last_contact_at: iso(-300), last_result: "Bounced", next_action_at: null, next_action: null, needs_new_contact: true, search_text: "scarboroughll", created_at: iso(-2) },
      { id: "44444444-4444-4444-4444-444444444444", name: "Island Cheer & Tumbling", name_known: true, audience: "league", stage: "new", sports: ["cheer"], seasons: ["winter"], town: "Deer Isle", last_contact_at: null, last_result: null, next_action_at: null, next_action: "Ready to send", needs_new_contact: false, search_text: "island cheer tumbling deer isle", created_at: iso(-1) }],
    prospect_contacts: [
      { id: "c1", org_id: "11111111-1111-1111-1111-111111111111", first_name: "Chris", last_name: "Snowdeal", email: "csnowdeal75@gmail.com", role: "President", is_primary: true, service_roles: { portraits: "main" }, history_only: false, created_at: iso(-3) },
      { id: "c2", org_id: "11111111-1111-1111-1111-111111111111", first_name: "Jamie", last_name: "Emerson", email: "jemerson@breweredu.org", is_primary: false, history_only: false, created_at: iso(-3) },
      { id: "c3", org_id: "33333333-3333-3333-3333-333333333333", email: "info@scarboroughlittleleague.org", bounced_at: iso(-300), history_only: true, created_at: iso(-2) },
      { id: "c4", org_id: "22222222-2222-2222-2222-222222222222", first_name: "Pat", last_name: "Lee", email: "plee@hancock.k12.me.us", history_only: true, created_at: iso(-2) }, { id: "c5", org_id: "44444444-4444-4444-4444-444444444444", email: "info@islandcheer.com", history_only: false, created_at: iso(-1) },
      // main contact per service (2026-10-24): the AD books sports, we pitch the principal for school photos
      { id: "c6", org_id: "22222222-2222-2222-2222-222222222222", first_name: "Dan", last_name: "Pratt", email: "dpratt@hancock.k12.me.us", role: "Athletic Director", is_primary: true, service_roles: { portraits: "main" }, history_only: false, created_at: iso(-5) },
      { id: "c7", org_id: "22222222-2222-2222-2222-222222222222", first_name: "Lisa", last_name: "Moreau", email: "lmoreau@hancock.k12.me.us", role: "Principal", is_primary: true, service_roles: { school_photos: "main" }, history_only: false, created_at: iso(-5) },
      { id: "c8", org_id: "22222222-2222-2222-2222-222222222222", first_name: "Tammy", last_name: "Lee", email: "tlee@hancock.k12.me.us", role: "Secretary", is_primary: false, service_roles: { portraits: "copy" }, history_only: false, created_at: iso(-5) }],
    prospect_contact_status: [
      { contact_id: "c1", org_id: "11111111-1111-1111-1111-111111111111", status: "sent", steps_sent: 1, steps_total: 4, next_send_at: iso(1) },
      { contact_id: "c2", org_id: "11111111-1111-1111-1111-111111111111", status: "queued", steps_sent: 0, steps_total: 4, next_send_at: iso(2) },
      { contact_id: "c3", org_id: "33333333-3333-3333-3333-333333333333", status: "bounced" },
      { contact_id: "c4", org_id: "22222222-2222-2222-2222-222222222222", status: "replied" }],
    prospect_activities: [
      { id: "a1", org_id: "11111111-1111-1111-1111-111111111111", contact_id: "c1", kind: "email_sent", subject: "Picture day for Brewer Travel", gmail_thread_id: "t1", meta: { step: 1 }, occurred_at: iso(-1) },
      { id: "a2", org_id: "11111111-1111-1111-1111-111111111111", kind: "stage_change", body: "First email sent", meta: { from: "new", to: "contacting", auto: true }, occurred_at: iso(-1) },
      { id: "a3", org_id: "11111111-1111-1111-1111-111111111111", kind: "note", body: "Met Chris at the fall tourney. Wants spring dates too.", meta: {}, occurred_at: iso(-2) },
      { id: "a4", org_id: "22222222-2222-2222-2222-222222222222", contact_id: "c4", kind: "reply", body: "Hello - I am interested. Send me some times we can discuss! We are looking at options for next year and would love to hear more about how picture day works with you.", meta: { history: true, thread_ids: ["x1"] }, occurred_at: iso(-40) },
      { id: "a5", org_id: "22222222-2222-2222-2222-222222222222", kind: "history_email", subject: "School Photos - 2026-27 School Year", body: "5 emails sent between Jul 20, 2026 and Aug 12, 2026 to plee@hancock.k12.me.us (Mailmeteor + Gmail)", meta: { thread_ids: ["x1", "x2"] }, occurred_at: iso(-41) }],
    prospect_scheduled_emails: [
      { id: "m1", org_id: "11111111-1111-1111-1111-111111111111", contact_id: "c1", enrollment_id: "e1", thread_id: "t1", step_no: 1, subject: "Brewer Travel Basketball Club picture day", body: "Hi Chris!\n\nWe're filling our winter calendar now...", status: "sent", sent_at: iso(-1), send_at: iso(-1), open_count: 2, gmail_thread_id: "g1", created_at: iso(-2) },
      { id: "m2", org_id: "11111111-1111-1111-1111-111111111111", contact_id: "c1", enrollment_id: "e1", thread_id: "t1", step_no: 2, subject: "Brewer Travel Basketball Club picture day", body: "Hi Chris, one more thing worth seeing.\n\nHere are some of our winter team photos...", status: "scheduled", send_at: iso(2), created_at: iso(-2) },
      { id: "m3", org_id: "11111111-1111-1111-1111-111111111111", contact_id: "c2", enrollment_id: "e1", thread_id: "t2", step_no: 1, subject: "Brewer Travel Basketball Club picture day", body: "Hi Jamie!\n\nWe're filling our winter calendar now...", status: "scheduled", send_at: iso(1), created_at: iso(-2) },
      { id: "m4", org_id: "44444444-4444-4444-4444-444444444444", contact_id: "c5", enrollment_id: "e4", thread_id: "t4", step_no: 1, subject: "Island Cheer & Tumbling picture day", body: "Hey there!\n\nLooks like your teams are already practicing, so I wanted to reach out before the season gets too busy.\n\nI'm Jeremiah with 207 Photo...", status: "held", needs_review: true, send_at: iso(0.2), created_at: iso(-0.5) }],
    prospect_sequences: [{ id: "q1", key: "winter-2026-leagues", name: "Winter 2026 Leagues", audience: "league", is_active: true, sports: [], seasons: ["winter"] }, { key: "cheer-gyms-2026-27", name: "Cheer Gyms 2026-27 (intro only)", audience: "league", is_active: true }],
    prospect_snippets: [{ id: "s1", kind: "quote", title: "Brewer Youth Hockey", body: "Brewer Youth Hockey has used us every season since 2018...", sports: ["hockey"], audience: "league", is_active: true, used_count: 3 },
      { id: "s2", kind: "quote", title: "Bangor Soccer Club", body: "Bangor Soccer Club runs 700+ players through picture day with us every spring.", sports: ["soccer"], audience: "league", is_active: true, used_count: 1 }],
    prospect_sequence_steps: [{ id: "st1", sequence_id: "q1", step_no: 1, delay_business_days: 0, subject: "{{league|winter}} picture day", body: "{{hi|Hey there}}!\n\n{{personal_line|We're filling our winter calendar now.}}", attachments: [{ path: "portfolio.pdf", filename: "207 Photo - Team & Individual Photos.pdf" }] },
      { id: "st2", sequence_id: "q1", step_no: 2, delay_business_days: 3, subject: null, body: "{{hi|Hey there}}, one more thing worth seeing.", attachments: [] }],
    prospect_saved_views: [],
    saved_views: [{ id: "sv1", user_id: "u1", page: "taskboard", name: "Editing this week", config: { who: "g:g1", show: "open", checklist: true }, shared: true, sort: 0 }],
    staff_group_members: [{ group_id: "g1", user_id: "u2" }],
    bookings: [{ id: "bk1", type_key: "sports_data" }, { id: "bk2", type_key: "school" }, { id: "bk3", type_key: "sports_nodata" }],
    inventory_bins: [{ id: "bin1", code: "A1", location: "Studio shelf" }], inventory_kits: [{ id: "kit1", name: "Kit 1" }],
    app_modules: [
      { key: "bookings", label: "Bookings", section: "Jobs", description: "Picture-day bookings.", sort: 10, status: "live", admin_only: false },
      { key: "galleries", label: "Galleries", section: "Jobs", description: "GotPhoto galleries.", sort: 20, status: "live", admin_only: false },
      { key: "hub", label: "Hub", section: "Jobs", description: "Hub activity.", sort: 30, status: "live", admin_only: false },
      { key: "parents", label: "Parent help", section: "Parents", description: "Help requests, makeups, retakes.", sort: 40, status: "live", admin_only: false },
      { key: "findmyphotos", label: "Find My Photos", section: "Parents", description: "Search activity and rules.", sort: 50, status: "live", admin_only: false },
      { key: "partners", label: "Organizations & outreach", section: "Partners", description: "Organizations and outreach.", sort: 60, status: "live", admin_only: false },
      { key: "settings", label: "Settings", section: "System", description: "", sort: 90, status: "live", admin_only: true },
      { key: "team", label: "Team", section: "System", description: "", sort: 95, status: "live", admin_only: true },
      { key: "scheduling", label: "Scheduling", section: "Staff", description: "The week's bar schedule.", sort: 200, status: "live", admin_only: false },
      { key: "timeoff", label: "Time off approvals", section: "Staff", description: "Approve or decline time off requests.", sort: 206, status: "live", admin_only: false },
      { key: "assignments", label: "Assignments", section: "Staff", description: "Daily, weekly and monthly tasks.", sort: 205, status: "live", admin_only: false },
      { key: "taskboard", label: "Task board", section: "Staff", description: "Board, calendar and workload.", sort: 206, status: "live", admin_only: false },
      { key: "staffrecords", label: "Staff records", section: "Staff", description: "Clearances and onboarding.", sort: 215, status: "live", admin_only: false },
      { key: "timeclock", label: "Time clock & mileage", section: "Staff", description: "Clock in and out, timesheets, mileage.", sort: 210, status: "live", admin_only: false },
      { key: "emails", label: "Email delivery", section: "System", description: "Every Resend email and how it went.", sort: 92, status: "live", admin_only: false }],
    prospect_enrollments: [{ org_id: "44444444-4444-4444-4444-444444444444", status: "paused", end_reason: "held for review" }],
    booking_types: [
      { key: "school", label: "School Photos", audience: "school", description: "Four emails: booked, student data (21 days), two weeks, day before. Creates the school on the hub.", title_labels: ["School Photos"], default_duration_min: 180, sort_order: 1 },
      { key: "sports_data", label: "Sports: league with parent contacts", audience: "sports", description: "Two emails: roster request, schedule check (14 days).", title_labels: ["Fall Sports", "Winter Sports", "Spring Sports", "Cheer"], default_duration_min: 60, sort_order: 2 },
      { key: "sports_nodata", label: "Sports: school teams, roster only", audience: "sports", description: "Three emails: roster request, schedule check (14 days), coach checklist (2 days).", title_labels: ["Fall Sports", "Winter Sports", "Spring Sports"], default_duration_min: 60, sort_order: 3 }],
    booking_sequences: [{ id: "bq1", type_key: "school", name: "School photos (4 emails)", is_active: true }, { id: "bq2", type_key: "sports_data", name: "Sports with data (2 emails)", is_active: true }, { id: "bq3", type_key: "sports_nodata", name: "Sports no data (3 emails)", is_active: true }],
    booking_steps: [
      { id: "bs1", sequence_id: "bq1", step_no: 1, label: "You're booked, start here", offset_days: 0, send_time: "07:30:00", subject: "{{org}} picture day is booked: {{picture_day}}", body_md: "Hi {{first_name|there}},\n\nYou're on our calendar! Picture day at {{org}} is **{{picture_day}}**.\n\n**One thing to do today: go to 207photo.com/schooladmin**\n\nWarmly,", is_active: true },
      { id: "bs2", sequence_id: "bq1", step_no: 2, label: "Student data", offset_days: 21, send_time: "07:30:00", subject: "Re: Your Upcoming School Photo Day with 207 Photo", body_md: "Hi {{first_name|there}},\n\n- First Name\n- Last Name\n\nWarmly,", is_active: true },
      { id: "bs3", sequence_id: "bq1", step_no: 3, label: "Two weeks before", offset_days: 14, send_time: "07:30:00", subject: "School Picture Day Reminder - 2 Weeks!", body_md: "Hi {{first_name|there}},", is_active: true },
      { id: "bs4", sequence_id: "bq1", step_no: 4, label: "Day before", offset_days: 1, send_time: "07:30:00", subject: "SCHOOL PICTURE DAY TOMORROW!", body_md: "Hi {{first_name|there}},", is_active: true },
      { id: "bs5", sequence_id: "bq2", step_no: 1, label: "Start here and roster request", offset_days: 0, send_time: "07:30:00", subject: "{{org}} picture day is {{picture_day}}: two things to do today", body_md: "Hello {{first_name|there}},\n\n**1. Go to 207photo.com/sportsadmin**\n\n[Sample CSV](https://docs.google.com/x)", is_active: true },
      { id: "bs10", sequence_id: "bq2", step_no: 10, label: "One week before", kind: "hub", trigger: "picture_day", offset_days: 7, send_time: "07:30:00", hub_key: "heads", subject: "Today: send your \"{{hub_title}}\" message ({{org}})", body_md: "Hi {{first_name|there}},\n\nToday is a send day for {{org}}. {{hub_detail}}\n\n{{hub_link}}", is_active: true },
      { id: "bs12", sequence_id: "bq2", step_no: 12, label: "Photos are online", kind: "hub", trigger: "gallery_live", offset_days: 0, send_time: "07:30:00", hub_key: "live", subject: "x", body_md: "{{live_note}}", is_active: true },
      { id: "bs6", sequence_id: "bq2", step_no: 2, label: "Schedule check and coach checklist", offset_days: 14, send_time: "07:30:00", subject: "{{org}}: schedule for picture day {{picture_day}}", body_md: "Hi {{first_name|there}},\n\n**{{picture_day}} starting at {{start_time}}**", is_active: true },
      { id: "bs7", sequence_id: "bq3", step_no: 1, label: "Start here and roster request", offset_days: 0, send_time: "07:30:00", subject: "{{org}} picture day", body_md: "Hello,", is_active: true },
      { id: "bs8", sequence_id: "bq3", step_no: 2, label: "Schedule check", offset_days: 14, send_time: "07:30:00", subject: "{{org}}: schedule", body_md: "Hi,", is_active: true },
      { id: "bs9", sequence_id: "bq3", step_no: 3, label: "Coach checklist", offset_days: 2, send_time: "07:30:00", subject: "Picture day is {{picture_day}}: coach checklist", body_md: "Hi,", is_active: true }],
    booking_settings: { id: true, sending_enabled: false, test_mode: false, test_recipient: null, bcc: null, from_name: "Jeremiah Mutty", from_email: "jmutty@207photo.com", signature: "Jeremiah & The 207 Photo Team", quiet_start: "21:00:00", quiet_end: "07:00:00", day0_delay_min: 10 },
    prospect_settings: { track_opens: true, cooldown_months: 6, paused: false, test_mode: false, daily_cap: 40, send_days: [1,2,3,4,5], send_window_start_hour: 17, send_window_end_hour: 20, send_windows: {} },
  };
  // Job stages per type + saved deliverables (2026-10-21)
  T.booking_stages = [];
  ["school", "sports_data", "sports_nodata"].forEach((k) => [["Booked", "booked"], ["Picture day done", "picture_day"], ["In production", null], ["Job launched", "gallery_live"], ["Deliverables sent", "deliverables_done"], ["Complete", null]]
    .forEach(([label, auto], i) => T.booking_stages.push({ id: "st-" + k + "-" + i, type_key: k, label, sort: (i + 1) * 10, auto, archived_at: null })));
  T.booking_tracking_settings = { id: true, auto_track: false };
  T.deliverable_templates = [
    { id: "dt1", type_key: "sports_data", label: "Team composites", due_days: 21, auto_add: true, sort: 10, archived_at: null },
    { id: "dt2", type_key: "sports_data", label: "Banner proofs", due_days: 14, auto_add: false, sort: 20, archived_at: null },
    { id: "dt3", type_key: "school", label: "Yearbook files", due_days: 30, auto_add: true, sort: 10, archived_at: null },
    { id: "dt4", type_key: null, label: "Thank-you card", due_days: null, auto_add: false, sort: 10, archived_at: null }];
  function q(table) {
    let single = false, head = false; const filt = [];
    const res = () => {
      let d = T[table] !== undefined ? T[table] : [];
      if (Array.isArray(d)) d = d.filter((r) => filt.every((f) => f(r)));
      if (single && Array.isArray(d)) d = d[0] || null;
      if (!single && !Array.isArray(d)) d = [d];
      return { data: head ? null : d, error: null, count: Array.isArray(d) ? d.length : 1 };
    };
    const p = new Proxy({}, { get(_, k) {
      if (k === "then") return (a, b) => Promise.resolve(res()).then(a, b);
      if (k === "single" || k === "maybeSingle") return () => { single = true; return p; };
      if (k === "select") return (_c, o) => { if (o && o.head) head = true; return p; };
      if (k === "eq") return (c, v) => { filt.push((r) => r[c] === undefined || r[c] === v); return p; };
      if (k === "in") return (c, v) => { filt.push((r) => v.includes(r[c])); return p; };
      if (k === "ilike") return (c, v) => { const needle = String(v).replace(/%/g, "").toLowerCase(); filt.push((r) => String(r[c] || r.name || "").toLowerCase().includes(needle)); return p; };
      if (k === "insert" || k === "update" || k === "delete") return (row) => { window.__writes = (window.__writes || []).concat([[table, k, row]]); return p; };
      return () => p;
    } });
    return p;
  }
  window.__rpcCalls = [];
  // ?as=staff signs in as a limited team member (bookings edit, parents view) instead of the owner.
  const AS_STAFF = /[?&]as=staff\b/.test(location.search);
  // ?as=viewer: bookings view only (read-only booking panel).
  const AS_VIEWER = /[?&]as=viewer\b/.test(location.search);
  const AS_GEAR = /[?&]as=gear\b/.test(location.search);
  // ?as=parttime: a part-time photographer (Open jobs view only).
  const AS_PART = /[?&]as=parttime\b/.test(location.search);
  // ?as=money: Season results view only.
  const AS_MONEY = /[?&]as=money\b/.test(location.search);
  const RPC = {
    my_access: AS_PART ? { user_id: "u6", email: "pat@207photo.com", name: "Pat Parttime", is_admin: false, active: true, trusted: true, must_change_password: false, modules: { openjobs: "view" } }
      : AS_MONEY ? { user_id: "u6", email: "bo@207photo.com", name: "Bo Books", is_admin: false, active: true, trusted: true, must_change_password: false, modules: { results: "view" } }
      : AS_GEAR ? { user_id: "u5", email: "gus@207photo.com", name: "Gus Shooter", is_admin: false, active: true, trusted: true, must_change_password: false, modules: { inventory: "view" } }
      : AS_VIEWER ? { user_id: "u4", email: "vic@207photo.com", name: "Vic Viewer", is_admin: false, active: true, trusted: true, must_change_password: false, modules: { bookings: "view" } }
      : AS_STAFF ? { user_id: "u2", email: "sam@207photo.com", name: "Sam Helper", is_admin: false, active: true, trusted: true, must_change_password: /[?&]temp=1\b/.test(location.search), modules: { bookings: "edit", parents: "view", scheduling: "view", assignments: "view", staffrecords: "view", timeclock: "view", taskboard: "view" } }
      : { user_id: "u1", email: "test@207photo.com", name: "Jeremiah Mutty", is_admin: true, active: true, trusted: true, must_change_password: false, modules: {} },
    team_list: [{ user_id: "u1", email: "test@207photo.com", name: "Jeremiah Mutty", is_admin: true, is_me: true, active: true, must_change_password: false, weekly_hours: 40, employment_type: "salaried", job_title: "Owner", last_sign_in_at: iso(-0.01), modules: {} },
      { user_id: "u2", email: "sam@207photo.com", name: "Sam Helper", is_admin: false, is_me: false, active: true, must_change_password: true, last_sign_in_at: null, modules: { bookings: "edit", parents: "view" } },
      { user_id: "u3", email: "old@207photo.com", name: "Former Staff", is_admin: false, is_me: false, active: false, must_change_password: false, last_sign_in_at: iso(-90), modules: { partners: "view" } }],
    team_audit_list: [{ at: iso(-0.5), action: "updated", actor: "Jeremiah Mutty", target: "Sam Helper" }, { at: iso(-1), action: "roles_set", actor: "Jeremiah Mutty", target: "Sam Helper" },
      { at: iso(-1), action: "welcome_sent", actor: "Jeremiah Mutty", target: "Sam Helper" }, { at: iso(-1), action: "added", actor: "Jeremiah Mutty", target: "Sam Helper" }],
    team_save: { ok: true }, me_password_changed: null,
    push_my_settings: { vapid_public: "BKz8kzZpH3b3FVt5JQq0C4f4vFq2l7yqzG0oQ6tVq2zrI8mN2l6Qy6X7cJq3yH4m1nV7pP3s2wT8kL5dR9e1aF0", devices: [{ id: "d1", label: "iPhone \u00b7 Safari", endpoint: "https://web.push.apple.com/abc", created_at: iso(-3), last_ok_at: iso(-1) }],
      topics: AS_STAFF ? [{ key: "help_request", label: "New help request", description: "A parent asked for help finding their access code.", enabled: true }]
        : [{ key: "help_request", label: "New help request", description: "A parent asked for help finding their access code.", enabled: true },
           { key: "booking_email_failed", label: "Booking email failed", description: "A booking email could not be sent.", enabled: false },
           { key: "sync_failed", label: "GotPhoto sync failing", description: "The GotPhoto sync started failing.", enabled: true }] },
    push_set_pref: null, push_set_mode: null, push_subscribe: { ok: true }, push_unsubscribe: null, push_test: { ok: true }, push_request_setup: null,
    admin_outbox: [
      { src: "outreach", id: "ob1", at: iso(0.1), to_name: "Island Cheer", to_email: "info@islandcheer.com", org: "Island Cheer & Tumbling", org_id: "44444444-4444-4444-4444-444444444444", subject: "Island Cheer picture day", detail: "Outreach, email 1", status: "needs_review", enrollment_id: "e9" },
      { src: "booking", id: "ob2", at: iso(-1), to_name: "Chris Snowdeal", to_email: "c@x.org", org: "Brewer Travel Basketball Club", booking_id: "b1", subject: "You're booked, start here", detail: "Booking email 1", status: "failed", error: "Gmail refused the send" },
      { src: "booking", id: "ob3", at: iso(0.2), to_name: "Chris Snowdeal", to_email: "c@x.org", org: "Brewer Travel Basketball Club", booking_id: "b1", subject: "Rosters and the parent flyer", detail: "Booking email 2", status: "waiting" },
      { src: "hub", id: "ob4", at: iso(0.3), to_name: "Chris Snowdeal, Jamie Emerson", org: "Brewer Travel Basketball Club", subject: "Today is a send day: One week before", detail: "Hub reminder, sports", status: "scheduled" },
      { src: "digest", id: "digest", at: iso(1), to_name: "jmutty@207photo.com, info@207photo.com", org: "The Today page, by email", subject: "Today at 207 Photo", detail: "Morning digest", status: "scheduled" },
      { src: "outreach", id: "ob5", at: iso(2), to_name: "Chris Snowdeal", to_email: "c@x.org", org: "Brewer Travel Basketball Club", org_id: "11111111-1111-1111-1111-111111111111", subject: "One more thing worth seeing", detail: "Outreach, email 2", status: "scheduled", enrollment_id: "e1" },
      { src: "outreach", id: "ob6", at: iso(-3), sent_at: iso(-3), to_name: "Pat Lee", to_email: "plee@hancock.k12.me.us", org: "Hancock Grammar School", subject: "School photos next year", detail: "Outreach, email 5", status: "sent" }],
    admin_bookings: [
      { id: "bk1", org_id: "11111111-1111-1111-1111-111111111111", org_name: "Brewer Travel Basketball Club", org_town: "Brewer", type_key: "sports_data", type_label: "Sports: league with parent contacts", audience: "sports", title: "Winter Sports \u2022 Brewer Travel Basketball Club", title_label: "Winter Sports", picture_day: iso(12).slice(0,10), start_at: iso(12), end_at: iso(12.05), duration_min: 60, location: "Brewer Auditorium", notes: "after practice", status: "booked", calendar_status: "synced", google_event_id: "evt123", contacts: [{ id: "c1", name: "Chris Snowdeal", email: "csnowdeal75@gmail.com" }], emails_total: 2, emails_sent: 1, emails_failed: 0, emails_waiting: 0, next_send_at: iso(-2) },
      { id: "bk2", org_id: "22222222-2222-2222-2222-222222222222", org_name: "Hancock Grammar School", org_town: "Hancock", type_key: "school", type_label: "School Photos", audience: "school", title: "School Photos \u2022 Hancock Grammar School", title_label: "School Photos", picture_day: iso(25).slice(0,10), start_at: iso(25), end_at: iso(25.1), duration_min: 180, location: "Hancock",
        // three shoot days with a gap (a list of dates, never "day 25 to day 28")
        days: [25, 26, 28].map((n, i) => ({ id: "bd2-" + i, day: iso(n).slice(0, 10), start_at: iso(n), end_at: iso(n + 0.1), label: null, sort: i, calendar_status: "synced" })), status: "booked", calendar_status: "pending", google_event_id: null, contacts: [{ id: "c4", name: "Pat Lee", email: "plee@hancock.k12.me.us" }], emails_total: 4, emails_sent: 0, emails_failed: 0, emails_waiting: 1, next_send_at: iso(4) },
      { id: "bk3", org_id: "44444444-4444-4444-4444-444444444444", org_name: "Island Cheer & Tumbling", org_town: "Deer Isle", type_key: "sports_nodata", type_label: "Sports: school teams, roster only", audience: "sports", title: "Cheer \u2022 Island Cheer & Tumbling", title_label: "Cheer", picture_day: iso(3).slice(0,10), start_at: iso(3), end_at: iso(3.05), duration_min: 60, status: "booked", calendar_status: "moved", google_event_id: "evt999", contacts: [], emails_total: 3, emails_sent: 1, emails_failed: 1, emails_waiting: 0, next_send_at: iso(1) }],
    admin_booking_detail: { id: "bk1", org_id: "11111111-1111-1111-1111-111111111111", org_name: "Brewer Travel Basketball Club", org_town: "Brewer", type_key: "sports_data", type_label: "Sports: league with parent contacts", audience: "sports", title: "Winter Sports \u2022 Brewer Travel Basketball Club", title_label: "Winter Sports", picture_day: iso(12).slice(0,10), start_at: iso(12), start_time: "17:00", duration_min: 60, location: "Brewer Auditorium", notes: "after practice", status: "booked", calendar_status: "synced", google_event_id: "evt123",
      contact_ids: ["c1", "c3"], contacts: [{ id: "c1", name: "Chris Snowdeal", email: "csnowdeal75@gmail.com" }, { id: "c3", name: "Dana Utter", email: "dutter@breweredu.org" }], org_contacts: [{ id: "c1", first_name: "Chris", last_name: "Snowdeal", email: "csnowdeal75@gmail.com", role: "President", is_primary: true, chosen: true, emailable: true }, { id: "c3", first_name: "Dana", last_name: "Utter", email: "dutter@breweredu.org", role: "Athletic Director", chosen: true, emailable: false }, { id: "c2", first_name: "Jamie", last_name: "Emerson", email: "jemerson@breweredu.org", chosen: false, emailable: true }],
      emails: [{ id: "e1", step_no: 1, label: "Start here and roster request", to_name: "Chris Snowdeal", to_email: "csnowdeal75@gmail.com", status: "sent", sent_at: iso(-2), send_at: iso(-2), is_resend: false },
               { id: "e2", step_no: 2, label: "Schedule check and coach checklist", to_name: "Chris Snowdeal", to_email: "csnowdeal75@gmail.com", cc_emails: ["jemerson@breweredu.org"], status: "scheduled", send_at: iso(-2), is_resend: false },
               { id: "e3", step_no: 12, kind: "hub", label: "Photos are online", to_name: "Chris Snowdeal", to_email: "csnowdeal75@gmail.com", cc_emails: ["jemerson@breweredu.org", "coach@x.org"], status: "waiting", reason: "gallery not live yet", is_resend: false },
               { id: "e4", step_no: 20, kind: "coach", trigger: "picture_day", offset_days: 2, label: "Coach checklist", to_name: null, to_email: "coach.a@example.org", to_emails: ["coach.a@example.org", "coach.b@example.org"], cc_emails: [], status: "scheduled", send_at: iso(10), is_resend: false },
               { id: "e5", step_no: 21, kind: "coach", trigger: "gallery_live", offset_days: 0, label: "Coach: photos online", to_name: null, to_email: "coach.a@example.org", to_emails: ["coach.a@example.org", "coach.b@example.org"], cc_emails: [], status: "waiting", reason: "gallery not live yet", is_resend: false }],
      coaches: [{ id: "co1", email: "coach.a@example.org", name: "Coach A", source: "reply" }, { id: "co2", email: "coach.b@example.org", name: null, source: "manual" }],
      mirror: null, hub_school: null, gotphoto_job: null, job_candidates: [{ gotphoto_job_id: "1", name: "Brewer Travel Basketball | Winter 2026", picture_day: iso(12).slice(0,10) }], type_labels: ["Fall Sports", "Winter Sports", "Spring Sports", "Cheer"], emails_total: 2, emails_sent: 1 },
    admin_retakes: [
      { id: "rt1", job_id: "9001", school: "Hampden Academy", retake_day: new Date(Date.now() + 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" }), access_code: "cffg2eq2", child: "Emma Smith", group: "4 - Brown", reasons: ["Eyes closed", "Hair"], notes: [{ at: iso(-0.2), text: "Glasses off please" }, { at: iso(-0.1), text: "Also fix hair" }], parent_name: "Pat Parent", parent_email: "pat@example.org", created_at: iso(-0.2), updated_at: iso(-0.1), pulled_at: null },
      { id: "rt2", job_id: "9001", school: "Hampden Academy", retake_day: new Date(Date.now() + 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" }), access_code: "ab12cd34", child: "Noah Lee", group: "2 - Ludden", reasons: ["Smile"], notes: [], parent_name: "Sam Lee", parent_email: "sam@example.org", created_at: iso(-3), updated_at: iso(-3), pulled_at: iso(-2), pulled_by: "Office Mac mini" },
      { id: "rt3", job_id: "9002", school: "Milbridge Elementary School", retake_day: iso(9).slice(0, 10), access_code: "zz99yy88", child: "Ava Gray", group: "K - Beal", reasons: [], notes: [{ at: iso(-5), text: "She was sick that day and looks tired" }], parent_name: "Jo Gray", parent_email: "jo@example.org", created_at: iso(-5), updated_at: iso(-5), pulled_at: null }],
    admin_retake_delete: null,
    admin_retake_mark_handled: null,
    admin_booking_progress: [{ booking_id: "bk1", stage_id: "st-sports_data-2", deliverables_total: 3, deliverables_open: 2, next_due: iso(-1).slice(0, 10), overdue: 1 },
      { booking_id: "bk2", stage_id: "st-school-0", deliverables_total: 0, deliverables_open: 0, next_due: null, overdue: 0 }],
    admin_booking_tracking: { stage_id: "st-sports_data-2", stage_at: iso(-1), last_day: iso(12).slice(0, 10),
      stages: [["Booked", "booked"], ["Picture day done", "picture_day"], ["In production", null], ["Job launched", "gallery_live"], ["Deliverables sent", "deliverables_done"], ["Complete", null]].map(([label, auto], i) => ({ id: "st-sports_data-" + i, label, sort: (i + 1) * 10, auto, archived: false })),
      events: [{ id: 3, label: "In production", auto: false, by: "Jeremiah Mutty", note: null, at: iso(-1) }, { id: 2, label: "Picture day done", auto: true, at: iso(-2) }, { id: 1, label: "Booked", auto: true, at: iso(-20) }],
      deliverables: [{ id: "bd1", template_id: "dt1", label: "Team composites", due_date: iso(-1).slice(0, 10), status: "todo", link: null, note: null },
        { id: "bd2", template_id: null, label: "Coach banner", due_date: iso(10).slice(0, 10), status: "todo", link: null, note: "Two sizes" },
        { id: "bd3", template_id: "dt2", label: "Banner proofs", due_date: iso(-3).slice(0, 10), status: "done", link: "https://www.dropbox.com/sh/x", done_at: iso(-3), done_by_name: "Sam Helper" }],
      templates: [{ id: "dt1", type_key: "sports_data", label: "Team composites", due_days: 21 }, { id: "dt2", type_key: "sports_data", label: "Banner proofs", due_days: 14 }, { id: "dt4", type_key: null, label: "Thank-you card", due_days: null }] },
    admin_deliverables_attention: { overdue: 1 },
    admin_trackable_jobs: [{ gotphoto_job_id: "g10", name: "Gould Academy | School Photos | 2026-2027", status: "published", picture_day: iso(-5).slice(0, 10), type_key: "school", org_id: "22222222-2222-2222-2222-222222222222", org_name: "Hancock Grammar School" },
      { gotphoto_job_id: "g11", name: "Barracudas | Winter | 26-27", status: "created", picture_day: iso(20).slice(0, 10), type_key: "sports_data", org_id: null, org_name: null }],
    booking_track_jobs: { ok: true, added: 1, ids: ["bk9"] }, booking_untrack: { ok: true },
    booking_make_real_suggest: { id: "bk1", org: "Brewer Travel Basketball Club", picture_day: iso(12).slice(0, 10), past: false, has_sequence: true,
      contacts: [{ id: "c1", name: "Kate Hutchinson", email: "kate@example.com", primary: true, usable: true }, { id: "c2", name: null, email: "old@example.com", primary: false, usable: false }],
      events: [{ id: "ev9", title: "Brewer Travel Basketball \u2022 Basketball", start_time: "17:00", end_time: "18:00", matches: true }],
      steps: [{ step_no: 2, subject: "{{org}}: schedule for picture day {{picture_day}}", offset_days: 14, send_day: iso(-2).slice(0, 10), passed: true },
              { step_no: 1, subject: "{{org}} picture day is {{picture_day}}: three things to do today", offset_days: 0, send_day: iso(12).slice(0, 10), passed: true }] },
    booking_make_real: { ok: true, emails: [{ step_no: 1, kind: "admin", subject: "Start here", status: "skipped", reason: "Not needed: already sent from 17hats", to: [], cc: [] },
      { step_no: 10, kind: "hub", subject: "One week before", status: "scheduled", send_at: iso(4), to: ["kate@example.com"], cc: [] }] }, booking_set_auto_track: { ok: true },
    booking_set_stage: { ok: true }, booking_deliverables_add: { ok: true, added: 1 }, booking_deliverable_update: { ok: true }, booking_deliverable_remove: { ok: true },
    admin_bookings_attention: { send_failed: 1, calendar: 1, no_contact: 1, needs_code: 1, needs_job: 1, needs_coaches: 1, sending_enabled: false, test_mode: false },
    booking_coaches_add: { ok: true, added: 1, skipped: 0, seen: 1, coaches: 3 }, booking_coach_remove: { ok: true }, booking_contact_remove: { ok: true },
    // Email the job's contacts (jobpage.js, 2026-10-23)
    job_emails: { contacts: [{ id: "c1", name: "Chris Snowdeal", email: "csnowdeal75@gmail.com", role: "President", why: null }, { id: "c3", name: "Dana Utter", email: "dutter@breweredu.org", role: "Athletic Director", why: "bounced" }],
                  emails: [{ id: "je1", subject: "Gym change", body: "We moved to the small gym.", status: "sent", sent_at: new Date(Date.now() - 3600e3).toISOString(), to_name: "Chris Snowdeal", to_email: "csnowdeal75@gmail.com", by: "Jeremiah Mutty" }] },
    job_email_send: { ok: true, ids: ["je2"], emails: 1, now: true, paused: false, test_mode: false },
    booking_create: { ok: true, id: "bk1" }, booking_update: { ok: true, calendar: true }, booking_cancel: { ok: true }, booking_set_access_code: { ok: true, hub_school_id: "s1" },
    booking_email_preview: { id: "e2", subject: "Brewer Travel Basketball Club: schedule for picture day Tuesday, November 10", body: "Hi Chris,\n\nPicture day is coming up. Here is what we have on file:\n\n**Tuesday, November 10 starting at 5:00 PM**\n\n**What we need back from you**\n- **Roster,** if we do not have it yet.\n- **Schedule.** Send the order.\n\nThanks,\n\nJeremiah & The 207 Photo Team", to_email: "csnowdeal75@gmail.com", to_name: "Chris Snowdeal" },
    booking_send_now: { ok: true, sending_enabled: false }, booking_resend: { ok: true, sending_enabled: false }, booking_adopt_calendar_date: { ok: true, picture_day: "2026-11-12" }, booking_rewrite_calendar: { ok: true }, booking_link_job: { ok: true },
    prospect_prior_contact: { cooldown_months: 6, matches: [{ source: "gmail", org_name: "Presque Isle Youth Hockey", matched_on: ["name", "domain"], emails: ["coach@piyh.org"], first_at: iso(-40), last_at: iso(-30), emails_sent: 2, replied: true, reply_note: "Asked us to check back in spring", status: null, thread_ids: ["18f00aa"], within_cooldown: true, is_client: true, do_not_email: ["gone@piyh.org"] }, { source: "gmail", org_name: "Portland School 0", matched_on: ["domain"], emails: ["p0@portlandschools.org"], last_at: iso(-40), emails_sent: 5, replied: false, thread_ids: [], within_cooldown: true }, { source: "gmail", org_name: "Portland School 1", matched_on: ["domain"], emails: ["p1@portlandschools.org"], last_at: iso(-40), emails_sent: 5, replied: false, thread_ids: [], within_cooldown: true }, { source: "gmail", org_name: "Portland School 2", matched_on: ["domain"], emails: ["p2@portlandschools.org"], last_at: iso(-40), emails_sent: 5, replied: false, thread_ids: [], within_cooldown: true }, { source: "gmail", org_name: "Portland School 3", matched_on: ["domain"], emails: ["p3@portlandschools.org"], last_at: iso(-40), emails_sent: 5, replied: false, thread_ids: [], within_cooldown: true }] }, prospect_enroll_org: { enrollment_id: 'e9', emails: 4, sequence: 'Winter 2026 Leagues' }, prospect_approve: { ok: true }, prospect_send_now: { ok: true, sending: 1, paused: false, test_mode: false }, prospect_import_orgs: { added: 1, matched: 1, contacts: 2, enrolled: 1, notes: ["x@y.org is already on Brewer Travel, left there"] }, prospect_sequence_rank: [{ key: "winter-2026-leagues", name: "Winter 2026 Leagues", score: 13, reason: "same season, general" }, { key: "cheer-gyms-2026-27", name: "Cheer Gyms 2026-27 (intro only)", score: 3, reason: "same season" }], admin_hub_activity: [{ hub: "sports", org_id: "gp1", org: "Hampden Little League", picture_day: iso(-3).slice(0,10), late_count: 1,
    sends: [{ key: "heads", title: "One week before", status: "late", grabs: 0, formats: [], who: [] }, { key: "day-2026-11-01", title: "Day before", status: "grabbed", grabs: 2, formats: ["email", "text"], who: ["pat@hll.org"], last_at: iso(-1) }], watchers: [{ id: "w1", name: "Pat Lee", email: "pat@hll.org", since: iso(-10) }] }, { hub: "school", org_id: "s1", org: "Testville Elementary", picture_day: iso(5).slice(0,10), late_count: 0, sends: [], watchers: [] }], admin_hub_watcher_add: { ok: true, id: "w2", result: "added" }, admin_hub_watcher_remove: { ok: true }, admin_hub_watcher_update: { ok: true } };
  // ?tracked=1: the open booking is a track-only job
  if (/[?&]tracked=1\b/.test(location.search)) Object.assign(RPC.admin_booking_detail, { status: "tracked", contacts: [], emails: [], gotphoto_job: { gotphoto_job_id: "1", name: "Brewer Travel Basketball | Winter 2026", gp_activated_at: null } });
  // Inventory: two bins, a kit in the van, a camera checked out to Sam and the kit out to Gus (late).
  Object.assign(T, {
    inventory_bins_v: [
      { id: "ib1", code: "A-01", location: "Studio, back shelf", note: "", photo_path: "bins/ib1/1.jpg", item_count: 3, kit_count: 0, preview: "AA batteries, Canon R6 body, Gaffer tape" },
      { id: "ib2", code: "V-1", location: "Van", note: "Behind the driver seat", photo_path: null, item_count: 0, kit_count: 1, preview: null }],
    inventory_kits_v: [{ id: "ik1", name: "Sports kit 1", note: "", photo_path: null, bin_id: "ib2", bin_code: "V-1", bin_location: "Van", item_count: 2,
      checkout_id: 2, holder_user: "u5", holder_name: "Gus Shooter", out_at: iso(-3), due_on: iso(-1).slice(0, 10) }],
    inventory_items_v: [
      { id: "ii1", name: "AA batteries", qty: 24, serial: "", note: "", photo_path: null, bin_id: "ib1", kit_id: null, place_bin_id: "ib1", bin_code: "A-01", bin_location: "Studio, back shelf", kit_name: null, checkout_id: null, holder_name: null, value: null, purchase_price: null },
      { id: "ii2", name: "Canon R6 body", qty: 1, serial: "SN-12345", note: "Main body", photo_path: "items/ii2/1.jpg", bin_id: "ib1", kit_id: null, place_bin_id: "ib1", bin_code: "A-01", bin_location: "Studio, back shelf", kit_name: null,
        checkout_id: 1, holder_user: "u2", holder_name: "Sam Helper", out_at: iso(-1), due_on: iso(2).slice(0, 10), out_with_kit: false,
        purchased_on: iso(-500).slice(0, 10), purchase_price: 2499, value: 1800, service_every_months: 12, last_service_on: iso(-370).slice(0, 10), next_service_on: iso(-5).slice(0, 10) },
      { id: "ii3", name: "Godox AD600 flash", qty: 1, serial: "GX-9", note: "", photo_path: null, bin_id: null, kit_id: "ik1", place_bin_id: "ib2", bin_code: "V-1", bin_location: "Van", kit_name: "Sports kit 1",
        checkout_id: 2, holder_user: "u5", holder_name: "Gus Shooter", out_at: iso(-3), due_on: iso(-1).slice(0, 10), out_with_kit: true,
        purchased_on: null, purchase_price: 349, value: 300, service_every_months: null, last_service_on: null, next_service_on: null }],
    inventory_service: [{ id: 1, item_id: "ii2", done_on: iso(-370).slice(0, 10), kind: "sensor", cost: 49, note: "Camera shop", created_by: "u1" }],
    inventory_out_v: [
      { id: 1, item_id: "ii2", kit_id: null, what: "Canon R6 body", serial: "SN-12345", holder_user: "u2", holder_name: "Sam Helper", out_at: iso(-1), due_on: iso(2).slice(0, 10), note: "", bin_code: "A-01" },
      { id: 2, item_id: null, kit_id: "ik1", what: "Sports kit 1", serial: "", holder_user: "u5", holder_name: "Gus Shooter", out_at: iso(-3), due_on: iso(-1).slice(0, 10), note: "Hampden", bin_code: "V-1" }],
  });
  Object.assign(RPC, {
    inventory_search: { items: T.inventory_items_v, kits: T.inventory_kits_v, bins: T.inventory_bins_v },
    inventory_people: [{ user_id: "u1", name: "Jeremiah Mutty" }, { user_id: "u2", name: "Sam Helper" }, { user_id: "u5", name: "Gus Shooter" }],
    inventory_check_out: { ok: true, id: 3, holder_name: "Jeremiah Mutty" }, inventory_return: { ok: true },
    inventory_history: [{ id: 2, holder_name: "Gus Shooter", out_at: iso(-3), due_on: null, note: "Hampden", returned_at: null, with_kit: false }],
    inventory_attention: { service_due: 1, gear_missing: 1, past_due: 1, needs_repair: 1 }, inventory_service_log: { ok: true, id: 2 }, inventory_service_remove: { ok: true },
    // Gear per job (2026-10-23): Hampden tomorrow is missing gear; the light stand is at repair.
    inventory_condition_set: { ok: true },
    job_gear_jobs: [{ booking_id: "bkg1", title: "Hampden Rec \u2022 Sports: Parent Contacts", picture_day: iso(1).slice(0, 10), type_label: "Sports: Parent Contacts", lines: 3, got: 1, out: 1 },
      { booking_id: "bkg2", title: "Testville Elementary \u2022 School Photos", picture_day: iso(9).slice(0, 10), type_label: "School Photos", lines: 0, got: 0, out: 0 }],
    job_gear: { can_edit: !AS_GEAR, booking: { id: "bkg1", title: "Hampden Rec \u2022 Sports: Parent Contacts", picture_day: iso(1).slice(0, 10), status: "booked", type_label: "Sports: Parent Contacts" },
      lines: [{ id: "gl1", label: "Sports kit 1", qty: 1, note: "", kit_id: "ik1", item_id: null, from_list: true, got: true, checkout_id: 2, holder_name: "Gus Shooter", returned_at: null, out_what: "Sports kit 1" },
        { id: "gl2", label: "Canon R6 body", qty: 1, note: "Bring both batteries", kit_id: null, item_id: "ii2", from_list: true, got: false, warn: "Out with Sam Helper, due Fri Oct 24" },
        { id: "gl3", label: "AA batteries", qty: 24, note: "", kit_id: null, item_id: null, from_list: true, got: false }],
      extras: [] },
    job_gear_check_out: { ok: true, id: 9, holder_name: "Jeremiah Mutty", line_id: "gl2" }, job_gear_pack: { ok: true }, job_gear_line_add: { ok: true }, job_gear_line_remove: { ok: true },
    gear_templates_list: { can_edit: !AS_GEAR, types: [{ key: "school", label: "School Photos" }, { key: "sports_data", label: "Sports: Parent Contacts" }],
      lines: [{ id: "gt1", type_key: null, kit_id: null, item_id: null, label: "AA batteries", name: "AA batteries", qty: 24, note: "" },
        { id: "gt2", type_key: "sports_data", kit_id: "ik1", item_id: null, label: "", name: "Sports kit 1", qty: 1, note: "" }] },
    gear_template_save: { ok: true }, gear_template_archive: { ok: true },
  });
  T.inventory_items_v.push({ id: "00000000-0000-0000-0000-0000000000a4", name: "Light stand", qty: 1, serial: "", note: "", photo_path: null, bin_id: "ib1", kit_id: null, place_bin_id: "ib1",
    bin_code: "A-01", bin_location: "Studio, back shelf", kit_name: null, checkout_id: null, holder_name: null, condition: "repair", condition_note: "Sent to the shop", condition_since: iso(-2) });
  T.inventory_items_v.forEach((r) => { if (!r.condition) r.condition = "ok"; });
  T.inventory_out_v[1].job_title = "Hampden Rec (Fri Oct 24)";
  // Labels: a stand-in for the QR library (the real one loads from jsDelivr).
  window.qrcode = () => ({ addData() {}, make() {}, createSvgTag: () => '<svg class="fake-qr" viewBox="0 0 1 1"></svg>' });
  // Season results (2026-10-22): two falls, a winter and a spring of jobs; Brewer gets 10%, Hampden 5%.
  {
    const BR = "11111111-1111-1111-1111-111111111111", HG = "22222222-2222-2222-2222-222222222222", IC = "44444444-4444-4444-4444-444444444444";
    const names = { [BR]: "Brewer Travel Basketball Club", [HG]: "Hancock Grammar School", [IC]: "Island Cheer & Tumbling" };
    const pct = { [BR]: 10, [HG]: 5 };
    const job = (id, name, org, day, type, season, year, sales, orders, extra) => {
      const p = org && pct[org] ? pct[org] : 0, due = sales == null ? 0 : Math.round(sales * p) / 100, paid = (extra && extra.paid) || 0;
      return Object.assign({ id, name, org_id: org, org_name: org ? names[org] : null, org_set: false, picture_day: day, job_type: type, booking_type: null, gallery_status: "published",
        season, season_year: year, gp_sales: sales, gp_orders: orders, gp_synced_at: iso(-0.05), gp_error: null, manual_sales: null, manual_orders: null,
        sales, orders, pct: p, pct_source: p ? "partner" : "none", payout_pct: null, payout_amount: null, due, paid, last_paid_on: paid ? "2026-03-02" : null,
        balance: Math.max(due - paid, 0), state: sales == null && p ? "waiting" : !due && !paid ? "none" : paid >= due ? "paid" : "owed", note: "" }, extra || {});
    };
    RPC.results_jobs = [
      job("r1", "Brewer Travel | Fall 2026", BR, "2026-09-19", "sport_other", "fall", 2026, 5200, 118),
      job("r2", "Hancock Grammar | Fall 2026", HG, "2026-09-24", "school_k_12", "fall", 2026, 3100, 96),
      job("r3", "Bangor Rec | Fall Soccer 2026", null, "2026-10-04", "sport_soccer", "fall", 2026, 1800, 52),
      job("r4", "Island Cheer | Fall 2026", IC, "2026-10-18", "sport_other", "fall", 2026, 900, 30),
      job("r5", "Brewer Travel | Fall 2025", BR, "2025-09-20", "sport_other", "fall", 2025, 4600, 104, { paid: 460, gallery_status: "archived" }),
      job("r6", "Hancock Grammar | Fall 2025", HG, "2025-09-25", "school_k_12", "fall", 2025, 2700, 90, { paid: 135, gallery_status: "archived" }),
      job("r7", "Old Town Soccer | Fall 2025", null, "2025-10-11", "sport_soccer", "fall", 2025, 2200, 61, { gallery_status: "archived" }),
      job("r8", "Brewer Travel | Winter 2026", BR, "2026-01-17", "sport_other", "winter", 2026, 3900, 88, { paid: 380, gallery_status: "archived" }),
      job("r9", "Hancock Grammar | Spring 2026", HG, "2026-04-14", "school_k_12", "spring", 2026, 1500, 44, { manual_sales: 1500, gp_sales: 1450 })];
    RPC.results_partners = [{ id: BR, name: names[BR], payout_pct: 10, note: "Partner Plan", jobs: 4 }, { id: HG, name: names[HG], payout_pct: 5, note: "", jobs: 3 },
      { id: IC, name: names[IC], payout_pct: null, note: "", jobs: 1 }];
    RPC.results_payments = [{ id: 1, amount: 380, paid_on: "2026-03-02", method: "Check", ref: "1042", by: "Jeremiah Mutty" }];
    RPC.results_attention = { owed: 2, total: 395 };
    RPC.results_pay = { ok: true, jobs: 2, total: 520 }; RPC.results_save = { ok: true }; RPC.results_set_terms = { ok: true }; RPC.results_payment_remove = { ok: true };
    T.results_settings = { id: true, gp_amount_field: null, gp_amount_cents: false, gp_field_used: "total_net", last_run_at: iso(-0.03), last_run_ok: true, last_run_error: null, last_run_jobs: 12 };
    T.app_modules.push({ key: "results", label: "Season results", section: "Jobs", description: "Sales per job, partner payouts, seasons against last year.", sort: 35, status: "live", admin_only: false });
  }
  // Partner follow-through (2026-10-22): rebooking, reviews, agreements, and the public #agree page.
  {
    const day = (n) => iso(n).slice(0, 10);
    const A = "11111111-1111-1111-1111-111111111111", H = "22222222-2222-2222-2222-222222222222";
    T.partner_followup_settings = [{ id: true, rebook_lead_days: 75, rebook_subject: "{{league}} {{year}}", rebook_body: "{{hi|Hi there}},", review_auto: true, review_link: "",
      review_subject: "Thank you", review_body: "{{hi}}, {{review_link}}", agreement_subject: "{{title}}", agreement_body: "{{agreement_link}}", agreement_terms: "This agreement is between 207 Photo and {{league}}." }];
    Object.assign(RPC, {
      partner_rebook_list: [
        { org_id: A, name: "Brewer Travel Basketball Club", town: "Brewer", stage: "client", last_date: day(-320), due_on: day(45), days: 45, open: true, job_count: 3, last_job: "League picture day",
          status: "todo", waiting: false, email: null, contact: { id: "c1", name: "Chris Snowdeal", email: "csnowdeal75@gmail.com" }, agreement: { status: "accepted", renewal_date: day(40) } },
        { org_id: H, name: "Hancock Grammar School", town: "Hancock", stage: "client", last_date: day(-260), due_on: day(105), days: 105, open: false, job_count: 1, last_job: "",
          status: "todo", waiting: false, email: null, contact: { id: "c4", name: "Pat Lee", email: "plee@hancock.k12.me.us" } }],
      partner_rebook_attention: { due: 1 }, partner_rebook_set: { ok: true },
      partner_reviews_list: [
        { id: "rv1", org_id: A, org: "Brewer Travel Basketball Club", booking_id: "b1", booking_status: "booked", job: "League picture day", picture_day: day(-30), reached_at: iso(-2),
          outcome: "open", quote: "", quote_by: "", saved_quote: false, note: "", email: { id: "m9", status: "review", at: iso(0), to: "csnowdeal75@gmail.com" } },
        { id: "rv2", org_id: H, org: "Hancock Grammar School", booking_id: "b2", booking_status: "tracked", job: "School picture day", picture_day: day(-40), reached_at: iso(-5),
          outcome: "open", quote: "", quote_by: "", saved_quote: false, note: "", email: null }],
      partner_review_log: { ok: true },
      partner_compose: { org_id: A, org: "Brewer Travel Basketball Club", contacts: [{ id: "c1", name: "Chris Snowdeal", email: "csnowdeal75@gmail.com", role: "President", primary: true }, { id: "c2", name: "Jamie Emerson", email: "jemerson@breweredu.org", role: "", primary: false }],
        contact_id: "c1", subject: "Brewer Travel Basketball Club 2027", body: "Hi Chris,\n\nLast year we photographed Brewer Travel Basketball Club on December 6, 2025.", warning: "" },
      partner_queue: { ok: true, email_id: "m10", status: "review" },
      agreements_list: [{ id: "ag1", org_id: A, org: "Brewer Travel Basketball Club", title: "Picture day agreement", status: "sent", picture_day: day(45), sent_at: iso(-3), viewed_at: null,
        renewal_date: day(410), w9_status: "requested", coi_status: "on_file", coi_expires: day(20), token: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2", email: { status: "sent", at: iso(-3) } }],
      agreement_get: { id: "ag1", org_id: A, org: "Brewer Travel Basketball Club", title: "Picture day agreement", status: "sent", picture_day: day(45), job: "League picture day", pricing: "Packages from $25.",
        payout: "15% of sales.", terms: "This agreement is between 207 Photo and {{league}}.", rendered: "This agreement is between 207 Photo and Brewer Travel Basketball Club.", sent_at: iso(-3), viewed_at: null,
        token: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2", renewal_date: day(410), w9_status: "requested", w9_at: null, w9_path: null, coi_status: "on_file", coi_at: day(-100), coi_expires: day(20), coi_path: "ag1/coi-1.pdf",
        note: "", email: { status: "sent", at: iso(-3) }, bookings: [{ id: "b1", picture_day: day(45), label: "League picture day", status: "booked" }] },
      agreement_orgs: [{ id: A, name: "Brewer Travel Basketball Club", town: "Brewer", stage: "client" }],
      agreement_save: { ok: true, id: "ag1" }, agreement_set_status: { ok: true },
      agreements_attention: { renew: 0, coi: 1 },
      agreement_public: { found: true, title: "Picture day agreement", org: "Brewer Travel Basketball Club", picture_day: day(45), status: "sent",
        text: "This agreement is between 207 Photo and Brewer Travel Basketball Club.\n\nPricing\nPackages from $25." },
      agreement_accept: { ok: true, accepted_name: "Chris Snowdeal", accepted_at: iso(0) },
    });
  }
  // Staff records (2026-10-22): owner sees the team; ?as=staff (Sam, view) sees only their own.
  {
    const day = (n) => iso(n).slice(0, 10);
    const steps = [["sp1", "Hiring paperwork", false, null], ["sp2", "Background check", false, "background"], ["sp3", "Watch the training videos", true, null], ["sp4", "Shadow day", false, null]]
      .map(([id, title, self_check, clearance_key], i) => ({ id, title, detail: "", link: id === "sp3" ? "https://example.com/videos" : "", self_check, clearance_key, sort: (i + 1) * 10, archived_at: null }));
    const sam = { user_id: "u2", name: "Sam Helper", is_me: AS_STAFF,
      clearances: [{ type_key: "background", done_on: day(-720), expires_on: day(9), reference: "BC-77", note: "", state: "soon" }],
      onboarding: { started_on: day(-6), finished_at: null, done: [{ step_id: "sp1", done_at: iso(-5), done_by: "Jeremiah Mutty", auto: false }, { step_id: "sp2", done_at: null, done_by: null, auto: true }] } };
    const people = [{ user_id: "u1", name: "Jeremiah Mutty", is_me: !AS_STAFF, clearances: [{ type_key: "background", done_on: day(-100), expires_on: day(995), reference: "", note: "", state: "ok" }, { type_key: "safesport", done_on: day(-30), expires_on: null, reference: "", note: "", state: "ok" }], onboarding: null },
      sam, { user_id: "u5", name: "Alex Assistant", is_me: false, clearances: [], onboarding: { started_on: day(-1), finished_at: null, done: [] } }];
    const school = [{ booking_id: "bk2", day: day(25), title: "Hancock Grammar School", user_id: "u5", name: "Alex Assistant", type_key: "background", type_label: "Background check", problem: "missing", expires_on: null }];
    Object.assign(RPC, {
      staff_records: { can_edit: !AS_STAFF, me: AS_STAFF ? "u2" : "u1", today: day(0),
        types: [{ key: "background", label: "Background check", school_required: true, warn_days: 30, sort: 10, archived: false },
                { key: "fingerprint", label: "School fingerprinting (CHRC)", school_required: false, warn_days: 30, sort: 20, archived: false },
                { key: "safesport", label: "SafeSport training", school_required: false, warn_days: 30, sort: 30, archived: false }],
        steps, people: AS_STAFF ? [sam] : people, school: AS_STAFF ? [] : school },
      staff_records_attention: AS_STAFF ? { school: 0, expiring: 1, onboarding: 0 } : { school: 1, expiring: 1, onboarding: 2 },
      staff_clearance_save: { ok: true }, staff_clearance_remove: { ok: true }, staff_clearance_type_save: { ok: true, key: "x" },
      staff_onboarding_set: { ok: true }, staff_onboarding_check: { ok: true, finished: false }, staff_onboarding_step_save: { ok: true, id: "sp9" },
    });
  }
  // Picture day planner (2026-10-22): one league picture day with a form back, three teams, two fields.
  {
    const pd = iso(12).slice(0, 10), at = (hm) => pd + "T" + hm + ":00-04:00";
    T.app_modules.push({ key: "pictureday", label: "Picture day planner", section: "Jobs", description: "Forms, team times and coach confirmations.", sort: 15, status: "live", admin_only: false });
    const team = (id, name, coach, email, field, slot, status, extra) => Object.assign({ id, name, coach_name: coach, coach_email: email, coach_phone: "", players: 12, field, slot_at: slot ? at(slot) : null, slot_min: null, sort: 0,
      status, changed: false, coach_note: "", responded_at: null, email_status: status === "new" ? null : "sent", link: "https://admin.207photo.com/#slot/" + "c".repeat(36) }, extra || {});
    Object.assign(RPC, {
      pd_list: [{ booking_id: "bk1", title: "Brewer Travel Basketball Club \u2022 Winter Sports", org_name: "Brewer Travel Basketball Club", audience: "sports", picture_day: pd, start_at: at("09:00"), time_set: true, location: "Brewer Rec Center",
                  plan_id: "pl1", intake_sent_at: iso(-3), submitted_at: iso(-1), teams: 3, timed: 2, sent: 2, confirmed: 1, move: 1, changed: 0 },
                { booking_id: "bk3", title: "Island Cheer & Tumbling \u2022 Cheer", org_name: "Island Cheer & Tumbling", audience: "sports", picture_day: iso(3).slice(0, 10), start_at: iso(3), time_set: false, location: "Deer Isle",
                  plan_id: null, intake_sent_at: null, submitted_at: null, teams: 0, timed: 0, sent: 0, confirmed: 0, move: 0, changed: 0 }],
      pd_get: { booking: { id: "bk1", title: "Brewer Travel Basketball Club \u2022 Winter Sports", org_id: "11111111-1111-1111-1111-111111111111", org_name: "Brewer Travel Basketball Club", status: "booked",
                           picture_day: pd, start_at: at("09:00"), end_at: at("12:00"), time_set: true, location: "Brewer Rec Center" },
        plan: { id: "pl1", booking_id: "bk1", contact_id: "c1", contact_name: "Chris Snowdeal", contact_email: "csnowdeal75@gmail.com", intake_sent_at: iso(-3), submitted_at: iso(-1), updated_by_contact_at: iso(-1),
                onsite_name: "Chris", onsite_phone: "207-555-0100", location: "Brewer Rec Center", fields: ["Court 1", "Court 2"], uniforms: "Home jerseys", props: "One ball per team", notes: "", roster_path: "a".repeat(36) + "/roster.csv", roster_name: "Roster.csv", roster_at: iso(-1), slot_min: 10 },
        link: "https://admin.207photo.com/#plan/" + "a".repeat(36),
        teams: [team("pt1", "U10 Blue", "Sam Coach", "sam@example.org", "Court 1", "09:00", "confirmed"),
                team("pt2", "U10 Red", "Alex Coach", "alex@example.org", "Court 2", "09:00", "move", { coach_note: "After 10 works better", responded_at: iso(-0.2), changed: true }),
                team("pt3", "U12 Green", "Pat Coach", "pat@example.org", "", null, "new")],
        contacts: [{ id: "c1", name: "Chris Snowdeal", email: "csnowdeal75@gmail.com", role: "President", on_booking: true }, { id: "c2", name: "Jamie Emerson", email: "jemerson@breweredu.org", role: null, on_booking: false }],
        booking_coaches: ["sam@example.org"],
        emails: [{ id: 2, kind: "slot", team_id: "pt1", to_email: "sam@example.org", to_name: "Sam Coach", subject: "U10 Blue: picture day", status: "sent", created_at: iso(-1), sent_at: iso(-1) },
                 { id: 1, kind: "intake", to_email: "csnowdeal75@gmail.com", to_name: "Chris Snowdeal", subject: "Brewer picture day", status: "sent", created_at: iso(-3), sent_at: iso(-3) }],
        sending: { enabled: true, test_mode: false } },
      pd_attention: { move: 1, to_plan: 0 },
      // Job page (jobpage.js)
      job_get: { booking: { id: "bk1", title: "Brewer Travel Basketball Club \u2022 Winter Sports", org_id: "11111111-1111-1111-1111-111111111111", org_name: "Brewer Travel Basketball Club", org_town: "Brewer",
                            type_key: "league", type_label: "League picture day", audience: "sports", status: "booked", picture_day: pd, start_at: at("09:00"), end_at: at("12:00"), time_set: true, end_set: true,
                            location: "Brewer Rec Center", retake_day: null, notes: "Use the side door.", wifi_network: "HLL-Guest", wifi_password: "hoops2026", gotphoto_job_id: "gp1", access_code: null },
                 days: [], stage: { label: "Booked", at: iso(-5), auto: true },
                 stages: [{ id: "s1", label: "Booked", reached: true }, { id: "s2", label: "Picture day done", reached: false }],
                 crew: [{ user_id: "u2", name: "Sam Helper", starts_at: at("08:30"), ends_at: at("12:30"), drive_before_min: 40, note: "" }],
                 contacts: [{ name: "Chris Snowdeal", email: "csnowdeal75@gmail.com", phone: "207-555-0100", role: "President", contact_id: "c1" }, { name: "Dana Utter", email: "dutter@breweredu.org", role: "Athletic Director", contact_id: "c3" }],
                 deliverables: [{ label: "Team composites", status: "todo", due_date: null, link: "" }],
                 tasks: [{ id: "t1", title: "Confirm crew", due_on: iso(-2).slice(0, 10), priority: "normal", who: "Sam Helper", mine: false, done: false },
                         { id: "t2", title: "Pack kit", due_on: iso(1).slice(0, 10), priority: "urgent", who: "Jeremiah Mutty", mine: true, done: true }],
                 picture_day: { intake_sent_at: iso(-3), submitted_at: iso(-1), roster_name: "roster.csv", onsite_name: "Chris", onsite_phone: "207-555-0100", teams: 3, timed: 2, confirmed: 1, move: 1 },
                 results: { sales: 1234.5, orders: 40, pct: 15, due: 185.18, paid: 0, balance: 185.18, payout_state: "owed", gallery_status: "live" },
                 notes_count: 1,
                 can: { bookings: true, bookings_edit: true, pictureday: true, workflows: true, results: true, scheduling: true, crew: false } },
      job_people: [{ user_id: "u2", name: "Sam Helper", crew: true }, { user_id: "u1", name: "Jeremiah Mutty", crew: false }],
      job_notes_list: [{ id: 1, author_name: "Jeremiah Mutty", body: "Parking is behind the gym. @Sam Helper bring the blue backdrop.", created_at: iso(-1), edited_at: null, mine: true, can_remove: true,
                         mentions: [{ user_id: "u2", name: "Sam Helper" }] }],
      job_note_add: { ok: true, id: 2 }, job_note_edit: { ok: true }, job_note_remove: { ok: true }, job_onsite_save: { ok: true, calendar: true }, org_wifi_save: { ok: true, jobs: 1 },
      history_get: [{ at: iso(-0.1), who: "Jeremiah Mutty", tbl: "bookings", action: "changed", changes: { location: ["Brewer High", "Brewer Rec Center"] } },
                    { at: iso(-0.2), who: "Jeremiah Mutty", tbl: "schedule_entries", action: "added", changes: { user_id: [null, "u2"], starts_at: [null, at("08:30")] } },
                    { at: iso(-5), who: "System", tbl: "stage", action: "changed", changes: { stage: [null, "Booked"] } }],
      signins_get: [{ at: iso(-0.01), via: "code", ip: "203.0.113.9", country: "US", user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" }],
      pd_save_plan: { ok: true }, pd_save_team: { ok: true, id: "pt9" }, pd_save_slots: { ok: true, saved: 1 }, pd_remove_team: { ok: true },
      pd_send_intake: { ok: true, to: "csnowdeal75@gmail.com", sending_enabled: true }, pd_send_slots: { ok: true, queued: 1, sending_enabled: true },
      pd_slot_preview: { to_email: "pat@example.org", subject: "U12 Green: picture day Sat, Nov 7 at 9:10 AM", text: "Hi Pat,\n\nHere is U12 Green's picture day time..." },
      pd_public_plan: { closed: false, org_name: "Brewer Travel Basketball Club", title: "Brewer Travel Basketball Club \u2022 Winter Sports", picture_day: pd, start_at: at("09:00"), booking_location: "Brewer Rec Center",
        contact_name: "Chris Snowdeal", submitted_at: null, onsite_name: "", onsite_phone: "", location: "", fields: [], uniforms: "", props: "", notes: "", roster_name: null,
        teams: [{ id: "pt1", name: "U10 Blue", coach_name: "Sam Coach", coach_email: "sam@example.org", coach_phone: "", players: 12, slot_at: at("09:00"), field: "Court 1", status: "confirmed" }] },
      pd_public_submit: { ok: true, teams: 3 }, pd_public_roster: { ok: true },
      pd_public_slot: { closed: false, org_name: "Brewer Travel Basketball Club", team: "U10 Blue", coach_name: "Sam Coach", slot_at: at("09:00"), slot_min: 10, field: "Court 1", where: "Brewer Rec Center",
        uniforms: "Home jerseys", props: "One ball per team", onsite_name: "Chris", onsite_phone: "207-555-0100", status: "sent", coach_note: "", responded_at: null },
      pd_public_slot_reply: { ok: true, status: "confirmed" },
    });
  }
  const storage = { from: () => ({
    createSignedUrl: async (path) => ({ data: { signedUrl: "logo.png" }, error: null }),
    createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: "logo.png" })), error: null }),
    createSignedUrl: async (p) => ({ data: { signedUrl: "logo.png" }, error: null }),
    upload: async (path) => (window.__writes = (window.__writes || []).concat([["storage", "upload", path]]), { data: { path }, error: null }),
    remove: async (paths) => (window.__writes = (window.__writes || []).concat([["storage", "remove", paths]]), { data: [], error: null }),
  }) };
  // Scheduling + Assignments (2026-10-22): this week (Sunday start, Eastern), relative to today.
  {
    const nyDay = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const add = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const today = nyDay(Date.now()), sun = add(today, -new Date(today + "T12:00:00Z").getUTCDay());
    const at = (d, hm) => d + "T" + hm + ":00-04:00";
    RPC.schedule_week = { can_edit: !AS_STAFF, me: AS_STAFF ? "u2" : "u1", studio_address: AS_STAFF ? "1 Main St, Bangor ME" : "", setup_default: 30, teardown_default: 30,
      calendar: [{ event_id: "ev1@google.com", summary: "Studio makeup session", start_date: add(sun, 3), end_date: add(sun, 3), all_day: false, start_at: at(add(sun, 3), "10:00"), end_at: at(add(sun, 3), "12:00"), off_user: null },
        { event_id: "ev2@google.com", summary: "Alex Off", start_date: add(sun, 6), end_date: add(sun, 6), all_day: true, start_at: null, end_at: null, off_user: "u5" }],
      people: [{ user_id: "u1", name: "Jeremiah Mutty", weekly_hours: 40 }, { user_id: "u2", name: "Sam Helper", weekly_hours: 24 }, { user_id: "u5", name: "Alex Assistant", weekly_hours: null, from_home: true }],
      bookings: [{ booking_id: "bk1", day: add(sun, 2), start_at: at(add(sun, 2), "09:00"), end_at: at(add(sun, 2), "12:00"), title: "Hampden Academy \u2022 School Photos", type_label: "School Photos", location: "89 Western Ave, Hampden ME", status: "booked", day_label: "" },
        { booking_id: "bk2", day: add(sun, 4), start_at: at(add(sun, 4), "16:00"), end_at: at(add(sun, 4), "19:00"), title: "Brewer Travel Basketball Club \u2022 Winter Sports", type_label: "Sports", location: "", status: "booked", day_label: "" },
        { booking_id: "bk4", day: add(sun, 2), start_at: at(add(sun, 2), "14:00"), end_at: at(add(sun, 2), "15:30"), title: "Hampden Rec \u2022 Fall Soccer", type_label: "Sports", location: "Dorothea Dix Park, Hampden ME", status: "booked", day_label: "" },
        { booking_id: "bk5", day: add(sun, 5), start_at: at(add(sun, 5), "08:30"), end_at: at(add(sun, 5), "11:00"), title: "Ellsworth Elementary \u2022 School Photos", type_label: "School Photos", location: "Ellsworth ME", status: "booked", day_label: "" },
        { booking_id: "bk6", day: add(sun, 5), start_at: at(add(sun, 5), "12:30"), end_at: at(add(sun, 5), "14:30"), title: "Bucksport Middle \u2022 School Photos", type_label: "School Photos", location: "Bucksport ME", status: "booked", day_label: "" },
        { booking_id: "bk3", day: add(sun, 6), start_at: null, end_at: null, title: "Island Cheer & Tumbling \u2022 Cheer", type_label: "Sports", location: "Deer Isle", status: "booked", day_label: "" }],
      entries: [{ id: "se1", user_id: "u1", kind: "job", booking_id: "bk1", starts_at: at(add(sun, 2), "09:00"), ends_at: at(add(sun, 2), "12:00"), drive_before_min: 30, drive_after_min: 30, setup_min: 30, teardown_min: 30, title: "", note: "", booking_title: "Hampden Academy \u2022 School Photos", booking_location: "89 Western Ave, Hampden ME", booking_status: "booked" },
        { id: "se2", user_id: "u2", kind: "job", booking_id: "bk1", starts_at: at(add(sun, 2), "09:00"), ends_at: at(add(sun, 2), "12:00"), drive_before_min: 30, drive_after_min: 30, setup_min: 30, teardown_min: 30, title: "", note: "", booking_title: "Hampden Academy \u2022 School Photos", booking_location: "89 Western Ave, Hampden ME", booking_status: "booked" },
        { id: "se3", user_id: "u2", kind: "admin", booking_id: null, starts_at: at(add(sun, 2), "12:15"), ends_at: at(add(sun, 2), "16:00"), drive_before_min: 0, drive_after_min: 0, title: "Editing", note: "", booking_title: null },
        { id: "se4", user_id: "u1", kind: "studio", booking_id: null, starts_at: at(add(sun, 1), "08:00"), ends_at: at(add(sun, 1), "16:30"), drive_before_min: 0, drive_after_min: 0, title: "", note: "", booking_title: null },
        { id: "se6", user_id: "u2", kind: "flex", booking_id: null, starts_at: at(add(sun, 4), "09:00"), ends_at: at(add(sun, 4), "11:00"), drive_before_min: 0, drive_after_min: 0, title: "Cull photos", note: "", booking_title: null },
        { id: "se7", user_id: "u1", kind: "job", booking_id: "bk5", batch_id: "trip1", starts_at: at(add(sun, 5), "08:30"), ends_at: at(add(sun, 5), "11:00"), drive_before_min: 45, drive_after_min: 0, drive_before_m: 70000, drive_after_m: 0, setup_min: 30, teardown_min: 30, title: "", note: "", booking_title: "Ellsworth Elementary \u2022 School Photos", booking_location: "Ellsworth ME", booking_status: "booked" },
        { id: "se8", user_id: "u1", kind: "job", booking_id: "bk6", batch_id: "trip1", starts_at: at(add(sun, 5), "12:30"), ends_at: at(add(sun, 5), "14:30"), drive_before_min: 25, drive_after_min: 25, drive_before_m: 30000, drive_after_m: 32000, setup_min: 30, teardown_min: 30, title: "", note: "", booking_title: "Bucksport Middle \u2022 School Photos", booking_location: "Bucksport ME", booking_status: "booked" },
        { id: "se5", user_id: "u5", kind: "off", booking_id: null, starts_at: at(add(sun, 3), "00:00"), ends_at: at(add(sun, 5), "00:00"), drive_before_min: 0, drive_after_min: 0, title: "Vacation", note: "", booking_title: null }],
      tasks: [{ user_id: "u2", day: add(sun, 1), n: 2 }, { user_id: "u2", day: add(sun, 2), n: 1 }, { user_id: "u1", day: add(sun, 5), n: 1 }] };
    RPC.schedule_attention = { unstaffed: 2 };
    RPC.schedule_save = { ok: true, id: "se9", overlaps: 0 }; RPC.schedule_remove = { ok: true }; RPC.schedule_settings_save = { ok: true }; RPC.schedule_batch_save = { ok: true }; RPC.schedule_setup_save = { ok: true, changed: 0 };
    const task = (id, title, repeat, extra) => Object.assign({ task_id: id, user_id: "u2", user_name: "Sam Helper", title, notes: "", repeat, priority: "normal", est_minutes: null, on_date: today, overdue: false, done_at: null, done_by: null }, extra || {});
    RPC.assignments_day = [task("t4", "Call Hampden about retakes", "once", { priority: "urgent", overdue: true, on_date: add(today, -1) }), task("t1", "Back up memory cards", "daily", { est_minutes: 15 }),
      task("t2", "Order print supplies", "weekly", { overdue: true, on_date: add(today, -2) }), task("t3", "Empty the studio trash", "daily", { done_at: new Date().toISOString(), done_by: "Sam Helper" })];
    RPC.my_day = { day: today, weekly_hours: 24, entries: RPC.schedule_week.entries.filter((e) => e.user_id === "u2").map((e) => Object.assign({}, e, { starts_at: e.starts_at.replace(/^\d{4}-\d{2}-\d{2}/, today), ends_at: e.ends_at.replace(/^\d{4}-\d{2}-\d{2}/, today) })), tasks: RPC.assignments_day };
    RPC.assignments_list = { can_edit: !AS_STAFF, me: AS_STAFF ? "u2" : "u1", settings: { day_plan_on: true, day_plan_hour: 20 },
      people: [{ user_id: "u1", name: "Jeremiah Mutty", gets_day_plan: true }, { user_id: "u2", name: "Sam Helper", gets_day_plan: true }, { user_id: "u5", name: "Alex Assistant", gets_day_plan: false }],
      tasks: [{ id: "t1", user_id: "u2", title: "Back up memory cards", notes: "Both card readers", repeat: "daily", weekdays: [1, 2, 3, 4, 5], month_day: null, due_on: null, starts_on: today, est_minutes: 15, priority: "normal", last_done: add(today, -1) },
        { id: "t2", user_id: "u2", title: "Order print supplies", notes: "", repeat: "weekly", weekdays: [1], month_day: null, due_on: null, starts_on: today, est_minutes: null, priority: "normal", last_done: null },
        { id: "t5", user_id: "u1", title: "Month-end numbers", notes: "", repeat: "monthly", weekdays: [], month_day: 31, due_on: null, starts_on: today, est_minutes: 60, priority: "normal", last_done: null },
        { id: "t4", user_id: "u2", title: "Call Hampden about retakes", notes: "", repeat: "once", weekdays: [], month_day: null, due_on: add(today, -1), starts_on: today, est_minutes: null, priority: "urgent", last_done: null }] };
    // Job checklists (2026-10-22)
    RPC.workflow_jobs = [
      { booking_id: "bk3", title: "Island Cheer & Tumbling \u2022 Cheer", picture_day: add(today, 3), type_key: "sports_nodata", lead: "Sam Helper", open_count: 2, overdue_count: 1,
        tasks: [{ task_id: "w1", title: "Confirm start time and crew with the contact", due_on: add(today, -1), user_name: "Sam Helper", done_at: null, done_by: null, priority: "normal", manual: false },
          { task_id: "w2", title: "Pack the kit and charge batteries", due_on: add(today, 2), user_name: "Sam Helper", done_at: null, done_by: null, priority: "normal", manual: false }] },
      { booking_id: "bk1", title: "Brewer Travel Basketball Club \u2022 Winter Sports", picture_day: add(today, 12), type_key: "sports_data", lead: null, open_count: 0, overdue_count: 0,
        tasks: [{ task_id: "w3", title: "Order team banners", due_on: add(today, -2), user_name: "Jeremiah Mutty", done_at: new Date().toISOString(), done_by: "Jeremiah Mutty", priority: "urgent", manual: false }] }];
    RPC.workflow_templates = { can_edit: true,
      types: [{ key: "school", label: "School Photos" }, { key: "sports_data", label: "Sports: league with parent contacts" }, { key: "sports_nodata", label: "Sports: school teams, roster only" }],
      people: [{ user_id: "u1", name: "Jeremiah Mutty" }, { user_id: "u2", name: "Sam Helper" }],
      groups: [{ id: "g1", name: "Editing team", members: [{ user_id: "u2", name: "Sam Helper" }], steps: 1 }],
      steps: [{ id: "ws4", type_key: null, title: "Edit the photos", notes: "", anchor: "picture_day", offset_days: 3, assign_to: "group", user_id: null, user_name: null, group_id: "g1", group_name: "Editing team",
                priority: "normal", sort: 35, waits_for: "ws5", waits_for_title: "Cards uploaded", remind_days: 2, late_days: 1, late_user_id: "u1", late_user_name: "Jeremiah Mutty",
                partner_email: true, partner_subject: "Proofs posted for {league}", partner_body: "Hi {first_name}" },
        { id: "ws5", type_key: null, title: "Cards uploaded", notes: "", anchor: "picture_day", offset_days: 1, assign_to: "crew", user_id: null, user_name: null, priority: "normal", sort: 30 },{ id: "ws1", type_key: null, title: "Confirm start time and crew with the contact", notes: "Call or email the contact on the booking.", anchor: "picture_day", offset_days: -7, assign_to: "crew", user_id: null, user_name: null, priority: "normal", sort: 10 },
        { id: "ws2", type_key: null, title: "Send the partner a thank-you", notes: "", anchor: "launch", offset_days: 14, assign_to: "crew", user_id: "u1", user_name: "Jeremiah Mutty", priority: "normal", sort: 50 },
        { id: "ws3", type_key: "sports_data", title: "Order team banners", notes: "", anchor: "booked", offset_days: 2, assign_to: "person", user_id: "u1", user_name: "Jeremiah Mutty", priority: "urgent", sort: 10 }] };
    // Task board (2026-10-22)
    {
      const tk = (id, title, due, extra) => Object.assign({ id, user_id: "u2", user_name: "Sam Helper", title, notes: "", due_on: due, priority: "normal", waiting: false, done_at: null,
        booking_id: null, group_id: null, group_name: null, checklist: false, waits_for: null }, extra || {});
      RPC.task_board = { can_edit: !AS_STAFF, me: AS_STAFF ? "u2" : "u1", today,
        people: [{ user_id: "u1", name: "Jeremiah Mutty" }, { user_id: "u2", name: "Sam Helper" }], groups: [{ id: "g1", name: "Editing team" }],
        tasks: [tk("k1", "Cards uploaded: Hampden Academy", add(today, -1), { checklist: true, booking_id: "bk1" }),
          tk("k2", "Edit the photos: Hampden Academy", add(today, 2), { checklist: true, booking_id: "bk1", waiting: true, waits_for: "Cards uploaded", group_id: "g1", group_name: "Editing team" }),
          tk("k3", "Order print supplies", add(today, 3)), tk("k4", "Call Hampden about retakes", today, { user_id: "u1", user_name: "Jeremiah Mutty", priority: "urgent" }),
          tk("k5", "Pack the kit: Brewer Travel", add(today, -3), { done_at: new Date().toISOString(), checklist: true })],
        repeating: [{ id: "t1", user_id: "u2", user_name: "Sam Helper", title: "Back up memory cards", day: add(today, 1), priority: "normal", done: false }] };
      RPC.task_bulk = { ok: true, changed: 1, skipped: 0, why: null };
      RPC.task_workload = { week: add(today, -new Date(today + "T12:00:00Z").getUTCDay()), today,
        rows: [{ user_id: "u1", name: "Jeremiah Mutty", groups: [], due_week: 4, done_week: 1, overdue: 0, waiting: 0, later: 2 },
               { user_id: "u2", name: "Sam Helper", groups: ["Editing team"], due_week: 9, done_week: 6, overdue: 2, waiting: 1, later: 3 }] };
      RPC.workflow_job = { booking_id: "bk1", status: "booked", can_check: true, me: "u1", people: [{ user_id: "u1", name: "Jeremiah Mutty" }, { user_id: "u2", name: "Sam Helper" }], tasks: [
          { task_id: "k1", title: "Cards uploaded", due_on: add(today, -1), user_id: "u2", user_name: "Sam Helper", done_at: null, priority: "normal", waiting: false },
          { task_id: "k2", title: "Edit the photos", due_on: add(today, 2), user_id: "u2", user_name: "Sam Helper", group_name: "Editing team", done_at: null, priority: "normal", waiting: true, waits_for: "Cards uploaded" }],
        emails: [{ kind: "partner", to: "pat@hampden.org", subject: "Proofs posted for Hampden Academy", status: "sent", test_mode: false, at: new Date().toISOString() }] };
      RPC.staff_group_save = { ok: true, id: "g9" }; RPC.staff_group_archive = { ok: true };
      RPC.booking_set_stage = { ok: true };
    }
    RPC.workflow_step_save = { ok: true, id: "ws9" }; RPC.workflow_step_archive = { ok: true }; RPC.workflow_attention = { overdue: 1 };
    // Crew (2026-10-23): roles, confirm answers, time off requests, the crew picker, weekly email.
    {
      const W = RPC.schedule_week, roles = [{ id: "r1", label: "Lead" }, { id: "r2", label: "Second shooter" }, { id: "r3", label: "Posing" }, { id: "r4", label: "Check-in" }];
      W.people[0].roles = ["r1"]; W.people[1].roles = ["r2", "r4"]; W.people[2].roles = ["r3"];
      Object.assign(W.entries[0], { role_id: "r1", role: "Lead", confirm: { status: "confirmed", reason: "", asked_at: iso(-2), answered_at: iso(-1), changed: false } });
      Object.assign(W.entries[1], { role_id: "r2", role: "Second shooter", confirm: { status: "pending", reason: "", asked_at: iso(-1), answered_at: null, changed: false } });
      W.crew = { roles, needed: { bk1: 3 }, declined: [{ booking_id: "bk1", user_id: "u5", name: "Alex Assistant", reason: "Dentist", answered_at: iso(-1) }],
        requests: [{ id: "to1", user_id: "u2", first_day: add(sun, 5), last_day: add(sun, 5), start_time: null, end_time: null, note: "Family wedding" }],
        settings: { crew_confirm_on: false, week_email_auto: false, week_email_dow: 5, week_email_hour: 15 } };
      RPC.my_day.entries.forEach((e) => { if (e.id === "se2") Object.assign(e, { role: "Second shooter", confirm: { status: "pending", token: "c".repeat(32) } }); });
      RPC.crew_capacity = { team: 3, days: [{ day: add(sun, 2), jobs: 1, needed: 3, on_jobs: 2, off: 0, asked_off: 0 }, { day: add(sun, 4), jobs: 1, needed: 1, on_jobs: 0, off: 1, asked_off: 0 },
        { day: add(sun, 12), jobs: 3, needed: 4, on_jobs: 1, off: 0, asked_off: 1 }] };
      const pp = (id, name, r, x) => Object.assign({ user_id: id, name, roles: r, has_home: true, home_min: null, off: false, asked_off: false, busy: [], on_it: false, declined: false }, x || {});
      RPC.crew_options = { destination: "89 western ave, hampden me", studio_min: 25, roles,
        people: [pp("u1", "Jeremiah Mutty", ["r1"], { home_min: 22, on_it: true }), pp("u2", "Sam Helper", ["r2", "r4"], { home_min: 41, on_it: true }),
          pp("u5", "Alex Assistant", ["r3"], { has_home: false, declined: true, busy: [{ starts_at: at(add(sun, 2), "13:00"), ends_at: at(add(sun, 2), "15:00"), kind: "studio", title: null }] })] };
      RPC.crew_roles_list = { can_edit: true, roles: roles.map((r, i) => Object.assign({ sort: (i + 1) * 10 }, r)), members: { u1: ["r1"], u2: ["r2", "r4"], u5: ["r3"] } };
      RPC.crew_role_save = { ok: true, id: "r9" }; RPC.crew_role_archive = { ok: true }; RPC.team_set_roles = { ok: true };
      RPC.crew_needed_set = { ok: true }; RPC.crew_ask_now = { ok: true }; RPC.crew_settings_save = { ok: true };
      RPC.week_email_preview = [{ user_id: "u1", name: "Jeremiah Mutty", subject: "Your schedule, week of Oct 18: 1 job", sent_at: null },
        { user_id: "u2", name: "Sam Helper", subject: "Your schedule, week of Oct 18: 1 job, 1 to confirm", sent_at: iso(-3) }];
      RPC.week_email_send = { ok: true, sent: 2, nothing_on: 1, no_email: 0 };
      RPC.crew_attention = { waiting: 1, mine: 1, timeoff: AS_STAFF ? 0 : 1 };
      RPC.crew_mine = [{ booking_id: "bk1", title: "Hampden Academy \u2022 School Photos", location: "89 Western Ave, Hampden ME", status: "pending", token: "c".repeat(32), changed: false,
        days: [{ starts_at: at(add(sun, 2), "09:00"), ends_at: at(add(sun, 2), "12:00"), drive_before_min: 30, role: "Second shooter", note: "" }] },
        { booking_id: "bk2", title: "Brewer Travel Basketball Club \u2022 Winter Sports", location: "", status: "confirmed", token: "d".repeat(32), changed: false,
        days: [{ starts_at: at(add(sun, 4), "16:00"), ends_at: at(add(sun, 4), "19:00"), drive_before_min: 0, role: null, note: "" }] }];
      RPC.crew_answer = { ok: true, status: "confirmed" };
      RPC.crew_public = { title: "Hampden Academy \u2022 School Photos", name: "Sam", location: "89 Western Ave, Hampden ME", status: "pending", reason: "", changed: false, cancelled: false,
        days: [{ starts_at: at(add(sun, 2), "09:00"), ends_at: at(add(sun, 2), "12:00"), drive_before_min: 30, role: "Second shooter", note: "" }], crew: [{ name: "Jeremiah Mutty", role: "Lead" }] };
      RPC.crew_for_booking = { can_edit: true, booking_status: "booked", needed: 3, crew: [{ user_id: "u1", name: "Jeremiah Mutty", roles: ["Lead"], status: "confirmed", days: [{ starts_at: at(add(sun, 2), "09:00"), ends_at: at(add(sun, 2), "12:00") }] }], declined: [] };
      RPC.time_off_list = { me: AS_STAFF ? "u2" : "u1", can_view: !AS_STAFF, can_edit: !AS_STAFF,
        mine: [{ id: "to2", user_id: AS_STAFF ? "u2" : "u1", name: "", first_day: add(sun, 20), last_day: add(sun, 22), start_time: null, end_time: null, note: "Vacation", status: "approved", decided_by: "Jeremiah Mutty", decided_at: iso(-2), decision_note: "Enjoy!", created_at: iso(-4), jobs: [] }],
        team: AS_STAFF ? [] : [{ id: "to1", user_id: "u2", name: "Sam Helper", first_day: add(sun, 5), last_day: add(sun, 5), start_time: null, end_time: null, note: "Family wedding", status: "pending", decided_by: null, decided_at: null, decision_note: "", created_at: iso(-1),
          jobs: [{ starts_at: at(add(sun, 5), "10:00"), title: "Island Cheer \u2022 Cheer" }] }] };
      RPC.time_off_request = { ok: true, id: "to9" }; RPC.time_off_cancel = { ok: true }; RPC.time_off_decide = { ok: true };
    }
    RPC.assignment_check = { ok: true }; RPC.assignment_save = { ok: true, id: "t9" }; RPC.assignment_archive = { ok: true }; RPC.staff_settings_save = { ok: true }; RPC.day_email_status = { on: true, hour: 7, mine: true }; RPC.day_email_settings_save = { ok: true }; RPC.day_email_mine = { ok: true, on: false }; RPC.team_set_hours = { ok: true };
  }
  // Open jobs (2026-10-22): offers to part-timers.
  {
    const nyDay = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const add = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const today = nyDay(Date.now()), at = (d, hm) => d + "T" + hm + ":00-04:00";
    const offer = (id, extra) => Object.assign({ id, booking_id: "bk1", title: "Hampden Academy \u2022 School Photos", type_label: "School Photos", location: "89 Western Ave, Hampden ME", booking_status: "booked",
      spots: 1, note: "Bring the white backdrop.", pay: "$150 flat", status: "open", created_at: iso(-0.1), created_by: "Jeremiah Mutty", taken: 0,
      days: [{ day: add(today, 3), start_at: at(add(today, 3), "09:00"), end_at: at(add(today, 3), "12:00") }] }, extra);
    RPC.openjobs_mine = { me: "u6", offers: [offer("of1", { mine: { drive_min: 35, answer: null, answered_at: null, reason: "" } }),
      offer("of2", { booking_id: "bk2", title: "Brewer Travel Basketball \u2022 Winter Sports", status: "filled", spots: 2, taken: 2, pay: "", note: "", mine: { drive_min: 50, answer: "declined", answered_at: iso(-1), reason: "Busy" } })] };
    RPC.openjobs_answer = { ok: true, answer: "accepted", scheduled: 1, untimed: 0 };
    RPC.openjobs_attention = { waiting: 1, no_takers: AS_PART ? 0 : 1 };
    RPC.openjobs_list = [Object.assign(offer("of1"), { recipients: [
      { user_id: "u6", name: "Pat Parttime", drive_min: 35, notified: true, seen_at: iso(-0.05), answer: "accepted", answered_at: iso(-0.03), picked_at: null, reason: "" },
      { user_id: "u7", name: "Riley Second", drive_min: 52, notified: true, seen_at: iso(-0.05), answer: "declined", answered_at: iso(-0.02), reason: "Out of town" },
      { user_id: "u8", name: "Casey Third", drive_min: null, notified: false, seen_at: null, answer: null, answered_at: null, reason: "" }] })];
    RPC.openjobs_upcoming = [{ booking_id: "bk1", title: "Hampden Academy \u2022 School Photos", type_label: "School Photos", first_day: add(today, 3), days: 1, location: "89 Western Ave, Hampden ME", crew: 1, open_offers: 1 },
      { booking_id: "bk2", title: "Brewer Travel Basketball \u2022 Winter Sports", type_label: "Sports", first_day: add(today, 5), days: 2, location: "", crew: 0, open_offers: 0 }];
    RPC.openjobs_candidates = { booking: { booking_id: "bk2", title: "Brewer Travel Basketball \u2022 Winter Sports", location: "Brewer, Maine", days: [{ day: add(today, 5), start_at: at(add(today, 5), "16:00"), end_at: at(add(today, 5), "19:00") }, { day: add(today, 6), start_at: null, end_at: null }] },
      people: [{ user_id: "u6", name: "Pat Parttime", home_set: true, max_drive_min: 60, drive_min: 35, meters: 40000, in_range: true, has_access: true, has_device: true, on_job: false, offered: false, busy: [] },
        { user_id: "u7", name: "Riley Second", home_set: true, max_drive_min: 45, drive_min: 40, meters: 50000, in_range: true, has_access: true, has_device: false, on_job: false, offered: false, busy: [add(today, 5)] },
        { user_id: "u8", name: "Casey Third", home_set: true, max_drive_min: 30, drive_min: 70, meters: 90000, in_range: false, has_access: true, has_device: true, on_job: false, offered: false, busy: [] },
        { user_id: "u9", name: "Dana Nohome", home_set: false, max_drive_min: 60, drive_min: null, meters: null, in_range: false, has_access: false, has_device: false, on_job: false, offered: false, busy: [] }] };
    RPC.openjobs_post = { ok: true, id: "of9", sent: 2, pushed: 1 };
    RPC.openjobs_close = { ok: true };
    RPC.openjobs_pick = { ok: true, filled: true, scheduled: 1 };
    RPC.openjobs_people = { can_grant: true, people: [{ user_id: "u6", name: "Pat Parttime", part_time: true, employment_type: "part_time", job_title: "Photographer", home_address: "12 Elm St, Bangor ME", max_drive_min: 60, has_access: true, has_device: true },
      { user_id: "u2", name: "Sam Helper", part_time: false, employment_type: null, job_title: "", home_address: "", max_drive_min: 60, has_access: false, has_device: true }] };
    RPC.openjobs_person_save = { ok: true, granted: true }; RPC.team_set_profile = { ok: true, granted: true };
  }
  // Time clock and mileage (2026-10-22). ?clockedin=1 starts clocked in.
  {
    const nyDay = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const add = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const today = nyDay(Date.now()), sun = add(today, -new Date(today + "T12:00:00Z").getUTCDay());
    const at = (d, hm) => d + "T" + hm + ":00-04:00";
    const me = AS_STAFF ? "u2" : "u1";
    const punch = (id, user, day, a, b, kind, extra) => Object.assign({ id, user_id: user, kind, booking_id: null, job_title: "", clock_in: at(day, a), clock_out: b ? at(day, b) : null, day,
      minutes: b ? (+b.slice(0, 2) * 60 + +b.slice(3)) - (+a.slice(0, 2) * 60 + +a.slice(3)) : 75, note: "", edited: false, edited_by: null, locked: false }, extra || {});
    const open = /[?&]clockedin=1\b/.test(location.search) ? punch("tp9", me, today, "08:00", null, "job", { booking_id: "bk1", job_title: "Hampden Academy \u2022 School Photos" }) : null;
    RPC.timeclock_status = { me, can_edit: !AS_STAFF, open,
      jobs: [{ booking_id: "bk1", title: "Hampden Academy \u2022 School Photos", start_at: at(today, "09:00"), location: "89 Western Ave, Hampden ME", mine: true },
             { booking_id: "bk2", title: "Brewer Travel Basketball Club \u2022 Winter Sports", start_at: at(today, "16:00"), location: "", mine: false }],
      today: open ? [open] : [], week_start: sun, week_worked_min: 610, week_scheduled_min: 1440, today_scheduled_min: 240 };
    RPC.timeclock_in = { ok: true, id: "tp10", switched: !!open }; RPC.timeclock_out = { ok: true, minutes: 135 };
    const days = (w) => Array.from({ length: 7 }, (_, i) => ({ day: add(sun, i), worked_min: w[i] || 0, scheduled_min: [0, 480, 480, 240, 0, 240, 0][i] }));
    RPC.timesheet_week = { can_edit: !AS_STAFF, me, week_start: sun, overtime_after: 40,
      jobs: [{ booking_id: "bk1", day: add(sun, 2), title: "Hampden Academy \u2022 School Photos", start_at: at(add(sun, 2), "09:00") }],
      people: [{ user_id: "u1", name: "Jeremiah Mutty", weekly_hours: 40, days: days([0, 500, 470]), miles: 26.1, open: false, approved_at: null, approved_by: null },
               { user_id: "u2", name: "Sam Helper", weekly_hours: 24, days: days([0, 480, 495, 0, 0, 0, 0]), miles: 0, open: false, approved_at: new Date().toISOString(), approved_by: "Jeremiah Mutty" }]
        .filter((p) => !AS_STAFF || p.user_id === "u2"),
      punches: [punch("tp1", "u2", add(sun, 1), "08:00", "16:00", "studio"), punch("tp2", "u2", add(sun, 2), "08:15", "12:30", "job", { booking_id: "bk1", job_title: "Hampden Academy \u2022 School Photos", note: "on site" }),
                punch("tp3", "u2", add(sun, 2), "12:45", "16:45", "admin", { edited: true, edited_by: "Sam Helper" }), punch("tp4", "u1", add(sun, 1), "08:00", "16:20", "studio")]
        .filter((p) => !AS_STAFF || p.user_id === "u2") };
    RPC.timepunch_save = { ok: true, id: "tp11" }; RPC.timepunch_remove = { ok: true }; RPC.timesheet_approve = { ok: true }; RPC.timeclock_settings_save = { ok: true };
    RPC.timesheet_payroll = { from: sun, to: add(sun, 6), mileage_rate: 0.7, overtime_after: 40,
      people: [{ user_id: "u1", name: "Jeremiah Mutty", email: "jmutty@207photo.com", employment_type: "full_time", job_title: "Owner", worked_min: 2610, overtime_min: 210, regular_min: 2400, miles: 26.1, mileage_pay: 18.27, weeks: 1, approved_weeks: 0, open: false },
               { user_id: "u2", name: "Sam Helper", email: "sam@207photo.com", employment_type: "part_time", job_title: "", worked_min: 975, overtime_min: 0, regular_min: 975, miles: 0, mileage_pay: 0, weeks: 1, approved_weeks: 1, open: false },
               { user_id: "u7", name: "Riley Second", email: "riley@example.com", employment_type: "contractor", job_title: "Second shooter", worked_min: 300, overtime_min: 0, regular_min: 300, miles: 40, mileage_pay: 28, weeks: 1, approved_weeks: 1, open: false }],
      punches: [Object.assign(punch("tp1", "u2", add(sun, 1), "08:00", "16:00", "studio"), { name: "Sam Helper" })] };
    RPC.mileage_list = { can_edit: !AS_STAFF, me, month: today.slice(0, 8) + "01", mileage_rate: 0.7, studio_address: "60 Main Rd, N Hampden",
      jobs: [{ booking_id: "bk1", day: add(sun, 2), title: "Hampden Academy \u2022 School Photos" }],
      trips: [{ id: "mt1", user_id: me, name: AS_STAFF ? "Sam Helper" : "Jeremiah Mutty", booking_id: "bk1", job_title: "Hampden Academy \u2022 School Photos", location: "89 Western Ave, Hampden ME", day: add(sun, 2), miles: 26.1, auto: true, note: "", est_miles: null, locked: false },
              { id: "mt2", user_id: me, name: AS_STAFF ? "Sam Helper" : "Jeremiah Mutty", booking_id: "bk3", job_title: "Island Cheer & Tumbling \u2022 Cheer", location: "Deer Isle", day: add(sun, 3), miles: null, auto: true, note: "", est_miles: null, locked: false },
              { id: "mt3", user_id: me, name: AS_STAFF ? "Sam Helper" : "Jeremiah Mutty", booking_id: null, job_title: "", location: null, day: add(sun, 1), miles: 12, auto: false, note: "Staples for paper", est_miles: null, locked: false }] };
    RPC.mileage_save = { ok: true, id: "mt9" }; RPC.mileage_remove = { ok: true }; RPC.mileage_refresh = { ok: true, filled: 0 }; RPC.mileage_from_schedule = { ok: true, added: 2 };
    RPC.timeclock_attention = { open_long: 0, to_approve: AS_STAFF ? 0 : 1, last_week: add(sun, -7), review: 1, expenses: AS_STAFF ? 0 : 1, near_ot: AS_STAFF ? 0 : 1 };
    // Round two (2026-10-23): location, review flag, pay, expenses, rates, job time.
    Object.assign(RPC.timeclock_status, { gps: true, overtime_after: 40, overtime_applies: true, review: 1 });
    RPC.timesheet_week.people.forEach((p, i) => Object.assign(p, { pay: { basis: "hourly", rate: 22, source: "type", pay: 352.5 + i * 10 }, expenses: i ? 0 : 12.75, review: i ? 1 : 0 }));
    Object.assign(RPC.timesheet_week.punches[0], { in_loc: { lat: 44.7449, lng: -68.837, acc: 12 }, out_loc: { lat: 44.745, lng: -68.84, acc: 20 } });
    Object.assign(RPC.timesheet_week.punches[RPC.timesheet_week.punches.length - 1], { auto_out: true, needs_review: true, note: "Clocked out automatically at midnight" });
    RPC.timesheet_payroll.people.forEach((p, i) => Object.assign(p, { pay: i === 2 ? null : { basis: i ? "day" : "hourly", rate: i ? 200 : 25, source: i ? "person" : "title", pay: i ? 400 : 1078.75 }, expenses: i ? 0 : 12.75 }));
    RPC.timesheet_payroll.expense_rows = [{ id: "x1", name: "Jeremiah Mutty", day: add(sun, 1), amount: 12.75, category: "supplies", job_title: "", note: "AA batteries", reviewed_by: "Jeremiah Mutty" }];
    RPC.timeclock_settings_get = { mileage_rate: 0.7, overtime_after: 40, gps_on: true, remind_before_min: 15, remind_out_after_min: 30, auto_out: true, ot_warn_hours: 4, half_day_hours: 5 };
    RPC.expense_list = { can_edit: !AS_STAFF, me, month: today.slice(0, 8) + "01", jobs: [{ booking_id: "bk1", day: add(sun, 2), title: "Hampden Academy \u2022 School Photos" }],
      expenses: [{ id: "x1", user_id: me, name: AS_STAFF ? "Sam Helper" : "Jeremiah Mutty", day: today, amount: 12.75, category: "supplies", booking_id: null, job_title: "", note: "AA batteries", receipt_path: me + "/r1.jpg", status: "submitted", reviewed_by: null, review_note: "" },
                 { id: "x2", user_id: me, name: AS_STAFF ? "Sam Helper" : "Jeremiah Mutty", day: today, amount: 18, category: "meals", booking_id: "bk1", job_title: "Hampden Academy \u2022 School Photos", note: "Crew lunch", receipt_path: null, status: "rejected", reviewed_by: "Jeremiah Mutty", review_note: "Need the receipt" },
                 { id: "x3", user_id: "u2", name: "Sam Helper", day: today, amount: 6, category: "parking", booking_id: null, job_title: "", note: "Garage", receipt_path: "u2/r3.pdf", status: "approved", reviewed_by: "Jeremiah Mutty", review_note: "" }]
        .filter((x) => !AS_STAFF || x.user_id === "u2") };
    RPC.expense_save = { ok: true, id: "x9" }; RPC.expense_remove = { ok: true, receipt_path: null }; RPC.expense_review = { ok: true };
    RPC.timeclock_rates = { half_day_hours: 5, titles: ["lead photographer", "assistant"],
      rates: [{ id: "r1", scope: "type", scope_key: "part_time", basis: "hourly", rate: 20, half_day_rate: null }, { id: "r2", scope: "title", scope_key: "lead photographer", basis: "hourly", rate: 25, half_day_rate: null },
              { id: "r3", scope: "person", scope_key: "u2", name: "Sam Helper", basis: "day", rate: 200, half_day_rate: 120 }],
      people: [{ user_id: "u1", name: "Jeremiah Mutty", employment_type: "salaried", job_title: "Owner", rate: null },
               { user_id: "u2", name: "Sam Helper", employment_type: "part_time", job_title: "", rate: { basis: "day", rate: 200, half_day_rate: 120, source: "person" } }] };
    RPC.timeclock_rate_save = { ok: true, id: "r9" }; RPC.timeclock_rate_remove = { ok: true };
    RPC.timeclock_job = { can_edit: !AS_STAFF, mileage_rate: 0.7, half_day_hours: 5,
      people: [{ user_id: "u2", name: "Sam Helper", minutes: 255, days: 1, open: false, miles: 26.1, expenses: 18, rate: AS_STAFF ? null : { basis: "hourly", rate: 20, source: "type" } }] };
  }
  // Email delivery (2026-10-23).
  {
    const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const row = (id, source, to, subject, status, h, extra) => Object.assign({ id, source, to: [to], from: "207 Admin <alerts@207photo.com>", subject, sent_at: ago(h), status, error: null, opened_at: null, clicked_at: null,
      last_event: null, test_mode: false, resent_from: null, resent: false, can_resend: source !== "signin", handled_at: null }, extra || {});
    RPC.email_list = { can_edit: !AS_STAFF, capturing: true, problems: 2, rows: [
      row(6, "pictureday", "coach@example.org", "U10 Blue: your picture day time", "delivered", 0.5, { opened_at: ago(0.2), clicked_at: ago(0.1) }),
      row(5, "makeup", "parent@example.com", "Ava's makeup photos are ready", "bounced", 3, { error: "Resend: bounced" }),
      row(4, "day_email", "sam@207photo.com", "Your day: Thursday", "delivered", 9),
      row(3, "signin", "sam@207photo.com", "Sign-in code", "delivered", 10),
      row(2, "pictureday", "typo@exmaple.com", "Picture day times", "failed", 26, { error: "Invalid `to` field." }),
      row(1, "hub", "watcher@example.com", "Hampden: your photo gallery is live", "sent", 0.1)] };
    RPC.email_detail = Object.assign({}, RPC.email_list.rows[1], { reply_to: "hello@207photo.com", cc: null, bcc: null, text: "Hi,\n\nAva's makeup photos are ready.", html: "<p>Hi,</p><p>Ava's makeup photos are ready.</p>",
      resend_id: "re_1", handled_by: null, resent_by: null, resends: [], bounced_contact: false });
    RPC.email_resend = { ok: true, id: 7 }; RPC.email_mark_handled = { ok: true, n: 1 }; RPC.email_attention = { problems: 2 };
    const ym = (n) => { const d = new Date(); d.setUTCDate(15); d.setUTCMonth(d.getUTCMonth() - n); return d.toISOString().slice(0, 7); };
    RPC.email_report = { from: ym(2) + "-01", first_sent_at: ago(24 * 50),
      months: [{ month: ym(1), sent: 412, delivered: 401, bounced: 6, complained: 1, failed: 4, delayed: 0, opened: 233, clicked: 61, test: 3 }, { month: ym(0), sent: 230, delivered: 224, bounced: 3, complained: 0, failed: 3, delayed: 1, opened: 140, clicked: 30, test: 0 }],
      sources: [{ source: "pictureday", sent: 300, delivered: 292, bounced: 5, failed: 3, opened: 210 }, { source: "day_email", sent: 200, delivered: 200, bounced: 0, failed: 0, opened: 120 }, { source: "makeup", sent: 142, delivered: 133, bounced: 4, failed: 4, opened: 43 }],
      bounced: [{ email: "parent@example.com", n: 2, last: ago(3) }] };
  }
  // ws/settings (2026-10-24): Settings tabs (Team emails, Job types, Team & pay, Company), one person record,
  // the job calculator's shared assumptions, and the app_modules rows the real database has.
  {
    T.admin_settings = { id: true, digest_enabled: true, digest_time: "07:00:00", digest_recipients: ["test@207photo.com"], calc_assumptions: null };
    [["inventory", "Gear inventory", "Ops", "Gear, bins, kits and check-outs.", 300], ["openjobs", "Open jobs", "Staff", "Offer jobs to part-timers and 1099.", 207],
     ["workflows", "Job checklists", "Jobs", "Checklist steps per job type.", 25]].forEach(([key, label, section, description, sort]) => {
      if (!T.app_modules.some((m) => m.key === key)) T.app_modules.push({ key, label, section, description, sort, status: "live", admin_only: false });
    });
    RPC.settings_team_emails = { day_plan_on: true, day_plan_hour: 20, day_email_on: true, day_email_hour: 7, crew_confirm_on: true, week_email_auto: true, week_email_dow: 5, week_email_hour: 15,
      clock: { mileage_rate: 0.7, overtime_after: 40, remind_before_min: 15, remind_out_after_min: 30, ot_warn_hours: 4 },
      topics: [{ key: "help_request", label: "New help request", description: "A parent asked for help finding their access code.", module: "parents", default_mode: "push" },
               { key: "crew_ask", label: "Put on a job", description: "You were put on a booked job. Confirm or say you can't make it.", module: "scheduling", default_mode: "push" },
               { key: "expense_update", label: "Expense update", description: "An expense was approved or sent back.", module: "timeclock", default_mode: "email" },
               { key: "checklist_late", label: "Checklist task late", description: "A job checklist task is past due.", module: "workflows", default_mode: "off" }] };
    RPC.push_topic_set_default = { ok: true }; RPC.team_set_max_drive = null; RPC.booking_type_add = { ok: true, key: "dance_recital" }; RPC.booking_set_auto_track = { ok: true };
    RPC.team_list.push({ user_id: "u6", email: "pat@207photo.com", name: "Pat Parttime", is_admin: false, is_me: false, active: true, must_change_password: false, employment_type: "part_time", job_title: "Photographer",
                         home_address: "12 Elm St, Bangor ME", max_drive_min: 60, last_sign_in_at: iso(-2), modules: { openjobs: "view", assignments: "view", timeclock: "view", staffrecords: "view" } },
                       { user_id: "u8", email: "casey@example.com", name: "Casey Third", is_admin: false, is_me: false, active: true, must_change_password: false, employment_type: "contractor", job_title: "",
                         home_address: "Orono", max_drive_min: 30, last_sign_in_at: null, modules: { openjobs: "view" } });
  }

  // ws/shell (2026-10-24): the account menu's Help line, "Morning email goes to you", and ?nodevice=1 for a person
  // with no device that has notifications on (the Today card and the new-hire ask).
  {
    RPC.help_contacts = [{ name: "Jeremiah Mutty", email: "test@207photo.com", phone: "207-555-0142" }];
    RPC.me_digest = { on: true, enabled: true, email: "test@207photo.com" };
    RPC.me_digest_set = { ok: true };
    if (/[?&]nodevice=1\b/.test(location.search)) RPC.push_my_settings.devices = [];
  }
  // ws/jobs (2026-10-24): one job screen (the Booking tab), checklists on All jobs, crew links into their job.
  {
    if (/[?&]tracked=1\b/.test(location.search)) RPC.job_get.booking.status = "tracked";
    // view-only Bookings: no Edit booking. A part-timer (Open jobs only) opens a job they are on: crew access only.
    if (AS_VIEWER) RPC.job_get.can = Object.assign({}, RPC.job_get.can, { bookings_edit: false });
    if (AS_PART) RPC.job_get.can = { bookings: false, bookings_edit: false, pictureday: false, workflows: false, results: false, scheduling: false, crew: true };
    // My jobs: from home, and their own checklist steps on the job
    if (Array.isArray(RPC.crew_mine) && RPC.crew_mine[0]) Object.assign(RPC.crew_mine[0], { from_home: true, checklist_open: 2, checklist_late: 1 });
    // My day: one checklist step (a task made by a job checklist) next to the plain tasks
    if (Array.isArray(RPC.assignments_day)) RPC.assignments_day.push({ task_id: "w1", user_id: "u2", user_name: "Sam Helper", title: "Confirm start time and crew with the contact", notes: "", repeat: "once", priority: "normal",
      est_minutes: null, on_date: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), overdue: false, done_at: null, done_by: null, booking_id: "bk3", booking_title: "Island Cheer & Tumbling \u2022 Cheer" });
    RPC.schedule_remove = { ok: true };
  }
  // ws/director (2026-10-24): the director's picture day page, the booking's team times / order dates, Email statement.
  {
    const day = (n) => iso(n).slice(0, 10);
    const TOK = "d1a2b3c4d5e6f708192a3b4c5d6e7f8091a2";
    Object.assign(RPC, {
      booking_director_get: { team_times: "9:00 U10 Blue\n9:15 U10 Red", order_deadline: day(30), discount_ends: day(20), shoot_setting: "either", school_data: false,
        day_link: "https://admin.207photo.com/#day/" + TOK, calendar_link: "https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?t=" + TOK },
      booking_director_save: { ok: true, day_link: "https://admin.207photo.com/#day/" + TOK },
      partner_statement_queue: { ok: true, email_id: "m11", to: "csnowdeal75@gmail.com", paid_line: "Check for $380.00 mailed on March 2, 2026 (check #1042)." },
      booking_public: (/#day\/0{36}/.test(location.hash)) ? { found: false } : {
        found: true, cancelled: /[?&]daycancel=1\b/.test(location.search), org: "Brewer Travel Basketball Club", audience: "sports", workflow: "families", job: "Winter Sports",
        picture_day: day(12), days: [{ day: day(12), label: "", start: "5:00 PM", end: "7:00 PM" }], when_line: "Saturday, November 7, 5:00 PM to 7:00 PM", time_set: true,
        location: "Brewer Auditorium, 318 Wilson St, Brewer, ME", arrival: "4:30 PM",
        contact: { name: "Jeremiah Mutty", email: "jmutty@207photo.com", phone: "(207) 558-3185" },
        needs: "A spot about 15 by 15 feet out of direct sun (or a room with an outlet if we're indoors), and someone who can send teams over in order.",
        weather: "If we're shooting outside and rain or high winds are in the forecast, we'll need a backup plan. We'll touch base the day before.", shoot_setting: "outdoors",
        emergency: { name: "Jeremiah", phone: "(207) 299-3928", email: "jmutty@207photo.com" },
        team_times: ["5:00 U10 Blue", "5:15 U10 Red", "5:30 U12 Girls"], roster: "We have your roster. Thank you!",
        families: ["Nothing to pay on picture day, and no order forms.", "After picture day, every family on your roster gets an email and a text with a link to their own athlete's gallery.", "They order online from that gallery.", "The early-order discount ends Friday, November 27."],
        order_deadline: day(30), discount_ends: day(20), terms: "Your program gets 10% of online sales (before tax), paid by check after the season.",
        deliverables: [{ label: "Team composites", done: true, link: "https://www.dropbox.com/sh/x" }, { label: "Coach banner", done: false, link: null }],
        retake: "Missed picture day? There's no on-location makeup day; families can book a makeup at 207photo.com/makeups.", retake_day: null,
        hub: "207photo.com/sportsadmin", hub_link: "https://207photo.com/sportsadmin/#job=1",
        flyer: "A printable flyer, a parent email and a text message are written for you on the hub (207photo.com/sportsadmin). Post the flyer and send the email about a week before picture day.",
        agreement: { status: "sent", link: "https://admin.207photo.com/#agree/a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2", accepted_at: null },
        day_link: "https://admin.207photo.com/#day/" + TOK, calendar_link: "https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?t=" + TOK },
    });
    T.booking_settings.day_of_phone = "(207) 558-3185";
    Object.assign(T.booking_settings, { emergency_name: "Jeremiah", emergency_phone: "(207) 299-3928", emergency_email: "jmutty@207photo.com" });
    T.booking_settings.weather_plan = "Outdoor shoots move to your backup date or an indoor space. We decide together by 7:00 AM on picture day, and we email and call you either way.";
  }
  // adaptive booking emails (2026-10-24): staff tasks on Today and the job page's Parents tab
  {
    const day = (n) => iso(n).slice(0, 10);
    Object.assign(RPC, {
      booking_followups_mine: [{ id: "fu1", booking_id: "bk1", kind: "roster", key: "roster", title: "No roster: Brewer Travel Basketball Club",
        detail: "Brewer Travel Basketball Club has picture day soon and no roster with parent emails yet. Keep the date and run it as Roster Only, or move it.",
        org: "Brewer Travel Basketball Club", picture_day: day(12), created_at: iso(0) }],
      booking_parents: { audience: "sports", shoot_setting: "outdoors", school_data_at: null, coaches: 0, roster_loaded_at: null, code_count: 0, workflow: "families",
        messages: [{ key: "heads", title: "One week before", due: day(5), sent_at: null, copied_at: iso(-20), counts_from: day(2) },
                   { key: "day", title: "Day before", due: day(11), sent_at: null, copied_at: null, counts_from: day(9) },
                   { key: "live", title: "Photos are online", due: null, sent_at: null, copied_at: null, counts_from: null },
                   { key: "lastcall", title: "Last call", due: null, sent_at: null, copied_at: null, counts_from: null }],
        clicks: [{ at: iso(-1), url: "https://207photo.com/sportsadmin/#job=1/send=heads/r", subject: "Tomorrow: send your \"One week before\" message" }],
        weather: [{ day: day(12), checked_at: iso(0), max_pop: 40, max_gust: 12, bad: true, error: null }],
        followups: [{ id: "fu1", kind: "roster", key: "roster", title: "No roster: Brewer Travel Basketball Club", detail: "Keep the date and run it as Roster Only, or move it.",
          created_at: iso(0), done_at: null, done_note: null, snooze_until: null }] },
      booking_followup_done: { ok: true }, booking_followup_snooze: { ok: true }, booking_run_roster_only: { ok: true },
    });
  }
  // ws/agreement (2026-10-24): the school agreement builder. Hancock Grammar School is the school partner.
  {
    const day = (n) => iso(n).slice(0, 10);
    const H = "22222222-2222-2222-2222-222222222222";
    const STD = { RATIO: "300", TA_GALLERY: "10", TA_FILES: "15", TA_COMPOSITE: "30", TA_CARDS: "15", TA_SHIP: "3", INS_OCC: "1000000", INS_AGG: "2000000", INS_SAM_AMT: "1000000",
      FIX_RATE: "75", RESCHED_FEE: "250", LIAB_CAP: "10000", COUNTY: "Penobscot", SPACE_SIZE: "20 ft by 30 ft", SETUP_MIN: "30", BREAKDOWN: "30", NET_DAYS: "30", ROSTER_EMAIL: "info@207photo.com" };
    RPC.agreement_orgs = RPC.agreement_orgs.concat([{ id: H, name: "Hancock Grammar School", town: "Hancock", stage: "client", audience: "school" }]);
    RPC.agreements_list = RPC.agreements_list.concat([{ id: "ag2", org_id: H, org: "Hancock Grammar School", title: "School Photography Service Agreement 2026-2027", status: "draft",
      picture_day: day(30), renewal_date: day(250), w9_status: "not_needed", coi_status: "needed", token: "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2", email: null, has_builder: true, audience: "school" }]);
    const ctx = {
      org: { id: H, name: "Hancock Grammar School", town: "Hancock", audience: "school", legal_name: "", billing_address: "" },
      contacts: [{ id: "c4", name: "Pat Lee", role: "Principal", email: "plee@hancock.k12.me.us", phone: "207-555-0144", primary: true },
                 { id: "c6", name: "Ann Office", role: "Secretary", email: "office@hancock.k12.me.us", phone: "", primary: false }],
      bookings: [{ id: "bk2", picture_day: day(30), retake_day: day(58), status: "booked", type_key: "school", audience: "school", label: "School Photos" }],
      defaults: STD, last: null, agreement: null, from: null };
    // With p_id: the saved draft (ag2) and its choices.
    Object.defineProperty(RPC, "agreement_builder_context", { enumerable: true, get() {
      const last = window.__rpcCalls[window.__rpcCalls.length - 1] || [];
      const a = last[1] || {};
      if (a.p_id === "ag2") return Object.assign({}, ctx, { agreement: { id: "ag2", status: "draft", title: "School Photography Service Agreement 2026-2027", booking_id: "bk2", token: "b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2",
        builder: { on: { FALL: true, YEARBOOK: true, EXCLUSIVITY: true }, val: { SCHOOL_NAME: "Hancock Grammar School", BUILDINGS: "Main building", YEAR_START: "2026", YEAR_END: "2027", FALL: day(30), RATIO: "250" } } } });
      return ctx;
    } });
    RPC.agreement_builder_save = { ok: true, id: "ag9" };
    RPC.agreement_builder_apply = { ok: true, jobs: 1, added: 4, message: "Added 4 deliverables to 1 job." };
    RPC.agreement_defaults_save = { ok: true };
    // The public page: the builder token shows stored HTML (with junk the page must strip).
    const plain = RPC.agreement_public;
    const built = { found: true, title: "School Photography Service Agreement 2026-2027", org: "Hancock Grammar School", picture_day: day(30), status: "sent", text: "SCHOOL PHOTOGRAPHY SERVICE AGREEMENT",
      html: '<div class="ab-doc-in"><h1 class="ab-p ab-title">SCHOOL PHOTOGRAPHY SERVICE AGREEMENT</h1><h2 class="ab-sec">8. EXCLUSIVITY</h2><p class="ab-p evil" style="color:red">For the term of this Agreement.</p>' +
        '<script>window.__pwn = 1<\/script><img src="x" onerror="window.__pwn = 2"><a href="javascript:window.__pwn=3">link text</a><table class="ab-table ab-w190"><tbody><tr><td class="ab-b">School or SAU</td><td class="ab-b">Hancock Grammar School</td></tr></tbody></table></div>' };
    Object.defineProperty(RPC, "agreement_public", { enumerable: true, get() { return /#agree\/b1b2/.test(location.hash) ? built : plain; } });
  }
  // ws/partners (2026-10-24): booking "Don't send", the Brewer booking carries GotPhoto job "1" (help request links),
  // ?clients=1 makes Brewer a client (the Partners list opens on Clients).
  {
    RPC.booking_email_skip = { ok: true, status: "skipped" };
    RPC.admin_bookings[0].gotphoto_job_id = "1";
    if (/[?&]clients=1\b/.test(location.search)) T.prospect_orgs.filter((o) => o.id === "11111111-1111-1111-1111-111111111111")
      .forEach((o) => Object.assign(o, { stage: "client", client_since: "2024-09-01", last_job_at: "2026-09-19", next_job_at: iso(12).slice(0, 10) }));
  }

  if (RPC.time_off_list && RPC.time_off_list.team[0]) RPC.time_off_list.team[0].jobs.forEach((j) => { j.booking_id = "bk5"; }); // B7: jobs carry booking_id
  window.__RPC = RPC; // screenshots can adjust the fake data
  window.supabase = { createClient: () => ({
    auth: { getSession: async () => ({ data: { session: /[?&]signedout=1\b/.test(location.search) ? null : { user: { email: "test@207photo.com" }, access_token: "x" } } }), // ws/shell: ?signedout=1 shows sign-in
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}),
            updateUser: async (u) => (window.__writes = (window.__writes || []).concat([["auth", "updateUser", Object.keys(u)]]), { data: {}, error: null }),
            // ws/shell (2026-10-24): Forgot password on the sign-in form
            resetPasswordForEmail: async (email, o) => (window.__writes = (window.__writes || []).concat([["auth", "resetPasswordForEmail", email, o && o.redirectTo]]), { data: {}, error: null }) },
    from: q, storage, rpc: async (n, a) => (window.__rpcCalls.push([n, a]), { data: RPC[n] !== undefined ? RPC[n] : [], error: null }),
  }) };
  // Edge functions: the Team page's account actions.
  const realFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (String(url).includes("/functions/v1/team")) {
      const b = JSON.parse(opts.body);
      window.__teamCalls = (window.__teamCalls || []).concat([b]);
      return new Response(JSON.stringify({ ok: true, user_id: "u9", temp_password: "k7mp-2qrx-h8vt-w3nd", emailed: b.send_welcome === true, email_error: null }), { status: 200 });
    }
    if (String(url).includes("/functions/v1/offer-drive")) {
      window.__offerDriveCalls = (window.__offerDriveCalls || []).concat([JSON.parse(opts.body)]);
      return new Response(JSON.stringify({ ok: true, asked: 3, stored: 3, missed: 0 }), { status: 200 });
    }
    if (String(url).includes("/functions/v1/admin/gplists")) {
      return new Response(JSON.stringify({ ok: true, price_profiles: [{ id: "pp-fall", name: "Fall Sports 2026" }, { id: "pp-spring", name: "Spring Sports 2027" }], communication_profiles: [{ id: "cp1", name: "League emails" }] }), { status: 200 });
    }
    if (String(url).includes("/functions/v1/admin/gpjob")) {
      window.__gpjobCalls = (window.__gpjobCalls || []).concat([String(url)]);
      if (String(url).includes("dry=1")) return new Response(JSON.stringify({ ok: true, linked: 0, dry: true, made: [{ booking_id: "bk1", template: "Inferno Hockey | Winter | 2026",
        body: { name: "Brewer Travel Basketball Club | Winter Sports | 2026", internal_name: "JOB00867", shoot: "2026-11-16", archive: "2026-12-16", price_profile_id: "pp-fall", communication_profile_id: "cp1", access_type: "qr_tagging", password_source: "qr_code_list" } }] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, linked: 0, made: [{ booking_id: "bk1", gotphoto_job_id: "9001", name: "Brewer Travel Basketball Club | Winter Sports | 2026" }] }), { status: 200 });
    }
    if (String(url).includes("/functions/v1/admin/sales")) {
      window.__salesCalls = (window.__salesCalls || 0) + 1;
      return new Response(JSON.stringify({ ok: true, jobs: 3, left: 0, errors: {} }), { status: 200 });
    }
    if (String(url).includes("/functions/v1/drive-time")) {
      window.__driveCalls = (window.__driveCalls || []).concat([JSON.parse(opts.body)]);
      if (JSON.parse(opts.body).from_booking_id) return new Response(JSON.stringify({ ok: true, minutes: 12, meters: 9000, origin: "89 Western Ave, Hampden ME", destination: "Dorothea Dix Park, Hampden ME" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, minutes: 23, meters: 21000, destination: "89 Western Ave, Hampden ME" }), { status: 200 });
    }
    if (String(url).includes("/functions/v1/place-search")) {
      const b = JSON.parse(opts.body);
      window.__placeCalls = (window.__placeCalls || []).concat([b]);
      if (b.place_id === "ChIJstudio00000001") return new Response(JSON.stringify({ ok: true, name: "60 Main Rd N", address: "60 Main Rd N, Hampden, ME 04444, USA" }), { status: 200 });
      if (b.place_id) return new Response(JSON.stringify({ ok: true, name: "James F. Doughty Middle School", address: "143 Fifth St, Bangor, ME 04401, USA" }), { status: 200 });
      if (b.kind === "town") return new Response(JSON.stringify({ ok: true, places: [{ id: "ChIJbangor00000001", name: "Bangor", detail: "ME, USA" }, { id: "ChIJbangor00000002", name: "Bangor", detail: "PA, USA" }] }), { status: 200 });
      if (/main/i.test(b.q)) return new Response(JSON.stringify({ ok: true, places: [{ id: "ChIJstudio00000001", name: "60 Main Road North", detail: "Hampden, ME, USA" }] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, places: [
        { id: "ChIJdoughty0000001", name: "James F. Doughty Middle School", detail: "Fifth Street, Bangor, ME, USA" },
        { id: "ChIJdoughty0000002", name: "Doughty Field", detail: "Hampden, ME, USA" }] }), { status: 200 });
    }
    return realFetch(url, opts);
  };
})();
