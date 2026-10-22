-- Season setup tests (20261023091500_job_season_setup). Run on a NON-production schema copy after the earlier
-- migrations; everything is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/job_season_setup_test.sql
begin;

create function pg_temp.act(p_uid uuid, p_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'aal', 'aal2')::text, true);
  execute format('set local role %I', p_role);
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
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- e = jobsetup edit, v = jobsetup view, x = bookings view only
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'e@example.com'), ('00000000-0000-0000-0000-0000000000e2', 'v@example.com'),
  ('00000000-0000-0000-0000-0000000000e3', 'x@example.com');
insert into public.team_members (user_id, display_name) values
  ('00000000-0000-0000-0000-0000000000e1', 'Ed'), ('00000000-0000-0000-0000-0000000000e2', 'Val'), ('00000000-0000-0000-0000-0000000000e3', 'Xan')
on conflict (user_id) do nothing;
insert into public.team_permissions (user_id, module_key, level) values
  ('00000000-0000-0000-0000-0000000000e1', 'jobsetup', 'edit'), ('00000000-0000-0000-0000-0000000000e2', 'jobsetup', 'view'),
  ('00000000-0000-0000-0000-0000000000e3', 'bookings', 'view');

insert into public.prospect_orgs (id, name, gotphoto_names) values
  ('00000000-0000-0000-0000-0000000000c1', 'Zz Test Hampden Little League', '{"Zz Hampden LL"}'),
  ('00000000-0000-0000-0000-0000000000c2', 'Zz Test Brewer School', '{}');
-- Last spring: a booked two-day weekend (times on both days) and a GotPhoto job that never was on Bookings.
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, duration_min, status, location, time_set, end_set, calendar_status) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'sports_data', 'Spring Sports', date '2026-04-25',
   timestamptz '2026-04-25 09:00 America/New_York', timestamptz '2026-04-25 13:00 America/New_York', 240, 'done', 'Hampden Field', true, true, 'synced');
insert into public.booking_days (booking_id, day, start_at, end_at, sort, label, calendar_status) values
  ('00000000-0000-0000-0000-0000000000b1', date '2026-04-25', timestamptz '2026-04-25 09:00 America/New_York', timestamptz '2026-04-25 13:00 America/New_York', 0, 'Majors', 'synced'),
  ('00000000-0000-0000-0000-0000000000b1', date '2026-04-26', timestamptz '2026-04-26 10:00 America/New_York', timestamptz '2026-04-26 12:00 America/New_York', 1, 'Minors', 'synced');
insert into public.synced_jobs (gotphoto_job_id, name, status, shoot_at, job_type) values
  ('zz-gp-1', 'Zz Hampden LL | Spring Sports', 'active', timestamptz '2026-05-02 12:00 Europe/Berlin', 'sports'),
  ('zz-gp-2', 'Zz Hampden LL | Fall Sports', 'active', timestamptz '2026-10-03 12:00 Europe/Berlin', 'sports');

-- ---------------------------------------------------------------- access
select pg_temp.act('00000000-0000-0000-0000-0000000000e3');
select pg_temp.raises($$select public.jobsetup_lookup()$$, 'bookings view alone does not open Season setup');
select pg_temp.raises($$select public.jobsetup_copy_candidates('2026-03-01', '2026-06-30', 364)$$, 'or list last season');
select pg_temp.act(null, 'anon');
select pg_temp.raises($$select public.jobsetup_history()$$, 'anon gets nothing');
select pg_temp.act('00000000-0000-0000-0000-0000000000e2');
select pg_temp.ok((public.jobsetup_lookup() ->> 'can_edit')::boolean = false and jsonb_array_length(public.jobsetup_lookup() -> 'types') >= 3, 'view sees the lookup, without edit');
select pg_temp.raises($$select public.jobsetup_import('csv', 'x.csv', '[{"org_id":"00000000-0000-0000-0000-0000000000c2","type_key":"school","days":[{"day":"2027-09-20"}]}]', false)$$, 'view cannot import');
select pg_temp.raises($$select public.jobsetup_import('csv', 'x.csv', '[{"org_id":"00000000-0000-0000-0000-0000000000c2","type_key":"school","days":[{"day":"2027-09-20"}]}]', true)$$, 'view cannot even dry-run');

