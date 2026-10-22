-- Tests for 20261022233000_staff_gear_records. Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/staff_records_test.sql
-- "ALL STAFF RECORDS TESTS PASSED" at the end means every check held. Dates are relative to today.

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
create temp table d as select (now() at time zone 'America/New_York')::date as today;
grant select on d to anon, authenticated;

-- o1 full access; e1 edits staff records; v1 and w1 view them; n1 has none. v1 and w1 are on the school job.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'o1@example.com'), ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'), ('00000000-0000-0000-0000-0000000000c2', 'w1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000a1', 'Owner One', true),
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000c1', 'View One', true),
  ('00000000-0000-0000-0000-0000000000c2', 'View Two', true), ('00000000-0000-0000-0000-0000000000d1', 'No One', true)
  on conflict (user_id) do update set display_name = excluded.display_name;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'staffrecords', 'edit'),
  ('00000000-0000-0000-0000-0000000000c1', 'staffrecords', 'view'), ('00000000-0000-0000-0000-0000000000c2', 'staffrecords', 'view'),
  ('00000000-0000-0000-0000-0000000000d1', 'inventory', 'view');

-- Pretend o1, e1 and n1 were on the team before this migration (they would not be on the checklist).
delete from public.staff_onboarding where user_id not in ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2');

select pg_temp.ok((select status from public.app_modules where key = 'staffrecords') = 'live', 'staffrecords module is live');
select pg_temp.ok(exists (select 1 from public.push_topics where key = 'clearance_warning' and module = 'staffrecords'), 'clearance warning notification kind exists');
select pg_temp.ok((select count(*) from public.staff_onboarding where user_id in ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2')) = 2,
  'people added to the team start on the onboarding checklist');

-- A school job in 5 days (v1, w1 scheduled), a sports job in 6 days (v1), a cancelled school job in 7 days (w1).
insert into public.bookings (id, type_key, title_override, picture_day, start_at, end_at, status, time_set, end_set)
select x.id::uuid, x.t, x.title, (select today from d) + x.n, ((select today from d) + x.n) + time '09:00', ((select today from d) + x.n) + time '12:00', x.st, true, true
  from (values ('00000000-0000-0000-0000-0000000000b1', 'school', 'Hampden Academy', 5, 'booked'),
               ('00000000-0000-0000-0000-0000000000b2', 'sports_data', 'Brewer Soccer', 6, 'booked'),
               ('00000000-0000-0000-0000-0000000000b3', 'school', 'Old School', 7, 'cancelled'),
               ('00000000-0000-0000-0000-0000000000b4', 'school', 'Inquiry School', 8, 'inquiry')) x(id, t, title, n, st);
insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at)
select u::uuid, 'job', b::uuid, (((select today from d) + n) + time '09:00') at time zone 'America/New_York', (((select today from d) + n) + time '12:00') at time zone 'America/New_York'
  from (values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 5), ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1', 5),
               ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b2', 6), ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b3', 7),
               ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b4', 8)) x(u, b, n);

-- The step ids below are looked up directly (only inside this rolled-back test).
grant select on public.staff_onboarding_steps to authenticated;
create policy test_peek on public.staff_onboarding_steps for select to authenticated using (true);

-- ---------------------------------------------------------------- outsiders
select pg_temp.act(null);
select pg_temp.raises($$select public.staff_records()$$, 'anon: no staff records');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.staff_records()$$, 'n1: no staff records');
select pg_temp.raises($$select public.staff_records_attention()$$, 'n1: no attention');
select pg_temp.raises($$select * from public.staff_clearances$$, 'n1: clearances not readable');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1', 'aal1');
select pg_temp.raises($$select public.staff_records()$$, 'v1 without the second sign-in step: refused');

-- ---------------------------------------------------------------- e1: edit
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.staff_records() ->> 'can_edit')::boolean, 'e1: can edit');
select pg_temp.ok(jsonb_array_length(public.staff_records() -> 'people') = 5, 'e1: sees everyone active');
select pg_temp.ok(jsonb_array_length(public.staff_records() -> 'school') = 2, 'e1: two people on the booked school job lack a background check');
select pg_temp.ok((select bool_and(x ->> 'problem' = 'missing' and x ->> 'type_key' = 'background') from jsonb_array_elements(public.staff_records() -> 'school') x), 'e1: both are missing');
select pg_temp.ok((public.staff_records_attention() ->> 'school')::int = 2, 'e1: Today counts two');

