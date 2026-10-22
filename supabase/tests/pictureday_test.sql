-- Tests for 20261022213500_picture_day_planner. Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/pictureday_test.sql
-- "ALL PICTURE DAY TESTS PASSED" at the end means every check held.

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

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'), ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000c1', 'View One', true),
  ('00000000-0000-0000-0000-0000000000d1', 'No Planner', true);
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'pictureday', 'edit'), ('00000000-0000-0000-0000-0000000000c1', 'pictureday', 'view');

insert into public.prospect_orgs (id, name) values ('00000000-0000-0000-0000-00000000f001', 'Hampden Youth Soccer');
insert into public.prospect_contacts (id, org_id, first_name, last_name, email, is_primary) values
  ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000f001', 'Dana', 'President', 'dana@hys.example.org', true);
insert into public.prospect_contacts (id, org_id, first_name, email, bounced_at) values
  ('00000000-0000-0000-0000-00000000c0a2', '00000000-0000-0000-0000-00000000f001', 'Gone', 'gone@hys.example.org', now());
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, location, contact_ids, status, time_set) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000f001', (select key from public.booking_types order by 1 limit 1), 'Spring Sports',
   current_date + 20, (current_date + 20 + time '09:00') at time zone 'America/New_York', (current_date + 20 + time '13:00') at time zone 'America/New_York',
   'Hampden Fields, 1 Main Rd', array['00000000-0000-0000-0000-00000000c0a1'::uuid], 'booked', true),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000f001', (select key from public.booking_types order by 1 limit 1), 'Fall Sports',
   current_date + 30, now() + interval '30 days', now() + interval '30 days 1 hour', '', '{}', 'tracked', false),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000f001', (select key from public.booking_types order by 1 limit 1), 'Winter Sports',
   current_date + 40, now() + interval '40 days', now() + interval '40 days 1 hour', '', '{}', 'booked', false),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000f001', (select key from public.booking_types order by 1 limit 1), 'Last Year',
   current_date - 3, now() - interval '3 days', now() - interval '3 days' + interval '1 hour', '', '{}', 'booked', false);
update public.booking_settings set sending_enabled = false, test_mode = false, quiet_start = '23:59', quiet_end = '23:59';

select pg_temp.ok((select status from public.app_modules where key = 'pictureday') = 'live', 'pictureday module is live');
select pg_temp.ok((select count(*) from public.push_topics where module = 'pictureday') = 2, 'two notification kinds for the planner');

-- ---------------------------------------------------------------- access
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.pd_list()$$, 'n1: cannot list picture days');
select pg_temp.raises($$select public.pd_get('00000000-0000-0000-0000-0000000000b1')$$, 'n1: cannot open one');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(public.pd_get('00000000-0000-0000-0000-0000000000b1') -> 'plan' = 'null'::jsonb, 'v1: opening does not create a plan (view only)');
select pg_temp.raises($$select public.pd_save_team((select id from public.pd_plans limit 1), '{"name":"x"}')$$, 'v1: cannot add teams');
select pg_temp.ok(jsonb_array_length(public.pd_list()) = 3, 'v1: lists booked picture days from a week ago on (not tracked)');