-- ---------------------------------------------------------------- CSV import
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
create temp table r as select public.jobsetup_import('csv', 'spring.csv', jsonb_build_array(
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c2', 'type_key', 'school', 'days', jsonb_build_array(jsonb_build_object('day', '2027-09-20', 'start_time', '08:00', 'end_time', '14:00')), 'location', 'Brewer HS'),
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c1', 'type_key', 'sports_data', 'title_label', 'Spring Sports',
                     'days', jsonb_build_array(jsonb_build_object('day', '2027-04-25', 'start_time', '09:00'), jsonb_build_object('day', '2027-04-24', 'label', 'Majors'))),
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c2', 'type_key', 'school', 'days', jsonb_build_array(jsonb_build_object('day', '2027-09-20'))),
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c1', 'type_key', 'sports_data', 'days', jsonb_build_array(jsonb_build_object('day', '2026-04-26'))),
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c2', 'type_key', 'nope', 'days', jsonb_build_array(jsonb_build_object('day', '2027-10-01'))),
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c2', 'type_key', 'school', 'days', jsonb_build_array(jsonb_build_object('day', '2027-10-02', 'start_time', '10:00', 'end_time', '09:00'))),
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c2', 'type_key', 'school', 'days', jsonb_build_array(jsonb_build_object('day', 'not a date'))),
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c2', 'type_key', 'school', 'gotphoto_job_id', 'zz-missing', 'days', jsonb_build_array(jsonb_build_object('day', '2027-10-05')))
), true) as j;
select pg_temp.ok((select (j->>'added')::int = 2 and (j->>'skipped')::int = 6 and j->>'import_id' is null from r), 'dry run: 2 would be added, 6 skipped, nothing saved');
select pg_temp.ok((select j->'results'->2->>'error' = 'Same job twice in this list.' from r), 'the same job twice in one file is caught');
select pg_temp.ok((select j->'results'->3->>'duplicate_of' = '00000000-0000-0000-0000-0000000000b1' from r), 'a job already on Bookings (its second day) is a duplicate');
select pg_temp.ok((select j->'results'->4->>'error' = 'Pick a job type.' from r), 'unknown type');
select pg_temp.ok((select j->'results'->5->>'error' like 'The end time is before%' from r), 'end before start');
select pg_temp.ok((select j->'results'->6->>'error' like 'Can''t read the date%' from r), 'bad date');
select pg_temp.ok((select j->'results'->7->>'error' like '%not in the sync%' from r), 'unknown GotPhoto job');
select pg_temp.ok((select j->'results'->1->'days'->0->>'day' = '2027-04-24' from r), 'days come back sorted');
reset role;
select pg_temp.ok(not exists (select 1 from public.job_imports), 'dry run wrote no batch');

select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
create temp table r2 as select public.jobsetup_import('csv', 'spring.csv', jsonb_build_array(
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c2', 'type_key', 'school', 'days', jsonb_build_array(jsonb_build_object('day', '2027-09-20', 'start_time', '08:00', 'end_time', '14:00')), 'location', 'Brewer HS', 'notes', 'from the sheet'),
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c1', 'type_key', 'sports_data', 'title_label', 'Spring Sports',
                     'days', jsonb_build_array(jsonb_build_object('day', '2027-04-25', 'start_time', '09:00'), jsonb_build_object('day', '2027-04-24', 'label', 'Majors'))),
  jsonb_build_object('org_id', '00000000-0000-0000-0000-0000000000c1', 'type_key', 'sports_data', 'days', jsonb_build_array(jsonb_build_object('day', '2026-04-26')))
), false) as j;
reset role;
select pg_temp.ok((select (j->>'added')::int = 2 and (j->>'skipped')::int = 1 from r2), 'import adds 2, skips the duplicate');
select pg_temp.ok((select added = 2 and skipped = 1 and kind = 'csv' and label = 'spring.csv' from public.job_imports), 'the batch is recorded');
select pg_temp.ok((select bool_and(status = 'tracked' and calendar_status = 'deleted' and contact_ids = '{}' and sequence_id is null and import_id is not null)
                     from public.bookings where import_id is not null), 'imported jobs are track-only: no contacts, no sequence, no calendar event');
