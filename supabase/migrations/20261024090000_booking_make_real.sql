-- Track-only jobs become real bookings (2026-10-23, moving off 17hats).
--
-- Upcoming jobs were added track-only so 17hats could keep emailing their directors. "Make it a real booking"
-- turns one into status 'booked' on the active sequence for its job type, without re-sending what 17hats already
-- sent and without a second calendar event:
--   * the chosen director contacts and the start/end time are set (suggested from the partner's contacts and the
--     Google Calendar event that day),
--   * the calendar event already on the calendar is linked (calendar_status 'synced'), so calendar-write makes none,
--   * every step picked as "already sent from 17hats" (Start here always) gets a booking_emails row with status
--     'skipped' and reason 'Not needed: already sent from 17hats'. booking_reschedule leaves such rows alone
--     (20261024080000_adaptive_booking_emails.sql), so they never fire later. Steps whose date has passed are
--     skipped by booking_reschedule as usual ("booked after this step's date").
-- p_dry_run does the whole conversion inside a subtransaction, reads back the emails it would schedule and rolls
-- it back, so the dialog can show the exact list before anything is saved.

do $$ begin
  if pg_get_functiondef('public.booking_reschedule'::regproc) not like '%Not needed:%' then
    raise exception 'Apply 20261024080000_adaptive_booking_emails.sql first: booking_reschedule must leave "Not needed:" rows alone.';
  end if;
end $$;

-- What the dialog needs to fill itself in: the partner's contacts, the calendar events that day, the steps.
create function public.booking_make_real_suggest(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare b bookings; v_org text; v_seq uuid; v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can_any('{bookings}', 'view') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into b from bookings where id = p_id;
  if b.id is null or b.status <> 'tracked' then raise exception 'This job is not track-only.'; end if;
  select name into v_org from prospect_orgs where id = b.org_id;
  select id into v_seq from booking_sequences where type_key = b.type_key and is_active limit 1;
  return jsonb_build_object(
    'id', b.id, 'org', v_org, 'picture_day', b.picture_day, 'past', b.picture_day < v_today, 'has_sequence', v_seq is not null,
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
                    'email', c.email, 'primary', coalesce(c.is_primary, false),
                    'usable', c.email is not null and c.bounced_at is null and c.unsubscribed_at is null and c.stopped_at is null)
                    order by coalesce(c.is_primary, false) desc, c.created_at)
                  from prospect_contacts c where c.org_id = b.org_id), '[]'),
    -- events that day, the one naming this organization first
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', split_part(e.google_event_id, '@', 1), 'title', e.summary,
                    'start_time', to_char(e.start_at at time zone 'America/New_York', 'HH24:MI'),
                    'end_time', to_char(e.end_at at time zone 'America/New_York', 'HH24:MI'),
                    'matches', public.hub_norm_name(e.summary) like '%' || public.hub_norm_name(v_org) || '%'
                               or public.hub_norm_name(split_part(e.summary, '•', 1)) like '%' || public.hub_norm_name(split_part(v_org, ' ', 1)) || '%')
                    order by (public.hub_norm_name(e.summary) like '%' || public.hub_norm_name(v_org) || '%') desc, e.start_at)
                  from calendar_events e
                 where not coalesce(e.all_day, false) and (e.start_at at time zone 'America/New_York')::date = b.picture_day
                   and split_part(e.google_event_id, '@', 1) not in (select x.google_event_id from bookings x where x.google_event_id is not null and x.status in ('booked', 'done'))), '[]'),
    -- the director emails a 17hats series could have sent (admin steps on the picture-day clock)
    'steps', coalesce((select jsonb_agg(jsonb_build_object('step_no', st.step_no, 'subject', st.subject, 'offset_days', st.offset_days,
                    'send_day', b.picture_day - st.offset_days, 'passed', b.picture_day - st.offset_days <= v_today)
                    order by st.offset_days desc, st.step_no)
                  from booking_steps st
                 where st.sequence_id = v_seq and st.is_active and st.kind = 'admin' and st.trigger = 'picture_day'), '[]'));
end $$;

