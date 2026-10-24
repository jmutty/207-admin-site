-- Makeup days for school jobs (2026-10-24). Jeremiah: "I need a way to add and track a makeup day for school photos.
-- It would go on the calendar as a job as it will need to be assigned, but won't need a separate GotPhoto gallery."
-- He likes the phrase "makeup day", focused on kids who were absent (retakes are welcome too).
--
-- The makeup day is a booking_days row with kind = 'makeup' on the same booking, so it rides the multi-day plumbing:
-- its own Google Calendar event (calendar-write, sort > 0), its own Schedule card through schedule_booking_days
-- (assign, drive time, Problems, Send changes, open jobs, time clock, mileage), and the booking's one GotPhoto job.
--
-- 1. booking_days.kind ('shoot' | 'makeup'). At most one live makeup row per booking. Its label is "Makeup day",
--    which the calendar title and the Schedule card show after the job's name.
-- 2. Everything that means "picture days" leaves the makeup row out: the emails' {{picture_day}}/{{schedule}} words,
--    the per-night hub reminder, launch / discount / gallery dates, the GotPhoto archive date, "Picture day done",
--    the director page, the photos-missing check, and Edit booking's day rows (booking_set_days never touches it,
--    and won't let a picture day land on the makeup day).
-- 3. admin_bookings and job_get return the picture days as 'days' (as before) and the makeup day as 'makeup'.
-- 4. booking_set_makeup(booking, {day, start_time, end_time}): add, move or take off the makeup day (an empty day
--    takes it off, with its crew bars). Booked and tracking-only jobs: a tracked job's makeup day gets its calendar
--    event and Schedule card, and no booking emails come from it. One date everywhere: bookings.retake_day and the
--    school's hub row follow it, and a date set on the hub row comes back to the job. The hub's existing makeup
--    dates are carried in (upcoming ones become makeup days).
-- 5. Words: "Retake day" becomes "Makeup day" in the hub reminder titles and details and on the director page.

alter table public.booking_days add column if not exists kind text not null default 'shoot';
do $$ begin
  alter table public.booking_days add constraint booking_days_kind_check check (kind in ('shoot', 'makeup'));
exception when duplicate_object then null; end $$;
create unique index if not exists booking_days_one_makeup on public.booking_days (booking_id) where kind = 'makeup' and not removed;

-- Plain-text patch of a live function: p_from must occur exactly p_expect times; skipped once p_marker is in it.
create or replace function pg_temp.patch_text(p_sig regprocedure, p_marker text, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  if strpos(v_def, p_marker) > 0 then raise notice 'patch %: already applied', p_sig; return; end if;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  if v_n <> p_expect then raise exception 'patch %: expected % of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute replace(v_def, p_from, p_to);
end $$;

-- Word change in every function of that name; at least one occurrence, skipped once p_from is gone.
create or replace function pg_temp.reword(p_name text, p_from text, p_to text)
returns void language plpgsql as $$
declare f regprocedure; v_def text; v_any boolean := false;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = p_name loop
    v_def := pg_get_functiondef(f);
    if strpos(v_def, p_from) > 0 then execute replace(v_def, p_from, p_to); v_any := true; end if;
    if strpos(v_def, p_to) > 0 then v_any := true; end if;
  end loop;
  if not v_any then raise exception 'reword %: % not found', p_name, p_from; end if;
end $$;

-- ---------------------------------------------------------------- 2. picture days leave the makeup day out
select pg_temp.patch_text('public.admin_booking_tracking(uuid)', $m$kind = 'shoot'$m$,
  $f$from booking_days where booking_id = p_id and not removed)$f$,
  $t$from booking_days where booking_id = p_id and not removed and kind = 'shoot')$t$, 1);

select pg_temp.patch_text('public.booking_director_facts(uuid)', $m$kind = 'shoot'$m$,
  $f$from public.booking_days d where d.booking_id = b.id and d.removed is not true;$f$,
  $t$from public.booking_days d where d.booking_id = b.id and d.removed is not true and d.kind = 'shoot';$t$, 1);

select pg_temp.patch_text('public.booking_email_skip_reason(uuid)', $m$kind = 'shoot'$m$,
  $f$from public.booking_days d where d.booking_id = b.id and not d.removed$f$,
  $t$from public.booking_days d where d.booking_id = b.id and not d.removed and d.kind = 'shoot'$t$, 1);

