-- Tests for 20261022234500_checklist_flow_views (waits for, groups, reminder rules, task board, saved views). Run against a
-- NON-production copy of the schema after the migration, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/checklist_flow_test.sql
-- "ALL CHECKLIST FLOW TESTS PASSED" at the end means every check held.

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
create temp table ids (k text primary key, id uuid);
grant all on ids to authenticated;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/New_York')::date $$;
create function pg_temp.task(p_k text, p_booking uuid default '00000000-0000-0000-0000-00000000bb11') returns public.staff_tasks language sql security definer as $$
  select * from public.staff_tasks where booking_id = p_booking and workflow_step_id = (select id from ids where k = p_k) $$;

-- o1 full access; e1 edits checklists + task board; v1 task board view only; n1 nothing; s1 s2 s3 shoot / edit photos
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'o1@example.com'), ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com'),
  ('00000000-0000-0000-0000-0000000000b1', 's1@example.com'), ('00000000-0000-0000-0000-0000000000b2', 's2@example.com'),
  ('00000000-0000-0000-0000-0000000000b3', 's3@example.com');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000e1', 'Ed Edit', true),
  ('00000000-0000-0000-0000-0000000000c1', 'Vi View', true), ('00000000-0000-0000-0000-0000000000d1', 'No Access', true),
  ('00000000-0000-0000-0000-0000000000b1', 'Sam Shooter', true), ('00000000-0000-0000-0000-0000000000b2', 'Ari Editor', true),
  ('00000000-0000-0000-0000-0000000000b3', 'Bo Editor', true);
insert into public.team_permissions (user_id, module_key, level) values
  ('00000000-0000-0000-0000-0000000000e1', 'workflows', 'edit'), ('00000000-0000-0000-0000-0000000000e1', 'taskboard', 'edit'),
  ('00000000-0000-0000-0000-0000000000e1', 'assignments', 'edit'),
  ('00000000-0000-0000-0000-0000000000c1', 'taskboard', 'view'), ('00000000-0000-0000-0000-0000000000c1', 'assignments', 'view'),
  ('00000000-0000-0000-0000-0000000000b1', 'assignments', 'view'), ('00000000-0000-0000-0000-0000000000b1', 'taskboard', 'view'),
  ('00000000-0000-0000-0000-0000000000b2', 'assignments', 'view'), ('00000000-0000-0000-0000-0000000000b2', 'taskboard', 'view'),
  ('00000000-0000-0000-0000-0000000000b3', 'assignments', 'view'), ('00000000-0000-0000-0000-0000000000b3', 'taskboard', 'view');

update public.workflow_steps set archived_at = now();
insert into public.booking_types (key, label) values ('cf_test', 'Test league') on conflict do nothing;
insert into public.prospect_orgs (id, name) values ('00000000-0000-0000-0000-0000000000f1', 'Bangor Rec');
insert into public.prospect_contacts (id, org_id, first_name, last_name, email, is_primary) values
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f1', 'Pat', 'Partner', 'pat@bangorrec.org', true);

-- ---------------------------------------------------------------- module + access
select pg_temp.ok(exists (select 1 from public.app_modules where key = 'taskboard' and status = 'live'), 'taskboard module is registered');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.task_board(current_date, current_date + 7)$$, 'no access: no task board');
select pg_temp.raises($$select public.task_workload()$$, 'no access: no workload');
select pg_temp.raises($$select public.staff_group_save('{"name":"x"}')$$, 'no access: cannot make groups');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.staff_group_save('{"name":"x"}')$$, 'task board view: cannot make groups');
select pg_temp.raises($$select public.task_bulk(array[gen_random_uuid()], '{"due_on":"2030-01-01"}')$$, 'view: cannot move due days');

-- ---------------------------------------------------------------- groups + steps
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
insert into ids select 'editing', (public.staff_group_save('{"name":"Editing team","members":["00000000-0000-0000-0000-0000000000b2","00000000-0000-0000-0000-0000000000b3"]}') ->> 'id')::uuid;
select pg_temp.raises($$select public.staff_group_save('{"name":"editing TEAM"}')$$, 'group names are unique');
select pg_temp.ok(jsonb_array_length((public.workflow_templates() -> 'groups') -> 0 -> 'members') = 2, 'group has two members');

