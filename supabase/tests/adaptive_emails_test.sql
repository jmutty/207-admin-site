-- Tests for 20261024080000_adaptive_booking_emails (and 20261024203500_short_email_links). Run against a NON-production copy of the schema with the
-- migration applied, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/adaptive_emails_test.sql
-- "ALL ADAPTIVE EMAIL TESTS PASSED" at the end means every check held.

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
-- local date n days from today, at hh:mm Eastern
create function pg_temp.at(p_days int, p_hm text default '12:00') returns timestamptz language sql as $$
  select (((now() at time zone 'America/New_York')::date + p_days)::text || ' ' || p_hm || ' America/New_York')::timestamptz
$$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/New_York')::date $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------- setup (as postgres)
-- e1 books jobs (bookings edit); c1 views; d1 has no bookings access
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'ae-edit@example.com'), ('00000000-0000-0000-0000-0000000000c1', 'ae-view@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'ae-none@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Booker', true), ('00000000-0000-0000-0000-0000000000c1', 'Viewer', true),
  ('00000000-0000-0000-0000-0000000000d1', 'Nobody', true);
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'bookings', 'edit'),
  ('00000000-0000-0000-0000-0000000000c1', 'bookings', 'view');

insert into public.prospect_orgs (id, name, stage, sports) values
  ('00000000-0000-0000-0000-00000000000a', 'Hampden Youth Soccer', 'client', '{soccer}'),
  ('00000000-0000-0000-0000-00000000000b', 'Hermon Elementary', 'client', '{}');
insert into public.prospect_contacts (id, org_id, first_name, last_name, email, phone, is_primary) values
  ('00000000-0000-0000-0000-0000000000ca', '00000000-0000-0000-0000-00000000000a', 'Dana', 'Smith', 'dana@hys.org', '207-555-0101', true),
  ('00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-00000000000b', 'Pat', 'Lee', 'pat@hermon.org', '', true);
insert into public.synced_jobs (gotphoto_job_id, name, job_type, access_type, status, comm_workflow)
  values ('ae-job-1', 'HYS Spring', 'sport_other', 'qr_tagging', 'created', null), ('ae-job-3', 'HYS Fall', 'sport_other', 'qr_tagging', 'created', null)
  on conflict (gotphoto_job_id) do nothing;
insert into public.comm_hub_schools (id, name, picture_day, access_code) values
  ('00000000-0000-0000-0000-0000000000a5', 'Hermon Elementary', pg_temp.today() + 12, 'HERM');
update public.booking_settings set sending_enabled = true, test_mode = false, quiet_start = '21:00', quiet_end = '07:00';

-- b1: Roster Only, 4 days out, outdoors, no coaches, booked by e1
-- b2: school, 12 days out, no one booked it on record
-- b3: Parent Contacts, 10 days out, no roster yet, booked by e1
-- b4: Roster Only, 2 days out, shooting "either", for weather
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, time_set, end_set, location, status, contact_ids, gotphoto_job_id, hub_school_id, created_by) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000a', 'sports_nodata', 'Spring Soccer', pg_temp.today() + 4,
   pg_temp.at(4, '09:00'), pg_temp.at(4, '12:00'), true, true, 'Doyle Field, Hampden ME', 'booked', array['00000000-0000-0000-0000-0000000000ca']::uuid[],
   'ae-job-1', null, '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000b', 'school', 'School Photos', pg_temp.today() + 12,
   pg_temp.at(12, '08:00'), pg_temp.at(12, '11:00'), true, true, 'Hermon Elementary', 'booked', array['00000000-0000-0000-0000-0000000000cc']::uuid[],
   null, '00000000-0000-0000-0000-0000000000a5', null),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000000a', 'sports_data', 'Fall Soccer', pg_temp.today() + 10,
   pg_temp.at(10, '09:00'), pg_temp.at(10, '12:00'), true, true, 'Doyle Field, Hampden ME', 'booked', array['00000000-0000-0000-0000-0000000000ca']::uuid[],
   'ae-job-3', null, '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000000a', 'sports_nodata', 'Lacrosse', pg_temp.today() + 2,
   pg_temp.at(2, '15:00'), pg_temp.at(2, '17:00'), true, true, 'Hampden Academy turf', 'booked', array['00000000-0000-0000-0000-0000000000ca']::uuid[],
   null, null, '00000000-0000-0000-0000-0000000000e1');
