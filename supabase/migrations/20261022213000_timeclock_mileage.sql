-- Time clock and mileage (2026-10-22). Module 'timeclock', pages #staff/clock, #staff/timesheets, #staff/mileage.
--
--   time_punches      one row per stretch of work: clock in, clock out, and what it was for (a job, Studio,
--                     Admin or Other). One open punch (clock_out null) per person at a time. Clocking in to
--                     something else while clocked in closes the open punch first ("switch").
--   timesheet_weeks   a person's week (Sunday start, Eastern) once a manager approved it, with the hours and
--                     miles as approved. An approved week is locked: nobody changes its punches or trips until
--                     it is unapproved.
--   mileage_trips     miles driven for work on one day. Clocking in to a job adds that job's round trip from the
--                     studio (2 x the one-way distance Google gave the drive-time function). People change the
--                     miles (0 = rode with someone) or add trips by hand; "Add from schedule" adds a trip for
--                     every job bar of the month that has none.
--   timeclock_settings  mileage rate ($ per mile) and weekly hours before overtime, for the payroll CSV.
--
-- Worked time counts on the day (and week) it was clocked in. Scheduled time is the person's bars on the
-- Schedule (jobs with their drive time, Studio / Admin / Flex / Other; time off does not count), the same
-- way the Schedule page adds up hours.
--
-- Access is the `timeclock` module:
--   view = clock yourself in and out, see and fix your own time and miles in weeks not yet approved.
--   edit = everyone's timesheets and miles, approve weeks, payroll CSV, settings.
-- People are kept by user_id and their name at the time (user_name), so removing someone from the Team page
-- does not take their hours out of past payroll. Nothing here sends email or notifications.

update public.app_modules
   set status = 'live', label = 'Time clock & mileage',
       description = 'Clock in and out from a phone, tied to a job; weekly timesheets (worked vs scheduled) with approval and a payroll CSV; miles per job. View = your own; Edit = everyone''s, approve and export.'
 where key = 'timeclock';

-- ---------------------------------------------------------------- tables
create table public.timeclock_settings (
  id             boolean primary key default true check (id),
  mileage_rate   numeric(5,3) not null default 0.700 check (mileage_rate between 0 and 5),
  overtime_after numeric(4,1) not null default 40 check (overtime_after between 0 and 80),
  updated_at     timestamptz not null default now()
);
insert into public.timeclock_settings (id) values (true);
comment on table public.timeclock_settings is 'Payroll settings: mileage rate in dollars per mile, and hours per week (Sunday-Saturday) after which time is overtime.';

create table public.time_punches (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  user_name   text not null default '',
  kind        text not null check (kind in ('job', 'studio', 'admin', 'other')),
  booking_id  uuid references public.bookings (id) on delete set null,
  job_title   text not null default '' check (length(job_title) <= 200),
  clock_in    timestamptz not null,
  clock_out   timestamptz,
  note        text not null default '' check (length(note) <= 500),
  edited      boolean not null default false,   -- times typed or changed after the fact (not a live clock in/out)
  edited_by   uuid,
  edited_at   timestamptz,
  created_at  timestamptz not null default now(),
  check (clock_out is null or clock_out > clock_in),
  check (clock_out is null or clock_out - clock_in <= interval '24 hours'),
  check (kind <> 'job' or booking_id is not null or job_title <> '')
);
comment on table public.time_punches is 'Time clock: one row per clock in / clock out. user_id has no foreign key on purpose (history outlives a removed login); user_name is the name at the time. Written only by the timeclock_* / timepunch_* functions.';
create unique index time_punches_open_uq on public.time_punches (user_id) where clock_out is null;
create index time_punches_user_idx on public.time_punches (user_id, clock_in);
create index time_punches_in_idx on public.time_punches (clock_in);
create index time_punches_booking_idx on public.time_punches (booking_id) where booking_id is not null;

create table public.timesheet_weeks (
  user_id     uuid not null,
  week_start  date not null check (extract(dow from week_start) = 0),
  approved_by uuid,
  approved_at timestamptz not null default now(),
  worked_min  int not null default 0,
  miles       numeric(7,1) not null default 0,
  primary key (user_id, week_start)
);
comment on table public.timesheet_weeks is 'Approved weeks (Sunday start). A row locks that person''s punches and trips for the week. worked_min / miles are as approved.';

create table public.mileage_trips (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  user_name   text not null default '',
  booking_id  uuid references public.bookings (id) on delete set null,
  job_title   text not null default '' check (length(job_title) <= 200),
  day         date not null,
  miles       numeric(6,1) check (miles is null or miles between 0 and 2000),  -- null = not looked up yet
  auto        boolean not null default true,    -- miles came from Google (round trip from the studio)
  note        text not null default '' check (length(note) <= 300),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (booking_id is not null or job_title <> '' or note <> '')
);
comment on table public.mileage_trips is 'Miles driven for work, one row per person per job per day (or a trip typed by hand). auto = round trip studio -> job from the drive-time cache; miles null until it is looked up.';
create unique index mileage_trips_job_uq on public.mileage_trips (user_id, booking_id, day) where booking_id is not null;
create index mileage_trips_day_idx on public.mileage_trips (day);

