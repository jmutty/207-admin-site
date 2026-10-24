-- Stand-ins for the production tables and helpers that day_locations_test.sql touches (columns trimmed to what it uses).
create role anon; create role authenticated;
create table public.booking_types (key text primary key, label text, default_duration_min int, audience text);
create table public.prospect_orgs (id uuid primary key default gen_random_uuid(), name text, town text, address text);
create table public.bookings (id uuid primary key default gen_random_uuid(), org_id uuid, type_key text, status text default 'booked', location text,
  picture_day date, start_at timestamptz, end_at timestamptz, duration_min int, time_set boolean, end_set boolean, updated_at timestamptz,
  gotphoto_job_id text, notes text, wifi_network text, wifi_password text, calendar_status text default 'synced', title_label text);
create table public.booking_days (id uuid primary key default gen_random_uuid(), booking_id uuid, day date, start_at timestamptz, end_at timestamptz, label text, sort int,
  google_event_id text, calendar_status text, calendar_error text, calendar_attempts int default 0, removed boolean default false, created_at timestamptz default now(), updated_at timestamptz, kind text default 'shoot',
  unique (booking_id, day));
create table public.synced_jobs (gotphoto_job_id text, hub_dates jsonb);
create table public.staff_settings (id boolean primary key default true, studio_address text);
create table public.drive_time_cache (origin text, destination text, minutes int, meters int, fetched_at timestamptz default now());
create table public.drive_leg_cache (origin text, destination text, minutes int, meters int, fetched_at timestamptz default now());
create table public.team_members (user_id uuid, active boolean, home_address text);
create table public.schedule_geo (q text, lat float8, lng float8);
create function public.can(text, text) returns boolean language sql as 'select true';
create function public.schedule_booking_title(uuid) returns text language sql as $$ select 'Org • Type' $$;
create function public.staff_name(uuid) returns text language sql as $$ select 'X' $$;
create function public.schedule_geo_key(text) returns text language sql as $$ select lower(btrim($1)) $$;
create function public.schedule_from_home(uuid) returns boolean language sql as 'select true';
create function public.drive_cached(text, text) returns jsonb language sql as $$ select jsonb_build_object('minutes', 10) $$;
create function public.booking_onsite_days_pending() returns trigger language plpgsql security definer set search_path = 'public' as $$
begin
  update booking_days set calendar_status = 'pending', calendar_error = null
   where booking_id = new.id and not removed and sort > 0 and calendar_status in ('synced', 'error');
  return null;
end $$;
create trigger booking_onsite_days_pending after update of notes, wifi_network, wifi_password on public.bookings for each row execute function public.booking_onsite_days_pending();
create function public.schedule_destination(p_booking uuid) returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(b.location), ''), nullif(concat_ws(', ', o.name, nullif(o.town, ''), 'Maine'), 'Maine'))
    from public.bookings b left join public.prospect_orgs o on o.id = b.org_id where b.id = p_booking $$;
create function public.mileage_estimate(p_booking uuid) returns numeric language sql as 'select 1.0';
create function public.drive_time_target(p_booking uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;
create function public.drive_from_target(p_booking uuid, p_user uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;
create function public.drive_leg_target(p_from uuid, p_to uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;
