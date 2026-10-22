-- Email delivery (2026-10-23). Module 'emails', page System > Email delivery (#system/delivery, #system/emailreport).
--
-- Every email the database sends through Resend (picture day emails, makeup notices, hub and parent gallery
-- emails, "Your day", the morning and follow-up digests, help-request replies, alerts, welcome emails and sign-in
-- codes) goes out with net.http_post(...'https://api.resend.com/emails'...). A trigger on pg_net's request queue
-- records each one in email_sends as it is queued, so no sender had to change and new senders are covered too:
--
--   queued     the request is in pg_net's queue
--   sent       Resend accepted it (we have its id)
--   delivered  the receiving server took it; opened_at / clicked_at when Resend saw an open / a click
--   delayed    the receiving server is deferring it (Resend keeps trying)
--   bounced    it bounced (the address is marked bounced on the organization contact, so outreach stops)
--   complained the person marked it as spam
--   failed     Resend refused it (bad address, suppressed, ...) or the request failed
--   unknown    pg_net lost the answer (it keeps answers about 6 hours)
--
-- How we hear back: email_delivery_sweep() every minute reads pg_net's answer to each send, then asks Resend
-- (GET /emails/<id>) about each sent email 10 minutes, 1 hour, 6 hours, 1 day and 3 days after sending, at most
-- 3 look-ups a minute (well inside Resend's rate limit). No webhook or extra secret is needed; it uses the
-- resend_api_key already in the vault. Open and click tracking only show if they are switched on for the domain
-- in Resend.
--
-- Not covered: booking emails and outreach go out through Gmail (their own edge functions), not Resend. Their
-- failures already show on Outbox, and outreach opens are tracked there.
--
-- Resend (Edit): posts the same email again, optionally to a corrected address. Emails with a sign-in code or a
-- temporary password are recorded without their content and can't be resent. Content is kept 60 days, the
-- record 13 months (for the monthly report).
--
-- Access is the `emails` module: View = the list, each email and the report; Edit = resend and mark handled.

insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('emails', 'Email delivery', 'System',
        'Every email sent through Resend with whether it was delivered, bounced, opened or clicked; resend failed ones; a monthly report. View = see them; Edit = resend and mark handled.',
        92, 'live', false)
on conflict (key) do update set status = 'live', label = excluded.label, section = excluded.section, description = excluded.description;

insert into public.push_topics (key, label, description, module, sort)
values ('email_problem', 'Email bounced or failed', 'An email we sent through Resend bounced, was marked as spam, or could not be sent.', 'emails', 93)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- table
create table public.email_sends (
  id            bigint generated always as identity primary key,
  request_id    bigint unique,                 -- pg_net request id of the send
  resend_id     text unique,                   -- Resend's email id, once accepted
  source        text not null default 'other' check (source in ('pictureday', 'makeup', 'hub', 'help', 'day_email', 'digest', 'alert', 'welcome', 'signin', 'other')),
  from_email    text not null default '',
  to_emails     text[] not null default '{}',
  subject       text not null default '',
  payload       jsonb,                         -- what was posted to Resend (minus nothing secret: no key); null for codes/passwords and after 60 days
  test_mode     boolean not null default false,
  sent_at       timestamptz not null default now(),
  status        text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'delayed', 'bounced', 'complained', 'failed', 'unknown')),
  error         text check (length(error) <= 500),
  opened_at     timestamptz,
  clicked_at    timestamptz,
  last_event    text,                          -- Resend's last_event as last seen
  last_event_at timestamptz,
  checks        int not null default 0,
  next_check_at timestamptz,
  poll_request_id bigint,                      -- pg_net request id of the look-up in flight
  resent_from   bigint references public.email_sends (id) on delete set null,
  resent_by     uuid,
  handled_at    timestamptz,                   -- a problem someone dealt with (or that was resent)
  handled_by    uuid
);
comment on table public.email_sends is 'Every email sent through Resend (recorded by a trigger on net.http_request_queue) and how it went. Kept 13 months; payload 60 days.';
create index email_sends_sent_idx on public.email_sends (sent_at desc);
create index email_sends_check_idx on public.email_sends (next_check_at) where next_check_at is not null;
create index email_sends_open_idx on public.email_sends (id) where status = 'queued' or poll_request_id is not null;
create index email_sends_problem_idx on public.email_sends (sent_at) where status in ('bounced', 'complained', 'failed') and handled_at is null;
create index email_sends_to_idx on public.email_sends using gin (to_emails);