update public.bookings set shoot_setting = 'either' where id = '00000000-0000-0000-0000-0000000000b4';
update public.bookings b set sequence_id = q.id from public.booking_sequences q
 where q.type_key = b.type_key and q.is_active and b.id::text like '00000000-0000-0000-0000-0000000000b%' and b.sequence_id is null;
select public.booking_reschedule(id) from public.bookings where id::text like '00000000-0000-0000-0000-0000000000b%';

-- ---------------------------------------------------------------- 1. settings, defaults, series
select pg_temp.ok((select emergency_phone = '(207) 299-3928' and emergency_email = 'jmutty@207photo.com' and emergency_name = 'Jeremiah' from public.booking_settings), 'emergency contact defaults');
select pg_temp.ok((select shoot_setting from public.bookings where id = '00000000-0000-0000-0000-0000000000b1') = 'outdoors', 'sports default to outdoors');
select pg_temp.ok((select shoot_setting from public.bookings where id = '00000000-0000-0000-0000-0000000000b2') = 'indoors', 'schools default to indoors');
select pg_temp.ok((select shoot_setting from public.bookings where id = '00000000-0000-0000-0000-0000000000b4') = 'either', 'a chosen setting is kept');
select pg_temp.ok((select name from public.booking_sequences where type_key = 'sports_nodata' and is_active) = 'Sports: Roster Only', 'series renamed');
select pg_temp.ok((select not s.is_active from public.booking_steps s join public.booking_sequences q on q.id = s.sequence_id where q.type_key = 'sports_nodata' and s.step_no = 3), 'Roster Only AD coach checklist is off');
select pg_temp.ok((select not s.is_active from public.booking_steps s join public.booking_sequences q on q.id = s.sequence_id where q.type_key = 'school' and s.step_no = 2), 'school 21-day data email is off');
select pg_temp.ok((select count(*) from public.booking_emails where booking_id = '00000000-0000-0000-0000-0000000000b1') > 0, 'b1 has emails scheduled');

-- ---------------------------------------------------------------- 2. hub copy windows
-- b1 heads window opens 10 days before picture day (6 days ago); a copy 8 days ago is too early
insert into public.hub_events (hub, org_id, send_key, action, created_at) values ('sports', 'ae-job-1', 'heads', 'copy', now() - interval '8 days');
select pg_temp.ok(public.booking_hub_sent('00000000-0000-0000-0000-0000000000b1', 'heads') is null, 'a copy before the window does not count');
-- three different messages copied inside the same hour: a bulk grab, does not count
insert into public.hub_events (hub, org_id, send_key, action, created_at) values
  ('sports', 'ae-job-1', 'heads', 'copy', now() - interval '3 hours'), ('sports', 'ae-job-1', 'live', 'copy', now() - interval '3 hours' + interval '5 minutes'),
  ('sports', 'ae-job-1', 'lastcall', 'copy', now() - interval '3 hours' + interval '10 minutes');
select pg_temp.ok(public.booking_hub_sent('00000000-0000-0000-0000-0000000000b1', 'heads') is null, '3+ messages copied in one hour do not count');
select pg_temp.ok((select reason is null or reason not like 'Not needed:%' from public.booking_emails e join public.booking_steps s on s.id = e.step_id
                    where e.booking_id = '00000000-0000-0000-0000-0000000000b1' and s.step_no = 14 limit 1), 'nothing skipped yet');
