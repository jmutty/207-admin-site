-- Assigning photographers, simpler (2026-10-23, Jeremiah: "Employees don't need to confirm at this point. Keep
-- that as an option later. If I assign to a job the default should just be to assign the job. If I put a job as
-- available and ask multiple photographers, they should be asked if they are available and I will confirm one.")
--
--   1. Putting someone on a job just puts them on it. With "Ask people to confirm" off (Settings, Scheduling;
--      off by default) no confirm request is made at all: no waiting mark on the bar, no "jobs to confirm", no
--      Confirm links in the weekly email, and "Ask to confirm" refuses. Requests made while it was off and never
--      sent are cleared. Turning it on later works as before for people put on jobs from then on.
--   2. Ask who's available (Open jobs) can go to anyone on the team, not only Part time and 1099. Each person
--      gets an email as well as the app notification, says I'm available or Can't make it, and the manager picks
--      one; picking puts them on the job (no confirm request, they already said yes) and emails them. When every
--      spot is picked, the others who said they were available hear it's covered.
-- Email and push only, never SMS; only bookings.status = 'booked' sends anything.

-- ================================================================ 1. confirmations really off
create or replace function public.crew_confirm_on() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select crew_confirm_on from public.staff_settings where id), false)
$$;

create or replace function public.crew_ask_ensure(p_booking uuid, p_user uuid, p_changed boolean)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if not public.crew_confirm_on() then return; end if;  -- 2026-10-23: off means assigning just assigns
  if not exists (select 1 from public.bookings b where b.id = p_booking and b.status = 'booked') then return; end if;
  -- Picked from Ask who's available: they already said they can make it.
  if exists (select 1 from public.job_offer_recipients r join public.job_offers o on o.id = r.offer_id
              where o.booking_id = p_booking and r.user_id = p_user and r.picked_at is not null) then return; end if;
  insert into public.crew_asks (booking_id, user_id) values (p_booking, p_user)
  on conflict (booking_id, user_id) do update
     set status = 'pending', reason = '', answered_at = null, asked_at = null, reminded_at = null, queued_at = now(),
         changed = public.crew_asks.status <> 'declined'
   where public.crew_asks.status = 'declined' or (p_changed and public.crew_asks.asked_at is not null);
  if p_user = (select auth.uid()) and exists (select 1 from public.admin_users a where a.user_id = p_user) then
    update public.crew_asks set status = 'confirmed', answered_at = now(), changed = false
     where booking_id = p_booking and user_id = p_user and status = 'pending';
  end if;
end $function$;

create or replace function public.crew_send_due()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_h int := extract(hour from now() at time zone 'America/New_York'); v_n int := 0; r record;
begin
  if not public.crew_confirm_on() or v_h < 7 or v_h >= 21 then return 0; end if;
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
end $function$;

