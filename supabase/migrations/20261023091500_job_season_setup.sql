-- Season setup: import jobs from a spreadsheet, copy last season forward, multi-day jobs (2026-10-23).
--
-- Module 'jobsetup' (page #jobs/setup). Two ways to put a season of jobs on the Bookings screen at once:
--   CSV import   the page reads the file in the browser, matches each row to an organization and job type,
--                and sends the rows here, first as a dry run (what would be added, what is a duplicate, what
--                is wrong) and then for real.
--   Copy forward pick a stretch of last season (say Mar-Jun 2026) and a shift (52 weeks keeps the weekday);
--                each job comes back with its new dates, and the ones you keep are added.
-- Either way the jobs are TRACK-ONLY (bookings.status = 'tracked'): they get stages and deliverables and
-- show on the schedule, and nothing is sent for them, ever: no emails, no calendar event, no hub row, no
-- contacts (the same rule as booking_track_one; every send path acts only on status = 'booked'). To email
-- the organization, book the job with Book a job as usual.
--
-- Multi-day jobs: a job can have several dates (a two-day league weekend). Imported and copied jobs keep
-- every date as booking_days rows with calendar_status 'deleted' (no event is ever written), and
-- jobsetup_set_days changes the dates of a tracked job later. Booked jobs already have this through
-- Edit booking (booking_set_days), which this does not touch.
--
-- Each import or copy is one job_imports row, and its jobs carry bookings.import_id, so a whole batch can be
-- undone: jobsetup_undo sets aside (cancels) the batch's jobs that are still track-only.
-- View = see the import history; Edit = import, copy, undo and change a tracked job's dates.
-- Nothing here removes rows: days taken off a tracked job are marked removed, and undo cancels.

-- ---------------------------------------------------------------- module
insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('jobsetup', 'Season setup', 'Jobs',
        'Import a season of jobs from a spreadsheet, copy last season''s jobs forward, and set the dates of multi-day jobs. Jobs added here are track-only and never send anything. View = see what was imported; Edit = import, copy and undo.',
        12, 'live', false)
on conflict (key) do update set label = excluded.label, section = excluded.section, description = excluded.description,
                                sort = excluded.sort, status = 'live';

-- ---------------------------------------------------------------- tables
create table public.job_imports (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('csv', 'copy')),
  label      text not null default '' check (length(label) <= 200),   -- file name, or "Mar 1 - Jun 30, 2026 + 52 weeks"
  added      int not null default 0,
  skipped    int not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  undone_at  timestamptz,
  undone_by  uuid
);
comment on table public.job_imports is 'One CSV import or season copy (Season setup). Its jobs have bookings.import_id = id.';
alter table public.job_imports enable row level security;
revoke all on public.job_imports from anon, authenticated;
grant select on public.job_imports to authenticated;
create policy job_imports_read on public.job_imports for select to authenticated using ((select public.can('jobsetup', 'view')));

