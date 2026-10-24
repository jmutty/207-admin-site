-- Ask who's available and the Schedule's crew picker use each day's own place (2026-10-24, Jeremiah: "close the
-- remaining gap. Obviously if I ask if anyone is available they will need to know their actual drive time").
--
-- A picture day can be somewhere other than the job's Location (booking_days.location, PR #108). Until now Open job
-- offers, the "Are you available?" email and push, and the crew picker's drive from home all used the job's
-- Location. Now:
--   * offer_drive_targets returns every place the job's coming days are at, so the offer-drive function looks up
--     each person's drive to each of them.
--   * A person's drive for an offer is the longest of those drives (unknown if any is unknown): that is what the
--     in-range check, the sort, the push and the stored drive_min use. Each day also carries its place and, for the
--     person, its own drive, so a job at two places shows both.
--   * crew_options (the Schedule's assign dialog) measures the drive to the day being assigned;
--     crew_drive_targets_day lets offer-drive fill that day's drives.

begin;

-- ---------------------------------------------------------------- helpers
-- Each coming day of the job: its place and the drive from this home to it (null when unknown).
create or replace function public.openjobs_day_drives(p_booking uuid, p_home text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'start_at', d.start_at, 'end_at', d.end_at,
           'place', coalesce(x.dest, ''), 'drive_min', c.minutes) order by d.day), '[]'::jsonb)
    from public.openjobs_days(p_booking) d
    cross join lateral (select public.schedule_destination(p_booking, d.day) as dest) x
    left join public.offer_drive_cache c on btrim(coalesce(p_home, '')) <> '' and c.origin = lower(btrim(p_home)) and c.destination = lower(x.dest)
$$;

-- The longest drive from this home to any of the job's coming days; null if any of them is unknown.
create or replace function public.openjobs_drive_min(p_booking uuid, p_home text) returns int
language sql stable security definer set search_path = '' as $$
  select case when count(*) > 0 and count(c.minutes) = count(*) then max(c.minutes) end
    from public.openjobs_days(p_booking) d
    cross join lateral (select public.schedule_destination(p_booking, d.day) as dest) x
    left join public.offer_drive_cache c on btrim(coalesce(p_home, '')) <> '' and c.origin = lower(btrim(p_home)) and c.destination = lower(x.dest)
$$;

-- More than one place across the job's coming days
create or replace function public.openjobs_places_differ(p_booking uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select count(distinct lower(btrim(public.schedule_destination(p_booking, d.day)))) > 1 from public.openjobs_days(p_booking) d
$$;

revoke all on function public.openjobs_day_drives(uuid, text), public.openjobs_drive_min(uuid, text), public.openjobs_places_differ(uuid) from public, anon;

-- ---------------------------------------------------------------- drive lookups: every place the job is at
create or replace function public.offer_drive_targets(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $function$
declare v_targets jsonb;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('destination', t.dest,
           'origins', (select coalesce(jsonb_agg(distinct btrim(m.home_address)), '[]'::jsonb)
                         from public.team_members m
                        where m.active and btrim(m.home_address) <> ''
                          and not exists (select 1 from public.offer_drive_cache c
                                           where c.origin = lower(btrim(m.home_address)) and c.destination = lower(t.dest)
                                             and c.fetched_at > now() - interval '180 days'))) order by t.first), '[]'::jsonb)
    into v_targets
    from (select x.dest, min(d.day) as first
            from public.openjobs_days(p_booking) d
            cross join lateral (select public.schedule_destination(p_booking, d.day) as dest) x
           where x.dest is not null
           group by x.dest) t;
  if v_targets = '[]'::jsonb and public.schedule_destination(p_booking) is not null then
    v_targets := jsonb_build_array(jsonb_build_object('destination', public.schedule_destination(p_booking),
      'origins', (select coalesce(jsonb_agg(distinct btrim(m.home_address)), '[]'::jsonb) from public.team_members m
                   where m.active and btrim(m.home_address) <> ''
                     and not exists (select 1 from public.offer_drive_cache c where c.origin = lower(btrim(m.home_address))
                                       and c.destination = lower(public.schedule_destination(p_booking)) and c.fetched_at > now() - interval '180 days'))));
  end if;
  if v_targets = '[]'::jsonb then return jsonb_build_object('ok', false, 'error', 'This job has no address. Add a location on the booking.'); end if;
  -- destination/origins: the first place, for an offer-drive that only knows one
  return jsonb_build_object('ok', true, 'destination', v_targets->0->>'destination', 'origins', v_targets->0->'origins', 'targets', v_targets);
end $function$;

