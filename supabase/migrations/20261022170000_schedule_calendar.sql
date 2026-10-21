-- Google Calendar on the Schedule (2026-10-22). The shared bookings calendar is already mirrored into
-- calendar_events every few minutes. Events there that are not bookings (an in-studio makeup session, a
-- conference, an appointment) show on the Schedule in a "From Google Calendar" lane; clicking one puts people
-- on it (a bar with gcal_event_id set, after which it leaves the lane). An event named like "Ryan Off" (or
-- "Ryan Smith off") shows as time off on that person's row when exactly one active team member matches.
-- Read only: nothing is written back to Google.

-- Calendar events between p_from (inclusive) and p_to (exclusive) that are not a booking.
-- An event is a booking when a booking (or one of its days) carries its event id, or when a booking that day
-- has its organization name (5+ characters) or its whole title in the event's summary.
create function public.schedule_calendar(p_from date, p_to date)
returns table (event_id text, summary text, start_date date, end_date date, all_day boolean, start_at timestamptz, end_at timestamptz, off_user uuid)
language sql stable security definer set search_path = '' as $$
  with ev as (
    select c.google_event_id, btrim(coalesce(c.summary, '')) as summary, c.start_date, coalesce(c.end_date, c.start_date) as end_date,
           coalesce(c.all_day, c.start_at is null) as all_day, c.start_at, c.end_at
      from public.calendar_events c
     where c.start_date < p_to and coalesce(c.end_date, c.start_date) >= p_from and btrim(coalesce(c.summary, '')) <> ''
  ), bk as (
    select x.day, lower(x.title) as title, lower(regexp_replace(split_part(x.title, ' • ', 1), '\s*\(.*\)$', '')) as org
      from public.schedule_booking_days(p_from - 14, p_to + 14) x
  ), offname as (
    select ev.google_event_id, lower(btrim(m[1])) as who
      from ev cross join lateral regexp_match(ev.summary, '^\W*([A-Za-z][A-Za-z.''-]*(?:\s+[A-Za-z][A-Za-z.''-]*)?)\s+off\M', 'i') m
  )
  select ev.google_event_id, ev.summary, ev.start_date, ev.end_date, ev.all_day, ev.start_at, ev.end_at,
         (select case when count(*) = 1 then min(tm.user_id::text)::uuid end
            from public.team_members tm join offname o on o.google_event_id = ev.google_event_id
           where tm.active and (lower(public.staff_name(tm.user_id)) = o.who or lower(split_part(public.staff_name(tm.user_id), ' ', 1)) = o.who))
    from ev
   where not exists (select 1 from public.bookings b where b.google_event_id = ev.google_event_id)
     and not exists (select 1 from public.booking_days d where d.google_event_id = ev.google_event_id)
     and not exists (select 1 from bk where bk.day between ev.start_date and ev.end_date
                       and ((length(bk.org) >= 5 and position(bk.org in lower(ev.summary)) > 0) or position(bk.title in lower(ev.summary)) > 0))
$$;
revoke all on function public.schedule_calendar(date, date) from public, anon, authenticated;

-- schedule_week: also the calendar events (with off_user for "X Off"), and each bar's gcal_event_id.
create or replace function public.schedule_week(p_start date, p_days int default 7)
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
    'calendar', (select coalesce(jsonb_agg(jsonb_build_object('event_id', c.event_id, 'summary', c.summary, 'start_date', c.start_date, 'end_date', c.end_date,
                                   'all_day', c.all_day, 'start_at', c.start_at, 'end_at', c.end_at, 'off_user', c.off_user)
                                   order by c.start_date, c.start_at nulls first, c.summary), '[]'::jsonb)
                   from public.schedule_calendar(p_start, v_end) c),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'user_id', e.user_id, 'kind', e.kind, 'booking_id', e.booking_id,
                                  'starts_at', e.starts_at, 'ends_at', e.ends_at, 'drive_before_min', e.drive_before_min, 'drive_after_min', e.drive_after_min,
                                  'title', e.title, 'note', e.note, 'gcal_event_id', e.gcal_event_id,
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
