-- Tests for 20261022235500_photocheck_shootlog. Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/photocheck_shootlog_test.sql
-- "ALL PHOTOCHECK AND SHOOT LOG TESTS PASSED" at the end means every check held.

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

-- e1 edits the check; v1 views it; c1 is crew with Shoot log view; c2 is crew on another job; n1 has nothing.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'), ('00000000-0000-0000-0000-0000000000a1', 'v1@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'c1@example.com'), ('00000000-0000-0000-0000-0000000000c2', 'c2@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000a1', 'View One', true),
  ('00000000-0000-0000-0000-0000000000c1', 'Crew One', true), ('00000000-0000-0000-0000-0000000000c2', 'Crew Two', true),
  ('00000000-0000-0000-0000-0000000000d1', 'Nobody', true);
insert into public.team_permissions values
  ('00000000-0000-0000-0000-0000000000e1', 'photocheck', 'edit'), ('00000000-0000-0000-0000-0000000000e1', 'pictureday', 'edit'),
  ('00000000-0000-0000-0000-0000000000e1', 'shootlog', 'edit'),
  ('00000000-0000-0000-0000-0000000000a1', 'photocheck', 'view'), ('00000000-0000-0000-0000-0000000000a1', 'pictureday', 'view'),
  ('00000000-0000-0000-0000-0000000000c1', 'shootlog', 'view'), ('00000000-0000-0000-0000-0000000000c2', 'shootlog', 'view');

insert into public.prospect_orgs (id, name) values ('00000000-0000-0000-0000-00000000f001', 'Hampden Academy'), ('00000000-0000-0000-0000-00000000f002', 'Hampden Youth Soccer');
insert into public.prospect_contacts (id, org_id, first_name, last_name, email, is_primary) values
  ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000f001', 'Pat', 'Principal', 'pat@ha.example.org', true);
insert into public.comm_hub_schools (id, name, picture_day, retake_day, access_code, gotphoto_job_id) values
  ('00000000-0000-0000-0000-0000000000a5', 'Hampden Academy', current_date - 2, current_date + 10, 'HA', 'JOB-S');
-- s1: school, two days ago, job through the hub. l1: league, yesterday, job on the booking. f1: next week. t1: tracked.
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, location, contact_ids, status, hub_school_id, gotphoto_job_id) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000f001', 'school', '', current_date - 2, now() - interval '2 days', now() - interval '2 days' + interval '3 hours', 'Gym', array['00000000-0000-0000-0000-00000000c0a1'::uuid], 'booked', '00000000-0000-0000-0000-0000000000a5', null),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000f002', 'sports_data', 'Fall Sports', current_date - 1, now() - interval '1 day', now() - interval '1 day' + interval '3 hours', 'Fields', '{}', 'booked', null, 'JOB-L'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000f002', 'sports_data', 'Winter Sports', current_date + 7, now() + interval '7 days', now() + interval '7 days 2 hours', 'Rink', '{}', 'booked', null, null),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000f002', 'sports_data', 'Old', current_date - 3, now() - interval '3 days', now() - interval '3 days' + interval '1 hour', '', '{}', 'tracked', null, 'JOB-T');
insert into public.booking_days (booking_id, day) values ('00000000-0000-0000-0000-0000000000b2', current_date - 1), ('00000000-0000-0000-0000-0000000000b2', current_date);
insert into public.booking_stages (id, type_key, label, sort, auto) values
  ('00000000-0000-0000-0000-00000000aa01', 'sports_data', 'Booked', 10, 'booked'), ('00000000-0000-0000-0000-00000000aa02', 'sports_data', 'Picture day done', 20, 'picture_day');
insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000000000c1', 'job', '00000000-0000-0000-0000-0000000000b2', now() - interval '1 day', now() - interval '1 day' + interval '3 hours'),
  ('00000000-0000-0000-0000-0000000000c1', 'job', '00000000-0000-0000-0000-0000000000b2', now(), now() + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000c2', 'job', '00000000-0000-0000-0000-0000000000b3', now() + interval '7 days', now() + interval '7 days 2 hours');
insert into public.synced_jobs (gotphoto_job_id, name, job_type, access_type, status) values ('JOB-S', 'Hampden Academy 2026', 'school', 'code', 'published'), ('JOB-L', 'HYS Fall', 'sports', 'code', 'published');
insert into public.synced_codes (gotphoto_password_id, gotphoto_job_id, code, subject_first, subject_last, subject_group, subject_identifier) values
  ('p1', 'JOB-S', 'aaa111', 'Ava', 'Adams', '3 - Boone', 'S100'),
  ('p2', 'JOB-S', 'BBB222', 'Ben', 'Brown', '3 - Boone', 'S101'),
  ('p3', 'JOB-S', 'CCC333', 'Cara', 'Cole', '4 - Diaz', ''),
  ('p4', 'JOB-S', 'DDD444', 'Sam', 'Lee', '3 - Boone', ''),
  ('p5', 'JOB-S', 'EEE555', 'Sam', 'Lee', '4 - Diaz', ''),
  ('p6', 'JOB-S', 'FFF666', 'Finn', 'Ford', '4 - Diaz', ''),
  ('p7', 'JOB-L', 'L1', 'Gia', 'Gray', 'U10 Blue', ''),
  ('p8', 'JOB-L', 'L2', 'Hal', 'Hart', 'U10 Blue', ''),
  ('p9', 'JOB-L', 'L3', 'Ivy', 'Irwin', 'U12 Red', '');
insert into public.pd_plans (id, booking_id) values ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000000b2');
insert into public.pd_teams (plan_id, name, coach_name, coach_email, status) values
  ('00000000-0000-0000-0000-00000000d001', 'U10 Blue', 'Coach Kim', 'kim@hys.example.org', 'confirmed'),
  ('00000000-0000-0000-0000-00000000d001', 'U12 Red', 'Coach Lou', '', 'new');
insert into public.makeup_bookings (google_event_id, parent_email, athlete_name, makeup_at, suggested_job_id) values ('ev1', 'p@example.org', 'Hal Hart', now() + interval '3 days', 'JOB-L');
-- a parent already asked for a retake for Cara
insert into public.retake_requests (gotphoto_job_id, hub_school_id, access_code, child_first, child_last, reasons, parent_name, parent_email)
values ('JOB-S', '00000000-0000-0000-0000-0000000000a5', 'CCC333', 'Cara', 'Cole', array['Eyes closed'], 'Mom Cole', 'mom@example.org');
update public.booking_settings set sending_enabled = false, test_mode = false, quiet_start = '23:59', quiet_end = '23:59';
delete from public.push_outbox;

select pg_temp.ok((select count(*) from public.app_modules where key in ('photocheck', 'shootlog') and status = 'live') = 2, 'two modules are live');

-- ---------------------------------------------------------------- access
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.pa_list()$$, 'n1: cannot list checks');
select pg_temp.raises($$select public.sl_mine()$$, 'n1: no shoot log');
select pg_temp.raises($$select public.rd_get(array['00000000-0000-0000-0000-0000000000b1'::uuid])$$, 'n1: no readiness');
select pg_temp.ok(public.pa_attention() ->> 'to_check' = '0', 'n1: attention is zero, not an error');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1', 'aal1');
select pg_temp.raises($$select public.pa_list()$$, 'e1 without the second sign-in step: refused');
select pg_temp.act(null);
select pg_temp.raises($$select public.pa_get('00000000-0000-0000-0000-0000000000b1')$$, 'anon: refused');
select pg_temp.raises($$select * from public.pa_people$$, 'anon: cannot read the table');

