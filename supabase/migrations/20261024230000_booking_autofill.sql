-- Booking fields that repeat every season fill themselves (Jeremiah 2026-10-23).
--   1. Shooting: indoors unless we know better. Schools and winter are always indoors. A fall or spring sports job
--      follows the partner's last job of the same season (the few outdoor ones are set once, then carry over).
--      Replaces the old default (every sports job outdoors), and puts upcoming winter jobs back indoors.
--   2. Ordering dates from the launch (the day after the last picture day):
--        sports   free shipping + 20% off to launch + 3, 20% off to launch + 14, orders to launch + 30
--        schools  free shipping + 20% off to launch + 14, 20% off to launch + 1 month, orders to May 31 (June 1 archive)
--      bookings.free_ship_ends is new. order_dates_auto (on by default) keeps the three dates following the
--      picture day; typing your own in the booking form turns it off for that booking.
--      The GotPhoto archive date is the day after "order by", both on create (gp_create_queue) and on the date push.
--   3. The partner's address (prospect_orgs.address): learned from the newest booking's location, edited on the
--      partner page, and a new booking with no location starts with it.

-- ================================================================ 1. shooting
create or replace function public.booking_season(p_day date, p_label text) returns text
language sql immutable set search_path = '' as $$
  select case when p_label ilike '%fall%' or p_label ilike '%autumn%' then 'fall'
              when p_label ilike '%spring%' then 'spring'
              when p_label ilike '%winter%' then 'winter'
              when p_day is null then null
              when extract(month from p_day) between 3 and 6 then 'spring'
              when extract(month from p_day) between 7 and 10 then 'fall'
              else 'winter' end;
$$;
comment on function public.booking_season(date, text) is 'fall / spring / winter: the calendar title word when there is one (Fall Sports, Winter Sports 2), else the month (Mar-Jun spring, Jul-Oct fall).';

-- What "automatic" gives for a booking. p_exclude: the booking itself (when editing).
create or replace function public.booking_shoot_auto(p_org uuid, p_type text, p_day date, p_label text, p_exclude uuid default null)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_season text := public.booking_season(p_day, p_label); v_prev text;
begin
  if (select t.audience from public.booking_types t where t.key = p_type) = 'school' or v_season is null or v_season = 'winter' then return 'indoors'; end if;
  select b.shoot_setting into v_prev
    from public.bookings b join public.booking_types t on t.key = b.type_key
   where b.org_id = p_org and t.audience <> 'school' and b.status <> 'cancelled' and b.shoot_setting is not null
     and b.id is distinct from p_exclude and b.picture_day is not null
     and public.booking_season(b.picture_day, concat_ws(' ', b.title_label, b.title_override)) = v_season
   order by b.picture_day desc limit 1;
  return coalesce(v_prev, 'indoors');
end $$;
revoke all on function public.booking_shoot_auto(uuid, text, date, text, uuid) from public, anon;
grant execute on function public.booking_shoot_auto(uuid, text, date, text, uuid) to authenticated;

create or replace function public.booking_shoot_default() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.shoot_setting is null then
    new.shoot_setting := public.booking_shoot_auto(new.org_id, new.type_key, new.picture_day, concat_ws(' ', new.title_label, new.title_override), new.id);
  end if;
  return new;
end $$;
comment on column public.bookings.shoot_setting is 'Indoors / outdoors / either (has an indoor fallback). Blank = automatic (booking_shoot_auto): indoors, except a fall or spring sports job follows the partner''s last job of that season. Outdoors and either get the weather paragraph and the forecast check.';

-- Upcoming winter jobs that got "outdoors" from the old sports default.
update public.bookings b set shoot_setting = null
 where b.status = 'booked' and b.shoot_setting = 'outdoors'
   and b.picture_day >= (now() at time zone 'America/New_York')::date
   and public.booking_season(b.picture_day, concat_ws(' ', b.title_label, b.title_override)) = 'winter';

-- ================================================================ 2. ordering dates
alter table public.bookings
  add column if not exists free_ship_ends date,
  add column if not exists order_dates_auto boolean not null default true;
comment on column public.bookings.free_ship_ends is 'Last day of free shipping (with 20% off). Admin only for now: the emails mention the 20% (discount_ends).';
comment on column public.bookings.order_dates_auto is 'True: free_ship_ends / discount_ends / order_deadline follow the picture day (booking_order_dates). Typing a date in the booking form turns it off.';

-- The three dates for a booking, from its job type and last picture day.
create or replace function public.booking_order_dates(p_booking uuid, out free_ship date, out discount date, out order_by date)
language plpgsql stable security definer set search_path = '' as $$
declare v_aud text; v_last date; v_launch date;
begin
  select t.audience, greatest(b.picture_day, (select max(d.day) from public.booking_days d where d.booking_id = b.id and d.removed is not true))
    into v_aud, v_last
    from public.bookings b join public.booking_types t on t.key = b.type_key where b.id = p_booking;
  if v_last is null then return; end if;
  v_launch := v_last + 1;   -- galleries go up within a day
  if v_aud = 'school' then
    free_ship := v_launch + 14;
    discount := (v_launch + interval '1 month')::date;
    order_by := make_date(extract(year from v_last)::int + case when extract(month from v_last) >= 6 then 1 else 0 end, 6, 1) - 1;
  else
    free_ship := v_launch + 3;
    discount := v_launch + 14;
    order_by := v_launch + 30;
  end if;
