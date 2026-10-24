-- A different place for each picture day (2026-10-24, Jeremiah: "For multiple booking dates we should have the option
-- to choose a different address for each date and have that carry over the event").
--
-- booking_days.location: blank = the booking's Location (which itself starts as the partner's address). A day with
-- its own place carries it onto that day's Google Calendar event, the Schedule (bars, map, drive time), the crew
-- emails and confirm page, the staff calendar feed, mileage, and the director's "picture day is tomorrow" email.
-- Open job offers and "Ask who's available" still use the booking's Location.
--
-- booking_set_days only changes a day's place when the day it is given has a "location" key, so the callers that
-- don't send one (making a tracked job real, older screens) leave the places alone.

begin;

alter table public.booking_days add column if not exists location text;

-- ---------------------------------------------------------------- where a day is
create or replace function public.schedule_destination(p_booking uuid, p_day date) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select nullif(btrim(d.location), '') from public.booking_days d
                    where d.booking_id = p_booking and d.day = p_day and not d.removed order by d.kind = 'shoot' desc limit 1),
                  public.schedule_destination(p_booking))
$$;

create or replace function public.mileage_estimate(p_booking uuid, p_day date) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(2 * c.meters / 1609.344, 1)
    from public.staff_settings s
    join public.drive_time_cache c on c.origin = lower(btrim(s.studio_address)) and c.destination = lower(btrim(public.schedule_destination(p_booking, p_day)))
   where s.id and btrim(s.studio_address) <> '' and c.meters is not null
$$;

-- ---------------------------------------------------------------- saving the days
create or replace function public.booking_set_days(p_booking uuid, p_days jsonb) returns void
language plpgsql security definer set search_path = 'public' as $function$
declare b bookings; t booking_types; d jsonb; v_day date; v_st time; v_en time; v_start timestamptz; v_end timestamptz; v_i int := 0;
        v_first date; v_fstart timestamptz; v_fend timestamptz; v_tset boolean; v_eset boolean; v_keep date[] := '{}';
        v_has boolean; v_loc text;
begin
  select * into b from bookings where id = p_booking;
  select * into t from booking_types where key = b.type_key;
  if p_days is null or jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) = 0 then return; end if;
  for d in select x from jsonb_array_elements(p_days) x order by (x->>'day')::date loop
    v_day := (d->>'day')::date;
    if v_day is null then continue; end if;
    v_st := nullif(d->>'start_time', '')::time;
    v_en := nullif(d->>'end_time', '')::time;
    v_start := (v_day + coalesce(v_st, '09:00'::time)) at time zone 'America/New_York';
    v_end := case when v_en is not null and v_en > coalesce(v_st, '09:00'::time) then (v_day + v_en) at time zone 'America/New_York'
                  else v_start + make_interval(mins => coalesce(t.default_duration_min, 60)) end;
    -- the day's own place; the same words as the booking's Location count as no place of its own
    v_has := d ? 'location';
    v_loc := nullif(btrim(coalesce(d->>'location', '')), '');
    if lower(v_loc) = lower(btrim(coalesce(b.location, ''))) then v_loc := null; end if;
    if exists (select 1 from booking_days where booking_id = p_booking and day = v_day and kind = 'makeup' and not removed) then
      raise exception 'The makeup day is % already. Move the makeup day first, or pick another picture day.', to_char(v_day, 'FMMM/FMDD');
    end if;
    v_keep := v_keep || v_day;
    insert into booking_days (booking_id, day, start_at, end_at, label, sort, calendar_status, location)
    values (p_booking, v_day, v_start, v_end, nullif(btrim(d->>'label'), ''), v_i, case when v_i = 0 then 'synced' else 'pending' end, v_loc)
    on conflict (booking_id, day) do update set
      start_at = excluded.start_at, end_at = excluded.end_at, label = excluded.label, sort = excluded.sort, removed = false, updated_at = now(),
      location = case when v_has then excluded.location else booking_days.location end,
      calendar_status = case when booking_days.sort > 0 and excluded.sort > 0 and (booking_days.start_at is distinct from excluded.start_at or booking_days.end_at is distinct from excluded.end_at or booking_days.label is distinct from excluded.label
                                                                                   or (v_has and booking_days.location is distinct from excluded.location)) then 'pending'
                             when excluded.sort = 0 then 'synced' else booking_days.calendar_status end;
    if v_i = 0 then v_first := v_day; v_fstart := v_start; v_fend := v_end; v_tset := v_st is not null; v_eset := v_en is not null and v_en > coalesce(v_st, '09:00'::time); end if;
    v_i := v_i + 1;
  end loop;
  update booking_days set removed = true, calendar_status = case when google_event_id is not null then 'remove' else 'deleted' end, updated_at = now()
   where booking_id = p_booking and kind = 'shoot' and not (day = any(v_keep));
  delete from booking_days where booking_id = p_booking and removed and google_event_id is null;
  update booking_days set calendar_status = 'pending' where booking_id = p_booking and sort > 0 and google_event_id is null and not removed and calendar_status <> 'pending';
  update bookings set picture_day = v_first, start_at = v_fstart, end_at = v_fend,
         duration_min = greatest(15, least(720, (extract(epoch from (v_fend - v_fstart)) / 60)::int)),
         time_set = v_tset, end_set = v_eset, updated_at = now()
   where id = p_booking;
  if b.gotphoto_job_id is not null then
    update synced_jobs set hub_dates = case when (select count(*) from booking_days where booking_id = p_booking and not removed and kind = 'shoot') > 1
        then (select jsonb_agg(jsonb_build_object('date', d2.day::text, 'label', coalesce(d2.label, '')) order by d2.day) from booking_days d2 where d2.booking_id = p_booking and not d2.removed and d2.kind = 'shoot')
        else null end
     where gotphoto_job_id = b.gotphoto_job_id;
  end if;
