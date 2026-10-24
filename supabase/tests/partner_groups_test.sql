-- Tests for 20261025080000_partner_groups. Run inside a transaction that is rolled back (a shadow copy, or prod
-- with the migration applied):
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/partner_groups_test.sql
-- "ALL PARTNER GROUP TESTS PASSED" at the end means every check held.

begin;

create function pg_temp.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok  %', p_what;
end $$;
-- true when the statement fails with a message containing p_msg
create function pg_temp.fails(p_sql text, p_msg text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return position(p_msg in sqlerrm) > 0;
end $$;

-- D is a district with schools A and B; L is a league; K and X are spare.
insert into public.prospect_orgs (id, name, audience, stage) values
  ('00000000-0000-0000-0000-0000000b0001', 'Group Test District', 'school', 'client'),
  ('00000000-0000-0000-0000-0000000b0002', 'Group Test School A', 'school', 'client'),
  ('00000000-0000-0000-0000-0000000b0003', 'Group Test School B', 'school', 'no_reply'),
  ('00000000-0000-0000-0000-0000000b0004', 'Group Test League', 'league', 'client'),
  ('00000000-0000-0000-0000-0000000b0005', 'Group Test Keep', 'school', 'client'),
  ('00000000-0000-0000-0000-0000000b0006', 'Group Test Spare', 'school', 'client');

update public.prospect_orgs set parent_id = '00000000-0000-0000-0000-0000000b0001'
 where id in ('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-0000000b0003');
select pg_temp.ok((select count(*) from public.prospect_orgs where parent_id = '00000000-0000-0000-0000-0000000b0001') = 2, 'two schools linked under the district');

select pg_temp.ok(pg_temp.fails($$update public.prospect_orgs set parent_id = id where id = '00000000-0000-0000-0000-0000000b0004'$$, 'prospect_orgs_parent_not_self'), 'a partner can''t be part of itself');
select pg_temp.ok(pg_temp.fails($$update public.prospect_orgs set parent_id = '00000000-0000-0000-0000-0000000b0002' where id = '00000000-0000-0000-0000-0000000b0004'$$, 'is already part of Group Test District'), 'can''t go under a member (one level only)');
select pg_temp.ok(pg_temp.fails($$update public.prospect_orgs set parent_id = '00000000-0000-0000-0000-0000000b0004' where id = '00000000-0000-0000-0000-0000000b0001'$$, 'has its own members'), 'a group can''t go under another partner');
select pg_temp.ok(pg_temp.fails($$insert into public.prospect_orgs (name, audience, stage, parent_id) values ('Group Test New', 'school', 'new', '00000000-0000-0000-0000-0000000b0003')$$, 'is already part of'), 'a new partner can''t go under a member either');

-- unlink
update public.prospect_orgs set parent_id = null where id = '00000000-0000-0000-0000-0000000b0003';
select pg_temp.ok((select parent_id is null from public.prospect_orgs where id = '00000000-0000-0000-0000-0000000b0003'), 'Remove takes a school out');
update public.prospect_orgs set parent_id = '00000000-0000-0000-0000-0000000b0001' where id = '00000000-0000-0000-0000-0000000b0003';

-- agreement covers its members
insert into public.partner_agreements (id, org_id, title, status) values
  ('00000000-0000-0000-0000-0000000b0021', '00000000-0000-0000-0000-0000000b0001', 'District agreement', 'accepted');
select pg_temp.ok((select covers_members = false from public.partner_agreements where id = '00000000-0000-0000-0000-0000000b0021'), 'agreements don''t cover members by default');
update public.partner_agreements set covers_members = true where id = '00000000-0000-0000-0000-0000000b0021';
select pg_temp.ok((select covers_members from public.partner_agreements where id = '00000000-0000-0000-0000-0000000b0021'), 'covers_members can be set');

-- merging the district into Keep moves its schools to Keep
update public.prospect_orgs set merged_into = '00000000-0000-0000-0000-0000000b0005' where id = '00000000-0000-0000-0000-0000000b0001';
select pg_temp.ok((select count(*) from public.prospect_orgs where parent_id = '00000000-0000-0000-0000-0000000b0005') = 2, 'merged group''s members follow it to the partner kept');

-- merging a member into its own group: the group keeps the rest, the merged one leaves
update public.prospect_orgs set merged_into = '00000000-0000-0000-0000-0000000b0005' where id = '00000000-0000-0000-0000-0000000b0003';
select pg_temp.ok((select parent_id is null from public.prospect_orgs where id = '00000000-0000-0000-0000-0000000b0003'), 'a merged member leaves its group');
select pg_temp.ok((select count(*) from public.prospect_orgs where parent_id = '00000000-0000-0000-0000-0000000b0005') = 1, 'the other member stays');

-- merging a member (Spare under League) into a partner with no group: the kept one joins the group
update public.prospect_orgs set parent_id = '00000000-0000-0000-0000-0000000b0004' where id = '00000000-0000-0000-0000-0000000b0006';
insert into public.prospect_orgs (id, name, audience, stage) values ('00000000-0000-0000-0000-0000000b0007', 'Group Test Lone', 'school', 'client');
update public.prospect_orgs set merged_into = '00000000-0000-0000-0000-0000000b0007' where id = '00000000-0000-0000-0000-0000000b0006';
select pg_temp.ok((select parent_id = '00000000-0000-0000-0000-0000000b0004' from public.prospect_orgs where id = '00000000-0000-0000-0000-0000000b0007'), 'the kept partner takes the merged one''s group');

select pg_temp.ok(pg_temp.fails($$update public.prospect_orgs set parent_id = '00000000-0000-0000-0000-0000000b0001' where id = '00000000-0000-0000-0000-0000000b0004'$$, 'was merged into another partner'), 'can''t link under a merged partner');

do $$ begin raise notice 'ALL PARTNER GROUP TESTS PASSED'; end $$;
rollback;
