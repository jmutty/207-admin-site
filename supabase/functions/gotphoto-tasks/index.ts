// gotphoto-tasks: the GotPhoto API automations of 2026-10-24 (migration 20261024160000_gotphoto_tasks.sql).
//
//   ?run=cron     every 10 minutes (pg_cron, gp_tasks_wake('cron')): everything below, each step in its own
//                 try so one failing step never stops the others. Stops starting new work after TIME_BUDGET_MS.
//   ?run=actions  woken right away by gp_job_launch() and booking date changes: only the job writes.
//
// Steps:
//   actions    gp_job_actions: 'launch' = PUT /jobs/{id} {status: published}; 'dates' = PUT /jobs/{id} {shoot, archive}.
//              Reads the job back and stores what GotPhoto now has in result.
//   orders     new paid orders since yesterday (GET /orders?created_min=) -> gotphoto_orders, one row per photo file,
//              gmail_message_id 'gp-api:<order id>' (the photo release page reads this table). Skips an order the
//              Gmail Apps Script already brought in. gp_orders_seen keeps each order from being read twice.
//   galleries  for jobs around their picture day: GET /jobs/{id}/galleries -> synced_jobs.gp_galleries / gp_photo_count.
//   customers  for selling jobs: GET /jobs/{id}/customers -> gp_registered / gp_buyers.
//   coupons    a makeup with no coupon gets one (POST /coupons, like the "Makeup Day Coupon Codes").
//   makeups    after a makeup: are the athlete's photos in the job yet? (galleries + photos created since the makeup)
//   parents    a help request answered with a code: add the parent to that code in GotPhoto (potential buyer).
//
// Auth: x-sync-secret = SYNC_TRIGGER_SECRET (as gotphoto-sync / gotphoto-sales). Same GP_* login. Service role writes.
import { createClient } from "npm:@supabase/supabase-js@2";

const GP_AUTH = "https://auth.getphoto.io/oauth/access_token";
const GP_API = "https://api.getphoto.io/v4";
const TIME_BUDGET_MS = 110_000;
const TZ = "America/New_York";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRIGGER_SECRET = Deno.env.get("SYNC_TRIGGER_SECRET")!;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

function secretMatches(given: string | null): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(given ?? ""), b = enc.encode(TRIGGER_SECRET ?? "");
  if (!b.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The sign-in sometimes times out (twice a day for gotphoto-sync); try three times.
async function login(): Promise<string> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(GP_AUTH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "password",
          username: Deno.env.get("GP_USERNAME"), password: Deno.env.get("GP_PASSWORD"),
          client_id: Deno.env.get("GP_CLIENT_ID"), client_secret: Deno.env.get("GP_CLIENT_SECRET"),
          scope: Deno.env.get("GP_SCOPE"),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (resp.ok) return (await resp.json()).access_token;
      last = new Error(`GotPhoto sign-in failed: ${resp.status}`);
      if (resp.status < 500 && resp.status !== 429) break;
    } catch (e) { last = e; }
    await sleep(attempt * 2000);
  }
  throw last;
}

class GpError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`GotPhoto ${status} on ${path}${body ? ": " + body.slice(0, 200) : ""}`);
  }
}

