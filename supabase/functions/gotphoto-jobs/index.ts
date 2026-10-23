// gotphoto-jobs: makes the GotPhoto job for a sports booking through GotPhoto's Admin API (POST /v4/jobs,
// https://developer.gotphoto.com/docs/public-admin-api/103247955f9a2-create-a-job), then links the booking to
// it once gotphoto-sync has picked the job up. Cron every 5 minutes (`gotphoto-jobs`), and "Create it in
// GotPhoto" on a job (admin `/gpjob?booking=<id>`).
//
// Auth: x-sync-secret = SYNC_TRIGGER_SECRET, like gotphoto-sales. Same GotPhoto login (GP_* env).
//
// Each run:
//   1. gp_create_link(): bookings whose job now shows in the sync get linked (workflow + email schedule).
//   2. gp_create_queue(): what to make (all of it is decided in SQL: name, JOB number, which jobs to copy).
//   3. For each: claim it (gp_create_claim, so two runs never make two jobs), read the template job(s) with
//      GET /v4/jobs/{id}, POST the new job, record the result (gp_create_done).
// ?booking=<id> does one booking now, whatever gp_create_settings.auto_enabled says.
// ?dry=1 builds the jobs it would make and returns them without claiming or creating anything.
import { createClient } from "npm:@supabase/supabase-js@2";

const GP_AUTH = "https://auth.getphoto.io/oauth/access_token";
const GP_API = "https://api.getphoto.io/v4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRIGGER_SECRET = Deno.env.get("SYNC_TRIGGER_SECRET")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// Settings copied from the newest job of the same booking type. Left out on purpose: coupon_id and
// prepay_code (often one job's own), estimated_subjects and notes (this job's), the dates (shifted below).
const COPY_KEYS = ["job_type_id", "access_type", "password_source", "register_after_password_login", "review_orders_photos",
  "show_photo_name", "can_request_individual_photos", "can_request_group_photos", "can_request_sibling_photos",
  "duration_of_shoot", "price_profile_id", "communication_profile_id", "photographer_goal", "watermark_id", "prepay",
  "customer_set_favorite_photo", "customer_set_favorite_photo_restrict"];
// From this organization's own last job, when it has one.
const ORG_KEYS = ["contractee_id", "location_address_id", "access_type", "password_source", "register_after_password_login"];

function secretMatches(given: string | null): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(given ?? ""), b = enc.encode(TRIGGER_SECRET ?? "");
  if (!b.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function login(): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(GP_AUTH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "password",
          username: Deno.env.get("GP_USERNAME"), password: Deno.env.get("GP_PASSWORD"),
          client_id: Deno.env.get("GP_CLIENT_ID"), client_secret: Deno.env.get("GP_CLIENT_SECRET"),
          scope: Deno.env.get("GP_SCOPE"),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!resp.ok) throw new Error(`GotPhoto sign-in failed (${resp.status})`);
      return (await resp.json()).access_token;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

async function getJob(id: string, token: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${GP_API}/jobs/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`GotPhoto ${resp.status} reading job ${id} to copy`);
  const body = await resp.json();
  return (body && typeof body === "object" && "data" in body && body.data && !Array.isArray(body.data)) ? body.data : body;
}

const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10) + "T12:00:00Z") - Date.parse(a.slice(0, 10) + "T12:00:00Z")) / 86_400_000);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);

// The POST body: settings from the template, organization bits from the org's job, this booking's name and date.
function buildJob(item: any, tpl: Record<string, any>, org: Record<string, any> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of COPY_KEYS) if (tpl[k] != null && tpl[k] !== "") out[k] = tpl[k];
  if (org) for (const k of ORG_KEYS) if (org[k] != null && org[k] !== "") out[k] = org[k];
  if (out.job_type_id == null && tpl.job_type && typeof tpl.job_type === "object" && tpl.job_type.id != null) out.job_type_id = tpl.job_type.id;
  // Dates keep their distance from the shoot (archive 60 days after, prepay deadline 3 days before, ...).
  if (isDay(tpl.shoot)) {
    for (const k of ["archive", "prepay_deadline", "registration_deadline"]) {
      if (isDay(tpl[k])) { const d = addDays(item.shoot, daysBetween(tpl.shoot, tpl[k])); if (d > new Date().toISOString().slice(0, 10)) out[k] = d; }
    }
  }
  if (out.password_source == null) out.password_source = "manual";
  return {
    ...out,
    name: item.job_name,
    internal_name: item.internal_name,
    shoot: item.shoot,
    status: "created",
    notes: `Made by 207 Admin from the booking. Settings copied from ${item.template_name ?? "an earlier job"}.`,
  };
}

