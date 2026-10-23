-- Tests for 20261023091300_job_gear. Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/job_gear_test.sql
-- "ALL JOB GEAR TESTS PASSED" at the end means every check held. Dates are relative to today.

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

insert into public.prospect_orgs (id, name) values ('00000000-0000-0000-0000-0000000000f1', 'Hampden Rec');
insert into public.inventory_bins (id, code) values ('00000000-0000-0000-0000-00000000b001', 'GJ-1');
insert into public.inventory_kits (id, name, bin_id) values ('00000000-0000-0000-0000-00000000c001', 'GJ sports kit', '00000000-0000-0000-0000-00000000b001');
insert into public.inventory_items (id, name, bin_id, kit_id) values
  ('00000000-0000-0000-0000-00000000a001', 'GJ camera', '00000000-0000-0000-0000-00000000b001', null),
  ('00000000-0000-0000-0000-00000000a002', 'GJ flash', null, '00000000-0000-0000-0000-00000000c001'),
  ('00000000-0000-0000-0000-00000000a003', 'GJ backdrop', '00000000-0000-0000-0000-00000000b001', null);

-- ---------------------------------------------------------------- e1: lists per job type
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.gear_template_save(jsonb_build_object('type_key', 'sports_data', 'kit_id', '00000000-0000-0000-0000-00000000c001')) ->> 'ok')::boolean, 'e1: adds a kit to the sports list');
select pg_temp.ok((public.gear_template_save(jsonb_build_object('type_key', 'sports_data', 'item_id', '00000000-0000-0000-0000-00000000a001')) ->> 'ok')::boolean, 'e1: adds an item');
select pg_temp.ok((public.gear_template_save(jsonb_build_object('label', 'GJ AA batteries', 'qty', 24)) ->> 'ok')::boolean, 'e1: adds words for every job type');
select pg_temp.raises($$select public.gear_template_save('{"label": "  "}')$$, 'e1: a line needs something');
select pg_temp.raises($$select public.gear_template_save('{"type_key": "nope", "label": "x"}')$$, 'e1: job type must exist');
select pg_temp.ok((select count(*) from public.gear_templates where archived_at is null and (label like 'GJ%' or kit_id is not null or item_id is not null)) = 3, 'e1: three lines');

-- ---------------------------------------------------------------- booking copies the list
reset role;
insert into public.bookings (id, org_id, type_key, picture_day, start_at, end_at, status)
select '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1', 'sports_data', today + 1, now() + interval '1 day', now() + interval '1 day 2 hours', 'booked' from d;
insert into public.bookings (id, org_id, type_key, picture_day, start_at, end_at, status)
select '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f1', 'school', today + 1, now() + interval '1 day', now() + interval '1 day 2 hours', 'tracked' from d;
select pg_temp.ok((select count(*) from public.booking_gear where booking_id = '00000000-0000-0000-0000-0000000000b1') = 3, 'booked sports job gets the sports list and the every-job line');
select pg_temp.ok((select count(*) from public.booking_gear where booking_id = '00000000-0000-0000-0000-0000000000b2') = 0, 'track-only job gets no gear list');
select pg_temp.ok((select label from public.booking_gear where booking_id = '00000000-0000-0000-0000-0000000000b1' and kit_id is not null) = 'GJ sports kit', 'kit line keeps the kit name');

select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(jsonb_array_length(public.job_gear('00000000-0000-0000-0000-0000000000b1') -> 'lines') = 3, 'v1: sees the job''s lines');
select pg_temp.ok((public.job_gear('00000000-0000-0000-0000-0000000000b1') -> 'booking' ->> 'title') = 'Hampden Rec • Sports: Parent Contacts', 'v1: sees the job''s name');
select pg_temp.ok((public.inventory_attention() ->> 'gear_missing')::int >= 1, 'v1: Today flags a job tomorrow missing gear');
select pg_temp.ok((select (j ->> 'got')::int = 0 and (j ->> 'lines')::int = 3 from jsonb_array_elements(public.job_gear_jobs()) j where j ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1'), 'v1: Jobs tab: 0 of 3 got');
select pg_temp.raises($$select public.gear_template_save('{"label": "x"}')$$, 'v1: cannot change gear lists');
select pg_temp.raises($$select public.job_gear_line_add(jsonb_build_object('booking_id', '00000000-0000-0000-0000-0000000000b1', 'label', 'x'))$$, 'v1: cannot add lines to a job');

-- ---------------------------------------------------------------- repairs block check-out
select pg_temp.raises($$select public.inventory_condition_set('00000000-0000-0000-0000-00000000a002', 'broken', '')$$, 'v1: broken needs a reason');
select pg_temp.ok((public.inventory_condition_set('00000000-0000-0000-0000-00000000a002', 'broken', 'Flash tube cracked') ->> 'ok')::boolean, 'v1: reports the flash broken');
select pg_temp.raises($$select public.inventory_condition_set('00000000-0000-0000-0000-00000000a002', 'ok')$$, 'v1: cannot mark it fixed');
select pg_temp.raises($$select public.job_gear_check_out('00000000-0000-0000-0000-0000000000b1', null, '00000000-0000-0000-0000-00000000c001')$$, 'v1: kit with a broken flash cannot go out');
select pg_temp.raises($$select public.inventory_check_out('00000000-0000-0000-0000-00000000a002', null, '00000000-0000-0000-0000-0000000000c1')$$, 'v1: the broken flash itself cannot go out');
select pg_temp.ok((select g ->> 'warn' from jsonb_array_elements(public.job_gear('00000000-0000-0000-0000-0000000000b1') -> 'lines') g where g ->> 'kit_id' is not null) = 'Something in this kit needs repair', 'v1: job shows the kit warning');
select pg_temp.ok((select not_ok_count from public.inventory_kits_v where id = '00000000-0000-0000-0000-00000000c001') = 1, 'v1: kits view counts it');

select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.inventory_condition_set('00000000-0000-0000-0000-00000000a002', 'repair', 'Sent to Canon') ->> 'ok')::boolean, 'e1: sends it to repair');
select pg_temp.ok((select condition_note from public.inventory_items where id = '00000000-0000-0000-0000-00000000a002') = 'Sent to Canon', 'e1: note kept');
select pg_temp.ok((public.inventory_condition_set('00000000-0000-0000-0000-00000000a002', 'ok', 'New tube', 80) ->> 'ok')::boolean, 'e1: marks it fixed');
select pg_temp.ok((select kind = 'repair' and cost = 80 from public.inventory_service where item_id = '00000000-0000-0000-0000-00000000a002'), 'e1: fixing logs a repair with the cost');