alter table public.bookings
  add column import_id   uuid references public.job_imports (id),
  add column copied_from uuid,       -- the job this one was copied from (no foreign key: the source may go away)
  add column copied_from_job text;  -- or the GotPhoto job it was copied from (last season's jobs that were never on Bookings)
comment on column public.bookings.import_id is 'The Season setup import or copy that added this job.';
comment on column public.bookings.copied_from is 'The earlier job this one was copied forward from (Season setup).';
comment on column public.bookings.copied_from_job is 'The GotPhoto job this one was copied forward from (Season setup).';
create index bookings_import_idx on public.bookings (import_id) where import_id is not null;
create index bookings_copied_from_idx on public.bookings (copied_from) where copied_from is not null;

-- ---------------------------------------------------------------- helpers
-- Every day a job is on (its booking_days, or its picture day when it has none).
create function public.jobsetup_days_of(p_booking uuid) returns setof date
language sql stable security definer set search_path = '' as $$
  select d.day from public.booking_days d where d.booking_id = p_booking and not d.removed
  union
  select b.picture_day from public.bookings b
   where b.id = p_booking and not exists (select 1 from public.booking_days d where d.booking_id = p_booking and not d.removed)
$$;

-- The days of an item as sorted jsonb [{day, start_time, end_time, label}], or an error text.
-- p_days: [{day: 'YYYY-MM-DD', start_time?: 'HH:MM', end_time?: 'HH:MM', label?}]
create function public.jobsetup_clean_days(p_days jsonb, out days jsonb, out err text)
language plpgsql immutable set search_path = '' as $$
declare d jsonb; v_day date; v_st time; v_en time; v_seen date[] := '{}';
begin
  days := '[]'::jsonb;
  if p_days is null or jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) = 0 then err := 'No date.'; return; end if;
  if jsonb_array_length(p_days) > 14 then err := 'More than 14 dates.'; return; end if;
  for d in select x from jsonb_array_elements(p_days) x loop
    begin
      v_day := (d->>'day')::date;
      v_st := nullif(btrim(coalesce(d->>'start_time', '')), '')::time;
      v_en := nullif(btrim(coalesce(d->>'end_time', '')), '')::time;
    exception when others then err := 'Can''t read the date or time "' || left(coalesce(d->>'day', '') || ' ' || coalesce(d->>'start_time', '') || ' ' || coalesce(d->>'end_time', ''), 60) || '".'; return;
    end;
    if v_day is null then err := 'A date is missing.'; return; end if;
    if v_day < date '2000-01-01' or v_day > date '2100-01-01' then err := 'The date ' || v_day || ' looks wrong.'; return; end if;
    if v_day = any (v_seen) then continue; end if;
    if v_en is not null and v_st is null then err := 'An end time needs a start time (' || v_day || ').'; return; end if;
    if v_en is not null and v_en <= v_st then err := 'The end time is before the start time (' || v_day || ').'; return; end if;
    v_seen := v_seen || v_day;
    days := days || jsonb_build_object('day', v_day, 'start_time', to_char(v_st, 'HH24:MI'), 'end_time', to_char(v_en, 'HH24:MI'),
                                      'label', nullif(left(btrim(coalesce(d->>'label', '')), 80), ''));
  end loop;
  select coalesce(jsonb_agg(x order by (x->>'day')::date), '[]'::jsonb) into days from jsonb_array_elements(days) x;
end $$;

