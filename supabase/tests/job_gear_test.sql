-- Tests for 20261023091300_job_gear (repairs and past-due gear). Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/job_gear_test.sql
-- "ALL GEAR REPAIR TESTS PASSED" at the end means every check held. Dates are relative to today.

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

-- e1 edits inventory; v1 views it (and holds late gear); n1 has none.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com');
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true),
  ('00000000-0000-0000-0000-0000000000c1', 'View One', true), ('00000000-0000-0000-0000-0000000000d1', 'No One', true)
  on conflict (user_id) do update set display_name = excluded.display_name;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'inventory', 'edit'),
  ('00000000-0000-0000-0000-0000000000c1', 'inventory', 'view');

insert into public.inventory_bins (id, code) values ('00000000-0000-0000-0000-00000000b001', 'GJ-1');
insert into public.inventory_kits (id, name, bin_id) values ('00000000-0000-0000-0000-00000000c001', 'GJ sports kit', '00000000-0000-0000-0000-00000000b001');
insert into public.inventory_items (id, name, bin_id, kit_id) values
  ('00000000-0000-0000-0000-00000000a001', 'GJ camera', '00000000-0000-0000-0000-00000000b001', null),
  ('00000000-0000-0000-0000-00000000a002', 'GJ flash', null, '00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-00000000a003', 'GJ backdrop', '00000000-0000-0000-0000-00000000b001', null);

select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
-- ---------------------------------------------------------------- repairs block check-out
select pg_temp.raises($$select public.inventory_condition_set('00000000-0000-0000-0000-00000000a002', 'broken', '')$$, 'v1: broken needs a reason');
select pg_temp.ok((public.inventory_condition_set('00000000-0000-0000-0000-00000000a002', 'broken', 'Flash tube cracked') ->> 'ok')::boolean, 'v1: reports the flash broken');
select pg_temp.raises($$select public.inventory_condition_set('00000000-0000-0000-0000-00000000a002', 'ok')$$, 'v1: cannot mark it fixed');
select pg_temp.raises($$select public.inventory_check_out(null, '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000c1')$$, 'v1: kit with a broken flash cannot go out');
select pg_temp.raises($$select public.inventory_check_out('00000000-0000-0000-0000-00000000a002', null, '00000000-0000-0000-0000-0000000000c1')$$, 'v1: the broken flash itself cannot go out');
select pg_temp.ok((select not_ok_count from public.inventory_kits_v where id = '00000000-0000-0000-0000-00000000c001') = 1, 'v1: kits view counts it');

select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.inventory_condition_set('00000000-0000-0000-0000-00000000a002', 'repair', 'Sent to Canon') ->> 'ok')::boolean, 'e1: sends it to repair');
select pg_temp.ok((select condition_note from public.inventory_items where id = '00000000-0000-0000-0000-00000000a002') = 'Sent to Canon', 'e1: note kept');
select pg_temp.ok((public.inventory_condition_set('00000000-0000-0000-0000-00000000a002', 'ok', 'New tube', 80) ->> 'ok')::boolean, 'e1: marks it fixed');
select pg_temp.ok((select kind = 'repair' and cost = 80 from public.inventory_service where item_id = '00000000-0000-0000-0000-00000000a002'), 'e1: fixing logs a repair with the cost');

-- ---------------------------------------------------------------- check out (now fixed)
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.inventory_check_out(null, '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000c1') ->> 'ok')::boolean, 'v1: the fixed kit goes out again');

-- ---------------------------------------------------------------- past-due push
reset role;
update public.inventory_checkouts set due_on = (select today - 1 from d) where kit_id = '00000000-0000-0000-0000-00000000c001' and returned_at is null;
delete from public.inventory_push_log;
delete from public.push_outbox where topic = 'gear_overdue';
select pg_temp.ok(public.inventory_push(true) >= 2, 'push: goes out');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'gear_overdue' and target_user = '00000000-0000-0000-0000-0000000000e1' and body like '%GJ sports kit (View One%'), 'push: manager gets the list');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'gear_overdue' and target_user = '00000000-0000-0000-0000-0000000000c1' and body like 'GJ sports kit%'), 'push: holder gets their own');
select pg_temp.ok(not exists (select 1 from public.push_outbox where topic = 'gear_overdue' and target_user = '00000000-0000-0000-0000-0000000000d1'), 'push: nobody else');
select pg_temp.ok(public.inventory_push(true) = 0, 'push: once a day');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.inventory_attention() ->> 'past_due')::int >= 1, 'v1: Today counts past due');
select pg_temp.raises($$select public.inventory_push(true)$$, 'v1: cannot run the push');

-- ---------------------------------------------------------------- outsiders
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.inventory_attention()$$, 'n1: no inventory Today counts');
select pg_temp.raises($$select public.inventory_condition_set('00000000-0000-0000-0000-00000000a001', 'broken', 'x')$$, 'n1: cannot report broken');
select pg_temp.act(null);
select pg_temp.raises($$select public.inventory_condition_set('00000000-0000-0000-0000-00000000a001', 'broken', 'x')$$, 'anon: nothing');

reset role;
select 'ALL GEAR REPAIR TESTS PASSED';
rollback;
