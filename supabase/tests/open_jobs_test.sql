-- Open jobs tests (20261022213000_open_jobs). Run on a NON-production schema copy after the team, push and
-- scheduling migrations; everything is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/open_jobs_test.sql
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

-- o = owner, m = manager (openjobs edit), p1 / p2 = part-timers (openjobs view), x = scheduling view only
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a0', 'o@example.com'), ('00000000-0000-0000-0000-0000000000a1', 'm@example.com'),
  ('00000000-0000-0000-0000-0000000000a2', 'p1@example.com'), ('00000000-0000-0000-0000-0000000000a3', 'p2@example.com'),
  ('00000000-0000-0000-0000-0000000000a4', 'x@example.com'), ('00000000-0000-0000-0000-0000000000a5', 'p3@example.com');
insert into public.admin_users values ('00000000-0000-0000-0000-0000000000a0') on conflict do nothing;
insert into public.team_members (user_id, display_name, part_time, home_address, max_drive_min) values
  ('00000000-0000-0000-0000-0000000000a0', 'Owner', false, '', 60),
  ('00000000-0000-0000-0000-0000000000a1', 'Manager Person', false, '', 60),
  ('00000000-0000-0000-0000-0000000000a2', 'Pat One', true, '1 Elm St, Bangor ME', 45),
  ('00000000-0000-0000-0000-0000000000a3', 'Riley Two', true, '2 Oak St, Ellsworth ME', 30),
  ('00000000-0000-0000-0000-0000000000a4', 'Xavier', false, '', 60),
  ('00000000-0000-0000-0000-0000000000a5', 'Casey Three', false, '3 Pine St, Orono ME', 60)
on conflict (user_id) do update set part_time = excluded.part_time, home_address = excluded.home_address, max_drive_min = excluded.max_drive_min;
insert into public.team_permissions values
  ('00000000-0000-0000-0000-0000000000a1', 'openjobs', 'edit'), ('00000000-0000-0000-0000-0000000000a2', 'openjobs', 'view'),
  ('00000000-0000-0000-0000-0000000000a3', 'openjobs', 'view'), ('00000000-0000-0000-0000-0000000000a4', 'scheduling', 'view');
-- p1 and m have a phone
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('00000000-0000-0000-0000-0000000000a2', 'https://push.example/p1', 'k', 'a'), ('00000000-0000-0000-0000-0000000000a1', 'https://push.example/m', 'k', 'a');

-- b1: booked, a timed day in 5 days + an untimed day in 6; b2: track-only
insert into public.booking_types (key, label, default_duration_min) values ('school', 'School Photos', 120) on conflict do nothing;
insert into public.bookings (id, type_key, title_override, status, picture_day, location) values
  ('00000000-0000-0000-0000-0000000000b1', 'school', 'Hampden Academy', 'booked', current_date + 5, '89 Western Ave, Hampden ME'),
  ('00000000-0000-0000-0000-0000000000b2', 'school', 'Tracked Job', 'tracked', current_date + 5, 'Somewhere ME');
insert into public.booking_days (booking_id, day, start_at, end_at, sort) values
  ('00000000-0000-0000-0000-0000000000b1', current_date + 5, (current_date + 5 + time '09:00') at time zone 'America/New_York', (current_date + 5 + time '12:00') at time zone 'America/New_York', 0),
  ('00000000-0000-0000-0000-0000000000b1', current_date + 6, null, null, 1);
update public.bookings set time_set = true, end_set = true, start_at = (current_date + 5 + time '09:00') at time zone 'America/New_York',
  end_at = (current_date + 5 + time '12:00') at time zone 'America/New_York' where id = '00000000-0000-0000-0000-0000000000b1';

-- ---------------------------------------------------------------- access
select pg_temp.act('00000000-0000-0000-0000-0000000000a4');
select pg_temp.raises($$select public.openjobs_mine()$$, 'no Open jobs access: no offers');
select pg_temp.raises($$select public.openjobs_upcoming()$$, 'no Open jobs access: no jobs list');
select pg_temp.act('00000000-0000-0000-0000-0000000000a2');
select pg_temp.raises($$select public.openjobs_candidates('00000000-0000-0000-0000-0000000000b1')$$, 'part-timer cannot see candidates');
select pg_temp.raises($$select public.openjobs_post('{"booking_id":"00000000-0000-0000-0000-0000000000b1","user_ids":["00000000-0000-0000-0000-0000000000a2"]}')$$, 'part-timer cannot post');
select pg_temp.raises($$select public.openjobs_people()$$, 'part-timer cannot see home addresses');
select pg_temp.raises($$select * from public.job_offers$$, 'tables not readable directly');
select pg_temp.ok(jsonb_array_length(public.openjobs_mine() -> 'offers') = 0, 'part-timer starts with no offers');

