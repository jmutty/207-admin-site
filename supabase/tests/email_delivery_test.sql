-- Tests for 20261023141600_email_delivery (record Resend sends, hear back, resend, report). Run on a NON-production
-- schema copy after the migration; everything is rolled back. pg_net is a stand-in there: answers are inserted by hand.
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/email_delivery_test.sql
begin;

create function pg_temp.act(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', case when p_uid is null then '{"role":"anon"}'
    else json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal2')::text end, true);
  execute case when p_uid is null then 'set local role anon' else 'set local role authenticated' end;
end $$;
create function pg_temp.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok  %', p_what;
end $$;
create function pg_temp.raises(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok  % (refused: %)', p_what, sqlerrm; return; end;
  raise exception 'FAILED: % (was allowed)', p_what;
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- e edits email delivery, v views it, n has neither
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000003e1', 'e3@example.com'), ('00000000-0000-0000-0000-0000000003c1', 'v3@example.com'),
  ('00000000-0000-0000-0000-0000000003d1', 'n3@example.com');
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000003e1', 'Edit Three', true),
  ('00000000-0000-0000-0000-0000000003c1', 'View Three', true), ('00000000-0000-0000-0000-0000000003d1', 'No Three', true)
  on conflict (user_id) do update set display_name = excluded.display_name;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000003e1', 'emails', 'edit'),
  ('00000000-0000-0000-0000-0000000003c1', 'emails', 'view'), ('00000000-0000-0000-0000-0000000003d1', 'bookings', 'view');
insert into vault.secrets (name, secret) select 'resend_api_key', 'test-key' where not exists (select 1 from vault.decrypted_secrets where name = 'resend_api_key');
insert into public.prospect_orgs (id, name, town) values ('00000000-0000-0000-0000-0000000003f1', 'Bounce Academy', 'Hampden');
insert into public.prospect_contacts (org_id, first_name, email) values ('00000000-0000-0000-0000-0000000003f1', 'Bo', 'Bounce@Example.com');

select pg_temp.ok((select status from public.app_modules where key = 'emails') = 'live', 'emails module is live');
select pg_temp.ok(exists (select 1 from pg_trigger where tgname = 'email_capture'), 'capture trigger is on pg_net''s queue');

-- ---------------------------------------------------------------- recording
create temp table t_req (k text, id bigint);
insert into t_req select 'day', /* day_email_send */ net.http_post(url := 'https://api.resend.com/emails',
  headers := '{"Authorization": "Bearer test-key"}', body := '{"from": "207 Admin <alerts@207photo.com>", "to": ["Bounce@example.com"], "subject": "Your day", "text": "hi", "html": "<p>hi</p>"}');
insert into t_req select 'code', net.http_post(url := 'https://api.resend.com/emails',
  body := '{"from": "207 Admin <alerts@207photo.com>", "to": "x@example.com", "subject": "123456 is your 207 Admin sign-in code", "text": "123456"}');
insert into t_req select 'pd', /* pd_send_waiting */ net.http_post(url := 'https://api.resend.com/emails',
  body := '{"from": "207 Photo <hello@207photo.com>", "to": ["coach@example.com"], "subject": "[TEST] Picture day times", "text": "9:00", "reply_to": "hello@207photo.com"}');
insert into t_req select 'push', net.http_post(url := 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/push-sender', body := '{}');
select pg_temp.ok((select count(*) from public.email_sends) = 3, 'three Resend sends recorded; other requests ignored');
select pg_temp.ok((select source = 'day_email' and to_emails = '{bounce@example.com}' and payload ->> 'html' = '<p>hi</p>' and not test_mode from public.email_sends where request_id = (select id from t_req where k = 'day')), 'source, lower-cased address and content kept');
select pg_temp.ok((select source = 'signin' and subject = 'Sign-in code' and payload is null and to_emails = '{x@example.com}' from public.email_sends where request_id = (select id from t_req where k = 'code')), 'sign-in codes: no code kept, not resendable');
select pg_temp.ok((select source = 'pictureday' and test_mode from public.email_sends where request_id = (select id from t_req where k = 'pd')), 'picture day test send');
select pg_temp.ok(not exists (select 1 from public.email_sends where payload::text like '%test-key%'), 'the API key is never stored');

-- ---------------------------------------------------------------- hearing back
insert into net._http_response (id, status_code, content) values
  ((select id from t_req where k = 'day'), 200, '{"id": "re_day"}'),
  ((select id from t_req where k = 'code'), 200, '{"id": "re_code"}'),
  ((select id from t_req where k = 'pd'), 422, '{"name": "validation_error", "message": "Invalid `to` field."}');
select public.email_delivery_sweep();
select pg_temp.ok((select status = 'sent' and resend_id = 're_day' and next_check_at > now() from public.email_sends where request_id = (select id from t_req where k = 'day')), 'accepted: sent, look-up scheduled');
select pg_temp.ok((select status = 'failed' and error = 'Invalid `to` field.' from public.email_sends where request_id = (select id from t_req where k = 'pd')), 'refused: failed with Resend''s message');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'email_problem' and title = 'Email not sent'), 'a failure is pushed');
update public.email_sends set next_check_at = now() - interval '1 minute' where resend_id in ('re_day', 're_code');
select public.email_delivery_sweep();
select pg_temp.ok((select count(*) from net.http_request_queue where method = 'GET' and url like 'https://api.resend.com/emails/re_%') = 2, 'due look-ups asked of Resend');
select pg_temp.ok((select count(*) from public.email_sends where resend_id in ('re_day', 're_code') and poll_request_id is not null) = 2, 'and remembered');
insert into net._http_response (id, status_code, content)
select s.poll_request_id, 200, case when s.resend_id = 're_day' then '{"id": "re_day", "last_event": "bounced"}' else '{"id": "re_code", "last_event": "opened"}' end
  from public.email_sends s where s.resend_id in ('re_day', 're_code');
select public.email_delivery_sweep();
select pg_temp.ok((select status = 'bounced' and next_check_at is null and poll_request_id is null from public.email_sends where resend_id = 're_day'), 'bounced: final');
select pg_temp.ok((select bounced_at is not null from public.prospect_contacts where email = 'Bounce@Example.com'), 'the contact is marked bounced, so outreach stops');
select pg_temp.ok((select status = 'delivered' and opened_at is not null and checks = 1 and next_check_at > now() + interval '50 minutes' from public.email_sends where resend_id = 're_code'), 'opened: delivered, opened, next look in an hour');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'email_problem' and title = 'Email bounced'), 'a bounce is pushed');
-- rate limited: same check again soon
update public.email_sends set next_check_at = now() - interval '1 minute' where resend_id = 're_code';
select public.email_delivery_sweep();
insert into net._http_response (id, status_code, content) select poll_request_id, 429, '{"message": "Too many requests"}' from public.email_sends where resend_id = 're_code';
select public.email_delivery_sweep();
select pg_temp.ok((select checks = 1 and status = 'delivered' and next_check_at < now() + interval '5 minutes' from public.email_sends where resend_id = 're_code'), '429: nothing lost, asked again in a couple of minutes');
-- an answer that never comes
update public.email_sends set poll_request_id = 999999, next_check_at = now() - interval '1 minute' where resend_id = 're_code';
select public.email_delivery_sweep();
select pg_temp.ok((select poll_request_id is not null and poll_request_id <> 999999 from public.email_sends where resend_id = 're_code'), 'a lost look-up is asked again');
-- a send with no answer at all for 6 hours
insert into public.email_sends (request_id, to_emails, subject, sent_at) values (888888, '{late@example.com}', 'Late', now() - interval '7 hours');
select public.email_delivery_sweep();
select pg_temp.ok((select status = 'unknown' from public.email_sends where request_id = 888888), 'no answer kept: unknown');

