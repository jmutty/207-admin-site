-- Job workflows (module 'workflows', page #jobs/checklists): a checklist per job type whose steps become tasks on
-- people's Assignments when a job is booked (2026-10-22).
--
-- A step is due a number of days before or after one of three moments in the job:
--   booked       the day the booking was made
--   picture_day  the (first) picture day: -7 = a week before, 1 = the day after
--   launch       the day the job reached Job launched (GotPhoto gallery live). These tasks appear at launch.
-- and goes to the job's crew (the first person scheduled on it; the step's fallback person if nobody is yet),
-- or always to one named person.
--
-- workflow_sync(booking) keeps a booking's tasks in step with it. It runs when a booking is made or changed, when
-- someone is put on or taken off the job in Scheduling, and when the job moves stage. A task that has not been
-- checked off follows the job: a new picture day moves its due day, a new crew member takes it over. Once
-- someone edits the task by hand in Assignments it is theirs (wf_auto = false) and only a cancel removes it.
-- Only status 'booked' jobs get tasks: track-only jobs never went through booking, and cancelling removes the
-- open ones. Tasks are plain one-time staff_tasks, so they show on My day, the 8pm push and the morning email.
--
-- View = see the checklists and every job's open tasks. Edit = change the checklists.

update public.app_modules
   set status = 'live', label = 'Job checklists', section = 'Jobs', sort = 25,
       description = 'A checklist per job type that puts tasks on people''s Assignments when a job is booked. View = see checklists and open tasks; Edit = change the checklists.'
 where key = 'workflows';

-- ---------------------------------------------------------------- tables
create table public.workflow_steps (
  id           uuid primary key default gen_random_uuid(),
  type_key     text references public.booking_types (key) on update cascade on delete cascade,  -- null = every job type
  title        text not null check (length(btrim(title)) between 1 and 120),
  notes        text not null default '' check (length(notes) <= 2000),
  anchor       text not null check (anchor in ('booked', 'picture_day', 'launch')),
  offset_days  int  not null default 0 check (offset_days between -365 and 365),
  assign_to    text not null default 'crew' check (assign_to in ('crew', 'person')),
  user_id      uuid references public.team_members (user_id) on delete set null,  -- the person, or crew's fallback
  priority     text not null default 'normal' check (priority in ('normal', 'urgent')),
  sort         int  not null default 100,
  archived_at  timestamptz,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  check (assign_to <> 'person' or user_id is not null or archived_at is not null)
);
comment on table public.workflow_steps is 'Job checklists: steps per job type (null = every type) that become one-time Assignments tasks on each booked job. Archive, never delete.';
create index workflow_steps_type_idx on public.workflow_steps (type_key, sort) where archived_at is null;

alter table public.staff_tasks
  add column booking_id       uuid references public.bookings (id) on delete cascade,
  add column workflow_step_id uuid references public.workflow_steps (id) on delete set null,
  add column wf_auto          boolean not null default false;
comment on column public.staff_tasks.booking_id is 'Set on tasks made from a job checklist: the job it belongs to.';
comment on column public.staff_tasks.wf_auto is 'true = made by workflow_sync and not edited by hand since, so it follows the job (due day, crew).';
create unique index staff_tasks_workflow_uq on public.staff_tasks (booking_id, workflow_step_id) where booking_id is not null and workflow_step_id is not null;
create index staff_tasks_booking_idx on public.staff_tasks (booking_id) where booking_id is not null;

-- A hand edit (assignment_save) takes the task out of the job's control.
create function public.staff_tasks_wf_manual() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.wf_auto and old.wf_auto and coalesce(current_setting('app.wf_sync', true), '') <> 'on'
     and (new.user_id, new.title, new.notes, new.due_on, new.priority, new.active) is distinct from (old.user_id, old.title, old.notes, old.due_on, old.priority, old.active) then
    new.wf_auto := false;
  end if;
  return new;
end $$;
create trigger staff_tasks_wf_manual before update on public.staff_tasks for each row execute function public.staff_tasks_wf_manual();

alter table public.workflow_steps enable row level security;
revoke all on public.workflow_steps from anon, authenticated;
grant select on public.workflow_steps to authenticated;
create policy workflow_steps_read on public.workflow_steps for select to authenticated using ((select public.can('workflows', 'view')));

