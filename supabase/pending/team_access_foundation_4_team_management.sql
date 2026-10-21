-- PENDING (2026-10-21): part 4 of the team access foundation, not yet applied to production.
-- Paste into Supabase Dashboard -> SQL Editor -> Run (or ask Claude to apply it and approve the prompt).
-- Safe to run once; it only creates the two team-management functions. See supabase/README.md.

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

revoke all on function public.team_save(uuid, text, boolean, jsonb) from public, anon;
grant execute on function public.team_save(uuid, text, boolean, jsonb) to authenticated, service_role;
revoke all on function public.team_set_active(uuid, boolean) from public, anon;
grant execute on function public.team_set_active(uuid, boolean) to authenticated, service_role;
