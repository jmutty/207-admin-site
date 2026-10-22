-- Season results and partner payouts (2026-10-22).
--
--   job_results      one row per GotPhoto job that has gone on sale. Sales and orders come from GotPhoto
--                    (gp_*, written by the gotphoto-sales edge function) or are typed in (manual_*, which
--                    wins). The job's name, type, picture day and organization are copied here so the
--                    numbers survive the job being deleted in GotPhoto, and so people who can see Results
--                    but not Galleries or Organizations still see whose job it was.
--   partner_terms    what each organization gets back: a percent of sales (Partner Plan = 10).
--                    A job can override the percent, or the amount outright.
--   job_payments     each payment made to a partner for a job. Paid = the sum; a late order that raises
--                    the share makes the job owed again for the difference.
--   results_settings how the sales pull reads GotPhoto's orders, and how its last run went.
--
-- Season: winter = Dec-Feb (December counts toward the next year: Dec 2025 is Winter 2026),
-- spring = Mar-May, summer = Jun-Jul, fall = Aug-Nov, by the job's picture day.
--
-- Access is the `results` module: view = see sales and payouts; edit = type in sales, set partner
-- terms and record payments. Nothing here sends email.

insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('results', 'Season results', 'Jobs',
        'Sales per job from GotPhoto, what each partner is owed and has been paid, and each season against last year. View = see the numbers; Edit = type in sales, set partner terms and record payments.',
        35, 'live', false)
on conflict (key) do update set label = excluded.label, section = excluded.section, description = excluded.description,
                                sort = excluded.sort, status = 'live';

