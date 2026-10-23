-- Tests for 20261023101500_crew_confirm_time_off (crew roles, Confirm / Can't make it, weekly schedule email,
-- time off requests, capacity). Run against a NON-production copy of the schema after the migration, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/crew_confirm_time_off_test.sql
-- "ALL CREW TESTS PASSED" at the end means every check held.

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
create temp table rl (id uuid, label text);
grant select on rl to anon, authenticated;

-- o1 full access; e1 edits scheduling + timeoff; v1 views scheduling; c1 crew with no modules (a part-timer); x1 deactivated
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'o1@example.com'), ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'c1@example.com'), ('00000000-0000-0000-0000-0000000000f9', 'x1@example.com');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into public.team_members (user_id, display_name, active, home_address) values ('00000000-0000-0000-0000-0000000000a1', 'Owner One', true, ''),
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true, '1 Main St, Bangor ME'), ('00000000-0000-0000-0000-0000000000c1', 'View One', true, ''),
  ('00000000-0000-0000-0000-0000000000d1', 'Crew One', true, '5 Elm St, Hampden ME'), ('00000000-0000-0000-0000-0000000000f9', 'Gone One', false, '')
  on conflict (user_id) do update set display_name = excluded.display_name, home_address = excluded.home_address;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'scheduling', 'edit'), ('00000000-0000-0000-0000-0000000000e1', 'timeoff', 'edit'),
  ('00000000-0000-0000-0000-0000000000c1', 'scheduling', 'view');
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('00000000-0000-0000-0000-0000000000d1', 'https://push.example/d1', 'k', 'a');
update public.staff_settings set studio_address = '60 Main Rd, Hampden ME' where id;

-- b1 booked, one day; b2 booked, two days; b3 track-only
insert into public.prospect_orgs (id, name, town) values ('00000000-0000-0000-0000-00000000aaa1', 'Test Academy', 'Hampden');
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, location, status) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000aaa1', 'school', 'School Photos', '2026-11-03', '2026-11-03 09:00 America/New_York', '2026-11-03 12:00 America/New_York', '12 Gym Rd, Hampden ME', 'booked'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000aaa1', 'sports', 'Fall Sports', '2026-11-04', '2026-11-04 15:00 America/New_York', '2026-11-04 18:00 America/New_York', '', 'booked'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000aaa1', 'sports', 'Old League', '2026-11-05', '2026-11-05 09:00 America/New_York', '2026-11-05 10:00 America/New_York', '', 'tracked');
insert into public.booking_days (booking_id, day, start_at, end_at, sort) values
  ('00000000-0000-0000-0000-0000000000b2', '2026-11-04', '2026-11-04 15:00 America/New_York', '2026-11-04 18:00 America/New_York', 0),
  ('00000000-0000-0000-0000-0000000000b2', '2026-11-06', '2026-11-06 15:00 America/New_York', '2026-11-06 18:00 America/New_York', 1);

select pg_temp.ok(exists (select 1 from public.app_modules where key = 'timeoff' and status = 'live' and not admin_only), 'timeoff module exists and is grantable');
select pg_temp.ok((select count(*) from public.crew_roles where archived_at is null) = 4, 'four starter roles');
select pg_temp.ok((select count(*) from cron.job where jobname in ('crew-send-due', 'week-email-auto')) = 2, 'crons scheduled');
select pg_temp.ok((select count(*) from public.push_topics where key in ('crew_ask', 'crew_declined', 'timeoff_request', 'timeoff_decided')) = 4 and not exists (select 1 from public.push_topics where key = 'week_schedule'), 'push kinds added (no week push: the email is enough)');
select pg_temp.ok(not (select crew_confirm_on from public.staff_settings where id), 'crew confirmations start off');
update public.staff_settings set crew_confirm_on = true where id;

