-- Tests for 20261024060000_director_journey + 20261024060100_director_steps (ws/director). Run against a
-- NON-production copy of the schema with both migrations applied, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/director_test.sql
-- (run from the repo root or anywhere: the steps migration is re-included with \ir, relative to this file).
-- "ALL DIRECTOR TESTS PASSED" at the end means every check held.

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
create temp table t (k text primary key, v text);
grant all on t to anon, authenticated;

-- ---------------------------------------------------------------- setup (as postgres)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'bk-edit@example.com'), ('00000000-0000-0000-0000-0000000000c1', 'bk-view@example.com'),
  ('00000000-0000-0000-0000-0000000000a1', 'results@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'nothing@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Bookings Edit', true), ('00000000-0000-0000-0000-0000000000c1', 'Bookings View', true),
  ('00000000-0000-0000-0000-0000000000a1', 'Results Edit', true), ('00000000-0000-0000-0000-0000000000d1', 'Nothing', true);
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'bookings', 'edit'), ('00000000-0000-0000-0000-0000000000c1', 'bookings', 'view'),
  ('00000000-0000-0000-0000-0000000000a1', 'results', 'edit');

insert into public.booking_types (key, label, audience) values ('sports_data', 'Sports: league with parent contacts', 'sports'), ('dir_school', 'School Photos (test)', 'school') on conflict do nothing;
insert into public.prospect_orgs (id, name, stage, sports) values
  ('00000000-0000-0000-0000-00000000000a', 'Hampden Youth Soccer', 'client', '{soccer}'),
  ('00000000-0000-0000-0000-00000000000b', 'Hermon Elementary', 'client', '{}');
insert into public.prospect_contacts (id, org_id, first_name, last_name, email, is_primary) values
  ('00000000-0000-0000-0000-0000000000ca', '00000000-0000-0000-0000-00000000000a', 'Dana', 'Smith', 'dana@hys.org', true),
  ('00000000-0000-0000-0000-0000000000cb', '00000000-0000-0000-0000-00000000000a', 'Lee', 'Jones', 'lee@hys.org', false),
  ('00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-00000000000b', 'Pat', null, 'pat@hermon.org', true);
update public.booking_settings set from_name = 'Jeremiah Mutty', from_email = 'jmutty@207photo.com', reply_to = 'jmutty@207photo.com, info@207photo.com';

-- b1: league, 20 days out, 9:00 to 12:00 Eastern; b2: school, no time yet; b3: track-only; b4: league for the review path
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, time_set, end_set, location, status, contact_ids) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000a', 'sports_data', 'Spring Soccer', (now() at time zone 'America/New_York')::date + 20,
   (((now() at time zone 'America/New_York')::date + 20)::text || ' 09:00 America/New_York')::timestamptz, (((now() at time zone 'America/New_York')::date + 20)::text || ' 12:00 America/New_York')::timestamptz,
   true, true, 'Doyle Field, Hampden ME', 'booked', array['00000000-0000-0000-0000-0000000000cb']::uuid[]),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000b', 'dir_school', 'School Photos', (now() at time zone 'America/New_York')::date + 30,
   (((now() at time zone 'America/New_York')::date + 30)::text || ' 08:00 America/New_York')::timestamptz, (((now() at time zone 'America/New_York')::date + 30)::text || ' 09:00 America/New_York')::timestamptz,
   false, false, '', 'booked', array['00000000-0000-0000-0000-0000000000cc']::uuid[]),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000000a', 'sports_data', 'Old', (now() at time zone 'America/New_York')::date - 10, null, null, true, true, '', 'tracked', '{}'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000000a', 'sports_data', 'Fall Soccer', (now() at time zone 'America/New_York')::date - 40,
   (((now() at time zone 'America/New_York')::date - 40)::text || ' 09:00 America/New_York')::timestamptz, (((now() at time zone 'America/New_York')::date - 40)::text || ' 10:00 America/New_York')::timestamptz,
   true, true, 'Doyle Field', 'booked', array['00000000-0000-0000-0000-0000000000ca']::uuid[]);
insert into public.partner_terms (org_id, payout_pct, note) values ('00000000-0000-0000-0000-00000000000a', 10, 'Partner Plan') on conflict (org_id) do update set payout_pct = 10;

