-- Editing time for the Lead (2026-10-24, Jeremiah). Every Lead job bar on a booked job gets its own Flex time
-- bar titled "Editing: <job>". Length: the first hour of shooting counts 1:1, every hour after that 30 min
-- (2 h shoot = 1.5 h editing), rounded up to 15 min. Shooting time is the bar itself (starts_at..ends_at): no
-- setup, teardown or drive. Due 24 hours after the shoot ends.
-- Where it goes: right after they get home (the end of the trip, drive included) if it fits before 9pm that day;
-- else the next morning from 8am, ending by the due time (so before they leave for anything else); else the first
-- gap that next day; else 8am next day anyway. Flex time is the Lead's own to move, resize or remove.
-- Kept in step: when the job bar changes (time, person, role, trip) the editing bar is placed again, unless the
-- Lead already moved it themselves (edit_moved); then only its length follows the job. No longer Lead, job not
-- booked or the job bar removed = the editing bar goes. Each day of a multi-day job is its own job bar, so each
-- day gets its own editing bar. Upcoming Lead bars get theirs when this runs; past jobs don't.
-- Editor (Jeremiah, same day): a job can have an Editor picked (bookings.editor_id, set on the job page). Then the
-- editing time goes on the Editor's schedule instead, from when the Lead gets home (the photos come home with them).

alter table public.schedule_entries
  add column edit_for uuid unique references public.schedule_entries (id) on delete cascade,
  add column edit_due timestamptz,
  add column edit_min integer,
  add column edit_moved boolean not null default false;
comment on column public.schedule_entries.edit_for is 'Editing time: the Lead job bar this flex bar was made for';
alter table public.bookings add column editor_id uuid references public.team_members (user_id) on delete set null;
comment on column public.bookings.editor_id is 'Who edits this job (gets the editing time); empty = the Lead';
comment on column public.schedule_entries.edit_moved is 'Editing time: the person moved it, so it is not placed again';

-- Minutes of editing for a shoot of p_min minutes
create function public.edit_minutes(p_min integer) returns integer
language sql immutable set search_path to '' as $$
  select greatest(15, (ceil((case when p_min <= 60 then p_min else 60 + (p_min - 60) / 2.0 end) / 15.0) * 15)::int)
$$;

-- Up to the next quarter hour
create function public.edit_q(p_at timestamptz) returns timestamptz
language sql immutable set search_path to '' as $$
  select to_timestamp(ceil(extract(epoch from p_at) / 900) * 900)
$$;

-- First start at or after p_from where p_user has p_min free minutes ending by p_to (null if none).
-- Busy = every other bar of theirs, with its drive, setup and teardown.
create function public.edit_slot(p_user uuid, p_from timestamptz, p_to timestamptz, p_min integer, p_skip uuid)
returns timestamptz language plpgsql stable security definer set search_path to '' as $$
declare v_at timestamptz := public.edit_q(p_from); v_len interval := make_interval(mins => p_min); r record;
begin
  if p_to is null or p_from >= p_to then return null; end if;
  for r in select e.starts_at - make_interval(mins => e.drive_before_min + e.setup_min) as s,
                  e.ends_at + make_interval(mins => e.drive_after_min + e.teardown_min) as z
             from public.schedule_entries e
            where e.user_id = p_user and e.id is distinct from p_skip
              and e.ends_at + make_interval(mins => e.drive_after_min + e.teardown_min) > v_at
              and e.starts_at - make_interval(mins => e.drive_before_min + e.setup_min) < p_to
            order by 1 loop
    exit when r.s >= v_at + v_len;
    if r.z > v_at then v_at := public.edit_q(r.z); end if;
  end loop;
  return case when v_at + v_len <= p_to then v_at end;
end $$;

