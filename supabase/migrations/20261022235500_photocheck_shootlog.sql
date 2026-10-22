-- Photographed check, picture day readiness and the shoot log (2026-10-22, Airstudio plan items E and L).
--
-- 1. Photographed check (module 'photocheck', page #jobs/photocheck/<booking id>, app/src/photocheck.js).
--    After a picture day, compare the roster with who GotPhoto says was photographed. The roster is GotPhoto's own
--    (synced_codes for the booking's job) or an uploaded file; the photographed list is a GotPhoto export the page
--    reads in the browser. Rows match by student ID, then access code, then email, then name (narrowed by group when
--    a name is on the roster twice). What is left still needs a photo, and feeds:
--      - Retakes (school jobs): each one becomes a retake request ("Not photographed"), so Names List flags them on
--        retake day and they show on the Retakes page.
--      - Makeups (league jobs): makeup bookings for this job are matched to the missing athletes by name.
--      - Email: the school contact gets the list before retake day; each coach gets their own team's list.
--    Emails follow booking_settings (switch, quiet hours, test mode, bcc), like the picture day planner, and only
--    bookings.status = 'booked' sends.
-- 2. Readiness (module 'pictureday'): one strip per picture day: form in, roster in, coaches confirmed, crew on the
--    schedule, gear packed (ticked by hand until gear per job exists), then shoot log and photographed check.
-- 3. Shoot log (module 'shootlog', page #staff/shootlog/<booking id>/<day>, app/src/shootlog.js). The crew lead logs
--    cards used, teams or classes shot, absences and issues from their phone. Saving the last day ticks the job's
--    "picture day" stage. View = log jobs you are on; Edit = everyone's. A 7:30pm push reminds crew who haven't.

insert into public.app_modules (key, label, section, description, sort, status, admin_only) values
  ('photocheck', 'Photographed check', 'Jobs',
   'After a picture day: the roster against who GotPhoto photographed, feeding retakes, makeups and the school or coach emails.', 16, 'live', false),
  ('shootlog', 'Shoot log', 'Staff',
   'The lead logs cards, teams shot, absences and issues from their phone. View = jobs you are on; Edit = everyone''s.', 212, 'live', false)
on conflict (key) do update set status = 'live', label = excluded.label, description = excluded.description;

-- ---------------------------------------------------------------- helpers
-- "Lee, Pat-Ann" and "pat ann lee" compare as letters and digits only.
create function public.pa_norm(p text) returns text language sql immutable set search_path = '' as $$
  select regexp_replace(lower(coalesce(p, '')), '[^[:alnum:]]', '', 'g') $$;
create function public.pa_clean(p text, p_max int default 200) returns text language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(coalesce(p, ''), '[\x00-\x1f]', ' ', 'g')), p_max) $$;
create function public.pa_today() returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'America/New_York')::date $$;

-- The GotPhoto job behind a booking: its own, or its school's on the hub.
create function public.pa_job_of(p_booking uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(b.gotphoto_job_id), ''), nullif(btrim(h.gotphoto_job_id), ''))
    from public.bookings b left join public.comm_hub_schools h on h.id = b.hub_school_id
   where b.id = p_booking $$;

-- ---------------------------------------------------------------- tables
create table public.pa_audits (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null unique references public.bookings (id) on delete cascade,
  roster_source   text check (roster_source in ('gotphoto', 'upload')),
  gotphoto_job_id text,                         -- the job the roster came from
  roster_name     text,
  roster_at       timestamptz,
  shot_name       text,                         -- the photographed file
  shot_at         timestamptz,
  shot_rows       int not null default 0,
  unmatched       jsonb not null default '[]',  -- photographed rows that matched nobody on the roster
  retakes_at      timestamptz,
  retakes_added   int not null default 0,
  updated_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.pa_audits is 'Photographed check: one per booking. Where the roster and the photographed list came from.';

create table public.pa_people (
  id                uuid primary key default gen_random_uuid(),
  audit_id          uuid not null references public.pa_audits (id) on delete cascade,
  first_name        text not null default '',
  last_name         text not null default '',
  grp               text not null default '',
  identifier        text not null default '',
  email             text not null default '',
  code              text not null default '',
  name_key          text generated always as (public.pa_norm(first_name || last_name)) stored,
  name_key2         text generated always as (public.pa_norm(last_name || first_name)) stored,
  photographed      boolean not null default false,
  matched_by        text check (matched_by in ('id', 'code', 'email', 'name', 'staff')),  -- staff = set by hand, kept on re-upload
  retake_request_id uuid,
  sort              int not null default 0
);
create index pa_people_audit on public.pa_people (audit_id);
create index pa_people_name on public.pa_people (audit_id, name_key);
comment on table public.pa_people is 'Photographed check: one row per person on the roster, and whether they were photographed.';

create table public.pa_emails (
  id         bigint generated always as identity primary key,
  audit_id   uuid not null references public.pa_audits (id) on delete cascade,
  kind       text not null check (kind in ('school', 'coach')),
  team       text,
  to_email   text not null,
  to_name    text not null default '',
  subject    text not null,
  body_text  text not null,
  body_html  text not null,
  status     text not null default 'waiting' check (status in ('waiting', 'sent', 'failed', 'cancelled')),
  test_mode  boolean not null default false,
  sent_to    text,
  request_id bigint,
  checked    boolean not null default false,
  error      text,
  created_by uuid,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index pa_emails_waiting on public.pa_emails (id) where status = 'waiting';
create index pa_emails_audit on public.pa_emails (audit_id, id desc);
comment on table public.pa_emails is 'Photographed check emails (the list to the school, each coach''s missing players). Sent by pa_send_waiting.';

create table public.pa_settings (
  id          boolean primary key default true check (id),
  makeup_link text not null default '',   -- where families book a makeup; blank = "reply to this email"
  updated_at  timestamptz not null default now()
);
insert into public.pa_settings (id) values (true) on conflict do nothing;

create table public.pd_ready (
  booking_id     uuid primary key references public.bookings (id) on delete cascade,
  gear_packed_at timestamptz,
  gear_packed_by text
);
comment on table public.pd_ready is 'Picture day readiness ticks that have no other home yet (gear packed).';

create table public.sl_logs (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null references public.bookings (id) on delete cascade,
  day           date not null,
  user_id       uuid,                          -- who logged it (no FK, so removing someone keeps the log)
  by_name       text not null default '',
  cards         smallint check (cards between 0 and 99),
  card_labels   text not null default '',
  groups        text[] not null default '{}',  -- teams or classes ticked as shot
  groups_shot   smallint check (groups_shot between 0 and 999),
  subjects_shot int check (subjects_shot between 0 and 9999),
  absences      text not null default '',
  issues        text not null default '',
  notes         text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (booking_id, day)
);
comment on table public.sl_logs is 'Shoot log: one per job day, filled in by the crew after the shoot.';

alter table public.pa_audits enable row level security;
alter table public.pa_people enable row level security;
alter table public.pa_emails enable row level security;
alter table public.pa_settings enable row level security;
alter table public.pd_ready enable row level security;
alter table public.sl_logs enable row level security;
revoke all on public.pa_audits, public.pa_people, public.pa_emails, public.pa_settings, public.pd_ready, public.sl_logs from anon, authenticated;
grant select on public.pa_audits, public.pa_people, public.pa_emails, public.pa_settings to authenticated;
create policy pa_audits_read   on public.pa_audits   for select to authenticated using ((select public.can('photocheck', 'view')));
create policy pa_people_read   on public.pa_people   for select to authenticated using ((select public.can('photocheck', 'view')));
create policy pa_emails_read   on public.pa_emails   for select to authenticated using ((select public.can('photocheck', 'view')));
create policy pa_settings_read on public.pa_settings for select to authenticated using ((select public.can('photocheck', 'view')));
-- pd_ready and sl_logs are read and written only through the RPCs below.

-- Parents asking for a retake get a push; the photographed check adding its own (no parent) does not.
create or replace function public.push_on_retake() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.parent_email is null then return null; end if;
  begin
    perform public.push_notify('retake_new', 'New retake request',
      'For ' || coalesce((select s.name from public.comm_hub_schools s where s.id = new.hub_school_id), 'a school') || '.',
      '/#parents/retakes', 'retake_new');
  exception when others then raise warning 'push_on_retake: %', sqlerrm;
  end;
  return null;
end $$;

-- ================================================================ photographed check
create function public.pa_booking(p_booking uuid) returns public.bookings
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_booking;
  if b.id is null then raise exception 'Booking not found.'; end if;
  return b;
end $$;

create function public.pa_audit_for(p_booking uuid) returns public.pa_audits
language plpgsql security definer set search_path = '' as $$
declare a public.pa_audits;
begin
  insert into public.pa_audits (booking_id) values (p_booking) on conflict (booking_id) do nothing;
  select * into a from public.pa_audits where booking_id = p_booking;
  return a;
end $$;

-- Booked picture days from the last four months, newest first, with where each check stands.
create function public.pa_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := public.pa_today();
begin
  if not public.can('photocheck', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'booking_id', b.id, 'title', public.schedule_booking_title(b.id), 'audience', bt.audience,
             'picture_day', b.picture_day, 'location', b.location, 'job_id', public.pa_job_of(b.id),
             'retake_day', coalesce(b.retake_day, h.retake_day),
             'roster', coalesce(k.roster, 0), 'photographed', coalesce(k.shot, 0), 'shot_at', a.shot_at, 'retakes_at', a.retakes_at,
             'logged', exists (select 1 from public.sl_logs l where l.booking_id = b.id))
           order by b.picture_day desc, b.start_at)
      from public.bookings b
      left join public.booking_types bt on bt.key = b.type_key
      left join public.comm_hub_schools h on h.id = b.hub_school_id
      left join public.pa_audits a on a.booking_id = b.id
      left join lateral (select count(*) roster, count(*) filter (where p.photographed) shot from public.pa_people p where p.audit_id = a.id) k on true
     where b.status = 'booked' and b.picture_day between v_today - 120 and v_today + 1), '[]'::jsonb);
