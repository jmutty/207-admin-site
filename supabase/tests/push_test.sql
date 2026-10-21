-- Push notification tests (20261021150000_push_notifications). Run on a NON-production schema copy
-- after the team + push migrations; everything is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/push_test.sql
-- Needs net.http_post to record calls in net.calls (see the local stubs in supabase/README.md).
begin;

create function pg_temp.act(p_uid uuid, p_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'aal', 'aal2', 'session_id', '00000000-0000-0000-0000-0000000000' || right(coalesce(p_uid::text, '00'), 2))::text, true);
  execute format('set local role %I', p_role);
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
-- devices a claimed notification goes to, as user ids
create function pg_temp.claim_users() returns jsonb language sql as $$
  select coalesce(jsonb_agg(x order by x), '[]') from (
    select distinct s.user_id::text x from jsonb_array_elements(public.push_claim(50)) n, jsonb_array_elements(n -> 'subs') sub
      join public.push_subscriptions s on s.id = (sub ->> 'id')::uuid) t
$$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;  -- as on Supabase

-- owner (full access), p1 = parents view, b1 = bookings edit, d1 = deactivated (had parents)
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'p1@example.com'),
  ('00000000-0000-0000-0000-0000000000c2', 'b1@example.com'), ('00000000-0000-0000-0000-0000000000c3', 'd1@example.com');
insert into public.team_members (user_id, display_name, active) values ('00000000-0000-0000-0000-0000000000c1', 'P1', true),
  ('00000000-0000-0000-0000-0000000000c2', 'B1', true), ('00000000-0000-0000-0000-0000000000c3', 'D1', false);
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000c1', 'parents', 'view'),
  ('00000000-0000-0000-0000-0000000000c2', 'bookings', 'edit'), ('00000000-0000-0000-0000-0000000000c3', 'parents', 'edit');
insert into public.team_members (user_id, display_name) values ('ccbe859a-d295-4df0-94bc-6f423db4d806', 'Owner') on conflict do nothing;
-- the deactivated person's old device (they can't subscribe any more)
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('00000000-0000-0000-0000-0000000000c3', 'https://push.example/d1', repeat('A', 87), repeat('B', 22));

-- ---------------------------------------------------------------- subscribing
select pg_temp.act('ccbe859a-d295-4df0-94bc-6f423db4d806');
select public.push_subscribe('https://push.example/owner', repeat('A', 87), repeat('B', 22), 'iPhone');
select pg_temp.ok(jsonb_array_length(public.push_my_settings() -> 'topics') = 6, 'owner: sees all 6 notification types');
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select public.push_subscribe('https://push.example/p1', repeat('A', 87), repeat('B', 22), 'Android');
select pg_temp.ok((select jsonb_agg(t ->> 'key' order by t ->> 'key') from jsonb_array_elements(public.push_my_settings() -> 'topics') t) = '["help_request", "makeup_new", "retake_new"]', 'p1: only Parent help notification types');
select pg_temp.ok(jsonb_array_length(public.push_my_settings() -> 'devices') = 1, 'p1: sees their own device only');
select pg_temp.raises($$select public.push_subscribe('http://insecure.example/x', repeat('A', 87), repeat('B', 22))$$, 'p1: non-https endpoint refused');
select pg_temp.raises($$select public.push_subscribe('https://push.example/x', 'short', repeat('B', 22))$$, 'p1: malformed key refused');
select pg_temp.raises($$select public.push_notify('help_request', 'spoof')$$, 'p1: cannot queue notifications');
select pg_temp.raises($$select public.push_claim(10)$$, 'p1: cannot claim the queue');
select pg_temp.raises($$select public.push_vapid_keys()$$, 'p1: cannot read the VAPID keys');
select pg_temp.raises($$select * from public.push_subscriptions$$, 'p1: cannot read subscriptions directly');
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000c2');
select public.push_subscribe('https://push.example/b1', repeat('A', 87), repeat('B', 22), 'Mac');
select pg_temp.ok((select jsonb_agg(t ->> 'key') from jsonb_array_elements(public.push_my_settings() -> 'topics') t) = '["booking_email_failed"]', 'b1: only Bookings notification types');
reset role;
select pg_temp.act('00000000-0000-0000-0000-0000000000c3');
select pg_temp.raises($$select public.push_subscribe('https://push.example/d1b', repeat('A', 87), repeat('B', 22))$$, 'd1 (deactivated): cannot subscribe');
reset role;
select pg_temp.act(null, 'anon');
select pg_temp.raises($$select public.push_my_settings()$$, 'anon: cannot read notification settings');
reset role;

-- ---------------------------------------------------------------- a help request
delete from net.calls;
insert into public.lookup_requests (parent_email) values ('parent@example.com');
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'help_request' and sent_at is null) = 1, 'help request queues one notification');
select pg_temp.ok((select count(*) from net.calls where url like '%/push-sender' and headers ? 'x-push-secret') = 1, 'and wakes push-sender with the secret');
insert into public.lookup_requests (parent_email) values ('parent2@example.com');
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'help_request' and sent_at is null) = 1, 'a second one within 10 minutes is merged');
select pg_temp.act(null, 'service_role');
select pg_temp.ok(pg_temp.claim_users() = '["00000000-0000-0000-0000-0000000000c1", "ccbe859a-d295-4df0-94bc-6f423db4d806"]', 'goes to the owner and p1 only (not b1, not deactivated d1)');
select public.push_done((select jsonb_agg(jsonb_build_object('id', id, 'sent', 2)) from public.push_outbox where sent_at is null));
reset role;

