-- Time clock, round two (2026-10-23). Builds on 20261022213200_timeclock_mileage and 20261023090000_employment_type.
--
--   Location      clocking in or out can carry the phone's location (lat, lng, accuracy in meters). The page asks
--                 only when "Ask for location" is on (Settings), and a refused or slow location never blocks the
--                 clock. Only the person and Time clock Edit see it (timesheets, with a map link).
--   Reminders     a push 15 minutes before a scheduled bar starts (drive time included) if they aren't clocked in,
--                 and one 30 minutes after their last bar ended if they are still clocked in. Push only, no texts.
--                 Bars of bookings that aren't booked are left out; time off and flex time get no reminder.
--   Auto clock-out  a clock still running at midnight (Eastern) is closed at midnight and flagged "check this".
--                 Fixing or saving the punch clears the flag; a week with a flagged punch can't be approved.
--   Expenses      receipts (photo, amount, what for, job), approved one by one by Time clock Edit, separately
--                 from the week. Approved expenses in the pay period go on the payroll CSV as reimbursements.
--                 Photos in the private `receipts` bucket, one folder per person.
--   Pay rates     hourly or day rate (with an optional half-day rate under N hours), set per employment type, per
--                 job title, or per person (person wins, then title, then type). Gives an estimated pay on the
--                 payroll (overtime at 1.5x for hourly people overtime applies to) and on your own timesheet.
--                 Rates are seen and set only with Time clock Edit; a person sees only their own estimate.
--   Overtime warning  a push to the person and to Time clock Edit people when someone is within N hours of overtime
--                 this week (worked so far, or worked plus what is still on the schedule), and again when they go
--                 over. Once per person per week per level. Salaried and 1099 people get none.
--
-- Everything time-based runs from timeclock_tick() every 5 minutes.

-- ---------------------------------------------------------------- settings
alter table public.timeclock_settings
  add column gps_on boolean not null default true,
  add column remind_before_min int not null default 15 check (remind_before_min between 0 and 120),
  add column remind_out_after_min int not null default 30 check (remind_out_after_min between 0 and 240),
  add column auto_out boolean not null default true,
  add column ot_warn_hours numeric(4,1) not null default 4 check (ot_warn_hours between 0 and 40),
  add column half_day_hours numeric(3,1) not null default 5 check (half_day_hours between 1 and 12);
comment on column public.timeclock_settings.gps_on is 'Ask the phone for its location when people clock in and out.';
comment on column public.timeclock_settings.remind_before_min is 'Push this many minutes before a scheduled bar starts (0 = off).';
comment on column public.timeclock_settings.remind_out_after_min is 'Push this many minutes after the last bar ended while still clocked in (0 = off).';
comment on column public.timeclock_settings.auto_out is 'Close clocks still running at midnight (Eastern) and flag them for review.';
comment on column public.timeclock_settings.ot_warn_hours is 'Warn when someone is this many hours from overtime in a week (0 = off).';
comment on column public.timeclock_settings.half_day_hours is 'Day-rate people working fewer hours than this in a day get the half-day rate (when one is set).';

-- ---------------------------------------------------------------- punches: location + auto clock-out
alter table public.time_punches
  add column in_lat  numeric(9,6) check (in_lat between -90 and 90),
  add column in_lng  numeric(9,6) check (in_lng between -180 and 180),
  add column in_acc  int check (in_acc between 0 and 100000),
  add column out_lat numeric(9,6) check (out_lat between -90 and 90),
  add column out_lng numeric(9,6) check (out_lng between -180 and 180),
  add column out_acc int check (out_acc between 0 and 100000),
  add column auto_out boolean not null default false,
  add column needs_review boolean not null default false;
comment on column public.time_punches.auto_out is 'The clock-out was filled in automatically at midnight.';
comment on column public.time_punches.needs_review is 'Someone should check this punch (auto clock-out). Cleared when the punch is saved.';
create index time_punches_review_idx on public.time_punches (user_id) where needs_review;

-- Location from the page: {lat, lng, acc}. Anything odd = no location (never an error: it must not block the clock).
create function public.tc_loc(p jsonb, p_key text) returns numeric
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p -> 'lat') = 'number' and jsonb_typeof(p -> 'lng') = 'number'
               and (p ->> 'lat')::numeric between -90 and 90 and (p ->> 'lng')::numeric between -180 and 180 then
           case p_key when 'lat' then round((p ->> 'lat')::numeric, 6) when 'lng' then round((p ->> 'lng')::numeric, 6)
                      when 'acc' then case when jsonb_typeof(p -> 'acc') = 'number' then least(greatest((p ->> 'acc')::numeric, 0), 100000) end end end
$$;

-- ---------------------------------------------------------------- reminder / warning logs
create table public.timeclock_reminders (
  entry_id uuid not null,
  kind     text not null check (kind in ('in', 'out')),
  user_id  uuid not null,
  sent_at  timestamptz not null default now(),
  primary key (entry_id, kind)
);
comment on table public.timeclock_reminders is 'Clock-in / clock-out reminders already pushed, one per schedule bar (kept 30 days).';

create table public.timeclock_ot_warnings (
  user_id    uuid not null,
  week_start date not null,
  level      text not null check (level in ('near', 'over')),
  worked_min int not null,
  sent_at    timestamptz not null default now(),
  primary key (user_id, week_start, level)
);
comment on table public.timeclock_ot_warnings is 'Overtime warnings already pushed: near = within ot_warn_hours (or scheduled past overtime), over = past it.';

