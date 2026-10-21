-- Push notifications (2026-10-21).
--
-- Phone / desktop notifications for 207 Admin (installed as a home-screen web app). Each notification
-- type (push_topics) belongs to a module, and goes only to people who can see that module (owner: all),
-- on every device they turned notifications on for, unless they switched that type off.
--
--   something happens -> trigger -> push_notify(topic, title, body, url)  -> push_outbox row
--                                                                         -> pokes the push-sender edge function (pg_net, after commit)
--   push-sender -> push_claim() (rows + their recipients' devices) -> sends -> push_done() (prunes dead devices)
--   cron every 5 min re-pokes if anything is still unsent.
--
-- New modules add notifications with one push_topics row + a trigger (or a call) that does
--   perform public.push_notify('shift_uncovered', 'A shift needs someone', 'Saturday 9am at Hampden', '/#staff/schedule');
-- A notification must never break the thing that caused it: triggers swallow their own errors.

-- ---------------------------------------------------------------- tables
create table public.push_topics (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  label       text not null,
  description text not null default '',
  module      text not null references public.app_modules (key) on update cascade,
  sort        int  not null default 100,
  default_on  boolean not null default true
);
comment on table public.push_topics is 'Kinds of push notification. Each goes to people who can see `module` (full access: everyone with full access).';

insert into public.push_topics (key, label, description, module, sort) values
  ('help_request',         'New help request',        'A parent asked for help finding their access code.', 'parents', 10),
  ('makeup_new',           'New makeup booked',       'A parent booked a makeup session.', 'parents', 20),
  ('retake_new',           'New retake request',      'A parent asked for a retake.', 'parents', 30),
  ('booking_email_failed', 'Booking email failed',    'A booking email could not be sent.', 'bookings', 40),
  ('outreach_review',      'Outreach to review',      'An outreach email is waiting for your review.', 'partners', 50),
  ('sync_failed',          'GotPhoto sync failing',   'The GotPhoto sync started failing.', 'settings', 60);

create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.team_members (user_id) on delete cascade,
  endpoint   text not null unique check (endpoint ~ '^https://'),
  p256dh     text not null,
  auth       text not null,
  label      text not null default '',
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures   int not null default 0
);
comment on table public.push_subscriptions is 'One row per device (browser push subscription) a team member turned notifications on for.';
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table public.push_prefs (
  user_id uuid not null references public.team_members (user_id) on delete cascade,
  topic   text not null references public.push_topics (key) on update cascade on delete cascade,
  enabled boolean not null,
  primary key (user_id, topic)
);
comment on table public.push_prefs is 'Per-person overrides of push_topics.default_on.';

create table public.push_outbox (
  id          bigint generated always as identity primary key,
  topic       text not null,          -- a push_topics key, or 'test'
  title       text not null,
  body        text not null default '',
  url         text not null default '/',
  tag         text,                   -- same tag = replaces the previous notification on the device
  target_user uuid,                   -- set: only this person (tests); null: everyone the topic reaches
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  attempts    int not null default 0,
  result      jsonb
);
comment on table public.push_outbox is 'Notifications waiting to be sent / sent (kept 30 days). Written by push_notify(); sent by the push-sender edge function.';
create index push_outbox_unsent_idx on public.push_outbox (created_at) where sent_at is null;

alter table public.push_topics        enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_prefs         enable row level security;
alter table public.push_outbox        enable row level security;
revoke all on public.push_topics, public.push_subscriptions, public.push_prefs, public.push_outbox from anon, authenticated;

-- Secret the database uses to wake push-sender (generated here; never leaves the server).
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'push_trigger_secret', '207 Admin: pg_net -> push-sender');

-- ---------------------------------------------------------------- internal helpers (not callable by users)
-- Like can(), but for any user and without a session: used to pick recipients.
create function public.team_user_can(p_uid uuid, p_module text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admin_users a where a.user_id = p_uid)
      or exists (select 1 from public.team_members m
                   join public.team_permissions p on p.user_id = m.user_id
                   join public.app_modules am on am.key = p.module_key and not am.admin_only
                  where m.user_id = p_uid and m.active and p.module_key = p_module)
