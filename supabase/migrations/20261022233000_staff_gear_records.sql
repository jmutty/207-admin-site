-- Staff and gear records (2026-10-22).
--
-- Staff records (module 'staffrecords', page #staff/clearances and #staff/onboarding):
--   staff_clearance_types   kinds of clearance (background check, SafeSport, school fingerprinting...). A type
--                           marked school_required must be current for anyone scheduled on a school job.
--   staff_clearances        one row per person per type: when it was done, when it runs out (null = never),
--                           a certificate or reference number and a note.
--   staff_onboarding_steps  the checklist every new person goes through. A step can be ticked by the person
--                           themselves (self_check), and a step tied to a clearance type ticks itself once that
--                           clearance is on file and current.
--   staff_onboarding        who is being onboarded (added automatically for everyone added to the team from
--                           now on; started by hand for anyone else) and when they finished.
--   staff_onboarding_done   the ticked steps.
--   View = your own clearances and checklist (and tick your self_check steps). Edit = everyone's.
--
-- School-job warnings: a booked school job (booking type audience 'school', bookings.status = 'booked') in the
-- next 30 days with someone on the schedule whose school_required clearance is missing, or runs out before
-- that day. Shown on the Staff records page and Today, and each morning (8am Eastern) a push notification goes
-- to managers (Staff records Edit) for problems in the next 14 days, and to the person whose clearance it is.
--
-- Gear care (module 'inventory'): purchase date, price paid, current value and a service interval on each
-- inventory item, plus a service log (service, sensor clean, repair). The Inventory "Gear" tab lists it and
-- exports an insurance list (CSV, built in the browser from inventory_items_v).

-- ---------------------------------------------------------------- module
insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('staffrecords', 'Staff records', 'Staff',
        'Clearances (background checks, SafeSport, school fingerprinting) with expiry dates, school-job warnings, and the onboarding checklist for new people. View = your own; Edit = everyone''s.',
        215, 'live', false)
on conflict (key) do update set status = 'live', label = excluded.label, section = excluded.section, description = excluded.description;

update public.app_modules
   set description = 'Bins and what is in them, serial numbers, kits, photos, who has what checked out, and gear value, service dates and the insurance list.'
 where key = 'inventory';

insert into public.push_topics (key, label, description, module, sort)
values ('clearance_warning', 'Clearance warning', 'Each morning, if someone on a school job in the next two weeks has a missing or expired clearance.', 'staffrecords', 75)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- tables: clearances
create table public.staff_clearance_types (
  key             text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  label           text not null check (btrim(label) <> '' and length(label) <= 80),
  school_required boolean not null default false,
  warn_days       int not null default 30 check (warn_days between 0 and 365),
  sort            int not null default 100,
  archived        boolean not null default false
);
comment on table public.staff_clearance_types is 'Kinds of staff clearance. school_required = must be current for anyone scheduled on a school job. warn_days = how early "runs out soon" shows.';

insert into public.staff_clearance_types (key, label, school_required, warn_days, sort) values
  ('background',  'Background check',                true,  30, 10),
  ('fingerprint', 'School fingerprinting (CHRC)',    false, 30, 20),
  ('safesport',   'SafeSport training',              false, 30, 30);

create table public.staff_clearances (
  user_id    uuid not null references public.team_members (user_id) on delete cascade,
  type_key   text not null references public.staff_clearance_types (key) on update cascade on delete cascade,
  done_on    date,
  expires_on date,
  reference  text not null default '' check (length(reference) <= 120),
  note       text not null default '' check (length(note) <= 500),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (user_id, type_key),
  check (expires_on is null or done_on is null or expires_on >= done_on)
);
comment on table public.staff_clearances is 'One clearance per person per type. expires_on null = does not run out. Written only by staff_clearance_save / staff_clearance_remove.';

-- ---------------------------------------------------------------- tables: onboarding
create table public.staff_onboarding_steps (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (btrim(title) <> '' and length(title) <= 120),
  detail        text not null default '' check (length(detail) <= 1000),
  link          text not null default '' check (link = '' or link ~ '^https?://'),
  self_check    boolean not null default false,
  clearance_key text references public.staff_clearance_types (key) on update cascade on delete set null,
  sort          int not null default 100,
  archived_at   timestamptz
);
comment on table public.staff_onboarding_steps is 'The new-hire checklist. self_check = the person can tick it themselves. clearance_key = ticks itself when that clearance is on file and current.';

insert into public.staff_onboarding_steps (title, detail, self_check, clearance_key, sort) values
  ('Hiring paperwork', 'W-4 and I-9 for employees, or a W-9 for contractors.', false, null, 10),
  ('Direct deposit form', '', false, null, 20),
  ('Background check', 'Ticks itself once a current background check is on file.', false, 'background', 30),
  ('SafeSport training', 'Ticks itself once their SafeSport certificate is on file.', false, 'safesport', 40),
  ('Watch the training videos', 'Add the link to the videos here.', true, null, 50),
  ('Read the picture day guide', '', true, null, 60),
  ('Shadow day with a lead photographer', '', false, null, 70),
  ('Gear issued', 'Check out their kit in Inventory.', false, null, 80),
  ('Access set on the Team page', 'Give them the areas they need.', false, null, 90);

create table public.staff_onboarding (
  user_id     uuid primary key references public.team_members (user_id) on delete cascade,
  started_on  date not null default ((now() at time zone 'America/New_York')::date),
  started_by  uuid,
  finished_at timestamptz
);
comment on table public.staff_onboarding is 'People going through (or done with) the onboarding checklist. finished_at is set when every step is ticked.';

create table public.staff_onboarding_done (
  user_id uuid not null references public.staff_onboarding (user_id) on delete cascade,
  step_id uuid not null references public.staff_onboarding_steps (id) on delete cascade,
  done_at timestamptz not null default now(),
  done_by uuid,
  primary key (user_id, step_id)
);
comment on table public.staff_onboarding_done is 'Ticked onboarding steps.';

create table public.staff_records_push_log (
  day     date primary key,
  sent_at timestamptz not null default now(),
  summary jsonb
);
comment on table public.staff_records_push_log is 'The morning clearance-warning run, once per day.';

alter table public.staff_clearance_types  enable row level security;
alter table public.staff_clearances       enable row level security;
alter table public.staff_onboarding_steps enable row level security;
alter table public.staff_onboarding       enable row level security;
alter table public.staff_onboarding_done  enable row level security;
alter table public.staff_records_push_log enable row level security;
-- Everything goes through the RPCs below.
revoke all on public.staff_clearance_types, public.staff_clearances, public.staff_onboarding_steps, public.staff_onboarding,
              public.staff_onboarding_done, public.staff_records_push_log from anon, authenticated;

-- Everyone added to the team from now on starts on the checklist. Never blocks adding the person.
create function public.staff_onboarding_on_new_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    insert into public.staff_onboarding (user_id, started_by) values (new.user_id, new.created_by) on conflict do nothing;
  exception when others then raise warning 'staff_onboarding_on_new_member: %', sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.staff_onboarding_on_new_member() from public, anon, authenticated;
create trigger team_members_onboarding after insert on public.team_members for each row execute function public.staff_onboarding_on_new_member();

-- ---------------------------------------------------------------- internal helpers
-- A clearance's state on p_day: ok, soon (within its type's warn_days), expired, missing.
create function public.staff_clearance_state(p_expires date, p_has boolean, p_warn int, p_day date) returns text
language sql immutable set search_path = '' as $$
  select case when not p_has then 'missing'
              when p_expires is null then 'ok'
              when p_expires < p_day then 'expired'
              when p_expires <= p_day + p_warn then 'soon'
              else 'ok' end
