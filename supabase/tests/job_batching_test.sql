-- Tests for 20261023120000_job_setup_batching (setup / teardown on job bars, batched trips). Run against a
-- NON-production copy of the schema after the migration, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/job_batching_test.sql
-- "ALL JOB BATCHING TESTS PASSED" at the end means every check held.

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
-- the id of e1's bar on a booking
create function pg_temp.bar(p_booking text, p_user text default '00000000-0000-0000-0000-0000000000e1') returns uuid language sql as $$
  select id from public.schedule_entries where booking_id = p_booking::uuid and user_id = p_user::uuid order by starts_at limit 1 $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- o1 full access; e1 edits scheduling; v1 views it
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'o1@example.com'), ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000a1', 'Owner One', true),
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000c1', 'View One', true)
  on conflict (user_id) do update set display_name = excluded.display_name;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'scheduling', 'edit'), ('00000000-0000-0000-0000-0000000000c1', 'scheduling', 'view');
update public.staff_settings set studio_address = '60 Main Rd, N Hampden' where id;

-- Tuesday 2026-11-03: b1 9-12 at the academy, b2 1:30-3:30 at the gym, b3 the next day.
insert into public.prospect_orgs (id, name, town) values ('00000000-0000-0000-0000-00000000aaa1', 'Test Academy', 'Hampden');
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, location, status, time_set, end_set) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000aaa1', 'school', 'School Photos', '2026-11-03', '2026-11-03 09:00 America/New_York', '2026-11-03 12:00 America/New_York', '', 'booked', true, true),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000aaa1', 'sports', 'Fall Sports', '2026-11-03', '2026-11-03 13:30 America/New_York', '2026-11-03 15:30 America/New_York', '12 Gym Rd, Hampden ME', 'booked', true, true),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000aaa1', 'sports', 'Winter Sports', '2026-11-04', '2026-11-04 09:00 America/New_York', '2026-11-04 11:00 America/New_York', '12 Gym Rd, Hampden ME', 'booked', true, true);

-- ---------------------------------------------------------------- setup and teardown
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000e1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b1',
  'starts_at', '2026-11-03 09:00 America/New_York', 'ends_at', '2026-11-03 12:00 America/New_York', 'drive_before_min', 30, 'drive_after_min', 30));
select pg_temp.ok((select setup_min = 30 and teardown_min = 30 from public.schedule_entries where id = pg_temp.bar('00000000-0000-0000-0000-0000000000b1')), 'a new job bar gets 30 min setup and 30 min teardown');
select pg_temp.ok((public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000e1', 'kind', 'studio',
  'starts_at', '2026-11-03 12:35 America/New_York', 'ends_at', '2026-11-03 14:00 America/New_York')) ->> 'overlaps')::int = 1,
  'overlaps count teardown (job ends 12, teardown + drive back until 1)');
select pg_temp.ok((select setup_min = 0 and teardown_min = 0 from public.schedule_entries where kind = 'studio'), 'studio time has no setup');
select public.schedule_remove((select id from public.schedule_entries where kind = 'studio'));

select public.schedule_save(jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b1'), 'user_id', '00000000-0000-0000-0000-0000000000e1', 'kind', 'job',
  'booking_id', '00000000-0000-0000-0000-0000000000b1', 'starts_at', '2026-11-03 09:00 America/New_York', 'ends_at', '2026-11-03 12:00 America/New_York',
  'drive_before_min', 30, 'drive_after_min', 30, 'setup_min', 45, 'teardown_min', 15));
select pg_temp.ok((select setup_min = 45 and teardown_min = 15 from public.schedule_entries where id = pg_temp.bar('00000000-0000-0000-0000-0000000000b1')), 'setup and teardown can be changed per bar');
select public.schedule_save(jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b1'), 'user_id', '00000000-0000-0000-0000-0000000000e1', 'kind', 'job',
  'booking_id', '00000000-0000-0000-0000-0000000000b1', 'starts_at', '2026-11-03 09:00 America/New_York', 'ends_at', '2026-11-03 12:00 America/New_York',
  'drive_before_min', 30, 'drive_after_min', 30, 'setup_min', 30, 'teardown_min', 30));