-- ---------------------------------------------------------------- outsiders
select pg_temp.act(null);
select pg_temp.raises($$select public.crew_roles_list()$$, 'anon: no roles');
select pg_temp.raises($$select public.time_off_list()$$, 'anon: no time off');
select pg_temp.raises($$select public.crew_ask_deliver(gen_random_uuid(), false)$$, 'anon: cannot send asks');
select pg_temp.raises($$select public.week_email_content('00000000-0000-0000-0000-0000000000d1', '2026-11-01')$$, 'anon: cannot read week emails');
select pg_temp.raises($$select * from public.crew_asks$$, 'anon: asks table not readable');
select pg_temp.ok(public.crew_public('nope') is null, 'anon: a bad token shows nothing');
select pg_temp.raises($$select public.crew_answer(repeat('0', 36), 'confirm')$$, 'anon: a bad token cannot answer');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.crew_options('00000000-0000-0000-0000-0000000000b1', '2026-11-03')$$, 'c1: no crew picker');
select pg_temp.raises($$select public.week_email_send('2026-11-01')$$, 'c1: cannot email the week');
select pg_temp.raises($$select public.crew_needed_set('00000000-0000-0000-0000-0000000000b1', 2)$$, 'c1: cannot set people needed');
select pg_temp.raises($$select * from public.time_off_requests$$, 'c1: time off table not readable');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.crew_role_save('{"label":"Driver"}')$$, 'v1: view cannot add roles');
select pg_temp.raises($$select public.time_off_decide(gen_random_uuid(), true)$$, 'v1: cannot approve time off');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1', 'aal1');
select pg_temp.raises($$select public.crew_options('00000000-0000-0000-0000-0000000000b1', '2026-11-03')$$, 'e1 without the second sign-in step: refused');

-- ---------------------------------------------------------------- roles
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.crew_role_save('{"label":"Driver","sort":50}') ->> 'ok')::boolean, 'e1 adds a role');
select pg_temp.raises($$select public.crew_role_save('{"label":"driver"}')$$, 'e1: no duplicate role names');
reset role; insert into rl select id, label from public.crew_roles;
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.team_set_roles('00000000-0000-0000-0000-0000000000d1', array[(select id from rl where label = 'Lead'), (select id from rl where label = 'Driver')]) ->> 'ok')::boolean, 'e1 sets c1''s roles');
select pg_temp.ok(jsonb_array_length(public.crew_roles_list() -> 'members' -> '00000000-0000-0000-0000-0000000000d1') = 2, 'c1 has two roles');
select pg_temp.ok((public.crew_role_archive((select id from rl where label = 'Driver')) ->> 'ok')::boolean, 'e1 archives a role');
select pg_temp.ok(jsonb_array_length(public.crew_roles_list() -> 'members' -> '00000000-0000-0000-0000-0000000000d1') = 1, 'archived roles drop off people');

-- ---------------------------------------------------------------- putting people on jobs creates asks
select pg_temp.ok((public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000d1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b1',
  'starts_at', '2026-11-03 09:00 America/New_York', 'ends_at', '2026-11-03 12:00 America/New_York', 'drive_before_min', 20, 'drive_after_min', 20,
  'role_id', (select id from rl where label = 'Lead'))) ->> 'ok')::boolean, 'c1 on b1 as Lead');
reset role;
select pg_temp.ok((select r.label from public.schedule_entries e join public.crew_roles r on r.id = e.role_id where e.user_id = '00000000-0000-0000-0000-0000000000d1' and e.booking_id = '00000000-0000-0000-0000-0000000000b1') = 'Lead', 'the bar keeps its role');
select pg_temp.ok((select status from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b1' and user_id = '00000000-0000-0000-0000-0000000000d1') = 'pending', 'an ask is waiting');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
-- two days of b2 for c1 = one ask
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000d1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b2',
  'starts_at', '2026-11-04 15:00 America/New_York', 'ends_at', '2026-11-04 18:00 America/New_York'));
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000d1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b2',
  'starts_at', '2026-11-06 15:00 America/New_York', 'ends_at', '2026-11-06 18:00 America/New_York'));
reset role;
select pg_temp.ok((select count(*) from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b2') = 1, 'one ask per person per job, however many days');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000e1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b3',
  'starts_at', '2026-11-05 09:00 America/New_York', 'ends_at', '2026-11-05 10:00 America/New_York'));
