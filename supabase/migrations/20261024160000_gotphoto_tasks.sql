-- GotPhoto API automations (2026-10-24). Jeremiah picked these from the API research page
-- (https://claude.ai/artifact/BLDtLNm6TAY56wVnGsH2aC): items 2 to 7.
--
--   2. Orders from the API instead of Gmail. gotphoto-tasks reads new paid orders (GET /orders,
--      /orders/{id}/orders_photos, /customers/{id}) into gotphoto_orders, the table the photo release page
--      reads. Rows from the API carry gmail_message_id 'gp-api:<order id>'. While the Gmail Apps Script still
--      runs, a trigger drops its copy of an order the API already brought in (same email and file within
--      30 minutes), and the API skips an order Gmail already brought in.
--   3. Makeups. A makeup with no coupon gets one made in GotPhoto (same settings as the "Makeup Day Coupon
--      Codes" ones: $30 off products, $10 off shipping, one use). After the makeup, the job's galleries are
--      checked for the athlete's photos (their name in the file name, or any photo uploaded after the makeup).
--      Until then the makeup is "Waiting for photos"; once found it is "Ready to send". A makeup with no
--      confirmed job whose suggested job has the photos gets that job confirmed. Auto-send is a switch (off).
--   4. Galleries: photo count and tagging per gallery on synced_jobs (gp_galleries). "In production" ticks
--      itself when the first photos are up (stage auto 'photos_uploaded'). Today lists jobs with no photos
--      three days after the last picture day.
--   5. Launch: gp_job_launch() queues PUT /jobs/{id} status=published. Dates: a booking's picture day and
--      order deadline go to GotPhoto (shoot, and archive = the day after the order deadline) when they change.
--   6. Help requests: after a code is sent, the parent's email is added to that code in GotPhoto as a
--      potential buyer, so GotPhoto's own reminders reach them.
--   7. Registered and ordered families per job (GET /jobs/{id}/customers) on synced_jobs.
--
-- Switches live in gp_task_settings (Settings > Sync). The edge function is gotphoto-tasks: cron every 10
-- minutes, and woken right away by gp_job_launch() / date changes.

-- ---------------------------------------------------------------- columns
alter table public.synced_jobs
  add column if not exists gp_galleries      jsonb,
  add column if not exists gp_photo_count    int,
  add column if not exists gp_tagging_done   boolean,
  add column if not exists gp_galleries_at   timestamptz,
  add column if not exists gp_first_photo_at timestamptz,
  add column if not exists gp_registered     int,
  add column if not exists gp_buyers         int,
  add column if not exists gp_customers_at   timestamptz;
comment on column public.synced_jobs.gp_galleries is 'GotPhoto galleries: [{id, name, photos, tagged, type}] (gotphoto-tasks).';
comment on column public.synced_jobs.gp_first_photo_at is 'When gotphoto-tasks first saw photos in this job.';
comment on column public.synced_jobs.gp_registered is 'Families (GotPhoto customers) on this job''s codes, buyers included.';
comment on column public.synced_jobs.gp_buyers is 'Families who ordered from this job.';

alter table public.makeup_bookings
  add column if not exists photos_in_at      timestamptz,
  add column if not exists photos_how        text,
  add column if not exists photos_n          int,
  add column if not exists photos_checked_at timestamptz,
  add column if not exists coupon_gp_id      text,
  add column if not exists coupon_made_at    timestamptz,
  add column if not exists auto_confirmed    boolean not null default false;
comment on column public.makeup_bookings.photos_how is 'name = a photo file carries the athlete''s name; upload = photos were uploaded to the job after the makeup.';

alter table public.lookup_requests
  add column if not exists gp_linked_at    timestamptz,
  add column if not exists gp_customer_id  text,
  add column if not exists gp_link_error   text,
  add column if not exists gp_link_tries   int not null default 0;

-- ---------------------------------------------------------------- settings and state
create table if not exists public.gp_task_settings (
  id               boolean primary key default true check (id),
  orders_from_api  boolean not null default true,
  makeup_coupons   boolean not null default true,
  makeup_auto_send boolean not null default false,
  push_dates       boolean not null default true,
  link_parents     boolean not null default true,
  coupon_name      text    not null default 'Makeup Day Coupon Codes',
  coupon_value     numeric not null default 30,
  coupon_shipping  numeric not null default 10,
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);
insert into public.gp_task_settings (id) values (true) on conflict do nothing;
alter table public.gp_task_settings enable row level security;

create table if not exists public.gp_task_state (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);
alter table public.gp_task_state enable row level security;

-- Orders already handled (imported, or seen and skipped), so a run never fetches the same order's photos twice.
create table if not exists public.gp_orders_seen (
  order_id   text primary key,
  created    timestamptz,
  files      int,
  how        text,
  seen_at    timestamptz not null default now()
);
alter table public.gp_orders_seen enable row level security;

-- Writes to GotPhoto jobs, one row each: 'launch' (status published) or 'dates' (shoot / archive).
create table if not exists public.gp_job_actions (
  id              bigint generated always as identity primary key,
  booking_id      uuid references public.bookings(id) on delete set null,
  gotphoto_job_id text not null,
  action          text not null check (action in ('launch', 'dates')),
  payload         jsonb not null default '{}'::jsonb,
  requested_by    uuid,
  requested_at    timestamptz not null default now(),
  started_at      timestamptz,
  done_at         timestamptz,
  ok              boolean,
  result          jsonb,
  error           text,
  tries           int not null default 0
);
create index if not exists gp_job_actions_open on public.gp_job_actions (requested_at) where done_at is null;
create index if not exists gp_job_actions_job on public.gp_job_actions (gotphoto_job_id, requested_at desc);
alter table public.gp_job_actions enable row level security;

-- ---------------------------------------------------------------- waking the function
create or replace function public.gp_tasks_wake(p_run text default 'actions')
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(
    url := 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/gotphoto-tasks?run=' || p_run,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_trigger_secret')),
    timeout_milliseconds := 120000);