create or replace function public.crew_drive_targets_day(p_booking uuid, p_destination text, p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $function$
declare v_dest text := coalesce(nullif(btrim(coalesce(p_destination, '')), ''),
                                case when p_booking is not null and p_day is not null then public.schedule_destination(p_booking, p_day) end,
                                public.crew_dest(p_booking, null));
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_dest is null then return jsonb_build_object('ok', false, 'error', 'This job has no address yet.'); end if;
  return jsonb_build_object('ok', true, 'destination', v_dest,
    'origins', (select coalesce(jsonb_agg(distinct o), '[]'::jsonb) from (
                  select btrim(m.home_address) as o from public.team_members m where m.active and btrim(m.home_address) <> ''
                  union select btrim(s.studio_address) from public.staff_settings s where s.id and btrim(s.studio_address) <> '') x
                 where not exists (select 1 from public.offer_drive_cache c where c.origin = lower(x.o) and c.destination = lower(v_dest) and c.fetched_at > now() - interval '180 days')));
end $function$;
revoke all on function public.crew_drive_targets_day(uuid, text, date) from public, anon;
grant execute on function public.crew_drive_targets_day(uuid, text, date) to authenticated;

-- ---------------------------------------------------------------- the Schedule's crew picker: the day's own place
create or replace function public.crew_options(p_booking uuid, p_day date, p_destination text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $function$
declare v_dest text; v_studio text; v_from timestamptz; v_to timestamptz;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  -- the place typed (Book a job, before saving), else that day's own place, else the job's
  v_dest := lower(coalesce(nullif(btrim(coalesce(p_destination, '')), ''),
                           case when p_booking is not null and p_day is not null then public.schedule_destination(p_booking, p_day) end,
                           public.crew_dest(p_booking, null)));
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
end $function$;

-- ---------------------------------------------------------------- Ask who's available: who to ask
create or replace function public.openjobs_candidates(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $function$
declare v_differ boolean := public.openjobs_places_differ(p_booking);
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.bookings where id = p_booking and status = 'booked') then raise exception 'Only booked jobs can be offered.'; end if;
  return jsonb_build_object(
    'booking', jsonb_build_object('booking_id', p_booking, 'title', public.schedule_booking_title(p_booking), 'location', coalesce(public.schedule_destination(p_booking), ''),
                 'places_differ', v_differ, 'days', public.openjobs_day_drives(p_booking, null)),
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', m.user_id, 'name', public.staff_name(m.user_id), 'home_set', btrim(m.home_address) <> '',
        'part_time', public.gets_open_jobs(m.user_id),
        'max_drive_min', m.max_drive_min, 'drive_min', dm.minutes,
        'drives', case when v_differ and btrim(m.home_address) <> '' then public.openjobs_day_drives(p_booking, m.home_address) end,
        'in_range', dm.minutes is not null and dm.minutes <= m.max_drive_min,
        'has_access', public.team_user_can(m.user_id, 'openjobs'),
        'has_device', exists (select 1 from public.push_subscriptions s where s.user_id = m.user_id),
        'on_job', exists (select 1 from public.schedule_entries e where e.booking_id = p_booking and e.user_id = m.user_id),
        'offered', exists (select 1 from public.job_offer_recipients r join public.job_offers o on o.id = r.offer_id
                            where o.booking_id = p_booking and o.status = 'open' and r.user_id = m.user_id and r.answer is null),
        'busy', (select coalesce(jsonb_agg(distinct d.day), '[]'::jsonb)
                   from public.openjobs_days(p_booking) d
                   join public.schedule_entries e on e.user_id = m.user_id and e.booking_id is distinct from p_booking
                    and ((d.start_at is not null and e.starts_at - make_interval(mins => e.drive_before_min + e.setup_min) < d.end_at and e.ends_at + make_interval(mins => e.drive_after_min + e.teardown_min) > d.start_at)
                      or (e.kind = 'off' and e.starts_at < (d.day + 1)::timestamp at time zone 'America/New_York' and e.ends_at > d.day::timestamp at time zone 'America/New_York'))))
        order by (dm.minutes is not null and dm.minutes <= m.max_drive_min) desc, dm.minutes nulls last, lower(public.staff_name(m.user_id))), '[]'::jsonb)
      from public.team_members m
      cross join lateral (select public.openjobs_drive_min(p_booking, m.home_address) as minutes) dm
     where m.active));
end $function$;

