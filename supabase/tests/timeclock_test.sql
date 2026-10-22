-- Tests for 20261022213000_timeclock_mileage (Time clock and mileage). Run against a NON-production copy of the
-- schema after the migration, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/timeclock_test.sql
-- "ALL TIMECLOCK TESTS PASSED" at the end means every check held.

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
grant execute on all functions in schema pg_temp to anon, authenticated;

-- o1 full access; e1 edits the time clock; v1 views it (uses it for themself); n1 has no time clock
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'o1@example.com'), ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000a1', 'Owner One', true),
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000c1', 'View One', true),
  ('00000000-0000-0000-0000-0000000000d1', 'No One', true)
  on conflict (user_id) do update set display_name = excluded.display_name;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'timeclock', 'edit'),
  ('00000000-0000-0000-0000-0000000000c1', 'timeclock', 'view'), ('00000000-0000-0000-0000-0000000000d1', 'bookings', 'view');

-- b1: a job today with a cached distance (21 km one way = 26.1 mi round trip); b2: a job in September, no distance yet.
update public.staff_settings set studio_address = '60 Main Rd, N Hampden' where id;
insert into public.prospect_orgs (id, name, town) values ('00000000-0000-0000-0000-00000000aaa1', 'Test Academy', 'Hampden');
insert into public.bookings (id, org_id, status, location, picture_day, start_at, end_at, time_set, end_set) values
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000aaa1', 'booked', '89 Western Ave, Hampden ME',
   (now() at time zone 'America/New_York')::date, now() - interval '1 hour', now() + interval '2 hours', true, true),
  ('00000000-0000-0000-0000-00000000bb02', '00000000-0000-0000-0000-00000000aaa1', 'booked', '1 Far Rd, Bethel ME', '2026-09-10',
   '2026-09-10 09:00-04', '2026-09-10 12:00-04', true, true);
insert into public.drive_time_cache (destination, origin, minutes, meters) values ('89 western ave, hampden me', '60 main rd, n hampden', 23, 21000);
insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at, drive_before_min, drive_after_min) values
  ('00000000-0000-0000-0000-0000000000c1', 'job', '00000000-0000-0000-0000-00000000bb01', now() - interval '1 hour', now() + interval '2 hours', 30, 30),
  ('00000000-0000-0000-0000-0000000000c1', 'job', '00000000-0000-0000-0000-00000000bb02', '2026-09-10 09:00-04', '2026-09-10 12:00-04', 60, 60);

select pg_temp.ok((select status from public.app_modules where key = 'timeclock') = 'live', 'timeclock module is live');

-- ---------------------------------------------------------------- access
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.timeclock_status()$$, 'no time clock: status refused');
select pg_temp.raises($$select public.timeclock_in('studio')$$, 'no time clock: clock in refused');
select pg_temp.raises($$select public.mileage_list(current_date)$$, 'no time clock: mileage refused');
select pg_temp.raises($$select public.drive_time_target('00000000-0000-0000-0000-00000000bb01')$$, 'no time clock or schedule edit: drive time refused');
select pg_temp.raises($$select * from public.time_punches$$, 'tables are not readable directly');
select pg_temp.act(null);
select pg_temp.raises($$select public.timeclock_status()$$, 'anon refused');

-- ---------------------------------------------------------------- clock in / switch / out
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((select (j ->> 'mine')::boolean from jsonb_array_elements(public.timeclock_status() -> 'jobs') j
                    where j ->> 'booking_id' = '00000000-0000-0000-0000-00000000bb01'), 'status lists today''s job, marked as mine');
