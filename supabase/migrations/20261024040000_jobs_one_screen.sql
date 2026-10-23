-- One job screen, crew reach their job (2026-10-24, ws/jobs).
--
-- 1. job_can_view: someone offered the job on Open jobs (offer still open, not passed on) can open its page
--    too, as well as everyone on its crew (a bar on the Schedule).
-- 2. workflow_job: the crew read the job's checklist on its page (Checklist tab) with job_can_view, not only
--    people with Job checklists. Ticking steps off is unchanged (assignment_check: their own steps).
-- 3. crew_mine (My jobs): whether they leave from home, and their open / late checklist steps on each job.
--    crew_public (the Confirm page): whether they leave from home ("Leave home by").
-- 4. my_day / assignments_day: each job bar and each checklist step carries its booking_id (and the step its
--    job's name) so My day links to the job page and lists "My checklist steps".
-- 5. Moving a job's day moves its crew: when a booking's picture day changes (Edit booking), the job's bars on
--    the Schedule that sat on an old day move by the same number of days to the matching new day, same wall
--    clock times. The bars move at commit (a deferred trigger), after booking_update has rewritten the days, so
--    booking_update itself is not changed. Moving a bar asks the crew to confirm again (crew_entries_changed),
--    and checklist steps follow picture day already (workflow_sync).
--
-- Safe to run twice: patches skip a function that already has them, the rest is create or replace /
-- drop trigger if exists. Same signatures as before. No deletes.

-- ---------------------------------------------------------------- patch helper (skips when already applied)
create or replace function pg_temp.patch_once(p_sig regprocedure, p_marker text, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  if strpos(v_def, p_marker) > 0 then raise notice 'patch %: already applied', p_sig; return; end if;
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

-- ---------------------------------------------------------------- 1. who may open a job
create or replace function public.job_can_view(p_booking uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.can_any(array['bookings', 'scheduling', 'pictureday', 'workflows', 'results'], 'view')
      or (public.admin_session_ok() and (
            exists (select 1 from public.schedule_entries e
                     where e.booking_id = p_booking and e.user_id = (select auth.uid()))
            -- offered on Open jobs and still deciding (jobs-one-screen)
         or exists (select 1 from public.job_offer_recipients r join public.job_offers o on o.id = r.offer_id
                     where o.booking_id = p_booking and r.user_id = (select auth.uid())
                       and o.status = 'open' and r.answer is distinct from 'declined')))
$$;
revoke all on function public.job_can_view(uuid) from public, anon;
grant execute on function public.job_can_view(uuid) to authenticated;

-- ---------------------------------------------------------------- 2. the checklist on the job page, for the crew
select pg_temp.patch_once('public.workflow_job(uuid)'::regprocedure, 'public.job_can_view(p_booking)',
  'if not public\.can\(''workflows'', ''view''\) then raise',
  'if not (public.can(''workflows'', ''view'') or public.job_can_view(p_booking)) then raise', 1);

-- ---------------------------------------------------------------- 3. My jobs and the Confirm page
select pg_temp.patch_once('public.crew_mine()'::regprocedure, '''checklist_open''',
  '''status'', a\.status, ''token'', a\.token\) as x',
  '''status'', a.status, ''token'', a.token, ''from_home'', public.schedule_from_home(v_me),
             ''checklist_open'', (select count(*) from public.staff_tasks k
                                   where k.booking_id = e.booking_id and k.user_id = v_me and k.active and not k.waiting
                                     and not exists (select 1 from public.staff_task_done d where d.task_id = k.id and d.on_date = k.due_on)),
             ''checklist_late'', (select count(*) from public.staff_tasks k
                                   where k.booking_id = e.booking_id and k.user_id = v_me and k.active and not k.waiting
                                     and k.due_on < (now() at time zone ''America/New_York'')::date
                                     and not exists (select 1 from public.staff_task_done d where d.task_id = k.id and d.on_date = k.due_on))) as x', 1);

select pg_temp.patch_once('public.crew_public(text)'::regprocedure, '''from_home''',
  '''cancelled'', b\.status <> ''booked'',',
  '''cancelled'', b.status <> ''booked'', ''from_home'', public.schedule_from_home(a.user_id),', 1);

-- ---------------------------------------------------------------- 4. My day: links to the job
select pg_temp.patch_once('public.my_day(date)'::regprocedure, '''booking_id'', e.booking_id,',
  '''booking_title'', case when e\.booking_id is not null',
  '''booking_id'', e.booking_id, ''booking_title'', case when e.booking_id is not null', 1);

select pg_temp.patch_once('public.assignments_day(date, uuid, boolean)'::regprocedure, '''booking_title'', (select',
  'jsonb_build_object\(''task_id'', i\.task_id,',
  'jsonb_build_object(''task_id'', i.task_id,
                            ''booking_id'', (select k.booking_id from public.staff_tasks k where k.id = i.task_id),
                            ''booking_title'', (select public.schedule_booking_title(k.booking_id) from public.staff_tasks k where k.id = i.task_id and k.booking_id is not null),', 1);

-- ---------------------------------------------------------------- 5. the crew moves with the day
-- Runs at commit for each booking whose picture day changed. A job bar moves when its day is no longer one
-- of the job's days and the same shift lands it on one. Bars on days that stay, or that were moved by hand,
-- stay where they are. A moved bar leaves its trip (batch) since the other jobs of that trip did not move.
create or replace function public.jobs_booking_moved() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_now date; v_delta int; v_days date[];
begin
  begin
    select b.picture_day into v_now from public.bookings b where b.id = new.id and b.status = 'booked';
    if v_now is null or old.picture_day is null then return null; end if;
    v_delta := v_now - old.picture_day;
    if v_delta = 0 then return null; end if;
    select array_agg(distinct x) into v_days from (
      select d.day as x from public.booking_days d where d.booking_id = new.id and d.removed is not true
      union select v_now) q;
    update public.schedule_entries e
       set starts_at = ((e.starts_at at time zone 'America/New_York') + make_interval(days => v_delta)) at time zone 'America/New_York',
           ends_at   = ((e.ends_at   at time zone 'America/New_York') + make_interval(days => v_delta)) at time zone 'America/New_York',
           batch_id = null, updated_at = now()
     where e.booking_id = new.id and e.kind = 'job'
       and not ((e.starts_at at time zone 'America/New_York')::date = any (v_days))
       and ((e.starts_at at time zone 'America/New_York')::date + v_delta) = any (v_days);
  exception when others then raise warning 'jobs_booking_moved: %', sqlerrm;  -- never block a booking change
  end;
  return null;
end $$;
revoke all on function public.jobs_booking_moved() from public, anon, authenticated;

drop trigger if exists jobs_booking_moved on public.bookings;
create constraint trigger jobs_booking_moved after update of picture_day on public.bookings
  deferrable initially deferred for each row
  when (old.picture_day is distinct from new.picture_day)
  execute function public.jobs_booking_moved();
