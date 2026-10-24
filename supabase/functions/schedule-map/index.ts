// schedule-map: the map beside the Schedule's day and week (2026-10-24, Schedule views).
//
// Deployed with verify_jwt=false; this function does its own checks. POST with the caller's token:
//   {start: "YYYY-MM-DD", days: 1..42, image?: true, size?: "640x420",
//    markers?: [{id, label?, color?}], routes?: [{color, stops: [place id, ...]}]}
// schedule_map_places(start, days) (run as the caller, so it checks can('scheduling','view')) lists the studio,
// each job and, for Scheduling edit only, each person's home, with any coordinates already looked up. The rest
// are looked up once with Google Places text search (biased to Maine) and kept through schedule_geo_store
// (service role). With image: true the map itself comes back as a PNG data URL from the Maps Static API
// (pins plus each person's route along the roads, from the Routes API), so the page needs no map scripts or outside images.
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

// The road a route takes (Routes API, the same one drive-time uses), as an encoded polyline for the picture.
// null when Google has no route, so the line is drawn straight instead.
async function roadPath(pts: { lat: number; lng: number }[]): Promise<string | null> {
  const ll = (p: { lat: number; lng: number }) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": MAPS_KEY, "X-Goog-FieldMask": "routes.polyline.encodedPolyline" },
    body: JSON.stringify({ origin: ll(pts[0]), destination: ll(pts[pts.length - 1]), intermediates: pts.slice(1, -1).map(ll), travelMode: "DRIVE", polylineQuality: "OVERVIEW" }),
  });
  if (!r.ok) { console.error("schedule-map route:", r.status, (await r.text().catch(() => "")).slice(0, 300)); return null; }
  return (await r.json())?.routes?.[0]?.polyline?.encodedPolyline ?? null;
}

// Google's encoded polyline format, so a long road line can be thinned to fit the picture's URL.
function decodePoly(enc: string): [number, number][] {
  const pts: [number, number][] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < enc.length) {
    for (const k of [0, 1]) {
      let shift = 0, res = 0, b: number;
      do { b = enc.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < enc.length);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}
function encodePoly(pts: [number, number][]): string {
  let out = "", pLat = 0, pLng = 0;
  const one = (v: number) => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [a, o] of pts) { const la = Math.round(a * 1e5), lo = Math.round(o * 1e5); one(la - pLat); one(lo - pLng); pLat = la; pLng = lo; }
  return out;
}
// Fewer points (Douglas-Peucker, widening the tolerance) until the line's URL-encoded size fits the budget.
function thinPoly(enc: string, budget: number): string | null {
  const pts = decodePoly(enc);
  const size = (e: string) => encodeURIComponent(e).length;
  if (size(enc) <= budget) return enc;
  const keep = (tol: number) => {
    const mark = new Uint8Array(pts.length); mark[0] = mark[pts.length - 1] = 1;
    const stack: [number, number][] = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop()!; let best = -1, far = tol;
      const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      for (let j = a + 1; j < b; j++) {
        // a day's loop starts and ends at home: measure from that point, not from a line
        const d = len < 1e-9 ? Math.hypot(pts[j][0] - ax, pts[j][1] - ay) : Math.abs(dx * (pts[j][1] - ay) - dy * (pts[j][0] - ax)) / len;
        if (d > far) { far = d; best = j; }
      }
      if (best > 0) { mark[best] = 1; stack.push([a, best], [best, b]); }
    }
    return encodePoly(pts.filter((_, j) => mark[j]));
  };
  for (let tol = 0.0005; tol < 0.2; tol *= 1.6) { const e = keep(tol); if (size(e) <= budget) return e; }
  return null;
}

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
    const coord = new Map(found.map((p) => [p.id, { lat: p.lat!, lng: p.lng! }]));
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
    // each person's route along the roads (a straight line between stops if Google has no route)
    const routes = Array.isArray(body.routes) ? body.routes.slice(0, 12) : [];
    const paths = await Promise.all(routes.map(async (r: any) => {
      const ids = (Array.isArray(r?.stops) ? r.stops : []).filter((s: string) => at.has(s)).slice(0, 25);
      if (ids.length < 2) return null;
      const color = `color:0x${COLOR.test(String(r.color ?? "")) ? r.color : "2f6db5"}cc|weight:4|`;
      const enc = await roadPath(ids.map((s: string) => coord.get(s)!)).catch(() => null);
      return { road: enc ? color + "enc:" + enc : null, straight: color + ids.map((s: string) => at.get(s)).join("|") };
    }));
    // Google takes up to about 16k characters of URL: road lines share what's left, thinned to fit (a long day's
    // road line from Google can be 12k characters or more); a line that still won't fit is drawn straight.
    const live = paths.filter(Boolean) as { road: string | null; straight: string }[];
    let room = 15000 - u.toString().length - 200;
    live.forEach((p, i) => {
      const share = Math.floor(room / (live.length - i));
      const enc = p.road ? thinPoly(p.road.slice(p.road.indexOf("enc:") + 4), share - 60) : null;
      const v = enc ? p.road!.slice(0, p.road!.indexOf("enc:") + 4) + enc : p.straight;
      u.searchParams.append("path", v);
      room -= encodeURIComponent(v).length + 6;
    });
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