alter table public.timeclock_settings enable row level security;
alter table public.time_punches       enable row level security;
alter table public.timesheet_weeks    enable row level security;
alter table public.mileage_trips      enable row level security;
revoke all on public.timeclock_settings, public.time_punches, public.timesheet_weeks, public.mileage_trips from anon, authenticated;

-- ---------------------------------------------------------------- helpers (internal)
create function public.tc_week_of(p_day date) returns date
language sql immutable set search_path = '' as $$ select p_day - extract(dow from p_day)::int $$;

create function public.tc_day_of(p_ts timestamptz) returns date
language sql stable set search_path = '' as $$ select (p_ts at time zone 'America/New_York')::date $$;

create function public.tc_locked(p_user uuid, p_day date) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.timesheet_weeks w where w.user_id = p_user and w.week_start = public.tc_week_of(p_day))
$$;

create function public.tc_name(p_user uuid, p_fallback text default '') returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(public.staff_name(p_user), nullif(p_fallback, ''), 'Removed person')
$$;

-- Round trip from the studio to a job in miles, from the drive-time cache (null if not looked up yet).
create function public.mileage_estimate(p_booking uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(2 * c.meters / 1609.344, 1)
    from public.staff_settings s
    join public.drive_time_cache c on c.origin = lower(btrim(s.studio_address)) and c.destination = lower(btrim(public.schedule_destination(p_booking)))
   where s.id and btrim(s.studio_address) <> '' and c.meters is not null
$$;

-- Scheduled minutes per person per Eastern day: bars other than time off, jobs with their drive time,
-- clipped to the day. Bars of cancelled bookings don't count.
create function public.tc_scheduled(p_users uuid[], p_from date, p_to date)
returns table (user_id uuid, day date, minutes int)
language sql stable security definer set search_path = '' as $$
  select e.user_id, g.day,
         round(sum(extract(epoch from least(e.ends_at + make_interval(mins => e.drive_after_min), (g.day + 1)::timestamp at time zone 'America/New_York')
                                    - greatest(e.starts_at - make_interval(mins => e.drive_before_min), g.day::timestamp at time zone 'America/New_York'))) / 60)::int
    from generate_series(p_from::timestamp, (p_to - 1)::timestamp, interval '1 day') gs
    cross join lateral (select gs::date as day) g
    join public.schedule_entries e
      on e.user_id = any (p_users) and e.kind <> 'off'
     and e.starts_at - make_interval(mins => e.drive_before_min) < (g.day + 1)::timestamp at time zone 'America/New_York'
     and e.ends_at + make_interval(mins => e.drive_after_min) > g.day::timestamp at time zone 'America/New_York'
   where e.booking_id is null or exists (select 1 from public.bookings b where b.id = e.booking_id and b.status <> 'cancelled')
   group by 1, 2
$$;

-- Minutes of one punch (an open one counts up to now).
create function public.tc_minutes(p public.time_punches) returns int
language sql stable set search_path = '' as $$
  select greatest(0, round(extract(epoch from coalesce(p.clock_out, now()) - p.clock_in) / 60))::int
$$;

create function public.tc_punch_json(p public.time_punches) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'user_id', p.user_id, 'kind', p.kind, 'booking_id', p.booking_id,
    'job_title', coalesce(case when p.booking_id is not null then public.schedule_booking_title(p.booking_id) end, nullif(p.job_title, ''), ''),
    'clock_in', p.clock_in, 'clock_out', p.clock_out, 'day', public.tc_day_of(p.clock_in), 'minutes', public.tc_minutes(p), 'note', p.note,
    'edited', p.edited, 'edited_by', case when p.edited_by is not null then public.staff_name(p.edited_by) end,
    'locked', public.tc_locked(p.user_id, public.tc_day_of(p.clock_in)))
$$;

-- Add the round trip for a job day if the person has none yet.
create function public.tc_add_trip(p_user uuid, p_booking uuid, p_day date) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_booking is null or public.tc_locked(p_user, p_day) then return; end if;
  insert into public.mileage_trips (user_id, user_name, booking_id, job_title, day, miles, auto, created_by)
  values (p_user, coalesce(public.staff_name(p_user), ''), p_booking, left(coalesce(public.schedule_booking_title(p_booking), ''), 200), p_day,
          public.mileage_estimate(p_booking), true, (select auth.uid()))
  on conflict (user_id, booking_id, day) where booking_id is not null do nothing;
end $$;