end $$;

-- One check: the booking, the audit, everyone on the roster with any makeup booked, what the crew logged, emails.
create function public.pa_get(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings; a public.pa_audits; v_job text; v_aud text; v_retake date; s public.booking_settings;
begin
  if not public.can('photocheck', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  b := public.pa_booking(p_booking);
  select * into a from public.pa_audits where booking_id = b.id;
  v_job := public.pa_job_of(b.id);
  select audience into v_aud from public.booking_types where key = b.type_key;
  select coalesce(b.retake_day, h.retake_day) into v_retake from public.comm_hub_schools h where h.id = b.hub_school_id;
  v_retake := coalesce(v_retake, b.retake_day);
  select * into s from public.booking_settings;
  return jsonb_build_object(
    'booking', jsonb_build_object('id', b.id, 'title', public.schedule_booking_title(b.id), 'org_id', b.org_id,
                 'org_name', (select name from public.prospect_orgs where id = b.org_id), 'status', b.status, 'audience', coalesce(v_aud, ''),
                 'picture_day', b.picture_day, 'location', b.location, 'retake_day', v_retake),
    'job', case when v_job is null then null else jsonb_build_object('id', v_job,
             'name', (select coalesce(nullif(j.internal_name, ''), j.name) from public.synced_jobs j where j.gotphoto_job_id = v_job),
             'codes', (select count(*) from public.synced_codes c where c.gotphoto_job_id = v_job and c.active and coalesce(c.code_type, 'photo') = 'photo')) end,
    'audit', case when a.id is null then null else to_jsonb(a) end,
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'first', p.first_name, 'last', p.last_name, 'group', p.grp,
                          'identifier', p.identifier, 'code', p.code, 'photographed', p.photographed, 'matched_by', p.matched_by,
                          'retake', p.retake_request_id is not null,
                          'makeup', (select jsonb_build_object('at', m.makeup_at, 'sent_at', m.sent_at)
                                       from public.makeup_bookings m
                                      where v_job is not null and coalesce(m.confirmed_job_id, m.suggested_job_id) = v_job and m.dismissed_at is null
                                        and public.pa_norm(m.athlete_name) in (p.name_key, p.name_key2)
                                      order by m.makeup_at desc limit 1))
                        order by p.grp, p.last_name, p.first_name, p.sort)
                         from public.pa_people p where p.audit_id = a.id), '[]'::jsonb),
    'logs', coalesce((select jsonb_agg(jsonb_build_object('day', l.day, 'by_name', l.by_name, 'absences', l.absences, 'issues', l.issues,
                        'subjects_shot', l.subjects_shot, 'groups_shot', l.groups_shot, 'updated_at', l.updated_at) order by l.day)
                       from public.sl_logs l where l.booking_id = b.id), '[]'::jsonb),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', btrim(concat_ws(' ', c.first_name, c.last_name)), 'email', c.email, 'role', c.role)
                          order by (c.id = any (coalesce(b.contact_ids, '{}'))) desc, c.is_primary desc, c.created_at)
                            from public.prospect_contacts c
                           where c.org_id = b.org_id and not coalesce(c.history_only, false) and c.stopped_at is null
                             and c.bounced_at is null and c.unsubscribed_at is null and public.pd_email_ok(c.email)), '[]'::jsonb),
    'teams', coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'coach_name', t.coach_name, 'coach_email', t.coach_email,
                         'key', public.pa_norm(t.name)) order by t.sort, t.created_at)
                        from public.pd_plans pl join public.pd_teams t on t.plan_id = pl.id
                       where pl.booking_id = b.id and t.removed_at is null), '[]'::jsonb),
    'emails', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'team', e.team, 'to_email', e.to_email, 'to_name', e.to_name,
                          'subject', e.subject, 'status', e.status, 'error', e.error, 'test_mode', e.test_mode, 'created_at', e.created_at, 'sent_at', e.sent_at)
                          order by e.id desc)
                         from (select * from public.pa_emails where audit_id = a.id order by id desc limit 40) e), '[]'::jsonb),
    'makeup_link', (select makeup_link from public.pa_settings),
    'sending', jsonb_build_object('enabled', coalesce(s.sending_enabled, false), 'test_mode', coalesce(s.test_mode, false), 'test_recipient', s.test_recipient));