-- ---------------------------------------------------------------- 1. fields + settings
select pg_temp.ok((select count(distinct day_token) from public.bookings where id::text like '00000000-0000-0000-0000-0000000000b%') = 4
                  and (select bool_and(day_token ~ '^[0-9a-f]{36}$') from public.bookings), 'every booking gets its own 36-hex day token');
select pg_temp.ok((select day_of_phone from public.booking_settings) <> '' and (select weather_plan from public.booking_settings) like '%7:00 AM%', 'picture day phone + rain plan settings have defaults');
select pg_temp.ok((select team_times from public.bookings where id = '00000000-0000-0000-0000-0000000000b1') = '', 'team times start empty');
select pg_temp.ok((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.booking_steps'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) ~ 'gallery_live' limit 1) ~ '''booking'''
                  or (select t.typtype from pg_attribute a join pg_type t on t.oid = a.atttypid where a.attrelid = 'public.booking_steps'::regclass and a.attname = 'trigger') = 'e'
                  or not exists (select 1 from pg_constraint c where c.conrelid = 'public.booking_steps'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) ~ 'gallery_live'),
                  'booking_steps.trigger accepts ''booking''');

-- staff save / read
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
insert into t select 'save', public.booking_director_save('00000000-0000-0000-0000-0000000000b1',
  jsonb_build_object('team_times', E'  9:00 U10 Blue\r\n9:15 U10 Red\n\n9:30 U12 Girls  ', 'order_deadline', ((now() at time zone 'America/New_York')::date + 45)::text, 'discount_ends', ((now() at time zone 'America/New_York')::date + 35)::text))::text;
select pg_temp.ok((select v from t where k = 'save')::jsonb ->> 'day_link' like 'https://admin.207photo.com/#day/%', 'save returns the picture day page link');
select pg_temp.raises($$select public.booking_director_save('00000000-0000-0000-0000-0000000000b1', jsonb_build_object('team_times', repeat('x', 4001)))$$, 'team times longer than 4,000 characters');
select public.booking_director_save('00000000-0000-0000-0000-0000000000b2', '{"order_deadline": ""}');
reset role;
select pg_temp.ok((select team_times from public.bookings where id = '00000000-0000-0000-0000-0000000000b1') = E'9:00 U10 Blue\n9:15 U10 Red\n\n9:30 U12 Girls', 'team times saved trimmed, without carriage returns');
select pg_temp.ok((select order_deadline is not null and discount_ends is not null from public.bookings where id = '00000000-0000-0000-0000-0000000000b1'), 'order dates saved');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.booking_director_get('00000000-0000-0000-0000-0000000000b1') ->> 'team_times') like '9:00 U10 Blue%', 'bookings view reads the fields');
select pg_temp.raises($$select public.booking_director_save('00000000-0000-0000-0000-0000000000b1', '{"team_times": "x"}')$$, 'bookings view cannot save');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.booking_director_get('00000000-0000-0000-0000-0000000000b1')$$, 'no bookings access: no read');
select pg_temp.act(null);
select pg_temp.raises($$select public.booking_director_vars('00000000-0000-0000-0000-0000000000b1')$$, 'anon cannot read the tokens');
select pg_temp.raises($$select public.booking_director_facts('00000000-0000-0000-0000-0000000000b1')$$, 'anon cannot read the facts');
reset role;

-- ---------------------------------------------------------------- 2. the tokens
insert into t select 'v1', public.booking_director_vars('00000000-0000-0000-0000-0000000000b1')::text;
insert into t select 'v2', public.booking_director_vars('00000000-0000-0000-0000-0000000000b2')::text;
select pg_temp.ok((select v from t where k = 'v1')::jsonb ?& array['families_block', 'day_of_block', 'weather_line', 'flyer_line', 'team_times', 'order_deadline', 'discount_ends', 'day_link', 'calendar_link', 'when_line', 'where_line', 'day_of_phone'],
                  'every new token is filled');
