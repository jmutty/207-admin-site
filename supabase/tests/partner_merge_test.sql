-- Tests for 20261024213000_partner_merge. Run inside a transaction that is rolled back (a shadow copy, or prod
-- with the migration applied):
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/partner_merge_test.sql
-- "ALL PARTNER MERGE TESTS PASSED" at the end means every check held.

begin;

create function pg_temp.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok  %', p_what;
end $$;

-- K is kept, D is the duplicate. Ann is on both (same email, different case); Bob only on D and Main for portraits,
-- which K already has a Main for (Ann); Cy only on D, Copy in for action.
insert into public.prospect_orgs (id, name, audience, stage, town, notes, gotphoto_names, cal_dates, sports, service_status) values
  ('00000000-0000-0000-0000-0000000a0001', 'Merge Test Keep', 'league', 'talking', null, 'keep note',
     '{"Keep GP"}', array[current_date - 300]::date[], '{soccer}', '{"portraits":"prospect"}'),
  ('00000000-0000-0000-0000-0000000a0002', 'Merge Test Dup', 'league', 'client', 'Bangor', 'dup note',
     '{"Dup GP"}', array[current_date - 200, current_date - 300]::date[], '{swim}', '{"portraits":"client"}');
insert into public.prospect_contacts (id, org_id, first_name, email, phone, service_roles, unsubscribed_at) values
  ('00000000-0000-0000-0000-0000000a0011', '00000000-0000-0000-0000-0000000a0001', 'Ann', 'ann@merge.test', null, '{"portraits":"main"}', null),
  ('00000000-0000-0000-0000-0000000a0012', '00000000-0000-0000-0000-0000000a0002', 'Annie', 'ANN@merge.test', '555-1111', '{"portraits":"main"}', now()),
  ('00000000-0000-0000-0000-0000000a0013', '00000000-0000-0000-0000-0000000a0002', 'Bob', 'bob@merge.test', null, '{"portraits":"main"}', null),
  ('00000000-0000-0000-0000-0000000a0014', '00000000-0000-0000-0000-0000000a0002', 'Cy', 'cy@merge.test', null, '{"action":"copy"}', null);
insert into public.bookings (id, org_id, type_key, picture_day, start_at, end_at, status, contact_ids) values
  ('00000000-0000-0000-0000-0000000a0021', '00000000-0000-0000-0000-0000000a0002', (select key from public.booking_types limit 1),
     current_date + 40, now() + interval '40 days', now() + interval '40 days 2 hours', 'tracked',
     array['00000000-0000-0000-0000-0000000a0012', '00000000-0000-0000-0000-0000000a0013']::uuid[]);
insert into public.prospect_activities (id, org_id, contact_id, kind, body) values
  ('00000000-0000-0000-0000-0000000a0031', '00000000-0000-0000-0000-0000000a0002', '00000000-0000-0000-0000-0000000a0012', 'note', 'old note');
insert into public.partner_rebook (org_id, due_on) values
  ('00000000-0000-0000-0000-0000000a0001', current_date + 10),
  ('00000000-0000-0000-0000-0000000a0002', current_date + 10),
  ('00000000-0000-0000-0000-0000000a0002', current_date + 90);

-- preview
select pg_temp.ok((public.partner_merge_preview('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0002') ->> 'contacts')::int = 3, 'preview counts 3 contacts');
select pg_temp.ok((public.partner_merge_preview('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0002') ->> 'same_people')::int = 1, 'preview finds Ann on both');
select pg_temp.ok((public.partner_merge_preview('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0002') ->> 'jobs')::int = 1, 'preview counts the job');
select pg_temp.ok(public.partner_merge_preview('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0001') ->> 'blocked' is not null, 'same partner twice is blocked');

-- merge
select public.partner_merge('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0002');

select pg_temp.ok((select org_id from public.bookings where id = '00000000-0000-0000-0000-0000000a0021') = '00000000-0000-0000-0000-0000000a0001', 'job moved');
select pg_temp.ok((select contact_ids from public.bookings where id = '00000000-0000-0000-0000-0000000a0021')
                  = array['00000000-0000-0000-0000-0000000a0011', '00000000-0000-0000-0000-0000000a0013']::uuid[], 'job tick on the duplicate Ann now points at kept Ann');
