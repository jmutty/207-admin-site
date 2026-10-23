-- Tests for 20261024030000_partners_outbox_skip ("Don't send" for one booking email). Run on a NON-production
-- schema copy after the migration; everything is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/partners_test.sql
begin;

create function pg_temp.act(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', case when p_uid is null then '{"role":"anon"}'
    else json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal2')::text end, true);
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

-- e edits bookings, v only views them, p has partners edit but not bookings
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000004e1', 'e4@example.com'), ('00000000-0000-0000-0000-0000000004c1', 'v4@example.com'),
  ('00000000-0000-0000-0000-0000000004d1', 'p4@example.com');
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000004e1', 'Edit Four', true),
  ('00000000-0000-0000-0000-0000000004c1', 'View Four', true), ('00000000-0000-0000-0000-0000000004d1', 'Partners Four', true)
  on conflict (user_id) do update set display_name = excluded.display_name;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000004e1', 'bookings', 'edit'),
  ('00000000-0000-0000-0000-0000000004c1', 'bookings', 'view'), ('00000000-0000-0000-0000-0000000004d1', 'partners', 'edit');

insert into public.booking_types (key, label, audience) values ('t_pskip', 'T', 'school') on conflict do nothing;
insert into public.prospect_orgs (id, name) values ('00000000-0000-0000-0000-0000000004f1', 'Skip Club');
insert into public.bookings (id, org_id, type_key, picture_day, start_at, end_at)
  values ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004f1', 't_pskip', current_date + 5, now() + interval '5 days', now() + interval '5 days 1 hour');
insert into public.booking_emails (id, booking_id, step_no, subject, status) values
  ('00000000-0000-0000-0000-00000000e401', '00000000-0000-0000-0000-0000000004b1', 1, 'Rosters', 'scheduled'),
  ('00000000-0000-0000-0000-00000000e402', '00000000-0000-0000-0000-0000000004b1', 2, 'Schedule', 'waiting'),
  ('00000000-0000-0000-0000-00000000e403', '00000000-0000-0000-0000-0000000004b1', 3, 'Photos online', 'failed'),
  ('00000000-0000-0000-0000-00000000e404', '00000000-0000-0000-0000-0000000004b1', 4, 'Thanks', 'sent');

-- ---------------------------------------------------------------- the function exists, signed in only
select pg_temp.ok(to_regprocedure('public.booking_email_skip(uuid)') is not null, 'booking_email_skip(uuid) exists');
select pg_temp.ok(not has_function_privilege('anon', 'public.booking_email_skip(uuid)', 'execute'), 'anon cannot call it');
select pg_temp.ok(has_function_privilege('authenticated', 'public.booking_email_skip(uuid)', 'execute'), 'signed-in people can call it (it checks bookings edit)');

-- ---------------------------------------------------------------- access
do $$ begin
  perform pg_temp.act('00000000-0000-0000-0000-0000000004c1');
  perform pg_temp.raises($q$select public.booking_email_skip('00000000-0000-0000-0000-00000000e401')$q$, 'bookings view only: refused');
  perform pg_temp.act('00000000-0000-0000-0000-0000000004d1');
  perform pg_temp.raises($q$select public.booking_email_skip('00000000-0000-0000-0000-00000000e401')$q$, 'partners edit without bookings: refused');
  perform pg_temp.act(null);
  perform pg_temp.raises($q$select public.booking_email_skip('00000000-0000-0000-0000-00000000e401')$q$, 'signed out: refused');
  reset role;
end $$;
select pg_temp.ok((select status from public.booking_emails where id = '00000000-0000-0000-0000-00000000e401') = 'scheduled', 'refused calls changed nothing');

-- ---------------------------------------------------------------- skipping
do $$
declare r jsonb;
begin
  perform pg_temp.act('00000000-0000-0000-0000-0000000004e1');
  r := public.booking_email_skip('00000000-0000-0000-0000-00000000e401');
  perform pg_temp.ok((r ->> 'ok')::boolean and r ->> 'status' = 'skipped', 'scheduled -> skipped');
  r := public.booking_email_skip('00000000-0000-0000-0000-00000000e402');
  perform pg_temp.ok((r ->> 'ok')::boolean, 'waiting -> skipped');
  r := public.booking_email_skip('00000000-0000-0000-0000-00000000e403');
  perform pg_temp.ok((r ->> 'ok')::boolean, 'failed -> skipped');
  r := public.booking_email_skip('00000000-0000-0000-0000-00000000e401');
  perform pg_temp.ok((r ->> 'ok')::boolean, 'skipping twice is fine');
  r := public.booking_email_skip('00000000-0000-0000-0000-00000000e404');
  perform pg_temp.ok(not (r ->> 'ok')::boolean and r ->> 'error' like '%already sent%', 'a sent email cannot be skipped');
  r := public.booking_email_skip('00000000-0000-0000-0000-00000000e4ff');
  perform pg_temp.ok(not (r ->> 'ok')::boolean, 'a missing email says so');
  reset role;
end $$;
select pg_temp.ok((select array_agg(status order by step_no) from public.booking_emails where booking_id = '00000000-0000-0000-0000-0000000004b1')
  = array['skipped', 'skipped', 'skipped', 'sent'], 'rows end skipped / skipped / skipped / sent; nothing deleted');

rollback;