select pg_temp.ok((select v from t where k = 'v1')::jsonb ->> 'when_line' like '%, 9:00 AM to 12:00 PM', 'when line has the time when it is set: ' || ((select v from t where k = 'v1')::jsonb ->> 'when_line'));
select pg_temp.ok((select v from t where k = 'v2')::jsonb ->> 'when_line' like '%(we''ll confirm the time)', 'when line says the time is coming when it is not set');
select pg_temp.ok((select v from t where k = 'v1')::jsonb ->> 'day_of_block' like '%We arrive by 8:30 AM%' and (select v from t where k = 'v1')::jsonb ->> 'day_of_block' like '%on-site contact%'
                  and (select v from t where k = 'v1')::jsonb ->> 'day_of_block' like '%' || (select day_of_phone from public.booking_settings) || '%', 'day-of block: arrival = start minus 30 minutes, phone, on-site contact ask');
select pg_temp.ok((select v from t where k = 'v1')::jsonb ->> 'team_times' = E'**Team times**\n- 9:00 U10 Blue\n- 9:15 U10 Red\n- 9:30 U12 Girls', 'team times become a list, blank lines dropped');
select pg_temp.ok((select v from t where k = 'v2')::jsonb ->> 'team_times' = '', 'no team times: empty token');
select pg_temp.ok((select v from t where k = 'v1')::jsonb ->> 'families_block' like '**How it works for families**%email and a text%Last day to order:%', 'league families block with the order dates');
select pg_temp.ok((select v from t where k = 'v2')::jsonb ->> 'families_block' like '%access code%' and (select v from t where k = 'v2')::jsonb ->> 'order_deadline' = '', 'school families block; no order date yet');
select pg_temp.ok((select v from t where k = 'v1')::jsonb ->> 'weather_line' like '**If the weather is bad:**%' and (select v from t where k = 'v2')::jsonb ->> 'weather_line' = '', 'rain plan for sports only');
select pg_temp.ok((select v from t where k = 'v1')::jsonb ->> 'flyer_line' like '%207photo.com/sportsadmin%' and (select v from t where k = 'v2')::jsonb ->> 'flyer_line' like '%207photo.com/schooladmin%', 'flyer line names the right hub');
select pg_temp.ok((select v from t where k = 'v2')::jsonb ->> 'where_line' = 'we''ll confirm the spot with you', 'no location: where line says we will confirm');
select pg_temp.ok((select v from t where k = 'v1')::jsonb ->> 'calendar_link' like 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?t=' || (select day_token from public.bookings where id = '00000000-0000-0000-0000-0000000000b1'), 'calendar link carries the token');

-- ---------------------------------------------------------------- 3. the public page + calendar (anon, token only)
insert into t select 'tok1', day_token from public.bookings where id = '00000000-0000-0000-0000-0000000000b1';
insert into t select 'tok2', day_token from public.bookings where id = '00000000-0000-0000-0000-0000000000b2';
insert into t select 'tok3', day_token from public.bookings where id = '00000000-0000-0000-0000-0000000000b3';
grant select on t to anon;
select pg_temp.act(null);
insert into t select 'pub', public.booking_public((select v from t where k = 'tok1'))::text;
select pg_temp.ok(((select v from t where k = 'pub')::jsonb ->> 'found')::boolean and (select v from t where k = 'pub')::jsonb ->> 'org' = 'Hampden Youth Soccer', 'anon reads the page by token');
select pg_temp.ok(not ((select v from t where k = 'pub')::jsonb ?| array['booking_id', 'status', 'setup_min', 'contact_ids', 'notes']), 'no internal fields on the page');
select pg_temp.ok((select v from t where k = 'pub')::jsonb ->> 'terms' like 'Your program gets 10% of online sales%', 'terms line from partner terms');
select pg_temp.ok(jsonb_array_length((select v from t where k = 'pub')::jsonb -> 'team_times') = 3 and (select v from t where k = 'pub')::jsonb #>> '{contact,email}' = 'jmutty@207photo.com', 'team times and 207''s contact');
select pg_temp.ok((select v from t where k = 'pub')::jsonb ->> 'retake' like '%207photo.com/makeups%', 'makeup line for a league');
select pg_temp.ok(not (public.booking_public('0000000000000000000000000000000000ff') ->> 'found')::boolean and not (public.booking_public('short') ->> 'found')::boolean, 'unknown or short token: not found');
select pg_temp.ok(not (public.booking_public((select v from t where k = 'tok3')) ->> 'found')::boolean, 'track-only jobs have no page');
insert into t select 'ics1', public.booking_ics((select v from t where k = 'tok1'));
insert into t select 'ics2', public.booking_ics((select v from t where k = 'tok2'));
select pg_temp.ok((select v from t where k = 'ics1') like E'BEGIN:VCALENDAR\r\n%END:VCALENDAR\r\n' and (select v from t where k = 'ics1') like '%BEGIN:VEVENT%DTSTART:________T130000Z%' or (select v from t where k = 'ics1') like '%DTSTART:________T140000Z%',
                  'calendar file: one timed event in UTC');
select pg_temp.ok((select v from t where k = 'ics1') like E'%LOCATION:Doyle Field\\, Hampden ME\r\n%' and (select v from t where k = 'ics1') like '%STATUS:CONFIRMED%', 'commas escaped, confirmed');
select pg_temp.ok((select v from t where k = 'ics2') like '%DTSTART;VALUE=DATE:%' , 'no time yet: an all-day event');
select pg_temp.ok((select bool_and(octet_length(l) <= 75) from regexp_split_to_table((select v from t where k = 'ics1'), E'\r\n') l), 'every line folded to 75 octets');
select pg_temp.ok(public.booking_ics('0000000000000000000000000000000000ff') is null, 'unknown token: no file');
reset role;

-- ---------------------------------------------------------------- 4. moved / cancelled notes (held)
update public.bookings set picture_day = picture_day + 1 where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok(not exists (select 1 from public.booking_director_notes where booking_id = '00000000-0000-0000-0000-0000000000b1'), 'nothing emailed yet: no moved note');
insert into public.booking_emails (id, booking_id, step_no, subject, status) values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', 1, 'Booked', 'sent');
update public.bookings set picture_day = picture_day + 7 where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select count(*) from public.booking_director_notes n join public.prospect_scheduled_emails e on e.id = n.email_id
                    where n.booking_id = '00000000-0000-0000-0000-0000000000b1' and n.kind = 'moved' and e.status = 'held' and e.needs_review
                      and e.contact_id = '00000000-0000-0000-0000-0000000000cb' and e.subject like 'Hampden Youth Soccer picture day moved to %'
                      and e.body like 'Hi Lee,%It was %#day/%') = 1, 'moved: one held note to the booking''s first contact, old and new date, page link');
