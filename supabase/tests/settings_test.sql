-- Tests for 20261024020000_settings (Settings tabs, default access for Part time / 1099, owner auto-confirm,
-- add a job type). Run against a NON-production copy of the schema after the migration, inside a transaction
-- that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/settings_test.sql
-- "ALL SETTINGS TESTS PASSED" at the end means every check held.

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
create function pg_temp.mods(p_uid uuid) returns jsonb language sql security definer as $$
  select coalesce(jsonb_object_agg(module_key, level), '{}'::jsonb) from public.team_permissions where user_id = p_uid
$$;

-- o1 full access; m1 edits scheduling only; p1 will be part time; k1 a 1099 who keeps edit on timeclock
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'o1@example.com'), ('00000000-0000-0000-0000-0000000000e1', 'm1@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'p1@example.com'), ('00000000-0000-0000-0000-0000000000d2', 'k1@example.com');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000a1', 'Owner One', true),
  ('00000000-0000-0000-0000-0000000000e1', 'Manny One', true), ('00000000-0000-0000-0000-0000000000d1', 'Pat Part', true),
  ('00000000-0000-0000-0000-0000000000d2', 'Ken Contract', true)
  on conflict (user_id) do update set display_name = excluded.display_name;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'scheduling', 'edit'), ('00000000-0000-0000-0000-0000000000d2', 'timeclock', 'edit');

-- ---------------------------------------------------------------- modules exist
select pg_temp.ok((select count(*) from public.app_modules where key in ('inventory', 'openjobs', 'workflows', 'timeclock', 'assignments', 'staffrecords')) = 6,
                  'inventory, open jobs, checklists, time clock (expenses), My day and records are grantable modules');

-- ---------------------------------------------------------------- outsiders
select pg_temp.act(null);
select pg_temp.raises($$select public.settings_team_emails()$$, 'anon: no team email settings');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.settings_team_emails()$$, 'm1: only full access reads team email settings');
select pg_temp.raises($$select public.push_topic_set_default('crew_ask', 'off')$$, 'm1: cannot change notification defaults');
select pg_temp.raises($$select public.team_set_max_drive('00000000-0000-0000-0000-0000000000d1', 30)$$, 'm1: cannot set longest drive');
select pg_temp.raises($$select public.booking_type_add('Dance recital', 'school')$$, 'm1: no bookings edit, cannot add a job type');
select pg_temp.raises($$select public.team_grant_defaults('00000000-0000-0000-0000-0000000000e1', array['openjobs'], 'x')$$, 'm1: cannot call the grant helper');

-- ---------------------------------------------------------------- Team emails
reset role;
select count(*) as n_topics from public.push_topics \gset
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok((select jsonb_array_length(public.settings_team_emails() -> 'topics')) = :n_topics, 'every notification kind is listed');
select pg_temp.ok(public.settings_team_emails() ? 'week_email_hour' and public.settings_team_emails() -> 'clock' ? 'remind_before_min', 'team emails carry week email and clock reminders');
select pg_temp.raises($$select public.push_topic_set_default('crew_ask', 'loud')$$, 'unknown mode refused');
select pg_temp.raises($$select public.push_topic_set_default('nope', 'off')$$, 'unknown kind refused');
select public.push_topic_set_default('crew_ask', 'email');
select pg_temp.ok((select x ->> 'default_mode' from jsonb_array_elements(public.settings_team_emails() -> 'topics') x where x ->> 'key' = 'crew_ask') = 'email', 'default saved');
reset role;
select pg_temp.ok((select default_on from public.push_topics where key = 'crew_ask'), 'email default still counts as on');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select public.push_topic_set_default('crew_ask', 'off');
reset role;
select pg_temp.ok(not (select default_on from public.push_topics where key = 'crew_ask'), 'off default turns default_on off');

-- ---------------------------------------------------------------- one person record
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.team_set_max_drive('00000000-0000-0000-0000-0000000000d1', 2)$$, 'longest drive under 5 refused');
select public.team_set_max_drive('00000000-0000-0000-0000-0000000000d1', 45);
select pg_temp.ok((select (p ->> 'max_drive_min')::int from jsonb_array_elements(public.team_list()) p where p ->> 'user_id' = '00000000-0000-0000-0000-0000000000d1') = 45, 'team list shows longest drive');