let TOKEN = "";
async function gp(method: string, path: string, body?: unknown, attempt = 1): Promise<{ data: any; total: number | null }> {
  let resp: Response;
  try {
    resp = await fetch(GP_API + path, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    if (attempt < 3) { await sleep(attempt * 2000); return gp(method, path, body, attempt + 1); }
    throw e;
  }
  // Only reads are retried on 5xx: a write that timed out on GotPhoto's side may still have happened.
  if ((resp.status >= 500 || resp.status === 429) && attempt < 3 && (method === "GET" || resp.status === 429)) {
    await sleep(attempt * 2000);
    return gp(method, path, body, attempt + 1);
  }
  const text = await resp.text();
  if (!resp.ok) throw new GpError(resp.status, path.split("?")[0], text);
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const tc = resp.headers.get("x-total-count");
  return { data, total: tc ? parseInt(tc, 10) : null };
}

// Every row of a list. GotPhoto 404s past the last page (and on page 1 of an empty list).
async function gpAll(path: string, pageSize = 500): Promise<any[]> {
  const out: any[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= 50; page++) {
    let r;
    try { r = await gp("GET", `${path}${sep}page=${page}&limit=${pageSize}`); }
    catch (e) { if (e instanceof GpError && e.status === 404) break; throw e; }
    const arr = Array.isArray(r.data) ? r.data : r.data?.data ?? [];
    out.push(...arr);
    if (arr.length < pageSize || (r.total !== null && out.length >= r.total)) break;
  }
  return out;
}

const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Letters only, lower case: "O'Brien-Smith" -> "obriensmith".
const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");

async function setState(key: string, value: unknown) {
  await sb.from("gp_task_state").upsert({ key, value, updated_at: new Date().toISOString() });
}

// ------------------------------------------------------------------ actions (launch, dates)
async function runActions(t0: number) {
  const { data: rows, error } = await sb.from("gp_job_actions").select("*").is("done_at", null)
    .lt("tries", 3).order("requested_at").limit(20);
  if (error) throw new Error(`actions: ${error.message}`);
  let done = 0;
  for (const a of rows ?? []) {
    if (Date.now() - t0 > TIME_BUDGET_MS) break;
    await sb.from("gp_job_actions").update({ started_at: new Date().toISOString(), tries: a.tries + 1 }).eq("id", a.id);
    try {
      const body: Record<string, unknown> = {};
      if (a.action === "launch") body.status = "published";
      if (a.action === "dates") {
        if (a.payload?.shoot) body.shoot = a.payload.shoot;
        if (a.payload?.archive) body.archive = a.payload.archive;
      }
      if (!Object.keys(body).length) throw new Error("nothing to send");
      await gp("PUT", `/jobs/${encodeURIComponent(a.gotphoto_job_id)}`, body);
      const { data: job } = await gp("GET", `/jobs/${encodeURIComponent(a.gotphoto_job_id)}`);
      const result = { status: job?.status, activated: job?.activated ?? null, shoot: job?.shoot ?? null, archive: job?.archive ?? null };
      await sb.from("gp_job_actions").update({ done_at: new Date().toISOString(), ok: true, result, error: null }).eq("id", a.id);
      // Show it on the job page now instead of after the next sync.
      const patch: Record<string, unknown> = {};
      if (job?.status) patch.status = job.status;
      if (job?.activated) patch.gp_activated_at = job.activated;
      if (job?.shoot) patch.shoot_at = job.shoot;
      if (Object.keys(patch).length) await sb.from("synced_jobs").update(patch).eq("gotphoto_job_id", a.gotphoto_job_id);
      done++;
    } catch (e) {
      const last = a.tries + 1 >= 3;
      await sb.from("gp_job_actions").update({
        error: String((e as Error).message ?? e).slice(0, 500), started_at: null,
        ...(last ? { done_at: new Date().toISOString(), ok: false } : {}),
      }).eq("id", a.id);
    }
  }
  return { actions: done };
}

// ------------------------------------------------------------------ orders
async function runOrders(t0: number) {
  const { data: set } = await sb.from("gp_task_settings").select("orders_from_api").single();
  if (!set?.orders_from_api) return { orders: "off" };
  const since = ymd(new Date(Date.now() - 36 * 3600_000));
  const list = await gpAll(`/orders?created_min=${since}`, 500);
  const paid = list.filter((o) => o.payment_status === "paid" || o.status === "completed");
  if (!paid.length) return { orders: 0 };
  const ids = paid.map((o) => String(o.id));
  const { data: seenRows } = await sb.from("gp_orders_seen").select("order_id").in("order_id", ids);
  const seen = new Set((seenRows ?? []).map((r: any) => r.order_id));
  const fresh = paid.filter((o) => !seen.has(String(o.id)));
  const { data: jobRows } = await sb.from("synced_jobs").select("gotphoto_job_id, name")
    .in("gotphoto_job_id", [...new Set(fresh.map((o) => String(o.job_id)))]);
  const jobName = new Map<string, string>((jobRows ?? []).map((j: any) => [String(j.gotphoto_job_id), String(j.name ?? "")]));
  const galleryNames = new Map<string, Map<string, string>>();
  const emails = new Map<string, string>();
  let imported = 0;
  for (const o of fresh) {
    if (Date.now() - t0 > TIME_BUDGET_MS) break;
    const oid = String(o.id), jid = String(o.job_id ?? "");
    let email = emails.get(o.customer_id);
    if (email === undefined && o.customer_id) {
      try { email = String((await gp("GET", `/customers/${encodeURIComponent(o.customer_id)}`)).data?.email ?? "").trim().toLowerCase(); }
      catch { email = ""; }
      emails.set(o.customer_id, email);
    }
    const photos = await gpAll(`/orders/${encodeURIComponent(oid)}/orders_photos`, 200);
    const files = [...new Set(photos.map((p) => String(p.photo?.original_filename ?? p.photo?.file_name ?? "").trim()).filter(Boolean))];
    if (!email || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email) || !files.length) {
      await sb.from("gp_orders_seen").upsert({ order_id: oid, created: o.created, files: 0, how: !email ? "no_email" : "no_files" });
      continue;
    }
    // The Gmail script may already have brought this order in: same email, same file, within 30 minutes.
    const ts = new Date(o.created);
    const { count } = await sb.from("gotphoto_orders").select("id", { count: "exact", head: true })
      .eq("email", email).in("filename", files)
      .gte("order_ts", new Date(ts.getTime() - 30 * 60_000).toISOString())
      .lte("order_ts", new Date(ts.getTime() + 30 * 60_000).toISOString());
    if ((count ?? 0) > 0) {
      await sb.from("gp_orders_seen").upsert({ order_id: oid, created: o.created, files: files.length, how: "gmail_had_it" });
      continue;
    }
    // Album as the Gmail notices spell it: job name without the "|" separators, then the gallery.
    if (jid && !galleryNames.has(jid)) {
      try { galleryNames.set(jid, new Map((await gpAll(`/jobs/${encodeURIComponent(jid)}/galleries`, 200)).map((g) => [String(g.id), String(g.name ?? "")]))); }
      catch { galleryNames.set(jid, new Map()); }
    }
    const jn = (jobName.get(jid) ?? "").replace(/\|/g, "");
    const rows = files.map((filename) => {
      const p = photos.find((x) => String(x.photo?.original_filename ?? x.photo?.file_name ?? "").trim() === filename);
      const gname = galleryNames.get(jid)?.get(String(p?.photo?.gallery_id ?? "")) ?? "";
      return { order_ts: ts.toISOString(), email, album_name: [jn, gname].filter(Boolean).join("/") || null, filename, gmail_message_id: `gp-api:${oid}` };
    });
    const { error } = await sb.from("gotphoto_orders").upsert(rows, { onConflict: "gmail_message_id,filename", ignoreDuplicates: true });
    if (error) throw new Error(`orders insert: ${error.message}`);
    await sb.from("gp_orders_seen").upsert({ order_id: oid, created: o.created, files: files.length, how: "imported" });
    imported++;
  }
  if (imported) await setState("orders_last", { at: new Date().toISOString(), imported });
  return { orders: imported };
}

