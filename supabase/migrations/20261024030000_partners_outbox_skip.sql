-- Partners (2026-10-24, ws/partners): "Don't send" for a booking email in the one Outbox and on the partner page.
--
-- Outreach emails already skip through prospect_scheduled_emails (status 'skipped'); booking emails had Send now and
-- Resend but no way to hold one back. booking_email_skip marks one booking email 'skipped' while it is still
-- scheduled, waiting or failed. Nothing is deleted: Send now still sends a skipped email later.
--
-- Safe to re-run: create or replace, grants re-applied. No existing function changes signature.

create or replace function public.booking_email_skip(p_email uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if not public.can('bookings', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select e.status into v_status from public.booking_emails e where e.id = p_email for update;
  if v_status is null then return jsonb_build_object('ok', false, 'error', 'That email is gone.'); end if;
  if v_status = 'skipped' then return jsonb_build_object('ok', true, 'status', 'skipped'); end if;
  if v_status not in ('scheduled', 'waiting', 'failed') then
    return jsonb_build_object('ok', false, 'error', case when v_status = 'sent' then 'It was already sent.' else 'It can''t be held back now (' || v_status || ').' end);
  end if;
  update public.booking_emails set status = 'skipped' where id = p_email;
  return jsonb_build_object('ok', true, 'status', 'skipped');
end $$;

revoke all on function public.booking_email_skip(uuid) from public, anon;
grant execute on function public.booking_email_skip(uuid) to authenticated;

comment on function public.booking_email_skip(uuid) is
  'Outbox / partner page "Don''t send" for one booking email (scheduled, waiting or failed -> skipped). Needs bookings edit. ws/partners 2026-10-24.';