-- ---------------------------------------------------------------- access + RPCs
select pg_temp.act('00000000-0000-0000-0000-0000000003d1');
select pg_temp.raises($$select public.email_list()$$, 'no emails module: list refused');
select pg_temp.raises($$select public.email_report()$$, 'no emails module: report refused');
select pg_temp.raises($$select * from public.email_sends$$, 'table is not readable directly');
select pg_temp.act(null);
select pg_temp.raises($$select public.email_list()$$, 'anon refused');
select pg_temp.act('00000000-0000-0000-0000-0000000003c1');
select pg_temp.ok((select jsonb_array_length(public.email_list() -> 'rows')) = 4, 'view: the list');
select pg_temp.ok((public.email_list() ->> 'capturing')::boolean, 'list says sends are being recorded');
select pg_temp.ok((select jsonb_array_length(public.email_list('problems') -> 'rows')) = 3, 'problems: bounced, failed, unknown');
select pg_temp.ok((select jsonb_array_length(public.email_list('all', null, 'bounce') -> 'rows')) = 1, 'search by address');
select pg_temp.ok((public.email_attention() ->> 'problems')::int = 2, 'Today: two problems (bounced + failed)');
select pg_temp.raises($$select public.email_resend(1)$$, 'view: resend refused');
select pg_temp.raises($$select public.email_mark_handled(array[1::bigint])$$, 'view: mark handled refused');
reset role;
create temp table t_ids as select resend_id, id from public.email_sends;
grant select on t_ids to authenticated;
select pg_temp.act('00000000-0000-0000-0000-0000000003c1');
select pg_temp.ok((select (d ->> 'html') = '<p>hi</p>' and (d ->> 'bounced_contact')::boolean from (select public.email_detail((select id from t_ids where resend_id = 're_day')) d) x), 'detail: the content and that the contact bounced');
select pg_temp.ok((select (r -> 'months' -> 0 ->> 'sent')::int = 4 and (r -> 'months' -> 0 ->> 'bounced')::int = 1 and (r -> 'months' -> 0 ->> 'opened')::int = 1
                     and jsonb_array_length(r -> 'bounced') = 1 from (select public.email_report(3) r) x), 'report: month counts and bounced addresses');

select pg_temp.act('00000000-0000-0000-0000-0000000003e1');
select pg_temp.raises($$select public.email_resend((select id from t_ids where resend_id = 're_code'))$$, 'a sign-in code can''t be resent');
select pg_temp.raises($$select public.email_resend((select id from t_ids where resend_id = 're_day'), 'not an address')$$, 'a bad corrected address refused');
select pg_temp.ok((public.email_resend((select id from t_ids where resend_id = 're_day'), 'Fixed@Example.com') ->> 'ok')::boolean, 'resend to a corrected address');
reset role;
select pg_temp.ok((select source = 'day_email' and to_emails = '{fixed@example.com}' and resent_from = (select id from t_ids where resend_id = 're_day')
                          and resent_by = '00000000-0000-0000-0000-0000000003e1' and payload ->> 'html' = '<p>hi</p>'
                     from public.email_sends where resent_from is not null), 'the resend is recorded, linked, with the same content');
select pg_temp.ok((select handled_at is not null from public.email_sends where resend_id = 're_day'), 'resending marks the problem handled');
select pg_temp.act('00000000-0000-0000-0000-0000000003e1');
select pg_temp.ok((public.email_mark_handled(array[(select id from t_ids where resend_id is null and id = (select max(id) from t_ids where resend_id is null))]) ->> 'n')::int = 1, 'mark handled');

select 'ALL EMAIL DELIVERY TESTS PASSED';
rollback;