// ------------------------------------------------------------------ galleries and customers
// Jobs worth watching: on a booking whose last picture day is from 1 day ahead to 60 days ago, or live in the last 120 days.
async function watchedJobs(): Promise<any[]> {
  const from = ymd(new Date(Date.now() - 60 * 86400_000)), to = ymd(new Date(Date.now() + 86400_000));
  const { data: bk } = await sb.from("bookings").select("gotphoto_job_id, picture_day").neq("status", "cancelled")
    .not("gotphoto_job_id", "is", null).gte("picture_day", from).lte("picture_day", to);
  const ids = new Set((bk ?? []).map((b: any) => String(b.gotphoto_job_id)));
  const { data: live } = await sb.from("synced_jobs").select("gotphoto_job_id")
    .gte("gp_activated_at", new Date(Date.now() - 120 * 86400_000).toISOString());
  (live ?? []).forEach((j: any) => ids.add(String(j.gotphoto_job_id)));
  if (!ids.size) return [];
  const { data } = await sb.from("synced_jobs")
    .select("gotphoto_job_id, status, gp_activated_at, gp_galleries_at, gp_customers_at, gp_photo_count, gp_first_photo_at")
    .in("gotphoto_job_id", [...ids]);
  return data ?? [];
}

async function runGalleries(t0: number, jobs: any[]) {
  const stale = (at: string | null, mins: number) => !at || Date.now() - Date.parse(at) > mins * 60_000;
  // Not live yet: every 20 minutes (that's when photos arrive). Live: every 6 hours.
  const due = jobs.filter((j) => stale(j.gp_galleries_at, j.gp_activated_at ? 360 : 20))
    .sort((a, b) => (a.gp_galleries_at ? Date.parse(a.gp_galleries_at) : 0) - (b.gp_galleries_at ? Date.parse(b.gp_galleries_at) : 0))
    .slice(0, 40);
  let n = 0;
  for (const j of due) {
    if (Date.now() - t0 > TIME_BUDGET_MS) break;
    try {
      const gals = await gpAll(`/jobs/${encodeURIComponent(j.gotphoto_job_id)}/galleries`, 200);
      const list = gals.map((g) => ({ id: String(g.id), name: String(g.name ?? ""), photos: num(g.photo_count),
        tagged: g.tagging_completed === true || g.tagging_completed === "1", type: g.type ?? null, modified: g.modified ?? null }));
      const total = list.reduce((s, g) => s + g.photos, 0);
      const withPhotos = list.filter((g) => g.photos > 0);
      await sb.from("synced_jobs").update({
        gp_galleries: list, gp_photo_count: total,
        gp_tagging_done: withPhotos.length ? withPhotos.every((g) => g.tagged) : null,
        gp_galleries_at: new Date().toISOString(),
        ...(total > 0 && !j.gp_first_photo_at ? { gp_first_photo_at: new Date().toISOString() } : {}),
      }).eq("gotphoto_job_id", j.gotphoto_job_id);
      n++;
    } catch (e) {
      if (e instanceof GpError && e.status === 404) {
        await sb.from("synced_jobs").update({ gp_galleries: [], gp_photo_count: 0, gp_galleries_at: new Date().toISOString() }).eq("gotphoto_job_id", j.gotphoto_job_id);
      } else console.error(`galleries ${j.gotphoto_job_id}:`, String(e));
    }
  }
  if (n) await sb.rpc("booking_stages_tick");
  return { galleries: n };
}