$$;

-- Is the step done for this person? Ticked, or tied to a clearance that is on file and current today.
create function public.staff_step_done(p_user uuid, p_step public.staff_onboarding_steps) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_onboarding_done d where d.user_id = p_user and d.step_id = p_step.id)
      or (p_step.clearance_key is not null and exists (
            select 1 from public.staff_clearances c
             where c.user_id = p_user and c.type_key = p_step.clearance_key
               and (c.expires_on is null or c.expires_on >= (now() at time zone 'America/New_York')::date)))
$$;

-- Set or clear finished_at once every current step is done.
create function public.staff_onboarding_refresh(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_all boolean;
begin
  select coalesce(bool_and(public.staff_step_done(p_user, s)), true) into v_all
    from public.staff_onboarding_steps s where s.archived_at is null;
  update public.staff_onboarding
     set finished_at = case when v_all then coalesce(finished_at, now()) end
   where user_id = p_user and (finished_at is null) = v_all;
end $$;

-- Booked school jobs from p_from (inclusive) to p_to (exclusive) with someone scheduled whose school_required
-- clearance is missing or runs out before the job day. Only bookings.status = 'booked'.
create function public.staff_school_problems(p_from date, p_to date)
returns table (booking_id uuid, day date, title text, user_id uuid, name text, type_key text, type_label text, problem text, expires_on date)
language sql stable security definer set search_path = '' as $$
  select distinct x.booking_id, x.day, x.title, e.user_id, public.staff_name(e.user_id), t.key, t.label,
         case when c.user_id is null then 'missing' else 'expired' end, c.expires_on
    from public.schedule_booking_days(p_from, p_to) x
    join public.bookings b on b.id = x.booking_id and b.status = 'booked'
    join public.booking_types bt on bt.key = b.type_key and bt.audience = 'school'
    join public.schedule_entries e on e.booking_id = x.booking_id and e.kind = 'job'
     and (e.starts_at at time zone 'America/New_York')::date <= x.day
     and (e.ends_at at time zone 'America/New_York')::date >= x.day
    join public.team_members m on m.user_id = e.user_id and m.active
    cross join public.staff_clearance_types t
    left join public.staff_clearances c on c.user_id = e.user_id and c.type_key = t.key
   where t.school_required and not t.archived
     and (c.user_id is null or c.expires_on < x.day)
$$;

-- ---------------------------------------------------------------- the page
-- Everything the Staff records page draws. Edit: every active person. View: just me.
create function public.staff_records()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_edit boolean;
  v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('staffrecords', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  v_edit := public.can('staffrecords', 'edit');
  return jsonb_build_object(
    'can_edit', v_edit,
    'me', v_me,
    'today', v_today,
    'types', (select coalesce(jsonb_agg(to_jsonb(t) order by t.sort, t.label), '[]'::jsonb) from public.staff_clearance_types t where not t.archived),
    'steps', (select coalesce(jsonb_agg(to_jsonb(s) order by s.sort, s.title), '[]'::jsonb) from public.staff_onboarding_steps s where s.archived_at is null),
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
                 'user_id', m.user_id, 'name', public.staff_name(m.user_id), 'is_me', m.user_id = v_me,
                 'clearances', (select coalesce(jsonb_agg(jsonb_build_object('type_key', c.type_key, 'done_on', c.done_on, 'expires_on', c.expires_on,
                                   'reference', c.reference, 'note', c.note, 'updated_at', c.updated_at,
                                   'state', public.staff_clearance_state(c.expires_on, true, t.warn_days, v_today))), '[]'::jsonb)
                                  from public.staff_clearances c join public.staff_clearance_types t on t.key = c.type_key
                                 where c.user_id = m.user_id and not t.archived),
                 'onboarding', (select jsonb_build_object('started_on', o.started_on, 'finished_at', o.finished_at,
                                   'done', (select coalesce(jsonb_agg(jsonb_build_object('step_id', s.id,
                                              'done_at', d.done_at, 'done_by', public.staff_name(d.done_by), 'auto', d.step_id is null)), '[]'::jsonb)
                                              from public.staff_onboarding_steps s
                                              left join public.staff_onboarding_done d on d.user_id = m.user_id and d.step_id = s.id
                                             where s.archived_at is null and public.staff_step_done(m.user_id, s)))
                                  from public.staff_onboarding o where o.user_id = m.user_id))
               order by lower(public.staff_name(m.user_id))), '[]'::jsonb)
                 from public.team_members m
                where m.active and (v_edit or m.user_id = v_me)),
    'school', (select coalesce(jsonb_agg(to_jsonb(p) order by p.day, p.title, p.name), '[]'::jsonb)
                 from public.staff_school_problems(v_today, v_today + 30) p
                where v_edit or p.user_id = v_me));