select pg_temp.ok(public.booking_email_skip_reason((select e.id from public.booking_emails e join public.booking_steps s on s.id = e.step_id
                    where e.booking_id = '00000000-0000-0000-0000-0000000000b1' and s.step_no = 14 limit 1)) is null, 'escalation still goes: families not told');

-- ---------------------------------------------------------------- 3. follow-ups (before the real copy)
select public.booking_followups_tick();
select pg_temp.ok((select assigned_to from public.booking_followups where booking_id = '00000000-0000-0000-0000-0000000000b1' and key = 'heads' and done_at is null) = '00000000-0000-0000-0000-0000000000e1',
                  'b1: families-not-told task goes to whoever booked');
select pg_temp.ok((select detail like '%Dana Smith%207-555-0101%' from public.booking_followups where booking_id = '00000000-0000-0000-0000-0000000000b1' and key = 'heads'), 'the task names the AD and their phone');
select pg_temp.ok((select count(*) from public.booking_followups where booking_id = '00000000-0000-0000-0000-0000000000b3' and key = 'roster' and done_at is null) = 1, 'b3: no roster 10 days out raises a task');
select pg_temp.ok((select count(*) from public.booking_followups where booking_id = '00000000-0000-0000-0000-0000000000b2') = 0, 'b2: school 12 days out has no task yet');
select pg_temp.ok((select count(*) from public.booking_followups where booking_id = '00000000-0000-0000-0000-0000000000b3' and key = 'heads') = 0, 'b3: 10 days out is too early for the families task');
select pg_temp.ok((public.booking_followups_tick() ->> 'raised')::int = 0, 'a second tick raises nothing new');

select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(jsonb_array_length(public.booking_followups_mine()) = 3, 'e1 sees their three tasks (b4 has no hub job linked, so nobody was told)');
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(jsonb_array_length(public.booking_followups_mine()) = 0, 'c1 does not see tasks assigned to e1');
select pg_temp.raises($$select public.booking_run_roster_only('00000000-0000-0000-0000-0000000000b3')$$, 'c1 (view) cannot switch a job to Roster Only');
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.ok(jsonb_array_length(public.booking_followups_mine()) = 0, 'd1 sees nothing');
select pg_temp.raises($$select public.booking_parents('00000000-0000-0000-0000-0000000000b1')$$, 'd1 cannot read the Parents tab');
reset role;

-- now the AD sends the one-week message on time
insert into public.hub_events (hub, org_id, send_key, action, created_at) values ('sports', 'ae-job-1', 'heads', 'copy', now() - interval '1 day');
select pg_temp.ok(public.booking_hub_sent('00000000-0000-0000-0000-0000000000b1', 'heads') is not null, 'an on-time copy counts');
select pg_temp.ok(public.booking_email_skip_reason((select e.id from public.booking_emails e join public.booking_steps s on s.id = e.step_id
                    where e.booking_id = '00000000-0000-0000-0000-0000000000b1' and s.step_no = 14 limit 1)) like 'Not needed: the message was copied on the hub%', 'the escalation is not needed now');
select public.booking_followups_tick();
select pg_temp.ok((select done_note from public.booking_followups where booking_id = '00000000-0000-0000-0000-0000000000b1' and key = 'heads') = 'The message was sent', 'the task closes itself');

-- ---------------------------------------------------------------- 4. skipped at send time, and left alone after
update public.booking_emails e set status = 'scheduled', send_at = pg_temp.at(0, '11:00')
  from public.booking_steps s where s.id = e.step_id and e.booking_id = '00000000-0000-0000-0000-0000000000b1' and s.step_no = 14;
select count(*) from public.booking_claim_due(50, pg_temp.at(0, '12:00'));
select pg_temp.ok((select e.status = 'skipped' and e.reason like 'Not needed:%' from public.booking_emails e join public.booking_steps s on s.id = e.step_id
                    where e.booking_id = '00000000-0000-0000-0000-0000000000b1' and s.step_no = 14), 'claim skips it with the reason');
