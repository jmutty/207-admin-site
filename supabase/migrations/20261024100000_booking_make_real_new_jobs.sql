-- Make it a real booking, round two (2026-10-23): jobs that were only ever on the calendar.
--
-- Hand-made calendar jobs never went through 17hats, so their Start here must still go out:
--   * start_here_sent: false leaves Start here to send as usual (default true, as before),
--   * days: several picture days in one booking (e.g. a three-day hockey picture day),
--   * start_time is optional: an all-day calendar event has none, and emails that mention the time wait for it,
--   * days[].google_event_id links each later day to the calendar event it already has (no second event),
--   * no_calendar: true makes no event at all, for a second booking sharing another one's event (Mount View MS + HS).

-- p: {contact_ids: [uuid], start_time: 'HH:MI'?, end_time: 'HH:MI'?, google_event_id?, sent_steps: [step_no],
--     start_here_sent: boolean (default true), no_calendar: boolean,
--     days: [{day, start_time?, end_time?, label?, google_event_id?}]?}
create or replace function public.booking_make_real(p_id uuid, p jsonb, p_dry_run boolean default false) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_nocal boolean; b bookings; v_seq uuid; v_ids uuid[]; v_n int; v_event text; v_sent int[]; v_plan jsonb;
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
  v_event := nullif(split_part(coalesce(p->>'google_event_id', ''), '@', 1), '');
  v_nocal := coalesce((p->>'no_calendar')::boolean, false) and v_event is null;
  if v_event is not null and exists (select 1 from bookings x where x.google_event_id = v_event and x.id <> p_id and x.status in ('booked', 'done')) then
    raise exception 'That calendar event already belongs to another booking.';
  end if;
  -- Start here counts as sent unless start_here_sent is false (a job 17hats never had, e.g. one made by hand on the calendar).
  select array_agg(distinct x) into v_sent from (
    select (jsonb_array_elements_text(coalesce(p->'sent_steps', '[]')))::int x
    union select st.step_no from booking_steps st where st.sequence_id = v_seq and st.trigger = 'picture_day' and st.offset_days = 0 and st.kind = 'admin'
                                                    and coalesce((p->>'start_here_sent')::boolean, true)) s;

  begin
    update bookings set status = 'booked', sequence_id = v_seq, contact_ids = v_ids,
           google_event_id = v_event, calendar_status = case when v_event is not null then 'synced' when v_nocal then 'deleted' else 'pending' end,
           calendar_error = null, calendar_attempts = 0, calendar_checked_at = case when v_event is null then null else now() end,
           updated_at = now()
     where id = p_id;
    -- no start time: time_set stays false and an email that mentions the time waits for it
    perform public.booking_set_days(p_id, case when jsonb_typeof(p->'days') = 'array' and jsonb_array_length(p->'days') > 0 then p->'days'
              else jsonb_build_array(jsonb_build_object('day', b.picture_day, 'start_time', nullif(p->>'start_time', ''), 'end_time', nullif(p->>'end_time', ''))) end);
    -- later days: link the event each already has; with no_calendar, none is made for any day
    update booking_days d set google_event_id = nullif(split_part(x->>'google_event_id', '@', 1), ''), calendar_status = 'synced'
      from jsonb_array_elements(case when jsonb_typeof(p->'days') = 'array' then p->'days' else '[]' end) x
     where d.booking_id = p_id and d.day = (x->>'day')::date and nullif(x->>'google_event_id', '') is not null;
    if v_nocal then update booking_days set calendar_status = 'deleted' where booking_id = p_id; end if;
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

  if v_event is null and not v_nocal then perform public.booking_poke('calendar-write', jsonb_build_object('booking_id', p_id)); end if;
  return jsonb_build_object('ok', true, 'id', p_id, 'emails', v_plan);
end $$;