end $$;
revoke all on function public.gp_tasks_wake(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- 5. launch and dates
-- The Launch button on the job page's GotPhoto tab.
create or replace function public.gp_job_launch(p_booking uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_job text; v_status text;
begin
  if not public.can('bookings', 'edit') then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select j.gotphoto_job_id, sj.status into v_job, v_status
    from public.booking_job_info(p_booking) j join synced_jobs sj using (gotphoto_job_id) limit 1;
  if v_job is null then return jsonb_build_object('ok', false, 'error', 'no_job'); end if;
  if v_status = 'published' then return jsonb_build_object('ok', false, 'error', 'already_live'); end if;
  if exists (select 1 from gp_job_actions where gotphoto_job_id = v_job and action = 'launch' and done_at is null) then
    return jsonb_build_object('ok', true, 'queued', true);
  end if;
  insert into gp_job_actions (booking_id, gotphoto_job_id, action, requested_by) values (p_booking, v_job, 'launch', auth.uid());
  perform public.gp_tasks_wake('actions');
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.gp_job_launch(uuid) from public, anon;
grant execute on function public.gp_job_launch(uuid) to authenticated;

-- A booking's picture day or order deadline changed (or its GotPhoto job was linked): queue the dates. One open
-- 'dates' row per job; a second change before it runs updates that row.
create or replace function public.gp_booking_dates_changed()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_p jsonb := '{}'::jsonb; v_linked boolean;
begin
  if new.status <> 'booked' or new.gotphoto_job_id is null then return new; end if;
  if not coalesce((select push_dates from gp_task_settings), false) then return new; end if;
  v_linked := new.gotphoto_job_id is distinct from old.gotphoto_job_id;
  if new.picture_day is distinct from old.picture_day and new.picture_day is not null then
    v_p := v_p || jsonb_build_object('shoot', new.picture_day);
  end if;
  if (new.order_deadline is distinct from old.order_deadline or v_linked) and new.order_deadline is not null then
    v_p := v_p || jsonb_build_object('archive', new.order_deadline + 1);
  end if;
  if v_p = '{}'::jsonb then return new; end if;
  update gp_job_actions set payload = payload || v_p, requested_at = now()
   where gotphoto_job_id = new.gotphoto_job_id and action = 'dates' and started_at is null and done_at is null;
  if not found then
    insert into gp_job_actions (booking_id, gotphoto_job_id, action, payload, requested_by)
    values (new.id, new.gotphoto_job_id, 'dates', v_p, auth.uid());
  end if;
  perform public.gp_tasks_wake('actions');
  return new;
end $$;
revoke all on function public.gp_booking_dates_changed() from public, anon, authenticated;
drop trigger if exists gp_booking_dates on public.bookings;
create trigger gp_booking_dates after update of picture_day, order_deadline, gotphoto_job_id on public.bookings
  for each row execute function public.gp_booking_dates_changed();

-- ---------------------------------------------------------------- 4. "In production" ticks when photos are up
alter table public.booking_stages drop constraint if exists booking_stages_auto_check;
alter table public.booking_stages add constraint booking_stages_auto_check
  check (auto = any (array['booked', 'picture_day', 'photos_uploaded', 'gallery_live', 'deliverables_done']));
update public.booking_stages set auto = 'photos_uploaded'
 where label = 'In production' and auto is null and archived_at is null
   and not exists (select 1 from public.booking_stages s2 where s2.type_key = booking_stages.type_key and s2.auto = 'photos_uploaded');

-- Same as before, plus photos_uploaded (gotphoto-tasks fills gp_photo_count; the gallery going live implies it).
create or replace function public.booking_stages_tick()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_today date := (now() at time zone 'America/New_York')::date; v_last date; v_live timestamptz; v_photos int;
begin
  for r in
    select b.id, b.picture_day, b.type_key from bookings b
      left join booking_progress p on p.booking_id = b.id
      left join booking_stages cur on cur.id = p.stage_id
     where b.status <> 'cancelled' and b.picture_day < v_today and b.picture_day >= v_today - 365
       and exists (select 1 from booking_stages s where s.type_key = b.type_key and s.archived_at is null
                     and s.auto in ('picture_day', 'photos_uploaded', 'gallery_live') and s.sort > coalesce(cur.sort, -1))
  loop
    select coalesce(max(day), r.picture_day) into v_last from booking_days where booking_id = r.id and not removed;
    if v_last < v_today and public.booking_stage_auto(r.id, 'picture_day') then n := n + 1; end if;
    select max(j.gp_activated_at), max(sj.gp_photo_count) into v_live, v_photos
      from public.booking_job_info(r.id) j left join synced_jobs sj using (gotphoto_job_id);
    if (coalesce(v_photos, 0) > 0 or v_live is not null) and public.booking_stage_auto(r.id, 'photos_uploaded') then n := n + 1; end if;
    if v_live is not null and public.booking_stage_auto(r.id, 'gallery_live') then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Jobs whose photos should be up by now: booked, last picture day 3 to 30 days ago, linked to a GotPhoto job
-- that isn't live and has no photos (once gotphoto-tasks has looked).
create or replace function public.gp_photos_missing()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.can('bookings', 'view') then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'title', coalesce(b.title_override, b.title_label || ' ' || chr(8226) || ' ' || o.name),
                                        'day', x.last_day, 'tab', 'gotphoto') order by x.last_day)
      from bookings b
      join prospect_orgs o on o.id = b.org_id
      cross join lateral (select coalesce(max(d.day), b.picture_day) last_day from booking_days d where d.booking_id = b.id and not d.removed) x
      join lateral (select j.gotphoto_job_id, j.gp_activated_at from public.booking_job_info(b.id) j limit 1) ji on true
      join synced_jobs sj on sj.gotphoto_job_id = ji.gotphoto_job_id
     where b.status = 'booked'
       and x.last_day between (now() at time zone 'America/New_York')::date - 30 and (now() at time zone 'America/New_York')::date - 3
       and ji.gp_activated_at is null and sj.gp_galleries_at is not null and coalesce(sj.gp_photo_count, 0) = 0), '[]'::jsonb) end
