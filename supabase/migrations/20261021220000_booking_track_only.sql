-- Track-only jobs (2026-10-21).
--
-- Jobs that never went through Book a job (for example school jobs set up straight in GotPhoto) can sit on
-- the Bookings screen with status 'tracked', so their stages and deliverables are tracked like any booking.
-- A tracked row sends nothing: every email, calendar, hub and coach path acts only on status = 'booked'
-- (booking_claim_due, booking_poke_sender, booking_reschedule, booking_hub_setup, booking_calendar_check,
-- booking_inbox_threads, booking_match_jobs, hub_reminders_due, hub_watch_notify, admin_outbox, the
-- attention counts and the morning digest), and tracked rows get no booking_days, no booking_emails, no
-- contacts and calendar_status 'deleted' (no event). Those hub/outbox checks that suppress the hub's own
-- reminders for booked jobs keep seeing tracked jobs as not booked, so what goes out today is unchanged.
--
-- Adding: pick GotPhoto jobs from the sync (admin_trackable_jobs -> booking_track_jobs), or add one by hand.
-- Optional: booking_tracking_settings.auto_track adds new GotPhoto jobs by itself (hourly, only jobs first
-- synced after the switch was turned on, only when the organization can be matched). Off by default.

alter table public.bookings drop constraint bookings_status_check,
  add constraint bookings_status_check check (status in ('booked', 'cancelled', 'done', 'tracked'));

create table public.booking_tracking_settings (
  id         boolean primary key default true check (id),
  auto_track boolean not null default false,
  auto_since timestamptz,            -- set when auto_track is turned on; only jobs first synced after it are added
  updated_at timestamptz not null default now()
);
insert into public.booking_tracking_settings (id) values (true);
alter table public.booking_tracking_settings enable row level security;
revoke all on public.booking_tracking_settings from anon, authenticated;
grant select on public.booking_tracking_settings to authenticated;
create policy booking_tracking_settings_read on public.booking_tracking_settings for select to authenticated using (public.can_any('{bookings}', 'view'));

-- The organization a GotPhoto job belongs to: the name before the first "|" against the organization's
-- GotPhoto names, else its own name (same normalising as the hub matching). Null when unclear.
create function public.gotphoto_job_org(p_job text) returns uuid
language sql stable security definer set search_path to 'public' as $$
  with j as (select btrim(split_part(name, '|', 1)) as org_name from synced_jobs where gotphoto_job_id = p_job),
  m as (select o.id from prospect_orgs o, j
         where j.org_name = any (coalesce(o.gotphoto_names, '{}'))
            or exists (select 1 from unnest(coalesce(o.gotphoto_names, '{}')) g where public.hub_norm_name(g) = public.hub_norm_name(j.org_name))
            or public.hub_norm_name(o.name) = public.hub_norm_name(j.org_name))
  select case when (select count(*) from m) = 1 then (select id from m) end;
$$;

-- GotPhoto job id -> already on the Bookings screen (any status but cancelled), directly or through a school's hub row.
create function public.gotphoto_jobs_on_bookings() returns setof text
language sql stable security definer set search_path to 'public' as $$
  select b.gotphoto_job_id from bookings b where b.status <> 'cancelled' and b.gotphoto_job_id is not null
  union
  select public.school_hub_job(b.hub_school_id) from bookings b where b.status <> 'cancelled' and b.hub_school_id is not null;
$$;

-- GotPhoto jobs that are not on the Bookings screen yet, with a suggested organization and job type.
create function public.admin_trackable_jobs(p_days_back int default 180, p_days_ahead int default 365) returns setof jsonb
language sql stable security definer set search_path to 'public' as $$
  with taken as (select x from public.gotphoto_jobs_on_bookings() x where x is not null)
  select jsonb_build_object('gotphoto_job_id', j.gotphoto_job_id, 'name', j.name, 'status', j.status,
           'picture_day', (j.shoot_at at time zone 'Europe/Berlin')::date,
           'type_key', case when j.job_type like 'school%' or j.access_type = 'single_password' and j.job_type not like 'sport%' then 'school'
                            else (select key from booking_types where audience = 'sports' order by sort_order limit 1) end,
           'org_id', o.id, 'org_name', o.name)
    from synced_jobs j
    left join prospect_orgs o on o.id = public.gotphoto_job_org(j.gotphoto_job_id)
   where public.can_any('{bookings}', 'view')
     and j.shoot_at is not null and j.status <> 'archived'
     and (j.shoot_at at time zone 'Europe/Berlin')::date between current_date - p_days_back and current_date + p_days_ahead
     and j.gotphoto_job_id not in (select x from taken)
   order by j.shoot_at desc;
$$;