-- ---------------------------------------------------------------- an offer as people see it
create or replace function public.openjobs_offer_json(p_offer uuid, p_uid uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'booking_id', o.booking_id, 'title', public.schedule_booking_title(o.booking_id),
    'type_label', t.label, 'location', coalesce(public.schedule_destination(o.booking_id), ''),
    'places_differ', public.openjobs_places_differ(o.booking_id),
    'booking_status', b.status, 'spots', o.spots, 'note', o.note, 'pay', o.pay, 'status', o.status,
    'created_at', o.created_at, 'created_by', public.staff_name(o.created_by),
    'taken', (select count(*) from public.job_offer_recipients r where r.offer_id = o.id and r.picked_at is not null),
    'yes', (select count(*) from public.job_offer_recipients r where r.offer_id = o.id and r.answer = 'accepted'),
    -- each day with its place, and the drive to it from this person's home
    'days', public.openjobs_day_drives(o.booking_id, case when p_uid is not null then (select m.home_address from public.team_members m where m.user_id = p_uid) end),
    'mine', case when p_uid is not null then
              (select jsonb_build_object('drive_min', coalesce(public.openjobs_drive_min(o.booking_id, (select m.home_address from public.team_members m where m.user_id = p_uid)), r.drive_min),
                                         'answer', r.answer, 'answered_at', r.answered_at, 'reason', r.reason, 'picked_at', r.picked_at)
                 from public.job_offer_recipients r where r.offer_id = o.id and r.user_id = p_uid) end)
    from public.job_offers o
    join public.bookings b on b.id = o.booking_id
    left join public.booking_types t on t.key = b.type_key
   where o.id = p_offer
$$;

-- ---------------------------------------------------------------- asking: the drive is from their home to each day's place
create or replace function public.openjobs_post(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_booking uuid := nullif(p ->> 'booking_id', '')::uuid;
  v_spots int := coalesce(nullif(p ->> 'spots', '')::int, 1);
  v_id uuid; v_title text; v_when text; v_uid uuid; v_min int; v_n int := 0; v_pushed int := 0; v_emailed int := 0; v_push boolean; v_mail boolean;
  v_differ boolean;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_booking is null or not exists (select 1 from public.bookings where id = v_booking and status = 'booked') then raise exception 'Only booked jobs can be offered.'; end if;
  if not exists (select 1 from public.openjobs_days(v_booking)) then raise exception 'This job has no days left to offer.'; end if;
  if v_spots not between 1 and 10 then raise exception 'People needed is 1 to 10.'; end if;
  if jsonb_typeof(p -> 'user_ids') is distinct from 'array' or jsonb_array_length(p -> 'user_ids') = 0 then raise exception 'Pick at least one person to ask.'; end if;

  insert into public.job_offers (booking_id, spots, note, pay, created_by)
  values (v_booking, v_spots, left(btrim(coalesce(p ->> 'note', '')), 500), left(btrim(coalesce(p ->> 'pay', '')), 80), (select auth.uid()))
  returning id into v_id;

  v_differ := public.openjobs_places_differ(v_booking);
  v_title := public.schedule_booking_title(v_booking);
  select to_char(f.day, 'Dy Mon FMDD') || coalesce(' ' || to_char(f.start_at at time zone 'America/New_York', 'FMHH12:MIam'), '')
         || case when n.c > 1 then ' (+' || (n.c - 1) || ' more day' || case when n.c > 2 then 's' else '' end || ')' else '' end
    into v_when
    from (select * from public.openjobs_days(v_booking) limit 1) f, (select count(*) as c from public.openjobs_days(v_booking)) n;

  for v_uid in select distinct (x)::uuid from jsonb_array_elements_text(p -> 'user_ids') x loop
    continue when not exists (select 1 from public.team_members m where m.user_id = v_uid and m.active)
               or not public.team_user_can(v_uid, 'openjobs');
    select public.openjobs_drive_min(v_booking, m.home_address) into v_min from public.team_members m where m.user_id = v_uid;
    v_push := public.openjobs_wants_push(v_uid, 'job_offer');
    insert into public.job_offer_recipients (offer_id, user_id, drive_min, notified) values (v_id, v_uid, v_min, v_push);
    v_n := v_n + 1;
    if v_push then
      begin
        perform public.push_notify('job_offer', 'Are you available? ' || v_title,
          v_when || coalesce(', ' || case when v_differ then 'up to ' else '' end || v_min || ' min drive', '') || case when btrim(coalesce(p ->> 'pay', '')) <> '' then '. ' || btrim(p ->> 'pay') else '' end || '. Tap to say if you can make it.',
          '/#staff/openjobs', 'job_offer_' || v_id, v_uid);
        v_pushed := v_pushed + 1;
      exception when others then raise warning 'openjobs_post push: %', sqlerrm;
      end;
    end if;
    v_mail := public.openjobs_email(v_id, v_uid, 'ask');
    if v_mail then
      update public.job_offer_recipients set emailed = true where offer_id = v_id and user_id = v_uid;
      v_emailed := v_emailed + 1;
    end if;
  end loop;
  if v_n = 0 then raise exception 'None of those people have Open jobs on the Team page, so they can''t answer.'; end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'sent', v_n, 'pushed', v_pushed, 'emailed', v_emailed);
end $function$;

