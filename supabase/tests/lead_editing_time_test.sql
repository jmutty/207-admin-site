-- Tests for 20261025040000_lead_editing_time (editing time for the Lead). Run against a NON-production copy of the
-- schema after the migration, inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/lead_editing_time_test.sql
-- "ALL LEAD EDITING TESTS PASSED" at the end means every check held.

begin;

create function pg_temp.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok  %', p_what;
end $$;

-- the length rule: first hour 1:1, then 30 min an hour, up to the next 15 min
select pg_temp.ok(public.edit_minutes(120) = 90, '2 h shoot = 1.5 h editing');
select pg_temp.ok(public.edit_minutes(180) = 120, '3 h shoot = 2 h');
select pg_temp.ok(public.edit_minutes(270) = 165, '4.5 h shoot = 2 h 45');
select pg_temp.ok(public.edit_minutes(45) = 45 and public.edit_minutes(50) = 60 and public.edit_minutes(5) = 15, 'short shoots, rounded up to 15 min');

-- l1 is the Lead, s1 shoots second, k1 takes over. b1 booked, far ahead on a quiet day.
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000e7', 'Lead One', true),
  ('00000000-0000-0000-0000-0000000000e8', 'Second One', true), ('00000000-0000-0000-0000-0000000000e9', 'Takes Over', true)
  on conflict (user_id) do update set active = true;
insert into public.bookings (id, title_label, status) values ('00000000-0000-0000-0000-00000000eb01', 'Edit Test Lacrosse', 'booked');
create temp table ids as select
  (select id from public.crew_roles where lower(label) = 'lead') as lead,
  (select id from public.crew_roles where lower(label) <> 'lead' order by sort limit 1) as other;

-- shoot 2-4pm, teardown 30, drive home 60: home 5:30pm, editing 5:30-7:00pm, due 4pm next day
insert into public.schedule_entries (id, user_id, kind, booking_id, starts_at, ends_at, setup_min, teardown_min, drive_before_min, drive_after_min, role_id)
values ('00000000-0000-0000-0000-00000000ee01', '00000000-0000-0000-0000-0000000000e7', 'job', '00000000-0000-0000-0000-00000000eb01',
        '2027-03-03 14:00-05', '2027-03-03 16:00-05', 30, 30, 60, 60, (select lead from ids)),
       ('00000000-0000-0000-0000-00000000ee02', '00000000-0000-0000-0000-0000000000e8', 'job', '00000000-0000-0000-0000-00000000eb01',
        '2027-03-03 14:00-05', '2027-03-03 16:00-05', 30, 30, 60, 60, (select other from ids));
create temp view ed as select e.* from public.schedule_entries e where e.edit_for = '00000000-0000-0000-0000-00000000ee01';
select pg_temp.ok((select count(*) from public.schedule_entries where edit_for = '00000000-0000-0000-0000-00000000ee02') = 0, 'only the Lead gets editing time');
select pg_temp.ok((select kind = 'flex' and user_id = '00000000-0000-0000-0000-0000000000e7' and title = 'Editing: Edit Test Lacrosse' from ed), 'a Flex bar for the Lead, named for the job');
select pg_temp.ok((select starts_at = '2027-03-03 17:30-05' and ends_at = '2027-03-03 19:00-05' from ed), 'right after they get home');
select pg_temp.ok((select edit_due = '2027-03-04 16:00-05' and not edit_moved from ed), 'due 24 hours after the shoot');

-- a late shoot: no room before 9pm, so 8am the next morning
update public.schedule_entries set starts_at = '2027-03-03 17:00-05', ends_at = '2027-03-03 19:00-05' where id = '00000000-0000-0000-0000-00000000ee01';
select pg_temp.ok((select starts_at = '2027-03-04 08:00-05' from ed), 'late shoot: next morning at 8');

-- something at 8am the next day: after it, still before it's due
insert into public.schedule_entries (user_id, kind, starts_at, ends_at, title)
values ('00000000-0000-0000-0000-0000000000e7', 'studio', '2027-03-04 08:00-05', '2027-03-04 09:10-05', 'Studio');
update public.schedule_entries set teardown_min = 45 where id = '00000000-0000-0000-0000-00000000ee01';
select pg_temp.ok((select starts_at = '2027-03-04 09:15-05' and ends_at = '2027-03-04 10:45-05' from ed), 'next morning goes around other bars');