select pg_temp.raises($$select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000e1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b3',
  'starts_at', '2026-11-04 09:00 America/New_York', 'ends_at', '2026-11-04 11:00 America/New_York', 'setup_min', 500))$$, 'setup over 240 minutes');

select pg_temp.ok((public.schedule_week('2026-11-01') ->> 'setup_default')::int = 30, 'schedule_week: the setup default');
select pg_temp.ok((public.schedule_week('2026-11-01') -> 'entries' -> 0 ->> 'teardown_min')::int = 30, 'schedule_week: teardown on the bar');

-- ---------------------------------------------------------------- job -> job drive times
select pg_temp.ok((public.drive_leg_target('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2') -> 'minutes') = 'null'::jsonb, 'leg: nothing cached yet');
select pg_temp.ok((public.drive_leg_target('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2') ->> 'origin') = 'Test Academy, Hampden, Maine', 'leg: from the first job''s address');
select public.drive_leg_store('Test Academy, Hampden, Maine', '12 Gym Rd, Hampden ME', 18, 15000);
select pg_temp.ok((public.drive_leg_target('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b1') ->> 'minutes')::int = 18, 'leg: cached either direction');
select pg_temp.ok((public.drive_leg_target('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3') ->> 'minutes')::int = 0, 'leg: same address is 0 minutes');

-- ---------------------------------------------------------------- a trip: studio -> b1 -> b2 -> studio
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000e1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b2',
  'starts_at', '2026-11-03 13:30 America/New_York', 'ends_at', '2026-11-03 15:30 America/New_York', 'drive_before_min', 35, 'drive_after_min', 35));
reset role;
insert into public.mileage_trips (user_id, user_name, booking_id, job_title, day, miles, auto) values
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', '00000000-0000-0000-0000-0000000000b1', 'School Photos', '2026-11-03', 50, true);
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.schedule_batch_save(jsonb_build_object('entries', jsonb_build_array(
  jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b1'), 'batch_id', '00000000-0000-0000-0000-00000000ba01', 'drive_before_min', 30, 'drive_after_min', 0, 'drive_before_m', 40000, 'drive_after_m', 0),
  jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b2'), 'batch_id', '00000000-0000-0000-0000-00000000ba01', 'drive_before_min', 20, 'drive_after_min', 35, 'drive_before_m', 15000, 'drive_after_m', 45000))));
select pg_temp.ok((select count(*) from public.schedule_entries where batch_id = '00000000-0000-0000-0000-00000000ba01') = 2, 'both bars are one trip');
select pg_temp.ok((select drive_after_min = 0 from public.schedule_entries where id = pg_temp.bar('00000000-0000-0000-0000-0000000000b1')), 'the first stop doesn''t drive back');
reset role;
select pg_temp.ok(not public.schedule_batched_later('00000000-0000-0000-0000-00000000ba01', '2026-11-03 09:00 America/New_York'), 'the first stop leaves from the studio');
select pg_temp.ok(public.schedule_batched_later('00000000-0000-0000-0000-00000000ba01', '2026-11-03 13:30 America/New_York'), 'the second stop leaves from the last job');
select pg_temp.ok(public.mileage_estimate_for('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', '2026-11-03') = 24.9, 'mileage: first stop is the drive out (40 km)');
select pg_temp.ok(public.mileage_estimate_for('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b2', '2026-11-03') = 37.3, 'mileage: last stop is the leg plus the drive home');
select pg_temp.ok((select miles from public.mileage_trips where booking_id = '00000000-0000-0000-0000-0000000000b1') = 24.9, 'mileage: the auto trip already made follows the trip');
-- 8:00-12:30 for b1 (leave 9 - 30 setup - 30 drive; 30 teardown, no drive back) + 12:40-4:35 for b2
select pg_temp.ok((select minutes from public.tc_scheduled(array['00000000-0000-0000-0000-0000000000e1'::uuid], '2026-11-03', '2026-11-04')) = 505, 'time clock scheduled minutes count setup, teardown and the trip');
select pg_temp.ok(strpos(public.day_email_content('00000000-0000-0000-0000-0000000000e1', '2026-11-03') ->> 'text', 'leave the studio 8:00am') > 0, 'morning email: leave the studio earlier for setup');
select pg_temp.ok(strpos(public.day_email_content('00000000-0000-0000-0000-0000000000e1', '2026-11-03') ->> 'text', 'leave the last job 12:40pm') > 0, 'morning email: the second stop leaves from the last job');
select pg_temp.ok(strpos(public.day_plan_text('00000000-0000-0000-0000-0000000000e1', '2026-11-03') ->> 'body', '(leave the last job 12:40pm)') > 0, 'evening notification: the second stop too');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.my_day('2026-11-03') -> 'entries' -> 1 ->> 'from_last_job')::boolean, 'my day: the second stop is from the last job');

-- ---------------------------------------------------------------- trips break up when bars move or go
select public.schedule_save(jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b2'), 'user_id', '00000000-0000-0000-0000-0000000000a1', 'kind', 'job',
  'booking_id', '00000000-0000-0000-0000-0000000000b2', 'starts_at', '2026-11-03 13:30 America/New_York', 'ends_at', '2026-11-03 15:30 America/New_York', 'drive_before_min', 20, 'drive_after_min', 35));