-- ---------------------------------------------------------------- expenses
create table public.timeclock_expenses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  user_name    text not null default '',
  day          date not null,
  amount       numeric(8,2) not null check (amount > 0 and amount <= 10000),
  category     text not null check (category in ('supplies', 'meals', 'parking', 'tolls', 'gear', 'other')),
  booking_id   uuid references public.bookings (id) on delete set null,
  job_title    text not null default '' check (length(job_title) <= 200),
  note         text not null default '' check (length(note) <= 300),
  receipt_path text check (receipt_path is null or length(receipt_path) <= 300),
  status       text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  review_note  text not null default '' check (length(review_note) <= 300),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table public.timeclock_expenses is 'Out-of-pocket expenses with a receipt photo. Approved one by one (not with the week); approved ones are reimbursed on the payroll CSV. user_id has no foreign key on purpose, like time_punches.';
create index timeclock_expenses_day_idx on public.timeclock_expenses (day);
create index timeclock_expenses_user_idx on public.timeclock_expenses (user_id, day);
create index timeclock_expenses_open_idx on public.timeclock_expenses (created_at) where status = 'submitted';

-- ---------------------------------------------------------------- pay rates
create table public.timeclock_pay_rates (
  id            uuid primary key default gen_random_uuid(),
  scope         text not null check (scope in ('type', 'title', 'person')),
  scope_key     text not null check (btrim(scope_key) <> '' and length(scope_key) <= 80),   -- employment type / lower(job title) / user_id
  basis         text not null check (basis in ('hourly', 'day')),
  rate          numeric(8,2) not null check (rate between 0 and 10000),
  half_day_rate numeric(8,2) check (half_day_rate between 0 and 10000),
  updated_by    uuid,
  updated_at    timestamptz not null default now(),
  unique (scope, scope_key),
  check (scope <> 'type' or scope_key in ('full_time', 'salaried', 'part_time', 'contractor')),
  check (basis = 'day' or half_day_rate is null)
);
comment on table public.timeclock_pay_rates is 'Pay rates for estimated pay. A person''s own rate wins, then their job title''s, then their employment type''s. Time clock Edit only.';

alter table public.timeclock_reminders   enable row level security;
alter table public.timeclock_ot_warnings enable row level security;
alter table public.timeclock_expenses    enable row level security;
alter table public.timeclock_pay_rates   enable row level security;
revoke all on public.timeclock_reminders, public.timeclock_ot_warnings, public.timeclock_expenses, public.timeclock_pay_rates from anon, authenticated;

-- ---------------------------------------------------------------- push topics
insert into public.push_topics (key, label, description, module, sort) values
  ('clock_reminder',   'Clock in and out reminders', 'Before your scheduled time starts, when you are still clocked in after it ended, and when your clock was stopped at midnight.', 'timeclock', 90),
  ('overtime_warning', 'Overtime warning',           'You (or, for managers, someone on the team) are close to overtime this week.', 'timeclock', 91),
  ('expense_update',   'Expenses',                   'An expense was approved or sent back (yours), or is waiting for approval (managers).', 'timeclock', 92)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- helpers (internal)
