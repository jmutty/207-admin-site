-- Roster status at a glance (2026-10-24, Jeremiah: "I need to know louder if rosters are loaded into gotphoto").
-- One answer per booking, the same on the job page, All jobs, the Jobs calendar, Today, the partner page and the
-- phone push: is the roster in GotPhoto yet?
--   in      GotPhoto has the names (QR codes on the job; synced_jobs.roster_loaded_at / code_count from the sync)
--   due     not in yet, and the deadline (two weeks before the first picture day, as the booking emails say) hasn't passed
--   late    not in, and the deadline has passed
--   nojob   no GotPhoto job linked yet, so there's nothing to load it into
--   single  the GotPhoto job uses one shared password: it never holds names, so no roster is expected there
--   past    picture day has passed (the screens don't show a tag then)
-- School Photos jobs use the student data file (bookings.school_data_at) for in/due/late.
-- Pushes: roster_push_tick() (hourly, 9am-8pm Eastern) sends "No roster" 7 days out and "Still no roster" 3 days out,
-- once each per job, to whoever booked it (everyone with Bookings when nobody did). Nothing goes to the league.

create or replace function public.booking_roster(p_booking uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $$
declare b record; j record; v_today date := (now() at time zone 'America/New_York')::date; v_in boolean; v_state text; v_due date;
begin
  select bk.id, bk.picture_day, bk.status, bk.gotphoto_job_id, bk.hub_school_id, bk.school_data_at, t.audience
    into b from public.bookings bk join public.booking_types t on t.key = bk.type_key where bk.id = p_booking;
  if b.id is null then return null; end if;
  select sj.gotphoto_job_id, sj.roster_loaded_at, coalesce(sj.code_count, 0) code_count, sj.access_type into j
    from public.synced_jobs sj
   where sj.gotphoto_job_id = coalesce(b.gotphoto_job_id, case when b.hub_school_id is not null then public.school_hub_job(b.hub_school_id) end);
  v_due := b.picture_day - 14;
  if b.audience = 'school' then
    v_in := b.school_data_at is not null;
  elsif j.gotphoto_job_id is null then
    v_state := 'nojob';
  elsif j.access_type = 'single_password' then
    v_state := 'single';
  else
    v_in := j.roster_loaded_at is not null or j.code_count > 0;
  end if;
  if b.picture_day < v_today then v_state := 'past';
  elsif v_state is null then v_state := case when v_in then 'in' when v_today > v_due then 'late' else 'due' end;
  end if;
  return jsonb_build_object('state', v_state, 'names', case when b.audience = 'school' then null else j.code_count end,
    'loaded_at', case when b.audience = 'school' then b.school_data_at else j.roster_loaded_at end,
    'due', v_due, 'days_out', b.picture_day - v_today, 'school', b.audience = 'school');
end $$;
revoke all on function public.booking_roster(uuid) from public, anon;
grant execute on function public.booking_roster(uuid) to authenticated;

-- admin_bookings: the live definition plus 'roster'.
create or replace function public.admin_bookings(p_from date default null::date, p_to date default null::date)
 returns setof jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select to_jsonb(b) - 'contact_ids' || jsonb_build_object(
    'org_name', o.name, 'org_town', o.town, 'type_label', t.label, 'audience', t.audience,
    'title', public.job_title(b.title_override, o.name, coalesce(nullif(b.title_label, ''), t.label)),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'day', d.day, 'start_at', d.start_at, 'end_at', d.end_at, 'label', d.label, 'location', d.location, 'sort', d.sort, 'calendar_status', d.calendar_status) order by d.day), '[]'::jsonb)
               from booking_days d where d.booking_id = b.id and not d.removed and d.kind = 'shoot'),
    'makeup', (select jsonb_build_object('id', d.id, 'day', d.day, 'start_at', d.start_at, 'end_at', d.end_at, 'calendar_status', d.calendar_status)
                 from booking_days d where d.booking_id = b.id and not d.removed and d.kind = 'makeup' limit 1),
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), 'email', c.email) order by c.is_primary desc, c.first_name), '[]'::jsonb)
                   from prospect_contacts c where c.id = any(b.contact_ids)),
    'emails_total', (select count(*) from booking_emails e where e.booking_id = b.id and not e.is_resend and e.status <> 'cancelled'),
    'emails_sent', (select count(*) from booking_emails e where e.booking_id = b.id and not e.is_resend and e.status = 'sent'),
    'emails_failed', (select count(*) from booking_emails e where e.booking_id = b.id and e.status = 'failed'),
    'emails_waiting', (select count(*) from booking_emails e where e.booking_id = b.id and e.status = 'waiting'),
    'emails_waiting_time', (select count(*) from booking_emails e where e.booking_id = b.id and e.status = 'waiting' and e.reason like 'needs the start time%'),
    'emails_waiting_coaches', (select count(*) from booking_emails e where e.booking_id = b.id and e.status = 'waiting' and e.reason = 'no coach emails yet'),
    'emails_waiting_gallery', (select count(*) from booking_emails e where e.booking_id = b.id and e.status = 'waiting' and e.reason = 'gallery not live yet'),
    'next_send_at', (select min(e.send_at) from booking_emails e where e.booking_id = b.id and e.status = 'scheduled'),
    'last_sent_at', (select max(e.sent_at) from booking_emails e where e.booking_id = b.id and e.status = 'sent'),
    'roster', case when b.status = 'booked' and b.picture_day >= (now() at time zone 'America/New_York')::date - 1 then public.booking_roster(b.id) end)
  from bookings b
  join prospect_orgs o on o.id = b.org_id
  join booking_types t on t.key = b.type_key
  where public.can_any('{bookings}', 'view')
    and (p_from is null or b.picture_day >= p_from)
    and (p_to is null or b.picture_day <= p_to)
  order by b.picture_day, b.start_at;
