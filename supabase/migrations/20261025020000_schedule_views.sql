-- Schedule views (2026-10-24, Jeremiah said "go" on the scheduling software comparison,
-- https://claude.ai/artifact/Xc2SyfFZR2WFgszRMh1W8C). The page side is in app/src/scheduling.js.
--
--   1. schedule_week gains what the new views draw: per booking day the shooting setting and the latest
--      forecast check (booking_weather_checks: rain chance, gusts, bad), and the time clock punches in the range
--      (who clocked in on which job, for the "on the job" mark on today's bars).
--   2. Map: schedule_map_places(start, days) lists the studio, each job's address and (Scheduling edit only)
--      each person's home, with the coordinates already looked up. The schedule-map edge function looks up
--      the rest (Google Places text search) and stores them through schedule_geo_store (service role only).
--   3. Send changes: every change to someone's schedule from today on, made by someone else, is noted in
--      schedule_changes. "Send changes" on the Schedule emails each person once with their changed days as
--      they are now (schedule_change_content), instead of an email per change. Time off and flex time aren't
--      noted (people do those themselves).
--      Also the time the Google Calendar mirror last synced, for the Google Calendar show/hide tick.
--   4. Calendar link: each person can subscribe their phone's calendar to their own schedule
--      (staff_cal_link -> staff-ics edge function -> staff_ics(token)). Jobs carry the address, when to
--      leave, the role, "For the crew" notes and the WiFi.
-- Email only (never SMS); only booked jobs.

-- ================================================================ 1. schedule_week extras
create or replace function public.schedule_week(p_start date, p_days integer default 7)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
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
    'crew', public.crew_week_extra(p_start, v_end),
    'me', v_me,
    'studio_address', (select studio_address from public.staff_settings where id),
    'setup_default', (select setup_min from public.staff_settings where id),
    'teardown_default', (select teardown_min from public.staff_settings where id),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', public.staff_name(m.user_id), 'from_home', public.schedule_from_home(m.user_id), 'weekly_hours', m.weekly_hours, 'roles', (select coalesce(jsonb_agg(tr.role_id), '[]'::jsonb) from public.team_member_roles tr join public.crew_roles r on r.id = tr.role_id and r.archived_at is null where tr.user_id = m.user_id))
                                         order by lower(public.staff_name(m.user_id))), '[]'::jsonb)
                 from public.team_members m where m.active),
    'bookings', (select coalesce(jsonb_agg(jsonb_build_object('booking_id', x.booking_id, 'day', x.day, 'start_at', x.start_at, 'end_at', x.end_at,
                                   'title', x.title, 'type_label', x.type_label, 'location', x.location, 'status', x.status, 'day_label', x.day_label,
                                   'shoot_setting', b.shoot_setting,
                                   'weather', (select jsonb_build_object('pop', w.max_pop, 'gust', w.max_gust, 'bad', w.bad, 'checked_at', w.checked_at)
                                                 from public.booking_weather_checks w
                                                where w.booking_id = x.booking_id and w.day = x.day and w.error is null
                                                order by w.checked_at desc limit 1))
                                   order by x.day, x.start_at nulls first, x.title), '[]'::jsonb)
                   from public.schedule_booking_days(p_start, v_end) x join public.bookings b on b.id = x.booking_id),
    'calendar', (select coalesce(jsonb_agg(jsonb_build_object('event_id', c.event_id, 'summary', c.summary, 'start_date', c.start_date, 'end_date', c.end_date,
                                   'all_day', c.all_day, 'start_at', c.start_at, 'end_at', c.end_at, 'off_user', c.off_user)
                                   order by c.start_date, c.start_at nulls first, c.summary), '[]'::jsonb)
                   from public.schedule_calendar(p_start, v_end) c),
    'calendar_synced_at', (select max(c.synced_at) from public.calendar_events c),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'user_id', e.user_id, 'kind', e.kind, 'booking_id', e.booking_id,
                                  'starts_at', e.starts_at, 'ends_at', e.ends_at, 'drive_before_min', e.drive_before_min, 'drive_after_min', e.drive_after_min, 'setup_min', e.setup_min, 'teardown_min', e.teardown_min,
                                  'batch_id', e.batch_id, 'drive_before_m', e.drive_before_m, 'drive_after_m', e.drive_after_m,
                                  'title', e.title, 'note', e.note, 'gcal_event_id', e.gcal_event_id, 'role_id', e.role_id, 'role', (select r.label from public.crew_roles r where r.id = e.role_id),
                                  'confirm', (select jsonb_build_object('status', a.status, 'reason', a.reason, 'asked_at', a.asked_at, 'answered_at', a.answered_at, 'changed', a.changed)
                                                from public.crew_asks a where a.booking_id = e.booking_id and a.user_id = e.user_id),
                                  'booking_title', case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) end,
                                  'booking_location', b.location, 'booking_status', b.status)
                                  order by e.starts_at), '[]'::jsonb)
                  from public.schedule_entries e left join public.bookings b on b.id = e.booking_id
                 where e.starts_at - make_interval(mins => e.drive_before_min + e.setup_min) < v_to
                   and e.ends_at + make_interval(mins => e.drive_after_min + e.teardown_min) > v_from),
    -- clock in / out times only (no locations): "on the job" / "done" on the day's bars
    'punches', (select coalesce(jsonb_agg(jsonb_build_object('user_id', t.user_id, 'booking_id', t.booking_id, 'clock_in', t.clock_in, 'clock_out', t.clock_out) order by t.clock_in), '[]'::jsonb)
                  from public.time_punches t where t.clock_in < v_to and coalesce(t.clock_out, now()) > v_from),
    'tasks', case when v_tasks_mine then
               (select coalesce(jsonb_agg(jsonb_build_object('user_id', s.user_id, 'day', s.day, 'n', s.n)), '[]'::jsonb)
                  from (select t.user_id, g::date as day, count(*) as n
                          from public.staff_tasks t
                          cross join generate_series(p_start::timestamp, (v_end - 1)::timestamp, interval '1 day') g
                         where t.active and (v_tasks_all or t.user_id = v_me) and public.staff_task_due(t, g::date)
                         group by 1, 2) s)
             else '[]'::jsonb end);
