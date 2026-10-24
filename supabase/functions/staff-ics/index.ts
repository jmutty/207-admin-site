// staff-ics: a team member's own schedule as a calendar their phone subscribes to (2026-10-24, Schedule views).
//
// GET https://socluffmclkdljtmiexw.supabase.co/functions/v1/staff-ics?t=<token>  (or webcal://...)
// The link comes from "Phone calendar" on the Schedule page (SQL staff_cal_link, which can also make a new one).
// Deployed with verify_jwt=false: no sign-in. The token is the only key; the SQL function staff_ics(token)
// (granted to anon) builds the whole .ics: that person's bars from 30 days ago to 6 months ahead, jobs with
// the address, when to leave, the role, "For the crew" and the WiFi. Unknown or reset tokens get null.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TOKEN = /^[0-9a-f]{20,64}$/;

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return text("Not found", 404);
  const url = new URL(req.url);
  // ?t=<token>, or /staff-ics/<token>.ics
  const token = (url.searchParams.get("t") ?? url.pathname.split("/").pop() ?? "").replace(/\.ics$/i, "").toLowerCase();
  if (!TOKEN.test(token)) return text("This calendar link isn't working any more. Get a new one from Phone calendar on the Schedule page in 207 Admin.", 404);

  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/staff_ics`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: token }),
  });
  if (!r.ok) return text("Something went wrong. Please try again in a minute.", 502);
  const ics = await r.json();
  if (typeof ics !== "string" || !ics.startsWith("BEGIN:VCALENDAR")) {
    return text("This calendar link isn't working any more. Get a new one from Phone calendar on the Schedule page in 207 Admin.", 404);
  }
  return new Response(req.method === "HEAD" ? null : ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="207-schedule.ics"',
      "Cache-Control": "no-store",
    },
  });
});
