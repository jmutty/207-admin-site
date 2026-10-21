-- Team access foundation (2026-10-21).
--
-- Adds people other than the owner, with per-module access (none / view / edit), WITHOUT changing
-- what any existing policy or RPC allows. After this migration alone:
--   * admin_users keeps its meaning: "full access" (the owner, and anyone given full access later).
--     is_admin() is unchanged, so every existing policy, RPC and the admin edge function behave exactly
--     as before.
--   * team_members / team_permissions hold everyone else. They can sign in (password + emailed code,
--     same as the owner) but see no data until 20261021120100_module_scoped_access swaps the
--     is_admin() checks for module checks.
--
-- New building blocks for every future module:
--   public.can(module, level)            -> boolean. Use in RLS policies and RPCs: (select public.can('scheduling', 'edit'))
--   public.can_any(modules[], level)     -> boolean. For data shared by several modules.
--   public.is_team_member()              -> any signed-in, trusted, active person (owner included).
--   public.app_modules                   -> the registry of modules people can be given access to.

-- ---------------------------------------------------------------- registry
create table public.app_modules (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  label       text not null,
  section     text not null,
  description text not null default '',
  sort        int  not null default 100,
  status      text not null default 'live' check (status in ('live', 'planned')),
  admin_only  boolean not null default false
);
comment on table public.app_modules is
  'Modules (areas of 207 Admin) a team member can be given access to. One row per module; add the row in the migration that creates the module. status=planned rows show on the Team page as "coming soon" so access can be granted ahead of launch. admin_only modules are never grantable (full-access people only).';

insert into public.app_modules (key, label, section, description, sort, status, admin_only) values
  ('bookings',     'Bookings',                 'Jobs',     'Picture-day bookings, their emails, coaches, calendar sync and the job calculator.', 10, 'live', false),
  ('galleries',    'Galleries',                'Jobs',     'GotPhoto galleries, per-job search fields and Sync now.', 20, 'live', false),
  ('hub',          'Hub',                      'Jobs',     'Hub activity and the schools listed on the Communications Hub.', 30, 'live', false),
  ('parents',      'Parent help',              'Parents',  'Help requests, makeups and retake requests.', 40, 'live', false),
  ('findmyphotos', 'Find My Photos',           'Parents',  'Search activity, search rules, blocked names and IPs.', 50, 'live', false),
  ('partners',     'Organizations & outreach', 'Partners', 'Organizations, contacts, outbox, outreach review and the email library.', 60, 'live', false),
  ('settings',     'Settings',                 'System',   'Sending settings, morning digest, sync settings.', 90, 'live', true),
  ('team',         'Team',                     'System',   'Add people and decide what they can see.', 95, 'live', true),
  ('scheduling',   'Employee scheduling',      'Staff',    'Shifts and who works which picture day.', 200, 'planned', false),
  ('timeclock',    'Time clock',               'Staff',    'Clock in / clock out and timesheets.', 210, 'planned', false),
  ('inventory',    'Inventory',                'Operations', 'Equipment and supplies.', 220, 'planned', false),
  ('workflows',    'Workflows',                'Operations', 'Checklists and task pipelines.', 230, 'planned', false);

-- ---------------------------------------------------------------- people
create table public.team_members (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  display_name         text not null default '' check (length(display_name) <= 120),
  active               boolean not null default true,
  must_change_password boolean not null default false,
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now()
);
comment on table public.team_members is
  'Everyone who can sign in to 207 Admin (the owner included). Full access = a row in admin_users; everyone else gets only the modules in team_permissions. Managed from the Team page.';

create table public.team_permissions (
  user_id    uuid not null references public.team_members (user_id) on delete cascade,
  module_key text not null references public.app_modules (key) on update cascade on delete cascade,
  level      text not null check (level in ('view', 'edit')),
  primary key (user_id, module_key)
);
comment on table public.team_permissions is 'Per-person module access. No row = no access. edit implies view.';

create table public.team_audit (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  target     uuid,
  action     text not null,
  detail     jsonb not null default '{}'::jsonb
);
comment on table public.team_audit is 'Who changed whose access, and when. Written only by the team_* functions.';
create index team_audit_at_idx on public.team_audit (at desc);

alter table public.app_modules      enable row level security;
alter table public.team_members     enable row level security;
alter table public.team_permissions enable row level security;
alter table public.team_audit       enable row level security;
-- All reads/writes go through the functions below; nothing is directly readable except the registry.
revoke all on public.app_modules, public.team_members, public.team_permissions, public.team_audit from anon, authenticated;
grant select on public.app_modules to authenticated;
create policy app_modules_read on public.app_modules for select to authenticated using (true);

-- The owner (and anyone else already in admin_users) gets a team_members row.
insert into public.team_members (user_id, display_name)
select a.user_id, coalesce(nullif(u.raw_user_meta_data ->> 'name', ''), split_part(u.email, '@', 1))
  from public.admin_users a join auth.users u on u.id = a.user_id
on conflict do nothing;

