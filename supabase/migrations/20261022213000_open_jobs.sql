-- Open jobs for part-time photographers (2026-10-22).
--
-- Module 'openjobs' (page #staff/openjobs). Some people on the team are part-timers: they have a home address
-- and how far they will drive. When a job needs someone, a manager offers it from the Open jobs page:
--   1. pick a booked job; the offer-drive edge function asks Google Maps how long each part-timer's drive is
--      (home -> job) and caches it in offer_drive_cache
--   2. the page lists part-timers in range (and who is busy or off that day); the manager ticks who gets it,
--      how many people are needed, and an optional note and pay
--   3. each one gets a push ("Open job near you") and sees it on their Open jobs page: Take it / Pass
--   4. first come, first served: taking it puts them on the schedule for every day of the job that has a
--      time, with their own drive time. When every spot is taken the offer is filled and the rest see that.
--      Passing is recorded with an optional reason. The manager who posted it gets a push for each answer.
-- View = a part-timer: see and answer the offers sent to you. Edit = post offers, see every answer, set who
-- is a part-timer and where they live.
-- Only bookings with status 'booked' can be offered or taken (track-only and cancelled jobs never send).
-- Everything goes through the RPCs below; the new tables are not readable directly.

-- ---------------------------------------------------------------- module
insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('openjobs', 'Open jobs', 'Staff', 'Offer jobs to part-time photographers near them; they take it or pass from their phone. View = a part-timer who gets offers; Edit = post offers and see the answers.', 207, 'live', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- part-timers
alter table public.team_members
  add column part_time     boolean not null default false,
  add column home_address  text not null default '' check (length(home_address) <= 300),
  add column max_drive_min int not null default 60 check (max_drive_min between 5 and 300);
comment on column public.team_members.part_time is 'Gets Open jobs offers (part-time photographer).';
comment on column public.team_members.home_address is 'Where drive time to an offered job is measured from (Open jobs).';
comment on column public.team_members.max_drive_min is 'Longest drive (minutes, one way) this part-timer wants for an offered job.';

-- ---------------------------------------------------------------- tables
create table public.offer_drive_cache (
  origin      text not null,           -- lower-cased, trimmed home address
  destination text not null,           -- lower-cased, trimmed job address (schedule_destination)
  minutes     int not null check (minutes between 0 and 1440),
  meters      int,
  fetched_at  timestamptz not null default now(),
  primary key (origin, destination)
);
comment on table public.offer_drive_cache is 'Drive times from part-timers'' homes to jobs (Google Routes API, via offer-drive).';

create table public.job_offers (
  id         uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  spots      int not null default 1 check (spots between 1 and 10),
  note       text not null default '' check (length(note) <= 500),
  pay        text not null default '' check (length(pay) <= 80),
  status     text not null default 'open' check (status in ('open', 'filled', 'closed')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
comment on table public.job_offers is 'A job offered to part-timers. open -> filled (every spot taken) or closed (by a manager).';
create index job_offers_booking_idx on public.job_offers (booking_id);
create index job_offers_open_idx on public.job_offers (created_at) where status = 'open';

create table public.job_offer_recipients (
  offer_id    uuid not null references public.job_offers (id) on delete cascade,
  user_id     uuid not null references public.team_members (user_id) on delete cascade,
  drive_min   int,                       -- home -> job when it was offered (null = unknown)
  notified    boolean not null default false,  -- a push was queued (they have a device and the kind on)
  seen_at     timestamptz,
  answer      text check (answer in ('accepted', 'declined')),
  answered_at timestamptz,
  reason      text not null default '' check (length(reason) <= 300),
  primary key (offer_id, user_id)
);
comment on table public.job_offer_recipients is 'Who an open job was offered to, and what they answered.';
create index job_offer_recipients_user_idx on public.job_offer_recipients (user_id);

alter table public.offer_drive_cache    enable row level security;
alter table public.job_offers           enable row level security;
alter table public.job_offer_recipients enable row level security;
revoke all on public.offer_drive_cache, public.job_offers, public.job_offer_recipients from anon, authenticated;

insert into public.push_topics (key, label, description, module, sort) values
  ('job_offer',       'Open job near you',     'A job you can take or pass on.', 'openjobs', 80),
  ('job_offer_reply', 'Answers to open jobs',  'Someone took or passed on a job you offered.', 'openjobs', 81)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- internal helpers
-- Does this person want this kind of push (and have a device to get it on)?
create function public.openjobs_wants_push(p_uid uuid, p_topic text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.push_subscriptions s where s.user_id = p_uid)
     and coalesce((select p.enabled from public.push_prefs p where p.user_id = p_uid and p.topic = p_topic),
                  (select t.default_on from public.push_topics t where t.key = p_topic), false)
$$;

-- The days of a booking from today on, with times when set (cancelled / track-only left out by the caller).
create function public.openjobs_days(p_booking uuid)
returns table (day date, start_at timestamptz, end_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select x.day, x.start_at, x.end_at
    from public.schedule_booking_days((now() at time zone 'America/New_York')::date, (now() at time zone 'America/New_York')::date + 400) x
   where x.booking_id = p_booking
   order by x.day
$$;

-- One offer as the app shows it. p_uid set: that recipient's view (their drive, their answer).
create function public.openjobs_offer_json(p_offer uuid, p_uid uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'booking_id', o.booking_id, 'title', public.schedule_booking_title(o.booking_id),
    'type_label', t.label, 'location', coalesce(public.schedule_destination(o.booking_id), ''),
    'booking_status', b.status, 'spots', o.spots, 'note', o.note, 'pay', o.pay, 'status', o.status,
    'created_at', o.created_at, 'created_by', public.staff_name(o.created_by),
    'taken', (select count(*) from public.job_offer_recipients r where r.offer_id = o.id and r.answer = 'accepted'),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'start_at', d.start_at, 'end_at', d.end_at) order by d.day), '[]'::jsonb)
               from public.openjobs_days(o.booking_id) d),
    'mine', case when p_uid is not null then
              (select jsonb_build_object('drive_min', r.drive_min, 'answer', r.answer, 'answered_at', r.answered_at, 'reason', r.reason)
                 from public.job_offer_recipients r where r.offer_id = o.id and r.user_id = p_uid) end)
    from public.job_offers o
    join public.bookings b on b.id = o.booking_id
    left join public.booking_types t on t.key = b.type_key
   where o.id = p_offer
$$;

-- ---------------------------------------------------------------- part-timers (Edit)
create function public.openjobs_people()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'can_grant', public.is_admin(),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', public.staff_name(m.user_id),
                 'part_time', m.part_time, 'home_address', m.home_address, 'max_drive_min', m.max_drive_min,
                 'has_access', public.team_user_can(m.user_id, 'openjobs'),
                 'has_device', exists (select 1 from public.push_subscriptions s where s.user_id = m.user_id))
                 order by m.part_time desc, lower(public.staff_name(m.user_id))), '[]'::jsonb)
                 from public.team_members m where m.active));
