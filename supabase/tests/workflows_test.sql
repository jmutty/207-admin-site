-- Tests for 20261022180000_job_workflows (Job checklists). Run against a NON-production copy of the schema after
-- the migration, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/workflows_test.sql
-- "ALL WORKFLOW TESTS PASSED" at the end means every check held.

begin;

create function pg_temp.act(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', case when p_uid is null then '{"role":"anon"}'
    else json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', '00000000-0000-0000-0000-0000000000' || right(p_uid::text, 2))::text end, true);
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

-- o1 full access; e1 edits checklists; v1 views them; n1 has no access; s1 and s2 shoot
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'o1@example.com'), ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com'),
  ('00000000-0000-0000-0000-0000000000b1', 's1@example.com'), ('00000000-0000-0000-0000-0000000000b2', 's2@example.com');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000e1', 'Ed Edit', true),
  ('00000000-0000-0000-0000-0000000000c1', 'Vi View', true), ('00000000-0000-0000-0000-0000000000d1', 'No Access', true),
  ('00000000-0000-0000-0000-0000000000b1', 'Sam Shooter', true), ('00000000-0000-0000-0000-0000000000b2', 'Ari Shooter', true);
insert into public.team_permissions (user_id, module_key, level) values ('00000000-0000-0000-0000-0000000000e1', 'workflows', 'edit'),
  ('00000000-0000-0000-0000-0000000000c1', 'workflows', 'view');

-- start from a known checklist: drop the seeded starter steps
update public.workflow_steps set archived_at = now();
insert into public.booking_types (key, label) values ('wf_test', 'Test sports') on conflict do nothing;
insert into public.booking_stages (type_key, label, sort, auto) values ('wf_test', 'Booked', 10, 'booked'), ('wf_test', 'Job launched', 40, 'gallery_live');

-- access
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.workflow_templates()$$, 'no access: cannot see checklists');
select pg_temp.raises($$select public.workflow_jobs()$$, 'no access: cannot see job tasks');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.workflow_templates() ->> 'can_edit')::boolean = false, 'view: sees checklists, not editable');
select pg_temp.raises($$select public.workflow_step_save('{"title":"x","anchor":"booked","assign_to":"crew"}')$$, 'view: cannot add a step');

select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.workflow_step_save('{"title":"x","anchor":"launch","offset_days":-2}')$$, 'only picture day steps can be due before');
select pg_temp.raises($$select public.workflow_step_save('{"title":"x","anchor":"booked","assign_to":"person"}')$$, 'a person step needs a person');
create temp table ids (k text primary key, id uuid);
grant all on ids to authenticated;
insert into ids select 'pack', (public.workflow_step_save(jsonb_build_object('type_key', 'wf_test', 'title', 'Pack the kit', 'anchor', 'picture_day', 'offset_days', -1, 'assign_to', 'crew')) ->> 'id')::uuid;
insert into ids select 'confirm', (public.workflow_step_save(jsonb_build_object('type_key', 'wf_test', 'title', 'Confirm', 'anchor', 'booked', 'offset_days', 2, 'assign_to', 'person', 'user_id', '00000000-0000-0000-0000-0000000000e1')) ->> 'id')::uuid;
insert into ids select 'thanks', (public.workflow_step_save(jsonb_build_object('title', 'Thank-you', 'anchor', 'launch', 'offset_days', 14, 'assign_to', 'crew', 'user_id', '00000000-0000-0000-0000-0000000000e1')) ->> 'id')::uuid;
reset role;

-- a booking 10 days out, no crew yet
insert into public.bookings (id, type_key, title_label, picture_day, status) values ('00000000-0000-0000-0000-00000000bb01', 'wf_test', 'Spring', (now() at time zone 'America/New_York')::date + 10, 'booked');
select pg_temp.ok((select count(*) from public.staff_tasks where booking_id = '00000000-0000-0000-0000-00000000bb01') = 1, 'booked: only the person step is made while nobody is on the job');
select pg_temp.ok((select due_on from public.staff_tasks where workflow_step_id = (select id from ids where k = 'confirm')) = (now() at time zone 'America/New_York')::date + 2, 'booked + 2 days');

