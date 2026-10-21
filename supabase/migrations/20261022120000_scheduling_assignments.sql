-- Scheduling + Assignments (2026-10-22).
--
-- Scheduling (module 'scheduling', page #staff/schedule): a bar scheduler. One row per person, weeks start on
-- Sunday, every booking of the week across the top. A bar is a schedule_entries row:
--   job   a person on a booking, with drive time before and after (drawn in its own color)
--   work  any other block of time (studio, editing, a shift)
--   off   time off
-- View = see the whole team's week. Edit = add, move and remove bars.
--
-- Assignments (module 'assignments', page #staff/myday): tasks per person that repeat daily (on chosen
-- weekdays), weekly (on one weekday), monthly (on a day of the month) or once. Each day a task is due it can
-- be checked off. A missed task carries over as overdue until it is done or its next due day comes around
-- (then that one takes its place, so nothing piles up). Priority: urgent tasks go to the top of the list;
-- normal ones that were missed just show as overdue. View = see and check off your own; Edit = assign tasks
-- to anyone and see everyone's day.
--
-- Each evening (8pm Eastern by default) people with Assignments get a "Tomorrow" push: their jobs (with
-- when to leave), other bars and tasks. Nothing is sent for a day with nothing on it. Set the hour before
-- noon and it covers the same day instead.
--
-- Drive time: the `drive-time` edge function asks Google Maps (Routes API) for the drive from the studio
-- address to the job and caches it in drive_time_cache; the minutes stay editable on each bar.
--
-- Team page: team_members.weekly_hours = default hours per week; the scheduler shows scheduled vs that.
-- Everything goes through the RPCs below; the new tables are not readable directly.

-- ---------------------------------------------------------------- modules
update public.app_modules
   set status = 'live', label = 'Scheduling',
       description = 'The week''s bar schedule: who works which job, drive time, other shifts and time off. View = see the team''s week; Edit = change it.'
 where key = 'scheduling';
insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('assignments', 'Assignments', 'Staff', 'Daily, weekly and monthly tasks per person, plus the morning "Your day" notification. View = your own tasks; Edit = assign tasks to anyone.', 205, 'live', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- default weekly hours
alter table public.team_members add column weekly_hours numeric(4,1)
  check (weekly_hours is null or (weekly_hours >= 0 and weekly_hours <= 80));
comment on column public.team_members.weekly_hours is 'Default hours to schedule this person per week (a target the scheduler compares against). Null = not set.';

-- ---------------------------------------------------------------- tables
create table public.schedule_entries (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.team_members (user_id) on delete cascade,
  kind             text not null check (kind in ('job', 'work', 'off')),
  booking_id       uuid references public.bookings (id) on delete cascade,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  drive_before_min int not null default 0 check (drive_before_min between 0 and 600),
  drive_after_min  int not null default 0 check (drive_after_min between 0 and 600),
  title            text not null default '' check (length(title) <= 120),
  note             text not null default '' check (length(note) <= 1000),
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((kind = 'job') = (booking_id is not null)),
  check (kind = 'job' or (drive_before_min = 0 and drive_after_min = 0))
);
comment on table public.schedule_entries is 'Bars on the schedule. job = a person on a booking (plus drive time before/after); work = any other time; off = time off. Written only by schedule_save / schedule_remove.';
create index schedule_entries_starts_idx on public.schedule_entries (starts_at);
create index schedule_entries_user_idx on public.schedule_entries (user_id, starts_at);
create index schedule_entries_booking_idx on public.schedule_entries (booking_id) where booking_id is not null;

create table public.staff_tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.team_members (user_id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 160),
  notes       text not null default '' check (length(notes) <= 2000),
  repeat      text not null check (repeat in ('once', 'daily', 'weekly', 'monthly')),
  weekdays    smallint[] not null default '{}',   -- 0 = Sunday ... 6 = Saturday. daily: the days it repeats on ({} = every day); weekly: its one day
  month_day   smallint check (month_day between 1 and 31), -- monthly; in a shorter month it falls on the last day
  due_on      date,                                -- once
  starts_on   date not null default ((now() at time zone 'America/New_York')::date),
  est_minutes int check (est_minutes between 1 and 1440),
  priority    text not null default 'normal' check (priority in ('normal', 'urgent')),
  active      boolean not null default true,       -- false = removed (kept so past check-offs keep their name)
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]),
  check (repeat <> 'once' or due_on is not null),
  check (repeat <> 'weekly' or cardinality(weekdays) = 1),
  check (repeat <> 'monthly' or month_day is not null)
);
comment on table public.staff_tasks is 'Assignments: a task for one person that repeats daily / weekly / monthly or happens once.';
create index staff_tasks_user_idx on public.staff_tasks (user_id) where active;