revoke all on function public.tc_locked(uuid, date), public.tc_name(uuid, text), public.mileage_estimate(uuid), public.tc_scheduled(uuid[], date, date),
  public.tc_punch_json(public.time_punches), public.tc_add_trip(uuid, uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------- clock (phone)
-- What the Clock page shows: am I clocked in, today's jobs to pick from (mine first), today's punches and
-- this week's worked vs scheduled minutes.
create function public.timeclock_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_today date := (now() at time zone 'America/New_York')::date;
  v_week date := public.tc_week_of((now() at time zone 'America/New_York')::date);
  p public.time_punches;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into p from public.time_punches where user_id = v_me and clock_out is null;
  return jsonb_build_object(
    'me', v_me,
    'can_edit', public.can('timeclock', 'edit'),
    'open', case when p.id is not null then public.tc_punch_json(p) end,
    'jobs', (select coalesce(jsonb_agg(j order by j ->> 'mine' desc, j ->> 'start_at' nulls last, j ->> 'title'), '[]'::jsonb) from (
              select jsonb_build_object('booking_id', x.booking_id, 'title', x.title, 'start_at', coalesce(min(e.starts_at), min(x.start_at)),
                                        'location', max(x.location), 'mine', bool_or(e.id is not null)) as j
                from public.schedule_booking_days(v_today, v_today + 1) x
                left join public.schedule_entries e on e.booking_id = x.booking_id and e.user_id = v_me and e.kind = 'job'
                 and e.starts_at < (v_today + 1)::timestamp at time zone 'America/New_York' and e.ends_at > v_today::timestamp at time zone 'America/New_York'
               group by x.booking_id, x.title) s),
    'today', (select coalesce(jsonb_agg(public.tc_punch_json(t) order by t.clock_in), '[]'::jsonb)
                from public.time_punches t where t.user_id = v_me and public.tc_day_of(t.clock_in) = v_today),
    'week_start', v_week,
    'week_worked_min', (select coalesce(sum(public.tc_minutes(t)), 0) from public.time_punches t
                         where t.user_id = v_me and public.tc_day_of(t.clock_in) >= v_week and public.tc_day_of(t.clock_in) < v_week + 7),
    'week_scheduled_min', (select coalesce(sum(s.minutes), 0) from public.tc_scheduled(array[v_me], v_week, v_week + 7) s),
    'today_scheduled_min', (select coalesce(sum(s.minutes), 0) from public.tc_scheduled(array[v_me], v_today, v_today + 1) s));
end $$;

-- Clock in to a job (p_kind 'job' + p_booking) or to Studio / Admin / Other. Already clocked in to something
-- else: that punch is closed now, so this is also "switch".
create function public.timeclock_in(p_kind text, p_booking uuid default null, p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_now timestamptz := date_trunc('minute', now());
  v_today date := (now() at time zone 'America/New_York')::date;
  o public.time_punches;
  v_id uuid;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.team_members where user_id = v_me and active) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('job', 'studio', 'admin', 'other') then raise exception 'Pick what you are working on.'; end if;
  if p_kind = 'job' then
    if p_booking is null or not exists (select 1 from public.bookings where id = p_booking and status <> 'cancelled') then raise exception 'Pick the job.'; end if;
  else
    p_booking := null;
  end if;
  if public.tc_locked(v_me, v_today) then raise exception 'This week is already approved. Ask a manager to unapprove it.'; end if;

  select * into o from public.time_punches where user_id = v_me and clock_out is null for update;
  if o.id is not null then
    if o.kind = p_kind and o.booking_id is not distinct from p_booking then raise exception 'You are already clocked in to that.'; end if;
    update public.time_punches set clock_out = greatest(v_now, clock_in + interval '1 minute') where id = o.id returning * into o;
  end if;
  insert into public.time_punches (user_id, user_name, kind, booking_id, job_title, clock_in, note)
  values (v_me, coalesce(public.staff_name(v_me), ''), p_kind, p_booking, left(coalesce(public.schedule_booking_title(p_booking), ''), 200),
          coalesce(o.clock_out, v_now), left(btrim(coalesce(p_note, '')), 500))
  returning id into v_id;
  if p_kind = 'job' then perform public.tc_add_trip(v_me, p_booking, v_today); end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'switched', o.id is not null);
end $$;

create function public.timeclock_out(p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid()); o public.time_punches;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into o from public.time_punches where user_id = v_me and clock_out is null for update;
  if o.id is null then raise exception 'You are not clocked in.'; end if;
  if now() - o.clock_in > interval '24 hours' then
    raise exception 'This has been open more than 24 hours. Fix the clock-out time on your timesheet instead.';
  end if;
  update public.time_punches
     set clock_out = greatest(date_trunc('minute', now()), clock_in + interval '1 minute'),
         note = left(concat_ws(' / ', nullif(note, ''), nullif(btrim(coalesce(p_note, '')), '')), 500)
   where id = o.id returning * into o;
  return jsonb_build_object('ok', true, 'minutes', public.tc_minutes(o));