select pg_temp.ok(public.timeclock_status() -> 'open' = 'null'::jsonb, 'not clocked in yet');
select pg_temp.ok((public.timeclock_status() ->> 'today_scheduled_min')::int = 240, 'today: 3h job + 2 x 30 min drive scheduled');
select pg_temp.raises($$select public.timeclock_in('job')$$, 'job without a booking refused');
select pg_temp.ok((public.timeclock_in('job', '00000000-0000-0000-0000-00000000bb01', 'on site')) ->> 'ok' = 'true', 'clock in to the job');
select pg_temp.ok((public.timeclock_status() -> 'open' ->> 'booking_id') = '00000000-0000-0000-0000-00000000bb01', 'open punch is the job');
select pg_temp.raises($$select public.timeclock_in('job', '00000000-0000-0000-0000-00000000bb01')$$, 'clocking in to the same thing again refused');
select pg_temp.ok((public.mileage_list(current_date) -> 'trips' -> 0 ->> 'miles')::numeric = 26.1, 'clocking in to a job adds its round trip (26.1 mi)');
select pg_temp.ok((public.timeclock_in('studio')) ->> 'switched' = 'true', 'switch to Studio closes the job punch');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.timeclock_status() -> 'today')) = 2, 'two punches today');
select pg_temp.ok((public.timeclock_status() -> 'open' ->> 'kind') = 'studio', 'now clocked in to Studio');
select pg_temp.ok((select (a ->> 'clock_out')::timestamptz <= (b ->> 'clock_in')::timestamptz
                     from (select public.timeclock_status() -> 'today' -> 0 as a, public.timeclock_status() -> 'today' -> 1 as b) x), 'switch leaves no overlap');
select pg_temp.ok((public.timeclock_out('done')) ->> 'ok' = 'true', 'clock out');
select pg_temp.raises($$select public.timeclock_out()$$, 'clock out twice refused');

-- ---------------------------------------------------------------- own timesheet fixes
select pg_temp.ok((public.timepunch_save(jsonb_build_object('kind', 'admin', 'clock_in', now() - interval '2 days 3 hours', 'clock_out', now() - interval '2 days', 'note', 'forgot to clock'))) ->> 'ok' = 'true',
                  'add a forgotten stretch to my own timesheet');
select pg_temp.raises(format($$select public.timepunch_save('{"kind":"admin","clock_in":"%s","clock_out":"%s"}')$$, now() - interval '2 days 2 hours', now() - interval '2 days 1 hour'),
                      'overlapping stretch refused');
select pg_temp.raises(format($$select public.timepunch_save('{"kind":"admin","clock_in":"%s","clock_out":"%s"}')$$, now() + interval '1 hour', now() + interval '2 hours'), 'future time refused');
select pg_temp.raises(format($$select public.timepunch_save('{"kind":"admin","clock_in":"%s"}')$$, now() - interval '5 days'), 'a closed stretch needs a clock-out');
select pg_temp.raises(format($$select public.timepunch_save('{"user_id":"00000000-0000-0000-0000-0000000000e1","kind":"admin","clock_in":"%s","clock_out":"%s"}')$$,
                      now() - interval '6 days 2 hours', now() - interval '6 days'), 'view: adding time for someone else refused');
select pg_temp.raises($$select public.timesheet_week(current_date, null, true)$$, 'view: everyone''s week refused');
select pg_temp.raises($$select public.timesheet_week(current_date, '00000000-0000-0000-0000-0000000000e1')$$, 'view: someone else''s week refused');
select pg_temp.raises($$select public.timesheet_payroll(current_date)$$, 'view: payroll refused');
select pg_temp.raises($$select public.timesheet_approve('00000000-0000-0000-0000-0000000000c1', current_date)$$, 'view: approving refused');
select pg_temp.raises($$select public.mileage_list(current_date, true)$$, 'view: everyone''s miles refused');
select pg_temp.ok((select (p ->> 'edited')::boolean from jsonb_array_elements(public.timesheet_week(current_date - 2) -> 'punches') p where p ->> 'note' = 'forgot to clock'), 'typed time is marked edited')
  where public.tc_week_of(current_date - 2) = public.tc_week_of(current_date);

-- ---------------------------------------------------------------- manager: week, approve, lock
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((select (p ->> 'open')::boolean = false and (select sum((d ->> 'scheduled_min')::int) from jsonb_array_elements(p -> 'days') d) >= 240
                     from jsonb_array_elements(public.timesheet_week(current_date, null, true) -> 'people') p where p ->> 'user_id' = '00000000-0000-0000-0000-0000000000c1'),
                  'edit: everyone''s week shows View One with scheduled time');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.timesheet_week(current_date, '00000000-0000-0000-0000-0000000000c1') -> 'punches')) >= 2, 'edit: someone''s punches');
