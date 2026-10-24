-- One time per day, everywhere (2026-10-24, Jeremiah: "I just changed a job's times on the scheduling calendar. That
-- should sync across Google Calendar, job, etc. Everywhere that time is used ... except other entries of the same
-- job, different dates").
--
-- Before this, a picture day's time lived on the job (booking_days) and on each crew bar (schedule_entries), and the
-- two only met when a job's first date moved. Now:
--   * booking_day_set_time: the Schedule sets one day's time on the job itself. The job page, Google Calendar event,
--     emails that mention the time and the hub follow, and everyone else on that day moves with it. Other dates of
--     the same job stay as they are. A makeup day goes through booking_makeup_apply as before.
--   * booking_set_days (Edit booking, the job page, the Schedule): the crew on a day follows that day. A changed time
--     moves their bars by the same amount (start with start, end with end), and a date that moves takes its crew
--     along, whichever date of the job it is (it used to be only the first date). Same number of dates before and
--     after: the 1st goes to the 1st, the 2nd to the 2nd. Otherwise a kept date keeps its crew and a dropped date's
--     crew goes to the new date, in order. A day that had no start time yet leaves the crew's times alone.

begin;

-- ---------------------------------------------------------------- saving the days (crew follows)
create or replace function public.booking_set_days(p_booking uuid, p_days jsonb) returns void
language plpgsql security definer set search_path = 'public' as $function$
declare b bookings; t booking_types; d jsonb; v_day date; v_st time; v_en time; v_start timestamptz; v_end timestamptz; v_i int := 0;
        v_first date; v_fstart timestamptz; v_fend timestamptz; v_tset boolean; v_eset boolean; v_keep date[] := '{}';
        v_has boolean; v_loc text; v_old jsonb; v_new jsonb := '[]'; v_tz text := 'America/New_York';
begin
  select * into b from bookings where id = p_booking;
  select * into t from booking_types where key = b.type_key;
  if p_days is null or jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) = 0 then return; end if;
  -- the picture days as they were, for moving the crew afterwards ("t": the day had a start time)
  select coalesce(jsonb_agg(jsonb_build_object('day', x.day, 's', x.start_at, 'e', x.end_at,
           't', case when x.sort = 0 then b.time_set is not false else true end) order by x.day), '[]')
    into v_old from booking_days x where x.booking_id = p_booking and x.kind = 'shoot' and not x.removed;
  if v_old = '[]'::jsonb and b.picture_day is not null then
    v_old := jsonb_build_array(jsonb_build_object('day', b.picture_day, 's', b.start_at, 'e', b.end_at, 't', b.time_set is not false));
  end if;
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
    v_new := v_new || jsonb_build_array(jsonb_build_object('day', v_day, 's', v_start, 'e', v_end, 't', v_st is not null));
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

  -- the crew follows its day: one statement, so each bar moves once
  begin
    with o as (select (x->>'day')::date od, (x->>'s')::timestamptz os, (x->>'e')::timestamptz oe, (x->>'t')::boolean ot, i
                 from jsonb_array_elements(v_old) with ordinality q(x, i)),
         n as (select (x->>'day')::date nd, (x->>'s')::timestamptz ns, (x->>'e')::timestamptz ne, (x->>'t')::boolean nt, i
                 from jsonb_array_elements(v_new) with ordinality q(x, i)),
         sc as (select (select count(*) from o) = (select count(*) from n) same),
         pairs as (
           select o.od, o.os, o.oe, o.ot, n.nd, n.ns, n.ne, n.nt from o join n on n.i = o.i where (select same from sc)
           union all
           select o.od, o.os, o.oe, o.ot, n.nd, n.ns, n.ne, n.nt from o join n on n.nd = o.od where not (select same from sc)
           union all
           select o2.od, o2.os, o2.oe, o2.ot, n2.nd, n2.ns, n2.ne, n2.nt
             from (select o.*, row_number() over (order by o.od) r from o where o.od not in (select nd from n)) o2
             join (select n.*, row_number() over (order by n.nd) r from n where n.nd not in (select od from o)) n2 on n2.r = o2.r
            where not (select same from sc)),
         m as (select p.*, (p.ot and p.nt) both_t from pairs p
                where p.nd <> p.od or (p.ot and p.nt and (p.os, p.oe) is distinct from (p.ns, p.ne))),
         mv as (select e.id, m.nd <> m.od moved,
                       case when m.both_t then e.starts_at + (m.ns - m.os)
                            else ((e.starts_at at time zone v_tz) + make_interval(days => m.nd - m.od)) at time zone v_tz end s2,
                       case when m.both_t then e.ends_at + (m.ne - m.oe)
                            else ((e.ends_at at time zone v_tz) + make_interval(days => m.nd - m.od)) at time zone v_tz end e2
                  from schedule_entries e join m on (e.starts_at at time zone v_tz)::date = m.od
                 where e.booking_id = p_booking and e.kind = 'job')
    update schedule_entries e
       set starts_at = mv.s2, ends_at = greatest(mv.e2, mv.s2 + interval '15 minutes'),
           batch_id = case when mv.moved then null else e.batch_id end, updated_at = now()
      from mv where e.id = mv.id;
  exception when others then raise warning 'booking_set_days crew: %', sqlerrm;  -- never block saving the job
  end;

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