end $$;

-- Mark someone a part-timer (or not), with their home address and longest drive. A full-access person doing
-- this also gives them Open jobs (view) if they had no access to it, so the offers reach them.
create function public.openjobs_person_save(p_user uuid, p_part_time boolean, p_home text, p_max_drive int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_granted boolean := false;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if length(coalesce(p_home, '')) > 300 then raise exception 'That address is too long.'; end if;
  if coalesce(p_max_drive, 60) not between 5 and 300 then raise exception 'Longest drive is 5 to 300 minutes.'; end if;
  update public.team_members
     set part_time = coalesce(p_part_time, false), home_address = btrim(coalesce(p_home, '')), max_drive_min = coalesce(p_max_drive, 60), updated_at = now()
   where user_id = p_user and active;
  if not found then raise exception 'Pick someone on the team.'; end if;
  if coalesce(p_part_time, false) and public.is_admin() and not public.team_user_can(p_user, 'openjobs') then
    insert into public.team_permissions (user_id, module_key, level) values (p_user, 'openjobs', 'view')
    on conflict (user_id, module_key) do nothing;
    insert into public.team_audit (actor, target, action, detail)
    values ((select auth.uid()), p_user, 'updated', jsonb_build_object('modules', jsonb_build_object('openjobs', 'view'), 'via', 'Open jobs: marked part-time'));
    v_granted := true;
  end if;
  return jsonb_build_object('ok', true, 'granted', v_granted);
end $$;

-- ---------------------------------------------------------------- drive times (offer-drive edge function, caller's token)
-- What to ask Google: the job's address and the part-timers' homes with no cached drive to it yet.
create function public.offer_drive_targets(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_dest text;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  v_dest := public.schedule_destination(p_booking);
  if v_dest is null then return jsonb_build_object('ok', false, 'error', 'This job has no address. Add a location on the booking.'); end if;
  return jsonb_build_object('ok', true, 'destination', v_dest,
    'origins', (select coalesce(jsonb_agg(distinct btrim(m.home_address)), '[]'::jsonb)
                  from public.team_members m
                 where m.active and m.part_time and btrim(m.home_address) <> ''
                   and not exists (select 1 from public.offer_drive_cache c
                                    where c.origin = lower(btrim(m.home_address)) and c.destination = lower(v_dest)
                                      and c.fetched_at > now() - interval '180 days')));
end $$;

-- p_rows = [{origin, minutes, meters}]
create function public.offer_drive_store(p_destination text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb; n int := 0;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
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

-- ---------------------------------------------------------------- posting offers (Edit)
-- Booked jobs from today on, for "Offer a job".
create function public.openjobs_upcoming()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('booking_id', x.booking_id, 'title', x.title, 'type_label', x.type_label,
            'first_day', x.first_day, 'days', x.days, 'location', x.location,
            'crew', (select count(distinct e.user_id) from public.schedule_entries e where e.booking_id = x.booking_id and e.kind = 'job'),
            'open_offers', (select count(*) from public.job_offers o where o.booking_id = x.booking_id and o.status = 'open'))
            order by x.first_day, x.title), '[]'::jsonb)
    from (select d.booking_id, min(d.title) as title, min(d.type_label) as type_label, min(d.day) as first_day, count(*) as days, min(d.location) as location
            from public.schedule_booking_days(v_today, v_today + 180) d
           where d.status = 'booked'
           group by d.booking_id) x);
end $$;

-- Every part-timer for one job: their drive (when known), whether that is within their range, and whether
-- they are already busy, off, on this job, or have it offered to them.
create function public.openjobs_candidates(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_dest text := lower(public.schedule_destination(p_booking));
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.bookings where id = p_booking and status = 'booked') then raise exception 'Only booked jobs can be offered.'; end if;
  return jsonb_build_object(
    'booking', jsonb_build_object('booking_id', p_booking, 'title', public.schedule_booking_title(p_booking), 'location', coalesce(public.schedule_destination(p_booking), ''),
                 'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'start_at', d.start_at, 'end_at', d.end_at) order by d.day), '[]'::jsonb) from public.openjobs_days(p_booking) d)),
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', m.user_id, 'name', public.staff_name(m.user_id), 'home_set', btrim(m.home_address) <> '',
        'max_drive_min', m.max_drive_min, 'drive_min', c.minutes, 'meters', c.meters,
        'in_range', c.minutes is not null and c.minutes <= m.max_drive_min,
        'has_access', public.team_user_can(m.user_id, 'openjobs'),
        'has_device', exists (select 1 from public.push_subscriptions s where s.user_id = m.user_id),
        'on_job', exists (select 1 from public.schedule_entries e where e.booking_id = p_booking and e.user_id = m.user_id),
        'offered', exists (select 1 from public.job_offer_recipients r join public.job_offers o on o.id = r.offer_id
                            where o.booking_id = p_booking and o.status = 'open' and r.user_id = m.user_id and r.answer is null),
        'busy', (select coalesce(jsonb_agg(distinct d.day), '[]'::jsonb)
                   from public.openjobs_days(p_booking) d
                   join public.schedule_entries e on e.user_id = m.user_id and e.booking_id is distinct from p_booking
                    and ((d.start_at is not null and e.starts_at - make_interval(mins => e.drive_before_min) < d.end_at and e.ends_at + make_interval(mins => e.drive_after_min) > d.start_at)
                      or (e.kind = 'off' and e.starts_at < (d.day + 1)::timestamp at time zone 'America/New_York' and e.ends_at > d.day::timestamp at time zone 'America/New_York'))))
        order by (c.minutes is not null and c.minutes <= m.max_drive_min) desc, c.minutes nulls last, lower(public.staff_name(m.user_id))), '[]'::jsonb)
      from public.team_members m
      left join public.offer_drive_cache c on c.origin = lower(btrim(m.home_address)) and c.destination = v_dest
     where m.active and m.part_time));
