  // ================================================================ PICTURE DAY: public pages (2026-10-22)
  // No sign-in; the token in the link is the key. Shown instead of sign-in (registerPublicPage in shell-top.js).
  //   https://admin.207photo.com/#plan/<token>  the organization's form: teams and coaches, on site, fields,
  //                                             uniforms and props, roster file (storage bucket `pictureday`)
  //   https://admin.207photo.com/#slot/<token>  a coach's time: confirm it or ask to move
  // RPCs: pd_public_plan / pd_public_submit / pd_public_roster, pd_public_slot / pd_public_slot_reply.
  const PictureDayPublic = (function () {
    const sb = supabase;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const route = () => /^#(plan|slot)\/([0-9a-f]{32,})$/.exec(location.hash);
    const wanted = () => !!route();
    const css = `
    .aca .pdp { max-width: 720px; margin: 0 auto; padding: 28px 16px 64px; font-size: 15px; line-height: 22px; }
    .aca .pdp-top { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; }
    .aca .pdp-top img { width: 44px; height: 44px; border-radius: 10px; border: 1px solid var(--border); }
    .aca .pdp-top b { display: block; font-size: 13px; color: var(--muted); font-weight: 600; }
    .aca .pdp h1 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 700; }
    .aca .pdp .when { margin: 4px 0 0; color: var(--muted); }
    .aca .pdp h2 { margin: 28px 0 4px; font-size: 16px; font-weight: 700; color: var(--head); }
    .aca .pdp h2 + p { margin: 0 0 12px; color: var(--muted); font-size: 14px; }
    .aca .pdp .field { margin-bottom: 12px; }
    .aca .pdp .field input, .aca .pdp .field textarea { width: 100%; height: 40px; font-size: 16px; }
    .aca .pdp textarea { min-height: 72px; padding: 8px 10px; }
    .aca .pdp .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .aca .pdp-team { display: grid; grid-template-columns: 1.3fr 1.1fr 1.4fr 1fr 70px 32px; gap: 6px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line2); }
    .aca .pdp-team input { width: 100%; height: 38px; font-size: 15px; min-width: 0; }
    .aca .pdp-team.head { font-size: 12px; font-weight: 600; color: var(--faint); border-bottom-color: var(--border); }
    .aca .pdp-team button { width: 32px; padding: 0; justify-content: center; border-color: transparent; color: var(--faint); font-size: 18px; }
    .aca .pdp-team .sent { grid-column: 1 / -1; font-size: 12.5px; color: var(--muted); }
    .aca .pdp-acts { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 0; }
    .aca .pdp button.primary.big { height: 46px; font-size: 16px; padding: 0 22px; }
    .aca .pdp .err { margin: 12px 0; padding: 10px 12px; border-radius: 4px; background: var(--err-bg); color: var(--err-fg); font-size: 14px; }
    .aca .pdp .ok { margin: 12px 0; padding: 12px 14px; border-radius: 4px; background: var(--ok-bg); color: var(--ok-fg); }
    .aca .pdp .note { padding: 10px 12px; border-radius: 4px; background: var(--surface-2); font-size: 14px; }
    .aca .pdp-big { margin: 18px 0; padding: 18px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .aca .pdp-big .t { font-size: 26px; line-height: 32px; font-weight: 700; }
    .aca .pdp-big dl { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 6px 12px; margin: 14px 0 0; }
    .aca .pdp-big dt { color: var(--muted); } .aca .pdp-big dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .aca .pdp-sched { width: 100%; border-collapse: collapse; font-size: 14px; }
    .aca .pdp-sched td { padding: 6px 8px 6px 0; border-bottom: 1px solid var(--line2); }
    .aca .pdp small.hint { display: block; color: var(--muted); font-size: 13px; margin-top: 4px; }
    @media (max-width: 640px) {
      .aca .pdp .row2 { grid-template-columns: 1fr; }
      .aca .pdp-team { grid-template-columns: 1fr 1fr 32px; }
      .aca .pdp-team.head { display: none; }
      .aca .pdp-team input[data-k=name] { grid-column: 1 / 3; font-weight: 600; }
      .aca .pdp-team button { grid-column: 3; grid-row: 1; }
      .aca .pdp-team input[data-k=coach_email], .aca .pdp-team input[data-k=coach_name] { grid-column: 1 / -1; }
      .aca .pdp-big dl { grid-template-columns: 1fr; gap: 0; } .aca .pdp-big dd { margin-bottom: 8px; }
    }`;
    const LOGO = "https://socluffmclkdljtmiexw.supabase.co/storage/v1/object/public/admin-app/icons/apple-touch-icon.png";
    const $ = (id) => document.getElementById("pdp-" + id);
    let box = null;
    const fmtDay = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
    const fmtTime = (ts) => new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
    const fmtDayTs = (ts) => new Date(ts).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" });
    const top = (sub, title, when) => '<div class="pdp-top"><img src="' + LOGO + '" alt="" /><div><b>207 Photo &#183; ' + esc(sub) + "</b><h1>" + esc(title) + "</h1>" +
      (when ? '<p class="when">' + when + "</p>" : "") + "</div></div>";

    function show() {
      const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
      ["welcomeView", "loginView", "dashView"].forEach((v) => { const n = el(v); if (n) n.classList.add("hidden"); });
      box = document.createElement("div"); box.className = "pdp"; box.id = "aca-pdPublic";
      document.querySelector(".aca").appendChild(box);
      document.title = "Picture day with 207 Photo";
      box.innerHTML = '<div class="empty"><span class="spin"></span>Loading&#8230;</div>';
      const [, kind, token] = route();
      if (kind === "plan") plan(token); else slot(token);
    }
    const notFound = (why) => { box.innerHTML = top("Picture day", "This link doesn’t work") + "<p>" + esc(why || "It may have been mistyped or replaced by a newer email. Please contact 207 Photo.") + "</p>"; };

    // ---------------------------------------------------------------- the organization's form
    let P = null, token = "";
    async function plan(tok) {
      token = tok;
      const { data, error } = await sb.rpc("pd_public_plan", { p_token: tok });
      if (error) { notFound(cleanErr(error)); return; }
      if (!data) { notFound(); return; }
      if (data.reason) { notFound(data.reason); return; }
      P = data;
      renderPlan();
    }
    const whenOf = (d) => esc(fmtDay(d.picture_day)) + (d.start_at ? " at " + esc(fmtTime(d.start_at)) : "");
    const teamRow = (t) => '<div class="pdp-team" data-id="' + esc(t.id || "") + '">' +
      '<input type="text" data-k="name" placeholder="Team name" aria-label="Team name" maxlength="120" value="' + esc(t.name || "") + '" />' +
      '<input type="text" data-k="coach_name" placeholder="Coach" aria-label="Coach" maxlength="120" value="' + esc(t.coach_name || "") + '" />' +
      '<input type="email" data-k="coach_email" placeholder="Coach email" aria-label="Coach email" autocomplete="off" value="' + esc(t.coach_email || "") + '" />' +
      '<input type="text" inputmode="tel" data-k="coach_phone" placeholder="Coach phone" aria-label="Coach phone" value="' + esc(t.coach_phone || "") + '" />' +
      '<input type="text" inputmode="numeric" data-k="players" placeholder="Players" aria-label="Players" value="' + (t.players != null ? esc(t.players) : "") + '" />' +
      '<button type="button" data-rm aria-label="Remove this team" title="Remove">&#215;</button>' +
      (t.slot_at ? '<span class="sent">Time: ' + esc(fmtTime(t.slot_at)) + (t.field ? ", " + esc(t.field) : "") + (t.status === "confirmed" ? " (coach confirmed)" : t.status === "move" ? " (coach asked to move)" : "") + "</span>" : "") + "</div>";

    function renderPlan(msg) {
      const d = P, closed = d.closed;
      const sched = d.teams.filter((t) => t.slot_at).sort((a, c) => a.slot_at.localeCompare(c.slot_at));
      let h = top("Picture day", d.org_name || d.title, whenOf(d) + (d.booking_location ? " &#183; " + esc(d.booking_location) : ""));
      if (msg) h += msg;
      if (sched.length) {
        h += "<h2>Team times</h2><p>We emailed each coach their time. They can confirm it or ask to move.</p><table class=\"pdp-sched\">" +
          sched.map((t) => "<tr><td><b>" + esc(fmtTime(t.slot_at)) + "</b></td><td>" + esc(t.name) + "</td><td>" + esc(t.field || "") + '</td><td class="muted">' +
            (t.status === "confirmed" ? "Confirmed" : t.status === "move" ? "Asked to move" : "") + "</td></tr>").join("") + "</table>";
      }
      if (closed) { box.innerHTML = h + '<p class="note">Picture day has passed, so this form is closed. Email 207 Photo with any changes.</p>'; return; }
      h += (d.submitted_at ? '<p class="note">You sent this on ' + esc(new Date(d.updated_at || d.submitted_at).toLocaleDateString("en-US", { month: "long", day: "numeric" })) + ". Change anything below and send it again.</p>"
                           : "<p>Hi" + (d.contact_name ? " " + esc(d.contact_name.split(" ")[0]) : "") + "! To build the team schedule we need a few details. It takes about 5 minutes, and you can come back and change it any time before picture day.</p>") +
        "<h2>Your teams</h2><p>One line per team. We email each coach their team&#8217;s time, so please include coach emails.</p>" +
        '<div class="pdp-team head"><span>Team</span><span>Coach</span><span>Coach email</span><span>Phone (optional)</span><span>Players</span><span></span></div>' +
        '<div id="pdp-teams">' + (d.teams.length ? d.teams : [{}, {}, {}]).map(teamRow).join("") + "</div>" +
        '<div class="pdp-acts"><button type="button" class="small" id="pdp-add">Add a team</button><button type="button" class="small quiet" id="pdp-pasteBtn">Paste a list</button></div>' +
        '<div id="pdp-paste" class="hidden" style="margin-top:10px"><div class="field"><label for="pdp-pasteText">Paste from a spreadsheet: team, coach, coach email, phone, players (one team per line)</label>' +
        '<textarea id="pdp-pasteText" placeholder="U10 Blue&#9;Sam Smith&#9;sam@example.org&#9;207-555-0100&#9;12"></textarea></div><button type="button" class="small" id="pdp-pasteGo">Add these teams</button></div>' +
        "<h2>On the day</h2><p>Who should our photographers find when they arrive?</p>" +
        '<div class="row2"><div class="field"><label for="pdp-onName">On-site contact</label><input type="text" id="pdp-onName" maxlength="120" value="' + esc(d.onsite_name) + '" /></div>' +
        '<div class="field"><label for="pdp-onPhone">Their cell phone</label><input type="text" inputmode="tel" id="pdp-onPhone" maxlength="40" value="' + esc(d.onsite_phone) + '" /></div></div>' +
        '<div class="field"><label for="pdp-loc">Where</label><input type="text" id="pdp-loc" maxlength="300" value="' + esc(d.location) + '" placeholder="' + esc(d.booking_location || "Field, school or building, and address") + '" /></div>' +
        '<div class="field"><label for="pdp-fields">Which fields, rinks or rooms can we use?</label><textarea id="pdp-fields" placeholder="Field 1&#10;Field 2">' + esc((d.fields || []).join("\n")) + "</textarea><small class=\"hint\">One per line. We can photograph a team on each at the same time.</small></div>" +
        "<h2>Uniforms and props</h2><p>We pass this on to every coach with their time.</p>" +
        '<div class="field"><label for="pdp-uni">Uniforms</label><textarea id="pdp-uni" maxlength="1000" placeholder="Game jerseys, home colors">' + esc(d.uniforms) + "</textarea></div>" +
        '<div class="field"><label for="pdp-props">What should teams bring?</label><textarea id="pdp-props" maxlength="1000" placeholder="One ball per team, the league banner">' + esc(d.props) + "</textarea></div>" +
        "<h2>Roster</h2><p>Optional. If you already sent us your roster, skip this.</p>" +
        '<div class="field"><input type="file" id="pdp-roster" accept=".csv,.xlsx,.xls,.ods,.pdf,.doc,.docx,.txt,image/*" style="height:auto" />' +
        (d.roster_name ? '<small class="hint">We have ' + esc(d.roster_name) + ". Pick a file only to replace it.</small>" : "") + "</div>" +
        "<h2>Anything else?</h2>" +
        '<div class="field"><label for="pdp-notes" class="hidden">Notes</label><textarea id="pdp-notes" maxlength="2000" placeholder="Rain date, teams that must go first, parking...">' + esc(d.notes) + "</textarea></div>" +
        '<div id="pdp-err" class="err hidden" role="alert"></div>' +
        '<div class="pdp-acts"><button type="button" class="primary big" id="pdp-send">' + (d.submitted_at ? "Send changes" : "Send to 207 Photo") + "</button></div>";
      box.innerHTML = h;
      wirePlan();
    }

    function wirePlan() {
      const list = $("teams");
      list.addEventListener("click", (e) => { const b = e.target.closest("[data-rm]"); if (b) b.closest(".pdp-team").remove(); });
      $("add").onclick = () => { list.insertAdjacentHTML("beforeend", teamRow({})); list.lastElementChild.querySelector("input").focus(); };
      $("pasteBtn").onclick = () => $("paste").classList.toggle("hidden");
      $("pasteGo").onclick = () => {
        const rows = $("pasteText").value.split(/\r?\n/).map((l) => l.split(l.includes("\t") ? "\t" : ",").map((x) => x.trim())).filter((c) => c.some(Boolean));
        // drop empty starter rows, then add one row per line; an email anywhere on the line is the coach email
        list.querySelectorAll(".pdp-team").forEach((r) => { if (![...r.querySelectorAll("input")].some((i) => i.value.trim())) r.remove(); });
        rows.forEach((c) => {
          const ei = c.findIndex((x) => /@/.test(x));
          const email = ei >= 0 ? c.splice(ei, 1)[0] : "";
          if (/^(team|team name)$/i.test(c[0] || "")) return; // a header line
          const players = c.length > 2 && /^\d+$/.test(c[c.length - 1]) ? c.pop() : "";
          list.insertAdjacentHTML("beforeend", teamRow({ name: c[0], coach_name: c[1] || "", coach_email: email, coach_phone: c[2] || "", players }));
        });
        $("pasteText").value = ""; $("paste").classList.add("hidden");
      };
      $("send").onclick = submit;
    }

    async function submit() {
      const err = $("err"), btn = $("send");
      err.classList.add("hidden");
      const teams = [...$("teams").querySelectorAll(".pdp-team")].map((r) => {
        const t = { id: r.dataset.id || null };
        r.querySelectorAll("input[data-k]").forEach((i) => { t[i.dataset.k] = i.value.trim(); });
        return t;
      }).filter((t) => t.name || t.coach_name || t.coach_email);
      const missing = teams.find((t) => !t.name);
      if (missing) return fail("Give every team a name (" + (missing.coach_name || missing.coach_email) + ").");
      const bad = teams.find((t) => t.coach_email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t.coach_email));
      if (bad) return fail("The coach email for " + bad.name + " doesn’t look right.");
      if (!teams.length) return fail("Add at least one team.");
      btn.disabled = true; btn.textContent = "Sending…";
      try {
        const file = $("roster").files[0];
        if (file) {
          if (file.size > 10 * 1024 * 1024) throw new Error("The roster file is over 10 MB. Email it to us instead.");
          const path = token + "/" + Date.now() + "-" + file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120);
          const up = await sb.storage.from("pictureday").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
          if (up.error) throw new Error("The roster didn’t upload (" + cleanErr(up.error) + "). Try a CSV, Excel or PDF file, or leave it off.");
          const rr = await sb.rpc("pd_public_roster", { p_token: token, p_path: path, p_name: file.name });
          if (rr.error) throw rr.error;
        }
        const { error } = await sb.rpc("pd_public_submit", { p_token: token, p: {
          onsite_name: $("onName").value, onsite_phone: $("onPhone").value, location: $("loc").value,
          fields: $("fields").value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          uniforms: $("uni").value, props: $("props").value, notes: $("notes").value, teams } });
        if (error) throw error;
        const again = await sb.rpc("pd_public_plan", { p_token: token });
        if (again.data) P = again.data;
        renderPlan('<div class="ok"><b>Thank you!</b> We have your ' + teams.length + " team" + (teams.length === 1 ? "" : "s") + ". We&#8217;ll lay out the times and email each coach theirs. You can change anything here until picture day.</div>");
        window.scrollTo(0, 0);
      } catch (e) {
        fail(cleanErr(e));
        btn.disabled = false; btn.textContent = P.submitted_at ? "Send changes" : "Send to 207 Photo";
      }
      function fail(m) { err.textContent = m; err.classList.remove("hidden"); err.scrollIntoView({ block: "center" }); }
    }

    // ---------------------------------------------------------------- a coach's time
    let S = null;
    async function slot(tok) {
      token = tok;
      const { data, error } = await sb.rpc("pd_public_slot", { p_token: tok });
      if (error) { notFound(cleanErr(error)); return; }
      if (!data) { notFound(); return; }
      if (data.reason) { notFound(data.reason); return; }
      S = data;
      renderSlot();
    }
    function renderSlot(msg) {
      const d = S;
      const rows = [["Where", [d.where, d.field].filter(Boolean).join(", ")], ["Uniforms", d.uniforms], ["Bring", d.props],
        ["On site", [d.onsite_name, d.onsite_phone].filter(Boolean).join(", ")]].filter((x) => x[1]);
      let h = top(d.org_name || "Picture day", d.team) +
        '<div class="pdp-big"><div class="t">' + esc(fmtDayTs(d.slot_at)) + "<br>" + esc(fmtTime(d.slot_at)) + "</div>" +
        (rows.length ? "<dl>" + rows.map((x) => "<dt>" + esc(x[0]) + "</dt><dd>" + esc(x[1]) + "</dd>").join("") + "</dl>" : "") + "</div>" +
        "<p>Please have the team there a few minutes early, ready for photos.</p>";
      if (msg) h += msg;
      if (d.closed) { box.innerHTML = h + '<p class="note">Picture day has passed.</p>'; return; }
      if (d.status === "confirmed" && !msg) h += '<div class="ok"><b>You confirmed this time.</b> See you there!</div>';
      if (d.status === "move" && !msg) h += '<div class="note">You asked to move: &#8220;' + esc(d.coach_note) + "&#8221; We&#8217;ll email you a new time.</div>";
      h += '<div id="pdp-err" class="err hidden" role="alert"></div>' +
        '<div class="pdp-acts" id="pdp-btns">' + (d.status !== "confirmed" ? '<button type="button" class="primary big" id="pdp-yes">Confirm this time</button>' : "") +
        '<button type="button" class="big" id="pdp-move" style="height:46px">' + (d.status === "move" ? "Change my note" : "Ask to move") + "</button></div>" +
        '<div id="pdp-moveBox" class="hidden" style="margin-top:16px"><div class="field"><label for="pdp-why">What would work better?</label>' +
        '<textarea id="pdp-why" maxlength="1000" placeholder="Anything after 10:30, or right after the U12 game">' + esc(d.status === "move" ? d.coach_note : "") + "</textarea></div>" +
        '<button type="button" class="primary big" id="pdp-moveGo">Send</button></div>';
      box.innerHTML = h;
      const yes = $("yes");
      if (yes) yes.onclick = () => reply("confirm", "");
      $("move").onclick = () => { $("moveBox").classList.remove("hidden"); $("why").focus(); };
      $("moveGo").onclick = () => reply("move", $("why").value.trim());
    }
    async function reply(answer, note) {
      const err = $("err");
      err.classList.add("hidden");
      if (answer === "move" && !note) { err.textContent = "Tell us what time would work better."; err.classList.remove("hidden"); return; }
      box.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      const { data, error } = await sb.rpc("pd_public_slot_reply", { p_token: token, p_answer: answer, p_note: note });
      if (error) { err.textContent = cleanErr(error); err.classList.remove("hidden"); box.querySelectorAll("button").forEach((b) => { b.disabled = false; }); return; }
      S.status = data.status; S.coach_note = answer === "move" ? note : "";
      renderSlot(answer === "confirm" ? '<div class="ok"><b>Thanks, you&#8217;re confirmed.</b> See you there!</div>'
                                      : '<div class="note"><b>Got it.</b> We&#8217;ll look for a better time and email you.</div>');
    }

    return { wanted, show };
  })();
  registerPublicPage(PictureDayPublic);
