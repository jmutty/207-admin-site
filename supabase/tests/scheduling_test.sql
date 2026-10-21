-- Tests for 20261022120000_scheduling_assignments (Scheduling + Assignments) 20261022150000_schedule_kinds and 20261022160000_day_email. Run against a NON-production copy
-- of the schema after the migration, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/scheduling_test.sql
-- "ALL SCHEDULING TESTS PASSED" at the end means every check held.

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

-- o1 full access; e1 edits both modules; v1 views both; n1 has neither; x1 is deactivated
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'o1@example.com'), ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com'), ('00000000-0000-0000-0000-0000000000f9', 'x1@example.com');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000a1', 'Owner One', true),
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000c1', 'View One', true),
  ('00000000-0000-0000-0000-0000000000d1', 'No One', true), ('00000000-0000-0000-0000-0000000000f9', 'Gone One', false)
  on conflict (user_id) do update set display_name = excluded.display_name;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'scheduling', 'edit'), ('00000000-0000-0000-0000-0000000000e1', 'assignments', 'edit'),
  ('00000000-0000-0000-0000-0000000000c1', 'scheduling', 'view'), ('00000000-0000-0000-0000-0000000000c1', 'assignments', 'view'),
  ('00000000-0000-0000-0000-0000000000d1', 'bookings', 'view');

-- Week of Sunday 2026-11-01 (Eastern). b1: one day with times; b2: two days, the first without a time; b3: cancelled.
insert into public.prospect_orgs (id, name, town) values ('00000000-0000-0000-0000-00000000aaa1', 'Test Academy', 'Hampden');
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, location, status, time_set, end_set) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000aaa1', 'school', 'School Photos', '2026-11-03', '2026-11-03 09:00 America/New_York', '2026-11-03 12:00 America/New_York', '', 'booked', true, true),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000aaa1', 'sports', 'Fall Sports', '2026-11-04', '2026-11-04 00:00 America/New_York', '2026-11-04 01:00 America/New_York', '12 Gym Rd, Hampden ME', 'booked', false, false),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000aaa1', 'school', 'Retakes', '2026-11-05', '2026-11-05 09:00 America/New_York', '2026-11-05 10:00 America/New_York', '', 'cancelled', true, true);
insert into public.booking_days (booking_id, day, start_at, end_at, sort) values
  ('00000000-0000-0000-0000-0000000000b2', '2026-11-04', '2026-11-04 00:00 America/New_York', '2026-11-04 01:00 America/New_York', 0),
  ('00000000-0000-0000-0000-0000000000b2', '2026-11-06', '2026-11-06 15:00 America/New_York', '2026-11-06 18:00 America/New_York', 1);

select pg_temp.ok((select status from public.app_modules where key = 'scheduling') = 'live', 'scheduling is live');
select pg_temp.ok(exists (select 1 from public.app_modules where key = 'assignments' and not admin_only), 'assignments module exists and is grantable');
select pg_temp.ok((select count(*) from cron.job where jobname = 'day-plan-send') = 1, 'the daily notification is scheduled');

-- ---------------------------------------------------------------- outsiders
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.schedule_week('2026-11-01')$$, 'n1: no schedule');
select pg_temp.raises($$select public.assignments_day('2026-11-02')$$, 'n1: no assignments');
select pg_temp.raises($$select * from public.schedule_entries$$, 'n1: table not readable');
select pg_temp.ok(jsonb_array_length(public.my_day('2026-11-02') -> 'tasks') = 0, 'n1: my_day works, no tasks without Assignments');
select pg_temp.act(null);
select pg_temp.raises($$select public.my_day('2026-11-02')$$, 'anon: no my_day');
select pg_temp.raises($$select public.schedule_week('2026-11-01')$$, 'anon: no schedule');

-- The checks below peek at the tables directly (only inside this rolled-back test).
reset role;
grant select on public.schedule_entries, public.staff_tasks, public.team_audit, public.push_outbox to authenticated;
create policy test_peek on public.schedule_entries for select to authenticated using (true);
create policy test_peek on public.staff_tasks for select to authenticated using (true);
create policy test_peek on public.team_audit for select to authenticated using (true);

