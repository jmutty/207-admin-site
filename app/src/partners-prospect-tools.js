  // ================================================================ PARTNERS: prospect helpers
  // Kept from the retired Prospects tab (2026-09-27, CRM stage 5; the full old tab is archived at
  // admin-page/archive/partners-prospects.retired-20260927.js): the "contacted before" check + popup,
  // the spreadsheet/CSV paste parser used by Organizations > Import, and the send-schedule wording.
  const Prior = (function () {
  const sb = supabase;
  const $ = (id) => document.getElementById("aca-" + id);
  let settings = null; // only sender_email is read (Gmail links); set via setSettings
  function fmtDay(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
  }
  const styleTag = document.createElement("style");
  styleTag.textContent = `
  .aca .pr-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 16px; }
  .aca .pr-sub { display: block; font-size: 12px; font-weight: 400; color: var(--muted); margin-top: 2px; }
  .aca .pr-modal-wrap { position: fixed; inset: 0; top: var(--og-top, 0px); background: rgba(16,24,40,.45); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 9998; }
  .aca .pr-modal { background: var(--surface); border-radius: var(--radius); box-shadow: 0 10px 30px rgba(16,24,40,.25); width: 100%; max-width: 600px; max-height: calc(100vh - var(--og-top, 0px) - 32px); overflow: auto; padding: 20px 22px; }
  .aca .pr-modal h2 { margin: 0 0 6px; font-size: 16px; font-family: inherit; }
  .aca .pr-modal > p { margin: 0 0 12px; font-size: 13px; }
  .aca .pr-prior { border: 1px solid var(--border); border-left-width: 4px; border-radius: 8px; padding: 9px 12px; margin-top: 8px; font-size: 13px; }
  .aca .pr-prior.warn { border-left-color: var(--warn-fg); } .aca .pr-prior.ok { border-left-color: var(--ok-fg); }
  .aca .pr-prior-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }`;
  document.head.appendChild(styleTag);

  // ---------------------------------------------------------------- prior contact (migration 20260927T01)
  // Before enrolling, ask the database whether this league (by name, address, or its own email domain)
  // was contacted before: by hand from Gmail (prospect_past_outreach) or by an earlier sequence.
  async function priorContact(name, emails) {
    const { data, error } = await sb.rpc("prospect_prior_contact", { p_org_name: name || null, p_emails: emails });
    if (error) throw error;
    return data || { cooldown_months: 6, matches: [] };
  }
  function agoText(iso) {
    const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 864e5));
    if (days < 45) return days === 1 ? "1 day ago" : days + " days ago";
    const months = Math.round(days / 30.4);
    if (months < 24) return months + " months ago";
    return Math.round(months / 12) + " years ago";
  }
  function gmailLink(id, source) {
    const acct = source === "gmail" ? "jmutty@gmail.com" : ((settings && settings.sender_email) || "jmutty@207photo.com");
    return "https://mail.google.com/mail/?authuser=" + encodeURIComponent(acct) + "#all/" + encodeURIComponent(id);
  }
  const MATCH_WORDS = { email: "same email", name: "same league name", domain: "same email domain" };
  function priorHtml(m, cool) {
    const sent = m.emails_sent == null ? "" : `${m.emails_sent} email${m.emails_sent === 1 ? "" : "s"} sent · `;
    const how = m.source === "gmail" ? "from your Gmail" : "Prospects sequence" + (m.status ? ` (${m.status})` : "");
    const reply = m.replied ? "They replied" + (m.reply_note ? `: ${m.reply_note}` : "") : "No reply";
    const threads = (m.thread_ids || []).slice(0, 3).map((id, i) =>
      `<a href="${esc(gmailLink(id, m.source))}" target="_blank" rel="noopener">thread${m.thread_ids.length > 1 ? " " + (i + 1) : ""}</a>`).join(" · ");
    return `<div class="pr-prior ${m.within_cooldown ? "warn" : "ok"}">
      <div class="pr-prior-head"><strong>${esc(m.org_name)}</strong>${m.is_client ? ' <span class="pill accent">Current client</span>' : ""}
        <span class="pill ${m.within_cooldown ? "warn" : "ok"}">${m.within_cooldown ? `Under the ${num(cool)}-month cool-down` : `Over ${num(cool)} months, fine to re-contact`}</span></div>
      ${(m.do_not_email || []).length ? `<span class="pr-sub" style="color:var(--err-fg);font-weight:600">Do not email: ${esc(m.do_not_email.join(", "))} (unsubscribed or bounced)</span>` : ""}
      <span class="pr-sub">Last contacted ${esc(fmtDay(m.last_at))} (${esc(agoText(m.last_at))}) · ${esc(sent)}${esc(reply)}</span>
      <span class="pr-sub">${esc(how)} · matched on ${esc((m.matched_on || []).map((k) => MATCH_WORDS[k] || k).join(", "))}${(m.emails || []).length ? " · " + esc(m.emails.join(", ")) : ""}${threads ? " · " + threads : ""}</span>
    </div>`;
  }
  // Same email / same name matches get a full block; matches only on a shared email domain (usually other
  // schools in the same district) collapse into one line once there are more than two of them.
  function priorListHtml(prior) {
    const cool = prior.cooldown_months;
    const strong = prior.matches.filter((m) => (m.matched_on || []).some((k) => k !== "domain"));
    const weak = prior.matches.filter((m) => !strong.includes(m));
    if (weak.length <= 2) return prior.matches.map((m) => priorHtml(m, cool)).join("");
    const dom = ((weak[0].emails || [])[0] || "").split("@")[1] || "the same domain";
    const soon = weak.filter((m) => m.within_cooldown).length;
    const names = weak.slice(0, 6).map((m) => m.org_name).join(", ") + (weak.length > 6 ? `, and ${weak.length - 6} more` : "");
    return strong.map((m) => priorHtml(m, cool)).join("") +
      `<div class="pr-prior ${soon ? "warn" : "ok"}"><div class="pr-prior-head"><strong>${weak.length} others at ${esc(dom)}</strong>
        <span class="pill ${soon ? "warn" : "ok"}">${soon ? `${num(soon)} under the ${num(cool)}-month cool-down` : `All over ${num(cool)} months`}</span></div>
        <span class="pr-sub">${esc(names)}. Same email domain, likely the same district or organization.</span></div>`;
  }
  // Resolves true for "Enroll anyway", false for Cancel / Escape / clicking outside.
  function confirmPrior(who, prior) {
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "pr-modal-wrap";
      const soon = prior.matches.some((m) => m.within_cooldown);
      wrap.innerHTML = `<div class="pr-modal" role="dialog" aria-modal="true" aria-labelledby="aca-prModalTitle">
        <h2 id="aca-prModalTitle">${prior.matches.some((m) => (m.matched_on || []).some((k) => k !== "domain")) ? `You've contacted ${esc(who)} before` : `You've contacted others at ${esc(who)}'s email domain`}</h2>
        <p class="muted">${soon ? "At least one contact was recent. Starting a new series now may feel like too much." : "The last contact was a while ago, so a new series is probably fine."} Your call.</p>
        ${priorListHtml(prior)}
        <div class="pr-actions"><button type="button" class="${soon ? "" : "primary"}" data-v="1">Enroll anyway</button>
          <button type="button" class="${soon ? "primary" : ""}" data-v="0">Cancel</button></div>
      </div>`;
      const done = (v) => { document.removeEventListener("keydown", onKey); wrap.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === "Escape") done(false); };
      wrap.addEventListener("click", (e) => {
        if (e.target === wrap) return done(false);
        const b = e.target.closest("button[data-v]"); if (b) done(b.dataset.v === "1");
      });
      document.addEventListener("keydown", onKey);
      document.querySelector(".aca").appendChild(wrap);
      wrap.querySelector('button[data-v="0"]').focus();
    });
  }

  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  function parseDelimited(text) {
    const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) return [];
    const tab = lines[0].includes("\t");
    return lines.map((line) => {
      if (tab) return line.split("\t").map((c) => c.trim());
      const out = []; let cur = "", q = false;              // simple CSV with quotes
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true; else if (ch === ",") { out.push(cur.trim()); cur = ""; } else cur += ch;
      }
      out.push(cur.trim());
      return out;
    });
  }
  const COLS = ["league", "sport", "town", "website", "first", "email", "role"];
  const HEADER_NAMES = {
    league: ["league", "league name", "organization", "organisation", "org", "club", "program", "team"],
    sport: ["sport", "sports"], town: ["town", "city", "location"], website: ["website", "url", "site", "web"],
    first: ["first", "first name", "firstname", "contact", "contact name", "name"], last: ["last", "last name", "lastname"],
    email: ["email", "e-mail", "email address"], role: ["role", "title", "position"],
    opener: ["opener", "custom opener", "personal line", "opening line"],
  };
  function buildGroups(text) {
    const rows = parseDelimited(text);
    if (!rows.length) return { groups: [], problems: ["Nothing to read. Paste some rows first."] };
    let map = {};
    const head = rows[0].map((h) => h.toLowerCase());
    const hasHeader = head.some((h) => HEADER_NAMES.email.includes(h));
    if (hasHeader) {
      Object.entries(HEADER_NAMES).forEach(([k, names]) => { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) map[k] = i; });
      rows.shift();
    } else COLS.forEach((k, i) => { map[k] = i; });
    if (map.email === undefined) return { groups: [], problems: ["Couldn't find an Email column."] };
    const get = (r, k) => (map[k] === undefined ? "" : (r[map[k]] || "").trim());
    const groups = new Map();
    rows.forEach((r, idx) => {
      const email = get(r, "email").toLowerCase();
      if (!email && !get(r, "league")) return;              // skip blank lines
      const league = get(r, "league");
      const key = league ? "L:" + league.toLowerCase() : "E:" + (email || "row" + idx);
      if (!groups.has(key)) groups.set(key, { league, sport: get(r, "sport"), town: get(r, "town"), website: get(r, "website"), opener: get(r, "opener"), contacts: [], issues: [], line: idx + (hasHeader ? 2 : 1) });
      const g = groups.get(key);
      g.sport = g.sport || get(r, "sport"); g.town = g.town || get(r, "town"); g.website = g.website || get(r, "website");
      if (!email) g.issues.push(`Row ${idx + (hasHeader ? 2 : 1)} has no email`);
      else if (!EMAIL_RE.test(email)) g.issues.push(`"${email}" doesn't look like an email`);
      else if (g.contacts.some((c) => c.email === email)) { /* duplicate row, ignore */ }
      else g.contacts.push({ first_name: get(r, "first"), last_name: get(r, "last"), email, role: get(r, "role") || null });
    });
    const list = [...groups.values()];
    list.forEach((g) => { if (!g.contacts.length) g.issues.push("No usable email, will be skipped"); });
    return { groups: list, problems: [] };
  }
  const TEMPLATE_HEADERS = ["League", "Sport", "Town", "Website", "First name", "Last name", "Email", "Role", "Custom opener"];

  const TEMPLATE_CSV = TEMPLATE_HEADERS.join(",") + "\r\n";
  function hourText(h) { const x = h % 12 || 12; return x + (h < 12 || h === 24 ? "am" : "pm"); }
  function rangeText(w) {
    const a = hourText(w[0]), b = hourText(w[1]);
    return (a.slice(-2) === b.slice(-2) ? a.slice(0, -2) : a) + " to " + b;
  }
  function scheduleText(st) {
    const names = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const win = (d) => { const w = (st.send_windows || {})[String(d)]; return Array.isArray(w) ? w : [st.send_window_start_hour, st.send_window_end_hour]; };
    const days = (st.send_days || []).slice().sort();
    const groups = [];                      // consecutive days sharing a window
    days.forEach((d) => {
      const r = rangeText(win(d)), g = groups[groups.length - 1];
      if (g && g.r === r && g.days[g.days.length - 1] === d - 1) g.days.push(d); else groups.push({ r, days: [d] });
    });
    const label = (ds) => ds.join(",") === "1,2,3,4,5" ? "weeknights" : ds.join(",") === "6,7" ? "weekends"
      : ds.length === 7 ? "every day" : ds.length > 2 ? names[ds[0]] + " to " + names[ds[ds.length - 1]] : ds.map((d) => names[d]).join(" and ");
    return groups.map((g) => {
      const l = label(g.days);
      return (l === "weeknights" && /am$/.test(g.r) ? "weekdays" : l === "weekends" ? "weekends" : l) + " " + g.r;
    }).join(" and ") + " Eastern";
  }

  return { priorContact, confirmPrior, buildGroups, TEMPLATE_CSV, scheduleText, setSettings: (x) => { settings = x; } };
  })();
