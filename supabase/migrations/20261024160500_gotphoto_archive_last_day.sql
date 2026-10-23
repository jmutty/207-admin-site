-- GotPhoto job create: the archive date counts from the job's last day. A multi-day booking (booking_days)
-- archives a month after its last day, not its first (Jeremiah 2026-10-23). Otherwise as 20261024150000.
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
    -- Archive counts from the job's last day (a multi-day booking's booking_days), not the first.
    select greatest(r.picture_day, max(d.day)) into v_last from booking_days d where d.booking_id = r.id and d.removed is not true;
    v_last := coalesce(v_last, r.picture_day);
    v_archive := case r.archive_rule
      when 'june_1' then make_date(extract(year from v_last)::int + case when extract(month from v_last) >= 6 then 1 else 0 end, 6, 1)
      else (v_last + interval '1 month')::date end;
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
