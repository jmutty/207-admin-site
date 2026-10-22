-- Tests for 20261022213000_season_results. Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/season_results_test.sql
-- "ALL SEASON RESULTS TESTS PASSED" at the end means every check held.

begin;

create function pg_temp.act(p_uid uuid, p_aal text default 'aal2') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', case when p_uid is null then '{"role":"anon"}'
    else json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal, 'session_id', '00000000-0000-0000-0000-0000000000' || right(p_uid::text, 2))::text end, true);
  execute case when p_uid is null then 'set local role anon' else 'set local role authenticated' end;
end $$;
create function pg_temp.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok  %', p_what;
end $$;
create function pg_temp.raises(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok  % (refused: %)', p_what, sqlerrm; return; end;
  raise exception 'FAILED: % (was allowed)', p_what;
end $$;
-- one job out of results_jobs()
create function pg_temp.job(p_id text) returns jsonb language sql as $$
  select j from jsonb_array_elements(public.results_jobs()) j where j ->> 'id' = p_id
$$;
grant execute on all functions in schema pg_temp to anon, authenticated;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'), ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000c1', 'View One', true),
  ('00000000-0000-0000-0000-0000000000d1', 'No Results', true);
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'results', 'edit'), ('00000000-0000-0000-0000-0000000000c1', 'results', 'view');

insert into public.prospect_orgs (id, name, gotphoto_names) values
  ('00000000-0000-0000-0000-00000000a0a1', 'Brewer Youth Basketball', '{"BYB Travel"}'),
  ('00000000-0000-0000-0000-00000000a0a2', 'Hampden Recreation', '{}');
insert into public.synced_jobs (gotphoto_job_id, name, job_type, status, shoot_at, gp_activated_at, gp_modified_at) values
  ('rt1', 'BYB Travel | Winter 2026',      'sport_other', 'published', '2026-01-17 00:00+01', '2026-01-25', '2026-01-25'),
  ('rt2', 'Brewer Youth Basketball | 2025', 'sport_other', 'archived', '2025-01-11 00:00+01', '2025-01-20', '2025-04-01'),
  ('rt3', 'Hampden | Fall Soccer',          'sport_soccer', 'published', '2025-10-04 00:00+02', '2025-10-12', '2025-10-12'),
  ('rt4', 'Holiday Minis',                  'studio_other', 'published', '2025-12-06 00:00+01', '2025-12-10', '2025-12-10'),
  ('rt5', 'Not selling yet',                'sport_other', 'created',   '2026-11-01 00:00+01', null, null);
insert into public.bookings (org_id, type_key, picture_day, status, gotphoto_job_id) values
  ('00000000-0000-0000-0000-00000000a0a2', 'sports_data', '2025-10-05', 'tracked', 'rt3');

select pg_temp.ok((select status from public.app_modules where key = 'results') = 'live', 'results module is live');

-- ---------------------------------------------------------------- v1: view only
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(jsonb_array_length(public.results_jobs()) = 4, 'v1: every job that went on sale, and only those');
select pg_temp.ok(pg_temp.job('rt1') ->> 'org_name' = 'Brewer Youth Basketball', 'org: matched by GotPhoto name');
select pg_temp.ok(pg_temp.job('rt2') ->> 'org_name' = 'Brewer Youth Basketball', 'org: matched by own name');
select pg_temp.ok(pg_temp.job('rt3') ->> 'org_name' = 'Hampden Recreation', 'org: from the booking');
select pg_temp.ok(pg_temp.job('rt3') ->> 'picture_day' = '2025-10-05', 'picture day: the booking''s');
select pg_temp.ok(pg_temp.job('rt4') ->> 'org_id' is null, 'org: none when nothing matches');
select pg_temp.ok(pg_temp.job('rt1') ->> 'season' = 'winter' and (pg_temp.job('rt1') ->> 'season_year')::int = 2026, 'season: January is winter of that year');
select pg_temp.ok(pg_temp.job('rt4') ->> 'season' = 'winter' and (pg_temp.job('rt4') ->> 'season_year')::int = 2026, 'season: December counts toward next year''s winter');
select pg_temp.ok(pg_temp.job('rt3') ->> 'season' = 'fall' and (pg_temp.job('rt3') ->> 'season_year')::int = 2025, 'season: October is fall');
select pg_temp.ok(pg_temp.job('rt1') ->> 'state' = 'none', 'no terms, no sales: nothing owed');
select pg_temp.ok((select count(*) from public.job_results) = 4, 'v1: can read the table');
select pg_temp.raises($$select public.results_save('rt1', '{"manual_sales": 5}')$$, 'v1: cannot type in sales');
select pg_temp.raises($$select public.results_pay('{rt1}', current_date)$$, 'v1: cannot record payments');
select pg_temp.raises($$select public.results_set_terms('00000000-0000-0000-0000-00000000a0a1', 10)$$, 'v1: cannot set terms');
select pg_temp.raises($$update public.job_results set manual_sales = 1$$, 'v1: no direct writes');
select pg_temp.ok((select count(*) from public.job_payments) = 0, 'v1: payments readable (none yet)');

-- ---------------------------------------------------------------- n1: no access
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.results_jobs()$$, 'n1: cannot list');
select pg_temp.ok((select count(*) from public.job_results) = 0, 'n1: table reads empty');
select pg_temp.ok((select count(*) from public.job_results_calc) = 0, 'n1: view reads empty');
select pg_temp.ok(public.results_partners() is null, 'n1: no partners');
select pg_temp.ok(public.results_attention() is null, 'n1: no Today line');

