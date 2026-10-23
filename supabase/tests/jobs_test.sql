-- Tests for 20261024040000_jobs_one_screen (crew reach their job, the crew moves with the day). Run against a
-- NON-production copy of the schema after the migration, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/jobs_test.sql
-- "ALL JOBS TESTS PASSED" at the end means every check held.

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
-- a bar's start as New York wall time, e.g. '2026-11-07 09:00'
create function pg_temp.ny(p_id text) returns text language sql as $$
  select to_char(starts_at at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') from public.schedule_entries where id = p_id::uuid $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- a1 owner; c1 on the crew (part time, works from home); p1 offered the job; d1 offered, passed; x1 outsider
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'a1@example.com'), ('00000000-0000-0000-0000-0000000000c1', 'c1@example.com'),
  ('00000000-0000-0000-0000-0000000000f1', 'p1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'd1@example.com'), ('00000000-0000-0000-0000-0000000000e1', 'x1@example.com');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000a1', 'Owner One', true),
  ('00000000-0000-0000-0000-0000000000c1', 'Crew One', true), ('00000000-0000-0000-0000-0000000000f1', 'Pick One', true),
  ('00000000-0000-0000-0000-0000000000d1', 'Pass One', true), ('00000000-0000-0000-0000-0000000000e1', 'Out One', true)
  on conflict (user_id) do update set display_name = excluded.display_name;
update public.team_members set home_address = '5 Elm St, Bangor ME', employment_type = 'part_time' where user_id = '00000000-0000-0000-0000-0000000000c1';
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000c1', 'assignments', 'view');

