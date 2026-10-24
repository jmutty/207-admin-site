-- Partner groups (2026-10-24, Jeremiah): a school sits under its district (RSU 22: Hampden Academy, Reeds Brook,
-- Wagner, ...) and a league can sit under a bigger league or district, so they stay connected and can be viewed
-- together, while each stays its own partner with its own contacts, jobs and emails.
--
--   prospect_orgs.parent_id          the group this partner is part of. One level only: a group can't itself be
--                                    part of another group. Not the same as merged_into, which is for duplicates.
--   partner_agreements.covers_members  a group's agreement that covers all its members. Their pages show
--                                    "Covered by <group>'s agreement" when they have none of their own.
--   agreement_set_covers(id, on)     turns that on or off (Agreement & rebooking tab on the group's page).
--
-- The group's contacts and agreement show on each member's page and are never copied ("show, don't copy").
-- Linking and unlinking is a plain update of parent_id (partners edit access, same as Rename); the trigger below
-- keeps it one level deep. Merging a partner that has members moves the members onto the partner kept.

alter table public.prospect_orgs add column if not exists parent_id uuid references public.prospect_orgs (id);
create index if not exists prospect_orgs_parent_id_idx on public.prospect_orgs (parent_id) where parent_id is not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'prospect_orgs_parent_not_self') then
    alter table public.prospect_orgs add constraint prospect_orgs_parent_not_self check (parent_id is distinct from id);
  end if;
end $$;

alter table public.partner_agreements add column if not exists covers_members boolean not null default false;

create or replace function public.prospect_orgs_parent() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_keep uuid; v_keep_parent uuid; p public.prospect_orgs;
begin
  -- Merged into another partner: its members follow it to the partner kept, and it leaves its own group.
  if tg_op = 'UPDATE' and old.merged_into is null and new.merged_into is not null then
    v_keep := new.merged_into;
    update public.prospect_orgs set parent_id = null where id = v_keep and parent_id = new.id;
    select parent_id into v_keep_parent from public.prospect_orgs where id = v_keep;
    if v_keep_parent is null then
      update public.prospect_orgs set parent_id = v_keep where parent_id = new.id and id <> v_keep;
      if new.parent_id is not null and new.parent_id <> v_keep
         and not exists (select 1 from public.prospect_orgs where parent_id = v_keep) then
        update public.prospect_orgs set parent_id = new.parent_id where id = v_keep;
      end if;
    else
      update public.prospect_orgs set parent_id = null where parent_id = new.id;
    end if;
    new.parent_id := null;
    return new;
  end if;
  if new.parent_id is null or (tg_op = 'UPDATE' and new.parent_id is not distinct from old.parent_id) then return new; end if;
  select * into p from public.prospect_orgs where id = new.parent_id;
  if p.id is null then raise exception 'That partner doesn''t exist any more.'; end if;
  if p.merged_into is not null then raise exception '% was merged into another partner. Pick that one instead.', p.name; end if;
  if p.parent_id is not null then
    raise exception '% is already part of %, so it can''t have its own members. Pick %.', p.name,
      (select name from public.prospect_orgs where id = p.parent_id), (select name from public.prospect_orgs where id = p.parent_id);
  end if;
  if tg_op = 'UPDATE' and exists (select 1 from public.prospect_orgs where parent_id = new.id) then
    raise exception '% has its own members, so it can''t go under another partner.', new.name;
  end if;
  return new;
end $$;

create or replace trigger prospect_orgs_parent before insert or update of parent_id, merged_into on public.prospect_orgs
  for each row execute function public.prospect_orgs_parent();

create or replace function public.agreement_set_covers(p_id uuid, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.partner_agreements set covers_members = coalesce(p_on, false), updated_at = now() where id = p_id;
  if not found then raise exception 'That agreement doesn''t exist any more.'; end if;
end $$;
revoke all on function public.agreement_set_covers(uuid, boolean) from public, anon;
grant execute on function public.agreement_set_covers(uuid, boolean) to authenticated;

-- RSU 22's schools (Hampden, Newburgh, Winterport): the district record already exists as a client.
update public.prospect_orgs s set parent_id = d.id
  from public.prospect_orgs d
 where d.name = 'RSU 22' and d.merged_into is null and d.parent_id is null
   and s.merged_into is null and s.parent_id is null and s.id <> d.id
   and s.name in ('Hampden Academy', 'Reeds Brook Middle School', 'Wagner Middle School',
                  'Earl C McGraw School', 'George B Weatherbee School', 'Leroy H Smith School');