select pg_temp.ok((public.timesheet_approve('00000000-0000-0000-0000-0000000000c1', current_date)) ->> 'ok' = 'true', 'approve View One''s week');
select pg_temp.ok((select p ->> 'approved_at' is not null from jsonb_array_elements(public.timesheet_week(current_date, '00000000-0000-0000-0000-0000000000c1') -> 'people') p), 'week shows approved');
select pg_temp.raises(format($$select public.timepunch_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","kind":"admin","clock_in":"%s","clock_out":"%s"}')$$,
                      date_trunc('minute', now()) - interval '10 minutes', date_trunc('minute', now()) - interval '5 minutes'), 'approved week is locked for edit too');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.timeclock_in('studio')$$, 'approved week: clock in refused');
select pg_temp.raises(format($$select public.mileage_save('{"day":"%s","miles":5,"note":"bank"}')$$, current_date), 'approved week: adding miles refused');
select pg_temp.raises(format($$select public.timepunch_remove('%s')$$, (select p ->> 'id' from jsonb_array_elements(public.timesheet_week(current_date) -> 'punches') p limit 1)), 'approved week: removing time refused');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.timesheet_approve('00000000-0000-0000-0000-0000000000c1', current_date, false)) ->> 'ok' = 'true', 'unapprove');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.timeclock_in('other', null, 'errand')) ->> 'ok' = 'true', 'unlocked again: clock in works');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.timesheet_approve('00000000-0000-0000-0000-0000000000c1', current_date)$$, 'can''t approve while they are clocked in');
select pg_temp.ok((public.timeclock_attention() ->> 'open_long')::int = 0, 'nobody clocked in for 12 hours');

-- ---------------------------------------------------------------- payroll and overtime (week of Sunday 2026-09-06)
reset role;
insert into public.time_punches (user_id, user_name, kind, clock_in, clock_out)
select '00000000-0000-0000-0000-0000000000e1', 'Edit One', 'studio', (d::date + time '08:00') at time zone 'America/New_York', (d::date + time '17:00') at time zone 'America/New_York'
  from generate_series(date '2026-09-07', date '2026-09-11', interval '1 day') d;          -- 5 x 9h = 45h
insert into public.time_punches (user_id, user_name, kind, clock_in, clock_out) values
  ('00000000-0000-0000-0000-0000000000f9', 'Gone Person', 'admin', '2026-09-08 09:00-04', '2026-09-08 11:30-04');  -- someone since removed from the team
insert into public.time_punches (user_id, user_name, kind, clock_in, clock_out) values
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', 'admin', '2026-09-14 09:00-04', '2026-09-14 10:00-04');      -- next week, 1h
insert into public.mileage_trips (user_id, user_name, day, miles, auto, note) values ('00000000-0000-0000-0000-0000000000e1', 'Edit One', '2026-09-09', 100, false, 'bank run');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((select (p ->> 'worked_min')::int = 2700 and (p ->> 'overtime_min')::int = 300 and (p ->> 'regular_min')::int = 2400
                          and (p ->> 'miles')::numeric = 100 and (p ->> 'mileage_pay')::numeric = 70.00 and p ->> 'email' = 'e1@example.com'
                     from jsonb_array_elements(public.timesheet_payroll('2026-09-09', 1) -> 'people') p where p ->> 'user_id' = '00000000-0000-0000-0000-0000000000e1'),
                  'payroll: 45h = 40 regular + 5 overtime, 100 mi at $0.70');
select pg_temp.ok((select (p ->> 'overtime_min')::int = 300 and (p ->> 'worked_min')::int = 2760
                     from jsonb_array_elements(public.timesheet_payroll('2026-09-06', 2) -> 'people') p where p ->> 'user_id' = '00000000-0000-0000-0000-0000000000e1'),
                  'two weeks: overtime is per week (the second week''s hour is regular)');
select pg_temp.ok((select p ->> 'name' = 'Gone Person' and (p ->> 'worked_min')::int = 150
                     from jsonb_array_elements(public.timesheet_payroll('2026-09-06', 1) -> 'people') p where p ->> 'user_id' = '00000000-0000-0000-0000-0000000000f9'),
                  'payroll keeps a removed person''s hours under their name');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.timesheet_payroll('2026-09-06', 1) -> 'punches')) = 6, 'payroll detail has every punch');
