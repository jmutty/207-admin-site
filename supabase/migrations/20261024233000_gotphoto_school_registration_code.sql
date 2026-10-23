-- GotPhoto job create for schools: 207 Admin sets the job's global registration code (PUT /v4/jobs/{id}
-- registration_code, right after it makes the job) and saves the same code on the booking, which puts the school
-- on the hub and starts its emails, like typing the access code in by hand (booking_set_access_code).
-- Called by gotphoto-jobs (service role) only after GotPhoto took the code.
create or replace function public.gp_create_set_code(p_booking uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if v_code !~ '^[A-Z0-9-]{3,30}$' then return jsonb_build_object('ok', false, 'error', 'Codes are 3 to 30 letters or numbers.'); end if;
  -- Already typed in on the booking (hub set up then): nothing to redo.
  if exists (select 1 from bookings where id = p_booking and upper(access_code) = v_code) then
    return jsonb_build_object('ok', true, 'hub_school_id', (select hub_school_id from bookings where id = p_booking));
  end if;
  update bookings set access_code = v_code where id = p_booking and status = 'booked';
  if not found then return jsonb_build_object('ok', false, 'error', 'Booking not found or not active.'); end if;
  perform public.booking_hub_setup(p_booking);
  perform public.booking_reschedule(p_booking);
  return jsonb_build_object('ok', true, 'hub_school_id', (select hub_school_id from bookings where id = p_booking));
end $$;
revoke all on function public.gp_create_set_code(uuid, text) from public, anon, authenticated;
grant execute on function public.gp_create_set_code(uuid, text) to service_role;

-- Is this registration code free? Codes already on the hub or on another booking are taken (the check screen asks
-- before suggesting one).
create or replace function public.gp_registration_code_taken(p_code text, p_booking uuid default null) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from school_hub_schools where upper(access_code) = upper(btrim(p_code)))
      or exists (select 1 from bookings where upper(access_code) = upper(btrim(p_code)) and id is distinct from p_booking);
$$;
revoke all on function public.gp_registration_code_taken(text, uuid) from public, anon;
grant execute on function public.gp_registration_code_taken(text, uuid) to authenticated;
