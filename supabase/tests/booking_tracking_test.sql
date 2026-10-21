-- Tests for 20261021200000_booking_stages_deliverables (job stages + deliverables). Run against a
-- NON-production copy of the schema after the migration, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/booking_tracking_test.sql
-- Each check RAISEs on failure; "ALL BOOKING TRACKING TESTS PASSED" at the end means every check held.

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

-- e1 = bookings edit; v1 = bookings view; p1 = partners only
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'), ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'p1@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000c1', 'View One', true), ('00000000-0000-0000-0000-0000000000d1', 'Partners One', true);
insert into public.team_permissions values
  ('00000000-0000-0000-0000-0000000000e1', 'bookings', 'edit'), ('00000000-0000-0000-0000-0000000000c1', 'bookings', 'view'), ('00000000-0000-0000-0000-0000000000d1', 'partners', 'view');

insert into public.prospect_orgs (id, name) values ('00000000-0000-0000-0000-0000000000f1', 'Test Org');
-- a sports job whose picture day was yesterday, linked to a gallery that is live
insert into public.synced_jobs (gotphoto_job_id, gp_activated_at) values ('test-job-1', now() - interval '1 hour') on conflict (gotphoto_job_id) do update set gp_activated_at = excluded.gp_activated_at;
insert into public.bookings (id, org_id, type_key, picture_day, start_at, end_at, gotphoto_job_id)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1', 'sports_data', current_date - 1, now() - interval '1 day', now() - interval '23 hours', 'test-job-1');
-- a school job three weeks out
insert into public.bookings (id, org_id, type_key, picture_day, start_at, end_at)
  values ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f1', 'school', current_date + 21, now() + interval '21 days', now() + interval '21 days 3 hours');

-- ---------------------------------------------------------------- setup (as postgres)
select pg_temp.ok((select count(*) from public.booking_types t where not exists (select 1 from public.booking_stages s where s.type_key = t.key)) = 0, 'every job type has stages');
select pg_temp.ok((select count(*) from public.booking_stages where type_key = 'school') = 6, 'school has the six default stages');
select pg_temp.ok((select s.auto from public.booking_progress p join public.booking_stages s on s.id = p.stage_id where p.booking_id = '00000000-0000-0000-0000-0000000000b2') = 'booked', 'a new booking starts at Booked');
select pg_temp.ok(exists (select 1 from cron.job where jobname = 'booking-stages-tick'), 'the tick is scheduled');
insert into public.booking_types (key, label, audience) values ('t_new_type', 'New type', 'sports');
select pg_temp.ok((select count(*) from public.booking_stages where type_key = 't_new_type') = 6, 'a new job type gets the default stages');

select public.booking_stages_tick();
select pg_temp.ok((select s.auto from public.booking_progress p join public.booking_stages s on s.id = p.stage_id where p.booking_id = '00000000-0000-0000-0000-0000000000b1') = 'gallery_live',
                  'tick: picture day passed + gallery live moves the job to Job launched');
select pg_temp.ok((select count(*) from public.booking_stage_events where booking_id = '00000000-0000-0000-0000-0000000000b1' and auto) = 3, 'tick: each automatic step is logged');
select pg_temp.ok((select s.auto from public.booking_progress p join public.booking_stages s on s.id = p.stage_id where p.booking_id = '00000000-0000-0000-0000-0000000000b2') = 'booked', 'tick: a future job stays at Booked');

-- ---------------------------------------------------------------- p1: partners only, sees nothing
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.ok((select count(*) from public.booking_stages) = 0, 'p1: no stages');
select pg_temp.ok((select count(*) from public.admin_booking_progress(null, null)) = 0, 'p1: no progress rows');
select pg_temp.raises($$select public.admin_booking_tracking('00000000-0000-0000-0000-0000000000b1')$$, 'p1: tracking refused');
select pg_temp.ok(public.admin_deliverables_attention() = '{}'::jsonb, 'p1: attention empty');
reset role;

-- ---------------------------------------------------------------- e1: bookings edit
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((select count(*) from public.admin_booking_progress(null, null)) >= 2, 'e1: progress for the list');
select pg_temp.ok(jsonb_array_length(public.admin_booking_tracking('00000000-0000-0000-0000-0000000000b2') -> 'stages') = 6, 'e1: tracking lists the type''s stages');

-- typed deliverables: one saved for the type, one one-off; a saved one picked again is skipped
select pg_temp.ok((public.booking_deliverables_add('00000000-0000-0000-0000-0000000000b2',
  '[{"label":"Yearbook files","save":true,"due_days":14},{"label":"Thank-you card"}]') ->> 'added')::int = 2, 'e1: adds two typed deliverables');