-- Push to one person if they can see the time clock, have a device and haven't switched this kind off.
create function public.tc_push(p_uid uuid, p_topic text, p_title text, p_body text, p_url text, p_tag text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.team_user_can(p_uid, 'timeclock') then return; end if;
  if not exists (select 1 from public.push_subscriptions s where s.user_id = p_uid) then return; end if;
  if not coalesce((select p.enabled from public.push_prefs p where p.user_id = p_uid and p.topic = p_topic),
                  (select t.default_on from public.push_topics t where t.key = p_topic), false) then return; end if;
  perform public.push_notify(p_topic, p_title, p_body, p_url, p_tag, p_uid);
exception when others then
  raise warning 'tc_push failed: %', sqlerrm;
end $$;

-- People who manage time (Time clock Edit, or full access) and are active.
create function public.tc_managers() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id from public.team_members m
   where m.active
     and (exists (select 1 from public.admin_users a where a.user_id = m.user_id)
          or exists (select 1 from public.team_permissions p where p.user_id = m.user_id and p.module_key = 'timeclock' and p.level = 'edit'))
$$;

-- The rate that applies to a person: their own, else their job title's, else their employment type's.
create function public.tc_rate_for(p_user uuid)
returns table (basis text, rate numeric, half_day_rate numeric, source text)
language sql stable security definer set search_path = '' as $$
  select r.basis, r.rate, r.half_day_rate, r.scope
    from public.timeclock_pay_rates r
    left join public.team_members m on m.user_id = p_user
   where (r.scope = 'person' and r.scope_key = p_user::text)
      or (r.scope = 'title' and m.job_title <> '' and r.scope_key = lower(btrim(m.job_title)))
      or (r.scope = 'type' and r.scope_key = m.employment_type)
   order by case r.scope when 'person' then 0 when 'title' then 1 else 2 end
   limit 1
$$;

-- Estimated pay for worked time in [p_from, p_to) (whole weeks for overtime). Hourly: regular + overtime at 1.5x
-- (only when overtime applies to them). Day: a day rate per day with time, the half-day rate under half_day_hours.
-- Null when no rate applies.
create function public.tc_pay_estimate(p_user uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r record; s public.timeclock_settings;
  v_reg int := 0; v_ot int := 0; v_full int := 0; v_half int := 0; v_pay numeric := 0;
  v_ot_applies boolean := public.overtime_applies(p_user);
begin
  select * into r from public.tc_rate_for(p_user);
  if r.basis is null then return null; end if;
  select * into s from public.timeclock_settings where id;
  if r.basis = 'hourly' then
    select coalesce(sum(case when v_ot_applies then least(w.m, round(s.overtime_after * 60)) else w.m end), 0),
           coalesce(sum(case when v_ot_applies then greatest(0, w.m - round(s.overtime_after * 60)) else 0 end), 0)
      into v_reg, v_ot
      from (select public.tc_week_of(public.tc_day_of(t.clock_in)) as wk, sum(public.tc_minutes(t))::int as m
              from public.time_punches t
             where t.user_id = p_user and public.tc_day_of(t.clock_in) >= p_from and public.tc_day_of(t.clock_in) < p_to
             group by 1) w;
    v_pay := round(v_reg / 60.0 * r.rate + v_ot / 60.0 * r.rate * 1.5, 2);
  else
    select count(*) filter (where r.half_day_rate is null or d.m >= round(s.half_day_hours * 60)),
           count(*) filter (where r.half_day_rate is not null and d.m < round(s.half_day_hours * 60))
      into v_full, v_half
      from (select public.tc_day_of(t.clock_in) as day, sum(public.tc_minutes(t))::int as m
              from public.time_punches t
             where t.user_id = p_user and public.tc_day_of(t.clock_in) >= p_from and public.tc_day_of(t.clock_in) < p_to
             group by 1 having sum(public.tc_minutes(t)) > 0) d;
    v_pay := round(v_full * r.rate + v_half * coalesce(r.half_day_rate, 0), 2);
  end if;
  return jsonb_build_object('basis', r.basis, 'rate', r.rate, 'half_day_rate', r.half_day_rate, 'source', r.source,
                            'regular_min', v_reg, 'overtime_min', v_ot, 'days', v_full, 'half_days', v_half, 'pay', v_pay);
end $$;

-- Approved expenses in [p_from, p_to).
create function public.tc_expenses_total(p_user uuid, p_from date, p_to date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(e.amount), 0) from public.timeclock_expenses e
   where e.user_id = p_user and e.status = 'approved' and e.day >= p_from and e.day < p_to
$$;

-- Minutes worked this week (Eastern, Sunday start), the open punch counted up to now, and minutes still on the
-- schedule from now to the end of the week (time off and flex left out; bookings that aren't booked left out).
create function public.tc_week_load(p_user uuid)
returns table (week_start date, worked_min int, ahead_min int)
language sql stable security definer set search_path = '' as $$
  with w as (select public.tc_week_of((now() at time zone 'America/New_York')::date) as ws)
  select w.ws,
         (select coalesce(sum(public.tc_minutes(t)), 0)::int from public.time_punches t
           where t.user_id = p_user and public.tc_day_of(t.clock_in) >= w.ws and public.tc_day_of(t.clock_in) < w.ws + 7),
         (select coalesce(sum(extract(epoch from (e.ends_at + make_interval(mins => e.drive_after_min))
                                - greatest(now(), e.starts_at - make_interval(mins => e.drive_before_min))) / 60), 0)::int
            from public.schedule_entries e
           where e.user_id = p_user and e.kind not in ('off', 'flex')
             and e.ends_at + make_interval(mins => e.drive_after_min) > now()
             and e.starts_at - make_interval(mins => e.drive_before_min) < (w.ws + 7)::timestamp at time zone 'America/New_York'
             and (e.booking_id is null or exists (select 1 from public.bookings b where b.id = e.booking_id and b.status = 'booked')))
    from w
$$;

revoke all on function public.tc_loc(jsonb, text), public.tc_push(uuid, text, text, text, text, text), public.tc_managers(), public.tc_rate_for(uuid),
  public.tc_pay_estimate(uuid, date, date), public.tc_expenses_total(uuid, date, date), public.tc_week_load(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- punch JSON: location + review flag
create or replace function public.tc_punch_json(p public.time_punches) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'user_id', p.user_id, 'kind', p.kind, 'booking_id', p.booking_id,
    'job_title', coalesce(case when p.booking_id is not null then public.schedule_booking_title(p.booking_id) end, nullif(p.job_title, ''), ''),
    'clock_in', p.clock_in, 'clock_out', p.clock_out, 'day', public.tc_day_of(p.clock_in), 'minutes', public.tc_minutes(p), 'note', p.note,
    'edited', p.edited, 'edited_by', case when p.edited_by is not null then public.staff_name(p.edited_by) end,
    'locked', public.tc_locked(p.user_id, public.tc_day_of(p.clock_in)),
    'in_loc', case when p.in_lat is not null then jsonb_build_object('lat', p.in_lat, 'lng', p.in_lng, 'acc', p.in_acc) end,
    'out_loc', case when p.out_lat is not null then jsonb_build_object('lat', p.out_lat, 'lng', p.out_lng, 'acc', p.out_acc) end,
    'auto_out', p.auto_out, 'needs_review', p.needs_review)
$$;

-- ---------------------------------------------------------------- clock in / out with location
-- Same as before, plus p_loc = {lat, lng, acc} (optional). The old 3-argument and 1-argument calls still work.
drop function public.timeclock_in(text, uuid, text);
create function public.timeclock_in(p_kind text, p_booking uuid default null, p_note text default '', p_loc jsonb default null)
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
    update public.time_punches set clock_out = greatest(v_now, clock_in + interval '1 minute'),
           out_lat = public.tc_loc(p_loc, 'lat'), out_lng = public.tc_loc(p_loc, 'lng'), out_acc = round(public.tc_loc(p_loc, 'acc'))::int
     where id = o.id returning * into o;
  end if;
  insert into public.time_punches (user_id, user_name, kind, booking_id, job_title, clock_in, note, in_lat, in_lng, in_acc)
  values (v_me, coalesce(public.staff_name(v_me), ''), p_kind, p_booking, left(coalesce(public.schedule_booking_title(p_booking), ''), 200),
          coalesce(o.clock_out, v_now), left(btrim(coalesce(p_note, '')), 500),
          public.tc_loc(p_loc, 'lat'), public.tc_loc(p_loc, 'lng'), round(public.tc_loc(p_loc, 'acc'))::int)
  returning id into v_id;
  if p_kind = 'job' then perform public.tc_add_trip(v_me, p_booking, v_today); end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'switched', o.id is not null);
end $$;

drop function public.timeclock_out(text);
create function public.timeclock_out(p_note text default '', p_loc jsonb default null)
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
         note = left(concat_ws(' / ', nullif(note, ''), nullif(btrim(coalesce(p_note, '')), '')), 500),
         out_lat = public.tc_loc(p_loc, 'lat'), out_lng = public.tc_loc(p_loc, 'lng'), out_acc = round(public.tc_loc(p_loc, 'acc'))::int
   where id = o.id returning * into o;
  return jsonb_build_object('ok', true, 'minutes', public.tc_minutes(o));
end $$;

-- ---------------------------------------------------------------- patch existing functions
create function pg_temp.patch_function(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

-- Clock page: the settings the phone needs, and overtime for me.
select pg_temp.patch_function('public.timeclock_status()'::regprocedure,
  '''me'', v_me,',
  '''me'', v_me, ''gps'', (select gps_on from public.timeclock_settings where id), ''overtime_after'', (select overtime_after from public.timeclock_settings where id), ''overtime_applies'', public.overtime_applies(v_me), ''review'', (select count(*) from public.time_punches t where t.user_id = v_me and t.needs_review),', 1);

-- Saving a punch (any change) means someone looked at it.
select pg_temp.patch_function('public.timepunch_save(jsonb)'::regprocedure,
  'set kind = v_kind, booking_id = v_booking,', 'set needs_review = false, kind = v_kind, booking_id = v_booking,', 1);

-- A week with a punch to check can't be approved.
select pg_temp.patch_function('public.timesheet_approve(uuid, date, boolean)'::regprocedure,
  '(Clock them out \(fix the time\) first\.'';\s*end if;)',
  E'\\1\n    if exists (select 1 from public.time_punches t where t.user_id = p_user and t.needs_review\n                and public.tc_day_of(t.clock_in) >= v_week and public.tc_day_of(t.clock_in) < v_week + 7) then\n      raise exception ''A clock-out that week was filled in at midnight. Check the time and save it first.'';\n    end if;', 1);

-- Timesheet week: estimated pay per person (theirs only, or everyone's with Edit: the same people the week shows).
select pg_temp.patch_function('public.timesheet_week(date, uuid, boolean)'::regprocedure,
  '''approved_min'', w\.worked_min\)',
  '''approved_min'', w.worked_min, ''pay'', public.tc_pay_estimate(u.uid, p_start, v_end), ''expenses'', public.tc_expenses_total(u.uid, p_start, v_end), ''review'', (select count(*) from public.time_punches t where t.user_id = u.uid and t.needs_review and public.tc_day_of(t.clock_in) >= p_start and public.tc_day_of(t.clock_in) < v_end))', 1);

-- Payroll: estimated pay and approved expenses per person; people with only expenses are listed too; every
-- approved expense for the detail CSV.
select pg_temp.patch_function('public.timesheet_payroll(date, integer)'::regprocedure,
  '''weeks'', x\.weeks,',
  '''weeks'', x.weeks, ''pay'', public.tc_pay_estimate(x.user_id, v_from, v_to), ''expenses'', public.tc_expenses_total(x.user_id, v_from, v_to),', 1);
select pg_temp.patch_function('public.timesheet_payroll(date, integer)'::regprocedure,
  '(union all select r\.user_id, r\.user_name from public\.mileage_trips r where r\.day >= v_from and r\.day < v_to)\)',
  E'\\1\n                                       union all select e.user_id, e.user_name from public.timeclock_expenses e where e.status = ''approved'' and e.day >= v_from and e.day < v_to)', 1);
select pg_temp.patch_function('public.timesheet_payroll(date, integer)'::regprocedure,
  '''from'', v_from, ''to'', v_to - 1,',
  '''from'', v_from, ''to'', v_to - 1, ''expense_rows'', (select coalesce(jsonb_agg(public.tc_expense_json(e) order by lower(public.tc_name(e.user_id, e.user_name)), e.day), ''[]''::jsonb) from public.timeclock_expenses e where e.status = ''approved'' and e.day >= v_from and e.day < v_to),', 1);

-- Today: punches to check, expenses waiting (Edit), people near overtime (Edit).
select pg_temp.patch_function('public.timeclock_attention()'::regprocedure,
  '''last_week'', v_last\);',
  E'''last_week'', v_last,\n    ''review'', (select count(*) from public.time_punches t where t.needs_review and (v_edit or t.user_id = (select auth.uid()))),\n    ''expenses'', case when v_edit then (select count(*) from public.timeclock_expenses e where e.status = ''submitted'') else 0 end,\n    ''near_ot'', case when v_edit then (select count(distinct o.user_id) from public.timeclock_ot_warnings o where o.week_start = public.tc_week_of((now() at time zone ''America/New_York'')::date)) else 0 end);', 1);

-- ---------------------------------------------------------------- settings
drop function public.timeclock_settings_save(numeric, numeric);
create function public.timeclock_settings_save(p_rate numeric, p_overtime numeric, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.timeclock_settings;
begin
  if not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_rate is null or p_rate < 0 or p_rate > 5 then raise exception 'The mileage rate is $0 to $5 a mile.'; end if;
  if p_overtime is null or p_overtime < 0 or p_overtime > 80 then raise exception 'Overtime starts after 0 to 80 hours a week.'; end if;
  select * into s from public.timeclock_settings where id;
  p := coalesce(p, '{}'::jsonb);
  if coalesce((p ->> 'remind_before_min')::int, s.remind_before_min) not between 0 and 120 then raise exception 'The clock-in reminder is 0 to 120 minutes before.'; end if;
  if coalesce((p ->> 'remind_out_after_min')::int, s.remind_out_after_min) not between 0 and 240 then raise exception 'The clock-out reminder is 0 to 240 minutes after.'; end if;
  if coalesce((p ->> 'ot_warn_hours')::numeric, s.ot_warn_hours) not between 0 and 40 then raise exception 'Warn 0 to 40 hours before overtime.'; end if;
  if coalesce((p ->> 'half_day_hours')::numeric, s.half_day_hours) not between 1 and 12 then raise exception 'A half day is under 1 to 12 hours.'; end if;
  update public.timeclock_settings
     set mileage_rate = round(p_rate, 3), overtime_after = round(p_overtime, 1),
         gps_on = coalesce((p ->> 'gps_on')::boolean, gps_on),
         remind_before_min = coalesce((p ->> 'remind_before_min')::int, remind_before_min),
         remind_out_after_min = coalesce((p ->> 'remind_out_after_min')::int, remind_out_after_min),
         auto_out = coalesce((p ->> 'auto_out')::boolean, auto_out),
         ot_warn_hours = round(coalesce((p ->> 'ot_warn_hours')::numeric, ot_warn_hours), 1),
         half_day_hours = round(coalesce((p ->> 'half_day_hours')::numeric, half_day_hours), 1),
         updated_at = now()
   where id;
  return jsonb_build_object('ok', true);
end $$;

create function public.timeclock_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.timeclock_settings;
begin
  if not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into s from public.timeclock_settings where id;
  return to_jsonb(s) - 'id';
end $$;

-- ---------------------------------------------------------------- pay rates (Edit)
create function public.timeclock_rates()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'half_day_hours', (select half_day_hours from public.timeclock_settings where id),
    'rates', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'scope', r.scope, 'scope_key', r.scope_key, 'basis', r.basis, 'rate', r.rate,
                                                           'half_day_rate', r.half_day_rate, 'updated_at', r.updated_at,
                                                           'name', case when r.scope = 'person' then public.tc_name(r.scope_key::uuid) end)
                                        order by r.scope, r.scope_key), '[]'::jsonb) from public.timeclock_pay_rates r),
    'titles', (select coalesce(jsonb_agg(distinct lower(btrim(m.job_title))), '[]'::jsonb) from public.team_members m where m.active and btrim(m.job_title) <> ''),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', public.tc_name(m.user_id), 'employment_type', m.employment_type,
                                                            'job_title', m.job_title, 'rate', (select to_jsonb(x) from public.tc_rate_for(m.user_id) x))
                                         order by lower(public.tc_name(m.user_id))), '[]'::jsonb)
                 from public.team_members m where m.active));