-- ---------------------------------------------------------------- the engine
-- Who a crew step goes to: the first person scheduled on the job.
create function public.workflow_crew_lead(p_booking uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select e.user_id from public.schedule_entries e join public.team_members m on m.user_id = e.user_id and m.active
   where e.booking_id = p_booking and e.kind = 'job' order by e.starts_at, e.created_at limit 1
$$;

-- Make, move or remove a booking's checklist tasks. Never raises (callers are triggers on the booking itself).
create function public.workflow_sync(p_booking uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings; s public.workflow_steps; t public.staff_tasks;
  v_today date := (now() at time zone 'America/New_York')::date;
  v_lead uuid; v_launch date; v_anchor date; v_due date; v_user uuid; v_title text; n int := 0;
begin
  perform set_config('app.wf_sync', 'on', true);
  select * into b from public.bookings where id = p_booking;
  if b.id is null then return 0; end if;
  if b.status <> 'booked' then
    -- cancelled, done or track-only: open checklist tasks go away (checked-off ones stay as history)
    update public.staff_tasks k set active = false, updated_at = now()
     where k.booking_id = p_booking and k.active
       and not exists (select 1 from public.staff_task_done d where d.task_id = k.id);
    get diagnostics n = row_count;
    perform set_config('app.wf_sync', '', true);
    return n;
  end if;
  v_lead := public.workflow_crew_lead(p_booking);
  v_launch := public.booking_launch_date(p_booking);
  for s in select * from public.workflow_steps w
            where w.archived_at is null and (w.type_key is null or w.type_key = b.type_key) order by w.sort, w.created_at loop
    v_anchor := case s.anchor when 'booked' then (coalesce((to_jsonb(b) ->> 'created_at')::timestamptz, now()) at time zone 'America/New_York')::date
                              when 'picture_day' then b.picture_day
                              else v_launch end;
    select * into t from public.staff_tasks where booking_id = p_booking and workflow_step_id = s.id;
    if v_anchor is null then continue; end if;
    v_due := v_anchor + s.offset_days;
    v_user := case s.assign_to when 'person' then s.user_id else coalesce(v_lead, s.user_id) end;
    if v_user is not null and not exists (select 1 from public.team_members where user_id = v_user and active) then v_user := null; end if;
    v_title := left(s.title || ': ' || coalesce(public.schedule_booking_title(p_booking), 'job'), 160);
    if t.id is null then
      if v_user is null then continue; end if;
      -- a job booked late: a step that was due already lands on today instead of being missed
      insert into public.staff_tasks (user_id, title, notes, repeat, due_on, starts_on, priority, booking_id, workflow_step_id, wf_auto)
      values (v_user, v_title, s.notes, 'once', greatest(v_due, v_today), v_today, s.priority, p_booking, s.id, true);
      n := n + 1;
    elsif t.wf_auto and not exists (select 1 from public.staff_task_done d where d.task_id = t.id) then
      v_due := greatest(v_due, least(t.due_on, v_today));   -- never move an open task into the past
      if (t.due_on, t.user_id, t.title, t.active) is distinct from (v_due, coalesce(v_user, t.user_id), v_title, true) then
        update public.staff_tasks set due_on = v_due, user_id = coalesce(v_user, user_id), title = v_title, active = true,
                                      starts_on = least(starts_on, v_due), updated_at = now()
         where id = t.id;
        n := n + 1;
      end if;
    end if;
  end loop;
  perform set_config('app.wf_sync', '', true);
  return n;
exception when others then
  perform set_config('app.wf_sync', '', true);
  raise warning 'workflow_sync(%): %', p_booking, sqlerrm;
  return 0;
end $$;
revoke all on function public.workflow_crew_lead(uuid), public.workflow_sync(uuid) from public, anon, authenticated;

create function public.workflow_bookings_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or (new.status, new.picture_day, new.type_key, new.org_id, new.title_label, new.title_override)
                          is distinct from (old.status, old.picture_day, old.type_key, old.org_id, old.title_label, old.title_override) then
    perform public.workflow_sync(new.id);
  end if;
  return null;
end $$;
create trigger workflow_bookings_changed after insert or update on public.bookings for each row execute function public.workflow_bookings_changed();

create function public.workflow_crew_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.booking_id is not null then perform public.workflow_sync(old.booking_id); end if;
  if tg_op in ('INSERT', 'UPDATE') and new.booking_id is not null and new.booking_id is distinct from old.booking_id then perform public.workflow_sync(new.booking_id); end if;
  return null;
end $$;
create trigger workflow_crew_changed after insert or update of booking_id, user_id, starts_at or delete on public.schedule_entries
  for each row execute function public.workflow_crew_changed();

create function public.workflow_stage_moved() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.workflow_sync(new.booking_id);
  return null;
end $$;
create trigger workflow_stage_moved after insert on public.booking_stage_events for each row execute function public.workflow_stage_moved();
revoke all on function public.staff_tasks_wf_manual(), public.workflow_bookings_changed(), public.workflow_crew_changed(), public.workflow_stage_moved()
  from public, anon, authenticated;

-- ---------------------------------------------------------------- RPCs
-- The checklists, job types and people to pick from.
create function public.workflow_templates() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('workflows', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'can_edit', public.can('workflows', 'edit'),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'label', t.label) order by t.label), '[]'::jsonb) from public.booking_types t),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', public.staff_name(m.user_id)) order by lower(public.staff_name(m.user_id))), '[]'::jsonb)
                 from public.team_members m where m.active),
    'steps', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'type_key', s.type_key, 'title', s.title, 'notes', s.notes, 'anchor', s.anchor,
                              'offset_days', s.offset_days, 'assign_to', s.assign_to, 'user_id', s.user_id, 'user_name', public.staff_name(s.user_id),
                              'priority', s.priority, 'sort', s.sort)
                              order by s.type_key nulls first, case s.anchor when 'booked' then 0 when 'picture_day' then 1 else 2 end, s.offset_days, s.sort), '[]'::jsonb)
                from public.workflow_steps s where s.archived_at is null));
