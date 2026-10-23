-- Gear per job, QR labels and repairs (2026-10-23, Airstudio plan item C). Module 'inventory'.
--
--   gear_templates      the gear list for a job type (type_key null = every job type). A line is a kit, an item,
--                       or just words ("AA batteries", qty 24) for things nobody tracks one by one.
--   booking_gear        each booked job's own copy of the list, made when the job is booked (job_gear_sync).
--                       A line is "got" once something is checked out for the job against it (checkout_id), or
--                       someone ticks it as packed. Lines nobody has touched follow the template; got lines stay.
--   inventory_checkouts gains booking_id: what went out for which job. Checking out for a job defaults the due
--                       day to the day after picture day.
--   inventory_items     gains a condition: ok, broken (somebody found it broken) or repair (at the shop). Anything
--                       not ok cannot be checked out, alone or inside its kit, until it is marked fixed.
--
-- Missing gear: a booked job (bookings.status = 'booked') in the next two days with a line not got. Shown on
-- the job, the Inventory "Jobs" tab and Today. Past due: anything still out after its due day. Each morning
-- (8am Eastern) a push goes to Inventory managers with the list and to each person holding something late.
-- Email and push only, never SMS.
--
-- QR labels hold https://admin.207photo.com/#ops/inventory/{i|k|b}/<uuid>; the app opens the item, kit or bin.
--
-- View = see the lists, tick packed, check out to yourself for a job, report something broken.
-- Edit = change the gear lists and a job's lines, check out to anyone, send to repair and mark fixed.

update public.app_modules
   set description = 'Bins and what is in them, serial numbers, kits, photos, who has what checked out, gear value and service, '
                     'a gear list per job type with a missing-gear check, QR labels and repairs.'
 where key = 'inventory';

insert into public.push_topics (key, label, description, module, sort)
values ('gear_overdue', 'Gear past due', 'Each morning, if gear is still out after the day it was due back.', 'inventory', 76)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- columns
alter table public.inventory_items
  add column condition       text not null default 'ok' check (condition in ('ok', 'broken', 'repair')),
  add column condition_note  text not null default '' check (length(condition_note) <= 500),
  add column condition_since timestamptz,
  add column condition_by    uuid;
comment on column public.inventory_items.condition is 'ok, broken (reported) or repair (at the shop). Not ok = cannot be checked out. Set by inventory_condition_set.';

alter table public.inventory_checkouts add column booking_id uuid references public.bookings (id) on delete set null;
comment on column public.inventory_checkouts.booking_id is 'The job this went out for (job_gear_check_out), if any.';
create index inventory_checkouts_booking_idx on public.inventory_checkouts (booking_id) where booking_id is not null;

-- ---------------------------------------------------------------- tables
create table public.gear_templates (
  id          uuid primary key default gen_random_uuid(),
  type_key    text references public.booking_types (key) on update cascade on delete cascade,   -- null = every job type
  kit_id      uuid references public.inventory_kits (id) on delete cascade,
  item_id     uuid references public.inventory_items (id) on delete cascade,
  label       text not null default '' check (length(label) <= 120),
  qty         int  not null default 1 check (qty between 1 and 1000),
  note        text not null default '' check (length(note) <= 300),
  sort        int  not null default 100,
  archived_at timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  check (num_nonnulls(kit_id, item_id) <= 1),
  check (kit_id is not null or item_id is not null or btrim(label) <> '')
);
comment on table public.gear_templates is 'Gear list per job type (null = every type): a kit, an item, or words. Copied to each booked job as booking_gear. Archive, never delete.';
create index gear_templates_type_idx on public.gear_templates (type_key, sort) where archived_at is null;