select pg_temp.ok((select contact_id from public.prospect_activities where id = '00000000-0000-0000-0000-0000000a0031') = '00000000-0000-0000-0000-0000000a0011', 'history follows Ann');
select pg_temp.ok((select phone from public.prospect_contacts where id = '00000000-0000-0000-0000-0000000a0011') = '555-1111', 'blank phone filled in');
select pg_temp.ok((select unsubscribed_at is not null from public.prospect_contacts where id = '00000000-0000-0000-0000-0000000a0011'), 'unsubscribe carried over');
select pg_temp.ok((select org_id = '00000000-0000-0000-0000-0000000a0002' and history_only from public.prospect_contacts where id = '00000000-0000-0000-0000-0000000a0012'), 'duplicate Ann stays behind as history only');
select pg_temp.ok((select org_id = '00000000-0000-0000-0000-0000000a0001' and service_roles ->> 'portraits' = 'copy' from public.prospect_contacts where id = '00000000-0000-0000-0000-0000000a0013'), 'Bob moved, second Main became Copy in');
select pg_temp.ok((select org_id = '00000000-0000-0000-0000-0000000a0001' and service_roles ->> 'action' = 'copy' from public.prospect_contacts where id = '00000000-0000-0000-0000-0000000a0014'), 'Cy moved as is');
select pg_temp.ok((select service_roles ->> 'portraits' = 'main' from public.prospect_contacts where id = '00000000-0000-0000-0000-0000000a0011'), 'Ann still Main');
select pg_temp.ok((select count(*) from public.partner_rebook where org_id = '00000000-0000-0000-0000-0000000a0001') = 2, 'rebook row moved, clash left behind');

select pg_temp.ok((select gotphoto_names = '{"Dup GP","Keep GP"}' from public.prospect_orgs where id = '00000000-0000-0000-0000-0000000a0001'), 'GotPhoto names combined');
select pg_temp.ok((select cardinality(cal_dates) = 2 from public.prospect_orgs where id = '00000000-0000-0000-0000-0000000a0001'), 'calendar dates combined without repeats');
select pg_temp.ok((select town = 'Bangor' and notes = E'keep note\ndup note' from public.prospect_orgs where id = '00000000-0000-0000-0000-0000000a0001'), 'blank town filled, notes joined');
select pg_temp.ok((select stage = 'client' and service_status ->> 'portraits' = 'client' from public.prospect_orgs where id = '00000000-0000-0000-0000-0000000a0001'), 'further-along stage and status win');
select pg_temp.ok((select sports @> '{soccer,swim}' from public.prospect_orgs where id = '00000000-0000-0000-0000-0000000a0001'), 'sports combined');

select pg_temp.ok((select name = 'Merge Test Dup (merged into Merge Test Keep)' and merged_into = '00000000-0000-0000-0000-0000000a0001'
                     and stage = 'do_not_contact' and gotphoto_names = '{}' and cal_dates = '{}' and last_job_at is null
                     from public.prospect_orgs where id = '00000000-0000-0000-0000-0000000a0002'), 'old record kept, renamed, out of lists and syncs');
select pg_temp.ok(exists (select 1 from public.prospect_activities where org_id = '00000000-0000-0000-0000-0000000a0001' and meta ->> 'merged_from' = '00000000-0000-0000-0000-0000000a0002'), 'merge noted in history');

select pg_temp.ok((select merged_into is not null from public.prospect_orgs where name = 'Barracudas Swim (merged into Bangor Region YMCA)'), 'Barracudas record linked to the YMCA');

-- a second merge of the same record is refused
do $$ begin
  perform public.partner_merge('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000a0002');
  raise exception 'FAILED: merged twice';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok  already merged is refused (%)', sqlerrm;
end $$;

select 'ALL PARTNER MERGE TESTS PASSED';
rollback;
