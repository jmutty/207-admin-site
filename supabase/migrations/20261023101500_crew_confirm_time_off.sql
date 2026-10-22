-- Crew confirmations, roles, the weekly schedule email, time off requests and daily capacity (2026-10-23).
-- Items B and F of the Airstudio plan.
--
-- Crew roles. crew_roles is the list (seeded: Lead, Second shooter, Posing, Check-in); team_member_roles says
-- who can do which (set on the Team page). A job bar (schedule_entries kind 'job') can carry a role_id.
--
-- Confirm / Can't make it. Putting someone on a booked job (a new job bar) creates a crew_asks row, one per
-- person per booking however many days it has. A few minutes later (cron, 7am-9pm Eastern) they get an email
-- and a push with Confirm and Can't make it buttons. The buttons open https://admin.207photo.com/#crew/<token>,
-- which works without signing in. Changing a confirmed person's time asks again. Saying they can't make it
-- takes their upcoming bars for that job off the schedule (so the job is back under "Jobs not assigned") and
-- pushes the people with Scheduling. Still pending after 2 days with the job within a week: one reminder.
-- Bars that existed before this migration have no ask (no surprise emails at go-live); "Ask to confirm" on
-- the Schedule sends one. Only bookings.status = 'booked' ever sends. Email and push only, never SMS.
--
-- Weekly schedule. week_email_send() emails each person only their own week (jobs with role, where, when to
-- leave, Confirm links for anything pending; studio / admin / other time; time off; hours). From the
-- Schedule's "Email the week" button, and optionally every week on a set day and hour (off by default).
--
-- Time off (module 'timeoff', page #staff/timeoff). Everyone signed in can ask for their own (whole days, or
-- some hours on one day) and cancel it. Edit = approve or decline; approving puts a Time off bar on the
-- Schedule. View = see the whole team's time off. Requests still waiting show faded on the Schedule and in
-- the crew picker.
--
-- Capacity. booking_crew says how many people a job needs (default 1). The Schedule shows a strip per day
-- (available, on jobs, still needed) and the busiest days ahead; "Jobs not assigned" keeps a job until it
-- has as many people as it needs.
--
-- Drive time in the crew picker: the offer-drive edge function (mode "crew") fills offer_drive_cache with the
-- drive from each person's home (and the studio) to the job; crew_options() reads it.