-- ---------------------------------------------------------------- drive times + candidates (manager)
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok(jsonb_array_length(public.offer_drive_targets('00000000-0000-0000-0000-0000000000b1') -> 'origins') = 2, 'both part-timers need a drive time');
select pg_temp.ok((public.offer_drive_store('89 Western Ave, Hampden ME', '[{"origin":"1 Elm St, Bangor ME","minutes":22,"meters":20000},{"origin":"2 Oak St, Ellsworth ME","minutes":41}]') ->> 'stored')::int = 2, 'stores drive times');
select pg_temp.ok(jsonb_array_length(public.offer_drive_targets('00000000-0000-0000-0000-0000000000b1') -> 'origins') = 0, 'cached ones are not asked again');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.openjobs_upcoming()) j where j ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1') = 1
              and (select count(*) from jsonb_array_elements(public.openjobs_upcoming()) j where j ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b2') = 0, 'upcoming lists booked jobs, not track-only');
select pg_temp.ok((select (p ->> 'in_range')::boolean from jsonb_array_elements(public.openjobs_candidates('00000000-0000-0000-0000-0000000000b1') -> 'people') p where p ->> 'name' = 'Pat One'), 'Pat (22 of 45 min) is in range');
select pg_temp.ok((select not (p ->> 'in_range')::boolean and (p ->> 'drive_min')::int = 41 from jsonb_array_elements(public.openjobs_candidates('00000000-0000-0000-0000-0000000000b1') -> 'people') p where p ->> 'name' = 'Riley Two'), 'Riley (41 of 30 min) is out of range');
select pg_temp.ok(jsonb_array_length(public.openjobs_candidates('00000000-0000-0000-0000-0000000000b1') -> 'people') = 2, 'only part-timers are candidates');
select pg_temp.raises($$select public.openjobs_post('{"booking_id":"00000000-0000-0000-0000-0000000000b2","user_ids":["00000000-0000-0000-0000-0000000000a2"]}')$$, 'track-only jobs cannot be offered');
select pg_temp.raises($$select public.openjobs_post('{"booking_id":"00000000-0000-0000-0000-0000000000b1","user_ids":["00000000-0000-0000-0000-0000000000a4"]}')$$, 'someone without Open jobs cannot be sent one');

-- ---------------------------------------------------------------- post
create temp table t_offer as select public.openjobs_post('{"booking_id":"00000000-0000-0000-0000-0000000000b1","spots":1,"pay":"$150","note":"Bring the backdrop",
  "user_ids":["00000000-0000-0000-0000-0000000000a2","00000000-0000-0000-0000-0000000000a3","00000000-0000-0000-0000-0000000000a4"]}') r;
grant select on t_offer to authenticated;
select pg_temp.ok((select (r ->> 'sent')::int = 2 and (r ->> 'pushed')::int = 1 from t_offer), 'sent to the 2 part-timers; 1 push (only Pat has a phone)');
reset role;
select pg_temp.ok((select count(*) = 1 and bool_and(target_user = '00000000-0000-0000-0000-0000000000a2' and topic = 'job_offer' and body like '%22 min drive%' and body like '%$150%') from public.push_outbox where topic = 'job_offer'), 'Pat''s push names the drive and the pay');
select pg_temp.ok((select not notified from public.job_offer_recipients where user_id = '00000000-0000-0000-0000-0000000000a3'), 'Riley has no phone: recorded as not notified');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok((select (p ->> 'offered')::boolean from jsonb_array_elements(public.openjobs_candidates('00000000-0000-0000-0000-0000000000b1') -> 'people') p where p ->> 'name' = 'Pat One'), 'candidates show it is already offered');

-- ---------------------------------------------------------------- answers
select pg_temp.act('00000000-0000-0000-0000-0000000000a3');
select pg_temp.ok((public.openjobs_attention() ->> 'waiting')::int = 1, 'Riley has one waiting');
select pg_temp.ok((select (o -> 'mine' ->> 'drive_min')::int = 41 and o ->> 'pay' = '$150' from jsonb_array_elements(public.openjobs_mine() -> 'offers') o), 'Riley sees the offer with their drive');
select pg_temp.ok((public.openjobs_answer((select (r ->> 'id')::uuid from t_offer), false, 'Too far') ->> 'answer') = 'declined', 'Riley passes');
select pg_temp.act('00000000-0000-0000-0000-0000000000a4');
select pg_temp.raises(format('select public.openjobs_answer(%L, true)', (select r ->> 'id' from t_offer)), 'someone not offered it cannot take it');
select pg_temp.act('00000000-0000-0000-0000-0000000000a2');
create temp table t_take as select public.openjobs_answer((select (r ->> 'id')::uuid from t_offer), true) r;
select pg_temp.ok((select (r ->> 'ok')::boolean and (r ->> 'scheduled')::int = 1 and (r ->> 'untimed')::int = 1 from t_take), 'Pat takes it: on the schedule for the timed day');
select pg_temp.raises(format('select public.openjobs_answer(%L, false)', (select r ->> 'id' from t_offer)), 'cannot pass after taking it');
select pg_temp.ok((public.openjobs_attention() ->> 'waiting')::int = 0, 'nothing waiting for Pat now');
reset role;
select pg_temp.ok((select count(*) = 1 and bool_and(e.drive_before_min = 25 and e.drive_after_min = 25 and e.kind = 'job') from public.schedule_entries e
                    where e.user_id = '00000000-0000-0000-0000-0000000000a2' and e.booking_id = '00000000-0000-0000-0000-0000000000b1'), 'schedule bar with their own drive (22 -> 25 min)');
select pg_temp.ok((select status = 'filled' from public.job_offers where id = (select (r ->> 'id')::uuid from t_offer)), 'offer is filled');
select pg_temp.ok((select count(*) = 2 from public.push_outbox where topic = 'job_offer_reply' and target_user = '00000000-0000-0000-0000-0000000000a1'), 'the manager got a push for each answer');
select pg_temp.ok((select bool_or(body like 'Too far%') from public.push_outbox where topic = 'job_offer_reply'), 'the pass push carries the reason');
select pg_temp.act('00000000-0000-0000-0000-0000000000a3');
select pg_temp.ok((public.openjobs_answer((select (r ->> 'id')::uuid from t_offer), true) ->> 'error') = 'filled', 'Riley changes their mind, but it is taken');

-- ---------------------------------------------------------------- manager view, close, no takers
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok((select (o ->> 'taken')::int = 1 and jsonb_array_length(o -> 'recipients') = 2
                     and (select r ->> 'reason' from jsonb_array_elements(o -> 'recipients') r where r ->> 'name' = 'Riley Two') = 'Too far'
                   from jsonb_array_elements(public.openjobs_list()) o), 'manager sees who took it and why the other passed');
create temp table t_offer2 as select public.openjobs_post('{"booking_id":"00000000-0000-0000-0000-0000000000b1","spots":2,"user_ids":["00000000-0000-0000-0000-0000000000a3"]}') r;
grant select on t_offer2 to authenticated;
select pg_temp.act('00000000-0000-0000-0000-0000000000a3');
select public.openjobs_answer((select (r ->> 'id')::uuid from t_offer2), false, '');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok((public.openjobs_attention() ->> 'no_takers')::int = 1, 'Today: an open job everyone passed on');
select pg_temp.ok((public.openjobs_close((select (r ->> 'id')::uuid from t_offer2)) ->> 'ok')::boolean, 'manager closes it');
select pg_temp.ok((public.openjobs_attention() ->> 'no_takers')::int = 0, 'closed offers drop off Today');
-- a cancelled booking can't be taken
create temp table t_offer3 as select public.openjobs_post('{"booking_id":"00000000-0000-0000-0000-0000000000b1","user_ids":["00000000-0000-0000-0000-0000000000a3"]}') r;
grant select on t_offer3 to authenticated;
reset role;
update public.bookings set status = 'cancelled' where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.act('00000000-0000-0000-0000-0000000000a3');
select pg_temp.ok((public.openjobs_answer((select (r ->> 'id')::uuid from t_offer3), true) ->> 'error') = 'closed', 'a cancelled job cannot be taken');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.openjobs_mine() -> 'offers') o where o ->> 'id' = (select r ->> 'id' from t_offer3)), 'and it leaves their list');
reset role;
update public.bookings set status = 'booked' where id = '00000000-0000-0000-0000-0000000000b1';

-- ---------------------------------------------------------------- part-timer setup
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok(not (public.openjobs_person_save('00000000-0000-0000-0000-0000000000a5', true, '3 Pine St, Orono ME', 60) ->> 'granted')::boolean, 'a manager marks Casey part-time but cannot grant access');
select pg_temp.raises($$select public.openjobs_person_save('00000000-0000-0000-0000-0000000000a5', true, '', 999)$$, 'longest drive is capped');
select pg_temp.act('00000000-0000-0000-0000-0000000000a0');
select pg_temp.ok((public.openjobs_person_save('00000000-0000-0000-0000-0000000000a5', true, '3 Pine St, Orono ME', 60) ->> 'granted')::boolean, 'the owner marking them part-time gives them Open jobs');
reset role;
select pg_temp.ok(exists (select 1 from public.team_permissions where user_id = '00000000-0000-0000-0000-0000000000a5' and module_key = 'openjobs' and level = 'view')
              and exists (select 1 from public.team_audit where target = '00000000-0000-0000-0000-0000000000a5'), 'view access granted and audited');

select 'ALL OPEN JOBS TESTS PASSED';
rollback;
