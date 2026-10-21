-- Tests for 20261021220000_booking_track_only (track-only jobs). Run against a NON-production copy of the
-- schema after both booking migrations, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/booking_track_only_test.sql
-- "ALL TRACK-ONLY TESTS PASSED" at the end means every check held.

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

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'), ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com');
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000c1', 'View One', true);
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'bookings', 'edit'), ('00000000-0000-0000-0000-0000000000c1', 'bookings', 'view');

-- orgs: one matched by its GotPhoto name, one by its own name, two that share a name (ambiguous)
insert into public.prospect_orgs (id, name, gotphoto_names) values
  ('00000000-0000-0000-0000-0000000000f1', 'Test Academy', '{"TA Upper School"}'),
  ('00000000-0000-0000-0000-0000000000f2', 'Test Rec & Parks', '{}'),
  ('00000000-0000-0000-0000-0000000000f3', 'Twin Town', '{}'), ('00000000-0000-0000-0000-0000000000f4', 'Twin Town', '{}');
insert into public.synced_jobs (gotphoto_job_id, name, job_type, access_type, status, shoot_at, first_synced_at, gp_activated_at) values
  ('tj-school', 'TA Upper School | School Photos | 2026-2027', 'school_k_12', 'qr_tagging', 'published', now() - interval '10 days', now() - interval '20 days', now() - interval '2 days'),
  ('tj-sport',  'Test Rec and Parks | Fall Sports | 2026', 'sport_other', 'qr_tagging', 'created', now() + interval '5 days', now() - interval '20 days', null),
  ('tj-twin',   'Twin Town | Winter | 2026', 'sport_other', 'qr_tagging', 'created', now() + interval '30 days', now() - interval '20 days', null),
  ('tj-booked', 'Test Academy | Fall Sports | 2026', 'sport_other', 'qr_tagging', 'created', now() + interval '8 days', now() - interval '20 days', null);
-- tj-booked is already a real booking
insert into public.bookings (id, org_id, type_key, picture_day, start_at, end_at, gotphoto_job_id)
  values ('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000f1', 'sports_data', current_date + 8, now() + interval '8 days', now() + interval '8 days 1 hour', 'tj-booked');
select pg_temp.ok((select count(*) from cron.job where jobname = 'booking-auto-track') = 1, 'auto-track sweep is scheduled');
select pg_temp.ok(not (select auto_track from public.booking_tracking_settings), 'auto-track starts off');
select pg_temp.ok(public.booking_auto_track() = 0, 'auto-track off: adds nothing');

-- ---------------------------------------------------------------- e1: bookings edit
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((select count(*) from public.admin_trackable_jobs() x where x ->> 'gotphoto_job_id' like 'tj-%') = 3, 'e1: lists the three jobs not on the screen');
select pg_temp.ok(not exists (select 1 from public.admin_trackable_jobs() x where x ->> 'gotphoto_job_id' = 'tj-booked'), 'e1: a booked job is not offered');
select pg_temp.ok((select x ->> 'org_name' from public.admin_trackable_jobs() x where x ->> 'gotphoto_job_id' = 'tj-school') = 'Test Academy', 'e1: matches the organization by its GotPhoto name');
select pg_temp.ok((select x ->> 'org_name' from public.admin_trackable_jobs() x where x ->> 'gotphoto_job_id' = 'tj-sport') = 'Test Rec & Parks', 'e1: matches the organization by its own name');
select pg_temp.ok((select x -> 'org_id' from public.admin_trackable_jobs() x where x ->> 'gotphoto_job_id' = 'tj-twin') = 'null'::jsonb, 'e1: two organizations with that name: left for you to pick');
select pg_temp.ok((select x ->> 'type_key' from public.admin_trackable_jobs() x where x ->> 'gotphoto_job_id' = 'tj-school') = 'school'
              and (select x ->> 'type_key' from public.admin_trackable_jobs() x where x ->> 'gotphoto_job_id' = 'tj-sport') = 'sports_data', 'e1: suggests the job type');