create or replace function public.crew_ask_now(p_booking uuid, p_user uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_id uuid;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.crew_confirm_on() then raise exception 'Asking people to confirm is off. Turn it on under Settings, Scheduling.'; end if;
  if not exists (select 1 from public.bookings where id = p_booking and status = 'booked') then raise exception 'Only booked jobs ask the crew to confirm.'; end if;
  if not exists (select 1 from public.crew_days(p_booking, p_user)) then raise exception 'They are not on this job anymore.'; end if;
  insert into public.crew_asks (booking_id, user_id) values (p_booking, p_user)
  on conflict (booking_id, user_id) do update set queued_at = now() returning id into v_id;
  update public.crew_asks set status = 'pending', reason = '', answered_at = null, changed = false where id = v_id;
  if not public.crew_ask_deliver(v_id, (select asked_at is not null from public.crew_asks where id = v_id)) then
    raise exception 'Nothing was sent: they have no email address or device to send to.';
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- The job page's Crew tab hides Ask to confirm while it's off.
create or replace function public.crew_for_booking(p_booking uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  if not public.can('scheduling', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'can_edit', public.can('scheduling', 'edit'),
    'confirm_on', public.crew_confirm_on(),
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
end $function$;

-- Requests made while confirming was off and never sent (2 at the time of writing): nobody was asked, so they go.
delete from public.crew_asks where status = 'pending' and asked_at is null and not public.crew_confirm_on();

-- ================================================================ 2. ask who's available: anyone, by email too
alter table public.job_offer_recipients add column emailed boolean not null default false;
comment on column public.job_offer_recipients.emailed is 'An email went out with the ask (2026-10-23), as well as or instead of the push.';

-- Email one person about an open job: kind 'ask' (are you available?), 'picked' (you've got it), 'covered' (someone else has it).
create or replace function public.openjobs_email(p_offer uuid, p_user uuid, p_kind text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  o public.job_offers; v_email text; v_name text; v_title text; v_loc text; v_days text[] := '{}'; v_subject text; v_lead text;
  v_link text := 'https://admin.207photo.com/#staff/openjobs'; v_btn text := 'Open jobs'; d record;
begin
  select * into o from public.job_offers where id = p_offer;
  if o.id is null or not exists (select 1 from public.bookings where id = o.booking_id and status = 'booked') then return false; end if;
  select u.email into v_email from auth.users u join public.team_members m on m.user_id = u.id where u.id = p_user and m.active;
  if coalesce(v_email, '') = '' then return false; end if;
  v_name := split_part(public.staff_name(p_user), ' ', 1);
  v_title := public.schedule_booking_title(o.booking_id);
  v_loc := coalesce(public.schedule_destination(o.booking_id), '');
  for d in select * from public.openjobs_days(o.booking_id) loop
    v_days := v_days || (to_char(d.day, 'FMDy FMMon FMDD') ||
              case when d.start_at is not null then ', ' || to_char(d.start_at at time zone 'America/New_York', 'FMHH12:MIam') || '-' || to_char(d.end_at at time zone 'America/New_York', 'FMHH12:MIam') else ', time not set yet' end);
  end loop;
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
      case when v_loc <> '' then E'\n' || v_loc else '' end || case when o.pay <> '' then E'\nPay: ' || o.pay else '' end ||
      case when o.note <> '' and p_kind <> 'covered' then E'\n\n' || o.note else '' end ||
      case when p_kind <> 'covered' then E'\n\n' || v_btn || ': ' || v_link else '' end,
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1e1b;max-width:600px">' ||
      '<p style="font-size:16px">Hi ' || public.html_esc(v_name) || '.</p><p>' || public.html_esc(v_lead) || '</p>' ||
      '<p><b>' || public.html_esc(v_title) || '</b><br>' || array_to_string(array(select public.html_esc(x) from unnest(v_days) x), '<br>') ||
      case when v_loc <> '' then '<br>' || public.html_esc(v_loc) else '' end || case when o.pay <> '' then '<br>Pay: ' || public.html_esc(o.pay) else '' end || '</p>' ||
      case when o.note <> '' and p_kind <> 'covered' then '<p style="white-space:pre-wrap">' || public.html_esc(o.note) || '</p>' else '' end ||
      case when p_kind <> 'covered' then '<p>' || public.crew_button(v_link, v_btn, '#2e7d4f') || '</p>' else '' end ||
      '<p style="margin-top:22px;font-size:13px;color:#6b675f">From <a href="https://admin.207photo.com/" style="color:#6b675f">207 Admin</a>.</p></div>') is not null;
exception when others then
  raise warning 'openjobs_email: %', sqlerrm;
  return false;
end $$;
revoke execute on function public.openjobs_email(uuid, uuid, text) from public, anon, authenticated;

-- Everyone active can be asked (part-timers and 1099 first when they're in range); drive from home where set.
create or replace function public.offer_drive_targets(p_booking uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare v_dest text;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  v_dest := public.schedule_destination(p_booking);
  if v_dest is null then return jsonb_build_object('ok', false, 'error', 'This job has no address. Add a location on the booking.'); end if;
  return jsonb_build_object('ok', true, 'destination', v_dest,
    'origins', (select coalesce(jsonb_agg(distinct btrim(m.home_address)), '[]'::jsonb)
                  from public.team_members m
                 where m.active and btrim(m.home_address) <> ''
                   and not exists (select 1 from public.offer_drive_cache c
                                    where c.origin = lower(btrim(m.home_address)) and c.destination = lower(v_dest)
                                      and c.fetched_at > now() - interval '180 days')));
end $function$;

create or replace function public.openjobs_candidates(p_booking uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare v_dest text := lower(public.schedule_destination(p_booking));
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.bookings where id = p_booking and status = 'booked') then raise exception 'Only booked jobs can be offered.'; end if;
  return jsonb_build_object(
    'booking', jsonb_build_object('booking_id', p_booking, 'title', public.schedule_booking_title(p_booking), 'location', coalesce(public.schedule_destination(p_booking), ''),
                 'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'start_at', d.start_at, 'end_at', d.end_at) order by d.day), '[]'::jsonb) from public.openjobs_days(p_booking) d)),
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', m.user_id, 'name', public.staff_name(m.user_id), 'home_set', btrim(m.home_address) <> '',
        'part_time', public.gets_open_jobs(m.user_id),
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
                    and ((d.start_at is not null and e.starts_at - make_interval(mins => e.drive_before_min + e.setup_min) < d.end_at and e.ends_at + make_interval(mins => e.drive_after_min + e.teardown_min) > d.start_at)
                      or (e.kind = 'off' and e.starts_at < (d.day + 1)::timestamp at time zone 'America/New_York' and e.ends_at > d.day::timestamp at time zone 'America/New_York'))))
        order by (c.minutes is not null and c.minutes <= m.max_drive_min) desc, c.minutes nulls last, lower(public.staff_name(m.user_id))), '[]'::jsonb)
      from public.team_members m
      left join public.offer_drive_cache c on c.origin = lower(btrim(m.home_address)) and c.destination = v_dest
     where m.active));
end $function$;

create or replace function public.openjobs_post(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_booking uuid := nullif(p ->> 'booking_id', '')::uuid;
  v_spots int := coalesce(nullif(p ->> 'spots', '')::int, 1);
  v_id uuid; v_dest text; v_title text; v_when text; v_uid uuid; v_min int; v_n int := 0; v_pushed int := 0; v_emailed int := 0; v_push boolean; v_mail boolean;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_booking is null or not exists (select 1 from public.bookings where id = v_booking and status = 'booked') then raise exception 'Only booked jobs can be offered.'; end if;
  if not exists (select 1 from public.openjobs_days(v_booking)) then raise exception 'This job has no days left to offer.'; end if;
  if v_spots not between 1 and 10 then raise exception 'People needed is 1 to 10.'; end if;
  if jsonb_typeof(p -> 'user_ids') is distinct from 'array' or jsonb_array_length(p -> 'user_ids') = 0 then raise exception 'Pick at least one person to ask.'; end if;

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
        perform public.push_notify('job_offer', 'Are you available? ' || v_title,
          v_when || coalesce(', ' || v_min || ' min drive', '') || case when btrim(coalesce(p ->> 'pay', '')) <> '' then '. ' || btrim(p ->> 'pay') else '' end || '. Tap to say if you can make it.',
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

create or replace function public.openjobs_list()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(public.openjobs_offer_json(o.id) || jsonb_build_object('recipients',
            (select coalesce(jsonb_agg(jsonb_build_object('user_id', r.user_id, 'name', public.staff_name(r.user_id), 'drive_min', r.drive_min,
                      'notified', r.notified, 'emailed', r.emailed, 'seen_at', r.seen_at, 'answer', r.answer, 'answered_at', r.answered_at, 'reason', r.reason, 'picked_at', r.picked_at)
                      order by r.picked_at is not null desc, r.answer = 'accepted' desc nulls last, r.drive_min nulls last, lower(public.staff_name(r.user_id))), '[]'::jsonb)
               from public.job_offer_recipients r where r.offer_id = o.id))
            order by o.status = 'open' desc, o.created_at desc), '[]'::jsonb)
    from public.job_offers o join public.bookings b on b.id = o.booking_id
   where o.status = 'open' or o.created_at > now() - interval '30 days');
end $function$;

-- Picking: on the job (no confirm request), an email to them, and once it's filled a "covered" note to the
-- others who said they were available.
create or replace function public.openjobs_pick(p_offer uuid, p_user uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  o public.job_offers; r public.job_offer_recipients; d record; x record;
  v_taken int; v_drive int; v_added int := 0;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into o from public.job_offers where id = p_offer for update;
  select * into r from public.job_offer_recipients where offer_id = p_offer and user_id = p_user;
  if o.id is null or r.offer_id is null then raise exception 'That person wasn''t asked about this job.'; end if;
  if r.answer is distinct from 'accepted' then raise exception 'Pick someone who said they''re available.'; end if;
  if r.picked_at is not null then return jsonb_build_object('ok', true, 'filled', o.status = 'filled', 'scheduled', 0); end if;
  if o.status <> 'open' or not exists (select 1 from public.bookings where id = o.booking_id and status = 'booked') then
    raise exception 'This offer is closed.';
  end if;
  select count(*) into v_taken from public.job_offer_recipients where offer_id = o.id and picked_at is not null;
  if v_taken >= o.spots then raise exception 'Every spot is already filled.'; end if;

  update public.job_offer_recipients set picked_at = now(), picked_by = v_me where offer_id = o.id and user_id = p_user;
  v_taken := v_taken + 1;
  if v_taken >= o.spots then update public.job_offers set status = 'filled', closed_at = now() where id = o.id; end if;

  v_drive := least(600, ceil(coalesce(r.drive_min, 0) / 5.0)::int * 5);
  for d in select * from public.openjobs_days(o.booking_id) where start_at is not null loop
    continue when exists (select 1 from public.schedule_entries e where e.user_id = p_user and e.booking_id = o.booking_id and e.starts_at = d.start_at);
    insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at, drive_before_min, drive_after_min, title, note, created_by)
    values (p_user, 'job', o.booking_id, d.start_at, d.end_at, v_drive, v_drive, '', 'Picked from Open jobs', v_me);
    v_added := v_added + 1;
  end loop;

  if public.openjobs_wants_push(p_user, 'job_offer') then
    begin
      perform public.push_notify('job_offer', 'You''ve got the job: ' || public.schedule_booking_title(o.booking_id),
        case when v_added > 0 then 'It''s on your schedule.' else 'The office will add the times.' end,
        '/#staff/crew', 'job_offer_pick_' || o.id || '_' || p_user, p_user);
    exception when others then raise warning 'openjobs_pick push: %', sqlerrm;
    end;
  end if;
  perform public.openjobs_email(o.id, p_user, 'picked');
  if v_taken >= o.spots then
    for x in select user_id from public.job_offer_recipients where offer_id = o.id and answer = 'accepted' and picked_at is null loop
      if public.openjobs_wants_push(x.user_id, 'job_offer') then
        begin
          perform public.push_notify('job_offer', 'Covered: ' || public.schedule_booking_title(o.booking_id), 'Thanks for saying you''re available. This one is covered now.',
            '/#staff/openjobs', 'job_offer_covered_' || o.id || '_' || x.user_id, x.user_id);
        exception when others then raise warning 'openjobs_pick covered push: %', sqlerrm;
        end;
      end if;
      perform public.openjobs_email(o.id, x.user_id, 'covered');
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'filled', v_taken >= o.spots, 'scheduled', v_added,
                            'untimed', (select count(*) from public.openjobs_days(o.booking_id) where start_at is null));
end $function$;

update public.push_topics set label = 'Are you available?', description = 'You were asked if you can make a job. Say if you''re available; you hear back if you get it.' where key = 'job_offer';
update public.app_modules set description = 'Ask several people if they''re available for a job; they answer from their phone or email and you pick who gets it. View = can be asked; Edit = ask and pick.' where key = 'openjobs';

-- ================================================================ 3. everyone travels from home
-- Jeremiah (2026-10-23): "All employee travel should be calculated from home as default, not just part time or
-- 1099." Anyone with a home address on their Team record starts and ends at home: drive times when they're put on
-- a job, "leave home" on their day and in emails, and the mileage estimate. No home address: the studio, as before.
-- Bars already on the schedule keep the minutes they were given.
create or replace function public.schedule_from_home(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members m where m.user_id = p_user and btrim(m.home_address) <> '')
$$;
