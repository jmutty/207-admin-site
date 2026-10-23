// admin: server-side helper for 207 Admin (https://admin.207photo.com).
//
// Deployed with verify_jwt=false; this function does its own checks. Until 2026-10-06 it also
// served a (stale) copy of the dashboard on GET; that copy is gone (archived in
// admin-page/archive/), the live app is the hosted bundle loaded by admin.207photo.com.
//
// Routes:
//   POST /sync -> caller must be signed in with a trusted session (emailed-code / remembered-device
//                 step) and have edit access to Galleries (can('galleries','edit'): full-access people
//                 always pass), then invoke gotphoto-sync with the x-sync-secret so the trigger secret
//                 stays off the wire.
//   POST /sales -> the same, with edit access to Season results (can('results','edit')): invoke
//                 gotphoto-sales. ?probe=<job id> passes through (field names and numbers of that job's
//                 first orders, to check how sales are read).
//   POST /gpjob?booking=<id> -> the same, with edit access to Bookings (can('bookings','edit')): invoke
//                 gotphoto-jobs for that booking ("Create it in GotPhoto" on a job).
//   POST /gplists -> the same check: GotPhoto's price and communication profiles for Settings > Job types.
//   anything else -> 404.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SYNC_TRIGGER_SECRET = Deno.env.get("SYNC_TRIGGER_SECRET") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "https://admin.207photo.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const route = req.method !== "POST" ? null
    : url.pathname.endsWith("/sync") ? { name: "sync", module: "galleries", target: "gotphoto-sync?trigger=manual" }
    : url.pathname.endsWith("/sales") ? { name: "sales", module: "results", target: "gotphoto-sales?trigger=manual" +
        (url.searchParams.get("probe") ? "&probe=" + encodeURIComponent(url.searchParams.get("probe")!) : "") }
    : url.pathname.endsWith("/gpjob") && /^[0-9a-f-]{36}$/i.test(url.searchParams.get("booking") ?? "")
      ? { name: "gpjob", module: "bookings", target: "gotphoto-jobs?trigger=manual&booking=" + url.searchParams.get("booking") }
    : url.pathname.endsWith("/gplists") ? { name: "gplists", module: "bookings", target: "gotphoto-jobs?lists=1" }
    : null;
  if (route) {
    try {
      const authz = req.headers.get("Authorization") ?? "";
      const jwt = authz.replace(/^Bearer\s+/i, "").trim();
      if (!jwt) return json({ ok: false, error: "Not signed in." }, 401);
      // Ask Postgres with the caller's own token: can() runs as that user and is false for anyone
      // without edit access to the module or who has not completed the sign-in second step.
      const who = await fetch(`${SUPABASE_URL}/rest/v1/rpc/can`, {
        method: "POST",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_module: route.module, p_level: "edit" }),
      });
      const allowed = who.ok && (await who.text()).trim() === "true";
      if (!allowed) {
        console.error(`admin/${route.name}: refused (auth status ${who.status})`);
        return json({ ok: false, error: "Invalid or expired session." }, 401);
      }
      if (!SYNC_TRIGGER_SECRET) return json({ ok: false, error: "Sync trigger secret is not configured." }, 500);
      // Invoke the function exactly the way pg_cron does: only the x-sync-secret header.
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/${route.target}`, {
        method: "POST",
        headers: { "x-sync-secret": SYNC_TRIGGER_SECRET },
      });
      const body = await resp.text();
      return new Response(body, { status: resp.status, headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (e) {
      console.error(`admin/${route.name}:`, e);
      return json({ ok: false, error: route.name === "sync" ? "Sync failed." : route.name.startsWith("gp") ? "Could not reach GotPhoto." : "Sales refresh failed." }, 500);
    }
  }

  return json({ ok: false, error: "not_found" }, 404);
});
