-- Tests for 20261024170000_service_contacts (main contact per service).
-- Run after the migration, in a transaction that is rolled back (safe on production), as the database owner:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/service_contacts_test.sql
-- "ALL SERVICE CONTACT TESTS PASSED" at the end means every check held.

begin;

create function pg_temp.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok  %', p_what;
end $$;

-- the migration moved today's data over
select pg_temp.ok(not exists (select 1 from prospect_orgs where service_status = '{}'::jsonb), 'every partner has at least one service');
select pg_temp.ok(not exists (select 1 from prospect_contacts where is_primary and service_roles = '{}'::jsonb), 'every Main star is main for a service');
select pg_temp.ok(not exists (select 1 from prospect_orgs where audience = 'school' and sp_status is distinct from
                    case when service_status ->> 'school_photos' = 'past_client' then 'client' else service_status ->> 'school_photos' end),
  'the old School photos field matches the School photos status');

-- a school we shoot sports for, pitching school photos
insert into prospect_orgs (id, name, audience, stage, services, service_status) values
  ('00000000-0000-0000-0000-00000000a0f1', 'Zz Riverside Middle School', 'school', 'client', '{portraits}', '{"portraits": "client", "school_photos": "prospect"}'),
  ('00000000-0000-0000-0000-00000000a0f2', 'Zz Lacrosse League', 'league', 'no_reply', '{}', '{}');
select pg_temp.ok((select sp_status = 'prospect' from prospect_orgs where id = '00000000-0000-0000-0000-00000000a0f1'), 'School photos status fills the old field');
select pg_temp.ok((select service_status = '{"portraits": "prospect"}'::jsonb from prospect_orgs where id = '00000000-0000-0000-0000-00000000a0f2'), 'a new league starts as a Team & individual prospect');
update prospect_orgs set sp_status = 'competitor' where id = '00000000-0000-0000-0000-00000000a0f1';
select pg_temp.ok((select service_status ->> 'school_photos' = 'competitor' from prospect_orgs where id = '00000000-0000-0000-0000-00000000a0f1'), 'the old field still works (an older screen or an import)');
update prospect_orgs set sp_status = 'prospect' where id = '00000000-0000-0000-0000-00000000a0f1';

insert into prospect_contacts (id, org_id, first_name, email, role, is_primary) values
  ('00000000-0000-0000-0000-00000000a0c1', '00000000-0000-0000-0000-00000000a0f1', 'Dan', 'dan@zz.test', 'Athletic Director', true);
select pg_temp.ok((select service_roles = '{"portraits": "main"}'::jsonb from prospect_contacts where id = '00000000-0000-0000-0000-00000000a0c1'),
  'a starred contact is main for the service we are a client for, not the school photos pitch');
insert into prospect_contacts (id, org_id, first_name, email, role, service_roles) values
  ('00000000-0000-0000-0000-00000000a0c2', '00000000-0000-0000-0000-00000000a0f1', 'Lisa', 'lisa@zz.test', 'Principal', '{"school_photos": "main", "bogus": "main", "events": "none"}'),
  ('00000000-0000-0000-0000-00000000a0c3', '00000000-0000-0000-0000-00000000a0f1', 'Tammy', 'tammy@zz.test', 'Secretary', '{"portraits": "copy"}');
select pg_temp.ok((select service_roles = '{"school_photos": "main"}'::jsonb and is_primary from prospect_contacts where id = '00000000-0000-0000-0000-00000000a0c2'),
  'roles are tidied (unknown services and "none" dropped) and is_primary follows');
update prospect_contacts set is_primary = false where id = '00000000-0000-0000-0000-00000000a0c1';
select pg_temp.ok((select service_roles = '{}'::jsonb from prospect_contacts where id = '00000000-0000-0000-0000-00000000a0c1'), 'Remove as main (older screens) takes the main roles off');
update prospect_contacts set service_roles = '{"portraits": "main"}' where id = '00000000-0000-0000-0000-00000000a0c1';

-- a school photos booking with the principal on it
insert into bookings (id, org_id, type_key, picture_day, start_at, end_at, status, calendar_status, contact_ids)
values ('00000000-0000-0000-0000-00000000a0b1', '00000000-0000-0000-0000-00000000a0f1', 'school', current_date + 30, now(), now(), 'tracked', 'deleted',
        array['00000000-0000-0000-0000-00000000a0c3', '00000000-0000-0000-0000-00000000a0c2']::uuid[]);
