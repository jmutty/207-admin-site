// prospect-sender: sends 207 Photo cold-prospecting sequences through Gmail.
//
// ONE SEND CYCLE PER CONTACT. Each contact at a league has its own row in prospect_threads
// and gets the sequence addressed to them alone, in their own Gmail thread. The enrollment
// is league-level: a reply from ANY contact (in any thread, or a fresh email) ends every
// thread for that league. A bounce only ends that one contact's thread.
//
// Called by pg_cron (and manually for tests) with header x-prospect-secret, checked against
// Vault secret 'prospect_trigger_secret' via RPC prospect_trigger_ok.
//
//   POST /prospect-sender                  normal run (respects paused, send days, windows, caps)
//   POST /prospect-sender?force=1          ignore send day / window (still respects paused + caps)
//   POST /prospect-sender?enrollment_id=X  only this league's due threads (combine with force=1)
//   POST /prospect-sender?ids=A,B          "Send now" in 207 Admin (SQL prospect_send_now): only these rows, right away,
//                                          ignoring send day / window, the daily cap and the booking-first wait. Respects paused.
//   POST /prospect-sender?preview=X        render every step for every contact of enrollment X
//   POST /prospect-sender?test_org=X       send org X's due emails NOW in test mode (to test_recipient, "[TEST]"),
//                                          ignoring pause + window. For end-to-end checks with a throwaway org.
//
// SINCE 2026-09-27 (Prospects CRM stage 3) the sender sends ONLY rows of prospect_scheduled_emails: every email,
// sequence step or one-off, exists as an editable row with its final text and send time before it goes out.
// Email 1 of a new enrollment sits 'held' until approved in 207 Admin (Ready to send). A row sends when it is
// 'scheduled', due, its enrollment (if any) is active, and every earlier step to that contact has gone out.
// Opens are tracked with a signed 1x1 pixel (prospect-track). Links are NEVER rewritten (deliverability).
//
// Needs Edge secrets GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
// (OAuth for jmutty@207photo.com, scopes gmail.send + gmail.readonly).

import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const G_ID = Deno.env.get("GMAIL_CLIENT_ID") ?? "";
const G_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET") ?? "";
const G_REFRESH = Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const PER_RUN = 3;              // max sends per invocation (spreads sends across the window)
const SWEEP_LIMIT = 8;          // leagues re-checked for replies per invocation
const BUCKET = "prospect-attachments";
const TRACK_URL = SUPABASE_URL + "/functions/v1/prospect-track";
const TRACK_SECRET = Deno.env.get("PROSPECT_TRACK_SECRET") ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o, null, 2), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const secret = req.headers.get("x-prospect-secret") ?? "";
  const { data: ok, error: authErr } = await db.rpc("prospect_trigger_ok", { p: secret });
  if (authErr || ok !== true) return json({ ok: false, error: "unauthorized" }, 401);
  try {
    const { data: s, error } = await db.from("prospect_settings").select("*").single();
    if (error || !s) throw new Error("settings missing: " + (error?.message ?? ""));
    const preview = url.searchParams.get("preview");
    if (preview) return json(await previewEnrollment(preview, s));
    const ids = (url.searchParams.get("ids") ?? "").split(",").map((x) => x.trim()).filter((x) => UUID.test(x)).slice(0, 25);
    return json(await run(s, {
      force: url.searchParams.get("force") === "1",
      only: url.searchParams.get("enrollment_id"),
      testOrg: url.searchParams.get("test_org"),
      ids: ids.length ? ids : null,
    }));
  } catch (e) {
    console.error("prospect-sender:", e);
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});

// ---------------------------------------------------------------- time helpers
type Parts = { y: number; m: number; d: number; h: number; min: number; wd: number };
const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function localParts(d: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: (+p.hour) % 24, min: +p.minute, wd: WD[p.weekday] };
}
function localToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min));
  const p = localParts(guess, tz);
  const offsetMs = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}
