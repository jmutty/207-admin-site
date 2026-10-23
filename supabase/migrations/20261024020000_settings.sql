-- Settings rebuilt (2026-10-24, ws/settings).
--
-- Settings gets four new tabs (Team emails, Job types, Team & pay, Company); each setting has one home there and
-- may keep a shortcut on its old page. What the database needs for that:
--   1. admin_settings.calc_assumptions: the Job calculator's assumptions, saved for everyone (were per device).
--   2. settings_team_emails(): everything the Team emails tab shows, in one read (full access only), and
--      push_topic_set_default(): the default Push now / Morning email / Off for each kind of notification.
--   3. One person record on the Team page: team_list() carries max_drive_min, team_set_max_drive() saves it.
--   4. Part time and 1099 people get My day (assignments), Time clock (timeclock), My records (staffrecords)
--      and Open jobs (openjobs), all view, by default: when their type is set (team_set_profile, the Team save
--      path), from openjobs_person_save, and a backfill for people already set. Nothing is ever taken away.
--   5. Jobs the owner (full access) puts himself on are confirmed right away (crew_ask_ensure).
--   6. booking_type_add(): add a job type from Settings > Job types, starting from an existing one.
-- Safe to run more than once where practical; no existing signature changes.

-- ================================================================ 1. job calculator assumptions
alter table public.admin_settings add column if not exists calc_assumptions jsonb;
comment on column public.admin_settings.calc_assumptions is 'Job calculator assumptions (Settings > Job calculator), shared by everyone with full access. Null = the built-in defaults.';

-- ================================================================ 2. Team emails
create or replace function public.settings_team_emails()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.staff_settings; t public.timeclock_settings;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into s from public.staff_settings where id;
  select * into t from public.timeclock_settings where id;
  return jsonb_build_object(
    'day_plan_on', s.day_plan_on, 'day_plan_hour', s.day_plan_hour,
    'day_email_on', s.day_email_on, 'day_email_hour', s.day_email_hour,
    'crew_confirm_on', s.crew_confirm_on, 'week_email_auto', s.week_email_auto, 'week_email_dow', s.week_email_dow, 'week_email_hour', s.week_email_hour,
    'clock', jsonb_build_object('mileage_rate', t.mileage_rate, 'overtime_after', t.overtime_after, 'remind_before_min', t.remind_before_min,
                                'remind_out_after_min', t.remind_out_after_min, 'ot_warn_hours', t.ot_warn_hours),
    'topics', (select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'label', p.label, 'description', p.description, 'module', p.module,
                                                            'default_mode', p.default_mode) order by p.sort, p.label), '[]'::jsonb)
                 from public.push_topics p));
end $$;
revoke all on function public.settings_team_emails() from public, anon;
grant execute on function public.settings_team_emails() to authenticated;