-- ---------------------------------------------------------------- module
insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('timeoff', 'Time off', 'Staff', 'Time off requests. Everyone can ask for their own; View = see the whole team''s; Edit = approve or decline.', 206, 'live', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- tables
create function public.crew_new_token() returns text
language sql volatile set search_path = '' as $$ select encode(extensions.gen_random_bytes(18), 'hex') $$;

create table public.crew_roles (
  id          uuid primary key default gen_random_uuid(),
  label       text not null check (length(btrim(label)) between 1 and 40),
  sort        int not null default 100,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
comment on table public.crew_roles is 'Roles on a job (Lead, Second shooter, ...). Archive, never delete.';
create unique index crew_roles_label_uq on public.crew_roles (lower(btrim(label))) where archived_at is null;
insert into public.crew_roles (label, sort) values ('Lead', 10), ('Second shooter', 20), ('Posing', 30), ('Check-in', 40);

create table public.team_member_roles (
  user_id uuid not null references public.team_members (user_id) on delete cascade,
  role_id uuid not null references public.crew_roles (id) on delete cascade,
  primary key (user_id, role_id)
);
comment on table public.team_member_roles is 'Which crew roles each person can fill (Team page).';

alter table public.schedule_entries add column role_id uuid references public.crew_roles (id) on delete set null;
comment on column public.schedule_entries.role_id is 'The crew role on a job bar (null = none).';

create table public.crew_asks (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings (id) on delete cascade,
  user_id     uuid not null references public.team_members (user_id) on delete cascade,
  token       text not null unique default public.crew_new_token(),
  status      text not null default 'pending' check (status in ('pending', 'confirmed', 'declined')),
  reason      text not null default '' check (length(reason) <= 300),
  changed     boolean not null default false,   -- asked again because the time changed
  queued_at   timestamptz not null default now(),
  asked_at    timestamptz,                      -- null = not sent yet
  reminded_at timestamptz,
  answered_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (booking_id, user_id)
);
comment on table public.crew_asks is 'Asking a person on a booked job to confirm it (Confirm / Can''t make it, no sign-in, by token).';
create index crew_asks_unsent_idx on public.crew_asks (queued_at) where status = 'pending' and asked_at is null;
create index crew_asks_user_idx on public.crew_asks (user_id);

create table public.booking_crew (
  booking_id uuid primary key references public.bookings (id) on delete cascade,
  needed     int not null default 1 check (needed between 1 and 20),
  updated_at timestamptz not null default now()
);
comment on table public.booking_crew is 'How many people a job needs on each day (no row = 1).';

create table public.time_off_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.team_members (user_id) on delete cascade,
  first_day     date not null,
  last_day      date not null,
  start_time    time,                -- both set: only these hours (one day only)
  end_time      time,
  note          text not null default '' check (length(note) <= 500),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  decided_by    uuid references auth.users (id) on delete set null,
  decided_at    timestamptz,
  decision_note text not null default '' check (length(decision_note) <= 500),
  entry_id      uuid references public.schedule_entries (id) on delete set null,   -- the Time off bar made on approval
  created_at    timestamptz not null default now(),
  check (last_day >= first_day and last_day - first_day <= 60),
  check ((start_time is null) = (end_time is null)),
  check (start_time is null or (first_day = last_day and end_time > start_time))
);
comment on table public.time_off_requests is 'Time off people asked for. Approving puts a Time off bar (schedule_entries kind off) on the Schedule.';
create index time_off_requests_days_idx on public.time_off_requests (first_day, last_day);
create index time_off_requests_pending_idx on public.time_off_requests (created_at) where status = 'pending';

create table public.week_email_log (
  user_id    uuid not null references public.team_members (user_id) on delete cascade,
  week_start date not null,
  sent_at    timestamptz not null default now(),
  request_id bigint,
  primary key (user_id, week_start)
);
comment on table public.week_email_log is 'Who got the weekly schedule email for which week (the automatic send goes once per person per week).';

alter table public.staff_settings
  add column crew_confirm_on boolean not null default true,
  add column week_email_auto boolean not null default false,
  add column week_email_dow  smallint not null default 5 check (week_email_dow between 0 and 6),
  add column week_email_hour smallint not null default 15 check (week_email_hour between 6 and 20);
comment on column public.staff_settings.crew_confirm_on is 'Ask people put on a job to confirm it (email + push).';
comment on column public.staff_settings.week_email_auto is 'Email everyone next week''s schedule on week_email_dow (0 = Sunday) at week_email_hour (Eastern).';

alter table public.crew_roles        enable row level security;
alter table public.team_member_roles enable row level security;
alter table public.crew_asks         enable row level security;
alter table public.booking_crew      enable row level security;
alter table public.time_off_requests enable row level security;
alter table public.week_email_log    enable row level security;
revoke all on public.crew_roles, public.team_member_roles, public.crew_asks, public.booking_crew, public.time_off_requests, public.week_email_log from anon, authenticated;

insert into public.push_topics (key, label, description, module, sort) values
  ('crew_ask',        'Job to confirm',        'You were put on a job. Confirm it or say you can''t make it.', 'scheduling', 72),
  ('crew_declined',   'Crew can''t make it',   'Someone on a job said they can''t make it.', 'scheduling', 73),
  ('week_schedule',   'Your week',             'Your schedule for next week is in your email.', 'scheduling', 74),
  ('timeoff_request', 'Time off to approve',   'Someone asked for time off.', 'timeoff', 75),
  ('timeoff_decided', 'Your time off',         'Your time off was approved or declined.', 'timeoff', 76)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- internal helpers
-- Does this person want this kind of push (and have a device)?
create function public.crew_wants_push(p_uid uuid, p_topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.push_subscriptions s where s.user_id = p_uid)
     and coalesce((select p.enabled from public.push_prefs p where p.user_id = p_uid and p.topic = p_topic),
                  (select t.default_on from public.push_topics t where t.key = p_topic), true)
$$;

create function public.crew_send_email(p_to text, p_subject text, p_text text, p_html text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_key text; v_req bigint;
begin
  if coalesce(p_to, '') = '' then return null; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_key is null then return null; end if;
  select net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('from', '207 Admin <alerts@207photo.com>', 'to', jsonb_build_array(p_to),
                               'subject', p_subject, 'text', p_text, 'html', p_html),
    timeout_milliseconds := 25000) into v_req;
  return v_req;
end $$;

-- A person's job bars on a booking that haven't ended, with their role.
create function public.crew_days(p_booking uuid, p_user uuid)
returns table (entry_id uuid, starts_at timestamptz, ends_at timestamptz, drive_before_min int, role text, note text)
language sql stable security definer set search_path = '' as $$
  select e.id, e.starts_at, e.ends_at, e.drive_before_min, r.label, e.note
    from public.schedule_entries e left join public.crew_roles r on r.id = e.role_id
   where e.booking_id = p_booking and e.user_id = p_user and e.kind = 'job' and e.ends_at > now()
   order by e.starts_at
$$;

-- "Sat Oct 25, 9:00am-12:00pm (Lead), leave the studio 8:15am"
create function public.crew_day_line(p_start timestamptz, p_end timestamptz, p_drive int, p_role text) returns text
language sql stable set search_path = '' as $$
  select to_char(p_start at time zone 'America/New_York', 'FMDy FMMon FMDD, FMHH12:MIam') || '-' || to_char(p_end at time zone 'America/New_York', 'FMHH12:MIam') ||
         case when coalesce(p_role, '') <> '' then ' (' || p_role || ')' else '' end ||
         case when coalesce(p_drive, 0) > 0 then ', leave the studio ' || to_char((p_start - make_interval(mins => p_drive)) at time zone 'America/New_York', 'FMHH12:MIam') else '' end
$$;

create function public.crew_button(p_href text, p_label text, p_bg text) returns text
language sql immutable set search_path = '' as $$
  select '<a href="' || p_href || '" style="display:inline-block;padding:11px 20px;margin:0 8px 8px 0;border-radius:6px;background:' || p_bg ||
         ';color:#fff;text-decoration:none;font-weight:600;font-size:15px">' || public.html_esc(p_label) || '</a>'
$$;

-- ---------------------------------------------------------------- asks follow the schedule
-- Make sure a person on a booked job has an ask. p_changed: a bar was added or its time moved, so someone
-- who already answered (or was already asked) is asked again; declined people put back on are asked again.
create function public.crew_ask_ensure(p_booking uuid, p_user uuid, p_changed boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.bookings b where b.id = p_booking and b.status = 'booked') then return; end if;
  insert into public.crew_asks (booking_id, user_id) values (p_booking, p_user)
  on conflict (booking_id, user_id) do update
     set status = 'pending', reason = '', answered_at = null, asked_at = null, reminded_at = null, queued_at = now(),
         changed = public.crew_asks.status <> 'declined'
   where public.crew_asks.status = 'declined' or (p_changed and public.crew_asks.asked_at is not null);
end $$;

-- Nobody's bar left on the job: the ask goes (a "can't make it" stays, so the Schedule can say who declined).
create function public.crew_ask_cleanup(p_booking uuid, p_user uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.crew_asks a
   where a.booking_id = p_booking and a.user_id = p_user and a.status <> 'declined'
     and not exists (select 1 from public.schedule_entries e where e.booking_id = p_booking and e.user_id = p_user and e.kind = 'job')
$$;

create function public.crew_entries_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if tg_op <> 'INSERT' and old.kind = 'job' and (tg_op = 'DELETE' or new.kind <> 'job' or old.booking_id is distinct from new.booking_id or old.user_id is distinct from new.user_id) then
      perform public.crew_ask_cleanup(old.booking_id, old.user_id);
    end if;
    if tg_op = 'INSERT' and new.kind = 'job' then
      perform public.crew_ask_ensure(new.booking_id, new.user_id, true);
    elsif tg_op = 'UPDATE' and new.kind = 'job' and (old.kind <> 'job' or old.booking_id is distinct from new.booking_id or old.user_id is distinct from new.user_id
                                                    or old.starts_at is distinct from new.starts_at or old.ends_at is distinct from new.ends_at) then
      perform public.crew_ask_ensure(new.booking_id, new.user_id, true);
    end if;
  exception when others then raise warning 'crew_entries_changed: %', sqlerrm;  -- never block a schedule change
  end;
  return null;
end $$;
create trigger crew_entries_changed after insert or update or delete on public.schedule_entries
  for each row execute function public.crew_entries_changed();

-- ---------------------------------------------------------------- the ask: email + push
create function public.crew_ask_content(p_ask uuid, p_reminder boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.crew_asks; v_title text; v_loc text; v_name text; v_lines text[] := '{}'; v_html text[] := '{}'; v_notes text[] := '{}';
  v_link text; v_subject text; v_first timestamptz; r record;
begin
  select * into a from public.crew_asks where id = p_ask;
  if a.id is null then return null; end if;
  v_title := public.schedule_booking_title(a.booking_id);
  v_loc := coalesce(public.schedule_destination(a.booking_id), '');
  v_name := split_part(public.staff_name(a.user_id), ' ', 1);
  for r in select * from public.crew_days(a.booking_id, a.user_id) loop
    v_first := coalesce(v_first, r.starts_at);
    v_lines := v_lines || ('- ' || public.crew_day_line(r.starts_at, r.ends_at, r.drive_before_min, r.role));
    v_html := v_html || ('<li style="margin:4px 0">' || public.html_esc(public.crew_day_line(r.starts_at, r.ends_at, r.drive_before_min, r.role)) || '</li>');
    if coalesce(r.note, '') <> '' and not r.note = any (v_notes) then v_notes := v_notes || r.note; end if;
  end loop;
  if v_first is null then return null; end if;
  v_link := 'https://admin.207photo.com/#crew/' || a.token;
  v_subject := case when p_reminder then 'Reminder: please confirm ' when a.changed then 'Time changed: please confirm ' else 'Please confirm: ' end ||
               v_title || ', ' || to_char(v_first at time zone 'America/New_York', 'FMDy FMMon FMDD');
  return jsonb_build_object(
    'subject', v_subject,
    'push_title', case when p_reminder then 'Still need your answer' when a.changed then 'A job''s time changed' else 'New job for you' end,
    'push_body', v_title || ', ' || to_char(v_first at time zone 'America/New_York', 'FMDy FMMon FMDD FMHH12:MIam') || '. Confirm or say you can''t make it.',
    'link', v_link,
    'text', 'Hi ' || v_name || E',\n\n' ||
            case when a.changed then E'The time changed on a job you are on. Please confirm you can still make it.\n\n' else E'You are on the schedule for this job. Please confirm you can make it.\n\n' end ||
            v_title || E'\n' || array_to_string(v_lines, E'\n') || case when v_loc <> '' then E'\nWhere: ' || v_loc else '' end ||
            case when cardinality(v_notes) > 0 then E'\nNote: ' || array_to_string(v_notes, ' / ') else '' end || E'\n\n' ||
            'Confirm: ' || v_link || E'/yes\n' || 'Can''t make it: ' || v_link || E'/no\n',
    'html', '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1e1b;max-width:560px">' ||
            '<p>Hi ' || public.html_esc(v_name) || ',</p>' ||
            '<p>' || case when a.changed then 'The time changed on a job you are on. Please confirm you can still make it.' else 'You are on the schedule for this job. Please confirm you can make it.' end || '</p>' ||
            '<p style="margin:14px 0 4px;font-size:16px"><b>' || public.html_esc(v_title) || '</b></p><ul style="margin:0 0 6px;padding-left:20px">' || array_to_string(v_html, '') || '</ul>' ||
            case when v_loc <> '' then '<p style="margin:4px 0">Where: <a href="https://www.google.com/maps/search/?api=1&amp;query=' || public.html_esc(replace(v_loc, ' ', '+')) || '" style="color:#1f1e1b">' || public.html_esc(v_loc) || '</a></p>' else '' end ||
            case when cardinality(v_notes) > 0 then '<p style="margin:4px 0;color:#6b675f">' || public.html_esc(array_to_string(v_notes, ' / ')) || '</p>' else '' end ||
            '<p style="margin:18px 0 6px">' || public.crew_button(v_link || '/yes', 'Confirm', '#2e7d4f') || public.crew_button(v_link || '/no', 'Can''t make it', '#8a8580') || '</p>' ||
            '<p style="margin-top:18px;font-size:13px;color:#6b675f">No sign-in needed. From <a href="https://admin.207photo.com/" style="color:#6b675f">207 Admin</a>.</p></div>');
end $$;

-- Send one ask (or its reminder) now. Returns true if anything went out.
create function public.crew_ask_deliver(p_ask uuid, p_reminder boolean default false) returns boolean
language plpgsql security definer set search_path = '' as $$
declare a public.crew_asks; v jsonb; v_email text; v_req bigint; v_push boolean := false;
begin
  select * into a from public.crew_asks where id = p_ask for update;
  if a.id is null or a.status <> 'pending' then return false; end if;
  if not exists (select 1 from public.bookings b where b.id = a.booking_id and b.status = 'booked') then return false; end if;
  v := public.crew_ask_content(p_ask, p_reminder);
  if v is null then return false; end if;
  select u.email into v_email from auth.users u join public.team_members m on m.user_id = u.id where u.id = a.user_id and m.active;
  if not found then return false; end if;
  v_req := public.crew_send_email(v_email, v ->> 'subject', v ->> 'text', v ->> 'html');
  if public.crew_wants_push(a.user_id, 'crew_ask') then
    perform public.push_notify('crew_ask', v ->> 'push_title', v ->> 'push_body', '/#crew/' || a.token, 'crew_ask_' || a.id, a.user_id);
    v_push := true;
  end if;
  if p_reminder then update public.crew_asks set reminded_at = now() where id = a.id;
  else update public.crew_asks set asked_at = now() where id = a.id; end if;
  return v_req is not null or v_push;
end $$;

-- Cron, every 5 minutes, 7am-9pm Eastern: new asks (2 minutes after the last change, so a job's days go out
-- together), and one reminder for anything still pending after 2 days with the job less than a week away.
create function public.crew_send_due() returns int
language plpgsql security definer set search_path = '' as $$
declare v_h int := extract(hour from now() at time zone 'America/New_York'); v_n int := 0; r record;
begin
  if not coalesce((select crew_confirm_on from public.staff_settings where id), true) or v_h < 7 or v_h >= 21 then return 0; end if;
  for r in select a.id from public.crew_asks a join public.bookings b on b.id = a.booking_id and b.status = 'booked'
            where a.status = 'pending' and a.asked_at is null and a.queued_at < now() - interval '2 minutes'
            order by a.queued_at limit 100 loop
    if public.crew_ask_deliver(r.id, false) then v_n := v_n + 1; end if;
  end loop;
  for r in select a.id from public.crew_asks a join public.bookings b on b.id = a.booking_id and b.status = 'booked'
            where a.status = 'pending' and a.asked_at < now() - interval '48 hours' and a.reminded_at is null
              and exists (select 1 from public.schedule_entries e where e.booking_id = a.booking_id and e.user_id = a.user_id and e.kind = 'job'
                             and e.starts_at > now() and e.starts_at < now() + interval '7 days')
            limit 100 loop
    if public.crew_ask_deliver(r.id, true) then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;
select cron.schedule('crew-send-due', '*/5 * * * *', 'select public.crew_send_due()');
select cron.schedule('crew-asks-retention', '58 4 * * *',
  $$delete from public.crew_asks a where not exists (select 1 from public.schedule_entries e where e.booking_id = a.booking_id and e.user_id = a.user_id and e.ends_at > now() - interval '60 days') and a.created_at < now() - interval '60 days'$$);

-- ---------------------------------------------------------------- the public page (no sign-in, by token)
create function public.crew_public(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.crew_asks; b public.bookings;
begin
  if length(coalesce(p_token, '')) < 32 then return null; end if;
  select * into a from public.crew_asks where token = p_token;
  if a.id is null then return null; end if;
  select * into b from public.bookings where id = a.booking_id;
  return jsonb_build_object(
    'name', split_part(public.staff_name(a.user_id), ' ', 1),
    'title', public.schedule_booking_title(a.booking_id),
    'type_label', (select t.label from public.booking_types t where t.key = b.type_key),
    'location', coalesce(public.schedule_destination(a.booking_id), ''),
    'status', a.status, 'reason', a.reason, 'answered_at', a.answered_at, 'changed', a.changed,
    'cancelled', b.status <> 'booked',
    'days', (select coalesce(jsonb_agg(jsonb_build_object('starts_at', d.starts_at, 'ends_at', d.ends_at, 'drive_before_min', d.drive_before_min, 'role', d.role, 'note', d.note)
                                       order by d.starts_at), '[]'::jsonb) from public.crew_days(a.booking_id, a.user_id) d),
    'crew', (select coalesce(jsonb_agg(distinct jsonb_build_object('name', public.staff_name(e.user_id), 'role', r.label)), '[]'::jsonb)
               from public.schedule_entries e left join public.crew_roles r on r.id = e.role_id
              where e.booking_id = a.booking_id and e.kind = 'job' and e.user_id <> a.user_id and e.ends_at > now()));
end $$;

-- p_answer: 'confirm' or 'decline'. Declining takes their upcoming bars for this job off the schedule.
create function public.crew_answer(p_token text, p_answer text, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.crew_asks; v_reason text := left(btrim(coalesce(p_reason, '')), 300); v_first timestamptz; v_who text;
begin
  if p_answer not in ('confirm', 'decline') then raise exception 'Pick Confirm or Can''t make it.'; end if;
  if length(coalesce(p_token, '')) < 32 then raise exception 'This link is not valid.'; end if;
  select * into a from public.crew_asks where token = p_token for update;
  if a.id is null then raise exception 'This link is not valid. You may have been taken off this job.'; end if;
  if not exists (select 1 from public.bookings b where b.id = a.booking_id and b.status = 'booked') then raise exception 'This job was cancelled.'; end if;
  if a.status = 'declined' then raise exception 'You already said you can''t make it. If that changed, contact 207 Photo.'; end if;
  select min(starts_at) into v_first from public.crew_days(a.booking_id, a.user_id);
  if v_first is null then raise exception 'This job has already happened.'; end if;
  if p_answer = 'confirm' then
    update public.crew_asks set status = 'confirmed', reason = '', answered_at = now() where id = a.id;
    return jsonb_build_object('ok', true, 'status', 'confirmed');
  end if;
  update public.crew_asks set status = 'declined', reason = v_reason, answered_at = now() where id = a.id;
  delete from public.schedule_entries where booking_id = a.booking_id and user_id = a.user_id and kind = 'job' and ends_at > now();
  v_who := public.staff_name(a.user_id);
  begin
    perform public.push_notify('crew_declined', v_who || ' can''t make it',
      public.schedule_booking_title(a.booking_id) || ', ' || to_char(v_first at time zone 'America/New_York', 'FMDy FMMon FMDD') ||
      case when v_reason <> '' then ': ' || v_reason else '. The job is back under Jobs not assigned.' end,
      '/#staff/schedule', 'crew_declined_' || a.id);
  exception when others then raise warning 'crew_declined push: %', sqlerrm;
  end;
  return jsonb_build_object('ok', true, 'status', 'declined');
end $$;

-- ---------------------------------------------------------------- roles (Team page + Schedule)
create function public.crew_roles_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.can('scheduling', 'view') or public.is_admin()) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'can_edit', public.can('scheduling', 'edit'),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'label', r.label, 'sort', r.sort) order by r.sort, lower(r.label)), '[]'::jsonb)
                from public.crew_roles r where r.archived_at is null),
    'members', (select coalesce(jsonb_object_agg(x.user_id, x.roles), '{}'::jsonb)
                  from (select tr.user_id, jsonb_agg(tr.role_id) as roles from public.team_member_roles tr
                          join public.crew_roles r on r.id = tr.role_id and r.archived_at is null group by tr.user_id) x));