-- Make, place, resize or remove the editing bar for one job bar
create function public.edit_sync(p_job uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare
  j public.schedule_entries; x public.schedule_entries;
  v_len int; v_due timestamptz; v_home timestamptz; v_day date; v_at timestamptz; v_title text; v_who uuid;
  v_tz text := 'America/New_York';
begin
  select * into j from public.schedule_entries where id = p_job;
  select * into x from public.schedule_entries where edit_for = p_job;
  if j.id is null or j.kind <> 'job'
     or not exists (select 1 from public.crew_roles r where r.id = j.role_id and lower(btrim(r.label)) = 'lead')
     or not exists (select 1 from public.bookings b where b.id = j.booking_id and b.status = 'booked') then
    if x.id is not null then delete from public.schedule_entries where id = x.id; end if;
    return;
  end if;
  if x.id is null and j.ends_at < now() then return; end if;  -- nothing new for past jobs

  v_len := public.edit_minutes((extract(epoch from j.ends_at - j.starts_at) / 60)::int);
  v_due := j.ends_at + interval '24 hours';
  v_title := left('Editing: ' || public.schedule_entry_label('job', j.booking_id, null), 120);
  select coalesce(m.user_id, j.user_id) into v_who
    from public.bookings b left join public.team_members m on m.user_id = b.editor_id and m.active where b.id = j.booking_id;
  perform set_config('aca.edit_sync', 'on', true);

  if x.id is not null and x.edit_moved and x.user_id = v_who then
    update public.schedule_entries
       set ends_at = case when x.edit_min is distinct from v_len then starts_at + make_interval(mins => v_len) else ends_at end,
           edit_min = v_len, edit_due = v_due, title = v_title, updated_at = now()
     where id = x.id
       and (x.edit_min is distinct from v_len or x.edit_due is distinct from v_due or x.title is distinct from v_title);
  else
    -- home = the end of their trip that day (the last bar of a batch drives home)
    select max(e.ends_at + make_interval(mins => e.teardown_min + e.drive_after_min)) into v_home
      from public.schedule_entries e
     where e.user_id = j.user_id and e.kind = 'job' and (e.id = j.id or (j.batch_id is not null and e.batch_id = j.batch_id));
    v_day := (j.ends_at at time zone v_tz)::date;
    v_at := coalesce(
      public.edit_slot(v_who, v_home, (v_day + time '21:00') at time zone v_tz, v_len, x.id),
      public.edit_slot(v_who, (v_day + 1 + time '08:00') at time zone v_tz, least(v_due, (v_day + 1 + time '21:00') at time zone v_tz), v_len, x.id),
      public.edit_slot(v_who, (v_day + 1 + time '08:00') at time zone v_tz, (v_day + 1 + time '21:00') at time zone v_tz, v_len, x.id),
      (v_day + 1 + time '08:00') at time zone v_tz);
    if x.id is null then
      insert into public.schedule_entries (user_id, kind, starts_at, ends_at, title, note, edit_for, edit_due, edit_min)
      values (v_who, 'flex', v_at, v_at + make_interval(mins => v_len), v_title,
              'Added automatically. Move it to whenever suits you before it is due.', j.id, v_due, v_len);
    elsif x.user_id is distinct from v_who or x.starts_at is distinct from v_at or x.edit_min is distinct from v_len
          or x.edit_due is distinct from v_due or x.title is distinct from v_title then
      update public.schedule_entries
         set user_id = v_who, starts_at = v_at, ends_at = v_at + make_interval(mins => v_len), title = v_title,
             edit_due = v_due, edit_min = v_len, edit_moved = false, updated_at = now()
       where id = x.id;
    end if;
  end if;
  perform set_config('aca.edit_sync', '', true);
end $$;
revoke all on function public.edit_slot(uuid, timestamptz, timestamptz, integer, uuid) from public, anon, authenticated;
revoke all on function public.edit_sync(uuid) from public, anon, authenticated;

-- An editing bar the person moves or resizes themselves stays where they put it.
create function public.edit_entry_moved() returns trigger
language plpgsql set search_path to '' as $$
begin
  if old.edit_for is not null then
    if new.kind <> 'flex' then
      new.edit_for := null; new.edit_due := null; new.edit_min := null;  -- made into something else: no longer editing time
    elsif coalesce(current_setting('aca.edit_sync', true), '') <> 'on'
          and (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at) then
      new.edit_moved := true;
    end if;
  end if;
  return new;
end $$;
create trigger schedule_entries_edit_moved before update on public.schedule_entries
  for each row execute function public.edit_entry_moved();

-- A job bar changed: keep its editing bar in step. (Removing the job bar removes it through edit_for.)
create function public.edit_job_changed() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  begin
    if new.kind = 'job' or (tg_op = 'UPDATE' and old.kind = 'job') then
      if tg_op = 'INSERT' or new.kind is distinct from old.kind or new.user_id is distinct from old.user_id
         or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
         or new.role_id is distinct from old.role_id or new.booking_id is distinct from old.booking_id
         or new.batch_id is distinct from old.batch_id or new.teardown_min is distinct from old.teardown_min
         or new.drive_after_min is distinct from old.drive_after_min then
        perform public.edit_sync(new.id);
      end if;
    end if;
  exception when others then raise warning 'edit_job_changed: %', sqlerrm;  -- never block a schedule change
  end;
  return null;
end $$;
create trigger schedule_entries_edit_sync after insert or update on public.schedule_entries
  for each row execute function public.edit_job_changed();

-- A booking was cancelled, booked again or renamed: its Lead bars follow.
create function public.edit_booking_changed() returns trigger
language plpgsql security definer set search_path to '' as $$
declare r record;
begin
  begin
    if new.status is distinct from old.status or new.title_override is distinct from old.title_override
       or new.title_label is distinct from old.title_label or new.org_id is distinct from old.org_id
       or new.editor_id is distinct from old.editor_id then
      for r in select e.id from public.schedule_entries e where e.booking_id = new.id and e.kind = 'job' order by e.ends_at loop
        perform public.edit_sync(r.id);
      end loop;
    end if;
  exception when others then raise warning 'edit_booking_changed: %', sqlerrm;  -- never block a booking change
  end;
  return null;
end $$;
create trigger bookings_edit_sync after update on public.bookings
  for each row execute function public.edit_booking_changed();

-- schedule_week: entries carry the due time and whether it's editing time
create function pg_temp.patch_function(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;
select pg_temp.patch_function('public.schedule_week(date,integer)'::regprocedure,
  '''role_id'', e\.role_id, ',
  '''role_id'', e.role_id, ''edit_for'', e.edit_for, ''edit_due'', e.edit_due, ''edit_moved'', e.edit_moved, ', 1);

-- Pick (or clear) the job's Editor: the editing time moves to them
create function public.job_editor_set(p_booking uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user is not null and not exists (select 1 from public.team_members where user_id = p_user and active) then raise exception 'Pick someone on the team.'; end if;
  update public.bookings set editor_id = p_user, updated_at = now() where id = p_booking;
  if not found then raise exception 'That job is gone. Reload the page.'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.job_editor_set(uuid, uuid) from public, anon;
grant execute on function public.job_editor_set(uuid, uuid) to authenticated;

-- job_get: the Editor, and who can be picked (for people who can change the schedule)
select pg_temp.patch_function('public.job_get(uuid)'::regprocedure,
  '''access_code'', case when v_bk then b\.access_code end\)',
  '''access_code'', case when v_bk then b.access_code end, ''editor_id'', b.editor_id, ''editor_name'', public.staff_name(b.editor_id))', 1);
select pg_temp.patch_function('public.job_get(uuid)'::regprocedure,
  '''can'', jsonb_build_object\(',
  '''editor_options'', case when public.can(''scheduling'', ''edit'') then (select coalesce(jsonb_agg(jsonb_build_object(''user_id'', m.user_id, ''name'', public.staff_name(m.user_id)) order by lower(public.staff_name(m.user_id))), ''[]''::jsonb) from public.team_members m where m.active) end,
    ''can'', jsonb_build_object(', 1);

-- Upcoming Lead bars get their editing time now, earliest first
do $$
declare r record;
begin
  for r in select e.id from public.schedule_entries e join public.crew_roles c on c.id = e.role_id and lower(btrim(c.label)) = 'lead'
            where e.kind = 'job' and e.ends_at > now() order by e.ends_at loop
    perform public.edit_sync(r.id);
  end loop;
end $$;
