-- Settings > Job types > GotPhoto defaults: "Photo access" also saves how the codes are made (password_source),
-- e.g. "Photo access for each person, with list of names" = qr_tagging + file_path; and one price list per job type.
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
    password_source = case when nullif(p->>'access_type', '') is null then null else coalesce(nullif(p->>'password_source', ''), 'manual') end,
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

-- One price list per job type from now on (picked again when a new season starts, in Settings or on the check
-- screen when a job is created). The per-season columns stay but are cleared, so gp_create_queue uses
-- price_profile_id. Jobs being booked now (late Oct 2026) are winter jobs, so a saved Winter list becomes the one list.
update public.gp_type_defaults
   set price_profile_id = coalesce(price_profile_winter, price_profile_id),
       labels = case when price_profile_winter is not null
                     then jsonb_set(labels, '{price_profile_id}', coalesce(labels->'price_profile_winter', to_jsonb(price_profile_winter)))
                     else labels end - 'price_profile_fall' - 'price_profile_winter' - 'price_profile_spring',
       price_profile_fall = null, price_profile_winter = null, price_profile_spring = null
 where price_profile_fall is not null or price_profile_winter is not null or price_profile_spring is not null;
