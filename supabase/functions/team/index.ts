// team: account actions for the Team page in 207 Admin (https://admin.207photo.com).
//
// Deployed with verify_jwt=false; this function does its own checks. Only what needs the service key
// lives here (creating auth users, setting passwords, banning). Who may do it, and what access people
// get, stays in SQL: every route first calls a team_* function with the CALLER's own token, and those
// re-check is_admin() (full access + trusted session) and write the audit log (public.team_audit).
//
// Routes (POST, JSON body):
//   {action:"create", email, name, is_admin, permissions, send_welcome}  -> new login with a temporary password
//   {action:"reset_password", user_id}                       -> new temporary password
//   {action:"send_welcome", user_id, temp_password}          -> email them how to sign in + get the phone app
//   {action:"set_active", user_id, active}                   -> deactivate / reactivate (bans the login)
//   {action:"remove", user_id}                               -> take a deactivated person off the team, delete the login
// Temporary passwords are returned once and never stored; the person is asked to change it at sign-in.
// send_welcome (or create with send_welcome:true) emails it to them with the phone app link (SQL team_send_welcome,
// which only sends while they are still on a temporary password). A failed email never undoes the login.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

// A team_* SQL function, run as the caller (so is_admin() and the audit log see who did it).
async function asCaller(jwt: string, fn: string, args: Record<string, unknown>): Promise<unknown> {
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
  return text ? JSON.parse(text) : null;
}

// GoTrue admin API (service key).
async function authAdmin(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = String(data.error_code ?? data.code ?? "");
    if (code === "email_exists" || /already been registered/i.test(String(data.msg ?? data.message ?? ""))) {
      throw new Refused("Someone with that email already has a login.");
    }
    throw new Error(`auth ${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// 16 letters/digits without look-alikes (no 0/o, 1/l/i), grouped for reading aloud: "k7mp-2qrx-...".
function tempPassword(): string {
  const A = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => A[b % A.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "not_found" }, 404);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ ok: false, error: "Not signed in." }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }

  try {
    // Gate: full access on a trusted session, asked with the caller's own token.
    if ((await asCaller(jwt, "is_admin", {})) !== true) return json({ ok: false, error: "Only people with full access can manage the team." }, 403);

    if (body.action === "create") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const name = String(body.name ?? "").trim().slice(0, 120);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Refused("Enter a valid email address.");
      if (!name) throw new Refused("Enter a name.");
      const password = tempPassword();
      const user = await authAdmin("POST", "users", { email, password, email_confirm: true, user_metadata: { name } });
      const userId = String(user.id);
      try {
        await asCaller(jwt, "team_save", { p_user_id: userId, p_name: name, p_is_admin: body.is_admin === true, p_permissions: body.permissions ?? {} });
        await asCaller(jwt, "team_flag_password", { p_user_id: userId, p_flag: true });
      } catch (e) {
        await authAdmin("DELETE", `users/${userId}`).catch((d) => console.error("team/create rollback:", d));
        throw e;
      }
      let emailed = false, email_error: string | null = null;
      if (body.send_welcome === true) {
        try { await asCaller(jwt, "team_send_welcome", { p_user_id: userId, p_password: password }); emailed = true; }
        catch (e) { email_error = e instanceof Refused ? e.message : "The email did not send."; console.error("team/create welcome:", e); }
      }
      return json({ ok: true, user_id: userId, email, temp_password: password, emailed, email_error });
    }

    const userId = String(body.user_id ?? "");
    if (!UUID.test(userId)) throw new Refused("Bad user id.");

    if (body.action === "reset_password") {
      await asCaller(jwt, "team_flag_password", { p_user_id: userId, p_flag: true }); // also checks they're on the team
      const password = tempPassword();
      await authAdmin("PUT", `users/${userId}`, { password });
      return json({ ok: true, temp_password: password });
    }

    if (body.action === "send_welcome") {
      const r = await asCaller(jwt, "team_send_welcome", { p_user_id: userId, p_password: String(body.temp_password ?? "") }) as { to?: string };
      return json({ ok: true, to: r?.to ?? null });
    }

    if (body.action === "set_active") {
      const active = body.active === true;
      await asCaller(jwt, "team_set_active", { p_user_id: userId, p_active: active });
      await authAdmin("PUT", `users/${userId}`, { ban_duration: active ? "none" : "876000h" });
      return json({ ok: true });
    }

    if (body.action === "remove") {
      await asCaller(jwt, "team_remove", { p_user_id: userId }); // checks they're deactivated, logs it
      // Already off the team and their login is banned, so a failed delete leaves nothing usable behind.
      await authAdmin("DELETE", `users/${userId}`).catch((e) => console.error("team/remove auth delete:", e));
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (e) {
    if (e instanceof Refused) return json({ ok: false, error: e.message }, 400);
    console.error("team:", e);
    return json({ ok: false, error: "Something went wrong. Refresh the Team page to see what was saved." }, 500);
  }
});
