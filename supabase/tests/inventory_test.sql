-- Tests for 20261022090000_inventory. Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/inventory_test.sql
-- "ALL INVENTORY TESTS PASSED" at the end means every check held.

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

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'), ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000c1', 'View One', true),
  ('00000000-0000-0000-0000-0000000000d1', 'No Inventory', true);
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'inventory', 'edit'), ('00000000-0000-0000-0000-0000000000c1', 'inventory', 'view');

select pg_temp.ok((select status from public.app_modules where key = 'inventory') = 'live', 'inventory module is live');

-- ---------------------------------------------------------------- e1: inventory edit
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
insert into public.inventory_bins (id, code, location) values
  ('00000000-0000-0000-0000-00000000b001', 'A-01', 'Studio shelf 1'), ('00000000-0000-0000-0000-00000000b002', 'V-1', 'Van');
select pg_temp.raises($$insert into public.inventory_bins (code) values (' a-01 ')$$, 'e1: bin codes are unique ignoring case');
insert into public.inventory_kits (id, name, bin_id) values ('00000000-0000-0000-0000-00000000c001', 'Sports kit 1', '00000000-0000-0000-0000-00000000b002');
insert into public.inventory_items (id, name, qty, serial, bin_id, kit_id) values
  ('00000000-0000-0000-0000-00000000a001', 'AA batteries', 24, '', '00000000-0000-0000-0000-00000000b001', null),
  ('00000000-0000-0000-0000-00000000a002', 'Canon R6 body', 1, 'SN-12345', '00000000-0000-0000-0000-00000000b001', null),
  ('00000000-0000-0000-0000-00000000a003', 'Godox AD600 flash', 1, 'GX-9', null, '00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-00000000a004', 'Light stand', 2, '', null, '00000000-0000-0000-0000-00000000c001');
select pg_temp.raises($$insert into public.inventory_items (name, serial) values ('Other', 'sn-12345')$$, 'e1: serial numbers are unique');
select pg_temp.ok((select updated_by from public.inventory_items where id = '00000000-0000-0000-0000-00000000a001') = '00000000-0000-0000-0000-0000000000e1', 'e1: rows stamp who changed them');

select pg_temp.ok(jsonb_array_length(public.inventory_search('batteries') -> 'items') = 1, 'search: finds by name');
select pg_temp.ok(public.inventory_search('batt') -> 'items' -> 0 ->> 'bin_code' = 'A-01', 'search: says which bin');
select pg_temp.ok(public.inventory_search('sn-123') -> 'items' -> 0 ->> 'name' = 'Canon R6 body', 'search: finds by serial');
select pg_temp.ok(public.inventory_search('flash') -> 'items' -> 0 ->> 'bin_code' = 'V-1', 'search: a kit item is in its kit''s bin');
select pg_temp.ok(public.inventory_search('flash') -> 'items' -> 0 ->> 'kit_name' = 'Sports kit 1', 'search: names the kit');
select pg_temp.ok(jsonb_array_length(public.inventory_search('van') -> 'items') = 2, 'search: by bin location');
select pg_temp.ok(jsonb_array_length(public.inventory_search('canon studio') -> 'items') = 1, 'search: every word must match');
select pg_temp.ok(jsonb_array_length(public.inventory_search('100%') -> 'items') = 0, 'search: % is literal');
select pg_temp.ok(jsonb_array_length(public.inventory_search('sports') -> 'kits') = 1, 'search: finds kits');
select pg_temp.ok(jsonb_array_length(public.inventory_search('a-01') -> 'bins') = 1, 'search: finds bins');
select pg_temp.ok(jsonb_array_length(public.inventory_search('  ') -> 'items') = 0, 'search: blank finds nothing');
select pg_temp.ok((select item_count from public.inventory_bins_v where code = 'A-01') = 2, 'bins view: counts loose items');
select pg_temp.ok((select kit_count from public.inventory_bins_v where code = 'V-1') = 1, 'bins view: counts kits');
select pg_temp.ok((select item_count from public.inventory_kits_v) = 2, 'kits view: counts items');
select pg_temp.ok(jsonb_array_length(public.inventory_people()) = 3, 'people: lists active team members');