end $function$;

-- ================================================================ 2. map places
create table if not exists public.schedule_geo (
  q text primary key,               -- the address as asked, lower-cased and trimmed
  lat double precision,
  lng double precision,
  found boolean not null default true,
  fetched_at timestamptz not null default now()
);
alter table public.schedule_geo enable row level security;
revoke all on public.schedule_geo from anon, authenticated;

create or replace function public.schedule_geo_key(p text) returns text
language sql immutable set search_path = '' as $$ select lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')) $$;

-- Studio, jobs and homes for the map, from p_start for p_days. Homes only with Scheduling edit (they are
-- addresses); everyone else gets the jobs and the studio. Coordinates come along where already looked up.
create or replace function public.schedule_map_places(p_start date, p_days integer default 1)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare v_end date; v_rows jsonb; v_studio text;
begin
  if not public.can('scheduling', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_start is null then raise exception 'pick a day'; end if;
  v_end := p_start + greatest(1, least(coalesce(p_days, 1), 42));
  v_studio := (select studio_address from public.staff_settings where id);
  with p as (
    select 'studio' as id, 'studio' as kind, 'Studio' as label, v_studio as address
     where coalesce(btrim(v_studio), '') <> ''
    union all
    select distinct on (x.booking_id) 'job:' || x.booking_id, 'job', split_part(x.title, ' • ', 1), public.schedule_destination(x.booking_id)
      from public.schedule_booking_days(p_start, v_end) x
     where coalesce(btrim(public.schedule_destination(x.booking_id)), '') <> ''
    union all
    select 'home:' || m.user_id, 'home', public.staff_name(m.user_id), m.home_address
      from public.team_members m
     where m.active and public.can('scheduling', 'edit') and coalesce(btrim(m.home_address), '') <> ''
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'label', p.label, 'q', public.schedule_geo_key(p.address),
                                               'lat', g.lat, 'lng', g.lng, 'known', g.q is not null)), '[]'::jsonb)
    into v_rows
    from p left join public.schedule_geo g on g.q = public.schedule_geo_key(p.address);
  return jsonb_build_object('places', v_rows);
end $function$;