end $$;

-- p = {id?, scope, scope_key, basis, rate, half_day_rate?}
create function public.timeclock_rate_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_scope text := p ->> 'scope';
  v_key text := btrim(coalesce(p ->> 'scope_key', ''));
  v_basis text := p ->> 'basis';
  v_rate numeric := round(nullif(p ->> 'rate', '')::numeric, 2);
  v_half numeric := round(nullif(p ->> 'half_day_rate', '')::numeric, 2);
  v_id uuid;
begin
  if not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_scope is null or v_scope not in ('type', 'title', 'person') then raise exception 'Pick who the rate is for.'; end if;
  if v_scope = 'title' then v_key := lower(v_key); end if;
  if v_scope = 'type' and v_key not in ('full_time', 'salaried', 'part_time', 'contractor') then raise exception 'Pick an employment type.'; end if;
  if v_scope = 'person' and not exists (select 1 from public.team_members m where m.user_id::text = v_key) then raise exception 'Pick someone on the team.'; end if;
  if v_key = '' or length(v_key) > 80 then raise exception 'Pick who the rate is for.'; end if;
  if v_basis is null or v_basis not in ('hourly', 'day') then raise exception 'Pick hourly or a day rate.'; end if;
  if v_rate is null or v_rate < 0 or v_rate > 10000 then raise exception 'Enter the rate.'; end if;
  if v_basis = 'hourly' then v_half := null; end if;
  if v_half is not null and (v_half < 0 or v_half > 10000) then raise exception 'Check the half-day rate.'; end if;
  if nullif(p ->> 'id', '') is not null then
    update public.timeclock_pay_rates set scope = v_scope, scope_key = v_key, basis = v_basis, rate = v_rate, half_day_rate = v_half,
           updated_by = (select auth.uid()), updated_at = now()
     where id = (p ->> 'id')::uuid returning id into v_id;
    if v_id is null then raise exception 'That rate was removed. Reload the page.'; end if;
  else
    insert into public.timeclock_pay_rates (scope, scope_key, basis, rate, half_day_rate, updated_by)
    values (v_scope, v_key, v_basis, v_rate, v_half, (select auth.uid()))
    on conflict (scope, scope_key) do update set basis = excluded.basis, rate = excluded.rate, half_day_rate = excluded.half_day_rate,
                                                 updated_by = excluded.updated_by, updated_at = now()
    returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  raise exception 'There is already a rate for that. Change that one.';
