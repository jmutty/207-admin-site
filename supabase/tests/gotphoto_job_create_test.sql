-- Tests for 20261024150000_gotphoto_job_create. Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/gotphoto_job_create_test.sql
-- "ALL GOTPHOTO JOB CREATE TESTS PASSED" at the end means every check held.

begin;

create function pg_temp.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok  %', p_what;
end $$;

-- Organizations: A has an old job of its own, B has none, C already has a lookalike job in the sync.
insert into public.prospect_orgs (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Gpc Test Hockey A'),
  ('00000000-0000-0000-0000-0000000000a2', 'Gpc Test Club B'),
  ('00000000-0000-0000-0000-0000000000a3', 'Gpc Test Rec C');
insert into public.synced_jobs (gotphoto_job_id, name, internal_name, job_type, access_type, status, shoot_at) values
  ('gpc-old-a', 'Gpc Test Hockey A | Hockey | 25-26', 'JOB90001', 'sport_other', 'single_password', 'archived', now() - interval '300 days'),
  ('gpc-tpl', 'Gpc Template | Winter | 2026', 'JOB90002', 'sport_other', 'qr_tagging', 'created', now() + interval '40 days'),
  ('gpc-look-c', 'Gpc Test Rec C | Winter | 2026', 'JOB90003', 'sport_other', 'qr_tagging', 'created', now() + interval '42 days');
-- The template counts because a sports_data booking links to it.
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, status, gotphoto_job_id, created_at) values
  ('00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-0000000000a2', 'sports_data', 'Winter', (now() + interval '40 days')::date,
   now() + interval '40 days', now() + interval '40 days 2 hours', 'tracked', 'gpc-tpl', now() - interval '1 day');
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, status, created_at) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'sports_data', 'Winter', (now() + interval '41 days')::date,
   now() + interval '41 days', now() + interval '41 days 2 hours', 'booked', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'sports_data', 'Spring', (now() + interval '42 days')::date,
   now() + interval '42 days', now() + interval '42 days 2 hours', 'booked', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a3', 'sports_data', 'Winter', (now() + interval '43 days')::date,
   now() + interval '43 days', now() + interval '43 days 2 hours', 'booked', now() - interval '1 hour');

update public.gp_create_settings set auto_enabled = false;
select pg_temp.ok(public.gp_create_queue() = '[]'::jsonb, 'off: the cron makes nothing');
select pg_temp.ok(jsonb_array_length(public.gp_create_queue(null, 50, true)) >= 1, 'off: the dry run still lists');

update public.gp_create_settings set auto_enabled = true;
create temp table q as select e from jsonb_array_elements(public.gp_create_queue(null, 50)) e
 where e->>'booking_id' like '00000000-0000-0000-0000-0000000000b%';
select pg_temp.ok((select count(*) from q) = 1, 'on: only A (B booked a minute ago, C has a lookalike job)');
select pg_temp.ok((select e->>'job_name' from q) = 'Gpc Test Hockey A | Winter | ' || extract(year from now() + interval '41 days')::int, 'name: Org | Title | year');
select pg_temp.ok((select e->>'template_job_id' from q) = 'gpc-tpl', 'settings come from the newest job of the same type');
select pg_temp.ok((select e->>'org_job_id' from q) = 'gpc-old-a', 'organization comes from its own last job');
select pg_temp.ok((select substring(e->>'internal_name' from 4)::int from q) > 90003, 'internal number is past the highest JOB number');

-- B on the button: no grace period, no organization job.
create temp table qb as select e from jsonb_array_elements(public.gp_create_queue('00000000-0000-0000-0000-0000000000b2')) e;
select pg_temp.ok((select count(*) from qb) = 1 and (select e->>'org_job_id' from qb) is null and (select (e->>'manual')::boolean from qb), 'button: makes B now, no organization job');

-- Claim: once, not twice.
select pg_temp.ok(public.gp_create_claim((select e from q)), 'claim A');
select pg_temp.ok(not public.gp_create_claim((select e from q)), 'a second claim is refused');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.gp_create_queue(null, 50)) e where e->>'booking_id' = '00000000-0000-0000-0000-0000000000b1'), 'a claimed booking leaves the list');

-- Failure with retry: back on the list after the wait, not before; three strikes and the cron stops.
select public.gp_create_done('00000000-0000-0000-0000-0000000000b1', null, 'GotPhoto said 500', true);
select pg_temp.ok((select status from public.gp_job_creates where booking_id = '00000000-0000-0000-0000-0000000000b1') = 'failed', 'failed is recorded');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.gp_create_queue(null, 50)) e where e->>'booking_id' = '00000000-0000-0000-0000-0000000000b1'), 'waits before trying again');
update public.gp_job_creates set next_try_at = now() - interval '1 minute' where booking_id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok(exists (select 1 from jsonb_array_elements(public.gp_create_queue(null, 50)) e where e->>'booking_id' = '00000000-0000-0000-0000-0000000000b1'), 'then tries again');
select public.gp_create_claim((select e from q));
select public.gp_create_done('00000000-0000-0000-0000-0000000000b1', null, 'no answer', false);
update public.gp_job_creates set next_try_at = now() - interval '1 minute' where booking_id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.gp_create_queue(null, 50)) e where e->>'booking_id' = '00000000-0000-0000-0000-0000000000b1'), 'no answer: the cron does not try again by itself');
select pg_temp.ok(jsonb_array_length(public.gp_create_queue('00000000-0000-0000-0000-0000000000b1')) = 1, 'the button still can');

-- Made: links once the sync has the job.
select public.gp_create_claim((select e from q));
select public.gp_create_done('00000000-0000-0000-0000-0000000000b1', 'gpc-new-a', null, false);
select public.gp_create_link();
select pg_temp.ok((select gotphoto_job_id from public.bookings where id = '00000000-0000-0000-0000-0000000000b1') is null, 'not linked before the sync sees it');
insert into public.synced_jobs (gotphoto_job_id, name, internal_name, job_type, access_type, status, shoot_at)
values ('gpc-new-a', 'Gpc Test Hockey A | Winter | 2027', 'JOB90004', 'sport_other', 'single_password', 'created', now() + interval '41 days');
select public.gp_create_link();
select pg_temp.ok((select gotphoto_job_id from public.bookings where id = '00000000-0000-0000-0000-0000000000b1') = 'gpc-new-a', 'linked once synced');
select pg_temp.ok((select status from public.gp_job_creates where booking_id = '00000000-0000-0000-0000-0000000000b1') = 'linked', 'row says linked');
select pg_temp.ok(not public.gp_create_claim((select e from q)), 'a linked booking cannot be claimed again');

select 'ALL GOTPHOTO JOB CREATE TESTS PASSED';
rollback;
