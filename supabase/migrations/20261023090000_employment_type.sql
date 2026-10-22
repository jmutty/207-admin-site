-- Employment type and job title (2026-10-23).
--
-- Team page: every person can have a job title ("Lead photographer") and an employment type:
--   full_time   Full time (hourly)
--   salaried    Salaried: hours are tracked, but no overtime
--   part_time   Part time: gets Open jobs offers
--   contractor  1099 contractor: gets Open jobs offers; hours and miles are kept out of the payroll CSV
--               (the Payroll dialog lists them separately with their own CSV)
-- Null = not set yet (treated like full time for overtime; no Open jobs offers).
--
-- Open jobs used team_members.part_time ("gets offers"); offers now go to Part time and 1099 people, and
-- existing part-timers become Part time. The part_time column stays (unused) so nothing is dropped.
-- Setting someone to Part time or 1099 also gives them Open jobs (view) if they had no access to it.

alter table public.team_members
  add column employment_type text check (employment_type in ('full_time', 'salaried', 'part_time', 'contractor')),
  add column job_title text not null default '' check (length(job_title) <= 80);
comment on column public.team_members.employment_type is 'full_time / salaried / part_time / contractor (1099). Null = not set. Part time + 1099 get Open jobs offers; salaried + 1099 get no overtime.';
comment on column public.team_members.job_title is 'Job title shown on the Team page.';
comment on column public.team_members.part_time is 'Superseded by employment_type (2026-10-23); no longer read.';
update public.team_members set employment_type = 'part_time' where part_time and employment_type is null;

