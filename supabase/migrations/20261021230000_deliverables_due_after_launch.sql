-- Deliverable due dates count from the job's launch (2026-10-21).
--
-- Deliverables are only owed once the job is launched on GotPhoto, so "due N days" now means N days after
-- the booking reaches its type's Job launched stage (auto = 'gallery_live', or any stage after it), not
-- after the last picture day. A deliverable picked before launch keeps its due_days and has no due date
-- until then; the stage move that launches the job fills the dates in. A date typed by hand still wins.

alter table public.booking_deliverables add column due_days int check (due_days between 0 and 365);
comment on column public.booking_deliverables.due_days is 'Due this many days after the job is launched; due_date is filled in at launch.';
comment on column public.deliverable_templates.due_days is 'Due this many days after the job is launched on GotPhoto.';

-- The day the booking first reached Job launched (or a later stage). Null while not launched.
create function public.booking_launch_date(p_booking uuid) returns date
language sql stable security definer set search_path to 'public' as $$
  select (min(e.at) at time zone 'America/New_York')::date
    from booking_stage_events e
    join booking_stages s on s.id = e.stage_id
    join booking_stages l on l.type_key = s.type_key and l.auto = 'gallery_live' and l.archived_at is null
   where e.booking_id = p_booking and s.sort >= l.sort;
$$;

-- Give undated deliverables their date once the job is launched.
create function public.booking_deliverables_date(p_booking uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_launch date := public.booking_launch_date(p_booking);
begin
  if v_launch is null then return; end if;
  update booking_deliverables set due_date = v_launch + due_days
   where booking_id = p_booking and due_date is null and due_days is not null and status = 'todo';
end $$;

create or replace function public.booking_stage_move(p_booking uuid, p_stage uuid, p_auto boolean, p_note text default null) returns void
language plpgsql security definer set search_path to 'public' as $$
declare s booking_stages;
begin
  select * into s from booking_stages where id = p_stage;
  insert into booking_progress (booking_id, stage_id, stage_at) values (p_booking, p_stage, now())
  on conflict (booking_id) do update set stage_id = excluded.stage_id, stage_at = excluded.stage_at;
  insert into booking_stage_events (booking_id, stage_id, label, auto, by_user, note)
  values (p_booking, p_stage, coalesce(s.label, '(stage)'), p_auto, case when p_auto then null else auth.uid() end, nullif(btrim(p_note), ''));
  perform public.booking_deliverables_date(p_booking);
end $$;

-- Same as before, except the due date counts from launch (none yet if the job is not launched).
create or replace function public.booking_deliverables_add(p_booking uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare b bookings; it jsonb; t deliverable_templates; v_launch date; v_label text; v_due date; v_sort int; n int := 0; v_days int;
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking;
  if b.id is null then return jsonb_build_object('ok', false, 'error', 'Booking not found.'); end if;
  if jsonb_typeof(p_items) <> 'array' then return jsonb_build_object('ok', false, 'error', 'Nothing to add.'); end if;
  v_launch := public.booking_launch_date(p_booking);
  select coalesce(max(sort), 0) into v_sort from booking_deliverables where booking_id = p_booking;
  for it in select * from jsonb_array_elements(p_items) loop
    t := null; v_days := null;
    if nullif(it->>'template_id', '') is not null then
      select * into t from deliverable_templates where id = (it->>'template_id')::uuid and (type_key is null or type_key = b.type_key);
      if t.id is null then continue; end if;
      v_label := t.label;
    else
      v_label := btrim(coalesce(it->>'label', ''));
      if v_label = '' then continue; end if;
      v_days := nullif(it->>'due_days', '')::int;
      if coalesce((it->>'save')::boolean, false) then
        select * into t from deliverable_templates where archived_at is null and (type_key is null or type_key = b.type_key) and lower(btrim(label)) = lower(v_label)
         order by type_key nulls last limit 1;
        if t.id is null then
          insert into deliverable_templates (type_key, label, note, due_days, sort, created_by)
          values (b.type_key, v_label, nullif(btrim(it->>'note'), ''), v_days,
                  (select coalesce(max(sort), 0) + 10 from deliverable_templates where type_key = b.type_key), auth.uid())
          returning * into t;
        end if;
      end if;
    end if;
    if exists (select 1 from booking_deliverables d where d.booking_id = p_booking and ((t.id is not null and d.template_id = t.id) or lower(btrim(d.label)) = lower(v_label))) then continue; end if;
    v_due := nullif(it->>'due_date', '')::date;
    v_days := case when v_due is null then coalesce(t.due_days, v_days) end;
    if v_due is null then v_due := v_launch + v_days; end if;
    v_sort := v_sort + 10;
    insert into booking_deliverables (booking_id, template_id, label, note, due_date, due_days, sort, created_by)
    values (p_booking, t.id, v_label, coalesce(nullif(btrim(it->>'note'), ''), t.note), v_due, v_days, v_sort, auth.uid());
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'added', n);
end $$;

revoke all on function public.booking_launch_date(uuid), public.booking_deliverables_date(uuid) from public, anon, authenticated;