-- v1: current check. w1: expires the day before the job.
select public.staff_clearance_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000c1', 'type_key', 'background',
  'done_on', (select today from d) - 300, 'expires_on', (select today from d) + 400, 'reference', ' BC-1 '));
select public.staff_clearance_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000c2', 'type_key', 'background',
  'done_on', (select today from d) - 700, 'expires_on', (select today from d) + 4));
select pg_temp.ok(jsonb_array_length(public.staff_records() -> 'school') = 1, 'e1: one problem left');
select pg_temp.ok((public.staff_records() -> 'school' -> 0 ->> 'problem') = 'expired' and (public.staff_records() -> 'school' -> 0 ->> 'name') = 'View Two', 'e1: w1 runs out before the job');
select pg_temp.ok((public.staff_records_attention() ->> 'expiring')::int = 1, 'e1: one clearance runs out soon');
select pg_temp.ok((select x -> 'clearances' -> 0 ->> 'state' from jsonb_array_elements(public.staff_records() -> 'people') x where x ->> 'name' = 'View Two') = 'soon', 'e1: w1''s check shows as running out soon');
select pg_temp.ok((select x -> 'clearances' -> 0 ->> 'reference' from jsonb_array_elements(public.staff_records() -> 'people') x where x ->> 'name' = 'View One') = 'BC-1', 'e1: reference is trimmed');
select pg_temp.raises($$select public.staff_clearance_save(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000c2', 'type_key', 'background', 'done_on', current_date, 'expires_on', current_date - 1))$$, 'e1: cannot run out before it was done');
select pg_temp.raises($$select public.staff_clearance_save('{"user_id":"00000000-0000-0000-0000-0000000000c2","type_key":"nope"}')$$, 'e1: unknown clearance type refused');

-- New type, required for schools.
select pg_temp.ok((public.staff_clearance_type_save('{"label":"Mandated reporter","school_required":true,"warn_days":14}') ->> 'key') = 'mandated_reporter', 'e1: adds a clearance type');
select pg_temp.ok(jsonb_array_length(public.staff_records() -> 'school') = 3, 'e1: new school requirement adds a problem for each person');
select public.staff_clearance_type_save('{"key":"mandated_reporter","label":"Mandated reporter","archived":true}');
select pg_temp.ok(jsonb_array_length(public.staff_records() -> 'school') = 1, 'e1: archived types stop counting');

-- Onboarding
select pg_temp.ok(jsonb_array_length(public.staff_records() -> 'steps') = 9, 'e1: nine starter steps');
select pg_temp.ok((select jsonb_array_length(x -> 'onboarding' -> 'done') from jsonb_array_elements(public.staff_records() -> 'people') x where x ->> 'name' = 'View One') = 1,
  'e1: v1''s background check step ticked itself');
select pg_temp.ok((select (x -> 'onboarding' -> 'done' -> 0 ->> 'auto')::boolean from jsonb_array_elements(public.staff_records() -> 'people') x where x ->> 'name' = 'View One'), 'e1: and says it was automatic');
select pg_temp.ok((select x -> 'onboarding' from jsonb_array_elements(public.staff_records() -> 'people') x where x ->> 'name' = 'Owner One') = 'null'::jsonb, 'e1: people already on the team are not on the checklist');
select pg_temp.ok((public.staff_onboarding_set('00000000-0000-0000-0000-0000000000a1', true) ->> 'ok')::boolean, 'e1: starts the owner on it');
select pg_temp.ok((public.staff_records_attention() ->> 'onboarding')::int = 3, 'e1: three people onboarding');
select pg_temp.ok((public.staff_onboarding_check('00000000-0000-0000-0000-0000000000c2', (select id from public.staff_onboarding_steps where sort = 10), true) ->> 'ok')::boolean, 'e1: ticks a step for w1');
select public.staff_onboarding_set('00000000-0000-0000-0000-0000000000a1', false);
select pg_temp.ok((public.staff_records_attention() ->> 'onboarding')::int = 2, 'e1: takes the owner off it');
-- Finish v1: tick every step that isn't automatic.
select public.staff_onboarding_check('00000000-0000-0000-0000-0000000000c1', s.id, true) from public.staff_onboarding_steps s where s.clearance_key is null;
reset role;
select pg_temp.ok((select finished_at is null from public.staff_onboarding where user_id = '00000000-0000-0000-0000-0000000000c1'), 'v1 is not done: SafeSport still missing');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.staff_clearance_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","type_key":"safesport"}');
reset role;
select pg_temp.ok((select finished_at is not null from public.staff_onboarding where user_id = '00000000-0000-0000-0000-0000000000c1'), 'v1 is done once SafeSport is on file');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.staff_onboarding_step_save('{"title":"Sign the photo release"}');
reset role;
select pg_temp.ok((select finished_at is null from public.staff_onboarding where user_id = '00000000-0000-0000-0000-0000000000c1'), 'a new step reopens the checklist');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.staff_onboarding_step_save(jsonb_build_object('id', (select id from public.staff_onboarding_steps where title = 'Sign the photo release'), 'title', 'Sign the photo release', 'archived', true));
reset role;
select pg_temp.ok((select finished_at is not null from public.staff_onboarding where user_id = '00000000-0000-0000-0000-0000000000c1'), 'removing it closes it again');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.staff_onboarding_step_save('{"title":"Videos","link":"javascript:alert(1)"}')$$, 'e1: links must be http(s)');

-- ---------------------------------------------------------------- v1: view = their own
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(not (public.staff_records() ->> 'can_edit')::boolean, 'v1: view only');
select pg_temp.ok(jsonb_array_length(public.staff_records() -> 'people') = 1 and (public.staff_records() -> 'people' -> 0 ->> 'is_me')::boolean, 'v1: sees only themselves');
select pg_temp.ok(jsonb_array_length(public.staff_records() -> 'school') = 0, 'v1: no problems of their own; w1''s are not shown');
select pg_temp.ok((public.staff_records_attention() ->> 'onboarding')::int = 0, 'v1: no onboarding count');
select pg_temp.raises($$select public.staff_clearance_save('{"user_id":"00000000-0000-0000-0000-0000000000c1","type_key":"fingerprint"}')$$, 'v1: cannot record clearances, even their own');
select pg_temp.raises($$select public.staff_onboarding_set('00000000-0000-0000-0000-0000000000c1', false)$$, 'v1: cannot leave the checklist');
select pg_temp.act('00000000-0000-0000-0000-0000000000c2');
select pg_temp.ok((public.staff_records() -> 'school' -> 0 ->> 'title') = 'Hampden Academy', 'w1: sees their own school-job problem');
select pg_temp.ok((public.staff_records_attention() ->> 'school')::int = 1, 'w1: Today counts it');
select pg_temp.ok((public.staff_onboarding_check('00000000-0000-0000-0000-0000000000c2', (select id from public.staff_onboarding_steps where sort = 50), true) ->> 'ok')::boolean, 'w1: ticks their own self-check step');
select pg_temp.raises($$select public.staff_onboarding_check('00000000-0000-0000-0000-0000000000c2', (select id from public.staff_onboarding_steps where sort = 70), true)$$, 'w1: cannot tick a manager step');
select pg_temp.raises($$select public.staff_onboarding_check('00000000-0000-0000-0000-0000000000c1', (select id from public.staff_onboarding_steps where sort = 50), false)$$, 'w1: cannot tick someone else''s');

-- ---------------------------------------------------------------- morning push
reset role;
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('00000000-0000-0000-0000-0000000000e1', 'https://push.example/e1', 'k', 'a'), ('00000000-0000-0000-0000-0000000000c2', 'https://push.example/w1', 'k', 'a');
select pg_temp.ok(public.staff_records_push(true) = 3, 'push: owner + e1 get the summary, w1 gets their own');
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'clearance_warning' and title like '1 person%' and body like 'View Two (Background check)%') = 2, 'push: summary names w1 and the clearance');
select pg_temp.ok((select body from public.push_outbox where target_user = '00000000-0000-0000-0000-0000000000c2') like 'You''re on Hampden Academy on %', 'push: w1''s own line names the job');
select pg_temp.ok(public.staff_records_push(true) = 0, 'push: once a day');
delete from public.staff_records_push_log;
insert into public.push_prefs values ('00000000-0000-0000-0000-0000000000e1', 'clearance_warning', false);
update public.bookings set status = 'inquiry' where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok(public.staff_records_push(true) = 0, 'push: nothing for a job that is not booked');
delete from public.staff_records_push_log;
update public.bookings set status = 'booked' where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok(public.staff_records_push(true) = 2, 'push: e1 switched it off');