select pg_temp.ok((public.timeclock_settings_save(0.725, 40)) ->> 'ok' = 'true', 'change the mileage rate');
select pg_temp.ok((select (p ->> 'mileage_pay')::numeric = 72.50 from jsonb_array_elements(public.timesheet_payroll('2026-09-06', 1) -> 'people') p
                    where p ->> 'user_id' = '00000000-0000-0000-0000-0000000000e1'), 'mileage pay follows the rate');
select pg_temp.raises($$select public.timeclock_settings_save(9, 40)$$, 'silly rate refused');
select pg_temp.ok((public.timeclock_attention() ->> 'to_approve')::int >= 0, 'attention answers for edit');

-- ---------------------------------------------------------------- mileage: from the schedule, look-ups, hand-typed trips
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.mileage_from_schedule('2026-09-01')) ->> 'added' = '1', 'add from schedule: the September job bar becomes a trip');
select pg_temp.ok((public.mileage_from_schedule('2026-09-01')) ->> 'added' = '0', 'add from schedule twice adds nothing');
select pg_temp.ok((select t -> 'miles' = 'null'::jsonb and t -> 'est_miles' = 'null'::jsonb from jsonb_array_elements(public.mileage_list('2026-09-01') -> 'trips') t), 'no distance yet: miles empty');
select pg_temp.ok((public.drive_time_target('00000000-0000-0000-0000-00000000bb02')) ->> 'destination' = '1 Far Rd, Bethel ME', 'time clock view may look up a job''s distance');
select pg_temp.ok((public.drive_time_store('60 Main Rd, N Hampden', '1 Far Rd, Bethel ME', 146, 160934)) ->> 'ok' = 'true', 'and store it');
select pg_temp.ok((select (t ->> 'est_miles')::numeric = 200.0 from jsonb_array_elements(public.mileage_list('2026-09-01') -> 'trips') t), 'estimate shows once looked up');
select pg_temp.ok((public.mileage_refresh('2026-09-01')) ->> 'filled' = '1', 'refresh fills the trip');
select pg_temp.ok((select (t ->> 'miles')::numeric = 200.0 and (t ->> 'auto')::boolean from jsonb_array_elements(public.mileage_list('2026-09-01') -> 'trips') t), 'trip has 200 mi from Google');
select pg_temp.ok((public.mileage_save(jsonb_build_object('id', (select t ->> 'id' from jsonb_array_elements(public.mileage_list('2026-09-01') -> 'trips') t), 'day', '2026-09-10', 'miles', 0, 'note', 'rode with Sam'))) ->> 'ok' = 'true',
                  'set miles to 0 (rode with someone)');
select pg_temp.ok((select (t ->> 'miles')::numeric = 0 and not (t ->> 'auto')::boolean from jsonb_array_elements(public.mileage_list('2026-09-01') -> 'trips') t), 'typed miles are no longer auto');
select pg_temp.raises($$select public.mileage_save('{"day":"2026-09-11","miles":12}')$$, 'a trip without a job needs a note');
select pg_temp.ok((public.mileage_save('{"day":"2026-09-11","miles":12,"note":"Staples for paper"}')) ->> 'ok' = 'true', 'add a trip by hand');
select pg_temp.raises($$select public.mileage_save('{"day":"2026-09-11","miles":12,"note":"x","user_id":"00000000-0000-0000-0000-0000000000e1"}')$$, 'view: trip for someone else refused');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.mileage_list('2026-09-01') -> 'trips')) = 2, 'my September: 2 trips (not the manager''s)');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.mileage_list('2026-09-01', true) -> 'trips')) = 3, 'edit: everyone''s September');
select pg_temp.ok((public.mileage_remove((select (t ->> 'id')::uuid from jsonb_array_elements(public.mileage_list('2026-09-01', true) -> 'trips') t where t ->> 'note' = 'Staples for paper'))) ->> 'ok' = 'true', 'edit: remove someone''s trip');

select 'ALL TIMECLOCK TESTS PASSED' as result;
rollback;