end $$;

-- ---------------------------------------------------------------- timesheets
-- One week (p_start = its Sunday). Default: mine. p_user = someone else's, p_all = everyone (both need Edit):
-- every active team member plus anyone with time that week.
create function public.timesheet_week(p_start date, p_user uuid default null, p_all boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_edit boolean := public.can('timeclock', 'edit');
  v_users uuid[];
  v_ot numeric;
  v_end date;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_start is null then raise exception 'pick a week'; end if;
  p_start := public.tc_week_of(p_start);
  v_end := p_start + 7;
  if coalesce(p_all, false) or (p_user is not null and p_user <> v_me) then
    if not v_edit then raise exception 'not allowed' using errcode = '42501'; end if;
    v_users := case when coalesce(p_all, false) then
                 (select array_agg(distinct u) from (select m.user_id as u from public.team_members m where m.active
                    union select t.user_id from public.time_punches t where public.tc_day_of(t.clock_in) >= p_start and public.tc_day_of(t.clock_in) < v_end) x)
               else array[p_user] end;
  else
    v_users := array[v_me];
  end if;
  v_users := coalesce(v_users, '{}');
  select overtime_after into v_ot from public.timeclock_settings where id;
  return jsonb_build_object(
    'can_edit', v_edit, 'me', v_me, 'week_start', p_start, 'overtime_after', v_ot,
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('booking_id', x.booking_id, 'day', x.day, 'title', x.title, 'start_at', x.start_at)
                                       order by x.day, x.start_at nulls first, x.title), '[]'::jsonb)
               from public.schedule_booking_days(p_start, v_end) x),
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
                  'user_id', u.uid,
                  'name', public.tc_name(u.uid, (select t.user_name from public.time_punches t where t.user_id = u.uid order by t.clock_in desc limit 1)),
                  'weekly_hours', (select m.weekly_hours from public.team_members m where m.user_id = u.uid),
                  'days', (select jsonb_agg(jsonb_build_object('day', d.day,
                              'worked_min', coalesce((select sum(public.tc_minutes(t)) from public.time_punches t where t.user_id = u.uid and public.tc_day_of(t.clock_in) = d.day), 0),
                              'scheduled_min', coalesce((select s.minutes from public.tc_scheduled(array[u.uid], d.day, d.day + 1) s), 0)) order by d.day)
                             from (select (p_start + i) as day from generate_series(0, 6) i) d),
                  'miles', (select coalesce(sum(r.miles), 0) from public.mileage_trips r where r.user_id = u.uid and r.day >= p_start and r.day < v_end),
                  'open', exists (select 1 from public.time_punches t where t.user_id = u.uid and t.clock_out is null
                                   and public.tc_day_of(t.clock_in) >= p_start and public.tc_day_of(t.clock_in) < v_end),
                  'approved_at', w.approved_at, 'approved_by', case when w.approved_by is not null then public.staff_name(w.approved_by) end,
                  'approved_min', w.worked_min)
                  order by lower(public.tc_name(u.uid))), '[]'::jsonb)
                 from unnest(v_users) u(uid)
                 left join public.timesheet_weeks w on w.user_id = u.uid and w.week_start = p_start),
    'punches', (select coalesce(jsonb_agg(public.tc_punch_json(t) order by t.clock_in), '[]'::jsonb)
                  from public.time_punches t
                 where t.user_id = any (v_users) and public.tc_day_of(t.clock_in) >= p_start and public.tc_day_of(t.clock_in) < v_end));
end $$;