select pg_temp.patch_text('public.booking_hub_where(uuid)', $m$kind = 'shoot'$m$,
  $f$from public.booking_days d where d.booking_id = b.id and not d.removed)$f$,
  $t$from public.booking_days d where d.booking_id = b.id and not d.removed and d.kind = 'shoot')$t$, 1);

select pg_temp.patch_text('public.booking_order_dates(uuid)', $m$kind = 'shoot'$m$,
  $f$d.removed is not true))$f$,
  $t$d.removed is not true and d.kind = 'shoot'))$t$, 1);

select pg_temp.patch_text('public.booking_reschedule(uuid)', $m$kind = 'shoot'$m$,
  $f$from booking_days where booking_id = p_booking and not removed;$f$,
  $t$from booking_days where booking_id = p_booking and not removed and kind = 'shoot';$t$, 1);

select pg_temp.patch_text('public.booking_schedule_words(uuid)', $m$kind = 'shoot'$m$,
  $f$from booking_days where booking_id = p_booking and not removed order by$f$,
  $t$from booking_days where booking_id = p_booking and not removed and kind = 'shoot' order by$t$, 1);

select pg_temp.patch_text('public.booking_series_vars(uuid)', $m$kind = 'shoot'$m$,
  $f$from public.booking_days d where d.booking_id = b.id and not d.removed order by$f$,
  $t$from public.booking_days d where d.booking_id = b.id and not d.removed and d.kind = 'shoot' order by$t$, 1);

select pg_temp.patch_text('public.booking_stages_tick()', $m$kind = 'shoot'$m$,
  $f$from booking_days where booking_id = r.id and not removed;$f$,
  $t$from booking_days where booking_id = r.id and not removed and kind = 'shoot';$t$, 1);

select pg_temp.patch_text('public.booking_vars(uuid, uuid, uuid, integer)', $m$kind = 'shoot'$m$,
  $f$from booking_days where booking_id = p_booking and not removed order by day offset$f$,
  $t$from booking_days where booking_id = p_booking and not removed and kind = 'shoot' order by day offset$t$, 1);

select pg_temp.patch_text('public.gp_create_queue(uuid, integer, boolean)', $m$kind = 'shoot'$m$,
  $f$from booking_days d where d.booking_id = r.id and d.removed is not true;$f$,
  $t$from booking_days d where d.booking_id = r.id and d.removed is not true and d.kind = 'shoot';$t$, 1);

-- a booking with only a makeup row still has its picture day checked
select pg_temp.patch_text('public.booking_weather_due()', $m$x.kind = 'shoot'$m$,
  $f$where not exists (select 1 from public.booking_days x where x.booking_id = b.id and not x.removed)$f$,
  $t$where not exists (select 1 from public.booking_days x where x.booking_id = b.id and not x.removed and x.kind = 'shoot')$t$, 1);

select pg_temp.patch_text('public.gp_photos_missing()', $m$kind = 'shoot'$m$,
  $f$from booking_days d where d.booking_id = b.id and not d.removed) x$f$,
  $t$from booking_days d where d.booking_id = b.id and not d.removed and d.kind = 'shoot') x$t$, 1);

-- Edit booking's day rows: the makeup row is never taken off by a picture-day edit, a picture day can't land on
-- it, and the hub's list of days is picture days only.
select pg_temp.patch_text('public.booking_set_days(uuid, jsonb)', $m$kind = 'shoot'$m$,
  $f$    v_keep := v_keep || v_day;
$f$,
  $t$    if exists (select 1 from booking_days where booking_id = p_booking and day = v_day and kind = 'makeup' and not removed) then
      raise exception 'The makeup day is % already. Move the makeup day first, or pick another picture day.', to_char(v_day, 'FMMM/FMDD');
    end if;
    v_keep := v_keep || v_day;
$t$, 1);
select pg_temp.patch_text('public.booking_set_days(uuid, jsonb)', $m$and kind = 'shoot' and not (day$m$,
  $f$where booking_id = p_booking and not (day = any(v_keep));$f$,
  $t$where booking_id = p_booking and kind = 'shoot' and not (day = any(v_keep));$t$, 1);
select pg_temp.patch_text('public.booking_set_days(uuid, jsonb)', $m$and not removed and kind = 'shoot') > 1$m$,
  $f$from booking_days where booking_id = p_booking and not removed) > 1$f$,
  $t$from booking_days where booking_id = p_booking and not removed and kind = 'shoot') > 1$t$, 1);
select pg_temp.patch_text('public.booking_set_days(uuid, jsonb)', $m$not d2.removed and d2.kind = 'shoot'$m$,
  $f$where d2.booking_id = p_booking and not d2.removed)$f$,
  $t$where d2.booking_id = p_booking and not d2.removed and d2.kind = 'shoot')$t$, 1);