create table public.staff_task_done (
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  on_date date not null,                 -- the due day this check-off is for
  done_by uuid references auth.users (id) on delete set null,
  done_at timestamptz not null default now(),
  primary key (task_id, on_date)
);
comment on table public.staff_task_done is 'One row per task per due day that was checked off.';

create table public.staff_settings (
  id            boolean primary key default true check (id),
  day_plan_on    boolean not null default true,
  day_plan_hour  smallint not null default 20 check (day_plan_hour between 4 and 21), -- noon or later = about tomorrow
  studio_address text not null default '' check (length(studio_address) <= 300),         -- where drive time is measured from
  updated_at    timestamptz not null default now()
);
insert into public.staff_settings (id) values (true);
comment on table public.staff_settings is 'The daily "Your day" notification (on/off, hour Eastern; from noon on it covers tomorrow) and the studio address drive time is measured from.';

create table public.drive_time_cache (
  destination text primary key,          -- lower-cased, trimmed address as sent to Google
  origin      text not null,
  minutes     int not null check (minutes between 0 and 1440),
  meters      int,
  fetched_at  timestamptz not null default now()
);
comment on table public.drive_time_cache is 'Drive times from the studio, one per destination address (Google Routes API). Dropped when the studio address changes.';

create table public.day_plan_log (
  user_id uuid not null references public.team_members (user_id) on delete cascade,
  day     date not null,
  sent_at timestamptz not null default now(),
  summary text,                          -- null = nothing on that day, so nothing was sent
  primary key (user_id, day)
);
comment on table public.day_plan_log is 'Who got their "Your day" notification for which day (once per person per day).';

alter table public.schedule_entries enable row level security;
alter table public.staff_tasks      enable row level security;
alter table public.staff_task_done  enable row level security;
alter table public.staff_settings   enable row level security;
alter table public.day_plan_log     enable row level security;
alter table public.drive_time_cache enable row level security;
revoke all on public.schedule_entries, public.staff_tasks, public.staff_task_done, public.staff_settings, public.day_plan_log, public.drive_time_cache from anon, authenticated;

insert into public.push_topics (key, label, description, module, sort)
values ('my_day', 'Your day', 'Each evening: tomorrow''s jobs (with when to leave), other scheduled time and tasks. Skipped when there is nothing on.', 'assignments', 70)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- internal helpers
create function public.staff_name(p_uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(m.display_name, ''), split_part(u.email, '@', 1))
    from public.team_members m left join auth.users u on u.id = m.user_id where m.user_id = p_uid
$$;

-- The booking's name the way the calendar shows it: its custom title, else "Organization • Label".
create function public.schedule_booking_title(p_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(b.title_override), ''), nullif(concat_ws(' • ', o.name, coalesce(nullif(b.title_label, ''), t.label)), ''), 'Booking')
    from public.bookings b
    left join public.prospect_orgs o on o.id = b.org_id
    left join public.booking_types t on t.key = b.type_key
   where b.id = p_id
$$;

-- Every booking day between p_from (inclusive) and p_to (exclusive), cancelled bookings left out.
-- Times are null when the booking has no time yet.
create function public.schedule_booking_days(p_from date, p_to date)
returns table (booking_id uuid, day date, start_at timestamptz, end_at timestamptz, title text, type_label text,
               location text, status text, day_label text)
language sql stable security definer set search_path = '' as $$
  select b.id, x.day, x.s,
         case when x.s is null then null
              else coalesce(x.e, x.s + make_interval(mins => coalesce(b.duration_min, t.default_duration_min, 60))) end,
         public.schedule_booking_title(b.id), t.label, coalesce(b.location, ''), b.status, coalesce(x.label, '')
    from public.bookings b
    left join public.booking_types t on t.key = b.type_key
    cross join lateral (
      select d.day,
             case when (case when d.sort = 0 then b.time_set is not false else d.start_at is not null end) then d.start_at end as s,
             case when (case when d.sort = 0 then b.time_set is not false and b.end_set is not false else d.end_at is not null end) then d.end_at end as e,
             d.label
        from public.booking_days d where d.booking_id = b.id and d.removed is not true
      union all
      select b.picture_day,
             case when b.time_set is not false then b.start_at end,
             case when b.time_set is not false and b.end_set is not false then b.end_at end,
             null
       where not exists (select 1 from public.booking_days d where d.booking_id = b.id)
    ) x
   where b.status <> 'cancelled' and x.day >= p_from and x.day < p_to
