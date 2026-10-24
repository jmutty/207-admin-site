-- Holds: a day penciled in for a partner before it's booked (2026-10-24, Jeremiah, jobs calendar review item S).
-- "I'll keep 5/9 for you" shows on the Jobs calendar as a striped chip so the day isn't given away twice.
-- A hold can be tied to a partner (Book it then starts the booking with that partner and day) or just carry a
-- label. Hold until is optional; after it the hold shows as expired. Released holds stay in the table
-- (released_at) and stop showing. Read and written only through the functions below.

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
  booking_id uuid references public.bookings(id) on delete set null
);
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
           'created_by_name', public.staff_name(h.created_by)) order by h.day, h.created_at), '[]'::jsonb)
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
           note = coalesce(btrim(p_note), ''), updated_at = now()
     where id = p_id and released_at is null
    returning id into v_id;
    if v_id is null then raise exception 'that hold is gone'; end if;
  end if;
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
  update public.job_holds set released_at = now(), booking_id = p_booking, updated_at = now() where id = p_id and released_at is null;
end $$;

revoke all on function public.job_holds_list(date, date) from public, anon;
revoke all on function public.job_hold_save(uuid, uuid, text, date, date, text) from public, anon;
revoke all on function public.job_hold_release(uuid, uuid) from public, anon;
grant execute on function public.job_holds_list(date, date) to authenticated;
grant execute on function public.job_hold_save(uuid, uuid, text, date, date, text) to authenticated;
grant execute on function public.job_hold_release(uuid, uuid) to authenticated;