end $$;

-- p = {id?, label, sort?}
create function public.crew_role_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid; v_label text := btrim(coalesce(p ->> 'label', '')); v_sort int := coalesce(nullif(p ->> 'sort', '')::int, 100);
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if length(v_label) not between 1 and 40 then raise exception 'Give the role a name (up to 40 letters).'; end if;
  if exists (select 1 from public.crew_roles where lower(btrim(label)) = lower(v_label) and archived_at is null and id is distinct from v_id) then
    raise exception 'There is already a role called %.', v_label;
  end if;
  if v_id is null then
    insert into public.crew_roles (label, sort) values (v_label, v_sort) returning id into v_id;
  else
    update public.crew_roles set label = v_label, sort = v_sort where id = v_id and archived_at is null;
    if not found then raise exception 'That role was removed.'; end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function public.crew_role_archive(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.crew_roles set archived_at = now() where id = p_id and archived_at is null;
  return jsonb_build_object('ok', found);
end $$;

-- Team page: the roles a person can fill.
create function public.team_set_roles(p_user_id uuid, p_roles uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_before uuid[]; v_after uuid[];
begin
  if not (public.is_admin() or public.can('scheduling', 'edit')) then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.team_members where user_id = p_user_id) then raise exception 'no such team member'; end if;
  select coalesce(array_agg(role_id order by role_id), '{}') into v_before from public.team_member_roles where user_id = p_user_id;
  select coalesce(array_agg(distinct r.id order by r.id), '{}') into v_after from public.crew_roles r where r.id = any (coalesce(p_roles, '{}')) and r.archived_at is null;
  if v_before is distinct from v_after then
    delete from public.team_member_roles where user_id = p_user_id and not role_id = any (v_after);
    insert into public.team_member_roles (user_id, role_id) select p_user_id, x from unnest(v_after) x on conflict do nothing;
    insert into public.team_audit (actor, target, action, detail)
    values ((select auth.uid()), p_user_id, 'roles_set', jsonb_build_object('roles', (select coalesce(jsonb_agg(label order by sort), '[]'::jsonb) from public.crew_roles where id = any (v_after))));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- Schedule: asks, needs, settings
-- Everything extra the Schedule draws for one week (folded into schedule_week as 'crew').
create function public.crew_week_extra(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'label', r.label) order by r.sort, lower(r.label)), '[]'::jsonb) from public.crew_roles r where r.archived_at is null),
    'needed', (select coalesce(jsonb_object_agg(c.booking_id, c.needed), '{}'::jsonb) from public.booking_crew c
                where c.booking_id in (select x.booking_id from public.schedule_booking_days(p_from, p_to) x)),
    'declined', (select coalesce(jsonb_agg(jsonb_build_object('booking_id', a.booking_id, 'user_id', a.user_id, 'name', public.staff_name(a.user_id), 'reason', a.reason, 'answered_at', a.answered_at)
                                           order by a.answered_at), '[]'::jsonb)
                   from public.crew_asks a where a.status = 'declined'
                    and a.booking_id in (select x.booking_id from public.schedule_booking_days(p_from, p_to) x)
                    and not exists (select 1 from public.schedule_entries e where e.booking_id = a.booking_id and e.user_id = a.user_id and e.kind = 'job')),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'user_id', t.user_id, 'first_day', t.first_day, 'last_day', t.last_day,
                                                              'start_time', t.start_time, 'end_time', t.end_time, 'note', t.note) order by t.first_day), '[]'::jsonb)
                   from public.time_off_requests t join public.team_members m on m.user_id = t.user_id and m.active
                  where t.status = 'pending' and t.first_day < p_to and t.last_day >= p_from),
    'settings', (select jsonb_build_object('crew_confirm_on', s.crew_confirm_on, 'week_email_auto', s.week_email_auto, 'week_email_dow', s.week_email_dow, 'week_email_hour', s.week_email_hour)
                   from public.staff_settings s where s.id))
