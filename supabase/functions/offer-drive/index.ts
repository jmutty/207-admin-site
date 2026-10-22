// offer-drive: drive times from part-timers' homes to a job, for Open jobs in 207 Admin.
//
// Deployed with verify_jwt=false; this function does its own checks. POST {booking_id} with the caller's
// token. offer_drive_targets() (run as the caller, so it checks can('openjobs','edit')) returns the job's
// address and the home addresses with no cached drive to it. Google Maps (Routes API, computeRouteMatrix,
// driving, no traffic) is asked for those in batches of 25, and the answers are stored with
// offer_drive_store(). The page then reads them from openjobs_candidates(). Returns {ok, asked, stored}.
//
// Uses the same secret as drive-time: GOOGLE_MAPS_API_KEY (Routes API enabled).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MAPS_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "https://admin.207photo.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

class Refused extends Error {}

// A SQL function, run as the caller (so can() sees who is asking).
async function asCaller(jwt: string, fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message ?? text; } catch { /* plain text */ }
    throw new Refused(msg || `HTTP ${r.status}`);
  }
  return text ? JSON.parse(text) : {};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Element { originIndex?: number; duration?: string; distanceMeters?: number; condition?: string }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "not_found" }, 404);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Not signed in." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
  const booking = String(body.booking_id ?? "");
  if (!UUID.test(booking)) return json({ ok: false, error: "Bad request." }, 400);

  try {
    const t = await asCaller(jwt, "offer_drive_targets", { p_booking: booking });
    if (t.ok !== true) return json({ ok: false, error: t.error ?? "No address." });
    const destination = String(t.destination);
    const origins = (t.origins as string[]) ?? [];
    if (!origins.length) return json({ ok: true, asked: 0, stored: 0 });
    if (!MAPS_KEY) return json({ ok: false, error: "Drive times need a Google Maps key (GOOGLE_MAPS_API_KEY)." });

    const rows: { origin: string; minutes: number; meters: number | null }[] = [];
    let missed = 0;
    for (let i = 0; i < origins.length; i += 25) {
      const batch = origins.slice(i, i + 25);
      const r = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": MAPS_KEY, "X-Goog-FieldMask": "originIndex,duration,distanceMeters,condition" },
        body: JSON.stringify({
          origins: batch.map((a) => ({ waypoint: { address: a } })),
          destinations: [{ waypoint: { address: destination } }],
          travelMode: "DRIVE", units: "IMPERIAL",
        }),
      });
      const g = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(g)) {
        console.error("offer-drive google:", r.status, JSON.stringify(g).slice(0, 500));
        return json({ ok: false, error: "Google Maps did not answer. Drive times are unknown for now." });
      }
      for (const e of g as Element[]) {
        const origin = batch[e.originIndex ?? 0];
        if (e.condition === "ROUTE_EXISTS" && e.duration && origin) {
          rows.push({ origin, minutes: Math.round(parseInt(String(e.duration), 10) / 60), meters: typeof e.distanceMeters === "number" ? e.distanceMeters : null });
        } else missed++;
      }
    }
    const s = await asCaller(jwt, "offer_drive_store", { p_destination: destination, p_rows: rows });
    return json({ ok: true, asked: origins.length, stored: s.stored ?? rows.length, missed });
  } catch (e) {
    if (e instanceof Refused) return json({ ok: false, error: e.message }, 403);
    console.error("offer-drive:", e);
    return json({ ok: false, error: "Something went wrong." }, 500);
  }
});