update public.bookings set picture_day = picture_day + 1 where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select count(*) from public.booking_director_notes n join public.prospect_scheduled_emails e on e.id = n.email_id where n.booking_id = '00000000-0000-0000-0000-0000000000b1' and e.status = 'held') = 1
                  and (select count(*) from public.booking_director_notes where booking_id = '00000000-0000-0000-0000-0000000000b1') = 2, 'moved again: the newer note replaces the held one');
update public.bookings set location = 'Somewhere else' where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select count(*) from public.booking_director_notes where booking_id = '00000000-0000-0000-0000-0000000000b1') = 2, 'other changes: no note');
update public.bookings set status = 'cancelled' where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select count(*) from public.booking_director_notes n join public.prospect_scheduled_emails e on e.id = n.email_id
                    where n.booking_id = '00000000-0000-0000-0000-0000000000b1' and e.status = 'held' and n.kind = 'cancelled' and e.subject = 'Hampden Youth Soccer picture day cancelled') = 1
                  and not exists (select 1 from public.booking_director_notes n join public.prospect_scheduled_emails e on e.id = n.email_id where n.booking_id = '00000000-0000-0000-0000-0000000000b1' and n.kind = 'moved' and e.status = 'held'),
                  'cancelled: a held cancel note, and the waiting moved note is skipped');
select pg_temp.act(null);
select pg_temp.ok((public.booking_public((select v from t where k = 'tok1')) ->> 'cancelled')::boolean, 'the page says cancelled');
select pg_temp.ok(public.booking_ics((select v from t where k = 'tok1')) like '%STATUS:CANCELLED%', 'the calendar file cancels the event');
reset role;
update public.bookings set picture_day = picture_day + 1 where id = '00000000-0000-0000-0000-0000000000b3';
select pg_temp.ok(not exists (select 1 from public.booking_director_notes where booking_id = '00000000-0000-0000-0000-0000000000b3'), 'track-only jobs: no notes');