$$;

create function public.crew_needed_set(p_booking uuid, p_needed int) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_needed is null or p_needed not between 1 and 20 then raise exception 'People needed is 1 to 20.'; end if;
  if not exists (select 1 from public.bookings where id = p_booking) then raise exception 'Pick the job.'; end if;
  insert into public.booking_crew (booking_id, needed) values (p_booking, p_needed)
  on conflict (booking_id) do update set needed = excluded.needed, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- "Ask to confirm" / "Ask again": send now (bars from before asks existed have none yet).
create function public.crew_ask_now(p_booking uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.bookings where id = p_booking and status = 'booked') then raise exception 'Only booked jobs ask the crew to confirm.'; end if;
  if not exists (select 1 from public.crew_days(p_booking, p_user)) then raise exception 'They are not on this job anymore.'; end if;
  insert into public.crew_asks (booking_id, user_id) values (p_booking, p_user)
  on conflict (booking_id, user_id) do update set queued_at = now() returning id into v_id;
  update public.crew_asks set status = 'pending', reason = '', answered_at = null, changed = false where id = v_id;
  if not public.crew_ask_deliver(v_id, (select asked_at is not null from public.crew_asks where id = v_id)) then
    raise exception 'Nothing was sent: they have no email address or device to send to.';
  end if;
  return jsonb_build_object('ok', true);
end $$;

create function public.crew_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_dow int := coalesce(nullif(p ->> 'week_email_dow', '')::int, 5); v_hour int := coalesce(nullif(p ->> 'week_email_hour', '')::int, 15);
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_dow not between 0 and 6 then raise exception 'Pick a day of the week.'; end if;
  if v_hour not between 6 and 20 then raise exception 'Pick an hour between 6am and 8pm.'; end if;
  update public.staff_settings
     set crew_confirm_on = coalesce((p ->> 'crew_confirm_on')::boolean, crew_confirm_on),
         week_email_auto = coalesce((p ->> 'week_email_auto')::boolean, week_email_auto),
         week_email_dow = v_dow, week_email_hour = v_hour, updated_at = now()
   where id;
  return jsonb_build_object('ok', true);
end $$;

-- One job's crew, for the job page: everyone on it with role, days and answer, plus who said no.
create function public.crew_for_booking(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'can_edit', public.can('scheduling', 'edit'),
    'booking_status', (select status from public.bookings where id = p_booking),
    'needed', coalesce((select needed from public.booking_crew where booking_id = p_booking), 1),
    'crew', (select coalesce(jsonb_agg(x order by x ->> 'name'), '[]'::jsonb) from (
               select jsonb_build_object('user_id', e.user_id, 'name', public.staff_name(e.user_id),
                        'roles', (select coalesce(jsonb_agg(distinct r.label), '[]'::jsonb) from public.schedule_entries e2 join public.crew_roles r on r.id = e2.role_id
                                   where e2.booking_id = p_booking and e2.user_id = e.user_id and e2.kind = 'job'),
                        'days', jsonb_agg(jsonb_build_object('id', e.id, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'drive_before_min', e.drive_before_min) order by e.starts_at),
                        'status', (select a.status from public.crew_asks a where a.booking_id = p_booking and a.user_id = e.user_id),
                        'asked_at', (select a.asked_at from public.crew_asks a where a.booking_id = p_booking and a.user_id = e.user_id),
                        'answered_at', (select a.answered_at from public.crew_asks a where a.booking_id = p_booking and a.user_id = e.user_id)) as x
                 from public.schedule_entries e where e.booking_id = p_booking and e.kind = 'job' group by e.user_id) q),
    'declined', (select coalesce(jsonb_agg(jsonb_build_object('user_id', a.user_id, 'name', public.staff_name(a.user_id), 'reason', a.reason, 'answered_at', a.answered_at)), '[]'::jsonb)
                   from public.crew_asks a where a.booking_id = p_booking and a.status = 'declined'
                    and not exists (select 1 from public.schedule_entries e where e.booking_id = a.booking_id and e.user_id = a.user_id and e.kind = 'job')));
