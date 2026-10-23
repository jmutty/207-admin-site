-- Gear repairs and past-due gear (2026-10-23, trimmed in the polish pass). Module 'inventory'.
--
--   inventory_checkouts gains booking_id: the job something went out for, if anyone says.
--   inventory_items     gains a condition: ok, broken (somebody found it broken) or repair (at the shop). Anything
--                       not ok cannot be checked out, alone or inside its kit, until it is marked fixed.
--
-- Photographers keep their own kits and check gear out by hand, so there are no gear lists per job type and no QR
-- labels (Jeremiah, 2026-10-23). Past due: anything still out after its due day. Each morning (8am Eastern) a push
-- goes to Inventory managers with the list and to each person holding something late. Email and push only, never SMS.
--
-- View = check out to yourself, report something broken. Edit = check out to anyone, send to repair and mark fixed.

update public.app_modules
   set description = 'Bins and what is in them, serial numbers, kits, photos, who has what checked out, gear value and service, '
                     'repairs and past-due gear.'
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
comment on column public.inventory_checkouts.booking_id is 'The job this went out for, if any.';
create index inventory_checkouts_booking_idx on public.inventory_checkouts (booking_id) where booking_id is not null;

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

-- ---------------------------------------------------------------- Today
-- Service due (as before), gear past due back, and gear needing repair.
create or replace function public.inventory_attention()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'service_due', (select count(*) from public.inventory_items_v v where v.next_service_on <= v_today + 14),
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
  foreach f in array array['public.inventory_push(boolean)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.inventory_job_label(uuid)', 'public.inventory_check_out(uuid, uuid, uuid, text, date, text, uuid)',
                           'public.inventory_condition_set(uuid, text, text, numeric)', 'public.inventory_attention()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
