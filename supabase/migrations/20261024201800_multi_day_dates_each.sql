-- Multi-day jobs name every shoot date, never a range (Jeremiah, 2026-10-23: "Nov 16 to Nov 19" hides that the 18th is off).
--
-- 1. {{picture_day}} for a multi-day job read "Sunday, Monday and Wednesday, November 16, November 17 and November 19":
--    every date was there, but you had to pair weekdays with dates by position. Now each day keeps its weekday:
--    "Sunday November 16, Monday November 17 and Wednesday November 19". One-day jobs are unchanged.
-- 2. {{picture_day_short}} (the coach email subjects) only ever showed the first day. A multi-day job now gets
--    "Nov 16, Nov 17 and Nov 19"; a one-day job still gets "Nov 16".
--
-- booking_schedule_words is replaced whole (same signature and keys, plus picture_day_short). booking_vars gets a text
-- patch that skips itself when already applied and fails loudly if the expected text isn't there. Safe to run twice;
-- nothing deleted.

create or replace function public.booking_schedule_words(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare b bookings; d record; n int := 0; lines text := ''; fulls text[] := '{}'; shorts text[] := '{}'; times text[] := '{}'; labels text[] := '{}';
        v_short text; v_pd text; v_pds text; v_same boolean := true; v_first_time text := null; v_st text; v_en text; v_t text;
begin
  select * into b from bookings where id = p_booking;
  for d in select * from booking_days where booking_id = p_booking and not removed order by day, sort loop
    n := n + 1;
    v_st := case when d.sort = 0 and not b.time_set then null
                 when d.sort > 0 and d.start_at is null then null
                 else trim(to_char(d.start_at at time zone 'America/New_York', 'FMHH12:MI AM')) end;
    v_en := case when d.sort = 0 and not b.end_set then null
                 when d.sort > 0 and d.end_at is null then null
                 else trim(to_char(d.end_at at time zone 'America/New_York', 'FMHH12:MI AM')) end;
    v_t := case when v_st is null then 'time to be confirmed' when v_en is null then 'starting at ' || v_st else v_st || ' to ' || v_en end;
    if v_first_time is null then v_first_time := v_t; elsif v_first_time <> v_t then v_same := false; end if;
    times := times || v_t;
    fulls := fulls || trim(to_char(d.day, 'FMDay FMMonth FMDD'));
    shorts := shorts || trim(to_char(d.day, 'Mon FMDD'));
    labels := labels || coalesce(d.label, '');
    lines := lines || '- ' || trim(to_char(d.day, 'FMDay, FMMonth FMDD')) || ', ' || v_t || case when d.label is not null then ': ' || d.label else '' end || E'\n';
  end loop;
  if n = 0 then return jsonb_build_object('days_count', 0); end if;
  if n = 1 then
    v_pd := trim(to_char(b.picture_day, 'FMDay, FMMonth FMDD'));
    v_pds := trim(to_char(b.picture_day, 'Mon FMDD'));
    v_short := v_pd || ', ' || times[1];
  else
    -- each day with its own weekday: "Sunday November 16, Monday November 17 and Wednesday November 19"
    v_pd := array_to_string(fulls[1:n-1], ', ') || ' and ' || fulls[n];
    v_pds := array_to_string(shorts[1:n-1], ', ') || ' and ' || shorts[n];
    v_short := v_pd || case when v_same then ', ' || times[1] || ' each day' else '' end;
  end if;
  return jsonb_build_object('days_count', n, 'schedule', rtrim(lines, E'\n'), 'schedule_short', v_short, 'picture_day', v_pd,
    'picture_day_short', v_pds,
    'start_time', case when b.time_set then trim(to_char(b.start_at at time zone 'America/New_York', 'FMHH12:MI AM')) else '' end,
    'end_time', case when b.end_set then trim(to_char(b.end_at at time zone 'America/New_York', 'FMHH12:MI AM')) else '' end,
    'same_times', v_same, 'labels', to_jsonb(labels));
end $function$;

create or replace function pg_temp.patch_once(p_sig regprocedure, p_marker text, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  if strpos(v_def, p_marker) > 0 then raise notice 'patch %: already applied', p_sig; return; end if;
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

select pg_temp.patch_once(p.oid::regprocedure, 'w->>''picture_day_short''',
  '''picture_day_short'', trim\(to_char\(b\.picture_day, ''Mon FMDD''\)\),',
  '''picture_day_short'', coalesce(w->>''picture_day_short'', trim(to_char(b.picture_day, ''Mon FMDD''))),', 1)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'booking_vars';