-- ---------------------------------------------------------------- 5. files + thank-you, review link guard
select pg_temp.ok((select review_body from public.partner_followup_settings) like '%{{files_block|Everything should be in your hands now%' or strpos((select review_body from public.partner_followup_settings), 'Everything should be in your hands now') = 0,
                  'the default thank-you carries {{files_block}}');
update public.partner_followup_settings set review_link = '', review_auto = true;
insert into public.booking_deliverables (booking_id, label, status, link, done_at) values
  ('00000000-0000-0000-0000-0000000000b4', 'Team composites', 'done', 'https://www.dropbox.com/sh/composites', now());
select pg_temp.ok((select r.email_id is null and r.note like 'No Google review link yet%' from public.partner_reviews r where r.booking_id = '00000000-0000-0000-0000-0000000000b4'),
                  'no review link: the review row is made but nothing is drafted');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
reset role;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'partners', 'edit');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.partner_queue('review', (select id from public.partner_reviews where booking_id = '00000000-0000-0000-0000-0000000000b4'), '00000000-0000-0000-0000-0000000000ca', 'Thanks', 'Thank you!')$$,
                      'no review link: a review email cannot be queued by hand either');
reset role;
update public.partner_followup_settings set review_link = 'https://g.page/r/test/review';
select public.partner_review_autodraft((select id from public.partner_reviews where booking_id = '00000000-0000-0000-0000-0000000000b4'));
select pg_temp.ok((select e.status = 'held' and e.body like '%Here is everything we made for you:%- Team composites: https://www.dropbox.com/sh/composites%https://g.page/r/test/review%'
                     from public.partner_reviews r join public.prospect_scheduled_emails e on e.id = r.email_id where r.booking_id = '00000000-0000-0000-0000-0000000000b4'),
                  'files + thank-you: one held email with each delivered file''s link and the review ask');

-- ---------------------------------------------------------------- 6. season statement email
insert into public.job_results (gotphoto_job_id, job_name, org_id, org_set, picture_day) values ('dir-job-1', 'Hampden Youth Soccer | Fall', '00000000-0000-0000-0000-00000000000a', true, '2026-09-20');
insert into public.job_payments (gotphoto_job_id, amount, paid_on, method, ref) values ('dir-job-1', 300, '2026-03-02', 'Check', '1042'), ('dir-job-1', 80, '2026-03-02', 'Check', '1042');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
insert into t select 'st', public.partner_statement_queue('00000000-0000-0000-0000-00000000000a', '{{league}}: picture day statement', E'{{hi|Hi there}},\n\nHere is your statement.\n\n{{paid_line}}')::text;
select pg_temp.ok((select v from t where k = 'st')::jsonb ->> 'paid_line' = 'Check for $380.00 mailed on March 2, 2026 (check #1042).', 'paid line from the latest payment: ' || ((select v from t where k = 'st')::jsonb ->> 'paid_line'));
reset role;
select pg_temp.ok((select e.status = 'held' and e.needs_review and e.subject = 'Hampden Youth Soccer: picture day statement' and e.body like 'Hi Dana,%Check for $380.00 mailed on March 2, 2026%'
                     from public.prospect_scheduled_emails e where e.id = ((select v from t where k = 'st')::jsonb ->> 'email_id')::uuid), 'statement held in the outbox, to the main contact');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.partner_statement_queue('00000000-0000-0000-0000-00000000000a', 'x', 'y')$$, 'no results edit: no statement email');
reset role;