$$;

create function public.push_poke()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/push-sender',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-push-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_trigger_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000);
exception when others then
  raise warning 'push_poke failed: %', sqlerrm;
end $$;

-- Queue a notification. A second one with the same tag within 10 minutes is dropped while the first
-- is still unsent (a batch of 20 outreach drafts = one notification).
create function public.push_notify(p_topic text, p_title text, p_body text default '', p_url text default '/',
                                   p_tag text default null, p_target_user uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_tag is not null and exists (select 1 from public.push_outbox o
                                    where o.tag = p_tag and o.sent_at is null and o.created_at > now() - interval '10 minutes'
                                      and o.target_user is not distinct from p_target_user) then
    return;
  end if;
  insert into public.push_outbox (topic, title, body, url, tag, target_user)
  values (p_topic, left(p_title, 120), left(coalesce(p_body, ''), 300), coalesce(p_url, '/'), p_tag, p_target_user);
  perform public.push_poke();
end $$;

-- ---------------------------------------------------------------- push-sender (service role only)
create function public.push_trigger_ok(p text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p, '') <> '' and exists (select 1 from vault.decrypted_secrets where name = 'push_trigger_secret' and decrypted_secret = p)
$$;

create function public.push_vapid_keys()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'public',  (select decrypted_secret from vault.decrypted_secrets where name = 'push_vapid_public'),
    'private', (select decrypted_secret from vault.decrypted_secrets where name = 'push_vapid_private'))
$$;

-- Called once by push-sender with keys it generated. First writer wins.
create function public.push_vapid_store(p_public text, p_private text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('push_vapid_store'));
  if not exists (select 1 from vault.secrets where name = 'push_vapid_public') then
    perform vault.create_secret(p_private, 'push_vapid_private', '207 Admin web push VAPID private key (JWK)');
    perform vault.create_secret(p_public, 'push_vapid_public', '207 Admin web push VAPID public key');
  end if;
  return public.push_vapid_keys();
end $$;

-- Claim up to p_limit unsent notifications, each with the devices it should go to.
create function public.push_claim(p_limit int default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with c as (
    update public.push_outbox o set claimed_at = now(), attempts = attempts + 1
     where o.id in (select id from public.push_outbox
                     where sent_at is null and attempts < 5 and (claimed_at is null or claimed_at < now() - interval '2 minutes')
                     order by created_at limit greatest(1, least(coalesce(p_limit, 20), 100))
                     for update skip locked)
    returning o.*)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'title', c.title, 'body', c.body, 'url', c.url, 'tag', c.tag,
           'subs', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
                      from public.push_subscriptions s
                      join public.team_members m on m.user_id = s.user_id
                     where (m.active or exists (select 1 from public.admin_users a where a.user_id = m.user_id))
                       and case when c.target_user is not null then s.user_id = c.target_user
                                else exists (select 1 from public.push_topics t
                                              where t.key = c.topic and public.team_user_can(s.user_id, t.module)
                                                and coalesce((select p.enabled from public.push_prefs p where p.user_id = s.user_id and p.topic = t.key), t.default_on))
                           end))), '[]'::jsonb)
    into v from c;
  return v;
end $$;