-- Add or fix a punch. p = {id?, user_id?, kind, booking_id?, job_title?, clock_in, clock_out?, note?}
-- View: your own, in weeks not approved. Edit: anyone's, in weeks not approved. Only the open punch may stay
-- without a clock-out. Punches of one person may not overlap.
create function public.timepunch_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_user uuid := coalesce(nullif(p ->> 'user_id', '')::uuid, (select auth.uid()));
  v_kind text := p ->> 'kind';
  v_booking uuid := nullif(p ->> 'booking_id', '')::uuid;
  v_title text := left(btrim(coalesce(p ->> 'job_title', '')), 200);
  v_in timestamptz := date_trunc('minute', nullif(p ->> 'clock_in', '')::timestamptz);
  v_out timestamptz := date_trunc('minute', nullif(p ->> 'clock_out', '')::timestamptz);
  o public.time_punches;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_id is not null then
    select * into o from public.time_punches where id = v_id for update;
    if not found then raise exception 'That time was already removed. Reload the page.'; end if;
    v_user := o.user_id;
  end if;
  if v_user <> v_me and not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_id is null and not exists (select 1 from public.team_members where user_id = v_user and active) then raise exception 'Pick someone on the team.'; end if;
  if v_kind is null or v_kind not in ('job', 'studio', 'admin', 'other') then raise exception 'Pick what the time was for.'; end if;
  if v_kind = 'job' then
    if v_booking is not null and not exists (select 1 from public.bookings where id = v_booking) then raise exception 'Pick the job.'; end if;
    if v_booking is null and v_title = '' then raise exception 'Pick the job.'; end if;
    if v_booking is not null then v_title := left(coalesce(public.schedule_booking_title(v_booking), v_title), 200); end if;
  else
    v_booking := null; v_title := '';
  end if;
  if v_in is null then raise exception 'Fill in the clock-in time.'; end if;
  if v_in > now() + interval '5 minutes' or v_out > now() + interval '5 minutes' then raise exception 'That time has not happened yet.'; end if;
  if v_out is null and not (o.id is not null and o.clock_out is null) then raise exception 'Fill in the clock-out time.'; end if;
  if v_out is not null and v_out <= v_in then raise exception 'Clock-out has to be after clock-in.'; end if;
  if v_out - v_in > interval '24 hours' then raise exception 'One stretch can be at most 24 hours. Split it in two.'; end if;
  if o.id is not null and public.tc_locked(o.user_id, public.tc_day_of(o.clock_in)) then raise exception 'That week is approved. Unapprove it to change it.'; end if;
  if public.tc_locked(v_user, public.tc_day_of(v_in)) then raise exception 'That week is approved. Unapprove it to change it.'; end if;
  if exists (select 1 from public.time_punches t where t.user_id = v_user and t.id is distinct from v_id
              and t.clock_in < coalesce(v_out, 'infinity') and coalesce(t.clock_out, 'infinity') > v_in) then
    raise exception 'That overlaps other time on this timesheet.';
  end if;

  if v_id is not null then
    update public.time_punches
       set kind = v_kind, booking_id = v_booking, job_title = v_title, clock_in = v_in, clock_out = v_out,
           note = left(coalesce(p ->> 'note', note), 500),
           edited = edited or clock_in is distinct from v_in or clock_out is distinct from v_out,
           edited_by = case when clock_in is distinct from v_in or clock_out is distinct from v_out then v_me else edited_by end,
           edited_at = case when clock_in is distinct from v_in or clock_out is distinct from v_out then now() else edited_at end
     where id = v_id;
  else
    insert into public.time_punches (user_id, user_name, kind, booking_id, job_title, clock_in, clock_out, note, edited, edited_by, edited_at)
    values (v_user, coalesce(public.staff_name(v_user), ''), v_kind, v_booking, v_title, v_in, v_out, left(coalesce(p ->> 'note', ''), 500), true, v_me, now())
    returning id into v_id;
  end if;
  if v_kind = 'job' then perform public.tc_add_trip(v_user, v_booking, public.tc_day_of(v_in)); end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function public.timepunch_remove(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.time_punches;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into o from public.time_punches where id = p_id;
  if not found then return jsonb_build_object('ok', false); end if;
  if o.user_id <> (select auth.uid()) and not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if public.tc_locked(o.user_id, public.tc_day_of(o.clock_in)) then raise exception 'That week is approved. Unapprove it to change it.'; end if;
  delete from public.time_punches where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Approve (lock) or unapprove a person's week. A week with someone still clocked in can't be approved.
create function public.timesheet_approve(p_user uuid, p_week date, p_approve boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_week date := public.tc_week_of(p_week);
begin
  if not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user is null or v_week is null then raise exception 'pick a person and a week'; end if;
  if coalesce(p_approve, true) then
    if exists (select 1 from public.time_punches t where t.user_id = p_user and t.clock_out is null
                and public.tc_day_of(t.clock_in) >= v_week and public.tc_day_of(t.clock_in) < v_week + 7) then
      raise exception 'They are still clocked in that week. Clock them out (fix the time) first.';
    end if;
    insert into public.timesheet_weeks (user_id, week_start, approved_by, approved_at, worked_min, miles)
    values (p_user, v_week, (select auth.uid()), now(),
            (select coalesce(sum(public.tc_minutes(t)), 0) from public.time_punches t
              where t.user_id = p_user and public.tc_day_of(t.clock_in) >= v_week and public.tc_day_of(t.clock_in) < v_week + 7),
            (select coalesce(sum(r.miles), 0) from public.mileage_trips r where r.user_id = p_user and r.day >= v_week and r.day < v_week + 7))
    on conflict (user_id, week_start) do nothing;
  else
    delete from public.timesheet_weeks where user_id = p_user and week_start = v_week;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Payroll for p_weeks weeks from the Sunday of p_start: per person regular / overtime minutes (overtime per
-- week, after timeclock_settings.overtime_after hours), miles and mileage pay, and whether every week with
-- time is approved; plus every punch, for the detail CSV. Edit only.
create function public.timesheet_payroll(p_start date, p_weeks int default 1)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date := public.tc_week_of(p_start);
  v_to date;
  s public.timeclock_settings;
begin
  if not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_from is null then raise exception 'pick a week'; end if;
  v_to := v_from + 7 * greatest(1, least(coalesce(p_weeks, 1), 6));
  select * into s from public.timeclock_settings where id;
  return jsonb_build_object(
    'from', v_from, 'to', v_to - 1, 'mileage_rate', s.mileage_rate, 'overtime_after', s.overtime_after,
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
                  'user_id', x.user_id, 'name', public.tc_name(x.user_id, x.user_name),
                  'email', (select u.email from auth.users u where u.id = x.user_id),
                  'worked_min', x.worked, 'overtime_min', x.ot, 'regular_min', x.worked - x.ot,
                  'miles', x.miles, 'mileage_pay', round(x.miles * s.mileage_rate, 2),
                  'weeks', x.weeks, 'approved_weeks', x.approved, 'open', x.open)
                  order by lower(public.tc_name(x.user_id, x.user_name))), '[]'::jsonb)
                 from (select u.user_id, u.user_name,
                              coalesce(sum(wk.worked), 0)::int as worked,
                              coalesce(sum(greatest(0, wk.worked - round(s.overtime_after * 60))), 0)::int as ot,
                              coalesce((select sum(r.miles) from public.mileage_trips r where r.user_id = u.user_id and r.day >= v_from and r.day < v_to), 0) as miles,
                              count(wk.week) filter (where wk.worked > 0) as weeks,
                              count(wk.week) filter (where wk.worked > 0 and exists (select 1 from public.timesheet_weeks a where a.user_id = u.user_id and a.week_start = wk.week)) as approved,
                              bool_or(wk.open) as open
                         from (select y.user_id, max(y.user_name) as user_name
                                 from (select t.user_id, t.user_name from public.time_punches t where public.tc_day_of(t.clock_in) >= v_from and public.tc_day_of(t.clock_in) < v_to
                                       union all select r.user_id, r.user_name from public.mileage_trips r where r.day >= v_from and r.day < v_to) y
                                group by y.user_id) u
                         left join lateral (select public.tc_week_of(public.tc_day_of(t.clock_in)) as week, sum(public.tc_minutes(t))::int as worked, bool_or(t.clock_out is null) as open
                                              from public.time_punches t
                                             where t.user_id = u.user_id and public.tc_day_of(t.clock_in) >= v_from and public.tc_day_of(t.clock_in) < v_to
                                             group by 1) wk on true
                        group by u.user_id, u.user_name) x),
    'punches', (select coalesce(jsonb_agg(public.tc_punch_json(t) || jsonb_build_object('name', public.tc_name(t.user_id, t.user_name)) order by lower(public.tc_name(t.user_id, t.user_name)), t.clock_in), '[]'::jsonb)
                  from public.time_punches t where public.tc_day_of(t.clock_in) >= v_from and public.tc_day_of(t.clock_in) < v_to));
