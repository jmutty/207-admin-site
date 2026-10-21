-- Schedule time types (2026-10-22): besides On site job (kind 'job', with drive time) and Time off, a bar can
-- be Studio (in-studio sessions), Admin (editing, office work) or Other ('work', the original catch-all).
-- Studio / Admin / Other count toward hours like work did; only jobs carry drive time.

alter table public.schedule_entries drop constraint schedule_entries_kind_check;
alter table public.schedule_entries add constraint schedule_entries_kind_check check (kind in ('job', 'studio', 'admin', 'work', 'off'));

-- Add or change a bar. p = {id?, user_id, kind, booking_id?, starts_at, ends_at, drive_before_min?, drive_after_min?, title?, note?}
create or replace function public.schedule_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_kind text := p ->> 'kind';
  v_booking uuid := nullif(p ->> 'booking_id', '')::uuid;
  v_start timestamptz := nullif(p ->> 'starts_at', '')::timestamptz;
  v_end timestamptz := nullif(p ->> 'ends_at', '')::timestamptz;
  v_db int := coalesce(nullif(p ->> 'drive_before_min', '')::int, 0);
  v_da int := coalesce(nullif(p ->> 'drive_after_min', '')::int, 0);
  v_overlaps int;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_kind is null or v_kind not in ('job', 'studio', 'admin', 'work', 'off') then raise exception 'Pick what kind of time this is.'; end if;
  if v_user is null or not exists (select 1 from public.team_members where user_id = v_user and active) then raise exception 'Pick someone on the team.'; end if;
  if v_start is null or v_end is null or v_end <= v_start then raise exception 'The end has to be after the start.'; end if;
  if v_end - v_start > (case when v_kind = 'off' then interval '15 days' else interval '24 hours' end) then
    raise exception 'That is too long for one bar.';
  end if;
  if v_kind = 'job' then
    if v_booking is null or not exists (select 1 from public.bookings where id = v_booking) then raise exception 'Pick the job.'; end if;
    if v_db not between 0 and 600 or v_da not between 0 and 600 then raise exception 'Drive time is 0 to 600 minutes each way.'; end if;
  else
    v_booking := null; v_db := 0; v_da := 0;
  end if;

  if v_id is not null then
    update public.schedule_entries
       set user_id = v_user, kind = v_kind, booking_id = v_booking, starts_at = v_start, ends_at = v_end,
           drive_before_min = v_db, drive_after_min = v_da,
           title = left(btrim(coalesce(p ->> 'title', '')), 120), note = left(coalesce(p ->> 'note', ''), 1000), updated_at = now()
     where id = v_id;
    if not found then raise exception 'That bar was already removed. Reload the week.'; end if;
  else
    insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at, drive_before_min, drive_after_min, title, note, created_by)
    values (v_user, v_kind, v_booking, v_start, v_end, v_db, v_da, left(btrim(coalesce(p ->> 'title', '')), 120), left(coalesce(p ->> 'note', ''), 1000), (select auth.uid()))
    returning id into v_id;
  end if;

  select count(*) into v_overlaps from public.schedule_entries o
   where o.user_id = v_user and o.id <> v_id
     and o.starts_at - make_interval(mins => o.drive_before_min) < v_end + make_interval(mins => v_da)
     and o.ends_at + make_interval(mins => o.drive_after_min) > v_start - make_interval(mins => v_db);
  return jsonb_build_object('ok', true, 'id', v_id, 'overlaps', v_overlaps);
end $$;

-- The evening notification names Studio / Admin time.
create or replace function public.day_plan_text(p_uid uuid, p_day date, p_tomorrow boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'America/New_York';
  v_to timestamptz := (p_day + 1)::timestamp at time zone 'America/New_York';
  v_lines text[] := '{}'; v_jobs int := 0; v_tasks text[]; v_title text; r record;
  fmt constant text := 'FMHH12:MIam';
begin
  for r in select e.*, case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) end as btitle
             from public.schedule_entries e
            where e.user_id = p_uid and e.starts_at < v_to and e.ends_at > v_from
              and (e.booking_id is null or exists (select 1 from public.bookings b where b.id = e.booking_id and b.status <> 'cancelled'))
            order by e.starts_at loop
    if r.kind = 'job' then
      v_jobs := v_jobs + 1;
      v_lines := v_lines || (to_char(r.starts_at at time zone 'America/New_York', fmt) || ' ' || coalesce(nullif(r.title, ''), r.btitle) ||
        case when r.drive_before_min > 0 then ' (leave ' || to_char((r.starts_at - make_interval(mins => r.drive_before_min)) at time zone 'America/New_York', fmt) || ')' else '' end);
    elsif r.kind in ('studio', 'admin', 'work') then
      v_lines := v_lines || (to_char(r.starts_at at time zone 'America/New_York', fmt) || '-' || to_char(r.ends_at at time zone 'America/New_York', fmt) || ' ' ||
        coalesce(nullif(r.title, ''), case r.kind when 'studio' then 'Studio' when 'admin' then 'Admin' else 'Work' end));
    else
      v_lines := v_lines || ('Off' || case when r.title <> '' then ': ' || r.title else '' end);
    end if;
  end loop;
  -- Tasks still open by then. Urgent ones first.
  select array_agg(i.title || case when i.priority = 'urgent' then ' (urgent)' when i.overdue then ' (overdue)' else '' end
                   order by i.priority = 'urgent' desc, i.overdue desc, lower(i.title)) into v_tasks
    from public.staff_task_items(p_day, array[p_uid]) i where i.done_at is null;
  if cardinality(v_lines) = 0 and coalesce(cardinality(v_tasks), 0) = 0 then return null; end if;
  v_title := case when p_tomorrow then 'Tomorrow (' || to_char(p_day, 'FMDay') || ')' else 'Today (' || to_char(p_day, 'FMDay') || ')' end;
  if v_jobs > 0 or coalesce(cardinality(v_tasks), 0) > 0 then
    v_title := v_title || ': ' || concat_ws(', ',
      case when v_jobs = 1 then '1 job' when v_jobs > 1 then v_jobs || ' jobs' end,
      case when cardinality(v_tasks) = 1 then '1 task' when cardinality(v_tasks) > 1 then cardinality(v_tasks) || ' tasks' end);
  end if;
  return jsonb_build_object('title', v_title,
    'body', left(array_to_string(v_lines || case when cardinality(v_tasks) > 0 then array['To do: ' || array_to_string(v_tasks, ', ')] else '{}'::text[] end, '. '), 300));
end $$;