select pg_temp.ok((select picture_day = date '2027-09-20' and time_set and end_set and duration_min = 360 and location = 'Brewer HS'
                          and to_char(start_at at time zone 'America/New_York', 'HH24:MI') = '08:00' and title_label = 'School Photos'
                     from public.bookings where org_id = '00000000-0000-0000-0000-0000000000c2' and import_id is not null), 'one-day job: date, times, place, default title');
select pg_temp.ok(not exists (select 1 from public.booking_days d join public.bookings b on b.id = d.booking_id where b.org_id = '00000000-0000-0000-0000-0000000000c2' and b.import_id is not null),
                  'a one-day job has no day rows (like any tracked job)');
select pg_temp.ok((select picture_day = date '2027-04-24' and not time_set from public.bookings where org_id = '00000000-0000-0000-0000-0000000000c1' and import_id is not null),
                  'two-day job: the first date is the picture day');
select pg_temp.ok((select count(*) = 2 and bool_and(d.calendar_status = 'deleted') and min(d.label) = 'Majors'
                          and max(to_char(d.start_at at time zone 'America/New_York', 'HH24:MI')) = '09:00'
                     from public.booking_days d join public.bookings b on b.id = d.booking_id where b.org_id = '00000000-0000-0000-0000-0000000000c1' and b.import_id is not null),
                  'both days are stored, never for the calendar');

-- ---------------------------------------------------------------- multi-day changes
create temp table ids as select (select id from public.bookings where org_id = '00000000-0000-0000-0000-0000000000c1' and import_id is not null) as two_day,
                                (select id from public.bookings where org_id = '00000000-0000-0000-0000-0000000000c2' and import_id is not null) as school;
grant select on ids to authenticated;
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.jobsetup_set_days((select two_day from ids),
                   '[{"day":"2027-04-24","start_time":"09:00","end_time":"12:00"},{"day":"2027-04-25"},{"day":"2027-05-01","label":"Rain date"}]') ->> 'ok')::boolean, 'set three dates on a tracked job');
reset role;
select pg_temp.ok((select count(*) filter (where not removed) = 3 and bool_and(d.calendar_status = 'deleted')
                     from public.booking_days d join public.bookings b on b.id = d.booking_id where b.org_id = '00000000-0000-0000-0000-0000000000c1' and b.import_id is not null), 'three days now');
select pg_temp.ok((select time_set and end_set and duration_min = 180 from public.bookings where org_id = '00000000-0000-0000-0000-0000000000c1' and import_id is not null), 'first day carries the time');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.jobsetup_set_days((select two_day from ids), '[{"day":"2027-04-25"}]');
reset role;
select pg_temp.ok((select count(*) filter (where not removed) = 0 and picture_day = date '2027-04-25'
                     from public.bookings b left join public.booking_days d on d.booking_id = b.id where b.org_id = '00000000-0000-0000-0000-0000000000c1' and b.import_id is not null
                     group by b.picture_day), 'back to one day: day rows set aside, picture day moved');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.jobsetup_set_days('00000000-0000-0000-0000-0000000000b1', '[{"day":"2026-04-25"}]')$$, 'a booked/done job changes dates through Edit booking only');
select pg_temp.raises($$select public.jobsetup_set_days((select school from ids), '[]')$$, 'a job needs a date');
select pg_temp.act('00000000-0000-0000-0000-0000000000e2');
select pg_temp.raises($$select public.jobsetup_set_days((select school from ids), '[{"day":"2027-09-21"}]')$$, 'view cannot change dates');

