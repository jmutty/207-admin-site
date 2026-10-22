  // ================================================================ JOBS: Picture day readiness (2026-10-22, Airstudio plan E)
  // One strip per picture day on the Picture days page: form in, roster in, coaches confirmed, crew on the schedule,
  // gear packed (ticked by hand until gear per job exists), then after the day the shoot log and the photographed
  // check. RPCs: rd_get (pictureday view), rd_gear (pictureday edit or crew on the job). pictureday.js calls
  // Readiness.fillList() and Readiness.fillDetail().
  const Readiness = (function () {
    const T = StaffTime;
    const css = `
    .aca .rd-strip { display: flex; gap: 4px 14px; flex-wrap: wrap; align-items: center; margin: -8px 0 18px; }
    .aca .rd-dots { display: inline-flex; gap: 3px; vertical-align: middle; }
    .aca .rd-dots i { width: 9px; height: 9px; border-radius: 50%; background: #d9d5cc; display: inline-block; }
    .aca .rd-dots i.ok { background: var(--ok-fg); } .aca .rd-dots i.warn { background: var(--accent); }
    .aca .rd-cell .sub { display: block; color: var(--muted); font-size: 12.5px; margin-top: 2px; }`;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

    // [[state, words], ...] for one picture day. state: ok | warn | muted
    function items(r) {
      const today = T.today(), soon = r.day <= T.addDays(today, 1), after = r.day <= today;
      const out = [
        r.form === "in" ? ["ok", "Form in"] : r.form === "sent" ? ["warn", "Form sent, not back"] : ["muted", "Form not sent"],
        r.roster ? ["ok", "Roster in"] : ["warn", "No roster"],
        !num(r.teams) ? ["muted", "No teams yet"] : num(r.confirmed) >= num(r.teams) ? ["ok", "Coaches confirmed"]
          : ["warn", num(r.confirmed) + " of " + num(r.teams) + " coaches confirmed"],
        num(r.crew) ? ["ok", num(r.crew) + " crew on the schedule"] : ["warn", "No crew"],
        r.gear_packed_at ? ["ok", "Gear packed" + (r.gear_by ? " (" + r.gear_by + ")" : "")] : [soon ? "warn" : "muted", "Gear not packed"]];
      if (after) out.push(r.logged ? ["ok", "Shoot logged"] : ["warn", "Shoot not logged"], r.checked ? ["ok", "Photographed check done"] : ["muted", "No photographed check"]);
      return out;
    }

    async function load(ids) {
      if (!ids.length) return {};
      const { data, error } = await supabase.rpc("rd_get", { p_bookings: ids });
      if (error) return {};
      const by = {}; (data || []).forEach((r) => { by[r.booking_id] = r; });
      return by;
    }

    // The list: one small row of dots in each <td data-rd="<booking id>">.
    async function fillList(box) {
      const cells = [...box.querySelectorAll("[data-rd]")];
      const by = await load(cells.map((c) => c.dataset.rd));
      cells.forEach((c) => {
        const r = by[c.dataset.rd]; if (!r) return;
        const it = items(r), ready = it.filter((x) => x[0] === "ok").length;
        c.innerHTML = '<span class="rd-dots" title="' + esc(it.map((x) => x[1]).join(" · ")) + '">' + it.map((x) => '<i class="' + x[0] + '"></i>').join("") + "</span>" +
          '<span class="sub">' + ready + " of " + it.length + " ready</span>";
      });
    }

    // One picture day: the strip with words, and a Gear packed button.
    async function fillDetail(box, bookingId, canTick) {
      if (!box) return;
      const r = (await load([bookingId]))[bookingId];
      if (!r) { box.innerHTML = ""; return; }
      box.innerHTML = items(r).map((x) => '<span class="pill ' + x[0] + '">' + esc(x[1]) + "</span>").join("") +
        (canTick ? '<button type="button" class="small quiet" id="aca-rdGear">' + (r.gear_packed_at ? "Gear not packed after all" : "Mark gear packed") + "</button>" : "");
      const g = el("rdGear");
      if (g) g.onclick = async () => {
        g.disabled = true;
        const { error } = await supabase.rpc("rd_gear", { p_booking: bookingId, p_packed: !r.gear_packed_at });
        if (error) { toast(String(error.message || error), true); g.disabled = false; return; }
        fillDetail(box, bookingId, canTick);
      };
    }

    return { fillList, fillDetail, items };
  })();

  // The job page (jobpage.js, #jobs/job/<id>/<tab>) gets a tab for each: the photographed check at 25 (after Picture day),
  // the shoot log at 27. Guarded so this works before or without jobpage.js.
  setTimeout(() => {
    try {
      if (typeof registerJobTab !== "function") return;
      registerJobTab({ id: "shootlog", label: "Shoot log", module: "shootlog", order: 27, render: (b, box) => ShootLog.renderJobTab(b, box) });
      registerJobTab({ id: "photocheck", label: "Photographed", module: "photocheck", order: 25, render: (b, box) => PhotoCheck.renderJobTab(b, box) });
    } catch (_e) { /* no job page yet */ }
  }, 0);
