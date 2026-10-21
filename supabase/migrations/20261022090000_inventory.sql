-- Inventory (2026-10-21): bins, what is in them, serial numbers, kits, photos and check-out.
--
--   inventory_bins       a numbered space ("A-03"): where it is (room, shelf, van) and a note.
--   inventory_kits       a named bundle ("Sports kit 1") that lives in a home bin and goes out as one.
--   inventory_items      one line: a name, a quantity, an optional serial number. It sits in a bin, or
--                        in a kit (then it is wherever the kit is).
--   inventory_checkouts  who has an item or a kit: one open row (returned_at null) while it is out, and
--                        the closed rows are the history.
--   storage bucket       `inventory` (private): one photo per bin, kit or item, shrunk in the browser.
--
-- Access is the `inventory` module:
--   view = search, look, and check things out to yourself / return what you have.
--   edit = add and change bins, kits and items, and check anything out to anyone.
-- Searching joins a handful of small tables with ILIKE; a few thousand items stay instant. If it ever
-- grows past that, add a pg_trgm GIN index on the item name.

update public.app_modules
   set status = 'live', description = 'Bins and what is in them, serial numbers, kits, photos and who has what checked out.'
 where key = 'inventory';

-- ---------------------------------------------------------------- tables
create table public.inventory_bins (
  id         uuid primary key default gen_random_uuid(),
  code       text not null check (btrim(code) <> '' and length(code) <= 30),
  location   text not null default '' check (length(location) <= 120),
  note       text not null default '' check (length(note) <= 1000),
  photo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.inventory_bins is 'Numbered spaces (bins, shelves, cases) where inventory is kept. code is unique, ignoring case and spaces at the ends.';
create unique index inventory_bins_code_uq on public.inventory_bins (lower(btrim(code)));

create table public.inventory_kits (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> '' and length(name) <= 120),
  bin_id     uuid references public.inventory_bins (id) on delete set null,
  note       text not null default '' check (length(note) <= 1000),
  photo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.inventory_kits is 'Bundles of items that go out together. bin_id is the kit''s home.';
create unique index inventory_kits_name_uq on public.inventory_kits (lower(btrim(name)));

create table public.inventory_items (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> '' and length(name) <= 120),
  qty        int  not null default 1 check (qty >= 0 and qty <= 100000),
  serial     text not null default '' check (length(serial) <= 80),
  bin_id     uuid references public.inventory_bins (id) on delete restrict,
  kit_id     uuid references public.inventory_kits (id) on delete set null,
  note       text not null default '' check (length(note) <= 1000),
  photo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
comment on table public.inventory_items is 'What is in each bin. An item in a kit is wherever the kit''s bin is. A bin with items cannot be deleted.';
create unique index inventory_items_serial_uq on public.inventory_items (lower(btrim(serial))) where btrim(serial) <> '';
create index inventory_items_bin_idx on public.inventory_items (bin_id);
create index inventory_items_kit_idx on public.inventory_items (kit_id);

create table public.inventory_checkouts (
  id          bigint generated always as identity primary key,
  item_id     uuid references public.inventory_items (id) on delete cascade,
  kit_id      uuid references public.inventory_kits (id) on delete cascade,
  holder_user uuid references public.team_members (user_id) on delete set null,
  holder_name text not null check (btrim(holder_name) <> '' and length(holder_name) <= 120),
  out_at      timestamptz not null default now(),
  out_by      uuid,
  due_on      date,
  note        text not null default '' check (length(note) <= 500),
  returned_at timestamptz,
  returned_by uuid,
  check ((item_id is null) <> (kit_id is null))
);
comment on table public.inventory_checkouts is 'Who has an item or kit. Open while returned_at is null; closed rows are the history. Written only by inventory_check_out / inventory_return.';
create unique index inventory_checkouts_item_open_uq on public.inventory_checkouts (item_id) where returned_at is null and item_id is not null;
create unique index inventory_checkouts_kit_open_uq  on public.inventory_checkouts (kit_id)  where returned_at is null and kit_id is not null;
create index inventory_checkouts_holder_idx on public.inventory_checkouts (holder_user) where returned_at is null;
create index inventory_checkouts_item_idx on public.inventory_checkouts (item_id, out_at desc);
create index inventory_checkouts_kit_idx  on public.inventory_checkouts (kit_id, out_at desc);

-- Stamp who changed a row and when.
create function public.inventory_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end $$;
create trigger inventory_bins_touch  before insert or update on public.inventory_bins  for each row execute function public.inventory_touch();
create trigger inventory_kits_touch  before insert or update on public.inventory_kits  for each row execute function public.inventory_touch();
create trigger inventory_items_touch before insert or update on public.inventory_items for each row execute function public.inventory_touch();

-- Deleting a kit leaves its items in the kit's bin instead of nowhere.
create function public.inventory_kit_unpack() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.inventory_items set bin_id = coalesce(old.bin_id, bin_id), kit_id = null where kit_id = old.id;
  return old;
end $$;
revoke all on function public.inventory_kit_unpack() from public, anon, authenticated;
create trigger inventory_kits_unpack before delete on public.inventory_kits for each row execute function public.inventory_kit_unpack();

-- ---------------------------------------------------------------- access
alter table public.inventory_bins      enable row level security;
alter table public.inventory_kits      enable row level security;
alter table public.inventory_items     enable row level security;
alter table public.inventory_checkouts enable row level security;
revoke all on public.inventory_bins, public.inventory_kits, public.inventory_items, public.inventory_checkouts from anon, authenticated;
grant select, insert, update, delete on public.inventory_bins, public.inventory_kits, public.inventory_items to authenticated;
grant select on public.inventory_checkouts to authenticated;

create policy inventory_bins_read   on public.inventory_bins  for select to authenticated using ((select public.can('inventory', 'view')));
create policy inventory_bins_write  on public.inventory_bins  for all    to authenticated using ((select public.can('inventory', 'edit')))
                                                                                   with check ((select public.can('inventory', 'edit')));
create policy inventory_kits_read   on public.inventory_kits  for select to authenticated using ((select public.can('inventory', 'view')));
create policy inventory_kits_write  on public.inventory_kits  for all    to authenticated using ((select public.can('inventory', 'edit')))
                                                                                   with check ((select public.can('inventory', 'edit')));
create policy inventory_items_read  on public.inventory_items for select to authenticated using ((select public.can('inventory', 'view')));
create policy inventory_items_write on public.inventory_items for all    to authenticated using ((select public.can('inventory', 'edit')))
                                                                                   with check ((select public.can('inventory', 'edit')));
create policy inventory_checkouts_read on public.inventory_checkouts for select to authenticated using ((select public.can('inventory', 'view')));

-- ---------------------------------------------------------------- views (RLS of the tables applies)
-- Every item with where it is, its kit, and who has it (itself or with its kit).
create view public.inventory_items_v with (security_invoker = true) as
select i.id, i.name, i.qty, i.serial, i.note, i.photo_path, i.bin_id, i.kit_id, i.updated_at,
       coalesce(k.bin_id, i.bin_id) as place_bin_id, b.code as bin_code, b.location as bin_location,
       k.name as kit_name,
       co.id as checkout_id, co.holder_user, co.holder_name, co.out_at, co.due_on, co.kit_id is not null as out_with_kit
  from public.inventory_items i
  left join public.inventory_kits k on k.id = i.kit_id
  left join public.inventory_bins b on b.id = coalesce(k.bin_id, i.bin_id)
  left join lateral (select c.* from public.inventory_checkouts c
                      where c.returned_at is null and (c.item_id = i.id or (i.kit_id is not null and c.kit_id = i.kit_id))
                      order by c.kit_id nulls first limit 1) co on true;

create view public.inventory_kits_v with (security_invoker = true) as
select k.id, k.name, k.note, k.photo_path, k.bin_id, k.updated_at, b.code as bin_code, b.location as bin_location,
       (select count(*) from public.inventory_items i where i.kit_id = k.id)::int as item_count,
       co.id as checkout_id, co.holder_user, co.holder_name, co.out_at, co.due_on
  from public.inventory_kits k
  left join public.inventory_bins b on b.id = k.bin_id
  left join public.inventory_checkouts co on co.kit_id = k.id and co.returned_at is null;

create view public.inventory_bins_v with (security_invoker = true) as
select b.id, b.code, b.location, b.note, b.photo_path, b.updated_at,
       (select count(*) from public.inventory_items i where i.bin_id = b.id and i.kit_id is null)::int as item_count,
       (select count(*) from public.inventory_kits k where k.bin_id = b.id)::int as kit_count,
       (select string_agg(x.name, ', ' order by x.name) from (select i.name from public.inventory_items i
          where i.bin_id = b.id and i.kit_id is null order by i.name limit 6) x) as preview
  from public.inventory_bins b;

-- Everything out right now, with the item or kit it is.
create view public.inventory_out_v with (security_invoker = true) as
select c.id, c.item_id, c.kit_id, coalesce(i.name, k.name) as what, i.serial, c.holder_user, c.holder_name,
       c.out_at, c.due_on, c.note, b.code as bin_code
  from public.inventory_checkouts c
  left join public.inventory_items i on i.id = c.item_id
  left join public.inventory_kits k on k.id = c.kit_id
  left join public.inventory_kits ik on ik.id = i.kit_id
  left join public.inventory_bins b on b.id = coalesce(k.bin_id, ik.bin_id, i.bin_id)
 where c.returned_at is null;

revoke all on public.inventory_items_v, public.inventory_kits_v, public.inventory_bins_v, public.inventory_out_v from anon, authenticated;
grant select on public.inventory_items_v, public.inventory_kits_v, public.inventory_bins_v, public.inventory_out_v to authenticated;

-- ---------------------------------------------------------------- search
-- Every word must appear somewhere in the item's name, serial, note, kit, bin code or bin location.
-- Returns {items: [...], kits: [...], bins: [...]}.
create function public.inventory_search(p_q text, p_limit int default 60)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_words text[];
  v_first text;
  v_limit int := least(greatest(coalesce(p_limit, 60), 1), 200);
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  v_words := array(select '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
                     from regexp_split_to_table(lower(btrim(coalesce(p_q, ''))), '\s+') w where w <> '');
  if cardinality(v_words) = 0 then return jsonb_build_object('items', '[]'::jsonb, 'kits', '[]'::jsonb, 'bins', '[]'::jsonb); end if;
  v_first := substr(v_words[1], 2);   -- "word%": names that start with the first word come first
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select v.* from public.inventory_items_v v
         where lower(concat_ws(' ', v.name, v.serial, v.note, v.kit_name, v.bin_code, v.bin_location)) like all (v_words)
         order by lower(v.name) like v_first desc, lower(v.name), v.bin_code
         limit v_limit) x), '[]'::jsonb),
    'kits', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select v.* from public.inventory_kits_v v
         where lower(concat_ws(' ', v.name, v.note, v.bin_code, v.bin_location)) like all (v_words)
         order by lower(v.name) limit 20) x), '[]'::jsonb),
    'bins', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select v.* from public.inventory_bins_v v
         where lower(concat_ws(' ', v.code, v.location, v.note)) like all (v_words)
         order by lower(v.code) limit 20) x), '[]'::jsonb));