create table public.booking_gear (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings (id) on delete cascade,
  template_id uuid references public.gear_templates (id) on delete set null,
  kit_id      uuid references public.inventory_kits (id) on delete set null,
  item_id     uuid references public.inventory_items (id) on delete set null,
  label       text not null check (btrim(label) <> '' and length(label) <= 120),   -- the name when copied, so it survives a deleted kit
  qty         int  not null default 1 check (qty between 1 and 1000),
  note        text not null default '' check (length(note) <= 300),
  sort        int  not null default 100,
  checkout_id bigint references public.inventory_checkouts (id) on delete set null,
  packed_at   timestamptz,
  packed_by   uuid,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
comment on table public.booking_gear is 'A job''s gear list. Got = checkout_id (checked out for this job) or packed_at (ticked). Written by job_gear_* RPCs and job_gear_sync.';
create unique index booking_gear_template_uq on public.booking_gear (booking_id, template_id) where template_id is not null;
create index booking_gear_booking_idx on public.booking_gear (booking_id, sort);
create index booking_gear_checkout_idx on public.booking_gear (checkout_id) where checkout_id is not null;

alter table public.gear_templates enable row level security;
alter table public.booking_gear   enable row level security;
revoke all on public.gear_templates, public.booking_gear from anon, authenticated;
grant select on public.gear_templates, public.booking_gear to authenticated;
create policy gear_templates_read on public.gear_templates for select to authenticated using ((select public.can('inventory', 'view')));
create policy booking_gear_read   on public.booking_gear   for select to authenticated using ((select public.can('inventory', 'view')));

-- Logged once a day so the morning push goes out once.
create table public.inventory_push_log (
  day     date primary key,
  summary jsonb not null default '{}'::jsonb,
  sent_at timestamptz not null default now()
);
alter table public.inventory_push_log enable row level security;
revoke all on public.inventory_push_log from anon, authenticated;

-- ---------------------------------------------------------------- views (gain columns at the end)
create or replace view public.inventory_items_v with (security_invoker = true) as
select i.id, i.name, i.qty, i.serial, i.note, i.photo_path, i.bin_id, i.kit_id, i.updated_at,
       coalesce(k.bin_id, i.bin_id) as place_bin_id, b.code as bin_code, b.location as bin_location,
       k.name as kit_name,
       co.id as checkout_id, co.holder_user, co.holder_name, co.out_at, co.due_on, co.kit_id is not null as out_with_kit,
       i.purchased_on, i.purchase_price, i.value, i.service_every_months, i.last_service_on,
       case when i.service_every_months is not null and coalesce(i.last_service_on, i.purchased_on) is not null
            then (coalesce(i.last_service_on, i.purchased_on) + make_interval(months => i.service_every_months))::date end as next_service_on,
       i.condition, i.condition_note, i.condition_since
  from public.inventory_items i
  left join public.inventory_kits k on k.id = i.kit_id
  left join public.inventory_bins b on b.id = coalesce(k.bin_id, i.bin_id)
  left join lateral (select c.* from public.inventory_checkouts c
                      where c.returned_at is null and (c.item_id = i.id or (i.kit_id is not null and c.kit_id = i.kit_id))
                      order by c.kit_id nulls first limit 1) co on true;

create or replace view public.inventory_kits_v with (security_invoker = true) as
select k.id, k.name, k.note, k.photo_path, k.bin_id, k.updated_at, b.code as bin_code, b.location as bin_location,
       (select count(*) from public.inventory_items i where i.kit_id = k.id)::int as item_count,
       co.id as checkout_id, co.holder_user, co.holder_name, co.out_at, co.due_on,
       (select count(*) from public.inventory_items i where i.kit_id = k.id and i.condition <> 'ok')::int as not_ok_count
  from public.inventory_kits k
  left join public.inventory_bins b on b.id = k.bin_id
  left join public.inventory_checkouts co on co.kit_id = k.id and co.returned_at is null;

-- The job a checkout went out for, as "Title (Sat Oct 25)". Bookings themselves stay behind the Bookings module.
create function public.inventory_job_label(p_booking uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when p_booking is not null and public.can('inventory', 'view') then
    (select public.schedule_booking_title(b.id) || ' (' || to_char(b.picture_day, 'Dy Mon FMDD') || ')' from public.bookings b where b.id = p_booking) end
$$;

create or replace view public.inventory_out_v with (security_invoker = true) as
select c.id, c.item_id, c.kit_id, coalesce(i.name, k.name) as what, i.serial, c.holder_user, c.holder_name,
       c.out_at, c.due_on, c.note, b.code as bin_code,
       c.booking_id, public.inventory_job_label(c.booking_id) as job_title
  from public.inventory_checkouts c
  left join public.inventory_items i on i.id = c.item_id
  left join public.inventory_kits k on k.id = c.kit_id
  left join public.inventory_kits ik on ik.id = i.kit_id
  left join public.inventory_bins b on b.id = coalesce(k.bin_id, ik.bin_id, i.bin_id)
 where c.returned_at is null;

-- ---------------------------------------------------------------- check out (now: repairs block, and a job)
-- Same as before, plus: nothing broken or at repair goes out (a kit with something broken in it neither), and
-- p_booking records the job it is for.
drop function public.inventory_check_out(uuid, uuid, uuid, text, date, text);
create function public.inventory_check_out(p_item uuid, p_kit uuid, p_holder uuid, p_holder_name text default null,
                                           p_due date default null, p_note text default '', p_booking uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_name text;
  v_busy text;
  v_id bigint;
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if (p_item is null) = (p_kit is null) then raise exception 'Pick one item or one kit.'; end if;
  if not public.can('inventory', 'edit') and p_holder is distinct from v_me then
    raise exception 'You can only check things out to yourself.' using errcode = '42501';
  end if;
  if p_booking is not null and not exists (select 1 from public.bookings where id = p_booking) then raise exception 'No such job.'; end if;
  if p_holder is not null then
    select coalesce(nullif(m.display_name, ''), split_part(u.email, '@', 1)) into v_name
      from public.team_members m join auth.users u on u.id = m.user_id where m.user_id = p_holder and m.active;
    if v_name is null then raise exception 'That person is not on the team.'; end if;
  else
    v_name := btrim(coalesce(p_holder_name, ''));
    if v_name = '' then raise exception 'Say who has it.'; end if;
  end if;

  if p_item is not null then
    if not exists (select 1 from public.inventory_items where id = p_item) then raise exception 'No such item.'; end if;
    select i.name || case i.condition when 'repair' then ' is out for repair' else ' is marked broken' end into v_busy
      from public.inventory_items i where i.id = p_item and i.condition <> 'ok';
    if v_busy is not null then raise exception '%. Mark it fixed before it goes out.', v_busy; end if;
    select coalesce(c.holder_name, '') into v_busy from public.inventory_items i
      join public.inventory_checkouts c on c.returned_at is null and (c.item_id = i.id or c.kit_id = i.kit_id)
     where i.id = p_item limit 1;
    if v_busy is not null then raise exception 'It is already checked out to %.', v_busy; end if;
  else
    if not exists (select 1 from public.inventory_kits where id = p_kit) then raise exception 'No such kit.'; end if;
    select string_agg(i.name || case i.condition when 'repair' then ' (at repair)' else ' (broken)' end, ', ' order by i.name) into v_busy
      from public.inventory_items i where i.kit_id = p_kit and i.condition <> 'ok';
    if v_busy is not null then raise exception 'Part of this kit needs repair: %. Swap it out of the kit or mark it fixed first.', v_busy; end if;
    select c.holder_name into v_busy from public.inventory_checkouts c where c.kit_id = p_kit and c.returned_at is null;
    if v_busy is not null then raise exception 'This kit is already checked out to %.', v_busy; end if;
    select string_agg(i.name || ' (' || c.holder_name || ')', ', ') into v_busy
      from public.inventory_items i join public.inventory_checkouts c on c.item_id = i.id and c.returned_at is null
     where i.kit_id = p_kit;
    if v_busy is not null then raise exception 'Part of this kit is already out: %. Return it first.', v_busy; end if;
  end if;

  insert into public.inventory_checkouts (item_id, kit_id, holder_user, holder_name, out_by, due_on, note, booking_id)
  values (p_item, p_kit, p_holder, v_name, v_me, p_due, coalesce(btrim(p_note), ''), p_booking)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'holder_name', v_name);
end $$;

-- ---------------------------------------------------------------- condition (broken / repair / fixed)
-- View: report it broken. Edit: also send it to repair and mark it fixed. Fixing logs a repair in the service
-- log (with the cost, if given).
create function public.inventory_condition_set(p_item uuid, p_condition text, p_note text default '', p_cost numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_old text; v_note text := left(btrim(coalesce(p_note, '')), 500);
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_condition is null or p_condition not in ('ok', 'broken', 'repair') then raise exception 'Pick ok, broken or at repair.'; end if;
  if p_condition <> 'broken' and not public.can('inventory', 'edit') then
    raise exception 'Only Inventory managers can send gear to repair or mark it fixed.' using errcode = '42501';
  end if;
  if p_cost is not null and p_cost < 0 then raise exception 'Cost should be 0 or more.'; end if;
  select condition into v_old from public.inventory_items where id = p_item for update;
  if v_old is null then raise exception 'No such item.'; end if;
  if p_condition = 'broken' and v_note = '' then raise exception 'Say what is wrong with it.'; end if;
  update public.inventory_items
     set condition = p_condition,
         condition_note = case when p_condition = 'ok' then '' when v_note = '' then condition_note else v_note end,
         condition_since = case when p_condition = 'ok' then null when p_condition = v_old then condition_since else now() end,
         condition_by = (select auth.uid())
   where id = p_item;
  if p_condition = 'ok' and v_old <> 'ok' then
    insert into public.inventory_service (item_id, done_on, kind, cost, note, created_by)
    values (p_item, (now() at time zone 'America/New_York')::date, 'repair', p_cost, coalesce(nullif(v_note, ''), 'Marked fixed'), (select auth.uid()));
  end if;
  return jsonb_build_object('ok', true, 'condition', p_condition);
end $$;

-- ---------------------------------------------------------------- the copy on each job
create function public.gear_line_label(p_label text, p_kit uuid, p_item uuid) returns text
language sql stable security definer set search_path = '' as $$
  select left(coalesce(nullif(btrim(p_label), ''), (select name from public.inventory_kits where id = p_kit),
                       (select name from public.inventory_items where id = p_item), 'Gear'), 120)
$$;

-- Make, update or drop a booking's template lines. Lines someone has got or ticked never change or go.
-- Never raises (callers are triggers on the booking itself).
create function public.job_gear_sync(p_booking uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare b public.bookings; n int := 0; k int;
begin
  select * into b from public.bookings where id = p_booking;
  if b.id is null then return 0; end if;
  delete from public.booking_gear g
   where g.booking_id = p_booking and g.template_id is not null and g.checkout_id is null and g.packed_at is null
     and (b.status <> 'booked'
          or not exists (select 1 from public.gear_templates x where x.id = g.template_id and x.archived_at is null
                                                                and (x.type_key is null or x.type_key = b.type_key)));
  get diagnostics n = row_count;
  if b.status <> 'booked' then return n; end if;
  update public.booking_gear g
     set kit_id = x.kit_id, item_id = x.item_id, label = public.gear_line_label(x.label, x.kit_id, x.item_id), qty = x.qty, note = x.note, sort = x.sort
    from public.gear_templates x
   where g.booking_id = p_booking and g.template_id = x.id and g.checkout_id is null and g.packed_at is null
     and (g.kit_id, g.item_id, g.label, g.qty, g.note, g.sort)
         is distinct from (x.kit_id, x.item_id, public.gear_line_label(x.label, x.kit_id, x.item_id), x.qty, x.note, x.sort);
  get diagnostics k = row_count; n := n + k;
  insert into public.booking_gear (booking_id, template_id, kit_id, item_id, label, qty, note, sort)
  select p_booking, x.id, x.kit_id, x.item_id, public.gear_line_label(x.label, x.kit_id, x.item_id), x.qty, x.note, x.sort
    from public.gear_templates x
   where x.archived_at is null and (x.type_key is null or x.type_key = b.type_key)
     and not exists (select 1 from public.booking_gear g where g.booking_id = p_booking and g.template_id = x.id);
  get diagnostics k = row_count;
  return n + k;
exception when others then
  raise warning 'job_gear_sync(%): %', p_booking, sqlerrm;
  return 0;
end $$;

create function public.job_gear_bookings_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or (new.status, new.type_key) is distinct from (old.status, old.type_key) then
    perform public.job_gear_sync(new.id);
  end if;
  return null;
end $$;
create trigger job_gear_bookings_changed after insert or update on public.bookings for each row execute function public.job_gear_bookings_changed();

-- Templates changed: booked jobs from today on follow.
create function public.job_gear_resync(p_type text) returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select b.id from public.bookings b
            where b.status = 'booked' and b.picture_day >= (now() at time zone 'America/New_York')::date
              and (p_type is null or b.type_key = p_type) loop
    perform public.job_gear_sync(r.id);
  end loop;
end $$;

-- Is a line got? Checked out for the job (and not handed back before picture day), or ticked as packed.
create function public.job_gear_got(g public.booking_gear, p_day date) returns boolean
language sql stable security definer set search_path = '' as $$
  select g.packed_at is not null
      or exists (select 1 from public.inventory_checkouts c where c.id = g.checkout_id
                    and (c.returned_at is null or (c.returned_at at time zone 'America/New_York')::date >= p_day))
$$;

-- ---------------------------------------------------------------- RPCs: gear lists per job type
create function public.gear_templates_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'can_edit', public.can('inventory', 'edit'),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'label', t.label) order by t.sort_order, t.label), '[]'::jsonb) from public.booking_types t),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'type_key', x.type_key, 'kit_id', x.kit_id, 'item_id', x.item_id,
                         'label', x.label, 'name', public.gear_line_label(x.label, x.kit_id, x.item_id), 'qty', x.qty, 'note', x.note, 'sort', x.sort)
                         order by x.type_key nulls first, x.sort, x.created_at), '[]'::jsonb)
                from public.gear_templates x where x.archived_at is null));