end $$;

create function public.timeclock_settings_save(p_rate numeric, p_overtime numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_rate is null or p_rate < 0 or p_rate > 5 then raise exception 'The mileage rate is $0 to $5 a mile.'; end if;
  if p_overtime is null or p_overtime < 0 or p_overtime > 80 then raise exception 'Overtime starts after 0 to 80 hours a week.'; end if;
  update public.timeclock_settings set mileage_rate = round(p_rate, 3), overtime_after = round(p_overtime, 1), updated_at = now() where id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- mileage
-- One month of trips (p_month = any day in it). Default: mine; p_all = everyone (Edit). Trips whose miles
-- were never looked up carry est_miles when the drive-time cache has it now, and needs_lookup otherwise.
create function public.mileage_list(p_month date, p_all boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_from date := date_trunc('month', coalesce(p_month, (now() at time zone 'America/New_York')::date))::date;
  v_all boolean := coalesce(p_all, false);
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_all and not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'can_edit', public.can('timeclock', 'edit'), 'me', v_me, 'month', v_from,
    'mileage_rate', (select mileage_rate from public.timeclock_settings where id),
    'studio_address', (select studio_address from public.staff_settings where id),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('booking_id', x.booking_id, 'day', x.day, 'title', x.title)
                                       order by x.day, x.start_at nulls first, x.title), '[]'::jsonb)
               from public.schedule_booking_days(v_from, (v_from + interval '1 month')::date) x),
    'trips', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'user_id', r.user_id, 'name', public.tc_name(r.user_id, r.user_name),
                 'booking_id', r.booking_id, 'job_title', coalesce(case when r.booking_id is not null then public.schedule_booking_title(r.booking_id) end, r.job_title),
                 'location', case when r.booking_id is not null then public.schedule_destination(r.booking_id) end,
                 'day', r.day, 'miles', r.miles, 'auto', r.auto, 'note', r.note,
                 'est_miles', case when r.miles is null and r.booking_id is not null then public.mileage_estimate(r.booking_id) end,
                 'locked', public.tc_locked(r.user_id, r.day))
                 order by r.day, lower(public.tc_name(r.user_id, r.user_name))), '[]'::jsonb)
                from public.mileage_trips r
               where r.day >= v_from and r.day < (v_from + interval '1 month')::date and (v_all or r.user_id = v_me)));
