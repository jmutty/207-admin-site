-- Tests for 20261025070000_day_locations (a place for each picture day). Runs on a blank Postgres 16:
--   psql -d blank -f supabase/tests/day_locations_stub.sql   (the few tables and helpers it needs, as in production)
--   psql -d blank -f <the migration up to the in-place patches> && psql -d blank -f supabase/tests/day_locations_test.sql
-- "ALL DAY LOCATION TESTS PASSED" at the end means every check held.
\set ON_ERROR_STOP 1
create function pg_temp.ok(c boolean, w text) returns void language plpgsql as $$ begin if c is distinct from true then raise exception 'FAILED: %', w; end if; raise notice 'ok  %', w; end $$;
insert into booking_types values ('t', 'Team', 60, 'sports');
insert into prospect_orgs (id, name, town) values ('00000000-0000-0000-0000-0000000000a1', 'Bangor Y', 'Bangor');
insert into bookings (id, org_id, type_key, location) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 't', 'Main Gym, 1 Main St, Bangor');
select booking_set_days('00000000-0000-0000-0000-0000000000b1', '[{"day":"2026-11-16","start_time":"09:00","end_time":"12:00","location":""},
  {"day":"2026-11-17","start_time":"09:00","end_time":"12:00","location":"Hampden Academy, 89 Western Ave, Hampden"},
  {"day":"2026-11-18","start_time":"09:00","end_time":"12:00","location":"main gym, 1 main st, bangor"}]');
select pg_temp.ok((select location from booking_days where day='2026-11-17') = 'Hampden Academy, 89 Western Ave, Hampden', 'day 2 keeps its own place');
select pg_temp.ok((select location from booking_days where day='2026-11-18') is null, 'same words as Location = no own place');
select pg_temp.ok(schedule_destination('00000000-0000-0000-0000-0000000000b1', '2026-11-17') = 'Hampden Academy, 89 Western Ave, Hampden', 'destination of day 2');
select pg_temp.ok(schedule_destination('00000000-0000-0000-0000-0000000000b1', '2026-11-16') = 'Main Gym, 1 Main St, Bangor', 'day 1 falls back to Location');
select pg_temp.ok(schedule_destination('00000000-0000-0000-0000-0000000000b1', null) = 'Main Gym, 1 Main St, Bangor', 'no day = Location');
select pg_temp.ok((select string_agg(location, '|' order by day) from schedule_booking_days('2026-11-01','2026-12-01')) = 'Main Gym, 1 Main St, Bangor|Hampden Academy, 89 Western Ave, Hampden|Main Gym, 1 Main St, Bangor', 'Schedule days carry each place');
update booking_days set calendar_status = 'synced', google_event_id = 'g' || day;
-- a caller with no location key leaves places alone, and doesn't make events pending
select booking_set_days('00000000-0000-0000-0000-0000000000b1', '[{"day":"2026-11-16","start_time":"09:00","end_time":"12:00"},{"day":"2026-11-17","start_time":"09:00","end_time":"12:00"},{"day":"2026-11-18","start_time":"09:00","end_time":"12:00"}]');
select pg_temp.ok((select location from booking_days where day='2026-11-17') is not null, 'no location key keeps the place');
select pg_temp.ok((select count(*) from booking_days where calendar_status = 'pending') = 0, 'nothing pending without a change');
-- changing day 3's place makes only its event pending
select booking_set_days('00000000-0000-0000-0000-0000000000b1', '[{"day":"2026-11-16","start_time":"09:00","end_time":"12:00","location":""},{"day":"2026-11-17","start_time":"09:00","end_time":"12:00","location":"Hampden Academy, 89 Western Ave, Hampden"},{"day":"2026-11-18","start_time":"09:00","end_time":"12:00","location":"Brewer HS"}]');
select pg_temp.ok((select string_agg(day::text, ',') from booking_days where calendar_status = 'pending') = '2026-11-18', 'only the moved day goes pending');
update booking_days set calendar_status = 'synced';
-- clearing a place
select booking_set_days('00000000-0000-0000-0000-0000000000b1', '[{"day":"2026-11-16","location":""},{"day":"2026-11-17","location":""},{"day":"2026-11-18","location":"Brewer HS"}]');
select pg_temp.ok((select location from booking_days where day='2026-11-17') is null and (select calendar_status from booking_days where day='2026-11-17') = 'pending', 'cleared place goes pending');
update booking_days set calendar_status = 'synced';
-- the Location changing re-writes the later days
update bookings set location = 'New Gym' where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select count(*) from booking_days where calendar_status = 'pending') = 2, 'Location change: later days pending');
select pg_temp.ok(drive_leg_target('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b1','2026-11-18')->>'destination' = 'Brewer HS', 'drive leg to a day place');
select pg_temp.ok(drive_from_target('00000000-0000-0000-0000-0000000000b1', gen_random_uuid(), '2026-11-18')->>'destination' = 'Brewer HS', 'drive from home to a day place');
insert into staff_settings values (true, '60 Main Rd N, Hampden');
select pg_temp.ok(drive_time_target('00000000-0000-0000-0000-0000000000b1')->>'destination' = 'New Gym', 'drive with no day = Location');
select pg_temp.ok(drive_time_target('00000000-0000-0000-0000-0000000000b1', '2026-11-18')->>'destination' = 'Brewer HS', 'drive from studio to a day place');
insert into team_members values (gen_random_uuid(), true, null);
select pg_temp.ok((select count(*) from jsonb_array_elements(schedule_map_places('2026-11-16', 3)->'places') p where p->>'kind' = 'job') = 2
  and exists (select 1 from jsonb_array_elements(schedule_map_places('2026-11-16', 3)->'places') p where p->>'id' = 'job:00000000-0000-0000-0000-0000000000b1:2026-11-18'), 'map: own pin for the day elsewhere');
-- the crew_ask_content statements compile and work
do $$ declare v_lines text[] := '{}'; v_html text[] := '{}'; v_loc text := ''; v_dl text; v_first timestamptz; r record;
begin
  for r in select x.d as starts_at, x.w from (values ('2026-11-16 09:00'::timestamptz, 'A'), ('2026-11-17 09:00', 'B'), ('2026-11-18 09:00', 'A')) x(d, w) loop
    v_dl := coalesce(r.w, '');
    if v_first is null then v_loc := v_dl; end if;
    v_first := coalesce(v_first, r.starts_at);
    v_lines := v_lines || ('- ' || r.starts_at::date::text);
    v_html := v_html || ('<li>' || r.starts_at::date::text || '</li>');
    if v_dl <> '' and v_dl <> v_loc then
      v_lines[cardinality(v_lines)] := v_lines[cardinality(v_lines)] || ' at ' || v_dl;
      v_html[cardinality(v_html)] := replace(v_html[cardinality(v_html)], '</li>', ' at ' || v_dl || '</li>');
    end if;
  end loop;
  perform pg_temp.ok(array_to_string(v_lines, '|') = '- 2026-11-16|- 2026-11-17 at B|- 2026-11-18' and v_html[2] = '<li>2026-11-17 at B</li>' and v_loc = 'A', 'confirm email lines');
end $$;
\echo ALL DAY LOCATION TESTS PASSED
