-- Tests for 20261024120500_rebook_per_season. Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/rebook_per_season_test.sql
-- "ALL REBOOK PER SEASON TESTS PASSED" at the end means every check held.

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
grant execute on all functions in schema pg_temp to anon, authenticated;
create temp table t (k text primary key, v text);
grant all on t to anon, authenticated;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e1', 'p1@example.com');
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000e1', 'Partners Edit', true);
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'partners', 'edit');

-- F: a school with winter sports last year (day -320, makeup -310) and a fall picture day this year (-40, retakes -25).
--    The old list only knew the fall date, so winter never came back.
-- G: the same, but winter is already booked for this year (+50), and last year's spring job (-250) isn't.
-- H: winter last year only in GotPhoto (a day early), on the calendar a day later.
insert into public.prospect_orgs (id, name, stage, last_job_at, cal_dates, gotphoto_names) values
  ('00000000-0000-0000-0000-00000000001f', 'Winter High', 'client', current_date - 25,
     array[current_date - 320, current_date - 310, current_date - 40, current_date - 25]::date[], '{}'),
  ('00000000-0000-0000-0000-00000000002f', 'Booked Middle', 'client', current_date - 40,
     array[current_date - 315, current_date - 250, current_date - 40]::date[], '{}'),
  ('00000000-0000-0000-0000-00000000003f', 'GotPhoto Rec', 'client', null,
     array[current_date - 300]::date[], '{"GotPhoto Rec"}');
insert into public.prospect_contacts (id, org_id, first_name, email, is_primary) values
  ('00000000-0000-0000-0000-0000000001cf', '00000000-0000-0000-0000-00000000001f', 'Ann', 'ann@winter.org', true);
insert into public.bookings (id, org_id, type_key, picture_day, status) values
  ('00000000-0000-0000-0000-0000000002b0', '00000000-0000-0000-0000-00000000002f', 'school', current_date + 50, 'booked');
insert into public.synced_jobs (gotphoto_job_id, name, job_type, access_type, status, shoot_at) values
  ('test-rebook-h', 'GotPhoto Rec | Basketball | 25-26', 'sport_other', 'code', 'published', ((current_date - 301)::timestamp at time zone 'America/New_York'));

select pg_temp.ok((select count(*) from public.partner_rebook_rows('00000000-0000-0000-0000-00000000001f')) = 2, 'F: two seasons, two rows');
select pg_temp.ok((select picture_day from public.partner_rebook_rows('00000000-0000-0000-0000-00000000001f') order by due_on limit 1) = current_date - 320,
                  'F: winter row starts on its picture day, not the makeup');
select pg_temp.ok((select picture_day from public.partner_rebook_rows('00000000-0000-0000-0000-00000000001f') order by due_on desc limit 1) = current_date - 40,
                  'F: fall picture day and retakes are one row');
select pg_temp.ok((select booked from public.partner_rebook_rows('00000000-0000-0000-0000-00000000002f') where picture_day = current_date - 315),
                  'G: a booking near this year''s date takes winter off');
select pg_temp.ok(not (select booked from public.partner_rebook_rows('00000000-0000-0000-0000-00000000002f') where picture_day = current_date - 250),
                  'G: booking winter does not hide spring');
select pg_temp.ok((select picture_day from public.partner_rebook_rows('00000000-0000-0000-0000-00000000003f')) = current_date - 300
                  and (select jobs from public.partner_rebook_rows('00000000-0000-0000-0000-00000000003f')) = 'Basketball',
                  'H: calendar date wins over GotPhoto''s, GotPhoto names the job');

select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
insert into t select 'list', public.partner_rebook_list()::text;
select pg_temp.ok(exists (select 1 from jsonb_array_elements((select v from t where k = 'list')::jsonb) x
                           where x ->> 'org_id' = '00000000-0000-0000-0000-00000000001f' and (x ->> 'open')::boolean
                             and (x ->> 'last_date')::date = current_date - 320
                             and (x ->> 'days')::int = (current_date - 320 + interval '1 year')::date - current_date),
                  'F: winter is on the list, due about 45 days out');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements((select v from t where k = 'list')::jsonb) x
                               where x ->> 'org_id' = '00000000-0000-0000-0000-00000000002f' and (x ->> 'last_date')::date = current_date - 315),
                  'G: booked winter is left out');
select pg_temp.ok(exists (select 1 from jsonb_array_elements((select v from t where k = 'list')::jsonb) x
                           where x ->> 'org_id' = '00000000-0000-0000-0000-00000000002f' and (x ->> 'last_date')::date = current_date - 250 and not (x ->> 'open')::boolean),
                  'G: spring is listed (coming up)');

insert into t select 'fdue', (current_date - 320 + interval '1 year')::date::text;
insert into t select 'rc', public.partner_compose('rebook', '00000000-0000-0000-0000-00000000001f', null, (select v from t where k = 'fdue')::date)::text;
select pg_temp.ok((select v from t where k = 'rc')::jsonb ->> 'due_on' = (select v from t where k = 'fdue'), 'compose: the winter row');
select pg_temp.ok(strpos((select v from t where k = 'rc')::jsonb ->> 'body', public.partner_fmt_day(current_date - 320)) > 0, 'compose: names last winter''s date');
insert into t select 'rc0', public.partner_compose('rebook', '00000000-0000-0000-0000-00000000001f')::text;
select pg_temp.ok((select v from t where k = 'rc0')::jsonb ->> 'due_on' = (select v from t where k = 'fdue'), 'compose without a date: the next open row');
select public.partner_queue('rebook', '00000000-0000-0000-0000-00000000001f', '00000000-0000-0000-0000-0000000001cf',
  (select v from t where k = 'rc')::jsonb ->> 'subject', (select v from t where k = 'rc')::jsonb ->> 'body', false, (select v from t where k = 'fdue')::date);
select pg_temp.ok((select status from public.partner_rebook where org_id = '00000000-0000-0000-0000-00000000001f' and due_on = (select v from t where k = 'fdue')::date) = 'emailed',
                  'queue: marks the winter row emailed');
select pg_temp.ok((select count(*) from public.partner_rebook where org_id = '00000000-0000-0000-0000-00000000001f') = 1, 'queue: leaves the fall row alone');

select 'ALL REBOOK PER SEASON TESTS PASSED';
rollback;
