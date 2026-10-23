-- Shell stream tests (20261024010000_shell_help_digest). Run on a NON-production schema copy after the migration;
-- everything is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/shell_test.sql
-- Help line: every team member sees the full-access people (owner first) with phone when on file, outsiders and
-- deactivated people can't. Morning email goes to you: full access only, adds / removes only the caller's own address.
begin;

create function pg_temp.act(p_uid uuid, p_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'aal', 'aal2', 'session_id', '00000000-0000-0000-0000-0000000000' || right(coalesce(p_uid::text, '00'), 2))::text, true);
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
grant execute on all functions in schema pg_temp to anon, authenticated;

-- a second full-access person (with a phone in user_metadata), s1 = staff (bookings edit), d1 = deactivated staff
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000e1', 'Vanessa@207photo.com', '{"phone": "207-555-0199"}'),
  ('00000000-0000-0000-0000-0000000000e2', 's1@example.com', '{}'), ('00000000-0000-0000-0000-0000000000e3', 'd1@example.com', '{}');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000e1');
insert into public.team_members (user_id, display_name, active, created_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'Vanessa Office', true, now() + interval '1 day'),
  ('00000000-0000-0000-0000-0000000000e2', 'S1', true, now()), ('00000000-0000-0000-0000-0000000000e3', 'D1', false, now());
insert into public.team_members (user_id, display_name, created_at) values ('ccbe859a-d295-4df0-94bc-6f423db4d806', 'Owner', now() - interval '1 year')
  on conflict (user_id) do update set display_name = excluded.display_name, active = true, created_at = excluded.created_at;
update public.admin_settings set digest_recipients = array['info@207photo.com'], digest_enabled = true where id;

-- ---------------------------------------------------------------- Help line
select pg_temp.act('00000000-0000-0000-0000-0000000000e2');
select pg_temp.ok(jsonb_array_length(public.help_contacts()) = 2, 'staff: sees both full-access people');
select pg_temp.ok(public.help_contacts() -> 0 ->> 'name' = 'Owner', 'staff: the owner comes first');
select pg_temp.ok(public.help_contacts() -> 1 ->> 'phone' = '207-555-0199', 'staff: a phone on file comes along');
select pg_temp.ok((public.help_contacts() -> 1) ? 'email', 'staff: with their email');
select pg_temp.raises($$select public.me_digest()$$, 'staff: cannot read the morning email list');
select pg_temp.raises($$select public.me_digest_set(true)$$, 'staff: cannot add themselves to the morning email');
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000e3');
select pg_temp.raises($$select public.help_contacts()$$, 'deactivated: no Help line');
reset role;
select pg_temp.act(null, 'anon');
select pg_temp.raises($$select public.help_contacts()$$, 'signed out: no Help line');
reset role;

-- ---------------------------------------------------------------- Morning email goes to you
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.me_digest() ->> 'on')::boolean = false and (public.me_digest() ->> 'enabled')::boolean, 'admin: not on the list yet; the email is on');
select pg_temp.ok((public.me_digest_set(true) ->> 'on')::boolean, 'admin: turning it on adds them');
select public.me_digest_set(true);
reset role;
select pg_temp.ok((select digest_recipients from public.admin_settings where id) = array['info@207photo.com', 'vanessa@207photo.com'], 'added once, in lower case, after the others');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(not (public.me_digest_set(false) ->> 'on')::boolean, 'admin: turning it off takes them off');
reset role;
select pg_temp.ok((select digest_recipients from public.admin_settings where id) = array['info@207photo.com'], 'the other addresses stay');
select pg_temp.ok((select digest_enabled from public.admin_settings where id), 'the on/off switch is untouched');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.me_digest_set(null)$$, 'admin: on or off is required');
reset role;

select 'ALL SHELL TESTS PASSED';
rollback;
