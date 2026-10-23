-- ws/settings (2026-10-24), finding B7: approving time off for someone who is on a job then should link to that
-- job on the Schedule. time_off_json's "jobs" now also carry booking_id (same signature, one key added).
create or replace function public.time_off_json(t public.time_off_requests) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'user_id', t.user_id, 'name', public.staff_name(t.user_id), 'first_day', t.first_day, 'last_day', t.last_day,
    'start_time', to_char(t.start_time, 'HH24:MI'), 'end_time', to_char(t.end_time, 'HH24:MI'), 'note', t.note, 'status', t.status,
    'decided_by', public.staff_name(t.decided_by), 'decided_at', t.decided_at, 'decision_note', t.decision_note, 'created_at', t.created_at,
    -- jobs they are already on in that time (a manager needs to know before approving)
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('booking_id', e.booking_id, 'title', public.schedule_booking_title(e.booking_id), 'starts_at', e.starts_at) order by e.starts_at), '[]'::jsonb)
               from public.schedule_entries e
              where e.user_id = t.user_id and e.kind = 'job'
                and e.starts_at < (case when t.start_time is null then (t.last_day + 1)::timestamp else t.first_day + t.end_time end) at time zone 'America/New_York'
                and e.ends_at > (case when t.start_time is null then t.first_day::timestamp else t.first_day + t.start_time end) at time zone 'America/New_York'))
$$;
