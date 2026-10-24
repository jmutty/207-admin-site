  // ================================================================ NOTES: notes wherever a job or partner is on screen (2026-10-24)
  // Jeremiah: "I need notes to be found easily in all areas where I might be looking at a client or a job."
  // Job notes (job_notes, with @mentions on the job's Notes tab) and partner notes (prospect_activities kind 'note',
  // on the partner's Notes & history tab) now show on the partner Overview, the job Overview, the Jobs and Partners
  // lists, the Schedule boxes and My day. One RPC reads them in bulk: notes_peek(p_bookings, p_orgs)
  // (migration 20261025070000_notes_everywhere.sql). Each person only gets the notes they may see.
  //
  //   Notes.fillLines(root)   fills every [data-nt-job="<booking id>"] / [data-nt-org="<org id>"] under root with a
  //                           one-line "newest note"; empty when there is none. Batched and cached for a minute.
  //   Notes.box(el, opts)     the notes box: newest notes from a job and its partner (or a partner and its jobs),
  //                           with an Add note field. opts: { bookings: [{id, title}], orgId, orgName, addTo: "job"|"org",
  //                           max, onAdd }. Job notes added here go through job_note_add, partner notes into prospect_activities.
  const Notes = (function () {
    const sb = supabase;
    const css = `
    .aca .nt-line { display: block; margin-top: 3px; font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .aca .nt-line:empty { display: none; }
    .aca .nt-line.nt-wrap { white-space: normal; overflow-wrap: anywhere; }
    .aca .nt-line .nt-k { font-weight: 700; color: var(--warn-fg); margin-right: 4px; }
    .aca .nt-line .nt-b { color: var(--text); }
    .aca .nt-box { padding: 10px 14px 12px; background: var(--warn-bg); border-radius: 6px; margin: 0 0 18px; }
    .aca .nt-box .nt-hd { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 4px; }
    .aca .nt-box .nt-hd h3 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--head); }
    .aca .nt-box .nt-hd a { font-size: 13px; color: var(--muted); }
    .aca .nt-box ul { list-style: none; margin: 0 0 8px; padding: 0; }
    .aca .nt-box li { padding: 6px 0; }
    .aca .nt-box li .h { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font-size: 13px; }
    .aca .nt-box li .h b { font-size: 13.5px; } .aca .nt-box li .h .muted { font-size: 12.5px; }
    .aca .nt-box li .h a { color: var(--muted); }
    .aca .nt-box li .b { margin-top: 2px; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .aca .nt-box .nt-none { font-size: 13px; color: var(--muted); margin: 0 0 8px; }
    .aca .nt-box textarea, .aca .sc-modal .nt-box textarea { width: 100%; margin: 0; min-height: 38px; height: 38px; background: var(--surface); resize: vertical; font: inherit; font-size: 14px; }
    /* stays open while it has text, so the Add note button doesn't jump away from the click */
    .aca .nt-box textarea:focus, .aca .nt-box textarea:not(:placeholder-shown), .aca .sc-modal .nt-box textarea:focus, .aca .sc-modal .nt-box textarea:not(:placeholder-shown) { height: 76px; }
    .aca .nt-box .nt-add { display: flex; gap: 8px; align-items: flex-end; }
    .aca .nt-box .nt-add textarea { flex: 1 1 auto; min-width: 0; }
    .aca .nt-box .nt-add button { flex: 0 0 auto; height: 38px; }
    .aca .sc-modal .nt-box { margin: 10px 0 14px; }
    @media (max-width: 760px) { .aca .nt-box.nt-phone1 li + li { display: none; } }
    `;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    // ---------------------------------------------------------------- bulk reads, cached for a minute
    const TTL = 60e3;
    const jobs = new Map(), orgs = new Map(); // id -> { at, v }
    const fresh = (m, id) => { const x = m.get(id); return x && Date.now() - x.at < TTL; };
    async function peek(bookingIds, orgIds, force) {
      const bIds = [...new Set((bookingIds || []).filter(Boolean))], oIds = [...new Set((orgIds || []).filter(Boolean))];
      const needB = bIds.filter((id) => force || !fresh(jobs, id)), needO = oIds.filter((id) => force || !fresh(orgs, id));
      // A job brings its partner along; ask for the partner again only when that job is already cached.
      for (let i = 0; i < needB.length || i < needO.length; i += 400) {
        const pb = needB.slice(i, i + 400), po = needO.slice(i, i + 400);
        if (!pb.length && !po.length) break;
        const { data, error } = await sb.rpc("notes_peek", { p_bookings: pb, p_orgs: po });
        if (error) break;
        const at = Date.now();
        pb.forEach((id) => jobs.set(id, { at, v: (data && data.jobs && data.jobs[id]) || null }));
        const got = (data && data.orgs) || {};
        po.concat(pb.map((id) => jobs.get(id).v && jobs.get(id).v.org_id).filter(Boolean)).forEach((id) => orgs.set(id, { at, v: got[id] || null }));
      }
      const out = { jobs: {}, orgs: {} };
      bIds.forEach((id) => { out.jobs[id] = jobs.has(id) ? jobs.get(id).v : null; const o = out.jobs[id] && out.jobs[id].org_id; if (o && orgs.has(o)) out.orgs[o] = orgs.get(o).v; });
      oIds.forEach((id) => { out.orgs[id] = orgs.has(id) ? orgs.get(id).v : null; });
      return out;
    }
    function forget(bookingId, orgId) { if (bookingId) jobs.delete(bookingId); if (orgId) orgs.delete(orgId); }

    const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
    const who = (n) => [n.author_name, fmtAgo(n.created_at)].filter(Boolean).join(", ");
    function lineHtml(n, label) {
      return '<span class="nt-k">' + esc(label) + ':</span><span class="nt-b">' + esc(clip(n.body, 140)) + '</span> <span class="muted">' + esc(who(n)) + "</span>";
    }

    // ---------------------------------------------------------------- one-line "newest note" in lists
    async function fillLines(root) {
      const nodes = [...(root || document).querySelectorAll("[data-nt-job],[data-nt-org]")];
      if (!nodes.length) return;
      const d = await peek(nodes.map((n) => n.dataset.ntJob), nodes.map((n) => n.dataset.ntOrg));
      nodes.forEach((n) => {
        if (!n.isConnected) return;
        let html = "";
        if (n.dataset.ntJob) {
          const j = d.jobs[n.dataset.ntJob], o = j && j.org_id && d.orgs[j.org_id];
          // The job's own newest note; with none, the partner's newest one (when this person can see partner notes)
          if (j && j.latest && j.latest[0]) html = lineHtml(j.latest[0], "Note");
          else if (n.dataset.ntPartner !== "no" && o && o.latest && o.latest[0]) html = lineHtml(o.latest[0], "Partner note");
        } else {
          const o = d.orgs[n.dataset.ntOrg];
          if (o && o.latest && o.latest[0]) html = lineHtml(o.latest[0], "Note");
        }
        n.innerHTML = html;
        if (html) n.title = n.textContent;
      });
    }

    // ---------------------------------------------------------------- the notes box
    async function box(node, opts) {
      if (!node) return;
      const o = Object.assign({ bookings: [], max: 3, addTo: "job" }, opts || {});
      if (!node.innerHTML) node.innerHTML = '<div class="nt-hd"><h3>Notes</h3></div><p class="nt-none"><span class="spin"></span>Loading&#8230;</p>';
      node.classList.add("nt-box");
      const d = await peek(o.bookings.map((b) => b.id), o.orgId ? [o.orgId] : [], o.force);
      if (!node.isConnected) return;
      const orgId = o.orgId || (o.bookings[0] && d.jobs[o.bookings[0].id] && d.jobs[o.bookings[0].id].org_id) || null;
      const items = [];
      // Each note says where it is from: on a partner page, which job; on a job, which ones are the partner's.
      o.bookings.forEach((b) => ((d.jobs[b.id] && d.jobs[b.id].latest) || []).forEach((n) => items.push(Object.assign({
        from: o.addTo === "org" || o.bookings.length > 1 ? b.title || "a job" : "", href: jobLink(b.id, "notes") }, n))));
      const on = orgId && d.orgs[orgId];
      ((on && on.latest) || []).forEach((n) => items.push(Object.assign({
        from: o.addTo === "org" ? "" : o.orgName ? "About " + o.orgName : "Partner note", href: orgLink(orgId, "history") }, n)));
      items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const total = o.bookings.reduce((n, b) => n + num(d.jobs[b.id] && d.jobs[b.id].count), 0) + num(on && on.count);
      const shown = items.slice(0, o.max);
      const allHref = o.addTo === "org" && orgId ? orgLink(orgId, "history") : o.bookings[0] ? jobLink(o.bookings[0].id, "notes") : "";
      const canAdd = o.addTo === "org" ? canEdit("partners") : !!o.bookings[0];
      node.classList.toggle("nt-phone1", shown.length > 1);
      node.innerHTML = '<div class="nt-hd"><h3>' + (shown.length ? "Latest notes" : "Notes") + "</h3>" +
        (allHref && total > shown.length ? '<a href="' + esc(allHref) + '">All ' + total + " notes &#8250;</a>" : allHref && shown.length ? '<a href="' + esc(allHref) + '">All notes &#8250;</a>' : "") + "</div>" +
        (shown.length ? "<ul>" + shown.map((n) => '<li><div class="h"><b>' + esc(n.author_name || "Someone") + '</b><span class="muted" title="' + esc(new Date(n.created_at).toLocaleString()) + '">' + esc(fmtAgo(n.created_at)) +
          (n.from ? ' &middot; <a href="' + esc(n.href) + '">' + esc(n.from) + "</a>" : "") +
          '</span></div><div class="b">' + esc(n.body) + "</div></li>").join("") + "</ul>"
          : '<p class="nt-none">No notes yet.' + (canAdd ? " Add the first one here." : "") + "</p>") +
        (canAdd ? '<div class="nt-add"><textarea maxlength="4000" aria-label="New note" placeholder="' + esc(o.addTo === "org" ? "Add a note about this partner…" : "Add a note to this job…") + '"></textarea>' +
          '<button type="button" class="small primary" data-nt="add">Add note</button></div>' : "");
      const btn = node.querySelector('[data-nt="add"]'), ta = node.querySelector("textarea");
      if (!btn) return;
      btn.onclick = async () => {
        const body = ta.value.trim(); if (!body) { ta.focus(); return; }
        btn.disabled = true;
        let err = null;
        if (o.addTo === "org") {
          const { error } = await sb.from("prospect_activities").insert({ org_id: orgId, kind: "note", body });
          err = error;
        } else {
          const { data, error } = await sb.rpc("job_note_add", { p_booking: o.bookings[0].id, p_body: body, p_mentions: [] });
          err = error || (data && data.ok === false ? { message: data.error } : null);
        }
        btn.disabled = false;
        if (err) { toast("Note not saved: " + String(err.message || err).replace(/^P0001:\s*/, ""), true); return; }
        toast("Note saved");
        forget(o.bookings[0] && o.bookings[0].id, orgId);
        o.bookings.forEach((b) => forget(b.id));
        await box(node, Object.assign({}, o, { force: true }));
        if (o.onAdd) o.onAdd();
      };
    }

    return { peek, fillLines, box, forget };
  })();