end $$;

create function public.timeclock_rate_remove(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from public.timeclock_pay_rates where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

-- ---------------------------------------------------------------- expenses
create function public.tc_expense_json(e public.timeclock_expenses) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'user_id', e.user_id, 'name', public.tc_name(e.user_id, e.user_name), 'day', e.day, 'amount', e.amount,
    'category', e.category, 'booking_id', e.booking_id,
    'job_title', coalesce(case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) end, nullif(e.job_title, ''), ''),
    'note', e.note, 'receipt_path', e.receipt_path, 'status', e.status,
    'reviewed_by', case when e.reviewed_by is not null then public.staff_name(e.reviewed_by) end, 'reviewed_at', e.reviewed_at,
    'review_note', e.review_note, 'created_at', e.created_at)
$$;
revoke all on function public.tc_expense_json(public.timeclock_expenses) from public, anon, authenticated;

-- One month (p_month = any day in it). Default: mine. p_all = everyone (Edit). Waiting ones from any month come too
-- when p_all, so nothing waits unseen.
create function public.expense_list(p_month date, p_all boolean default false)
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
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('booking_id', x.booking_id, 'day', x.day, 'title', x.title)
                                       order by x.day, x.start_at nulls first, x.title), '[]'::jsonb)
               from public.schedule_booking_days(v_from - 7, (v_from + interval '1 month')::date) x),
    'expenses', (select coalesce(jsonb_agg(public.tc_expense_json(e) order by e.day desc, e.created_at desc), '[]'::jsonb)
                   from public.timeclock_expenses e
                  where (v_all or e.user_id = v_me)
                    and ((e.day >= v_from and e.day < (v_from + interval '1 month')::date) or (v_all and e.status = 'submitted'))));
