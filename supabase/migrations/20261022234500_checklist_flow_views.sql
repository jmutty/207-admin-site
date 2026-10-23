-- Checklists that move themselves along, the Task board, and saved views (2026-10-22). Airstudio plan items D and O.
--
-- Job checklist steps (module 'workflows') get:
--   waits_for   another step on the same job. The task is made but stays "waiting", hidden from its owner's
--               lists, until that step is checked off. Un-checking it puts the task back to waiting.
--   a group     "Editing team": the step goes to the group member with the fewest open tasks, and anyone in
--               the group can check it off.
--   reminders   a push to the owner N days before the step is due; a push and email to a manager (or the
--               full-access people) N days after it is late; an email to the job's partner contact when the
--               step is checked off. Only jobs with bookings.status = 'booked' send anything, and partner
--               emails follow the Booking emails settings (switch, quiet hours, test mode, bcc). Email and
--               push only, never SMS.
--
-- Task board (module 'taskboard', page #staff/board): every one-time task as a board (Waiting / To do / Done),
-- a month calendar (drag to move the due day), a workload table per person, and bulk changes (done, due day,
-- owner, priority). View = your own and your groups' tasks; Edit = everyone's, and moving or reassigning them.
-- People who have Assignments get the same level here when this runs.
--
-- Saved views (saved_views): a named filter on a list page (task board, bookings, inventory), private or
-- shared with the team. Organizations keeps its own (prospect_saved_views).

-- ---------------------------------------------------------------- module
insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('taskboard', 'Task board', 'Staff',
        'Every one-time task as a board, a calendar and a workload table per person, with bulk changes. View = your own and your groups'' tasks; Edit = everyone''s.',
        205, 'live', false)
on conflict (key) do update set status = 'live', label = excluded.label, section = excluded.section, description = excluded.description;

insert into public.team_permissions (user_id, module_key, level)
select p.user_id, 'taskboard', p.level from public.team_permissions p where p.module_key = 'assignments'
on conflict do nothing;

insert into public.push_topics (key, label, description, module, sort) values
  ('checklist_due',  'Checklist step coming up', 'A job checklist step of yours is due soon.', 'assignments', 42),
  ('checklist_late', 'Checklist step is late',   'A job checklist step is past due by the number of days its checklist says.', 'workflows', 43)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- groups
create table public.staff_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 60),
  archived_at timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
comment on table public.staff_groups is 'Groups of people ("Editing team") that can own a job checklist step. Archive, never delete.';
create unique index staff_groups_name_uq on public.staff_groups (lower(btrim(name))) where archived_at is null;

create table public.staff_group_members (
  group_id uuid not null references public.staff_groups (id) on delete cascade,
  user_id  uuid not null references public.team_members (user_id) on delete cascade,
  primary key (group_id, user_id)
);
create index staff_group_members_user_idx on public.staff_group_members (user_id);

alter table public.staff_groups enable row level security;
alter table public.staff_group_members enable row level security;
revoke all on public.staff_groups, public.staff_group_members from anon, authenticated;
grant select on public.staff_groups, public.staff_group_members to authenticated;
create policy staff_groups_read on public.staff_groups for select to authenticated
  using ((select public.can_any(array['workflows', 'taskboard'], 'view')));
create policy staff_group_members_read on public.staff_group_members for select to authenticated
  using ((select public.can_any(array['workflows', 'taskboard'], 'view')));

-- ---------------------------------------------------------------- steps: waits for, group, reminder rules
alter table public.workflow_steps
  add column waits_for      uuid references public.workflow_steps (id) on delete set null,
  add column group_id       uuid references public.staff_groups (id) on delete set null,
  add column remind_days    int check (remind_days between 1 and 30),
  add column late_days      int check (late_days between 1 and 30),
  add column late_user_id   uuid references public.team_members (user_id) on delete set null,
  add column partner_email  boolean not null default false,
  add column partner_subject text not null default '' check (length(partner_subject) <= 200),
  add column partner_body   text not null default '' check (length(partner_body) <= 4000);
alter table public.workflow_steps drop constraint workflow_steps_assign_to_check;
alter table public.workflow_steps add constraint workflow_steps_assign_to_check check (assign_to in ('crew', 'person', 'group'));
alter table public.workflow_steps add constraint workflow_steps_group_check check (assign_to <> 'group' or group_id is not null or archived_at is not null);
alter table public.workflow_steps add constraint workflow_steps_waits_self check (waits_for is distinct from id);
comment on column public.workflow_steps.waits_for is 'The step this one waits for on the same job: its task stays waiting (off people''s lists) until that one is checked off.';
comment on column public.workflow_steps.remind_days is 'Push the owner this many days before the step is due (null = no reminder).';
comment on column public.workflow_steps.late_days is 'This many days after the due day, push and email late_user_id (null = the full-access people). Null = no alert.';
comment on column public.workflow_steps.partner_email is 'Email the job''s partner contact when the step is checked off (partner_subject / partner_body; {league} {job} {picture_day} {step} {first_name}).';

alter table public.staff_tasks
  add column waiting  boolean not null default false,
  add column group_id uuid references public.staff_groups (id) on delete set null;
comment on column public.staff_tasks.waiting is 'true = a checklist task whose step waits for another step on the job that is not done yet. Not due anywhere until released.';
comment on column public.staff_tasks.group_id is 'Set when a group owns the task: anyone in it can check it off.';
create index staff_tasks_group_idx on public.staff_tasks (group_id) where group_id is not null and active;
create index staff_tasks_once_due_idx on public.staff_tasks (due_on) where repeat = 'once' and active;

-- A waiting task is not due on any day, so My day, the 8pm push, the morning email and the schedule leave it out.
create or replace function public.staff_task_due(t public.staff_tasks, p_day date) returns boolean
language sql stable set search_path = '' as $$
  select t.active and not coalesce(t.waiting, false) and p_day is not null and (t.repeat = 'once' or p_day >= t.starts_on) and case t.repeat
    when 'once'    then p_day = t.due_on
    when 'daily'   then cardinality(t.weekdays) = 0 or extract(dow from p_day)::smallint = any (t.weekdays)
    when 'weekly'  then extract(dow from p_day)::smallint = any (t.weekdays)
    when 'monthly' then extract(day from p_day)::int = least(t.month_day::int, extract(day from (date_trunc('month', p_day) + interval '1 month - 1 day'))::int)
    else false end