-- b1: Sat Oct 31 (still daylight time) 9-12; b2 cancelled, same day.
insert into public.prospect_orgs (id, name, town) values ('00000000-0000-0000-0000-00000000aaa1', 'Test Academy', 'Hampden');
insert into public.bookings (id, org_id, type_key, picture_day, start_at, end_at, status, location) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000aaa1', 'school', '2026-10-31', '2026-10-31 09:00 America/New_York', '2026-10-31 12:00 America/New_York', 'booked', '12 Gym Rd, Hampden ME'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000aaa1', 'school', '2026-10-31', '2026-10-31 13:00 America/New_York', '2026-10-31 14:00 America/New_York', 'cancelled', '');
insert into public.booking_days (booking_id, day) values ('00000000-0000-0000-0000-0000000000b1', '2026-10-31'), ('00000000-0000-0000-0000-0000000000b2', '2026-10-31');
insert into public.schedule_entries (id, user_id, booking_id, kind, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'job', '2026-10-31 09:00 America/New_York', '2026-10-31 12:00 America/New_York'),
  -- a bar put by hand on another day stays where it is
  ('00000000-0000-0000-0000-0000000005e2', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'job', '2026-11-02 09:00 America/New_York', '2026-11-02 10:00 America/New_York'),
  ('00000000-0000-0000-0000-0000000005e3', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b2', 'job', '2026-10-31 13:00 America/New_York', '2026-10-31 14:00 America/New_York');
insert into public.job_offers (id, booking_id, status) values ('00000000-0000-0000-0000-00000000f0f1', '00000000-0000-0000-0000-0000000000b1', 'open');
insert into public.job_offer_recipients (offer_id, user_id, answer) values ('00000000-0000-0000-0000-00000000f0f1', '00000000-0000-0000-0000-0000000000f1', null),
  ('00000000-0000-0000-0000-00000000f0f1', '00000000-0000-0000-0000-0000000000d1', 'declined');
-- c1's checklist steps on b1: one late, one due later, one done; and a plain task
insert into public.staff_tasks (id, user_id, title, repeat, due_on, booking_id) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000c1', 'Confirm start time', 'once', current_date - 3, '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000c1', 'Pack the kit', 'once', current_date + 5, '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000c1', 'Charge batteries', 'once', current_date - 1, '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000c1', 'Clean the van', 'once', current_date, null);
insert into public.staff_task_done (task_id, on_date, done_by) values ('00000000-0000-0000-0000-00000000aa03', current_date - 1, '00000000-0000-0000-0000-0000000000c1');
-- the job's checklist steps that the workflow makes on its own for c1 (from the live checklist templates) are switched
-- off here so the counts below see only the three steps above (rolled back with the rest)
update public.staff_tasks set active = false
 where booking_id = '00000000-0000-0000-0000-0000000000b1'
   and id not in ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000aa03');

-- ---------------------------------------------------------------- who may open the job
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(public.job_can_view('00000000-0000-0000-0000-0000000000b1'), 'crew: can open the job');
select pg_temp.ok((public.workflow_job('00000000-0000-0000-0000-0000000000b1') -> 'tasks') is not null, 'crew: reads the job''s checklist');
select pg_temp.act('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok(public.job_can_view('00000000-0000-0000-0000-0000000000b1'), 'offered on Open jobs: can open the job');
select pg_temp.act('00000000-0000-0000-0000-0000000000f1', 'aal1');
select pg_temp.ok(not public.job_can_view('00000000-0000-0000-0000-0000000000b1'), 'offered, without the second sign-in step: cannot');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.ok(not public.job_can_view('00000000-0000-0000-0000-0000000000b1'), 'passed on the offer: cannot open the job');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(not public.job_can_view('00000000-0000-0000-0000-0000000000b1'), 'outsider: cannot open the job');
select pg_temp.raises($$select public.workflow_job('00000000-0000-0000-0000-0000000000b1')$$, 'outsider: no checklist');
reset role;
update public.job_offers set status = 'filled' where id = '00000000-0000-0000-0000-00000000f0f1';
select pg_temp.act('00000000-0000-0000-0000-0000000000f1');
select pg_temp.ok(not public.job_can_view('00000000-0000-0000-0000-0000000000b1'), 'offer filled by others: no longer opens');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok(public.job_can_view('00000000-0000-0000-0000-0000000000b1'), 'owner: can open the job');

-- ---------------------------------------------------------------- My jobs, the Confirm page, My day
reset role;
insert into public.crew_asks (booking_id, user_id, token) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', repeat('t', 40))
  on conflict do nothing;
update public.schedule_entries set starts_at = now() + interval '2 days', ends_at = now() + interval '2 days 3 hours' where id = '00000000-0000-0000-0000-0000000005e1';
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
do $$
declare j jsonb := (select x from jsonb_array_elements(public.crew_mine()) x where x ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1');
begin
  perform pg_temp.ok(j is not null, 'My jobs: b1 is listed');
  perform pg_temp.ok((j ->> 'from_home')::boolean, 'My jobs: part-timer with a home address leaves from home');
  perform pg_temp.ok((j ->> 'checklist_open')::int = 2, 'My jobs: 2 checklist steps open (done one not counted)');
  perform pg_temp.ok((j ->> 'checklist_late')::int = 1, 'My jobs: 1 of them late');
end $$;
reset role;
select set_config('jobs_test.token', (select token from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b1'
                                        and user_id = '00000000-0000-0000-0000-0000000000c1' limit 1), true);
select pg_temp.act(null);
select pg_temp.ok((public.crew_public(current_setting('jobs_test.token')) ->> 'from_home')::boolean, 'Confirm page (signed out): says leave home');
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
do $$
declare d jsonb := public.my_day((now() at time zone 'America/New_York')::date + 2);
        a jsonb := public.assignments_day((now() at time zone 'America/New_York')::date);
begin
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(d -> 'entries') e where e ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1'), 'My day: the job bar carries its booking_id');
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(a) t where t ->> 'task_id' = '00000000-0000-0000-0000-00000000aa01'
                                and t ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1' and t ->> 'booking_title' is not null), 'My day: a checklist step carries its job');
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(a) t where t ->> 'task_id' = '00000000-0000-0000-0000-00000000aa04' and t -> 'booking_id' = 'null'::jsonb), 'My day: a plain task has no job');
end $$;
reset role;
update public.schedule_entries set starts_at = '2026-10-31 09:00 America/New_York', ends_at = '2026-10-31 12:00 America/New_York' where id = '00000000-0000-0000-0000-0000000005e1';

-- ---------------------------------------------------------------- the crew moves with the day
-- Edit booking moves b1 a week on (Oct 31 is daylight time, Nov 7 is standard time: same wall clock).
update public.bookings set picture_day = '2026-11-07' where id = '00000000-0000-0000-0000-0000000000b1';
update public.booking_days set day = '2026-11-07' where booking_id = '00000000-0000-0000-0000-0000000000b1';
update public.bookings set picture_day = '2026-11-07' where id = '00000000-0000-0000-0000-0000000000b2';
update public.booking_days set day = '2026-11-07' where booking_id = '00000000-0000-0000-0000-0000000000b2';
select pg_temp.ok(pg_temp.ny('00000000-0000-0000-0000-0000000005e1') = '2026-10-31 09:00', 'nothing moves before the edit is saved (commit)');
set constraints all immediate;   -- what commit does
select pg_temp.ok(pg_temp.ny('00000000-0000-0000-0000-0000000005e1') = '2026-11-07 09:00', 'the crew''s bar moves to the new day, same time');
select pg_temp.ok((select to_char(ends_at at time zone 'America/New_York', 'HH24:MI') from public.schedule_entries where id = '00000000-0000-0000-0000-0000000005e1') = '12:00', 'and it still ends at noon');
select pg_temp.ok(pg_temp.ny('00000000-0000-0000-0000-0000000005e2') = '2026-11-02 09:00', 'a bar on another day stays');
select pg_temp.ok(pg_temp.ny('00000000-0000-0000-0000-0000000005e3') = '2026-10-31 13:00', 'a cancelled job''s bars stay');
-- saving again with the same day changes nothing
set constraints all deferred;
update public.bookings set picture_day = '2026-11-07' where id = '00000000-0000-0000-0000-0000000000b1';
set constraints all immediate;
select pg_temp.ok(pg_temp.ny('00000000-0000-0000-0000-0000000005e1') = '2026-11-07 09:00', 'saving the same day again: no move');
select pg_temp.ok(not has_function_privilege('authenticated', 'public.jobs_booking_moved()', 'execute'), 'the trigger function is not callable from the app');

do $$ begin raise notice 'ALL JOBS TESTS PASSED'; end $$;
rollback;
