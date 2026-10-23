  // ================================================================ JOBS: hub activity (part of each job since 2026-10-25)
  // Which parent messages each team / school has grabbed on /sportsadmin/ and /schooladmin/. All of it (send dates,
  // statuses, grabs) comes from the admin-only RPC admin_hub_activity(); hub_events is not readable any other way.
  // A copy means they grabbed the message, not that they sent it, so the label is "Grabbed".
  // There is no Hub activity page any more: each job's Parents tab (parents-reach.js) shows who grabbed which message,
  // the hub link and the school's access code (HubActivity.forBooking), and Today's "hub message late" lines name the
  // jobs, each opening its Parents tab. Old #jobs/hubact and #jobs/schools links land on All jobs (MOVED in shell-top.js).
  // Reminder contacts follow the booking's contacts (change them on the job's Booking tab).
  Object.assign(JOB_REASON, { hubLate: "a hub message is late: nudge them" });

  let hubActList = [], hubActAt = 0, hubActLoading = null;
  let hubBookings = {}; // "sports:<gotphoto job id>" / "school:<hub school id>" -> booking (booked or tracked)

  async function fetchHubActivity() {
    const { data, error } = await supabase.rpc("admin_hub_activity");
    if (error) throw error;
    hubActList = Array.isArray(data) ? data : [];
    hubActAt = Date.now();
    return hubActList;
  }

  // Today: the late ones that have a job, each opening that job's Parents tab.
  async function loadHubActivity() {
    try { await fetchHubActivity(); } catch (_e) { setAttention("hubLate", 0, "", "bookings", "err"); return; }
    hubBookings = {};
    try {
      const from = new Date(Date.now() - 90 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const { data: bk } = await supabase.rpc("admin_bookings", { p_from: from, p_to: null });
      (bk || []).forEach((b) => {
        if (b.status !== "booked" && b.status !== "tracked") return;
        if (b.gotphoto_job_id) hubBookings["sports:" + b.gotphoto_job_id] = b;
        if (b.hub_school_id) hubBookings["school:" + b.hub_school_id] = b;
      });
    } catch (_e) { /* no jobs to point at: nothing to list */ }
    const jobs = hubActList.filter((o) => o.late_count > 0 && hubBookings[o.hub + ":" + o.org_id])
      .map((o) => { const b = hubBookings[o.hub + ":" + o.org_id]; return { id: b.id, title: b.title || o.org, day: o.picture_day, tab: "parents" }; });
    setAttention("hubLate", jobs.length, jobs.length === 1 ? "job with a late hub message" : "jobs with late hub messages", "bookings", "err", null, jobs);
  }

  // One job's hub row: { hub, org_id, org, picture_day, sends: [{ key, title, status, who, formats, last_at, grabs }] }, or null.
  // Reuses what Today loaded in the last minute.
  async function hubRowFor(hub, orgId) {
    if (!hub || !orgId) return null;
    if (Date.now() - hubActAt > 60000) {
      if (!hubActLoading) hubActLoading = fetchHubActivity().finally(() => { hubActLoading = null; });
      await hubActLoading;
    }
    return hubActList.find((o) => o.hub === hub && String(o.org_id) === String(orgId)) || null;
  }
  const hubLinkFor = (hub, orgId) => hub === "sports"
    ? "https://207photo.com/sportsadmin/#job=" + encodeURIComponent(orgId)
    : "https://207photo.com/schooladmin/#school=" + encodeURIComponent(orgId);
  const HUB_FORMAT = { email: "email", text: "text", flyer: "flyer", social: "social post" };
  // "Grabbed by pat@hll.org (email, text) Oct 12" for one message, or "".
  function grabbedLine(s) {
    if (!s || !(s.grabs > 0)) return "";
    const formats = (s.formats || []).map((f) => HUB_FORMAT[f] || f).join(", ");
    return "Grabbed" + ((s.who || []).length ? " by " + s.who.join(", ") : "") + (formats ? " (" + formats + ")" : "") +
      (s.last_at ? " " + Fmt.day(String(s.last_at).slice(0, 10)) : "") + (s.grabs > 1 ? ", " + num(s.grabs) + " grabs" : "");
  }
  const HubActivity = { forBooking: hubRowFor, link: hubLinkFor, grabbedLine };
