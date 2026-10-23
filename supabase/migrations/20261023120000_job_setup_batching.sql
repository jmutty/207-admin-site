-- Setup, teardown and batched jobs (2026-10-23).
--
-- 1. Every on site job bar gets setup time before it and teardown time after it (30 minutes each by
--    default, set on the Schedule under "Drive & setup", changeable per bar). They sit between the drive
--    and the job: leave the studio = start - setup - drive there; back = end + teardown + drive back.
--    Hours, "leave by", the morning email, the evening notification, Open jobs "busy" and time clock
--    scheduled hours all count them.
-- 2. Batched jobs: one person's job bars on one day can be joined into a trip (batch_id). The drive then
--    goes job to job: studio -> A -> B -> studio. The first bar's "drive there" is from the studio, each
--    later bar's "drive there" is from the job before it, and only the last bar drives back. The app works
--    the legs out (drive-time edge function, which now also does job -> job, cached in drive_leg_cache)
--    and saves them with schedule_batch_save. Mileage for a batched job is its share of the trip.
--
-- 3. Part time and 1099 people with a home address on the Team page (the Open jobs people) start and end at
--    home, not the studio: their drive there / back, the first and last legs of their trips, and their mileage
--    are measured from home. Everyone else is measured from the studio as before.
--
-- Existing bars that haven't ended get 30/30; past bars keep 0 so old weeks read as they did.
-- Functions from earlier migrations are patched in place (same approach as 20261023090000), so the
-- patterns here leave the text that 20261023101500 (crew, not live yet) patches untouched.

-- ---------------------------------------------------------------- columns
alter table public.schedule_entries
  add column setup_min     int,
  add column teardown_min  int,
  add column batch_id      uuid,
  add column drive_before_m int,
  add column drive_after_m  int;
update public.schedule_entries set setup_min = case when kind = 'job' and ends_at > now() then 30 else 0 end,
                                   teardown_min = case when kind = 'job' and ends_at > now() then 30 else 0 end;
alter table public.schedule_entries
  alter column setup_min set not null,
  alter column teardown_min set not null,
  add constraint schedule_entries_setup_check check (setup_min between 0 and 240 and teardown_min between 0 and 240),
  add constraint schedule_entries_meters_check check (coalesce(drive_before_m, 0) >= 0 and coalesce(drive_after_m, 0) >= 0),
  add constraint schedule_entries_setup_job_check check (kind = 'job' or (setup_min = 0 and teardown_min = 0 and batch_id is null));
create index schedule_entries_batch_idx on public.schedule_entries (batch_id) where batch_id is not null;
comment on column public.schedule_entries.setup_min is 'Minutes of setup before the job starts (on site, after the drive). 0 for bars that are not jobs.';
comment on column public.schedule_entries.teardown_min is 'Minutes of teardown after the job ends (on site, before the drive back).';
comment on column public.schedule_entries.batch_id is 'Job bars of one person on one day that are one trip (studio -> A -> B -> studio). Drive there on a later bar is from the job before it; only the last bar drives back.';
comment on column public.schedule_entries.drive_before_m is 'Meters of the drive there (batched bars only; null = use the round trip from the studio).';
comment on column public.schedule_entries.drive_after_m is 'Meters of the drive back (batched bars only).';

alter table public.staff_settings
  add column setup_min int not null default 30 check (setup_min between 0 and 240),
  add column teardown_min int not null default 30 check (teardown_min between 0 and 240);
comment on column public.staff_settings.setup_min is 'Default setup minutes on a new job bar.';
comment on column public.staff_settings.teardown_min is 'Default teardown minutes on a new job bar.';

-- A job bar saved without setup / teardown gets the defaults; any other bar gets 0 and no trip. This also
-- covers bars made by Open jobs (taking a job) and Book a job ("Who's shooting").
create function public.schedule_entries_setup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'job' then
    if new.setup_min is null then new.setup_min := coalesce((select s.setup_min from public.staff_settings s where s.id), 30); end if;
    if new.teardown_min is null then new.teardown_min := coalesce((select s.teardown_min from public.staff_settings s where s.id), 30); end if;
  else
    new.setup_min := 0; new.teardown_min := 0; new.batch_id := null; new.drive_before_m := null; new.drive_after_m := null;
  end if;
  return new;