-- ---------------------------------------------------------------- checks
-- May this auth user sign in at all? (Used by the email-code / device steps, before the session is trusted.)
create function public.is_team_user(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_uid is not null and (
    exists (select 1 from public.admin_users a where a.user_id = p_uid)
    or exists (select 1 from public.team_members m where m.user_id = p_uid and m.active))
$$;

-- Any active person on a trusted session (owner included). Use for things every team member gets:
-- their own devices, the sync-status header, the module registry.
create function public.is_team_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_team_user((select auth.uid())) and public.admin_session_ok()
$$;

-- The one module check. Full-access people pass everything (so is_admin() => can_any() for any input);
-- others need an edit row for 'edit', or a view/edit row for 'view'. Unknown levels fail closed.
create function public.can_any(p_modules text[], p_level text default 'view')
returns boolean language sql stable security definer set search_path = '' as $$
  select p_level in ('view', 'edit') and public.admin_session_ok() and (
    exists (select 1 from public.admin_users a where a.user_id = (select auth.uid()))
    or exists (select 1 from public.team_members m
                 join public.team_permissions p on p.user_id = m.user_id
                 join public.app_modules am on am.key = p.module_key and not am.admin_only
                where m.user_id = (select auth.uid()) and m.active
                  and p.module_key = any (p_modules)
                  and (p.level = 'edit' or p_level = 'view')))
$$;

create function public.can(p_module text, p_level text default 'view')
returns boolean language sql stable security definer set search_path = '' as $$
  select public.can_any(array[p_module], p_level)
$$;

-- What the signed-in person may see: drives the menu in the app. The server enforces the same rules.
create function public.my_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  with me as (
    select (select auth.uid()) as uid,
           exists (select 1 from public.admin_users a where a.user_id = (select auth.uid())) as is_admin,
           public.admin_session_ok() as trusted)
  select jsonb_build_object(
    'user_id', me.uid,
    'email', u.email,
    'name', coalesce(nullif(m.display_name, ''), split_part(u.email, '@', 1)),
    'is_admin', me.is_admin,
    'active', me.is_admin or coalesce(m.active, false),
    'trusted', me.trusted,
    'must_change_password', coalesce(m.must_change_password, false),
    'modules', case
      when not me.trusted then '{}'::jsonb
      when me.is_admin then (select coalesce(jsonb_object_agg(am.key, 'edit'), '{}'::jsonb) from public.app_modules am)
      when coalesce(m.active, false) then (select coalesce(jsonb_object_agg(p.module_key, p.level), '{}'::jsonb)
                                             from public.team_permissions p join public.app_modules am on am.key = p.module_key and not am.admin_only
                                            where p.user_id = me.uid)
      else '{}'::jsonb end)
  from me
  left join auth.users u on u.id = me.uid
  left join public.team_members m on m.user_id = me.uid
$$;

-- ---------------------------------------------------------------- team management (full-access only)
create function public.team_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', m.user_id,
             'email', u.email,
             'name', m.display_name,
             'is_admin', exists (select 1 from public.admin_users a where a.user_id = m.user_id),
             'is_me', m.user_id = (select auth.uid()),
             'active', m.active,
             'must_change_password', m.must_change_password,
             'created_at', m.created_at,
             'last_sign_in_at', u.last_sign_in_at,
             'modules', (select coalesce(jsonb_object_agg(p.module_key, p.level), '{}'::jsonb)
                           from public.team_permissions p where p.user_id = m.user_id))
           order by (exists (select 1 from public.admin_users a where a.user_id = m.user_id)) desc, m.active desc, lower(m.display_name))
      from public.team_members m join auth.users u on u.id = m.user_id), '[]'::jsonb);
end $$;