select pg_temp.ok((select batch_id is null from public.schedule_entries where booking_id = '00000000-0000-0000-0000-0000000000b2'), 'moved to someone else: out of the trip');
select pg_temp.ok((select batch_id is null and drive_before_m is null from public.schedule_entries where id = pg_temp.bar('00000000-0000-0000-0000-0000000000b1')), 'the bar left alone is no longer a trip');
select pg_temp.raises($$select public.schedule_batch_save(jsonb_build_object('entries', jsonb_build_array(
  jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b1'), 'batch_id', '00000000-0000-0000-0000-00000000ba02'),
  jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1'), 'batch_id', '00000000-0000-0000-0000-00000000ba02'))))$$, 'a trip is one person');
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000e1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b3',
  'starts_at', '2026-11-04 09:00 America/New_York', 'ends_at', '2026-11-04 11:00 America/New_York', 'drive_before_min', 35, 'drive_after_min', 35));
select pg_temp.raises($$select public.schedule_batch_save(jsonb_build_object('entries', jsonb_build_array(
  jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b1'), 'batch_id', '00000000-0000-0000-0000-00000000ba03'),
  jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b3'), 'batch_id', '00000000-0000-0000-0000-00000000ba03'))))$$, 'a trip is one day');
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000e1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b2',
  'starts_at', '2026-11-03 13:30 America/New_York', 'ends_at', '2026-11-03 15:30 America/New_York', 'drive_before_min', 35, 'drive_after_min', 35));
select public.schedule_batch_save(jsonb_build_object('entries', jsonb_build_array(
  jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b1'), 'batch_id', '00000000-0000-0000-0000-00000000ba04', 'drive_before_min', 30, 'drive_after_min', 0),
  jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b2'), 'batch_id', '00000000-0000-0000-0000-00000000ba04', 'drive_before_min', 20, 'drive_after_min', 35))));
select public.schedule_remove(pg_temp.bar('00000000-0000-0000-0000-0000000000b2'));
select pg_temp.ok((select batch_id is null from public.schedule_entries where id = pg_temp.bar('00000000-0000-0000-0000-0000000000b1')), 'removing a stop ends a two-stop trip');

-- ---------------------------------------------------------------- defaults
select pg_temp.ok((public.schedule_setup_save(20, 25, true) ->> 'changed')::int = 3, 'new defaults, applied to the job bars from today on');
select pg_temp.ok((select setup_min = 20 and teardown_min = 25 from public.schedule_entries where id = pg_temp.bar('00000000-0000-0000-0000-0000000000b3')), 'the later bar follows');
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000a1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b3',
  'starts_at', '2026-11-04 09:00 America/New_York', 'ends_at', '2026-11-04 11:00 America/New_York'));
select pg_temp.ok((select setup_min = 20 from public.schedule_entries where id = pg_temp.bar('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1')), 'a new bar gets the new default');

-- ---------------------------------------------------------------- Part time / 1099 people start at home
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f1', 'p1@example.com');
insert into public.team_members (user_id, display_name, active, employment_type, home_address) values
  ('00000000-0000-0000-0000-0000000000f1', 'Part Timer', true, 'part_time', '5 Elm St, Bangor ME')
  on conflict (user_id) do update set employment_type = excluded.employment_type, home_address = excluded.home_address;
insert into public.offer_drive_cache (origin, destination, minutes, meters) values ('5 elm st, bangor me', 'test academy, hampden, maine', 40, 50000);
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.drive_from_target('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1') ->> 'from') = 'home'
  and (public.drive_from_target('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1') ->> 'minutes')::int = 40, 'part-timer: the drive is from home (Open jobs cache)');
select pg_temp.ok((public.drive_from_target('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f1') -> 'minutes') = 'null'::jsonb, 'part-timer: a job not looked up yet');
select pg_temp.ok((public.drive_from_target('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1') ->> 'from') = 'studio', 'full time: the drive is from the studio');
select pg_temp.ok((select (p ->> 'from_home')::boolean from jsonb_array_elements(public.schedule_week('2026-11-01') -> 'people') p where p ->> 'user_id' = '00000000-0000-0000-0000-0000000000f1'), 'schedule_week: who starts at home');
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000f1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b1',
  'starts_at', '2026-11-03 09:00 America/New_York', 'ends_at', '2026-11-03 12:00 America/New_York', 'drive_before_min', 40, 'drive_after_min', 40));
reset role;
select pg_temp.ok(public.mileage_estimate_for('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', '2026-11-03') = 62.1, 'part-timer mileage: the round trip from home');
select pg_temp.ok(strpos(public.day_email_content('00000000-0000-0000-0000-0000000000f1', '2026-11-03') ->> 'text', 'leave home') > 0, 'part-timer morning email: leave home');
update public.team_members set employment_type = 'full_time' where user_id = '00000000-0000-0000-0000-0000000000f1';
select pg_temp.ok(not public.schedule_from_home('00000000-0000-0000-0000-0000000000f1'), 'full time with a home address: still the studio');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.drive_from_target('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1')$$, 'v1: no home drive lookups');

-- ---------------------------------------------------------------- access
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.schedule_batch_save(jsonb_build_object('entries', jsonb_build_array(jsonb_build_object('id', pg_temp.bar('00000000-0000-0000-0000-0000000000b1'), 'batch_id', null))))$$, 'v1: no batching');
select pg_temp.raises($$select public.drive_leg_target('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2')$$, 'v1: no leg lookups');
select pg_temp.raises($$select public.drive_leg_store('a', 'b', 1, 1)$$, 'v1: no leg storing');
select pg_temp.raises($$select public.schedule_setup_save(30, 30)$$, 'v1: no defaults');
select pg_temp.raises($$select public.mileage_estimate_for('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', '2026-11-03')$$, 'v1: internal mileage helper');
select pg_temp.raises($$select * from public.drive_leg_cache$$, 'v1: leg cache not readable');

reset role;
do $$ begin raise notice 'ALL JOB BATCHING TESTS PASSED'; end $$;
rollback;