function windowFor(iso: number, s: any): [number, number] {
  const w = (s.send_windows ?? {})[String(iso)];
  if (Array.isArray(w) && w.length === 2) return [Number(w[0]), Number(w[1])];
  return [s.send_window_start_hour, s.send_window_end_hour];
}
function nextSendAt(from: Date, delayDays: number, s: any): Date {
  const allowed = (s.send_days as number[]) ?? [1, 2, 3, 4, 5, 6, 7];
  const isoOf = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1;
  const p = localParts(from, s.timezone);
  let day = new Date(Date.UTC(p.y, p.m - 1, p.d));
  let added = 0;
  while (added < delayDays) {
    day = new Date(day.getTime() + 86400000);
    if (allowed.includes(isoOf(day))) added++;
  }
  for (let i = 0; i < 14 && !allowed.includes(isoOf(day)); i++) day = new Date(day.getTime() + 86400000);
  const [ws, we] = windowFor(isoOf(day), s);
  const jitter = Math.floor(Math.random() * Math.max(30, (we - ws) * 60 - 20));
  const start = localToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), ws, 0, s.timezone);
  return new Date(start.getTime() + jitter * 60000);
}

// ---------------------------------------------------------------- rendering
function render(tpl: string, vars: Record<string, string>): string {
  let out = "";
  let i = 0;
  while (i < tpl.length) {
    const st = tpl.indexOf("{{", i);
    if (st < 0) { out += tpl.slice(i); break; }
    out += tpl.slice(i, st);
    let depth = 0, j = st;
    while (j < tpl.length) {
      if (tpl.startsWith("{{", j)) { depth++; j += 2; continue; }
      if (tpl.startsWith("}}", j)) { depth--; j += 2; if (depth === 0) break; continue; }
      j++;
    }
    const inner = tpl.slice(st + 2, Math.max(st + 2, j - 2));
    const bar = inner.indexOf("|");
    const key = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    const fb = bar < 0 ? "" : inner.slice(bar + 1);
    const v = (vars[key] ?? "").trim();
    out += v ? v : render(fb, vars);
    i = j;
  }
  return out;
}
const tidy = (t: string) => t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

type Ctx = { enr: any; org: any; contacts: any[]; steps: any[]; threads: any[] };
async function loadCtx(enr: any): Promise<Ctx> {
  const [o, c, st, th] = await Promise.all([
    db.from("prospect_orgs").select("*").eq("id", enr.org_id).single(),
    db.from("prospect_contacts").select("*").eq("org_id", enr.org_id).order("created_at"),
    db.from("prospect_sequence_steps").select("*").eq("sequence_id", enr.sequence_id).order("step_no"),
    db.from("prospect_threads").select("*").eq("enrollment_id", enr.id),
  ]);
  const err = o.error ?? c.error ?? st.error ?? th.error;
  if (err) throw new Error("load failed: " + err.message);
  return { enr, org: o.data, contacts: c.data ?? [], steps: st.data ?? [], threads: th.data ?? [] };
}
function compose(ctx: Ctx, step: any, s: any, contact: any) {
  const first = (contact?.first_name ?? "").trim();
  const vars: Record<string, string> = {
    hi: first ? `Hi ${first}` : "", first_name: first,
    league: ctx.org?.name_known === false ? "" : (ctx.org?.name ?? ""),
    sport: (ctx.org?.sport ?? "").toLowerCase(), town: ctx.org?.town ?? "",
    personal_line: ctx.org?.personal_line ?? "", sender_first_name: s.sender_first_name ?? "",
  };
  const firstStep = ctx.steps.find((x: any) => x.step_no === 1) ?? step;
  const baseSubject = tidy(render(firstStep.subject ?? "", vars)) || "Picture day";
  const subject = (s.test_mode ? "[TEST] " : "") + (step.step_no === 1 ? baseSubject : "Re: " + baseSubject);
  const parts = [tidy(render(step.body, vars))];
  if ((s.signature ?? "").trim()) parts.push(s.signature.trim());
  if ((s.footer ?? "").trim()) parts.push(s.footer.trim());
  const to = s.test_mode ? [s.test_recipient] : [contact.email];
  return { subject, text: parts.join("\n\n"), to, attachments: (step.attachments ?? []) as { path: string; filename: string }[] };
}
async function previewEnrollment(id: string, s: any) {
  const { data: enr, error } = await db.from("prospect_enrollments").select("*").eq("id", id).single();
  if (error || !enr) throw new Error("enrollment not found");
  const ctx = await loadCtx(enr);
  const byContact = new Map(ctx.contacts.map((c: any) => [c.id, c]));
  return {
    ok: true, test_mode: s.test_mode, league: ctx.org.name,
    threads: ctx.threads.map((t: any) => {
      const c = byContact.get(t.contact_id);
      return {
        contact: c?.email, status: t.status, current_step: t.current_step, next_send_at: t.next_send_at,
        steps: ctx.steps.map((st: any) => { const e = compose(ctx, st, s, c); return { step: st.step_no, to: e.to, subject: e.subject, text: e.text }; }),
      };
    }),
  };
}