select public.booking_reschedule('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok((select e.status = 'skipped' from public.booking_emails e join public.booking_steps s on s.id = e.step_id
                    where e.booking_id = '00000000-0000-0000-0000-0000000000b1' and s.step_no = 14), 'reschedule leaves a "Not needed" row alone');

-- ---------------------------------------------------------------- 5. tokens and tracked links
select pg_temp.ok((select v ->> 'link_heads' = 'https://207photo.com/sportsadmin/#job=ae-job-1/send=heads/r'
                      and v ->> 'link_day' = 'https://207photo.com/sportsadmin/#job=ae-job-1/send=day-' || to_char(pg_temp.today() + 4, 'YYYY-MM-DD') || '/r'
                      and v ->> 'emergency_line' like '%(207) 299-3928%calling more than twice%'
                      and v ->> 'short_notice' like '%less than two weeks%'
                      and v ->> 'paste_day' like '> Reminder: team photos are%9:00 am%'
                      and v ->> 'coach_tips_if_none' like '**For your coaches**%'
                      and v ->> 'day_of_block' like '%call again right away%'
                   from (select public.booking_vars('00000000-0000-0000-0000-0000000000b1', null, null, 0) v) x), 'b1 series tokens');
select pg_temp.ok((select v ->> 'link_m2' = 'https://207photo.com/schooladmin/#school=00000000-0000-0000-0000-0000000000a5/send=m2/r'
                      and v ->> 'two_weeks_ask' like '**Send the "Two weeks before" message today.**%'
                      and v ->> 'data_ask' like '**Student data:**%'
                   from (select public.booking_vars('00000000-0000-0000-0000-0000000000b2', null, null, 0) v) x), 'b2 school tokens');
select pg_temp.ok((select (public.booking_director_facts('00000000-0000-0000-0000-0000000000b2') ->> 'weather') is null
                       or (public.booking_director_facts('00000000-0000-0000-0000-0000000000b2') ->> 'weather') = ''), 'an indoor booking has no weather paragraph');