-- p_results: [{id: <outbox id>, sent: n, failed: n, ok_subs: [uuid], gone_subs: [uuid], failed_subs: [uuid]}]
create function public.push_done(p_results jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    update public.push_outbox set sent_at = now(), result = r - 'ok_subs' - 'gone_subs' - 'failed_subs' where id = (r ->> 'id')::bigint;
    update public.push_subscriptions set last_ok_at = now(), failures = 0
     where id in (select jsonb_array_elements_text(coalesce(r -> 'ok_subs', '[]'))::uuid);
    update public.push_subscriptions set failures = failures + 1
     where id in (select jsonb_array_elements_text(coalesce(r -> 'failed_subs', '[]'))::uuid);
    delete from public.push_subscriptions
     where id in (select jsonb_array_elements_text(coalesce(r -> 'gone_subs', '[]'))::uuid) or failures >= 20;
  end loop;
end $$;

-- ---------------------------------------------------------------- for the app (signed-in team members)
-- Everything the Notifications screen needs: the public key, this person's topics, their devices.
create function public.push_my_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'vapid_public', (select decrypted_secret from vault.decrypted_secrets where name = 'push_vapid_public'),
    'topics', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'label', t.label, 'description', t.description,
                 'enabled', coalesce((select p.enabled from public.push_prefs p where p.user_id = v_uid and p.topic = t.key), t.default_on)) order by t.sort), '[]'::jsonb)
                 from public.push_topics t where public.team_user_can(v_uid, t.module)),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'endpoint', s.endpoint, 'created_at', s.created_at, 'last_ok_at', s.last_ok_at) order by s.created_at), '[]'::jsonb)
                  from public.push_subscriptions s where s.user_id = v_uid));
end $$;

create function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_label text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or length(p_endpoint) > 1000 or coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,30}$' then
    raise exception 'bad subscription';
  end if;
  if (select count(*) from public.push_subscriptions where user_id = v_uid) >= 10 then raise exception 'Too many devices: turn notifications off on one first.'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, label)
  values (v_uid, p_endpoint, p_p256dh, p_auth, left(coalesce(p_label, ''), 120))
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, failures = 0;
  return jsonb_build_object('ok', true);
end $$;

create function public.push_unsubscribe(p_endpoint text default null, p_id uuid default null)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions
   where user_id = (select auth.uid()) and public.is_team_member() and (endpoint = p_endpoint or id = p_id);
$$;

create function public.push_set_pref(p_topic text, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.push_topics where key = p_topic) then raise exception 'unknown notification type'; end if;
  insert into public.push_prefs (user_id, topic, enabled) values ((select auth.uid()), p_topic, coalesce(p_enabled, true))
  on conflict (user_id, topic) do update set enabled = excluded.enabled;
end $$;

-- "Send a test" on the Notifications screen: only to the person asking, at most once a minute.
create function public.push_test()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.push_outbox where target_user = v_uid and topic = 'test' and created_at > now() - interval '1 minute') then
    return jsonb_build_object('ok', false, 'error', 'wait');
  end if;
  if not exists (select 1 from public.push_subscriptions where user_id = v_uid) then return jsonb_build_object('ok', false, 'error', 'no_devices'); end if;
  perform public.push_notify('test', 'Notifications are on', 'This is what 207 Admin notifications look like.', '/#today', null, v_uid);
  return jsonb_build_object('ok', true);
end $$;

-- The app calls this when push_my_settings() has no public key yet: push-sender creates the keys.
create function public.push_request_setup()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from vault.secrets where name = 'push_vapid_public') then perform public.push_poke(); end if;
end $$;