$$;
revoke all on function public.gp_photos_missing() from public, anon;
grant execute on function public.gp_photos_missing() to authenticated;

-- What the job page's GotPhoto tab and the Hub tab show.
create or replace function public.gp_job_panel(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_job text; sj synced_jobs; b bookings;
begin
  if not public.job_can_view(p_booking) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking;
  select j.gotphoto_job_id into v_job from public.booking_job_info(p_booking) j limit 1;
  if v_job is null then return jsonb_build_object('linked', false, 'can_edit', public.can('bookings', 'edit')); end if;
  select * into sj from synced_jobs where gotphoto_job_id = v_job;
  return jsonb_build_object(
    'linked', true, 'job_id', v_job, 'name', sj.name, 'status', sj.status, 'activated_at', sj.gp_activated_at,
    'shoot_at', sj.shoot_at, 'code_count', sj.code_count, 'access_type', sj.access_type,
    'galleries', coalesce(sj.gp_galleries, '[]'::jsonb), 'photo_count', sj.gp_photo_count, 'tagging_done', sj.gp_tagging_done,
    'galleries_at', sj.gp_galleries_at, 'first_photo_at', sj.gp_first_photo_at,
    'registered', sj.gp_registered, 'buyers', sj.gp_buyers, 'customers_at', sj.gp_customers_at,
    'order_deadline', b.order_deadline, 'picture_day', b.picture_day,
    'push_dates', (select push_dates from gp_task_settings),
    'can_edit', public.can('bookings', 'edit'),
    'actions', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'action', a.action, 'payload', a.payload, 'requested_at', a.requested_at,
                  'done_at', a.done_at, 'ok', a.ok, 'error', a.error, 'result', a.result) order by a.requested_at desc), '[]'::jsonb)
                  from (select * from gp_job_actions where gotphoto_job_id = v_job order by requested_at desc limit 5) a));