async function runCustomers(t0: number, jobs: any[]) {
  const due = jobs.filter((j) => j.gp_activated_at && (!j.gp_customers_at || Date.now() - Date.parse(j.gp_customers_at) > 3 * 3600_000))
    .sort((a, b) => (a.gp_customers_at ? Date.parse(a.gp_customers_at) : 0) - (b.gp_customers_at ? Date.parse(b.gp_customers_at) : 0))
    .slice(0, 25);
  let n = 0;
  for (const j of due) {
    if (Date.now() - t0 > TIME_BUDGET_MS) break;
    try {
      const rows = await gpAll(`/jobs/${encodeURIComponent(j.gotphoto_job_id)}/customers`, 500);
      const all = new Set<string>(), buyers = new Set<string>();
      for (const r of rows) {
        const id = String(r.customer?.id ?? "");
        if (!id) continue;
        all.add(id);
        if (r.type === "buyer") buyers.add(id);
      }
      await sb.from("synced_jobs").update({ gp_registered: all.size, gp_buyers: buyers.size, gp_customers_at: new Date().toISOString() })
        .eq("gotphoto_job_id", j.gotphoto_job_id);
      n++;
    } catch (e) {
      if (e instanceof GpError && e.status === 404) {
        await sb.from("synced_jobs").update({ gp_registered: 0, gp_buyers: 0, gp_customers_at: new Date().toISOString() }).eq("gotphoto_job_id", j.gotphoto_job_id);
      } else console.error(`customers ${j.gotphoto_job_id}:`, String(e));
    }
  }
  return { customers: n };
}

// ------------------------------------------------------------------ makeups
// Six characters like the ledger's coupons, without look-alikes (0/O, 1/I).
function couponCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => A[x % A.length]).join("");
}