-- Write a tracked job's dates: the first day is the booking's picture day (and its time); with more than
-- one day every day is a booking_days row. Calendar status is always 'deleted': no event is written.
-- Days that are no longer wanted are marked removed (tracked jobs never have calendar events).
create function public.jobsetup_write_days(p_booking uuid, p_days jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.bookings; t public.booking_types; d jsonb; v_i int := 0; v_day date; v_st time; v_en time;
        v_start timestamptz; v_end timestamptz; v_keep date[] := '{}'; v_n int := jsonb_array_length(p_days);
begin
  select * into b from public.bookings where id = p_booking;
  select * into t from public.booking_types where key = b.type_key;
  for d in select x from jsonb_array_elements(p_days) x order by (x->>'day')::date loop
    v_day := (d->>'day')::date;
    v_st := nullif(d->>'start_time', '')::time;
    v_en := nullif(d->>'end_time', '')::time;
    v_start := (v_day + coalesce(v_st, time '09:00')) at time zone 'America/New_York';
    v_end := case when v_en is not null then (v_day + v_en) at time zone 'America/New_York'
                  else v_start + make_interval(mins => coalesce(t.default_duration_min, 60)) end;
    if v_i = 0 then
      update public.bookings set picture_day = v_day, start_at = v_start, end_at = v_end,
             duration_min = greatest(15, least(720, (extract(epoch from (v_end - v_start)) / 60)::int)),
             time_set = v_st is not null, end_set = v_en is not null, updated_at = now()
       where id = p_booking;
    end if;
    if v_n > 1 then
      insert into public.booking_days (booking_id, day, start_at, end_at, label, sort, calendar_status)
      values (p_booking, v_day, case when v_st is not null then v_start end, case when v_en is not null then v_end end,
              d->>'label', v_i, 'deleted')
      on conflict (booking_id, day) do update set start_at = excluded.start_at, end_at = excluded.end_at, label = excluded.label,
             sort = excluded.sort, removed = false, calendar_status = 'deleted', updated_at = now();
    end if;
    v_keep := v_keep || v_day;
    v_i := v_i + 1;
  end loop;
  update public.booking_days set removed = true, calendar_status = 'deleted', updated_at = now()
   where booking_id = p_booking and not removed and (v_n <= 1 or not (day = any (v_keep)));
end $$;

-- An existing job (not cancelled) of the same organization and type on any of these days, or null.
create function public.jobsetup_duplicate(p_org uuid, p_type text, p_days date[]) returns uuid
language sql stable security definer set search_path = '' as $$
  select b.id from public.bookings b
   where b.org_id = p_org and b.type_key = p_type and b.status <> 'cancelled'
     and b.picture_day between (select min(x) from unnest(p_days) x) - 14 and (select max(x) from unnest(p_days) x) + 14
     and exists (select 1 from public.jobsetup_days_of(b.id) d where d = any (p_days))
   order by b.picture_day limit 1
$$;

-- Check one item. Returns {ok, error?, duplicate_of?, days, org_name, type_label, title}.
-- p: {org_id, type_key, days: [...], title_label?, title_override?, location?, notes?, gotphoto_job_id?, copied_from?}
create function public.jobsetup_check(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.booking_types; o public.prospect_orgs; c record; v_dup uuid; v_gp text; v_label text;
begin
  select * into t from public.booking_types where key = p->>'type_key';
  if t.key is null then return jsonb_build_object('ok', false, 'error', 'Pick a job type.'); end if;
  begin
    select * into o from public.prospect_orgs where id = nullif(p->>'org_id', '')::uuid;
  exception when others then o := null;
  end;
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'Pick an organization.'); end if;
  select * into c from public.jobsetup_clean_days(p->'days');
  if c.err is not null then return jsonb_build_object('ok', false, 'error', c.err); end if;
  v_label := coalesce(nullif(left(btrim(coalesce(p->>'title_label', '')), 120), ''), t.title_labels[1], t.label);
  v_gp := nullif(btrim(coalesce(p->>'gotphoto_job_id', '')), '');
  if v_gp is not null then
    if not exists (select 1 from public.synced_jobs j where j.gotphoto_job_id = v_gp) then
      return jsonb_build_object('ok', false, 'error', 'GotPhoto job ' || v_gp || ' is not in the sync.');
    end if;
    if v_gp in (select x from public.gotphoto_jobs_on_bookings() x where x is not null) then
      return jsonb_build_object('ok', false, 'error', 'GotPhoto job ' || v_gp || ' is already on the Bookings screen.',
                                'duplicate_of', (select b.id from public.bookings b where b.gotphoto_job_id = v_gp and b.status <> 'cancelled' limit 1));
    end if;
  end if;
  v_dup := public.jobsetup_duplicate(o.id, t.key, array(select (x->>'day')::date from jsonb_array_elements(c.days) x));
  return jsonb_build_object('ok', v_dup is null, 'error', case when v_dup is not null then 'Already on the Bookings screen for that date.' end,
    'duplicate_of', v_dup, 'days', c.days, 'org_name', o.name, 'type_label', t.label,
    'title', coalesce(nullif(btrim(coalesce(p->>'title_override', '')), ''), v_label || ' ' || chr(8226) || ' ' || o.name));
end $$;

-- ---------------------------------------------------------------- RPCs (view)
-- Organizations and job types for matching spreadsheet rows. Names only: no contacts.
create function public.jobsetup_lookup() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('jobsetup', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'types', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'label', t.label, 'audience', t.audience, 'title_labels', t.title_labels) order by t.sort_order), '[]'::jsonb)
                from public.booking_types t),
    'orgs', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'town', o.town, 'audience', o.audience, 'gotphoto_names', o.gotphoto_names) order by o.name), '[]'::jsonb)
               from public.prospect_orgs o),
    'can_edit', public.can('jobsetup', 'edit'));
end $$;

-- Past imports and copies, newest first, with what became of their jobs.
create function public.jobsetup_history(p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('jobsetup', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'label', i.label, 'added', i.added, 'skipped', i.skipped,
             'created_at', i.created_at, 'by', coalesce(public.staff_name(i.created_by), ''), 'undone_at', i.undone_at,
             'tracked', (select count(*) from public.bookings b where b.import_id = i.id and b.status = 'tracked'),
             'booked', (select count(*) from public.bookings b where b.import_id = i.id and b.status in ('booked', 'done')),
             'cancelled', (select count(*) from public.bookings b where b.import_id = i.id and b.status = 'cancelled'),
             'first_day', (select min(b.picture_day) from public.bookings b where b.import_id = i.id),
             'last_day', (select max(b.picture_day) from public.bookings b where b.import_id = i.id))
           order by i.created_at desc)
      from (select * from public.job_imports order by created_at desc limit greatest(1, least(coalesce(p_limit, 30), 200))) i), '[]'::jsonb);