-- ---------------------------------------------------------------- tables
create table public.partner_terms (
  org_id     uuid primary key references public.prospect_orgs (id) on delete cascade,
  payout_pct numeric(5,2) not null default 0 check (payout_pct >= 0 and payout_pct <= 100),
  note       text not null default '' check (length(note) <= 500),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.partner_terms is 'Each partner''s share of sales (percent). Jobs of organizations without a row pay nothing unless the job sets its own.';

create table public.job_results (
  gotphoto_job_id text primary key,
  job_name        text not null default '',
  job_type        text,
  booking_type    text,
  gallery_status  text,
  picture_day     date,
  org_id          uuid references public.prospect_orgs (id) on delete set null,
  org_set         boolean not null default false,
  gp_sales        numeric(12,2),
  gp_orders       int,
  gp_synced_at    timestamptz,
  gp_error        text,
  manual_sales    numeric(12,2) check (manual_sales >= 0),
  manual_orders   int check (manual_orders >= 0),
  payout_pct      numeric(5,2) check (payout_pct >= 0 and payout_pct <= 100),
  payout_amount   numeric(12,2) check (payout_amount >= 0),
  note            text not null default '' check (length(note) <= 1000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
comment on table public.job_results is 'Sales and partner payout per GotPhoto job. manual_* overrides gp_*; payout_pct overrides the partner''s terms; payout_amount overrides both. org_set = organization chosen by hand (refresh leaves it).';
comment on column public.job_results.gp_sales is 'Sales before tax from GotPhoto orders, written by the gotphoto-sales edge function.';
create index job_results_org_idx on public.job_results (org_id);
create index job_results_day_idx on public.job_results (picture_day);

create table public.job_payments (
  id              bigint generated always as identity primary key,
  gotphoto_job_id text not null references public.job_results (gotphoto_job_id) on delete cascade,
  amount          numeric(12,2) not null check (amount > 0),
  paid_on         date not null,
  method          text not null default '' check (length(method) <= 40),
  ref             text not null default '' check (length(ref) <= 80),
  created_at      timestamptz not null default now(),
  created_by      uuid
);
comment on table public.job_payments is 'Payments to partners, one row per job per payment. Written only by results_pay / results_payment_remove.';
create index job_payments_job_idx on public.job_payments (gotphoto_job_id);

create table public.results_settings (
  id               boolean primary key default true check (id),
  gp_amount_field  text,
  gp_amount_cents  boolean not null default false,
  gp_skip_statuses text[] not null default '{cancelled,canceled,refunded,failed,aborted,expired,unpaid,pending_payment}',
  gp_field_used    text,
  last_run_at      timestamptz,
  last_run_ok      boolean,
  last_run_error   text,
  last_run_jobs    int
);
comment on table public.results_settings is 'gp_amount_field: which order field is the sale amount (null = the first of total_net, net_total, subtotal, total, ... that GotPhoto sends). gp_amount_cents: amounts are in cents.';
insert into public.results_settings (id) values (true);

-- Stamp who changed a row and when.
create function public.results_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce((select auth.uid()), new.updated_by);
  return new;
end $$;
create trigger partner_terms_touch before insert or update on public.partner_terms for each row execute function public.results_touch();

-- ---------------------------------------------------------------- access
alter table public.partner_terms    enable row level security;
alter table public.job_results      enable row level security;
alter table public.job_payments     enable row level security;
alter table public.results_settings enable row level security;
revoke all on public.partner_terms, public.job_results, public.job_payments, public.results_settings from anon, authenticated;
grant select on public.partner_terms, public.job_results, public.job_payments, public.results_settings to authenticated;
create policy partner_terms_read    on public.partner_terms    for select to authenticated using ((select public.can('results', 'view')));
create policy job_results_read      on public.job_results      for select to authenticated using ((select public.can('results', 'view')));
create policy job_payments_read     on public.job_payments     for select to authenticated using ((select public.can('results', 'view')));
create policy results_settings_read on public.results_settings for select to authenticated using ((select public.can('results', 'view')));

-- ---------------------------------------------------------------- season
create function public.results_season(d date) returns text
language sql immutable set search_path = '' as $$
  select case when d is null then null
              when extract(month from d) in (12, 1, 2) then 'winter'
              when extract(month from d) in (3, 4, 5) then 'spring'
              when extract(month from d) in (6, 7) then 'summer'
              else 'fall' end
$$;
create function public.results_season_year(d date) returns int
language sql immutable set search_path = '' as $$
  select extract(year from d)::int + case when extract(month from d) = 12 then 1 else 0 end
$$;

-- Effective numbers per job (RLS of the tables applies).
create view public.job_results_calc with (security_invoker = true) as
with base as (
  select r.*,
         coalesce(r.manual_sales, r.gp_sales) as sales,
         coalesce(r.manual_orders, r.gp_orders) as orders,
         coalesce(r.payout_pct, t.payout_pct, 0) as pct,
         case when r.payout_pct is not null then 'job' when t.org_id is not null then 'partner' else 'none' end as pct_source,
         coalesce(p.paid, 0) as paid, p.last_paid_on
    from public.job_results r
    left join public.partner_terms t on t.org_id = r.org_id
    left join (select gotphoto_job_id, sum(amount) as paid, max(paid_on) as last_paid_on
                 from public.job_payments group by gotphoto_job_id) p on p.gotphoto_job_id = r.gotphoto_job_id
), due as (
  select b.*, coalesce(b.payout_amount, round(coalesce(b.sales, 0) * b.pct / 100, 2)) as due from base b
)
select d.*,
       greatest(d.due - d.paid, 0) as balance,
       case when d.sales is null and d.payout_amount is null and d.pct > 0 and d.paid = 0 then 'waiting'
            when d.due <= 0 and d.paid = 0 then 'none'
            when d.paid >= d.due - 0.005 then 'paid'
            else 'owed' end as payout_state,
       public.results_season(d.picture_day) as season,
       public.results_season_year(d.picture_day) as season_year
  from due d;
revoke all on public.job_results_calc from anon, authenticated;
grant select on public.job_results_calc to authenticated;

-- ---------------------------------------------------------------- refresh
-- New rows for every job that has gone on sale, fresh copies of name / type / picture day, and the
-- organization: a booking's organization first, else the name before the first "|" against each
-- organization's GotPhoto names or own name (same normalising as gotphoto_job_org, done as one join
-- because that function costs ~7 ms a job). Rows whose organization was picked by hand are left alone.
create function public.results_refresh_internal() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_new int; v_upd int; v_org int;
begin
  insert into public.job_results (gotphoto_job_id)
  select j.gotphoto_job_id from public.synced_jobs j where j.gp_activated_at is not null
  on conflict (gotphoto_job_id) do nothing;
  get diagnostics v_new = row_count;

  with bj as (
    select distinct on (x.job) x.job, x.picture_day, x.type_key, x.org_id
      from (select coalesce(b.gotphoto_job_id, public.school_hub_job(b.hub_school_id)) as job, b.picture_day, b.type_key, b.org_id, b.created_at
              from public.bookings b where b.status <> 'cancelled') x
     where x.job is not null
     order by x.job, x.created_at desc
  ), src as (
    select j.gotphoto_job_id, j.name, j.job_type, j.status,
           coalesce(bj.picture_day, (j.shoot_at at time zone 'Europe/Berlin')::date, (j.gp_activated_at at time zone 'America/New_York')::date) as picture_day,
           bj.type_key, bj.org_id as booking_org
      from public.synced_jobs j left join bj on bj.job = j.gotphoto_job_id
  ), names as (
    select o.id, public.hub_norm_name(n) as nn
      from public.prospect_orgs o, unnest(coalesce(o.gotphoto_names, '{}') || o.name) n
  ), guess as (
    select s.gotphoto_job_id, case when count(distinct n.id) = 1 then (array_agg(n.id))[1] end as org_id
      from src s join names n on n.nn = public.hub_norm_name(btrim(split_part(s.name, '|', 1)))
     where public.hub_norm_name(btrim(split_part(s.name, '|', 1))) <> ''
     group by s.gotphoto_job_id
  )
  update public.job_results r
     set job_name = coalesce(s.name, ''), job_type = s.job_type, gallery_status = s.status, picture_day = s.picture_day,
         booking_type = s.type_key,
         org_id = case when r.org_set then r.org_id else coalesce(s.booking_org, g.org_id) end
    from src s left join guess g on g.gotphoto_job_id = s.gotphoto_job_id
   where s.gotphoto_job_id = r.gotphoto_job_id
     and (r.job_name, r.job_type, r.gallery_status, r.picture_day, r.booking_type, r.org_id)
         is distinct from (coalesce(s.name, ''), s.job_type, s.status, s.picture_day, s.type_key,
                           case when r.org_set then r.org_id else coalesce(s.booking_org, g.org_id) end);
  get diagnostics v_upd = row_count;
  return jsonb_build_object('new', v_new, 'updated', v_upd);
end $$;
revoke all on function public.results_refresh_internal() from public, anon, authenticated;
grant execute on function public.results_refresh_internal() to service_role;

-- ---------------------------------------------------------------- read
-- Every job with its numbers, newest picture day first. Small: a couple of hundred jobs a year.
create function public.results_jobs() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('results', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  perform public.results_refresh_internal();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.gotphoto_job_id, 'name', c.job_name, 'job_type', c.job_type, 'booking_type', bt.label,
             'gallery_status', c.gallery_status, 'picture_day', c.picture_day, 'season', c.season, 'season_year', c.season_year,
             'org_id', c.org_id, 'org_name', o.name, 'org_set', c.org_set,
             'gp_sales', c.gp_sales, 'gp_orders', c.gp_orders, 'gp_synced_at', c.gp_synced_at, 'gp_error', c.gp_error,
             'manual_sales', c.manual_sales, 'manual_orders', c.manual_orders, 'sales', c.sales, 'orders', c.orders,
             'pct', c.pct, 'pct_source', c.pct_source, 'payout_pct', c.payout_pct, 'payout_amount', c.payout_amount,
             'due', c.due, 'paid', c.paid, 'last_paid_on', c.last_paid_on, 'balance', c.balance, 'state', c.payout_state,
             'note', c.note)
           order by c.picture_day desc nulls last, c.job_name)
      from public.job_results_calc c
      left join public.prospect_orgs o on o.id = c.org_id
      left join public.booking_types bt on bt.key = c.booking_type), '[]'::jsonb);