end $$;
create trigger schedule_entries_setup before insert or update on public.schedule_entries
  for each row execute function public.schedule_entries_setup();

-- A trip of one bar isn't a trip.
create function public.schedule_entries_unbatch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.batch_id is not null and (tg_op = 'DELETE' or new.batch_id is distinct from old.batch_id) then
    update public.schedule_entries set batch_id = null, drive_before_m = null, drive_after_m = null
     where batch_id = old.batch_id and (select count(*) from public.schedule_entries x where x.batch_id = old.batch_id) = 1;
  end if;
  return null;
end $$;
create trigger schedule_entries_unbatch after update of batch_id or delete on public.schedule_entries
  for each row execute function public.schedule_entries_unbatch();

-- ---------------------------------------------------------------- job -> job drive times
create table public.drive_leg_cache (
  origin      text not null,             -- lower-cased, trimmed address of the job driven from
  destination text not null,             -- lower-cased, trimmed address of the job driven to
  minutes     int not null check (minutes between 0 and 1440),
  meters      int,
  fetched_at  timestamptz not null default now(),
  primary key (origin, destination)
);
comment on table public.drive_leg_cache is 'Drive times from one job to another (Google Routes API, via drive-time), for batched jobs.';
alter table public.drive_leg_cache enable row level security;
revoke all on public.drive_leg_cache from anon, authenticated;