end $function$;

-- A changed Location moves the days that follow it, so their events are written again (it already did for notes/WiFi).
drop trigger if exists booking_onsite_days_pending on public.bookings;
create trigger booking_onsite_days_pending after update of notes, wifi_network, wifi_password, location on public.bookings
  for each row when (old.notes is distinct from new.notes or old.wifi_network is distinct from new.wifi_network
                     or old.wifi_password is distinct from new.wifi_password or old.location is distinct from new.location)
  execute function public.booking_onsite_days_pending();

-- ---------------------------------------------------------------- the Schedule's days
create or replace function public.schedule_booking_days(p_from date, p_to date)
returns table(booking_id uuid, day date, start_at timestamptz, end_at timestamptz, title text, type_label text, location text, status text, day_label text)
language sql stable security definer set search_path = '' as $function$
  select b.id, x.day, x.s,
         case when x.s is null then null
              else coalesce(x.e, x.s + make_interval(mins => coalesce(b.duration_min, t.default_duration_min, 60))) end,
         public.schedule_booking_title(b.id), t.label, coalesce(nullif(btrim(x.loc), ''), b.location, ''),
         case when b.status = 'tracked' and x.kind = 'makeup' then 'booked' else b.status end, coalesce(x.label, '')
    from public.bookings b
    left join public.booking_types t on t.key = b.type_key
    cross join lateral (
      select d.day,
             case when (case when d.sort = 0 then b.time_set is not false else d.start_at is not null end) then d.start_at end as s,
             case when (case when d.sort = 0 then b.time_set is not false and b.end_set is not false else d.end_at is not null end) then d.end_at end as e,
             d.label, d.kind, d.location as loc
        from public.booking_days d where d.booking_id = b.id and d.removed is not true
      union all
      select b.picture_day,
             case when b.time_set is not false then b.start_at end,
             case when b.time_set is not false and b.end_set is not false then b.end_at end,
             null, 'shoot', null
       where not exists (select 1 from public.booking_days d where d.booking_id = b.id and d.kind = 'shoot')
    ) x
   where b.status <> 'cancelled' and x.day >= p_from and x.day < p_to
$function$;

-- The map: a day somewhere else is its own pin ("job:<booking>:<day>"); the rest of the job stays "job:<booking>".
create or replace function public.schedule_map_places(p_start date, p_days integer default 1) returns jsonb
language plpgsql stable security definer set search_path = '' as $function$
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
    select distinct on (j.id) j.id, 'job', j.label, j.dest
      from (select case when od.booking_id is not null then 'job:' || x.booking_id || ':' || x.day else 'job:' || x.booking_id end as id,
                   split_part(x.title, ' • ', 1) as label, public.schedule_destination(x.booking_id, x.day) as dest
              from public.schedule_booking_days(p_start, v_end) x
              left join public.booking_days od on od.booking_id = x.booking_id and od.day = x.day and not od.removed and nullif(btrim(od.location), '') is not null) j
     where coalesce(btrim(j.dest), '') <> ''
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

-- ---------------------------------------------------------------- drive time to a day's place
-- p_day is optional: without it (or for a day with no place of its own) it is the booking's Location as before.
drop function if exists public.drive_from_target(uuid, uuid);
drop function if exists public.drive_time_target(uuid);
drop function if exists public.drive_leg_target(uuid, uuid);

