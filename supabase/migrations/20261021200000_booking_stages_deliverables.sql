-- Job stages and deliverables on bookings (2026-10-21).
--
-- Each job type has its own list of stages (booking_stages), seeded with:
--   Booked -> Picture day done -> In production -> Job launched -> Deliverables sent -> Complete
-- A booking's place in that list lives in booking_progress (one row per booking), and every move is
-- logged in booking_stage_events. Four stages can tick themselves (booking_stages.auto), always forward:
--   booked            when the booking is created
--   picture_day       the morning after the last picture day           (cron, booking_stages_tick)
--   gallery_live      when the GotPhoto gallery is activated            (cron, booking_stages_tick)
--   deliverables_done when every deliverable is done or skipped         (trigger on booking_deliverables)
--
-- Deliverables are what is owed to the client after the job. booking_deliverables is each booking's
-- checklist; deliverable_templates are the saved ones per job type (type_key null = every type), offered
-- as one-click picks and copied onto the booking (editing a template never changes past bookings).
--
-- Everything sits behind the existing `bookings` module: view to see, edit to change. Bookings
-- themselves are not altered; the new data hangs off them, so the email, calendar and hub code is untouched.

-- ---------------------------------------------------------------- tables
create table public.booking_stages (
  id          uuid primary key default gen_random_uuid(),
  type_key    text not null references public.booking_types (key) on update cascade on delete cascade,
  label       text not null check (btrim(label) <> '' and length(label) <= 60),
  sort        int  not null default 100,
  auto        text check (auto in ('booked', 'picture_day', 'gallery_live', 'deliverables_done')),
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
comment on table public.booking_stages is 'The stages a job of each type moves through, in sort order. auto = the event that ticks the stage by itself. Archive, never delete.';
create unique index booking_stages_auto_uq on public.booking_stages (type_key, auto) where auto is not null and archived_at is null;
create index booking_stages_type_idx on public.booking_stages (type_key, sort);

create table public.booking_progress (
  booking_id         uuid primary key references public.bookings (id) on delete cascade,
  stage_id           uuid references public.booking_stages (id) on delete set null,
  stage_at           timestamptz,
  deliverables_total int  not null default 0,
  deliverables_open  int  not null default 0,
  next_due           date
);
comment on table public.booking_progress is 'Per booking: the current stage and a deliverables summary (kept by triggers) for the bookings list.';

create table public.booking_stage_events (
  id         bigint generated always as identity primary key,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  stage_id   uuid references public.booking_stages (id) on delete set null,
  label      text not null,          -- the stage's name at the time
  auto       boolean not null default false,
  by_user    uuid,
  note       text,
  at         timestamptz not null default now()
);
comment on table public.booking_stage_events is 'Every stage move of every booking (auto = ticked by itself).';
create index booking_stage_events_booking_idx on public.booking_stage_events (booking_id, at);

create table public.deliverable_templates (
  id          uuid primary key default gen_random_uuid(),
  type_key    text references public.booking_types (key) on update cascade on delete cascade,  -- null = every job type
  label       text not null check (btrim(label) <> '' and length(label) <= 120),
  note        text,
  due_days    int check (due_days between 0 and 365),   -- due this many days after the last picture day
  auto_add    boolean not null default false,           -- ticked by default when booking a job of this type
  sort        int not null default 100,
  archived_at timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
comment on table public.deliverable_templates is 'Saved deliverables per job type, offered when booking a job. Copied onto the booking, so edits only affect future picks.';
create unique index deliverable_templates_label_uq on public.deliverable_templates (coalesce(type_key, ''), lower(btrim(label))) where archived_at is null;

create table public.booking_deliverables (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings (id) on delete cascade,
  template_id uuid references public.deliverable_templates (id) on delete set null,
  label       text not null check (btrim(label) <> '' and length(label) <= 120),
  note        text,
  due_date    date,
  status      text not null default 'todo' check (status in ('todo', 'done', 'skipped')),
  link        text check (link ~* '^https?://'),
  sort        int not null default 100,
  done_at     timestamptz,
  done_by     uuid,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
comment on table public.booking_deliverables is 'What is owed to the client for a booking, ticked off as it goes out.';
create index booking_deliverables_booking_idx on public.booking_deliverables (booking_id, sort);
create index booking_deliverables_due_idx on public.booking_deliverables (due_date) where status = 'todo';

-- ---------------------------------------------------------------- access
-- Stages and saved deliverables are edited directly (Bookings > Job types), like booking_steps.
-- Progress, events and a booking's deliverables change only through the RPCs below.
alter table public.booking_stages        enable row level security;
alter table public.booking_progress      enable row level security;
alter table public.booking_stage_events  enable row level security;
alter table public.deliverable_templates enable row level security;
alter table public.booking_deliverables  enable row level security;
revoke all on public.booking_stages, public.booking_progress, public.booking_stage_events, public.deliverable_templates, public.booking_deliverables from anon, authenticated;
grant select, insert, update on public.booking_stages, public.deliverable_templates to authenticated;
grant select on public.booking_progress, public.booking_stage_events, public.booking_deliverables to authenticated;

create policy booking_stages_read  on public.booking_stages for select to authenticated using (public.can_any('{bookings}', 'view'));
create policy booking_stages_write on public.booking_stages for insert to authenticated with check (public.can_any('{bookings}', 'edit'));
create policy booking_stages_edit  on public.booking_stages for update to authenticated using (public.can_any('{bookings}', 'edit')) with check (public.can_any('{bookings}', 'edit'));
create policy deliverable_templates_read  on public.deliverable_templates for select to authenticated using (public.can_any('{bookings}', 'view'));
create policy deliverable_templates_write on public.deliverable_templates for insert to authenticated with check (public.can_any('{bookings}', 'edit'));
create policy deliverable_templates_edit  on public.deliverable_templates for update to authenticated using (public.can_any('{bookings}', 'edit')) with check (public.can_any('{bookings}', 'edit'));
create policy booking_progress_read      on public.booking_progress      for select to authenticated using (public.can_any('{bookings}', 'view'));
create policy booking_stage_events_read  on public.booking_stage_events  for select to authenticated using (public.can_any('{bookings}', 'view'));
create policy booking_deliverables_read  on public.booking_deliverables  for select to authenticated using (public.can_any('{bookings}', 'view'));

-- ---------------------------------------------------------------- stages: seed + new job types
create function public.booking_stages_seed(p_type text) returns void
language sql security definer set search_path to 'public' as $$
  insert into booking_stages (type_key, label, sort, auto)
  select p_type, s.label, s.sort, s.auto
    from (values ('Booked', 10, 'booked'), ('Picture day done', 20, 'picture_day'), ('In production', 30, null),
                 ('Job launched', 40, 'gallery_live'), ('Deliverables sent', 50, 'deliverables_done'), ('Complete', 60, null)) s (label, sort, auto)
   where not exists (select 1 from booking_stages x where x.type_key = p_type);
$$;
select public.booking_stages_seed(key) from public.booking_types;

create function public.booking_types_seed_stages() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.booking_stages_seed(new.key);
  return new;
end $$;
create trigger booking_types_seed_stages after insert on public.booking_types for each row execute function public.booking_types_seed_stages();

-- ---------------------------------------------------------------- moving a booking between stages
-- The one place a stage changes. p_auto = ticked by itself (logged without a person).
create function public.booking_stage_move(p_booking uuid, p_stage uuid, p_auto boolean, p_note text default null) returns void
language plpgsql security definer set search_path to 'public' as $$
declare s booking_stages;
begin
  select * into s from booking_stages where id = p_stage;
  insert into booking_progress (booking_id, stage_id, stage_at) values (p_booking, p_stage, now())
  on conflict (booking_id) do update set stage_id = excluded.stage_id, stage_at = excluded.stage_at;
  insert into booking_stage_events (booking_id, stage_id, label, auto, by_user, note)
  values (p_booking, p_stage, coalesce(s.label, '(stage)'), p_auto, case when p_auto then null else auth.uid() end, nullif(btrim(p_note), ''));
end $$;

-- Tick the booking's `p_auto` stage if it is further along than where the booking is now. Never moves back.
create function public.booking_stage_auto(p_booking uuid, p_auto text) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare b bookings; v_target booking_stages; v_cur_sort int;
begin
  select * into b from bookings where id = p_booking;
  if b.id is null or b.status = 'cancelled' then return false; end if;
  select * into v_target from booking_stages where type_key = b.type_key and auto = p_auto and archived_at is null;
  if v_target.id is null then return false; end if;
  select s.sort into v_cur_sort from booking_progress p join booking_stages s on s.id = p.stage_id and s.type_key = b.type_key where p.booking_id = p_booking;
  if v_cur_sort is not null and v_cur_sort >= v_target.sort then return false; end if;
  perform public.booking_stage_move(p_booking, v_target.id, true);
  return true;
end $$;

-- New bookings start at their type's "booked" stage (or its first stage).
create function public.bookings_progress_start() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_stage uuid;
begin
  begin
    select id into v_stage from booking_stages where type_key = new.type_key and archived_at is null
     order by (auto = 'booked') desc nulls last, sort limit 1;
    if v_stage is not null then perform public.booking_stage_move(new.id, v_stage, true);
    else insert into booking_progress (booking_id) values (new.id) on conflict do nothing; end if;
  exception when others then raise warning 'bookings_progress_start: %', sqlerrm;  -- never block a booking
  end;
  return new;
end $$;
create trigger bookings_progress_start after insert on public.bookings for each row execute function public.bookings_progress_start();

-- Existing bookings: start them at Booked (picture_day / gallery_live catch up on the first tick).
select public.booking_stage_move(b.id, s.id, true)
  from public.bookings b
  join lateral (select id from public.booking_stages x where x.type_key = b.type_key and x.archived_at is null
                 order by (x.auto = 'booked') desc nulls last, x.sort limit 1) s on true
 where not exists (select 1 from public.booking_progress p where p.booking_id = b.id);

-- Every 15 minutes: picture day passed, gallery live. Only bookings not yet past the stage in question.
create function public.booking_stages_tick() returns int
language plpgsql security definer set search_path to 'public' as $$
declare r record; n int := 0; v_today date := (now() at time zone 'America/New_York')::date; v_last date; v_live timestamptz;
begin
  for r in
    select b.id, b.picture_day, b.type_key from bookings b
      left join booking_progress p on p.booking_id = b.id
      left join booking_stages cur on cur.id = p.stage_id
     where b.status <> 'cancelled' and b.picture_day < v_today and b.picture_day >= v_today - 365
       and exists (select 1 from booking_stages s where s.type_key = b.type_key and s.archived_at is null
                     and s.auto in ('picture_day', 'gallery_live') and s.sort > coalesce(cur.sort, -1))
  loop
    select coalesce(max(day), r.picture_day) into v_last from booking_days where booking_id = r.id and not removed;
    if v_last < v_today and public.booking_stage_auto(r.id, 'picture_day') then n := n + 1; end if;
    select max(j.gp_activated_at) into v_live from public.booking_job_info(r.id) j;
    if v_live is not null and public.booking_stage_auto(r.id, 'gallery_live') then n := n + 1; end if;
  end loop;
  return n;
end $$;
select cron.schedule('booking-stages-tick', '3,18,33,48 * * * *', 'select public.booking_stages_tick();');

-- ---------------------------------------------------------------- deliverables summary + auto tick
create function public.booking_deliverables_changed() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_booking uuid := coalesce(new.booking_id, old.booking_id); v_total int; v_open int; v_due date;
begin
  select count(*), count(*) filter (where status = 'todo'), min(due_date) filter (where status = 'todo')
    into v_total, v_open, v_due from booking_deliverables where booking_id = v_booking;
  insert into booking_progress (booking_id, deliverables_total, deliverables_open, next_due) values (v_booking, v_total, v_open, v_due)
  on conflict (booking_id) do update set deliverables_total = excluded.deliverables_total, deliverables_open = excluded.deliverables_open, next_due = excluded.next_due;
  if v_total > 0 and v_open = 0 then perform public.booking_stage_auto(v_booking, 'deliverables_done'); end if;
  return null;
end $$;
create trigger booking_deliverables_changed after insert or update or delete on public.booking_deliverables
  for each row execute function public.booking_deliverables_changed();

-- ---------------------------------------------------------------- RPCs (app)
-- Stage + deliverables summary for the bookings list (same date window as admin_bookings).
create function public.admin_booking_progress(p_from date default null, p_to date default null) returns setof jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('booking_id', b.id, 'stage_id', p.stage_id, 'stage_at', p.stage_at,
           'deliverables_total', coalesce(p.deliverables_total, 0), 'deliverables_open', coalesce(p.deliverables_open, 0), 'next_due', p.next_due,
           'overdue', (select count(*) from booking_deliverables d where d.booking_id = b.id and d.status = 'todo' and d.due_date < (now() at time zone 'America/New_York')::date))
    from bookings b left join booking_progress p on p.booking_id = b.id
   where public.can_any('{bookings}', 'view')
     and (p_from is null or b.picture_day >= p_from)
     and (p_to is null or b.picture_day <= p_to);
$$;

-- Everything the booking panel's Stage and Deliverables sections show.
create function public.admin_booking_tracking(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare b bookings; p booking_progress;
begin
  if not public.can_any('{bookings}', 'view') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into b from bookings where id = p_id;
  if b.id is null then return null; end if;
  select * into p from booking_progress where booking_id = p_id;
  return jsonb_build_object(
    'stage_id', p.stage_id, 'stage_at', p.stage_at,
    'last_day', (select coalesce(max(day), b.picture_day) from booking_days where booking_id = p_id and not removed),
    'stages', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'sort', s.sort, 'auto', s.auto, 'archived', s.archived_at is not null) order by s.sort, s.created_at), '[]'::jsonb)
                 from booking_stages s where s.type_key = b.type_key and (s.archived_at is null or s.id = p.stage_id)),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'label', e.label, 'auto', e.auto, 'note', e.note, 'at', e.at,
                        'by', coalesce(m.display_name, case when a.user_id is not null then 'Owner' end)) order by e.at desc, e.id desc), '[]'::jsonb)
                 from booking_stage_events e left join team_members m on m.user_id = e.by_user left join admin_users a on a.user_id = e.by_user
                where e.booking_id = p_id),
    'deliverables', (select coalesce(jsonb_agg(to_jsonb(d) || jsonb_build_object('done_by_name', m.display_name) order by d.sort, d.created_at), '[]'::jsonb)
                       from booking_deliverables d left join team_members m on m.user_id = d.done_by where d.booking_id = p_id),
    'templates', (select coalesce(jsonb_agg(to_jsonb(t) order by t.type_key nulls last, t.sort, t.label), '[]'::jsonb)
                    from deliverable_templates t where t.archived_at is null and (t.type_key is null or t.type_key = b.type_key)));