end $$;
revoke all on function public.gp_job_panel(uuid) from public, anon;
grant execute on function public.gp_job_panel(uuid) to authenticated;

-- ---------------------------------------------------------------- 3. makeups
-- Waiting for photos: after the makeup, with a job, until gotphoto-tasks finds the photos (or 14 days pass, so
-- nothing gets stuck where no photo carries the name and nothing new was uploaded).
create or replace function public.makeup_status(b makeup_bookings)
returns text language sql stable set search_path = public as $$
  select case when b.dismissed_at is not null then 'dismissed'
              when b.sent_at is not null then 'sent'
              when b.makeup_at > now() then 'upcoming'
              when b.confirmed_job_id is null then 'needs_job'
              when b.photos_in_at is null and b.makeup_at > now() - interval '14 days' then 'waiting_photos'
              else 'ready' end
$$;

-- The send itself, without the permission check: makeup_send_ready (people) and makeup_send_auto (gotphoto-tasks,
-- when auto-send is on) both use it. Body unchanged from makeup_send_ready, plus 'waiting_photos' may be sent by hand.
create or replace function public.makeup_send_core(p_id uuid, p_email text, p_first text, p_coupon text, p_force boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  b makeup_bookings; v_status text; v_parts jsonb; v_key text; v_req bigint;
begin
  -- Row lock: a double click waits here, then sees sent_at and stops.
  select * into b from makeup_bookings where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  v_status := makeup_status(b);
  if v_status = 'sent' and not p_force then return jsonb_build_object('ok', false, 'error', 'already_sent'); end if;
  if v_status not in ('ready', 'waiting_photos', 'sent') then return jsonb_build_object('ok', false, 'error', v_status); end if;

  v_parts := makeup_email_parts(p_id, p_email, p_first, p_coupon);
  if (v_parts ->> 'ok')::boolean is not true then return v_parts; end if;
  if (v_parts ->> 'to') !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_email');
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_key is null then return jsonb_build_object('ok', false, 'error', 'no_resend_key'); end if;

  select net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body    := jsonb_build_object(
                 'from', '207 Photo <alerts@207photo.com>',
                 'to', jsonb_build_array(v_parts ->> 'to'),
                 'reply_to', 'info@207photo.com',
                 'subject', v_parts ->> 'subject',
                 'text', v_parts ->> 'text',
                 'html', v_parts ->> 'html'),
    timeout_milliseconds := 20000) into v_req;

  update makeup_bookings set sent_at = now(), sent_to = v_parts ->> 'to', sent_link = v_parts ->> 'link',
         send_request_id = v_req, send_status = 'pending', send_error = null
   where id = p_id;
  return jsonb_build_object('ok', true, 'to', v_parts ->> 'to', 'link_kind', v_parts ->> 'link_kind');
end $$;
revoke all on function public.makeup_send_core(uuid, text, text, text, boolean) from public, anon, authenticated;

