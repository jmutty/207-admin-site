-- Two Settings saves updated their one-row settings table with no WHERE, which the API's safe-update guard refuses
-- ("UPDATE requires a WHERE clause") when a signed-in person saves (found 2026-10-24 with the partner merge fix).
-- Same functions, with `where true`.
create or replace function public.booking_set_auto_track(p_on boolean) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  update booking_tracking_settings set auto_track = p_on, updated_at = now(),
         auto_since = case when p_on and not auto_track then now() else auto_since end
   where true;
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.agreement_defaults_save(p jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $function$
declare v jsonb;
begin
  if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Nothing to save.'; end if;
  select coalesce(jsonb_object_agg(k, left(btrim(p ->> k), 200)), '{}'::jsonb) into v
    from unnest(array['RATIO', 'TA_GALLERY', 'TA_FILES', 'TA_COMPOSITE', 'TA_CARDS', 'TA_SHIP', 'INS_OCC', 'INS_AGG', 'INS_SAM_AMT', 'FIX_RATE',
                      'RESCHED_FEE', 'LIAB_CAP', 'COUNTY', 'SPACE_SIZE', 'SETUP_MIN', 'BREAKDOWN', 'NET_DAYS', 'ROSTER_EMAIL']) k
   where p ? k and jsonb_typeof(p -> k) in ('string', 'number');
  update public.partner_followup_settings set agreement_defaults = agreement_defaults || v, updated_at = now(), updated_by = auth.uid()
   where true;
  return jsonb_build_object('ok', true, 'defaults', (select agreement_defaults from public.partner_followup_settings));
end $function$;