-- ---------------------------------------------------------------- one day's time, from the Schedule
create or replace function public.booking_day_set_time(p_booking uuid, p_day date, p_start text, p_end text) returns jsonb
language plpgsql security definer set search_path = 'public' as $function$
declare b bookings; dd booking_days; v_st time := nullif(p_start, '')::time; v_en time := nullif(p_end, '')::time;
        v_days jsonb; v_before jsonb; v_after jsonb; v_cal boolean; v_tz text := 'America/New_York';
begin
  if not (public.can('scheduling', 'edit') or public.can_any('{bookings}', 'edit')) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking;
  if b.id is null then raise exception 'Booking not found.'; end if;
  if b.status = 'cancelled' then raise exception 'This booking was cancelled.'; end if;
  if v_st is null or v_en is null or v_en <= v_st then raise exception 'The end time has to be after the start time.'; end if;
  select * into dd from booking_days where booking_id = p_booking and day = p_day and not removed limit 1;
  if dd.kind = 'makeup' then
    return public.booking_makeup_apply(p_booking, p_day, v_st, v_en) || jsonb_build_object('kind', 'makeup', 'changed', true);
  end if;
  if dd.id is null and p_day is distinct from b.picture_day then raise exception 'That day is not on this job any more. Reload the week.'; end if;

  -- every picture day as it is, with only this one's time changed (places and labels stay)
  select jsonb_agg(jsonb_build_object('day', x.day, 'label', coalesce(x.label, ''),
           'start_time', case when x.day = p_day then to_char(v_st, 'HH24:MI') when x.sort = 0 and b.time_set is false then null
                              else to_char(x.start_at at time zone v_tz, 'HH24:MI') end,
           'end_time', case when x.day = p_day then to_char(v_en, 'HH24:MI') when x.sort = 0 and (b.time_set is false or b.end_set is false) then null
                            else to_char(x.end_at at time zone v_tz, 'HH24:MI') end) order by x.day)
    into v_days from booking_days x where x.booking_id = p_booking and x.kind = 'shoot' and not x.removed;
  if v_days is null then
    v_days := jsonb_build_array(jsonb_build_object('day', b.picture_day, 'start_time', to_char(v_st, 'HH24:MI'), 'end_time', to_char(v_en, 'HH24:MI')));
  end if;

  select jsonb_agg(jsonb_build_object('d', day, 's', start_at, 'e', end_at) order by day) into v_before from booking_days where booking_id = p_booking and not removed;
  perform public.booking_set_days(p_booking, v_days);
  select jsonb_agg(jsonb_build_object('d', day, 's', start_at, 'e', end_at) order by day) into v_after from booking_days where booking_id = p_booking and not removed;
  v_cal := v_before is distinct from v_after or (p_day = b.picture_day and b.time_set is false);
  if not v_cal then return jsonb_build_object('ok', true, 'kind', 'shoot', 'changed', false); end if;

  -- the same follow-through as Edit booking: the calendar event, the hub, and emails timed from the day
  update bookings set calendar_status = case when calendar_status in ('synced', 'moved', 'missing', 'error') then 'pending' else calendar_status end, calendar_error = null
   where id = p_booking and status = 'booked';
  if b.status = 'booked' then
    perform public.booking_hub_setup(p_booking);
    perform public.booking_reschedule(p_booking);
  end if;
  perform public.booking_poke('calendar-write', jsonb_build_object('booking_id', p_booking));
  return jsonb_build_object('ok', true, 'kind', 'shoot', 'changed', true);
end $function$;

revoke all on function public.booking_day_set_time(uuid, date, text, text) from public, anon;
grant execute on function public.booking_day_set_time(uuid, date, text, text) to authenticated;

commit;