create or replace function public.makeup_send_ready(p_id uuid, p_email text default null, p_first text default null,
                                                    p_coupon text default null, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.can_any('{parents}', 'edit') then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  return public.makeup_send_core(p_id, p_email, p_first, p_coupon, p_force);
end $$;

-- gotphoto-tasks (service role) only: send once the photos are found, when auto-send is on.
create or replace function public.makeup_send_auto(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b makeup_bookings;
begin
  if not coalesce((select makeup_auto_send from gp_task_settings), false) then return jsonb_build_object('ok', false, 'error', 'auto_send_off'); end if;
  select * into b from makeup_bookings where id = p_id;
  if b.id is null or b.photos_in_at is null or makeup_status(b) <> 'ready' then return jsonb_build_object('ok', false, 'error', 'not_ready'); end if;
  return public.makeup_send_core(p_id, null, null, null, false);
end $$;
revoke all on function public.makeup_send_auto(uuid) from public, anon, authenticated;
grant execute on function public.makeup_send_auto(uuid) to service_role;

-- The Makeups list, plus what the photo check found and whether the coupon was made here.
create or replace function public.admin_makeups()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.can_any('{parents}', 'view') then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', b.id, 'parent_name', b.parent_name, 'parent_email', b.parent_email,
             'athlete_name', b.athlete_name, 'team_text', b.team_text, 'makeup_at', b.makeup_at,
             'coupon_code', b.coupon_code, 'booked_at', b.booked_at,
             'suggested_job_id', b.suggested_job_id, 'suggested_name', sj.name,
             'candidates', b.suggested_candidates,
             'confirmed_job_id', b.confirmed_job_id, 'confirmed_name', cj.name,
             'confirmed_live', cj.gp_activated_at is not null,
             'dismissed_at', b.dismissed_at, 'sent_at', b.sent_at, 'sent_to', b.sent_to,
             'sent_link', b.sent_link, 'send_status', b.send_status, 'send_error', b.send_error,
             'code_choice', case when coalesce(b.confirmed_job_id, b.suggested_job_id) is not null
                                 then makeup_code_for(coalesce(b.confirmed_job_id, b.suggested_job_id), b.athlete_name) end,
             'photos_in_at', b.photos_in_at, 'photos_how', b.photos_how, 'photos_n', b.photos_n,
             'photos_checked_at', b.photos_checked_at, 'coupon_made_at', b.coupon_made_at, 'auto_confirmed', b.auto_confirmed,
             'status', makeup_status(b))
             order by b.makeup_at desc)
      from makeup_bookings b
      left join synced_jobs sj on sj.gotphoto_job_id = b.suggested_job_id
      left join synced_jobs cj on cj.gotphoto_job_id = b.confirmed_job_id), '[]'::jsonb) end
$$;

-- ---------------------------------------------------------------- 2. orders: no double rows while Gmail still runs
create or replace function public.gotphoto_orders_dedupe()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.gmail_message_id like 'gp-api:%' then return new; end if;
  if exists (select 1 from gotphoto_orders o
              where o.gmail_message_id like 'gp-api:%' and o.email = new.email and o.filename = new.filename
                and o.order_ts between new.order_ts - interval '30 minutes' and new.order_ts + interval '30 minutes') then
    return null;
  end if;
  return new;
end $$;
revoke all on function public.gotphoto_orders_dedupe() from public, anon, authenticated;
drop trigger if exists gotphoto_orders_dedupe on public.gotphoto_orders;
create trigger gotphoto_orders_dedupe before insert on public.gotphoto_orders
  for each row execute function public.gotphoto_orders_dedupe();

-- ---------------------------------------------------------------- settings for Settings > Sync
create or replace function public.gp_task_settings_get()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.can('settings', 'view') then null else (
    select jsonb_build_object('orders_from_api', s.orders_from_api, 'makeup_coupons', s.makeup_coupons,
      'makeup_auto_send', s.makeup_auto_send, 'push_dates', s.push_dates, 'link_parents', s.link_parents,
      'orders_last', (select value from gp_task_state where key = 'orders_last'),
      'last_run', (select value from gp_task_state where key = 'last_run'),
      'can_edit', public.can('settings', 'edit'))
      from gp_task_settings s) end
$$;
revoke all on function public.gp_task_settings_get() from public, anon;
grant execute on function public.gp_task_settings_get() to authenticated;

create or replace function public.gp_task_settings_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can('settings', 'edit') then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  update gp_task_settings set
    orders_from_api  = coalesce((p ->> 'orders_from_api')::boolean, orders_from_api),
    makeup_coupons   = coalesce((p ->> 'makeup_coupons')::boolean, makeup_coupons),
    makeup_auto_send = coalesce((p ->> 'makeup_auto_send')::boolean, makeup_auto_send),
    push_dates       = coalesce((p ->> 'push_dates')::boolean, push_dates),
    link_parents     = coalesce((p ->> 'link_parents')::boolean, link_parents),
    updated_at = now(), updated_by = auth.uid()
   where id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.gp_task_settings_save(jsonb) from public, anon;
grant execute on function public.gp_task_settings_save(jsonb) to authenticated;

-- ---------------------------------------------------------------- cron: every 10 minutes
select cron.unschedule('gotphoto-tasks') where exists (select 1 from cron.job where jobname = 'gotphoto-tasks');
select cron.schedule('gotphoto-tasks', '7-59/10 * * * *', $$ select public.gp_tasks_wake('cron') $$);