-- ---------------------------------------------------------------- grants
do $$
declare f text;
begin
  foreach f in array array['public.team_user_can(uuid, text)', 'public.push_poke()', 'public.push_notify(text, text, text, text, text, uuid)',
                           'public.push_trigger_ok(text)', 'public.push_vapid_keys()', 'public.push_vapid_store(text, text)',
                           'public.push_claim(integer)', 'public.push_done(jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.push_trigger_ok(text)', 'public.push_vapid_keys()', 'public.push_vapid_store(text, text)',
                           'public.push_claim(integer)', 'public.push_done(jsonb)'] loop
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['public.push_my_settings()', 'public.push_subscribe(text, text, text, text)', 'public.push_unsubscribe(text, uuid)',
                           'public.push_set_pref(text, boolean)', 'public.push_test()', 'public.push_request_setup()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- what triggers a notification
create function public.push_on_help_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public.push_notify('help_request', 'New help request',
      'A parent needs help finding their code' || coalesce(' for ' || (select j.name from public.synced_jobs j where j.gotphoto_job_id = new.gotphoto_job_id), '') || '.',
      '/#parents/requests', 'help_request');
  exception when others then raise warning 'push_on_help_request: %', sqlerrm;
  end;
  return null;
end $$;
create trigger push_help_request after insert on public.lookup_requests for each row execute function public.push_on_help_request();

create function public.push_on_makeup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public.push_notify('makeup_new', 'New makeup booked',
      coalesce(nullif(btrim(new.team_text), ''), 'A makeup') ||
      coalesce(', ' || to_char(new.makeup_at at time zone 'America/New_York', 'Dy Mon FMDD FMHH12:MI AM'), '') || '.',
      '/#parents/makeups', 'makeup_new');
  exception when others then raise warning 'push_on_makeup: %', sqlerrm;
  end;
  return null;
end $$;
create trigger push_makeup after insert on public.makeup_bookings for each row execute function public.push_on_makeup();

create function public.push_on_retake()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public.push_notify('retake_new', 'New retake request',
      'For ' || coalesce((select s.name from public.comm_hub_schools s where s.id = new.hub_school_id), 'a school') || '.',
      '/#parents/retakes', 'retake_new');
  exception when others then raise warning 'push_on_retake: %', sqlerrm;
  end;
  return null;
end $$;
create trigger push_retake after insert on public.retake_requests for each row execute function public.push_on_retake();

create function public.push_on_booking_email()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'failed' and old.status is distinct from 'failed' then
    begin
      perform public.push_notify('booking_email_failed', 'A booking email failed',
        coalesce(new.subject, 'A booking email') || coalesce(' (' || (select o.name from public.bookings b join public.prospect_orgs o on o.id = b.org_id where b.id = new.booking_id) || ')', ''),
        '/#jobs/bookings/' || new.booking_id, 'booking_email_failed');
    exception when others then raise warning 'push_on_booking_email: %', sqlerrm;
    end;
  end if;
  return null;
end $$;
create trigger push_booking_email after update of status on public.booking_emails for each row execute function public.push_on_booking_email();

create function public.push_on_outreach_review()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'held' and new.needs_review and (tg_op = 'INSERT' or not (old.status = 'held' and old.needs_review)) then
    begin
      perform public.push_notify('outreach_review', 'Outreach to review',
        'An email to ' || coalesce((select o.name from public.prospect_orgs o where o.id = new.org_id), 'an organization') || ' is waiting for your review.',
        '/#partners/ready', 'outreach_review');
    exception when others then raise warning 'push_on_outreach_review: %', sqlerrm;
    end;
  end if;
  return null;
end $$;
create trigger push_outreach_review after insert or update of status, needs_review on public.prospect_scheduled_emails
  for each row execute function public.push_on_outreach_review();

-- Only when the sync goes from working to failing (it retries every 5 minutes; one notification, not 12 an hour).
create function public.push_on_sync_run()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.ok is false and (tg_op = 'INSERT' or old.ok is distinct from false)
     and coalesce((select r.ok from public.sync_runs r where r.started_at < new.started_at and r.ok is not null order by r.started_at desc limit 1), true) then
    begin
      perform public.push_notify('sync_failed', 'GotPhoto sync is failing',
        'It retries every 5 minutes. Codes on Find My Photos may be out of date.' || coalesce(' ' || left(new.error, 120), ''),
        '/#system/health', 'sync_failed');
    exception when others then raise warning 'push_on_sync_run: %', sqlerrm;
    end;
  end if;
  return null;
end $$;
create trigger push_sync_run after insert or update of ok on public.sync_runs for each row execute function public.push_on_sync_run();

revoke all on function public.push_on_help_request(), public.push_on_makeup(), public.push_on_retake(),
  public.push_on_booking_email(), public.push_on_outreach_review(), public.push_on_sync_run() from public, anon, authenticated;

-- ---------------------------------------------------------------- schedules
select cron.schedule('push-retry', '*/5 * * * *',
  $$select public.push_poke() where exists (select 1 from public.push_outbox where sent_at is null and attempts < 5)$$);
select cron.schedule('push-outbox-retention', '50 4 * * *',
  $$delete from public.push_outbox where created_at < now() - interval '30 days'$$);