end $$;

-- p = {id?, type_key?, kit_id? | item_id? | label, qty?, note?}
create function public.gear_template_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_type text := nullif(p ->> 'type_key', '');
  v_kit uuid := nullif(p ->> 'kit_id', '')::uuid;
  v_item uuid := nullif(p ->> 'item_id', '')::uuid;
  v_label text := left(btrim(coalesce(p ->> 'label', '')), 120);
  v_qty int := coalesce(nullif(p ->> 'qty', '')::int, 1);
  v_old text;
begin
  if not public.can('inventory', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_type is not null and not exists (select 1 from public.booking_types where key = v_type) then raise exception 'Pick a job type.'; end if;
  if v_kit is not null and v_item is not null then raise exception 'Pick a kit or an item, not both.'; end if;
  if v_kit is not null and not exists (select 1 from public.inventory_kits where id = v_kit) then raise exception 'That kit is gone.'; end if;
  if v_item is not null and not exists (select 1 from public.inventory_items where id = v_item) then raise exception 'That item is gone.'; end if;
  if v_kit is null and v_item is null and v_label = '' then raise exception 'Say what to bring.'; end if;
  if v_qty not between 1 and 1000 then raise exception 'How many: 1 to 1000.'; end if;
  if v_kit is not null or v_item is not null then v_label := ''; end if;
  if v_id is not null then
    select type_key into v_old from public.gear_templates where id = v_id and archived_at is null;
    if not found then raise exception 'That line was removed. Reload the page.'; end if;
    update public.gear_templates set type_key = v_type, kit_id = v_kit, item_id = v_item, label = v_label, qty = v_qty,
           note = left(btrim(coalesce(p ->> 'note', '')), 300)
     where id = v_id;
    if v_old is distinct from v_type then perform public.job_gear_resync(v_old); end if;
  else
    insert into public.gear_templates (type_key, kit_id, item_id, label, qty, note, sort, created_by)
    values (v_type, v_kit, v_item, v_label, v_qty, left(btrim(coalesce(p ->> 'note', '')), 300),
            coalesce((select max(sort) + 10 from public.gear_templates where type_key is not distinct from v_type and archived_at is null), 10), (select auth.uid()))
    returning id into v_id;
  end if;
  perform public.job_gear_resync(v_type);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function public.gear_template_archive(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_type text;
begin
  if not public.can('inventory', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.gear_templates set archived_at = now() where id = p_id and archived_at is null returning type_key into v_type;
  if not found then return jsonb_build_object('ok', false); end if;
  perform public.job_gear_resync(v_type);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- RPCs: one job
-- The job's lines, whether each is got and how, and a warning when the named kit or item can't go
-- (broken, at repair, or out with someone else). extras = things checked out for the job that no line names.
create function public.job_gear(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings;
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking;
  if b.id is null then raise exception 'No such job.'; end if;
  return jsonb_build_object(
    'can_edit', public.can('inventory', 'edit'),
    'booking', jsonb_build_object('id', b.id, 'title', public.schedule_booking_title(b.id), 'picture_day', b.picture_day, 'status', b.status,
                                  'type_label', (select label from public.booking_types where key = b.type_key)),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', g.id, 'label', g.label, 'qty', g.qty, 'note', g.note, 'kit_id', g.kit_id, 'item_id', g.item_id,
                  'from_list', g.template_id is not null, 'got', public.job_gear_got(g, b.picture_day),
                  'checkout_id', g.checkout_id, 'holder_name', c.holder_name, 'holder_user', c.holder_user, 'returned_at', c.returned_at,
                  'out_what', coalesce(ci.name, ck.name),
                  'packed_at', g.packed_at, 'packed_by', public.staff_name(g.packed_by),
                  'warn', case when public.job_gear_got(g, b.picture_day) then null
                               when i.condition = 'repair' then 'At repair'
                               when i.condition = 'broken' then 'Broken' || coalesce(': ' || nullif(i.condition_note, ''), '')
                               when g.kit_id is not null and exists (select 1 from public.inventory_items x where x.kit_id = g.kit_id and x.condition <> 'ok')
                                 then 'Something in this kit needs repair'
                               else (select 'Out with ' || o.holder_name || coalesce(' for ' || public.inventory_job_label(o.booking_id), '')
                                            || coalesce(', due ' || to_char(o.due_on, 'Dy Mon FMDD'), '')
                                       from public.inventory_checkouts o
                                      where o.returned_at is null and o.booking_id is distinct from b.id
                                        and (o.kit_id = g.kit_id or o.item_id = g.item_id or (i.kit_id is not null and o.kit_id = i.kit_id))
                                      limit 1) end)
                  order by g.sort, g.created_at), '[]'::jsonb)
                from public.booking_gear g
                left join public.inventory_checkouts c on c.id = g.checkout_id
                left join public.inventory_items ci on ci.id = c.item_id
                left join public.inventory_kits ck on ck.id = c.kit_id
                left join public.inventory_items i on i.id = g.item_id
               where g.booking_id = b.id),
    'extras', (select coalesce(jsonb_agg(jsonb_build_object('checkout_id', c.id, 'what', coalesce(i.name, k.name), 'holder_name', c.holder_name,
                                 'holder_user', c.holder_user, 'returned_at', c.returned_at, 'item_id', c.item_id, 'kit_id', c.kit_id) order by c.out_at), '[]'::jsonb)
                 from public.inventory_checkouts c
                 left join public.inventory_items i on i.id = c.item_id
                 left join public.inventory_kits k on k.id = c.kit_id
                where c.booking_id = b.id and not exists (select 1 from public.booking_gear g where g.checkout_id = c.id)));