-- check out the kit to View One; its items go with it
select pg_temp.ok((public.inventory_check_out(null, '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000c1', null, current_date + 3, 'Hampden') ->> 'ok')::boolean, 'e1: checks the kit out to v1');
select pg_temp.ok((select holder_name from public.inventory_items_v where id = '00000000-0000-0000-0000-00000000a003') = 'View One', 'kit items show who has them');
select pg_temp.ok((select out_with_kit from public.inventory_items_v where id = '00000000-0000-0000-0000-00000000a003'), 'kit items say they went with the kit');
select pg_temp.raises($$select public.inventory_check_out('00000000-0000-0000-0000-00000000a003', null, '00000000-0000-0000-0000-0000000000e1')$$, 'e1: cannot check out an item that is out with its kit');
select pg_temp.raises($$select public.inventory_check_out(null, '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000e1')$$, 'e1: cannot check out a kit twice');
select pg_temp.ok((public.inventory_check_out('00000000-0000-0000-0000-00000000a002', null, null, 'Pat (freelancer)') ->> 'ok')::boolean, 'e1: checks an item out to someone off the team');
select pg_temp.raises($$select public.inventory_check_out('00000000-0000-0000-0000-00000000a001', null, null, '  ')$$, 'e1: must say who has it');
select pg_temp.raises($$select public.inventory_check_out('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000e1')$$, 'e1: one item or one kit, not both');
select pg_temp.ok((select count(*) from public.inventory_out_v) = 2, 'out view: two things are out');
select pg_temp.raises($$delete from public.inventory_bins where code = 'A-01'$$, 'e1: a bin with items cannot be deleted');

-- ---------------------------------------------------------------- v1: inventory view
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(jsonb_array_length(public.inventory_search('canon') -> 'items') = 1, 'v1: can search');
select pg_temp.ok((select count(*) from public.inventory_out_v) = 2, 'v1: sees what is out');
select pg_temp.raises($$insert into public.inventory_bins (code) values ('Z-9')$$, 'v1: cannot add bins');
update public.inventory_items set qty = 0 where name = 'AA batteries';
select pg_temp.ok((select qty from public.inventory_items where name = 'AA batteries') = 24, 'v1: cannot change items');
select pg_temp.raises($$insert into public.inventory_checkouts (item_id, holder_name) values ('00000000-0000-0000-0000-00000000a001', 'x')$$, 'v1: cannot write checkouts directly');
select pg_temp.raises($$select public.inventory_check_out('00000000-0000-0000-0000-00000000a001', null, '00000000-0000-0000-0000-0000000000e1')$$, 'v1: cannot check out to someone else');
select pg_temp.raises($$select public.inventory_check_out('00000000-0000-0000-0000-00000000a001', null, null, 'Pat')$$, 'v1: cannot check out to a typed name');
select pg_temp.ok((public.inventory_check_out('00000000-0000-0000-0000-00000000a001', null, '00000000-0000-0000-0000-0000000000c1') ->> 'ok')::boolean, 'v1: checks batteries out to self');
select pg_temp.raises(format('select public.inventory_return(%s)', (select id from public.inventory_out_v where item_id = '00000000-0000-0000-0000-00000000a002')), 'v1: cannot return someone else''s');
select pg_temp.ok((public.inventory_return((select id from public.inventory_out_v where kit_id = '00000000-0000-0000-0000-00000000c001')) ->> 'ok')::boolean, 'v1: returns own kit');
select pg_temp.ok((select holder_name from public.inventory_items_v where id = '00000000-0000-0000-0000-00000000a003') is null, 'kit items are back with the kit');
select pg_temp.ok(jsonb_array_length(public.inventory_history('00000000-0000-0000-0000-00000000a003', null)) = 1, 'history: an item lists its kit''s checkouts');
select pg_temp.raises($$insert into storage.objects (bucket_id, name) values ('inventory', 'x.jpg')$$, 'v1: cannot upload photos');

-- ---------------------------------------------------------------- d1: no inventory access
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.ok((select count(*) from public.inventory_items) = 0, 'd1: sees no items');
select pg_temp.ok((select count(*) from public.inventory_items_v) = 0, 'd1: sees nothing through the views');
select pg_temp.raises($$select public.inventory_search('canon')$$, 'd1: cannot search');
select pg_temp.raises($$select public.inventory_people()$$, 'd1: cannot list people');
select pg_temp.raises($$select public.inventory_check_out('00000000-0000-0000-0000-00000000a004', null, '00000000-0000-0000-0000-0000000000d1')$$, 'd1: cannot check out');

-- ---------------------------------------------------------------- anon
select pg_temp.act(null);
select pg_temp.raises($$select count(*) from public.inventory_items$$, 'anon: no table access');
select pg_temp.raises($$select public.inventory_search('canon')$$, 'anon: cannot search');

-- ---------------------------------------------------------------- e1 again: upload a photo, return, delete
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
insert into storage.objects (bucket_id, name) values ('inventory', 'items/x.jpg');
select pg_temp.ok((public.inventory_return((select id from public.inventory_out_v where item_id = '00000000-0000-0000-0000-00000000a002')) ->> 'ok')::boolean, 'e1: returns anyone''s');
select pg_temp.raises(format('select public.inventory_return(%s)', (select min(id) from public.inventory_checkouts)), 'e1: cannot return twice');
delete from public.inventory_kits where id = '00000000-0000-0000-0000-00000000c001';
select pg_temp.ok((select count(*) from public.inventory_items where kit_id is null and bin_id = '00000000-0000-0000-0000-00000000b002') = 2, 'deleting a kit leaves its items in its bin');

reset role;
do $$ begin raise notice 'ALL INVENTORY TESTS PASSED'; end $$;
rollback;