reset role;
select pg_temp.ok(not exists (select 1 from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b3'), 'track-only jobs never ask');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000e1', 'kind', 'studio', 'starts_at', '2026-11-02 09:00 America/New_York', 'ends_at', '2026-11-02 12:00 America/New_York'));
reset role;
select pg_temp.ok(not exists (select 1 from public.crew_asks where user_id = '00000000-0000-0000-0000-0000000000e1'), 'studio time never asks');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
-- schedule_week carries it all
select pg_temp.ok((select x -> 'confirm' ->> 'status' from jsonb_array_elements(public.schedule_week('2026-11-01') -> 'entries') x
                   where x ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1') = 'pending', 'schedule_week: the bar says pending');
select pg_temp.ok((select x ->> 'role' from jsonb_array_elements(public.schedule_week('2026-11-01') -> 'entries') x
                   where x ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1') = 'Lead', 'schedule_week: the bar says Lead');
select pg_temp.ok(jsonb_array_length((select x -> 'roles' from jsonb_array_elements(public.schedule_week('2026-11-01') -> 'people') x where x ->> 'user_id' = '00000000-0000-0000-0000-0000000000d1')) = 1, 'schedule_week: people carry their roles');
select pg_temp.ok(jsonb_array_length(public.schedule_week('2026-11-01') -> 'crew' -> 'roles') = 4, 'schedule_week: the crew extras');

-- ---------------------------------------------------------------- sending
select pg_temp.act(null); reset role;
select pg_temp.ok(public.crew_ask_deliver((select id from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b1'), false), 'the ask goes out');
select pg_temp.ok((select count(*) from net.calls where url = 'https://api.resend.com/emails' and body ->> 'to' like '%c1@example.com%') = 1, 'an email to c1');
select pg_temp.ok((select body ->> 'html' from net.calls where url = 'https://api.resend.com/emails' order by id desc limit 1) like '%#crew/%/yes%', 'the email has a Confirm button');
select pg_temp.ok((select body ->> 'html' from net.calls where url = 'https://api.resend.com/emails' order by id desc limit 1) like '%leave the studio 8:40am%', 'the email says when to leave');
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'crew_ask' and target_user = '00000000-0000-0000-0000-0000000000d1') = 1, 'and a push to c1 only');
select pg_temp.ok((select asked_at is not null from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b1'), 'asked_at is set');
select pg_temp.ok(not public.crew_ask_deliver((select id from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b3' limit 1), false) is true, 'nothing to send for track-only');
-- the cron obeys the switch and quiet hours
update public.staff_settings set crew_confirm_on = false where id;
select pg_temp.ok(public.crew_send_due() = 0, 'switched off: nothing sent');
update public.staff_settings set crew_confirm_on = true where id;
update public.crew_asks set queued_at = now() - interval '5 minutes' where booking_id = '00000000-0000-0000-0000-0000000000b2';
select pg_temp.ok(case when extract(hour from now() at time zone 'America/New_York') between 7 and 20 then public.crew_send_due() = 1 else public.crew_send_due() = 0 end,
                  'the cron sends due asks in the day, nothing at night');
update public.crew_asks set asked_at = coalesce(asked_at, now()) where booking_id = '00000000-0000-0000-0000-0000000000b2';

-- ---------------------------------------------------------------- the public page
create temp table tok as select token, booking_id from public.crew_asks;
grant select on tok to anon, authenticated;
select pg_temp.act(null);
select pg_temp.ok((public.crew_public((select token from tok where booking_id = '00000000-0000-0000-0000-0000000000b2')) ->> 'name') = 'Crew', 'anon: the page greets them by first name');
select pg_temp.ok(jsonb_array_length(public.crew_public((select token from tok where booking_id = '00000000-0000-0000-0000-0000000000b2')) -> 'days') = 2, 'anon: both days of b2');
select pg_temp.ok((public.crew_answer((select token from tok where booking_id = '00000000-0000-0000-0000-0000000000b1'), 'confirm') ->> 'status') = 'confirmed', 'anon: confirms b1');
select pg_temp.raises($$select public.crew_answer((select token from tok where booking_id = '00000000-0000-0000-0000-0000000000b1'), 'maybe')$$, 'anon: only confirm or decline');
select pg_temp.ok((public.crew_answer((select token from tok where booking_id = '00000000-0000-0000-0000-0000000000b2'), 'decline', 'Sick kid') ->> 'status') = 'declined', 'anon: can''t make b2');
reset role;
select pg_temp.ok(not exists (select 1 from public.schedule_entries where booking_id = '00000000-0000-0000-0000-0000000000b2' and user_id = '00000000-0000-0000-0000-0000000000d1'), 'declining takes their b2 bars off');
select pg_temp.ok((select status from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b2') = 'declined', 'the decline is kept');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'crew_declined' and target_user is null and body like '%Sick kid%'), 'the schedulers get a push with the reason');
select pg_temp.act(null);
select pg_temp.raises($$select public.crew_answer((select token from tok where booking_id = '00000000-0000-0000-0000-0000000000b2'), 'confirm')$$, 'anon: cannot flip a decline back');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.schedule_week('2026-11-01') -> 'crew' -> 'declined' -> 0 ->> 'reason') = 'Sick kid', 'v1: the week shows who can''t make it');

-- ---------------------------------------------------------------- changes ask again
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
reset role; create temp table b1e as select id from public.schedule_entries where booking_id = '00000000-0000-0000-0000-0000000000b1' and user_id = '00000000-0000-0000-0000-0000000000d1'; grant select on b1e to authenticated;
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.schedule_save(jsonb_build_object('id', (select id from b1e),
  'user_id', '00000000-0000-0000-0000-0000000000d1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b1',
  'starts_at', '2026-11-03 10:00 America/New_York', 'ends_at', '2026-11-03 12:00 America/New_York', 'drive_before_min', 20, 'drive_after_min', 20));
reset role;
select pg_temp.ok((select status = 'pending' and changed and asked_at is null from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b1'), 'a new time asks a confirmed person again');
select pg_temp.ok((select r.label from public.schedule_entries e join public.crew_roles r on r.id = e.role_id where e.booking_id = '00000000-0000-0000-0000-0000000000b1') = 'Lead', 'saving without role_id keeps the role');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.schedule_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000d1', 'kind', 'job', 'booking_id', '00000000-0000-0000-0000-0000000000b2',
  'starts_at', '2026-11-04 15:00 America/New_York', 'ends_at', '2026-11-04 18:00 America/New_York'));
reset role;
select pg_temp.ok((select status = 'pending' and not changed from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b2'), 'put back on after declining: asked again');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
reset role; create temp table rm as select id from public.schedule_entries where booking_id = '00000000-0000-0000-0000-0000000000b2' and user_id = '00000000-0000-0000-0000-0000000000d1'; grant select on rm to authenticated;
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.schedule_remove((select id from rm));
reset role;
select pg_temp.ok(not exists (select 1 from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b2'), 'taken off the job: the ask goes');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.crew_ask_now('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1') ->> 'ok')::boolean, 'e1: Ask to confirm sends now');
select pg_temp.raises($$select public.crew_ask_now('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000e1')$$, 'e1: track-only jobs cannot ask');
select pg_temp.ok((public.crew_for_booking('00000000-0000-0000-0000-0000000000b1') -> 'crew' -> 0 ->> 'status') = 'pending', 'crew_for_booking: status per person');
select pg_temp.ok((public.crew_attention() ->> 'waiting')::int = 0, 'Today: b1 is more than a week out, so it is not flagged yet');

-- ---------------------------------------------------------------- people needed, capacity, picker
select pg_temp.ok((public.crew_needed_set('00000000-0000-0000-0000-0000000000b1', 2) ->> 'ok')::boolean, 'e1: b1 needs 2');
select pg_temp.raises($$select public.crew_needed_set('00000000-0000-0000-0000-0000000000b1', 0)$$, 'e1: at least 1');
select pg_temp.ok((public.schedule_week('2026-11-01') -> 'crew' -> 'needed' ->> '00000000-0000-0000-0000-0000000000b1')::int = 2, 'schedule_week: needed');
select pg_temp.ok((select (d ->> 'needed')::int from jsonb_array_elements(public.crew_capacity('2026-11-01', 14) -> 'days') d where d ->> 'day' = '2026-11-03') = 2, 'capacity: Nov 3 needs 2');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.crew_capacity('2026-11-01', 14) -> 'days') d where d ->> 'day' = '2026-11-05'), 'capacity: track-only days left out');
reset role;
insert into public.offer_drive_cache (origin, destination, minutes) values ('5 elm st, hampden me', '12 gym rd, hampden me', 9), ('60 main rd, hampden me', '12 gym rd, hampden me', 14);
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((select (x ->> 'home_min')::int from jsonb_array_elements(public.crew_options('00000000-0000-0000-0000-0000000000b1', '2026-11-03') -> 'people') x where x ->> 'user_id' = '00000000-0000-0000-0000-0000000000d1') = 9, 'picker: drive from home');
select pg_temp.ok((public.crew_options('00000000-0000-0000-0000-0000000000b1', '2026-11-03') ->> 'studio_min')::int = 14, 'picker: drive from the studio');
select pg_temp.ok((select (x ->> 'on_it')::boolean from jsonb_array_elements(public.crew_options('00000000-0000-0000-0000-0000000000b1', '2026-11-03') -> 'people') x where x ->> 'user_id' = '00000000-0000-0000-0000-0000000000d1'), 'picker: already on it');
select pg_temp.ok((public.crew_options(null, '2026-11-03', '12 Gym Rd, Hampden ME') ->> 'studio_min')::int = 14, 'picker before the booking exists: typed address');
select pg_temp.ok((select jsonb_array_length(public.crew_drive_targets('00000000-0000-0000-0000-0000000000b1') -> 'origins')) = 1, 'drive targets: only the uncached home');
select pg_temp.ok((public.crew_drive_store('12 Gym Rd, Hampden ME', '[{"origin":"1 Main St, Bangor ME","minutes":22}]') ->> 'stored')::int = 1, 'drive store');

-- ---------------------------------------------------------------- weekly email
select pg_temp.ok(jsonb_array_length(public.week_email_preview('2026-11-01')) = 2, 'preview: e1 and c1 have something that week');
select pg_temp.raises($$select public.week_email_send('2026-11-02')$$, 'the week starts on a Sunday');
select pg_temp.ok((public.week_email_send('2026-11-01', array['00000000-0000-0000-0000-0000000000d1'::uuid]) ->> 'sent')::int = 1, 'e1 emails c1 their week');
reset role;
select pg_temp.ok((select body ->> 'subject' from net.calls where url = 'https://api.resend.com/emails' order by id desc limit 1) like 'Your schedule, week of Nov 1: 1 job, 1 to confirm', 'the subject counts jobs and answers');
select pg_temp.ok((select body ->> 'html' from net.calls where url = 'https://api.resend.com/emails' order by id desc limit 1) not like '%Edit One%', 'only their own schedule');
select pg_temp.ok((select body ->> 'html' from net.calls where url = 'https://api.resend.com/emails' order by id desc limit 1) like '%(Lead)%', 'the role is in it');
select pg_temp.ok(not exists (select 1 from public.push_outbox where topic = 'week_schedule'), 'no push on top of the email');
select pg_temp.ok(public.week_email_content('00000000-0000-0000-0000-0000000000c1', '2026-11-01') is null, 'nothing on: no email');
select pg_temp.ok((public.week_email_deliver('2026-11-01', array['00000000-0000-0000-0000-0000000000d1'::uuid], false) ->> 'sent')::int = 0, 'the automatic send skips people already sent');
select pg_temp.ok(public.week_email_auto() = 0, 'automatic send is off by default');

-- ---------------------------------------------------------------- time off
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.ok((public.time_off_request('{"first_day":"2026-11-03","last_day":"2026-11-04","note":"Wedding"}') ->> 'ok')::boolean, 'c1 asks for two days off');
select pg_temp.raises($$select public.time_off_request('{"first_day":"2026-11-04"}')$$, 'c1: not the same days twice');
select pg_temp.raises($$select public.time_off_request('{"first_day":"2026-11-10","last_day":"2026-11-11","start_time":"09:00","end_time":"12:00"}')$$, 'c1: hours only on one day');
select pg_temp.ok((public.time_off_request('{"first_day":"2026-11-10","start_time":"09:00","end_time":"12:00"}') ->> 'ok')::boolean, 'c1 asks for a morning off');
select pg_temp.ok(jsonb_array_length(public.time_off_list() -> 'mine') = 2 and public.time_off_list() -> 'team' = 'null'::jsonb, 'c1 sees only their own');
select pg_temp.ok((select jsonb_array_length(x -> 'jobs') from jsonb_array_elements(public.time_off_list() -> 'mine') x where x ->> 'first_day' = '2026-11-03') = 1, 'the request knows c1 is on b1 then');
reset role; create temp table tor as select id, first_day from public.time_off_requests; grant select on tor to authenticated;
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'timeoff_request' and title like 'Crew One%'), 'the approvers get a push');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(jsonb_array_length(public.schedule_week('2026-11-01') -> 'crew' -> 'requests') = 1, 'the Schedule shows the waiting request');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((select (x ->> 'asked_off')::boolean from jsonb_array_elements(public.crew_options('00000000-0000-0000-0000-0000000000b1', '2026-11-03') -> 'people') x where x ->> 'user_id' = '00000000-0000-0000-0000-0000000000d1'), 'the picker shows the waiting request');
select pg_temp.ok(jsonb_array_length(public.time_off_list() -> 'team') = 2, 'e1 sees the team''s');
select pg_temp.ok((public.crew_attention() ->> 'timeoff')::int = 2, 'Today: two to approve');
select pg_temp.ok((public.time_off_decide((select id from tor where first_day = '2026-11-03'), true, 'Enjoy!') ->> 'jobs')::int = 1, 'e1 approves, and is told about the job');
reset role;
select pg_temp.ok(exists (select 1 from public.schedule_entries where user_id = '00000000-0000-0000-0000-0000000000d1' and kind = 'off'
                            and starts_at = '2026-11-03 00:00 America/New_York' and ends_at = '2026-11-05 00:00 America/New_York'), 'a Time off bar on the Schedule');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.time_off_decide((select id from tor where first_day = '2026-11-10'), false, 'Busy morning') ->> 'ok')::boolean, 'e1 declines the morning');
select pg_temp.raises($$select public.time_off_decide((select id from tor where first_day = '2026-11-10'), true)$$, 'e1: cannot decide twice');
reset role;
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'timeoff_decided' and target_user = '00000000-0000-0000-0000-0000000000d1') = 2, 'c1 hears both answers');
select pg_temp.ok(exists (select 1 from net.calls where body ->> 'subject' = 'Time off declined: Tue Nov 10, 9:00am-12:00pm'), 'and an email');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.time_off_cancel((select id from tor where first_day = '2026-11-03'))$$, 'o1: cannot cancel someone else''s');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.ok((public.time_off_cancel((select id from tor where first_day = '2026-11-03')) ->> 'ok')::boolean, 'c1 cancels the approved days');
reset role;
select pg_temp.ok(not exists (select 1 from public.schedule_entries where user_id = '00000000-0000-0000-0000-0000000000d1' and kind = 'off'), 'the bar comes off');

-- ---------------------------------------------------------------- my jobs
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.ok(jsonb_array_length(public.crew_mine()) = 1 and (public.crew_mine() -> 0 ->> 'status') = 'pending', 'c1: My jobs lists b1, pending');
select pg_temp.ok((public.crew_attention() ->> 'mine')::int = 1, 'Today: one of mine to confirm');
select pg_temp.ok((select x -> 'confirm' ->> 'status' from jsonb_array_elements(public.my_day('2026-11-03') -> 'entries') x where x ->> 'kind' = 'job') = 'pending', 'my_day carries the answer');
select pg_temp.raises($$select public.crew_ask_now('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1')$$, 'c1: cannot re-send asks');

-- ---------------------------------------------------------------- settings
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.crew_settings_save('{"week_email_auto":true,"week_email_dow":5,"week_email_hour":15}') ->> 'ok')::boolean, 'e1 turns on the Friday email');
select pg_temp.raises($$select public.crew_settings_save('{"week_email_hour":23}')$$, 'e1: hour 6am to 8pm');
select pg_temp.ok((public.schedule_week('2026-11-01') -> 'crew' -> 'settings' ->> 'week_email_auto')::boolean, 'schedule_week: settings');

do $$ begin raise notice 'ALL CREW TESTS PASSED'; end $$;
rollback;