-- ---------------------------------------------------------------- check out for the job
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.job_gear_check_out('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000a001', null, null, '00000000-0000-0000-0000-0000000000e1')$$, 'v1: only to themselves');
select pg_temp.ok((public.job_gear_check_out('00000000-0000-0000-0000-0000000000b1', null, '00000000-0000-0000-0000-00000000c001') ->> 'line_id') is not null, 'v1: scans the kit out, fills the kit line');
select pg_temp.ok((select due_on = (select today + 2 from d) and booking_id = '00000000-0000-0000-0000-0000000000b1' and holder_name = 'View One'
                     from public.inventory_checkouts where kit_id = '00000000-0000-0000-0000-00000000c001' and returned_at is null), 'v1: due the day after picture day, tied to the job');
select pg_temp.ok((select job_title from public.inventory_out_v where kit_id = '00000000-0000-0000-0000-00000000c001') like 'Hampden Rec%', 'v1: Checked out shows the job');
select pg_temp.ok((public.job_gear_check_out('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000a003', null) ->> 'line_id') is null, 'v1: something not on the list still goes out for the job');
select pg_temp.ok(jsonb_array_length(public.job_gear('00000000-0000-0000-0000-0000000000b1') -> 'extras') = 1, 'v1: shows as an extra');
select pg_temp.ok((public.job_gear_pack((select id from public.booking_gear where booking_id = '00000000-0000-0000-0000-0000000000b1' and label = 'GJ AA batteries'), true) ->> 'ok')::boolean, 'v1: ticks the batteries packed');
select pg_temp.ok((select count(*) from jsonb_array_elements(public.job_gear('00000000-0000-0000-0000-0000000000b1') -> 'lines') g where (g ->> 'got')::boolean) = 2, 'v1: 2 of 3 got');

-- the camera is out with someone else: the line warns
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.inventory_check_out('00000000-0000-0000-0000-00000000a001', null, null, 'Freelancer Fred', null, '');
select pg_temp.ok((select g ->> 'warn' from jsonb_array_elements(public.job_gear('00000000-0000-0000-0000-0000000000b1') -> 'lines') g where g ->> 'item_id' is not null) like 'Out with Freelancer Fred%', 'e1: line warns it is out with someone else');

-- ---------------------------------------------------------------- the list follows the template; got lines stay
select pg_temp.ok((public.gear_template_save(jsonb_build_object('id', (select id from public.gear_templates where item_id = '00000000-0000-0000-0000-00000000a001'),
                    'type_key', 'sports_data', 'item_id', '00000000-0000-0000-0000-00000000a001', 'qty', 2)) ->> 'ok')::boolean, 'e1: changes the camera line to 2');
select pg_temp.ok((select qty from public.booking_gear where booking_id = '00000000-0000-0000-0000-0000000000b1' and item_id = '00000000-0000-0000-0000-00000000a001') = 2, 'untouched job line follows');
select pg_temp.ok((public.gear_template_archive((select id from public.gear_templates where kit_id = '00000000-0000-0000-0000-00000000c001')) ->> 'ok')::boolean, 'e1: removes the kit from the list');
select pg_temp.ok((select count(*) from public.booking_gear where booking_id = '00000000-0000-0000-0000-0000000000b1' and kit_id = '00000000-0000-0000-0000-00000000c001') = 1, 'the job''s got kit line stays');
select pg_temp.ok((public.job_gear_line_add(jsonb_build_object('booking_id', '00000000-0000-0000-0000-0000000000b1', 'label', 'GJ ladder')) ->> 'ok')::boolean, 'e1: adds a line to one job');
reset role;
update public.bookings set status = 'cancelled' where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select count(*) from public.booking_gear where booking_id = '00000000-0000-0000-0000-0000000000b1' and template_id is not null and checkout_id is null and packed_at is null) = 0, 'cancelled: open list lines go');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.job_gear_check_out('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000a003', null)$$, 'v1: nothing goes out for a cancelled job');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.job_gear_jobs()) j where j ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b1'), 'v1: cancelled job leaves the Jobs tab');

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
select pg_temp.raises($$select public.job_gear('00000000-0000-0000-0000-0000000000b1')$$, 'n1: no job gear');
select pg_temp.raises($$select public.gear_templates_list()$$, 'n1: no lists');
select pg_temp.raises($$select public.inventory_condition_set('00000000-0000-0000-0000-00000000a001', 'broken', 'x')$$, 'n1: cannot report broken');
select pg_temp.ok((select count(*) from public.booking_gear) = 0, 'n1: sees no booking gear rows');
select pg_temp.act(null);
select pg_temp.raises($$select public.job_gear_jobs()$$, 'anon: nothing');

reset role;
select 'ALL JOB GEAR TESTS PASSED';
rollback;
