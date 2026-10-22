// gotphoto-sales: reads each job's orders from the GotPhoto Admin API and stores sales and order counts
// in job_results (Season results page). Hourly from pg_cron, and "Refresh sales" in 207 Admin (through
// the admin function's /sales route).
//
// Auth: x-sync-secret = SYNC_TRIGGER_SECRET, the same secret gotphoto-sync uses. Writes with the
// service role. Uses the same GotPhoto login (GP_* env) as gotphoto-sync.
//
// Which jobs: results_sales_queue() (never read, still selling and not read in 6 hours, or archived
// since the last read), newest picture days first. Stops starting new jobs after TIME_BUDGET_MS; the
// next run carries on.
//
// Reading an order. GotPhoto's /orders response is not documented publicly, so this is careful:
//   - the job: job_id, jobId, job.id or job on each order. An order for another job is not counted,
//     and if GotPhoto ignores ?job_id= (every order comes back) the run stops instead of counting the
//     whole account against each job.
//   - the amount: results_settings.gp_amount_field if set, else the first of AMOUNT_KEYS the first
//     order carries. Numbers, numeric strings and {amount|value: ...} are understood; cents when
//     gp_amount_cents is on or the field name ends in _cents. The field used is saved in
//     results_settings.gp_field_used so the page can show it.
//   - orders whose status is in results_settings.gp_skip_statuses (cancelled, refunded, ...) are left out.
//   ?probe=<job id> returns the shape of that job's first orders (field names and numbers only, never
//   names or emails) without writing anything, to check the field choice.
import { createClient } from "npm:@supabase/supabase-js@2";

const GP_AUTH = "https://auth.getphoto.io/oauth/access_token";
const GP_API = "https://api.getphoto.io/v4";
const TIME_BUDGET_MS = 100_000;
const PAGE_SIZE = 1000;
const AMOUNT_KEYS = ["total_net", "net_total", "subtotal_net", "total_without_tax", "subtotal", "total",
  "total_gross", "grand_total", "amount", "sum", "price"];

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

async function gpFetch(url: string, token: string, attempt = 1): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    if (attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 2000)); return gpFetch(url, token, attempt + 1); }
    throw e;
  }
  if ((resp.status >= 500 || resp.status === 429) && attempt < 3) {
    await new Promise((r) => setTimeout(r, attempt * 2000));
    return gpFetch(url, token, attempt + 1);
  }
  if (!resp.ok) throw new Error(`GotPhoto ${resp.status} on ${url.split("?")[0]}`);
  return resp;
}

// Every order for a job. A 404 on page 1 means no orders (GotPhoto 404s past the last page). A pull
// shorter than X-Total-Count is an error, so a job's sales never drop because a page went missing.
async function jobOrders(jobId: string, token: string): Promise<any[]> {
  const out: any[] = [];
  let expected: number | null = null;
  for (let page = 1; ; page++) {
    let resp: Response;
    try {
      resp = await gpFetch(`${GP_API}/orders?job_id=${encodeURIComponent(jobId)}&page=${page}&limit=${PAGE_SIZE}`, token);
    } catch (e) {
      if (String(e).includes("GotPhoto 404")) break;
      throw e;
    }
    if (expected === null) {
      const tc = resp.headers.get("x-total-count");
      if (tc) expected = parseInt(tc, 10);
    }
    const body = await resp.json();
    const arr = Array.isArray(body) ? body : body.data ?? [];
    out.push(...arr);
    if (arr.length < PAGE_SIZE) break;
  }
  if (expected !== null && !Number.isNaN(expected) && out.length < expected) {
    throw new Error(`incomplete order pull: got ${out.length} of ${expected}`);
  }
  return out;
}

async function login(): Promise<string> {
  const resp = await fetch(GP_AUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      username: Deno.env.get("GP_USERNAME"), password: Deno.env.get("GP_PASSWORD"),
      client_id: Deno.env.get("GP_CLIENT_ID"), client_secret: Deno.env.get("GP_CLIENT_SECRET"),
      scope: Deno.env.get("GP_SCOPE"),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`GotPhoto auth failed: ${resp.status}`);
  return (await resp.json()).access_token;
}

function orderJob(o: any): string | null {
  for (const k of ["job_id", "jobId"]) if (o?.[k] != null) return String(o[k]);
  const j = o?.job;
  if (j && typeof j === "object" && j.id != null) return String(j.id);
  if (typeof j === "string" || typeof j === "number") return String(j);
  return null;
}

function moneyOf(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? parseFloat(v) : null;
  if (typeof v === "object") {
    for (const k of ["amount", "value", "net", "gross"]) {
      const n = moneyOf((v as any)[k]);
      if (n !== null) return n;
    }
  }
  return null;
}

