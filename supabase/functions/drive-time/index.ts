// drive-time: how long the drive is from the studio to a job, for the Schedule page in 207 Admin.
//
// Deployed with verify_jwt=false; this function does its own checks. POST {booking_id} with the caller's
// token. drive_time_target() (run as the caller, so it checks can('scheduling','edit')) says what to ask
// and returns a cached answer when there is one. Otherwise Google Maps (Routes API, computeRoutes, driving,
// no traffic) is asked once and the answer is cached with drive_time_store(). Returns {ok, minutes, ...}.
// With {from_booking_id, booking_id} it is the drive from one job to the next (batched jobs): asked through
// drive_leg_target() / drive_leg_store() instead (Scheduling edit only).
//
// Needs the secret GOOGLE_MAPS_API_KEY (a Google Cloud key with the Routes API enabled; restrict it to
// that API). Without it the Schedule page says so and the minutes are typed in by hand.

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "not_found" }, 404);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Not signed in." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
  const booking = String(body.booking_id ?? "");
  const from = body.from_booking_id == null ? "" : String(body.from_booking_id);
  if (!UUID.test(booking) || (from && !UUID.test(from))) return json({ ok: false, error: "Bad request." }, 400);

  try {
    const t = from ? await asCaller(jwt, "drive_leg_target", { p_from: from, p_to: booking })
                   : await asCaller(jwt, "drive_time_target", { p_booking: booking });
    if (t.ok !== true) return json({ ok: false, error: t.error ?? "No address." });
    if (typeof t.minutes === "number") return json({ ok: true, minutes: t.minutes, meters: t.meters, origin: t.origin, destination: t.destination, cached: true });
    if (!MAPS_KEY) return json({ ok: false, error: "Drive times need a Google Maps key (GOOGLE_MAPS_API_KEY). Type the minutes for now." });

    const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": MAPS_KEY, "X-Goog-FieldMask": "routes.duration,routes.distanceMeters" },
      body: JSON.stringify({ origin: { address: t.origin }, destination: { address: t.destination }, travelMode: "DRIVE", units: "IMPERIAL" }),
    });
    const g = await r.json().catch(() => ({}));
    const route = g?.routes?.[0];
    if (!r.ok || !route?.duration) {
      console.error("drive-time google:", r.status, JSON.stringify(g).slice(0, 500));
      return json({ ok: false, error: r.ok ? `Google Maps found no route ${from ? `from "${t.origin}" ` : ""}to "${t.destination}". Check the location on the booking.` : "Google Maps did not answer. Type the minutes for now." });
    }
    const minutes = Math.round(parseInt(String(route.duration), 10) / 60);
    const meters = typeof route.distanceMeters === "number" ? route.distanceMeters : null;
    await asCaller(jwt, from ? "drive_leg_store" : "drive_time_store", { p_origin: t.origin, p_destination: t.destination, p_minutes: minutes, p_meters: meters });
    return json({ ok: true, minutes, meters, origin: t.origin, destination: t.destination, cached: false });
  } catch (e) {
    if (e instanceof Refused) return json({ ok: false, error: e.message }, 403);
    console.error("drive-time:", e);
    return json({ ok: false, error: "Something went wrong." }, 500);
  }
});