end $$;

-- For Today: people who haven't answered for jobs in the next 7 days; their own jobs to confirm.
create function public.crew_attention() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid());
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'waiting', case when public.can('scheduling', 'view') then
                 (select count(*) from public.crew_asks a join public.bookings b on b.id = a.booking_id and b.status = 'booked'
                   where a.status = 'pending' and a.asked_at is not null
                     and exists (select 1 from public.schedule_entries e where e.booking_id = a.booking_id and e.user_id = a.user_id and e.kind = 'job'
                                   and e.starts_at > now() and e.starts_at < now() + interval '7 days')) end,
    'mine', (select count(*) from public.crew_asks a join public.bookings b on b.id = a.booking_id and b.status = 'booked'
              where a.user_id = v_me and a.status = 'pending' and exists (select 1 from public.crew_days(a.booking_id, a.user_id))),
    'timeoff', case when public.can('timeoff', 'edit') then (select count(*) from public.time_off_requests t join public.team_members m on m.user_id = t.user_id and m.active
                                                              where t.status = 'pending' and t.last_day >= (now() at time zone 'America/New_York')::date) end);
end $$;

-- ---------------------------------------------------------------- crew picker: who is free, roles, drive from home
-- p_booking (an existing job) or p_destination (Book a job, before it is saved); p_day = the day picked.
create function public.crew_dest(p_booking uuid, p_destination text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(coalesce(p_destination, '')), ''), case when p_booking is not null then public.schedule_destination(p_booking) end)
$$;

create function public.crew_options(p_booking uuid, p_day date, p_destination text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_dest text := lower(public.crew_dest(p_booking, p_destination)); v_studio text; v_from timestamptz; v_to timestamptz;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_day is null then p_day := (now() at time zone 'America/New_York')::date; end if;
  select lower(btrim(studio_address)) into v_studio from public.staff_settings where id;
  v_from := p_day::timestamp at time zone 'America/New_York';
  v_to := (p_day + 1)::timestamp at time zone 'America/New_York';
  return jsonb_build_object(
    'destination', v_dest,
    'studio_min', coalesce((select c.minutes from public.offer_drive_cache c where c.origin = v_studio and c.destination = v_dest),
                           (select c.minutes from public.drive_time_cache c where c.destination = v_dest and c.origin = v_studio)),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'label', r.label) order by r.sort, lower(r.label)), '[]'::jsonb) from public.crew_roles r where r.archived_at is null),
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
                  'user_id', m.user_id, 'name', public.staff_name(m.user_id),
                  'roles', (select coalesce(jsonb_agg(tr.role_id), '[]'::jsonb) from public.team_member_roles tr join public.crew_roles r on r.id = tr.role_id and r.archived_at is null where tr.user_id = m.user_id),
                  'has_home', btrim(m.home_address) <> '',
                  'home_min', (select c.minutes from public.offer_drive_cache c where c.origin = lower(btrim(m.home_address)) and c.destination = v_dest and btrim(m.home_address) <> ''),
                  'off', exists (select 1 from public.schedule_entries e where e.user_id = m.user_id and e.kind = 'off' and e.starts_at < v_to and e.ends_at > v_from),
                  'asked_off', exists (select 1 from public.time_off_requests t where t.user_id = m.user_id and t.status = 'pending' and p_day between t.first_day and t.last_day),
                  'busy', (select coalesce(jsonb_agg(jsonb_build_object('starts_at', e.starts_at, 'ends_at', e.ends_at, 'kind', e.kind,
                                     'title', case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) else nullif(e.title, '') end) order by e.starts_at), '[]'::jsonb)
                             from public.schedule_entries e where e.user_id = m.user_id and e.kind <> 'off' and e.kind <> 'flex'
                              and e.booking_id is distinct from p_booking and e.starts_at < v_to and e.ends_at > v_from),
                  'on_it', p_booking is not null and exists (select 1 from public.schedule_entries e where e.user_id = m.user_id and e.booking_id = p_booking and e.starts_at < v_to and e.ends_at > v_from),
                  'declined', p_booking is not null and exists (select 1 from public.crew_asks a where a.user_id = m.user_id and a.booking_id = p_booking and a.status = 'declined'))
                  order by lower(public.staff_name(m.user_id))), '[]'::jsonb)
                 from public.team_members m where m.active));
end $$;