end $$;

-- Add or change an expense. p = {id?, user_id?, day, amount, category, booking_id?, note?, receipt_path?}.
-- Own with View while not approved (a sent-back one goes back to waiting); anyone's with Edit while not approved.
create function public.expense_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_user uuid := coalesce(nullif(p ->> 'user_id', '')::uuid, (select auth.uid()));
  v_day date := nullif(p ->> 'day', '')::date;
  v_amount numeric := round(nullif(p ->> 'amount', '')::numeric, 2);
  v_cat text := p ->> 'category';
  v_booking uuid := nullif(p ->> 'booking_id', '')::uuid;
  v_note text := left(btrim(coalesce(p ->> 'note', '')), 300);
  v_path text := nullif(btrim(coalesce(p ->> 'receipt_path', '')), '');
  o public.timeclock_expenses;
  v_new boolean;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_id is not null then
    select * into o from public.timeclock_expenses where id = v_id for update;
    if not found then raise exception 'That expense was removed. Reload the page.'; end if;
    v_user := o.user_id;
    if o.status = 'approved' then raise exception 'That expense is approved. A manager can send it back first.'; end if;
    if not p ? 'receipt_path' then v_path := o.receipt_path; end if;
  end if;
  if v_user <> v_me and not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_id is null and not exists (select 1 from public.team_members where user_id = v_user and active) then raise exception 'Pick someone on the team.'; end if;
  if v_day is null then raise exception 'Pick the day.'; end if;
  if v_day > (now() at time zone 'America/New_York')::date + 1 then raise exception 'That day has not happened yet.'; end if;
  if v_amount is null or v_amount <= 0 or v_amount > 10000 then raise exception 'Enter the amount ($0.01 to $10,000).'; end if;
  if v_cat is null or v_cat not in ('supplies', 'meals', 'parking', 'tolls', 'gear', 'other') then raise exception 'Pick what it was for.'; end if;
  if v_booking is not null and not exists (select 1 from public.bookings where id = v_booking) then raise exception 'Pick the job.'; end if;
  if v_booking is null and v_note = '' then raise exception 'Say what it was for in the note.'; end if;
  if v_path is not null and (v_path not like v_user::text || '/%' or v_path like '%..%') then raise exception 'Upload the receipt again.'; end if;
  v_new := v_id is null;
  if v_id is not null then
    update public.timeclock_expenses
       set day = v_day, amount = v_amount, category = v_cat, booking_id = v_booking, note = v_note, receipt_path = v_path,
           job_title = left(coalesce(case when v_booking is not null then public.schedule_booking_title(v_booking) end, ''), 200),
           status = 'submitted', reviewed_by = null, reviewed_at = null, updated_at = now()
     where id = v_id;
  else
    insert into public.timeclock_expenses (user_id, user_name, day, amount, category, booking_id, job_title, note, receipt_path, created_by)
    values (v_user, coalesce(public.staff_name(v_user), ''), v_day, v_amount, v_cat, v_booking,
            left(coalesce(public.schedule_booking_title(v_booking), ''), 200), v_note, v_path, v_me)
    returning id into v_id;
  end if;
  -- Managers hear about new ones (not about their own, and not when a manager typed it in).
  if v_new and not public.can('timeclock', 'edit') then
    perform public.tc_push(m, 'expense_update', 'Expense to approve',
                           coalesce(public.staff_name(v_user), 'Someone') || ': $' || to_char(v_amount, 'FM999,990.00') || ' (' || v_cat || ')',
                           '/#staff/expenses', 'expense_waiting')
      from public.tc_managers() m where m <> v_me;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function public.expense_remove(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.timeclock_expenses;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into o from public.timeclock_expenses where id = p_id;
  if not found then return jsonb_build_object('ok', false); end if;
  if o.user_id <> (select auth.uid()) and not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if o.status = 'approved' then raise exception 'That expense is approved. Send it back first.'; end if;
  delete from public.timeclock_expenses where id = p_id;
  return jsonb_build_object('ok', true, 'receipt_path', o.receipt_path);
end $$;

-- Approve, send back (rejected, with a note), or reopen (submitted). Edit only.
create function public.expense_review(p_id uuid, p_status text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.timeclock_expenses;
begin
  if not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('approved', 'rejected', 'submitted') then raise exception 'Approve or send back.'; end if;
  if p_status = 'rejected' and btrim(coalesce(p_note, '')) = '' then raise exception 'Say why it is going back.'; end if;
  update public.timeclock_expenses
     set status = p_status, review_note = left(btrim(coalesce(p_note, '')), 300),
         reviewed_by = case when p_status = 'submitted' then null else (select auth.uid()) end,
         reviewed_at = case when p_status = 'submitted' then null else now() end, updated_at = now()
   where id = p_id returning * into o;
  if o.id is null then raise exception 'That expense was removed. Reload the page.'; end if;
  if p_status <> 'submitted' and o.user_id <> (select auth.uid()) then
    perform public.tc_push(o.user_id, 'expense_update',
                           case when p_status = 'approved' then 'Expense approved' else 'Expense sent back' end,
                           '$' || to_char(o.amount, 'FM999,990.00') || ' on ' || to_char(o.day, 'Mon FMDD')
                             || case when p_status = 'rejected' then ': ' || btrim(p_note) else '' end,
                           '/#staff/expenses', 'expense_' || o.id);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Receipts: private bucket, one folder per person (<user_id>/...). Your own folder with View; everyone's with Edit.
-- The browser shrinks each photo to about 1400px JPEG first.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;
create policy receipts_read on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and ((select public.can('timeclock', 'edit'))
         or ((select public.can('timeclock', 'view')) and (storage.foldername(name))[1] = (select auth.uid())::text)));
create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and ((select public.can('timeclock', 'edit'))
              or ((select public.can('timeclock', 'view')) and (storage.foldername(name))[1] = (select auth.uid())::text)));
