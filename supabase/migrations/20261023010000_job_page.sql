-- Job page (2026-10-23, Airstudio plan A, J, K).
--  * job_get(): everything about one booking on one screen, trimmed to what the viewer may see.
--  * job_notes: a notes thread on each job; @mentions push to the person mentioned.
--  * record_history: who changed what (before and after) on bookings, their days and crew, organizations,
--    time punches and mileage trips. history_get() reads it with the same access as the record.
--  * signin_log: each trusted sign-in (code or remembered device) with IP, country and browser.
-- Contains "delete" (FK and trigger events), so apply it from the Mac like the other module migrations.

-- ---------------------------------------------------------------- who may open a job
-- Anyone with a job area, or anyone on the job's crew.
create or replace function public.job_can_view(p_booking uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.can_any(array['bookings', 'scheduling', 'pictureday', 'workflows', 'results'], 'view')
      or (public.admin_session_ok() and exists (select 1 from public.schedule_entries e
                                                 where e.booking_id = p_booking and e.user_id = (select auth.uid())))
$$;
revoke all on function public.job_can_view(uuid) from public, anon;
grant execute on function public.job_can_view(uuid) to authenticated;

-- ---------------------------------------------------------------- one job
create or replace function public.job_get(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  b public.bookings; o public.prospect_orgs; t public.booking_types;
  v_bk boolean := public.can('bookings', 'view');
  v_pd boolean := public.can('pictureday', 'view');
  v_wf boolean := public.can('workflows', 'view');
  v_rs boolean := public.can('results', 'view');
  v_sc boolean := public.can('scheduling', 'view');
  v_crew boolean;
  v_plan public.pd_plans;
begin
  if not public.job_can_view(p_booking) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking;
  if b.id is null then return null; end if;
  select * into o from public.prospect_orgs where id = b.org_id;
  select * into t from public.booking_types where key = b.type_key;
  v_crew := exists (select 1 from public.schedule_entries e where e.booking_id = b.id and e.user_id = (select auth.uid()));
  select * into v_plan from public.pd_plans where booking_id = b.id;

  return jsonb_build_object(
    'booking', jsonb_build_object(
      'id', b.id, 'title', coalesce(b.title_override, b.title_label || ' ' || chr(8226) || ' ' || o.name),
      'org_id', b.org_id, 'org_name', o.name, 'org_town', o.town, 'type_key', b.type_key, 'type_label', t.label,
      'audience', t.audience, 'status', b.status, 'picture_day', b.picture_day, 'start_at', b.start_at, 'end_at', b.end_at,
      'time_set', b.time_set, 'end_set', b.end_set, 'location', b.location, 'retake_day', b.retake_day,
      'notes', b.notes, 'gotphoto_job_id', b.gotphoto_job_id, 'created_at', b.created_at,
      'access_code', case when v_bk then b.access_code end),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'start_at', d.start_at, 'end_at', d.end_at, 'label', d.label) order by d.day), '[]'::jsonb)
               from public.booking_days d where d.booking_id = b.id and not d.removed),
    'stage', (select jsonb_build_object('label', ev.label, 'at', ev.at, 'auto', ev.auto)
                from public.booking_stage_events ev where ev.booking_id = b.id order by ev.at desc, ev.id desc limit 1),
    'stages', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label,
                        'reached', exists (select 1 from public.booking_stage_events ev where ev.booking_id = b.id and ev.stage_id = s.id)) order by s.sort), '[]'::jsonb)
                 from public.booking_stages s where s.type_key = b.type_key and s.archived_at is null),
    'crew', (select coalesce(jsonb_agg(jsonb_build_object('user_id', e.user_id, 'name', coalesce(public.staff_name(e.user_id), 'Someone'),
                      'starts_at', e.starts_at, 'ends_at', e.ends_at, 'drive_before_min', e.drive_before_min, 'note', e.note) order by e.starts_at), '[]'::jsonb)
               from public.schedule_entries e where e.booking_id = b.id and e.user_id is not null),
    'contacts', case when v_bk then (select coalesce(jsonb_agg(jsonb_build_object('name', nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
                      'email', c.email, 'phone', c.phone, 'role', c.role) order by c.is_primary desc, c.first_name), '[]'::jsonb)
                   from public.prospect_contacts c where c.id = any(b.contact_ids)) end,
    'deliverables', case when v_bk then (select coalesce(jsonb_agg(jsonb_build_object('label', d.label, 'status', d.status, 'due_date', d.due_date, 'link', d.link) order by d.sort, d.created_at), '[]'::jsonb)
                       from public.booking_deliverables d where d.booking_id = b.id) end,
    'tasks', case when v_wf or v_bk or v_sc or v_crew then (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'due_on', k.due_on,
                      'priority', k.priority, 'who', coalesce(public.staff_name(k.user_id), ''), 'mine', k.user_id = (select auth.uid()),
                      'done', exists (select 1 from public.staff_task_done x where x.task_id = k.id)) order by k.due_on nulls last, k.title), '[]'::jsonb)
                from public.staff_tasks k where k.booking_id = b.id and k.active) end,
    'picture_day', case when v_pd and v_plan.id is not null then jsonb_build_object(
                      'intake_sent_at', v_plan.intake_sent_at, 'submitted_at', v_plan.submitted_at, 'roster_name', v_plan.roster_name,
                      'onsite_name', v_plan.onsite_name, 'onsite_phone', v_plan.onsite_phone,
                      'teams', (select count(*) from public.pd_teams pt where pt.plan_id = v_plan.id and pt.removed_at is null),
                      'timed', (select count(*) from public.pd_teams pt where pt.plan_id = v_plan.id and pt.removed_at is null and pt.slot_at is not null),
                      'confirmed', (select count(*) from public.pd_teams pt where pt.plan_id = v_plan.id and pt.removed_at is null and pt.status = 'confirmed'),
                      'move', (select count(*) from public.pd_teams pt where pt.plan_id = v_plan.id and pt.removed_at is null and pt.status = 'move')) end,
    'results', case when v_rs and b.gotphoto_job_id is not null then (select jsonb_build_object('sales', r.sales, 'orders', r.orders, 'pct', r.pct,
                      'due', r.due, 'paid', r.paid, 'balance', r.balance, 'payout_state', r.payout_state, 'gallery_status', r.gallery_status)
                   from public.job_results_calc r where r.gotphoto_job_id = b.gotphoto_job_id) end,
    'notes_count', (select count(*) from public.job_notes n where n.booking_id = b.id and n.deleted_at is null),
    'can', jsonb_build_object('bookings', v_bk, 'bookings_edit', public.can('bookings', 'edit'), 'pictureday', v_pd, 'workflows', v_wf,
                              'results', v_rs, 'scheduling', v_sc, 'crew', v_crew));
