// calendar-write: keeps the "207Photo - Scheduling" Google Calendar in step with public.bookings.
//
// Called with header x-booking-secret (Vault 'prospect_trigger_secret', checked by RPC booking_trigger_ok):
//   POST {}                      process every booking with calendar_status pending/error (<10 attempts)   [cron]
//   POST { "booking_id": uuid }  process that booking now                                                    [RPC pokes]
// Never called from the browser.
//
// Auth to Google: a service account (edge secret GOOGLE_CALENDAR_SA_JSON = the downloaded key file) that
// Jeremiah shared the calendar with ("Make changes to events"). Scope calendar.events only.
// Until that secret exists the function answers {ok:false, error:"GOOGLE_CALENDAR_SA_JSON missing"} and leaves
// rows 'pending' so the cron picks them up the moment the secret is set.
//
// Event content (spec 4.5): title "<Org> • <Type label>", description with contacts/type/notes, location,
// timed start/end in America/New_York, no guests (Google would email invitations).
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64Url } from "jsr:@std/encoding@1/base64url";
import { eventBody } from "./event.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SA_JSON = Deno.env.get("GOOGLE_CALENDAR_SA_JSON") ?? "";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const TZ = "America/New_York";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const secret = req.headers.get("x-booking-secret") ?? "";
  const { data: ok, error: authErr } = await db.rpc("booking_trigger_ok", { p: secret });
  if (authErr || ok !== true) return json({ ok: false, error: "unauthorized" }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  try {
    const ids: string[] = [];
    if (body.booking_id) ids.push(String(body.booking_id));
    else {
      const { data } = await db.from("bookings").select("id").in("calendar_status", ["pending", "error"]).lt("calendar_attempts", 10).limit(25);
      for (const r of data ?? []) ids.push(r.id);
      const { data: dd } = await db.from("booking_days").select("booking_id").in("calendar_status", ["pending", "error", "remove"]).lt("calendar_attempts", 10).limit(25);
      for (const r of dd ?? []) if (!ids.includes(r.booking_id)) ids.push(r.booking_id);
    }
    if (!ids.length) return json({ ok: true, processed: 0 });
    if (!SA_JSON) return json({ ok: false, error: "GOOGLE_CALENDAR_SA_JSON missing", pending: ids.length });
    const { data: settings } = await db.from("booking_settings").select("calendar_id").single();
    const calendarId = settings?.calendar_id;
    if (!calendarId) return json({ ok: false, error: "booking_settings.calendar_id empty" });
    let token: string;
    try { token = await saToken(); }
    catch (e) {
      // a bad key must surface on Today, not sit as "writing..." forever
      const msg = String((e as Error)?.message ?? e).slice(0, 500);
      for (const id of ids) { const { data: b } = await db.from("bookings").select("calendar_attempts").eq("id", id).single(); await db.from("bookings").update({ calendar_status: "error", calendar_error: msg, calendar_attempts: (b?.calendar_attempts ?? 0) + 1 }).eq("id", id); }
      return json({ ok: false, error: msg, marked_error: ids.length });
    }
    const results = [];
    for (const id of ids) { results.push(await processBooking(token, calendarId, id)); results.push(...await processExtraDays(token, calendarId, id)); }
    return json({ ok: true, processed: results.length, results });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});