-- ---------------------------------------------------------------- list
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok(jsonb_array_length(public.pa_list()) = 2, 'v1: list shows the two booked past jobs (not tracked, not next week)');
select pg_temp.ok((select x ->> 'job_id' from jsonb_array_elements(public.pa_list()) x where x ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1') = 'JOB-S', 'school job found through the hub');
select pg_temp.raises($$select public.pa_roster_gotphoto('00000000-0000-0000-0000-0000000000b1')$$, 'v1: cannot load the roster');

-- ---------------------------------------------------------------- school: roster, photographed, retakes
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(public.pa_attention() ->> 'to_check' = '2', 'two picture days waiting for a check');
select pg_temp.raises($$select public.pa_photographed('00000000-0000-0000-0000-0000000000b1', '[]', 'x.csv')$$, 'photographed before a roster is refused');
select pg_temp.ok((public.pa_roster_gotphoto('00000000-0000-0000-0000-0000000000b1') ->> 'people')::int = 6, 'GotPhoto roster: six students');
select pg_temp.ok((select code from public.pa_people where first_name = 'Ava') = 'AAA111', 'codes stored upper case');
select pg_temp.ok(public.pa_photographed('00000000-0000-0000-0000-0000000000b1', $$[
  {"id": "s100", "first": "Ava", "last": "Adams"},
  {"code": "bbb222"},
  {"first": "Sam", "last": "Lee", "group": "3 - Boone"},
  {"first": "Cole,", "last": "Cara"},
  {"first": "Nobody", "last": "Here", "group": "5 - X"}]$$::jsonb, 'photographed.csv') = '{"ok": true, "rows": 5, "matched": 4, "unmatched": 1, "missing": 2}'::jsonb,
  'photographed: ID, code, name narrowed by group, last-first name; one unmatched');
select pg_temp.ok((select string_agg(first_name || ' ' || last_name || ' ' || grp, ',' order by first_name, grp) from public.pa_people where not photographed) = 'Finn Ford 4 - Diaz,Sam Lee 4 - Diaz',
  'missing: Finn and the other Sam Lee');
select pg_temp.ok((select matched_by from public.pa_people where first_name = 'Ben') = 'code' and (select matched_by from public.pa_people where first_name = 'Ava') = 'id', 'records how each matched');
select pg_temp.ok((select unmatched -> 0 ->> 'name' from public.pa_audits where booking_id = '00000000-0000-0000-0000-0000000000b1') = 'Nobody Here', 'unmatched row kept for staff');
-- Sam Lee with no group is ambiguous: not matched
select public.pa_photographed('00000000-0000-0000-0000-0000000000b1', '[{"first": "Sam", "last": "Lee"}]', 'b.csv');
select pg_temp.ok((select count(*) from public.pa_people where first_name = 'Sam' and photographed) = 0, 'a name on the roster twice, no group: nobody matched');
-- a hand mark survives re-upload and a roster reload
select public.pa_mark((select id from public.pa_people where first_name = 'Finn'), true);
select public.pa_photographed('00000000-0000-0000-0000-0000000000b1', '[{"id": "S100"}, {"code": "BBB222"}, {"first": "Sam", "last": "Lee", "group": "3 - Boone"}, {"first": "Cara", "last": "Cole"}]', 'c.csv');
select pg_temp.ok((select photographed and matched_by = 'staff' from public.pa_people where first_name = 'Finn'), 'hand mark kept when the file is uploaded again');
select public.pa_roster_gotphoto('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok((select photographed and matched_by = 'staff' from public.pa_people where first_name = 'Finn')
                  and (select count(*) from public.pa_people where photographed) = 5, 'reloading the roster keeps the marks');

select pg_temp.raises($$select public.pa_to_retakes('00000000-0000-0000-0000-0000000000b2')$$, 'retakes refused for a league job');
select pg_temp.ok(public.pa_to_retakes('00000000-0000-0000-0000-0000000000b1') ->> 'added' = '1', 'retakes: one added (the other Sam Lee)');
reset role;
select pg_temp.ok((select reasons = array['Not photographed'] and hub_school_id = '00000000-0000-0000-0000-0000000000a5' and parent_email is null
                     from public.retake_requests where access_code = 'EEE555'), 'retake request has the reason and the school');
select pg_temp.ok(not exists (select 1 from public.push_outbox where topic = 'retake_new'), 'no "new retake request" push for staff-added ones');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(public.pa_to_retakes('00000000-0000-0000-0000-0000000000b1') ->> 'added' = '0', 'running it again adds nothing');
-- Cara was photographed, so her parent's request is untouched; mark her missing and she joins with the reason added
select public.pa_mark((select id from public.pa_people where first_name = 'Cara'), false);
select public.pa_to_retakes('00000000-0000-0000-0000-0000000000b1');
reset role;
select pg_temp.ok((select reasons from public.retake_requests where access_code = 'CCC333' and deleted_at is null) = array['Eyes closed', 'Not photographed']
                  and (select count(*) from public.retake_requests where access_code = 'CCC333') = 1, 'a parent''s request gets the reason, not a duplicate');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');

-- school email
select pg_temp.ok((select x ->> 'subject' from jsonb_array_elements(public.pa_email_preview('00000000-0000-0000-0000-0000000000b1', 'school', '00000000-0000-0000-0000-00000000c0a1')) x)
                  = 'Hampden Academy: 2 students still need a picture', 'school email subject');
select pg_temp.ok((select (x ->> 'text') like '%4 - Diaz: Cara Cole, Sam Lee%Retake day is%' from jsonb_array_elements(public.pa_email_preview('00000000-0000-0000-0000-0000000000b1', 'school', '00000000-0000-0000-0000-00000000c0a1')) x),
  'school email lists by class and names the retake day');
select pg_temp.raises($$select public.pa_send('00000000-0000-0000-0000-0000000000b1', 'school', null, 'not-an-email')$$, 'a bad address is refused');
select pg_temp.ok(public.pa_send('00000000-0000-0000-0000-0000000000b1', 'school', '00000000-0000-0000-0000-00000000c0a1') ->> 'queued' = '1', 'school email queued');
select pg_temp.ok((select status from public.pa_emails order by id desc limit 1) = 'waiting', 'sending is off: it waits');

-- ---------------------------------------------------------------- league: coach emails and makeups
select public.pa_roster_gotphoto('00000000-0000-0000-0000-0000000000b2');
select public.pa_photographed('00000000-0000-0000-0000-0000000000b2', '[{"first": "Gia", "last": "Gray"}]', 'l.csv');
select pg_temp.ok((select x -> 'makeup' ->> 'at' is not null from jsonb_array_elements(public.pa_get('00000000-0000-0000-0000-0000000000b2') -> 'people') x where x ->> 'first' = 'Hal'),
  'Hal''s makeup booking shows on the check');
select pg_temp.ok((select jsonb_agg(x ->> 'team') from jsonb_array_elements(public.pa_email_preview('00000000-0000-0000-0000-0000000000b2', 'coach')) x) = '["U10 Blue"]'::jsonb,
  'coach emails: only the coach with an address and a missing player');
select pg_temp.ok((select (x ->> 'text') like '%Hal Hart%reply to this email%' from jsonb_array_elements(public.pa_email_preview('00000000-0000-0000-0000-0000000000b2', 'coach')) x),
  'no makeup link set: asks families to reply');
select public.pa_settings_save('https://207photo.com/makeups');
select pg_temp.ok((select (x ->> 'html') like '%href="https://207photo.com/makeups"%' from jsonb_array_elements(public.pa_email_preview('00000000-0000-0000-0000-0000000000b2', 'coach')) x),
  'makeup link becomes the button');
select pg_temp.raises($$select public.pa_settings_save('javascript:alert(1)')$$, 'makeup link must be a web address');
reset role;
update public.booking_settings set sending_enabled = true, test_mode = true, test_recipient = 'test@207photo.com';
insert into vault.secrets values ('resend_api_key', 'k');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(public.pa_send('00000000-0000-0000-0000-0000000000b2', 'coach') ->> 'queued' = '1', 'coach email queued');
select pg_temp.ok((select status = 'sent' and sent_to = 'test@207photo.com' and test_mode from public.pa_emails where kind = 'coach'), 'test mode: went to the test address');
select pg_temp.ok((select status from public.pa_emails where kind = 'school') = 'sent', 'the waiting school email went too once sending was on');
-- tracked jobs never send
reset role;
update public.bookings set status = 'tracked' where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.pa_send('00000000-0000-0000-0000-0000000000b1', 'school', '00000000-0000-0000-0000-00000000c0a1')$$, 'a tracked job does not send');
reset role;
update public.bookings set status = 'booked' where id = '00000000-0000-0000-0000-0000000000b1';
update public.booking_settings set sending_enabled = false;

-- ---------------------------------------------------------------- readiness
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok((select x ->> 'teams' = '2' and x ->> 'coach_emails' = '1' and x ->> 'confirmed' = '1' and x ->> 'crew' = '1' and (x ->> 'roster')::boolean and (x ->> 'checked')::boolean
                     from jsonb_array_elements(public.rd_get(array['00000000-0000-0000-0000-0000000000b2'::uuid])) x), 'readiness: teams, coaches, crew, roster, checked');
select pg_temp.raises($$select public.rd_gear('00000000-0000-0000-0000-0000000000b2', true)$$, 'v1 (view, not crew) cannot tick gear');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select public.rd_gear('00000000-0000-0000-0000-0000000000b2', true);
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok((select x ->> 'gear_by' from jsonb_array_elements(public.rd_get(array['00000000-0000-0000-0000-0000000000b2'::uuid])) x) = 'Crew One', 'crew ticks gear packed');

-- ---------------------------------------------------------------- shoot log
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(jsonb_array_length(public.sl_mine() -> 'jobs') = 2, 'c1: both days of the league job');
select pg_temp.ok(public.sl_attention() ->> 'to_log' in ('1', '2'), 'c1: yesterday needs a log');
select pg_temp.ok((public.sl_get('00000000-0000-0000-0000-0000000000b2', current_date - 1) -> 'groups') = '["U10 Blue", "U12 Red"]'::jsonb, 'teams to tick come from the planner');
select pg_temp.raises($$select public.sl_get('00000000-0000-0000-0000-0000000000b1', null)$$, 'c1: not on the school job');
select pg_temp.raises($$select public.sl_save('00000000-0000-0000-0000-0000000000b2', current_date + 1, '{}')$$, 'not one of the job''s days');
select public.sl_save('00000000-0000-0000-0000-0000000000b2', current_date - 1, '{"cards": 2, "card_labels": "A, B", "groups": ["U10 Blue", "U12 Red", "u10 blue"], "subjects_shot": 30, "absences": "Ivy Irwin", "issues": ""}');
reset role;
select pg_temp.ok((select groups = array['U10 Blue', 'U12 Red'] and groups_shot = 2 and cards = 2 and by_name = 'Crew One' from public.sl_logs where day = current_date - 1), 'log saved; teams de-duplicated and counted');
select pg_temp.ok(not exists (select 1 from public.booking_progress where booking_id = '00000000-0000-0000-0000-0000000000b2'), 'first of two days: stage not ticked yet');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.sl_save('00000000-0000-0000-0000-0000000000b2', current_date, '{"cards": 1, "issues": "Backdrop stand broke"}') ->> 'stage')::boolean, 'last day logged: picture day stage ticked');
reset role;
select pg_temp.ok((select stage_id from public.booking_progress where booking_id = '00000000-0000-0000-0000-0000000000b2') = '00000000-0000-0000-0000-00000000aa02', 'booking moved to Picture day done');
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'shootlog_issue') = 1, 'an issue pushes to managers');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select public.sl_save('00000000-0000-0000-0000-0000000000b2', current_date, '{"cards": 1, "issues": "Backdrop stand broke"}');
reset role;
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'shootlog_issue') = 1, 'saving the same issue again does not push again');
select pg_temp.act('00000000-0000-0000-0000-0000000000c2');
select pg_temp.raises($$select public.sl_save('00000000-0000-0000-0000-0000000000b2', current_date - 1, '{}')$$, 'c2: cannot log a job they were not on');
select pg_temp.ok(jsonb_array_length(public.sl_mine() -> 'jobs') = 0, 'c2: nothing in the last two weeks');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(jsonb_array_length(public.sl_mine() -> 'jobs') = 3, 'e1 (edit): every booked job day up to today');
select pg_temp.ok(jsonb_array_length(public.pa_get('00000000-0000-0000-0000-0000000000b2') -> 'logs') = 2, 'the check shows what the crew logged');

-- evening reminder: only crew on today's job day without a log
reset role;
delete from public.sl_logs where day = current_date;
delete from public.push_outbox;
select pg_temp.ok(public.sl_nudge() = 1, 'nudge: one push');
select pg_temp.ok((select target_user from public.push_outbox where topic = 'shootlog_due') = '00000000-0000-0000-0000-0000000000c1', 'nudge goes to today''s crew only');

do $$ begin raise notice 'ALL PHOTOCHECK AND SHOOT LOG TESTS PASSED'; end $$;
rollback;