-- Called by offer-drive (mode "crew") with the caller's token: the homes (and the studio) with no cached drive yet.
create function public.crew_drive_targets(p_booking uuid, p_destination text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_dest text := public.crew_dest(p_booking, p_destination);
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_dest is null then return jsonb_build_object('ok', false, 'error', 'This job has no address yet.'); end if;
  return jsonb_build_object('ok', true, 'destination', v_dest,
    'origins', (select coalesce(jsonb_agg(distinct o), '[]'::jsonb) from (
                  select btrim(m.home_address) as o from public.team_members m where m.active and btrim(m.home_address) <> ''
                  union select btrim(s.studio_address) from public.staff_settings s where s.id and btrim(s.studio_address) <> '') x
                 where not exists (select 1 from public.offer_drive_cache c where c.origin = lower(x.o) and c.destination = lower(v_dest) and c.fetched_at > now() - interval '180 days')));
end $$;

-- p_rows = [{origin, minutes, meters}], like offer_drive_store.
create function public.crew_drive_store(p_destination text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; n int := 0;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(btrim(p_destination), '') = '' then raise exception 'bad drive time'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    continue when coalesce(btrim(r ->> 'origin'), '') = '' or (r ->> 'minutes') is null or (r ->> 'minutes')::int not between 0 and 1440;
    insert into public.offer_drive_cache (origin, destination, minutes, meters)
    values (lower(btrim(r ->> 'origin')), lower(btrim(p_destination)), (r ->> 'minutes')::int, nullif(r ->> 'meters', '')::int)
    on conflict (origin, destination) do update set minutes = excluded.minutes, meters = excluded.meters, fetched_at = now();
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'stored', n);
end $$;

-- ---------------------------------------------------------------- capacity: the busiest days ahead
create function public.crew_capacity(p_from date default null, p_days int default 56) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_team int;
begin
  if not public.can('scheduling', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  p_from := coalesce(p_from, (now() at time zone 'America/New_York')::date);
  p_days := greatest(1, least(coalesce(p_days, 56), 120));
  select count(*) into v_team from public.team_members where active;
  return jsonb_build_object('team', v_team, 'days', (select coalesce(jsonb_agg(d order by d ->> 'day'), '[]'::jsonb) from (
    select jsonb_build_object('day', g.day, 'jobs', count(distinct x.booking_id),
             'needed', coalesce(sum(coalesce(c.needed, 1)), 0),
             'on_jobs', (select count(distinct e.user_id) from public.schedule_entries e where e.kind = 'job'
                           and e.starts_at < (g.day + 1)::timestamp at time zone 'America/New_York' and e.ends_at > g.day::timestamp at time zone 'America/New_York'),
             'off', (select count(distinct e.user_id) from public.schedule_entries e join public.team_members m on m.user_id = e.user_id and m.active where e.kind = 'off'
                       and e.starts_at < (g.day + 1)::timestamp at time zone 'America/New_York' and e.ends_at > g.day::timestamp at time zone 'America/New_York'),
             'asked_off', (select count(distinct t.user_id) from public.time_off_requests t where t.status = 'pending' and g.day between t.first_day and t.last_day)) as d
      from (select generate_series(p_from::timestamp, (p_from + p_days - 1)::timestamp, interval '1 day')::date as day) g
      join public.schedule_booking_days(p_from, p_from + p_days) x on x.day = g.day and x.status = 'booked'
      left join public.booking_crew c on c.booking_id = x.booking_id
     group by g.day) q));
end $$;

-- ---------------------------------------------------------------- weekly schedule email
-- {subject, text, html} for one person's week from p_start (a Sunday), or null when nothing is on it.
create function public.week_email_content(p_uid uuid, p_start date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := p_start::timestamp at time zone 'America/New_York';
  v_to timestamptz := (p_start + 7)::timestamp at time zone 'America/New_York';
  fmt constant text := 'FMHH12:MIam';
  v_txt text[] := '{}'; v_htm text[] := '{}'; v_day date; v_line text; v_sub text; v_btn text;
  v_min numeric := 0; v_jobs int := 0; v_pending int := 0; v_name text; r record;
begin
  for r in select e.*, case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) end as btitle,
                  case when e.booking_id is not null then public.schedule_destination(e.booking_id) end as bloc,
                  ro.label as role, a.status as ask, a.token
             from public.schedule_entries e
             left join public.bookings b on b.id = e.booking_id
             left join public.crew_roles ro on ro.id = e.role_id
             left join public.crew_asks a on a.booking_id = e.booking_id and a.user_id = e.user_id
            where e.user_id = p_uid and e.starts_at < v_to and e.ends_at > v_from and coalesce(b.status, 'booked') = 'booked'
            order by e.starts_at loop
    v_day := greatest((r.starts_at at time zone 'America/New_York')::date, p_start);
    if r.kind = 'off' then
      v_line := 'Time off' || case when r.title <> '' then ': ' || r.title else '' end ||
                case when (r.ends_at - r.starts_at) > interval '1 day' then ' through ' || to_char(least((r.ends_at - interval '1 minute') at time zone 'America/New_York', (p_start + 6)::timestamp), 'FMDy FMMon FMDD') else '' end;
      v_sub := ''; v_btn := '';
    else
      v_line := to_char(r.starts_at at time zone 'America/New_York', fmt) || '-' || to_char(r.ends_at at time zone 'America/New_York', fmt) || ' ' ||
                case when r.kind = 'job' then coalesce(r.btitle, 'On site job') else coalesce(nullif(r.title, ''), case r.kind when 'studio' then 'Studio' when 'admin' then 'Admin' when 'flex' then 'Flex time' else 'Work' end) end ||
                case when r.role is not null then ' (' || r.role || ')' else '' end;
      v_sub := concat_ws(' · ', case when r.kind = 'job' then nullif(r.bloc, '') end,
                 case when r.kind = 'job' and r.drive_before_min > 0 then 'leave the studio ' || to_char((r.starts_at - make_interval(mins => r.drive_before_min)) at time zone 'America/New_York', fmt) end,
                 nullif(r.note, ''),
                 case r.ask when 'confirmed' then 'confirmed' when 'pending' then 'please confirm' end);
      v_min := v_min + extract(epoch from (r.ends_at - r.starts_at)) / 60 + case when r.kind = 'job' then r.drive_before_min + r.drive_after_min else 0 end;
      v_btn := '';
      if r.kind = 'job' then
        v_jobs := v_jobs + 1;
        if r.ask = 'pending' then
          v_pending := v_pending + 1;
          v_btn := '<br>' || public.crew_button('https://admin.207photo.com/#crew/' || r.token || '/yes', 'Confirm', '#2e7d4f') ||
                   public.crew_button('https://admin.207photo.com/#crew/' || r.token || '/no', 'Can''t make it', '#8a8580');
          v_sub := v_sub || E'\n  Confirm: https://admin.207photo.com/#crew/' || r.token;
        end if;
      end if;
    end if;
    v_txt := v_txt || (to_char(v_day, 'FMDy FMMon FMDD') || ': ' || v_line || case when v_sub <> '' then E'\n  ' || v_sub else '' end);
    v_htm := v_htm || ('<tr><td style="padding:8px 12px 8px 0;vertical-align:top;white-space:nowrap;color:#6b675f">' || to_char(v_day, 'FMDy FMMon FMDD') || '</td>' ||
                       '<td style="padding:8px 0;vertical-align:top"><b>' || public.html_esc(v_line) || '</b>' ||
                       case when v_sub <> '' then '<br><span style="color:#6b675f;font-size:13px">' || public.html_esc(split_part(v_sub, E'\n', 1)) || '</span>' else '' end || v_btn || '</td></tr>');
  end loop;
  if cardinality(v_txt) = 0 then return null; end if;
  v_name := split_part(public.staff_name(p_uid), ' ', 1);
  return jsonb_build_object(
    'jobs', v_jobs, 'pending', v_pending,
    'subject', 'Your schedule, week of ' || to_char(p_start, 'FMMon FMDD') || ': ' ||
               coalesce(nullif(concat_ws(', ', case when v_jobs = 1 then '1 job' when v_jobs > 1 then v_jobs || ' jobs' end,
                                              case when v_pending > 0 then v_pending || ' to confirm' end), ''), 'your time'),
    'text', 'Hi ' || v_name || E'. Here is your schedule for the week of ' || to_char(p_start, 'FMMonth FMDD') || E'.\n\n' || array_to_string(v_txt, E'\n') ||
            E'\n\n' || trim(to_char(round(v_min / 15) / 4, 'FM990.99'), '.') || E' hours scheduled.\n\nThe whole week: https://admin.207photo.com/#staff/schedule',
    'html', '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1e1b;max-width:600px">' ||
            '<p style="font-size:16px">Hi ' || public.html_esc(v_name) || '. Here is your schedule for the week of ' || to_char(p_start, 'FMMonth FMDD') || '.</p>' ||
            '<table style="border-collapse:collapse;font-size:14.5px">' || array_to_string(v_htm, '') || '</table>' ||
            '<p style="margin:12px 0 0;font-size:13px;color:#6b675f">' || trim(to_char(round(v_min / 15) / 4, 'FM990.99'), '.') || ' hours scheduled.</p>' ||
            '<p style="margin-top:22px;font-size:13px;color:#6b675f">From <a href="https://admin.207photo.com/" style="color:#6b675f">207 Admin</a>. Only your own schedule is in this email.</p></div>');
end $$;

-- Email (and push) each person their own week. p_users null = everyone with something on that week.
-- p_force = false skips people already sent that week (the automatic send).
create function public.week_email_deliver(p_start date, p_users uuid[], p_force boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_req bigint; v_sent int := 0; v_empty int := 0; v_noaddr int := 0; r record;
begin
  for r in select m.user_id, u.email from public.team_members m join auth.users u on u.id = m.user_id
            where m.active and (p_users is null or m.user_id = any (p_users))
              and (p_force or not exists (select 1 from public.week_email_log l where l.user_id = m.user_id and l.week_start = p_start)) loop
    v := public.week_email_content(r.user_id, p_start);
    if v is null then v_empty := v_empty + 1; continue; end if;
    v_req := public.crew_send_email(r.email, v ->> 'subject', v ->> 'text', v ->> 'html');
    if v_req is null then v_noaddr := v_noaddr + 1; end if;
    if public.crew_wants_push(r.user_id, 'week_schedule') then
      perform public.push_notify('week_schedule', 'Your week of ' || to_char(p_start, 'FMMon FMDD'),
        concat_ws(', ', case when (v ->> 'jobs')::int = 1 then '1 job' when (v ->> 'jobs')::int > 1 then (v ->> 'jobs') || ' jobs' end,
                        case when (v ->> 'pending')::int > 0 then (v ->> 'pending') || ' to confirm' end, 'details in your email'),
        '/#staff/crew', 'week_schedule_' || p_start, r.user_id);
    end if;
    insert into public.week_email_log (user_id, week_start, request_id) values (r.user_id, p_start, v_req)
    on conflict (user_id, week_start) do update set sent_at = now(), request_id = excluded.request_id;
    v_sent := v_sent + 1;
  end loop;
  return jsonb_build_object('ok', true, 'sent', v_sent, 'nothing_on', v_empty, 'no_email', v_noaddr);
end $$;

-- "Email the week" on the Schedule.
create function public.week_email_send(p_start date, p_users uuid[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_start is null or extract(dow from p_start) <> 0 then raise exception 'Pick a week (it starts on a Sunday).'; end if;
  return public.week_email_deliver(p_start, p_users, true);
end $$;

-- Who would get it, for the button's preview.
create function public.week_email_preview(p_start date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', public.staff_name(m.user_id), 'subject', v ->> 'subject',
                                                       'sent_at', (select l.sent_at from public.week_email_log l where l.user_id = m.user_id and l.week_start = p_start))
                                    order by lower(public.staff_name(m.user_id))), '[]'::jsonb)
            from public.team_members m cross join lateral (select public.week_email_content(m.user_id, p_start) as v) c
           where m.active and v is not null);
end $$;

-- Cron, hourly: on the set day and hour, next week's schedule to everyone (once each).
create function public.week_email_auto() returns int
language plpgsql security definer set search_path = '' as $$
declare s public.staff_settings; v_now timestamp := now() at time zone 'America/New_York'; v_start date;
begin
  select * into s from public.staff_settings where id;
  if not found or not s.week_email_auto or extract(dow from v_now) <> s.week_email_dow or extract(hour from v_now) <> s.week_email_hour then return 0; end if;
  v_start := v_now::date + (7 - extract(dow from v_now)::int);   -- the coming Sunday
  return (public.week_email_deliver(v_start, null, false) ->> 'sent')::int;
end $$;
select cron.schedule('week-email-auto', '2 * * * *', 'select public.week_email_auto()');
select cron.schedule('week-email-log-retention', '59 4 * * *', $$delete from public.week_email_log where week_start < current_date - 120$$);

-- ---------------------------------------------------------------- my jobs (signed in): what I'm on and what to confirm
create function public.crew_mine() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid());
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(x order by x ->> 'first'), '[]'::jsonb) from (
    select jsonb_build_object('booking_id', e.booking_id, 'title', public.schedule_booking_title(e.booking_id),
             'location', coalesce(public.schedule_destination(e.booking_id), ''), 'first', min(e.starts_at),
             'days', jsonb_agg(jsonb_build_object('starts_at', e.starts_at, 'ends_at', e.ends_at, 'drive_before_min', e.drive_before_min,
                                                  'role', (select r.label from public.crew_roles r where r.id = e.role_id), 'note', e.note) order by e.starts_at),
             'status', a.status, 'token', a.token) as x
      from public.schedule_entries e join public.bookings b on b.id = e.booking_id and b.status = 'booked'
      left join public.crew_asks a on a.booking_id = e.booking_id and a.user_id = e.user_id
     where e.user_id = v_me and e.kind = 'job' and e.ends_at > now() and e.starts_at < now() + interval '60 days'
     group by e.booking_id, a.status, a.token) q);
