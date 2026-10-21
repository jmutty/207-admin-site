-- Remove a team member (2026-10-21).
--
-- Deactivating keeps a person on the Team page forever. team_remove takes a deactivated person off it:
-- their team_members row goes (access, notification devices and preferences cascade with it), and the
-- `team` edge function then deletes their login (auth user). Only people already deactivated can be
-- removed, so removal is always a second, deliberate step.
--
-- team_audit has no foreign keys, so the history stays. The 'removed' row keeps the person's name and
-- email in its detail, and team_audit_list falls back to it, so old log lines still say who it was.

create function public.team_remove(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_name text; v_email text; v_active boolean;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user_id = (select auth.uid()) then raise exception 'You cannot remove yourself.'; end if;
  select m.display_name, u.email, m.active into v_name, v_email, v_active
    from public.team_members m left join auth.users u on u.id = m.user_id where m.user_id = p_user_id;
  if not found then raise exception 'no such team member'; end if;
  if v_active then raise exception 'Deactivate this person before removing them.'; end if;
  if exists (select 1 from public.admin_users where user_id = p_user_id) then
    raise exception 'Remove full access before removing this person.';
  end if;

  insert into public.team_audit (actor, target, action, detail)
  values ((select auth.uid()), p_user_id, 'removed', jsonb_build_object('name', v_name, 'email', v_email));
  delete from public.team_members where user_id = p_user_id;
  delete from public.admin_trusted_sessions where user_id = p_user_id;
  delete from public.admin_devices where user_id = p_user_id;
  delete from public.admin_login_codes where user_id = p_user_id;
  return jsonb_build_object('ok', true);
end $$;

-- Same as before, plus: a removed person's name comes from their 'removed' audit row.
create or replace function public.team_audit_list(p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('at', t.at, 'action', t.action, 'detail', t.detail,
                                        'actor', coalesce(nullif(am.display_name, ''), nullif(ra.detail ->> 'name', ''), au.email, ra.detail ->> 'email'),
                                        'target', coalesce(nullif(tm.display_name, ''), nullif(rt.detail ->> 'name', ''), tu.email, rt.detail ->> 'email')) order by t.at desc)
      from (select * from public.team_audit order by at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) t
      left join public.team_members am on am.user_id = t.actor left join auth.users au on au.id = t.actor
      left join public.team_members tm on tm.user_id = t.target left join auth.users tu on tu.id = t.target
      left join lateral (select r.detail from public.team_audit r where r.action = 'removed' and r.target = t.actor order by r.at desc limit 1) ra on true
      left join lateral (select r.detail from public.team_audit r where r.action = 'removed' and r.target = t.target order by r.at desc limit 1) rt on true), '[]'::jsonb);
end $$;

revoke all on function public.team_remove(uuid) from public, anon;
grant execute on function public.team_remove(uuid) to authenticated, service_role;