-- The edge function stores what Google found (or that it found nothing, so it isn't asked again for a week).
create or replace function public.schedule_geo_store(p_q text, p_lat double precision, p_lng double precision)
 returns void
 language sql
 security definer
 set search_path to ''
as $function$
  insert into public.schedule_geo (q, lat, lng, found, fetched_at)
  values (public.schedule_geo_key(p_q), p_lat, p_lng, p_lat is not null, now())
  on conflict (q) do update set lat = excluded.lat, lng = excluded.lng, found = excluded.found, fetched_at = now()
$function$;

-- ================================================================ 3. send changes
create table if not exists public.schedule_changes (
  id bigserial primary key,
  user_id uuid not null,
  day date not null,                -- the Eastern day that changed
  what text not null,               -- added / changed / removed
  title text not null default '',
  at timestamptz not null default now(),
  by_user uuid,
  sent_at timestamptz
);
create index if not exists schedule_changes_unsent on public.schedule_changes (user_id, day) where sent_at is null;
alter table public.schedule_changes enable row level security;
revoke all on public.schedule_changes from anon, authenticated;

create or replace function public.schedule_entry_label(p_kind text, p_booking uuid, p_title text) returns text
language sql stable security definer set search_path = '' as $$
  select case when p_kind = 'job' then coalesce(split_part(public.schedule_booking_title(p_booking), ' • ', 1), 'On site job')
              else coalesce(nullif(p_title, ''), case p_kind when 'studio' then 'Studio' when 'admin' then 'Admin' else 'Work' end) end
$$;

create or replace function public.schedule_changes_note()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_today date := (now() at time zone 'America/New_York')::date;
  v_old date; v_new date;
begin
  if TG_OP <> 'INSERT' then v_old := (OLD.starts_at at time zone 'America/New_York')::date; end if;
  if TG_OP <> 'DELETE' then v_new := (NEW.starts_at at time zone 'America/New_York')::date; end if;
  if TG_OP = 'UPDATE' and NEW.user_id = OLD.user_id and NEW.starts_at = OLD.starts_at and NEW.ends_at = OLD.ends_at
     and NEW.kind = OLD.kind and NEW.booking_id is not distinct from OLD.booking_id
     and NEW.drive_before_min + NEW.setup_min = OLD.drive_before_min + OLD.setup_min
     and NEW.role_id is not distinct from OLD.role_id then
    return null;  -- nothing the person would notice (notes, drive back, meters)
  end if;
  if TG_OP <> 'INSERT' and OLD.kind not in ('off', 'flex') and v_old >= v_today and OLD.user_id is distinct from v_me
     and (TG_OP = 'DELETE' or NEW.user_id <> OLD.user_id or v_new <> v_old) then
    insert into public.schedule_changes (user_id, day, what, title, by_user)
    values (OLD.user_id, v_old, 'removed', public.schedule_entry_label(OLD.kind, OLD.booking_id, OLD.title), v_me);
  end if;
  if TG_OP <> 'DELETE' and NEW.kind not in ('off', 'flex') and v_new >= v_today and NEW.user_id is distinct from v_me then
    insert into public.schedule_changes (user_id, day, what, title, by_user)
    values (NEW.user_id, v_new, case when TG_OP = 'INSERT' or NEW.user_id <> OLD.user_id or v_new <> v_old then 'added' else 'changed' end,
            public.schedule_entry_label(NEW.kind, NEW.booking_id, NEW.title), v_me);
  end if;
  return null;
end $function$;

drop trigger if exists schedule_changes_note on public.schedule_entries;
create trigger schedule_changes_note after insert or update or delete on public.schedule_entries
  for each row execute function public.schedule_changes_note();

-- One email per person: each changed day as it is now, and what was taken off.
create or replace function public.schedule_change_content(p_uid uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  fmt constant text := 'FMHH12:MIam';
  v_today date := (now() at time zone 'America/New_York')::date;
  v_txt text[] := '{}'; v_htm text[] := '{}'; v_lines text[]; v_hl text[]; v_gone text; v_days int := 0; v_first date;
  v_name text; d record; r record; v_line text; v_sub text;
begin
  for d in select c.day, string_agg(distinct case when c.what = 'removed' then c.title end, ', ') as gone
             from public.schedule_changes c
            where c.user_id = p_uid and c.sent_at is null and c.day >= v_today
            group by c.day order by c.day loop
    v_days := v_days + 1; v_first := coalesce(v_first, d.day);
    v_lines := '{}'; v_hl := '{}';
    for r in select e.*, case when e.booking_id is not null then public.schedule_destination(e.booking_id) end as bloc, ro.label as role
               from public.schedule_entries e
               left join public.bookings b on b.id = e.booking_id
               left join public.crew_roles ro on ro.id = e.role_id
              where e.user_id = p_uid and e.kind not in ('off')
                and (e.starts_at at time zone 'America/New_York')::date = d.day
                and coalesce(b.status, 'booked') = 'booked'
              order by e.starts_at loop
      v_line := to_char(r.starts_at at time zone 'America/New_York', fmt) || '-' || to_char(r.ends_at at time zone 'America/New_York', fmt) || ' ' ||
                public.schedule_entry_label(r.kind, r.booking_id, r.title) || case when r.role is not null then ' (' || r.role || ')' else '' end;
      v_sub := concat_ws(' · ', case when r.kind = 'job' then nullif(r.bloc, '') end,
                 case when r.kind = 'job' and r.drive_before_min > 0 then public.schedule_leave_from(r.id) || ' ' ||
                   to_char((r.starts_at - make_interval(mins => r.drive_before_min + r.setup_min)) at time zone 'America/New_York', fmt) end);
      v_lines := v_lines || (v_line || case when v_sub <> '' then E'\n    ' || v_sub else '' end);
      v_hl := v_hl || ('<b>' || public.html_esc(v_line) || '</b>' || case when v_sub <> '' then '<br><span style="color:#6b675f;font-size:13px">' || public.html_esc(v_sub) || '</span>' else '' end);
    end loop;
    v_gone := nullif(d.gone, '');
    if cardinality(v_lines) = 0 then
      v_lines := array['Nothing scheduled now']; v_hl := array['Nothing scheduled now'];
    end if;
    v_txt := v_txt || (to_char(d.day, 'FMDy FMMon FMDD') || E':\n  ' || array_to_string(v_lines, E'\n  ') ||
                       case when v_gone is not null then E'\n  Taken off: ' || v_gone else '' end);
    v_htm := v_htm || ('<tr><td style="padding:8px 12px 8px 0;vertical-align:top;white-space:nowrap;color:#6b675f">' || to_char(d.day, 'FMDy FMMon FMDD') || '</td>' ||
                       '<td style="padding:8px 0;vertical-align:top">' || array_to_string(v_hl, '<br>') ||
                       case when v_gone is not null then '<br><span style="color:#a33;font-size:13px">Taken off: ' || public.html_esc(v_gone) || '</span>' else '' end || '</td></tr>');
  end loop;
  if v_days = 0 then return null; end if;
  v_name := split_part(public.staff_name(p_uid), ' ', 1);
  return jsonb_build_object(
    'days', v_days,
    'subject', 'Your schedule changed: ' || case when v_days = 1 then to_char(v_first, 'FMDy FMMon FMDD') else v_days || ' days' end,
    'text', 'Hi ' || v_name || E'. Your schedule changed. Here is how ' || case when v_days = 1 then 'that day looks' else 'those days look' end || E' now.\n\n' ||
            array_to_string(v_txt, E'\n\n') || E'\n\nYour whole schedule: https://admin.207photo.com/#staff/schedule',
    'html', '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1e1b;max-width:600px">' ||
            '<p style="font-size:16px">Hi ' || public.html_esc(v_name) || '. Your schedule changed. Here is how ' || case when v_days = 1 then 'that day looks' else 'those days look' end || ' now.</p>' ||
            '<table style="border-collapse:collapse;font-size:14.5px">' || array_to_string(v_htm, '') || '</table>' ||
            '<p style="margin-top:22px;font-size:13px;color:#6b675f"><a href="https://admin.207photo.com/#staff/schedule" style="color:#6b675f">Your whole schedule</a> in 207 Admin. Only your own schedule is in this email.</p></div>');
end $function$;

-- Who has changes not sent yet, with the days (Scheduling edit).
create or replace function public.schedule_changes_pending()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', s.user_id, 'name', public.staff_name(s.user_id), 'days', s.days, 'n', s.n,
                                                        'has_email', exists (select 1 from auth.users u where u.id = s.user_id and coalesce(u.email, '') <> ''))
                                     order by lower(public.staff_name(s.user_id))), '[]'::jsonb)
            from (select c.user_id, count(*) as n,
                         jsonb_agg(distinct c.day) as days
                    from public.schedule_changes c
                    join public.team_members m on m.user_id = c.user_id and m.active
                   where c.sent_at is null and c.day >= v_today
                   group by c.user_id) s);