end $$;

-- ---------------------------------------------------------------- time off
create function public.time_off_json(t public.time_off_requests) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'user_id', t.user_id, 'name', public.staff_name(t.user_id), 'first_day', t.first_day, 'last_day', t.last_day,
    'start_time', to_char(t.start_time, 'HH24:MI'), 'end_time', to_char(t.end_time, 'HH24:MI'), 'note', t.note, 'status', t.status,
    'decided_by', public.staff_name(t.decided_by), 'decided_at', t.decided_at, 'decision_note', t.decision_note, 'created_at', t.created_at,
    -- jobs they are already on in that time (a manager needs to know before approving)
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('title', public.schedule_booking_title(e.booking_id), 'starts_at', e.starts_at) order by e.starts_at), '[]'::jsonb)
               from public.schedule_entries e
              where e.user_id = t.user_id and e.kind = 'job'
                and e.starts_at < (case when t.start_time is null then (t.last_day + 1)::timestamp else t.first_day + t.end_time end) at time zone 'America/New_York'
                and e.ends_at > (case when t.start_time is null then t.first_day::timestamp else t.first_day + t.start_time end) at time zone 'America/New_York'))
$$;

-- Mine, plus (View) the team's from 2 weeks ago on, plus (Edit) everything waiting.
create function public.time_off_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := (select auth.uid()); v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'me', v_me, 'can_view', public.can('timeoff', 'view'), 'can_edit', public.can('timeoff', 'edit'),
    'mine', (select coalesce(jsonb_agg(public.time_off_json(t) order by t.first_day desc), '[]'::jsonb) from public.time_off_requests t
              where t.user_id = v_me and (t.last_day >= v_today - 60 or t.status = 'pending')),
    'team', case when public.can('timeoff', 'view') then
              (select coalesce(jsonb_agg(public.time_off_json(t) order by t.status <> 'pending', t.first_day), '[]'::jsonb)
                 from public.time_off_requests t join public.team_members m on m.user_id = t.user_id and m.active
                where (t.status = 'pending' and t.last_day >= v_today) or (t.status in ('approved', 'declined') and t.last_day >= v_today - 14)) end);
end $$;

-- Ask for time off. p = {first_day, last_day?, start_time?, end_time?, note?}
create function public.time_off_request(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid()); v_a date := nullif(p ->> 'first_day', '')::date; v_z date := coalesce(nullif(p ->> 'last_day', '')::date, nullif(p ->> 'first_day', '')::date);
  v_s time := nullif(p ->> 'start_time', '')::time; v_e time := nullif(p ->> 'end_time', '')::time; v_id uuid; v_when text;
