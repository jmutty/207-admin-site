// booking-weather: the forecast check for outdoor picture days (2026-10-24, adaptive booking emails).
//
// Called by cron twice a day (booking_poke('booking-weather'), header x-booking-secret checked by RPC
// booking_trigger_ok). POST {} checks every booking from booking_weather_due(): shooting outdoors or
// "either", with a location, one to three days out. POST {booking_id} checks just that one.
//
// For each day: the location is geocoded once (Google Places Text Search, secret GOOGLE_MAPS_API_KEY,
// cached on the booking by booking_weather_geo), then the National Weather Service hourly grid
// (api.weather.gov, free, no key) gives the chance of rain and wind gusts for each hour of the shoot
// (9 AM to 5 PM when no time is set). booking_weather_record() decides: 20%+ rain or gusts over 25 mph
// is bad, and whoever booked the job gets a Today task and a push. Nothing goes to the AD.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAPS_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const TZ = "America/New_York";
const NWS_HEADERS = { "User-Agent": "207 Photo admin (info@207photo.com)", Accept: "application/geo+json" };
const HOUR = 3600_000;

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { "Content-Type": "application/json" } });

type Due = { booking_id: string; day: string; days_out: number; location: string; lat: number | null; lng: number | null; geo_for: string | null; start_at: string | null; end_at: string | null };
type Series = { start: number; end: number; value: number }[];

// "2026-10-23T05:00:00+00:00/PT3H" or ".../P1DT4H" -> [start, end) in ms
function interval(validTime: string): [number, number] {
  const [at, dur] = validTime.split("/");
  const start = Date.parse(at);
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(dur ?? "");
  const ms = m ? ((+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 60 + +(m[3] ?? 0)) * 60_000 : HOUR;
  return [start, start + ms];
}

function series(prop: any): Series {
  return (prop?.values ?? []).filter((v: any) => v.value != null).map((v: any) => {
    const [start, end] = interval(v.validTime);
    return { start, end, value: Number(v.value) };
  });
}

const at = (s: Series, t: number) => s.find((x) => t >= x.start && t < x.end)?.value ?? null;

// minutes east of UTC for New York on that instant (-240 or -300)
function nyOffset(t: number): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).formatToParts(new Date(t))
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(name);
  return m ? +m[1] * 60 + Math.sign(+m[1]) * +(m[2] ?? 0) : -300;
}

function localTime(day: string, hour: number): number {
  const guess = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  return guess - nyOffset(guess) * 60_000;
}

const hourLabel = (t: number) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric" }).format(new Date(t));

async function geocode(d: Due): Promise<[number, number] | null> {
  if (d.lat != null && d.lng != null && d.geo_for === d.location) return [d.lat, d.lng];
  if (!MAPS_KEY) throw new Error("GOOGLE_MAPS_API_KEY missing");
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": MAPS_KEY, "X-Goog-FieldMask": "places.location" },
    body: JSON.stringify({ textQuery: d.location, regionCode: "us", locationBias: { circle: { center: { latitude: 44.8, longitude: -68.8 }, radius: 50000 } } }),
  });
  if (!r.ok) throw new Error(`Places ${r.status}`);
  const loc = (await r.json())?.places?.[0]?.location;
  if (!loc) return null;
  await db.rpc("booking_weather_geo", { p_booking: d.booking_id, p_lat: loc.latitude, p_lng: loc.longitude, p_for: d.location });
  return [loc.latitude, loc.longitude];
}

const grids = new Map<string, any>();
async function grid(lat: number, lng: number): Promise<any> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (grids.has(key)) return grids.get(key);
  const p = await fetch(`https://api.weather.gov/points/${key}`, { headers: NWS_HEADERS });
  if (!p.ok) throw new Error(`NWS points ${p.status}`);
  const gridUrl = (await p.json())?.properties?.forecastGridData;
  if (!gridUrl) throw new Error("NWS: no forecast grid for this spot");
  const g = await fetch(gridUrl, { headers: NWS_HEADERS });
  if (!g.ok) throw new Error(`NWS grid ${g.status}`);
  const props = (await g.json())?.properties;
  grids.set(key, props);
  return props;
}

async function check(d: Due): Promise<Record<string, unknown>> {
  try {
    const ll = await geocode(d);
    if (!ll) throw new Error(`Couldn't find "${d.location}" on the map`);
    const props = await grid(ll[0], ll[1]);
    const pop = series(props?.probabilityOfPrecipitation);
    const gust = series(props?.windGust);
    const gustMph = (props?.windGust?.uom ?? "wmoUnit:km_h-1").includes("km_h") ? 0.621371 : 1;
    let start = d.start_at ? Date.parse(d.start_at) : localTime(d.day, 9);
    let end = d.end_at ? Date.parse(d.end_at) : (d.start_at ? start + 3 * HOUR : localTime(d.day, 17));
    if (end <= start) end = start + HOUR;
    start = Math.floor(start / HOUR) * HOUR;
    const hours: { hour: string; pop: number; gust: number }[] = [];
    let maxPop = 0, maxGust = 0, seen = false;
    for (let t = start; t < end; t += HOUR) {
      const p = at(pop, t), g = at(gust, t);
      if (p == null && g == null) continue;
      seen = true;
      const mph = Math.round((g ?? 0) * gustMph);
      hours.push({ hour: hourLabel(t), pop: Math.round(p ?? 0), gust: mph });
      maxPop = Math.max(maxPop, Math.round(p ?? 0));
      maxGust = Math.max(maxGust, mph);
    }
    if (!seen) throw new Error("The forecast doesn't reach that day yet");
    const { data, error } = await db.rpc("booking_weather_record", {
      p_booking: d.booking_id, p_day: d.day, p_max_pop: maxPop, p_max_gust: maxGust, p_hours: hours, p_error: null,
    });
    if (error) throw new Error(error.message);
    return { booking_id: d.booking_id, day: d.day, max_pop: maxPop, max_gust: maxGust, ...(data ?? {}) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.rpc("booking_weather_record", { p_booking: d.booking_id, p_day: d.day, p_max_pop: null, p_max_gust: null, p_hours: null, p_error: msg });
    return { booking_id: d.booking_id, day: d.day, error: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const secret = req.headers.get("x-booking-secret") ?? "";
  const { data: ok, error: authErr } = await db.rpc("booking_trigger_ok", { p: secret });
  if (authErr || ok !== true) return json({ ok: false, error: "unauthorized" }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const { data: due, error } = await db.rpc("booking_weather_due");
  if (error) return json({ ok: false, error: error.message }, 500);
  const list = ((due ?? []) as Due[]).filter((d) => !body.booking_id || d.booking_id === String(body.booking_id));
  const results = [];
  for (const d of list) results.push(await check(d));
  return json({ ok: true, checked: results.length, results });
});