end $$;
revoke all on function public.booking_order_dates(uuid) from public, anon;
grant execute on function public.booking_order_dates(uuid) to authenticated;

create or replace function public.booking_order_dates_refresh(p_booking uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  select * into v from public.booking_order_dates(p_booking);
  if v.order_by is null then return; end if;
  update public.bookings set free_ship_ends = v.free_ship, discount_ends = v.discount, order_deadline = v.order_by
   where id = p_booking and order_dates_auto and status = 'booked'
     and (free_ship_ends, discount_ends, order_deadline) is distinct from (v.free_ship, v.discount, v.order_by);
end $$;
revoke all on function public.booking_order_dates_refresh(uuid) from public, anon, authenticated;

create or replace function public.booking_order_dates_on_booking() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.booking_order_dates_refresh(new.id);
  return null;
end $$;
revoke all on function public.booking_order_dates_on_booking() from public, anon, authenticated;
create or replace trigger booking_order_dates after insert or update of picture_day, type_key, status, order_dates_auto on public.bookings
  for each row execute function public.booking_order_dates_on_booking();

create or replace function public.booking_order_dates_on_day() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.booking_order_dates_refresh(new.booking_id);
  return null;
end $$;
revoke all on function public.booking_order_dates_on_day() from public, anon, authenticated;
create or replace trigger booking_order_dates_day after insert or update of day, removed on public.booking_days
  for each row execute function public.booking_order_dates_on_day();

-- The booking form. Adds free_ship_ends and dates_auto.
create or replace function public.booking_director_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings;
begin
  if not public.can('bookings', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_id;
  if b.id is null then raise exception 'Booking not found.'; end if;
  return jsonb_build_object('team_times', b.team_times, 'order_deadline', b.order_deadline, 'discount_ends', b.discount_ends,
    'free_ship_ends', b.free_ship_ends, 'dates_auto', b.order_dates_auto,
    'shoot_setting', b.shoot_setting, 'school_data', b.school_data_at is not null,
    'day_link', 'https://admin.207photo.com/#day/' || b.day_token,
    'calendar_link', 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?t=' || b.day_token);
end $$;

-- p: any of team_times, free_ship_ends, discount_ends, order_deadline ('' clears a date), dates_auto (true: the three
-- dates follow the picture day and any sent are ignored; false: they are kept as sent), shoot_setting ('' = automatic),
-- school_data (true / false). Left-out keys are unchanged.
create or replace function public.booking_director_save(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_token text; v_auto boolean := case when p ? 'dates_auto' then (p ->> 'dates_auto')::boolean end;
  v_fs date; v_de date; v_od date;
begin
  if not public.can('bookings', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p ? 'team_times' and length(coalesce(p ->> 'team_times', '')) > 4000 then raise exception 'Team times are too long (4,000 characters at most).'; end if;
  if p ? 'shoot_setting' and coalesce(p ->> 'shoot_setting', '') not in ('', 'indoors', 'outdoors', 'either') then raise exception 'Shooting must be indoors, outdoors or either.'; end if;
  if v_auto is not true then
    v_fs := nullif(p ->> 'free_ship_ends', '')::date; v_de := nullif(p ->> 'discount_ends', '')::date; v_od := nullif(p ->> 'order_deadline', '')::date;
    if v_fs > v_de then raise exception 'Free shipping can''t end after the discount.'; end if;
    if v_de > v_od or v_fs > v_od then raise exception 'The discount can''t end after the order deadline.'; end if;
  end if;
  update public.bookings set
    team_times     = case when p ? 'team_times' then btrim(replace(coalesce(p ->> 'team_times', ''), E'\r', '')) else team_times end,
    order_dates_auto = coalesce(v_auto, order_dates_auto),
    free_ship_ends = case when v_auto is not true and p ? 'free_ship_ends' then v_fs else free_ship_ends end,
    order_deadline = case when v_auto is not true and p ? 'order_deadline' then v_od else order_deadline end,
    discount_ends  = case when v_auto is not true and p ? 'discount_ends' then v_de else discount_ends end,
    shoot_setting  = case when p ? 'shoot_setting' then nullif(p ->> 'shoot_setting', '') else shoot_setting end,
    school_data_at = case when p ? 'school_data' then case when (p ->> 'school_data')::boolean then coalesce(school_data_at, now()) end else school_data_at end
  where id = p_id
  returning day_token into v_token;
  if v_token is null then raise exception 'Booking not found.'; end if;
  if v_auto then perform public.booking_order_dates_refresh(p_id); end if;
  return jsonb_build_object('ok', true, 'day_link', 'https://admin.207photo.com/#day/' || v_token);
end $$;

-- GotPhoto job create: archive the day after the booking's "order by"; the rule (now launch + 30 for sports, so the
-- same date) only when a booking has none.
create or replace function public.gp_create_queue(p_booking uuid default null, p_limit int default 10, p_preview boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s gp_create_settings; r record; v_out jsonb := '[]'::jsonb; v_tpl record; v_org record; v_seq int; v_archive date; v_last date;
begin
  select * into s from gp_create_settings where id;
  if p_booking is null and not coalesce(s.auto_enabled, false) and not p_preview then return v_out; end if;
  -- Next internal number: past the highest JOB number GotPhoto has and any this function made that the sync
  -- has not seen yet.
  select greatest(coalesce((select max(substring(internal_name from '^JOB(\d+)$')::int) from synced_jobs), 0),
                  coalesce((select max(substring(internal_name from '^JOB(\d+)$')::int) from gp_job_creates), 0)) into v_seq;
  for r in
    select b.id, b.picture_day, b.type_key, b.order_deadline, o.name as org_name, o.gotphoto_names,
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
    -- Archive counts from the job's last day (a multi-day booking's booking_days), not the first.
    select greatest(r.picture_day, max(d.day)) into v_last from booking_days d where d.booking_id = r.id and d.removed is not true;
    v_last := coalesce(v_last, r.picture_day);
    v_archive := coalesce(r.order_deadline + 1, case r.archive_rule
      when 'june_1' then make_date(extract(year from v_last)::int + case when extract(month from v_last) >= 6 then 1 else 0 end, 6, 1)
      else v_last + 31 end);
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

-- Upcoming booked jobs get their dates now (linked GotPhoto jobs get the new archive date through the date push).
select public.booking_order_dates_refresh(b.id) from public.bookings b
 where b.status = 'booked' and b.order_dates_auto and b.picture_day >= (now() at time zone 'America/New_York')::date;

-- ================================================================ 3. the partner's address
alter table public.prospect_orgs add column if not exists address text;
comment on column public.prospect_orgs.address is 'Where we shoot for them: the newest booking''s location, or set on the partner page. New bookings start with it.';

create or replace function public.booking_location_from_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(btrim(new.location), '') = '' and new.org_id is not null then
    select nullif(btrim(o.address), '') into new.location from prospect_orgs o where o.id = new.org_id;
  end if;
  return new;
end $$;
revoke all on function public.booking_location_from_org() from public, anon, authenticated;
create or replace trigger booking_location_from_org before insert on public.bookings for each row execute function public.booking_location_from_org();

-- The newest booked job's place (or the first one we hear of) becomes the partner's address.
create or replace function public.booking_location_to_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'booked' or coalesce(btrim(new.location), '') = '' or new.org_id is null then return null; end if;
  if exists (select 1 from bookings x where x.org_id = new.org_id and x.id <> new.id and x.status = 'booked'
               and coalesce(btrim(x.location), '') <> '' and x.picture_day > new.picture_day)
     and exists (select 1 from prospect_orgs o where o.id = new.org_id and coalesce(btrim(o.address), '') <> '') then
    return null;
  end if;
  update prospect_orgs set address = btrim(new.location) where id = new.org_id and address is distinct from btrim(new.location);
  return null;
end $$;
revoke all on function public.booking_location_to_org() from public, anon, authenticated;
create or replace trigger booking_location_to_org after insert or update of location, status on public.bookings
  for each row execute function public.booking_location_to_org();

-- Partner page: change the address; upcoming jobs that still had the old one (or none) take the new one.
create or replace function public.org_address_save(p_org uuid, p_address text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o prospect_orgs; v_addr text := nullif(btrim(p_address), ''); r record; v_n int := 0;
begin
  if not public.can_any('{partners,bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into o from prospect_orgs where id = p_org;
  if o.id is null then raise exception 'Partner not found.'; end if;
  if length(coalesce(v_addr, '')) > 300 then raise exception 'The address can be up to 300 characters.'; end if;
  update prospect_orgs set address = v_addr where id = p_org;
  if v_addr is null then return jsonb_build_object('ok', true, 'jobs', 0); end if;
  for r in select id from bookings
            where org_id = p_org and status = 'booked' and picture_day >= (now() at time zone 'America/New_York')::date
              and (coalesce(btrim(location), '') = '' or btrim(location) = coalesce(btrim(o.address), ''))
              and location is distinct from v_addr loop
    update bookings set location = v_addr,
           calendar_status = case when calendar_status in ('synced', 'moved', 'missing', 'error') then 'pending' else calendar_status end, calendar_error = null
     where id = r.id;
    perform public.booking_poke('calendar-write', jsonb_build_object('booking_id', r.id));
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'jobs', v_n);
end $$;
revoke all on function public.org_address_save(uuid, text) from public, anon;
grant execute on function public.org_address_save(uuid, text) to authenticated;

-- Fill it from what we have: each partner's newest booking with a location.
update public.prospect_orgs o set address = x.location
  from (select distinct on (b.org_id) b.org_id, btrim(b.location) as location
          from public.bookings b
         where b.status in ('booked', 'tracked') and coalesce(btrim(b.location), '') <> ''
         order by b.org_id, b.picture_day desc nulls last) x
 where o.id = x.org_id and coalesce(btrim(o.address), '') = '';