end $$;

-- Owner / team on Today.
create function public.admin_deliverables_attention() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select case when public.can_any('{bookings}', 'view') then jsonb_build_object(
    'overdue', (select count(*) from booking_deliverables d join bookings b on b.id = d.booking_id
                 where d.status = 'todo' and b.status <> 'cancelled' and d.due_date < (now() at time zone 'America/New_York')::date))
  else '{}'::jsonb end;
$$;

create function public.booking_set_stage(p_booking uuid, p_stage uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare b bookings; s booking_stages;
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking;
  if b.id is null then return jsonb_build_object('ok', false, 'error', 'Booking not found.'); end if;
  if b.status = 'cancelled' then return jsonb_build_object('ok', false, 'error', 'This booking is cancelled.'); end if;
  select * into s from booking_stages where id = p_stage and type_key = b.type_key and archived_at is null;
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'That stage is not one of this job type''s stages.'); end if;
  if exists (select 1 from booking_progress where booking_id = p_booking and stage_id = p_stage) then return jsonb_build_object('ok', true, 'unchanged', true); end if;
  perform public.booking_stage_move(p_booking, p_stage, false, p_note);
  return jsonb_build_object('ok', true);
end $$;

-- Add deliverables to a booking. p_items: [{"template_id": "..."} | {"label": "...", "note"?, "due_date"?, "due_days"?, "save": true}]
-- "save" keeps a typed one as a saved deliverable for the booking's job type (or reuses the saved one with that name).
-- Anything already on the booking (same saved deliverable or same name) is skipped.
create function public.booking_deliverables_add(p_booking uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare b bookings; it jsonb; t deliverable_templates; v_last date; v_label text; v_due date; v_sort int; n int := 0; v_days int;
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into b from bookings where id = p_booking;
  if b.id is null then return jsonb_build_object('ok', false, 'error', 'Booking not found.'); end if;
  if jsonb_typeof(p_items) <> 'array' then return jsonb_build_object('ok', false, 'error', 'Nothing to add.'); end if;
  select coalesce(max(day), b.picture_day) into v_last from booking_days where booking_id = p_booking and not removed;
  select coalesce(max(sort), 0) into v_sort from booking_deliverables where booking_id = p_booking;
  for it in select * from jsonb_array_elements(p_items) loop
    t := null;
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
    v_due := coalesce(nullif(it->>'due_date', '')::date, v_last + coalesce(t.due_days, v_days));
    v_sort := v_sort + 10;
    insert into booking_deliverables (booking_id, template_id, label, note, due_date, sort, created_by)
    values (p_booking, t.id, v_label, coalesce(nullif(btrim(it->>'note'), ''), t.note), v_due, v_sort, auth.uid());
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'added', n);
end $$;