-- The Schedule's days. Same as before (20261022120000) except: a booking with only a makeup row still shows its
-- picture day, and a tracking-only job's makeup day counts as a real job there (assign it, Problems, open jobs);
-- its picture days stay faint "tracked" ones.
create or replace function public.schedule_booking_days(p_from date, p_to date)
returns table (booking_id uuid, day date, start_at timestamptz, end_at timestamptz, title text, type_label text,
               location text, status text, day_label text)
language sql stable security definer set search_path = '' as $$
  select b.id, x.day, x.s,
         case when x.s is null then null
              else coalesce(x.e, x.s + make_interval(mins => coalesce(b.duration_min, t.default_duration_min, 60))) end,
         public.schedule_booking_title(b.id), t.label, coalesce(b.location, ''),
         case when b.status = 'tracked' and x.kind = 'makeup' then 'booked' else b.status end, coalesce(x.label, '')
    from public.bookings b
    left join public.booking_types t on t.key = b.type_key
    cross join lateral (
      select d.day,
             case when (case when d.sort = 0 then b.time_set is not false else d.start_at is not null end) then d.start_at end as s,
             case when (case when d.sort = 0 then b.time_set is not false and b.end_set is not false else d.end_at is not null end) then d.end_at end as e,
             d.label, d.kind
        from public.booking_days d where d.booking_id = b.id and d.removed is not true
      union all
      select b.picture_day,
             case when b.time_set is not false then b.start_at end,
             case when b.time_set is not false and b.end_set is not false then b.end_at end,
             null, 'shoot'
       where not exists (select 1 from public.booking_days d where d.booking_id = b.id and d.kind = 'shoot')
    ) x
   where b.status <> 'cancelled' and x.day >= p_from and x.day < p_to
$$;

-- ---------------------------------------------------------------- 3. 'days' = picture days, 'makeup' = the makeup day
select pg_temp.patch_text('public.admin_bookings(date, date)', $m$'makeup'$m$,
  $f$               from booking_days d where d.booking_id = b.id and not d.removed),$f$,
  $t$               from booking_days d where d.booking_id = b.id and not d.removed and d.kind = 'shoot'),
    'makeup', (select jsonb_build_object('id', d.id, 'day', d.day, 'start_at', d.start_at, 'end_at', d.end_at, 'calendar_status', d.calendar_status)
                 from booking_days d where d.booking_id = b.id and not d.removed and d.kind = 'makeup' limit 1),$t$, 1);

select pg_temp.patch_text('public.job_get(uuid)', $m$'makeup'$m$,
  $f$               from public.booking_days d where d.booking_id = b.id and not d.removed),$f$,
  $t$               from public.booking_days d where d.booking_id = b.id and not d.removed and d.kind = 'shoot'),
    'makeup', (select jsonb_build_object('day', d.day, 'start_at', d.start_at, 'end_at', d.end_at, 'calendar_status', d.calendar_status)
                 from public.booking_days d where d.booking_id = b.id and not d.removed and d.kind = 'makeup' limit 1),$t$, 1);

-- ---------------------------------------------------------------- 5. words
select pg_temp.reword('booking_parents', 'Retake day, one week out', 'Makeup day, one week out');
select pg_temp.reword('booking_parents', 'Retake day, day before', 'Makeup day, day before');
select pg_temp.reword('hub_sends_all', 'Retake day, one week out', 'Makeup day, one week out');
select pg_temp.reword('hub_sends_all', 'Retake day, day before', 'Makeup day, day before');
select pg_temp.reword('hub_reminders_due_all', 'Retake day, one week out', 'Makeup day, one week out');
select pg_temp.reword('hub_reminders_due_all', 'Retake day, day before', 'Makeup day, day before');
select pg_temp.reword('hub_reminders_due_all', 'Retake day is one week away.', 'Makeup day is one week away.');
select pg_temp.reword('hub_reminders_due_all', 'Retake day is tomorrow.', 'Makeup day is tomorrow.');
select pg_temp.reword('hub_reminders_due_all', $f$Your school''s retake day is$f$, $t$Your school''s makeup day is$t$);
select pg_temp.reword('booking_vars', 'Retake day is one week away.', 'Makeup day is one week away.');
select pg_temp.reword('booking_vars', 'Retake day is tomorrow.', 'Makeup day is tomorrow.');
select pg_temp.reword('booking_vars', $f$Your school''s retake day is$f$, $t$Your school''s makeup day is$t$);
select pg_temp.reword('booking_director_facts',
  $f$'Retake day is ' || public.director_fmt_day(v_retake_day) || '. Anyone who was out, or wants a retake, comes then.'$f$,
  $t$'Makeup day is ' || public.director_fmt_day(v_retake_day) || '. Students who were absent on picture day are photographed then, and anyone who would like a retake is welcome too.'$t$);