-- ---------------------------------------------------------------- gear care
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'inventory', 'edit');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
insert into public.inventory_items (id, name, qty, serial, purchased_on, purchase_price, value, service_every_months) values
  ('00000000-0000-0000-0000-00000000a001', 'Canon R6 body', 1, 'SN-1', (select today from d) - 400, 2499, 1800, 12),
  ('00000000-0000-0000-0000-00000000a002', 'Light stand', 4, '', null, null, 60, null);
select pg_temp.ok((select next_service_on from public.inventory_items_v where id = '00000000-0000-0000-0000-00000000a001') = (select today from d) - 400 + interval '12 months', 'gear: next service counts from purchase');
select pg_temp.ok((public.inventory_attention() ->> 'service_due')::int = 1, 'gear: one item due for service');
select pg_temp.raises($$insert into public.inventory_items (name, value) values ('Bad', -1)$$, 'gear: value cannot be negative');

select pg_temp.act('00000000-0000-0000-0000-0000000000d1');   -- inventory view
select pg_temp.ok((public.inventory_service_log('00000000-0000-0000-0000-00000000a001', (select today from d) - 1, 'sensor', 49, 'cleaned') ->> 'ok')::boolean, 'gear: view can log a sensor clean');
select pg_temp.ok((select last_service_on from public.inventory_items_v where id = '00000000-0000-0000-0000-00000000a001') = (select today from d) - 1, 'gear: last service follows the log');
select pg_temp.ok((public.inventory_attention() ->> 'service_due')::int = 0, 'gear: no longer due');
select public.inventory_service_log('00000000-0000-0000-0000-00000000a001', (select today from d), 'repair', null, 'new strap');
select pg_temp.ok((select last_service_on from public.inventory_items_v where id = '00000000-0000-0000-0000-00000000a001') = (select today from d) - 1, 'gear: a repair is not a service');
select pg_temp.raises($$select public.inventory_service_log('00000000-0000-0000-0000-00000000a001', current_date + 30, 'service')$$, 'gear: not in the future');
select pg_temp.raises($$select public.inventory_service_log('00000000-0000-0000-0000-00000000a001', current_date, 'polish')$$, 'gear: unknown kind refused');
select pg_temp.raises($$insert into public.inventory_service (item_id, done_on, kind) values ('00000000-0000-0000-0000-00000000a001', current_date, 'service')$$, 'gear: log is written only through the RPC');
select pg_temp.ok((select count(*) from public.inventory_service) = 2, 'gear: view can read the log');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');   -- no inventory
select pg_temp.raises($$select public.inventory_service_log('00000000-0000-0000-0000-00000000a001', current_date, 'service')$$, 'gear: no inventory, no logging');
select pg_temp.ok((select count(*) from public.inventory_service) = 0, 'gear: no inventory, log not visible');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.inventory_service_remove((select max(id) from public.inventory_service where kind = 'sensor')) ->> 'ok')::boolean, 'gear: edit removes a log line');
select pg_temp.ok((select last_service_on from public.inventory_items_v where id = '00000000-0000-0000-0000-00000000a001') is null, 'gear: last service recalculated');

reset role;
select pg_temp.ok(true, 'ALL STAFF RECORDS TESTS PASSED');
rollback;