-- ---------------------------------------------------------------- default access by type
select pg_temp.ok(not (public.team_set_profile('00000000-0000-0000-0000-0000000000e1', 'full_time', '') ->> 'granted')::boolean, 'full time: nothing added');
select pg_temp.ok(pg_temp.mods('00000000-0000-0000-0000-0000000000e1') = '{"scheduling":"edit"}'::jsonb, 'full time keeps exactly what they had');
select pg_temp.ok((public.team_set_profile('00000000-0000-0000-0000-0000000000d1', 'part_time', '') ->> 'granted')::boolean, 'part time: pages added');
select pg_temp.ok(pg_temp.mods('00000000-0000-0000-0000-0000000000d1') = '{"openjobs":"view","assignments":"view","timeclock":"view","staffrecords":"view"}'::jsonb, 'part time gets the four pages at view');
reset role;
delete from public.team_permissions where user_id = '00000000-0000-0000-0000-0000000000d1' and module_key = 'staffrecords';
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select public.team_set_profile('00000000-0000-0000-0000-0000000000d1', 'part_time', 'Second shooter');
select pg_temp.ok(not pg_temp.mods('00000000-0000-0000-0000-0000000000d1') ? 'staffrecords', 'saving the same type again does not put back a page you took away');
select public.team_set_profile('00000000-0000-0000-0000-0000000000d1', 'contractor', 'Second shooter');
select pg_temp.ok(not pg_temp.mods('00000000-0000-0000-0000-0000000000d1') ? 'staffrecords', 'part time to 1099 is not a new default');
select public.team_set_profile('00000000-0000-0000-0000-0000000000d2', 'contractor', '');
select pg_temp.ok(pg_temp.mods('00000000-0000-0000-0000-0000000000d2') ->> 'timeclock' = 'edit' and pg_temp.mods('00000000-0000-0000-0000-0000000000d2') ->> 'staffrecords' = 'view',
                  '1099: an existing edit stays edit; the missing pages are added');
select pg_temp.ok((public.team_set_profile('00000000-0000-0000-0000-0000000000a1', 'part_time', '') ->> 'granted')::boolean is false, 'full access: nothing added');
select public.team_set_profile('00000000-0000-0000-0000-0000000000a1', '', '');
reset role;
select pg_temp.ok((select count(*) from public.team_audit where action = 'updated' and detail ->> 'via' = 'employment type'
                    and target in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2')) = 2, 'each grant is audited');
-- openjobs_person_save fills in what is missing
delete from public.team_permissions where user_id = '00000000-0000-0000-0000-0000000000d1' and module_key = 'assignments';
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok((public.openjobs_person_save('00000000-0000-0000-0000-0000000000d1', true, 'Hampden ME', 50) -> 'added') ? 'assignments', 'Open jobs save adds a missing default page');
select pg_temp.ok(pg_temp.mods('00000000-0000-0000-0000-0000000000d1') ? 'staffrecords', 'and the other missing one');

-- ---------------------------------------------------------------- owner auto-confirm
reset role;
insert into public.prospect_orgs (id, name, town) values ('00000000-0000-0000-0000-00000000aaa1', 'Test Academy', 'Hampden');
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, location, status) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000aaa1', 'school', 'School Photos', '2026-11-03', '2026-11-03 09:00 America/New_York', '2026-11-03 12:00 America/New_York', '', 'booked');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1'); reset role;   -- keep the owner's claims, run as the table owner
select public.crew_ask_ensure('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', true);
select public.crew_ask_ensure('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', true);
select pg_temp.ok((select status from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b1' and user_id = '00000000-0000-0000-0000-0000000000a1') = 'confirmed', 'the owner putting himself on a job is confirmed');
select pg_temp.ok((select status from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b1' and user_id = '00000000-0000-0000-0000-0000000000d1') = 'pending', 'someone else he puts on is still asked');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1'); reset role;
select public.crew_ask_ensure('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', true);
select pg_temp.ok((select status from public.crew_asks where booking_id = '00000000-0000-0000-0000-0000000000b1' and user_id = '00000000-0000-0000-0000-0000000000e1') = 'pending', 'a scheduler putting themselves on is still asked');

-- ---------------------------------------------------------------- add a job type
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.booking_type_add('x', 'school')$$, 'a one-letter name refused');
select pg_temp.raises($$select public.booking_type_add('Dance recital', 'no_such_type')$$, 'must start from a real type');
create temp table nt as select public.booking_type_add('Dance recital', 'school') ->> 'key' as k;
reset role;
select pg_temp.ok((select k from nt) = 'dance_recital', 'key made from the name');
select pg_temp.ok((select audience from public.booking_types where key = 'dance_recital') = (select audience from public.booking_types where key = 'school'), 'copies the audience');
select pg_temp.ok(exists (select 1 from public.booking_stages where type_key = 'dance_recital'), 'stages are seeded');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.booking_type_add('dance recital', 'school')$$, 'same name twice refused');

-- ---------------------------------------------------------------- calculator assumptions
reset role;
select pg_temp.ok(exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'admin_settings' and column_name = 'calc_assumptions'), 'admin_settings has calc_assumptions');

-- ---------------------------------------------------------------- time off: jobs carry booking_id (B7)
select pg_temp.ok(pg_get_functiondef('public.time_off_json(public.time_off_requests)'::regprocedure) like '%''booking_id'', e.booking_id%', 'time off jobs link to their booking');

select 'ALL SETTINGS TESTS PASSED';
rollback;
