// push-sender: sends queued 207 Admin push notifications (public.push_outbox).
//
// Deployed with verify_jwt=false. Only the database calls it: push_notify() pokes it through pg_net
// right after something happens, and the push-retry cron re-pokes every 5 minutes while anything is
// unsent. Both send x-push-secret (Vault: push_trigger_secret), checked by push_trigger_ok().
// Who gets what is decided in SQL (push_claim); this function only encrypts and delivers.
// The VAPID key pair is created here on first run and kept in Vault (push_vapid_store).
import { generateVapidKeys, sendPush, type VapidKeys } from "./webpush.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUBJECT = "mailto:info@207photo.com";

async function rpc(fn: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function vapidKeys(): Promise<VapidKeys> {
  let k = await rpc("push_vapid_keys") as { public: string | null; private: string | null };
  if (!k.public || !k.private) {
    const g = await generateVapidKeys();
    k = await rpc("push_vapid_store", { p_public: g.publicKey, p_private: JSON.stringify(g.privateJwk) }) as typeof k;
  }
  return { publicKey: k.public!, privateJwk: JSON.parse(k.private!) };
}

interface Claimed { id: number; title: string; body: string; url: string; tag: string | null; subs: { id: string; endpoint: string; p256dh: string; auth: string }[] }

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("not found", { status: 404 });
  try {
    if ((await rpc("push_trigger_ok", { p: req.headers.get("x-push-secret") ?? "" })) !== true) return new Response("forbidden", { status: 403 });
    const keys = await vapidKeys();
    let sent = 0, failed = 0, batches = 0;
    const started = Date.now();
    while (batches < 10 && Date.now() - started < 40_000) {
      const items = await rpc("push_claim", { p_limit: 20 }) as Claimed[];
      if (!items.length) break;
      batches++;
      const results = await Promise.all(items.map(async (n) => {
        const r = { id: n.id, sent: 0, failed: 0, ok_subs: [] as string[], gone_subs: [] as string[], failed_subs: [] as string[], errors: [] as string[] };
        await Promise.all(n.subs.map(async (s) => {
          try {
            const res = await sendPush(s, { title: n.title, body: n.body, url: n.url, tag: n.tag }, keys, SUBJECT, { topic: n.tag ?? undefined });
            if (res.status >= 200 && res.status < 300) { r.sent++; r.ok_subs.push(s.id); }
            else if (res.status === 404 || res.status === 410) { r.gone_subs.push(s.id); }
            else { r.failed++; r.failed_subs.push(s.id); r.errors.push(`${res.status} ${res.body.slice(0, 120)}`); }
          } catch (e) { r.failed++; r.failed_subs.push(s.id); r.errors.push(String(e).slice(0, 120)); }
        }));
        sent += r.sent; failed += r.failed;
        return r;
      }));
      await rpc("push_done", { p_results: results });
    }
    return new Response(JSON.stringify({ ok: true, sent, failed }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("push-sender:", e);
    return new Response(JSON.stringify({ ok: false }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
