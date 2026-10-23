-- Tests for 20261024090000_booking_make_real (track-only jobs become real bookings, moving off 17hats).
-- Run against a NON-production copy of the schema with 20261024080000 and 20261024090000 applied, in a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/booking_make_real_test.sql
-- "ALL MAKE-REAL TESTS PASSED" at the end means every check held.

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

-- ---------------------------------------------------------------- suggest
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
create temp table sg as select public.booking_make_real_suggest('00000000-0000-0000-0000-0000000000d1') j;
select pg_temp.ok((select jsonb_array_length(j->'contacts') = 2 and (j->'contacts'->0->>'email') = 'jen@zz.test' and (j->'contacts'->1->>'usable')::boolean = false from sg), 'suggest: contacts, primary first, bounced one marked unusable');
select pg_temp.ok((select (j->'events'->0->>'id') = 'zzev1' and (j->'events'->0->>'start_time') = '15:00' and (j->'events'->0->>'matches')::boolean from sg), 'suggest: the calendar event naming the organization comes first, bare id, local time');
select pg_temp.ok((select jsonb_array_length(j->'steps') = 2 and (j->'steps'->1->>'step_no') = '1' and not (j->'steps'->0->>'passed')::boolean from sg), 'suggest: the director steps 17hats could have sent (not the adaptive ones), with send day');

-- ---------------------------------------------------------------- dry run changes nothing
create temp table dr as select public.booking_make_real('00000000-0000-0000-0000-0000000000d1',
  '{"contact_ids":["00000000-0000-0000-0000-0000000000c1"],"start_time":"15:00","end_time":"16:00","google_event_id":"zzev1"}', true) j;
select pg_temp.ok((select (j->>'dry_run')::boolean from dr), 'dry run says so');
select pg_temp.ok((select exists (select 1 from jsonb_array_elements(j->'emails') e where e->>'step_no' = '1' and e->>'status' = 'skipped' and e->>'reason' like 'Not needed: already sent from 17hats%') from dr), 'dry run: Start here shows as already sent from 17hats');
select pg_temp.ok((select exists (select 1 from jsonb_array_elements(j->'emails') e where e->>'step_no' = '2' and e->>'status' = 'scheduled'
                     and (e->>'send_at')::timestamptz = ((current_date + 3) + time '07:30') at time zone 'America/New_York') from dr), 'dry run: the picture day plan is scheduled 14 days out');