select pg_temp.ok((select count(*) from public.deliverable_templates where type_key = 'school' and label = 'Yearbook files' and due_days = 14) = 1, 'e1: "save" keeps it for school jobs');
select pg_temp.ok((select count(*) from public.deliverable_templates where label = 'Thank-you card') = 0, 'e1: a one-off is not saved');
select pg_temp.ok((select due_date is null and due_days = 14 from public.booking_deliverables where booking_id = '00000000-0000-0000-0000-0000000000b2' and label = 'Yearbook files'), 'e1: not launched yet: no due date, the days are kept');
select pg_temp.ok((public.booking_deliverables_add('00000000-0000-0000-0000-0000000000b2',
  jsonb_build_array(jsonb_build_object('template_id', (select id from public.deliverable_templates where label = 'Yearbook files')))) ->> 'added')::int = 0, 'e1: picking one already on the booking adds nothing');
select pg_temp.ok((select deliverables_total = 2 and deliverables_open = 2 from public.booking_progress where booking_id = '00000000-0000-0000-0000-0000000000b2'), 'e1: summary counts 2 open');
select public.booking_set_stage('00000000-0000-0000-0000-0000000000b2', (select id from public.booking_stages where type_key = 'school' and auto = 'gallery_live'));
select pg_temp.ok((select due_date from public.booking_deliverables where booking_id = '00000000-0000-0000-0000-0000000000b2' and label = 'Yearbook files') = (now() at time zone 'America/New_York')::date + 14, 'e1: launching the job dates it: launch day + due days');
select pg_temp.ok((select due_date from public.booking_deliverables where booking_id = '00000000-0000-0000-0000-0000000000b2' and label = 'Thank-you card') is null, 'e1: one without due days stays undated');
select pg_temp.ok((select next_due from public.booking_progress where booking_id = '00000000-0000-0000-0000-0000000000b2') = (now() at time zone 'America/New_York')::date + 14, 'e1: list summary picks up the new date');
select pg_temp.ok((public.booking_deliverables_add('00000000-0000-0000-0000-0000000000b1', '[{"label":"Banner proofs","due_days":7}]') ->> 'added')::int = 1, 'e1: adds one after launch');
select pg_temp.ok((select due_date from public.booking_deliverables where booking_id = '00000000-0000-0000-0000-0000000000b1' and label = 'Banner proofs') = (now() at time zone 'America/New_York')::date + 7, 'e1: added after launch: dated from the launch day');
select pg_temp.ok((public.booking_deliverables_add('00000000-0000-0000-0000-0000000000b1', '[{"label":"Team poster","due_date":"2027-01-05"}]') ->> 'added')::int = 1, 'e1: adds one with a typed date');
select pg_temp.ok((select due_date = '2027-01-05' and due_days is null from public.booking_deliverables where label = 'Team poster'), 'e1: a date typed by hand wins');

-- the saved one is offered to the next school job, not to sports jobs
select pg_temp.ok(exists (select 1 from jsonb_array_elements(public.admin_booking_tracking('00000000-0000-0000-0000-0000000000b2') -> 'templates') t where t ->> 'label' = 'Yearbook files'), 'e1: offered on school jobs');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.admin_booking_tracking('00000000-0000-0000-0000-0000000000b1') -> 'templates') t where t ->> 'label' = 'Yearbook files'), 'e1: not offered on sports jobs');
select pg_temp.ok((public.booking_deliverables_add('00000000-0000-0000-0000-0000000000b1',
  jsonb_build_array(jsonb_build_object('template_id', (select id from public.deliverable_templates where label = 'Yearbook files')))) ->> 'added')::int = 0, 'e1: a school deliverable cannot be put on a sports job');

-- ticking them off: done + skipped closes the list and moves the job to Deliverables sent
select public.booking_set_stage('00000000-0000-0000-0000-0000000000b2', (select id from public.booking_stages where type_key = 'school' and label = 'In production'), 'started editing');
select pg_temp.ok((select s.label from public.booking_progress p join public.booking_stages s on s.id = p.stage_id where p.booking_id = '00000000-0000-0000-0000-0000000000b2') = 'In production', 'e1: moves a job by hand');
select pg_temp.ok((select by_user from public.booking_stage_events where booking_id = '00000000-0000-0000-0000-0000000000b2' order by id desc limit 1) = '00000000-0000-0000-0000-0000000000e1', 'e1: the move records who');
select public.booking_deliverable_update((select id from public.booking_deliverables where label = 'Yearbook files'), '{"status":"done","link":"dropbox.com/sh/abc"}');
select pg_temp.ok((select done_by = '00000000-0000-0000-0000-0000000000e1' and link = 'https://dropbox.com/sh/abc' from public.booking_deliverables where label = 'Yearbook files'), 'e1: done records who and fixes the link');
select pg_temp.ok((select s.label from public.booking_progress p join public.booking_stages s on s.id = p.stage_id where p.booking_id = '00000000-0000-0000-0000-0000000000b2') = 'In production', 'e1: one still open, stage unchanged');
select public.booking_deliverable_update((select id from public.booking_deliverables where label = 'Thank-you card'), '{"status":"skipped"}');
select pg_temp.ok((select s.auto from public.booking_progress p join public.booking_stages s on s.id = p.stage_id where p.booking_id = '00000000-0000-0000-0000-0000000000b2') = 'deliverables_done', 'e1: last one closed -> Deliverables sent');
select public.booking_deliverable_update((select id from public.booking_deliverables where label = 'Thank-you card'), '{"status":"todo"}');
select pg_temp.ok((select s.auto from public.booking_progress p join public.booking_stages s on s.id = p.stage_id where p.booking_id = '00000000-0000-0000-0000-0000000000b2') = 'deliverables_done', 'e1: reopening one never moves the job back by itself');
select pg_temp.ok((select deliverables_open from public.booking_progress where booking_id = '00000000-0000-0000-0000-0000000000b2') = 1, 'e1: but the summary shows it open again');