-- ---------------------------------------------------------------- the email: each day's place and their drive to it
create or replace function public.openjobs_email(p_offer uuid, p_user uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $function$
declare
  o public.job_offers; v_email text; v_name text; v_title text; v_loc text; v_days text[] := '{}'; v_subject text; v_lead text;
  v_link text := 'https://admin.207photo.com/#staff/openjobs'; v_btn text := 'Open jobs'; d jsonb; v_home text; v_differ boolean; v_min int; v_drive text := '';
begin
  select * into o from public.job_offers where id = p_offer;
  if o.id is null or not exists (select 1 from public.bookings where id = o.booking_id and status = 'booked') then return false; end if;
  select u.email, m.home_address into v_email, v_home from auth.users u join public.team_members m on m.user_id = u.id where u.id = p_user and m.active;
  if coalesce(v_email, '') = '' then return false; end if;
  v_name := split_part(public.staff_name(p_user), ' ', 1);
  v_title := public.schedule_booking_title(o.booking_id);
  v_differ := public.openjobs_places_differ(o.booking_id);
  -- one place: it goes under the days; places that differ: each day names its own, with the drive to it
  v_loc := case when v_differ then '' else coalesce(public.schedule_destination(o.booking_id), '') end;
  for d in select x from jsonb_array_elements(public.openjobs_day_drives(o.booking_id, v_home)) x loop
    v_days := v_days || (to_char((d->>'day')::date, 'FMDy FMMon FMDD') ||
              case when d->>'start_at' is not null then ', ' || to_char((d->>'start_at')::timestamptz at time zone 'America/New_York', 'FMHH12:MIam') || '-' || to_char((d->>'end_at')::timestamptz at time zone 'America/New_York', 'FMHH12:MIam') else ', time not set yet' end ||
              case when v_differ and coalesce(d->>'place', '') <> '' then ' at ' || (d->>'place') || coalesce(' (about ' || (d->>'drive_min') || ' min drive from home)', '') else '' end);
  end loop;
  if not v_differ then
    v_min := public.openjobs_drive_min(o.booking_id, v_home);
    if v_min is not null then v_drive := 'About ' || v_min || ' min drive from home'; end if;
  end if;
  if p_kind = 'ask' then
    v_subject := 'Are you available? ' || v_title;
    v_lead := 'Are you available for this job? Say I''m available or Can''t make it. You''ll hear back if you get it.';
    v_btn := 'Answer in 207 Admin';
  elsif p_kind = 'picked' then
    v_subject := 'You''ve got the job: ' || v_title;
    v_lead := 'Thanks for saying you''re available. You''ve got this job, and it''s on your schedule.';
    v_link := 'https://admin.207photo.com/#staff/crew'; v_btn := 'My jobs';
  elsif p_kind = 'covered' then
    v_subject := 'Covered: ' || v_title;
    v_lead := 'Thanks for saying you''re available. This one is covered now, so nothing more to do.';
  else return false; end if;
  return public.crew_send_email(v_email, v_subject,
    'Hi ' || v_name || E'.\n\n' || v_lead || E'\n\n' || v_title || E'\n' || array_to_string(v_days, E'\n') ||
      case when v_loc <> '' then E'\n' || v_loc else '' end || case when v_drive <> '' and p_kind <> 'covered' then E'\n' || v_drive else '' end ||
      case when o.pay <> '' then E'\nPay: ' || o.pay else '' end ||
      case when o.note <> '' and p_kind <> 'covered' then E'\n\n' || o.note else '' end ||
      case when p_kind <> 'covered' then E'\n\n' || v_btn || ': ' || v_link else '' end,
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1e1b;max-width:600px">' ||
      '<p style="font-size:16px">Hi ' || public.html_esc(v_name) || '.</p><p>' || public.html_esc(v_lead) || '</p>' ||
      '<p><b>' || public.html_esc(v_title) || '</b><br>' || array_to_string(array(select public.html_esc(x) from unnest(v_days) x), '<br>') ||
      case when v_loc <> '' then '<br>' || public.html_esc(v_loc) else '' end || case when v_drive <> '' and p_kind <> 'covered' then '<br>' || public.html_esc(v_drive) else '' end ||
      case when o.pay <> '' then '<br>Pay: ' || public.html_esc(o.pay) else '' end || '</p>' ||
      case when o.note <> '' and p_kind <> 'covered' then '<p style="white-space:pre-wrap">' || public.html_esc(o.note) || '</p>' else '' end ||
      case when p_kind <> 'covered' then '<p>' || public.crew_button(v_link, v_btn, '#2e7d4f') || '</p>' else '' end ||
      '<p style="margin-top:22px;font-size:13px;color:#6b675f">From <a href="https://admin.207photo.com/" style="color:#6b675f">207 Admin</a>.</p></div>') is not null;
exception when others then
  raise warning 'openjobs_email: %', sqlerrm;
  return false;
end $function$;

commit;