end $$;

-- Add or change a trip. p = {id?, user_id?, booking_id?, day, miles, note?}. Own with View, anyone's with Edit.
create function public.mileage_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_user uuid := coalesce(nullif(p ->> 'user_id', '')::uuid, (select auth.uid()));
  v_booking uuid := nullif(p ->> 'booking_id', '')::uuid;
  v_day date := nullif(p ->> 'day', '')::date;
  v_miles numeric := round(nullif(p ->> 'miles', '')::numeric, 1);
  v_note text := left(btrim(coalesce(p ->> 'note', '')), 300);
  o public.mileage_trips;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_id is not null then
    select * into o from public.mileage_trips where id = v_id for update;
    if not found then raise exception 'That trip was already removed. Reload the page.'; end if;
    v_user := o.user_id;
    if not p ? 'booking_id' then v_booking := o.booking_id; end if;
  end if;
  if v_user <> v_me and not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_id is null and not exists (select 1 from public.team_members where user_id = v_user and active) then raise exception 'Pick someone on the team.'; end if;
  if v_day is null then raise exception 'Pick the day.'; end if;
  if v_day > (now() at time zone 'America/New_York')::date + 1 then raise exception 'That day has not happened yet.'; end if;
  if v_miles is null or v_miles < 0 or v_miles > 2000 then raise exception 'Miles is 0 to 2000.'; end if;
  if v_booking is not null and not exists (select 1 from public.bookings where id = v_booking) then raise exception 'Pick the job.'; end if;
  if v_booking is null and v_note = '' then raise exception 'Say where you drove.'; end if;
  if o.id is not null and public.tc_locked(o.user_id, o.day) then raise exception 'That week is approved. Unapprove it to change it.'; end if;
  if public.tc_locked(v_user, v_day) then raise exception 'That week is approved. Unapprove it to change it.'; end if;
  if v_booking is not null and exists (select 1 from public.mileage_trips r where r.user_id = v_user and r.booking_id = v_booking and r.day = v_day and r.id is distinct from v_id) then
    raise exception 'That job already has a trip that day. Change that one.';
  end if;
  if v_id is not null then
    update public.mileage_trips
       set booking_id = v_booking, day = v_day, note = v_note, updated_at = now(),
           auto = auto and miles is not distinct from v_miles and booking_id is not distinct from v_booking,
           job_title = left(coalesce(case when v_booking is not null then public.schedule_booking_title(v_booking) end, job_title), 200),
           miles = v_miles
     where id = v_id;
  else
    insert into public.mileage_trips (user_id, user_name, booking_id, job_title, day, miles, auto, note, created_by)
    values (v_user, coalesce(public.staff_name(v_user), ''), v_booking, left(coalesce(public.schedule_booking_title(v_booking), ''), 200), v_day, v_miles, false, v_note, v_me)
    returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function public.mileage_remove(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.mileage_trips;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into o from public.mileage_trips where id = p_id;
  if not found then return jsonb_build_object('ok', false); end if;
  if o.user_id <> (select auth.uid()) and not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if public.tc_locked(o.user_id, o.day) then raise exception 'That week is approved. Unapprove it to change it.'; end if;
  delete from public.mileage_trips where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Fill in miles that were not looked up when the trip was made (the page asks the drive-time function first).
create function public.mileage_refresh(p_month date, p_all boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_from date := date_trunc('month', coalesce(p_month, (now() at time zone 'America/New_York')::date))::date;
  v_n int;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_all, false) and not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.mileage_trips r set miles = public.mileage_estimate(r.booking_id), updated_at = now()
   where r.miles is null and r.auto and r.booking_id is not null
     and r.day >= v_from and r.day < (v_from + interval '1 month')::date
     and (coalesce(p_all, false) or r.user_id = (select auth.uid()))
     and not public.tc_locked(r.user_id, r.day)
     and public.mileage_estimate(r.booking_id) is not null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'filled', v_n);
end $$;