insert into ids select 'upload', (public.workflow_step_save(jsonb_build_object('type_key', 'cf_test', 'title', 'Cards uploaded', 'anchor', 'picture_day', 'offset_days', 1,
  'assign_to', 'crew', 'remind_days', 2, 'late_days', 1, 'late_user_id', '00000000-0000-0000-0000-0000000000e1')) ->> 'id')::uuid;
insert into ids select 'edit', (public.workflow_step_save(jsonb_build_object('type_key', 'cf_test', 'title', 'Edit the photos', 'anchor', 'picture_day', 'offset_days', 3,
  'assign_to', 'group', 'group_id', (select id from ids where k = 'editing'), 'waits_for', (select id from ids where k = 'upload'),
  'partner_email', true, 'partner_subject', 'Proofs posted for {league}', 'partner_body', E'Hi {first_name},\n\nProofs for {job} are up. Picture day was {picture_day}.')) ->> 'id')::uuid;
insert into ids select 'other', (public.workflow_step_save(jsonb_build_object('title', 'Other type step', 'anchor', 'booked', 'assign_to', 'person', 'user_id', '00000000-0000-0000-0000-0000000000e1')) ->> 'id')::uuid;
select pg_temp.raises(format($$select public.workflow_step_save(jsonb_build_object('id', %L, 'type_key', 'cf_test', 'title', 'Cards uploaded', 'anchor', 'picture_day', 'offset_days', 1, 'assign_to', 'crew', 'waits_for', %L))$$,
  (select id from ids where k = 'upload'), (select id from ids where k = 'edit')), 'steps cannot wait for each other');
select pg_temp.raises(format($$select public.workflow_step_save(jsonb_build_object('title', 'x', 'anchor', 'booked', 'assign_to', 'group'))$$), 'a group step needs a group');
select pg_temp.raises($$select public.workflow_step_save(jsonb_build_object('title', 'x', 'anchor', 'booked', 'assign_to', 'crew', 'remind_days', 40))$$, 'reminders are 1-30 days');
reset role;

-- ---------------------------------------------------------------- a booked job: waiting until the step before is done
insert into public.bookings (id, org_id, type_key, title_label, picture_day, status, contact_ids)
values ('00000000-0000-0000-0000-00000000bb11', '00000000-0000-0000-0000-0000000000f1', 'cf_test', 'Spring', pg_temp.today() + 2, 'booked', array['00000000-0000-0000-0000-0000000000f2']::uuid[]);
insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at)
values ('00000000-0000-0000-0000-0000000000b1', 'job', '00000000-0000-0000-0000-00000000bb11', now() + interval '2 days', now() + interval '2 days 2 hours');
select pg_temp.ok((pg_temp.task('upload')).user_id = '00000000-0000-0000-0000-0000000000b1' and not (pg_temp.task('upload')).waiting, 'upload goes to the crew, not waiting');
select pg_temp.ok((pg_temp.task('edit')).waiting, 'edit waits for upload');
select pg_temp.ok((pg_temp.task('edit')).group_id = (select id from ids where k = 'editing'), 'edit is owned by the group');
select pg_temp.ok((pg_temp.task('edit')).user_id in ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3'), 'edit goes to a group member');
-- a waiting task is not due anywhere
select pg_temp.ok(not public.staff_task_due(pg_temp.task('edit'), pg_temp.today() + 5), 'waiting: not due on its day');
select pg_temp.ok(not exists (select 1 from public.staff_task_items(pg_temp.today() + 5, array[(pg_temp.task('edit')).user_id]) i where i.task_id = (pg_temp.task('edit')).id), 'waiting: not on the owner''s list');
select pg_temp.act((select user_id from pg_temp.task('edit')));
select pg_temp.raises(format('select public.assignment_check(%L, %L, true)', (pg_temp.task('edit')).id, (pg_temp.task('edit')).due_on), 'waiting task cannot be checked off');
reset role;

-- the next job's group step goes to the other, less busy editor
insert into public.bookings (id, org_id, type_key, title_label, picture_day, status)
values ('00000000-0000-0000-0000-00000000bb12', '00000000-0000-0000-0000-0000000000f1', 'cf_test', 'Fall', pg_temp.today() + 20, 'booked');
insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at)
values ('00000000-0000-0000-0000-0000000000b1', 'job', '00000000-0000-0000-0000-00000000bb12', now() + interval '20 days', now() + interval '20 days 2 hours');
select pg_temp.ok((pg_temp.task('edit', '00000000-0000-0000-0000-00000000bb12')).user_id <> (pg_temp.task('edit')).user_id, 'group steps go to the least busy member');

