-- Main contact per service (2026-10-23). Jeremiah: "an athletic director that does all the bookings for sports, but
-- then we might want to prospect the principal to see if we can get their school photo business also - and the
-- secretary might be our main contact for school photos once booked."
-- Mockup and his choices: https://claude.ai/artifact/8rZsZbXWm7Kprzb9jZw7QA
--
-- Services are the four on the partner page: portraits (Team & individual), action, school_photos, events.
--   prospect_orgs.service_status     {service: client | prospect | competitor | not_interested | past_client}; a
--                                    service that isn't there is Not offered. school_photos stays in step with the
--                                    old sp_status column both ways (older screens and imports still write it).
--   prospect_contacts.service_roles  {service: main | copy}; a service that isn't there is Not involved, which keeps
--                                    the person out of everything automatic for it (booking ticks, Email someone,
--                                    rebooking, outreach threads). is_primary stays as "main for something", and
--                                    old code that sets it still works (a star with no service = main for the
--                                    services we're a client for there).
--   prospect_orgs.roles_checked_at   set by "Looks right" on the partner page; until then a partner with two live
--                                    services and one person main for both is on Today's "check who's main" list.
-- Both sports job types are portraits, School Photos is school_photos (prospect_service_of_type).
--
-- What picks people by service:
--   * a new booking (trigger): the service turns Client; when nobody is main for it yet, the first person on the
--     booking becomes main and the others copy in.
--   * booking_recipients: the booking service's main is To.
--   * prospect_school_handoff: the first School Photos booking at a school asks who runs picture day.
--   * rebook emails (partner_compose): the main of the service last year's job was for comes first.
--   * outreach threads (prospect_schedule_threads, prospect_enroll): only people on the sequence's service.
-- Book a job, Email someone and Enroll tick people in the app (partners-orgs.js, bookings.js).
-- Safe to run twice; nothing deleted.

alter table public.prospect_orgs add column if not exists service_status jsonb not null default '{}'::jsonb;
alter table public.prospect_orgs add column if not exists roles_checked_at timestamptz;
alter table public.prospect_contacts add column if not exists service_roles jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------- helpers
create or replace function public.prospect_service_of_type(p_type text) returns text
language sql stable set search_path = '' as $$
  select case when (select t.audience from public.booking_types t where t.key = p_type) = 'school' then 'school_photos' else 'portraits' end
$$;

create or replace function public.prospect_service_of_sequence(p_sequence uuid) returns text
language sql stable set search_path = '' as $$
  select case when (select q.audience from public.prospect_sequences q where q.id = p_sequence) = 'school' then 'school_photos' else 'portraits' end
$$;

create or replace function public.prospect_stage_status(p_stage text) returns text
language sql immutable set search_path = '' as $$
  select case when p_stage in ('client', 'booked') then 'client' when p_stage = 'past_client' then 'past_client'
              when p_stage = 'do_not_contact' then 'not_interested' else 'prospect' end
$$;

-- The services a partner uses or is pitched for; with none set, the one its type points to.
create or replace function public.prospect_org_services(p_org uuid) returns text[]
language sql stable set search_path = '' as $$
  select coalesce((select array_agg(k order by array_position(array['portraits', 'action', 'school_photos', 'events'], k))
                     from jsonb_object_keys(o.service_status) k),
                  array[case when o.audience = 'school' then 'school_photos' else 'portraits' end])
    from public.prospect_orgs o where o.id = p_org
$$;

-- Where a Main star with no service lands: the services we're a client for (or were), else all of them. So an
-- AD starred at a school we shoot sports for is the Team & individual main, not the person we pitch school photos to.
create or replace function public.prospect_org_star_services(p_org uuid) returns text[]
language sql stable set search_path = '' as $$
  select coalesce((select array_agg(e.key) from public.prospect_orgs o, jsonb_each_text(o.service_status) e
                    where o.id = p_org and e.value in ('client', 'past_client')),
                  public.prospect_org_services(p_org))
$$;

-- ---------------------------------------------------------------- keeping the columns tidy and in step
create or replace function public.prospect_orgs_services() returns trigger
language plpgsql set search_path = public as $$
declare k text; v jsonb := '{}'::jsonb; v_sp text;
begin
  for k in select jsonb_object_keys(coalesce(new.service_status, '{}'::jsonb)) loop
    if k in ('portraits', 'action', 'school_photos', 'events')
       and new.service_status ->> k in ('client', 'prospect', 'competitor', 'not_interested', 'past_client') then
      v := v || jsonb_build_object(k, new.service_status ->> k);
    end if;
  end loop;
  new.service_status := v;
  if tg_op = 'INSERT' then
    if new.service_status = '{}'::jsonb then
      new.service_status := jsonb_build_object(case when new.audience = 'school' then 'school_photos' else 'portraits' end,
                                               coalesce(case when new.audience = 'school' then new.sp_status end, public.prospect_stage_status(new.stage)));
    end if;
  elsif new.sp_status is distinct from old.sp_status and new.service_status = old.service_status then
    -- the old School photos field changed (an older screen or an import): carry it over
    new.service_status := case when new.sp_status is null then new.service_status - 'school_photos'
                               else new.service_status || jsonb_build_object('school_photos', new.sp_status) end;
  end if;
  v_sp := new.service_status ->> 'school_photos';
  new.sp_status := case when v_sp = 'past_client' then 'client' else v_sp end;
  -- a service we're a client for is ticked under Services
  new.services := (select coalesce(array_agg(distinct x order by x), '{}') from unnest(coalesce(new.services, '{}') ||
                     array(select e.key from jsonb_each_text(new.service_status) e where e.value = 'client')) x);
  return new;
end $$;
drop trigger if exists prospect_orgs_services on public.prospect_orgs;
create trigger prospect_orgs_services before insert or update on public.prospect_orgs
  for each row execute function public.prospect_orgs_services();

create or replace function public.prospect_contacts_roles() returns trigger
language plpgsql set search_path = public as $$
declare k text; v jsonb := '{}'::jsonb;
begin
  for k in select jsonb_object_keys(coalesce(new.service_roles, '{}'::jsonb)) loop
    if k in ('portraits', 'action', 'school_photos', 'events') and new.service_roles ->> k in ('main', 'copy') then
      v := v || jsonb_build_object(k, new.service_roles ->> k);
    end if;
  end loop;
  new.service_roles := v;
  -- older screens and RPCs set is_primary ("Add as main contact", enrolling, imports)
  if tg_op = 'INSERT' or (new.is_primary is distinct from old.is_primary and new.service_roles = old.service_roles) then
    if new.is_primary and not exists (select 1 from jsonb_each_text(new.service_roles) e where e.value = 'main') then
      foreach k in array coalesce(public.prospect_org_star_services(new.org_id), '{}') loop
        new.service_roles := new.service_roles || jsonb_build_object(k, 'main');
      end loop;
    elsif tg_op = 'UPDATE' and not new.is_primary then
      new.service_roles := coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(new.service_roles) e where e.value <> '"main"'::jsonb), '{}'::jsonb);
    end if;
  end if;
  new.is_primary := exists (select 1 from jsonb_each_text(new.service_roles) e where e.value = 'main');
  return new;