$function$;

-- Phone pushes 7 and 3 days out.
create table if not exists public.roster_pushes (
  booking_id uuid not null, -- no foreign key, so this migration can go in through the cloud (bookings are cancelled, not removed)
  stage int not null check (stage in (7, 3)),
  sent_at timestamptz not null default now(),
  primary key (booking_id, stage)
);
alter table public.roster_pushes enable row level security;
revoke all on public.roster_pushes from anon, authenticated;

insert into public.push_topics (key, label, description, module, sort, default_on, default_mode) values
  ('roster_missing', 'No roster in GotPhoto', 'A picture day is 7 days out (and again at 3 days) and GotPhoto has no roster for it yet. Goes to whoever booked the job.', 'bookings', 44, true, 'push')
on conflict (key) do nothing;

create or replace function public.roster_push_tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_now timestamp := now() at time zone 'America/New_York'; v_stage int; v_owner uuid; v_title text; v_body text; v_sent int := 0;
begin
  if extract(hour from v_now) < 9 or extract(hour from v_now) >= 20 then return jsonb_build_object('skipped', 'night'); end if;
  for r in
    select b.id, o.name org, b.picture_day, public.booking_roster(b.id) ro
      from public.bookings b left join public.prospect_orgs o on o.id = b.org_id
     where b.status = 'booked' and b.picture_day between v_now::date and v_now::date + 7
  loop
    if r.ro->>'state' <> 'late' then continue; end if;
    v_stage := case when (r.ro->>'days_out')::int <= 3 then 3 else 7 end;
    if exists (select 1 from public.roster_pushes p where p.booking_id = r.id and p.stage = v_stage) then continue; end if;
    insert into public.roster_pushes (booking_id, stage) values (r.id, v_stage) on conflict do nothing;
    v_title := case when v_stage = 3 then 'Still no roster: ' else 'No roster: ' end || coalesce(r.org, 'a job');
    v_body := 'Picture day is ' || trim(to_char(r.picture_day, 'FMDay')) || ' ' || to_char(r.picture_day, 'FMMM/FMDD') || ', '
      || case (r.ro->>'days_out')::int when 0 then 'today' when 1 then 'tomorrow' else (r.ro->>'days_out') || ' days out' end
      || case when (r.ro->>'school')::boolean then ', and the student data file isn''t in yet.' else ', and GotPhoto has no names yet.' end
      || case when v_stage = 3 then ' Run it as Roster Only or call them today.' else '' end;
    v_owner := public.booking_followup_owner(r.id);
    begin
      perform public.push_notify('roster_missing', v_title, v_body, '/#jobs/job/' || r.id, 'roster_missing:' || r.id || ':' || v_stage, v_owner);
    exception when others then raise warning 'roster_push_tick push: %', sqlerrm;
    end;
    v_sent := v_sent + 1;
  end loop;
  return jsonb_build_object('sent', v_sent);
end $$;
revoke all on function public.roster_push_tick() from public, anon, authenticated;

do $$ begin
  perform cron.unschedule('roster-push') where exists (select 1 from cron.job where jobname = 'roster-push');
  perform cron.schedule('roster-push', '40 * * * *', 'select public.roster_push_tick()');
end $$;