end $$;

-- Check something out for a job. Without p_line it fills the first open line naming that item or kit
-- (or a kit line, when the item is part of that kit); with nothing matching it still goes out for the job.
-- p_holder null and no p_holder_name = yourself. Due back: p_due, else the day after picture day.
create function public.job_gear_check_out(p_booking uuid, p_item uuid, p_kit uuid, p_line uuid default null,
                                          p_holder uuid default null, p_holder_name text default null, p_due date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b public.bookings; g public.booking_gear;
  v_today date := (now() at time zone 'America/New_York')::date;
  v_res jsonb; v_co bigint; v_kit_of uuid;
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking;
  if b.id is null then raise exception 'No such job.'; end if;
  if b.status <> 'booked' then raise exception 'This job isn''t booked.'; end if;
  if p_line is not null then
    select * into g from public.booking_gear where id = p_line and booking_id = p_booking for update;
    if g.id is null then raise exception 'That line is gone. Reload.'; end if;
    if public.job_gear_got(g, b.picture_day) then raise exception 'That line is already got.'; end if;
    if p_item is null and p_kit is null then p_item := g.item_id; p_kit := g.kit_id; end if;
  end if;
  if p_holder is null and nullif(btrim(coalesce(p_holder_name, '')), '') is null then p_holder := (select auth.uid()); end if;
  v_res := public.inventory_check_out(p_item, p_kit, p_holder, p_holder_name, coalesce(p_due, greatest(b.picture_day + 1, v_today)),
                                      left(public.schedule_booking_title(b.id), 200), p_booking);
  v_co := (v_res ->> 'id')::bigint;
  if g.id is null then
    select kit_id into v_kit_of from public.inventory_items where id = p_item;
    select * into g from public.booking_gear x
     where x.booking_id = p_booking and not public.job_gear_got(x, b.picture_day)
       and ((p_item is not null and x.item_id = p_item) or (p_kit is not null and x.kit_id = p_kit))
     order by x.sort, x.created_at limit 1 for update;
  end if;
  if g.id is not null then
    update public.booking_gear set checkout_id = v_co where id = g.id;
  end if;
  return v_res || jsonb_build_object('line_id', g.id, 'label', g.label,
                                     'what', coalesce((select name from public.inventory_items where id = p_item), (select name from public.inventory_kits where id = p_kit)));
end $$;

-- Tick (or untick) a line as packed: for words-only lines, or anything packed without checking it out.
create function public.job_gear_pack(p_line uuid, p_packed boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.booking_gear set packed_at = case when p_packed then coalesce(packed_at, now()) end,
                                 packed_by = case when p_packed then coalesce(packed_by, (select auth.uid())) end
   where id = p_line;
  if not found then raise exception 'That line is gone. Reload.'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Add a line to one job only. p = {booking_id, kit_id? | item_id? | label, qty?, note?}
create function public.job_gear_line_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_booking uuid := nullif(p ->> 'booking_id', '')::uuid;
  v_kit uuid := nullif(p ->> 'kit_id', '')::uuid;
  v_item uuid := nullif(p ->> 'item_id', '')::uuid;
  v_label text := left(btrim(coalesce(p ->> 'label', '')), 120);
  v_qty int := coalesce(nullif(p ->> 'qty', '')::int, 1);
  v_id uuid;
begin
  if not public.can('inventory', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.bookings where id = v_booking) then raise exception 'No such job.'; end if;
  if v_kit is not null and v_item is not null then raise exception 'Pick a kit or an item, not both.'; end if;
  if v_kit is null and v_item is null and v_label = '' then raise exception 'Say what to bring.'; end if;
  if v_qty not between 1 and 1000 then raise exception 'How many: 1 to 1000.'; end if;
  insert into public.booking_gear (booking_id, kit_id, item_id, label, qty, note, sort, created_by)
  values (v_booking, v_kit, v_item, public.gear_line_label(case when v_kit is null and v_item is null then v_label end, v_kit, v_item), v_qty,
          left(btrim(coalesce(p ->> 'note', '')), 300),
          coalesce((select max(sort) + 10 from public.booking_gear where booking_id = v_booking), 10), (select auth.uid()))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Take a line off one job. What was checked out against it stays out.
create function public.job_gear_line_remove(p_line uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('inventory', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from public.booking_gear where id = p_line;
  return jsonb_build_object('ok', found);
end $$;

-- Booked jobs from yesterday through p_days ahead, with how much of the gear is got.
create function public.job_gear_jobs(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(j order by j ->> 'picture_day', j ->> 'title'), '[]'::jsonb) from (
    select jsonb_build_object('booking_id', b.id, 'title', public.schedule_booking_title(b.id), 'picture_day', b.picture_day,
             'type_label', (select label from public.booking_types where key = b.type_key),
             'lines', count(g.id), 'got', count(g.id) filter (where public.job_gear_got(g, b.picture_day)),
             'out', (select count(*) from public.inventory_checkouts c where c.booking_id = b.id and c.returned_at is null)) j
      from public.bookings b
      left join public.booking_gear g on g.booking_id = b.id
     where b.status = 'booked' and b.picture_day between v_today - 1 and v_today + least(greatest(coalesce(p_days, 30), 1), 120)
     group by b.id) x);
end $$;

-- ---------------------------------------------------------------- Today
-- Service due (as before), booked jobs in the next two days with gear not got, and gear past due back.
create or replace function public.inventory_attention()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'service_due', (select count(*) from public.inventory_items_v v where v.next_service_on <= v_today + 14),
    'gear_missing', (select count(distinct b.id) from public.bookings b join public.booking_gear g on g.booking_id = b.id
                      where b.status = 'booked' and b.picture_day between v_today and v_today + 2 and not public.job_gear_got(g, b.picture_day)),
    'past_due', (select count(*) from public.inventory_checkouts c where c.returned_at is null and c.due_on < v_today),
    'needs_repair', (select count(*) from public.inventory_items i where i.condition <> 'ok'));
end $$;

-- ---------------------------------------------------------------- morning push (cron)
-- From 8am Eastern, once a day: everything still out after its due day. Inventory managers (Edit, full access)
-- get the whole list; everyone else who is holding something late gets their own. Both honor "Gear past due".
create function public.inventory_push(p_force boolean default false)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'America/New_York';
  v_today date := v_now::date;
  v_sent int := 0; v_n int; v_body text; r record;
begin
  if not p_force and (extract(hour from v_now) < 8 or extract(hour from v_now) >= 11) then return 0; end if;
  insert into public.inventory_push_log (day) values (v_today) on conflict do nothing;
  if not found then return 0; end if;

  select count(*), string_agg(x.what || ' (' || x.holder_name || ', due ' || to_char(x.due_on, 'Dy Mon FMDD') || ')', '; ' order by x.due_on, x.what)
    into v_n, v_body
    from (select coalesce(i.name, k.name) as what, c.holder_name, c.due_on from public.inventory_checkouts c
            left join public.inventory_items i on i.id = c.item_id left join public.inventory_kits k on k.id = c.kit_id
           where c.returned_at is null and c.due_on < v_today) x;
  update public.inventory_push_log set summary = jsonb_build_object('past_due', v_n) where day = v_today;
  if v_n = 0 then return 0; end if;

  for r in select m.user_id from public.team_members m
            where (exists (select 1 from public.admin_users a where a.user_id = m.user_id)
                   or (m.active and exists (select 1 from public.team_permissions p where p.user_id = m.user_id and p.module_key = 'inventory' and p.level = 'edit')))
              and coalesce((select p.enabled from public.push_prefs p where p.user_id = m.user_id and p.topic = 'gear_overdue'), true) loop
    perform public.push_notify('gear_overdue', case when v_n = 1 then '1 thing is past due back' else v_n || ' things are past due back' end,
                               v_body, '/#ops/invout', 'gear_overdue', r.user_id);
    v_sent := v_sent + 1;
  end loop;

  for r in select c.holder_user, count(*) as n, string_agg(coalesce(i.name, k.name), ', ' order by c.due_on) as what, min(c.due_on) as d
             from public.inventory_checkouts c
             left join public.inventory_items i on i.id = c.item_id left join public.inventory_kits k on k.id = c.kit_id
            where c.returned_at is null and c.due_on < v_today and c.holder_user is not null
              and public.team_user_can(c.holder_user, 'inventory')
              and not exists (select 1 from public.admin_users a where a.user_id = c.holder_user)
              and not exists (select 1 from public.team_permissions p where p.user_id = c.holder_user and p.module_key = 'inventory' and p.level = 'edit')
              and coalesce((select p.enabled from public.push_prefs p where p.user_id = c.holder_user and p.topic = 'gear_overdue'), true)
            group by c.holder_user loop
    perform public.push_notify('gear_overdue', case when r.n = 1 then 'Gear past due back' else r.n || ' things past due back' end,
                               r.what || ' (due ' || to_char(r.d, 'Dy Mon FMDD') || '). Bring it back or tell the office.', '/#ops/inventory', 'gear_overdue_me', r.holder_user);
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;

select cron.schedule('inventory-push', '10,40 * * * *', 'select public.inventory_push()');
select cron.schedule('inventory-push-log-retention', '59 4 * * *', $$delete from public.inventory_push_log where day < current_date - 60$$);

-- ---------------------------------------------------------------- grants
do $$
declare f text;
begin
  foreach f in array array['public.gear_line_label(text, uuid, uuid)', 'public.job_gear_sync(uuid)', 'public.job_gear_bookings_changed()',
                           'public.job_gear_resync(text)', 'public.job_gear_got(public.booking_gear, date)', 'public.inventory_push(boolean)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.inventory_job_label(uuid)', 'public.inventory_check_out(uuid, uuid, uuid, text, date, text, uuid)',
                           'public.inventory_condition_set(uuid, text, text, numeric)', 'public.gear_templates_list()', 'public.gear_template_save(jsonb)',
                           'public.gear_template_archive(uuid)', 'public.job_gear(uuid)', 'public.job_gear_check_out(uuid, uuid, uuid, uuid, uuid, text, date)',
                           'public.job_gear_pack(uuid, boolean)', 'public.job_gear_line_add(jsonb)', 'public.job_gear_line_remove(uuid)',
                           'public.job_gear_jobs(int)', 'public.inventory_attention()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- Jobs already booked from today on get their (empty, until lists are made) gear lists.
select public.job_gear_sync(b.id) from public.bookings b
 where b.status = 'booked' and b.picture_day >= (now() at time zone 'America/New_York')::date;