create function public.drive_time_target(p_booking uuid, p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $function$
declare v_origin text; v_dest text; c public.drive_time_cache;
begin
  if not (public.can('scheduling', 'edit') or public.can('timeclock', 'view')) then raise exception 'not allowed' using errcode = '42501'; end if;
  select btrim(studio_address) into v_origin from public.staff_settings where id;
  v_dest := public.schedule_destination(p_booking, p_day);
  if coalesce(v_origin, '') = '' then return jsonb_build_object('ok', false, 'error', 'Add the studio address on the Schedule page first.'); end if;
  if v_dest is null then return jsonb_build_object('ok', false, 'error', 'This job has no address. Add a location on the booking.'); end if;
  select * into c from public.drive_time_cache where destination = lower(v_dest) and origin = lower(v_origin) and fetched_at > now() - interval '180 days';
  return jsonb_build_object('ok', true, 'origin', v_origin, 'destination', v_dest, 'minutes', c.minutes, 'meters', c.meters);
end $function$;

create function public.drive_from_target(p_booking uuid, p_user uuid, p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $function$
declare v_home text; v_dest text := public.schedule_destination(p_booking, p_day); c jsonb;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.schedule_from_home(p_user) then return public.drive_time_target(p_booking, p_day) || jsonb_build_object('from', 'studio'); end if;
  if v_dest is null then return jsonb_build_object('ok', false, 'error', 'This job has no address. Add a location on the booking.'); end if;
  select btrim(home_address) into v_home from public.team_members where user_id = p_user;
  c := public.drive_cached(v_home, v_dest);
  return jsonb_build_object('ok', true, 'from', 'home', 'origin', v_home, 'destination', v_dest, 'minutes', c -> 'minutes', 'meters', c -> 'meters');
end $function$;

create function public.drive_leg_target(p_from uuid, p_to uuid, p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $function$
declare v_origin text := public.schedule_destination(p_from, p_day); v_dest text := public.schedule_destination(p_to, p_day); c public.drive_leg_cache;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_origin is null or v_dest is null then return jsonb_build_object('ok', false, 'error', 'A job has no address. Add a location on the booking.'); end if;
  if lower(btrim(v_origin)) = lower(btrim(v_dest)) then
    return jsonb_build_object('ok', true, 'origin', v_origin, 'destination', v_dest, 'minutes', 0, 'meters', 0);
  end if;
  select * into c from public.drive_leg_cache
   where ((origin = lower(btrim(v_origin)) and destination = lower(btrim(v_dest))) or (origin = lower(btrim(v_dest)) and destination = lower(btrim(v_origin))))
     and fetched_at > now() - interval '180 days'
   order by origin = lower(btrim(v_origin)) desc limit 1;
  return jsonb_build_object('ok', true, 'origin', v_origin, 'destination', v_dest, 'minutes', c.minutes, 'meters', c.meters);
end $function$;

revoke all on function public.schedule_destination(uuid, date), public.mileage_estimate(uuid, date) from public, anon, authenticated;
revoke all on function public.drive_time_target(uuid, date), public.drive_from_target(uuid, uuid, date), public.drive_leg_target(uuid, uuid, date) from public, anon;
grant execute on function public.drive_time_target(uuid, date), public.drive_from_target(uuid, uuid, date), public.drive_leg_target(uuid, uuid, date) to authenticated;

-- ---------------------------------------------------------------- the rest, patched in place so other changes to them stay
create function pg_temp.patch_text(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
begin
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute replace(v_def, p_from, p_to);
end $$;

-- the job page, the bookings list and the Edit booking form get each day's place
select pg_temp.patch_text('public.job_get(uuid)'::regprocedure,
  $p$'end_at', d.end_at, 'label', d.label)$p$, $p$'end_at', d.end_at, 'label', d.label, 'location', d.location)$p$, 1);
select pg_temp.patch_text('public.admin_bookings(date, date)'::regprocedure,
  $p$'label', d.label, 'sort', d.sort,$p$, $p$'label', d.label, 'location', d.location, 'sort', d.sort,$p$, 1);
-- a day's place changing counts as a change to the booking (its calendar event is written again)
select pg_temp.patch_text('public.booking_update(uuid, jsonb)'::regprocedure,
  $p$'l', label)$p$, $p$'l', label, 'p', location)$p$, 2);
-- {{location}} in a day's email ("picture day is tomorrow") is that day's place
select pg_temp.patch_text('public.booking_vars(uuid, uuid, uuid, integer)'::regprocedure,
  $p$'location', coalesce(b.location, ''),$p$, $p$'location', coalesce(nullif(btrim(dd.location), ''), b.location, ''),$p$, 1);
-- the Schedule knows which days are somewhere else (their own map pin)
select pg_temp.patch_text('public.schedule_week(date, integer)'::regprocedure,
  $p$'day_label', x.day_label,$p$,
  $p$'day_label', x.day_label, 'own_place', exists (select 1 from public.booking_days od where od.booking_id = x.booking_id and od.day = x.day and not od.removed and nullif(btrim(od.location), '') is not null),$p$, 1);
