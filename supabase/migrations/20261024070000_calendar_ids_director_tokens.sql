-- Two fixes found right after the walkthrough build went live (2026-10-23).
--
-- 1. "Missing in Google" on bookings that are on the calendar. The hourly Apps Script mirror (calendar-ingest) stores
--    each event under its iCal UID, "<id>@google.com", while bookings.google_event_id (written by calendar-write) is
--    the Calendar API's "<id>". Exact matches never hit, so booking_calendar_check flagged every booked event within
--    180 days as missing, the job page showed no mirror, "Use the calendar date" said the event wasn't mirrored, and
--    the Schedule drew the booking's own event as an extra calendar bar. Every lookup now compares the part before
--    the "@", which matches both forms. Then the check runs once so the flags clear now, not at 5:10 tomorrow.
-- 2. The director blocks the walkthrough build added to live emails ({{families_block}}, {{day_of_block}},
--    {{weather_line}}, {{team_times}}, {{flyer_line}}, {{day_link}}...) rendered blank: booking_vars, which fills
--    every booking email, didn't include booking_director_vars. It does now.
--
-- Text patches skip a function that already has them and fail loudly if the expected text isn't there. Safe to
-- run twice; no signature changes, nothing deleted.

create or replace function pg_temp.patch_once(p_sig regprocedure, p_marker text, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  if strpos(v_def, p_marker) > 0 then raise notice 'patch %: already applied', p_sig; return; end if;
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

-- ---------------------------------------------------------------- 1. calendar ids, either form
select pg_temp.patch_once('public.booking_calendar_check()'::regprocedure, 'split_part(ce.google_event_id',
  'left join calendar_events ce on ce\.google_event_id = b\.google_event_id',
  'left join calendar_events ce on split_part(ce.google_event_id, ''@'', 1) = b.google_event_id', 1);

select pg_temp.patch_once('public.admin_booking_detail(uuid)'::regprocedure, 'split_part(ce.google_event_id',
  'from calendar_events ce where ce\.google_event_id = b\.google_event_id\)',
  'from calendar_events ce where split_part(ce.google_event_id, ''@'', 1) = b.google_event_id limit 1)', 1);

select pg_temp.patch_once('public.booking_adopt_calendar_date(uuid)'::regprocedure, 'split_part(google_event_id',
  'from calendar_events where google_event_id = b\.google_event_id;',
  'from calendar_events where split_part(google_event_id, ''@'', 1) = b.google_event_id limit 1;', 1);

select pg_temp.patch_once(p.oid::regprocedure, 'split_part(ev.google_event_id',
  '([bd])\.google_event_id = ev\.google_event_id\)',
  '\1.google_event_id = split_part(ev.google_event_id, ''@'', 1))', 2)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'schedule_calendar';

select public.booking_calendar_check();

-- ---------------------------------------------------------------- 2. director tokens in every booking email
select pg_temp.patch_once(p.oid::regprocedure, 'booking_director_vars(p_booking)',
  '\n  return v;\nend',
  E'\n  -- the director blocks and links (20261024060000_director_journey)\n  return v || coalesce(public.booking_director_vars(p_booking), ''{}''::jsonb);\nend', 1)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'booking_vars';