end $$;

-- Add or change a step. p = {id?, type_key?, title, notes?, anchor, offset_days, assign_to, user_id?, priority?}
-- Booked jobs from today on pick up the change at once.
create function public.workflow_step_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_type text := nullif(p ->> 'type_key', '');
  v_title text := left(btrim(coalesce(p ->> 'title', '')), 120);
  v_anchor text := p ->> 'anchor';
  v_off int := coalesce(nullif(p ->> 'offset_days', '')::int, 0);
  v_to text := coalesce(nullif(p ->> 'assign_to', ''), 'crew');
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_prio text := coalesce(nullif(p ->> 'priority', ''), 'normal');
  r record;
begin
  if not public.can('workflows', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_title = '' then raise exception 'Give the step a name.'; end if;
  if v_type is not null and not exists (select 1 from public.booking_types where key = v_type) then raise exception 'Pick a job type.'; end if;
  if v_anchor is null or v_anchor not in ('booked', 'picture_day', 'launch') then raise exception 'Pick when it is due.'; end if;
  if v_off not between -365 and 365 then raise exception 'Days are -365 to 365.'; end if;
  if v_anchor <> 'picture_day' and v_off < 0 then raise exception 'Only picture day steps can be due before.'; end if;
  if v_to not in ('crew', 'person') then raise exception 'Pick who does it.'; end if;
  if v_to = 'person' and v_user is null then raise exception 'Pick the person.'; end if;
  if v_user is not null and not exists (select 1 from public.team_members where user_id = v_user and active) then raise exception 'Pick someone on the team.'; end if;
  if v_prio not in ('normal', 'urgent') then raise exception 'Priority is normal or urgent.'; end if;
  if v_id is not null then
    update public.workflow_steps set type_key = v_type, title = v_title, notes = left(coalesce(p ->> 'notes', ''), 2000), anchor = v_anchor,
           offset_days = v_off, assign_to = v_to, user_id = v_user, priority = v_prio
     where id = v_id and archived_at is null;
    if not found then raise exception 'That step was removed. Reload the page.'; end if;
    -- open, untouched tasks pick up the new name, notes and priority
    update public.staff_tasks set notes = left(coalesce(p ->> 'notes', ''), 2000), priority = v_prio, updated_at = now()
     where workflow_step_id = v_id and wf_auto and active and not exists (select 1 from public.staff_task_done d where d.task_id = staff_tasks.id);
  else
    insert into public.workflow_steps (type_key, title, notes, anchor, offset_days, assign_to, user_id, priority, sort, created_by)
    values (v_type, v_title, left(coalesce(p ->> 'notes', ''), 2000), v_anchor, v_off, v_to, v_user, v_prio,
            coalesce((select max(sort) + 10 from public.workflow_steps where type_key is not distinct from v_type), 10), (select auth.uid()))
    returning id into v_id;
  end if;
  for r in select b.id from public.bookings b
            where b.status = 'booked' and b.picture_day >= (now() at time zone 'America/New_York')::date
              and (v_type is null or b.type_key = v_type) loop
    perform public.workflow_sync(r.id);
  end loop;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Remove a step: its open, untouched tasks go too.
create function public.workflow_step_archive(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('workflows', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.workflow_steps set archived_at = now() where id = p_id and archived_at is null;
  if not found then return jsonb_build_object('ok', false); end if;
  update public.staff_tasks k set active = false, updated_at = now()
   where k.workflow_step_id = p_id and k.wf_auto and k.active and not exists (select 1 from public.staff_task_done d where d.task_id = k.id);
  return jsonb_build_object('ok', true);
end $$;

-- Every booked job from p_from on with its checklist tasks: who, due, done.
create function public.workflow_jobs(p_from date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('workflows', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  p_from := coalesce(p_from, v_today - 60);
  return (select coalesce(jsonb_agg(j order by (j ->> 'open_count')::int = 0, j ->> 'picture_day'), '[]'::jsonb) from (
    select jsonb_build_object('booking_id', b.id, 'title', public.schedule_booking_title(b.id), 'picture_day', b.picture_day, 'type_key', b.type_key,
             'lead', public.staff_name(public.workflow_crew_lead(b.id)),
             'open_count', count(k.id) filter (where d.task_id is null),
             'overdue_count', count(k.id) filter (where d.task_id is null and k.due_on < v_today),
             'tasks', coalesce(jsonb_agg(jsonb_build_object('task_id', k.id, 'title', coalesce(s.title, k.title), 'due_on', k.due_on, 'user_name', public.staff_name(k.user_id),
                                 'done_at', d.done_at, 'done_by', public.staff_name(d.done_by), 'priority', k.priority, 'manual', not k.wf_auto)
                                 order by k.due_on, s.sort) filter (where k.id is not null), '[]'::jsonb)) j
      from public.bookings b
      join public.staff_tasks k on k.booking_id = b.id and k.active
      left join public.workflow_steps s on s.id = k.workflow_step_id
      left join public.staff_task_done d on d.task_id = k.id and d.on_date = k.due_on
     where b.status = 'booked' and b.picture_day >= p_from
     group by b.id) x (j));
end $$;

-- For the Today line: open checklist tasks that are past due.
create function public.workflow_attention() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.can('workflows', 'view') then jsonb_build_object('overdue',
    (select count(*) from public.staff_tasks k join public.bookings b on b.id = k.booking_id and b.status = 'booked'
      where k.active and k.workflow_step_id is not null and k.due_on < (now() at time zone 'America/New_York')::date
        and not exists (select 1 from public.staff_task_done d where d.task_id = k.id and d.on_date = k.due_on)))
  else '{}'::jsonb end
$$;

revoke all on function public.workflow_templates(), public.workflow_step_save(jsonb), public.workflow_step_archive(uuid),
                       public.workflow_jobs(date), public.workflow_attention() from public, anon;
grant execute on function public.workflow_templates(), public.workflow_step_save(jsonb), public.workflow_step_archive(uuid),
                          public.workflow_jobs(date), public.workflow_attention() to authenticated;

-- ---------------------------------------------------------------- a starting checklist (every job type)
-- Crew steps fall back to nobody until a person is set, so nothing is made for a job with no crew yet.
insert into public.workflow_steps (type_key, title, notes, anchor, offset_days, assign_to, sort) values
  (null, 'Confirm start time and crew with the contact', 'Call or email the contact on the booking.', 'picture_day', -7, 'crew', 10),
  (null, 'Pack the kit and charge batteries', 'Check out the kit in Inventory.', 'picture_day', -1, 'crew', 20),
  (null, 'Upload and back up the photos', '', 'picture_day', 1, 'crew', 30),
  (null, 'Launch the job on GotPhoto', '', 'picture_day', 7, 'crew', 40),
  (null, 'Send the partner a thank-you', '', 'launch', 14, 'crew', 50);

-- Jobs already booked for today or later get their tasks now.
select public.workflow_sync(b.id) from public.bookings b
 where b.status = 'booked' and b.picture_day >= (now() at time zone 'America/New_York')::date;