-- Does this person get Open jobs offers? / Does overtime apply to them?
create function public.gets_open_jobs(p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members m where m.user_id = p_uid and m.employment_type in ('part_time', 'contractor'))
$$;
create function public.overtime_applies(p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select m.employment_type not in ('salaried', 'contractor') or m.employment_type is null from public.team_members m where m.user_id = p_uid), true)
$$;
revoke all on function public.gets_open_jobs(uuid), public.overtime_applies(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- Team page (full access only)
create function public.team_set_profile(p_user_id uuid, p_type text, p_title text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.team_members; v_type text := nullif(btrim(coalesce(p_type, '')), ''); v_granted boolean := false;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_type is not null and v_type not in ('full_time', 'salaried', 'part_time', 'contractor') then raise exception 'Pick an employment type.'; end if;
  if length(btrim(coalesce(p_title, ''))) > 80 then raise exception 'That job title is too long.'; end if;
  select * into m from public.team_members where user_id = p_user_id;
  if not found then raise exception 'no such team member'; end if;
  if m.employment_type is distinct from v_type or m.job_title is distinct from btrim(coalesce(p_title, '')) then
    update public.team_members set employment_type = v_type, job_title = btrim(coalesce(p_title, '')), updated_at = now() where user_id = p_user_id;
    insert into public.team_audit (actor, target, action, detail)
    values ((select auth.uid()), p_user_id, 'profile_set', jsonb_build_object('before', jsonb_build_object('type', m.employment_type, 'title', m.job_title),
                                                                             'after', jsonb_build_object('type', v_type, 'title', btrim(coalesce(p_title, '')))));
  end if;
  if v_type in ('part_time', 'contractor') and not public.team_user_can(p_user_id, 'openjobs') then
    insert into public.team_permissions (user_id, module_key, level) values (p_user_id, 'openjobs', 'view') on conflict (user_id, module_key) do nothing;
    insert into public.team_audit (actor, target, action, detail)
    values ((select auth.uid()), p_user_id, 'updated', jsonb_build_object('modules', jsonb_build_object('openjobs', 'view'), 'via', 'employment type'));
    v_granted := true;
  end if;
  return jsonb_build_object('ok', true, 'granted', v_granted);
end $$;
revoke all on function public.team_set_profile(uuid, text, text) from public, anon;
grant execute on function public.team_set_profile(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- patch existing functions
create function pg_temp.patch_function(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

-- Team list: title and type.
select pg_temp.patch_function('public.team_list()'::regprocedure,
  '''weekly_hours'', m\.weekly_hours,', '''weekly_hours'', m.weekly_hours, ''employment_type'', m.employment_type, ''job_title'', m.job_title,', 1);

-- Open jobs: offers go to Part time + 1099.
select pg_temp.patch_function('public.openjobs_people()'::regprocedure, 'm\.part_time', 'public.gets_open_jobs(m.user_id)', 2);
select pg_temp.patch_function('public.openjobs_people()'::regprocedure,
  '''home_address'', m\.home_address,', '''home_address'', m.home_address, ''employment_type'', m.employment_type, ''job_title'', m.job_title,', 1);
select pg_temp.patch_function('public.offer_drive_targets(uuid)'::regprocedure, 'm\.active and m\.part_time', 'm.active and public.gets_open_jobs(m.user_id)', 1);
select pg_temp.patch_function('public.openjobs_candidates(uuid)'::regprocedure, 'm\.active and m\.part_time', 'm.active and public.gets_open_jobs(m.user_id)', 1);
select pg_temp.patch_function('public.openjobs_post(jsonb)'::regprocedure,
  'Mark them part-time first\.', 'Set them to Part time or 1099 on the Team page first.', 1);

-- Home address and longest drive (Open jobs, Edit). p_part_time is no longer used: who gets offers comes from
-- the employment type on the Team page. A full-access person saving a Part time / 1099 person without
-- Open jobs access still gives them view.
create or replace function public.openjobs_person_save(p_user uuid, p_part_time boolean, p_home text, p_max_drive int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_granted boolean := false;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if length(coalesce(p_home, '')) > 300 then raise exception 'That address is too long.'; end if;
  if coalesce(p_max_drive, 60) not between 5 and 300 then raise exception 'Longest drive is 5 to 300 minutes.'; end if;
  update public.team_members
     set home_address = btrim(coalesce(p_home, '')), max_drive_min = coalesce(p_max_drive, 60), updated_at = now()
   where user_id = p_user and active;
  if not found then raise exception 'Pick someone on the team.'; end if;
  if public.gets_open_jobs(p_user) and public.is_admin() and not public.team_user_can(p_user, 'openjobs') then
    insert into public.team_permissions (user_id, module_key, level) values (p_user, 'openjobs', 'view')
    on conflict (user_id, module_key) do nothing;
    insert into public.team_audit (actor, target, action, detail)
    values ((select auth.uid()), p_user, 'updated', jsonb_build_object('modules', jsonb_build_object('openjobs', 'view'), 'via', 'Open jobs'));
    v_granted := true;
  end if;
  return jsonb_build_object('ok', true, 'granted', v_granted);
end $$;

-- Time clock: no overtime for salaried and 1099; the type rides along so the page can split out contractors.
select pg_temp.patch_function('public.timesheet_week(date, uuid, boolean)'::regprocedure,
  '''weekly_hours'', \(select m\.weekly_hours from public\.team_members m where m\.user_id = u\.uid\),',
  '''weekly_hours'', (select m.weekly_hours from public.team_members m where m.user_id = u.uid), ''employment_type'', (select m.employment_type from public.team_members m where m.user_id = u.uid), ''overtime_applies'', public.overtime_applies(u.uid),', 1);
select pg_temp.patch_function('public.timesheet_payroll(date, integer)'::regprocedure,
  'coalesce\(sum\(greatest\(0, wk\.worked - round\(s\.overtime_after \* 60\)\)\), 0\)::int as ot',
  'case when public.overtime_applies(u.user_id) then coalesce(sum(greatest(0, wk.worked - round(s.overtime_after * 60))), 0)::int else 0 end as ot', 1);
select pg_temp.patch_function('public.timesheet_payroll(date, integer)'::regprocedure,
  '''email'', \(select u\.email from auth\.users u where u\.id = x\.user_id\),',
  '''email'', (select u.email from auth.users u where u.id = x.user_id), ''employment_type'', (select m.employment_type from public.team_members m where m.user_id = x.user_id), ''job_title'', (select m.job_title from public.team_members m where m.user_id = x.user_id),', 1);