end $$;
revoke all on function public.inventory_search(text, int) from public, anon;
grant execute on function public.inventory_search(text, int) to authenticated;

-- ---------------------------------------------------------------- people, check out, return
-- Active team members, for "who has it". Anyone with inventory access may see the names.
create function public.inventory_people()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(m.display_name, ''), split_part(u.email, '@', 1)))
                                   order by lower(coalesce(nullif(m.display_name, ''), u.email)))
                     from public.team_members m join auth.users u on u.id = m.user_id where m.active), '[]'::jsonb);
end $$;
revoke all on function public.inventory_people() from public, anon;
grant execute on function public.inventory_people() to authenticated;

-- Check out one item or one kit. p_holder = a team member, or null with p_holder_name for someone else.
-- View-only people may only check things out to themselves.
create function public.inventory_check_out(p_item uuid, p_kit uuid, p_holder uuid, p_holder_name text default null,
                                           p_due date default null, p_note text default '')
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
    select coalesce(c.holder_name, '') into v_busy from public.inventory_items i
      join public.inventory_checkouts c on c.returned_at is null and (c.item_id = i.id or c.kit_id = i.kit_id)
     where i.id = p_item limit 1;
    if v_busy is not null then raise exception 'It is already checked out to %.', v_busy; end if;
  else
    if not exists (select 1 from public.inventory_kits where id = p_kit) then raise exception 'No such kit.'; end if;
    select c.holder_name into v_busy from public.inventory_checkouts c where c.kit_id = p_kit and c.returned_at is null;
    if v_busy is not null then raise exception 'This kit is already checked out to %.', v_busy; end if;
    select string_agg(i.name || ' (' || c.holder_name || ')', ', ') into v_busy
      from public.inventory_items i join public.inventory_checkouts c on c.item_id = i.id and c.returned_at is null
     where i.kit_id = p_kit;
    if v_busy is not null then raise exception 'Part of this kit is already out: %. Return it first.', v_busy; end if;
  end if;

  insert into public.inventory_checkouts (item_id, kit_id, holder_user, holder_name, out_by, due_on, note)
  values (p_item, p_kit, p_holder, v_name, v_me, p_due, coalesce(btrim(p_note), ''))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'holder_name', v_name);
