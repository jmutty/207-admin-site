-- GotPhoto jobs made by 207 Admin (2026-10-23). A booking needs its GotPhoto job before email 0 can go out, and
-- the "Create the job in GotPhoto" link stopped working (GotPhoto retired its create page, so the link only
-- landed on the jobs list). Now the gotphoto-jobs function creates the job through GotPhoto's Admin API
-- (POST /v4/jobs). A sports booking links to it once the sync has picked it up; a school booking still needs
-- the access code typed in (the hub step).
--
-- What the new job gets (gp_type_defaults, one row per booking type, Jeremiah 2026-10-23):
--   - GotPhoto job type: Sport (Other) for sports, K-12 School for school photos;
--   - archive date: one month after the shoot for sports, June 1 after the shoot for schools (school's out);
--   - each other setting the row names (access type, price profile, communication profile, watermark, prepay,
--     ...); a setting left empty is copied from the newest job of that GotPhoto job type, so new jobs get this
--     season's prices and emails until a value is set here;
--   - the organization, the shoot address and the access type from this organization's own last job, if it
--     has one (an access type set in gp_type_defaults wins);
--   - the name the sync matches: "Org | Title | year" (school: "Org | Title | 2026-2027"), the next JOB00000.
-- Not in GotPhoto's API: "Switch price list on", coupons at creation, registration form fields, products.
--
-- gp_create_settings.auto_enabled: on = every upcoming booking with no job and nothing in the sync that looks
-- like its job gets one about 15 minutes after it is booked (time to make it by hand, and for the sync to link
-- one first). Off = only the "Create it in GotPhoto" button on the job.

create table if not exists public.gp_create_settings (
  id boolean primary key default true check (id),
  auto_enabled boolean not null default false,   -- switched on in the go-live, after a dry run
  grace_minutes int not null default 15,
  updated_at timestamptz not null default now()
);
insert into public.gp_create_settings (id) values (true) on conflict do nothing;
alter table public.gp_create_settings enable row level security;
drop policy if exists gp_create_settings_read on public.gp_create_settings;
create policy gp_create_settings_read on public.gp_create_settings for select to authenticated using (public.can_any('{bookings}', 'view'));

-- Per booking type. Null = copy from the newest job of gp_job_type.
create table if not exists public.gp_type_defaults (
  type_key text primary key references public.booking_types(key) on delete cascade,
  gp_job_type text not null,                      -- synced_jobs.job_type of the jobs to make and copy: sport_other, school_k_12
  archive_rule text not null check (archive_rule in ('month_after', 'june_1')),
  access_type text check (access_type in ('public', 'qr_tagging', 'single_password')),
  password_source text check (password_source in ('manual', 'qr_code', 'file_path', 'registration')),
  register_after_password_login text check (register_after_password_login in ('off', 'optional', 'required')),
  price_profile_id text,                          -- any season
  price_profile_fall text,                        -- shoots Aug to Oct
  price_profile_winter text,                      -- Nov to Feb
  price_profile_spring text,                      -- Mar to Jul
  communication_profile_id text,
  watermark_id int,
  prepay boolean,
  prepay_deadline_days int,                       -- days after the shoot
  review_orders_photos text check (review_orders_photos in ('off', 'on', 'auto')),
  customer_set_favorite_photo text check (customer_set_favorite_photo in ('off', 'favorite', 'student_id', 'yearbook')),
  photographer_goal int,
  labels jsonb not null default '{}'::jsonb,      -- GotPhoto names of the picked profiles, for Settings
  updated_at timestamptz not null default now()
);
insert into public.gp_type_defaults (type_key, gp_job_type, archive_rule) values
  ('sports_data', 'sport_other', 'month_after'),
  ('sports_nodata', 'sport_other', 'month_after'),
  ('school', 'school_k_12', 'june_1')
on conflict (type_key) do nothing;
alter table public.gp_type_defaults enable row level security;
drop policy if exists gp_type_defaults_read on public.gp_type_defaults;
create policy gp_type_defaults_read on public.gp_type_defaults for select to authenticated using (public.can_any('{bookings}', 'view'));

-- Settings > Job types > GotPhoto defaults. p: the columns above (empty string or null = copy from the newest job).
create or replace function public.gp_type_defaults_save(p_type text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v gp_type_defaults;
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  if not exists (select 1 from booking_types where key = p_type) then raise exception 'Unknown job type.'; end if;
  insert into gp_type_defaults (type_key, gp_job_type, archive_rule)
  select p_type, case when audience = 'school' then 'school_k_12' else 'sport_other' end, case when audience = 'school' then 'june_1' else 'month_after' end
    from booking_types where key = p_type
  on conflict (type_key) do nothing;
  update gp_type_defaults set
    gp_job_type = coalesce(nullif(p->>'gp_job_type', ''), gp_job_type),
    archive_rule = coalesce(nullif(p->>'archive_rule', ''), archive_rule),
    access_type = nullif(p->>'access_type', ''),
    register_after_password_login = nullif(p->>'register_after_password_login', ''),
    price_profile_id = nullif(p->>'price_profile_id', ''),
    price_profile_fall = nullif(p->>'price_profile_fall', ''),
    price_profile_winter = nullif(p->>'price_profile_winter', ''),
    price_profile_spring = nullif(p->>'price_profile_spring', ''),
    communication_profile_id = nullif(p->>'communication_profile_id', ''),
    prepay = case p->>'prepay' when 'true' then true when 'false' then false end,
    prepay_deadline_days = nullif(p->>'prepay_deadline_days', '')::int,
    review_orders_photos = nullif(p->>'review_orders_photos', ''),
    customer_set_favorite_photo = nullif(p->>'customer_set_favorite_photo', ''),
    photographer_goal = nullif(p->>'photographer_goal', '')::int,
    labels = coalesce(p->'labels', '{}'::jsonb),
    updated_at = now()
   where type_key = p_type returning * into v;
  return to_jsonb(v);
end $$;
revoke all on function public.gp_type_defaults_save(text, jsonb) from public, anon;
grant execute on function public.gp_type_defaults_save(text, jsonb) to authenticated;

-- One row per booking: what 207 Admin did in GotPhoto for it.
create table if not exists public.gp_job_creates (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  status text not null check (status in ('working', 'created', 'linked', 'failed')),
  job_name text,
  internal_name text,
  gotphoto_job_id text,
  template_job_id text,          -- settings copied from
  template_name text,
  org_job_id text,               -- organization / address / access type copied from (null = none on file)
  error text,
  attempts int not null default 0,
  next_try_at timestamptz,
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gp_job_creates enable row level security;
drop policy if exists gp_job_creates_read on public.gp_job_creates;
create policy gp_job_creates_read on public.gp_job_creates for select to authenticated using (public.can_any('{bookings}', 'view'));

-- The name the sync matches (same as gpJobName in app/src/bookings.js): sports use the shoot year, schools the
-- school year.
create or replace function public.gp_job_name(p_booking uuid) returns text
language sql stable security definer set search_path = public as $$
  select concat_ws(' | ', o.name, coalesce(nullif(btrim(b.title_label), ''), t.label),
           case when t.audience = 'school' then
             case when extract(month from b.picture_day) >= 7 then extract(year from b.picture_day)::int || '-' || (extract(year from b.picture_day)::int + 1)
                  else (extract(year from b.picture_day)::int - 1) || '-' || extract(year from b.picture_day)::int end
           else extract(year from b.picture_day)::int::text end)
    from bookings b join prospect_orgs o on o.id = b.org_id join booking_types t on t.key = b.type_key
   where b.id = p_booking;
$$;
revoke all on function public.gp_job_name(uuid) from public, anon, authenticated;

-- Jobs in the sync that could already be this booking's: same GotPhoto job type, within 3 weeks, the same name
-- test as booking_job_candidates (without its caller check, since this runs as the service role, and on
-- synced_jobs itself: sports_hub_jobs stops at 180 days out). Any hit = leave it to the person to link.
create or replace function public.gp_job_lookalikes(p_booking uuid) returns int
language sql stable security definer set search_path = public as $$
  with j as (
    select s.gotphoto_job_id, s.job_type, ((s.shoot_at at time zone 'Europe/Berlin'))::date as picture_day,
           btrim(regexp_replace(btrim(split_part(s.name, '|', 1)), '\s*(19|20)[0-9]{2}(\s*-\s*[0-9]{2,4})?\s*$', '')) as org
      from synced_jobs s where s.status <> 'archived')
  select count(*)::int
    from bookings b join prospect_orgs o on o.id = b.org_id
    join booking_types t on t.key = b.type_key
    left join gp_type_defaults d on d.type_key = b.type_key
    join j on j.job_type = coalesce(d.gp_job_type, case when t.audience = 'school' then 'school_k_12' else 'sport_other' end)
   where b.id = p_booking
     and (j.picture_day is null or abs(j.picture_day - b.picture_day) <= 21)
     and not exists (select 1 from bookings x where x.gotphoto_job_id = j.gotphoto_job_id and x.status in ('booked', 'tracked') and x.id <> b.id)
     and (public.hub_norm_name(j.org) = public.hub_norm_name(o.name)
          or public.hub_norm_name(j.org) like '%' || public.hub_norm_name(o.name) || '%'
          or public.hub_norm_name(o.name) like '%' || public.hub_norm_name(j.org) || '%'
          or exists (select 1 from unnest(coalesce(o.gotphoto_names, '{}')) g where public.hub_norm_name(j.org) = public.hub_norm_name(g)));
$$;
revoke all on function public.gp_job_lookalikes(uuid) from public, anon, authenticated;

-- What to create. p_booking = the button (that booking, now, whatever the setting); null = the cron's list.
-- p_preview = the dry run's list even while auto_enabled is off. Each item carries the settings to send
-- ('set', from gp_type_defaults and the dates) and the jobs to copy the rest from.
drop function if exists public.gp_create_queue(uuid, int);
create or replace function public.gp_create_queue(p_booking uuid default null, p_limit int default 10, p_preview boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s gp_create_settings; r record; v_out jsonb := '[]'::jsonb; v_tpl record; v_org record; v_seq int; v_archive date;
begin
  select * into s from gp_create_settings where id;
  if p_booking is null and not coalesce(s.auto_enabled, false) and not p_preview then return v_out; end if;
  -- Next internal number: past the highest JOB number GotPhoto has and any this function made that the sync
  -- has not seen yet.
  select greatest(coalesce((select max(substring(internal_name from '^JOB(\d+)$')::int) from synced_jobs), 0),
                  coalesce((select max(substring(internal_name from '^JOB(\d+)$')::int) from gp_job_creates), 0)) into v_seq;
  for r in
    select b.id, b.picture_day, b.type_key, o.name as org_name, o.gotphoto_names,
           coalesce(d.gp_job_type, case when t.audience = 'school' then 'school_k_12' else 'sport_other' end) as gp_job_type,
           coalesce(d.archive_rule, case when t.audience = 'school' then 'june_1' else 'month_after' end) as archive_rule, d.access_type,
           d.password_source, d.register_after_password_login, d.communication_profile_id, d.watermark_id,
           coalesce(case when extract(month from b.picture_day) between 8 and 10 then d.price_profile_fall
                         when extract(month from b.picture_day) between 3 and 7 then d.price_profile_spring
                         else d.price_profile_winter end, d.price_profile_id) as price_profile_id,
           d.prepay, d.prepay_deadline_days, d.review_orders_photos, d.customer_set_favorite_photo, d.photographer_goal
      from bookings b join prospect_orgs o on o.id = b.org_id join booking_types t on t.key = b.type_key
      left join gp_type_defaults d on d.type_key = b.type_key   -- a job type added later: the defaults by audience
      left join gp_job_creates c on c.booking_id = b.id
     where b.status = 'booked' and b.gotphoto_job_id is null and b.hub_school_id is null and b.picture_day is not null
       and case when p_booking is not null then b.id = p_booking and (c.booking_id is null or c.status = 'failed'
                                                                       or (c.status = 'working' and c.updated_at < now() - interval '5 minutes'))
                else b.picture_day >= (now() at time zone 'America/New_York')::date
                 and b.created_at < now() - make_interval(mins => s.grace_minutes)
                 and (c.booking_id is null or (c.status = 'failed' and c.attempts < 3 and c.next_try_at <= now()))
                 and public.gp_job_lookalikes(b.id) = 0 end
     order by b.picture_day limit p_limit
  loop
    -- Copy the rest from the newest job of this GotPhoto job type, preferring one made for this booking type.
    select j.gotphoto_job_id, j.name into v_tpl
      from synced_jobs j
     where j.job_type = r.gp_job_type and j.status <> 'archived'
     order by exists (select 1 from bookings x where x.gotphoto_job_id = j.gotphoto_job_id and x.type_key = r.type_key) desc,
              j.shoot_at desc nulls last limit 1;
    select j.gotphoto_job_id, j.name into v_org
      from synced_jobs j
     where public.hub_norm_name(btrim(split_part(j.name, '|', 1))) = public.hub_norm_name(r.org_name)
        or exists (select 1 from unnest(coalesce(r.gotphoto_names, '{}')) g where public.hub_norm_name(btrim(split_part(j.name, '|', 1))) = public.hub_norm_name(g))
     order by (j.job_type = r.gp_job_type) desc, j.shoot_at desc nulls last limit 1;
    v_archive := case r.archive_rule
      when 'june_1' then make_date(extract(year from r.picture_day)::int + case when extract(month from r.picture_day) >= 6 then 1 else 0 end, 6, 1)
      else (r.picture_day + interval '1 month')::date end;
    v_seq := v_seq + 1;
    v_out := v_out || jsonb_build_object('booking_id', r.id, 'job_name', public.gp_job_name(r.id),
      'internal_name', 'JOB' || lpad(v_seq::text, 5, '0'), 'shoot', r.picture_day,
      'template_job_id', v_tpl.gotphoto_job_id, 'template_name', v_tpl.name,
      'org_job_id', v_org.gotphoto_job_id, 'manual', p_booking is not null,
      'set', jsonb_strip_nulls(jsonb_build_object(
        'archive', v_archive,
        'access_type', r.access_type, 'password_source', r.password_source,
        'register_after_password_login', r.register_after_password_login,
        'price_profile_id', r.price_profile_id, 'communication_profile_id', r.communication_profile_id,
        'watermark_id', r.watermark_id, 'prepay', r.prepay,
        'prepay_deadline', case when r.prepay_deadline_days is not null then r.picture_day + r.prepay_deadline_days end,
        'review_orders_photos', r.review_orders_photos, 'customer_set_favorite_photo', r.customer_set_favorite_photo,
        'photographer_goal', r.photographer_goal)));
  end loop;
  return v_out;
end $$;
revoke all on function public.gp_create_queue(uuid, int, boolean) from public, anon, authenticated;
grant execute on function public.gp_create_queue(uuid, int, boolean) to service_role;

-- Claim a booking before calling GotPhoto, so two runs never make two jobs. False = someone else has it, or
-- it got a job in the meantime.
create or replace function public.gp_create_claim(p_item jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p_item->>'booking_id')::uuid; n int;
begin
  if exists (select 1 from bookings where id = v_id and (gotphoto_job_id is not null or hub_school_id is not null)) then return false; end if;
  insert into gp_job_creates as c (booking_id, status, job_name, internal_name, template_job_id, template_name, org_job_id, manual, attempts)
  values (v_id, 'working', p_item->>'job_name', p_item->>'internal_name', p_item->>'template_job_id', p_item->>'template_name',
          p_item->>'org_job_id', coalesce((p_item->>'manual')::boolean, false), 1)
  on conflict (booking_id) do update set status = 'working', job_name = excluded.job_name, internal_name = excluded.internal_name,
    template_job_id = excluded.template_job_id, template_name = excluded.template_name, org_job_id = excluded.org_job_id,
    manual = excluded.manual, attempts = c.attempts + 1, error = null, updated_at = now()
   where c.status = 'failed' or (c.status = 'working' and c.updated_at < now() - interval '5 minutes');
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.gp_create_claim(jsonb) from public, anon, authenticated;
grant execute on function public.gp_create_claim(jsonb) to service_role;

-- The result. p_retry false = do not try again by itself (GotPhoto may have made the job anyway).
create or replace function public.gp_create_done(p_booking uuid, p_job text, p_error text, p_retry boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  update gp_job_creates set
    status = case when p_job is not null then 'created' else 'failed' end,
    gotphoto_job_id = p_job, error = left(p_error, 500),
    attempts = case when p_job is null and not p_retry then greatest(attempts, 3) else attempts end,
    next_try_at = case when p_job is null then now() + make_interval(mins => 30 * attempts) end,
    updated_at = now()
   where booking_id = p_booking;
end $$;
revoke all on function public.gp_create_done(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.gp_create_done(uuid, text, text, boolean) to service_role;

-- Link created sports jobs once the sync has them (same steps as booking_link_job). Runs at the start of every
-- gotphoto-jobs call. School jobs are marked linked too; their booking joins the hub when the access code is
-- typed in.
create or replace function public.gp_create_link() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select c.booking_id, c.gotphoto_job_id, t.audience from gp_job_creates c join synced_jobs j on j.gotphoto_job_id = c.gotphoto_job_id
             join bookings b on b.id = c.booking_id join booking_types t on t.key = b.type_key
            where c.status = 'created' loop
    if r.audience = 'sports' then
      update bookings set gotphoto_job_id = r.gotphoto_job_id where id = r.booking_id and status = 'booked' and gotphoto_job_id is null;
      if found then
        perform public.booking_apply_workflow(r.booking_id);
        perform public.booking_reschedule(r.booking_id);
        n := n + 1;
      end if;
    end if;
    update gp_job_creates set status = 'linked', updated_at = now() where booking_id = r.booking_id;
  end loop;
  return n;
end $$;
revoke all on function public.gp_create_link() from public, anon, authenticated;
grant execute on function public.gp_create_link() to service_role;

-- Every 5 minutes, 3 minutes after the sync (on the 5s) and 1 after booking-match-jobs, so a job made by hand links first.
select cron.unschedule('gotphoto-jobs') where exists (select 1 from cron.job where jobname = 'gotphoto-jobs');
select cron.schedule('gotphoto-jobs', '3-59/5 * * * *', $$
  select net.http_post(
    url := 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/gotphoto-jobs?trigger=cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_trigger_secret')
    ),
    timeout_milliseconds := 120000
  );
$$);