// ---------------------------------------------------------------- one booking
async function processBooking(token: string, calendarId: string, id: string) {
  const { data: b, error } = await db.from("bookings").select("*").eq("id", id).single();
  if (error || !b) return { id, outcome: "not found" };
  if (b.calendar_status === "synced" || b.calendar_status === "deleted") return { id, outcome: "nothing to do (" + b.calendar_status + ")" };
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  try {
    if (b.status === "done") {
      // picture day passed: the event stays as history, nothing to write
      await db.from("bookings").update({ calendar_status: b.google_event_id ? "synced" : "deleted", calendar_error: null }).eq("id", id);
      return { id, outcome: "done, left alone" };
    }
    if (b.status !== "booked") {
      // cancelled: delete the event if we made one
      if (b.google_event_id) {
        const r = await fetch(`${base}/${encodeURIComponent(b.google_event_id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`delete ${r.status}: ${(await r.text()).slice(0, 300)}`);
      }
      await db.from("bookings").update({ calendar_status: "deleted", calendar_error: null, calendar_attempts: b.calendar_attempts + 1 }).eq("id", id);
      if (b.google_event_id) await db.from("calendar_events").delete().eq("google_event_id", b.google_event_id);
      return { id, outcome: "deleted" };
    }
    const ev = await buildEvent(b);
    let r: Response;
    if (b.google_event_id) {
      r = await fetch(`${base}/${encodeURIComponent(b.google_event_id)}?sendUpdates=none`, { method: "PATCH", headers: hdrs(token), body: JSON.stringify(ev) });
      if (r.status === 404 || r.status === 410) r = await fetch(`${base}?sendUpdates=none`, { method: "POST", headers: hdrs(token), body: JSON.stringify(ev) }); // event vanished: recreate
    } else {
      r = await fetch(`${base}?sendUpdates=none`, { method: "POST", headers: hdrs(token), body: JSON.stringify(ev) });
    }
    const t = await r.text();
    if (!r.ok) throw new Error(`${b.google_event_id ? "patch" : "insert"} ${r.status}: ${t.slice(0, 300)}`);
    const g = JSON.parse(t);
    await mirrorEvent(g); // instant mirror: the sports hub sees the date now, not after the hourly Apps Script run
    // write back only if nothing changed meanwhile (a cancel inside the undo window must win, not be overwritten)
    const { data: upd } = await db.from("bookings").update({ google_event_id: g.id, calendar_status: "synced", calendar_error: null, calendar_attempts: 0, calendar_checked_at: new Date().toISOString() })
      .eq("id", id).eq("status", "booked").eq("calendar_status", b.calendar_status).select("id");
    if (!upd || !upd.length) {
      const { data: now } = await db.from("bookings").select("status, calendar_status, google_event_id").eq("id", id).single();
      if (now && now.status !== "booked") {
        await fetch(`${base}/${encodeURIComponent(g.id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
        await db.from("calendar_events").delete().eq("google_event_id", g.id);
        await db.from("bookings").update({ calendar_status: "deleted", google_event_id: null }).eq("id", id);
        return { id, outcome: "cancelled meanwhile, event removed" };
      }
      // edited meanwhile: keep the event id, leave status pending so the next run patches it with the newer data
      await db.from("bookings").update({ google_event_id: g.id }).eq("id", id);
      return { id, outcome: "edited meanwhile, will patch again", event: g.id };
    }
    return { id, outcome: b.google_event_id ? "updated" : "created", event: g.id };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    await db.from("bookings").update({ calendar_status: "error", calendar_error: msg, calendar_attempts: b.calendar_attempts + 1 }).eq("id", id);
    return { id, outcome: "error", error: msg };
  }
}
const hdrs = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

// Same row shape the hourly calendarToSupabase.gs mirror writes (title + dates only; no description/location).
const nyDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
async function mirrorEvent(g: any) {
  try {
    const allDay = !!g.start?.date;
    const startAt = allDay ? g.start.date + "T12:00:00Z" : g.start?.dateTime, endAt = allDay ? g.start.date + "T13:00:00Z" : g.end?.dateTime;
    if (!g.id || !g.summary || !startAt || !endAt) return;
    const row = { google_event_id: g.id, summary: String(g.summary).replace(/\s+/g, " ").trim().slice(0, 300), start_date: allDay ? g.start.date : nyDate(startAt), end_date: allDay ? g.start.date : nyDate(endAt),
      all_day: allDay, start_at: new Date(startAt).toISOString(), end_at: new Date(endAt).toISOString(), google_updated: g.updated ?? null, synced_at: new Date().toISOString() };
    if (row.end_date < row.start_date) row.end_date = row.start_date;
    await db.from("calendar_events").upsert(row, { onConflict: "google_event_id" });
  } catch (_e) { /* the hourly mirror will catch up */ }
}

export async function buildEvent(b: any, day?: any, dayNo?: number, dayCount?: number) {
  const { data: org } = await db.from("prospect_orgs").select("name, town").eq("id", b.org_id).single();
  const { data: type } = await db.from("booking_types").select("label").eq("key", b.type_key).single();
  const { data: contacts } = await db.from("prospect_contacts").select("first_name, last_name, email, role").in("id", b.contact_ids ?? []);
  const { data: days } = await db.from("booking_days").select("label, sort, kind, location").eq("booking_id", b.id).eq("removed", false).order("day");
  const first = (days ?? []).find((x: any) => x.sort === 0);
  const n = dayCount ?? (days ?? []).filter((x: any) => x.kind !== "makeup").length;
  const makeup = day?.kind === "makeup";
  return eventBody({
    orgName: org?.name ?? "", typeLabel: type?.label ?? b.type_key, titleLabel: b.title_label, titleOverride: b.title_override,
    // a makeup day with no time yet has no start_at: noon UTC keeps its all-day event on the right date
    startAt: day ? (day.start_at ?? `${day.day}T12:00:00Z`) : b.start_at, endAt: day ? (day.end_at ?? day.start_at ?? `${day.day}T13:00:00Z`) : b.end_at, location: (day ? day.location : first?.location)?.trim() || b.location, notes: b.notes, accessCode: b.access_code, retakeDay: b.retake_day,
    wifiNetwork: b.wifi_network, wifiPassword: b.wifi_password,
    contacts: (contacts ?? []).map((c: any) => ({ name: [c.first_name, c.last_name].filter(Boolean).join(" "), email: c.email, role: c.role })),
    shortId: String(b.id).slice(0, 8),
    // booking_days always carry a placeholder 9:00 start, so the booking-wide time_set decides (a later day of
    // an untimed booking stays all-day too)
    allDay: b.time_set === false || (day ? !day.start_at : false),
    dayLabel: day ? day.label : first?.label,
    // A school's makeup day (2026-10-24) shares the job and its GotPhoto gallery but isn't one of its picture days.
    dayNote: makeup ? "Makeup day: students who were absent on picture day (retakes welcome too)" : n > 1 ? `Day ${(dayNo ?? 0) + 1} of ${n}` : null,
  });
}

// Days after the first: each has its own event (booking_days.google_event_id). 'remove' = the day was taken off.
async function processExtraDays(token: string, calendarId: string, bookingId: string) {
  const out: any[] = [];
  const { data: b } = await db.from("bookings").select("*").eq("id", bookingId).single();
  if (!b) return out;
  const { data: days } = await db.from("booking_days").select("*").eq("booking_id", bookingId).order("day");
  const live = (days ?? []).filter((d: any) => !d.removed && d.kind !== "makeup");
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  for (const d of days ?? []) {
    if (d.sort === 0 && !d.removed) continue; // the bookings row owns day 0's event
    // A tracking-only job's makeup day still gets its event (2026-10-24); its other days never do.
    const wantsGone = d.removed || !(b.status === "booked" || (b.status === "tracked" && d.kind === "makeup"));
    if (!wantsGone && !["pending", "error"].includes(d.calendar_status)) continue;
    if (wantsGone && !d.google_event_id) { if (d.removed) await db.from("booking_days").delete().eq("id", d.id); continue; }
    try {
      if (wantsGone) {
        const r = await fetch(`${base}/${encodeURIComponent(d.google_event_id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`delete ${r.status}: ${(await r.text()).slice(0, 300)}`);
        await db.from("calendar_events").delete().eq("google_event_id", d.google_event_id);
        if (d.removed) await db.from("booking_days").delete().eq("id", d.id);
        else await db.from("booking_days").update({ calendar_status: "deleted", google_event_id: null, calendar_error: null }).eq("id", d.id);
        out.push({ id: bookingId, day: d.day, outcome: "day event deleted" });
        continue;
      }
      const ev = await buildEvent(b, d, live.findIndex((x: any) => x.id === d.id), live.length);
      let r: Response;
      if (d.google_event_id) {
        r = await fetch(`${base}/${encodeURIComponent(d.google_event_id)}?sendUpdates=none`, { method: "PATCH", headers: hdrs(token), body: JSON.stringify(ev) });
        if (r.status === 404 || r.status === 410) r = await fetch(`${base}?sendUpdates=none`, { method: "POST", headers: hdrs(token), body: JSON.stringify(ev) });
      } else r = await fetch(`${base}?sendUpdates=none`, { method: "POST", headers: hdrs(token), body: JSON.stringify(ev) });
      const t = await r.text();
      if (!r.ok) throw new Error(`day ${d.google_event_id ? "patch" : "insert"} ${r.status}: ${t.slice(0, 300)}`);
      const g = JSON.parse(t);
      await mirrorEvent(g);
      await db.from("booking_days").update({ google_event_id: g.id, calendar_status: "synced", calendar_error: null, calendar_attempts: 0, updated_at: new Date().toISOString() }).eq("id", d.id);
      out.push({ id: bookingId, day: d.day, outcome: d.google_event_id ? "day event updated" : "day event created", event: g.id });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 500);
      await db.from("booking_days").update({ calendar_status: "error", calendar_error: msg, calendar_attempts: (d.calendar_attempts ?? 0) + 1 }).eq("id", d.id);
      out.push({ id: bookingId, day: d.day, outcome: "error", error: msg });
    }
  }
  return out;
}

// ---------------------------------------------------------------- service-account token (RS256 JWT)
let cached: { token: string; exp: number } | null = null;
async function saToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const sa = JSON.parse(SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/calendar.events", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  const assertion = `${header}.${claims}.${encodeBase64Url(sig)}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Google token error: " + JSON.stringify(j).slice(0, 300));
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) * 1000) };
  return j.access_token;
}
function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