alter table public.email_sends enable row level security;
revoke all on public.email_sends from anon, authenticated;

-- ---------------------------------------------------------------- recording sends
-- Which pipeline sent it: from the statement that queued it (the RPC or cron command), else from the subject.
create function public.email_source(p_query text, p_subject text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_query ~* 'admin_send_code' or p_subject ~* 'is your 207 Admin sign-in code' then 'signin'
    when p_query ~* 'team_send_welcome' or p_subject in ('Welcome to 207 Admin', 'Your new 207 Admin password') then 'welcome'
    when p_query ~* '\mpd_' then 'pictureday'
    when p_query ~* 'makeup_' then 'makeup'
    when p_query ~* 'lookup_request' then 'help'
    when p_query ~* 'hub_send_reminders|hub_watch_notify|parent_watch_notify' then 'hub'
    when p_query ~* 'day_email_send' then 'day_email'
    when p_query ~* 'admin_morning_digest|prospect_followup_digest' then 'digest'
    when p_query ~* 'roster_alert_sweep|shared_ip_alert' or p_subject ~* '^Shared connection:' then 'alert'
    else 'other' end
$$;

create function public.email_capture() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_body jsonb; v_to text[]; v_subject text; v_src text;
begin
  if new.method is distinct from 'POST' or new.url is distinct from 'https://api.resend.com/emails' then return new; end if;
  begin
    v_body := convert_from(new.body, 'UTF8')::jsonb;
    v_to := case jsonb_typeof(v_body -> 'to') when 'array' then array(select lower(btrim(x)) from jsonb_array_elements_text(v_body -> 'to') x)
                                              when 'string' then array[lower(btrim(v_body ->> 'to'))] else '{}' end;
    v_subject := left(coalesce(v_body ->> 'subject', ''), 300);
    v_src := public.email_source(left(coalesce(current_query(), ''), 2000), v_subject);
    insert into public.email_sends (request_id, source, from_email, to_emails, subject, payload, test_mode)
    values (new.id, v_src, left(coalesce(v_body ->> 'from', ''), 300), v_to,
            case when v_src = 'signin' then 'Sign-in code' else v_subject end,
            case when v_src in ('signin', 'welcome') then null else v_body - 'headers' end,
            v_subject like '[TEST]%')
    on conflict (request_id) do nothing;
  exception when others then
    raise warning 'email_capture failed: %', sqlerrm;   -- never stop an email over this
  end;
  return new;
end $$;
revoke all on function public.email_source(text, text), public.email_capture() from public, anon, authenticated;

create trigger email_capture after insert on net.http_request_queue for each row execute function public.email_capture();

-- ---------------------------------------------------------------- hearing back
create function public.email_next_check(p_checks int) returns interval
language sql immutable set search_path = '' as $$
  select case p_checks when 0 then interval '10 minutes' when 1 then interval '1 hour' when 2 then interval '6 hours'
                       when 3 then interval '1 day' when 4 then interval '3 days' end
$$;

-- A problem: tell the people who look after email (merged per kind within 10 minutes) and stop outreach to a bounced address.
create function public.email_problem(e public.email_sends) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if e.status = 'bounced' and not e.test_mode then
    update public.prospect_contacts set bounced_at = now(), updated_at = now()
     where bounced_at is null and lower(btrim(email)) = any (e.to_emails);
  end if;
  perform public.push_notify('email_problem',
    case e.status when 'bounced' then 'Email bounced' when 'complained' then 'Email marked as spam' else 'Email not sent' end,
    array_to_string(e.to_emails, ', ') || ': ' || e.subject, '/#system/delivery', 'email_' || e.status);
exception when others then
  raise warning 'email_problem failed: %', sqlerrm;
end $$;

create function public.email_json(p text) returns jsonb
language plpgsql immutable set search_path = '' as $$
begin
  return case when p ~ '^\s*\{' then p::jsonb end;
exception when others then
  return null;
end $$;

-- Every minute: read pg_net's answers to sends and look-ups, then start up to 3 look-ups that are due.
create function public.email_delivery_sweep() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record; v_key text; v_req bigint; v_ev text; v_status text; e public.email_sends;
  v_sent int := 0; v_polled int := 0; v_asked int := 0;
begin
  -- 1. Answers to sends.
  for r in select s.id, h.status_code, h.content, h.timed_out, h.error_msg
             from public.email_sends s join net._http_response h on h.id = s.request_id
            where s.status = 'queued' loop
    if r.status_code between 200 and 299 then
      update public.email_sends set status = 'sent', resend_id = left(public.email_json(r.content) ->> 'id', 100), next_check_at = now() + public.email_next_check(0)
       where id = r.id;
    else
      update public.email_sends set status = 'failed', next_check_at = null,
             error = left(coalesce(public.email_json(r.content) ->> 'message', nullif(r.error_msg, ''),
                                   case when r.timed_out then 'Resend did not answer in time.' end, 'HTTP ' || r.status_code), 500)
       where id = r.id returning * into e;
      perform public.email_problem(e);
    end if;
    v_sent := v_sent + 1;
  end loop;
  update public.email_sends set status = 'unknown', error = 'No answer from Resend was kept.'
   where status = 'queued' and sent_at < now() - interval '6 hours';

  -- 2. Answers to look-ups.
  for r in select s.id, s.status, s.checks, h.status_code, h.content
             from public.email_sends s join net._http_response h on h.id = s.poll_request_id
            where s.poll_request_id is not null loop
    v_ev := case when r.status_code between 200 and 299 then public.email_json(r.content) ->> 'last_event' end;
    v_status := case v_ev when 'delivered' then 'delivered' when 'opened' then 'delivered' when 'clicked' then 'delivered'
                          when 'bounced' then 'bounced' when 'complained' then 'complained' when 'delivery_delayed' then 'delayed'
                          when 'failed' then 'failed' when 'suppressed' then 'failed' when 'canceled' then 'failed'
                          else r.status end;
    update public.email_sends
       set poll_request_id = null, checks = checks + case when r.status_code = 429 then 0 else 1 end,
           last_event = coalesce(v_ev, last_event), last_event_at = case when v_ev is distinct from last_event then now() else last_event_at end,
           status = v_status,
           error = case when v_status = 'failed' and r.status <> 'failed' then 'Resend: ' || v_ev else error end,
           opened_at = case when v_ev in ('opened', 'clicked') then coalesce(opened_at, now()) else opened_at end,
           clicked_at = case when v_ev = 'clicked' then coalesce(clicked_at, now()) else clicked_at end,
           next_check_at = case when r.status_code = 429 then now() + interval '2 minutes'            -- rate limited: try again soon
                                when v_status in ('bounced', 'complained', 'failed') or v_ev = 'clicked' then null
                                else now() + public.email_next_check(checks + 1) end
     where id = r.id returning * into e;
    if e.status in ('bounced', 'complained', 'failed') and r.status not in ('bounced', 'complained', 'failed') then perform public.email_problem(e); end if;
    v_polled := v_polled + 1;
  end loop;
  -- A look-up whose answer never came (pg_net drops answers after a few hours): free it to be asked again.
  update public.email_sends s set poll_request_id = null
   where s.poll_request_id is not null and s.next_check_at <= now()
     and not exists (select 1 from net._http_response h where h.id = s.poll_request_id);

  -- 3. Look-ups that are due.
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_key is not null then
    for r in select s.id, s.resend_id from public.email_sends s
              where s.next_check_at <= now() and s.poll_request_id is null and s.resend_id is not null
              order by s.next_check_at limit 3 for update skip locked loop
      select net.http_get(url := 'https://api.resend.com/emails/' || r.resend_id,
                          headers := jsonb_build_object('Authorization', 'Bearer ' || v_key),
                          timeout_milliseconds := 10000) into v_req;
      update public.email_sends set poll_request_id = v_req, next_check_at = now() + interval '30 minutes' where id = r.id;  -- if the answer never comes
      v_asked := v_asked + 1;
    end loop;
  end if;
  return jsonb_build_object('sent', v_sent, 'polled', v_polled, 'asked', v_asked);
end $$;
revoke all on function public.email_json(text), public.email_next_check(int), public.email_problem(public.email_sends), public.email_delivery_sweep() from public, anon, authenticated;

select cron.schedule('email-delivery-sweep', '* * * * *', 'select public.email_delivery_sweep()');
select cron.schedule('email-sends-retention', '51 4 * * *',
  $$update public.email_sends set payload = null where payload is not null and sent_at < now() - interval '60 days';
    delete from public.email_sends where sent_at < now() - interval '13 months'$$);

-- ---------------------------------------------------------------- RPCs
create function public.email_row_json(e public.email_sends) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'source', e.source, 'to', e.to_emails, 'from', e.from_email, 'subject', e.subject,
    'sent_at', e.sent_at, 'status', e.status, 'error', e.error, 'opened_at', e.opened_at, 'clicked_at', e.clicked_at,
    'last_event', e.last_event, 'test_mode', e.test_mode, 'resent_from', e.resent_from,
    'resent', exists (select 1 from public.email_sends x where x.resent_from = e.id),
    'can_resend', e.payload is not null, 'handled_at', e.handled_at)
