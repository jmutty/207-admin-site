-- Holds: a day penciled in for a partner before it's booked (2026-10-24, Jeremiah, jobs calendar review item S).
-- "I'll keep 5/9 for you" shows on the Jobs calendar as a striped chip so the day isn't given away twice.
-- A hold can be tied to a partner (Book it then starts the booking with that partner and day) or just carry a
-- label. Hold until is optional; after it the hold shows as expired. Released holds stay in the table
-- (released_at) and stop showing. Read and written only through the functions below.
-- Jeremiah: a held day must show on the Google Calendar too, or the public open-dates page
-- (calendar.207photo.com) offers it. So each hold gets an all-day "HOLD: <name>" event on the booking calendar,
-- written by the calendar-write edge function (calendar_status pending -> synced; remove -> deleted on let go).

create table if not exists public.job_holds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.prospect_orgs(id) on update cascade on delete set null,
  label text not null default '',
  day date not null,
  hold_until date,
  note text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz,
  booking_id uuid references public.bookings(id) on delete set null,
  google_event_id text,
  calendar_status text not null default 'pending' check (calendar_status in ('pending', 'synced', 'error', 'remove', 'deleted')),
  calendar_error text,
  calendar_attempts integer not null default 0
);
create index if not exists job_holds_calendar_todo on public.job_holds (calendar_status) where calendar_status in ('pending', 'error', 'remove');
create index if not exists job_holds_day on public.job_holds (day) where released_at is null;
alter table public.job_holds enable row level security;
revoke all on public.job_holds from anon, authenticated;

-- Holds on days from p_from to p_to that are still held.
create or replace function public.job_holds_list(p_from date, p_to date)
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'org_id', h.org_id, 'org_name', o.name, 'org_town', o.town, 'label', h.label,
           'day', h.day, 'hold_until', h.hold_until, 'note', h.note, 'created_at', h.created_at,
           'created_by_name', public.staff_name(h.created_by), 'calendar_status', h.calendar_status, 'calendar_error', h.calendar_error) order by h.day, h.created_at), '[]'::jsonb)
    from public.job_holds h left join public.prospect_orgs o on o.id = h.org_id
   where public.can_any('{bookings}', 'view')
     and h.released_at is null and h.day between p_from and p_to
$$;

-- Add (p_id null) or change a hold. Returns its id.
create or replace function public.job_hold_save(p_id uuid, p_org uuid, p_label text, p_day date, p_until date, p_note text)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare v_id uuid;
begin
  if not public.can('bookings', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_day is null then raise exception 'pick a day'; end if;
  if p_org is null and coalesce(btrim(p_label), '') = '' then raise exception 'say who the hold is for'; end if;
  if p_id is null then
    insert into public.job_holds (org_id, label, day, hold_until, note)
    values (p_org, coalesce(btrim(p_label), ''), p_day, p_until, coalesce(btrim(p_note), ''))
    returning id into v_id;
  else
    update public.job_holds set org_id = p_org, label = coalesce(btrim(p_label), ''), day = p_day, hold_until = p_until,
           note = coalesce(btrim(p_note), ''), updated_at = now(), calendar_status = 'pending', calendar_attempts = 0
     where id = p_id and released_at is null
    returning id into v_id;
    if v_id is null then raise exception 'that hold is gone'; end if;
  end if;
  perform public.booking_poke('calendar-write', jsonb_build_object('hold_id', v_id));
  return v_id;
end $$;

-- Let a hold go (or mark it booked, when p_booking is the job it became).
create or replace function public.job_hold_release(p_id uuid, p_booking uuid default null)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if not public.can('bookings', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.job_holds set released_at = now(), booking_id = p_booking, updated_at = now(),
         calendar_status = case when google_event_id is null then 'deleted' else 'remove' end, calendar_attempts = 0
   where id = p_id and released_at is null;
  perform public.booking_poke('calendar-write', jsonb_build_object('hold_id', p_id));
end $$;

-- The Schedule's (and the Jobs calendar's) "From Google Calendar" list leaves out the holds' own events, like bookings'.
create or replace function public.schedule_calendar(p_from date, p_to date)
 returns table(event_id text, summary text, start_date date, end_date date, all_day boolean, start_at timestamp with time zone, end_at timestamp with time zone, off_user uuid)
 language sql
 stable security definer
 set search_path to ''
as $function$
  with ev as (
    select c.google_event_id, btrim(coalesce(c.summary, '')) as summary, c.start_date, coalesce(c.end_date, c.start_date) as end_date,
           coalesce(c.all_day, c.start_at is null) as all_day, c.start_at, c.end_at
      from public.calendar_events c
     where c.start_date < p_to and coalesce(c.end_date, c.start_date) >= p_from and btrim(coalesce(c.summary, '')) <> ''
  ), bk as (
    select x.day, lower(x.title) as title, lower(regexp_replace(split_part(x.title, ' • ', 1), '\s*\(.*\)$', '')) as org
      from public.schedule_booking_days(p_from - 14, p_to + 14) x
  ), offname as (
    select ev.google_event_id, lower(btrim(m[1])) as who
      from ev cross join lateral regexp_match(ev.summary, '^\W*([A-Za-z][A-Za-z.''-]*(?:\s+[A-Za-z][A-Za-z.''-]*)?)\s+off\M', 'i') m
  )
  select ev.google_event_id, ev.summary, ev.start_date, ev.end_date, ev.all_day, ev.start_at, ev.end_at,
         (select case when count(*) = 1 then min(tm.user_id::text)::uuid end
            from public.team_members tm join offname o on o.google_event_id = ev.google_event_id
           where tm.active and (lower(public.staff_name(tm.user_id)) = o.who or lower(split_part(public.staff_name(tm.user_id), ' ', 1)) = o.who))
    from ev
   where not exists (select 1 from public.bookings b where b.google_event_id = split_part(ev.google_event_id, '@', 1))
     and not exists (select 1 from public.booking_days d where d.google_event_id = split_part(ev.google_event_id, '@', 1))
     and not exists (select 1 from public.job_holds h where h.google_event_id = split_part(ev.google_event_id, '@', 1))
     and not exists (select 1 from bk where bk.day between ev.start_date and ev.end_date
                       and ((length(bk.org) >= 5 and position(bk.org in lower(ev.summary)) > 0) or position(bk.title in lower(ev.summary)) > 0))
$function$;
revoke all on function public.schedule_calendar(date, date) from public, anon, authenticated;

revoke all on function public.job_holds_list(date, date) from public, anon;
revoke all on function public.job_hold_save(uuid, uuid, text, date, date, text) from public, anon;
revoke all on function public.job_hold_release(uuid, uuid) from public, anon;
grant execute on function public.job_holds_list(date, date) to authenticated;
grant execute on function public.job_hold_save(uuid, uuid, text, date, date, text) to authenticated;
grant execute on function public.job_hold_release(uuid, uuid) to authenticated;