end $$;

-- Jobs between p_from and p_to (by first day) with their dates moved by p_shift days. Two sources:
--   'booking'  jobs on the Bookings screen (not cancelled), with their days, times, title and place
--   'gotphoto' GotPhoto jobs from the sync that never were on the Bookings screen (most of last season),
--              with the organization and type guessed the way Track a job does (org_id null when unclear)
-- Each comes back with what a copy would be and whether the new dates are already taken.
create function public.jobsetup_copy_candidates(p_from date, p_to date, p_shift int default 364) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('jobsetup', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Pick the dates to copy from.'; end if;
  if p_to - p_from > 400 then raise exception 'Copy at most a year at a time.'; end if;
  if p_shift is null or p_shift = 0 or abs(p_shift) > 1100 then raise exception 'Pick how far forward to copy.'; end if;
  return coalesce((
    select jsonb_agg(x.j || jsonb_build_object(
             'duplicate_of', case when x.j->>'org_id' is not null then public.jobsetup_duplicate((x.j->>'org_id')::uuid, x.j->>'type_key',
                               array(select (d->>'day')::date from jsonb_array_elements(x.j->'days') d)) end,
             'copied_already', (select c.id from public.bookings c
                                 where c.status <> 'cancelled'
                                   and (c.copied_from = nullif(x.j->>'copied_from', '')::uuid or c.copied_from_job = x.j->>'copied_from_job') limit 1))
           order by x.j->>'first_day', x.j->>'org_name')
      from (
        select jsonb_build_object(
                 'source', 'booking', 'copied_from', b.id, 'org_id', b.org_id, 'org_name', o.name, 'type_key', b.type_key, 'type_label', t.label,
                 'status', b.status, 'title_label', b.title_label, 'title_override', b.title_override, 'location', b.location,
                 'title', coalesce(b.title_override, b.title_label || ' ' || chr(8226) || ' ' || o.name),
                 'from_days', (select jsonb_agg(d.day order by d.day) from public.jobsetup_days_of(b.id) d(day)),
                 'first_day', (b.picture_day + p_shift)::text,
                 'days', (select jsonb_agg(jsonb_build_object(
                                   'day', (s.day + p_shift)::text,
                                   'start_time', case when s.has_time then to_char(s.start_at at time zone 'America/New_York', 'HH24:MI') end,
                                   'end_time', case when s.has_end then to_char(s.end_at at time zone 'America/New_York', 'HH24:MI') end,
                                   'label', s.label) order by s.day)
                            from (select d.day, d.start_at, d.end_at, d.label,
                                         case when d.sort = 0 then b.time_set and d.start_at is not null else d.start_at is not null end as has_time,
                                         case when d.sort = 0 then b.time_set and b.end_set and d.end_at is not null else d.start_at is not null and d.end_at is not null end as has_end
                                    from public.booking_days d where d.booking_id = b.id and not d.removed
                                  union all
                                  select b.picture_day, b.start_at, b.end_at, null::text, b.time_set, b.time_set and b.end_set
                                   where not exists (select 1 from public.booking_days d where d.booking_id = b.id and not d.removed)) s)) as j
          from public.bookings b
          join public.prospect_orgs o on o.id = b.org_id
          join public.booking_types t on t.key = b.type_key
         where b.status <> 'cancelled' and b.picture_day between p_from and p_to
        union all
        select jsonb_build_object(
                 'source', 'gotphoto', 'copied_from_job', g.gotphoto_job_id, 'gotphoto_name', g.name, 'org_id', o.id, 'org_name', coalesce(o.name, btrim(split_part(g.name, '|', 1))),
                 'type_key', g.type_key, 'type_label', t.label, 'status', g.status,
                 'title_label', coalesce(nullif(btrim(split_part(g.name, '|', 2)), ''), t.title_labels[1], t.label), 'title_override', null, 'location', null,
                 'title', g.name,
                 'from_days', (select jsonb_agg(d order by d) from unnest(g.days) d),
                 'first_day', (g.days[1] + p_shift)::text,
                 'days', (select jsonb_agg(jsonb_build_object('day', (d.day + p_shift)::text, 'start_time', null, 'end_time', null, 'label', d.label) order by d.day)
                            from (select (h->>'date')::date as day, nullif(h->>'label', '') as label from jsonb_array_elements(g.hub_dates) h
                                   where g.multi
                                  union all
                                  select g.days[1], null where not g.multi) d)) as j
          from (select j.*, array[(j.shoot_at at time zone 'Europe/Berlin')::date] as days,
                       coalesce(jsonb_typeof(j.hub_dates) = 'array' and jsonb_array_length(j.hub_dates) > 1, false) as multi,
                       case when j.job_type like 'school%' or j.access_type = 'single_password' and j.job_type not like 'sport%' then 'school'
                            else (select key from public.booking_types where audience = 'sports' order by sort_order limit 1) end as type_key
                  from public.synced_jobs j
                 where j.shoot_at is not null and j.status <> 'archived'
                   and (j.shoot_at at time zone 'Europe/Berlin')::date between p_from and p_to
                   and j.gotphoto_job_id not in (select y from public.gotphoto_jobs_on_bookings() y where y is not null)) g
          left join public.prospect_orgs o on o.id = public.gotphoto_job_org(g.gotphoto_job_id)
          left join public.booking_types t on t.key = g.type_key) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- RPCs (edit)
-- Check (p_dry = true) or add a batch of track-only jobs. p_items: [item, ...] as in jobsetup_check.
-- Returns {ok, results: [{i, ok, error?, duplicate_of?, id?, title, days}], added, skipped, import_id}.
-- Duplicates (on the screen already, or twice in this batch) and bad rows are skipped, never added.
create function public.jobsetup_import(p_kind text, p_label text, p_items jsonb, p_dry boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare it jsonb; r jsonb; v_i int := 0; v_imp uuid; v_id uuid; v_added int := 0; v_skipped int := 0; v_out jsonb := '[]'::jsonb;
        v_seen text[] := '{}'; v_keys text[]; v_gp text; v_label text; t public.booking_types; v_seen_gp text[] := '{}';
begin
  if not public.can('jobsetup', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_kind not in ('csv', 'copy') then raise exception 'Unknown kind of import.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Nothing to add.'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'At most 500 jobs at a time.'; end if;
  if not p_dry then
    insert into public.job_imports (kind, label, created_by) values (p_kind, left(coalesce(btrim(p_label), ''), 200), (select auth.uid()))
    returning id into v_imp;
  end if;
  for it in select x from jsonb_array_elements(p_items) x loop
    r := public.jobsetup_check(it);
    v_gp := nullif(btrim(coalesce(it->>'gotphoto_job_id', '')), '');
    if (r->>'ok')::boolean then
      v_keys := array(select (it->>'org_id') || '|' || (it->>'type_key') || '|' || (d->>'day') from jsonb_array_elements(r->'days') d);
      if v_keys && v_seen or (v_gp is not null and v_gp = any (v_seen_gp)) then
        r := r || jsonb_build_object('ok', false, 'error', 'Same job twice in this list.');
      end if;
    end if;
    if (r->>'ok')::boolean then
      v_seen := v_seen || v_keys;
      if v_gp is not null then v_seen_gp := v_seen_gp || v_gp; end if;
      if not p_dry then
        select * into t from public.booking_types where key = it->>'type_key';
        v_label := coalesce(nullif(left(btrim(coalesce(it->>'title_label', '')), 120), ''), t.title_labels[1], t.label);
        insert into public.bookings (org_id, type_key, sequence_id, title_label, title_override, picture_day, start_at, end_at, duration_min,
                                     location, notes, contact_ids, gotphoto_job_id, calendar_status, status, time_set, end_set,
                                     created_by, import_id, copied_from, copied_from_job)
        values ((it->>'org_id')::uuid, t.key, null, v_label, nullif(left(btrim(coalesce(it->>'title_override', '')), 200), ''),
                (r->'days'->0->>'day')::date, now(), now(), coalesce(t.default_duration_min, 60),
                nullif(left(btrim(coalesce(it->>'location', '')), 300), ''), nullif(left(btrim(coalesce(it->>'notes', '')), 2000), ''),
                '{}', v_gp, 'deleted', 'tracked', false, false, (select auth.uid()), v_imp,
                case when p_kind = 'copy' then nullif(it->>'copied_from', '')::uuid end,
                case when p_kind = 'copy' then nullif(it->>'copied_from_job', '') end)
        returning id into v_id;
        perform public.jobsetup_write_days(v_id, r->'days');
        r := r || jsonb_build_object('id', v_id);
      end if;
      v_added := v_added + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
    v_out := v_out || (jsonb_build_object('i', v_i) || r);
    v_i := v_i + 1;
  end loop;
  if not p_dry then update public.job_imports set added = v_added, skipped = v_skipped where id = v_imp; end if;
  return jsonb_build_object('ok', true, 'dry', p_dry, 'import_id', v_imp, 'added', v_added, 'skipped', v_skipped, 'results', v_out);
end $$;

-- Undo a batch: its jobs that are still track-only are set aside like a cancelled booking. Jobs that were
-- booked since (or already set aside) are left alone.
create function public.jobsetup_undo(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.can('jobsetup', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.job_imports where id = p_id) then raise exception 'That import is gone.'; end if;
  update public.bookings set status = 'cancelled', cancelled_at = now(), updated_at = now()
   where import_id = p_id and status = 'tracked';
  get diagnostics n = row_count;
  update public.job_imports set undone_at = now(), undone_by = (select auth.uid()) where id = p_id;
  return jsonb_build_object('ok', true, 'cancelled', n,
    'kept', (select count(*) from public.bookings b where b.import_id = p_id and b.status in ('booked', 'done')));
end $$;

-- Change the dates of a track-only job (one or many). Booked jobs change theirs with Edit booking.
create function public.jobsetup_set_days(p_booking uuid, p_days jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b public.bookings; c record;
begin
  if not public.can_any('{jobsetup,bookings}', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking;
  if b.id is null then raise exception 'That job is gone.'; end if;
  if b.status <> 'tracked' then raise exception 'Only track-only jobs change their dates here. Use Edit booking for a booked job.'; end if;
  select * into c from public.jobsetup_clean_days(p_days);
  if c.err is not null then raise exception '%', c.err; end if;
  perform public.jobsetup_write_days(p_booking, c.days);
  return jsonb_build_object('ok', true, 'days', (select coalesce(jsonb_agg(d order by d), '[]'::jsonb) from public.jobsetup_days_of(p_booking) d));
end $$;

-- Copy one job forward (the "Copy" button on a job): the same organization, type, title, place and times,
-- p_shift days later (or on p_days when given). Track-only, so it sends nothing.
create function public.jobsetup_copy_one(p_booking uuid, p_shift int default 364, p_days jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b public.bookings; v jsonb; r jsonb;
begin
  if not public.can('jobsetup', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking;
  if b.id is null then raise exception 'That job is gone.'; end if;
  select x into v from jsonb_array_elements(public.jobsetup_copy_candidates(b.picture_day, b.picture_day, coalesce(nullif(p_shift, 0), 364))) x
   where (x->>'copied_from')::uuid = p_booking;
  if v is null then raise exception 'A cancelled job can''t be copied.'; end if;
  if p_days is not null then v := v || jsonb_build_object('days', p_days); end if;
  r := public.jobsetup_import('copy', 'Copy of ' || coalesce(v->>'title', '') || ' (' || b.picture_day || ')', jsonb_build_array(v), false);
  return r->'results'->0 || jsonb_build_object('import_id', r->'import_id');
end $$;

-- ---------------------------------------------------------------- grants
do $$
declare f text;
begin
  foreach f in array array['public.jobsetup_days_of(uuid)', 'public.jobsetup_clean_days(jsonb)', 'public.jobsetup_write_days(uuid, jsonb)',
                           'public.jobsetup_duplicate(uuid, text, date[])', 'public.jobsetup_check(jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.jobsetup_lookup()', 'public.jobsetup_history(integer)', 'public.jobsetup_copy_candidates(date, date, integer)',
                           'public.jobsetup_import(text, text, jsonb, boolean)', 'public.jobsetup_undo(uuid)',
                           'public.jobsetup_set_days(uuid, jsonb)', 'public.jobsetup_copy_one(uuid, integer, jsonb)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
