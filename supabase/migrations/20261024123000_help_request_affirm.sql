-- Help request push says whether the parent ticked the parent/guardian box (2026-10-23).
--
-- The lookup form on pictureday.207photo.com saves the checkbox as search_data.affirm = 'yes'. The push only said
-- "A parent needs help...", so there was no way to tell from the notification whether they confirmed it.

create or replace function public.push_on_help_request()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ok boolean := lower(coalesce(new.search_data ->> 'affirm', '')) in ('yes', 'true', 'on', '1');
begin
  begin
    perform public.push_notify('help_request', 'New help request',
      -- the box first, so it shows on a lock screen even when the job name is long
      case when v_ok then 'Parent/guardian box ticked. ' else 'Parent/guardian box NOT ticked. ' end ||
      'Needs help finding their code' || coalesce(' for ' || (select j.name from public.synced_jobs j where j.gotphoto_job_id = new.gotphoto_job_id), '') || '.',
      '/#parents/requests', 'help_request');
  exception when others then raise warning 'push_on_help_request: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function public.push_on_help_request() from public, anon, authenticated;

-- No more alert email to info@ for every help request (Jeremiah, 2026-10-23): the push covers it, and anything
-- still pending shows in the 7am morning email ("A parent asked for help finding a code."). The trigger was made
-- outside these migrations; notify_lookup_request() stays so it can be switched back on.
drop trigger if exists lookup_request_email on public.lookup_requests;