-- The one way a tracked row is made. p: {org_id, type_key, gotphoto_job_id?, picture_day?, title_label?}
create function public.booking_track_one(p jsonb) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare t booking_types; j synced_jobs; v_org uuid; v_pd date; v_start timestamptz; v_label text; v_id uuid;
begin
  select * into t from booking_types where key = p->>'type_key';
  if t.key is null then raise exception 'Pick a job type.'; end if;
  v_org := nullif(p->>'org_id', '')::uuid;
  if v_org is null or not exists (select 1 from prospect_orgs where id = v_org) then raise exception 'Pick an organization.'; end if;
  if nullif(p->>'gotphoto_job_id', '') is not null then
    select * into j from synced_jobs where gotphoto_job_id = p->>'gotphoto_job_id';
    if j.gotphoto_job_id is null then raise exception 'That GotPhoto job is not in the sync.'; end if;
    if j.gotphoto_job_id in (select x from public.gotphoto_jobs_on_bookings() x) then return null; end if;  -- already on the screen
  end if;
  v_pd := coalesce(nullif(p->>'picture_day', '')::date, (j.shoot_at at time zone 'Europe/Berlin')::date);
  if v_pd is null then raise exception 'Pick the picture day.'; end if;
  v_start := (v_pd + time '09:00') at time zone 'America/New_York';
  v_label := coalesce(nullif(btrim(p->>'title_label'), ''), nullif(btrim(split_part(j.name, '|', 2)), ''), t.title_labels[1], t.label);
  insert into bookings (org_id, type_key, sequence_id, title_label, picture_day, start_at, end_at, duration_min, contact_ids,
                        gotphoto_job_id, calendar_status, status, time_set, end_set, notes, created_by)
  values (v_org, t.key, null, v_label, v_pd, v_start, v_start + interval '1 hour', 60, '{}',
          j.gotphoto_job_id, 'deleted', 'tracked', false, false, nullif(btrim(p->>'notes'), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Add tracked jobs. p_items: [{gotphoto_job_id?, org_id, type_key, picture_day?, title_label?}]
create function public.booking_track_jobs(p_items jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare it jsonb; n int := 0; v_id uuid; v_ids uuid[] := '{}';
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' then return jsonb_build_object('ok', false, 'error', 'Nothing to add.'); end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_id := public.booking_track_one(it);
    if v_id is not null then n := n + 1; v_ids := v_ids || v_id; end if;
  end loop;
  return jsonb_build_object('ok', true, 'added', n, 'ids', to_jsonb(v_ids));
end $$;

-- Stop tracking: the row is set aside like a cancelled booking (history kept, nothing else touched).
create function public.booking_untrack(p_id uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  update bookings set status = 'cancelled', cancelled_at = now() where id = p_id and status = 'tracked';
  return jsonb_build_object('ok', found);
end $$;

create function public.booking_set_auto_track(p_on boolean) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  update booking_tracking_settings set auto_track = p_on, updated_at = now(),
         auto_since = case when p_on and not auto_track then now() else auto_since end;
  return jsonb_build_object('ok', true);
end $$;

-- Hourly when switched on: new GotPhoto jobs (first synced after the switch) whose organization is clear.
create function public.booking_auto_track() returns int
language plpgsql security definer set search_path to 'public' as $$
declare s booking_tracking_settings; r record; n int := 0; v_org uuid;
begin
  select * into s from booking_tracking_settings;
  if not coalesce(s.auto_track, false) or s.auto_since is null then return 0; end if;
  for r in select j.* from synced_jobs j
            where j.first_synced_at >= s.auto_since and j.shoot_at is not null and j.status <> 'archived'
              and j.gotphoto_job_id not in (select x from public.gotphoto_jobs_on_bookings() x where x is not null)
              and not exists (select 1 from bookings b where b.gotphoto_job_id = j.gotphoto_job_id)  -- untracked once: leave it
  loop
    v_org := public.gotphoto_job_org(r.gotphoto_job_id);
    if v_org is null then continue; end if;
    begin
      perform public.booking_track_one(jsonb_build_object('gotphoto_job_id', r.gotphoto_job_id, 'org_id', v_org,
        'type_key', case when r.job_type like 'school%' then 'school' else (select key from booking_types where audience = 'sports' order by sort_order limit 1) end));
      n := n + 1;
    exception when others then raise warning 'booking_auto_track %: %', r.gotphoto_job_id, sqlerrm;
    end;
  end loop;
  return n;
end $$;
select cron.schedule('booking-auto-track', '25 * * * *', 'select public.booking_auto_track();');

revoke all on function public.gotphoto_job_org(text), public.gotphoto_jobs_on_bookings(), public.booking_track_one(jsonb), public.booking_auto_track()
  from public, anon, authenticated;
revoke all on function public.admin_trackable_jobs(int, int), public.booking_track_jobs(jsonb), public.booking_untrack(uuid), public.booking_set_auto_track(boolean)
  from public, anon;
grant execute on function public.admin_trackable_jobs(int, int), public.booking_track_jobs(jsonb), public.booking_untrack(uuid), public.booking_set_auto_track(boolean)
  to authenticated;