-- ---------------------------------------------------------------- 7. the email series (steps migration, re-run on test rows)
insert into public.booking_sequences (id, type_key, name, is_active) values ('00000000-0000-0000-0000-0000000005e1', 'sports_data', 'Director test sequence', false);
insert into public.booking_steps (id, sequence_id, step_no, label, offset_days, send_time, subject, body_md, is_active, kind, "trigger", hub_key, covered_by_gotphoto, school_days) values
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000005e1', 1, 'Start here', 0, '07:30', '{{org}} picture day', E'Hello {{first_name|there}},\n\n**1. Go to 207photo.com/sportsadmin**\n\nWarmly,', true, 'admin', 'picture_day', null, false, false),
  ('00000000-0000-0000-0000-0000000005a2', '00000000-0000-0000-0000-0000000005e1', 2, 'Schedule check', 14, '07:30', '{{org}}: schedule', E'Hi {{first_name|there}},\n\nHere is the plan.', true, 'admin', 'picture_day', null, false, false),
  ('00000000-0000-0000-0000-0000000005a3', '00000000-0000-0000-0000-0000000005e1', 10, 'One week before', 7, '07:30', 'Today: send your "{{hub_title}}" message ({{org}})', E'Hi {{first_name|there}},\n\nToday is a send day for {{org}}. {{hub_detail}}\n\n{{hub_link}}', true, 'hub', 'picture_day', 'heads', false, false),
  ('00000000-0000-0000-0000-0000000005a4', '00000000-0000-0000-0000-0000000005e1', 11, 'Day before', 1, '07:30', 'Today: send your "{{hub_title}}" message ({{org}})', E'Hi,\n\nToday is a send day for {{org}}.', true, 'hub', 'picture_day', 'day', false, false),
  ('00000000-0000-0000-0000-0000000005a5', '00000000-0000-0000-0000-0000000005e1', 12, 'Photos are online', 0, '07:30', 'Photos are online', E'{{live_note}}', true, 'hub', 'gallery_live', 'live', false, false);
\ir ../migrations/20261024060100_director_steps.sql
select pg_temp.ok((select count(*) from public.booking_steps where sequence_id = '00000000-0000-0000-0000-0000000005e1' and "trigger" = 'booking' and not is_active and offset_days = 0
                     and body_md like '%{{when_line}}%{{calendar_link}}%on-site contact%roster (or tell us families will pre-register)%{{day_link}}%') = 1, 'Booked step added, switched off, with the asks and the links');
select pg_temp.ok((select body_md from public.booking_steps where id = '00000000-0000-0000-0000-0000000005a1') = E'Hello {{first_name|there}},\n\n**1. Go to 207photo.com/sportsadmin**\n\n{{families_block}}\n\n{{flyer_line}}\n\nWarmly,',
                  'set-up email: families block and flyer line above the sign-off');
select pg_temp.ok((select body_md from public.booking_steps where id = '00000000-0000-0000-0000-0000000005a2') like E'Here is the plan.\n\n{{day_of_block}}\n\n{{weather_line}}\n\n{{team_times}}\n\n%{{day_link}}' or
                  (select body_md from public.booking_steps where id = '00000000-0000-0000-0000-0000000005a2') like E'%Here is the plan.\n\n{{day_of_block}}\n\n{{weather_line}}\n\n{{team_times}}\n\n%{{day_link}}', 'two-week email: day-of, weather, team times, page link at the end');
select pg_temp.ok((select offset_days = 8 and send_time = '18:00' and subject like 'Tomorrow: send your%' and body_md like '%Tomorrow is a send day for {{org}}. The message is ready now, so any time this week works.%'
                     from public.booking_steps where id = '00000000-0000-0000-0000-0000000005a3'), 'one-week hub reminder: the evening before, "any time this week"');
select pg_temp.ok((select offset_days = 2 and send_time = '18:00' and body_md like '%Tomorrow is a send day for {{org}}. The message is ready now; send it tomorrow.%'
                     from public.booking_steps where id = '00000000-0000-0000-0000-0000000005a4'), 'day-before hub reminder: the evening before, "send it tomorrow"');
select pg_temp.ok((select offset_days = 0 and send_time = '07:30' and subject = 'Photos are online' from public.booking_steps where id = '00000000-0000-0000-0000-0000000005a5'), 'gallery-live hub step unchanged');
insert into t select 'snap', (select jsonb_agg(to_jsonb(s) - 'updated_at' order by s.step_no) from public.booking_steps s where s.sequence_id = '00000000-0000-0000-0000-0000000005e1')::text;
\ir ../migrations/20261024060100_director_steps.sql
select pg_temp.ok((select jsonb_agg(to_jsonb(s) - 'updated_at' order by s.step_no) from public.booking_steps s where s.sequence_id = '00000000-0000-0000-0000-0000000005e1') = (select v from t where k = 'snap')::jsonb,
                  'running the steps migration again changes nothing');

do $$ begin raise notice 'ALL DIRECTOR TESTS PASSED'; end $$;
rollback;