select pg_temp.ok((public.booking_track_jobs('[{"gotphoto_job_id":"tj-school","org_id":"00000000-0000-0000-0000-0000000000f1","type_key":"school"},
  {"gotphoto_job_id":"tj-sport","org_id":"00000000-0000-0000-0000-0000000000f2","type_key":"sports_data"},
  {"gotphoto_job_id":"tj-school","org_id":"00000000-0000-0000-0000-0000000000f1","type_key":"school"},
  {"org_id":"00000000-0000-0000-0000-0000000000f3","type_key":"sports_nodata","picture_day":"2026-12-01","title_label":"Cheer"}]') ->> 'added')::int = 3,
  'e1: tracks two GotPhoto jobs and one by hand (a repeat is skipped)');
reset role;

-- ---------------------------------------------------------------- nothing goes out
select pg_temp.ok((select count(*) from public.bookings where status = 'tracked') = 3, 'three tracked rows');
select pg_temp.ok((select bool_and(calendar_status = 'deleted' and google_event_id is null and cardinality(contact_ids) = 0 and sequence_id is null and hub_school_id is null)
                     from public.bookings where status = 'tracked'), 'tracked rows: no calendar event, no contacts, no email sequence, no hub row');
select pg_temp.ok(not exists (select 1 from public.booking_emails e join public.bookings b on b.id = e.booking_id where b.status = 'tracked'), 'tracked rows: no emails');
select pg_temp.ok(not exists (select 1 from public.booking_days d join public.bookings b on b.id = d.booking_id where b.status = 'tracked'), 'tracked rows: no calendar days');
select pg_temp.ok((select picture_day from public.bookings where gotphoto_job_id = 'tj-school') = current_date - 10 and (select title_label from public.bookings where gotphoto_job_id = 'tj-school') = 'School Photos',
                  'picture day and title come from the GotPhoto job');

-- ---------------------------------------------------------------- stages work on tracked rows
select pg_temp.ok((select s.auto from public.booking_progress p join public.booking_stages s on s.id = p.stage_id join public.bookings b on b.id = p.booking_id where b.gotphoto_job_id = 'tj-sport') = 'booked', 'a tracked job starts at Booked');
select public.booking_stages_tick();
select pg_temp.ok((select s.auto from public.booking_progress p join public.booking_stages s on s.id = p.stage_id join public.bookings b on b.id = p.booking_id where b.gotphoto_job_id = 'tj-school') = 'gallery_live',
                  'the tick moves a tracked school job to Job launched when its gallery is live');

select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.booking_deliverables_add((select id from public.bookings where gotphoto_job_id = 'tj-school'), '[{"label":"Yearbook files","save":true}]') ->> 'added')::int = 1, 'e1: deliverables on a tracked job');
select pg_temp.ok(not exists (select 1 from public.admin_trackable_jobs() x where x ->> 'gotphoto_job_id' in ('tj-school', 'tj-sport')), 'e1: tracked jobs drop off the picker');
select pg_temp.ok((public.booking_untrack((select id from public.bookings where gotphoto_job_id = 'tj-sport')) ->> 'ok')::boolean, 'e1: stops tracking one');
select pg_temp.ok(not (public.booking_untrack('00000000-0000-0000-0000-0000000000b9') ->> 'ok')::boolean, 'e1: untrack leaves real bookings alone');
select pg_temp.ok(exists (select 1 from public.admin_trackable_jobs() x where x ->> 'gotphoto_job_id' = 'tj-sport'), 'e1: an untracked job is offered again');
select pg_temp.raises($$select public.booking_track_jobs('[{"gotphoto_job_id":"tj-twin","type_key":"sports_data"}]')$$, 'e1: no organization refused');
select public.booking_set_auto_track(true);
reset role;

-- ---------------------------------------------------------------- auto-track: only new jobs, only clear organizations
insert into public.synced_jobs (gotphoto_job_id, name, job_type, access_type, status, shoot_at, first_synced_at) values
  ('tj-new', 'TA Upper School | Spring Sports | 2027', 'sport_mixed_sports', 'qr_tagging', 'created', now() + interval '120 days', now() + interval '1 minute'),
  ('tj-new-twin', 'Twin Town | Spring | 2027', 'sport_other', 'qr_tagging', 'created', now() + interval '120 days', now() + interval '1 minute');
select pg_temp.ok(public.booking_auto_track() = 1, 'auto-track adds the one new job with a clear organization');
select pg_temp.ok((select status from public.bookings where gotphoto_job_id = 'tj-new') = 'tracked', 'auto-tracked job is track-only');
select pg_temp.ok(not exists (select 1 from public.bookings where gotphoto_job_id in ('tj-twin', 'tj-new-twin')), 'auto-track skips jobs from before the switch and unclear organizations');
select pg_temp.ok(not exists (select 1 from public.bookings where gotphoto_job_id = 'tj-sport' and status = 'tracked'), 'auto-track does not re-add a job you stopped tracking');
select pg_temp.ok(public.booking_auto_track() = 0, 'auto-track is idempotent');

-- ---------------------------------------------------------------- v1: bookings view
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((select count(*) from public.admin_trackable_jobs()) >= 1, 'v1: sees the picker list');
select pg_temp.raises($$select public.booking_track_jobs('[]')$$, 'v1: cannot track');
select pg_temp.raises($$select public.booking_set_auto_track(false)$$, 'v1: cannot change auto-track');
select pg_temp.raises($$update public.booking_tracking_settings set auto_track = false$$, 'v1: no direct writes to the setting');
reset role;
select pg_temp.act(null);
select pg_temp.raises($$select public.admin_trackable_jobs()$$, 'anon: no picker');
reset role;

do $$ begin raise notice 'ALL TRACK-ONLY TESTS PASSED'; end $$;

rollback;
