-- Tests for 20261024100000_booking_make_real_new_jobs (hand-made calendar jobs become bookings).
-- Run against a NON-production copy of the schema with 20261024080000, 090000 and 100000 applied, in a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/booking_make_real_new_jobs_test.sql
-- "ALL NEW-JOB TESTS PASSED" at the end means every check held.

begin;

create function pg_temp.act(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
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

-- ---------------------------------------------------------------- setup (as postgres)
insert into t_access values ('00000000-0000-0000-0000-0000000000a1', true), ('00000000-0000-0000-0000-0000000000b2', false)
  on conflict (uid) do update set can_edit = excluded.can_edit;
insert into booking_settings (id, sending_enabled) values (true, true) on conflict (id) do nothing;
insert into booking_types (key, label, audience) values ('zz_sports', 'Sports: Parent Contacts', 'sports');
insert into job_type_rules (job_type, comm_workflow) values ('zz_sport_other', 'league');
insert into booking_sequences (id, type_key, name) values ('00000000-0000-0000-0000-00000000005e', 'zz_sports', 'test');
insert into booking_steps (sequence_id, step_no, kind, hub_key, trigger, offset_days, send_time, covered_by_gotphoto, subject, body_md) values
  ('00000000-0000-0000-0000-00000000005e', 1,  'admin', null,    'picture_day', 0,  '07:30', false, 'Start here', 'x'),
  ('00000000-0000-0000-0000-00000000005e', 2,  'admin', null,    'picture_day', 14, '07:30', false, 'Picture day plan', 'starts {{start_time}}'),
  ('00000000-0000-0000-0000-00000000005e', 10, 'hub',   'heads', 'picture_day', 8,  '18:00', false, 'One week', 'x'),
  ('00000000-0000-0000-0000-00000000005e', 14, 'admin', null,    'picture_day', 5,  '07:30', false, 'Families haven''t heard yet', 'x'),
  ('00000000-0000-0000-0000-00000000005e', 11, 'hub',   'day',   'picture_day', 2,  '18:00', true,  'Day before', 'x'),
  ('00000000-0000-0000-0000-00000000005e', 12, 'hub',   'live',  'gallery_live', 0, '07:30', false, 'Gallery live', 'x'),
  ('00000000-0000-0000-0000-00000000005e', 20, 'coach', null,    'picture_day', 2,  '07:30', false, 'Coach checklist', 'x');
update booking_steps set send_if = '{hub_not_sent}' where sequence_id = '00000000-0000-0000-0000-00000000005e' and step_no = 14;
insert into prospect_orgs (id, name) values ('00000000-0000-0000-0000-0000000000f1', 'Zz Pioneers Hockey'), ('00000000-0000-0000-0000-0000000000f2', 'Zz Midcoast Rec');
insert into prospect_contacts (id, org_id, first_name, email, is_primary, bounced_at) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'Jen', 'jen@zz.test', true, null),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f1', 'Bad', 'bad@zz.test', false, now()),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f2', 'Jesse', 'jesse@zz.test', false, null);
insert into synced_jobs (gotphoto_job_id, name, job_type, access_type, status, shoot_at, roster_loaded_at) values
  ('zz1', 'Zz Pioneers | Winter', 'zz_sport_other', 'codes', 'published', now() + interval '17 days', null),
  ('zz2', 'Zz Midcoast | Winter', 'zz_sport_other', 'codes', 'published', now() + interval '6 days', now());
insert into calendar_events (google_event_id, summary, start_date, end_date, start_at, end_at) values
  ('zzev1@google.com', 'Zz Pioneers • Hockey', current_date + 17, current_date + 17,
   ((current_date + 17) + time '15:00') at time zone 'America/New_York', ((current_date + 17) + time '16:00') at time zone 'America/New_York'),
  ('zzev9@google.com', 'Somebody else • Soccer', current_date + 17, current_date + 17,
   ((current_date + 17) + time '10:00') at time zone 'America/New_York', ((current_date + 17) + time '11:00') at time zone 'America/New_York');