create policy receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and ((select public.can('timeclock', 'edit'))
         or ((select public.can('timeclock', 'view')) and (storage.foldername(name))[1] = (select auth.uid())::text)));

-- ---------------------------------------------------------------- the job page: time on one job
-- Everyone's time, miles and approved expenses on a booking (Edit, with estimated cost), or just mine (View).
create function public.timeclock_job(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid()); v_edit boolean := public.can('timeclock', 'edit');
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('can_edit', v_edit,
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
                  'user_id', u.user_id, 'name', public.tc_name(u.user_id, u.user_name),
                  'minutes', (select coalesce(sum(public.tc_minutes(t)), 0) from public.time_punches t where t.user_id = u.user_id and t.booking_id = p_booking),
                  'days', (select count(distinct public.tc_day_of(t.clock_in)) from public.time_punches t where t.user_id = u.user_id and t.booking_id = p_booking),
                  'open', exists (select 1 from public.time_punches t where t.user_id = u.user_id and t.booking_id = p_booking and t.clock_out is null),
                  'miles', (select coalesce(sum(r.miles), 0) from public.mileage_trips r where r.user_id = u.user_id and r.booking_id = p_booking),
                  'expenses', (select coalesce(sum(e.amount), 0) from public.timeclock_expenses e where e.user_id = u.user_id and e.booking_id = p_booking and e.status = 'approved'),
                  'rate', case when v_edit then (select to_jsonb(x) from public.tc_rate_for(u.user_id) x) end)
                  order by lower(public.tc_name(u.user_id, u.user_name))), '[]'::jsonb)
                 from (select y.user_id, max(y.user_name) as user_name from (
                         select t.user_id, t.user_name from public.time_punches t where t.booking_id = p_booking
                         union all select r.user_id, r.user_name from public.mileage_trips r where r.booking_id = p_booking
                         union all select e.user_id, e.user_name from public.timeclock_expenses e where e.booking_id = p_booking and e.status = 'approved') y
                        where v_edit or y.user_id = v_me group by y.user_id) u),
    'mileage_rate', (select mileage_rate from public.timeclock_settings where id),
    'half_day_hours', (select half_day_hours from public.timeclock_settings where id));
end $$;

-- ---------------------------------------------------------------- every 5 minutes
create function public.timeclock_tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.timeclock_settings;
  r record;
  v_in int := 0; v_out int := 0; v_auto int := 0; v_ot int := 0;
  v_today date := (now() at time zone 'America/New_York')::date;
  v_level text; v_name text; v_body text;