-- check off upload: edit is released, due on its own day
select pg_temp.act('00000000-0000-0000-0000-0000000000b1');
select public.assignment_check((pg_temp.task('upload')).id, (pg_temp.task('upload')).due_on, true);
reset role;
select pg_temp.ok(not (pg_temp.task('edit')).waiting, 'checked off: edit is released');
select pg_temp.ok((pg_temp.task('edit')).due_on = pg_temp.today() + 5, 'released: due picture day + 3');
-- un-check: back to waiting
select pg_temp.act('00000000-0000-0000-0000-0000000000b1');
select public.assignment_check((pg_temp.task('upload')).id, (pg_temp.task('upload')).due_on, false);
reset role;
select pg_temp.ok((pg_temp.task('edit')).waiting, 'un-checked: edit waits again');
select pg_temp.act('00000000-0000-0000-0000-0000000000b1');
select public.assignment_check((pg_temp.task('upload')).id, (pg_temp.task('upload')).due_on, true);
reset role;

-- anyone in the group can check it off, not other staff
select pg_temp.act('00000000-0000-0000-0000-0000000000b1');
select pg_temp.raises(format('select public.assignment_check(%L, %L, true)', (pg_temp.task('edit')).id, (pg_temp.task('edit')).due_on), 'outside the group: cannot check it off');
select pg_temp.act((select case when user_id = '00000000-0000-0000-0000-0000000000b2' then '00000000-0000-0000-0000-0000000000b3'::uuid else '00000000-0000-0000-0000-0000000000b2'::uuid end from pg_temp.task('edit')));
select pg_temp.ok((public.task_board(pg_temp.today() - 3, pg_temp.today() + 30) -> 'tasks') @> jsonb_build_array(jsonb_build_object('id', (pg_temp.task('edit')).id)), 'group member sees the group task on the board');
select public.assignment_check((pg_temp.task('edit')).id, (pg_temp.task('edit')).due_on, true);
reset role;
select pg_temp.ok(exists (select 1 from public.staff_task_done where task_id = (pg_temp.task('edit')).id), 'group member checked it off');

