-- Access tests for the 2026-10-21 team migrations. Run against a NON-production copy of the schema
-- (it inserts fake users and rows) after both migrations, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/team_access_test.sql
-- Each check RAISEs on failure; "ALL ACCESS TESTS PASSED" at the end means every check held.
-- Needs the Supabase-style stubs: auth.uid() from request.jwt.claim.sub, auth.jwt() from request.jwt.claims.

begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
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

-- owner = the real admin_users row; s1 = bookings edit + parents view; s2 = partners view; s3 = deactivated; s4 = auth user, not on the team
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 's1@example.com'), ('00000000-0000-0000-0000-0000000000a2', 's2@example.com'),
  ('00000000-0000-0000-0000-0000000000a3', 's3@example.com'), ('00000000-0000-0000-0000-0000000000a4', 's4@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000a1', 'Staff One', true), ('00000000-0000-0000-0000-0000000000a2', 'Staff Two', true),
  ('00000000-0000-0000-0000-0000000000a3', 'Staff Three', false);
insert into public.team_permissions values
  ('00000000-0000-0000-0000-0000000000a1', 'bookings', 'edit'), ('00000000-0000-0000-0000-0000000000a1', 'parents', 'view'),
  ('00000000-0000-0000-0000-0000000000a2', 'partners', 'view'), ('00000000-0000-0000-0000-0000000000a3', 'bookings', 'edit');
-- a staff member granted an admin-only module (only possible by direct insert) must still not get it
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000a1', 'settings', 'edit');

insert into public.booking_types (key, label, audience) values ('t_school', 'School', 'school') on conflict do nothing;
insert into public.prospect_orgs (id, name) values ('00000000-0000-0000-0000-0000000000f1', 'Test Org');
insert into public.bookings (id, org_id, type_key, picture_day, start_at, end_at)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1', 't_school', current_date + 10, now() + interval '10 days', now() + interval '10 days 1 hour');
insert into public.lookup_requests (parent_email) values ('parent@example.com');
insert into public.admin_settings (id) values (true) on conflict do nothing;
insert into public.sync_runs (trigger_source) values ('test');

-- ---------------------------------------------------------------- owner: everything, as before
select pg_temp.act('ccbe859a-d295-4df0-94bc-6f423db4d806');
select pg_temp.ok(public.is_admin(), 'owner: is_admin() unchanged');
select pg_temp.ok((select bool_and(public.can(key, 'edit')) from public.app_modules), 'owner: can edit every module, admin-only ones included');
select pg_temp.ok((public.my_access() ->> 'is_admin')::boolean and (public.my_access() -> 'modules' ->> 'team') = 'edit', 'owner: my_access says full access');
select pg_temp.ok((select count(*) from public.bookings) = 1, 'owner: reads bookings');
select pg_temp.ok((select count(*) from public.prospect_orgs) = 1, 'owner: reads prospect_orgs');
select pg_temp.ok((select count(*) from public.lookup_requests) = 1, 'owner: reads lookup_requests');
select pg_temp.ok((select count(*) from public.admin_settings) = 1, 'owner: reads admin_settings');
select pg_temp.ok(jsonb_array_length(public.team_list()) = 4, 'owner: team_list shows owner + 3 staff');
with u as (update public.prospect_orgs set notes = 'x' where id = '00000000-0000-0000-0000-0000000000f1' returning 1) select pg_temp.ok((select count(*) from u) = 1, 'owner: updates prospect_orgs');
select pg_temp.ok((select count(*) from public.admin_bookings(null, null)) = 1, 'owner: admin_bookings RPC');
select pg_temp.raises($$select public.team_save('ccbe859a-d295-4df0-94bc-6f423db4d806', 'Me', false, '{}')$$, 'owner: cannot remove own full access');
select pg_temp.raises($$select public.team_set_active('ccbe859a-d295-4df0-94bc-6f423db4d806', false)$$, 'owner: cannot deactivate self');
select pg_temp.raises($$select public.team_save('00000000-0000-0000-0000-0000000000a2', 'S2', false, '{"settings":"edit"}')$$, 'owner: admin-only modules are not grantable');
select pg_temp.raises($$select public.team_save('00000000-0000-0000-0000-0000000000a2', 'S2', false, '{"bookings":"admin"}')$$, 'owner: unknown level refused');
select public.team_save('00000000-0000-0000-0000-0000000000a2', 'Staff Two', false, '{"partners":"view","scheduling":"edit","hub":"none"}');
select pg_temp.ok((select x -> 'modules' from jsonb_array_elements(public.team_list()) x where x ->> 'user_id' = '00000000-0000-0000-0000-0000000000a2') = '{"partners":"view","scheduling":"edit"}', 'owner: team_save replaces grants (none = no row)');
select pg_temp.ok(jsonb_array_length(public.team_audit_list(10)) >= 1, 'owner: change is in the audit log');
reset role;