-- Change one deliverable. p: any of label, note, due_date, status (todo|done|skipped), link ("" clears).
create function public.booking_deliverable_update(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare d booking_deliverables; v_status text; v_link text;
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  select * into d from booking_deliverables where id = p_id;
  if d.id is null then return jsonb_build_object('ok', false, 'error', 'Deliverable not found.'); end if;
  v_status := coalesce(p->>'status', d.status);
  if v_status not in ('todo', 'done', 'skipped') then return jsonb_build_object('ok', false, 'error', 'Unknown status.'); end if;
  if p ? 'label' and btrim(coalesce(p->>'label', '')) = '' then return jsonb_build_object('ok', false, 'error', 'Give it a name.'); end if;
  v_link := case when p ? 'link' then nullif(btrim(p->>'link'), '') else d.link end;
  if v_link is not null and v_link !~* '^https?://' then v_link := 'https://' || v_link; end if;
  update booking_deliverables set
    label    = case when p ? 'label' then btrim(p->>'label') else label end,
    note     = case when p ? 'note' then nullif(btrim(p->>'note'), '') else note end,
    due_date = case when p ? 'due_date' then nullif(p->>'due_date', '')::date else due_date end,
    link     = v_link,
    status   = v_status,
    done_at  = case when v_status = 'todo' then null when v_status <> d.status then now() else done_at end,
    done_by  = case when v_status = 'todo' then null when v_status <> d.status then auth.uid() else done_by end
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create function public.booking_deliverable_remove(p_id uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.can_any('{bookings}', 'edit') then raise exception 'admin only' using errcode = '42501'; end if;
  delete from booking_deliverables where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

-- ---------------------------------------------------------------- function grants
revoke all on function public.booking_stages_seed(text), public.booking_types_seed_stages(), public.booking_stage_move(uuid, uuid, boolean, text),
  public.booking_stage_auto(uuid, text), public.bookings_progress_start(), public.booking_stages_tick(), public.booking_deliverables_changed()
  from public, anon, authenticated;
revoke all on function public.admin_booking_progress(date, date), public.admin_booking_tracking(uuid), public.admin_deliverables_attention(),
  public.booking_set_stage(uuid, uuid, text), public.booking_deliverables_add(uuid, jsonb), public.booking_deliverable_update(uuid, jsonb),
  public.booking_deliverable_remove(uuid) from public, anon;
grant execute on function public.admin_booking_progress(date, date), public.admin_booking_tracking(uuid), public.admin_deliverables_attention(),
  public.booking_set_stage(uuid, uuid, text), public.booking_deliverables_add(uuid, jsonb), public.booking_deliverable_update(uuid, jsonb),
  public.booking_deliverable_remove(uuid) to authenticated;