$$;

-- Is the task due on p_day?
create function public.staff_task_due(t public.staff_tasks, p_day date) returns boolean
language sql stable set search_path = '' as $$
  select t.active and p_day is not null and (t.repeat = 'once' or p_day >= t.starts_on) and case t.repeat
    when 'once'    then p_day = t.due_on
    when 'daily'   then cardinality(t.weekdays) = 0 or extract(dow from p_day)::smallint = any (t.weekdays)
    when 'weekly'  then extract(dow from p_day)::smallint = any (t.weekdays)
    when 'monthly' then extract(day from p_day)::int = least(t.month_day::int, extract(day from (date_trunc('month', p_day) + interval '1 month - 1 day'))::int)
    else false end
$$;

-- The latest due day on or before p_day (null if none).
create function public.staff_task_last_due(t public.staff_tasks, p_day date) returns date
language sql stable set search_path = '' as $$
  select case when t.repeat = 'once' then case when t.active and t.due_on <= p_day then t.due_on end
         else (select max(g::date) from generate_series((p_day - 31)::timestamp, p_day::timestamp, interval '1 day') g
                where public.staff_task_due(t, g::date)) end
$$;

-- What is on each person's list on p_day: tasks due that day (done or not), plus a task whose latest due day
-- was earlier and is still not done (overdue). Only the latest due day counts, so a missed task shows once.
create function public.staff_task_items(p_day date, p_users uuid[])
returns table (task_id uuid, user_id uuid, title text, notes text, repeat text, priority text, est_minutes int, on_date date,
               overdue boolean, done_at timestamptz, done_by text)
language sql stable security definer set search_path = '' as $$
  select t.id, t.user_id, t.title, t.notes, t.repeat, t.priority, t.est_minutes, o.on_date, o.on_date < p_day, d.done_at, public.staff_name(d.done_by)
    from public.staff_tasks t
    cross join lateral (select case when public.staff_task_due(t, p_day) then p_day else public.staff_task_last_due(t, p_day) end as on_date) o
    left join public.staff_task_done d on d.task_id = t.id and d.on_date = o.on_date
   where t.active and t.user_id = any (p_users) and o.on_date is not null
     and (o.on_date = p_day or d.task_id is null)
$$;

-- ---------------------------------------------------------------- scheduling (module 'scheduling')
-- Everything the scheduler draws for p_days days from p_start (a Sunday for the week view).
create function public.schedule_week(p_start date, p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_from timestamptz; v_to timestamptz; v_end date;
  v_tasks_all boolean; v_tasks_mine boolean;
begin
  if not public.can('scheduling', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_start is null then raise exception 'pick a week'; end if;
  p_days := greatest(1, least(coalesce(p_days, 7), 42));
  v_end := p_start + p_days;
  v_from := p_start::timestamp at time zone 'America/New_York';
  v_to := v_end::timestamp at time zone 'America/New_York';
  v_tasks_all := public.can('assignments', 'edit');
  v_tasks_mine := public.can('assignments', 'view');
  return jsonb_build_object(
    'can_edit', public.can('scheduling', 'edit'),
    'me', v_me,
    'studio_address', (select studio_address from public.staff_settings where id),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', public.staff_name(m.user_id), 'weekly_hours', m.weekly_hours)
                                         order by lower(public.staff_name(m.user_id))), '[]'::jsonb)
                 from public.team_members m where m.active),
    'bookings', (select coalesce(jsonb_agg(jsonb_build_object('booking_id', x.booking_id, 'day', x.day, 'start_at', x.start_at, 'end_at', x.end_at,
                                   'title', x.title, 'type_label', x.type_label, 'location', x.location, 'status', x.status, 'day_label', x.day_label)
                                   order by x.day, x.start_at nulls first, x.title), '[]'::jsonb)
                   from public.schedule_booking_days(p_start, v_end) x),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'user_id', e.user_id, 'kind', e.kind, 'booking_id', e.booking_id,
                                  'starts_at', e.starts_at, 'ends_at', e.ends_at, 'drive_before_min', e.drive_before_min, 'drive_after_min', e.drive_after_min,
                                  'title', e.title, 'note', e.note,
                                  'booking_title', case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) end,
                                  'booking_location', b.location, 'booking_status', b.status)
                                  order by e.starts_at), '[]'::jsonb)
                  from public.schedule_entries e left join public.bookings b on b.id = e.booking_id
                 where e.starts_at - make_interval(mins => e.drive_before_min) < v_to
                   and e.ends_at + make_interval(mins => e.drive_after_min) > v_from),
    'tasks', case when v_tasks_mine then
               (select coalesce(jsonb_agg(jsonb_build_object('user_id', s.user_id, 'day', s.day, 'n', s.n)), '[]'::jsonb)
                  from (select t.user_id, g::date as day, count(*) as n
                          from public.staff_tasks t
                          cross join generate_series(p_start::timestamp, (v_end - 1)::timestamp, interval '1 day') g
                         where t.active and (v_tasks_all or t.user_id = v_me) and public.staff_task_due(t, g::date)
                         group by 1, 2) s)
             else '[]'::jsonb end);