-- Called by drive-time with the caller's token: what to ask Google, or the cached answer (either direction).
create function public.drive_leg_target(p_from uuid, p_to uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_origin text := public.schedule_destination(p_from); v_dest text := public.schedule_destination(p_to); c public.drive_leg_cache;
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
end $$;

create function public.drive_leg_store(p_origin text, p_destination text, p_minutes int, p_meters int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_minutes is null or p_minutes not between 0 and 1440 or coalesce(btrim(p_origin), '') = '' or coalesce(btrim(p_destination), '') = '' then raise exception 'bad drive time'; end if;
  insert into public.drive_leg_cache (origin, destination, minutes, meters)
  values (lower(btrim(p_origin)), lower(btrim(p_destination)), p_minutes, p_meters)
  on conflict (origin, destination) do update set minutes = excluded.minutes, meters = excluded.meters, fetched_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- home-based people
-- Part time and 1099 (gets_open_jobs) with a home address start and end at home.
create function public.schedule_from_home(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members m where m.user_id = p_user and btrim(m.home_address) <> '' and public.gets_open_jobs(m.user_id))
$$;

-- A cached drive from one address to another: Open jobs' home -> job cache or the job -> job cache.
create function public.drive_cached(p_origin text, p_destination text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select (select jsonb_build_object('minutes', x.minutes, 'meters', x.meters) from (
            select c.minutes, c.meters, c.fetched_at from public.offer_drive_cache c where c.origin = lower(btrim(p_origin)) and c.destination = lower(btrim(p_destination))
            union all
            select c.minutes, c.meters, c.fetched_at from public.drive_leg_cache c where c.origin = lower(btrim(p_origin)) and c.destination = lower(btrim(p_destination))
          ) x where x.fetched_at > now() - interval '180 days' order by x.fetched_at desc limit 1)
$$;

-- Called by drive-time with {booking_id, user_id}: the drive from where this person starts (home or the studio).
-- From home it is cached in drive_leg_cache (drive_leg_store); from the studio it is drive_time_target as before.
create function public.drive_from_target(p_booking uuid, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_home text; v_dest text := public.schedule_destination(p_booking); c jsonb;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.schedule_from_home(p_user) then return public.drive_time_target(p_booking) || jsonb_build_object('from', 'studio'); end if;
  if v_dest is null then return jsonb_build_object('ok', false, 'error', 'This job has no address. Add a location on the booking.'); end if;
  select btrim(home_address) into v_home from public.team_members where user_id = p_user;
  c := public.drive_cached(v_home, v_dest);
  return jsonb_build_object('ok', true, 'from', 'home', 'origin', v_home, 'destination', v_dest, 'minutes', c -> 'minutes', 'meters', c -> 'meters');
end $$;

-- ---------------------------------------------------------------- trips
-- Is this bar a later stop of a trip (so it leaves from the job before it, not the studio)?
create function public.schedule_batched_later(p_batch uuid, p_start timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_batch is not null and exists (select 1 from public.schedule_entries x where x.batch_id = p_batch and x.starts_at < p_start)
$$;

-- Miles for one person's job on one day: their share of a batched trip, else the round trip from home (Part
-- time / 1099 with a home address) or from the studio.
create function public.mileage_estimate_for(p_user uuid, p_booking uuid, p_day date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select round((e.drive_before_m + e.drive_after_m) / 1609.344, 1) from public.schedule_entries e
      where e.user_id = p_user and e.booking_id = p_booking and e.kind = 'job' and e.batch_id is not null
        and e.drive_before_m is not null and e.drive_after_m is not null
        and (e.starts_at at time zone 'America/New_York')::date = p_day
      order by e.starts_at limit 1),
    case when public.schedule_from_home(p_user)
         then (select round(2 * (public.drive_cached(m.home_address, public.schedule_destination(p_booking)) ->> 'meters')::numeric / 1609.344, 1)
                 from public.team_members m where m.user_id = p_user)
         else public.mileage_estimate(p_booking) end)
$$;

-- Join bars into trips, or take them out. p = {entries: [{id, batch_id (null = not batched), drive_before_min,
-- drive_after_min, drive_before_m?, drive_after_m?}]}. A trip is one person's job bars on one Eastern day.
-- Auto mileage trips that aren't approved yet follow the new miles.
create function public.schedule_batch_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare x jsonb; e public.schedule_entries; v_batches uuid[] := '{}'; v_b uuid; v_db int; v_da int;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p -> 'entries') is distinct from 'array' or jsonb_array_length(p -> 'entries') = 0 then raise exception 'Pick the jobs.'; end if;
  for x in select * from jsonb_array_elements(p -> 'entries') loop
    select * into e from public.schedule_entries where id = nullif(x ->> 'id', '')::uuid for update;
    if e.id is null then raise exception 'A bar was already removed. Reload the week.'; end if;
    if e.kind <> 'job' then raise exception 'Only on site jobs can be batched.'; end if;
    v_b := nullif(x ->> 'batch_id', '')::uuid;
    v_db := coalesce(nullif(x ->> 'drive_before_min', '')::int, e.drive_before_min);
    v_da := coalesce(nullif(x ->> 'drive_after_min', '')::int, e.drive_after_min);
    if v_db not between 0 and 600 or v_da not between 0 and 600 then raise exception 'Drive time is 0 to 600 minutes each way.'; end if;
    update public.schedule_entries
       set batch_id = v_b, drive_before_min = v_db, drive_after_min = v_da,
           drive_before_m = case when v_b is not null then nullif(x ->> 'drive_before_m', '')::int end,
           drive_after_m = case when v_b is not null then nullif(x ->> 'drive_after_m', '')::int end,
           updated_at = now()
     where id = e.id;
    if v_b is not null and not v_b = any (v_batches) then v_batches := v_batches || v_b; end if;
  end loop;
  if exists (select 1 from public.schedule_entries where batch_id = any (v_batches)
              group by batch_id having count(distinct user_id) > 1 or count(distinct (starts_at at time zone 'America/New_York')::date) > 1) then
    raise exception 'A trip is one person''s jobs on one day.';
  end if;
  update public.schedule_entries s set batch_id = null, drive_before_m = null, drive_after_m = null
   where s.batch_id = any (v_batches) and (select count(*) from public.schedule_entries x where x.batch_id = s.batch_id) = 1;

  update public.mileage_trips r set miles = public.mileage_estimate_for(r.user_id, r.booking_id, r.day), updated_at = now()
    from public.schedule_entries s
   where s.id in (select nullif(y ->> 'id', '')::uuid from jsonb_array_elements(p -> 'entries') y)
     and r.user_id = s.user_id and r.booking_id = s.booking_id and r.day = (s.starts_at at time zone 'America/New_York')::date
     and r.auto and not public.tc_locked(r.user_id, r.day)
     and public.mileage_estimate_for(r.user_id, r.booking_id, r.day) is not null;
  return jsonb_build_object('ok', true);
end $$;

-- Default setup / teardown for new job bars; p_apply also changes job bars from today on.
create function public.schedule_setup_save(p_setup int, p_teardown int, p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int := 0;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_setup is null or p_teardown is null or p_setup not between 0 and 240 or p_teardown not between 0 and 240 then
    raise exception 'Setup and teardown are 0 to 240 minutes each.';
  end if;
  update public.staff_settings set setup_min = p_setup, teardown_min = p_teardown, updated_at = now() where id;
  if coalesce(p_apply, false) then
    update public.schedule_entries set setup_min = p_setup, teardown_min = p_teardown, updated_at = now()
     where kind = 'job' and starts_at >= (now() at time zone 'America/New_York')::date::timestamp at time zone 'America/New_York'
       and (setup_min, teardown_min) is distinct from (p_setup, p_teardown);
    get diagnostics v_n = row_count;
  end if;
  return jsonb_build_object('ok', true, 'changed', v_n);
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
-- Bar extents everywhere: the drive plus setup before, teardown plus the drive after.
create function pg_temp.patch_extents(p_sig regprocedure, p_alias text, p_before int, p_after int)
returns void language plpgsql as $$
begin
  perform pg_temp.patch_function(p_sig, 'make_interval\(mins => ' || p_alias || '\.drive_before_min\)',
                                 'make_interval(mins => ' || p_alias || '.drive_before_min + ' || p_alias || '.setup_min)', p_before);
  perform pg_temp.patch_function(p_sig, 'make_interval\(mins => ' || p_alias || '\.drive_after_min\)',
                                 'make_interval(mins => ' || p_alias || '.drive_after_min + ' || p_alias || '.teardown_min)', p_after);
end $$;

-- schedule_save: p.setup_min / p.teardown_min (left out: the defaults on a new job bar, unchanged on an
-- existing one); moving a bar to another person or day takes it out of its trip; overlaps count setup/teardown.
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  'v_da int := coalesce\(nullif\(p ->> ''drive_after_min'', ''''\)::int, 0\);',
  'v_da int := coalesce(nullif(p ->> ''drive_after_min'', '''')::int, 0);
  v_su int := nullif(p ->> ''setup_min'', '''')::int;
  v_td int := nullif(p ->> ''teardown_min'', '''')::int;', 1);
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  'raise exception ''Drive time is 0 to 600 minutes each way\.''; end if;',
  'raise exception ''Drive time is 0 to 600 minutes each way.''; end if;
    if coalesce(v_su, 0) not between 0 and 240 or coalesce(v_td, 0) not between 0 and 240 then raise exception ''Setup and teardown are 0 to 240 minutes each.''; end if;', 1);
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  'drive_before_min = v_db, drive_after_min = v_da,',
  'drive_before_min = v_db, drive_after_min = v_da,
           setup_min = case when v_kind = ''job'' and kind = ''job'' then coalesce(v_su, setup_min) else v_su end,
           teardown_min = case when v_kind = ''job'' and kind = ''job'' then coalesce(v_td, teardown_min) else v_td end,
           batch_id = case when v_kind = ''job'' and user_id = v_user
                            and (starts_at at time zone ''America/New_York'')::date = (v_start at time zone ''America/New_York'')::date then batch_id end,', 1);
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  'starts_at, ends_at, drive_before_min, drive_after_min, title, note,',
  'starts_at, ends_at, drive_before_min, drive_after_min, setup_min, teardown_min, title, note,', 1);
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  'values \(v_user, v_kind, v_booking, v_start, v_end, v_db, v_da, ',
  'values (v_user, v_kind, v_booking, v_start, v_end, v_db, v_da, v_su, v_td, ', 1);
select pg_temp.patch_extents('public.schedule_save(jsonb)'::regprocedure, 'o', 1, 1);
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  '< v_end \+ make_interval\(mins => v_da\)',
  '< v_end + make_interval(mins => v_da + (select n.teardown_min from public.schedule_entries n where n.id = v_id))', 1);
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  '> v_start - make_interval\(mins => v_db\)',
  '> v_start - make_interval(mins => v_db + (select n.setup_min from public.schedule_entries n where n.id = v_id))', 1);