end $$;

-- p = {booking_id, spots, note, pay, user_ids: [uuid]}
create function public.openjobs_post(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_booking uuid := nullif(p ->> 'booking_id', '')::uuid;
  v_spots int := coalesce(nullif(p ->> 'spots', '')::int, 1);
  v_id uuid; v_dest text; v_title text; v_when text; v_uid uuid; v_min int; v_n int := 0; v_pushed int := 0; v_push boolean;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_booking is null or not exists (select 1 from public.bookings where id = v_booking and status = 'booked') then raise exception 'Only booked jobs can be offered.'; end if;
  if not exists (select 1 from public.openjobs_days(v_booking)) then raise exception 'This job has no days left to offer.'; end if;
  if v_spots not between 1 and 10 then raise exception 'People needed is 1 to 10.'; end if;
  if jsonb_typeof(p -> 'user_ids') is distinct from 'array' or jsonb_array_length(p -> 'user_ids') = 0 then raise exception 'Pick at least one part-timer.'; end if;

  insert into public.job_offers (booking_id, spots, note, pay, created_by)
  values (v_booking, v_spots, left(btrim(coalesce(p ->> 'note', '')), 500), left(btrim(coalesce(p ->> 'pay', '')), 80), (select auth.uid()))
  returning id into v_id;

  v_dest := lower(public.schedule_destination(v_booking));
  v_title := public.schedule_booking_title(v_booking);
  select to_char(f.day, 'Dy Mon FMDD') || coalesce(' ' || to_char(f.start_at at time zone 'America/New_York', 'FMHH12:MIam'), '')
         || case when n.c > 1 then ' (+' || (n.c - 1) || ' more day' || case when n.c > 2 then 's' else '' end || ')' else '' end
    into v_when
    from (select * from public.openjobs_days(v_booking) limit 1) f, (select count(*) as c from public.openjobs_days(v_booking)) n;

  for v_uid in select distinct (x)::uuid from jsonb_array_elements_text(p -> 'user_ids') x loop
    continue when not exists (select 1 from public.team_members m where m.user_id = v_uid and m.active)
               or not public.team_user_can(v_uid, 'openjobs');
    select c.minutes into v_min from public.team_members m
      join public.offer_drive_cache c on c.origin = lower(btrim(m.home_address)) and c.destination = v_dest
     where m.user_id = v_uid;
    v_push := public.openjobs_wants_push(v_uid, 'job_offer');
    insert into public.job_offer_recipients (offer_id, user_id, drive_min, notified) values (v_id, v_uid, v_min, v_push);
    v_n := v_n + 1;
    if v_push then
      begin
        perform public.push_notify('job_offer', 'Open job: ' || v_title,
          v_when || coalesce(', ' || v_min || ' min drive', '') || case when btrim(coalesce(p ->> 'pay', '')) <> '' then '. ' || btrim(p ->> 'pay') else '' end || '. Tap to take it or pass.',
          '/#staff/openjobs', 'job_offer_' || v_id, v_uid);
        v_pushed := v_pushed + 1;
      exception when others then raise warning 'openjobs_post push: %', sqlerrm;
      end;
    end if;
  end loop;
  if v_n = 0 then raise exception 'None of those people can get Open jobs. Mark them part-time first.'; end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'sent', v_n, 'pushed', v_pushed);