end $$;
revoke all on function public.job_get(uuid) from public, anon;
grant execute on function public.job_get(uuid) to authenticated;

-- ---------------------------------------------------------------- job notes
create table if not exists public.job_notes (
  id          bigint generated always as identity primary key,
  booking_id  uuid not null references public.bookings (id) on delete cascade,
  author      uuid,
  author_name text not null default '',
  body        text not null check (length(body) between 1 and 4000),
  mentions    uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,
  deleted_at  timestamptz
);
create index if not exists job_notes_booking_idx on public.job_notes (booking_id, created_at);
alter table public.job_notes enable row level security;
revoke all on public.job_notes from anon, authenticated;   -- RPCs only

insert into public.push_topics (key, label, description, module, sort, default_on)
values ('job_mention', 'Mentioned in job notes', 'Someone @mentioned you in the notes on a job.', 'scheduling', 75, true)
on conflict (key) do nothing;

-- People who can be @mentioned on this job: the crew first, then everyone else who can open jobs.
create or replace function public.job_people(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.job_can_view(p_booking) then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'name', x.name, 'crew', x.crew) order by x.crew desc, x.name), '[]'::jsonb)
            from (select m.user_id, coalesce(public.staff_name(m.user_id), 'Someone') as name,
                         exists (select 1 from public.schedule_entries e where e.booking_id = p_booking and e.user_id = m.user_id) as crew
                    from public.team_members m
                   where (m.active or exists (select 1 from public.admin_users a where a.user_id = m.user_id))
                     and (exists (select 1 from public.admin_users a where a.user_id = m.user_id)
                          or exists (select 1 from unnest(array['bookings', 'scheduling', 'pictureday', 'workflows', 'results']) md where public.team_user_can(m.user_id, md))
                          or exists (select 1 from public.schedule_entries e where e.booking_id = p_booking and e.user_id = m.user_id))) x);
