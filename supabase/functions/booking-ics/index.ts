// booking-ics: "Add to your calendar" for a director (2026-10-24, ws/director).
//
// GET https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?t=<day_token>
// Linked from the Booked email ({{calendar_link}}) and the "Your picture day" page (#day/<token>).
// Deployed with verify_jwt=false: no sign-in. The token is the only key; the SQL function booking_ics(token)
// (granted to anon) builds the whole .ics (one event per picture day, all-day until the time is set,
// cancelled events once the booking is cancelled) and returns null for an unknown token.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TOKEN = /^[0-9a-f]{20,64}$/;

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return text("Not found", 404);
  const url = new URL(req.url);
  // ?t=<token>, or /booking-ics/<token>.ics
  const token = (url.searchParams.get("t") ?? url.pathname.split("/").pop() ?? "").replace(/\.ics$/i, "").toLowerCase();
  if (!TOKEN.test(token)) return text("This calendar link isn't working. Reply to our email and we'll send a new one.", 404);

  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/booking_ics`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: token }),
  });
  if (!r.ok) return text("Something went wrong. Please try again in a minute.", 502);
  const ics = await r.json();
  if (typeof ics !== "string" || !ics.startsWith("BEGIN:VCALENDAR")) {
    return text("This calendar link isn't working. Reply to our email and we'll send a new one.", 404);
  }
  return new Response(req.method === "HEAD" ? null : ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="picture-day.ics"',
      "Cache-Control": "no-store",
    },
  });
});