end $$;

-- Offers still open, plus the last 30 days of filled / closed ones, with every recipient's answer.
create function public.openjobs_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(public.openjobs_offer_json(o.id) || jsonb_build_object('recipients',
            (select coalesce(jsonb_agg(jsonb_build_object('user_id', r.user_id, 'name', public.staff_name(r.user_id), 'drive_min', r.drive_min,
                      'notified', r.notified, 'seen_at', r.seen_at, 'answer', r.answer, 'answered_at', r.answered_at, 'reason', r.reason)
                      order by r.answer = 'accepted' desc nulls last, r.answered_at, lower(public.staff_name(r.user_id))), '[]'::jsonb)
               from public.job_offer_recipients r where r.offer_id = o.id))
            order by o.status = 'open' desc, o.created_at desc), '[]'::jsonb)
    from public.job_offers o join public.bookings b on b.id = o.booking_id
   where o.status = 'open' or o.created_at > now() - interval '30 days');
end $$;

create function public.openjobs_close(p_offer uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.job_offers set status = 'closed', closed_at = now() where id = p_offer and status = 'open';
  return jsonb_build_object('ok', found);
end $$;

-- ---------------------------------------------------------------- part-timers (View)
-- The offers sent to me: open ones I can still answer, and ones I answered in the last 30 days.
-- Opening the page marks them seen (the manager sees that).
create function public.openjobs_mine()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v jsonb;
begin
  if not public.can('openjobs', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(public.openjobs_offer_json(o.id, v_uid) order by (r.answer is null and o.status = 'open') desc, o.created_at desc), '[]'::jsonb) into v
    from public.job_offer_recipients r
    join public.job_offers o on o.id = r.offer_id
    join public.bookings b on b.id = o.booking_id
   where r.user_id = v_uid
     and ((o.status = 'open' and r.answer is null and b.status = 'booked' and exists (select 1 from public.openjobs_days(o.booking_id)))
       or (r.answer is not null and r.answered_at > now() - interval '30 days')
       or (r.answer is null and o.status <> 'open' and coalesce(o.closed_at, o.created_at) > now() - interval '7 days'));
  update public.job_offer_recipients set seen_at = now() where user_id = v_uid and seen_at is null;
  return jsonb_build_object('me', v_uid, 'offers', v);
end $$;

-- Take it (p_accept true) or pass (false, with an optional reason). Taking it is first come, first served.
create function public.openjobs_answer(p_offer uuid, p_accept boolean, p_reason text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  o public.job_offers; r public.job_offer_recipients; d record;
  v_taken int; v_drive int; v_added int := 0; v_title text; v_who text;
begin
  if not public.can('openjobs', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into o from public.job_offers where id = p_offer for update;
  select * into r from public.job_offer_recipients where offer_id = p_offer and user_id = v_uid;
  if o.id is null or r.offer_id is null then raise exception 'That job was not offered to you.'; end if;
  if r.answer = 'accepted' then raise exception 'You already took this job. Call the office if you can''t make it.'; end if;

  if p_accept then
    if o.status = 'filled' then return jsonb_build_object('ok', false, 'error', 'filled'); end if;
    if o.status <> 'open' or not exists (select 1 from public.bookings where id = o.booking_id and status = 'booked')
       or not exists (select 1 from public.openjobs_days(o.booking_id)) then
      return jsonb_build_object('ok', false, 'error', 'closed');
    end if;
    select count(*) into v_taken from public.job_offer_recipients where offer_id = o.id and answer = 'accepted';
    if v_taken >= o.spots then
      update public.job_offers set status = 'filled', closed_at = now() where id = o.id;
      return jsonb_build_object('ok', false, 'error', 'filled');
    end if;
    update public.job_offer_recipients set answer = 'accepted', answered_at = now(), reason = '' where offer_id = o.id and user_id = v_uid;
    v_taken := v_taken + 1;
    if v_taken >= o.spots then update public.job_offers set status = 'filled', closed_at = now() where id = o.id; end if;
    -- On the schedule for each day that has a time, with their own drive (rounded up to 5 minutes).
    v_drive := least(600, ceil(coalesce(r.drive_min, 0) / 5.0)::int * 5);
    for d in select * from public.openjobs_days(o.booking_id) where start_at is not null loop
      continue when exists (select 1 from public.schedule_entries e where e.user_id = v_uid and e.booking_id = o.booking_id and e.starts_at = d.start_at);
      insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at, drive_before_min, drive_after_min, title, note, created_by)
      values (v_uid, 'job', o.booking_id, d.start_at, d.end_at, v_drive, v_drive, '', 'Took it from Open jobs', v_uid);
      v_added := v_added + 1;
    end loop;
  else
    update public.job_offer_recipients set answer = 'declined', answered_at = now(), reason = left(btrim(coalesce(p_reason, '')), 300)
     where offer_id = o.id and user_id = v_uid;
  end if;

  -- Tell whoever posted it.
  if o.created_by is not null and o.created_by <> v_uid and public.openjobs_wants_push(o.created_by, 'job_offer_reply') then
    begin
      v_title := public.schedule_booking_title(o.booking_id);
      v_who := public.staff_name(v_uid);
      perform public.push_notify('job_offer_reply',
        case when p_accept then v_who || ' took ' || v_title else v_who || ' passed on ' || v_title end,
        case when p_accept then case when v_taken >= o.spots then 'Every spot is filled.' else v_taken || ' of ' || o.spots || ' spots taken.' end
             else coalesce(nullif(left(btrim(coalesce(p_reason, '')), 200), '') || '. ', '') ||
                  (select count(*) from public.job_offer_recipients x where x.offer_id = o.id and x.answer is null) || ' still to answer.' end,
        '/#staff/openjobs', null, o.created_by);
    exception when others then raise warning 'openjobs_answer push: %', sqlerrm;
    end;
  end if;
  return jsonb_build_object('ok', true, 'answer', case when p_accept then 'accepted' else 'declined' end, 'scheduled', v_added,
                            'untimed', (select count(*) from public.openjobs_days(o.booking_id) where start_at is null));
end $$;

-- For Today: offers waiting on me; for managers, open offers that everyone has passed on.
create function public.openjobs_attention()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if not public.can('openjobs', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'waiting', (select count(*) from public.job_offer_recipients r join public.job_offers o on o.id = r.offer_id join public.bookings b on b.id = o.booking_id
                 where r.user_id = v_uid and r.answer is null and o.status = 'open' and b.status = 'booked' and exists (select 1 from public.openjobs_days(o.booking_id))),
    'no_takers', case when public.can('openjobs', 'edit') then
                   (select count(*) from public.job_offers o join public.bookings b on b.id = o.booking_id
                     where o.status = 'open' and b.status = 'booked' and exists (select 1 from public.openjobs_days(o.booking_id))
                       and not exists (select 1 from public.job_offer_recipients r where r.offer_id = o.id and r.answer is distinct from 'declined'))
                 else 0 end);
end $$;

-- ---------------------------------------------------------------- grants
do $$
declare f text;
begin
  foreach f in array array['public.openjobs_wants_push(uuid, text)', 'public.openjobs_days(uuid)', 'public.openjobs_offer_json(uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.openjobs_people()', 'public.openjobs_person_save(uuid, boolean, text, integer)',
                           'public.offer_drive_targets(uuid)', 'public.offer_drive_store(text, jsonb)',
                           'public.openjobs_upcoming()', 'public.openjobs_candidates(uuid)', 'public.openjobs_post(jsonb)',
                           'public.openjobs_list()', 'public.openjobs_close(uuid)', 'public.openjobs_mine()',
                           'public.openjobs_answer(uuid, boolean, text)', 'public.openjobs_attention()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