select pg_temp.ok((public.booking_director_facts('00000000-0000-0000-0000-0000000000b4') ->> 'weather') like 'If we''re shooting outside%', 'an "either" booking gets the weather paragraph');
select pg_temp.ok((public.booking_director_facts('00000000-0000-0000-0000-0000000000b1') #>> '{emergency,phone}') = '(207) 299-3928', 'the day page gets the emergency contact');

-- 20261024203500_short_email_links: tracked links are short admin.207photo.com/go/<code> links with words
select set_config('ae.email', (select id::text from public.booking_emails where booking_id = '00000000-0000-0000-0000-0000000000b1' limit 1), true);
select set_config('ae.tracked', public.booking_track_links('See https://207photo.com/sportsadmin/#job=J/send=heads/r. Home https://207photo.com/sportsadmin/#job=J and https://example.com/x stays. '
                    || '[Add it to your calendar](https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?b=1)', current_setting('ae.email')::uuid), true);
select pg_temp.ok(current_setting('ae.tracked') = 'See [Open the message on your hub](https://admin.207photo.com/go/'
                    || (select code from public.booking_link_codes where email_id = current_setting('ae.email')::uuid and url = 'https://207photo.com/sportsadmin/#job=J/send=heads/r')
                    || '). Home [Open your hub](https://admin.207photo.com/go/'
                    || (select code from public.booking_link_codes where email_id = current_setting('ae.email')::uuid and url = 'https://207photo.com/sportsadmin/#job=J')
                    || ') and https://example.com/x stays. [Add it to your calendar](https://admin.207photo.com/go/'
                    || (select code from public.booking_link_codes where email_id = current_setting('ae.email')::uuid and url = 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?b=1')
                    || ')', 'links are short, longest first, bare ones get words, [words](link) keeps its words, others untouched');
select pg_temp.ok(public.booking_track_links('https://admin.207photo.com/#day/abc', current_setting('ae.email')::uuid) ~ '^\[Open your picture day page\]\(https://admin\.207photo\.com/go/[A-Za-z0-9_-]{8}\)$', 'the picture day page link reads "Open your picture day page"');
select pg_temp.ok(public.booking_track_links('See https://207photo.com/sportsadmin/#job=J', current_setting('ae.email')::uuid)
                  = public.booking_track_links('See https://207photo.com/sportsadmin/#job=J', current_setting('ae.email')::uuid), 'rendering again gives the same code');
select pg_temp.ok(public.booking_track_links('See https://207photo.com/sportsadmin/#job=J', '00000000-0000-0000-0000-000000000001') = 'See https://207photo.com/sportsadmin/#job=J', 'no such email: left alone');
select pg_temp.ok((public.booking_render_row((select e.id from public.booking_emails e join public.booking_steps s on s.id = e.step_id
                    where e.booking_id = '00000000-0000-0000-0000-0000000000b1' and s.step_no = 1 limit 1)) ->> 'body') like '%admin.207photo.com/go/%', 'rendered emails carry short links');
select set_config('ae.code', (select code from public.booking_link_codes where url = 'https://207photo.com/sportsadmin/#job=J' limit 1), true);
select pg_temp.act(null);
select pg_temp.ok(public.booking_link_go(current_setting('ae.code'), false) = 'https://207photo.com/sportsadmin/#job=J', 'anon looks a code up');
select pg_temp.ok(public.booking_link_go('zzzzzzzz') is null and public.booking_link_go('../etc') is null, 'unknown or malformed codes answer nothing');
select pg_temp.raises($$select public.booking_link_code(gen_random_uuid(), 'https://207photo.com/sportsadmin')$$, 'anon cannot make codes');
reset role;
select pg_temp.ok((select count(*) from public.booking_link_clicks where booking_id = '00000000-0000-0000-0000-0000000000b1') = 0, 'a HEAD-style lookup logs nothing');

select set_config('ae.email', (select id::text from public.booking_emails where booking_id = '00000000-0000-0000-0000-0000000000b1' limit 1), true);
select pg_temp.act(null);
select pg_temp.ok(public.booking_link_click(current_setting('ae.email')::uuid,
                  'https://207photo.com/sportsadmin/#job=ae-job-1/send=heads/r') = 'https://207photo.com/sportsadmin/#job=ae-job-1/send=heads/r', 'anon click answers the link');
select pg_temp.ok(public.booking_link_click(current_setting('ae.email')::uuid,
                  'https://207photo.com/sportsadmin/#job=ae-job-1/send=heads/r') is not null, 'a repeat click still redirects');
select pg_temp.ok(public.booking_link_click(null, 'https://evil.example.com/') is null, 'anything not ours is refused');
reset role;
select pg_temp.ok((select count(*) from public.booking_link_clicks where booking_id = '00000000-0000-0000-0000-0000000000b1') = 1, 'one click logged (repeat within 10 minutes dropped)');

-- ---------------------------------------------------------------- 6. weather
select pg_temp.ok((select count(*) from jsonb_array_elements(public.booking_weather_due()) x where x ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b4') = 1, 'b4 (either, 2 days out) is due a weather check');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.booking_weather_due()) x where x ->> 'booking_id' in ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2')) = 0, 'b1 (4 days) and b2 (indoors) are not');
select pg_temp.ok((public.booking_weather_record('00000000-0000-0000-0000-0000000000b4', pg_temp.today() + 2, 10, 18, '[]') ->> 'bad')::boolean = false, '10% rain, 18 mph gusts is fine');
select pg_temp.ok((select count(*) from public.booking_followups where booking_id = '00000000-0000-0000-0000-0000000000b4' and kind = 'weather') = 0, 'no task for fine weather');
select pg_temp.ok((public.booking_weather_record('00000000-0000-0000-0000-0000000000b4', pg_temp.today() + 2, 20, 10, '[{"hour":"3 PM","pop":20,"gust":10}]') ->> 'alerted')::boolean, '20% rain alerts');
select pg_temp.ok((select assigned_to = '00000000-0000-0000-0000-0000000000e1' and detail like '%3 PM 20% rain%' from public.booking_followups
                    where booking_id = '00000000-0000-0000-0000-0000000000b4' and kind = 'weather' and done_at is null), 'the weather task goes to whoever booked, with the hours');
select pg_temp.ok((public.booking_weather_record('00000000-0000-0000-0000-0000000000b4', pg_temp.today() + 2, 5, 26, '[]') ->> 'alerted')::boolean = false, 'still bad (26 mph gusts) does not alert again');
select public.booking_weather_record('00000000-0000-0000-0000-0000000000b4', pg_temp.today() + 2, 0, 12, '[]');
select pg_temp.ok((select done_note from public.booking_followups where booking_id = '00000000-0000-0000-0000-0000000000b4' and kind = 'weather') = 'Weather OK: the forecast cleared', 'cleared weather closes the task');

-- ---------------------------------------------------------------- 7. the job page, booking form, Roster Only switch
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((select p ->> 'audience' = 'sports' and jsonb_array_length(p -> 'messages') = 4 and (p -> 'messages' -> 0 ->> 'sent_at') is not null
                      and (p ->> 'coaches')::int = 0 and jsonb_array_length(p -> 'clicks') = 1
                   from (select public.booking_parents('00000000-0000-0000-0000-0000000000b1') p) x), 'c1 reads the Parents tab');
select pg_temp.ok((select jsonb_array_length(public.booking_parents('00000000-0000-0000-0000-0000000000b2') -> 'messages')) = 4, 'school without retakes shows 4 messages');
select pg_temp.raises($$select public.booking_director_save('00000000-0000-0000-0000-0000000000b1', '{"shoot_setting":"indoors"}')$$, 'c1 cannot change the booking');
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.booking_director_save('00000000-0000-0000-0000-0000000000b2', '{"shoot_setting":"outdoors","school_data":true}');
select pg_temp.ok((select shoot_setting = 'outdoors' and school_data_at is not null from public.bookings where id = '00000000-0000-0000-0000-0000000000b2'), 'e1 sets outdoors and data received');
select public.booking_director_save('00000000-0000-0000-0000-0000000000b2', '{"shoot_setting":"","school_data":false}');
select pg_temp.ok((select shoot_setting = 'indoors' and school_data_at is null from public.bookings where id = '00000000-0000-0000-0000-0000000000b2'), 'blank goes back to the job type default');
select pg_temp.raises($$select public.booking_director_save('00000000-0000-0000-0000-0000000000b2', '{"shoot_setting":"roof"}')$$, 'a bad setting is refused');
select pg_temp.ok((public.booking_director_get('00000000-0000-0000-0000-0000000000b2') ->> 'shoot_setting') = 'indoors', 'director_get returns the setting');
select public.booking_run_roster_only('00000000-0000-0000-0000-0000000000b3');
reset role;
select pg_temp.ok((select type_key = 'sports_nodata' from public.bookings where id = '00000000-0000-0000-0000-0000000000b3'), 'b3 now runs as Roster Only');
select pg_temp.ok((select done_note from public.booking_followups where booking_id = '00000000-0000-0000-0000-0000000000b3' and key = 'roster') = 'Kept the date: running as Roster Only', 'and its roster task is closed');

-- a cancelled booking's open tasks close
select public.booking_weather_record('00000000-0000-0000-0000-0000000000b4', pg_temp.today() + 2, 60, 10, '[]');
update public.bookings set status = 'cancelled', cancelled_at = now() where id = '00000000-0000-0000-0000-0000000000b4';
select public.booking_followups_tick();
select pg_temp.ok((select count(*) from public.booking_followups where booking_id = '00000000-0000-0000-0000-0000000000b4' and done_at is null) = 0, 'cancelled booking: tasks closed');

select 'ALL ADAPTIVE EMAIL TESTS PASSED';
rollback;