end $$;

-- Organizations to pick from (clients, plus any with terms or jobs here) with their terms.
create function public.results_partners() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not public.can('results', 'view') then null else coalesce((
    select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'payout_pct', t.payout_pct, 'note', coalesce(t.note, ''),
                                        'jobs', (select count(*) from public.job_results r where r.org_id = o.id))
                     order by lower(o.name))
      from public.prospect_orgs o
      left join public.partner_terms t on t.org_id = o.id
     where t.org_id is not null or o.client_since is not null or coalesce(o.job_count, 0) > 0
        or exists (select 1 from public.job_results r where r.org_id = o.id)), '[]'::jsonb) end
$$;

-- Payments for one job (the job panel's history).
create function public.results_payments(p_job text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not public.can('results', 'view') then null else coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'paid_on', p.paid_on, 'method', p.method, 'ref', p.ref,
                                        'by', coalesce(m.display_name, '')) order by p.paid_on, p.id)
      from public.job_payments p left join public.team_members m on m.user_id = p.created_by
     where p.gotphoto_job_id = p_job), '[]'::jsonb) end
$$;

-- Today: payouts owed on jobs whose picture day is more than 30 days back.
create function public.results_attention() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not public.can('results', 'view') then null else (
    select jsonb_build_object('owed', count(*), 'total', coalesce(sum(c.balance), 0))
      from public.job_results_calc c
     where c.payout_state = 'owed' and c.picture_day < current_date - 30) end