-- Add a trip for every job bar on the Schedule in the month that has none yet (mine, or everyone's with p_all).
create function public.mileage_from_schedule(p_month date, p_all boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_from date := date_trunc('month', coalesce(p_month, (now() at time zone 'America/New_York')::date))::date;
  v_to date;
  v_n int := 0; r record;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_all, false) and not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  v_to := least((v_from + interval '1 month')::date, (now() at time zone 'America/New_York')::date + 1);
  for r in select distinct e.user_id, e.booking_id, public.tc_day_of(e.starts_at) as day
             from public.schedule_entries e
             join public.bookings b on b.id = e.booking_id and b.status <> 'cancelled'
             join public.team_members m on m.user_id = e.user_id and m.active
            where e.kind = 'job' and public.tc_day_of(e.starts_at) >= v_from and public.tc_day_of(e.starts_at) < v_to
              and (coalesce(p_all, false) or e.user_id = (select auth.uid()))
              and not exists (select 1 from public.mileage_trips t where t.user_id = e.user_id and t.booking_id = e.booking_id and t.day = public.tc_day_of(e.starts_at)) loop
    if not public.tc_locked(r.user_id, r.day) then
      perform public.tc_add_trip(r.user_id, r.booking_id, r.day);
      v_n := v_n + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'added', v_n);
end $$;

-- ---------------------------------------------------------------- Today
-- open_long: still clocked in after 12 hours (mine; everyone's with Edit).
-- to_approve (Edit): people with time last week whose week isn't approved.
create function public.timeclock_attention()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_edit boolean := public.can('timeclock', 'edit');
  v_last date := public.tc_week_of((now() at time zone 'America/New_York')::date) - 7;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'open_long', (select count(*) from public.time_punches t where t.clock_out is null and t.clock_in < now() - interval '12 hours'
                   and (v_edit or t.user_id = (select auth.uid()))),
    'to_approve', case when v_edit then (select count(distinct t.user_id) from public.time_punches t
                    where public.tc_day_of(t.clock_in) >= v_last and public.tc_day_of(t.clock_in) < v_last + 7
                      and not exists (select 1 from public.timesheet_weeks w where w.user_id = t.user_id and w.week_start = v_last)) else 0 end,
    'last_week', v_last);
end $$;

-- ---------------------------------------------------------------- drive time: the Mileage page may look up a job's distance too
create or replace function public.drive_time_target(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_origin text; v_dest text; c public.drive_time_cache;
begin
  if not (public.can('scheduling', 'edit') or public.can('timeclock', 'view')) then raise exception 'not allowed' using errcode = '42501'; end if;
  select btrim(studio_address) into v_origin from public.staff_settings where id;
  v_dest := public.schedule_destination(p_booking);
  if coalesce(v_origin, '') = '' then return jsonb_build_object('ok', false, 'error', 'Add the studio address on the Schedule page first.'); end if;
  if v_dest is null then return jsonb_build_object('ok', false, 'error', 'This job has no address. Add a location on the booking.'); end if;
  select * into c from public.drive_time_cache where destination = lower(v_dest) and origin = lower(v_origin) and fetched_at > now() - interval '180 days';
  return jsonb_build_object('ok', true, 'origin', v_origin, 'destination', v_dest, 'minutes', c.minutes, 'meters', c.meters);
end $$;

create or replace function public.drive_time_store(p_origin text, p_destination text, p_minutes int, p_meters int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not (public.can('scheduling', 'edit') or public.can('timeclock', 'view')) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_minutes is null or p_minutes not between 0 and 1440 or coalesce(p_destination, '') = '' then raise exception 'bad drive time'; end if;
  if not exists (select 1 from public.staff_settings where id and lower(btrim(studio_address)) = lower(btrim(p_origin))) then
    return jsonb_build_object('ok', false);   -- the studio address changed meanwhile
  end if;
  insert into public.drive_time_cache (destination, origin, minutes, meters)
  values (lower(btrim(p_destination)), lower(btrim(p_origin)), p_minutes, p_meters)
  on conflict (destination) do update set origin = excluded.origin, minutes = excluded.minutes, meters = excluded.meters, fetched_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function public.timeclock_status(), public.timeclock_in(text, uuid, text), public.timeclock_out(text),
  public.timesheet_week(date, uuid, boolean), public.timepunch_save(jsonb), public.timepunch_remove(uuid),
  public.timesheet_approve(uuid, date, boolean), public.timesheet_payroll(date, int), public.timeclock_settings_save(numeric, numeric),
  public.mileage_list(date, boolean), public.mileage_save(jsonb), public.mileage_remove(uuid), public.mileage_refresh(date, boolean),
  public.mileage_from_schedule(date, boolean), public.timeclock_attention() from public, anon;
grant execute on function public.timeclock_status(), public.timeclock_in(text, uuid, text), public.timeclock_out(text),
  public.timesheet_week(date, uuid, boolean), public.timepunch_save(jsonb), public.timepunch_remove(uuid),
  public.timesheet_approve(uuid, date, boolean), public.timesheet_payroll(date, int), public.timeclock_settings_save(numeric, numeric),
  public.mileage_list(date, boolean), public.mileage_save(jsonb), public.mileage_remove(uuid), public.mileage_refresh(date, boolean),
  public.mileage_from_schedule(date, boolean), public.timeclock_attention() to authenticated;