-- schedule_week: setup, teardown, trip and leg miles on each bar; the setup / teardown defaults; who starts at home.
select pg_temp.patch_function('public.schedule_week(date, integer)'::regprocedure,
  '''drive_after_min'', e\.drive_after_min,',
  '''drive_after_min'', e.drive_after_min, ''setup_min'', e.setup_min, ''teardown_min'', e.teardown_min,
                                  ''batch_id'', e.batch_id, ''drive_before_m'', e.drive_before_m, ''drive_after_m'', e.drive_after_m,', 1);
select pg_temp.patch_function('public.schedule_week(date, integer)'::regprocedure,
  '''studio_address'', \(select studio_address from public\.staff_settings where id\),',
  '''studio_address'', (select studio_address from public.staff_settings where id),
    ''setup_default'', (select setup_min from public.staff_settings where id),
    ''teardown_default'', (select teardown_min from public.staff_settings where id),', 1);
select pg_temp.patch_extents('public.schedule_week(date, integer)'::regprocedure, 'e', 1, 1);
select pg_temp.patch_function('public.schedule_week(date, integer)'::regprocedure,
  '''name'', public\.staff_name\(m\.user_id\),',
  '''name'', public.staff_name(m.user_id), ''from_home'', public.schedule_from_home(m.user_id),', 1);

-- my_day: the same on my bars, and whether a bar leaves from the job before it.
select pg_temp.patch_function('public.my_day(date)'::regprocedure,
  '''drive_after_min'', e\.drive_after_min,',
  '''drive_after_min'', e.drive_after_min, ''setup_min'', e.setup_min, ''teardown_min'', e.teardown_min, ''batch_id'', e.batch_id,
                                  ''from_last_job'', public.schedule_batched_later(e.batch_id, e.starts_at), ''from_home'', public.schedule_from_home(e.user_id),', 1);
select pg_temp.patch_extents('public.my_day(date)'::regprocedure, 'e', 1, 1);

-- Evening notification and morning email: leave earlier for setup, and a later stop leaves from the last job.
select pg_temp.patch_extents('public.day_plan_text(uuid, date, boolean)'::regprocedure, 'r', 1, 0);
select pg_temp.patch_function('public.day_plan_text(uuid, date, boolean)'::regprocedure,
  ''' \(leave '' \|\|',
  ''' (leave '' || case when public.schedule_batched_later(r.batch_id, r.starts_at) then ''the last job '' else '''' end ||', 1);
select pg_temp.patch_extents('public.day_email_content(uuid, date)'::regprocedure, 'r', 2, 1);
select pg_temp.patch_function('public.day_email_content(uuid, date)'::regprocedure,
  '''leave the studio '' \|\|',
  'case when public.schedule_batched_later(r.batch_id, r.starts_at) then ''leave the last job ''
        when public.schedule_from_home(r.user_id) then ''leave home '' else ''leave the studio '' end ||', 1);

-- Time clock scheduled hours and Open jobs "busy" count setup and teardown.
select pg_temp.patch_extents('public.tc_scheduled(uuid[], date, date)'::regprocedure, 'e', 2, 2);
select pg_temp.patch_extents('public.openjobs_candidates(uuid)'::regprocedure, 'e', 1, 1);

-- Mileage: a batched job's miles are its share of the trip.
select pg_temp.patch_function('public.tc_add_trip(uuid, uuid, date)'::regprocedure,
  'public\.mileage_estimate\(p_booking\)', 'public.mileage_estimate_for(p_user, p_booking, p_day)', 1);
select pg_temp.patch_function('public.mileage_refresh(date, boolean)'::regprocedure,
  'public\.mileage_estimate\(r\.booking_id\)', 'public.mileage_estimate_for(r.user_id, r.booking_id, r.day)', 2);
select pg_temp.patch_function('public.mileage_list(date, boolean)'::regprocedure,
  'public\.mileage_estimate\(r\.booking_id\)', 'public.mileage_estimate_for(r.user_id, r.booking_id, r.day)', 1);

-- ---------------------------------------------------------------- grants
revoke all on function public.schedule_entries_setup(), public.schedule_entries_unbatch(), public.schedule_batched_later(uuid, timestamptz),
  public.mileage_estimate_for(uuid, uuid, date), public.schedule_from_home(uuid), public.drive_cached(text, text) from public, anon, authenticated;
revoke all on function public.drive_leg_target(uuid, uuid), public.drive_leg_store(text, text, int, int), public.drive_from_target(uuid, uuid),
  public.schedule_batch_save(jsonb), public.schedule_setup_save(int, int, boolean) from public, anon;
grant execute on function public.drive_leg_target(uuid, uuid), public.drive_leg_store(text, text, int, int), public.drive_from_target(uuid, uuid),
  public.schedule_batch_save(jsonb), public.schedule_setup_save(int, int, boolean) to authenticated;