select pg_temp.ok((select service_status ->> 'school_photos' = 'client' from prospect_orgs where id = '00000000-0000-0000-0000-00000000a0f1'), 'a school photos booking makes school photos a client');
select pg_temp.ok((select to_contact = '00000000-0000-0000-0000-00000000a0c2' from booking_recipients('00000000-0000-0000-0000-00000000a0b1', false)), 'the service main is To, even second on the booking');

-- hand-off: the secretary runs picture day, the principal stays copied in
select public.prospect_school_handoff('00000000-0000-0000-0000-00000000a0b1', '00000000-0000-0000-0000-00000000a0c3', true);
select pg_temp.ok((select service_roles = '{"portraits": "copy", "school_photos": "main"}'::jsonb from prospect_contacts where id = '00000000-0000-0000-0000-00000000a0c3'), 'the secretary is the School photos main');
select pg_temp.ok((select service_roles = '{"school_photos": "copy"}'::jsonb from prospect_contacts where id = '00000000-0000-0000-0000-00000000a0c2'), 'the principal is copied in');
select pg_temp.ok((select service_roles = '{"portraits": "main"}'::jsonb from prospect_contacts where id = '00000000-0000-0000-0000-00000000a0c1'), 'the AD is untouched');
select pg_temp.ok((select contact_ids[1] = '00000000-0000-0000-0000-00000000a0c3' and cardinality(contact_ids) = 2 from bookings where id = '00000000-0000-0000-0000-00000000a0b1'), 'the secretary goes first on the booking');
select pg_temp.ok((select to_contact = '00000000-0000-0000-0000-00000000a0c3' from booking_recipients('00000000-0000-0000-0000-00000000a0b1', false)), 'and is now To');

-- a sports booking at a league with nobody main yet: the first person becomes main, the rest copy in
insert into prospect_contacts (id, org_id, first_name, email) values
  ('00000000-0000-0000-0000-00000000a0c4', '00000000-0000-0000-0000-00000000a0f2', 'Jo', 'jo@zz.test'),
  ('00000000-0000-0000-0000-00000000a0c5', '00000000-0000-0000-0000-00000000a0f2', 'Sam', 'sam@zz.test');
insert into bookings (id, org_id, type_key, picture_day, start_at, end_at, status, calendar_status, contact_ids)
values ('00000000-0000-0000-0000-00000000a0b2', '00000000-0000-0000-0000-00000000a0f2', (select key from booking_types where audience = 'sports' order by sort_order limit 1),
        current_date + 30, now(), now(), 'tracked', 'deleted', array['00000000-0000-0000-0000-00000000a0c5', '00000000-0000-0000-0000-00000000a0c4']::uuid[]);
select pg_temp.ok((select service_roles = '{"portraits": "main"}'::jsonb from prospect_contacts where id = '00000000-0000-0000-0000-00000000a0c5')
              and (select service_roles = '{"portraits": "copy"}'::jsonb from prospect_contacts where id = '00000000-0000-0000-0000-00000000a0c4'), 'first on a booking becomes the main');
select pg_temp.ok((select service_status ->> 'portraits' = 'client' from prospect_orgs where id = '00000000-0000-0000-0000-00000000a0f2'), 'and the league is a client');

-- check list: a school with two live services and one person main for both
update prospect_contacts set service_roles = '{"portraits": "main", "school_photos": "main"}' where id = '00000000-0000-0000-0000-00000000a0c1';
update prospect_orgs set roles_checked_at = null where id = '00000000-0000-0000-0000-00000000a0f1';
select pg_temp.ok(exists (select 1 from prospect_orgs o where o.id = '00000000-0000-0000-0000-00000000a0f1' and o.roles_checked_at is null
  and (select count(*) from jsonb_each_text(o.service_status) e where e.value in ('client', 'past_client')) >= 2), 'two live services');

-- the patches went in
select pg_temp.ok(pg_get_functiondef('public.partner_compose(text, uuid, uuid, date)'::regprocedure) like '%partner_rebook_first%', 'rebook emails start from the service people');
select pg_temp.ok(pg_get_functiondef('public.prospect_schedule_threads(uuid)'::regprocedure) like '%prospect_service_of_sequence%', 'outreach threads follow the service');
select pg_temp.ok(pg_get_functiondef('public.prospect_enroll(jsonb, jsonb, text, boolean, boolean)'::regprocedure) like '%held threads by service%', 'held threads follow the service');
select pg_temp.ok(public.partner_rebook_first('00000000-0000-0000-0000-00000000a0f2') is not null, 'partner_rebook_first runs');

do $$ begin raise notice 'ALL SERVICE CONTACT TESTS PASSED'; end $$;
rollback;