-- ---------------------------------------------------------------- staff: open, send the form
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(public.pd_get('00000000-0000-0000-0000-0000000000b1') -> 'plan' ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1', 'e1: opening creates the plan');
select pg_temp.ok(public.pd_get('00000000-0000-0000-0000-0000000000b2') -> 'plan' = 'null'::jsonb, 'e1: a tracked job gets no plan');
select pg_temp.ok(jsonb_array_length(public.pd_get('00000000-0000-0000-0000-0000000000b1') -> 'contacts') = 1, 'contacts leave out bounced addresses');
select pg_temp.raises($$select public.pd_send_intake((select id from public.pd_plans where booking_id = '00000000-0000-0000-0000-0000000000b1'), null, 'not-an-email')$$, 'e1: the form needs a real address');
select pg_temp.ok((public.pd_send_intake((select id from public.pd_plans where booking_id = '00000000-0000-0000-0000-0000000000b1'), '00000000-0000-0000-0000-00000000c0a1') ->> 'to') = 'dana@hys.example.org', 'e1: form queued to the contact');
reset role;
select pg_temp.ok((select status from public.pd_emails where kind = 'intake') = 'waiting', 'sending is off: the form waits');
select pg_temp.ok((select request_id is null from public.pd_emails where kind = 'intake'), 'nothing went to Resend');
select pg_temp.ok((select body_text from public.pd_emails where kind = 'intake') like '%admin.207photo.com/#plan/' || (select token from public.pd_plans where booking_id = '00000000-0000-0000-0000-0000000000b1') || '%', 'the form email carries the form link');
select pg_temp.ok((select body_text from public.pd_emails where kind = 'intake') like 'Hi Dana,%', 'the form email greets the contact by first name');

-- ---------------------------------------------------------------- the organization fills in the form
create temp table tok as select token from public.pd_plans where booking_id = '00000000-0000-0000-0000-0000000000b1';
grant select on tok to anon, authenticated;
select pg_temp.act(null);
select pg_temp.raises($$select count(*) from public.pd_plans$$, 'anon: no table access');
select pg_temp.raises($$select public.pd_list()$$, 'anon: cannot list');
select pg_temp.ok(public.pd_public_plan('nope') is null and public.pd_public_plan(repeat('0', 36)) is null, 'anon: unknown links show nothing');
select pg_temp.ok(public.pd_public_plan((select token from tok)) ->> 'org_name' = 'Hampden Youth Soccer', 'anon: the form shows the organization');
select pg_temp.raises($$select public.pd_public_submit((select token from tok), '{"teams":[{"name":"U10 Blue","coach_email":"bad@"}]}')$$, 'anon: a bad coach email is refused');
select pg_temp.ok((public.pd_public_submit((select token from tok), jsonb_build_object(
  'onsite_name', 'Dana', 'onsite_phone', '207-555-0100', 'location', 'Hampden Fields', 'fields', jsonb_build_array('Field 1', 'Field 2', 'field 1', ' '),
  'uniforms', 'Game jerseys', 'props', 'One ball per team', 'notes', 'Rain date Sunday',
  'teams', jsonb_build_array(
    jsonb_build_object('name', 'U10 Blue', 'coach_name', 'Sam Coach', 'coach_email', 'SAM@example.org', 'players', '12'),
    jsonb_build_object('name', 'U10 Red', 'coach_name', 'Alex Coach', 'coach_email', 'alex@example.org', 'players', 11),
    jsonb_build_object('name', 'U12 Green', 'coach_name', 'Pat', 'coach_email', ''),
    jsonb_build_object('name', '  ')))) ->> 'teams')::int = 3, 'anon: form saved with 3 teams (blank names skipped)');
reset role;
select pg_temp.ok((select fields from public.pd_plans where token = (select token from tok)) = array['Field 1', 'Field 2'], 'fields are trimmed and de-duplicated');
select pg_temp.ok((select submitted_at is not null from public.pd_plans where token = (select token from tok)), 'form marked as in');
select pg_temp.ok((select coach_email from public.pd_teams where name = 'U10 Blue') = 'sam@example.org', 'coach emails are lower-cased');
select pg_temp.ok((select count(*) from public.push_log where topic = 'pd_intake') = 1, 'a push notification says the form is in');
select pg_temp.act(null);
-- sending again without U12 Green removes it (no coach was told anything yet)
select public.pd_public_submit((select token from tok), public.pd_public_plan((select token from tok)) || jsonb_build_object(
  'teams', (select jsonb_agg(t) from jsonb_array_elements(public.pd_public_plan((select token from tok)) -> 'teams') t where t ->> 'name' <> 'U12 Green')));
reset role;
select pg_temp.ok((select count(*) from public.pd_teams where removed_at is null) = 2, 'a team left off the form is removed');

-- ---------------------------------------------------------------- staff lay out slots and email coaches
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
create temp table ids as select (select id from public.pd_plans where booking_id = '00000000-0000-0000-0000-0000000000b1') plan_id,
  (select id from public.pd_teams where name = 'U10 Blue') blue, (select id from public.pd_teams where name = 'U10 Red') red;
select public.pd_save_team((select plan_id from ids), '{"name":"U8 Gold","coach_name":"No Email"}');
select pg_temp.ok((public.pd_save_slots((select plan_id from ids), jsonb_build_array(
  jsonb_build_object('id', (select blue from ids), 'field', 'Field 1', 'slot_at', (current_date + 20 + time '09:00') at time zone 'America/New_York'),
  jsonb_build_object('id', (select red from ids), 'field', 'Field 2', 'slot_at', (current_date + 20 + time '09:00') at time zone 'America/New_York'),
  jsonb_build_object('id', (select id from public.pd_teams where name = 'U8 Gold'), 'field', 'Field 1', 'slot_at', (current_date + 20 + time '09:10') at time zone 'America/New_York')))
  ->> 'saved')::int = 3, 'e1: slots saved');
select pg_temp.ok(public.pd_slot_preview((select blue from ids)) ->> 'subject' like 'U10 Blue: picture day % at 9:00 AM', 'preview: subject has the team and time');
select pg_temp.ok(public.pd_slot_preview((select blue from ids)) ->> 'text' like '%Where: Hampden Fields, Field 1%Uniforms: Game jerseys%Bring: One ball per team%', 'preview: where, uniforms, props');
select pg_temp.ok((public.pd_send_slots((select plan_id from ids)) ->> 'queued')::int = 2, 'e1: emails the two coaches with an address');
select pg_temp.ok((public.pd_send_slots((select plan_id from ids)) ->> 'queued')::int = 0, 'sending again: nobody new');
reset role;
select pg_temp.ok((select count(*) from public.pd_emails where kind = 'slot' and status = 'waiting') = 2, 'switch off: coach emails wait');

-- switch on: everything waiting goes, booked jobs only
insert into public.pd_plans (id, booking_id) values ('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000b2');
insert into public.pd_emails (plan_id, kind, to_email, subject, body_text, body_html) values ('00000000-0000-0000-0000-00000000aaa2', 'intake', 'x@example.org', 's', 't', 'h');
update public.booking_settings set sending_enabled = true, reply_to = 'info@207photo.com', bcc = 'archive@207photo.com';
select pg_temp.ok(public.pd_send_waiting() = 3, 'switch on: the form and both coach emails go');
select pg_temp.ok((select status from public.pd_emails where plan_id = '00000000-0000-0000-0000-00000000aaa2') = 'waiting', 'a tracked job''s email never goes');
select pg_temp.ok((select count(*) from net.requests where body -> 'to' ->> 0 = 'sam@example.org' and body ->> 'reply_to' = 'info@207photo.com'
                    and body ->> 'from' = 'Jeremiah Mutty <jmutty@207photo.com>' and body -> 'bcc' ->> 0 = 'archive@207photo.com') = 1, 'Resend: to the coach, from the booking sender, reply-to and bcc');
-- Resend refuses one
insert into net._http_response (id, status_code, content) select request_id, 422, '{"message":"bad"}' from public.pd_emails where to_email = 'alex@example.org';
insert into net._http_response (id, status_code, content) select request_id, 200, '{}' from public.pd_emails where to_email = 'sam@example.org';
select public.pd_send_waiting();
select pg_temp.ok((select status from public.pd_emails where to_email = 'alex@example.org') = 'failed', 'a refused send shows as failed');
select pg_temp.ok((select status from public.pd_emails where to_email = 'sam@example.org') = 'sent', 'an accepted send stays sent');
-- quiet hours
update public.booking_settings set quiet_start = ((now() at time zone 'America/New_York') - interval '1 hour')::time, quiet_end = ((now() at time zone 'America/New_York') + interval '1 hour')::time;
insert into public.pd_emails (plan_id, kind, to_email, subject, body_text, body_html) values ((select plan_id from ids), 'intake', 'q@example.org', 's', 't', 'h');
select pg_temp.ok(public.pd_send_waiting() = 0, 'quiet hours: nothing goes');
-- test mode
update public.booking_settings set quiet_start = '23:59', quiet_end = '23:59', test_mode = true, test_recipient = 'me@207photo.com';
select pg_temp.ok(public.pd_send_waiting() = 1, 'test mode: it goes');
select pg_temp.ok((select sent_to from public.pd_emails where to_email = 'q@example.org') = 'me@207photo.com', 'test mode: to the test address');
select pg_temp.ok((select body ->> 'subject' from net.requests order by id desc limit 1) like '[TEST] %' and (select not (body ? 'bcc') from net.requests order by id desc limit 1), 'test mode: [TEST] subject, no bcc');
update public.booking_settings set test_mode = false;
-- a bounced address is never sent to
insert into public.pd_emails (plan_id, kind, to_email, subject, body_text, body_html) values ((select plan_id from ids), 'intake', 'gone@hys.example.org', 's', 't', 'h');
select public.pd_send_waiting();
select pg_temp.ok((select status from public.pd_emails where to_email = 'gone@hys.example.org') = 'failed', 'a bounced address fails instead of sending');

-- ---------------------------------------------------------------- the coach answers
create temp table ctok as select token from public.pd_teams where name = 'U10 Blue';
grant select on ctok to anon;
select pg_temp.act(null);
select pg_temp.ok(public.pd_public_slot((select token from ctok)) ->> 'team' = 'U10 Blue', 'coach: sees the team');
select pg_temp.ok(public.pd_public_slot((select token from ctok)) ->> 'field' = 'Field 1', 'coach: sees the field');
select pg_temp.raises($$select token from public.pd_teams$$, 'anon: cannot read pd_teams to find tokens');
select pg_temp.raises($$select public.pd_public_slot_reply((select token from ctok), 'move', '')$$, 'coach: moving needs a note');
select public.pd_public_slot_reply((select token from ctok), 'move', 'After 10 works better');
reset role;
select pg_temp.ok((select status from public.pd_teams where name = 'U10 Blue') = 'move', 'coach asked to move');
select pg_temp.ok((select count(*) from public.push_log where topic = 'pd_move') = 1, 'a push notification says a coach wants to move');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.pd_attention() ->> 'move')::int = 1, 'Today: one coach wants to move');
select pg_temp.act(null);
select public.pd_public_slot_reply((select token from ctok), 'confirm');
reset role;
select pg_temp.ok((select status from public.pd_teams where name = 'U10 Blue') = 'confirmed', 'coach confirmed');
-- staff move the team: it shows as changed and only it is emailed again
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.pd_save_slots((select plan_id from ids), jsonb_build_array(jsonb_build_object('id', (select blue from ids), 'field', 'Field 1', 'slot_at', (current_date + 20 + time '10:20') at time zone 'America/New_York')));
select pg_temp.ok((select (x ->> 'changed')::int from jsonb_array_elements(public.pd_list()) x where x ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1') = 1, 'list: one team changed since its email');
select pg_temp.ok((public.pd_send_slots((select plan_id from ids)) ->> 'queued')::int = 1, 'only the changed team is emailed again');
select pg_temp.ok((select status from public.pd_teams where name = 'U10 Blue') = 'sent', 'a new time asks the coach again');
-- remove a team: its waiting email is cancelled
reset role;
update public.booking_settings set sending_enabled = false;
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.pd_send_slots((select plan_id from ids), array[(select red from ids)]);
select public.pd_remove_team((select red from ids));
reset role;
select pg_temp.ok((select status from public.pd_emails where team_id = (select red from ids) order by id desc limit 1) = 'cancelled', 'removing a team cancels its waiting email');

-- ---------------------------------------------------------------- roster upload
select pg_temp.act(null);
insert into storage.objects (bucket_id, name) values ('pictureday', (select token from tok) || '/roster.csv');
select pg_temp.raises($$insert into storage.objects (bucket_id, name) values ('pictureday', repeat('a', 36) || '/x.csv')$$, 'anon: cannot upload without a real link');
select pg_temp.raises($$insert into storage.objects (bucket_id, name) values ('pictureday', (select token from tok) || '/a/b.csv')$$, 'anon: no sub-folders');
select public.pd_public_roster((select token from tok), (select token from tok) || '/roster.csv', 'Roster.csv');
select pg_temp.ok(not exists (select 1 from storage.objects where bucket_id = 'pictureday'), 'anon: cannot read rosters back');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((select count(*) from storage.objects where bucket_id = 'pictureday') = 1, 'v1: can read the roster');
select pg_temp.ok((select roster_name from public.pd_plans where booking_id = '00000000-0000-0000-0000-0000000000b1') = 'Roster.csv', 'roster recorded on the plan');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.ok((select count(*) from public.pd_plans) = 0 and (select count(*) from storage.objects where bucket_id = 'pictureday') = 0, 'n1: sees no plans and no rosters');

-- ---------------------------------------------------------------- closed forms
reset role;
insert into public.pd_plans (booking_id) values ('00000000-0000-0000-0000-0000000000b4');
create temp table oldtok as select token from public.pd_plans where booking_id = '00000000-0000-0000-0000-0000000000b4';
grant select on oldtok to anon;
select pg_temp.act(null);
select pg_temp.ok((public.pd_public_plan((select token from oldtok)) ->> 'closed')::boolean, 'a past picture day shows as closed');
select pg_temp.raises($$select public.pd_public_submit((select token from oldtok), '{"teams":[]}')$$, 'a past picture day refuses the form');
select pg_temp.raises($$select public.pd_public_roster((select token from oldtok), (select token from oldtok) || '/r.csv', 'r.csv')$$, 'a past picture day refuses a roster');

reset role;
do $$ begin raise notice 'ALL PICTURE DAY TESTS PASSED'; end $$;
rollback;