-- ---------------------------------------------------------------- the sales pull (service role)
reset role;
select pg_temp.ok((select count(*) from public.results_sales_queue(50)) = 4, 'queue: every unread job');
update public.job_results set gp_sales = 1000, gp_orders = 40, gp_synced_at = now() where gotphoto_job_id = 'rt1';
update public.job_results set gp_synced_at = now() - interval '7 hours' where gotphoto_job_id = 'rt3';
update public.job_results set gp_synced_at = now() where gotphoto_job_id = 'rt2';
select pg_temp.ok('rt3' in (select public.results_sales_queue(50)), 'queue: selling job read 7 hours ago');
select pg_temp.ok('rt1' not in (select public.results_sales_queue(50)), 'queue: not a job read just now');
select pg_temp.ok('rt2' not in (select public.results_sales_queue(50)), 'queue: not an archived job read after it changed');
update public.job_results set gp_error = 'GotPhoto 500', gp_synced_at = now() - interval '7 hours' where gotphoto_job_id = 'rt2';
select pg_temp.ok('rt2' in (select public.results_sales_queue(50)), 'queue: a failed archived job is tried again');
update public.job_results set gp_error = null, gp_synced_at = now() where gotphoto_job_id = 'rt2';

-- ---------------------------------------------------------------- e1: edit
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(jsonb_array_length(public.results_partners()) = 2, 'e1: partners include orgs with jobs here');
select public.results_set_terms('00000000-0000-0000-0000-00000000a0a1', 10, 'Partner Plan');
select pg_temp.ok((pg_temp.job('rt1') ->> 'due')::numeric = 100, 'terms: 10% of $1,000 is $100');
select pg_temp.ok(pg_temp.job('rt1') ->> 'state' = 'owed' and pg_temp.job('rt1') ->> 'pct_source' = 'partner', 'terms: owed, from the partner');
select pg_temp.ok(pg_temp.job('rt2') ->> 'state' = 'waiting', 'terms: no sales yet is waiting, not owed');

select public.results_pay('{rt1,rt2}', '2026-03-01', 'Check', '1042');
select pg_temp.ok(pg_temp.job('rt1') ->> 'state' = 'paid' and (pg_temp.job('rt1') ->> 'paid')::numeric = 100, 'pay: what was owed');
select pg_temp.ok((select count(*) from public.job_payments) = 1, 'pay: nothing recorded for a job with nothing owed');
select pg_temp.ok(public.results_payments('rt1') -> 0 ->> 'ref' = '1042', 'pay: history keeps the check number');

reset role;
update public.job_results set gp_sales = 1200 where gotphoto_job_id = 'rt1';
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(pg_temp.job('rt1') ->> 'state' = 'owed' and (pg_temp.job('rt1') ->> 'balance')::numeric = 20, 'late orders: owed the difference');
select public.results_pay('{rt1}', '2026-04-01', 'Check', '1050', 5);
select pg_temp.ok((pg_temp.job('rt1') ->> 'balance')::numeric = 15, 'partial payment');
select pg_temp.raises($$select public.results_pay('{rt1,rt2}', current_date, '', '', 5)$$, 'an amount is for one job only');
select pg_temp.raises($$select public.results_pay('{rt1}', null)$$, 'a payment needs a date');
select public.results_payment_remove((select max(id) from public.job_payments));
select pg_temp.ok((pg_temp.job('rt1') ->> 'balance')::numeric = 20, 'undo a payment');

select public.results_save('rt1', '{"manual_sales": 1500, "manual_orders": 55}');
select pg_temp.ok((pg_temp.job('rt1') ->> 'sales')::numeric = 1500 and (pg_temp.job('rt1') ->> 'orders')::int = 55, 'typed sales win over GotPhoto');
select public.results_save('rt1', '{"manual_sales": null, "manual_orders": null, "payout_pct": 15}');
select pg_temp.ok((pg_temp.job('rt1') ->> 'due')::numeric = 180 and pg_temp.job('rt1') ->> 'pct_source' = 'job', 'a job''s own percent wins over the terms');
select public.results_save('rt1', '{"payout_pct": null, "payout_amount": 250}');
select pg_temp.ok((pg_temp.job('rt1') ->> 'due')::numeric = 250, 'a fixed amount wins over percent');
select public.results_save('rt1', '{"payout_amount": null}');

select public.results_save('rt4', '{"org_id": "00000000-0000-0000-0000-00000000a0a2"}');
select pg_temp.ok(pg_temp.job('rt4') ->> 'org_name' = 'Hampden Recreation', 'org: picked by hand');
reset role; select public.results_refresh_internal(); select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(pg_temp.job('rt4') ->> 'org_name' = 'Hampden Recreation', 'org: refresh keeps a hand pick');
select public.results_save('rt4', '{"org_auto": true}');
select pg_temp.ok(pg_temp.job('rt4') ->> 'org_id' is null, 'org: back to matching');

select pg_temp.ok((public.results_attention() ->> 'owed')::int = 1 and (public.results_attention() ->> 'total')::numeric = 20, 'Today: owed more than 30 days after picture day');
select public.results_set_terms('00000000-0000-0000-0000-00000000a0a1', null);
select pg_temp.ok(pg_temp.job('rt1') ->> 'pct_source' = 'none', 'terms removed');
select pg_temp.ok(pg_temp.job('rt1') ->> 'state' = 'paid', 'paid more than now owed still reads paid');

-- ---------------------------------------------------------------- anon
select pg_temp.act(null);
select pg_temp.raises($$select public.results_jobs()$$, 'anon: cannot list');
select pg_temp.raises($$select * from public.job_results$$, 'anon: no table access');

reset role;
do $$ begin raise notice 'ALL SEASON RESULTS TESTS PASSED'; end $$;
rollback;