-- The default for one kind of notification. A person's own choice (account menu) still wins.
create or replace function public.push_topic_set_default(p_topic text, p_mode text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('push', 'email', 'off') then raise exception 'Pick Push now, Morning email or Off.'; end if;
  update public.push_topics set default_mode = p_mode, default_on = p_mode <> 'off' where key = p_topic;
  if not found then raise exception 'unknown notification type'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.push_topic_set_default(text, text) from public, anon;
grant execute on function public.push_topic_set_default(text, text) to authenticated;

-- ================================================================ 3. one person record
create function pg_temp.patch_function(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

-- Team list: longest drive (only when it is not there yet, so a second run changes nothing).
do $$
begin
  if pg_get_functiondef('public.team_list()'::regprocedure) !~ 'max_drive_min' then
    perform pg_temp.patch_function('public.team_list()'::regprocedure,
      '''home_address'', m\.home_address,', '''home_address'', m.home_address, ''max_drive_min'', m.max_drive_min,', 1);
  end if;
end $$;

create or replace function public.team_set_max_drive(p_user_id uuid, p_min int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_min, 60) not between 5 and 300 then raise exception 'Longest drive is 5 to 300 minutes.'; end if;
  update public.team_members set max_drive_min = coalesce(p_min, 60), updated_at = now() where user_id = p_user_id;
  if not found then raise exception 'no such team member'; end if;
end $$;
revoke all on function public.team_set_max_drive(uuid, int) from public, anon;
grant execute on function public.team_set_max_drive(uuid, int) to authenticated;

-- ================================================================ 4. default access for Part time and 1099
-- Gives the person each of p_modules at view when they have no row for it yet (never lowers or removes).
-- Returns the modules it added.
create or replace function public.team_grant_defaults(p_user_id uuid, p_modules text[], p_via text)
returns text[] language plpgsql security definer set search_path = '' as $$
declare v_added text[];
begin
  with ins as (
    insert into public.team_permissions (user_id, module_key, level)
    select p_user_id, k, 'view' from unnest(p_modules) k
     where exists (select 1 from public.app_modules am where am.key = k)
    on conflict (user_id, module_key) do nothing
    returning module_key)
  select array_agg(module_key order by module_key) into v_added from ins;
  if v_added is not null then
    insert into public.team_audit (actor, target, action, detail)
    values ((select auth.uid()), p_user_id, 'updated',
            jsonb_build_object('modules', (select jsonb_object_agg(k, 'view') from unnest(v_added) k), 'via', p_via));
  end if;
  return coalesce(v_added, '{}');
end $$;
revoke all on function public.team_grant_defaults(uuid, text[], text) from public, anon, authenticated;

-- Setting the type (Team page save). Changing someone INTO Part time / 1099 gives them the four pages; Open jobs
-- is also given whenever it is missing, as before. Re-saving the same type does not put back a page you took away.
create or replace function public.team_set_profile(p_user_id uuid, p_type text, p_title text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.team_members; v_type text := nullif(btrim(coalesce(p_type, '')), ''); v_added text[] := '{}';
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
  if v_type in ('part_time', 'contractor') and not exists (select 1 from public.admin_users a where a.user_id = p_user_id) then
    if m.employment_type is distinct from v_type and coalesce(m.employment_type, '') not in ('part_time', 'contractor') then
      v_added := public.team_grant_defaults(p_user_id, array['openjobs', 'assignments', 'timeclock', 'staffrecords'], 'employment type');
    elsif not public.team_user_can(p_user_id, 'openjobs') then
      v_added := public.team_grant_defaults(p_user_id, array['openjobs'], 'employment type');
    end if;
  end if;
  return jsonb_build_object('ok', true, 'granted', cardinality(v_added) > 0, 'added', to_jsonb(v_added));
end $$;
revoke all on function public.team_set_profile(uuid, text, text) from public, anon;
grant execute on function public.team_set_profile(uuid, text, text) to authenticated;

-- Open jobs > Part-timers & 1099 (now read-only on the page, kept for older pages): a full-access person
-- saving a Part time / 1099 person fills in any of the four pages they have no row for.
create or replace function public.openjobs_person_save(p_user uuid, p_part_time boolean, p_home text, p_max_drive int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_added text[] := '{}';
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if length(coalesce(p_home, '')) > 300 then raise exception 'That address is too long.'; end if;
  if coalesce(p_max_drive, 60) not between 5 and 300 then raise exception 'Longest drive is 5 to 300 minutes.'; end if;
  update public.team_members
     set home_address = btrim(coalesce(p_home, '')), max_drive_min = coalesce(p_max_drive, 60), updated_at = now()
   where user_id = p_user and active;
  if not found then raise exception 'Pick someone on the team.'; end if;
  if public.gets_open_jobs(p_user) and public.is_admin() and not exists (select 1 from public.admin_users a where a.user_id = p_user) then
    v_added := public.team_grant_defaults(p_user, array['openjobs', 'assignments', 'timeclock', 'staffrecords'], 'Open jobs');
  end if;
  return jsonb_build_object('ok', true, 'granted', cardinality(v_added) > 0, 'added', to_jsonb(v_added));
end $$;

-- Backfill: everyone already set to Part time / 1099 (and not full access) gets any of the four they have no row
-- for. Existing rows (including edit) are left alone.
do $$
declare r record;
begin
  for r in select m.user_id from public.team_members m
            where m.active and m.employment_type in ('part_time', 'contractor')
              and not exists (select 1 from public.admin_users a where a.user_id = m.user_id)
  loop
    perform public.team_grant_defaults(r.user_id, array['openjobs', 'assignments', 'timeclock', 'staffrecords'], 'default access (2026-10-24)');
  end loop;
end $$;

-- ================================================================ 5. the owner's own jobs confirm themselves
-- Same as before, then: when the person put on the job is the full-access person doing it, their ask is
-- marked confirmed at once (nothing is emailed; it never shows as waiting).
create or replace function public.crew_ask_ensure(p_booking uuid, p_user uuid, p_changed boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.bookings b where b.id = p_booking and b.status = 'booked') then return; end if;
  insert into public.crew_asks (booking_id, user_id) values (p_booking, p_user)
  on conflict (booking_id, user_id) do update
     set status = 'pending', reason = '', answered_at = null, asked_at = null, reminded_at = null, queued_at = now(),
         changed = public.crew_asks.status <> 'declined'
   where public.crew_asks.status = 'declined' or (p_changed and public.crew_asks.asked_at is not null);
  if p_user = (select auth.uid()) and exists (select 1 from public.admin_users a where a.user_id = p_user) then
    update public.crew_asks set status = 'confirmed', answered_at = now(), changed = false
     where booking_id = p_booking and user_id = p_user and status = 'pending';
  end if;
end $$;

-- ================================================================ 6. add a job type
-- Copies an existing type (audience, title labels, duration, everything else) under a new label and key.
-- Stages are seeded by the existing insert trigger. The new type has no booking email sequence yet.
create or replace function public.booking_type_add(p_label text, p_copy_from text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_label text := btrim(coalesce(p_label, '')); v_base text; v_key text; v_n int := 1; v_row jsonb; v_cols text;
begin
  if not public.can('bookings', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if length(v_label) < 2 or length(v_label) > 60 then raise exception 'Give the job type a name (2 to 60 letters).'; end if;
  if exists (select 1 from public.booking_types t where lower(t.label) = lower(v_label)) then raise exception 'There is already a job type called that.'; end if;
  select to_jsonb(t) into v_row from public.booking_types t where t.key = p_copy_from;
  if v_row is null then raise exception 'Pick a job type to start from.'; end if;
  v_base := left(btrim(regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g'), '_'), 40);
  if v_base = '' then v_base := 'type'; end if;
  v_key := v_base;
  while exists (select 1 from public.booking_types t where t.key = v_key) loop
    v_n := v_n + 1; v_key := v_base || '_' || v_n;
  end loop;
  v_row := (v_row - 'id' - 'created_at' - 'updated_at')
           || jsonb_build_object('key', v_key, 'label', v_label,
                                 'sort_order', (select coalesce(max(t.sort_order), 0) + 10 from public.booking_types t));
  if v_row ? 'description' then v_row := v_row || jsonb_build_object('description', ''); end if;
  select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(v_row) k;
  execute format('insert into public.booking_types (%s) select %s from jsonb_populate_record(null::public.booking_types, $1)', v_cols, v_cols) using v_row;
  return jsonb_build_object('ok', true, 'key', v_key);
end $$;
revoke all on function public.booking_type_add(text, text) from public, anon;
grant execute on function public.booking_type_add(text, text) to authenticated;
