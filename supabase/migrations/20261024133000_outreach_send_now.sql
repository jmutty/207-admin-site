-- Send now or Add to queue (2026-10-23). Jeremiah: "Sometimes we can just send an email, not wait for ideal hours."
-- Every outreach-type email (sequence step, quick email, rebook / review / agreement email, one-off) can now go out
-- right away instead of in the next send window. Add to queue is the old approve (prospect_approve /
-- prospect_approve_quick / partner_queue with p_approve), unchanged.
--
-- prospect_send_now approves what is still held, sets send_at to now (date_manual, so the sender's end-of-day
-- shuffle leaves it alone), then wakes prospect-sender with ?ids=..., which sends exactly those rows outside the
-- send window. Sending switched off (prospect_settings.paused) still wins: the rows wait, and the answer says so.

create or replace function public.prospect_send_now(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x record; v_ids uuid[] := '{}'; v_enr uuid; v_paused boolean; v_test boolean; i int;
begin
  if not public.can_any('{partners,agreements}', 'edit') then raise exception 'Not authorized' using errcode = '42501'; end if;
  -- held sequence emails: approve their whole sequence first (every contact's email 1 goes now)
  for v_enr in select distinct e.enrollment_id from prospect_scheduled_emails e
                where e.id = any (p_ids) and e.status = 'held' and e.enrollment_id is not null loop
    perform public.prospect_approve(v_enr);
    v_ids := v_ids || array(select distinct on (thread_id) id from prospect_scheduled_emails
                             where enrollment_id = v_enr and status = 'scheduled' order by thread_id, step_no);
  end loop;
  -- held one-offs: same checks as Add to queue (do not contact, bounced, unsubscribed are skipped)
  perform public.prospect_approve_quick(array(select id from prospect_scheduled_emails where id = any (p_ids) and status = 'held' and enrollment_id is null));
  for x in select e.* from prospect_scheduled_emails e
            where (e.id = any (p_ids) or e.id = any (v_ids)) and e.status in ('scheduled', 'failed') loop
    update prospect_scheduled_emails set status = 'scheduled', needs_review = false, send_at = now(), date_manual = true, error = null where id = x.id;
    if x.thread_id is not null then
      perform public.prospect_replan_thread(x.thread_id, x.step_no, now());
      perform public.prospect_thread_sync(x.thread_id);
    end if;
    if x.enrollment_id is not null then
      update prospect_enrollments set next_send_at = now() where id = x.enrollment_id and status = 'active';
    end if;
    v_ids := v_ids || x.id;
  end loop;
  select array_agg(distinct u) into v_ids from unnest(v_ids) u
   where exists (select 1 from prospect_scheduled_emails e where e.id = u and e.status = 'scheduled');
  if v_ids is null then return jsonb_build_object('ok', false, 'error', 'Nothing to send: it already went out or was stopped.'); end if;
  select paused, test_mode into v_paused, v_test from prospect_settings limit 1;
  if not coalesce(v_paused, false) then
    -- ten per wake-up keeps each run well inside the function's time limit
    for i in 0 .. (cardinality(v_ids) - 1) / 10 loop
      perform net.http_post(
        url := 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/prospect-sender?ids=' || array_to_string(v_ids[i * 10 + 1 : i * 10 + 10], ','),
        headers := jsonb_build_object('Content-Type', 'application/json',
          'x-prospect-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'prospect_trigger_secret')),
        timeout_milliseconds := 120000);
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'sending', cardinality(v_ids), 'paused', coalesce(v_paused, false), 'test_mode', coalesce(v_test, false));
end $$;

revoke all on function public.prospect_send_now(uuid[]) from public, anon;
grant execute on function public.prospect_send_now(uuid[]) to authenticated;
