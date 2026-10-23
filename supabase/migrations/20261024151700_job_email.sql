-- Email the job's contacts from the job page (2026-10-23). Jeremiah: "I want to be able to send e-mails from the job
-- page to whoever our contact is."
--
-- The job page header gets an Email button. It writes to the people under "Who gets the emails" (bookings.contact_ids)
-- and goes out the same way as "Email someone" on the partner page: one prospect_scheduled_emails row per person,
-- sent by prospect-sender from Gmail with the usual signature and footer. Send now sends right away (like
-- prospect_send_now); Add to queue waits for the next send window. Sending switched off in Settings > Sending still wins.
--
-- 1. prospect_scheduled_emails.booking_id ties the email to the job (the partner page lists it as before).
-- 2. job_email_send(...) makes the emails, adds a line to the job's History, and sends now when asked.
-- 3. job_emails(booking) is the job page's list: who can be emailed and what was sent from this job.

alter table public.prospect_scheduled_emails add column if not exists booking_id uuid references public.bookings (id) on delete set null;
create index if not exists prospect_scheduled_emails_booking_idx on public.prospect_scheduled_emails (booking_id, created_at desc) where booking_id is not null;

create or replace function public.job_email_send(p_booking uuid, p_contacts uuid[], p_subject text, p_body text, p_now boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b bookings; o prospect_orgs; c prospect_contacts; v_uid uuid := (select auth.uid()); v_ids uuid[] := '{}'; v_id uuid;
        v_names text[] := '{}'; v_paused boolean; v_test boolean; i int;
begin
  if not public.can_any('{bookings,partners}', 'edit') then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking;
  if b.id is null then raise exception 'Job not found.'; end if;
  if trim(coalesce(p_subject, '')) = '' or trim(coalesce(p_body, '')) = '' then raise exception 'Add a subject and a message.'; end if;
  if coalesce(cardinality(p_contacts), 0) = 0 then raise exception 'Tick at least one person.'; end if;
  select * into o from prospect_orgs where id = b.org_id;
  if o.stage = 'do_not_contact' or o.status = 'do_not_contact' then raise exception '% is marked do not contact.', o.name; end if;
  for c in select * from prospect_contacts where id = any (p_contacts) order by is_primary desc, first_name loop
    if not (c.id = any (b.contact_ids)) then raise exception '% isn''t on this job. Add them with Edit booking first.', coalesce(c.email, 'That person'); end if;
    if c.email is null or btrim(c.email) = '' then raise exception '% has no email address.', coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), 'That person'); end if;
    if c.bounced_at is not null or c.unsubscribed_at is not null then raise exception '% bounced or unsubscribed.', c.email; end if;
    if c.stopped_at is not null then raise exception 'Emails to % are stopped on the partner page.', c.email; end if;
    insert into prospect_scheduled_emails (org_id, contact_id, booking_id, subject, body, send_at, date_manual, status, edited, created_by)
    values (c.org_id, c.id, b.id, trim(p_subject), public.prospect_tidy(p_body), now(), coalesce(p_now, false), 'scheduled', true, v_uid)
    returning id into v_id;
    v_ids := v_ids || v_id;
    v_names := v_names || coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email);
  end loop;
  if cardinality(v_ids) = 0 then raise exception 'Tick at least one person.'; end if;
  perform public.prospect_org_refresh(b.org_id);

  insert into record_history (actor, actor_name, tbl, record_id, booking_id, action, changes)
  values (v_uid, coalesce(public.staff_name(v_uid), 'Someone'), 'job_email', v_ids[1]::text, b.id, 'added',
          jsonb_build_object('to', jsonb_build_array(null, array_to_string(v_names, ', ')), 'subject', jsonb_build_array(null, trim(p_subject)),
                             'how', jsonb_build_array(null, case when p_now then 'now' else 'queue' end)));

  select paused, test_mode into v_paused, v_test from prospect_settings limit 1;
  if p_now and not coalesce(v_paused, false) then
    -- same wake-up as prospect_send_now: prospect-sender ?ids= sends exactly these, outside the send window
    for i in 0 .. (cardinality(v_ids) - 1) / 10 loop
      perform net.http_post(
        url := 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/prospect-sender?ids=' || array_to_string(v_ids[i * 10 + 1 : i * 10 + 10], ','),
        headers := jsonb_build_object('Content-Type', 'application/json',
          'x-prospect-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'prospect_trigger_secret')),
        timeout_milliseconds := 120000);
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'ids', to_jsonb(v_ids), 'emails', cardinality(v_ids), 'now', coalesce(p_now, false),
                            'paused', coalesce(v_paused, false), 'test_mode', coalesce(v_test, false));
end $$;
revoke all on function public.job_email_send(uuid, uuid[], text, text, boolean) from public, anon;
grant execute on function public.job_email_send(uuid, uuid[], text, text, boolean) to authenticated;

create or replace function public.job_emails(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b bookings;
begin
  if not public.can_any('{bookings,partners}', 'view') then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking;
  if b.id is null then raise exception 'Job not found.'; end if;
  return jsonb_build_object(
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
                    'email', c.email, 'role', c.role, 'is_primary', c.is_primary,
                    'why', case when c.email is null or btrim(c.email) = '' then 'no email address'
                                when c.bounced_at is not null then 'bounced' when c.unsubscribed_at is not null then 'unsubscribed'
                                when c.stopped_at is not null then 'emails stopped' end)
                    order by c.is_primary desc, c.first_name), '[]'::jsonb)
                   from prospect_contacts c where c.id = any (b.contact_ids)),
    'emails', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'subject', e.subject, 'body', e.body, 'status', e.status,
                  'send_at', e.send_at, 'sent_at', e.sent_at, 'opened_at', e.opened_at, 'error', e.error, 'test_mode', e.test_mode,
                  'to_name', nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), 'to_email', c.email,
                  'by', coalesce(public.staff_name(e.created_by), '')) order by e.created_at desc), '[]'::jsonb)
                 from prospect_scheduled_emails e left join prospect_contacts c on c.id = e.contact_id
                where e.booking_id = b.id));
end $$;
revoke all on function public.job_emails(uuid) from public, anon;
grant execute on function public.job_emails(uuid) to authenticated;