-- a crew bar (Schedule, My day) shows its day's place
select pg_temp.patch_text('public.schedule_week(date, integer)'::regprocedure,
  $p$'booking_location', b.location,$p$,
  $p$'booking_location', coalesce((select nullif(btrim(od.location), '') from public.booking_days od where od.booking_id = e.booking_id and od.day = (e.starts_at at time zone 'America/New_York')::date and not od.removed limit 1), b.location),$p$, 1);
select pg_temp.patch_text('public.my_day(date)'::regprocedure,
  $p$'booking_location', b.location,$p$,
  $p$'booking_location', coalesce((select nullif(btrim(od.location), '') from public.booking_days od where od.booking_id = e.booking_id and od.day = (e.starts_at at time zone 'America/New_York')::date and not od.removed limit 1), b.location),$p$, 1);
-- crew emails, the schedule email and the staff calendar feed: each shift's own place
select pg_temp.patch_text('public.schedule_change_content(uuid)'::regprocedure,
  'public.schedule_destination(e.booking_id)', $p$public.schedule_destination(e.booking_id, (e.starts_at at time zone 'America/New_York')::date)$p$, 1);
select pg_temp.patch_text('public.schedule_view_content(uuid)'::regprocedure,
  'public.schedule_destination(e.booking_id)', $p$public.schedule_destination(e.booking_id, (e.starts_at at time zone 'America/New_York')::date)$p$, 1);
select pg_temp.patch_text('public.week_email_content(uuid, date)'::regprocedure,
  'public.schedule_destination(e.booking_id)', $p$public.schedule_destination(e.booking_id, (e.starts_at at time zone 'America/New_York')::date)$p$, 1);
select pg_temp.patch_text('public.staff_ics(text)'::regprocedure,
  'public.schedule_destination(e.booking_id)', $p$public.schedule_destination(e.booking_id, (e.starts_at at time zone 'America/New_York')::date)$p$, 1);
-- My jobs and the confirm page: each day carries its place
select pg_temp.patch_text('public.crew_mine()'::regprocedure,
  $p$'note', e.note) order by e.starts_at)$p$,
  $p$'note', e.note, 'location', coalesce(public.schedule_destination(e.booking_id, (e.starts_at at time zone 'America/New_York')::date), '')) order by e.starts_at)$p$, 1);
select pg_temp.patch_text('public.crew_public(text)'::regprocedure,
  $p$'note', d.note)$p$,
  $p$'note', d.note, 'location', coalesce(public.schedule_destination(a.booking_id, (d.starts_at at time zone 'America/New_York')::date), ''))$p$, 1);
-- the "please confirm" email: Where is the first day's place, and a day somewhere else says so on its line
select pg_temp.patch_text('public.crew_ask_content(uuid, boolean)'::regprocedure,
  $p$v_loc := coalesce(public.schedule_destination(a.booking_id), '');$p$, $p$v_loc := '';$p$, 1);
select pg_temp.patch_text('public.crew_ask_content(uuid, boolean)'::regprocedure,
  'v_link text; v_subject text;', 'v_link text; v_subject text; v_dl text;', 1);
select pg_temp.patch_text('public.crew_ask_content(uuid, boolean)'::regprocedure,
  '    v_first := coalesce(v_first, r.starts_at);',
  $p$    v_dl := coalesce(public.schedule_destination(a.booking_id, (r.starts_at at time zone 'America/New_York')::date), '');
    if v_first is null then v_loc := v_dl; end if;
    v_first := coalesce(v_first, r.starts_at);$p$, 1);
select pg_temp.patch_text('public.crew_ask_content(uuid, boolean)'::regprocedure,
  $p$|| '</li>');$p$,
  $p$|| '</li>');
    if v_dl <> '' and v_dl <> v_loc then
      v_lines[cardinality(v_lines)] := v_lines[cardinality(v_lines)] || ' at ' || v_dl;
      v_html[cardinality(v_html)] := replace(v_html[cardinality(v_html)], '</li>', ' at ' || public.html_esc(v_dl) || '</li>');
    end if;$p$, 1);
-- mileage: a trip goes to that day's place
select pg_temp.patch_text('public.mileage_list(date, boolean)'::regprocedure,
  'public.schedule_destination(r.booking_id)', 'public.schedule_destination(r.booking_id, r.day)', 1);
select pg_temp.patch_text('public.mileage_estimate_for(uuid, uuid, date)'::regprocedure,
  'public.mileage_estimate(p_booking)', 'public.mileage_estimate(p_booking, p_day)', 3);

commit;