async function runCoupons(t0: number) {
  const { data: set } = await sb.from("gp_task_settings").select("makeup_coupons, coupon_name, coupon_value, coupon_shipping").single();
  if (!set?.makeup_coupons) return { coupons: "off" };
  const { data: rows } = await sb.from("makeup_bookings").select("id, athlete_name, makeup_at")
    .is("coupon_code", null).is("dismissed_at", null).is("sent_at", null)
    .gte("makeup_at", new Date(Date.now() - 30 * 86400_000).toISOString()).limit(10);
  let n = 0;
  for (const m of rows ?? []) {
    if (Date.now() - t0 > TIME_BUDGET_MS) break;
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = couponCode();
      try {
        const r = await gp("POST", "/coupons", {
          name: set.coupon_name, code, type: "value",
          product_value: { amount: Number(set.coupon_value), currency: "USD" },
          product_value_net: { amount: Number(set.coupon_value), currency: "USD" },
          shipping_value: { amount: Number(set.coupon_shipping), currency: "USD" },
          minimum_basket_sum: { amount: 0, currency: "USD" },
          max_uses: 1, max_uses_per_password: 0,
        });
        // Only store a code GotPhoto accepted, and only if the row still has none.
        await sb.from("makeup_bookings").update({ coupon_code: code, coupon_gp_id: String(r.data?.resource_id ?? ""), coupon_made_at: new Date().toISOString() })
          .eq("id", m.id).is("coupon_code", null);
        n++;
        break;
      } catch (e) {
        // 422 is most likely a code that already exists: try another.
        if (!(e instanceof GpError && e.status === 422) || attempt === 2) { console.error(`coupon for ${m.id}:`, String(e)); break; }
      }
    }
  }
  return { coupons: n };
}

async function runMakeups(t0: number) {
  const now = Date.now();
  const { data: rows } = await sb.from("makeup_bookings")
    .select("id, athlete_name, makeup_at, confirmed_job_id, suggested_job_id, photos_checked_at")
    .is("dismissed_at", null).is("sent_at", null).is("photos_in_at", null)
    .lt("makeup_at", new Date(now).toISOString()).gte("makeup_at", new Date(now - 21 * 86400_000).toISOString())
    .order("makeup_at", { ascending: false }).limit(25);
  let checked = 0, found = 0;
  for (const m of rows ?? []) {
    if (Date.now() - t0 > TIME_BUDGET_MS) break;
    const job = m.confirmed_job_id ?? m.suggested_job_id;
    if (!job) continue;
    if (m.photos_checked_at && now - Date.parse(m.photos_checked_at) < 20 * 60_000) continue;
    checked++;
    try {
      const since = Date.parse(m.makeup_at);
      const nameParts = String(m.athlete_name ?? "").split(/\s+/).map(norm).filter((x) => x.length > 1);
      const gals = await gpAll(`/jobs/${encodeURIComponent(job)}/galleries`, 200);
      let byName = 0, newer = 0;
      for (const g of gals) {
        if (g.modified && Date.parse(g.modified) < since - 6 * 3600_000) continue;  // nothing added to this gallery since
        const photos = await gpAll(`/jobs/${encodeURIComponent(job)}/galleries/${encodeURIComponent(g.id)}/photos?created_min=${ymd(new Date(since))}`, 500);
        for (const p of photos) {
          if (!p.created || Date.parse(p.created) < since) continue;
          newer++;
          const f = norm(String(p.file_name ?? "") + " " + String(p.name ?? ""));
          if (nameParts.length >= 2 && nameParts.every((x) => f.includes(x))) byName++;
        }
      }
      const patch: Record<string, unknown> = { photos_checked_at: new Date().toISOString() };
      if (byName || newer) {
        Object.assign(patch, { photos_in_at: new Date().toISOString(), photos_how: byName ? "name" : "upload", photos_n: byName || newer });
        // The suggested team's job had the photos: confirm it (a person can still change it).
        if (!m.confirmed_job_id && byName) Object.assign(patch, { confirmed_job_id: job, auto_confirmed: true });
        found++;
      }
      await sb.from("makeup_bookings").update(patch).eq("id", m.id);
      if (patch.photos_in_at) {
        const { data: sent } = await sb.rpc("makeup_send_auto", { p_id: m.id });
        if (sent?.ok) console.log(`makeup ${m.id}: sent automatically`);
      }
    } catch (e) {
      console.error(`makeup ${m.id}:`, String(e));
      await sb.from("makeup_bookings").update({ photos_checked_at: new Date().toISOString() }).eq("id", m.id);
    }
  }
  return { makeups_checked: checked, makeups_found: found };
}