end $$;

-- Add or change a bar. p = {id?, user_id, kind, booking_id?, starts_at, ends_at, drive_before_min?, drive_after_min?, title?, note?}
create function public.schedule_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_kind text := p ->> 'kind';
  v_booking uuid := nullif(p ->> 'booking_id', '')::uuid;
  v_start timestamptz := nullif(p ->> 'starts_at', '')::timestamptz;
  v_end timestamptz := nullif(p ->> 'ends_at', '')::timestamptz;
  v_db int := coalesce(nullif(p ->> 'drive_before_min', '')::int, 0);
  v_da int := coalesce(nullif(p ->> 'drive_after_min', '')::int, 0);
  v_overlaps int;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_kind is null or v_kind not in ('job', 'work', 'off') then raise exception 'Pick what kind of time this is.'; end if;
  if v_user is null or not exists (select 1 from public.team_members where user_id = v_user and active) then raise exception 'Pick someone on the team.'; end if;
  if v_start is null or v_end is null or v_end <= v_start then raise exception 'The end has to be after the start.'; end if;
  if v_end - v_start > (case when v_kind = 'off' then interval '15 days' else interval '24 hours' end) then
    raise exception 'That is too long for one bar.';
  end if;
  if v_kind = 'job' then
    if v_booking is null or not exists (select 1 from public.bookings where id = v_booking) then raise exception 'Pick the job.'; end if;
    if v_db not between 0 and 600 or v_da not between 0 and 600 then raise exception 'Drive time is 0 to 600 minutes each way.'; end if;
  else
    v_booking := null; v_db := 0; v_da := 0;
  end if;

  if v_id is not null then
    update public.schedule_entries
       set user_id = v_user, kind = v_kind, booking_id = v_booking, starts_at = v_start, ends_at = v_end,
           drive_before_min = v_db, drive_after_min = v_da,
           title = left(btrim(coalesce(p ->> 'title', '')), 120), note = left(coalesce(p ->> 'note', ''), 1000), updated_at = now()
     where id = v_id;
    if not found then raise exception 'That bar was already removed. Reload the week.'; end if;
  else
    insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at, drive_before_min, drive_after_min, title, note, created_by)
    values (v_user, v_kind, v_booking, v_start, v_end, v_db, v_da, left(btrim(coalesce(p ->> 'title', '')), 120), left(coalesce(p ->> 'note', ''), 1000), (select auth.uid()))
    returning id into v_id;
  end if;

  select count(*) into v_overlaps from public.schedule_entries o
   where o.user_id = v_user and o.id <> v_id
     and o.starts_at - make_interval(mins => o.drive_before_min) < v_end + make_interval(mins => v_da)
     and o.ends_at + make_interval(mins => o.drive_after_min) > v_start - make_interval(mins => v_db);
  return jsonb_build_object('ok', true, 'id', v_id, 'overlaps', v_overlaps);
end $$;

