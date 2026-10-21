// place-search: Google Maps place suggestions for the Location box on Book a job / Edit booking in 207 Admin.
//
// Deployed with verify_jwt=false; this function does its own checks. POST with the caller's token:
//   {q, session}         -> {ok, places: [{id, name, detail}]}   (Places API (New) Autocomplete, biased to Maine)
//   {place_id, session}  -> {ok, name, address, location}        (Place Details: name + formatted address)
// `session` is a UUID the page makes per search so Google bills the typing and the pick as one session.
// The caller must have can('bookings','edit'). The picked text goes in bookings.location, which drive-time
// already sends to the Routes API, so drive times use the exact address.
//
// Needs the secret GOOGLE_MAPS_API_KEY with "Places API (New)" enabled (as well as the Routes API). Without
// it the page says so and the location is typed by hand like before.

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

// Maine, a little wider (jobs near the NH line). A bias, not a limit: other places still come up.
const MAINE = { rectangle: { low: { latitude: 42.9, longitude: -71.3 }, high: { latitude: 47.5, longitude: -66.9 } } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;

async function allowed(jwt: string): Promise<boolean> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/can`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_module: "bookings", p_level: "edit" }),
  });
  return r.ok && (await r.json().catch(() => false)) === true;
}

// Google's refusal, in words someone can act on.
function googleError(status: number, g: Record<string, any>): string {
  const msg = String(g?.error?.message ?? "");
  if (status === 403 || /not been used|disabled|not authorized|blocked/i.test(msg)) {
    return "Google Maps search is not turned on for this key. Enable \"Places API (New)\" for the Google Maps key in Google Cloud. Type the location for now.";
  }
  return "Google Maps did not answer. Type the location for now.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "not_found" }, 404);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Not signed in." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
  const session = UUID.test(String(body.session ?? "")) ? String(body.session) : undefined;

  try {
    if (!(await allowed(jwt))) return json({ ok: false, error: "not allowed" }, 403);
    if (!MAPS_KEY) return json({ ok: false, error: "Location search needs a Google Maps key (GOOGLE_MAPS_API_KEY). Type the location for now." });

    if (body.place_id !== undefined) {
      const id = String(body.place_id);
      if (!PLACE_ID.test(id)) return json({ ok: false, error: "Bad request." }, 400);
      const r = await fetch(`https://places.googleapis.com/v1/places/${id}` + (session ? `?sessionToken=${session}` : ""), {
        headers: { "X-Goog-Api-Key": MAPS_KEY, "X-Goog-FieldMask": "displayName,formattedAddress,location" },
      });
      const g = await r.json().catch(() => ({}));
      if (!r.ok) { console.error("place-search details:", r.status, JSON.stringify(g).slice(0, 500)); return json({ ok: false, error: googleError(r.status, g) }); }
      return json({ ok: true, name: g?.displayName?.text ?? "", address: g?.formattedAddress ?? "", location: g?.location ?? null });
    }

    const q = String(body.q ?? "").trim().slice(0, 200);
    if (q.length < 2) return json({ ok: true, places: [] });
    const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": MAPS_KEY },
      body: JSON.stringify({ input: q, includedRegionCodes: ["us"], locationBias: MAINE, ...(session ? { sessionToken: session } : {}) }),
    });
    const g = await r.json().catch(() => ({}));
    if (!r.ok) { console.error("place-search autocomplete:", r.status, JSON.stringify(g).slice(0, 500)); return json({ ok: false, error: googleError(r.status, g) }); }
    const places = (g?.suggestions ?? []).map((s: any) => s?.placePrediction).filter((p: any) => p?.placeId).slice(0, 6).map((p: any) => ({
      id: p.placeId,
      name: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
      detail: p.structuredFormat?.secondaryText?.text ?? "",
    }));
    return json({ ok: true, places });
  } catch (e) {
    console.error("place-search:", e);
    return json({ ok: false, error: "Something went wrong." }, 500);
  }
});