select pg_temp.reword('booking_director_facts',
  $f$'Anyone out on picture day can be photographed on a retake day; we''ll set one with you if it''s needed.'$f$,
  $t$'Students who are absent on picture day can be photographed on a makeup day; we''ll set one with you if it''s needed.'$t$);

-- ---------------------------------------------------------------- 4. add, move or take off the makeup day
-- One makeup date everywhere (Jeremiah, 2026-10-24: "make sure we are auto-populating that everywhere once it gets
-- added somewhere"). It lives on the booking's makeup row and is copied to bookings.retake_day (booking emails, the
-- director page, the agreement builder) and to the school's hub row comm_hub_schools.retake_day (hub reminders,
-- parent retake requests, the Retakes list and digest). A date typed on the hub row comes back the other way.

-- The school's hub row for a booking: its link, else the hub row with the same school name and picture day (the
-- tracking-only schools' rows were made by hand on the old Schools tab and were never linked).
create or replace function public.booking_hub_school(p_booking uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(b.hub_school_id,
           (select h.id from comm_hub_schools h join prospect_orgs o on o.id = b.org_id
             where public.hub_norm_name(h.name) = public.hub_norm_name(o.name) and h.picture_day = b.picture_day
             order by h.active desc, h.created_at desc limit 1))
    from bookings b where b.id = p_booking
$$;
revoke all on function public.booking_hub_school(uuid) from public, anon, authenticated;

-- The work behind booking_set_makeup and the hub sync. p_day null takes it off. p_keep_times: a hub date change
-- keeps the makeup day's start and end times. p_from_hub: the hub row already has the date.
create or replace function public.booking_makeup_apply(p_booking uuid, p_day date, p_st time, p_en time,
                                                       p_keep_times boolean default false, p_from_hub boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b bookings; m booking_days; v_st time := p_st; v_en time := p_en; v_start timestamptz; v_end timestamptz;
        v_delta int; v_moved int := 0; v_off int := 0; v_hub uuid; v_tz text := 'America/New_York';
begin
  select * into b from bookings where id = p_booking;
  if b.id is null then raise exception 'Booking not found.'; end if;
  -- a tracking-only job (it never went through Book a job, often already launched) gets one too: the makeup day goes
  -- on the calendar and the Schedule, and no booking emails come from the job
  if b.status not in ('booked', 'tracked') then raise exception 'Only a booked or tracked job can have a makeup day.'; end if;
  select * into m from booking_days where booking_id = p_booking and kind = 'makeup' and not removed;

  if p_day is null then
    if m.id is not null then
      -- its crew bars come off with it
      delete from schedule_entries where booking_id = p_booking and kind = 'job' and (starts_at at time zone v_tz)::date = m.day;
      get diagnostics v_off = row_count;
      update booking_days set removed = true, calendar_status = case when google_event_id is not null then 'remove' else 'deleted' end, updated_at = now()
       where id = m.id;
      delete from booking_days where id = m.id and google_event_id is null;
    end if;
  else
    if p_day <= b.picture_day then raise exception 'The makeup day has to be after picture day (%).', to_char(b.picture_day, 'FMMM/FMDD'); end if;
    if exists (select 1 from booking_days where booking_id = p_booking and kind = 'shoot' and not removed and day = p_day) then
      raise exception '% is already a picture day on this job. Pick another day for the makeup day.', to_char(p_day, 'FMMM/FMDD');
    end if;
    if exists (select 1 from booking_days where booking_id = p_booking and day = p_day and removed) then
      raise exception 'That day was just taken off this job and its calendar event is still being removed. Try again in a minute.';
    end if;
    if p_keep_times and m.id is not null then
      v_st := (m.start_at at time zone v_tz)::time; v_en := (m.end_at at time zone v_tz)::time;
    end if;
    if v_st is not null and v_en is not null and v_en <= v_st then raise exception 'The end time has to be after the start time.'; end if;
    v_start := case when v_st is not null then (p_day + v_st) at time zone v_tz end;
    v_end := case when v_st is not null and v_en is not null then (p_day + v_en) at time zone v_tz end;
    if m.id is null then
      insert into booking_days (booking_id, day, start_at, end_at, label, sort, kind, calendar_status)
      values (p_booking, p_day, v_start, v_end, 'Makeup day', 1000, 'makeup', 'pending');
    else
      v_delta := p_day - m.day;
      if v_delta <> 0 then   -- whoever was on it moves with it
        update schedule_entries
           set starts_at = ((starts_at at time zone v_tz) + make_interval(days => v_delta)) at time zone v_tz,
               ends_at   = ((ends_at   at time zone v_tz) + make_interval(days => v_delta)) at time zone v_tz,
               batch_id = null, updated_at = now()
         where booking_id = p_booking and kind = 'job' and (starts_at at time zone v_tz)::date = m.day;
        get diagnostics v_moved = row_count;
      end if;
      update booking_days set day = p_day, start_at = v_start, end_at = v_end, updated_at = now(),
             calendar_status = case when (m.day, m.start_at, m.end_at) is distinct from (p_day, v_start, v_end) or calendar_status = 'error' then 'pending'
                                    else calendar_status end
       where id = m.id;
    end if;
  end if;

  update bookings set retake_day = p_day, updated_at = now() where id = p_booking and retake_day is distinct from p_day;
  if not p_from_hub then
    v_hub := public.booking_hub_school(p_booking);
    if v_hub is not null then update comm_hub_schools set retake_day = p_day, updated_at = now() where id = v_hub and retake_day is distinct from p_day; end if;
  end if;
  if b.status = 'booked' then   -- the booked job's hub row and its makeup-day reminder emails
    perform public.booking_hub_setup(p_booking);
    perform public.booking_reschedule(p_booking);
  end if;
  perform public.booking_poke('calendar-write', jsonb_build_object('booking_id', p_booking));
  return jsonb_build_object('ok', true, 'day', p_day, 'crew_moved', v_moved, 'crew_removed', v_off);
end $$;
revoke all on function public.booking_makeup_apply(uuid, date, time, time, boolean, boolean) from public, anon, authenticated;

-- p = {day, start_time?, end_time?}; an empty day takes it off. Times can wait (an all-day event until set).
create or replace function public.booking_set_makeup(p_booking uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  return public.booking_makeup_apply(p_booking, nullif(p->>'day', '')::date, nullif(p->>'start_time', '')::time, nullif(p->>'end_time', '')::time);
end $$;
revoke all on function public.booking_set_makeup(uuid, jsonb) from public, anon;
grant execute on function public.booking_set_makeup(uuid, jsonb) to authenticated;

-- A makeup date set or changed on a school's hub row reaches its job (booked or tracked): the makeup day appears,
-- moves (keeping its times) or comes off. A date the job can't take (before picture day) is skipped, not refused.
create or replace function public.hub_school_makeup_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select b.id from bookings b join booking_types t on t.key = b.type_key
            where t.audience = 'school' and b.status in ('booked', 'tracked') and b.retake_day is distinct from new.retake_day
              and b.picture_day between new.picture_day - 60 and new.picture_day + 60
              and public.booking_hub_school(b.id) = new.id loop
    begin
      perform public.booking_makeup_apply(r.id, new.retake_day, null, null, true, true);
    exception when others then raise warning 'hub makeup date for booking %: %', r.id, sqlerrm;
    end;
  end loop;
  return null;
end $$;
revoke all on function public.hub_school_makeup_sync() from public, anon, authenticated;
drop trigger if exists hub_school_makeup_sync on public.comm_hub_schools;
create trigger hub_school_makeup_sync after update of retake_day on public.comm_hub_schools
  for each row when (old.retake_day is distinct from new.retake_day) execute function public.hub_school_makeup_sync();

-- The makeup dates already on the hub: upcoming ones become makeup days (on the calendar and the Schedule to assign);
-- past ones are only copied onto the job.
do $$
declare r record;
begin
  for r in select b.id, h.retake_day from bookings b join booking_types t on t.key = b.type_key and t.audience = 'school'
             join comm_hub_schools h on h.id = public.booking_hub_school(b.id)
            where b.status in ('booked', 'tracked') and h.retake_day is not null and b.retake_day is null
              and not exists (select 1 from booking_days d where d.booking_id = b.id and d.kind = 'makeup' and not d.removed) loop
    if r.retake_day >= (now() at time zone 'America/New_York')::date then
      perform public.booking_makeup_apply(r.id, r.retake_day, null, null, false, true);
    else
      update bookings set retake_day = r.retake_day where id = r.id;
    end if;
  end loop;
end $$;
