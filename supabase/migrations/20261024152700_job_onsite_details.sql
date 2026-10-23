-- On-site details on a job (2026-10-23). Schools send the WiFi after booking, and Jeremiah wants a place for it
-- plus free text that lands on the Google Calendar event so the crew sees it there.
--
-- 1. bookings.wifi_network / wifi_password. The existing bookings.notes ("For the crew") already goes on the event.
-- 2. job_get and admin_booking_detail return the two WiFi fields (patched in place, like 20261024140000).
-- 3. booking_update takes wifi_network / wifi_password (Edit booking) and re-writes the event when they change.
-- 4. job_onsite_save(booking, p): the Edit link on the job Overview's On-site details card. Only the keys sent
--    change (wifi_network, wifi_password, notes); the event is re-written, emails are not touched.
-- 5. Days after the first have their own events. A change to notes or WiFi marks those pending too, so every day
--    of a multi-day job shows the same text (before this, a notes edit only reached day 1's event).

alter table public.bookings add column if not exists wifi_network text, add column if not exists wifi_password text;

create or replace function pg_temp.patch_once(p_sig regprocedure, p_marker text, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  if strpos(v_def, p_marker) > 0 then raise notice 'patch %: already applied', p_sig; return; end if;
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

select pg_temp.patch_once('public.job_get(uuid)'::regprocedure, '''wifi_network''',
  '''notes'', b\.notes,',
  '''notes'', b.notes, ''wifi_network'', b.wifi_network, ''wifi_password'', b.wifi_password,', 1);

-- Edit booking reads the booking through admin_booking_detail.
select pg_temp.patch_once('public.admin_booking_detail(uuid)'::regprocedure, '''wifi_network''',
  '''contact_ids'', to_jsonb\(b\.contact_ids\),',
  '''contact_ids'', to_jsonb(b.contact_ids), ''wifi_network'', b.wifi_network, ''wifi_password'', b.wifi_password,', 1);

select pg_temp.patch_once('public.booking_update(uuid, jsonb)'::regprocedure, 'p ? ''wifi_network''',
  'or \(p \? ''notes'' and nullif\(btrim\(p->>''notes''\), ''''\) is distinct from b\.notes\)',
  'or (p ? ''notes'' and nullif(btrim(p->>''notes''), '''') is distinct from b.notes)
        or (p ? ''wifi_network'' and nullif(btrim(p->>''wifi_network''), '''') is distinct from b.wifi_network)
        or (p ? ''wifi_password'' and nullif(btrim(p->>''wifi_password''), '''') is distinct from b.wifi_password)', 1);

select pg_temp.patch_once('public.booking_update(uuid, jsonb)'::regprocedure, 'wifi_network = case',
  'notes = case when p \? ''notes'' then nullif\(btrim\(p->>''notes''\), ''''\) else notes end,',
  'notes = case when p ? ''notes'' then nullif(btrim(p->>''notes''), '''') else notes end,
    wifi_network = case when p ? ''wifi_network'' then nullif(btrim(p->>''wifi_network''), '''') else wifi_network end,
    wifi_password = case when p ? ''wifi_password'' then nullif(btrim(p->>''wifi_password''), '''') else wifi_password end,', 1);

create or replace function public.job_onsite_save(p_booking uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b bookings; v_net text; v_pw text; v_notes text;
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking;
  if b.id is null then raise exception 'Booking not found.'; end if;
  if b.status = 'cancelled' then raise exception 'This booking was cancelled.'; end if;
  v_net := case when p ? 'wifi_network' then nullif(btrim(p->>'wifi_network'), '') else b.wifi_network end;
  v_pw := case when p ? 'wifi_password' then nullif(btrim(p->>'wifi_password'), '') else b.wifi_password end;
  v_notes := case when p ? 'notes' then nullif(btrim(p->>'notes'), '') else b.notes end;
  if length(coalesce(v_net, '')) > 120 or length(coalesce(v_pw, '')) > 120 then raise exception 'The WiFi name and password can be up to 120 characters.'; end if;
  if length(coalesce(v_notes, '')) > 4000 then raise exception 'For the crew can be up to 4000 characters.'; end if;
  if (v_net, v_pw, v_notes) is not distinct from (b.wifi_network, b.wifi_password, b.notes) then
    return jsonb_build_object('ok', true, 'calendar', false);
  end if;
  update bookings set wifi_network = v_net, wifi_password = v_pw, notes = v_notes,
         calendar_status = case when status = 'booked' and calendar_status in ('synced', 'moved', 'missing', 'error') then 'pending' else calendar_status end,
         calendar_error = case when status = 'booked' then null else calendar_error end
   where id = p_booking;
  if b.status = 'booked' then perform public.booking_poke('calendar-write', jsonb_build_object('booking_id', p_booking)); end if;
  return jsonb_build_object('ok', true, 'calendar', b.status = 'booked');
end $$;
revoke all on function public.job_onsite_save(uuid, jsonb) from public, anon;
grant execute on function public.job_onsite_save(uuid, jsonb) to authenticated;

-- Every later day's event carries the same text as day 1.
create or replace function public.booking_onsite_days_pending() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update booking_days set calendar_status = 'pending', calendar_error = null
   where booking_id = new.id and not removed and sort > 0 and calendar_status in ('synced', 'error');
  return null;
end $$;
revoke all on function public.booking_onsite_days_pending() from public, anon, authenticated;
drop trigger if exists booking_onsite_days_pending on public.bookings;
create trigger booking_onsite_days_pending after update of notes, wifi_network, wifi_password on public.bookings
  for each row when ((old.notes, old.wifi_network, old.wifi_password) is distinct from (new.notes, new.wifi_network, new.wifi_password))
  execute function public.booking_onsite_days_pending();

-- ---------------------------------------------------------------- WiFi on the partner (2026-10-23, Jeremiah)
-- "Store that for each partner page also, so it auto-fills from season to season if it remains the same."
-- prospect_orgs.wifi_network / wifi_password hold the partner's last known WiFi:
--   * a new booking with no WiFi of its own starts with the partner's (before-insert trigger);
--   * WiFi saved on a job becomes the partner's (after-update trigger), so next season starts from it;
--   * org_wifi_save (partner page Overview) changes the partner's WiFi and every upcoming booked job that still
--     had the old one (or none), and re-writes those calendar events.
alter table public.prospect_orgs add column if not exists wifi_network text, add column if not exists wifi_password text;

create or replace function public.booking_wifi_from_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.wifi_network is null and new.wifi_password is null and new.org_id is not null then
    select o.wifi_network, o.wifi_password into new.wifi_network, new.wifi_password from prospect_orgs o where o.id = new.org_id;
  end if;
  return new;
end $$;
revoke all on function public.booking_wifi_from_org() from public, anon, authenticated;
drop trigger if exists booking_wifi_from_org on public.bookings;
create trigger booking_wifi_from_org before insert on public.bookings for each row execute function public.booking_wifi_from_org();

create or replace function public.booking_wifi_to_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update prospect_orgs set wifi_network = new.wifi_network, wifi_password = new.wifi_password
   where id = new.org_id and (wifi_network, wifi_password) is distinct from (new.wifi_network, new.wifi_password);
  return null;
end $$;
revoke all on function public.booking_wifi_to_org() from public, anon, authenticated;
drop trigger if exists booking_wifi_to_org on public.bookings;
create trigger booking_wifi_to_org after update of wifi_network, wifi_password on public.bookings
  for each row when ((old.wifi_network, old.wifi_password) is distinct from (new.wifi_network, new.wifi_password)
                     and (new.wifi_network is not null or new.wifi_password is not null))
  execute function public.booking_wifi_to_org();

create or replace function public.org_wifi_save(p_org uuid, p_network text, p_password text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o prospect_orgs; v_net text := nullif(btrim(p_network), ''); v_pw text := nullif(btrim(p_password), ''); r record; v_n int := 0;
begin
  if not public.can_any('{partners,bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into o from prospect_orgs where id = p_org;
  if o.id is null then raise exception 'Partner not found.'; end if;
  if length(coalesce(v_net, '')) > 120 or length(coalesce(v_pw, '')) > 120 then raise exception 'The WiFi name and password can be up to 120 characters.'; end if;
  update prospect_orgs set wifi_network = v_net, wifi_password = v_pw where id = p_org;
  -- upcoming jobs that still have the old WiFi (or none) take the new one
  for r in select id from bookings
            where org_id = p_org and status = 'booked' and picture_day >= (now() at time zone 'America/New_York')::date
              and (wifi_network, wifi_password) is not distinct from (o.wifi_network, o.wifi_password)
              and (wifi_network, wifi_password) is distinct from (v_net, v_pw) loop
    update bookings set wifi_network = v_net, wifi_password = v_pw,
           calendar_status = case when calendar_status in ('synced', 'moved', 'missing', 'error') then 'pending' else calendar_status end, calendar_error = null
     where id = r.id;
    perform public.booking_poke('calendar-write', jsonb_build_object('booking_id', r.id));
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'jobs', v_n);
end $$;
revoke all on function public.org_wifi_save(uuid, text, text) from public, anon;
grant execute on function public.org_wifi_save(uuid, text, text) to authenticated;
