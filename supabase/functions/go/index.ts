// go: the tracked-link redirect in booking emails (2026-10-24, adaptive booking emails).
//
// GET https://socluffmclkdljtmiexw.supabase.co/functions/v1/go?e=<booking_emails.id>&u=<base64url of the link>
// booking_track_links() writes these into each email when it is rendered. Only our own pages are tracked:
// the hubs, the picture day page (#day/<token>) and the calendar file. booking_link_click (granted to anon)
// checks the link against the same list, logs the click (once per link per 10 minutes) and answers where to
// go. Anything else gets a plain page, never a redirect, so this can't be used to bounce people elsewhere.
// Deployed with verify_jwt=false: email links carry no sign-in.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OURS = /^https:\/\/(207photo\.com\/(sportsadmin|schooladmin)|admin\.207photo\.com\/#day\/|socluffmclkdljtmiexw\.supabase\.co\/functions\/v1\/booking-ics\?)/;

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function decode(u: string): string {
  try {
    const b64 = u.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return text("Not found", 404);
  const url = new URL(req.url);
  const email = url.searchParams.get("e") ?? "";
  const link = decode(url.searchParams.get("u") ?? "");
  if (!OURS.test(link) || link.length >= 600) return text("This link isn't working. Reply to our email and we'll send it again.", 404);

  let dest = link;
  if (UUID.test(email) && req.method === "GET") {
    try {
      const ip = req.headers.get("cf-connecting-ip") ?? (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/booking_link_click`, {
        method: "POST",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ p_email: email, p_url: link }),
      });
      if (r.ok) {
        const answer = await r.json();
        if (answer === null) return text("This link isn't working. Reply to our email and we'll send it again.", 404);
        if (typeof answer === "string" && OURS.test(answer)) dest = answer;
      }
    } catch {
      // logging is best effort; the person still gets where they were going
    }
  }
  return new Response(null, { status: 302, headers: { Location: dest, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
});