end $$;
revoke all on function public.inventory_check_out(uuid, uuid, uuid, text, date, text) from public, anon;
grant execute on function public.inventory_check_out(uuid, uuid, uuid, text, date, text) to authenticated;

-- Check something back in. View-only people may only return what is checked out to them.
create function public.inventory_return(p_checkout bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_row public.inventory_checkouts;
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into v_row from public.inventory_checkouts where id = p_checkout and returned_at is null for update;
  if not found then raise exception 'That is already back.'; end if;
  if not public.can('inventory', 'edit') and v_row.holder_user is distinct from v_me then
    raise exception 'You can only return what is checked out to you.' using errcode = '42501';
  end if;
  update public.inventory_checkouts set returned_at = now(), returned_by = v_me where id = p_checkout;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.inventory_return(bigint) from public, anon;
grant execute on function public.inventory_return(bigint) to authenticated;

-- History of one item or kit (newest first), including checkouts of the kit an item belongs to.
create function public.inventory_history(p_item uuid, p_kit uuid, p_limit int default 20)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x)) from (
      select c.id, c.holder_name, c.out_at, c.due_on, c.note, c.returned_at, c.kit_id is not null and p_item is not null as with_kit
        from public.inventory_checkouts c
       where (p_item is not null and (c.item_id = p_item or c.kit_id = (select kit_id from public.inventory_items where id = p_item)))
          or (p_kit is not null and c.kit_id = p_kit)
       order by c.out_at desc
       limit least(greatest(coalesce(p_limit, 20), 1), 100)) x), '[]'::jsonb);
end $$;
revoke all on function public.inventory_history(uuid, uuid, int) from public, anon;
grant execute on function public.inventory_history(uuid, uuid, int) to authenticated;

-- ---------------------------------------------------------------- photos
-- Private bucket; the app shows photos through short-lived signed URLs. The browser shrinks each photo
-- to about 1600px JPEG before upload, so 5 MB is a generous ceiling.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inventory', 'inventory', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy inventory_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'inventory' and (select public.can('inventory', 'view')));
create policy inventory_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'inventory' and (select public.can('inventory', 'edit')));
create policy inventory_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'inventory' and (select public.can('inventory', 'edit')))
  with check (bucket_id = 'inventory' and (select public.can('inventory', 'edit')));
create policy inventory_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'inventory' and (select public.can('inventory', 'edit')));