end $$;
drop trigger if exists prospect_contacts_roles on public.prospect_contacts;
create trigger prospect_contacts_roles before insert or update on public.prospect_contacts
  for each row execute function public.prospect_contacts_roles();

-- ---------------------------------------------------------------- moving today's data over
-- Statuses: Team & individual from the stage (leagues, and schools we've shot sports for); School photos from the
-- old field; Action and Events where they're ticked under Services.
update public.prospect_orgs o set service_status = x.s
  from (select o2.id, jsonb_strip_nulls(jsonb_build_object(
          'portraits', case when (o2.audience = 'league' and (cardinality(o2.services) = 0 or 'portraits' = any (o2.services)))
                                 or (o2.audience = 'school' and ('portraits' = any (o2.services) or sp.yes))
                            then public.prospect_stage_status(o2.stage) end,
          'action', case when 'action' = any (o2.services) then public.prospect_stage_status(o2.stage) end,
          'events', case when 'events' = any (o2.services) then public.prospect_stage_status(o2.stage) end,
          'school_photos', case when o2.sp_status is not null then o2.sp_status
                                when 'school_photos' = any (o2.services) then 'client'
                                when o2.audience = 'school' and not ('portraits' = any (o2.services) or sp.yes) then public.prospect_stage_status(o2.stage) end)) s
          from public.prospect_orgs o2
          cross join lateral (select exists (select 1 from public.bookings b join public.booking_types t on t.key = b.type_key
                                              where b.org_id = o2.id and t.audience = 'sports' and b.status <> 'cancelled') as yes) sp) x
 where x.id = o.id and o.service_status = '{}'::jsonb;
update public.prospect_orgs set service_status = jsonb_build_object(case when audience = 'school' then 'school_photos' else 'portraits' end,
                                                                    public.prospect_stage_status(stage))
 where service_status = '{}'::jsonb;

-- Today's Main stars: main for the services we're a client for there (all of them where we're a client for none).
update public.prospect_contacts c set service_roles = (select jsonb_object_agg(k, 'main') from unnest(public.prospect_org_star_services(c.org_id)) k)
 where c.is_primary and c.service_roles = '{}'::jsonb;

-- ---------------------------------------------------------------- "check who's main" (Today + the partner page)
create or replace function public.prospect_roles_to_check() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select o.id from public.prospect_orgs o
   where public.can_any('{partners}', 'view') and o.roles_checked_at is null
     and (select count(*) from jsonb_each_text(o.service_status) e where e.value in ('client', 'past_client')) >= 2
     and exists (select 1 from public.prospect_contacts c
                  where c.org_id = o.id and c.stopped_at is null
                    and (select count(*) from jsonb_each_text(c.service_roles) r
                          where r.value = 'main' and o.service_status ->> r.key in ('client', 'past_client')) >= 2)
$$;
revoke all on function public.prospect_roles_to_check() from public, anon;
grant execute on function public.prospect_roles_to_check() to authenticated;

-- ---------------------------------------------------------------- bookings
-- A booking makes its service Client, and gives the service a main when it has none: the first person on it.
create or replace function public.bookings_service_roles() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_svc text := public.prospect_service_of_type(new.type_key); v_first uuid;
begin
  if new.org_id is null or new.status not in ('booked', 'tracked', 'done') then return null; end if;
  if tg_op = 'UPDATE' and old.status = new.status and old.contact_ids is not distinct from new.contact_ids then return null; end if;
  update prospect_orgs set service_status = service_status || jsonb_build_object(v_svc, 'client')
   where id = new.org_id and service_status ->> v_svc is distinct from 'client';
  if not exists (select 1 from prospect_contacts c where c.org_id = new.org_id and c.service_roles ->> v_svc = 'main') then
    select c.id into v_first from unnest(coalesce(new.contact_ids, '{}')) with ordinality u(id, pos)
      join prospect_contacts c on c.id = u.id and c.org_id = new.org_id order by u.pos limit 1;
    if v_first is not null then
      update prospect_contacts set service_roles = service_roles || jsonb_build_object(v_svc, 'main') where id = v_first;
      update prospect_contacts set service_roles = service_roles || jsonb_build_object(v_svc, 'copy')
       where id = any (new.contact_ids) and id <> v_first and org_id = new.org_id and not (service_roles ? v_svc);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists bookings_service_roles on public.bookings;
create trigger bookings_service_roles after insert or update of status, contact_ids on public.bookings
  for each row execute function public.bookings_service_roles();

-- The booking service's main is To; the rest of the booking's people are cc, in the order picked.
create or replace function public.booking_recipients(p_booking uuid, p_hub boolean)
returns table(to_contact uuid, to_email text, to_name text, cc text[])
language plpgsql stable security definer set search_path = public as $$
declare b bookings; r record; v_cc text[] := '{}'; v_to uuid; v_email text; v_name text; v_svc text;
begin
  select * into b from bookings where id = p_booking;
  v_svc := public.prospect_service_of_type(b.type_key);
  for r in select pc.id, lower(btrim(pc.email)) email, nullif(btrim(concat_ws(' ', pc.first_name, pc.last_name)), '') nm
             from unnest(b.contact_ids) with ordinality u(id, pos) join prospect_contacts pc on pc.id = u.id
            where pc.email is not null and pc.bounced_at is null and pc.unsubscribed_at is null and pc.stopped_at is null
            order by (pc.service_roles ->> v_svc = 'main') desc nulls last, pc.is_primary desc, u.pos loop
    if v_to is null then v_to := r.id; v_email := r.email; v_name := r.nm;
    elsif r.email <> v_email and not (r.email = any(v_cc)) then v_cc := v_cc || r.email; end if;
  end loop;
  if v_to is null then return; end if;
  to_contact := v_to; to_email := v_email; to_name := v_name; cc := v_cc;
  return next;
end $$;

-- First School Photos booking at a school we were pitching: who runs picture day. They become the School photos
-- main and the booking's first person; whoever we pitched is copied in (p_keep) or taken off; school photos
-- outreach to the school stops.
create or replace function public.prospect_school_handoff(p_booking uuid, p_runner uuid, p_keep boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b bookings; v_svc text; v_pitched uuid[]; v_ids uuid[]; e record; n int := 0;
begin
  if auth.uid() is not null and not public.can_any('{bookings,partners}', 'edit') then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking;
  if b.id is null then raise exception 'Booking not found.'; end if;
  v_svc := public.prospect_service_of_type(b.type_key);
  if not exists (select 1 from prospect_contacts c where c.id = p_runner and c.org_id = b.org_id
                  and c.email is not null and c.bounced_at is null and c.unsubscribed_at is null and c.stopped_at is null) then
    raise exception 'Pick someone at this partner who can get emails.';
  end if;
  select coalesce(array_agg(c.id), '{}') into v_pitched from prospect_contacts c
   where c.org_id = b.org_id and c.id <> p_runner and c.service_roles ->> v_svc = 'main';
  update prospect_contacts set service_roles = case when p_keep then service_roles || jsonb_build_object(v_svc, 'copy') else service_roles - v_svc end
   where id = any (v_pitched);
  update prospect_contacts set service_roles = service_roles || jsonb_build_object(v_svc, 'main') where id = p_runner;
  update prospect_orgs set service_status = service_status || jsonb_build_object(v_svc, 'client'), roles_checked_at = coalesce(roles_checked_at, now())
   where id = b.org_id;
  v_ids := array[p_runner] || array(select x from unnest(coalesce(b.contact_ids, '{}')) with ordinality u(x, pos)
                                     where x <> p_runner and (p_keep or not (x = any (v_pitched))) order by pos);
  update bookings set contact_ids = v_ids where id = p_booking;
  if b.status = 'booked' then perform public.booking_reschedule(p_booking); end if;
  for e in select en.id from prospect_enrollments en join prospect_sequences q on q.id = en.sequence_id
            where en.org_id = b.org_id and en.status in ('active', 'paused')
              and public.prospect_service_of_sequence(q.id) = v_svc loop
    perform public.prospect_set_status(e.id, 'stop'); n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'outreach_stopped', n);
end $$;
revoke all on function public.prospect_school_handoff(uuid, uuid, boolean) from public, anon;
grant execute on function public.prospect_school_handoff(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- rebooking: the main for last year's service first
create or replace function public.partner_rebook_first(p_org uuid, p_due date default null) returns uuid[]
language sql stable security definer set search_path = '' as $$
  with pk as (select x.picture_day from public.partner_rebook_pick(p_org, p_due) x limit 1),
  svc as (
    select coalesce((select public.prospect_service_of_type(b.type_key) from public.bookings b, pk
                      where b.org_id = p_org and b.status in ('booked', 'tracked', 'done') and pk.picture_day is not null
                        and abs(b.picture_day - pk.picture_day) <= 30
                      order by abs(b.picture_day - pk.picture_day) limit 1),
                    (public.prospect_org_services(p_org))[1]) as s)
  select coalesce(array_agg(c.id order by c.service_roles ->> svc.s desc, c.created_at), '{}')  -- 'main' before 'copy'
    from public.prospect_contacts c, svc
   where c.org_id = p_org and c.service_roles ->> svc.s in ('main', 'copy')
$$;

-- ---------------------------------------------------------------- small patches to live functions
create or replace function pg_temp.patch_once(p_sig regprocedure, p_marker text, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  if strpos(v_def, p_marker) > 0 then raise notice 'patch %: already applied', p_sig; return; end if;
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

-- rebook emails start from the service's people (review and agreement emails already use the booking's)
select pg_temp.patch_once('public.partner_compose(text, uuid, uuid, date)'::regprocedure, 'partner_rebook_first',
  'v_org := p_ref;', 'v_org := p_ref; v_first := public.partner_rebook_first(p_ref, p_due);', 1);

-- outreach threads: only people on the sequence's service
select pg_temp.patch_once('public.prospect_schedule_threads(uuid)'::regprocedure, 'prospect_service_of_sequence',
  'and c\.stopped_at is null and not c\.history_only\s+on conflict \(enrollment_id, contact_id\) do nothing;',
  'and c.stopped_at is null and not c.history_only
    and c.service_roles ? public.prospect_service_of_sequence((select e.sequence_id from prospect_enrollments e where e.id = p_enrollment_id))
  on conflict (enrollment_id, contact_id) do nothing;', 1);

-- prospect_enroll (the prospecting skill): the people it's given are on the sequence's service, and held
-- threads only go to people on it
select pg_temp.patch_once('public.prospect_enroll(jsonb, jsonb, text, boolean, boolean)'::regprocedure, 'prospect_service_of_sequence',
  '(\n  insert into public\.prospect_enrollments \(org_id, sequence_id, status, next_send_at, end_reason\))',
  '
  update public.prospect_contacts c set service_roles = c.service_roles || jsonb_build_object(public.prospect_service_of_sequence(v_seq.id), ''copy'')
   where c.org_id = v_org_id and not (c.service_roles ? public.prospect_service_of_sequence(v_seq.id))
     and lower(c.email) in (select lower(trim(x->>''email'')) from jsonb_array_elements(p_contacts) x);
\1', 1);
select pg_temp.patch_once('public.prospect_enroll(jsonb, jsonb, text, boolean, boolean)'::regprocedure, 'held threads by service',
  'and c\.stopped_at is null and not c\.history_only\s+on conflict do nothing;',
  'and c.stopped_at is null and not c.history_only
      and c.service_roles ? public.prospect_service_of_sequence(v_seq.id)  -- held threads by service
    on conflict do nothing;', 1);