-- overdue
select public.booking_deliverable_update((select id from public.booking_deliverables where label = 'Thank-you card'), jsonb_build_object('due_date', current_date - 2));
select pg_temp.ok((public.admin_deliverables_attention() ->> 'overdue')::int = 1, 'e1: overdue count on Today');
select pg_temp.ok((select (x ->> 'overdue')::int from public.admin_booking_progress(null, null) x where x ->> 'booking_id' = '00000000-0000-0000-0000-0000000000b2') = 1, 'e1: overdue on the list row');

-- refusals
select pg_temp.raises($$select public.booking_set_stage('00000000-0000-0000-0000-0000000000b2', 'not-a-uuid')$$, 'e1: junk stage refused');
select pg_temp.ok((public.booking_set_stage('00000000-0000-0000-0000-0000000000b2', (select id from public.booking_stages where type_key = 'sports_data' limit 1)) ->> 'ok')::boolean = false, 'e1: another type''s stage refused');
select pg_temp.raises($$update public.booking_deliverables set status = 'done'$$, 'e1: no direct writes to booking deliverables');
select pg_temp.raises($$insert into public.booking_progress (booking_id) values ('00000000-0000-0000-0000-0000000000b2')$$, 'e1: no direct writes to progress');
with u as (update public.deliverable_templates set auto_add = true where label = 'Yearbook files' returning 1) select pg_temp.ok((select count(*) from u) = 1, 'e1: edits saved deliverables directly');
with u as (update public.booking_stages set label = 'Editing' where type_key = 'school' and label = 'In production' returning 1) select pg_temp.ok((select count(*) from u) = 1, 'e1: renames a stage');
select pg_temp.ok((select label from public.booking_stage_events where booking_id = '00000000-0000-0000-0000-0000000000b2' and note = 'started editing') = 'In production', 'e1: history keeps the old name');
select pg_temp.raises($$delete from public.booking_stages where type_key = 'school'$$, 'e1: stages cannot be deleted (archive instead)');
select pg_temp.ok((public.booking_deliverable_remove((select id from public.booking_deliverables where label = 'Thank-you card')) ->> 'ok')::boolean, 'e1: removes a deliverable');
reset role;

-- ---------------------------------------------------------------- v1: bookings view
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(jsonb_array_length(public.admin_booking_tracking('00000000-0000-0000-0000-0000000000b2') -> 'deliverables') = 1, 'v1: sees the deliverables');
select pg_temp.ok(jsonb_array_length(public.admin_booking_tracking('00000000-0000-0000-0000-0000000000b2') -> 'events') >= 3, 'v1: sees the history');
select pg_temp.raises($$select public.booking_set_stage('00000000-0000-0000-0000-0000000000b2', (select id from public.booking_stages where type_key = 'school' and auto = 'booked'))$$, 'v1: cannot move a job');
select pg_temp.raises($$select public.booking_deliverables_add('00000000-0000-0000-0000-0000000000b2', '[{"label":"x"}]')$$, 'v1: cannot add deliverables');
select pg_temp.raises($$select public.booking_deliverable_update((select id from public.booking_deliverables limit 1), '{"status":"todo"}')$$, 'v1: cannot tick deliverables');
with u as (update public.deliverable_templates set auto_add = false returning 1) select pg_temp.ok((select count(*) from u) = 0, 'v1: cannot edit saved deliverables');
reset role;

-- ---------------------------------------------------------------- signed out
select pg_temp.act(null);
select pg_temp.raises($$select public.admin_booking_progress(null, null)$$, 'anon: no RPCs');
select pg_temp.raises($$select count(*) from public.booking_stages$$, 'anon: no tables');
reset role;

-- ---------------------------------------------------------------- cancelling stops tracking
update public.bookings set status = 'cancelled' where id = '00000000-0000-0000-0000-0000000000b2';
select pg_temp.ok(not public.booking_stage_auto('00000000-0000-0000-0000-0000000000b2', 'picture_day'), 'cancelled jobs do not tick');

do $$ begin raise notice 'ALL BOOKING TRACKING TESTS PASSED'; end $$;

rollback;
