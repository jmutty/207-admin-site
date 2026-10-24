// schedule-map: the map beside the Schedule's day and week (2026-10-24, Schedule views).
//
// Deployed with verify_jwt=false; this function does its own checks. POST with the caller's token:
//   {start: "YYYY-MM-DD", days: 1..42, image?: true, size?: "640x420",
//    markers?: [{id, label?, color?}], routes?: [{color, stops: [place id, ...]}]}
// schedule_map_places(start, days) (run as the caller, so it checks can('scheduling','view')) lists the studio,
// each job and, for Scheduling edit only, each person's home, with any coordinates already looked up. The rest
// are looked up once with Google Places text search (biased to Maine) and kept through schedule_geo_store
// (service role). With image: true the map itself comes back as a PNG data URL from the Maps Static API
// (pins plus each person's route as a line), so the page needs no map scripts or outside images.
// Returns {ok, places: [{id, kind, label, lat, lng}], image: "data:image/png;base64,..." | null, map_error}.
// Same GOOGLE_MAPS_API_KEY as drive-time; the picture needs "Maps Static API" turned on for that key. When it
// isn't, the page draws the pins itself and says so.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAPS_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "https://admin.207photo.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class Refused extends Error {}

async function rpc(key: string, jwt: string, fn: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message ?? text; } catch { /* plain text */ }
    throw new Refused(msg || `HTTP ${r.status}`);
  }
  return text ? JSON.parse(text) : null;
}

type Place = { id: string; kind: string; label: string; q: string; lat: number | null; lng: number | null; known: boolean };

async function geocode(q: string): Promise<{ lat: number; lng: number } | null> {
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": MAPS_KEY, "X-Goog-FieldMask": "places.location" },
    body: JSON.stringify({ textQuery: q, regionCode: "us", locationBias: { circle: { center: { latitude: 44.8, longitude: -68.8 }, radius: 50000 } } }),
  });
  if (!r.ok) throw new Error(`Places ${r.status}`);
  const loc = (await r.json())?.places?.[0]?.location;
  return loc ? { lat: loc.latitude, lng: loc.longitude } : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COLOR = /^[0-9a-f]{6}$/i;
const ID = /^(studio|(job|home):[0-9a-f-]{36})$/i;
const LABEL = /^[A-Z0-9]$/;

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "not_found" }, 404);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Not signed in." }, 401);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
  const start = String(body.start ?? ""), days = Math.max(1, Math.min(42, Number(body.days) || 1));
  if (!DAY.test(start)) return json({ ok: false, error: "Bad request." }, 400);

  try {
    const res = await rpc(ANON_KEY, jwt, "schedule_map_places", { p_start: start, p_days: days });
    const places: Place[] = res?.places ?? [];
    if (!MAPS_KEY) return json({ ok: true, places: places.filter((p) => p.lat != null), image: null, map_error: "The map needs the Google Maps key (GOOGLE_MAPS_API_KEY)." });

    // look up what isn't known yet (a handful per call; the rest next time)
    for (const p of places.filter((x) => !x.known).slice(0, 25)) {
      try {
        const g = await geocode(p.q);
        await rpc(SERVICE_KEY, SERVICE_KEY, "schedule_geo_store", { p_q: p.q, p_lat: g?.lat ?? null, p_lng: g?.lng ?? null });
        if (g) { p.lat = g.lat; p.lng = g.lng; }
      } catch (e) { console.error("schedule-map geocode:", String(e)); break; }
    }
    const found = places.filter((p) => p.lat != null && p.lng != null);
    const at = new Map(found.map((p) => [p.id, `${p.lat!.toFixed(5)},${p.lng!.toFixed(5)}`]));
    const out = found.map(({ id, kind, label, lat, lng }) => ({ id, kind, label, lat, lng }));
    if (!body.image || !found.length) return json({ ok: true, places: out, image: null, map_error: null });

    // the picture: Maps Static API
    const size = /^\d{2,3}x\d{2,3}$/.test(String(body.size)) ? String(body.size) : "640x420";
    const u = new URL("https://maps.googleapis.com/maps/api/staticmap");
    u.searchParams.set("size", size); u.searchParams.set("scale", "2"); u.searchParams.set("maptype", "roadmap");
    u.searchParams.append("style", "feature:poi|visibility:off");
    u.searchParams.append("style", "feature:transit|visibility:off");
    const marked = new Map<string, { label: string; color: string }>();
    for (const m of Array.isArray(body.markers) ? body.markers.slice(0, 60) : []) {
      if (!ID.test(String(m?.id)) || !at.has(m.id)) continue;
      marked.set(m.id, { label: LABEL.test(String(m.label ?? "")) ? m.label : "", color: COLOR.test(String(m.color ?? "")) ? m.color : "2f6db5" });
    }
    for (const p of found) {
      if (!marked.has(p.id)) marked.set(p.id, p.kind === "studio" ? { label: "S", color: "222222" } : p.kind === "home" ? { label: "H", color: "8a8580" } : { label: "", color: "2f6db5" });
    }
    for (const [id, m] of marked) u.searchParams.append("markers", `size:mid|color:0x${m.color}|${m.label ? "label:" + m.label + "|" : ""}${at.get(id)}`);
    for (const r of Array.isArray(body.routes) ? body.routes.slice(0, 12) : []) {
      const pts = (Array.isArray(r?.stops) ? r.stops : []).filter((s: string) => at.has(s)).map((s: string) => at.get(s));
      if (pts.length < 2) continue;
      u.searchParams.append("path", `color:0x${COLOR.test(String(r.color ?? "")) ? r.color : "2f6db5"}cc|weight:4|${pts.join("|")}`);
    }
    u.searchParams.set("key", MAPS_KEY);
    const g = await fetch(u.toString());
    const type = g.headers.get("content-type") ?? "";
    if (!g.ok || !type.startsWith("image/")) {
      const t = await g.text().catch(() => "");
      console.error("schedule-map static:", g.status, t.slice(0, 300));
      return json({ ok: true, places: out, image: null,
        map_error: g.status === 403 || /not activated|not authorized|disabled/i.test(t) ? "Turn on \"Maps Static API\" for the Google Maps key in Google Cloud to see the map picture." : "Google Maps didn't send the map picture." });
    }
    return json({ ok: true, places: out, image: `data:${type.split(";")[0]};base64,${b64(await g.arrayBuffer())}`, map_error: null });
  } catch (e) {
    if (e instanceof Refused) return json({ ok: false, error: e.message }, 403);
    console.error("schedule-map:", e);
    return json({ ok: false, error: "Something went wrong." }, 500);
  }
});