-- ---------------------------------------------------------------- partner email on done
select pg_temp.ok((select count(*) from public.wf_emails where kind = 'partner' and booking_id = '00000000-0000-0000-0000-00000000bb11' and status = 'waiting') = 1, 'done: partner email queued');
select pg_temp.ok((select subject from public.wf_emails where kind = 'partner' and booking_id = '00000000-0000-0000-0000-00000000bb11') = 'Proofs posted for Bangor Rec', 'subject filled in');
select pg_temp.ok((select body_text like 'Hi Pat,%Spring%' from public.wf_emails where kind = 'partner' and booking_id = '00000000-0000-0000-0000-00000000bb11'), 'body filled in');
select pg_temp.ok((select to_email from public.wf_emails where kind = 'partner' and booking_id = '00000000-0000-0000-0000-00000000bb11') = 'pat@bangorrec.org', 'to the booking contact');
-- un-check before it goes: cancelled; check again: a new one
delete from public.staff_task_done where task_id = (pg_temp.task('edit')).id;
select pg_temp.ok((select status from public.wf_emails where kind = 'partner' and booking_id = '00000000-0000-0000-0000-00000000bb11') = 'cancelled', 'un-checked: email cancelled');
insert into public.staff_task_done (task_id, on_date) values ((pg_temp.task('edit')).id, (pg_temp.task('edit')).due_on);
-- sending follows the Booking emails switch and quiet hours; test mode goes to the test address
update public.booking_settings set sending_enabled = false;
select public.wf_send_waiting();
select pg_temp.ok((select count(*) from public.wf_emails where kind = 'partner' and status = 'waiting') = 1, 'sending off: waits');
update public.booking_settings set sending_enabled = true, quiet_start = '00:00', quiet_end = '00:00', test_mode = true, test_recipient = 'test@207photo.com';
select public.wf_send_waiting();
select pg_temp.ok((select sent_to from public.wf_emails where kind = 'partner' and status = 'sent') = 'test@207photo.com', 'test mode: to the test address');
select pg_temp.ok((select body ->> 'subject' from net.http_log order by id desc limit 1) like '[TEST] %', 'test mode: [TEST] subject');
-- track-only / cancelled jobs send nothing
update public.wf_emails set status = 'waiting', sent_to = null where kind = 'partner' and status = 'sent';
update public.bookings set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000bb11';
select pg_temp.ok(public.wf_send_waiting() = 0, 'cancelled job: nothing sent');
update public.bookings set status = 'booked' where id = '00000000-0000-0000-0000-00000000bb11';
update public.wf_emails set status = 'cancelled' where kind = 'partner';

-- ---------------------------------------------------------------- reminders
-- "due soon" two days ahead to the owner; once per due day; only 8am-8pm
insert into public.bookings (id, org_id, type_key, title_label, picture_day, status)
values ('00000000-0000-0000-0000-00000000bb13', '00000000-0000-0000-0000-0000000000f1', 'cf_test', 'Summer', pg_temp.today() + 1, 'booked');
insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at)
values ('00000000-0000-0000-0000-0000000000b1', 'job', '00000000-0000-0000-0000-00000000bb13', now() + interval '1 day', now() + interval '1 day 2 hours');
select pg_temp.ok(public.wf_reminders_send((pg_temp.today() + time '03:00') at time zone 'America/New_York') = 0, 'night: no reminders');
select public.wf_reminders_send((pg_temp.today() + time '10:00') at time zone 'America/New_York');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'checklist_due' and target_user = '00000000-0000-0000-0000-0000000000b1' and title like 'Due %: Cards uploaded'), 'due soon: push to the owner');
select pg_temp.ok(not exists (select 1 from public.push_outbox where topic = 'checklist_due' and title like '%Edit the photos%'), 'waiting steps do not remind');
delete from public.push_outbox;
select public.wf_reminders_send((pg_temp.today() + time '10:15') at time zone 'America/New_York');
select pg_temp.ok(not exists (select 1 from public.push_outbox where topic = 'checklist_due'), 'due soon: only once');
-- late by a day: push + email to the manager named on the step
select public.wf_reminders_send((pg_temp.today() + 3 + time '10:00') at time zone 'America/New_York');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'checklist_late' and target_user = '00000000-0000-0000-0000-0000000000e1'), 'late: push to the manager');
select pg_temp.ok(exists (select 1 from public.wf_emails where kind = 'late' and to_email = 'e1@example.com' and booking_id = '00000000-0000-0000-0000-00000000bb13'), 'late: email to the manager');
select pg_temp.ok((select status from public.wf_emails where kind = 'late' and booking_id = '00000000-0000-0000-0000-00000000bb13') = 'sent', 'late email goes out whatever the booking switch says');