-- ---------------------------------------------------------------- copy last season forward
select pg_temp.act('00000000-0000-0000-0000-0000000000e2');
create temp table c as select x from jsonb_array_elements(public.jobsetup_copy_candidates('2026-03-01', '2026-06-30', 364)) x;
select pg_temp.ok((select count(*) = 2 from c), 'last spring: the booked weekend and the GotPhoto-only job');
select pg_temp.ok((select x->'days'->0->>'day' = '2027-04-24' and x->'days'->1->>'day' = '2027-04-25' and x->'days'->1->>'start_time' = '10:00'
                          and x->'days'->1->>'label' = 'Minors' and x->>'duplicate_of' is not null
                     from c where x->>'source' = 'booking'), 'the weekend moves 52 weeks (same weekdays), keeps times and labels, and sees the imported job on those dates');
select pg_temp.ok((select x->>'org_id' = '00000000-0000-0000-0000-0000000000c1' and x->'days'->0->>'day' = '2027-05-01' and x->>'title_label' = 'Spring Sports'
                          and x->>'type_key' = 'sports_data' and x->>'duplicate_of' is null
                     from c where x->>'source' = 'gotphoto'), 'the GotPhoto job gets its organization, type and title guessed');
select pg_temp.ok(jsonb_array_length(public.jobsetup_copy_candidates('2026-09-01', '2026-10-31', 364)) = 1, 'fall: only the GotPhoto job (cancelled and other seasons left out)');

select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
create temp table r3 as select public.jobsetup_import('copy', 'Mar 1 - Jun 30, 2026 + 52 weeks', (select jsonb_agg(x) from c), false) as j;
reset role;
select pg_temp.ok((select (j->>'added')::int = 1 and (j->>'skipped')::int = 1 from r3), 'copy adds the GotPhoto job, skips the weekend already imported');
select pg_temp.ok((select copied_from_job = 'zz-gp-1' and gotphoto_job_id is null and status = 'tracked' and import_id = (select (j->>'import_id')::uuid from r3)
                     from public.bookings where copied_from_job is not null), 'the copy remembers its source and has no GotPhoto job of its own');
select pg_temp.act('00000000-0000-0000-0000-0000000000e2');
select pg_temp.ok((select x->>'copied_already' is not null from jsonb_array_elements(public.jobsetup_copy_candidates('2026-03-01', '2026-06-30', 364)) x where x->>'source' = 'gotphoto'),
                  'listing again shows it was copied already');

-- one job: the Copy button
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
create temp table r4 as select public.jobsetup_copy_one('00000000-0000-0000-0000-0000000000b1', 378) as j;
reset role;
select pg_temp.ok((select (j->>'ok')::boolean and j->'days'->0->>'day' = '2027-05-08' and jsonb_array_length(j->'days') = 2 from r4), 'copy one job 54 weeks on, both days');
select pg_temp.ok((select copied_from = '00000000-0000-0000-0000-0000000000b1' and location = 'Hampden Field' and title_label = 'Spring Sports'
                     from public.bookings where id = (select (j->>'id')::uuid from r4)), 'the copy keeps place and title');

-- ---------------------------------------------------------------- undo
update public.bookings set status = 'booked' where org_id = '00000000-0000-0000-0000-0000000000c2' and import_id is not null;  -- booked meanwhile
create temp table imp as select id from public.job_imports where kind = 'csv';
grant select on imp to authenticated;
select pg_temp.act('00000000-0000-0000-0000-0000000000e2');
select pg_temp.raises($$select public.jobsetup_undo((select id from imp))$$, 'view cannot undo');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((select (x->>'cancelled')::int = 1 and (x->>'kept')::int = 1 from (select public.jobsetup_undo((select id from imp)) x) y),
                  'undo sets aside the still-tracked job and keeps the one that was booked');
select pg_temp.ok((select (h->>'cancelled')::int = 1 and (h->>'booked')::int = 1 and h->>'undone_at' is not null
                     from jsonb_array_elements(public.jobsetup_history()) h where h->>'kind' = 'csv'), 'history shows what became of the batch');
reset role;
select pg_temp.ok(not exists (select 1 from public.booking_days d join public.bookings b on b.id = d.booking_id
                                where b.import_id is not null and d.calendar_status <> 'deleted'), 'no Season setup day is ever queued for the calendar');

select 'ALL SEASON SETUP TESTS PASSED';
rollback;