end $$;

-- Roster from GotPhoto: everyone with a photo code on the booking's job. Re-loading keeps marks by access code.
create function public.pa_roster_gotphoto(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b public.bookings; a public.pa_audits; v_job text; n int;
begin
  if not public.can('photocheck', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  b := public.pa_booking(p_booking);
  v_job := public.pa_job_of(b.id);
  if v_job is null then raise exception 'This booking has no GotPhoto job yet. Link it on the booking, or upload the roster.'; end if;
  if not exists (select 1 from public.synced_codes c where c.gotphoto_job_id = v_job and c.active) then
    raise exception 'GotPhoto has no roster for this job yet. Upload the roster instead.';
  end if;
  a := public.pa_audit_for(b.id);
  with old as (select upper(p.code) k, p.photographed, p.matched_by, p.retake_request_id from public.pa_people p
                where p.audit_id = a.id and p.code <> '' and (p.matched_by is not null or p.retake_request_id is not null)),
       gone as (delete from public.pa_people p where p.audit_id = a.id)
  insert into public.pa_people (audit_id, first_name, last_name, grp, identifier, code, photographed, matched_by, retake_request_id, sort)
  select a.id, coalesce(c.subject_first, ''), coalesce(c.subject_last, ''), coalesce(nullif(c.subject_group, ''), coalesce(c.subject_teacher, '')),
         coalesce(c.subject_identifier, ''), upper(c.code), coalesce(o.photographed, false), o.matched_by, o.retake_request_id,
         row_number() over (order by c.subject_group, c.subject_last, c.subject_first)
    from public.synced_codes c left join old o on o.k = upper(c.code)
   where c.gotphoto_job_id = v_job and c.active and coalesce(c.code_type, 'photo') = 'photo';
  get diagnostics n = row_count;
  update public.pa_audits set roster_source = 'gotphoto', gotphoto_job_id = v_job,
         roster_name = coalesce((select coalesce(nullif(j.internal_name, ''), j.name) from public.synced_jobs j where j.gotphoto_job_id = v_job), v_job),
         roster_at = now(), updated_by = (select auth.uid()), updated_at = now()
   where id = a.id;
  return jsonb_build_object('ok', true, 'people', n);
end $$;

-- Roster from a file the page read. p_rows: [{first, last, group, id, email, code}]. Re-uploading keeps marks by ID, else name.
create function public.pa_roster_upload(p_booking uuid, p_rows jsonb, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b public.bookings; a public.pa_audits; n int;
begin
  if not public.can('photocheck', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'That file has nobody in it.'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'That roster is over 5,000 people. Split it up.'; end if;
  b := public.pa_booking(p_booking);
  a := public.pa_audit_for(b.id);
  with old as (select coalesce(nullif(lower(p.identifier), ''), p.name_key) k, p.photographed, p.matched_by, p.retake_request_id from public.pa_people p
                where p.audit_id = a.id and (p.matched_by is not null or p.retake_request_id is not null)),
       gone as (delete from public.pa_people p where p.audit_id = a.id),
       rws as (select public.pa_clean(x->>'first', 80) f, public.pa_clean(x->>'last', 80) l, public.pa_clean(x->>'group', 120) g,
                       public.pa_clean(x->>'id', 80) i, lower(public.pa_clean(x->>'email', 200)) e, upper(public.pa_clean(x->>'code', 40)) c, ord
                  from jsonb_array_elements(p_rows) with ordinality t(x, ord))
  insert into public.pa_people (audit_id, first_name, last_name, grp, identifier, email, code, photographed, matched_by, retake_request_id, sort)
  select a.id, r.f, r.l, r.g, r.i, r.e, r.c, coalesce(o.photographed, false), o.matched_by, o.retake_request_id, r.ord
    from rws r left join lateral (select * from old where old.k = coalesce(nullif(lower(r.i), ''), public.pa_norm(r.f || r.l)) limit 1) o on true
   where r.f <> '' or r.l <> '';
  get diagnostics n = row_count;
  update public.pa_audits set roster_source = 'upload', gotphoto_job_id = null, roster_name = public.pa_clean(p_name, 180),
         roster_at = now(), updated_by = (select auth.uid()), updated_at = now()
   where id = a.id;
  return jsonb_build_object('ok', true, 'people', n);
end $$;

-- The photographed list (GotPhoto's export, read by the page). p_rows: [{first, last, group, id, email, code}], one per
-- person photographed. Replaces the last file's matches; marks set by hand stay.
create function public.pa_photographed(p_booking uuid, p_rows jsonb, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.pa_audits; x jsonb; v_pid uuid; v_by text; v_ids uuid[]; v_id text; v_code text; v_email text; v_key text; v_grp text;
        n int := 0; m int := 0; v_un jsonb := '[]'::jsonb;
begin
  if not public.can('photocheck', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'That file has nobody in it.'; end if;
  if jsonb_array_length(p_rows) > 8000 then raise exception 'That file is over 8,000 rows. Split it up.'; end if;
  select * into a from public.pa_audits where booking_id = p_booking;
  if a.id is null or not exists (select 1 from public.pa_people where audit_id = a.id) then raise exception 'Load the roster first.'; end if;
  update public.pa_people set photographed = false, matched_by = null where audit_id = a.id and matched_by is distinct from 'staff';
  for x in select * from jsonb_array_elements(p_rows) loop
    n := n + 1; v_pid := null; v_by := null;
    v_id := lower(public.pa_clean(x->>'id', 80)); v_code := upper(public.pa_clean(x->>'code', 40));
    v_email := lower(public.pa_clean(x->>'email', 200)); v_grp := public.pa_norm(x->>'group');
    v_key := public.pa_norm(coalesce(x->>'first', '') || coalesce(x->>'last', ''));
    if v_id <> '' then
      select id into v_pid from public.pa_people where audit_id = a.id and lower(identifier) = v_id limit 1;
      if v_pid is not null then v_by := 'id'; end if;
    end if;
    if v_pid is null and v_code <> '' then
      select id into v_pid from public.pa_people where audit_id = a.id and code = v_code limit 1;
      if v_pid is not null then v_by := 'code'; end if;
    end if;
    if v_pid is null and v_email <> '' then
      select id into v_pid from public.pa_people where audit_id = a.id and email = v_email limit 1;
      if v_pid is not null then v_by := 'email'; end if;
    end if;
    if v_pid is null and v_key <> '' then
      select array_agg(id) into v_ids from public.pa_people where audit_id = a.id and (name_key = v_key or name_key2 = v_key);
      if coalesce(array_length(v_ids, 1), 0) > 1 and v_grp <> '' then
        select array_agg(id) into v_ids from public.pa_people where id = any (v_ids) and public.pa_norm(grp) = v_grp;
      end if;
      if coalesce(array_length(v_ids, 1), 0) = 1 then v_pid := v_ids[1]; v_by := 'name'; end if;
    end if;
    if v_pid is not null then
      update public.pa_people set photographed = true, matched_by = v_by where id = v_pid and matched_by is distinct from 'staff';
      m := m + 1;
    elsif jsonb_array_length(v_un) < 300 then
      v_un := v_un || jsonb_build_object('name', btrim(concat_ws(' ', public.pa_clean(x->>'first', 80), public.pa_clean(x->>'last', 80))),
                                         'group', public.pa_clean(x->>'group', 120), 'id', public.pa_clean(x->>'id', 80));
    end if;
  end loop;
  update public.pa_audits set shot_name = public.pa_clean(p_name, 180), shot_at = now(), shot_rows = n, unmatched = v_un,
         updated_by = (select auth.uid()), updated_at = now()
   where id = a.id;
  return jsonb_build_object('ok', true, 'rows', n, 'matched', m, 'unmatched', n - m,
    'missing', (select count(*) from public.pa_people where audit_id = a.id and not photographed));
end $$;

-- Set one person by hand (kept when the file is uploaded again).
create function public.pa_mark(p_person uuid, p_photographed boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('photocheck', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.pa_people set photographed = coalesce(p_photographed, false), matched_by = 'staff' where id = p_person;
  return jsonb_build_object('ok', found);
end $$;

-- School jobs: everyone still missing becomes a retake request ("Not photographed"), so Names List flags them on
-- retake day. A request a parent already made just gets the reason added.
create function public.pa_to_retakes(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b public.bookings; a public.pa_audits; v_job text; v_hub uuid; r record; v_rid uuid; n_add int := 0; n_upd int := 0;
begin
  if not public.can('photocheck', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  b := public.pa_booking(p_booking);
  if b.status <> 'booked' then raise exception 'Only booked jobs.'; end if;
  if (select audience from public.booking_types where key = b.type_key) is distinct from 'school' then
    raise exception 'Retakes are for school jobs. For leagues, the missing players go to their coaches and Makeups.';
  end if;
  select * into a from public.pa_audits where booking_id = b.id;
  if a.id is null or a.shot_at is null then raise exception 'Upload the photographed list first.'; end if;
  v_job := coalesce(a.gotphoto_job_id, public.pa_job_of(b.id));
  if v_job is null then raise exception 'This booking has no GotPhoto job, so Names List could not find these students.'; end if;
  v_hub := coalesce(b.hub_school_id, (select h.id from public.comm_hub_schools h where h.gotphoto_job_id = v_job limit 1));
  for r in select * from public.pa_people where audit_id = a.id and not photographed and code <> '' and retake_request_id is null loop
    select id into v_rid from public.retake_requests where gotphoto_job_id = v_job and upper(access_code) = r.code and deleted_at is null;
    if v_rid is null then
      insert into public.retake_requests (gotphoto_job_id, hub_school_id, access_code, child_first, child_last, child_group, reasons, notes)
      values (v_job, v_hub, r.code, nullif(r.first_name, ''), nullif(r.last_name, ''), nullif(r.grp, ''), array['Not photographed'],
              jsonb_build_array(jsonb_build_object('at', now(), 'text', 'Added by the photographed check: not photographed on picture day.')))
      returning id into v_rid;
      n_add := n_add + 1;
    else
      update public.retake_requests set reasons = (select array_agg(distinct x) from unnest(reasons || array['Not photographed']) x), updated_at = now()
       where id = v_rid and not ('Not photographed' = any (reasons));
      n_upd := n_upd + 1;
    end if;
    update public.pa_people set retake_request_id = v_rid where id = r.id;
  end loop;
  update public.pa_audits set retakes_at = now(), retakes_added = retakes_added + n_add, updated_at = now() where id = a.id;
  return jsonb_build_object('ok', true, 'added', n_add, 'already', n_upd,
    'no_code', (select count(*) from public.pa_people where audit_id = a.id and not photographed and code = ''));
end $$;

-- ---------------------------------------------------------------- emails
create function public.pa_email_html(p_paras text[], p_list text[], p_after text[], p_button text, p_link text, p_sig text)
returns text language sql immutable set search_path = '' as $$
  select '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f1e1b;max-width:540px">' ||
         coalesce((select string_agg('<p style="margin:0 0 12px">' || x || '</p>', '' order by i) from unnest(p_paras) with ordinality t(x, i)), '') ||
         coalesce('<ul style="margin:0 0 14px;padding-left:20px">' || (select string_agg('<li>' || x || '</li>', '' order by i) from unnest(p_list) with ordinality t(x, i)) || '</ul>', '') ||
         case when coalesce(p_link, '') <> '' then '<p style="margin:18px 0 18px"><a href="' || public.html_esc(p_link) ||
           '" style="display:inline-block;background:#bf4a1f;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:4px">' ||
           public.html_esc(p_button) || '</a></p>' else '' end ||
         coalesce((select string_agg('<p style="margin:0 0 12px">' || x || '</p>', '' order by i) from unnest(p_after) with ordinality t(x, i)), '') ||
         '<p style="margin:18px 0 0">' || replace(public.html_esc(p_sig), E'\n', '<br>') || '</p></div>' $$;

-- {to_email, to_name, subject, text, html, n}: the school's list of students still missing, by group.
create function public.pa_school_content(p_audit uuid, p_email text, p_name text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.pa_audits; b public.bookings; v_org text; v_first text; v_sig text; v_retake date; v_lines text[]; v_lines_h text[]; n int;
begin
  select * into a from public.pa_audits where id = p_audit;
  select * into b from public.bookings where id = a.booking_id;
  select name into v_org from public.prospect_orgs where id = b.org_id;
  v_org := coalesce(v_org, 'your school');
  v_first := coalesce(nullif(split_part(btrim(coalesce(p_name, '')), ' ', 1), ''), 'there');
  select coalesce(b.retake_day, h.retake_day) into v_retake from public.comm_hub_schools h where h.id = b.hub_school_id;
  v_retake := coalesce(v_retake, b.retake_day);
  select signature into v_sig from public.booking_settings;
  v_sig := coalesce(nullif(v_sig, ''), 'The 207 Photo Team');
  select array_agg(coalesce(nullif(g, ''), 'No class listed') || ': ' || names order by g), array_agg('<b>' || public.html_esc(coalesce(nullif(g, ''), 'No class listed')) || ':</b> ' || public.html_esc(names) order by g), sum(c)
    into v_lines, v_lines_h, n
    from (select p.grp g, string_agg(btrim(p.first_name || ' ' || p.last_name), ', ' order by p.last_name, p.first_name) names, count(*) c
            from public.pa_people p where p.audit_id = a.id and not p.photographed group by p.grp) z;
  n := coalesce(n, 0);
  return jsonb_build_object('to_email', lower(btrim(p_email)), 'to_name', coalesce(p_name, ''), 'n', n,
    'subject', v_org || ': ' || n || case when n = 1 then ' student still needs a picture' else ' students still need a picture' end,
    'text', 'Hi ' || v_first || E',\n\n' ||
            'We checked picture day at ' || v_org || ' against your roster. ' ||
            case when n = 1 then 'This student was not photographed:' else 'These ' || n || ' students were not photographed:' end || E'\n\n' ||
            array_to_string(v_lines, E'\n') || E'\n\n' ||
            case when v_retake is not null and v_retake >= public.pa_today() then 'Retake day is ' || public.pd_fmt_day(v_retake::timestamp at time zone 'America/New_York') || E', and we will have them on our list.\n\n'
                 else E'We will be in touch about a time to photograph them.\n\n' end ||
            E'If any of them have left the school, just reply and let us know.\n\n' || v_sig,
    'html', public.pa_email_html(
              array['Hi ' || public.html_esc(v_first) || ',',
                    'We checked picture day at <b>' || public.html_esc(v_org) || '</b> against your roster. ' ||
                    case when n = 1 then 'This student was not photographed:' else 'These ' || n || ' students were not photographed:' end],
              v_lines_h,
              array[case when v_retake is not null and v_retake >= public.pa_today()
                         then 'Retake day is <b>' || public.html_esc(public.pd_fmt_day(v_retake::timestamp at time zone 'America/New_York')) || '</b>, and we will have them on our list.'
                         else 'We will be in touch about a time to photograph them.' end,
                    'If any of them have left the school, just reply and let us know.'],
              null, null, v_sig));
end $$;

-- {to_email, to_name, subject, text, html, n}: one coach's players who weren't photographed.
create function public.pa_coach_content(p_audit uuid, p_team text, p_email text, p_name text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.pa_audits; b public.bookings; v_org text; v_first text; v_sig text; v_link text; v_names text[]; n int; v_day text;
begin
  select * into a from public.pa_audits where id = p_audit;
  select * into b from public.bookings where id = a.booking_id;
  select name into v_org from public.prospect_orgs where id = b.org_id;
  v_first := coalesce(nullif(split_part(btrim(coalesce(p_name, '')), ' ', 1), ''), 'Coach');
  select signature into v_sig from public.booking_settings;
  v_sig := coalesce(nullif(v_sig, ''), 'The 207 Photo Team');
  select nullif(btrim(makeup_link), '') into v_link from public.pa_settings;
  v_day := public.pd_fmt_day(b.picture_day::timestamp at time zone 'America/New_York');
  select array_agg(btrim(p.first_name || ' ' || p.last_name) order by p.last_name, p.first_name), count(*) into v_names, n
    from public.pa_people p where p.audit_id = a.id and not p.photographed and public.pa_norm(p.grp) = public.pa_norm(p_team);
  n := coalesce(n, 0);
  return jsonb_build_object('to_email', lower(btrim(p_email)), 'to_name', coalesce(p_name, ''), 'n', n,
    'subject', p_team || ': ' || case when n = 1 then '1 player missed picture day' else n || ' players missed picture day' end,
    'text', 'Hi ' || v_first || E',\n\n' ||
            case when n = 1 then 'One player' else n || ' players' end || ' on ' || p_team || coalesce(' (' || v_org || ')', '') ||
            ' weren''t photographed on ' || v_day || E':\n\n' || array_to_string(v_names, E'\n') || E'\n\n' ||
            case when v_link is not null then E'They can still get photos at a makeup session. Families can book one here:\n' || v_link || E'\n\n'
                 else E'They can still get photos at a makeup session. Have the family reply to this email and we will find a time.\n\n' end ||
            E'Could you pass this along to their families? Thank you!\n\n' || v_sig,
    'html', public.pa_email_html(
              array['Hi ' || public.html_esc(v_first) || ',',
                    case when n = 1 then 'One player' else n || ' players' end || ' on <b>' || public.html_esc(p_team) || '</b>' ||
                    coalesce(' (' || public.html_esc(v_org) || ')', '') || ' weren&#39;t photographed on ' || public.html_esc(v_day) || ':'],
              (select array_agg(public.html_esc(x)) from unnest(v_names) x),
              array[case when v_link is not null then 'They can still get photos at a makeup session.'
                         else 'They can still get photos at a makeup session. Have the family reply to this email and we will find a time.' end,
                    'Could you pass this along to their families? Thank you!'],
              'Book a makeup', v_link, v_sig));
end $$;

-- Sends waiting emails (booked jobs only), following booking_settings like pd_send_waiting. Runs after anything is
-- queued and every 5 minutes.
create function public.pa_send_waiting() returns int
language plpgsql security definer set search_path = '' as $$
declare s public.booking_settings; v_key text; v_local time; r record; v_to text; v_from text; v_req bigint; n int := 0;
begin
  update public.pa_emails e set checked = true,
         status = case when h.status_code between 200 and 299 then e.status else 'failed' end,
         error = case when h.status_code between 200 and 299 then e.error
                      else left(coalesce(nullif(h.error_msg, ''), 'HTTP ' || h.status_code || ': ' || coalesce(h.content, '')), 300) end
    from net._http_response h
   where e.status = 'sent' and not e.checked and e.request_id = h.id;

  select * into s from public.booking_settings;
  if not coalesce(s.sending_enabled, false) then return 0; end if;
  v_local := (now() at time zone 'America/New_York')::time;
  if (s.quiet_start > s.quiet_end and (v_local >= s.quiet_start or v_local < s.quiet_end))
     or (s.quiet_start <= s.quiet_end and v_local >= s.quiet_start and v_local < s.quiet_end) then return 0; end if;
  if s.test_mode and not public.pd_email_ok(s.test_recipient) then return 0; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_key is null then return 0; end if;
  v_from := case when lower(s.from_email) like '%@207photo.com' then coalesce(nullif(s.from_name, ''), '207 Photo') || ' <' || s.from_email || '>'
                 else '207 Photo <alerts@207photo.com>' end;

  for r in select e.* from public.pa_emails e
             join public.pa_audits a on a.id = e.audit_id
             join public.bookings b on b.id = a.booking_id
            where e.status = 'waiting' and b.status = 'booked'
            order by e.id limit 50
            for update of e skip locked
  loop
    if not s.test_mode and exists (select 1 from public.prospect_contacts pc where lower(btrim(pc.email)) = lower(r.to_email)
                                     and (pc.bounced_at is not null or pc.unsubscribed_at is not null)) then
      update public.pa_emails set status = 'failed', error = 'this address bounced or unsubscribed' where id = r.id; continue;
    end if;
    v_to := case when s.test_mode then s.test_recipient else r.to_email end;
    select net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := jsonb_strip_nulls(jsonb_build_object(
        'from', v_from, 'to', jsonb_build_array(v_to),
        'bcc', case when not s.test_mode and public.pd_email_ok(s.bcc) then jsonb_build_array(s.bcc) end,
        'reply_to', coalesce(nullif(btrim(s.reply_to), ''), s.from_email),
        'subject', case when s.test_mode then '[TEST] ' else '' end || r.subject,
        'text', r.body_text, 'html', r.body_html)),
      timeout_milliseconds := 10000) into v_req;
    update public.pa_emails set status = 'sent', sent_at = now(), request_id = v_req, test_mode = s.test_mode, sent_to = v_to, error = null
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('pa-email-send', '*/5 * * * *', 'select public.pa_send_waiting()');

create function public.pa_queue(p_audit uuid, p_kind text, p_team text, c jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.pa_emails (audit_id, kind, team, to_email, to_name, subject, body_text, body_html, created_by)
  values (p_audit, p_kind, p_team, lower(btrim(c->>'to_email')), coalesce(c->>'to_name', ''), c->>'subject', c->>'text', c->>'html', (select auth.uid()))
  returning id into v_id;
  return v_id;
end $$;

-- The emails one send would queue: 'school' to one contact (p_contact, or p_email), 'coach' to every coach with a
-- player missing. Each item: {to_email, to_name, subject, text, html, n, team}.
create function public.pa_email_plan(p_booking uuid, p_kind text, p_contact uuid, p_email text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings; a public.pa_audits; c public.prospect_contacts; v_email text; v_name text; tm record; v_out jsonb := '[]'::jsonb; x jsonb;
begin
  b := public.pa_booking(p_booking);
  select * into a from public.pa_audits where booking_id = b.id;
  if a.id is null or a.shot_at is null then raise exception 'Upload the photographed list first.'; end if;
  if not exists (select 1 from public.pa_people where audit_id = a.id and not photographed) then raise exception 'Everyone was photographed. Nothing to send.'; end if;
  if p_kind = 'school' then
    if p_contact is not null then
      select * into c from public.prospect_contacts where id = p_contact and org_id = b.org_id;
      if c.id is null then raise exception 'That contact is not on this organization.'; end if;
      v_email := lower(btrim(c.email)); v_name := btrim(concat_ws(' ', c.first_name, c.last_name));
    else
      v_email := lower(public.pa_clean(p_email, 200)); v_name := '';
    end if;
    if not public.pd_email_ok(v_email) then raise exception 'Pick someone with an email address.'; end if;
    return jsonb_build_array(public.pa_school_content(a.id, v_email, v_name));
  elsif p_kind = 'coach' then
    for tm in select distinct on (lower(t.coach_email), public.pa_norm(t.name)) t.name, t.coach_name, t.coach_email
               from public.pd_plans pl join public.pd_teams t on t.plan_id = pl.id
              where pl.booking_id = b.id and t.removed_at is null and public.pd_email_ok(t.coach_email)
                and exists (select 1 from public.pa_people p where p.audit_id = a.id and not p.photographed and public.pa_norm(p.grp) = public.pa_norm(t.name))
    loop
      x := public.pa_coach_content(a.id, tm.name, tm.coach_email, tm.coach_name) || jsonb_build_object('team', tm.name);
      v_out := v_out || x;
    end loop;
    if jsonb_array_length(v_out) = 0 then
      raise exception 'No coach has a missing player. Coaches come from the Picture days planner, matched to the roster''s team names.';
    end if;
    return v_out;
  end if;
  raise exception 'Pick school or coach.';
end $$;

create function public.pa_email_preview(p_booking uuid, p_kind text, p_contact uuid default null, p_email text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('photocheck', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return public.pa_email_plan(p_booking, p_kind, p_contact, p_email);
end $$;

create function public.pa_send(p_booking uuid, p_kind text, p_contact uuid default null, p_email text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b public.bookings; a public.pa_audits; x jsonb; n int := 0; s public.booking_settings;
begin
  if not public.can('photocheck', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  b := public.pa_booking(p_booking);
  if b.status <> 'booked' then raise exception 'Only booked jobs send emails.'; end if;
  select * into a from public.pa_audits where booking_id = b.id;
  for x in select * from jsonb_array_elements(public.pa_email_plan(p_booking, p_kind, p_contact, p_email)) loop
    perform public.pa_queue(a.id, p_kind, x->>'team', x);
    n := n + 1;
  end loop;
  perform public.pa_send_waiting();
  select * into s from public.booking_settings;
  return jsonb_build_object('ok', true, 'queued', n, 'sending_enabled', coalesce(s.sending_enabled, false), 'test_mode', coalesce(s.test_mode, false));
end $$;

create function public.pa_settings_save(p_makeup_link text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v text := public.pa_clean(p_makeup_link, 500);
begin
  if not public.can('photocheck', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v <> '' and v !~* '^https?://[^\s<>"]+$' then raise exception 'The makeup link should start with https://'; end if;
  update public.pa_settings set makeup_link = v, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Today: picture days in the last two weeks with a GotPhoto job and no photographed list yet.
create function public.pa_attention() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := public.pa_today();
begin
  if not public.can('photocheck', 'view') then return jsonb_build_object('to_check', 0); end if;
  return jsonb_build_object('to_check', (
    select count(*) from public.bookings b left join public.pa_audits a on a.booking_id = b.id
     where b.status = 'booked' and b.picture_day between v_today - 14 and v_today - 1
       and public.pa_job_of(b.id) is not null and a.shot_at is null));
end $$;

-- ================================================================ readiness (Picture days)
-- One row per booking: {booking_id, form, roster, teams, coach_emails, confirmed, crew, gear_packed_at, gear_by, logged, checked, day}
create function public.rd_get(p_bookings uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('pictureday', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'booking_id', b.id, 'day', b.picture_day,
      'form', case when p.submitted_at is not null then 'in' when p.intake_sent_at is not null then 'sent' else 'none' end,
      'roster', p.roster_path is not null
                or exists (select 1 from public.synced_jobs j where j.gotphoto_job_id = public.pa_job_of(b.id) and j.roster_loaded_at is not null)
                or exists (select 1 from public.synced_codes c where c.gotphoto_job_id = public.pa_job_of(b.id) and c.active),
      'teams', coalesce(k.teams, 0), 'coach_emails', coalesce(k.emails, 0), 'confirmed', coalesce(k.confirmed, 0),
      'crew', (select count(distinct se.user_id) from public.schedule_entries se where se.booking_id = b.id and se.kind = 'job'),
      'gear_packed_at', r.gear_packed_at, 'gear_by', r.gear_packed_by,
      'logged', exists (select 1 from public.sl_logs l where l.booking_id = b.id),
      'checked', exists (select 1 from public.pa_audits a where a.booking_id = b.id and a.shot_at is not null)))
      from public.bookings b
      left join public.pd_plans p on p.booking_id = b.id
      left join public.pd_ready r on r.booking_id = b.id
      left join lateral (select count(*) teams, count(*) filter (where public.pd_email_ok(t.coach_email)) emails,
                                count(*) filter (where t.status = 'confirmed') confirmed
                           from public.pd_teams t where t.plan_id = p.id and t.removed_at is null) k on true
     where b.id = any (coalesce(p_bookings, '{}'))), '[]'::jsonb);
end $$;

-- Gear packed: anyone who can edit the planner, or crew on the job.
create function public.rd_gear(p_booking uuid, p_packed boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.can('pictureday', 'edit')
          or exists (select 1 from public.schedule_entries se where se.booking_id = p_booking and se.user_id = (select auth.uid()) and se.kind = 'job'))
  then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.pd_ready (booking_id, gear_packed_at, gear_packed_by)
  values (p_booking, case when p_packed then now() end, case when p_packed then public.tc_name((select auth.uid()), '') end)
  on conflict (booking_id) do update set gear_packed_at = excluded.gear_packed_at, gear_packed_by = excluded.gear_packed_by;
  return jsonb_build_object('ok', true);
end $$;

-- ================================================================ shoot log
create function public.sl_days(p_booking uuid) returns setof date
language sql stable security definer set search_path = '' as $$
  select picture_day from public.bookings where id = p_booking and picture_day is not null
  union
  select day from public.booking_days where booking_id = p_booking and not removed $$;

create function public.sl_on_crew(p_booking uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.schedule_entries se where se.booking_id = p_booking and se.user_id = (select auth.uid()) and se.kind = 'job') $$;

create function public.sl_ok(p_booking uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can('shootlog', 'edit') or (public.can('shootlog', 'view') and public.sl_on_crew(p_booking)) $$;

-- Job days from the last two weeks to today: yours, or everyone's with Edit.
create function public.sl_mine() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := public.pa_today(); v_all boolean := public.can('shootlog', 'edit');
begin
  if not public.can('shootlog', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('can_edit', v_all, 'today', v_today, 'jobs', coalesce((
    select jsonb_agg(jsonb_build_object('booking_id', b.id, 'day', d.day, 'title', public.schedule_booking_title(b.id), 'location', b.location,
             'mine', public.sl_on_crew(b.id), 'logged_at', l.updated_at, 'by_name', l.by_name, 'issues', coalesce(l.issues, '') <> '')
           order by d.day desc, b.start_at)
      from public.bookings b cross join lateral public.sl_days(b.id) d(day)
      left join public.sl_logs l on l.booking_id = b.id and l.day = d.day
     where b.status = 'booked' and d.day between v_today - 14 and v_today
       and (v_all or public.sl_on_crew(b.id))), '[]'::jsonb));
end $$;

-- One job day: the booking, its days, the log (or null), crew, and the teams or classes to tick.
create function public.sl_get(p_booking uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings; l public.sl_logs; v_day date;
begin
  if not public.sl_ok(p_booking) then raise exception 'not allowed' using errcode = '42501'; end if;
  b := public.pa_booking(p_booking);
  v_day := coalesce(p_day, (select max(d) from public.sl_days(b.id) d where d <= public.pa_today()), b.picture_day);
  select * into l from public.sl_logs where booking_id = b.id and day = v_day;
  return jsonb_build_object(
    'booking', jsonb_build_object('id', b.id, 'title', public.schedule_booking_title(b.id), 'status', b.status, 'location', b.location,
                 'picture_day', b.picture_day, 'audience', (select audience from public.booking_types where key = b.type_key)),
    'day', v_day,
    'days', (select coalesce(jsonb_agg(d order by d), '[]'::jsonb) from public.sl_days(b.id) d),
    'log', case when l.id is null then null else to_jsonb(l) end,
    'can_edit', public.sl_ok(b.id),
    'crew', coalesce((select jsonb_agg(distinct public.tc_name(se.user_id, '')) from public.schedule_entries se
                       where se.booking_id = b.id and se.kind = 'job'
                         and (se.starts_at at time zone 'America/New_York')::date = v_day), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(g order by s, g) from (
                          select t.name g, min(t.sort) s from public.pd_plans pl join public.pd_teams t on t.plan_id = pl.id
                           where pl.booking_id = b.id and t.removed_at is null group by t.name
                          union
                          select p.grp, 100000 from public.pa_audits a join public.pa_people p on p.audit_id = a.id
                           where a.booking_id = b.id and p.grp <> ''
                             and not exists (select 1 from public.pd_plans pl join public.pd_teams t on t.plan_id = pl.id
                                              where pl.booking_id = b.id and t.removed_at is null)
                           group by p.grp) z limit 300), '[]'::jsonb));
end $$;

-- Save the log. p: {cards, card_labels, groups[], groups_shot, subjects_shot, absences, issues, notes}
create function public.sl_save(p_booking uuid, p_day date, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b public.bookings; v_old text; v_issues text := public.pa_clean(p->>'issues', 2000); v_id uuid; v_stage boolean := false;
        v_groups text[];
begin
  if not public.sl_ok(p_booking) then raise exception 'not allowed' using errcode = '42501'; end if;
  b := public.pa_booking(p_booking);
  if b.status <> 'booked' then raise exception 'This job is %.', b.status; end if;
  if p_day is null or not exists (select 1 from public.sl_days(b.id) d where d = p_day) then raise exception 'That isn''t one of this job''s days.'; end if;
  if p_day > public.pa_today() then raise exception 'Log the shoot on or after the day.'; end if;
  select coalesce(array_agg(g order by i), '{}') into v_groups
    from (select distinct on (lower(public.pa_clean(x, 120))) public.pa_clean(x, 120) g, i
            from jsonb_array_elements_text(coalesce(p->'groups', '[]')) with ordinality t(x, i) where public.pa_clean(x, 120) <> ''
           order by lower(public.pa_clean(x, 120)), i limit 300) z;
  select issues into v_old from public.sl_logs where booking_id = b.id and day = p_day;
  insert into public.sl_logs (booking_id, day, user_id, by_name, cards, card_labels, groups, groups_shot, subjects_shot, absences, issues, notes)
  values (b.id, p_day, (select auth.uid()), public.tc_name((select auth.uid()), ''),
          nullif(p->>'cards', '')::smallint, public.pa_clean(p->>'card_labels', 300), v_groups,
          coalesce(nullif(p->>'groups_shot', '')::smallint, nullif(cardinality(v_groups), 0)::smallint), nullif(p->>'subjects_shot', '')::int,
          left(btrim(coalesce(p->>'absences', '')), 4000), v_issues, left(btrim(coalesce(p->>'notes', '')), 4000))
  on conflict (booking_id, day) do update set
    user_id = excluded.user_id, by_name = excluded.by_name, cards = excluded.cards, card_labels = excluded.card_labels,
    groups = excluded.groups, groups_shot = excluded.groups_shot, subjects_shot = excluded.subjects_shot,
    absences = excluded.absences, issues = excluded.issues, notes = excluded.notes, updated_at = now()
  returning id into v_id;
  -- The last day logged = picture day is done (the stage only ever moves forward).
  if p_day = (select max(d) from public.sl_days(b.id) d) then
    begin
      v_stage := public.booking_stage_auto(b.id, 'picture_day');
    exception when others then raise warning 'sl_save stage: %', sqlerrm;
    end;
  end if;
  if v_issues <> '' and v_issues is distinct from v_old then
    begin
      perform public.push_notify('shootlog_issue', 'Issue at ' || public.schedule_booking_title(b.id), left(v_issues, 200),
        '/#staff/shootlog/' || b.id || '/' || p_day, 'sl_issue_' || v_id);
    exception when others then raise warning 'sl_save push: %', sqlerrm;
    end;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'stage', v_stage);
end $$;

-- Today: your job days in the last three days with no log (today's counts after 3pm).
create function public.sl_attention() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := public.pa_today(); v_late boolean := (now() at time zone 'America/New_York')::time >= time '15:00';
begin
  if not public.can('shootlog', 'view') then return jsonb_build_object('to_log', 0); end if;
  return jsonb_build_object('to_log', (
    select count(*) from public.bookings b cross join lateral public.sl_days(b.id) d(day)
     where b.status = 'booked' and public.sl_on_crew(b.id)
       and (d.day between v_today - 3 and v_today - 1 or (d.day = v_today and v_late))
       and not exists (select 1 from public.sl_logs l where l.booking_id = b.id and l.day = d.day)));
end $$;

-- 7:30pm Eastern: a push to each crew member on today's jobs that have no log yet.
create function public.sl_nudge() returns int
language plpgsql security definer set search_path = '' as $$
declare v_today date := public.pa_today(); r record; n int := 0;
begin
  for r in select distinct b.id, se.user_id, public.schedule_booking_title(b.id) title
             from public.bookings b
             join public.schedule_entries se on se.booking_id = b.id and se.kind = 'job'
                                             and (se.starts_at at time zone 'America/New_York')::date = v_today
            where b.status = 'booked' and v_today in (select d from public.sl_days(b.id) d)
              and not exists (select 1 from public.sl_logs l where l.booking_id = b.id and l.day = v_today)
              and se.user_id is not null
  loop
    begin
      perform public.push_notify('shootlog_due', 'Log today''s shoot', r.title || ': cards, teams shot, absences and any issues.',
        '/#staff/shootlog/' || r.id || '/' || v_today, 'sl_due_' || r.id || '_' || r.user_id, r.user_id);
      n := n + 1;
    exception when others then raise warning 'sl_nudge: %', sqlerrm;
    end;
  end loop;
  return n;
end $$;
-- 23:30 UTC = 7:30pm EDT, 6:30pm EST.
select cron.schedule('sl-nudge', '30 23 * * *', 'select public.sl_nudge()');

insert into public.push_topics (key, label, description, module, sort) values
  ('shootlog_due',   'Log your shoot',         'Evening reminder to log a picture day you worked.', 'shootlog', 72),
  ('shootlog_issue', 'Issue logged at a shoot', 'The crew logged an issue in the shoot log.',       'photocheck', 17)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- grants
revoke all on function public.pa_job_of(uuid), public.pa_booking(uuid), public.pa_audit_for(uuid), public.pa_school_content(uuid, text, text),
  public.pa_coach_content(uuid, text, text, text), public.pa_send_waiting(), public.pa_queue(uuid, text, text, jsonb),
  public.pa_email_plan(uuid, text, uuid, text), public.sl_days(uuid), public.sl_on_crew(uuid), public.sl_ok(uuid), public.sl_nudge()
  from public, anon, authenticated;
revoke all on function public.pa_list(), public.pa_get(uuid), public.pa_roster_gotphoto(uuid), public.pa_roster_upload(uuid, jsonb, text),
  public.pa_photographed(uuid, jsonb, text), public.pa_mark(uuid, boolean), public.pa_to_retakes(uuid),
  public.pa_email_preview(uuid, text, uuid, text), public.pa_send(uuid, text, uuid, text), public.pa_settings_save(text), public.pa_attention(),
  public.rd_get(uuid[]), public.rd_gear(uuid, boolean),
  public.sl_mine(), public.sl_get(uuid, date), public.sl_save(uuid, date, jsonb), public.sl_attention()
  from public, anon;
grant execute on function public.pa_list(), public.pa_get(uuid), public.pa_roster_gotphoto(uuid), public.pa_roster_upload(uuid, jsonb, text),
  public.pa_photographed(uuid, jsonb, text), public.pa_mark(uuid, boolean), public.pa_to_retakes(uuid),
  public.pa_email_preview(uuid, text, uuid, text), public.pa_send(uuid, text, uuid, text), public.pa_settings_save(text), public.pa_attention(),
  public.rd_get(uuid[]), public.rd_gear(uuid, boolean),
  public.sl_mine(), public.sl_get(uuid, date), public.sl_save(uuid, date, jsonb), public.sl_attention()
  to authenticated;