// ------------------------------------------------------------------ parents (help requests)
async function runParents(t0: number) {
  const { data: set } = await sb.from("gp_task_settings").select("link_parents").single();
  if (!set?.link_parents) return { parents: "off" };
  const { data: rows } = await sb.from("lookup_requests")
    .select("id, gotphoto_job_id, reply_to, parent_email, reply_code, search_data, gp_link_tries")
    .not("reply_code", "is", null).is("gp_linked_at", null).lt("gp_link_tries", 3)
    .gte("reply_sent_at", new Date(Date.now() - 14 * 86400_000).toISOString()).limit(20);
  let n = 0;
  for (const r of rows ?? []) {
    if (Date.now() - t0 > TIME_BUDGET_MS) break;
    try {
      const email = String(r.reply_to || r.parent_email || "").trim().toLowerCase();
      let q = sb.from("synced_codes").select("gotphoto_password_id, gotphoto_job_id").ilike("code", r.reply_code).limit(2);
      if (r.gotphoto_job_id) q = q.eq("gotphoto_job_id", r.gotphoto_job_id);
      const { data: codes } = await q;
      if (!codes || codes.length !== 1) throw new Error(codes?.length ? "that code is on more than one job" : "code not found in the synced codes");
      const pid = codes[0].gotphoto_password_id;
      let cid = "";
      const found = await gp("GET", `/customers?email=${encodeURIComponent(email)}&limit=5`).catch((e) => {
        if (e instanceof GpError && e.status === 404) return { data: [], total: 0 };
        throw e;
      });
      const match = (Array.isArray(found.data) ? found.data : []).find((c: any) => String(c.email ?? "").toLowerCase() === email);
      if (match) cid = String(match.id);
      else {
        const sd = r.search_data ?? {};
        const name = String(sd.searcher_name ?? "").trim().split(/\s+/);
        const made = await gp("POST", "/customers", {
          email, language: "en-us",
          ...(name[0] ? { first_name: name[0] } : {}), ...(name.length > 1 ? { last_name: name.slice(1).join(" ") } : {}),
        });
        cid = String(made.data?.resource_id ?? "");
      }
      if (!cid) throw new Error("GotPhoto did not return a customer");
      const linked = await gpAll(`/passwords/${encodeURIComponent(pid)}/customers`, 200).catch(() => []);
      if (!linked.some((x: any) => String(x.customer?.id ?? x.customer?.[0]?.id ?? "") === cid)) {
        await gp("POST", `/passwords/${encodeURIComponent(pid)}/customers`, { customer_id: cid, type: "potential_buyer" });
      }
      await sb.from("lookup_requests").update({ gp_linked_at: new Date().toISOString(), gp_customer_id: cid, gp_link_error: null }).eq("id", r.id);
      n++;
    } catch (e) {
      await sb.from("lookup_requests").update({ gp_link_tries: (r.gp_link_tries ?? 0) + 1, gp_link_error: String((e as Error).message ?? e).slice(0, 300) }).eq("id", r.id);
    }
  }
  return { parents: n };
}

// ------------------------------------------------------------------ main
Deno.serve(async (req) => {
  if (!secretMatches(req.headers.get("x-sync-secret"))) return new Response("forbidden", { status: 403 });
  const run = new URL(req.url).searchParams.get("run") ?? "cron";
  const t0 = Date.now();
  const out: Record<string, unknown> = { run };
  const errors: Record<string, string> = {};
  try {
    TOKEN = await login();
  } catch (e) {
    await setState("last_run", { at: new Date().toISOString(), run, ok: false, error: String(e) });
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
  const step = async (name: string, f: () => Promise<Record<string, unknown>>) => {
    if (Date.now() - t0 > TIME_BUDGET_MS) { errors[name] = "skipped: out of time"; return; }
    try { Object.assign(out, await f()); } catch (e) { errors[name] = String((e as Error).message ?? e).slice(0, 300); console.error(name, e); }
  };
  await step("actions", () => runActions(t0));
  if (run === "cron") {
    await step("orders", () => runOrders(t0));
    let jobs: any[] = [];
    await step("jobs", async () => { jobs = await watchedJobs(); return { watched: jobs.length }; });
    await step("galleries", () => runGalleries(t0, jobs));
    await step("coupons", () => runCoupons(t0));
    await step("makeups", () => runMakeups(t0));
    await step("parents", () => runParents(t0));
    await step("customers", () => runCustomers(t0, jobs));
    await setState("last_run", { at: new Date().toISOString(), ok: !Object.keys(errors).length, ms: Date.now() - t0, ...out, errors });
  }
  return Response.json({ ok: !Object.keys(errors).length, ...out, errors });
});