$$;

create or replace function public.staff_task_last_due(t public.staff_tasks, p_day date) returns date
language sql stable set search_path = '' as $$
  select case when t.repeat = 'once' then case when t.active and not coalesce(t.waiting, false) and t.due_on <= p_day then t.due_on end
         else (select max(g::date) from generate_series((p_day - 31)::timestamp, p_day::timestamp, interval '1 day') g
                where public.staff_task_due(t, g::date)) end
$$;

-- Is p_user in the task's group?
create function public.staff_in_group(p_group uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_group is not null and exists (select 1 from public.staff_group_members gm join public.staff_groups g on g.id = gm.group_id and g.archived_at is null
                                          where gm.group_id = p_group and gm.user_id = p_user)
$$;

-- Check a task off (or un-check it). Your own or your group's with View; anyone's with Edit.
create or replace function public.assignment_check(p_task uuid, p_on date, p_done boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.staff_tasks;
begin
  if not public.can_any(array['assignments', 'taskboard'], 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into t from public.staff_tasks where id = p_task;
  if not found then raise exception 'That task was removed.'; end if;
  if t.user_id <> (select auth.uid()) and not public.staff_in_group(t.group_id, (select auth.uid()))
     and not public.can_any(array['assignments', 'taskboard'], 'edit') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if t.waiting then raise exception 'That task is waiting for an earlier step on the job.'; end if;
  if not public.staff_task_due(t, p_on) then raise exception 'That task is not due that day.'; end if;
  if coalesce(p_done, false) then
    insert into public.staff_task_done (task_id, on_date, done_by) values (p_task, p_on, (select auth.uid())) on conflict do nothing;
  else
    delete from public.staff_task_done where task_id = p_task and on_date = p_on;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- the engine
-- Who in a group gets a new task: the member with the fewest open one-time tasks (then by name).
create function public.workflow_group_pick(p_group uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select gm.user_id from public.staff_group_members gm
    join public.staff_groups g on g.id = gm.group_id and g.archived_at is null
    join public.team_members m on m.user_id = gm.user_id and m.active
   where gm.group_id = p_group
   order by (select count(*) from public.staff_tasks k where k.user_id = gm.user_id and k.active and k.repeat = 'once'
               and not exists (select 1 from public.staff_task_done d where d.task_id = k.id)), lower(public.staff_name(gm.user_id))
   limit 1
$$;

-- Is a step on this job still waiting for the step it waits for? Not when that step was removed or does not apply.
create function public.workflow_is_waiting(p_booking uuid, p_step uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workflow_steps s
      join public.workflow_steps w on w.id = s.waits_for and w.archived_at is null
      join public.bookings b on b.id = p_booking and (w.type_key is null or w.type_key = b.type_key)
     where s.id = p_step
       and not exists (select 1 from public.staff_tasks k join public.staff_task_done d on d.task_id = k.id
                        where k.booking_id = p_booking and k.workflow_step_id = w.id))
$$;

-- Make, move or remove a booking's checklist tasks; hold or release the ones that wait. Never raises.
create or replace function public.workflow_sync(p_booking uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings; s public.workflow_steps; t public.staff_tasks;
  v_today date := (now() at time zone 'America/New_York')::date;
  v_lead uuid; v_launch date; v_anchor date; v_due date; v_user uuid; v_title text; v_wait boolean; n int := 0;
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
    v_wait := public.workflow_is_waiting(p_booking, s.id);
    if v_wait then v_due := greatest(v_due, v_today); end if;   -- when it is released it is due today at the earliest
    v_user := case s.assign_to when 'person' then s.user_id
                               when 'group' then case when t.id is not null and public.staff_in_group(s.group_id, t.user_id) then t.user_id
                                                      else public.workflow_group_pick(s.group_id) end
                               else coalesce(v_lead, s.user_id) end;
    if v_user is not null and not exists (select 1 from public.team_members where user_id = v_user and active) then v_user := null; end if;
    v_title := left(s.title || ': ' || coalesce(public.schedule_booking_title(p_booking), 'job'), 160);
    if t.id is null then
      if v_user is null then continue; end if;
      -- a job booked late: a step that was due already lands on today instead of being missed
      insert into public.staff_tasks (user_id, title, notes, repeat, due_on, starts_on, priority, booking_id, workflow_step_id, wf_auto, waiting, group_id)
      values (v_user, v_title, s.notes, 'once', greatest(v_due, v_today), v_today, s.priority, p_booking, s.id, true, v_wait,
              case when s.assign_to = 'group' then s.group_id end);
      n := n + 1;
    elsif not exists (select 1 from public.staff_task_done d where d.task_id = t.id) then
      if t.wf_auto then
        v_due := greatest(v_due, least(t.due_on, v_today));   -- never move an open task into the past
        if (t.due_on, t.user_id, t.title, t.active, t.waiting, t.group_id)
           is distinct from (v_due, coalesce(v_user, t.user_id), v_title, true, v_wait, case when s.assign_to = 'group' then s.group_id end) then
          update public.staff_tasks set due_on = v_due, user_id = coalesce(v_user, user_id), title = v_title, active = true, waiting = v_wait,
                                        group_id = case when s.assign_to = 'group' then s.group_id end,
                                        starts_on = least(starts_on, v_due), updated_at = now()
           where id = t.id;
          n := n + 1;
        end if;
      elsif t.active and t.waiting is distinct from v_wait then
        -- edited by hand: the person and due day are theirs, but it still waits for the step before it
        update public.staff_tasks set waiting = v_wait, due_on = case when v_wait then due_on else greatest(due_on, v_today) end,
                                      starts_on = least(starts_on, greatest(due_on, v_today)), updated_at = now()
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

-- ---------------------------------------------------------------- emails (partner on done, manager when late)
create table public.wf_emails (
  id         bigint generated always as identity primary key,
  task_id    uuid references public.staff_tasks (id) on delete set null,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  kind       text not null check (kind in ('partner', 'late')),
  to_email   text not null,
  to_name    text not null default '',
  subject    text not null,
  body_text  text not null,
  body_html  text not null,
  status     text not null default 'waiting' check (status in ('waiting', 'sent', 'failed', 'cancelled')),
  test_mode  boolean not null default false,
  sent_to    text,
  request_id bigint,
  checked    boolean not null default false,
  error      text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
comment on table public.wf_emails is 'Job checklist emails: to the partner contact when a step is checked off, and to a manager when a step is late. Sent by wf_send_waiting.';
create index wf_emails_waiting_idx on public.wf_emails (id) where status = 'waiting';
create index wf_emails_booking_idx on public.wf_emails (booking_id);
alter table public.wf_emails enable row level security;
revoke all on public.wf_emails from anon, authenticated;
grant select on public.wf_emails to authenticated;
create policy wf_emails_read on public.wf_emails for select to authenticated using ((select public.can('workflows', 'view')));

create table public.wf_reminder_log (
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  kind    text not null check (kind in ('due', 'late')),
  due_on  date not null,              -- the due day it was about, so moving the task re-arms it
  sent_at timestamptz not null default now(),
  primary key (task_id, kind, due_on)
);
comment on table public.wf_reminder_log is 'Which checklist reminders went out, once per task, kind and due day.';
alter table public.wf_reminder_log enable row level security;
revoke all on public.wf_reminder_log from anon, authenticated;

-- {league} {job} {picture_day} {step} {first_name} filled in.
create function public.wf_fill(p text, p_booking uuid, p_step text, p_first text) returns text
language sql stable security definer set search_path = '' as $$
  select replace(replace(replace(replace(replace(coalesce(p, ''),
           '{league}', coalesce(o.name, '')), '{job}', coalesce(public.schedule_booking_title(b.id), '')),
           '{picture_day}', coalesce(to_char(b.picture_day, 'FMDay, FMMonth FMDD'), '')), '{step}', coalesce(p_step, '')),
           '{first_name}', coalesce(nullif(p_first, ''), 'there'))
    from public.bookings b left join public.prospect_orgs o on o.id = b.org_id where b.id = p_booking
$$;

-- Queue the partner email for a step that was just checked off (booked jobs, steps that have it on).
create function public.wf_queue_partner(p_task uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare k public.staff_tasks; s public.workflow_steps; b public.bookings; c jsonb; v_first text; v_sig text; v_subj text; v_body text;
begin
  select * into k from public.staff_tasks where id = p_task;
  select * into s from public.workflow_steps where id = k.workflow_step_id;
  select * into b from public.bookings where id = k.booking_id;
  if s.id is null or b.id is null or not s.partner_email or b.status <> 'booked' then return; end if;
  if exists (select 1 from public.wf_emails e where e.task_id = p_task and e.kind = 'partner' and e.status in ('waiting', 'sent')) then return; end if;
  c := public.partner_contacts(b.org_id, b.contact_ids) -> 0;
  if c is null or not public.pd_email_ok(c ->> 'email') then return; end if;
  v_first := split_part(btrim(coalesce(c ->> 'name', '')), ' ', 1);
  if position('@' in v_first) > 0 then v_first := ''; end if;
  select signature into v_sig from public.booking_settings;
  v_sig := coalesce(nullif(v_sig, ''), 'The 207 Photo Team');
  v_subj := left(public.wf_fill(coalesce(nullif(btrim(s.partner_subject), ''), '{step}: {job}'), b.id, s.title, v_first), 200);
  v_body := public.wf_fill(coalesce(nullif(btrim(s.partner_body), ''), E'Hi {first_name},\n\nA quick update on {job}: {step} is done.'), b.id, s.title, v_first);
  insert into public.wf_emails (task_id, booking_id, kind, to_email, to_name, subject, body_text, body_html)
  values (p_task, b.id, 'partner', lower(btrim(c ->> 'email')), coalesce(c ->> 'name', ''), v_subj, v_body || E'\n\n' || v_sig,
          '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f1e1b;max-width:540px">' ||
          (select string_agg('<p style="margin:0 0 12px">' || replace(public.html_esc(x), E'\n', '<br>') || '</p>', '' order by i)
             from unnest(regexp_split_to_array(v_body, E'\\n\\s*\\n')) with ordinality t(x, i)) ||
          '<p style="margin:18px 0 0">' || replace(public.html_esc(v_sig), E'\n', '<br>') || '</p></div>');
end $$;

-- Checking a checklist step off (or un-checking it): release or hold the steps that wait for it, and queue or
-- take back the partner email. Never blocks the check-off.
create function public.wf_task_done_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_task uuid := coalesce(new.task_id, old.task_id); v_booking uuid;
begin
  select booking_id into v_booking from public.staff_tasks where id = v_task and workflow_step_id is not null;
  if v_booking is null then return null; end if;
  begin
    perform public.workflow_sync(v_booking);
    if tg_op = 'INSERT' then
      perform public.wf_queue_partner(v_task);
    else
      update public.wf_emails set status = 'cancelled', error = 'step un-checked before it went out'
       where task_id = v_task and kind = 'partner' and status = 'waiting';
    end if;
  exception when others then raise warning 'wf_task_done_changed(%): %', v_task, sqlerrm;
  end;
  return null;
end $$;
create trigger wf_task_done_changed after insert or delete on public.staff_task_done for each row execute function public.wf_task_done_changed();

-- Cron, every 15 minutes, 8am to 8pm Eastern: "due soon" pushes to owners, "late" pushes and emails to managers.
-- Booked jobs only; waiting and checked-off steps never remind.
create function public.wf_reminders_send(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := p_now at time zone 'America/New_York';
  v_today date := (p_now at time zone 'America/New_York')::date;
  r record; m record; n int := 0; v_when text; v_late int; v_link text := 'https://admin.207photo.com/#staff/board';
begin
  if extract(hour from v_now) < 8 or extract(hour from v_now) >= 20 then return 0; end if;
  for r in select k.id, k.user_id, k.due_on, s.title as step, s.remind_days, s.late_days, s.late_user_id, k.booking_id,
                  public.schedule_booking_title(k.booking_id) as job
             from public.staff_tasks k
             join public.workflow_steps s on s.id = k.workflow_step_id
             join public.bookings b on b.id = k.booking_id and b.status = 'booked'
            where k.active and not k.waiting and k.repeat = 'once'
              and (s.remind_days is not null or s.late_days is not null)
              and not exists (select 1 from public.staff_task_done d where d.task_id = k.id) loop
    -- due soon, to the owner
    if r.remind_days is not null and r.due_on >= v_today and r.due_on - r.remind_days <= v_today
       and not exists (select 1 from public.wf_reminder_log l where l.task_id = r.id and l.kind = 'due' and l.due_on = r.due_on) then
      insert into public.wf_reminder_log (task_id, kind, due_on) values (r.id, 'due', r.due_on);
      v_when := case r.due_on - v_today when 0 then 'today' when 1 then 'tomorrow' else to_char(r.due_on, 'FMDay') end;
      perform public.push_notify('checklist_due', 'Due ' || v_when || ': ' || r.step, coalesce(r.job, ''), '/#staff/myday', 'wf_due_' || r.id, r.user_id);
      n := n + 1;
    end if;
    -- late, to the manager (or the full-access people): push and email
    if r.late_days is not null and r.due_on + r.late_days <= v_today
       and not exists (select 1 from public.wf_reminder_log l where l.task_id = r.id and l.kind = 'late' and l.due_on = r.due_on) then
      insert into public.wf_reminder_log (task_id, kind, due_on) values (r.id, 'late', r.due_on);
      v_late := v_today - r.due_on;
      for m in select u.id as user_id, u.email from auth.users u
                where (r.late_user_id is not null and u.id = r.late_user_id
                       and exists (select 1 from public.team_members t where t.user_id = u.id and t.active))
                   or (r.late_user_id is null and u.id in (select a.user_id from public.admin_users a)) loop
        perform public.push_notify('checklist_late', 'Late ' || v_late || (case when v_late = 1 then ' day: ' else ' days: ' end) || r.step,
                                   coalesce(r.job, '') || ' · ' || coalesce(public.staff_name(r.user_id), 'nobody'), '/#staff/board', 'wf_late_' || r.id, m.user_id);
        if public.pd_email_ok(m.email) then
          insert into public.wf_emails (task_id, booking_id, kind, to_email, to_name, subject, body_text, body_html)
          values (r.id, r.booking_id, 'late', lower(m.email), coalesce(public.staff_name(m.user_id), ''),
                  left('Late: ' || r.step || ' (' || coalesce(r.job, 'job') || ')', 200),
                  r.step || ' for ' || coalesce(r.job, 'a job') || ' was due ' || to_char(r.due_on, 'FMDay, FMMonth FMDD') || ' and is not checked off yet. It is ' ||
                    coalesce(public.staff_name(r.user_id), 'nobody') || E'''s.\n\nTask board: ' || v_link,
                  public.pd_email_html(array['<b>' || public.html_esc(r.step) || '</b> for ' || public.html_esc(coalesce(r.job, 'a job')) || ' was due ' ||
                                               public.html_esc(to_char(r.due_on, 'FMDay, FMMonth FMDD')) || ' and is not checked off yet.',
                                             'It is ' || public.html_esc(coalesce(public.staff_name(r.user_id), 'nobody')) || '&#39;s.'],
                                       'Open the task board', v_link, '{}', '207 Admin'));
        end if;
      end loop;
      n := n + 1;
    end if;
  end loop;
  if n > 0 then perform public.wf_send_waiting(); end if;
  return n;
end $$;

-- Sends waiting checklist emails, then reads Resend's answers to earlier ones. Partner emails follow
-- booking_settings (Booking emails switch, quiet hours, test mode, bcc, bounced/unsubscribed). Emails to
-- staff go from alerts@ whatever the booking switch says, like the morning email. Booked jobs only.
create function public.wf_send_waiting() returns int
language plpgsql security definer set search_path = '' as $$
declare s public.booking_settings; v_key text; v_local time; v_quiet boolean; v_partner_ok boolean; r record; v_to text; v_from text; v_req bigint; n int := 0;
begin
  update public.wf_emails e set checked = true,
         status = case when h.status_code between 200 and 299 then e.status else 'failed' end,
         error = case when h.status_code between 200 and 299 then e.error
                      else left(coalesce(nullif(h.error_msg, ''), 'HTTP ' || h.status_code || ': ' || coalesce(h.content, '')), 300) end
    from net._http_response h
   where e.status = 'sent' and not e.checked and e.request_id = h.id;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_key is null then return 0; end if;
  select * into s from public.booking_settings;
  v_local := (now() at time zone 'America/New_York')::time;
  v_quiet := (s.quiet_start > s.quiet_end and (v_local >= s.quiet_start or v_local < s.quiet_end))
          or (s.quiet_start <= s.quiet_end and v_local >= s.quiet_start and v_local < s.quiet_end);
  v_partner_ok := coalesce(s.sending_enabled, false) and not coalesce(v_quiet, false) and (not s.test_mode or public.pd_email_ok(s.test_recipient));
  v_from := case when lower(s.from_email) like '%@207photo.com' then coalesce(nullif(s.from_name, ''), '207 Photo') || ' <' || s.from_email || '>'
                 else '207 Photo <alerts@207photo.com>' end;

  for r in select e.* from public.wf_emails e join public.bookings b on b.id = e.booking_id
            where e.status = 'waiting' and b.status = 'booked' and (e.kind = 'late' or v_partner_ok)
            order by e.id limit 50
            for update of e skip locked loop
    if r.kind = 'partner' then
      if r.task_id is null or not exists (select 1 from public.staff_task_done d where d.task_id = r.task_id) then
        update public.wf_emails set status = 'cancelled', error = 'step no longer checked off' where id = r.id; continue;
      end if;
      if not s.test_mode and exists (select 1 from public.prospect_contacts pc where lower(btrim(pc.email)) = r.to_email
                                       and (pc.bounced_at is not null or pc.unsubscribed_at is not null)) then
        update public.wf_emails set status = 'failed', error = 'this address bounced or unsubscribed' where id = r.id; continue;
      end if;
      v_to := case when s.test_mode then s.test_recipient else r.to_email end;
      select net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_strip_nulls(jsonb_build_object(
          'from', v_from, 'to', jsonb_build_array(v_to),
          'bcc', case when not s.test_mode and public.pd_email_ok(s.bcc) then jsonb_build_array(s.bcc) end,
          'reply_to', coalesce(nullif(btrim(s.reply_to), ''), s.from_email),
          'subject', case when s.test_mode then '[TEST] ' else '' end || r.subject,
          'text', r.body_text, 'html', r.body_html)),
        timeout_milliseconds := 10000) into v_req;
      update public.wf_emails set status = 'sent', sent_at = now(), request_id = v_req, test_mode = s.test_mode, sent_to = v_to, error = null where id = r.id;
    else
      if r.task_id is null or exists (select 1 from public.staff_task_done d where d.task_id = r.task_id) then
        update public.wf_emails set status = 'cancelled', error = 'done before the alert went out' where id = r.id; continue;
      end if;
      select net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', '207 Admin <alerts@207photo.com>', 'to', jsonb_build_array(r.to_email),
                                   'subject', r.subject, 'text', r.body_text, 'html', r.body_html),
        timeout_milliseconds := 10000) into v_req;
      update public.wf_emails set status = 'sent', sent_at = now(), request_id = v_req, sent_to = r.to_email, error = null where id = r.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

select cron.schedule('wf-reminders', '*/15 * * * *', 'select public.wf_reminders_send()');
select cron.schedule('wf-email-send', '*/5 * * * *', 'select public.wf_send_waiting()');

revoke all on function public.staff_in_group(uuid, uuid), public.workflow_group_pick(uuid), public.workflow_is_waiting(uuid, uuid),
                       public.wf_fill(text, uuid, text, text), public.wf_queue_partner(uuid), public.wf_task_done_changed(),
                       public.wf_reminders_send(timestamptz), public.wf_send_waiting() from public, anon, authenticated;

-- ---------------------------------------------------------------- checklist RPCs (replacing the 20261022180000 ones)
create or replace function public.workflow_templates() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('workflows', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'can_edit', public.can('workflows', 'edit'),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'label', t.label) order by t.label), '[]'::jsonb) from public.booking_types t),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', public.staff_name(m.user_id)) order by lower(public.staff_name(m.user_id))), '[]'::jsonb)
                 from public.team_members m where m.active),
    'groups', public.staff_groups_json(),
    'steps', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'type_key', s.type_key, 'title', s.title, 'notes', s.notes, 'anchor', s.anchor,
                              'offset_days', s.offset_days, 'assign_to', s.assign_to, 'user_id', s.user_id, 'user_name', public.staff_name(s.user_id),
                              'group_id', s.group_id, 'group_name', (select g.name from public.staff_groups g where g.id = s.group_id),
                              'priority', s.priority, 'sort', s.sort, 'waits_for', s.waits_for,
                              'waits_for_title', (select w.title from public.workflow_steps w where w.id = s.waits_for and w.archived_at is null),
                              'remind_days', s.remind_days, 'late_days', s.late_days, 'late_user_id', s.late_user_id, 'late_user_name', public.staff_name(s.late_user_id),
                              'partner_email', s.partner_email, 'partner_subject', s.partner_subject, 'partner_body', s.partner_body)
                              order by s.type_key nulls first, case s.anchor when 'booked' then 0 when 'picture_day' then 1 else 2 end, s.offset_days, s.sort), '[]'::jsonb)
                from public.workflow_steps s where s.archived_at is null));
end $$;

-- p = {id?, type_key?, title, notes?, anchor, offset_days, assign_to (crew | person | group), user_id?, group_id?, priority?,
--      waits_for?, remind_days?, late_days?, late_user_id?, partner_email?, partner_subject?, partner_body?}
create or replace function public.workflow_step_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_type text := nullif(p ->> 'type_key', '');
  v_title text := left(btrim(coalesce(p ->> 'title', '')), 120);
  v_anchor text := p ->> 'anchor';
  v_off int := coalesce(nullif(p ->> 'offset_days', '')::int, 0);
  v_to text := coalesce(nullif(p ->> 'assign_to', ''), 'crew');
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_group uuid := nullif(p ->> 'group_id', '')::uuid;
  v_prio text := coalesce(nullif(p ->> 'priority', ''), 'normal');
  v_waits uuid := nullif(p ->> 'waits_for', '')::uuid;
  v_remind int := nullif(p ->> 'remind_days', '')::int;
  v_late int := nullif(p ->> 'late_days', '')::int;
  v_late_user uuid := nullif(p ->> 'late_user_id', '')::uuid;
  v_partner boolean := coalesce((p ->> 'partner_email')::boolean, false);
  w public.workflow_steps; v_chain uuid; v_hops int := 0;
  r record;
begin
  if not public.can('workflows', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_title = '' then raise exception 'Give the step a name.'; end if;
  if v_type is not null and not exists (select 1 from public.booking_types where key = v_type) then raise exception 'Pick a job type.'; end if;
  if v_anchor is null or v_anchor not in ('booked', 'picture_day', 'launch') then raise exception 'Pick when it is due.'; end if;
  if v_off not between -365 and 365 then raise exception 'Days are -365 to 365.'; end if;
  if v_anchor <> 'picture_day' and v_off < 0 then raise exception 'Only picture day steps can be due before.'; end if;
  if v_to not in ('crew', 'person', 'group') then raise exception 'Pick who does it.'; end if;
  if v_to = 'person' and v_user is null then raise exception 'Pick the person.'; end if;
  if v_to = 'group' and (v_group is null or not exists (select 1 from public.staff_groups where id = v_group and archived_at is null)) then raise exception 'Pick the group.'; end if;
  if v_to <> 'group' then v_group := null; end if;
  if v_to = 'group' then v_user := null; end if;
  if v_user is not null and not exists (select 1 from public.team_members where user_id = v_user and active) then raise exception 'Pick someone on the team.'; end if;
  if v_prio not in ('normal', 'urgent') then raise exception 'Priority is normal or urgent.'; end if;
  if v_remind is not null and v_remind not between 1 and 30 then raise exception 'Remind 1 to 30 days before.'; end if;
  if v_late is not null and v_late not between 1 and 30 then raise exception 'Late alerts are 1 to 30 days after.'; end if;
  if v_late is null then v_late_user := null; end if;
  if v_late_user is not null and not exists (select 1 from public.team_members where user_id = v_late_user and active) then raise exception 'Pick someone on the team to tell.'; end if;
  if v_waits is not null then
    select * into w from public.workflow_steps where id = v_waits and archived_at is null;
    if w.id is null then raise exception 'The step it waits for was removed. Reload the page.'; end if;
    if w.id = v_id then raise exception 'A step cannot wait for itself.'; end if;
    if w.type_key is not null and w.type_key is distinct from v_type then raise exception 'It can only wait for a step on the same job type (or every job type).'; end if;
    -- no loops: walk up from the step it waits for
    v_chain := w.waits_for;
    while v_chain is not null and v_hops < 50 loop
      if v_chain = v_id then raise exception 'That would make the steps wait for each other.'; end if;
      select waits_for into v_chain from public.workflow_steps where id = v_chain;
      v_hops := v_hops + 1;
    end loop;
  end if;
  if v_id is not null then
    update public.workflow_steps set type_key = v_type, title = v_title, notes = left(coalesce(p ->> 'notes', ''), 2000), anchor = v_anchor,
           offset_days = v_off, assign_to = v_to, user_id = v_user, group_id = v_group, priority = v_prio, waits_for = v_waits,
           remind_days = v_remind, late_days = v_late, late_user_id = v_late_user, partner_email = v_partner,
           partner_subject = left(coalesce(p ->> 'partner_subject', ''), 200), partner_body = left(coalesce(p ->> 'partner_body', ''), 4000)
     where id = v_id and archived_at is null;
    if not found then raise exception 'That step was removed. Reload the page.'; end if;
    -- a step on one job type can no longer be waited for by steps of other types
    update public.workflow_steps set waits_for = null where waits_for = v_id and v_type is not null and type_key is distinct from v_type;
    update public.staff_tasks set notes = left(coalesce(p ->> 'notes', ''), 2000), priority = v_prio, updated_at = now()
     where workflow_step_id = v_id and wf_auto and active and not exists (select 1 from public.staff_task_done d where d.task_id = staff_tasks.id);
  else
    insert into public.workflow_steps (type_key, title, notes, anchor, offset_days, assign_to, user_id, group_id, priority, waits_for,
                                       remind_days, late_days, late_user_id, partner_email, partner_subject, partner_body, sort, created_by)
    values (v_type, v_title, left(coalesce(p ->> 'notes', ''), 2000), v_anchor, v_off, v_to, v_user, v_group, v_prio, v_waits,
            v_remind, v_late, v_late_user, v_partner, left(coalesce(p ->> 'partner_subject', ''), 200), left(coalesce(p ->> 'partner_body', ''), 4000),
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

-- Removing a step: steps that waited for it stop waiting.
create or replace function public.workflow_step_archive(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if not public.can('workflows', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.workflow_steps set archived_at = now() where id = p_id and archived_at is null;
  if not found then return jsonb_build_object('ok', false); end if;
  update public.staff_tasks k set active = false, updated_at = now()
   where k.workflow_step_id = p_id and k.wf_auto and k.active and not exists (select 1 from public.staff_task_done d where d.task_id = k.id);
  update public.workflow_steps set waits_for = null where waits_for = p_id;
  for r in select distinct k.booking_id from public.staff_tasks k join public.bookings b on b.id = k.booking_id and b.status = 'booked'
            where k.waiting and k.active loop
    perform public.workflow_sync(r.booking_id);
  end loop;
  return jsonb_build_object('ok', true);
end $$;

-- Every booked job from p_from on with its checklist tasks: who, due, done, waiting.
create or replace function public.workflow_jobs(p_from date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('workflows', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  p_from := coalesce(p_from, v_today - 60);
  return (select coalesce(jsonb_agg(j order by (j ->> 'open_count')::int = 0, j ->> 'picture_day'), '[]'::jsonb) from (
    select jsonb_build_object('booking_id', b.id, 'title', public.schedule_booking_title(b.id), 'picture_day', b.picture_day, 'type_key', b.type_key,
             'lead', public.staff_name(public.workflow_crew_lead(b.id)),
             'open_count', count(k.id) filter (where d.task_id is null),
             'overdue_count', count(k.id) filter (where d.task_id is null and not k.waiting and k.due_on < v_today),
             'tasks', public.workflow_job_tasks_json(b.id)) j
      from public.bookings b
      join public.staff_tasks k on k.booking_id = b.id and k.active
      left join public.staff_task_done d on d.task_id = k.id and d.on_date = k.due_on
     where b.status = 'booked' and b.picture_day >= p_from
     group by b.id) x (j));
end $$;

-- One job's checklist tasks (the job page tab and the Jobs list).
create function public.workflow_job_tasks_json(p_booking uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('task_id', k.id, 'title', coalesce(s.title, k.title), 'due_on', k.due_on, 'user_id', k.user_id,
                              'user_name', public.staff_name(k.user_id), 'group_name', (select g.name from public.staff_groups g where g.id = k.group_id),
                              'done_at', d.done_at, 'done_by', public.staff_name(d.done_by), 'priority', k.priority, 'manual', not k.wf_auto,
                              'waiting', k.waiting, 'waits_for', (select w.title from public.workflow_steps w where w.id = s.waits_for))
                              order by k.due_on, s.sort), '[]'::jsonb)
    from public.staff_tasks k
    left join public.workflow_steps s on s.id = k.workflow_step_id
    left join public.staff_task_done d on d.task_id = k.id and d.on_date = k.due_on
   where k.booking_id = p_booking and k.active
$$;

create function public.workflow_job(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('workflows', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('booking_id', p_booking, 'status', (select status from public.bookings where id = p_booking),
    'can_check', public.can_any(array['assignments', 'taskboard'], 'edit'), 'me', (select auth.uid()),
    'tasks', public.workflow_job_tasks_json(p_booking),
    'emails', (select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'to', e.to_email, 'subject', e.subject, 'status', e.status, 'error', e.error,
                                                         'test_mode', e.test_mode, 'at', coalesce(e.sent_at, e.created_at)) order by e.id desc), '[]'::jsonb)
                 from public.wf_emails e where e.booking_id = p_booking and e.kind = 'partner'));
end $$;

create or replace function public.workflow_attention() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when public.can('workflows', 'view') then jsonb_build_object('overdue',
    (select count(*) from public.staff_tasks k join public.bookings b on b.id = k.booking_id and b.status = 'booked'
      where k.active and not k.waiting and k.workflow_step_id is not null and k.due_on < (now() at time zone 'America/New_York')::date
        and not exists (select 1 from public.staff_task_done d where d.task_id = k.id and d.on_date = k.due_on)))
  else '{}'::jsonb end
$$;

-- ---------------------------------------------------------------- group RPCs
create function public.staff_groups_json() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name,
           'members', (select coalesce(jsonb_agg(jsonb_build_object('user_id', gm.user_id, 'name', public.staff_name(gm.user_id))
                                                 order by lower(public.staff_name(gm.user_id))), '[]'::jsonb)
                         from public.staff_group_members gm join public.team_members m on m.user_id = gm.user_id and m.active where gm.group_id = g.id),
           'steps', (select count(*) from public.workflow_steps s where s.group_id = g.id and s.archived_at is null))
         order by lower(g.name)), '[]'::jsonb)
    from public.staff_groups g where g.archived_at is null
$$;

-- p = {id?, name, members: [user_id, ...]}
create function public.staff_group_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid; v_name text := left(btrim(coalesce(p ->> 'name', '')), 60); v_members uuid[];
begin
  if not public.can('workflows', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_name = '' then raise exception 'Give the group a name.'; end if;
  select coalesce(array_agg(distinct x::uuid), '{}') into v_members
    from jsonb_array_elements_text(case when jsonb_typeof(p -> 'members') = 'array' then p -> 'members' else '[]'::jsonb end) x;
  if exists (select 1 from unnest(v_members) u where not exists (select 1 from public.team_members m where m.user_id = u and m.active)) then
    raise exception 'Pick people on the team.';
  end if;
  if exists (select 1 from public.staff_groups g where lower(btrim(g.name)) = lower(v_name) and g.archived_at is null and g.id is distinct from v_id) then
    raise exception 'There is already a group called %.', v_name;
  end if;
  if v_id is null then
    insert into public.staff_groups (name, created_by) values (v_name, (select auth.uid())) returning id into v_id;
  else
    update public.staff_groups set name = v_name where id = v_id and archived_at is null;
    if not found then raise exception 'That group was removed. Reload the page.'; end if;
  end if;
  delete from public.staff_group_members where group_id = v_id and user_id <> all (v_members);
  insert into public.staff_group_members (group_id, user_id) select v_id, u from unnest(v_members) u on conflict do nothing;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Removing a group: its steps go back to the crew, and open tasks keep their person.
create function public.staff_group_archive(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('workflows', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.staff_groups set archived_at = now() where id = p_id and archived_at is null;
  if not found then return jsonb_build_object('ok', false); end if;
  update public.workflow_steps set assign_to = 'crew', group_id = null where group_id = p_id;
  update public.staff_tasks set group_id = null where group_id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- task board RPCs (module 'taskboard')
-- One-time tasks due between p_from and p_to, plus older ones still open, and recurring tasks' days in the range
-- (for the calendar). Edit: everyone's (or p_user's); View: your own and your groups'.
create function public.task_board(p_from date, p_to date, p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid()); v_all boolean; v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('taskboard', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Pick the days.'; end if;
  if p_to - p_from > 62 then p_to := p_from + 62; end if;
  v_all := public.can('taskboard', 'edit');
  return jsonb_build_object(
    'can_edit', v_all, 'me', v_me, 'today', v_today,
    'people', case when v_all then (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', public.staff_name(m.user_id))
                                                              order by lower(public.staff_name(m.user_id))), '[]'::jsonb) from public.team_members m where m.active)
                   else jsonb_build_array(jsonb_build_object('user_id', v_me, 'name', public.staff_name(v_me))) end,
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by lower(g.name)), '[]'::jsonb)
                 from public.staff_groups g where g.archived_at is null),
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'user_id', k.user_id, 'user_name', public.staff_name(k.user_id), 'title', k.title,
                                'notes', k.notes, 'due_on', k.due_on, 'priority', k.priority, 'waiting', k.waiting, 'done_at', d.done_at,
                                'booking_id', k.booking_id, 'group_id', k.group_id, 'group_name', g.name, 'checklist', k.workflow_step_id is not null,
                                'waits_for', (select w.title from public.workflow_steps s join public.workflow_steps w on w.id = s.waits_for where s.id = k.workflow_step_id))
                                order by k.due_on, k.priority = 'urgent' desc, lower(k.title)), '[]'::jsonb)
                from public.staff_tasks k
                left join public.staff_task_done d on d.task_id = k.id and d.on_date = k.due_on
                left join public.staff_groups g on g.id = k.group_id
                left join public.bookings b on b.id = k.booking_id
               where k.active and k.repeat = 'once' and (b.id is null or b.status = 'booked')
                 and (k.due_on between p_from and p_to or (k.due_on < p_from and d.task_id is null))
                 and (case when v_all then p_user is null or k.user_id = p_user
                           else k.user_id = v_me or public.staff_in_group(k.group_id, v_me) end)),
    'repeating', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'user_id', k.user_id, 'user_name', public.staff_name(k.user_id), 'title', k.title,
                                    'day', g::date, 'priority', k.priority,
                                    'done', exists (select 1 from public.staff_task_done d where d.task_id = k.id and d.on_date = g::date))
                                    order by g, lower(k.title)), '[]'::jsonb)
                    from public.staff_tasks k cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
                   where k.active and k.repeat <> 'once' and public.staff_task_due(k, g::date)
                     and (case when v_all then p_user is null or k.user_id = p_user else k.user_id = v_me end)));
end $$;

-- Change several tasks at once. p = {done?: true | false, due_on?, user_id?, priority?}
-- Marking done: your own and your groups' with View, anyone's with Edit. Everything else needs Edit.
-- A due day or person changed this way takes a checklist task out of the job's control, like any hand edit.
create function public.task_bulk(p_ids uuid[], p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid()); v_edit boolean;
  v_done boolean := (p ->> 'done')::boolean;
  v_due date := nullif(p ->> 'due_on', '')::date;
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_prio text := nullif(p ->> 'priority', '');
  t public.staff_tasks; v_changed int := 0; v_skipped int := 0; v_notes text[] := '{}';
begin
  if not public.can('taskboard', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  v_edit := public.can('taskboard', 'edit');
  if (v_due is not null or v_user is not null or v_prio is not null) and not v_edit then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_done is null and v_due is null and v_user is null and v_prio is null then raise exception 'Pick what to change.'; end if;
  if cardinality(coalesce(p_ids, '{}')) > 500 then raise exception 'Pick 500 tasks or fewer.'; end if;
  if v_user is not null and not exists (select 1 from public.team_members where user_id = v_user and active) then raise exception 'Pick someone on the team.'; end if;
  if v_prio is not null and v_prio not in ('normal', 'urgent') then raise exception 'Priority is normal or urgent.'; end if;
  if v_due is not null and v_due < (now() at time zone 'America/New_York')::date - 365 then raise exception 'Pick a later day.'; end if;
  for t in select * from public.staff_tasks where id = any (p_ids) and active and repeat = 'once' order by due_on for update loop
    if not v_edit and t.user_id <> v_me and not public.staff_in_group(t.group_id, v_me) then v_skipped := v_skipped + 1; continue; end if;
    if v_due is not null or v_user is not null or v_prio is not null then
      if exists (select 1 from public.staff_task_done d where d.task_id = t.id) and (v_due is not null) then
        v_skipped := v_skipped + 1; v_notes := v_notes || 'done tasks keep their day'::text; continue;
      end if;
      update public.staff_tasks set due_on = coalesce(v_due, due_on), starts_on = least(starts_on, coalesce(v_due, due_on)),
                                    user_id = coalesce(v_user, user_id), priority = coalesce(v_prio, priority), updated_at = now()
       where id = t.id;
      select * into t from public.staff_tasks where id = t.id;
    end if;
    if v_done is not null then
      if t.waiting then v_skipped := v_skipped + 1; v_notes := v_notes || 'waiting tasks wait for the step before'::text; continue; end if;
      if v_done then
        insert into public.staff_task_done (task_id, on_date, done_by) values (t.id, t.due_on, v_me) on conflict do nothing;
      else
        delete from public.staff_task_done where task_id = t.id;
      end if;
    end if;
    v_changed := v_changed + 1;
  end loop;
  return jsonb_build_object('ok', true, 'changed', v_changed, 'skipped', v_skipped,
                            'why', (select string_agg(distinct x, '; ') from unnest(v_notes) x));
end $$;

-- Per person for the week starting p_week (a Sunday): due this week, done this week, overdue now, waiting, open later.
-- Edit: everyone; View: yourself.
create function public.task_workload(p_week date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid()); v_today date := (now() at time zone 'America/New_York')::date; v_end date;
begin
  if not public.can('taskboard', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  p_week := coalesce(p_week, v_today - extract(dow from v_today)::int);
  v_end := p_week + 6;
  return jsonb_build_object('week', p_week, 'today', v_today, 'rows', (
    select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', public.staff_name(m.user_id),
             'groups', (select coalesce(jsonb_agg(g.name order by lower(g.name)), '[]'::jsonb) from public.staff_group_members gm
                          join public.staff_groups g on g.id = gm.group_id and g.archived_at is null where gm.user_id = m.user_id),
             'due_week', (select count(*) from public.staff_tasks k cross join generate_series(p_week::timestamp, v_end::timestamp, interval '1 day') g
                           where k.user_id = m.user_id and public.staff_task_due(k, g::date)),
             'done_week', (select count(*) from public.staff_task_done d join public.staff_tasks k on k.id = d.task_id
                            where k.user_id = m.user_id and d.on_date between p_week and v_end),
             'overdue', (select count(*) from public.staff_task_items(v_today, array[m.user_id]) i where i.overdue and i.done_at is null),
             'waiting', (select count(*) from public.staff_tasks k where k.user_id = m.user_id and k.active and k.waiting),
             'later', (select count(*) from public.staff_tasks k where k.user_id = m.user_id and k.active and not k.waiting and k.repeat = 'once' and k.due_on > v_end
                         and not exists (select 1 from public.staff_task_done d where d.task_id = k.id)))
           order by lower(public.staff_name(m.user_id))), '[]'::jsonb)
      from public.team_members m
     where m.active and (m.user_id = v_me or public.can('taskboard', 'edit'))
       and public.team_user_can(m.user_id, 'assignments')));
end $$;

revoke all on function public.workflow_job_tasks_json(uuid), public.staff_groups_json() from public, anon, authenticated;
revoke all on function public.workflow_job(uuid), public.staff_group_save(jsonb), public.staff_group_archive(uuid),
                       public.task_board(date, date, uuid), public.task_bulk(uuid[], jsonb), public.task_workload(date) from public, anon;
grant execute on function public.workflow_job(uuid), public.staff_group_save(jsonb), public.staff_group_archive(uuid),
                          public.task_board(date, date, uuid), public.task_bulk(uuid[], jsonb), public.task_workload(date) to authenticated;

-- ---------------------------------------------------------------- saved views
create table public.saved_views (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  page       text not null check (page in ('taskboard', 'bookings', 'inventory')),
  name       text not null check (length(btrim(name)) between 1 and 60),
  config     jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and length(config::text) <= 4000),
  shared     boolean not null default false,
  sort       int not null default 100,
  created_at timestamptz not null default now()
);
comment on table public.saved_views is 'Named filters on a list page (task board, bookings, inventory). Private, or shared with everyone who can see that page.';
create unique index saved_views_name_uq on public.saved_views (user_id, page, lower(btrim(name)));
create index saved_views_page_idx on public.saved_views (page);

-- The module behind each page.
create function public.saved_view_module(p_page text) returns text language sql immutable set search_path = '' as $$
  select case p_page when 'taskboard' then 'taskboard' when 'bookings' then 'bookings' when 'inventory' then 'inventory' end $$;

alter table public.saved_views enable row level security;
revoke all on public.saved_views from anon, authenticated;
grant select, insert, update, delete on public.saved_views to authenticated;
create policy saved_views_read on public.saved_views for select to authenticated
  using ((user_id = (select auth.uid()) or shared) and public.can(public.saved_view_module(page), 'view'));
create policy saved_views_write on public.saved_views for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_team_member()))
  with check (user_id = (select auth.uid()) and public.can(public.saved_view_module(page), 'view'));
grant execute on function public.saved_view_module(text) to authenticated;

-- ---------------------------------------------------------------- existing tasks
-- Booked jobs from today on pick up waiting and groups now (no step waits for anything yet, so nothing changes).
select public.workflow_sync(b.id) from public.bookings b
 where b.status = 'booked' and b.picture_day >= (now() at time zone 'America/New_York')::date;