-- p1 switches help requests off
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select public.push_set_pref('help_request', false);
select pg_temp.ok(not (select (t ->> 'enabled')::boolean from jsonb_array_elements(public.push_my_settings() -> 'topics') t where t ->> 'key' = 'help_request'), 'p1: preference saved');
reset role;
update public.push_outbox set created_at = now() - interval '1 hour';  -- past the merge window
insert into public.lookup_requests (parent_email) values ('parent3@example.com');
select pg_temp.act(null, 'service_role');
select pg_temp.ok(pg_temp.claim_users() = '["ccbe859a-d295-4df0-94bc-6f423db4d806"]', 'after p1 switches it off: owner only');
select public.push_done((select jsonb_agg(jsonb_build_object('id', id)) from public.push_outbox where sent_at is null));
reset role;

-- ---------------------------------------------------------------- other triggers
insert into public.makeup_bookings (google_event_id, parent_name, parent_email, athlete_name, team_text, makeup_at) values ('evt-x', 'P', 'p@example.com', 'A', 'Hampden U10', now() + interval '2 days');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'makeup_new' and body like 'Hampden U10, %'), 'makeup booked -> notification with team and time');
insert into public.retake_requests (gotphoto_job_id, access_code) values ('j1', 'abc');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'retake_new'), 'retake request -> notification');

insert into public.booking_types (key, label, audience) values ('t_push', 'T', 'school') on conflict do nothing;
insert into public.prospect_orgs (id, name) values ('00000000-0000-0000-0000-0000000000f9', 'Brewer Club');
insert into public.bookings (id, org_id, type_key, picture_day, start_at, end_at) values ('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000f9', 't_push', current_date + 5, now(), now());
insert into public.booking_emails (id, booking_id, step_no, subject, status) values ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000b9', 1, 'Rosters', 'scheduled');
select pg_temp.ok(not exists (select 1 from public.push_outbox where topic = 'booking_email_failed'), 'scheduled booking email: no notification');
update public.booking_emails set status = 'failed' where id = '00000000-0000-0000-0000-0000000000e9';
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'booking_email_failed' and body = 'Rosters (Brewer Club)' and url = '/#jobs/bookings/00000000-0000-0000-0000-0000000000b9'), 'booking email fails -> notification naming the org, linking the booking');
select pg_temp.act(null, 'service_role');
select pg_temp.ok((select jsonb_agg(x) from (select distinct s.user_id::text x from jsonb_array_elements(public.push_claim(50)) n, jsonb_array_elements(n -> 'subs') sub join public.push_subscriptions s on s.id = (sub ->> 'id')::uuid where n ->> 'title' = 'A booking email failed') t) @> '["00000000-0000-0000-0000-0000000000c2"]', 'booking failure reaches b1 (bookings)');
reset role;

insert into public.prospect_scheduled_emails (org_id, contact_id, subject, body, status, needs_review) values ('00000000-0000-0000-0000-0000000000f9', gen_random_uuid(), 's', 'b', 'held', true), ('00000000-0000-0000-0000-0000000000f9', gen_random_uuid(), 's', 'b', 'held', true);
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'outreach_review') = 1, 'two drafts held for review -> one notification');

insert into public.sync_runs (trigger_source, started_at, ok) values ('cron', now() - interval '10 minutes', true);
insert into public.sync_runs (id, trigger_source, started_at) values ('00000000-0000-0000-0000-0000000000a9', 'cron', now() - interval '5 minutes');
update public.sync_runs set ok = false, error = 'timeout' where id = '00000000-0000-0000-0000-0000000000a9';
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'sync_failed') = 1, 'sync goes from ok to failed -> notification');
update public.push_outbox set sent_at = now() where topic = 'sync_failed';
insert into public.sync_runs (trigger_source, started_at, ok) values ('cron', now(), false);
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'sync_failed') = 1, 'still failing 5 minutes later -> no second notification');

-- A broken notification never blocks the thing that caused it.
alter table public.push_outbox rename to push_outbox_away;
insert into public.lookup_requests (parent_email) values ('still-works@example.com');
select pg_temp.ok(exists (select 1 from public.lookup_requests where parent_email = 'still-works@example.com'), 'help request still saved when notifications are broken');
alter table public.push_outbox_away rename to push_outbox;

-- ---------------------------------------------------------------- test button + dead devices
select pg_temp.act('ccbe859a-d295-4df0-94bc-6f423db4d806');
select pg_temp.ok((public.push_test() ->> 'ok')::boolean, 'owner: send a test');
select pg_temp.ok(public.push_test() ->> 'error' = 'wait', 'owner: second test within a minute refused');
reset role;
select pg_temp.act(null, 'service_role');
select pg_temp.ok((select jsonb_agg(distinct s.user_id::text) from jsonb_array_elements(public.push_claim(50)) n, jsonb_array_elements(n -> 'subs') sub join public.push_subscriptions s on s.id = (sub ->> 'id')::uuid where n ->> 'title' = 'Notifications are on') = '["ccbe859a-d295-4df0-94bc-6f423db4d806"]', 'test goes to the owner only');
select public.push_done(jsonb_build_array(jsonb_build_object('id', 0, 'gone_subs', jsonb_build_array((select id from public.push_subscriptions where endpoint = 'https://push.example/p1')))));
reset role;
select pg_temp.ok(not exists (select 1 from public.push_subscriptions where endpoint = 'https://push.example/p1'), 'a device the push service says is gone is removed');

select pg_temp.act(null, 'service_role');
select public.push_vapid_store('PUB', '{"d":"x"}');
select public.push_vapid_store('PUB2', '{"d":"y"}');
select pg_temp.ok(public.push_vapid_keys() ->> 'public' = 'PUB', 'VAPID keys: first store wins, never overwritten');
reset role;

do $$ begin raise notice 'ALL PUSH TESTS PASSED'; end $$;
rollback;