-- ---------------------------------------------------------------- task board, bulk, workload
select pg_temp.act('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok(not (public.task_board(pg_temp.today() - 3, pg_temp.today() + 30) ->> 'can_edit')::boolean, 'view: board is read-only');
select pg_temp.ok(not ((public.task_board(pg_temp.today() - 3, pg_temp.today() + 30) -> 'tasks') @> jsonb_build_array(jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000e1'))), 'view: only own and group tasks');
select pg_temp.ok((public.task_bulk(array[(pg_temp.task('upload', '00000000-0000-0000-0000-00000000bb13')).id, (pg_temp.task('edit', '00000000-0000-0000-0000-00000000bb12')).id], '{"done":true}') ->> 'changed')::int = 1, 'view: marks own done, skips others');
select pg_temp.ok(jsonb_array_length(public.task_workload() -> 'rows') = 1, 'view: workload is just me');
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.task_bulk(array[(pg_temp.task('edit', '00000000-0000-0000-0000-00000000bb12')).id], jsonb_build_object('due_on', pg_temp.today() + 30, 'user_id', '00000000-0000-0000-0000-0000000000b3', 'priority', 'urgent'));
reset role;
select pg_temp.ok((pg_temp.task('edit', '00000000-0000-0000-0000-00000000bb12')).due_on = pg_temp.today() + 30, 'bulk: new due day');
select pg_temp.ok((pg_temp.task('edit', '00000000-0000-0000-0000-00000000bb12')).user_id = '00000000-0000-0000-0000-0000000000b3', 'bulk: new owner');
select pg_temp.ok(not (pg_temp.task('edit', '00000000-0000-0000-0000-00000000bb12')).wf_auto, 'bulk: the task is now a hand edit');
select pg_temp.ok((pg_temp.task('edit', '00000000-0000-0000-0000-00000000bb12')).waiting, 'bulk: a hand-edited task still waits');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.task_bulk(array[(pg_temp.task('edit', '00000000-0000-0000-0000-00000000bb12')).id], '{"done":true}') ->> 'skipped')::int = 1, 'bulk: waiting tasks cannot be marked done');
select pg_temp.ok(jsonb_array_length(public.task_workload() -> 'rows') >= 4, 'edit: workload for everyone with Assignments');
select pg_temp.ok(((select r from jsonb_array_elements(public.task_workload() -> 'rows') r where r ->> 'user_id' = '00000000-0000-0000-0000-0000000000b3') ->> 'waiting')::int >= 1, 'workload counts waiting');
-- the job tab
select pg_temp.ok(jsonb_array_length(public.workflow_job('00000000-0000-0000-0000-00000000bb11') -> 'tasks') = 3, 'job tab: all three steps');
reset role;

-- removing the step it waits for releases the waiting one
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.workflow_step_archive((select id from ids where k = 'upload'));
reset role;
select pg_temp.ok(not (pg_temp.task('edit', '00000000-0000-0000-0000-00000000bb12')).waiting, 'step removed: nothing waits for it');
-- removing a group sends its steps back to the crew
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.staff_group_archive((select id from ids where k = 'editing'));
reset role;
select pg_temp.ok((select assign_to from public.workflow_steps where id = (select id from ids where k = 'edit')) = 'crew', 'group removed: step goes to the crew');

-- ---------------------------------------------------------------- saved views
select pg_temp.act('00000000-0000-0000-0000-0000000000b1');
insert into public.saved_views (page, name, config) values ('taskboard', 'My open', '{"who":"me"}');
insert into public.saved_views (page, name, config, shared) values ('taskboard', 'Team late', '{"show":"overdue"}', true);
select pg_temp.raises($$insert into public.saved_views (page, name) values ('bookings', 'x')$$, 'no Bookings access: cannot save a Bookings view');
select pg_temp.raises($$insert into public.saved_views (user_id, page, name) values ('00000000-0000-0000-0000-0000000000b2', 'taskboard', 'x')$$, 'cannot save a view as someone else');
select pg_temp.act('00000000-0000-0000-0000-0000000000b2');
select pg_temp.ok((select count(*) from public.saved_views) = 1, 'others see only shared views');
update public.saved_views set name = 'hacked';
delete from public.saved_views;
select pg_temp.act('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok((select count(*) from public.saved_views where name in ('My open', 'Team late')) = 2, 'others cannot change or delete my views');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.ok((select count(*) from public.saved_views) = 0, 'no task board access: no task board views');
reset role;

do $$ begin raise notice 'ALL CHECKLIST FLOW TESTS PASSED'; end $$;
rollback;