$$;
revoke all on function public.email_row_json(public.email_sends) from public, anon, authenticated;

-- The list, newest first, 100 at a time (p_before = the last id shown). p_filter: all / problems / opened / waiting.
create function public.email_list(p_filter text default 'all', p_source text default null, p_q text default null, p_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_q text := nullif(lower(btrim(coalesce(p_q, ''))), '');
begin
  if not public.can('emails', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'can_edit', public.can('emails', 'edit'),
    'capturing', exists (select 1 from pg_trigger t where t.tgname = 'email_capture' and t.tgrelid = 'net.http_request_queue'::regclass),
    'problems', (select count(*) from public.email_sends s where s.status in ('bounced', 'complained', 'failed') and s.handled_at is null and s.sent_at > now() - interval '14 days'),
    'rows', (select coalesce(jsonb_agg(public.email_row_json(s) order by s.id desc), '[]'::jsonb) from (
               select * from public.email_sends s
                where (p_before is null or s.id < p_before)
                  and (p_source is null or p_source = '' or s.source = p_source)
                  and (v_q is null or s.subject ilike '%' || v_q || '%' or exists (select 1 from unnest(s.to_emails) t where t like '%' || v_q || '%'))
                  and case coalesce(p_filter, 'all')
                        when 'problems' then s.status in ('bounced', 'complained', 'failed', 'unknown', 'delayed')
                        when 'opened' then s.opened_at is not null
                        when 'waiting' then s.status in ('queued', 'sent')
                        else true end
                order by s.id desc limit 100) s));
end $$;

-- One email with what was sent (when kept), and its resends.
create function public.email_detail(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e public.email_sends;
begin
  if not public.can('emails', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into e from public.email_sends where id = p_id;
  if e.id is null then raise exception 'That email is no longer kept.'; end if;
  return public.email_row_json(e) || jsonb_build_object(
    'reply_to', e.payload -> 'reply_to', 'cc', e.payload -> 'cc', 'bcc', e.payload -> 'bcc',
    'text', e.payload ->> 'text', 'html', e.payload ->> 'html', 'resend_id', e.resend_id,
    'handled_by', case when e.handled_by is not null then public.staff_name(e.handled_by) end,
    'resent_by', case when e.resent_by is not null then public.staff_name(e.resent_by) end,
    'resends', (select coalesce(jsonb_agg(public.email_row_json(x) order by x.id), '[]'::jsonb) from public.email_sends x where x.resent_from = e.id),
    'bounced_contact', exists (select 1 from public.prospect_contacts c where c.bounced_at is not null and lower(btrim(c.email)) = any (e.to_emails)));
end $$;

-- Send it again, the same email, to the same address or to p_to (one corrected address). Edit.
create function public.email_resend(p_id bigint, p_to text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.email_sends; v_key text; v_body jsonb; v_to text := nullif(lower(btrim(coalesce(p_to, ''))), ''); v_req bigint; v_new bigint;
begin
  if not public.can('emails', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into e from public.email_sends where id = p_id for update;
  if e.id is null then raise exception 'That email is no longer kept.'; end if;
  if e.payload is null then raise exception 'This one can''t be resent (it held a sign-in code or password, or is over 60 days old).'; end if;
  if v_to is not null and v_to !~ '^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$' then raise exception 'That email address doesn''t look right.'; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_key is null then raise exception 'Email is not set up (resend_api_key).'; end if;
  v_body := e.payload;
  if v_to is not null then v_body := jsonb_set(v_body, '{to}', jsonb_build_array(v_to)); end if;
  select net.http_post(url := 'https://api.resend.com/emails',
                       headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
                       body := v_body, timeout_milliseconds := 10000) into v_req;
  update public.email_sends set source = e.source, resent_from = e.id, resent_by = (select auth.uid())
   where request_id = v_req returning id into v_new;
  update public.email_sends set handled_at = coalesce(handled_at, now()), handled_by = coalesce(handled_by, (select auth.uid())) where id = e.id;
  return jsonb_build_object('ok', true, 'id', v_new);
end $$;

-- Mark problems as dealt with (or not). Edit.
create function public.email_mark_handled(p_ids bigint[], p_handled boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not public.can('emails', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.email_sends
     set handled_at = case when coalesce(p_handled, true) then now() end,
         handled_by = case when coalesce(p_handled, true) then (select auth.uid()) end
   where id = any (coalesce(p_ids, '{}'));
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'n', v_n);
end $$;

-- Month by month (p_months back, this month included): sent, delivered, bounced, spam, failed, opened, clicked;
-- by source for the months shown; and the addresses that bounced lately.
create function public.email_report(p_months int default 12)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_from date := (date_trunc('month', now() at time zone 'America/New_York') - make_interval(months => greatest(1, least(coalesce(p_months, 12), 13)) - 1))::date;
begin
  if not public.can('emails', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'from', v_from,
    'first_sent_at', (select min(sent_at) from public.email_sends),
    'months', (select coalesce(jsonb_agg(m order by m ->> 'month'), '[]'::jsonb) from (
                 select jsonb_build_object('month', to_char(date_trunc('month', s.sent_at at time zone 'America/New_York'), 'YYYY-MM'),
                          'sent', count(*), 'delivered', count(*) filter (where s.status in ('delivered', 'complained')),
                          'bounced', count(*) filter (where s.status = 'bounced'), 'complained', count(*) filter (where s.status = 'complained'),
                          'failed', count(*) filter (where s.status in ('failed', 'unknown')), 'delayed', count(*) filter (where s.status = 'delayed'),
                          'opened', count(*) filter (where s.opened_at is not null), 'clicked', count(*) filter (where s.clicked_at is not null),
                          'test', count(*) filter (where s.test_mode)) as m
                   from public.email_sends s where s.sent_at >= v_from::timestamp at time zone 'America/New_York'
                  group by date_trunc('month', s.sent_at at time zone 'America/New_York')) x),
    'sources', (select coalesce(jsonb_agg(x order by x ->> 'source'), '[]'::jsonb) from (
                  select jsonb_build_object('source', s.source, 'sent', count(*),
                           'delivered', count(*) filter (where s.status in ('delivered', 'complained')),
                           'bounced', count(*) filter (where s.status = 'bounced'), 'failed', count(*) filter (where s.status in ('failed', 'unknown')),
                           'opened', count(*) filter (where s.opened_at is not null)) as x
                    from public.email_sends s where s.sent_at >= v_from::timestamp at time zone 'America/New_York' group by s.source) y),
    'bounced', (select coalesce(jsonb_agg(b order by b ->> 'last' desc), '[]'::jsonb) from (
                  select jsonb_build_object('email', t.addr, 'n', count(*), 'last', max(s.sent_at)) as b
                    from public.email_sends s cross join unnest(s.to_emails) t(addr)
                   where s.status in ('bounced', 'complained') and s.sent_at > now() - interval '90 days'
                   group by t.addr order by max(s.sent_at) desc limit 50) z));
end $$;

-- Today: problems in the last 14 days nobody has dealt with.
create function public.email_attention()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('emails', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('problems', (select count(*) from public.email_sends s
                                          where s.status in ('bounced', 'complained', 'failed') and s.handled_at is null and s.sent_at > now() - interval '14 days'));
end $$;

revoke all on function public.email_list(text, text, text, bigint), public.email_detail(bigint), public.email_resend(bigint, text),
  public.email_mark_handled(bigint[], boolean), public.email_report(int), public.email_attention() from public, anon;
grant execute on function public.email_list(text, text, text, bigint), public.email_detail(bigint), public.email_resend(bigint, text),
  public.email_mark_handled(bigint[], boolean), public.email_report(int), public.email_attention() to authenticated;
