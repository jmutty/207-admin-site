-- Employment type + job title tests (20261023090000_employment_type). Run on a NON-production schema copy
-- after the team, scheduling, open jobs and time clock migrations; everything is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/employment_type_test.sql
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

-- o = owner; f = full time, s = salaried, c = 1099, n = not set; m = timeclock edit (not full access)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e0', 'o@example.com'), ('00000000-0000-0000-0000-0000000000e1', 'f@example.com'),
  ('00000000-0000-0000-0000-0000000000e2', 's@example.com'), ('00000000-0000-0000-0000-0000000000e3', 'c@example.com'),
  ('00000000-0000-0000-0000-0000000000e4', 'n@example.com'), ('00000000-0000-0000-0000-0000000000e5', 'm@example.com');
insert into public.admin_users values ('00000000-0000-0000-0000-0000000000e0') on conflict do nothing;
insert into public.team_members (user_id, display_name) values
  ('00000000-0000-0000-0000-0000000000e0', 'Owner'), ('00000000-0000-0000-0000-0000000000e1', 'Fran Full'),
  ('00000000-0000-0000-0000-0000000000e2', 'Sal Aried'), ('00000000-0000-0000-0000-0000000000e3', 'Con Tractor'),
  ('00000000-0000-0000-0000-0000000000e4', 'Nora Notset'), ('00000000-0000-0000-0000-0000000000e5', 'Manny Ger')
on conflict (user_id) do nothing;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e5', 'timeclock', 'edit');

-- ---------------------------------------------------------------- Team page
select pg_temp.act('00000000-0000-0000-0000-0000000000e5');
select pg_temp.raises($$select public.team_set_profile('00000000-0000-0000-0000-0000000000e1', 'full_time', '')$$, 'only full access sets type and title');
select pg_temp.act('00000000-0000-0000-0000-0000000000e0');
select pg_temp.raises($$select public.team_set_profile('00000000-0000-0000-0000-0000000000e1', 'intern', '')$$, 'unknown type refused');
select pg_temp.raises($$select public.team_set_profile('00000000-0000-0000-0000-0000000000e1', 'full_time', repeat('x', 81))$$, 'long title refused');
select pg_temp.ok(not (public.team_set_profile('00000000-0000-0000-0000-0000000000e1', 'full_time', ' Lead photographer ') ->> 'granted')::boolean, 'full time: no Open jobs');
select public.team_set_profile('00000000-0000-0000-0000-0000000000e2', 'salaried', 'Studio manager');
select pg_temp.ok((public.team_set_profile('00000000-0000-0000-0000-0000000000e3', 'contractor', 'Second shooter') ->> 'granted')::boolean, '1099 gets Open jobs');
select pg_temp.ok((select p ->> 'employment_type' = 'full_time' and p ->> 'job_title' = 'Lead photographer' from jsonb_array_elements(public.team_list()) p where p ->> 'name' = 'Fran Full'), 'team list shows type and trimmed title');
select pg_temp.ok((select p ->> 'employment_type' is null from jsonb_array_elements(public.team_list()) p where p ->> 'name' = 'Nora Notset'), 'not set stays empty');
select public.team_set_profile('00000000-0000-0000-0000-0000000000e1', '', 'Lead photographer');
select pg_temp.ok((select p ->> 'employment_type' is null from jsonb_array_elements(public.team_list()) p where p ->> 'name' = 'Fran Full'), 'type can be cleared');
select public.team_set_profile('00000000-0000-0000-0000-0000000000e1', 'full_time', 'Lead photographer');
reset role;
select pg_temp.ok((select count(*) from public.team_audit where action = 'profile_set') = 5, 'each change is audited');
select pg_temp.ok(public.gets_open_jobs('00000000-0000-0000-0000-0000000000e3') and not public.gets_open_jobs('00000000-0000-0000-0000-0000000000e2'), 'Open jobs: 1099 yes, salaried no');

-- ---------------------------------------------------------------- time clock: 45 hours each in one week
insert into public.time_punches (user_id, user_name, kind, clock_in, clock_out)
select u, 'x', 'studio', ((public.tc_week_of(current_date - 14) + d) + time '08:00') at time zone 'America/New_York', ((public.tc_week_of(current_date - 14) + d) + time '17:00') at time zone 'America/New_York'
  from unnest(array['00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000e4']::uuid[]) u,
       generate_series(1, 5) d;
select pg_temp.act('00000000-0000-0000-0000-0000000000e5');
create temp table t_pay as select p from jsonb_array_elements(public.timesheet_payroll(current_date - 14, 1) -> 'people') p;
select pg_temp.ok((select (p ->> 'overtime_min')::int = 300 and p ->> 'employment_type' = 'full_time' from t_pay where p ->> 'email' = 'f@example.com'), 'full time: 5 h overtime');
select pg_temp.ok((select (p ->> 'overtime_min')::int = 300 from t_pay where p ->> 'email' = 'n@example.com'), 'not set: overtime like full time');
select pg_temp.ok((select (p ->> 'overtime_min')::int = 0 and (p ->> 'regular_min')::int = 2700 from t_pay where p ->> 'email' = 's@example.com'), 'salaried: no overtime, all 45 h regular');
select pg_temp.ok((select (p ->> 'overtime_min')::int = 0 and p ->> 'employment_type' = 'contractor' and p ->> 'job_title' = 'Second shooter' from t_pay where p ->> 'email' = 'c@example.com'), '1099: no overtime, marked contractor');
select pg_temp.ok((select (p ->> 'overtime_applies')::boolean = false and p ->> 'employment_type' = 'salaried'
                     from jsonb_array_elements(public.timesheet_week(public.tc_week_of(current_date - 14), null, true) -> 'people') p
                    where p ->> 'user_id' = '00000000-0000-0000-0000-0000000000e2'), 'timesheet week says no overtime for salaried');

select 'ALL EMPLOYMENT TYPE TESTS PASSED';
rollback;