// ---------------------------------------------------------------- HTML + MIME + Gmail
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function linkify(line: string): string {
  return esc(line).replace(/\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|org|net|edu|us)(?:\/[^\s<]*)?)/gi, (m) => {
    const trail = (m.match(/[.,;:!?)]+$/) ?? [""])[0];
    const core = trail ? m.slice(0, -trail.length) : m;
    const href = /^https?:\/\//i.test(core) ? core : "https://" + core;
    return `<a href="${href}">${core}</a>${trail}`;
  });
}
const toHtml = (text: string, extra = "") =>
  `<div dir="ltr">${text.split("\n").map((l) => l.trim() === "" ? "<div><br></div>" : `<div>${linkify(l)}</div>`).join("")}${extra}</div>`;
const enc = new TextEncoder();
const b64 = (s: string) => encodeBase64(enc.encode(s));
const wrap76 = (s: string) => (s.match(/.{1,76}/g) ?? []).join("\r\n");
const encHeader = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
function buildMime(o: {
  from: string; to: string[]; replyTo: string[]; subject: string; text: string; htmlExtra?: string;
  messageId: string; inReplyTo?: string | null; attachments: { filename: string; mime: string; b64: string }[];
}) {
  const h = [`From: ${o.from}`, `To: ${o.to.join(", ")}`];
  if (o.replyTo.length) h.push(`Reply-To: ${o.replyTo.join(", ")}`);
  h.push(`Subject: ${encHeader(o.subject)}`, `Message-ID: ${o.messageId}`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0");
  if (o.inReplyTo) h.push(`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`);
  const alt = "a207_" + crypto.randomUUID().replace(/-/g, "");
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(o.text))].join("\r\n");
  const htmlPart = ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(toHtml(o.text, o.htmlExtra ?? "")))].join("\r\n");
  const bodyPart = [`Content-Type: multipart/alternative; boundary="${alt}"`, "", `--${alt}`, textPart, `--${alt}`, htmlPart, `--${alt}--`, ""].join("\r\n");
  if (!o.attachments.length) return [...h, bodyPart].join("\r\n");
  const mixed = "b207_" + crypto.randomUUID().replace(/-/g, "");
  const parts = [`--${mixed}`, bodyPart];
  for (const a of o.attachments) {
    const fn = a.filename.replace(/"/g, "");
    parts.push(`--${mixed}`, [`Content-Type: ${a.mime}; name="${fn}"`, `Content-Disposition: attachment; filename="${fn}"`, "Content-Transfer-Encoding: base64", "", wrap76(a.b64)].join("\r\n"));
  }
  parts.push(`--${mixed}--`, "");
  return [...h, `Content-Type: multipart/mixed; boundary="${mixed}"`, "", ...parts].join("\r\n");
}
// Open pixel: /prospect-track/o/<email id>.<signature>.gif. The signature (HMAC of the id) stops anyone
// from faking opens for other emails. No pixel when tracking is off or the secret is missing.
async function openPixel(id: string): Promise<string> {
  if (!TRACK_SECRET) return "";
  const key = await crypto.subtle.importKey("raw", enc.encode(TRACK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(id)));
  const s64 = encodeBase64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
  return `<img src="${TRACK_URL}/o/${id}.${s64}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`;
}
const b64url = (s: string) => encodeBase64(enc.encode(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function gmailToken(): Promise<string> {
  if (!G_ID || !G_SECRET || !G_REFRESH) throw new Error("Gmail secrets missing: need GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: G_ID, client_secret: G_SECRET, refresh_token: G_REFRESH, grant_type: "refresh_token" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Gmail token error: " + JSON.stringify(j).slice(0, 300));
  return j.access_token;
}
async function gm(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Gmail ${path.split("?")[0]} ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}
const hdr = (m: any, name: string) => ((m.payload?.headers ?? []) as any[]).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const emailOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

// Whole-league check. Any human reply in ANY contact's thread, or any email from ANY contact
// since enrollment, ends the league. Bounce notices only flag that one thread.
async function checkLeague(token: string, ctx: Ctx, s: any): Promise<{ replied: string | null; bounced: string[] }> {
  const me = String(s.sender_email).toLowerCase();
  const bounced: string[] = [];
  for (const t of ctx.threads) {
    if (!t.gmail_thread_id) continue;
    const th = await gm(token, `threads/${t.gmail_thread_id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Auto-Submitted`);
    for (const m of th.messages ?? []) {
      const from = hdr(m, "From").toLowerCase();
      if ((m.labelIds ?? []).includes("SENT") || emailOf(from) === me) continue;
      if (/mailer-daemon|postmaster/.test(from)) { if (t.status === "active") bounced.push(t.id); break; }
      const auto = hdr(m, "Auto-Submitted").toLowerCase();
      const subj = hdr(m, "Subject").toLowerCase();
      if ((auto && auto !== "no") || /out of (the )?office|automatic reply|auto-?reply/.test(subj)) continue;
      return { replied: `reply from ${emailOf(from)}`, bounced };
    }
  }
  if (!s.test_mode && ctx.contacts.length) {
    const after = Math.floor(new Date(ctx.enr.started_at).getTime() / 1000);
    const q = `from:(${ctx.contacts.map((c: any) => c.email).join(" OR ")}) after:${after} -subject:"automatic reply" -subject:"out of office"`;
    const r = await gm(token, `messages?maxResults=1&q=${encodeURIComponent(q)}`);
    if ((r.messages ?? []).length) return { replied: "email from a league contact", bounced };
  }
  return { replied: null, bounced };
}

async function endLeague(enrId: string, orgId: string, status: string, reason: string) {
  const now = new Date().toISOString();
  await db.from("prospect_threads").update({ status: "stopped", next_send_at: null }).eq("enrollment_id", enrId).eq("status", "active");
  await db.from("prospect_enrollments").update({ status, end_reason: reason, ended_at: now, next_send_at: null, last_checked_at: now }).eq("id", enrId);
  if (status === "replied") await db.from("prospect_orgs").update({ status: "replied" }).eq("id", orgId).eq("status", "active");
}
async function markBounced(ctx: Ctx, threadIds: string[]) {
  const now = new Date().toISOString();
  for (const id of threadIds) {
    const t = ctx.threads.find((x: any) => x.id === id);
    await db.from("prospect_threads").update({ status: "bounced", next_send_at: null }).eq("id", id);
    if (t) { t.status = "bounced"; await db.from("prospect_contacts").update({ bounced_at: now }).eq("id", t.contact_id); }
  }
}
// Roll thread state up to the league row the dashboard reads.
async function refreshLeague(enrId: string) {
  const { data: th } = await db.from("prospect_threads").select("status, current_step, next_send_at").eq("enrollment_id", enrId);
  const { data: enr } = await db.from("prospect_enrollments").select("status").eq("id", enrId).single();
  if (!th || !enr) return;
  const active = th.filter((t: any) => t.status === "active");
  const maxStep = th.reduce((m: number, t: any) => Math.max(m, t.current_step), 0);
  const next = active.map((t: any) => t.next_send_at).filter(Boolean).sort()[0] ?? null;
  const patch: any = { current_step: maxStep, next_send_at: enr.status === "active" ? next : null, last_checked_at: new Date().toISOString() };
  if (enr.status === "active" && th.length && !active.length) {
    const allBounced = th.every((t: any) => t.status === "bounced");
    Object.assign(patch, { status: allBounced ? "bounced" : "completed", ended_at: new Date().toISOString(), end_reason: allBounced ? "every address bounced" : "sequence finished" });
  }
  await db.from("prospect_enrollments").update(patch).eq("id", enrId);
}

const attachmentCache = new Map<string, string>();
async function loadAttachment(path: string): Promise<string> {
  if (attachmentCache.has(path)) return attachmentCache.get(path)!;
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`attachment ${path}: ${error?.message ?? "missing"}`);
  const b = encodeBase64(new Uint8Array(await data.arrayBuffer()));
  attachmentCache.set(path, b);
  return b;
}

// Send ONE scheduled email row. ctx is the league context for sequence rows (null for one-offs).
async function sendRow(token: string, row: any, ctx: Ctx | null, s: any, testMode: boolean) {
  const { data: contact } = await db.from("prospect_contacts").select("*").eq("id", row.contact_id).single();
  if (!contact || contact.unsubscribed_at || contact.bounced_at) {
    await db.from("prospect_scheduled_emails").update({ status: "stopped", error: "contact not emailable" }).eq("id", row.id);
    return { outcome: "skipped: contact not emailable" };
  }
  const thread = ctx && row.thread_id ? ctx.threads.find((x: any) => x.id === row.thread_id) : null;
  const threaded = !!(thread && thread.gmail_thread_id && row.step_no > 1);
  const baseSubject = (row.subject ?? "").trim() || "Picture day";
  const subject = (testMode ? "[TEST] " : "") + (threaded ? "Re: " + baseSubject : baseSubject);
  const parts = [tidy(row.body)];
  if ((s.signature ?? "").trim()) parts.push(s.signature.trim());
  if ((s.footer ?? "").trim()) parts.push(s.footer.trim());
  const to = testMode ? [s.test_recipient] : [contact.email];
  const atts = [];
  for (const a of (row.attachments ?? []) as { path: string; filename: string }[]) {
    atts.push({ filename: a.filename, mime: a.filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream", b64: await loadAttachment(a.path) });
  }
  const pixel = s.track_opens === false ? "" : await openPixel(row.id);
  const raw = buildMime({
    from: `${encHeader(s.sender_name)} <${s.sender_email}>`, to, replyTo: s.reply_to ?? [],
    subject, text: parts.join("\n\n"), htmlExtra: pixel, messageId: `<${crypto.randomUUID()}@207photo.com>`,
    inReplyTo: threaded ? thread.last_message_id : null, attachments: atts,
  });
  const sent = await gm(token, "messages/send", { method: "POST", body: JSON.stringify({ raw: b64url(raw), ...(threaded ? { threadId: thread.gmail_thread_id } : {}) }) });
  let realId: string | null = null;
  try { const m = await gm(token, `messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`); realId = hdr(m, "Message-ID") || null; } catch { /* ignore */ }
  const now = new Date().toISOString();
  const { data: log } = await db.from("prospect_send_log").insert({
    enrollment_id: row.enrollment_id, thread_id: row.thread_id, scheduled_email_id: row.id, step_no: row.step_no,
    test_mode: testMode, to_emails: to, cc_emails: [], subject, gmail_message_id: sent.id, gmail_thread_id: sent.threadId, ok: true,
  }).select("id").single();
  await db.from("prospect_scheduled_emails").update({
    status: "sent", sent_at: now, test_mode: testMode, gmail_message_id: sent.id, gmail_thread_id: sent.threadId,
    send_log_id: log?.id ?? null, error: null,
  }).eq("id", row.id);
  if (thread) {
    await db.from("prospect_threads").update({ gmail_thread_id: sent.threadId, last_message_id: realId ?? thread.last_message_id }).eq("id", thread.id);
    thread.gmail_thread_id = sent.threadId; thread.last_message_id = realId ?? thread.last_message_id;
  }
  await db.rpc("prospect_after_send", { p_email: row.id });
  return { outcome: "sent", step: row.step_no, to, subject };
}

async function run(s: any, opt: { force: boolean; only: string | null; testOrg: string | null; ids: string[] | null }) {
  const res: any = { ok: true, test_mode: s.test_mode || !!opt.testOrg, sent: [], stopped: [], errors: [], sweep: [], skipped: null };
  if (s.paused && !opt.testOrg) return { ...res, skipped: "paused" };
  const now = new Date();
  const lp = localParts(now, s.timezone);
  const [ws, we] = windowFor(lp.wd, s);
  const inWindow = opt.force || !!opt.testOrg || !!opt.ids || ((s.send_days as number[]).includes(lp.wd) && lp.h >= ws && lp.h < we);

  let due: any[] = [];
  let room = 0;
  if (inWindow) {
    const midnight = localToUtc(lp.y, lp.m, lp.d, 0, 0, s.timezone);
    const nextMidnight = localToUtc(lp.y, lp.m, lp.d + 1, 0, 0, s.timezone);
    const { count } = await db.from("prospect_send_log").select("id", { count: "exact", head: true }).eq("ok", true).gte("sent_at", midnight.toISOString());
    // Send now: someone pressed the button for these exact emails, so the cap and the booking-first wait don't apply.
    room = opt.ids ? opt.ids.length : opt.testOrg ? PER_RUN : Math.min(PER_RUN, s.daily_cap - (count ?? 0));
    // Client emails come first (2026-10-12). Booking admin emails share this Gmail account: while any is due,
    // prospecting waits for the next tick, and a shared daily budget keeps room for the booking emails still
    // scheduled today. Prospect emails that no longer fit move to the next day's window.
    if (!opt.testOrg && !opt.force && !opt.ids) {
      const { data: bs } = await db.from("booking_settings").select("sending_enabled").maybeSingle();
      // only a sender that is switched on can be "due"; with booking sending off, its rows wait and must not block prospecting
      const { count: bookingDue } = bs?.sending_enabled
        ? await db.from("booking_emails").select("id", { count: "exact", head: true }).in("status", ["scheduled", "sending"]).lte("send_at", now.toISOString())
        : { count: 0 };
      const { count: bookingSent } = await db.from("booking_emails").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", midnight.toISOString());
      const { count: bookingLater } = await db.from("booking_emails").select("id", { count: "exact", head: true }).eq("status", "scheduled").gt("send_at", now.toISOString()).lt("send_at", nextMidnight.toISOString());
      const budget = Number(s.gmail_daily_budget ?? 150);
      const budgetRoom = budget - (bookingSent ?? 0) - (bookingLater ?? 0) - (count ?? 0);
      if ((bookingDue ?? 0) > 0) { room = 0; res.skipped = "booking emails are due first"; }
      else if (budgetRoom < room) { room = Math.max(0, budgetRoom); if (room === 0) res.skipped = "gmail budget kept for booking emails"; }
      if (room === 0 && res.skipped !== "booking emails are due first") {
        // nothing more goes today: move what is due to the next day's window so the outbox says so
        const { data: dueNow } = await db.from("prospect_scheduled_emails").select("id").eq("status", "scheduled").eq("date_manual", false).lte("send_at", now.toISOString()).limit(200);
        for (const d of dueNow ?? []) {
          const { data: nx } = await db.rpc("prospect_next_send_at", { p_from: nextMidnight.toISOString(), p_delay: 0 });
          if (nx) await db.from("prospect_scheduled_emails").update({ send_at: nx }).eq("id", d.id).eq("status", "scheduled");
        }
        res.moved = (dueNow ?? []).length;
      }
    }
    if (room > 0) {
      let q = db.from("prospect_scheduled_emails").select("*").eq("status", "scheduled")
        .lte("send_at", now.toISOString()).order("send_at").limit(room * 5);
      if (opt.only) q = q.eq("enrollment_id", opt.only);
      if (opt.testOrg) q = q.eq("org_id", opt.testOrg);
      if (opt.ids) q = q.in("id", opt.ids);
      const { data, error } = await q;
      if (error) throw error;
      due = data ?? [];
    } else if (!res.skipped) res.skipped = "daily cap reached";
  } else res.skipped = "outside send days/window";

  const { count: liveCount } = await db.from("prospect_threads").select("id", { count: "exact", head: true }).not("gmail_thread_id", "is", null);
  if (!due.length && !liveCount) return { ...res, skipped: res.skipped ?? "nothing due" };

  const token = await gmailToken();
  const checked = new Map<string, Ctx | null>();   // enrollment -> ctx (null = league ended or not sendable)
  let sentN = 0;
  for (const row of due) {
    if (sentN >= room) break;
    try {
      let ctx: Ctx | null = null;
      if (row.enrollment_id) {
        let c = checked.get(row.enrollment_id);
        if (c === undefined) {
          const { data: enr } = await db.from("prospect_enrollments").select("*").eq("id", row.enrollment_id).single();
          if (!enr || enr.status !== "active") { c = null; }
          else {
            c = await loadCtx(enr);
            const hit = await checkLeague(token, c, s);
            if (hit.bounced.length) await markBounced(c, hit.bounced);
            if (hit.replied) {
              await endLeague(enr.id, enr.org_id, "replied", hit.replied);
              res.stopped.push({ league: c.org.name, outcome: "replied", reason: hit.replied });
              c = null;
            }
          }
          checked.set(row.enrollment_id, c);
        }
        if (!c) continue;
        ctx = c;
        // earlier steps to this contact must be out (or skipped) first
        const { count: earlier } = await db.from("prospect_scheduled_emails").select("id", { count: "exact", head: true })
          .eq("thread_id", row.thread_id).lt("step_no", row.step_no).in("status", ["held", "scheduled", "sending", "failed"]);
        if (earlier) continue;
        const live = ctx.threads.find((x: any) => x.id === row.thread_id);
        if (!live || live.status !== "active") continue;
      }
      // claim the row so an overlapping run can't send it twice. Re-checks send_at: sending an earlier step in
      // this same run re-plans the later ones (e.g. step 2 moves to 3 business days after step 1).
      const { data: claimed } = await db.from("prospect_scheduled_emails").update({ status: "sending" })
        .eq("id", row.id).eq("status", "scheduled").lte("send_at", new Date().toISOString()).select("*");
      if (!claimed || !claimed.length) continue;
      const r = await sendRow(token, { ...row, ...claimed[0] }, ctx, s, s.test_mode || !!opt.testOrg);
      if (r.outcome === "sent") { res.sent.push({ org_id: row.org_id, league: ctx?.org?.name, ...r }); sentN++; }
      else res.stopped.push({ org_id: row.org_id, ...r });
      if (row.enrollment_id) await refreshLeague(row.enrollment_id);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      res.errors.push({ email_id: row.id, error: msg });
      await db.from("prospect_send_log").insert({ enrollment_id: row.enrollment_id, thread_id: row.thread_id, scheduled_email_id: row.id, step_no: row.step_no, test_mode: s.test_mode, ok: false, error: msg });
      await db.from("prospect_scheduled_emails").update({ status: "scheduled", error: msg, send_at: new Date(Date.now() + 3600e3).toISOString() }).eq("id", row.id).in("status", ["sending", "scheduled"]);
      if (row.enrollment_id) await refreshLeague(row.enrollment_id);
    }
  }
  if (!opt.only && !opt.testOrg && !opt.ids) {
    res.sweep = await sweep(token, s, new Set(checked.keys()));
    res.sweep.push(...await sweepOneOffs(token, s));
  }
  if (!due.length) res.skipped = res.skipped ?? "nothing due";
  return res;
}

// Re-check leagues between sends so replies show up in the pipeline promptly.
async function sweep(token: string, s: any, skip: Set<string>) {
  const cutoff = new Date(Date.now() - 2 * 3600e3).toISOString();
  const { data } = await db.from("prospect_enrollments").select("*").in("status", ["active", "completed"])
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`).limit(SWEEP_LIMIT);
  const out: any[] = [];
  for (const enr of data ?? []) {
    if (skip.has(enr.id)) continue;
    const stamp = () => db.from("prospect_enrollments").update({ last_checked_at: new Date().toISOString() }).eq("id", enr.id);
    if (enr.status === "completed" && enr.ended_at && Date.now() - new Date(enr.ended_at).getTime() > 21 * 86400e3) { await stamp(); continue; }
    try {
      const ctx = await loadCtx(enr);
      if (!ctx.threads.some((t: any) => t.gmail_thread_id)) { await stamp(); continue; }
      const hit = await checkLeague(token, ctx, s);
      if (hit.bounced.length) { await markBounced(ctx, hit.bounced); await refreshLeague(enr.id); }
      if (hit.replied) { await endLeague(enr.id, enr.org_id, "replied", hit.replied); out.push({ league: ctx.org.name, replied: hit.replied }); }
      else await stamp();
    } catch (e) { out.push({ id: enr.id, error: String((e as Error).message) }); }
  }
  return out;
}

// One-off emails live outside sequences: check their Gmail threads for a human reply for 3 weeks.
async function sweepOneOffs(token: string, s: any) {
  const me = String(s.sender_email).toLowerCase();
  const since = new Date(Date.now() - 21 * 86400e3).toISOString();
  const { data } = await db.from("prospect_scheduled_emails").select("id, gmail_thread_id, org_id")
    .is("enrollment_id", null).eq("status", "sent").eq("test_mode", false).gte("sent_at", since).not("gmail_thread_id", "is", null).limit(SWEEP_LIMIT);
  const out: any[] = [];
  for (const r of data ?? []) {
    try {
      const th = await gm(token, `threads/${r.gmail_thread_id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Auto-Submitted`);
      for (const m of th.messages ?? []) {
        const from = hdr(m, "From").toLowerCase();
        if ((m.labelIds ?? []).includes("SENT") || emailOf(from) === me) continue;
        const auto = hdr(m, "Auto-Submitted").toLowerCase();
        const subj = hdr(m, "Subject").toLowerCase();
        if (/mailer-daemon|postmaster/.test(from) || (auto && auto !== "no") || /out of (the )?office|automatic reply|auto-?reply/.test(subj)) continue;
        await db.rpc("prospect_log_reply", { p_email: r.id, p_from: emailOf(from), p_snippet: (m.snippet ?? "").slice(0, 400) });
        out.push({ one_off: r.id, replied: emailOf(from) });
        break;
      }
    } catch (e) { out.push({ one_off: r.id, error: String((e as Error).message) }); }
  }
  return out;
}