insert into bookings (id, org_id, type_key, picture_day, start_at, end_at, gotphoto_job_id, calendar_status, status, time_set, end_set) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'zz_sports', current_date + 17, now(), now(), 'zz1', 'deleted', 'tracked', false, false),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000f2', 'zz_sports', current_date + 6,  now(), now(), 'zz2', 'deleted', 'tracked', false, false),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000f2', 'zz_sports', current_date - 3,  now(), now(), null,  'deleted', 'tracked', false, false);
delete from net.q;

-- ---------------------------------------------------------------- a calendar-only job: Start here still goes, three days, no start time
update synced_jobs set shoot_at = now() + interval '17 days' where gotphoto_job_id = 'zz1';
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
create temp table nj as select public.booking_make_real('00000000-0000-0000-0000-0000000000d1',
  jsonb_build_object('contact_ids', '["00000000-0000-0000-0000-0000000000c1"]'::jsonb, 'google_event_id', 'zzev1', 'start_here_sent', false,
    'days', jsonb_build_array(jsonb_build_object('day', current_date + 17), jsonb_build_object('day', current_date + 18, 'google_event_id', 'zzday2@google.com'), jsonb_build_object('day', current_date + 20)))) j;
reset role;
select pg_temp.ok((select (j->>'ok')::boolean from nj), 'converted with no start time');
select pg_temp.ok((select status = 'booked' and not time_set and picture_day = current_date + 17 from bookings where id = '00000000-0000-0000-0000-0000000000d1'), 'booked, first day is the picture day, time not set');
select pg_temp.ok((select count(*) = 3 from booking_days where booking_id = '00000000-0000-0000-0000-0000000000d1' and not removed), 'three picture days');
select pg_temp.ok(not exists (select 1 from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d1' and reason like 'Not needed%'), 'nothing marked as sent from 17hats');
select pg_temp.ok((select status = 'scheduled' and send_at > now() and send_at < now() + interval '1 hour' from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d1' and step_no = 1), 'Start here goes out shortly');
select pg_temp.ok((select status = 'waiting' and reason like 'needs the start time%' from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d1' and step_no = 2), 'the plan email (mentions the time) waits for the start time');
select pg_temp.ok((select count(*) = 3 from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d1' and step_no = 11), 'a day-before nudge per night');
select pg_temp.ok((select google_event_id = 'zzday2' and calendar_status = 'synced' from booking_days where booking_id = '00000000-0000-0000-0000-0000000000d1' and day = current_date + 18), 'day 2 linked to its own calendar event');
select pg_temp.ok((select calendar_status = 'pending' and google_event_id is null from booking_days where booking_id = '00000000-0000-0000-0000-0000000000d1' and day = current_date + 20), 'a day with no event gets one made');

-- ---------------------------------------------------------------- a second booking sharing that event: no calendar at all
insert into bookings (id, org_id, type_key, picture_day, start_at, end_at, gotphoto_job_id, calendar_status, status, time_set, end_set) values
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000f1', 'zz_sports', current_date + 17, now(), now(), null, 'deleted', 'tracked', false, false);
delete from net.q;
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.booking_make_real('00000000-0000-0000-0000-0000000000d4', '{"contact_ids":["00000000-0000-0000-0000-0000000000c1"],"google_event_id":"zzev1"}')$$, 'the shared event cannot be linked twice');
select public.booking_make_real('00000000-0000-0000-0000-0000000000d4', '{"contact_ids":["00000000-0000-0000-0000-0000000000c1"],"start_time":"12:00","no_calendar":true,"start_here_sent":false}');
reset role;
select pg_temp.ok((select calendar_status = 'deleted' and google_event_id is null from bookings where id = '00000000-0000-0000-0000-0000000000d4')
                  and not exists (select 1 from booking_days where booking_id = '00000000-0000-0000-0000-0000000000d4' and calendar_status <> 'deleted')
                  and not exists (select 1 from net.q where url like '%calendar-write%'), 'no_calendar: no event made, no calendar-write call');

-- ---------------------------------------------------------------- the default is unchanged: Start here counts as sent
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select public.booking_make_real('00000000-0000-0000-0000-0000000000d2', '{"contact_ids":["00000000-0000-0000-0000-0000000000c3"],"start_time":"15:30"}');
reset role;
select pg_temp.ok((select status = 'skipped' and reason like 'Not needed:%' from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d2' and step_no = 1), 'without start_here_sent, Start here is still skipped');

\echo ALL NEW-JOB TESTS PASSED
rollback;