-- ---------------------------------------------------------------- owner without the second sign-in step
select pg_temp.act('ccbe859a-d295-4df0-94bc-6f423db4d806', 'aal1');
select pg_temp.ok(not public.is_admin() and not public.can('bookings'), 'owner, password only: no access (unchanged)');
select pg_temp.ok((select count(*) from public.bookings) = 0, 'owner, password only: reads nothing');
reset role;

-- ---------------------------------------------------------------- s1: bookings edit, parents view
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok(not public.is_admin(), 's1: not full access');
select pg_temp.ok(public.can('bookings', 'edit') and public.can('bookings', 'view'), 's1: bookings edit (implies view)');
select pg_temp.ok(public.can('parents', 'view') and not public.can('parents', 'edit'), 's1: parents view only');
select pg_temp.ok(not public.can('partners') and not public.can('galleries') and not public.can('settings', 'view'), 's1: nothing else, not even a smuggled settings row');
select pg_temp.ok(not public.can('bookings', 'manage'), 's1: unknown level fails closed');
select pg_temp.ok(public.my_access() -> 'modules' = '{"bookings":"edit","parents":"view"}', 's1: my_access lists exactly their modules');
select pg_temp.ok((select count(*) from public.bookings) = 1, 's1: reads bookings');
with u as (update public.bookings set notes = 'moved' where id = '00000000-0000-0000-0000-0000000000b1' returning 1) select pg_temp.ok((select count(*) from u) = 1, 's1: edits bookings');
select pg_temp.ok((select count(*) from public.lookup_requests) = 1, 's1: reads help requests (parents view)');
with u as (update public.lookup_requests set status = 'resolved' returning 1) select pg_temp.ok((select count(*) from u) = 0, 's1: cannot edit help requests (view only)');
select pg_temp.raises($$select public.admin_retake_delete('00000000-0000-0000-0000-000000000000')$$, 's1: parents edit RPC refused');
select pg_temp.ok((select count(*) from public.admin_retakes(60)) >= 0, 's1: parents view RPC allowed');
select pg_temp.ok((select count(*) from public.prospect_orgs) = 0, 's1: cannot read organizations');
select pg_temp.raises($$insert into public.prospect_orgs (name) values ('sneaky')$$, 's1: cannot add organizations');
select pg_temp.ok(public.admin_outbox(14) = '[]'::jsonb, 's1: outbox RPC returns nothing');
select pg_temp.raises($$select public.prospect_set_status('00000000-0000-0000-0000-000000000000', 'x')$$, 's1: partners edit RPC refused');
select pg_temp.ok((select count(*) from public.admin_settings) = 0, 's1: cannot read settings');
select pg_temp.ok((select count(*) from public.sync_runs) = 1, 's1: reads sync status (everyone)');
select pg_temp.ok((select count(*) from public.prospect_sequence_rank('00000000-0000-0000-0000-0000000000f1')) = 0, 's1: sequence ranking returns nothing');
select pg_temp.raises($$select public.prospect_org_refresh('00000000-0000-0000-0000-0000000000f1')$$, 's1: internal prospect helper not callable');
select pg_temp.raises($$select public.team_list()$$, 's1: cannot list the team');
select pg_temp.raises($$select public.team_save('00000000-0000-0000-0000-0000000000a1', 'Me', true, '{}')$$, 's1: cannot give themselves full access');
select pg_temp.raises($$insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000a1', 'partners', 'edit')$$, 's1: cannot write team_permissions directly');
select pg_temp.raises($$insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000a1')$$, 's1: cannot write admin_users directly');
select pg_temp.ok((select count(*) from public.app_modules) >= 12, 's1: can read the module registry');
select pg_temp.raises($$select public.is_team_user('00000000-0000-0000-0000-0000000000a2')$$, 's1: is_team_user is internal');
reset role;

-- s1 before the emailed code: nothing
select pg_temp.act('00000000-0000-0000-0000-0000000000a1', 'aal1');
select pg_temp.ok(not public.can('bookings') and (select count(*) from public.bookings) = 0, 's1, password only: no access');
select pg_temp.ok(public.my_access() -> 'modules' = '{}' and not (public.my_access() ->> 'trusted')::boolean, 's1, password only: my_access shows no modules');
select pg_temp.ok((public.admin_send_code() ->> 'error') is distinct from 'not_admin', 's1, password only: can get an emailed code');
reset role;

-- ---------------------------------------------------------------- s2: partners view (after owner's team_save)
select pg_temp.act('00000000-0000-0000-0000-0000000000a2');
select pg_temp.ok((select count(*) from public.prospect_orgs) = 1, 's2: reads organizations');
with u as (update public.prospect_orgs set notes = 'y' returning 1) select pg_temp.ok((select count(*) from u) = 0, 's2: cannot edit organizations (view only)');
select pg_temp.ok((select count(*) from public.bookings) = 0, 's2: cannot read bookings');
select pg_temp.ok(public.can('scheduling', 'edit'), 's2: planned module granted ahead of launch');
reset role;

-- ---------------------------------------------------------------- s3 deactivated, s4 not on the team, anon
select pg_temp.act('00000000-0000-0000-0000-0000000000a3');
select pg_temp.ok(not public.can('bookings') and (select count(*) from public.bookings) = 0, 's3 (deactivated): no access');
select pg_temp.ok(public.admin_send_code() ->> 'error' = 'not_admin', 's3 (deactivated): no emailed code');
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000a4');
select pg_temp.ok(not public.can('bookings') and not public.is_team_member(), 's4 (not on team): no access');
select pg_temp.ok(public.admin_send_code() ->> 'error' = 'not_admin', 's4 (not on team): no emailed code');
select pg_temp.ok(not public.admin_use_device(repeat('a', 64)), 's4 (not on team): no remembered device');
reset role;
select pg_temp.act(null);
select pg_temp.raises($$select public.can('bookings')$$, 'anon: cannot call can()');
select pg_temp.raises($$select public.my_access()$$, 'anon: cannot call my_access()');
select pg_temp.raises($$select count(*) from public.bookings$$, 'anon: cannot query bookings');
reset role;

-- ---------------------------------------------------------------- deactivation through team_set_active
select pg_temp.act('ccbe859a-d295-4df0-94bc-6f423db4d806');
select public.team_set_active('00000000-0000-0000-0000-0000000000a1', false);
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok(not public.can('bookings'), 's1 after deactivation: access gone immediately');
reset role;

-- ---------------------------------------------------------------- removal through team_remove
select pg_temp.act('ccbe859a-d295-4df0-94bc-6f423db4d806');
select pg_temp.raises($$select public.team_remove('00000000-0000-0000-0000-0000000000a2')$$, 'owner: cannot remove an active person');
select pg_temp.raises($$select public.team_remove('ccbe859a-d295-4df0-94bc-6f423db4d806')$$, 'owner: cannot remove self');
select public.team_remove('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok(jsonb_array_length(public.team_list()) = 3, 'owner: removed person is off team_list');
select pg_temp.ok(exists (select 1 from jsonb_array_elements(public.team_audit_list()) r where r ->> 'action' = 'deactivated' and r ->> 'target' = 'Staff One'),
                  'owner: change log still names the removed person');
reset role;
select pg_temp.ok(not exists (select 1 from public.team_permissions where user_id = '00000000-0000-0000-0000-0000000000a1'), 'removed person: permissions gone');
select pg_temp.act('00000000-0000-0000-0000-0000000000a2');
select pg_temp.raises($$select public.team_remove('00000000-0000-0000-0000-0000000000a3')$$, 's2 (no full access): cannot remove');
reset role;

-- ---------------------------------------------------------------- nothing left behind
select pg_temp.ok(not exists (select 1 from pg_policies where (coalesce(qual, '') || coalesce(with_check, '')) ~ 'is_admin\(\)'
                               and tablename not in ('admin_settings', 'gotphoto_orders', 'photo_releases')), 'only the intended policies still use is_admin()');
select pg_temp.ok((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) ~ 'is_admin\(\)'
                      and p.proname not in ('is_admin', 'can_any', 'admin_morning_digest', 'team_list', 'team_save', 'team_set_active', 'team_remove', 'team_flag_password', 'team_audit_list')) = 0,
                  'only the intended functions still use is_admin()');

do $$ begin raise notice 'ALL ACCESS TESTS PASSED'; end $$;

rollback;