end $function$;

create or replace function public.schedule_changes_preview(p_user uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return public.schedule_change_content(p_user);
end $function$;

-- p_send false: mark them done without emailing ("Don't send").
create or replace function public.schedule_changes_send(p_users uuid[], p_send boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v jsonb; v_req bigint; v_sent int := 0; v_noaddr int := 0; r record;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  for r in select distinct c.user_id, u.email
             from public.schedule_changes c
             join public.team_members m on m.user_id = c.user_id and m.active
             left join auth.users u on u.id = c.user_id
            where c.sent_at is null and (p_users is null or c.user_id = any (p_users)) loop
    if p_send then
      v := public.schedule_change_content(r.user_id);
      if v is not null then
        v_req := public.crew_send_email(r.email, v ->> 'subject', v ->> 'text', v ->> 'html');
        if v_req is null then v_noaddr := v_noaddr + 1; else v_sent := v_sent + 1; end if;
      end if;
    end if;
    update public.schedule_changes set sent_at = now() where user_id = r.user_id and sent_at is null;
  end loop;
  return jsonb_build_object('ok', true, 'sent', v_sent, 'no_email', v_noaddr);
end $function$;

-- ================================================================ 4. calendar link
create table if not exists public.staff_cal_tokens (
  user_id uuid primary key,
  token text not null unique,
  created_at timestamptz not null default now()
);
alter table public.staff_cal_tokens enable row level security;
revoke all on public.staff_cal_tokens from anon, authenticated;

-- Your own link (made the first time). p_reset makes a new one, so the old link stops working.
create or replace function public.staff_cal_link(p_reset boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_me uuid := (select auth.uid()); v_tok text;
begin
  if v_me is null or not exists (select 1 from public.team_members m where m.user_id = v_me and m.active) then
    raise exception 'Only people on the team have a schedule calendar.' using errcode = '42501';
  end if;
  if p_reset then
    update public.staff_cal_tokens set token = encode(extensions.gen_random_bytes(20), 'hex'), created_at = now() where user_id = v_me;
  end if;
  insert into public.staff_cal_tokens (user_id, token) values (v_me, encode(extensions.gen_random_bytes(20), 'hex'))
  on conflict (user_id) do nothing;
  select token into v_tok from public.staff_cal_tokens where user_id = v_me;
  return jsonb_build_object('ok', true, 'token', v_tok);
end $function$;

-- The .ics for a token: that person's schedule from 30 days ago to 6 months ahead.
create or replace function public.staff_ics(p_token text)
 returns text
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_uid uuid; v_name text; r record; v_desc text; v_loc text;
  fmt constant text := 'FMHH12:MIam';
  v_lines text[] := array['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//207 Photo//Schedule//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
                          'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  utc constant text := 'YYYYMMDD"T"HH24MISS"Z"';
begin
  if coalesce(length(p_token), 0) < 20 then return null; end if;
  select t.user_id into v_uid from public.staff_cal_tokens t join public.team_members m on m.user_id = t.user_id and m.active where t.token = p_token;
  if v_uid is null then return null; end if;
  v_name := split_part(public.staff_name(v_uid), ' ', 1);
  v_lines := v_lines || public.director_ics_fold('X-WR-CALNAME:' || public.director_ics_text('207 Photo: ' || v_name || '''s schedule'));
  for r in select e.*, b.status as bstatus, b.notes as crew_notes, b.wifi_network, b.wifi_password, ro.label as role,
                  case when e.booking_id is not null then public.schedule_destination(e.booking_id) end as bloc
             from public.schedule_entries e
             left join public.bookings b on b.id = e.booking_id
             left join public.crew_roles ro on ro.id = e.role_id
            where e.user_id = v_uid
              and e.ends_at > now() - interval '30 days' and e.starts_at < now() + interval '183 days'
            order by e.starts_at loop
    v_lines := v_lines || array['BEGIN:VEVENT', 'UID:' || r.id || '@schedule.207photo.com', 'DTSTAMP:' || to_char(now() at time zone 'UTC', utc)];
    if r.kind = 'off' then
      v_lines := v_lines || array[
        'DTSTART;VALUE=DATE:' || to_char((r.starts_at at time zone 'America/New_York')::date, 'YYYYMMDD'),
        'DTEND;VALUE=DATE:' || to_char(((r.ends_at - interval '1 second') at time zone 'America/New_York')::date + 1, 'YYYYMMDD'),
        public.director_ics_fold('SUMMARY:' || public.director_ics_text('Off' || case when r.title <> '' then ': ' || r.title else '' end)),
        'TRANSP:TRANSPARENT'];
    else
      v_loc := case when r.kind = 'job' then coalesce(r.bloc, '') else '' end;
      v_desc := concat_ws(E'\n',
        case when r.kind = 'job' and r.drive_before_min + r.setup_min > 0 then
          initcap(left(public.schedule_leave_from(r.id), 1)) || substr(public.schedule_leave_from(r.id), 2) || ' at ' ||
          to_char((r.starts_at - make_interval(mins => r.drive_before_min + r.setup_min)) at time zone 'America/New_York', fmt) ||
          coalesce(' (' || nullif(concat_ws(', ', case when r.drive_before_min > 0 then r.drive_before_min || ' min drive' end,
                                              case when r.setup_min > 0 then r.setup_min || ' min setup' end), '') || ')', '') end,
        case when r.role is not null then 'Role: ' || r.role end,
        case when r.kind = 'job' and coalesce(btrim(r.crew_notes), '') <> '' then 'For the crew: ' || btrim(r.crew_notes) end,
        case when r.kind = 'job' and coalesce(btrim(r.wifi_network), '') <> '' then 'WiFi: ' || btrim(r.wifi_network) ||
          case when coalesce(btrim(r.wifi_password), '') <> '' then ' / ' || btrim(r.wifi_password) else '' end end,
        nullif(btrim(r.note), ''),
        case when r.kind = 'job' then 'Job page: https://admin.207photo.com/#jobs/job/' || r.booking_id end);
      v_lines := v_lines || array[
        'DTSTART:' || to_char(r.starts_at at time zone 'UTC', utc),
        'DTEND:' || to_char(r.ends_at at time zone 'UTC', utc),
        public.director_ics_fold('SUMMARY:' || public.director_ics_text(public.schedule_entry_label(r.kind, r.booking_id, r.title) || case when r.role is not null then ' (' || r.role || ')' else '' end))];
      if v_loc <> '' then v_lines := v_lines || public.director_ics_fold('LOCATION:' || public.director_ics_text(v_loc)); end if;
      if coalesce(v_desc, '') <> '' then v_lines := v_lines || public.director_ics_fold('DESCRIPTION:' || public.director_ics_text(v_desc)); end if;
      -- a reminder 15 minutes before it's time to leave for a job (not for the later stops of a batched trip)
      if r.kind = 'job' and coalesce(r.bstatus, 'booked') = 'booked' and r.drive_before_min > 0 and public.schedule_leave_from(r.id) <> 'leave the last job' then
        v_lines := v_lines || array['BEGIN:VALARM', 'ACTION:DISPLAY', public.director_ics_fold('DESCRIPTION:' || public.director_ics_text('Leave in 15 minutes')),
                                    'TRIGGER:-PT' || (r.drive_before_min + r.setup_min + 15) || 'M', 'END:VALARM'];
      end if;
    end if;
    v_lines := v_lines || array['STATUS:' || case when r.bstatus = 'cancelled' then 'CANCELLED' else 'CONFIRMED' end, 'END:VEVENT'];
  end loop;
  v_lines := v_lines || 'END:VCALENDAR'::text;
  return array_to_string(v_lines, E'\r\n') || E'\r\n';
end $function$;

-- ================================================================ grants
revoke all on function
  public.schedule_geo_key(text), public.schedule_map_places(date, integer), public.schedule_geo_store(text, double precision, double precision),
  public.schedule_entry_label(text, uuid, text), public.schedule_changes_note(), public.schedule_change_content(uuid),
  public.schedule_changes_pending(), public.schedule_changes_preview(uuid), public.schedule_changes_send(uuid[], boolean),
  public.staff_cal_link(boolean), public.staff_ics(text)
from public, anon, authenticated;
grant execute on function public.schedule_map_places(date, integer), public.schedule_changes_pending(), public.schedule_changes_preview(uuid),
  public.schedule_changes_send(uuid[], boolean), public.staff_cal_link(boolean) to authenticated;
grant execute on function public.staff_ics(text) to anon, authenticated;
grant execute on function public.schedule_geo_store(text, double precision, double precision) to service_role;