-- they move it themselves: it stays put, only its length follows the job
update public.schedule_entries set starts_at = '2027-03-04 13:00-05', ends_at = '2027-03-04 14:30-05' where edit_for = '00000000-0000-0000-0000-00000000ee01';
select pg_temp.ok((select edit_moved from ed), 'moving it marks it as theirs');
update public.schedule_entries set ends_at = '2027-03-03 20:00-05' where id = '00000000-0000-0000-0000-00000000ee01';  -- 3 h shoot
select pg_temp.ok((select starts_at = '2027-03-04 13:00-05' and ends_at = '2027-03-04 15:00-05' and edit_due = '2027-03-04 20:00-05' from ed), 'moved bar stays, length and due follow the job');

-- someone else takes the bar: placed again for them
update public.schedule_entries set user_id = '00000000-0000-0000-0000-0000000000e9' where id = '00000000-0000-0000-0000-00000000ee01';
select pg_temp.ok((select user_id = '00000000-0000-0000-0000-0000000000e9' and not edit_moved and starts_at = '2027-03-04 08:00-05' from ed), 'follows the new person');

-- the Lead role moves to the second shooter: editing moves with it
update public.schedule_entries set role_id = (select other from ids) where id = '00000000-0000-0000-0000-00000000ee01';
update public.schedule_entries set role_id = (select lead from ids) where id = '00000000-0000-0000-0000-00000000ee02';
select pg_temp.ok(not exists (select 1 from ed), 'not Lead any more: gone');
select pg_temp.ok((select user_id = '00000000-0000-0000-0000-0000000000e8' and starts_at = '2027-03-03 17:30-05'
                     from public.schedule_entries where edit_for = '00000000-0000-0000-0000-00000000ee02'), 'new Lead gets it');

-- cancelled: gone; booked again: back
update public.bookings set status = 'cancelled' where id = '00000000-0000-0000-0000-00000000eb01';
select pg_temp.ok(not exists (select 1 from public.schedule_entries where edit_for = '00000000-0000-0000-0000-00000000ee02'), 'cancelled job: gone');
update public.bookings set status = 'booked', title_override = 'Edit Test Lax' where id = '00000000-0000-0000-0000-00000000eb01';
select pg_temp.ok((select title = 'Editing: Edit Test Lax' from public.schedule_entries where edit_for = '00000000-0000-0000-0000-00000000ee02'), 'booked again: back, with the new name');

-- an Editor picked for the job: the editing time goes on their schedule, timed from when the Lead gets home
select public.job_editor_set('00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-0000000000e9');
create temp view ed2 as select e.* from public.schedule_entries e where e.edit_for = '00000000-0000-0000-0000-00000000ee02';
select pg_temp.ok((select user_id = '00000000-0000-0000-0000-0000000000e9' and starts_at = '2027-03-04 08:00-05' from ed2), 'Editor gets it, around their own day (busy that evening)');
select pg_temp.ok((select (j -> 'booking' ->> 'editor_name') = 'Takes Over' and jsonb_array_length(j -> 'editor_options') >= 3 from public.job_get('00000000-0000-0000-0000-00000000eb01') j), 'job page shows the Editor and who can be picked');
select public.job_editor_set('00000000-0000-0000-0000-00000000eb01', null);
select pg_temp.ok((select user_id = '00000000-0000-0000-0000-0000000000e8' and starts_at = '2027-03-03 17:30-05' from ed2), 'no Editor: back to the Lead');

-- job bar removed: editing goes with it; past jobs get nothing new
delete from public.schedule_entries where id = '00000000-0000-0000-0000-00000000ee02';
select pg_temp.ok(not exists (select 1 from public.schedule_entries where edit_for = '00000000-0000-0000-0000-00000000ee02'), 'job bar removed: gone');
insert into public.schedule_entries (id, user_id, kind, booking_id, starts_at, ends_at, role_id)
values ('00000000-0000-0000-0000-00000000ee03', '00000000-0000-0000-0000-0000000000e7', 'job', '00000000-0000-0000-0000-00000000eb01',
        now() - interval '3 days', now() - interval '3 days' + interval '2 hours', (select lead from ids));
select pg_temp.ok(not exists (select 1 from public.schedule_entries where edit_for = '00000000-0000-0000-0000-00000000ee03'), 'past job: no editing bar');

-- Week data carries the due time
select pg_temp.ok(position('edit_due' in pg_get_functiondef('public.schedule_week(date,integer)'::regprocedure)) > 0, 'schedule_week sends edit_due');

do $$ begin raise notice 'ALL LEAD EDITING TESTS PASSED'; end $$;
rollback;