-- p: {contact_ids: [uuid], start_time: 'HH:MI', end_time: 'HH:MI'?, google_event_id?, sent_steps: [step_no]}
create function public.booking_make_real(p_id uuid, p jsonb, p_dry_run boolean default false) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare b bookings; v_seq uuid; v_ids uuid[]; v_n int; v_event text; v_sent int[]; v_plan jsonb;
        v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into b from bookings where id = p_id for update;
  if b.id is null or b.status <> 'tracked' then raise exception 'This job is not track-only.'; end if;
  if b.picture_day < v_today then raise exception 'Picture day has passed. Past jobs stay track-only.'; end if;
  select id into v_seq from booking_sequences where type_key = b.type_key and is_active limit 1;
  if v_seq is null then raise exception 'No active email sequence for this job type.'; end if;
  select coalesce(array_agg(x::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(p->'contact_ids', '[]')) x;
  select count(*) into v_n from prospect_contacts c where c.id = any(v_ids) and c.org_id = b.org_id and c.email is not null
    and c.bounced_at is null and c.unsubscribed_at is null and c.stopped_at is null;
  if v_n = 0 then raise exception 'Pick a director with a usable email address.'; end if;
  if nullif(p->>'start_time', '') is null then raise exception 'Pick the start time.'; end if;
  v_event := nullif(split_part(coalesce(p->>'google_event_id', ''), '@', 1), '');
  if v_event is not null and exists (select 1 from bookings x where x.google_event_id = v_event and x.id <> p_id and x.status in ('booked', 'done')) then
    raise exception 'That calendar event already belongs to another booking.';
  end if;
  -- Start here always counts as sent: every track-only job got it from 17hats.
  select array_agg(distinct x) into v_sent from (
    select (jsonb_array_elements_text(coalesce(p->'sent_steps', '[]')))::int x
    union select st.step_no from booking_steps st where st.sequence_id = v_seq and st.trigger = 'picture_day' and st.offset_days = 0 and st.kind = 'admin') s;

  begin
    update bookings set status = 'booked', sequence_id = v_seq, contact_ids = v_ids,
           google_event_id = v_event, calendar_status = case when v_event is null then 'pending' else 'synced' end,
           calendar_error = null, calendar_attempts = 0, calendar_checked_at = case when v_event is null then null else now() end,
           updated_at = now()
     where id = p_id;
    perform public.booking_set_days(p_id, jsonb_build_array(jsonb_build_object('day', b.picture_day,
              'start_time', p->>'start_time', 'end_time', nullif(p->>'end_time', ''))));
    insert into booking_emails (booking_id, step_id, step_no, day_index, status, reason)
    select p_id, st.id, st.step_no, 0, 'skipped', 'Not needed: already sent from 17hats'
      from booking_steps st where st.sequence_id = v_seq and st.step_no = any(v_sent)
       and not exists (select 1 from booking_emails e where e.booking_id = p_id and e.step_no = st.step_no and not e.is_resend and e.day_index = 0);
    perform public.booking_hub_setup(p_id);
    perform public.booking_reschedule(p_id);

    select coalesce(jsonb_agg(jsonb_build_object('step_no', e.step_no, 'kind', coalesce(st.kind, 'admin'), 'subject', st.subject,
             'status', e.status, 'send_at', e.send_at, 'reason', e.reason, 'to', e.to_emails, 'cc', e.cc_emails)
             order by e.send_at nulls last, e.step_no), '[]') into v_plan
      from booking_emails e left join booking_steps st on st.id = e.step_id
     where e.booking_id = p_id and not e.is_resend;
    if p_dry_run then raise exception using errcode = 'P0099', message = 'dry run'; end if;
  exception when sqlstate 'P0099' then
    return jsonb_build_object('ok', true, 'dry_run', true, 'emails', v_plan);
  end;

  if v_event is null then perform public.booking_poke('calendar-write', jsonb_build_object('booking_id', p_id)); end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'emails', v_plan);
end $$;

revoke all on function public.booking_make_real_suggest(uuid) from public, anon;
revoke all on function public.booking_make_real(uuid, jsonb, boolean) from public, anon;
grant execute on function public.booking_make_real_suggest(uuid) to authenticated;
grant execute on function public.booking_make_real(uuid, jsonb, boolean) to authenticated;

-- The daily no-roster alert pointed at 17hats for the director's details; they live in Admin now.
do $$
declare d text := pg_get_functiondef('public.roster_alert_sweep'::regproc);
begin
  if d like '%Contact details are in 17hats.%' then
    execute replace(d, 'Contact details are in 17hats.', 'The director''''s details are on the partner page in 207 Admin.');
  end if;
end $$;