begin
  if not public.is_team_member() or not exists (select 1 from public.team_members where user_id = v_me and active) then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_a is null then raise exception 'Pick the first day.'; end if;
  if v_z < v_a then raise exception '"Through" has to be on or after the first day.'; end if;
  if v_z - v_a > 60 then raise exception 'That is more than two months. Ask for it in parts.'; end if;
  if v_a < (now() at time zone 'America/New_York')::date - 1 then raise exception 'That day has passed.'; end if;
  if (v_s is null) <> (v_e is null) then raise exception 'Enter both the start and the end time, or neither.'; end if;
  if v_s is not null and (v_z <> v_a or v_e <= v_s) then raise exception 'Hours off are for one day, with the end after the start.'; end if;
  if exists (select 1 from public.time_off_requests where user_id = v_me and status in ('pending', 'approved') and first_day <= v_z and last_day >= v_a and start_time is null and v_s is null) then
    raise exception 'You already asked for time off on those days.';
  end if;
  insert into public.time_off_requests (user_id, first_day, last_day, start_time, end_time, note)
  values (v_me, v_a, v_z, v_s, v_e, left(btrim(coalesce(p ->> 'note', '')), 500)) returning id into v_id;
  v_when := to_char(v_a, 'FMDy FMMon FMDD') || case when v_z > v_a then ' to ' || to_char(v_z, 'FMDy FMMon FMDD') else '' end ||
            case when v_s is not null then ', ' || to_char(v_s, 'FMHH12:MIam') || '-' || to_char(v_e, 'FMHH12:MIam') else '' end;
  begin
    perform public.push_notify('timeoff_request', public.staff_name(v_me) || ' asked for time off', v_when ||
      case when btrim(coalesce(p ->> 'note', '')) <> '' then ': ' || left(btrim(p ->> 'note'), 120) else '' end, '/#staff/timeoff', 'timeoff_request_' || v_id);
  exception when others then raise warning 'timeoff_request push: %', sqlerrm;
  end;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Your own: cancel a request (an approved one also comes off the schedule, if it hasn't started).
create function public.time_off_cancel(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.time_off_requests;
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into t from public.time_off_requests where id = p_id for update;
  if t.id is null or t.user_id <> (select auth.uid()) then raise exception 'not allowed' using errcode = '42501'; end if;
  if t.status not in ('pending', 'approved') then raise exception 'That request is already %.', t.status; end if;
  if t.status = 'approved' and t.first_day <= (now() at time zone 'America/New_York')::date then raise exception 'That time off has started. Ask a manager to change it on the Schedule.'; end if;
  if t.entry_id is not null then delete from public.schedule_entries where id = t.entry_id and kind = 'off'; end if;
  update public.time_off_requests set status = 'cancelled', entry_id = null where id = t.id;
  return jsonb_build_object('ok', true);
end $$;

-- Edit: approve (puts a Time off bar on the Schedule) or decline, with an optional note to them.
create function public.time_off_decide(p_id uuid, p_approve boolean, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.time_off_requests; v_entry uuid; v_email text; v_subj text; v_body text; v_when text; v_note text := left(btrim(coalesce(p_note, '')), 500);
begin
  if not public.can('timeoff', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into t from public.time_off_requests where id = p_id for update;
  if t.id is null then raise exception 'That request was removed.'; end if;
  if t.status <> 'pending' then raise exception 'That request is already %.', t.status; end if;
  if not exists (select 1 from public.team_members where user_id = t.user_id and active) then raise exception 'They are no longer on the team.'; end if;
  if coalesce(p_approve, false) then
    insert into public.schedule_entries (user_id, kind, starts_at, ends_at, title, note, created_by)
    values (t.user_id, 'off',
            (case when t.start_time is null then t.first_day::timestamp else t.first_day + t.start_time end) at time zone 'America/New_York',
            (case when t.start_time is null then (t.last_day + 1)::timestamp else t.first_day + t.end_time end) at time zone 'America/New_York',
            left(t.note, 120), 'Approved time off request', (select auth.uid()))
    returning id into v_entry;
  end if;
  update public.time_off_requests set status = case when coalesce(p_approve, false) then 'approved' else 'declined' end,
         decided_by = (select auth.uid()), decided_at = now(), decision_note = v_note, entry_id = v_entry
   where id = t.id;
  v_when := to_char(t.first_day, 'FMDy FMMon FMDD') || case when t.last_day > t.first_day then ' to ' || to_char(t.last_day, 'FMDy FMMon FMDD') else '' end ||
            case when t.start_time is not null then ', ' || to_char(t.start_time, 'FMHH12:MIam') || '-' || to_char(t.end_time, 'FMHH12:MIam') else '' end;
  v_subj := 'Time off ' || case when coalesce(p_approve, false) then 'approved' else 'declined' end || ': ' || v_when;
  v_body := 'Your time off for ' || v_when || case when coalesce(p_approve, false) then ' was approved. It is on the schedule.' else ' was declined.' end ||
            case when v_note <> '' then ' ' || public.staff_name((select auth.uid())) || ': ' || v_note else '' end;
  begin
    select u.email into v_email from auth.users u where u.id = t.user_id;
    perform public.crew_send_email(v_email, v_subj, v_body || E'\n\nhttps://admin.207photo.com/#staff/timeoff',
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1e1b;max-width:560px"><p>' || public.html_esc(v_body) ||
      '</p><p><a href="https://admin.207photo.com/#staff/timeoff" style="color:#1f1e1b">Your time off</a></p></div>');
    if public.crew_wants_push(t.user_id, 'timeoff_decided') then
      perform public.push_notify('timeoff_decided', v_subj, v_body, '/#staff/timeoff', 'timeoff_decided_' || t.id, t.user_id);
    end if;
  exception when others then raise warning 'time_off_decide notify: %', sqlerrm;
  end;
  return jsonb_build_object('ok', true, 'entry_id', v_entry,
    'jobs', jsonb_array_length(public.time_off_json((select x from public.time_off_requests x where x.id = t.id)) -> 'jobs'));
end $$;

-- ---------------------------------------------------------------- patch existing functions
create function pg_temp.patch_function(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

-- schedule_save: a job bar can carry a role (p.role_id; leaving it out keeps the bar's role).
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  'v_overlaps int;', 'v_overlaps int;
  v_role uuid := (select r.id from public.crew_roles r where r.id = nullif(p ->> ''role_id'', '''')::uuid);', 1);
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  'v_booking := null; v_db := 0; v_da := 0;', 'v_booking := null; v_db := 0; v_da := 0; v_role := null;', 1);
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  'gcal_event_id = case when p \? ''gcal_event_id'' then v_gcal else gcal_event_id end, updated_at = now\(\)',
  'gcal_event_id = case when p ? ''gcal_event_id'' then v_gcal else gcal_event_id end,
           role_id = case when p ? ''role_id'' or v_kind <> ''job'' then v_role else role_id end, updated_at = now()', 1);
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  'title, note, gcal_event_id, created_by\)', 'title, note, gcal_event_id, created_by, role_id)', 1);
select pg_temp.patch_function('public.schedule_save(jsonb)'::regprocedure,
  'left\(v_gcal, 300\), \(select auth\.uid\(\)\)\)', 'left(v_gcal, 300), (select auth.uid()), v_role)', 1);

-- schedule_week: each bar's role and answer, each person's roles, and the week's crew extras.
select pg_temp.patch_function('public.schedule_week(date, integer)'::regprocedure,
  '''gcal_event_id'', e\.gcal_event_id,',
  '''gcal_event_id'', e.gcal_event_id, ''role_id'', e.role_id, ''role'', (select r.label from public.crew_roles r where r.id = e.role_id),
                                  ''confirm'', (select jsonb_build_object(''status'', a.status, ''reason'', a.reason, ''asked_at'', a.asked_at, ''answered_at'', a.answered_at, ''changed'', a.changed)
                                                from public.crew_asks a where a.booking_id = e.booking_id and a.user_id = e.user_id),', 1);
select pg_temp.patch_function('public.schedule_week(date, integer)'::regprocedure,
  '''weekly_hours'', m\.weekly_hours\)',
  '''weekly_hours'', m.weekly_hours, ''roles'', (select coalesce(jsonb_agg(tr.role_id), ''[]''::jsonb) from public.team_member_roles tr join public.crew_roles r on r.id = tr.role_id and r.archived_at is null where tr.user_id = m.user_id))', 1);
select pg_temp.patch_function('public.schedule_week(date, integer)'::regprocedure,
  '''can_edit'', public\.can\(''scheduling'', ''edit''\),',
  '''can_edit'', public.can(''scheduling'', ''edit''),
    ''crew'', public.crew_week_extra(p_start, v_end),', 1);

-- my_day: the role and the answer on my job bars (with the link to answer).
select pg_temp.patch_function('public.my_day(date)'::regprocedure,
  '''booking_location'', b\.location, ''booking_status'', b\.status\) order by e\.starts_at',
  '''booking_location'', b.location, ''booking_status'', b.status, ''role'', (select r.label from public.crew_roles r where r.id = e.role_id),
                                  ''confirm'', (select jsonb_build_object(''status'', a.status, ''token'', a.token) from public.crew_asks a
                                                where a.booking_id = e.booking_id and a.user_id = e.user_id and b.status = ''booked'')) order by e.starts_at', 1);

-- ---------------------------------------------------------------- grants
do $$
declare f text;
begin
  -- internal
  foreach f in array array['public.crew_new_token()', 'public.crew_wants_push(uuid, text)', 'public.crew_send_email(text, text, text, text)',
                           'public.crew_days(uuid, uuid)', 'public.crew_day_line(timestamptz, timestamptz, int, text)', 'public.crew_button(text, text, text)',
                           'public.crew_ask_ensure(uuid, uuid, boolean)', 'public.crew_ask_cleanup(uuid, uuid)', 'public.crew_entries_changed()',
                           'public.crew_ask_content(uuid, boolean)', 'public.crew_ask_deliver(uuid, boolean)', 'public.crew_send_due()',
                           'public.crew_week_extra(date, date)', 'public.crew_dest(uuid, text)', 'public.week_email_content(uuid, date)',
                           'public.week_email_deliver(date, uuid[], boolean)', 'public.week_email_auto()', 'public.time_off_json(public.time_off_requests)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- the app (each checks access first)
  foreach f in array array['public.crew_roles_list()', 'public.crew_role_save(jsonb)', 'public.crew_role_archive(uuid)', 'public.team_set_roles(uuid, uuid[])',
                           'public.crew_needed_set(uuid, int)', 'public.crew_ask_now(uuid, uuid)', 'public.crew_settings_save(jsonb)', 'public.crew_for_booking(uuid)',
                           'public.crew_attention()', 'public.crew_options(uuid, date, text)', 'public.crew_drive_targets(uuid, text)', 'public.crew_drive_store(text, jsonb)',
                           'public.crew_capacity(date, int)', 'public.week_email_send(date, uuid[])', 'public.week_email_preview(date)', 'public.crew_mine()',
                           'public.time_off_list()', 'public.time_off_request(jsonb)', 'public.time_off_cancel(uuid)', 'public.time_off_decide(uuid, boolean, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- the public Confirm / Can't make it page
  foreach f in array array['public.crew_public(text)', 'public.crew_answer(text, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
