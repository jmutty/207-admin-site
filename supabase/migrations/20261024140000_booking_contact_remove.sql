-- Taking someone off booking emails (2026-10-23). Jeremiah stopped David Utterback on the Penobscot Pioneers
-- partner page, but booking emails kept him on cc: "Stop emails" only stopped outreach, while booking emails go to
-- the contacts picked on each booking (bookings.contact_ids), and the queued rows already had him on cc.
--
-- 1. booking_contact_remove(booking, contact): the Remove button next to a person under "Who gets the emails" on a
--    job. Takes them off the booking and rebuilds the unsent emails' To / cc (booking_reschedule).
-- 2. booking_contact_drop(contact): takes a contact off every booked job and rebuilds those jobs' unsent emails.
--    prospect_contact_action calls it for Stop emails, Mark bounced, Mark unsubscribed and Remove, so "Stop all
--    emails" on the partner page now means booking emails too. Resume does not put them back on a job.
-- 3. job_get's contacts carry the contact id, so the job page can offer Remove.

create or replace function public.booking_contact_drop(p_contact uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b record; v_out jsonb := '[]'::jsonb; v_left int;
begin
  for b in select id, picture_day, coalesce(nullif(btrim(title_override), ''), title_label) as title from bookings
            where status = 'booked' and p_contact = any(contact_ids) order by picture_day loop
    update bookings set contact_ids = array_remove(contact_ids, p_contact) where id = b.id;
    perform public.booking_reschedule(b.id);
    select count(*) into v_left from bookings x join prospect_contacts c on c.id = any(x.contact_ids)
     where x.id = b.id and c.email is not null and c.bounced_at is null and c.unsubscribed_at is null and c.stopped_at is null;
    v_out := v_out || jsonb_build_object('id', b.id, 'title', b.title, 'picture_day', b.picture_day, 'nobody_left', v_left = 0);
  end loop;
  return v_out;
end $$;
revoke all on function public.booking_contact_drop(uuid) from public, anon, authenticated;

create or replace function public.booking_contact_remove(p_booking uuid, p_contact uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b bookings; v_left int;
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking;
  if b.id is null then raise exception 'Booking not found.'; end if;
  if not (p_contact = any(b.contact_ids)) then return jsonb_build_object('ok', true, 'already', true); end if;
  select count(*) into v_left from prospect_contacts c
   where c.id = any(array_remove(b.contact_ids, p_contact)) and c.email is not null
     and c.bounced_at is null and c.unsubscribed_at is null and c.stopped_at is null;
  if v_left = 0 and b.status = 'booked' then
    raise exception 'They are the only one getting this job''s emails. Add someone else with Edit booking first.';
  end if;
  update bookings set contact_ids = array_remove(contact_ids, p_contact) where id = p_booking;
  perform public.booking_reschedule(p_booking);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.booking_contact_remove(uuid, uuid) from public, anon;
grant execute on function public.booking_contact_remove(uuid, uuid) to authenticated;

-- prospect_contact_action as it is in production today, plus the booking_contact_drop call and 'bookings' in the answer.
create or replace function public.prospect_contact_action(p_contact uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_c prospect_contacts; v_emailed boolean; v_bk jsonb := '[]'::jsonb;
begin
  if not public.can_any('{partners}', 'edit') then raise exception 'Not authorized'; end if;
  select * into v_c from prospect_contacts where id = p_contact;
  if v_c.id is null then raise exception 'Contact not found'; end if;
  if p_action in ('stop', 'bounced', 'unsubscribed') then
    update prospect_threads set status = 'stopped', next_send_at = null where contact_id = p_contact and status = 'active';
  end if;
  if p_action = 'stop' then
    update prospect_contacts set stopped_at = now() where id = p_contact;
  elsif p_action = 'resume' then
    update prospect_contacts set stopped_at = null where id = p_contact;
  elsif p_action = 'bounced' then
    update prospect_contacts set bounced_at = coalesce(bounced_at, now()) where id = p_contact;
  elsif p_action = 'unsubscribed' then
    update prospect_contacts set unsubscribed_at = coalesce(unsubscribed_at, now()) where id = p_contact;
  elsif p_action = 'clear_flags' then
    update prospect_contacts set bounced_at = null, unsubscribed_at = null, stopped_at = null where id = p_contact;
  elsif p_action = 'primary' then
    update prospect_contacts set is_primary = true where id = p_contact;
  elsif p_action = 'unprimary' then
    update prospect_contacts set is_primary = false where id = p_contact;
  elsif p_action = 'remove' then
    -- anyone we've emailed stays (their history matters); stop them instead
    v_emailed := exists (select 1 from prospect_threads where contact_id = p_contact and current_step > 0)
              or exists (select 1 from prospect_activities where contact_id = p_contact and kind in ('email_sent', 'history_email', 'reply'));
    if v_emailed then raise exception 'We have emailed % before, so they stay on the record. Use Stop emails instead.', v_c.email; end if;
    v_bk := public.booking_contact_drop(p_contact);
    delete from prospect_contacts where id = p_contact;
  else
    raise exception 'Unknown action % (stop, resume, bounced, unsubscribed, clear_flags, primary, unprimary, remove)', p_action;
  end if;
  -- stopped, bounced or unsubscribed: off every booked job's emails too (2026-10-23)
  if p_action in ('stop', 'bounced', 'unsubscribed') then v_bk := public.booking_contact_drop(p_contact); end if;
  -- the enrollment roll-up the old screens read
  update prospect_enrollments e set next_send_at = (select min(next_send_at) from prospect_threads t where t.enrollment_id = e.id and t.status = 'active')
   where e.id in (select enrollment_id from prospect_threads where contact_id = p_contact) and e.status = 'active';
  return jsonb_build_object('ok', true, 'bookings', v_bk);
end $$;

-- job_get: contacts carry their id (for Remove on the job page)
create or replace function pg_temp.patch_once(p_sig regprocedure, p_marker text, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  if strpos(v_def, p_marker) > 0 then raise notice 'patch %: already applied', p_sig; return; end if;
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

select pg_temp.patch_once('public.job_get(uuid)'::regprocedure, '''contact_id'', c.id',
  '''email'', c\.email, ''phone'', c\.phone, ''role'', c\.role\)',
  '''email'', c.email, ''phone'', c.phone, ''role'', c.role, ''contact_id'', c.id)', 1);
