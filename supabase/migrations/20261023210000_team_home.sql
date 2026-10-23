-- Home address on the Team page (2026-10-23). Drive times for Part time / 1099 people start from home, so the
-- add/edit person form takes it too (it used to be only under Open jobs > Part-timers & 1099). A town alone is
-- fine: drive times are measured to it.

create function pg_temp.patch_function(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

select pg_temp.patch_function('public.team_list()'::regprocedure,
  '''job_title'', m\.job_title,', '''job_title'', m.job_title, ''home_address'', m.home_address,', 1);

create function public.team_set_home(p_user_id uuid, p_home text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_home, ''))) > 300 then raise exception 'That address is too long.'; end if;
  update public.team_members set home_address = btrim(coalesce(p_home, '')), updated_at = now() where user_id = p_user_id;
  if not found then raise exception 'no such team member'; end if;
end $$;
revoke all on function public.team_set_home(uuid, text) from public, anon;
grant execute on function public.team_set_home(uuid, text) to authenticated;