$$;

-- ---------------------------------------------------------------- write
-- p: any of manual_sales, manual_orders, payout_pct, payout_amount (null clears), note, org_id
-- (null with org_auto = true goes back to matching by name).
create function public.results_save(p_job text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.job_results;
begin
  if not public.can('results', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into r from public.job_results where gotphoto_job_id = p_job for update;
  if not found then raise exception 'No such job.'; end if;
  if p ? 'manual_sales'  then r.manual_sales  := nullif(p ->> 'manual_sales', '')::numeric; end if;
  if p ? 'manual_orders' then r.manual_orders := nullif(p ->> 'manual_orders', '')::int; end if;
  if p ? 'payout_pct'    then r.payout_pct    := nullif(p ->> 'payout_pct', '')::numeric; end if;
  if p ? 'payout_amount' then r.payout_amount := nullif(p ->> 'payout_amount', '')::numeric; end if;
  if p ? 'note'          then r.note          := left(coalesce(p ->> 'note', ''), 1000); end if;
  if coalesce((p ->> 'org_auto')::boolean, false) then
    r.org_set := false; r.org_id := null;
  elsif p ? 'org_id' then
    r.org_id := nullif(p ->> 'org_id', '')::uuid; r.org_set := true;
  end if;
  update public.job_results
     set manual_sales = r.manual_sales, manual_orders = r.manual_orders, payout_pct = r.payout_pct,
         payout_amount = r.payout_amount, note = r.note, org_id = r.org_id, org_set = r.org_set,
         updated_at = now(), updated_by = (select auth.uid())
   where gotphoto_job_id = p_job;
  if coalesce((p ->> 'org_auto')::boolean, false) then perform public.results_refresh_internal(); end if;
  return jsonb_build_object('ok', true);
end $$;

-- A partner's share. p_pct null removes the terms (their jobs then pay nothing unless set per job).
create function public.results_set_terms(p_org uuid, p_pct numeric, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('results', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_pct is null then
    delete from public.partner_terms where org_id = p_org;
  else
    insert into public.partner_terms (org_id, payout_pct, note) values (p_org, p_pct, left(coalesce(p_note, ''), 500))
    on conflict (org_id) do update set payout_pct = excluded.payout_pct, note = excluded.note;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Record a payment: pays what is still owed on each job (one check covering a partner's season is one
-- call). p_amount, only with a single job, records a partial or different amount.
create function public.results_pay(p_jobs text[], p_paid_on date, p_method text default '', p_ref text default '', p_amount numeric default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_n int; v_total numeric;
begin
  if not public.can('results', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_paid_on is null then raise exception 'Pick the date it was paid.'; end if;
  if p_amount is not null and cardinality(p_jobs) <> 1 then raise exception 'An amount can only be given for one job.'; end if;
  if p_amount is not null and p_amount <= 0 then raise exception 'The amount must be more than zero.'; end if;
  with ins as (
    insert into public.job_payments (gotphoto_job_id, amount, paid_on, method, ref, created_by)
    select c.gotphoto_job_id, coalesce(p_amount, c.balance), p_paid_on, left(coalesce(p_method, ''), 40), left(coalesce(p_ref, ''), 80), (select auth.uid())
      from public.job_results_calc c
     where c.gotphoto_job_id = any (p_jobs) and (p_amount is not null or c.balance > 0)
    returning amount)
  select count(*), coalesce(sum(amount), 0) into v_n, v_total from ins;
  return jsonb_build_object('ok', true, 'jobs', v_n, 'total', v_total);
end $$;

create function public.results_payment_remove(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('results', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from public.job_payments where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

revoke all on function public.results_season(date), public.results_season_year(date) from public, anon;
grant execute on function public.results_season(date), public.results_season_year(date) to authenticated, service_role;
revoke all on function public.results_jobs(), public.results_partners(), public.results_payments(text), public.results_attention(),
                       public.results_save(text, jsonb), public.results_set_terms(uuid, numeric, text),
                       public.results_pay(text[], date, text, text, numeric), public.results_payment_remove(bigint) from public, anon;
grant execute on function public.results_jobs(), public.results_partners(), public.results_payments(text), public.results_attention(),
                          public.results_save(text, jsonb), public.results_set_terms(uuid, numeric, text),
                          public.results_pay(text[], date, text, text, numeric), public.results_payment_remove(bigint) to authenticated;

-- ---------------------------------------------------------------- sales pull (gotphoto-sales edge function)
-- Jobs whose sales to (re)read: never read, still selling and not read in 6 hours, archived since
-- the last read, or failed more than 6 hours ago. Newest picture days first, so this season fills in before the history does.
create function public.results_sales_queue(p_limit int default 200) returns setof text
language plpgsql security definer set search_path = '' as $$
begin
  perform public.results_refresh_internal();
  return query
    select r.gotphoto_job_id
      from public.job_results r join public.synced_jobs j on j.gotphoto_job_id = r.gotphoto_job_id
     where r.gp_synced_at is null
        or (j.status <> 'archived' and r.gp_synced_at < now() - interval '6 hours')
        or (j.gp_modified_at is not null and r.gp_synced_at < j.gp_modified_at)
        or (r.gp_error is not null and r.gp_synced_at < now() - interval '6 hours')
     order by r.gp_synced_at nulls first, r.picture_day desc nulls last
     limit p_limit;
end $$;
revoke all on function public.results_sales_queue(int) from public, anon, authenticated;
grant execute on function public.results_sales_queue(int) to service_role;

-- Hourly. The function stops starting new jobs after ~100 s; the next hour carries on.
select cron.schedule('gotphoto-sales-hourly', '41 * * * *', $$
  select net.http_post(
    url := 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/gotphoto-sales?trigger=cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_trigger_secret')
    ),
    timeout_milliseconds := 120000
  );
$$);