create function public.schedule_remove(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from public.schedule_entries where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

-- For Today: booked days in the next 14 days that nobody is scheduled on.
create function public.schedule_attention()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('scheduling', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('unstaffed', (
    select count(*) from public.schedule_booking_days(v_today, v_today + 14) x
     where x.status = 'booked'
       and not exists (select 1 from public.schedule_entries e
                        where e.booking_id = x.booking_id
                          and (e.starts_at at time zone 'America/New_York')::date <= x.day
                          and (e.ends_at at time zone 'America/New_York')::date >= x.day)));
end $$;

-- ---------------------------------------------------------------- assignments (module 'assignments')
-- One day's list. Default: my own. p_user = someone else's, p_all = everyone's (both need Edit).
create function public.assignments_day(p_day date, p_user uuid default null, p_all boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid()); v_users uuid[];
begin
  if not public.can('assignments', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_day is null then p_day := (now() at time zone 'America/New_York')::date; end if;
  if coalesce(p_all, false) or (p_user is not null and p_user <> v_me) then
    if not public.can('assignments', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
    v_users := case when coalesce(p_all, false) then (select array_agg(user_id) from public.team_members where active) else array[p_user] end;
  else
    v_users := array[v_me];
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('task_id', i.task_id, 'user_id', i.user_id, 'user_name', public.staff_name(i.user_id),
                            'title', i.title, 'notes', i.notes, 'repeat', i.repeat, 'priority', i.priority, 'est_minutes', i.est_minutes,
                            'on_date', i.on_date, 'overdue', i.overdue, 'done_at', i.done_at, 'done_by', i.done_by)
                            -- open first; urgent at the top (missed urgent first of all); missed normal ones just say overdue
                            order by lower(public.staff_name(i.user_id)), i.done_at is not null, i.priority = 'urgent' desc,
                                     (i.priority = 'urgent' and i.overdue) desc, lower(i.title)), '[]'::jsonb)
            from public.staff_task_items(p_day, coalesce(v_users, '{}')) i);
end $$;

-- My day: my bars (jobs with drive time, other time, time off) and, with Assignments, my tasks.
create function public.my_day(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid()); v_from timestamptz; v_to timestamptz;
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_day is null then p_day := (now() at time zone 'America/New_York')::date; end if;
  v_from := p_day::timestamp at time zone 'America/New_York';
  v_to := (p_day + 1)::timestamp at time zone 'America/New_York';
  return jsonb_build_object(
    'day', p_day,
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
                                  'drive_before_min', e.drive_before_min, 'drive_after_min', e.drive_after_min, 'title', e.title, 'note', e.note,
                                  'booking_title', case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) end,
                                  'booking_location', b.location, 'booking_status', b.status) order by e.starts_at), '[]'::jsonb)
                  from public.schedule_entries e left join public.bookings b on b.id = e.booking_id
                 where e.user_id = v_me
                   and e.starts_at - make_interval(mins => e.drive_before_min) < v_to
                   and e.ends_at + make_interval(mins => e.drive_after_min) > v_from),
    'tasks', case when public.can('assignments', 'view') then public.assignments_day(p_day) else '[]'::jsonb end,
    'weekly_hours', (select weekly_hours from public.team_members where user_id = v_me));
end $$;

-- Check a task off (or un-check it) for one due day. Your own with View; anyone's with Edit.
create function public.assignment_check(p_task uuid, p_on date, p_done boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.staff_tasks;
begin
  if not public.can('assignments', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into t from public.staff_tasks where id = p_task;
  if not found then raise exception 'That task was removed.'; end if;
  if t.user_id <> (select auth.uid()) and not public.can('assignments', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.staff_task_due(t, p_on) then raise exception 'That task is not due that day.'; end if;
  if coalesce(p_done, false) then
    insert into public.staff_task_done (task_id, on_date, done_by) values (p_task, p_on, (select auth.uid())) on conflict do nothing;
  else
    delete from public.staff_task_done where task_id = p_task and on_date = p_on;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Every task (Edit: everyone's; View: your own), with the morning-notification settings.
create function public.assignments_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid()); v_all boolean;
begin
  if not public.can('assignments', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  v_all := public.can('assignments', 'edit');
  return jsonb_build_object(
    'can_edit', v_all,
    'me', v_me,
    'settings', (select jsonb_build_object('day_plan_on', s.day_plan_on, 'day_plan_hour', s.day_plan_hour) from public.staff_settings s),
    'people', case when v_all then (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', public.staff_name(m.user_id),
                                                         'gets_day_plan', public.team_user_can(m.user_id, 'assignments'))
                                                         order by lower(public.staff_name(m.user_id))), '[]'::jsonb)
                                      from public.team_members m where m.active)
                   else jsonb_build_array(jsonb_build_object('user_id', v_me, 'name', public.staff_name(v_me), 'gets_day_plan', true)) end,
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'user_id', t.user_id, 'title', t.title, 'notes', t.notes, 'repeat', t.repeat,
                                'weekdays', to_jsonb(t.weekdays), 'month_day', t.month_day, 'due_on', t.due_on, 'starts_on', t.starts_on,
                                'est_minutes', t.est_minutes, 'priority', t.priority,
                                'last_done', (select max(d.on_date) from public.staff_task_done d where d.task_id = t.id))
                                order by t.created_at), '[]'::jsonb)
                from public.staff_tasks t
               where t.active and (v_all or t.user_id = v_me)
                 and (t.repeat <> 'once' or t.due_on >= (now() at time zone 'America/New_York')::date - 30)));
end $$;

