  // ================================================================ JOBS: Picture day planner (2026-10-22)
  // For each booked picture day: 1. email the organization a form (teams and coaches, on-site contact, fields,
  // uniforms and props, roster file; public page in pictureday-public.js), 2. lay out a time slot for each team by
  // field, 3. email each coach their time; they confirm or ask to move. View = see it all; Edit = change and send.
  // Everything goes through RPCs (supabase/migrations/20261022213500_picture_day_planner.sql): pd_list, pd_get,
  // pd_save_plan, pd_save_team, pd_save_slots, pd_remove_team, pd_send_intake, pd_slot_preview, pd_send_slots,
  // pd_attention. Emails follow the Booking emails switch and test mode (Settings > Sending).
  registerPage({ id: "pictureday", label: "Picture days", group: "Jobs", section: "jobs", module: "pictureday",
                 tabs: [["pictureday", "Picture days"]], onShow: () => PictureDay.show() });
  registerAttention("pdMove", { module: "pictureday", level: "warn", name: "coach time changes",
    one: "A coach asked to move their team's picture day time.", many: "{n} coaches asked to move their team's picture day time." });
  registerAttention("pdToPlan", { module: "pictureday", level: "soon", name: "picture day forms",
    one: "A picture day form came back. Lay out the team times.", many: "{n} picture day forms came back. Lay out the team times." });
  registerTodayLoader("pictureday", () => PictureDay.loadAttention());

  const PictureDay = (function () {
    const T = StaffTime;
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const css = `
    .aca .pd-list { width: 100%; }
    .aca .pd-list td { vertical-align: top; padding: 10px 8px 10px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; }
    .aca .pd-list th { text-align: left; font-size: 12px; color: var(--faint); font-weight: 600; padding: 8px 8px 6px 0; border-bottom: 1px solid var(--border); }
    .aca .pd-list tr.go { cursor: pointer; } .aca .pd-list tr.go:hover td { background: var(--surface-2); }
    .aca .pd-list .sub { display: block; color: var(--muted); font-size: 12.5px; }
    .aca .pd-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 4px 0 2px; }
    .aca .pd-head h2 { margin: 0; font-size: 19px; font-weight: 600; }
    .aca .pd-meta { margin: 0 0 18px; color: var(--muted); font-size: 13.5px; }
    .aca .pd-banner { margin: 0 0 18px; padding: 9px 12px; border-radius: 4px; background: var(--warn-bg); color: var(--warn-fg); font-size: 13px; }
    .aca .pd-step { margin-bottom: 30px; }
    .aca .pd-step h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; color: var(--head); }
    .aca .pd-step > p.muted { margin: 0 0 10px; font-size: 13px; max-width: 80ch; }
    .aca .pd-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    .aca .pd-row select { max-width: 320px; }
    .aca .pd-dl { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 6px 14px; margin: 12px 0 0; font-size: 13.5px; max-width: 760px; }
    .aca .pd-dl dt { color: var(--muted); } .aca .pd-dl dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .aca .pd-board { display: grid; grid-template-columns: repeat(var(--cols), minmax(190px, 1fr)); gap: 12px; overflow-x: auto; padding-bottom: 4px; }
    .aca .pd-col { background: var(--surface-2); border-radius: 6px; padding: 8px; min-width: 0; }
    .aca .pd-col h4 { margin: 2px 4px 8px; font-size: 13px; font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
    .aca .pd-col h4 small { color: var(--muted); font-weight: 400; }
    .aca .pd-col.loose { background: transparent; border: 1px dashed var(--border); }
    .aca button.pd-team { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 2px 8px; width: 100%; height: auto; padding: 7px 8px; margin: 0 0 6px; text-align: left; font-weight: 400; white-space: normal; background: var(--surface); border: 1px solid var(--border); border-left: 3px solid #b9b4aa; }
    .aca button.pd-team b { font-size: 13.5px; } .aca button.pd-team .t { font-weight: 700; font-variant-numeric: tabular-nums; }
    .aca button.pd-team .c { grid-column: 2; color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; }
    .aca button.pd-team .s { grid-column: 2; }
    .aca button.pd-team.st-confirmed { border-left-color: var(--ok-fg); } .aca button.pd-team.st-move { border-left-color: var(--accent); }
    .aca button.pd-team.st-sent { border-left-color: #2f6db5; } .aca button.pd-team.changed { border-left-color: #f0b429; }
    .aca .pd-note { display: block; margin-top: 2px; color: var(--accent); font-size: 12.5px; white-space: pre-wrap; }
    .aca .pd-coaches td { padding: 8px 8px 8px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; vertical-align: top; }
    .aca .pd-coaches td.r { text-align: right; white-space: nowrap; }
    .aca .pd-log { margin: 6px 0 0; padding: 0; list-style: none; font-size: 13px; }
    .aca .pd-log li { padding: 5px 0; border-bottom: 1px solid var(--line2); display: flex; gap: 10px; flex-wrap: wrap; }
    .aca .pd-log .muted { font-size: 12.5px; }
    .aca .pd-modal .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .aca .pd-modal .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
    .aca .pd-modal .field input, .aca .pd-modal .field select, .aca .pd-modal .field textarea { width: 100%; }
    .aca .pd-modal textarea { min-height: 64px; padding: 6px 10px; }
    .aca .pd-pre { white-space: pre-wrap; background: var(--surface-2); border-radius: 4px; padding: 12px; font-size: 13px; max-height: 50vh; overflow: auto; }
    @media (max-width: 700px) {
      .aca .pd-list .hide-sm { display: none; }
      .aca .pd-board { grid-template-columns: 1fr; }
      .aca .pd-dl { grid-template-columns: 1fr; gap: 0 0; } .aca .pd-dl dd { margin-bottom: 8px; }
      .aca .pd-modal .row2, .aca .pd-modal .row3 { grid-template-columns: 1fr; }
      .aca .pd-coaches tr { display: block; padding: 8px 0; border-bottom: 1px solid var(--line2); }
      .aca .pd-coaches td { display: block; padding: 1px 0; border: 0; } .aca .pd-coaches td.r { text-align: left; }
    }`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    let D = null; // pd_get result for the open picture day
    const root = () => el("panel-pictureday");
    const openId = () => { const m = /^#jobs\/pictureday\/([^/?]+)/.exec(location.hash); return m ? m[1] : null; };
    const fmtDayIso = (d) => (d ? T.fmtDay(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "");
    const timeOf = (ts) => (ts ? T.fmtTs(ts) : "");
    const lenOf = (t) => t.slot_min || (D && D.plan ? D.plan.slot_min : 10);

    function show() { const id = openId(); if (id) open(id); else list(); }

    // ---------------------------------------------------------------- the list
    async function list() {
      D = null;
      const r = root();
      r.innerHTML = '<div class="card"><div class="card-head"><div><h2>Picture days</h2><p>Booked picture days from last week on. Open one to send the organization its form, lay out a time for each team by field, and email each coach their time to confirm.</p></div></div><div id="aca-pdList"><div class="empty"><span class="spin"></span>Loading&#8230;</div></div></div>';
      const { data, error } = await sb.rpc("pd_list");
      const box = el("pdList");
      if (!box) return;
      if (error) { box.innerHTML = '<div class="inline-error">' + esc(cleanErr(error)) + "</div>"; return; }
      const rows = data || [];
      if (!rows.length) { box.innerHTML = '<div class="empty">No booked picture days coming up.</div>'; return; }
      box.innerHTML = '<table class="pd-list"><thead><tr><th>Date</th><th>Job</th><th>Form</th><th class="hide-sm">Teams</th><th>Coaches</th><th class="hide-sm">Ready</th></tr></thead><tbody>' +
        rows.map((b) => {
          const form = b.submitted_at ? '<span class="pill ok">Filled in</span>' : b.intake_sent_at ? '<span class="pill">Sent ' + esc(fmtAgo(b.intake_sent_at)) + "</span>" : '<span class="pill muted">Not sent</span>';
          const n = num(b.teams);
          const coach = !n ? '<span class="muted">&#8212;</span>' :
            [num(b.move) ? '<span class="pill warn">' + num(b.move) + " want to move</span>" : "",
             num(b.changed) ? '<span class="pill warn">' + num(b.changed) + " changed since sent</span>" : "",
             '<span class="sub">' + num(b.confirmed) + " of " + n + " confirmed" + (num(b.sent) < n ? ", " + (n - num(b.sent)) + " not sent" : "") + "</span>"].join(" ");
          return '<tr class="go" data-open="' + esc(b.booking_id) + '"><td class="tnum">' + esc(fmtDayIso(b.picture_day)) +
            '<span class="sub">' + (b.time_set ? esc(timeOf(b.start_at)) : "time not set") + "</span></td>" +
            "<td><b>" + esc(b.title) + '</b><span class="sub">' + esc(b.location || "") + "</span></td><td>" + form + '</td><td class="hide-sm tnum">' +
            n + (n ? '<span class="sub">' + num(b.timed) + " with a time</span>" : "") + "</td><td>" + coach + '</td><td class="hide-sm rd-cell" data-rd="' + esc(b.booking_id) + '"></td></tr>';
        }).join("") + "</tbody></table>";
      box.querySelectorAll("[data-open]").forEach((tr) => tr.addEventListener("click", () => {
        history.replaceState(null, "", "#jobs/pictureday/" + tr.dataset.open); open(tr.dataset.open);
      }));
      Readiness.fillList(box);
    }

    // ---------------------------------------------------------------- one picture day
    async function open(id, keepScroll) {
      const r = root();
      if (!D || D.booking.id !== id) r.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const y = window.scrollY;
      const { data, error } = await sb.rpc("pd_get", { p_booking: id });
      if (error) { r.innerHTML = '<p><button type="button" class="link" id="aca-pdBack">&#8592; Picture days</button></p><div class="inline-error">' + esc(cleanErr(error)) + "</div>"; el("pdBack").onclick = back; return; }
      D = data;
      render();
      if (keepScroll) window.scrollTo(0, y);
    }
    function back() { history.replaceState(null, "", "#jobs/pictureday"); list(); }
    const reload = () => open(D.booking.id, true);

    function fieldsOf() {
      const f = (D.plan && D.plan.fields) || [];
      const used = D.teams.map((t) => t.field).filter(Boolean);
      return f.concat(used.filter((x, i) => used.indexOf(x) === i && !f.includes(x)));
    }

    function teamStatus(t) {
      if (!t.coach_email) return '<span class="pill muted">No coach email</span>';
      if (t.email_status === "failed") return '<span class="pill err">Email failed</span>';
      if (t.status === "move") return '<span class="pill warn">Wants to move</span>';
      if (t.changed) return '<span class="pill warn">Changed since sent</span>';
      if (t.status === "confirmed") return '<span class="pill ok">Confirmed</span>';
      if (t.status === "sent") return t.email_status === "waiting" ? '<span class="pill">Waiting to send</span>' : '<span class="pill accent">Sent</span>';
      return t.slot_at ? '<span class="pill muted">Not sent</span>' : '<span class="pill muted">No time yet</span>';
    }

    function render() {
      const b = D.booking, p = D.plan, edit = canEdit("pictureday") && !!p;
      const r = root();
      const s = D.sending || {};
      let h = '<p style="margin:0 0 8px"><button type="button" class="link" id="aca-pdBack">&#8592; Picture days</button></p>' +
        '<div class="pd-head"><h2>' + esc(b.title) + "</h2></div>" +
        '<p class="pd-meta">' + esc(fmtDayIso(b.picture_day)) + (b.time_set ? ", " + esc(timeOf(b.start_at)) + (b.end_at ? " to " + esc(timeOf(b.end_at)) : "") : ", time not set") +
        (b.location ? " &#183; " + esc(b.location) : "") + "</p>" + '<div class="rd-strip" id="aca-rdStrip"></div>';
      if (b.status !== "booked") h += '<div class="pd-banner">This job is ' + esc(b.status) + ". Only booked jobs send anything.</div>";
      else if (!s.enabled) h += '<div class="pd-banner"><b>Booking emails are switched off.</b> Emails you send here wait until they are switched back on (Settings &#8250; Sending).</div>';
      else if (s.test_mode) h += '<div class="pd-banner"><b>Test mode.</b> Every email goes to ' + esc(s.test_recipient || "the test address") + " with a [TEST] subject.</div>";
      if (!p) { r.innerHTML = h + '<div class="empty">Nobody has started planning this picture day yet.</div>'; el("pdBack").onclick = back; Readiness.fillDetail(el("rdStrip"), b.id, false); return; }

      // 1. the form
      const sentLine = p.submitted_at ? '<span class="pill ok">Filled in ' + esc(fmtDate(p.submitted_at)) + "</span>" +
          (p.updated_by_contact_at && p.updated_by_contact_at !== p.submitted_at ? ' <span class="muted">updated ' + esc(fmtAgo(p.updated_by_contact_at)) + "</span>" : "")
        : p.intake_sent_at ? '<span class="pill">Sent to ' + esc(p.contact_name || p.contact_email) + " " + esc(fmtAgo(p.intake_sent_at)) + "</span> <span class=\"muted\">Not filled in yet.</span>"
        : '<span class="pill muted">Not sent yet</span>';
      h += '<div class="pd-step"><h3>1. The organization&#8217;s form</h3><p class="muted">Their teams and coaches, who is on site, the fields we can use, uniforms and props, and a roster file. They can come back to it and change their answers until picture day.</p>' +
        '<div class="pd-row">' + sentLine + "</div>";
      if (edit) {
        const opts = D.contacts.map((c) => '<option value="' + esc(c.id) + '"' + (p.contact_id === c.id ? " selected" : "") + ">" + esc((c.name || c.email) + (c.role ? " (" + c.role + ")" : "") + " – " + c.email) + "</option>").join("");
        h += '<div class="pd-row"><select id="aca-pdContact" aria-label="Send the form to">' + opts + '<option value="">Someone else&#8230;</option></select>' +
          '<input type="email" id="aca-pdOther" class="hidden" placeholder="name@example.org" aria-label="Their email" style="width:240px" />' +
          '<button type="button" class="primary small" id="aca-pdSendForm">' + (p.intake_sent_at ? "Send the form again" : "Email the form") + "</button>" +
          '<button type="button" class="small" id="aca-pdCopy">Copy link</button><button type="button" class="small" id="aca-pdEdit">Edit answers</button></div>';
      }
      const dl = [["On site", [p.onsite_name, p.onsite_phone].filter(Boolean).join(", ")], ["Where", p.location || b.location || ""],
        ["Fields", (p.fields || []).join(", ")], ["Uniforms", p.uniforms], ["Bring", p.props], ["Notes", p.notes]].filter((x) => x[1]);
      if (dl.length || p.roster_path) {
        h += '<dl class="pd-dl">' + dl.map((x) => "<dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd>").join("") +
          (p.roster_path ? '<dt>Roster</dt><dd><button type="button" class="link" id="aca-pdRoster">' + esc(p.roster_name || "Download") + '</button> <span class="muted">' + esc(fmtAgo(p.roster_at)) + "</span></dd>" : "") + "</dl>";
      }
      h += "</div>";

      // 2. team times
      const fields = fieldsOf(), cols = (fields.length ? fields : ["Field 1"]);
      const loose = D.teams.filter((t) => !t.slot_at || !cols.includes(t.field));
      const startHm = b.time_set && b.start_at ? T.hhmm(T.local(b.start_at).min) : "09:00";
      h += '<div class="pd-step"><h3>2. Team times</h3><p class="muted">One column per field. Lay out times puts every team without a time into the next free slot, field by field. Click a team to change it.</p>';
      if (edit) {
        h += '<div class="pd-row"><label for="aca-pdLen">Each team</label><input type="number" id="aca-pdLen" min="3" max="120" value="' + num(p.slot_min) + '" /> <span class="muted">min, from</span>' +
          '<input type="time" id="aca-pdStart" value="' + esc(startHm) + '" aria-label="First slot" />' +
          '<button type="button" class="small" id="aca-pdLayout">Lay out times</button><button type="button" class="small" id="aca-pdRelayout">Start over</button>' +
          '<button type="button" class="small" id="aca-pdAdd">Add team</button><button type="button" class="small quiet" id="aca-pdPrint">Print day sheet</button></div>';
      } else h += '<div class="pd-row"><button type="button" class="small quiet" id="aca-pdPrint">Print day sheet</button></div>';
      if (!D.teams.length) h += '<div class="empty">No teams yet. They come in with the form' + (edit ? ", or add them here" : "") + ".</div>";
      else {
        const card = (t) => '<button type="button" class="pd-team st-' + esc(t.status) + (t.changed ? " changed" : "") + '" data-team="' + esc(t.id) + '">' +
          '<span class="t">' + (t.slot_at ? esc(timeOf(t.slot_at)) : "&#8212;") + "</span><b>" + esc(t.name) + "</b>" +
          '<span class="c">' + esc(t.coach_name || t.coach_email || "No coach yet") + (t.players ? " &#183; " + num(t.players) + " players" : "") + "</span>" +
          '<span class="s">' + teamStatus(t) + (t.status === "move" && t.coach_note ? '<span class="pd-note">&#8220;' + esc(t.coach_note) + "&#8221;</span>" : "") + "</span></button>";
        const byTime = (a, c) => String(a.slot_at || "").localeCompare(String(c.slot_at || "")) || a.sort - c.sort;
        h += '<div class="pd-board" style="--cols:' + (cols.length + (loose.length ? 1 : 0)) + '">' +
          cols.map((f) => { const ts = D.teams.filter((t) => t.slot_at && t.field === f).sort(byTime);
            const last = ts[ts.length - 1];
            return '<div class="pd-col"><h4>' + esc(f) + "<small>" + ts.length + (last ? " &#183; done " + esc(T.fmtMin((T.local(last.slot_at).min + lenOf(last)) % 1440)) : "") + "</small></h4>" + ts.map(card).join("") + "</div>"; }).join("") +
          (loose.length ? '<div class="pd-col loose"><h4>No time yet<small>' + loose.length + "</small></h4>" + loose.map(card).join("") + "</div>" : "") + "</div>";
      }
      h += "</div>";

      // 3. coaches
      const ready = D.teams.filter((t) => t.slot_at && t.coach_email && (t.status === "new" || t.changed));
      const notInBooking = D.teams.filter((t) => t.coach_email && !D.booking_coaches.includes(t.coach_email.toLowerCase()));
      h += '<div class="pd-step"><h3>3. Coaches</h3><p class="muted">Each coach gets their team&#8217;s time, the field, uniforms and what to bring, with a link to confirm or ask to move. Replies go to the booking emails inbox.</p>';
      if (edit) {
        h += '<div class="pd-row"><button type="button" class="primary small" id="aca-pdSendSlots"' + (ready.length ? "" : " disabled") + ">" +
          (ready.length ? "Email " + ready.length + " coach" + (ready.length === 1 ? "" : "es") + " their time" : "Every coach with a time has it") + "</button>" +
          (ready.length ? '<button type="button" class="small" id="aca-pdPreview">Preview</button>' : "") +
          (notInBooking.length && canEdit("bookings") ? '<button type="button" class="small quiet" id="aca-pdToBooking" title="Adds them to this booking’s coach emails (checklist, photos online)">Add ' + notInBooking.length + " to the booking&#8217;s coach emails</button>" : "") + "</div>";
      }
      if (D.teams.length) {
        h += '<table class="pd-coaches"><tbody>' + D.teams.slice().sort((a, c) => String(a.slot_at || "~").localeCompare(String(c.slot_at || "~"))).map((t) =>
          "<td><b>" + esc(t.name) + '</b><br><span class="muted">' + (t.slot_at ? esc(timeOf(t.slot_at)) + (t.field ? ", " + esc(t.field) : "") : "No time yet") + "</span></td>" +
          "<td>" + esc(t.coach_name || "") + (t.coach_email ? '<br><span class="muted">' + esc(t.coach_email) + "</span>" : "") + (t.coach_phone ? '<br><span class="muted">' + esc(t.coach_phone) + "</span>" : "") + "</td>" +
          "<td>" + teamStatus(t) + (t.coach_note ? '<span class="pd-note">&#8220;' + esc(t.coach_note) + "&#8221;</span>" : "") + (t.responded_at ? '<br><span class="muted">' + esc(fmtAgo(t.responded_at)) + "</span>" : "") + "</td>" +
          '<td class="r">' + (edit && t.status !== "new" && t.coach_email && t.slot_at ? '<button type="button" class="small quiet" data-again="' + esc(t.id) + '">Send again</button>' : "") + "</td>").map((x) => "<tr>" + x + "</tr>").join("") + "</tbody></table>";
      }
      h += "</div>";

      // emails
      if (D.emails.length) {
        const stat = { waiting: '<span class="pill">Waiting</span>', sent: '<span class="pill ok">Sent</span>', failed: '<span class="pill err">Failed</span>', cancelled: '<span class="pill muted">Cancelled</span>' };
        h += '<div class="pd-step"><h3>Emails</h3><ul class="pd-log">' + D.emails.map((e) => "<li>" + (stat[e.status] || esc(e.status)) +
          "<span>" + esc(e.kind === "intake" ? "Form" : "Time") + " to " + esc(e.to_name ? e.to_name + " <" + e.to_email + ">" : e.to_email) + "</span>" +
          '<span class="muted">' + esc(fmtDate(e.sent_at || e.created_at)) + (e.test_mode ? " (test: " + esc(e.sent_to || "") + ")" : "") + (e.error ? " &#183; " + esc(e.error) : "") + "</span></li>").join("") + "</ul></div>";
      }
      r.innerHTML = h;
      Readiness.fillDetail(el("rdStrip"), b.id, canEdit("pictureday"));
      wire(edit);
    }

    function wire(edit) {
      el("pdBack").onclick = back;
      root().querySelectorAll("[data-team]").forEach((b) => b.addEventListener("click", () => teamModal(D.teams.find((t) => t.id === b.dataset.team))));
      el("pdPrint").onclick = printSheet;
      const ro = el("pdRoster");
      if (ro) ro.onclick = async () => {
        const { data, error } = await sb.storage.from("pictureday").createSignedUrl(D.plan.roster_path, 300, { download: D.plan.roster_name || true });
        if (error) { toast(cleanErr(error), true); return; }
        window.open(data.signedUrl, "_blank", "noopener");
      };
      if (!edit) return;
      const sel = el("pdContact");
      const other = () => el("pdOther").classList.toggle("hidden", sel.value !== "");
      sel.onchange = other; other();
      el("pdSendForm").onclick = async () => {
        const b = el("pdSendForm"); b.disabled = true;
        try {
          const args = sel.value ? { p_plan: D.plan.id, p_contact: sel.value } : { p_plan: D.plan.id, p_contact: null, p_email: el("pdOther").value.trim() };
          const { data, error } = await sb.rpc("pd_send_intake", args);
          if (error) throw error;
          toast(data.sending_enabled ? "Form sent to " + data.to : "Queued for " + data.to + ". Booking emails are off, so it waits.");
          reload();
        } catch (e) { toast(cleanErr(e), true); b.disabled = false; }
      };
      el("pdCopy").onclick = async () => {
        try { await navigator.clipboard.writeText(D.link); toast("Link copied. Paste it into your own email if you like."); }
        catch (_e) { openModal("<h2>The form&#8217;s link</h2><p>Anyone with this link can fill in the form for this picture day.</p><p class=\"pd-pre\">" + esc(D.link) + '</p><div class="modal-actions"><button type="button" class="primary" data-x>Done</button></div>').querySelector("[data-x]").onclick = function () { this.closest(".modal").close(); }; }
      };
      el("pdEdit").onclick = planModal;
      el("pdAdd").onclick = () => teamModal(null);
      el("pdLen").onchange = async () => {
        const { error } = await sb.rpc("pd_save_plan", { p_plan: D.plan.id, p: { slot_min: Math.max(3, Math.min(120, +el("pdLen").value || 10)) } });
        if (error) toast(cleanErr(error), true); else reload();
      };
      el("pdLayout").onclick = () => layout(false);
      el("pdRelayout").onclick = () => { if (confirm("Give every team a new time, starting from the first slot? Coaches already emailed will show as changed.")) layout(true); };
      const ss = el("pdSendSlots");
      if (ss) ss.onclick = async () => {
        ss.disabled = true;
        try {
          const { data, error } = await sb.rpc("pd_send_slots", { p_plan: D.plan.id, p_teams: null });
          if (error) throw error;
          toast(num(data.queued) + " email" + (num(data.queued) === 1 ? "" : "s") + (data.sending_enabled ? " on the way" : " queued. Booking emails are off, so they wait."));
          reload();
        } catch (e) { toast(cleanErr(e), true); ss.disabled = false; }
      };
      const pv = el("pdPreview");
      if (pv) pv.onclick = async () => {
        const t = D.teams.find((x) => x.slot_at && x.coach_email && (x.status === "new" || x.changed));
        const { data, error } = await sb.rpc("pd_slot_preview", { p_team: t.id });
        if (error) { toast(cleanErr(error), true); return; }
        const m = openModal('<h2>What ' + esc(t.coach_name || "the coach") + " gets</h2><p><b>To:</b> " + esc(data.to_email) + "<br><b>Subject:</b> " + esc(data.subject) + '</p><div class="pd-pre">' + esc(data.text) + '</div><div class="modal-actions"><button type="button" class="primary" data-x>Close</button></div>');
        m.querySelector("[data-x]").onclick = () => m.close();
      };
      const tb = el("pdToBooking");
      if (tb) tb.onclick = async () => {
        const list = D.teams.filter((t) => t.coach_email && !D.booking_coaches.includes(t.coach_email.toLowerCase()))
          .map((t) => (t.coach_name ? '"' + t.coach_name.replace(/"/g, "") + '" <' + t.coach_email + ">" : t.coach_email)).join("\n");
        tb.disabled = true;
        const { data, error } = await sb.rpc("booking_coaches_add", { p_booking: D.booking.id, p_text: list, p_source: "manual" });
        if (error) { toast(cleanErr(error), true); tb.disabled = false; return; }
        toast(num(data && data.added) + " added to the booking's coach emails");
        reload();
      };
      root().querySelectorAll("[data-again]").forEach((b) => b.addEventListener("click", async () => {
        b.disabled = true;
        const { data, error } = await sb.rpc("pd_send_slots", { p_plan: D.plan.id, p_teams: [b.dataset.again] });
        if (error) { toast(cleanErr(error), true); b.disabled = false; return; }
        toast(data.sending_enabled ? "Sent again" : "Queued. Booking emails are off, so it waits.");
        reload();
      }));
    }

    // Fills the earliest free slot field by field, in the order teams came in. all = start everyone over.
    async function layout(all) {
      const len = Math.max(3, Math.min(120, +el("pdLen").value || D.plan.slot_min || 10));
      const start = el("pdStart").value || "09:00";
      const day = D.booking.picture_day;
      const fields = fieldsOf().length ? fieldsOf() : ["Field 1"];
      const startMin = (+start.slice(0, 2)) * 60 + (+start.slice(3, 5));
      const next = {};
      fields.forEach((f) => { next[f] = startMin; });
      if (!all) D.teams.forEach((t) => {
        if (t.slot_at && fields.includes(t.field)) next[t.field] = Math.max(next[t.field], T.local(t.slot_at).min + (t.slot_min || len));
      });
      const todo = D.teams.filter((t) => all || !t.slot_at || !fields.includes(t.field)).sort((a, c) => (all ? String(a.slot_at || "~").localeCompare(String(c.slot_at || "~")) : 0) || a.sort - c.sort);
      if (!todo.length) { toast("Every team already has a time."); return; }
      const slots = todo.map((t) => {
        const f = fields.reduce((best, x) => (next[x] < next[best] ? x : best), fields[0]);
        const at = next[f]; next[f] += t.slot_min || len;
        return { id: t.id, field: f, slot_at: T.toIso(day, T.hhmm(at)) };
      });
      if (len !== D.plan.slot_min) await sb.rpc("pd_save_plan", { p_plan: D.plan.id, p: { slot_min: len } });
      const { error } = await sb.rpc("pd_save_slots", { p_plan: D.plan.id, p_slots: slots });
      if (error) { toast(cleanErr(error), true); return; }
      toast(slots.length + " team" + (slots.length === 1 ? "" : "s") + " given a time");
      reload();
    }

    function teamModal(t) {
      const isNew = !t, edit = canEdit("pictureday");
      t = t || { name: "", coach_name: "", coach_email: "", coach_phone: "", players: null, field: fieldsOf()[0] || "", slot_at: null, slot_min: null };
      const fields = fieldsOf();
      const fopts = fields.concat(t.field && !fields.includes(t.field) ? [t.field] : []).map((f) => '<option' + (f === t.field ? " selected" : "") + ">" + esc(f) + "</option>").join("");
      const m = openModal('<div class="pd-modal"><h2>' + (isNew ? "Add a team" : esc(t.name)) + "</h2>" +
        (t.status === "move" && t.coach_note ? '<div class="pd-banner">The coach asked to move: &#8220;' + esc(t.coach_note) + "&#8221;</div>" : "") +
        '<div class="field"><label for="aca-pdtName">Team</label><input type="text" id="aca-pdtName" value="' + esc(t.name) + '" maxlength="120" /></div>' +
        '<div class="row3"><div class="field"><label for="aca-pdtCoach">Coach</label><input type="text" id="aca-pdtCoach" value="' + esc(t.coach_name) + '" /></div>' +
        '<div class="field"><label for="aca-pdtEmail">Coach email</label><input type="email" id="aca-pdtEmail" value="' + esc(t.coach_email) + '" /></div>' +
        '<div class="field"><label for="aca-pdtPhone">Coach phone</label><input type="text" id="aca-pdtPhone" value="' + esc(t.coach_phone) + '" /></div></div>' +
        '<div class="row3"><div class="field"><label for="aca-pdtField">Field</label><select id="aca-pdtField"><option value="">No field yet</option>' + fopts + "</select></div>" +
        '<div class="field"><label for="aca-pdtTime">Time</label><input type="time" id="aca-pdtTime" value="' + (t.slot_at ? esc(T.hhmm(T.local(t.slot_at).min)) : "") + '" /></div>' +
        '<div class="field"><label for="aca-pdtLen">Minutes</label><input type="number" id="aca-pdtLen" min="3" max="120" placeholder="' + num(D.plan.slot_min) + '" value="' + (t.slot_min ? num(t.slot_min) : "") + '" /></div></div>' +
        '<div class="field"><label for="aca-pdtPlayers">Players</label><input type="number" id="aca-pdtPlayers" min="0" max="500" value="' + (t.players != null ? num(t.players) : "") + '" /></div>' +
        (!isNew && t.link ? '<p class="muted" style="font-size:12.5px">Coach&#8217;s link: <span class="mono">' + esc(t.link) + "</span></p>" : "") +
        '<div class="inline-error hidden" id="aca-pdtErr"></div><div class="modal-actions">' +
        (!isNew && edit ? '<button type="button" class="quiet" id="aca-pdtRemove">Remove team</button><span class="grow"></span>' : "") +
        '<button type="button" class="quiet" id="aca-pdtCancel">Cancel</button>' + (edit ? '<button type="button" class="primary" id="aca-pdtSave">Save</button>' : "") + "</div></div>");
      el("pdtCancel").onclick = () => m.close();
      if (!edit) { m.querySelectorAll("input,select").forEach((x) => { x.disabled = true; }); return; }
      el("pdtSave").onclick = async () => {
        const time = el("pdtTime").value;
        const p = { id: isNew ? null : t.id, name: el("pdtName").value, coach_name: el("pdtCoach").value, coach_email: el("pdtEmail").value.trim(), coach_phone: el("pdtPhone").value,
          players: el("pdtPlayers").value, field: el("pdtField").value, slot_at: time ? T.toIso(D.booking.picture_day, time) : null, slot_min: el("pdtLen").value };
        const { error } = await sb.rpc("pd_save_team", { p_plan: D.plan.id, p });
        if (error) { showError("pdtErr", cleanErr(error)); return; }
        m.close(); reload();
      };
      const rm = el("pdtRemove");
      if (rm) rm.onclick = async () => {
        if (!confirm("Remove " + t.name + "?" + (t.status !== "new" ? " Their coach already has a time; let them know it's off." : ""))) return;
        const { error } = await sb.rpc("pd_remove_team", { p_team: t.id });
        if (error) { showError("pdtErr", cleanErr(error)); return; }
        m.close(); reload();
      };
    }

    function planModal() {
      const p = D.plan;
      const m = openModal('<div class="pd-modal"><h2>The form&#8217;s answers</h2><p class="muted">Fill these in yourself if you got them on the phone. The organization sees your changes if they open the form again.</p>' +
        '<div class="row2"><div class="field"><label for="aca-pdpOn">On-site contact</label><input type="text" id="aca-pdpOn" value="' + esc(p.onsite_name) + '" /></div>' +
        '<div class="field"><label for="aca-pdpPh">Their phone</label><input type="text" id="aca-pdpPh" value="' + esc(p.onsite_phone) + '" /></div></div>' +
        '<div class="field"><label for="aca-pdpLoc">Where</label><input type="text" id="aca-pdpLoc" value="' + esc(p.location) + '" placeholder="' + esc(D.booking.location || "") + '" /></div>' +
        '<div class="field"><label for="aca-pdpFields">Fields, rinks or rooms (one per line)</label><textarea id="aca-pdpFields">' + esc((p.fields || []).join("\n")) + "</textarea></div>" +
        '<div class="field"><label for="aca-pdpUni">Uniforms</label><textarea id="aca-pdpUni">' + esc(p.uniforms) + "</textarea></div>" +
        '<div class="field"><label for="aca-pdpProps">What teams bring</label><textarea id="aca-pdpProps">' + esc(p.props) + "</textarea></div>" +
        '<div class="field"><label for="aca-pdpNotes">Notes</label><textarea id="aca-pdpNotes">' + esc(p.notes) + "</textarea></div>" +
        '<div class="inline-error hidden" id="aca-pdpErr"></div><div class="modal-actions"><button type="button" class="quiet" id="aca-pdpCancel">Cancel</button><button type="button" class="primary" id="aca-pdpSave">Save</button></div></div>');
      el("pdpCancel").onclick = () => m.close();
      el("pdpSave").onclick = async () => {
        const { error } = await sb.rpc("pd_save_plan", { p_plan: p.id, p: { onsite_name: el("pdpOn").value, onsite_phone: el("pdpPh").value, location: el("pdpLoc").value,
          fields: el("pdpFields").value.split("\n").map((x) => x.trim()).filter(Boolean), uniforms: el("pdpUni").value, props: el("pdpProps").value, notes: el("pdpNotes").value } });
        if (error) { showError("pdpErr", cleanErr(error)); return; }
        m.close(); reload();
      };
    }

    // A printable page for the crew: each field's teams in time order, with the coach and their answer.
    function printSheet() {
      const b = D.booking, p = D.plan || {};
      const cols = fieldsOf().length ? fieldsOf() : ["Field 1"];
      const timed = D.teams.filter((t) => t.slot_at).sort((a, c) => a.slot_at.localeCompare(c.slot_at));
      const loose = D.teams.filter((t) => !t.slot_at);
      const ans = (t) => (t.status === "confirmed" ? "Confirmed" : t.status === "move" ? "Wants to move" : t.status === "sent" ? "Sent" : "");
      const row = (t) => "<tr><td>" + esc(t.slot_at ? timeOf(t.slot_at) : "") + "</td><td><b>" + esc(t.name) + "</b></td><td>" + esc(t.coach_name || "") + (t.coach_phone ? "<br>" + esc(t.coach_phone) : "") + "</td><td>" + (t.players != null ? num(t.players) : "") + "</td><td>" + esc(ans(t)) + "</td><td class=\"box\"></td></tr>";
      const head = "<tr><th>Time</th><th>Team</th><th>Coach</th><th>Players</th><th>Answer</th><th>Done</th></tr>";
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(b.title) + " day sheet</title><style>" +
        "body{font:13px/1.4 Arial,Helvetica,sans-serif;color:#111;margin:24px}h1{font-size:18px;margin:0 0 2px}h2{font-size:15px;margin:18px 0 6px}" +
        "p{margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-bottom:6px}th,td{text-align:left;border-bottom:1px solid #ccc;padding:5px 6px;vertical-align:top}" +
        "th{font-size:11px;text-transform:uppercase;color:#555}td.box{width:40px}.f{page-break-inside:avoid}</style></head><body>" +
        "<h1>" + esc(b.title) + "</h1><p>" + esc(fmtDayIso(b.picture_day)) + (b.time_set ? ", " + esc(timeOf(b.start_at)) : "") + " &#183; " + esc(p.location || b.location || "") + "</p>" +
        (p.onsite_name ? "<p>On site: " + esc([p.onsite_name, p.onsite_phone].filter(Boolean).join(", ")) + "</p>" : "") +
        (p.uniforms ? "<p>Uniforms: " + esc(p.uniforms) + "</p>" : "") + (p.props ? "<p>Bring: " + esc(p.props) + "</p>" : "") + (p.notes ? "<p>Notes: " + esc(p.notes) + "</p>" : "") +
        cols.map((f) => { const ts = timed.filter((t) => t.field === f); return ts.length ? '<div class="f"><h2>' + esc(f) + "</h2><table>" + head + ts.map(row).join("") + "</table></div>" : ""; }).join("") +
        (timed.some((t) => !cols.includes(t.field)) ? '<div class="f"><h2>Other</h2><table>' + head + timed.filter((t) => !cols.includes(t.field)).map(row).join("") + "</table></div>" : "") +
        (loose.length ? '<div class="f"><h2>No time yet</h2><table>' + head + loose.map(row).join("") + "</table></div>" : "") + "</body></html>";
      const w = window.open("", "_blank");
      if (!w) { toast("Allow pop-ups to print the day sheet.", true); return; }
      w.document.open(); w.document.write(html); w.document.close();
      setTimeout(() => w.print(), 300);
    }

    async function loadAttention() {
      const { data, error } = await sb.rpc("pd_attention");
      if (error || !data) return;
      setAttention("pdMove", num(data.move), "", "pictureday");
      setAttention("pdToPlan", num(data.to_plan), "", "pictureday");
    }

    return { show, loadAttention };
  })();