end $$;

-- Add or change one clearance. p = {user_id, type_key, done_on?, expires_on?, reference?, note?}
create function public.staff_clearance_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_type text := p ->> 'type_key';
  v_done date := nullif(p ->> 'done_on', '')::date;
  v_exp date := nullif(p ->> 'expires_on', '')::date;
begin
  if not public.can('staffrecords', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_user is null or not exists (select 1 from public.team_members where user_id = v_user) then raise exception 'Pick someone on the team.'; end if;
  if not exists (select 1 from public.staff_clearance_types where key = v_type) then raise exception 'Pick the kind of clearance.'; end if;
  if v_done is not null and v_exp is not null and v_exp < v_done then raise exception 'It can''t run out before it was done.'; end if;
  insert into public.staff_clearances (user_id, type_key, done_on, expires_on, reference, note, updated_by)
  values (v_user, v_type, v_done, v_exp, left(btrim(coalesce(p ->> 'reference', '')), 120), left(btrim(coalesce(p ->> 'note', '')), 500), (select auth.uid()))
  on conflict (user_id, type_key) do update
     set done_on = excluded.done_on, expires_on = excluded.expires_on, reference = excluded.reference, note = excluded.note,
         updated_at = now(), updated_by = excluded.updated_by;
  perform public.staff_onboarding_refresh(v_user);
  return jsonb_build_object('ok', true);
end $$;

create function public.staff_clearance_remove(p_user uuid, p_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('staffrecords', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from public.staff_clearances where user_id = p_user and type_key = p_type;
  perform public.staff_onboarding_refresh(p_user);
  return jsonb_build_object('ok', found);
end $$;

-- Add or change a kind of clearance. p = {key?, label, school_required, warn_days, sort?, archived?}
create function public.staff_clearance_type_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(p ->> 'key', '');
  v_label text := btrim(coalesce(p ->> 'label', ''));
begin
  if not public.can('staffrecords', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_label = '' then raise exception 'Give it a name.'; end if;
  if v_key is null then
    v_key := left(trim(both '_' from regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g')), 40);
    if v_key !~ '^[a-z]' then v_key := 'c_' || v_key; end if;
    while exists (select 1 from public.staff_clearance_types where key = v_key) loop v_key := v_key || '_2'; end loop;
    insert into public.staff_clearance_types (key, label, school_required, warn_days, sort)
    values (v_key, left(v_label, 80), coalesce((p ->> 'school_required')::boolean, false), coalesce((p ->> 'warn_days')::int, 30),
            coalesce((p ->> 'sort')::int, (select coalesce(max(sort), 0) + 10 from public.staff_clearance_types)));
  else
    update public.staff_clearance_types
       set label = left(v_label, 80), school_required = coalesce((p ->> 'school_required')::boolean, school_required),
           warn_days = coalesce((p ->> 'warn_days')::int, warn_days), sort = coalesce((p ->> 'sort')::int, sort),
           archived = coalesce((p ->> 'archived')::boolean, archived)
     where key = v_key;
    if not found then raise exception 'That kind of clearance is gone. Reload the page.'; end if;
  end if;
  return jsonb_build_object('ok', true, 'key', v_key);
end $$;

-- Put someone on the checklist (p_on true) or take them off it (false; their ticks go too).
create function public.staff_onboarding_set(p_user uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('staffrecords', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.team_members where user_id = p_user and active) then raise exception 'Pick someone on the team.'; end if;
  if p_on then
    insert into public.staff_onboarding (user_id, started_by) values (p_user, (select auth.uid())) on conflict do nothing;
    perform public.staff_onboarding_refresh(p_user);
  else
    delete from public.staff_onboarding where user_id = p_user;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Tick or untick a step. Edit: anyone's. View: only your own self_check steps.
create function public.staff_onboarding_check(p_user uuid, p_step uuid, p_done boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  s public.staff_onboarding_steps;
begin
  if not public.can('staffrecords', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into s from public.staff_onboarding_steps where id = p_step and archived_at is null;
  if not found then raise exception 'That step is gone. Reload the page.'; end if;
  if not public.can('staffrecords', 'edit') and (p_user is distinct from v_me or not s.self_check) then
    raise exception 'A manager ticks this one.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.staff_onboarding where user_id = p_user) then raise exception 'They are not on the onboarding checklist.'; end if;
  if p_done then
    insert into public.staff_onboarding_done (user_id, step_id, done_by) values (p_user, p_step, v_me) on conflict do nothing;
  else
    delete from public.staff_onboarding_done where user_id = p_user and step_id = p_step;
  end if;
  perform public.staff_onboarding_refresh(p_user);
  return jsonb_build_object('ok', true, 'finished', (select finished_at is not null from public.staff_onboarding where user_id = p_user));
end $$;

-- Add or change a checklist step. p = {id?, title, detail?, link?, self_check?, clearance_key?, sort?, archived?}
create function public.staff_onboarding_step_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_title text := btrim(coalesce(p ->> 'title', ''));
  v_link text := btrim(coalesce(p ->> 'link', ''));
  v_ck text := nullif(p ->> 'clearance_key', '');
  v_who uuid;
begin
  if not public.can('staffrecords', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_title = '' then raise exception 'Give the step a name.'; end if;
  if v_link <> '' and v_link !~ '^https?://' then raise exception 'The link should start with https://'; end if;
  if v_ck is not null and not exists (select 1 from public.staff_clearance_types where key = v_ck) then raise exception 'Pick a clearance, or none.'; end if;
  if v_id is null then
    insert into public.staff_onboarding_steps (title, detail, link, self_check, clearance_key, sort)
    values (left(v_title, 120), left(coalesce(p ->> 'detail', ''), 1000), v_link, coalesce((p ->> 'self_check')::boolean, false), v_ck,
            coalesce((p ->> 'sort')::int, (select coalesce(max(sort), 0) + 10 from public.staff_onboarding_steps)))
    returning id into v_id;
  else
    update public.staff_onboarding_steps
       set title = left(v_title, 120), detail = left(coalesce(p ->> 'detail', ''), 1000), link = v_link,
           self_check = coalesce((p ->> 'self_check')::boolean, self_check), clearance_key = v_ck,
           sort = coalesce((p ->> 'sort')::int, sort),
           archived_at = case when coalesce((p ->> 'archived')::boolean, false) then coalesce(archived_at, now()) end
     where id = v_id;
    if not found then raise exception 'That step is gone. Reload the page.'; end if;
  end if;
  -- A new or removed step changes who is finished.
  for v_who in select user_id from public.staff_onboarding loop perform public.staff_onboarding_refresh(v_who); end loop;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- For Today: people on school jobs who aren't cleared, clearances running out, people mid-onboarding.
-- Edit: whole team; View: just me.
create function public.staff_records_attention()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_edit boolean;
  v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('staffrecords', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  v_edit := public.can('staffrecords', 'edit');
  return jsonb_build_object(
    'school', (select count(distinct p.user_id) from public.staff_school_problems(v_today, v_today + 30) p where v_edit or p.user_id = v_me),
    'expiring', (select count(*) from public.staff_clearances c
                   join public.staff_clearance_types t on t.key = c.type_key and not t.archived
                   join public.team_members m on m.user_id = c.user_id and m.active
                  where (v_edit or c.user_id = v_me)
                    and public.staff_clearance_state(c.expires_on, true, t.warn_days, v_today) in ('soon', 'expired')),
    'onboarding', case when v_edit then (select count(*) from public.staff_onboarding o
                                           join public.team_members m on m.user_id = o.user_id and m.active
                                          where o.finished_at is null) else 0 end);
end $$;

-- ---------------------------------------------------------------- morning push (cron)
-- Once a day from 8am Eastern: school-job clearance problems in the next 14 days. Managers (Staff records Edit,
-- full access) get the summary; each person with a problem gets their own line (if they can see Staff records).
-- Both honor the "Clearance warning" switch under Notifications. p_force skips the hour check (tests).
create function public.staff_records_push(p_force boolean default false)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'America/New_York';
  v_today date := v_now::date;
  v_sent int := 0; v_n int; v_jobs int; v_body text; r record;
begin
  if not p_force and (extract(hour from v_now) < 8 or extract(hour from v_now) >= 11) then return 0; end if;
  insert into public.staff_records_push_log (day) values (v_today) on conflict do nothing;
  if not found then return 0; end if;

  select count(distinct x.user_id), count(distinct x.booking_id) into v_n, v_jobs from public.staff_school_problems(v_today, v_today + 14) x;
  update public.staff_records_push_log set summary = jsonb_build_object('people', v_n, 'jobs', v_jobs) where day = v_today;
  if v_n = 0 then return 0; end if;

  select string_agg(x.line, '; ' order by x.d) into v_body
    from (select min(p.day) as d, p.name || ' (' || string_agg(distinct p.type_label, ', ') || ')' as line
            from public.staff_school_problems(v_today, v_today + 14) p group by p.user_id, p.name) x;
  for r in select m.user_id from public.team_members m
            where (m.active or exists (select 1 from public.admin_users a where a.user_id = m.user_id))
              and (exists (select 1 from public.admin_users a where a.user_id = m.user_id)
                   or exists (select 1 from public.team_permissions p where p.user_id = m.user_id and p.module_key = 'staffrecords' and p.level = 'edit' and m.active))
              and coalesce((select p.enabled from public.push_prefs p where p.user_id = m.user_id and p.topic = 'clearance_warning'), true) loop
    perform public.push_notify('clearance_warning',
      case when v_n = 1 then '1 person on a school job isn''t cleared' else v_n || ' people on school jobs aren''t cleared' end,
      v_body, '/#staff/clearances', 'clearance_warning', r.user_id);
    v_sent := v_sent + 1;
  end loop;

  for r in select s.user_id, min(s.day) as d, min(s.title) as title, string_agg(distinct s.type_label, ', ') as what
             from public.staff_school_problems(v_today, v_today + 14) s
            where public.team_user_can(s.user_id, 'staffrecords')
              and not exists (select 1 from public.admin_users a where a.user_id = s.user_id)
              and not exists (select 1 from public.team_permissions p where p.user_id = s.user_id and p.module_key = 'staffrecords' and p.level = 'edit')
              and coalesce((select p.enabled from public.push_prefs p where p.user_id = s.user_id and p.topic = 'clearance_warning'), true)
            group by s.user_id loop
    perform public.push_notify('clearance_warning', 'Your ' || r.what || ' needs updating',
      'You''re on ' || r.title || ' on ' || to_char(r.d, 'Dy Mon FMDD') || '. Send the office a current copy.', '/#staff/clearances', 'clearance_warning_me', r.user_id);
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;

select cron.schedule('staff-records-push', '5,35 * * * *', 'select public.staff_records_push()');
select cron.schedule('staff-records-push-log-retention', '58 4 * * *', $$delete from public.staff_records_push_log where day < current_date - 60$$);

-- ---------------------------------------------------------------- gear care (module 'inventory')
alter table public.inventory_items
  add column purchased_on         date,
  add column purchase_price       numeric(10,2) check (purchase_price is null or purchase_price >= 0),
  add column value                numeric(10,2) check (value is null or value >= 0),
  add column service_every_months smallint check (service_every_months is null or service_every_months between 1 and 120),
  add column last_service_on      date;
comment on column public.inventory_items.value is 'What one of these is worth today (replacement value for insurance). The insurance list multiplies by qty.';
comment on column public.inventory_items.service_every_months is 'Service or sensor clean every this many months. Next due = last_service_on (or purchased_on) + this.';
comment on column public.inventory_items.last_service_on is 'Kept up to date from inventory_service (latest service or sensor clean).';

create table public.inventory_service (
  id         bigint generated always as identity primary key,
  item_id    uuid not null references public.inventory_items (id) on delete cascade,
  done_on    date not null,
  kind       text not null check (kind in ('service', 'sensor', 'repair', 'other')),
  cost       numeric(10,2) check (cost is null or cost >= 0),
  note       text not null default '' check (length(note) <= 500),
  created_at timestamptz not null default now(),
  created_by uuid
);
comment on table public.inventory_service is 'Service log per item. service and sensor (clean) count toward last_service_on. Written by inventory_service_log / inventory_service_remove.';
create index inventory_service_item_idx on public.inventory_service (item_id, done_on desc);
alter table public.inventory_service enable row level security;
revoke all on public.inventory_service from anon, authenticated;
grant select on public.inventory_service to authenticated;
create policy inventory_service_read on public.inventory_service for select to authenticated using ((select public.can('inventory', 'view')));

-- The view gains the gear columns (added at the end, so create or replace keeps the old ones).
create or replace view public.inventory_items_v with (security_invoker = true) as
select i.id, i.name, i.qty, i.serial, i.note, i.photo_path, i.bin_id, i.kit_id, i.updated_at,
       coalesce(k.bin_id, i.bin_id) as place_bin_id, b.code as bin_code, b.location as bin_location,
       k.name as kit_name,
       co.id as checkout_id, co.holder_user, co.holder_name, co.out_at, co.due_on, co.kit_id is not null as out_with_kit,
       i.purchased_on, i.purchase_price, i.value, i.service_every_months, i.last_service_on,
       case when i.service_every_months is not null and coalesce(i.last_service_on, i.purchased_on) is not null
            then (coalesce(i.last_service_on, i.purchased_on) + make_interval(months => i.service_every_months))::date end as next_service_on
  from public.inventory_items i
  left join public.inventory_kits k on k.id = i.kit_id
  left join public.inventory_bins b on b.id = coalesce(k.bin_id, i.bin_id)
  left join lateral (select c.* from public.inventory_checkouts c
                      where c.returned_at is null and (c.item_id = i.id or (i.kit_id is not null and c.kit_id = i.kit_id))
                      order by c.kit_id nulls first limit 1) co on true;

create function public.inventory_service_sync(p_item uuid) returns void
language sql security definer set search_path = '' as $$
  update public.inventory_items
     set last_service_on = (select max(done_on) from public.inventory_service where item_id = p_item and kind in ('service', 'sensor'))
   where id = p_item
$$;

-- Log a service. Anyone with Inventory (view is enough: whoever cleans the sensor writes it down).
create function public.inventory_service_log(p_item uuid, p_done_on date, p_kind text, p_cost numeric default null, p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.inventory_items where id = p_item) then raise exception 'No such item.'; end if;
  if p_done_on is null or p_done_on > (now() at time zone 'America/New_York')::date + 1 then raise exception 'Pick the day it was done.'; end if;
  if p_kind is null or p_kind not in ('service', 'sensor', 'repair', 'other') then raise exception 'Pick what was done.'; end if;
  insert into public.inventory_service (item_id, done_on, kind, cost, note, created_by)
  values (p_item, p_done_on, p_kind, p_cost, left(btrim(coalesce(p_note, '')), 500), (select auth.uid()))
  returning id into v_id;
  perform public.inventory_service_sync(p_item);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Remove a log line: Inventory Edit, or the person who logged it.
create function public.inventory_service_remove(p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_item uuid; v_by uuid;
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select item_id, created_by into v_item, v_by from public.inventory_service where id = p_id;
  if not found then return jsonb_build_object('ok', false); end if;
  if not public.can('inventory', 'edit') and v_by is distinct from (select auth.uid()) then
    raise exception 'Only the person who logged it can remove it.' using errcode = '42501';
  end if;
  delete from public.inventory_service where id = p_id;
  perform public.inventory_service_sync(v_item);
  return jsonb_build_object('ok', true);
end $$;

-- For Today: items due (or overdue) for service within 14 days.
create function public.inventory_attention()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.can('inventory', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('service_due', (select count(*) from public.inventory_items_v v
                                             where v.next_service_on <= (now() at time zone 'America/New_York')::date + 14));
end $$;

-- ---------------------------------------------------------------- grants
do $$
declare f text;
begin
  foreach f in array array['public.staff_clearance_state(date, boolean, int, date)', 'public.staff_step_done(uuid, public.staff_onboarding_steps)',
                           'public.staff_onboarding_refresh(uuid)', 'public.staff_school_problems(date, date)', 'public.staff_records_push(boolean)',
                           'public.inventory_service_sync(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.staff_records()', 'public.staff_clearance_save(jsonb)', 'public.staff_clearance_remove(uuid, text)',
                           'public.staff_clearance_type_save(jsonb)', 'public.staff_onboarding_set(uuid, boolean)',
                           'public.staff_onboarding_check(uuid, uuid, boolean)', 'public.staff_onboarding_step_save(jsonb)',
                           'public.staff_records_attention()',
                           'public.inventory_service_log(uuid, date, text, numeric, text)', 'public.inventory_service_remove(bigint)',
                           'public.inventory_attention()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