Deno.serve(async (req) => {
  if (!secretMatches(req.headers.get("x-sync-secret"))) return new Response("forbidden", { status: 403 });
  const url = new URL(req.url);
  const booking = url.searchParams.get("booking");
  const dry = url.searchParams.get("dry") === "1";

  const linked = dry ? 0 : await sb.rpc("gp_create_link").then(({ data, error }) => { if (error) console.error("link:", error.message); return data ?? 0; });
  const { data: queue, error: qErr } = await sb.rpc("gp_create_queue", { p_booking: booking, p_limit: booking ? 1 : 10, p_preview: dry });
  if (qErr) return Response.json({ ok: false, error: `queue: ${qErr.message}` }, { status: 500 });
  const items = (queue ?? []) as any[];
  if (!items.length) {
    return Response.json({ ok: true, linked, made: [], ...(booking ? { error: "This booking already has a GotPhoto job, is being made, or is not a sports booking." } : {}) });
  }

  let token: string;
  try { token = await login(); } catch (e) { return Response.json({ ok: false, linked, error: String((e as Error).message ?? e) }, { status: 502 }); }

  const made: any[] = [];
  const tplCache = new Map<string, Record<string, any>>();
  const read = async (id: string) => { if (!tplCache.has(id)) tplCache.set(id, await getJob(id, token)); return tplCache.get(id)!; };

  for (const item of items) {
    if (!item.template_job_id) {
      if (!dry && await claim(item)) await done(item.booking_id, null, "No earlier GotPhoto job of this type to copy settings from. Make this one in GotPhoto.", false);
      made.push({ booking_id: item.booking_id, error: "nothing to copy" });
      continue;
    }
    let body: Record<string, unknown>;
    try {
      const tpl = await read(String(item.template_job_id));
      const org = item.org_job_id ? await read(String(item.org_job_id)).catch(() => null) : null;
      body = buildJob(item, tpl, org);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (!dry && await claim(item)) await done(item.booking_id, null, msg, true);
      made.push({ booking_id: item.booking_id, error: msg });
      continue;
    }
    if (dry) { made.push({ booking_id: item.booking_id, template: item.template_name, org_job_id: item.org_job_id, body }); continue; }
    if (!(await claim(item))) { made.push({ booking_id: item.booking_id, skipped: "already being made or linked" }); continue; }

    let resp: Response;
    try {
      resp = await fetch(`${GP_API}/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      // No answer: GotPhoto may have made it anyway, so do not try again by itself.
      await done(item.booking_id, null, "GotPhoto did not answer. Check GotPhoto for " + item.job_name + " before trying again.", false);
      made.push({ booking_id: item.booking_id, error: String(e) });
      continue;
    }
    const text = await resp.text();
    if (resp.status === 201 || resp.ok) {
      let id: string | null = null;
      try { id = JSON.parse(text)?.resource_id ?? JSON.parse(text)?.id ?? null; } catch (_) { /* fall back to Location */ }
      if (id == null) id = (resp.headers.get("location") ?? "").match(/\/jobs\/(\d+)/)?.[1] ?? null;
      if (id == null) {
        await done(item.booking_id, null, "GotPhoto made the job but did not say its number. It links itself once the sync finds " + item.job_name + ".", false);
        made.push({ booking_id: item.booking_id, error: "no id in response" });
        continue;
      }
      await done(item.booking_id, String(id), null, false);
      made.push({ booking_id: item.booking_id, gotphoto_job_id: String(id), name: item.job_name });
    } else {
      // 4xx = GotPhoto refused this body; say why (its message, not ours). 5xx = try again later.
      let why = text.slice(0, 300);
      try { const j = JSON.parse(text); why = j?.message ?? j?.detail ?? j?.title ?? (j?.violations ? j.violations.map((v: any) => `${v.propertyPath}: ${v.title ?? v.message}`).join("; ") : why); } catch (_) { /* keep text */ }
      await done(item.booking_id, null, `GotPhoto said ${resp.status}: ${why}`, resp.status >= 500 || resp.status === 429);
      made.push({ booking_id: item.booking_id, error: `${resp.status}` });
      if (resp.status === 401 || resp.status === 403) break;   // the login cannot create jobs: stop the run
    }
  }
  return Response.json({ ok: true, linked, dry, made });
});

async function claim(item: any): Promise<boolean> {
  const { data, error } = await sb.rpc("gp_create_claim", { p_item: item });
  if (error) { console.error("claim:", error.message); return false; }
  return data === true;
}
async function done(bookingId: string, job: string | null, err: string | null, retry: boolean) {
  const { error } = await sb.rpc("gp_create_done", { p_booking: bookingId, p_job: job, p_error: err, p_retry: retry });
  if (error) console.error("done:", error.message);
}