-- put Sam on the job
insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at)
values ('00000000-0000-0000-0000-0000000000b1', 'job', '00000000-0000-0000-0000-00000000bb01', now() + interval '10 days', now() + interval '10 days 2 hours');
select pg_temp.ok((select user_id from public.staff_tasks where workflow_step_id = (select id from ids where k = 'pack')) = '00000000-0000-0000-0000-0000000000b1', 'crew step goes to the crew');
select pg_temp.ok((select due_on from public.staff_tasks where workflow_step_id = (select id from ids where k = 'pack')) = (now() at time zone 'America/New_York')::date + 9, 'picture day - 1');
select pg_temp.ok(not exists (select 1 from public.staff_tasks where workflow_step_id = (select id from ids where k = 'thanks')), 'launch step waits for launch');

-- move picture day: open tasks follow
update public.bookings set picture_day = picture_day + 5 where id = '00000000-0000-0000-0000-00000000bb01';
select pg_temp.ok((select due_on from public.staff_tasks where workflow_step_id = (select id from ids where k = 'pack')) = (now() at time zone 'America/New_York')::date + 14, 'new picture day moves the task');

-- swap crew: Ari replaces Sam
update public.schedule_entries set user_id = '00000000-0000-0000-0000-0000000000b2' where booking_id = '00000000-0000-0000-0000-00000000bb01';
select pg_temp.ok((select user_id from public.staff_tasks where workflow_step_id = (select id from ids where k = 'pack')) = '00000000-0000-0000-0000-0000000000b2', 'new crew takes the task');

-- a hand edit keeps the task where it was put
update public.staff_tasks set due_on = due_on + 1 where workflow_step_id = (select id from ids where k = 'pack');
select pg_temp.ok((select not wf_auto from public.staff_tasks where workflow_step_id = (select id from ids where k = 'pack')), 'hand edit: task leaves the job''s control');
update public.bookings set picture_day = picture_day + 1 where id = '00000000-0000-0000-0000-00000000bb01';
select pg_temp.ok((select due_on from public.staff_tasks where workflow_step_id = (select id from ids where k = 'pack')) = (now() at time zone 'America/New_York')::date + 15, 'hand-edited task does not move');

-- launch: the launch step appears, with the crew
insert into public.booking_stage_events (booking_id, stage_id, label) select '00000000-0000-0000-0000-00000000bb01', id, label from public.booking_stages where type_key = 'wf_test' and auto = 'gallery_live';
select pg_temp.ok((select due_on from public.staff_tasks where workflow_step_id = (select id from ids where k = 'thanks')) = (now() at time zone 'America/New_York')::date + 14, 'launch + 14 once launched');

-- the job list
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(jsonb_array_length((select j -> 'tasks' from jsonb_array_elements(public.workflow_jobs()) j where j ->> 'booking_id' = '00000000-0000-0000-0000-00000000bb01')) = 3, 'view: sees the job''s three tasks');
reset role;

-- check one off, then cancel: open ones go, the done one stays
insert into public.staff_task_done (task_id, on_date) select id, due_on from public.staff_tasks where workflow_step_id = (select id from ids where k = 'confirm');
update public.bookings set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000bb01';
select pg_temp.ok((select count(*) from public.staff_tasks where booking_id = '00000000-0000-0000-0000-00000000bb01' and active) = 1, 'cancel: only the done task remains');

-- track-only jobs get nothing
insert into public.bookings (id, type_key, title_label, picture_day, status) values ('00000000-0000-0000-0000-00000000bb02', 'wf_test', 'Old', (now() at time zone 'America/New_York')::date + 3, 'tracked');
select pg_temp.ok(not exists (select 1 from public.staff_tasks where booking_id = '00000000-0000-0000-0000-00000000bb02'), 'track-only: no tasks');

-- booked late: a step already due lands on today
insert into public.bookings (id, type_key, title_label, picture_day, status) values ('00000000-0000-0000-0000-00000000bb03', 'wf_test', 'Rush', (now() at time zone 'America/New_York')::date, 'booked');
insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at)
values ('00000000-0000-0000-0000-0000000000b1', 'job', '00000000-0000-0000-0000-00000000bb03', now(), now() + interval '1 hour');
select pg_temp.ok((select due_on from public.staff_tasks where booking_id = '00000000-0000-0000-0000-00000000bb03' and workflow_step_id = (select id from ids where k = 'pack')) = (now() at time zone 'America/New_York')::date, 'booked late: due today');

-- removing a step removes its open tasks
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.workflow_step_archive((select id from ids where k = 'pack'));
reset role;
select pg_temp.ok(not exists (select 1 from public.staff_tasks where workflow_step_id = (select id from ids where k = 'pack') and active and wf_auto), 'archived step: open tasks removed');

do $$ begin raise notice 'ALL WORKFLOW TESTS PASSED'; end $$;
rollback;