reset role;
select pg_temp.ok((select status = 'tracked' and sequence_id is null from bookings where id = '00000000-0000-0000-0000-0000000000d1'), 'dry run: the job is still track-only');
select pg_temp.ok(not exists (select 1 from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d1') and not exists (select 1 from booking_days where booking_id = '00000000-0000-0000-0000-0000000000d1') and not exists (select 1 from net.q), 'dry run: no emails, days or calls left behind');

-- ---------------------------------------------------------------- refusals
select pg_temp.act('00000000-0000-0000-0000-0000000000b2');
select pg_temp.raises($$select public.booking_make_real('00000000-0000-0000-0000-0000000000d1', '{"contact_ids":["00000000-0000-0000-0000-0000000000c1"],"start_time":"15:00"}')$$, 'view-only staff cannot convert');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.booking_make_real('00000000-0000-0000-0000-0000000000d1', '{"contact_ids":["00000000-0000-0000-0000-0000000000c2"],"start_time":"15:00"}')$$, 'a bounced contact alone is refused');
select pg_temp.raises($$select public.booking_make_real('00000000-0000-0000-0000-0000000000d1', '{"contact_ids":["00000000-0000-0000-0000-0000000000c3"],"start_time":"15:00"}')$$, 'a contact of another organization is refused');
select pg_temp.raises($$select public.booking_make_real('00000000-0000-0000-0000-0000000000d1', '{"contact_ids":["00000000-0000-0000-0000-0000000000c1"]}')$$, 'no start time is refused');
select pg_temp.raises($$select public.booking_make_real('00000000-0000-0000-0000-0000000000d3', '{"contact_ids":["00000000-0000-0000-0000-0000000000c3"],"start_time":"15:00"}')$$, 'a past job stays track-only');
select pg_temp.act(null);
select pg_temp.raises($$select public.booking_make_real_suggest('00000000-0000-0000-0000-0000000000d1')$$, 'anon cannot read suggestions');

-- ---------------------------------------------------------------- the real thing, with the calendar event
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select public.booking_make_real('00000000-0000-0000-0000-0000000000d1',
  '{"contact_ids":["00000000-0000-0000-0000-0000000000c1"],"start_time":"15:00","end_time":"16:00","google_event_id":"zzev1@google.com"}');
reset role;
select pg_temp.ok((select status = 'booked' and sequence_id = '00000000-0000-0000-0000-00000000005e' and time_set and google_event_id = 'zzev1' and calendar_status = 'synced'
                     and start_at = ((current_date + 17) + time '15:00') at time zone 'America/New_York' from bookings where id = '00000000-0000-0000-0000-0000000000d1'), 'booked, on the sequence, 3:00 start, existing event linked');
select pg_temp.ok(not exists (select 1 from net.q where url like '%calendar-write%'), 'no calendar-write call: no second event');
select pg_temp.ok((select count(*) = 1 from booking_days where booking_id = '00000000-0000-0000-0000-0000000000d1'), 'one booking day');
select pg_temp.ok((select status = 'skipped' and reason = 'Not needed: already sent from 17hats' from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d1' and step_no = 1), 'Start here: skipped as sent from 17hats');
select public.booking_reschedule('00000000-0000-0000-0000-0000000000d1');
select pg_temp.ok((select status = 'skipped' and send_at is null from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d1' and step_no = 1), 'Start here stays skipped after a reschedule (never fires later)');
select pg_temp.ok((select status = 'scheduled' and to_emails = '{jen@zz.test}' from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d1' and step_no = 2), 'picture day plan goes to the director');
select pg_temp.ok((select status = 'waiting' from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d1' and step_no = 20), 'coach checklist waits for coach emails');
select pg_temp.ok((select status = 'waiting' from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d1' and step_no = 12), 'gallery email waits for the gallery');
select pg_temp.raises($$select public.booking_make_real('00000000-0000-0000-0000-0000000000d1', '{"contact_ids":["00000000-0000-0000-0000-0000000000c1"],"start_time":"15:00"}')$$, 'a booked job cannot be converted twice');

-- ---------------------------------------------------------------- 6 days out, roster loaded, 17hats sent the plan too, no event
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.booking_make_real('00000000-0000-0000-0000-0000000000d2', '{"contact_ids":["00000000-0000-0000-0000-0000000000c3"],"start_time":"15:30","google_event_id":"zzev1"}')$$, 'an event that belongs to another booking is refused');
select public.booking_make_real('00000000-0000-0000-0000-0000000000d2',
  '{"contact_ids":["00000000-0000-0000-0000-0000000000c3"],"start_time":"15:30","sent_steps":[2]}');
reset role;
select pg_temp.ok((select status = 'skipped' and reason like 'Not needed:%' from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d2' and step_no = 2), 'a step picked as sent by 17hats is skipped as Not needed');
select pg_temp.ok((select status = 'skipped' and reason = 'send day already passed' from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d2' and step_no = 10), 'a hub nudge whose day passed is skipped');
select pg_temp.ok((select status = 'skipped' and reason like 'sent by GotPhoto%' from booking_emails where booking_id = '00000000-0000-0000-0000-0000000000d2' and step_no = 11), 'roster loaded: day-before is left to GotPhoto');
select pg_temp.ok((select calendar_status = 'pending' and google_event_id is null from bookings where id = '00000000-0000-0000-0000-0000000000d2')
                  and exists (select 1 from net.q where url like '%calendar-write%' and body->>'booking_id' = '00000000-0000-0000-0000-0000000000d2'), 'no event picked: calendar-write is asked to make one');
select pg_temp.ok(not exists (select 1 from booking_emails e join bookings b on b.id = e.booking_id where b.id in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2')
                     and e.status = 'scheduled' and e.send_at < now()), 'nothing back-dated is scheduled');

-- ---------------------------------------------------------------- roster alert wording
select pg_temp.ok(pg_get_functiondef('public.roster_alert_sweep'::regproc) not like '%17hats%', 'the no-roster alert no longer points at 17hats');

\echo ALL MAKE-REAL TESTS PASSED
rollback;