-- Add or change a task. p = {id?, user_id, title, notes?, repeat, weekdays?, month_day?, due_on?, starts_on?, est_minutes?, priority?}
create function public.assignment_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_title text := left(btrim(coalesce(p ->> 'title', '')), 160);
  v_repeat text := p ->> 'repeat';
  v_days smallint[];
  v_mday smallint := nullif(p ->> 'month_day', '')::smallint;
  v_due date := nullif(p ->> 'due_on', '')::date;
  v_starts date := coalesce(nullif(p ->> 'starts_on', '')::date, (now() at time zone 'America/New_York')::date);
  v_est int := nullif(p ->> 'est_minutes', '')::int;
  v_prio text := coalesce(nullif(p ->> 'priority', ''), 'normal');
begin
  if not public.can('assignments', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_user is null or not exists (select 1 from public.team_members where user_id = v_user and active) then raise exception 'Pick someone on the team.'; end if;
  if v_title = '' then raise exception 'Give the task a name.'; end if;
  if v_repeat is null or v_repeat not in ('once', 'daily', 'weekly', 'monthly') then raise exception 'Pick how often it repeats.'; end if;
  select coalesce(array_agg(distinct x::smallint order by x::smallint), '{}') into v_days
    from jsonb_array_elements_text(case when jsonb_typeof(p -> 'weekdays') = 'array' then p -> 'weekdays' else '[]'::jsonb end) x;
  if not v_days <@ '{0,1,2,3,4,5,6}'::smallint[] then raise exception 'bad weekday'; end if;
  if v_repeat = 'once' and v_due is null then raise exception 'Pick the day it is due.'; end if;
  if v_repeat = 'weekly' and cardinality(v_days) <> 1 then raise exception 'Pick the day of the week.'; end if;
  if v_repeat = 'monthly' and (v_mday is null or v_mday not between 1 and 31) then raise exception 'Pick the day of the month.'; end if;
  if v_repeat = 'daily' and cardinality(v_days) = 7 then v_days := '{}'; end if;
  if v_repeat not in ('daily', 'weekly') then v_days := '{}'; end if;
  if v_repeat <> 'monthly' then v_mday := null; end if;
  if v_repeat <> 'once' then v_due := null; end if;
  if v_est is not null and v_est not between 1 and 1440 then raise exception 'Time needed is 1 to 1440 minutes.'; end if;
  if v_prio not in ('normal', 'urgent') then raise exception 'Priority is normal or urgent.'; end if;

  if v_id is not null then
    update public.staff_tasks
       set user_id = v_user, title = v_title, notes = left(coalesce(p ->> 'notes', ''), 2000), repeat = v_repeat, weekdays = v_days,
           month_day = v_mday, due_on = v_due, starts_on = v_starts, est_minutes = v_est, priority = v_prio, updated_at = now()
     where id = v_id and active;
    if not found then raise exception 'That task was removed. Reload the page.'; end if;
  else
    insert into public.staff_tasks (user_id, title, notes, repeat, weekdays, month_day, due_on, starts_on, est_minutes, priority, created_by)
    values (v_user, v_title, left(coalesce(p ->> 'notes', ''), 2000), v_repeat, v_days, v_mday, v_due, v_starts, v_est, v_prio, (select auth.uid()))
    returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function public.assignment_archive(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('assignments', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.staff_tasks set active = false, updated_at = now() where id = p_id and active;
  return jsonb_build_object('ok', found);
end $$;

create function public.staff_settings_save(p_on boolean, p_hour int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('assignments', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_hour is null or p_hour not between 4 and 21 then raise exception 'Pick an hour between 4am and 9pm.'; end if;
  update public.staff_settings set day_plan_on = coalesce(p_on, true), day_plan_hour = p_hour, updated_at = now() where id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- "Your day" notification
-- {title, body} for one person's day, or null when there is nothing on it. p_tomorrow words it as "Tomorrow".
create function public.day_plan_text(p_uid uuid, p_day date, p_tomorrow boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'America/New_York';
  v_to timestamptz := (p_day + 1)::timestamp at time zone 'America/New_York';
  v_lines text[] := '{}'; v_jobs int := 0; v_tasks text[]; v_title text; r record;
  fmt constant text := 'FMHH12:MIam';
begin
  for r in select e.*, case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) end as btitle
             from public.schedule_entries e
            where e.user_id = p_uid and e.starts_at < v_to and e.ends_at > v_from
              and (e.booking_id is null or exists (select 1 from public.bookings b where b.id = e.booking_id and b.status <> 'cancelled'))
            order by e.starts_at loop
    if r.kind = 'job' then
      v_jobs := v_jobs + 1;
      v_lines := v_lines || (to_char(r.starts_at at time zone 'America/New_York', fmt) || ' ' || coalesce(nullif(r.title, ''), r.btitle) ||
        case when r.drive_before_min > 0 then ' (leave ' || to_char((r.starts_at - make_interval(mins => r.drive_before_min)) at time zone 'America/New_York', fmt) || ')' else '' end);
    elsif r.kind = 'work' then
      v_lines := v_lines || (to_char(r.starts_at at time zone 'America/New_York', fmt) || '-' || to_char(r.ends_at at time zone 'America/New_York', fmt) || ' ' || coalesce(nullif(r.title, ''), 'Work'));
    else
      v_lines := v_lines || ('Off' || case when r.title <> '' then ': ' || r.title else '' end);
    end if;
  end loop;
  -- Tasks still open by then. Urgent ones first.
  select array_agg(i.title || case when i.priority = 'urgent' then ' (urgent)' when i.overdue then ' (overdue)' else '' end
                   order by i.priority = 'urgent' desc, i.overdue desc, lower(i.title)) into v_tasks
    from public.staff_task_items(p_day, array[p_uid]) i where i.done_at is null;
  if cardinality(v_lines) = 0 and coalesce(cardinality(v_tasks), 0) = 0 then return null; end if;
  v_title := case when p_tomorrow then 'Tomorrow (' || to_char(p_day, 'FMDay') || ')' else 'Today (' || to_char(p_day, 'FMDay') || ')' end;
  if v_jobs > 0 or coalesce(cardinality(v_tasks), 0) > 0 then
    v_title := v_title || ': ' || concat_ws(', ',
      case when v_jobs = 1 then '1 job' when v_jobs > 1 then v_jobs || ' jobs' end,
      case when cardinality(v_tasks) = 1 then '1 task' when cardinality(v_tasks) > 1 then cardinality(v_tasks) || ' tasks' end);
  end if;
  return jsonb_build_object('title', v_title,
    'body', left(array_to_string(v_lines || case when cardinality(v_tasks) > 0 then array['To do: ' || array_to_string(v_tasks, ', ')] else '{}'::text[] end, '. '), 300));
end $$;

-- Cron, every 15 minutes: from the set hour (Eastern) until 3 hours after it, send each person their day once.
-- From noon on it is about tomorrow (default 8pm: "Tomorrow: 2 jobs, 3 tasks"); before noon, about today.
-- Goes to people who can use Assignments, have a device with notifications on and did not switch "Your day" off.
create function public.day_plan_send()
returns int language plpgsql security definer set search_path = '' as $$
declare
  s public.staff_settings;
  v_now timestamp := now() at time zone 'America/New_York';
  v_day date;
  v_sent int := 0; v jsonb; r record;
begin
  select * into s from public.staff_settings where id;
  if not found or not s.day_plan_on or extract(hour from v_now) < s.day_plan_hour or extract(hour from v_now) >= s.day_plan_hour + 3 then return 0; end if;
  v_day := v_now::date + case when s.day_plan_hour >= 12 then 1 else 0 end;
  for r in select m.user_id from public.team_members m
            where m.active and public.team_user_can(m.user_id, 'assignments')
              and exists (select 1 from public.push_subscriptions ps where ps.user_id = m.user_id)
              and coalesce((select p.enabled from public.push_prefs p where p.user_id = m.user_id and p.topic = 'my_day'),
                           (select t.default_on from public.push_topics t where t.key = 'my_day'), true)
              and not exists (select 1 from public.day_plan_log l where l.user_id = m.user_id and l.day = v_day) loop
    v := public.day_plan_text(r.user_id, v_day, s.day_plan_hour >= 12);
    insert into public.day_plan_log (user_id, day, summary) values (r.user_id, v_day, v ->> 'body') on conflict do nothing;
    if v is not null then
      perform public.push_notify('my_day', v ->> 'title', v ->> 'body', '/#staff/myday', 'my_day', r.user_id);
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end $$;

select cron.schedule('day-plan-send', '*/15 * * * *', 'select public.day_plan_send()');
select cron.schedule('day-plan-log-retention', '55 4 * * *', $$delete from public.day_plan_log where day < current_date - 60$$);

-- ---------------------------------------------------------------- drive time (Google Maps, via the drive-time edge function)
-- The address a booking is driven to: its location, else "Organization, Town, Maine".
create function public.schedule_destination(p_booking uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(b.location), ''), nullif(concat_ws(', ', o.name, nullif(o.town, ''), 'Maine'), 'Maine'))
    from public.bookings b left join public.prospect_orgs o on o.id = b.org_id where b.id = p_booking
$$;

-- Called by drive-time with the caller's token: what to ask Google, or the cached answer.
create function public.drive_time_target(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_origin text; v_dest text; c public.drive_time_cache;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select btrim(studio_address) into v_origin from public.staff_settings where id;
  v_dest := public.schedule_destination(p_booking);
  if coalesce(v_origin, '') = '' then return jsonb_build_object('ok', false, 'error', 'Add the studio address on the Schedule page first.'); end if;
  if v_dest is null then return jsonb_build_object('ok', false, 'error', 'This job has no address. Add a location on the booking.'); end if;
  select * into c from public.drive_time_cache where destination = lower(v_dest) and origin = lower(v_origin) and fetched_at > now() - interval '180 days';
  return jsonb_build_object('ok', true, 'origin', v_origin, 'destination', v_dest, 'minutes', c.minutes, 'meters', c.meters);
end $$;

create function public.drive_time_store(p_origin text, p_destination text, p_minutes int, p_meters int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_minutes is null or p_minutes not between 0 and 1440 or coalesce(p_destination, '') = '' then raise exception 'bad drive time'; end if;
  if not exists (select 1 from public.staff_settings where id and lower(btrim(studio_address)) = lower(btrim(p_origin))) then
    return jsonb_build_object('ok', false);   -- the studio address changed meanwhile
  end if;
  insert into public.drive_time_cache (destination, origin, minutes, meters)
  values (lower(btrim(p_destination)), lower(btrim(p_origin)), p_minutes, p_meters)
  on conflict (destination) do update set origin = excluded.origin, minutes = excluded.minutes, meters = excluded.meters, fetched_at = now();
  return jsonb_build_object('ok', true);
end $$;

create function public.schedule_settings_save(p_studio_address text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if length(coalesce(p_studio_address, '')) > 300 then raise exception 'That address is too long.'; end if;
  update public.staff_settings set studio_address = btrim(coalesce(p_studio_address, '')), updated_at = now()
   where id and studio_address is distinct from btrim(coalesce(p_studio_address, ''));
  if found then truncate public.drive_time_cache; end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- Team page: default weekly hours
create function public.team_set_hours(p_user_id uuid, p_hours numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_before numeric;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_hours is not null and (p_hours < 0 or p_hours > 80) then raise exception 'Hours per week is 0 to 80.'; end if;
  select weekly_hours into v_before from public.team_members where user_id = p_user_id;
  if not found then raise exception 'no such team member'; end if;
  if v_before is distinct from p_hours then
    update public.team_members set weekly_hours = round(p_hours, 1), updated_at = now() where user_id = p_user_id;
    insert into public.team_audit (actor, target, action, detail)
    values ((select auth.uid()), p_user_id, 'hours_set', jsonb_build_object('before', v_before, 'after', p_hours));
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.team_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', m.user_id,
             'email', u.email,
             'name', m.display_name,
             'is_admin', exists (select 1 from public.admin_users a where a.user_id = m.user_id),
             'is_me', m.user_id = (select auth.uid()),
             'active', m.active,
             'must_change_password', m.must_change_password,
             'weekly_hours', m.weekly_hours,
             'created_at', m.created_at,
             'last_sign_in_at', u.last_sign_in_at,
             'modules', (select coalesce(jsonb_object_agg(p.module_key, p.level), '{}'::jsonb)
                           from public.team_permissions p where p.user_id = m.user_id))
           order by (exists (select 1 from public.admin_users a where a.user_id = m.user_id)) desc, m.active desc, lower(m.display_name))
      from public.team_members m join auth.users u on u.id = m.user_id), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- grants
do $$
declare f text;
begin
  -- internal: no one calls these directly
  foreach f in array array['public.staff_name(uuid)', 'public.schedule_booking_title(uuid)', 'public.schedule_booking_days(date, date)',
                           'public.staff_task_items(date, uuid[])', 'public.schedule_destination(uuid)', 'public.day_plan_text(uuid, date, boolean)', 'public.day_plan_send()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- the app (each checks access first)
  foreach f in array array['public.schedule_week(date, int)', 'public.schedule_save(jsonb)', 'public.schedule_remove(uuid)', 'public.schedule_attention()',
                           'public.assignments_day(date, uuid, boolean)', 'public.my_day(date)', 'public.assignment_check(uuid, date, boolean)',
                           'public.assignments_list()', 'public.assignment_save(jsonb)', 'public.assignment_archive(uuid)',
                           'public.staff_settings_save(boolean, int)', 'public.team_set_hours(uuid, numeric)',
                           'public.drive_time_target(uuid)', 'public.drive_time_store(text, text, int, int)', 'public.schedule_settings_save(text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