end $$;
revoke all on function public.job_people(uuid) from public, anon;
grant execute on function public.job_people(uuid) to authenticated;

create or replace function public.job_notes_list(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_mod boolean := public.can('bookings', 'edit');
begin
  if not public.job_can_view(p_booking) then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'author_name', n.author_name, 'body', n.body, 'created_at', n.created_at,
                 'edited_at', n.edited_at, 'mine', n.author = (select auth.uid()), 'can_remove', n.author = (select auth.uid()) or v_mod,
                 'mentions', (select coalesce(jsonb_agg(jsonb_build_object('user_id', u, 'name', coalesce(public.staff_name(u), 'Someone'))), '[]'::jsonb) from unnest(n.mentions) u))
                 order by n.created_at), '[]'::jsonb)
            from public.job_notes n where n.booking_id = p_booking and n.deleted_at is null);
end $$;
revoke all on function public.job_notes_list(uuid) from public, anon;
grant execute on function public.job_notes_list(uuid) to authenticated;

-- p_mentions: user ids picked from job_people(). Anyone not allowed on the job is dropped.
create or replace function public.job_note_add(p_booking uuid, p_body text, p_mentions uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := coalesce(public.staff_name((select auth.uid())), 'Someone');
  v_body text := btrim(coalesce(p_body, ''));
  v_title text;
  v_ok uuid[];
  v_id bigint;
  u uuid;
begin
  if not public.job_can_view(p_booking) then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_body = '' then return jsonb_build_object('ok', false, 'error', 'Write something first.'); end if;
  if length(v_body) > 4000 then return jsonb_build_object('ok', false, 'error', 'That note is too long. Keep it under 4,000 characters.'); end if;
  select array_agg(distinct (p ->> 'user_id')::uuid) into v_ok
    from jsonb_array_elements(public.job_people(p_booking)) p
   where (p ->> 'user_id')::uuid = any(coalesce(p_mentions, '{}'));
  insert into public.job_notes (booking_id, author, author_name, body, mentions)
  values (p_booking, v_uid, v_name, v_body, coalesce(v_ok, '{}')) returning id into v_id;

  select coalesce(b.title_override, b.title_label || ' ' || chr(8226) || ' ' || o.name) into v_title
    from public.bookings b join public.prospect_orgs o on o.id = b.org_id where b.id = p_booking;
  foreach u in array coalesce(v_ok, '{}') loop
    continue when u = v_uid;
    continue when exists (select 1 from public.push_prefs pp where pp.user_id = u and pp.topic = 'job_mention' and not pp.enabled);
    begin
      perform public.push_notify('job_mention', v_name || ' mentioned you: ' || coalesce(v_title, 'a job'), left(v_body, 280),
                                 '/#jobs/job/' || p_booking || '/notes', null, u);
    exception when others then null;   -- a notification never blocks the note
    end;
  end loop;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.job_note_add(uuid, text, uuid[]) from public, anon;
grant execute on function public.job_note_add(uuid, text, uuid[]) to authenticated;

create or replace function public.job_note_edit(p_id bigint, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_body text := btrim(coalesce(p_body, ''));
begin
  if v_body = '' or length(v_body) > 4000 then return jsonb_build_object('ok', false, 'error', 'A note needs between 1 and 4,000 characters.'); end if;
  update public.job_notes set body = v_body, edited_at = now()
   where id = p_id and author = (select auth.uid()) and deleted_at is null and public.job_can_view(booking_id);
  if not found then return jsonb_build_object('ok', false, 'error', 'You can only change your own notes.'); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.job_note_edit(bigint, text) from public, anon;
grant execute on function public.job_note_edit(bigint, text) to authenticated;

-- Removing hides the note; the text stays in the table.
create or replace function public.job_note_remove(p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.job_notes set deleted_at = now()
   where id = p_id and deleted_at is null and public.job_can_view(booking_id)
     and (author = (select auth.uid()) or public.can('bookings', 'edit'));
  if not found then return jsonb_build_object('ok', false, 'error', 'You can only remove your own notes.'); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.job_note_remove(bigint) from public, anon;
grant execute on function public.job_note_remove(bigint) to authenticated;

-- ---------------------------------------------------------------- record history
create table if not exists public.record_history (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,                 -- null = the system (sync, cron, a public form)
  actor_name  text not null default '',
  tbl         text not null,
  record_id   text not null,
  booking_id  uuid,                 -- set for rows that belong to a job, so the job page can list them together
  action      text not null check (action in ('added', 'changed', 'removed')),
  changes     jsonb not null default '{}'   -- {"field": [old, new]}
);
create index if not exists record_history_rec_idx on public.record_history (tbl, record_id, at desc);
create index if not exists record_history_booking_idx on public.record_history (booking_id, at desc) where booking_id is not null;
alter table public.record_history enable row level security;
revoke all on public.record_history from anon, authenticated;   -- history_get() only

-- Columns that change on their own and would only be noise.
create or replace function public.history_skip_cols()
returns text[] language sql immutable set search_path = '' as $$
  select array['updated_at', 'created_at', 'search_text', 'last_opened_at', 'calendar_status', 'calendar_error', 'calendar_attempts',
               'calendar_checked_at', 'google_event_id', 'gcal_event_id', 'stage_changed_at', 'last_contact_at', 'last_job_at',
               'next_job_at', 'job_count', 'edited', 'edited_at', 'edited_by']
$$;

create or replace function public.history_log()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_ch jsonb := '{}';
  v_uid uuid := (select auth.uid());
  v_skip text[] := public.history_skip_cols();
  k text;
begin
  begin
    -- Organizations change a lot in the background (stage autos, search text); keep only people's edits.
    if tg_table_name = 'prospect_orgs' and v_uid is null then return null; end if;
    if tg_op = 'UPDATE' then
      for k in select jsonb_object_keys(v_new) loop
        continue when k = any(v_skip);
        if (v_old -> k) is distinct from (v_new -> k) then v_ch := v_ch || jsonb_build_object(k, jsonb_build_array(v_old -> k, v_new -> k)); end if;
      end loop;
      if v_ch = '{}' then return null; end if;
    elsif tg_op = 'INSERT' then
      v_ch := (select coalesce(jsonb_object_agg(e.key, jsonb_build_array(null, e.value)), '{}') from jsonb_each(v_new) e
                where not (e.key = any(v_skip)) and e.value <> 'null'::jsonb and e.key not in ('id', 'token'));
    else
      v_ch := (select coalesce(jsonb_object_agg(e.key, jsonb_build_array(e.value, null)), '{}') from jsonb_each(v_old) e
                where not (e.key = any(v_skip)) and e.value <> 'null'::jsonb and e.key not in ('id', 'token'));
    end if;
    insert into public.record_history (actor, actor_name, tbl, record_id, booking_id, action, changes)
    values (v_uid, coalesce(public.staff_name(v_uid), case when v_uid is null then 'System' else 'Someone' end),
            tg_table_name, v_row ->> 'id',
            case when tg_table_name = 'bookings' then (v_row ->> 'id')::uuid else nullif(v_row ->> 'booking_id', '')::uuid end,
            case tg_op when 'INSERT' then 'added' when 'UPDATE' then 'changed' else 'removed' end, v_ch);
  exception when others then null;   -- history never blocks the change itself
  end;
  return null;
end $$;

drop trigger if exists zz_history on public.bookings;
create trigger zz_history after insert or update or delete on public.bookings for each row execute function public.history_log();
drop trigger if exists zz_history on public.booking_days;
create trigger zz_history after insert or update or delete on public.booking_days for each row execute function public.history_log();
drop trigger if exists zz_history on public.schedule_entries;
create trigger zz_history after insert or update or delete on public.schedule_entries for each row execute function public.history_log();
drop trigger if exists zz_history on public.prospect_orgs;
create trigger zz_history after update on public.prospect_orgs for each row execute function public.history_log();
drop trigger if exists zz_history on public.time_punches;
create trigger zz_history after insert or update or delete on public.time_punches for each row execute function public.history_log();
drop trigger if exists zz_history on public.mileage_trips;
create trigger zz_history after insert or update or delete on public.mileage_trips for each row execute function public.history_log();

-- p_kind: 'job' (a booking id: the booking, its days and crew, plus stage moves), 'org' (an organization id),
-- 'punches' (a team member's user id: their time punches and mileage). Newest first, at most 300 rows.
create or replace function public.history_get(p_kind text, p_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if p_kind = 'job' then
    if not public.job_can_view(p_id::uuid) then raise exception 'not allowed' using errcode = '42501'; end if;
    return (select coalesce(jsonb_agg(x order by x ->> 'at' desc), '[]'::jsonb) from (
      (select jsonb_build_object('at', h.at, 'who', h.actor_name, 'tbl', h.tbl, 'action', h.action, 'changes', h.changes) x
         from public.record_history h where h.booking_id = p_id::uuid order by h.at desc limit 300)
      union all
      (select jsonb_build_object('at', ev.at, 'who', case when ev.auto then 'System' else coalesce(public.staff_name(ev.by_user), 'Someone') end,
                                 'tbl', 'stage', 'action', 'changed', 'changes', jsonb_build_object('stage', jsonb_build_array(null, ev.label)))
         from public.booking_stage_events ev where ev.booking_id = p_id::uuid order by ev.at desc limit 100)) s);
  elsif p_kind = 'org' then
    if not public.can('partners', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
    return (select coalesce(jsonb_agg(jsonb_build_object('at', h.at, 'who', h.actor_name, 'tbl', h.tbl, 'action', h.action, 'changes', h.changes) order by h.at desc), '[]'::jsonb)
              from (select * from public.record_history h where h.tbl = 'prospect_orgs' and h.record_id = p_id order by h.at desc limit 300) h);
  elsif p_kind = 'punches' then
    if not (public.can('timeclock', 'edit') or (p_id = v_uid::text and public.can('timeclock', 'view'))) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    return (select coalesce(jsonb_agg(jsonb_build_object('at', h.at, 'who', h.actor_name, 'tbl', h.tbl, 'action', h.action, 'changes', h.changes) order by h.at desc), '[]'::jsonb)
              from (select h.* from public.record_history h
                     where h.tbl in ('time_punches', 'mileage_trips')
                       and coalesce(h.changes -> 'user_id' ->> 1, h.changes -> 'user_id' ->> 0,
                                    (select tp.user_id::text from public.time_punches tp where tp.id::text = h.record_id),
                                    (select mt.user_id::text from public.mileage_trips mt where mt.id::text = h.record_id)) = p_id
                     order by h.at desc limit 300) h);
  end if;
  raise exception 'unknown history kind' using errcode = '22023';
end $$;
revoke all on function public.history_get(text, text) from public, anon;
grant execute on function public.history_get(text, text) to authenticated;

-- ---------------------------------------------------------------- sign-ins
create table if not exists public.signin_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  at         timestamptz not null default now(),
  via        text not null default '',
  ip         text not null default '',
  country    text not null default '',
  user_agent text not null default ''
);
create index if not exists signin_log_user_idx on public.signin_log (user_id, at desc);
alter table public.signin_log enable row level security;
revoke all on public.signin_log from anon, authenticated;   -- signins_get() only

-- A session becomes trusted once the emailed code is right or a remembered device is used: that is a sign-in.
-- PostgREST passes the request headers, so the IP and browser come from the sign-in request itself.
create or replace function public.signin_log_add()
returns trigger language plpgsql security definer set search_path = '' as $$
declare h jsonb;
begin
  begin
    h := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}');
    insert into public.signin_log (user_id, via, ip, country, user_agent)
    values (new.user_id, coalesce(new.via, ''),
            btrim(split_part(coalesce(h ->> 'cf-connecting-ip', h ->> 'x-real-ip', h ->> 'x-forwarded-for', ''), ',', 1)),
            coalesce(h ->> 'cf-ipcountry', ''), left(coalesce(h ->> 'user-agent', ''), 400));
  exception when others then null;   -- logging never blocks a sign-in
  end;
  return null;
end $$;
drop trigger if exists zz_signin_log on public.admin_trusted_sessions;
create trigger zz_signin_log after insert on public.admin_trusted_sessions for each row execute function public.signin_log_add();

-- Your own sign-ins, or anyone's with Team edit.
create or replace function public.signins_get(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.can('team', 'edit') or (p_user = (select auth.uid()) and public.admin_session_ok())) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('at', s.at, 'via', s.via, 'ip', s.ip, 'country', s.country, 'user_agent', s.user_agent) order by s.at desc), '[]'::jsonb)
            from (select * from public.signin_log where user_id = p_user order by at desc limit 50) s);
end $$;
revoke all on function public.signins_get(uuid) from public, anon;
grant execute on function public.signins_get(uuid) to authenticated;