// Field names, types and numbers only: no names, emails or addresses leave the function.
function shape(o: any, prefix = "", depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = prefix + k;
    if (v === null || typeof v === "boolean" || typeof v === "number") out[key] = v;
    else if (typeof v === "string") out[key] = /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? v : (k === "status" || k === "currency" ? v : `string(${v.length})`);
    else if (Array.isArray(v)) out[key] = `array(${v.length})`;
    else if (typeof v === "object" && depth < 1) Object.assign(out, shape(v, key + ".", depth + 1));
    else out[key] = "object";
  }
  return out;
}

Deno.serve(async (req) => {
  if (!secretMatches(req.headers.get("x-sync-secret"))) return new Response("forbidden", { status: 403 });
  const url = new URL(req.url);
  const t0 = Date.now();

  const { data: settings } = await sb.from("results_settings").select("*").eq("id", true).single();
  const skip = new Set<string>((settings?.gp_skip_statuses ?? []).map((s: string) => s.toLowerCase()));
  let field: string | null = settings?.gp_amount_field ?? null;

  try {
    const token = await login();

    const probe = url.searchParams.get("probe");
    if (probe) {
      const orders = await jobOrders(probe, token);
      return Response.json({
        ok: true, job: probe, orders: orders.length,
        jobs_seen: [...new Set(orders.map(orderJob))].slice(0, 5),
        sample: orders.slice(0, 3).map((o) => shape(o)),
      });
    }

    const { data: queue, error: qErr } = await sb.rpc("results_sales_queue", { p_limit: 300 });
    if (qErr) throw new Error(`queue: ${qErr.message}`);
    let done = 0;
    const errors: Record<string, string> = {};
    for (const row of (queue ?? []) as string[]) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break;
      const jobId = String(row);
      try {
        const orders = await jobOrders(jobId, token);
        if (orders.length) {
          const jobs = orders.map(orderJob);
          if (jobs.every((j) => j === null)) throw new Error("orders do not say which job they belong to");
          // GotPhoto ignored the filter: stop the whole run rather than count every order on every job.
          if (jobs.some((j) => j !== null && j !== jobId)) {
            throw Object.assign(new Error("GotPhoto returned orders for other jobs; the job filter is not working"), { fatal: true });
          }
          if (!field) field = AMOUNT_KEYS.find((k) => moneyOf(orders[0]?.[k]) !== null) ?? null;
          if (!field) throw new Error(`no amount field found (fields: ${Object.keys(orders[0] ?? {}).join(", ")})`);
        }
        const cents = !!settings?.gp_amount_cents || /_cents$/.test(field ?? "");
        let sales = 0, count = 0;
        for (const o of orders) {
          if (typeof o?.status === "string" && skip.has(o.status.toLowerCase())) continue;
          const n = moneyOf(o?.[field!]);
          if (n === null) continue;
          sales += cents ? n / 100 : n;
          count += 1;
        }
        const { error } = await sb.from("job_results").update({
          gp_sales: Math.round(sales * 100) / 100, gp_orders: count, gp_synced_at: new Date().toISOString(), gp_error: null,
        }).eq("gotphoto_job_id", jobId);
        if (error) throw new Error(error.message);
        done += 1;
      } catch (e) {
        errors[jobId] = String((e as Error).message ?? e);
        // Leave the last good numbers; note the error and try again on the next 6-hour round.
        await sb.from("job_results").update({ gp_error: errors[jobId].slice(0, 300), gp_synced_at: new Date().toISOString() })
          .eq("gotphoto_job_id", jobId);
        if ((e as any).fatal) throw e;
      }
    }
    const ok = Object.keys(errors).length === 0;
    await sb.from("results_settings").update({
      gp_field_used: field, last_run_at: new Date().toISOString(), last_run_ok: ok, last_run_jobs: done,
      last_run_error: ok ? null : `${Object.keys(errors).length} job(s) failed, e.g. ${Object.values(errors)[0]}`.slice(0, 500),
    }).eq("id", true);
    return Response.json({ ok, jobs: done, left: Math.max(0, (queue ?? []).length - done), errors });
  } catch (e) {
    await sb.from("results_settings").update({
      last_run_at: new Date().toISOString(), last_run_ok: false, last_run_error: String((e as Error).message ?? e).slice(0, 500),
    }).eq("id", true);
    console.error("gotphoto-sales:", String(e));
    return Response.json({ ok: false, error: "Sales pull failed; see Season results." }, { status: 500 });
  }
});