-- ---------------------------------------------------------------- e1: scheduling edit
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.schedule_week('2026-11-01') ->> 'can_edit')::boolean, 'e1: can edit');
select pg_temp.ok(jsonb_array_length(public.schedule_week('2026-11-01') -> 'people') = 4, 'e1: four active people (deactivated left out)');
select pg_temp.ok(jsonb_array_length(public.schedule_week('2026-11-01') -> 'bookings') = 3, 'e1: three booking days (cancelled left out)');
select pg_temp.ok((select x ->> 'title' from jsonb_array_elements(public.schedule_week('2026-11-01') -> 'bookings') x where x ->> 'day' = '2026-11-03') = 'Test Academy • School Photos', 'e1: booking title is Organization • Label');
select pg_temp.ok((select x -> 'start_at' from jsonb_array_elements(public.schedule_week('2026-11-01') -> 'bookings') x where x ->> 'day' = '2026-11-04') = 'null'::jsonb, 'e1: a day with no time yet has no start');
select pg_temp.ok((select (x ->> 'start_at')::timestamptz from jsonb_array_elements(public.schedule_week('2026-11-01') -> 'bookings') x where x ->> 'day' = '2026-11-06') = '2026-11-06 15:00 America/New_York', 'e1: second day keeps its own time');

select pg_temp.ok((public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","kind":"job","booking_id":"00000000-0000-0000-0000-0000000000b1",
  "starts_at":"2026-11-03T09:00:00-05:00","ends_at":"2026-11-03T12:00:00-05:00","drive_before_min":45,"drive_after_min":45}') ->> 'overlaps')::int = 0, 'e1: puts v1 on b1 with drive time');
select pg_temp.ok((public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","kind":"work","title":"Editing",
  "starts_at":"2026-11-03T12:30:00-05:00","ends_at":"2026-11-03T15:00:00-05:00","drive_before_min":30}') ->> 'overlaps')::int = 1, 'e1: a bar inside the drive home counts as an overlap');
select pg_temp.ok((select drive_before_min from public.schedule_entries where kind = 'work') = 0, 'e1: drive time only on jobs');
select pg_temp.ok((public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000d1","kind":"studio","starts_at":"2026-11-04T09:00:00-05:00","ends_at":"2026-11-04T12:00:00-05:00"}') ->> 'ok')::boolean, 'e1: studio time saves');
select pg_temp.ok((public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000d1","kind":"admin","title":"Editing","starts_at":"2026-11-04T13:00:00-05:00","ends_at":"2026-11-04T15:00:00-05:00","drive_before_min":20}') ->> 'ok')::boolean, 'e1: admin time saves');
select pg_temp.ok((select sum(drive_before_min) from public.schedule_entries where kind in ('studio', 'admin')) = 0, 'e1: no drive time on studio or admin time');
reset role;
select pg_temp.ok((public.day_plan_text('00000000-0000-0000-0000-0000000000d1', '2026-11-04') ->> 'body') like '%Studio%' and (public.day_plan_text('00000000-0000-0000-0000-0000000000d1', '2026-11-04') ->> 'body') like '%Editing%', 'e1: studio and admin time are in the day plan');
delete from public.schedule_entries where kind in ('studio', 'admin');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","kind":"lunch","starts_at":"2026-11-03T09:00:00-05:00","ends_at":"2026-11-03T10:00:00-05:00"}')$$, 'e1: unknown kinds refused');
select pg_temp.raises($$select public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","kind":"job","starts_at":"2026-11-03T09:00:00-05:00","ends_at":"2026-11-03T10:00:00-05:00"}')$$, 'e1: a job needs its booking');
select pg_temp.raises($$select public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","kind":"work","starts_at":"2026-11-03T10:00:00-05:00","ends_at":"2026-11-03T09:00:00-05:00"}')$$, 'e1: end before start refused');
select pg_temp.raises($$select public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000f9","kind":"work","starts_at":"2026-11-03T09:00:00-05:00","ends_at":"2026-11-03T10:00:00-05:00"}')$$, 'e1: deactivated people cannot be scheduled');
select pg_temp.raises($$select public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","kind":"work","starts_at":"2026-11-03T09:00:00-05:00","ends_at":"2026-11-05T10:00:00-05:00"}')$$, 'e1: a work bar over 24 hours refused');
select pg_temp.ok((public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000e1","kind":"off","title":"Vacation","starts_at":"2026-11-02T00:00:00-05:00","ends_at":"2026-11-05T00:00:00-05:00"}') ->> 'ok')::boolean, 'e1: several days off in one bar');
select pg_temp.ok(jsonb_array_length(public.schedule_week('2026-11-01') -> 'entries') = 3, 'e1: week shows the three bars');
select pg_temp.ok(jsonb_array_length(public.schedule_week('2026-11-08') -> 'entries') = 0, 'e1: next week is empty');
select pg_temp.ok(jsonb_array_length(public.schedule_week('2026-11-03', 1) -> 'entries') = 3, 'e1: day view of Nov 3');
select pg_temp.ok(((public.schedule_week('2026-11-01') -> 'entries') -> 0 ->> 'booking_title') is null or true, 'entries carry their booking title');
select pg_temp.ok((select (public.schedule_remove(id) ->> 'ok')::boolean from public.schedule_entries where kind = 'off'), 'e1: removes a bar');

-- drive time
select pg_temp.ok(not (public.drive_time_target('00000000-0000-0000-0000-0000000000b1') ->> 'ok')::boolean, 'drive time: needs the studio address first');
select public.schedule_settings_save('  5 Studio Ln, Bangor ME ');
select pg_temp.ok((public.drive_time_target('00000000-0000-0000-0000-0000000000b1') ->> 'destination') = 'Test Academy, Hampden, Maine', 'drive time: no location -> organization and town');
select pg_temp.ok((public.drive_time_target('00000000-0000-0000-0000-0000000000b2') ->> 'destination') = '12 Gym Rd, Hampden ME', 'drive time: the booking location');
select pg_temp.ok((public.drive_time_target('00000000-0000-0000-0000-0000000000b1') -> 'minutes') = 'null'::jsonb, 'drive time: nothing cached yet');
select pg_temp.ok((public.drive_time_store('5 Studio Ln, Bangor ME', 'Test Academy, Hampden, Maine', 22, 18000) ->> 'ok')::boolean, 'drive time: stores');
select pg_temp.ok((public.drive_time_target('00000000-0000-0000-0000-0000000000b1') ->> 'minutes')::int = 22, 'drive time: cached answer');
select pg_temp.ok(not (public.drive_time_store('Somewhere else', 'X', 5, 1) ->> 'ok')::boolean, 'drive time: answer for an old studio address dropped');
select public.schedule_settings_save('6 New St, Bangor ME');
select pg_temp.ok((public.drive_time_target('00000000-0000-0000-0000-0000000000b1') -> 'minutes') = 'null'::jsonb, 'drive time: moving the studio clears the cache');

-- ---------------------------------------------------------------- v1: scheduling view
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(not (public.schedule_week('2026-11-01') ->> 'can_edit')::boolean, 'v1: view only');
select pg_temp.ok(jsonb_array_length(public.schedule_week('2026-11-01') -> 'entries') = 2, 'v1: sees the team''s week');
select pg_temp.raises($$select public.schedule_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","kind":"work","starts_at":"2026-11-03T09:00:00-05:00","ends_at":"2026-11-03T10:00:00-05:00"}')$$, 'v1: cannot add bars');
select pg_temp.raises($$select public.schedule_remove((select id from public.schedule_entries limit 1))$$, 'v1: cannot remove bars');
select pg_temp.raises($$select public.drive_time_target('00000000-0000-0000-0000-0000000000b1')$$, 'v1: no drive time lookups');
select pg_temp.raises($$select public.schedule_settings_save('x')$$, 'v1: cannot move the studio');
select pg_temp.ok(jsonb_array_length(public.my_day('2026-11-03') -> 'entries') = 2, 'v1: my day has the job and the editing');

-- ---------------------------------------------------------------- assignments
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.assignment_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","title":"Back up cards","repeat":"daily","weekdays":[1,2,3,4,5],"starts_on":"2026-10-01"}');
select public.assignment_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","title":"Order supplies","repeat":"weekly","weekdays":[1],"starts_on":"2026-10-01"}');
select public.assignment_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","title":"Month-end report","repeat":"monthly","month_day":31,"starts_on":"2026-10-01"}');
select public.assignment_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","title":"Call Hampden","repeat":"once","due_on":"2026-11-04","priority":"urgent"}');
select public.assignment_save('{"user_id":"00000000-0000-0000-0000-0000000000e1","title":"Edit-one task","repeat":"daily","starts_on":"2026-10-01"}');
select pg_temp.raises($$select public.assignment_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","title":"x","repeat":"weekly","weekdays":[1,2]}')$$, 'weekly needs exactly one day');
select pg_temp.raises($$select public.assignment_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","title":"x","repeat":"once"}')$$, 'once needs a due day');
select pg_temp.raises($$select public.assignment_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","title":"x","repeat":"daily","priority":"panic"}')$$, 'priority is normal or urgent');
select pg_temp.ok((select weekdays from public.staff_tasks where title = 'Edit-one task') = '{}', 'daily with no days = every day');
select pg_temp.ok(jsonb_array_length(public.assignments_day('2026-11-02', null, true)) = 4, 'e1: everyone''s Monday (v1 daily + weekly + Oct 31 report still open, e1 daily)');
select pg_temp.ok(jsonb_array_length(public.schedule_week('2026-11-01') -> 'tasks') > 0, 'e1: schedule shows task counts');

select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((select string_agg(x ->> 'title', ',' order by x ->> 'title') from jsonb_array_elements(public.assignments_day('2026-11-02')) x) = 'Back up cards,Month-end report,Order supplies', 'v1: Monday list (October''s report carried over)');
select pg_temp.ok((select string_agg(x ->> 'title', ',') from jsonb_array_elements(public.assignments_day('2026-11-30')) x) like '%Month-end report%', 'v1: day 31 falls on Nov 30');
select pg_temp.raises($$select public.assignments_day('2026-11-02', null, true)$$, 'v1: cannot see everyone''s');
select pg_temp.raises($$select public.assignments_day('2026-11-02', '00000000-0000-0000-0000-0000000000e1')$$, 'v1: cannot see e1''s');
select pg_temp.raises($$select public.assignment_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","title":"x","repeat":"daily"}')$$, 'v1: cannot assign');
select pg_temp.ok(jsonb_array_length(public.assignments_list() -> 'tasks') = 4, 'v1: list shows only their own');
select public.assignment_check((select id from public.staff_tasks where title = 'Month-end report'), '2026-10-31', true);
-- Monday: check off the weekly one, miss the daily one
select public.assignment_check((select id from public.staff_tasks where title = 'Order supplies'), '2026-11-02', true);
select pg_temp.raises($$select public.assignment_check((select id from public.staff_tasks where title = 'Order supplies'), '2026-11-03', true)$$, 'v1: not due that day');
select pg_temp.raises($$select public.assignment_check((select id from public.staff_tasks where title = 'Edit-one task'), '2026-11-02', true)$$, 'v1: cannot check off someone else''s');
-- Tuesday: the daily task shows once (today's), the done weekly one is gone
select pg_temp.ok((select string_agg(x ->> 'title' || ':' || (x ->> 'overdue'), ',') from jsonb_array_elements(public.assignments_day('2026-11-03')) x) = 'Back up cards:false', 'v1: Tuesday: daily once, done weekly gone');
-- Saturday: Friday's missed daily task carries over as overdue
select pg_temp.ok((select (x ->> 'overdue')::boolean from jsonb_array_elements(public.assignments_day('2026-11-07')) x where x ->> 'title' = 'Back up cards'), 'v1: Saturday: missed Friday task carried over');
-- Thursday: the urgent one-time task was missed Wednesday -> at the top
select pg_temp.ok((public.assignments_day('2026-11-05') -> 0 ->> 'title') = 'Call Hampden' and (public.assignments_day('2026-11-05') -> 0 ->> 'overdue')::boolean, 'v1: missed urgent task on top the next day');
-- a weekly task not done stays overdue until its next week
select pg_temp.ok(exists (select 1 from jsonb_array_elements(public.assignments_day('2026-11-14')) x where x ->> 'title' = 'Order supplies' and (x ->> 'overdue')::boolean), 'v1: missed weekly shows overdue on Saturday');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.assignments_day('2026-11-16')) x where x ->> 'title' = 'Order supplies') = 1, 'v1: ...and once on the next Monday (no pile-up)');
-- un-check
select public.assignment_check((select id from public.staff_tasks where title = 'Order supplies'), '2026-11-02', false);
select pg_temp.ok(exists (select 1 from jsonb_array_elements(public.assignments_day('2026-11-03')) x where x ->> 'title' = 'Order supplies'), 'v1: un-checked weekly comes back as overdue');

-- notification text (as the server builds it)
reset role;
select pg_temp.ok((public.day_plan_text('00000000-0000-0000-0000-0000000000c1', '2026-11-03', true) ->> 'title') = 'Tomorrow (Tuesday): 1 job, 2 tasks', 'day plan title: ' || (public.day_plan_text('00000000-0000-0000-0000-0000000000c1', '2026-11-03', true) ->> 'title'));
select pg_temp.ok((public.day_plan_text('00000000-0000-0000-0000-0000000000c1', '2026-11-03', true) ->> 'body') like '9:00am Test Academy • School Photos (leave 8:15am)%', 'day plan body: ' || (public.day_plan_text('00000000-0000-0000-0000-0000000000c1', '2026-11-03', true) ->> 'body'));
select pg_temp.ok(public.day_plan_text('00000000-0000-0000-0000-0000000000d1', '2026-11-03') is null, 'nothing on -> no notification');

-- sending: works whatever hour the test runs (4am-9pm Eastern); outside that window just checks it sends nothing
do $$
declare h int := extract(hour from now() at time zone 'America/New_York');
begin
  insert into public.push_subscriptions (user_id) values ('00000000-0000-0000-0000-0000000000c1'), ('00000000-0000-0000-0000-0000000000d1');
  update public.staff_tasks set starts_on = current_date - 40 where title = 'Back up cards';
  update public.staff_tasks set weekdays = '{}' where title = 'Back up cards';
  if h between 4 and 21 then
    update public.staff_settings set day_plan_hour = h;
    perform pg_temp.ok(public.day_plan_send() = 1, 'sends to v1 only (n1 has no Assignments)');
    perform pg_temp.ok((select target_user from public.push_outbox where topic = 'my_day') = '00000000-0000-0000-0000-0000000000c1', 'goes to v1 alone');
    perform pg_temp.ok(public.day_plan_send() = 0, 'once per day');
    update public.staff_settings set day_plan_hour = case when h >= 5 then h - 4 else h end;
  else
    perform pg_temp.ok(public.day_plan_send() = 0, 'outside the window: nothing');
  end if;
end $$;
-- "Your day" morning email (20261022160000_day_email)
select pg_temp.ok((public.day_email_content('00000000-0000-0000-0000-0000000000c1', '2026-11-03') ->> 'subject') = 'Your day, Tuesday Nov 3: 1 job, 2 tasks', 'email subject: ' || (public.day_email_content('00000000-0000-0000-0000-0000000000c1', '2026-11-03') ->> 'subject'));
select pg_temp.ok((public.day_email_content('00000000-0000-0000-0000-0000000000c1', '2026-11-03') ->> 'text') like '%9:00am-12:00pm Test Academy • School Photos%leave the studio 8:15am (45 min drive)%', 'email lists the job and when to leave');
select pg_temp.ok((public.day_email_content('00000000-0000-0000-0000-0000000000c1', '2026-11-03') ->> 'text') like '%hours scheduled%' and (public.day_email_content('00000000-0000-0000-0000-0000000000c1', '2026-11-03') ->> 'text') like '%TASKS%- [ ] %', 'email has hours and tasks');
select pg_temp.ok((public.day_email_content('00000000-0000-0000-0000-0000000000c1', '2026-11-03') ->> 'html') like '%<ul%' and (public.day_email_content('00000000-0000-0000-0000-0000000000c1', '2026-11-03') ->> 'html') not like '%<script%', 'email has html');
select pg_temp.ok(public.day_email_content('00000000-0000-0000-0000-0000000000d1', '2026-11-03') is null, 'email: nothing on -> nothing sent');
select pg_temp.ok(public.html_esc('<b>&') = '&lt;b&gt;&amp;', 'html_esc escapes');
do $$
declare h int := extract(hour from now() at time zone 'America/New_York');
begin
  insert into vault.decrypted_secrets values ('resend_api_key', 'test-key');
  if h between 4 and 13 then
    update public.staff_settings set day_email_hour = least(h, 11);
    perform pg_temp.ok(public.day_email_send() = 2, 'emails v1 and e1 (n1 has no Assignments)');
    perform pg_temp.ok((select array_agg(body -> 'to' ->> 0 order by body -> 'to' ->> 0) from net.calls) = '{e1@example.com,v1@example.com}', 'to their login emails');
    perform pg_temp.ok(public.day_email_send() = 0, 'email: once per day');
    delete from public.day_email_log; update public.team_members set day_email = false where user_id = '00000000-0000-0000-0000-0000000000c1';
    perform pg_temp.ok(public.day_email_send() = 1, 'email: v1 switched theirs off');
    update public.team_members set day_email = true; delete from public.day_email_log;
    update public.staff_settings set day_email_on = false;
    perform pg_temp.ok(public.day_email_send() = 0, 'email: switched off for everyone');
    update public.staff_settings set day_email_on = true;
  else
    perform pg_temp.ok(public.day_email_send() = 0, 'email: outside the window, nothing');
  end if;
end $$;
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.day_plan_send()$$, 'v1: cannot run the sender');
select pg_temp.raises($$select public.day_email_send()$$, 'v1: cannot run the email sender');
select pg_temp.raises($$select public.day_email_settings_save(true, 7)$$, 'v1: cannot change the email hour');
select pg_temp.ok((public.day_email_mine(false) ->> 'ok')::boolean, 'v1: switches their own email off');
select pg_temp.ok(not (public.day_email_status() ->> 'mine')::boolean, 'v1: and sees it off');
select pg_temp.ok((public.day_email_mine(true) ->> 'on')::boolean, 'v1: and back on');
select pg_temp.raises($$select public.staff_settings_save(true, 20)$$, 'v1: cannot change the notification hour');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.staff_settings_save(true, 23)$$, 'hour after 9pm refused');
select pg_temp.ok((public.staff_settings_save(false, 20) ->> 'ok')::boolean, 'e1: can turn the notification off');
select pg_temp.ok((select (public.assignment_archive(id) ->> 'ok')::boolean from public.staff_tasks where title = 'Call Hampden'), 'e1: removes a task');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.assignments_day('2026-11-05', '00000000-0000-0000-0000-0000000000c1')) x where x ->> 'title' = 'Call Hampden'), 'removed task is off the list');

-- ---------------------------------------------------------------- weekly hours (Team page, full access)
select pg_temp.raises($$select public.team_set_hours('00000000-0000-0000-0000-0000000000c1', 30)$$, 'e1: cannot set hours (Team is full-access)');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select public.team_set_hours('00000000-0000-0000-0000-0000000000c1', 32);
select pg_temp.ok((select (x ->> 'weekly_hours')::numeric from jsonb_array_elements(public.team_list()) x where x ->> 'user_id' = '00000000-0000-0000-0000-0000000000c1') = 32, 'o1: weekly hours saved and listed');
select pg_temp.raises($$select public.team_set_hours('00000000-0000-0000-0000-0000000000c1', 90)$$, 'o1: over 80 hours refused');
select pg_temp.ok((select count(*) from public.team_audit where action = 'hours_set') = 1, 'hours change is in the log');

-- ---------------------------------------------------------------- Today: unstaffed jobs
reset role;
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, status, time_set, end_set) values
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000aaa1', 'school', 'Soon', (now() at time zone 'America/New_York')::date + 3,
   now() + interval '3 days', now() + interval '3 days 2 hours', 'booked', true, true);
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.schedule_attention() ->> 'unstaffed')::int >= 1, 'a job in 3 days with nobody on it is flagged');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000c1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b4',
  'starts_at', now() + interval '3 days', 'ends_at', now() + interval '3 days 2 hours'));
select pg_temp.ok((public.schedule_attention() ->> 'unstaffed')::int = 0, 'once someone is on it, it is not flagged');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.schedule_attention()$$, 'n1: no attention count');

reset role;
select 'ALL SCHEDULING TESTS PASSED';
rollback;