-- Create-or-update a person's profile and access. p_permissions = {"bookings": "edit", "parents": "view", ...};
-- modules left out (or "none") get no access. Called by the Team page (edit) and the `team` edge function (add).
create function public.team_save(p_user_id uuid, p_name text, p_is_admin boolean, p_permissions jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_before jsonb; v_after jsonb; v_key text; v_level text; v_new boolean;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then raise exception 'no such user'; end if;
  if jsonb_typeof(coalesce(p_permissions, '{}'::jsonb)) <> 'object' then raise exception 'permissions must be an object'; end if;
  if p_user_id = v_me and not coalesce(p_is_admin, false) then raise exception 'You cannot remove your own full access.'; end if;

  for v_key, v_level in select key, value from jsonb_each_text(coalesce(p_permissions, '{}'::jsonb)) loop
    if v_level not in ('view', 'edit', 'none') then raise exception 'bad level % for %', v_level, v_key; end if;
    if not exists (select 1 from public.app_modules where key = v_key and not admin_only) then raise exception 'unknown module %', v_key; end if;
  end loop;

  select jsonb_build_object('name', m.display_name,
                            'is_admin', exists (select 1 from public.admin_users a where a.user_id = m.user_id),
                            'modules', (select coalesce(jsonb_object_agg(p.module_key, p.level), '{}'::jsonb) from public.team_permissions p where p.user_id = m.user_id))
    into v_before from public.team_members m where m.user_id = p_user_id;
  v_new := v_before is null;

  insert into public.team_members (user_id, display_name, created_by)
  values (p_user_id, left(btrim(coalesce(p_name, '')), 120), v_me)
  on conflict (user_id) do update set display_name = excluded.display_name, updated_at = now();

  if coalesce(p_is_admin, false) then
    insert into public.admin_users (user_id, note) values (p_user_id, 'full access granted on the Team page') on conflict do nothing;
  else
    delete from public.admin_users where user_id = p_user_id;
  end if;

  delete from public.team_permissions where user_id = p_user_id;
  insert into public.team_permissions (user_id, module_key, level)
  select p_user_id, key, value from jsonb_each_text(coalesce(p_permissions, '{}'::jsonb)) where value in ('view', 'edit');

  v_after := jsonb_build_object('name', left(btrim(coalesce(p_name, '')), 120), 'is_admin', coalesce(p_is_admin, false),
                                'modules', (select coalesce(jsonb_object_agg(module_key, level), '{}'::jsonb) from public.team_permissions where user_id = p_user_id));
  insert into public.team_audit (actor, target, action, detail)
  values (v_me, p_user_id, case when v_new then 'added' else 'updated' end, jsonb_build_object('before', v_before, 'after', v_after));
  return jsonb_build_object('ok', true);
end $$;

-- Deactivate / reactivate. A deactivated person keeps their history but can't sign in (no code is sent)
-- and every module check fails immediately. The `team` edge function also bans/unbans the auth user.
create function public.team_set_active(p_user_id uuid, p_active boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user_id = (select auth.uid()) then raise exception 'You cannot deactivate yourself.'; end if;
  if not p_active and exists (select 1 from public.admin_users where user_id = p_user_id) then
    raise exception 'Remove full access before deactivating this person.';
  end if;
  update public.team_members set active = p_active, updated_at = now() where user_id = p_user_id;
  if not found then raise exception 'no such team member'; end if;
  if not p_active then
    delete from public.admin_trusted_sessions where user_id = p_user_id;
    delete from public.admin_devices where user_id = p_user_id;
    delete from public.admin_login_codes where user_id = p_user_id;
  end if;
  insert into public.team_audit (actor, target, action) values ((select auth.uid()), p_user_id, case when p_active then 'reactivated' else 'deactivated' end);
  return jsonb_build_object('ok', true);
end $$;

-- Set by the `team` edge function after it sets a temporary password; cleared by the person once they change it.
create function public.team_flag_password(p_user_id uuid, p_flag boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.team_members set must_change_password = p_flag, updated_at = now() where user_id = p_user_id;
  if not found then raise exception 'no such team member'; end if;
  insert into public.team_audit (actor, target, action) values ((select auth.uid()), p_user_id, case when p_flag then 'temp_password_set' else 'temp_password_cleared' end);
end $$;

create function public.me_password_changed()
returns void language sql security definer set search_path = '' as $$
  update public.team_members set must_change_password = false, updated_at = now()
   where user_id = (select auth.uid()) and public.is_team_member();
$$;

create function public.team_audit_list(p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('at', t.at, 'action', t.action, 'detail', t.detail,
                                        'actor', coalesce(nullif(am.display_name, ''), au.email),
                                        'target', coalesce(nullif(tm.display_name, ''), tu.email)) order by t.at desc)
      from (select * from public.team_audit order by at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) t
      left join public.team_members am on am.user_id = t.actor left join auth.users au on au.id = t.actor
      left join public.team_members tm on tm.user_id = t.target left join auth.users tu on tu.id = t.target), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function public.is_team_user(uuid) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'public.is_team_member()', 'public.can_any(text[], text)', 'public.can(text, text)', 'public.my_access()',
    'public.team_list()', 'public.team_save(uuid, text, boolean, jsonb)', 'public.team_set_active(uuid, boolean)',
    'public.team_flag_password(uuid, boolean)', 'public.me_password_changed()', 'public.team_audit_list(int)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- sign-in steps accept team members
-- The emailed-code and remembered-device steps checked admin_users directly; they now accept any active
-- team member. Patched in place so the rest of each function stays byte-for-byte what is deployed.
create function pg_temp.patch_function(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

select pg_temp.patch_function('public.admin_send_code()'::regprocedure,
  'not exists \(select 1 from public\.admin_users where user_id = v_uid\)', 'not public.is_team_user(v_uid)', 1);
select pg_temp.patch_function('public.admin_use_device(text)'::regprocedure,
  'not exists \(select 1 from public\.admin_users where user_id = v_uid\)', 'not public.is_team_user(v_uid)', 1);
select pg_temp.patch_function('public.admin_remember_device(text)'::regprocedure,
  'not public\.is_admin\(\)', 'not public.is_team_member()', 1);
select pg_temp.patch_function('public.admin_devices_list()'::regprocedure,
  'public\.is_admin\(\)', 'public.is_team_member()', 1);
select pg_temp.patch_function('public.admin_forget_device(uuid)'::regprocedure,
  'public\.is_admin\(\)', 'public.is_team_member()', 1);