begin
  select * into s from public.timeclock_settings where id;

  -- 1. Clock-in reminders: a bar (job, studio, admin, other work) starting within remind_before_min, drive time
  --    included, for someone not clocked in. One per bar.
  if s.remind_before_min > 0 then
    for r in select e.id, e.user_id, e.kind, e.booking_id, e.title, e.starts_at, e.starts_at - make_interval(mins => e.drive_before_min) as go_at, e.drive_before_min
               from public.schedule_entries e
               join public.team_members m on m.user_id = e.user_id and m.active
              where e.kind not in ('off', 'flex')
                and e.starts_at - make_interval(mins => e.drive_before_min) > now()
                and e.starts_at - make_interval(mins => e.drive_before_min) <= now() + make_interval(mins => s.remind_before_min)
                and (e.booking_id is null or exists (select 1 from public.bookings b where b.id = e.booking_id and b.status = 'booked'))
                and not exists (select 1 from public.time_punches t where t.user_id = e.user_id and t.clock_out is null)
                and not exists (select 1 from public.timeclock_reminders x where x.entry_id = e.id and x.kind = 'in') loop
      insert into public.timeclock_reminders (entry_id, kind, user_id) values (r.id, 'in', r.user_id) on conflict do nothing;
      perform public.tc_push(r.user_id, 'clock_reminder', 'Clock in at ' || to_char(r.go_at at time zone 'America/New_York', 'FMHH12:MI am'),
        coalesce(case when r.booking_id is not null then public.schedule_booking_title(r.booking_id) end, nullif(r.title, ''), initcap(r.kind))
          || case when r.drive_before_min > 0 then ' starts at ' || to_char(r.starts_at at time zone 'America/New_York', 'FMHH12:MI am') || ' (drive time included).' else '.' end,
        '/#staff/clock', 'clockin_' || r.id);
      v_in := v_in + 1;
    end loop;
  end if;

  -- 2. Clock-out reminders: still clocked in remind_out_after_min after the person's last bar of the stretch ended
  --    (nothing else on their schedule now or in the next 30 minutes). Bars that ended over 6 hours ago are ignored.
  if s.remind_out_after_min > 0 then
    for r in select distinct on (t.user_id) t.user_id, e.id, e.ends_at + make_interval(mins => e.drive_after_min) as end_at, t.kind, t.booking_id, t.job_title
               from public.time_punches t
               join public.schedule_entries e on e.user_id = t.user_id and e.kind not in ('off', 'flex')
              where t.clock_out is null
                and e.ends_at + make_interval(mins => e.drive_after_min) > t.clock_in
                and e.ends_at + make_interval(mins => e.drive_after_min) <= now() - make_interval(mins => s.remind_out_after_min)
                and e.ends_at + make_interval(mins => e.drive_after_min) > now() - interval '6 hours'
                and (e.booking_id is null or exists (select 1 from public.bookings b where b.id = e.booking_id and b.status = 'booked'))
                and not exists (select 1 from public.schedule_entries e2 where e2.user_id = t.user_id and e2.kind not in ('off', 'flex')
                                   and e2.starts_at - make_interval(mins => e2.drive_before_min) < now() + interval '30 minutes'
                                   and e2.ends_at + make_interval(mins => e2.drive_after_min) > now()
                                   and (e2.booking_id is null or exists (select 1 from public.bookings b where b.id = e2.booking_id and b.status = 'booked')))
              order by t.user_id, e.ends_at desc loop
      if exists (select 1 from public.timeclock_reminders x where x.entry_id = r.id and x.kind = 'out') then continue; end if;
      insert into public.timeclock_reminders (entry_id, kind, user_id) values (r.id, 'out', r.user_id) on conflict do nothing;
      perform public.tc_push(r.user_id, 'clock_reminder', 'Still clocked in?',
        'Your scheduled time ended at ' || to_char(r.end_at at time zone 'America/New_York', 'FMHH12:MI am') || '. Clock out if you are done.',
        '/#staff/clock', 'clockout_' || r.user_id);
      v_out := v_out + 1;
    end loop;
  end if;

  -- 3. Midnight: close clocks started on an earlier day (Eastern) at the midnight after they started; flag them.
  if s.auto_out then
    for r in select t.* from public.time_punches t
              where t.clock_out is null and public.tc_day_of(t.clock_in) < v_today
              for update skip locked loop
      update public.time_punches
         set clock_out = greatest((public.tc_day_of(r.clock_in) + 1)::timestamp at time zone 'America/New_York', r.clock_in + interval '1 minute'),
             auto_out = true, needs_review = true,
             note = left(concat_ws(' / ', nullif(note, ''), 'Clocked out automatically at midnight'), 500)
       where id = r.id;
      perform public.tc_push(r.user_id, 'clock_reminder', 'Your clock was stopped at midnight',
        'You were still clocked in. Put in the time you really stopped on your timesheet.', '/#staff/timesheets', 'autoout_' || r.id);
      v_auto := v_auto + 1;
    end loop;
  end if;

  -- 4. Overtime warnings (people overtime applies to), once per level per week.
  if s.ot_warn_hours > 0 then
    for r in select m.user_id, l.week_start, l.worked_min, l.ahead_min
               from public.team_members m
               cross join lateral public.tc_week_load(m.user_id) l
              where m.active and public.overtime_applies(m.user_id) and public.team_user_can(m.user_id, 'timeclock')
                and (l.worked_min >= round((s.overtime_after - s.ot_warn_hours) * 60) or l.worked_min + l.ahead_min > round(s.overtime_after * 60)) loop
      v_level := case when r.worked_min > round(s.overtime_after * 60) then 'over' else 'near' end;
      if exists (select 1 from public.timeclock_ot_warnings w where w.user_id = r.user_id and w.week_start = r.week_start and (w.level = v_level or w.level = 'over')) then continue; end if;
      insert into public.timeclock_ot_warnings (user_id, week_start, level, worked_min) values (r.user_id, r.week_start, v_level, r.worked_min);
      v_name := coalesce(public.staff_name(r.user_id), 'Someone');
      v_body := round(r.worked_min / 60.0, 1) || 'h worked this week'
                || case when r.ahead_min > 0 then ', ' || round(r.ahead_min / 60.0, 1) || 'h more on the schedule' else '' end
                || '. Overtime starts at ' || s.overtime_after || 'h.';
      perform public.tc_push(r.user_id, 'overtime_warning', case when v_level = 'over' then 'You are into overtime' else 'Close to overtime' end,
                             v_body, '/#staff/timesheets', 'ot_' || r.user_id);
      perform public.tc_push(mg, 'overtime_warning', v_name || case when v_level = 'over' then ' is into overtime' else ' is close to overtime' end,
                             v_body, '/#staff/timesheets', 'ot_' || r.user_id)
        from public.tc_managers() mg where mg <> r.user_id;
      v_ot := v_ot + 1;
    end loop;
  end if;

  return jsonb_build_object('reminders_in', v_in, 'reminders_out', v_out, 'auto_out', v_auto, 'overtime', v_ot);
end $$;
revoke all on function public.timeclock_tick() from public, anon, authenticated;

select cron.schedule('timeclock-tick', '*/5 * * * *', 'select public.timeclock_tick()');
select cron.schedule('timeclock-log-retention', '43 4 * * *',
  $$delete from public.timeclock_reminders where sent_at < now() - interval '30 days'; delete from public.timeclock_ot_warnings where week_start < current_date - 120$$);

update public.app_modules
   set description = 'Clock in and out from a phone, tied to a job (with location if allowed); reminders and midnight clock-out; weekly timesheets with approval, pay rates and a payroll CSV; miles per job; expenses with receipts. View = your own; Edit = everyone''s, approve and export.'
 where key = 'timeclock';

-- ---------------------------------------------------------------- grants
revoke all on function public.timeclock_in(text, uuid, text, jsonb), public.timeclock_out(text, jsonb),
  public.timeclock_settings_save(numeric, numeric, jsonb), public.timeclock_settings_get(), public.timeclock_rates(), public.timeclock_rate_save(jsonb),
  public.timeclock_rate_remove(uuid), public.expense_list(date, boolean), public.expense_save(jsonb), public.expense_remove(uuid),
  public.expense_review(uuid, text, text), public.timeclock_job(uuid) from public, anon;
grant execute on function public.timeclock_in(text, uuid, text, jsonb), public.timeclock_out(text, jsonb),
  public.timeclock_settings_save(numeric, numeric, jsonb), public.timeclock_settings_get(), public.timeclock_rates(), public.timeclock_rate_save(jsonb),
  public.timeclock_rate_remove(uuid), public.expense_list(date, boolean), public.expense_save(jsonb), public.expense_remove(uuid),
  public.expense_review(uuid, text, text), public.timeclock_job(uuid) to authenticated;
