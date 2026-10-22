-- Partner portal (2026-10-23): one link per league or school, https://admin.207photo.com/#portal/<token>, no sign-in.
--
-- What the organization sees on it, all in one place:
--   Picture days   every job of theirs that isn't cancelled: date, time, place, where it stands, the team times we
--                  sent the coaches, a button into the picture day form (#plan/<token>, which takes the roster), and
--                  the deliverables with their download links once they are done.
--   Approvals      composites and proofs staff put up for approval. They open the file, then approve it or ask for
--                  changes with a note. A new file on the same proof starts a new round.
--   Agreement      the latest agreement, with a button into the accept page (#agree/<token>).
--   Files          files we share with them (download), and files they send us (roster, logo, a list of names).
--   Sales          their sales and payout statement from Season results, if staff leave it switched on.
--
-- Tables: partner_portals (one per organization: the link and its switches), portal_proofs, portal_files,
-- portal_settings (one row: the two email templates). Staff read them with can('portal', 'view') and change them
-- through the portal_* RPCs (edit). The public page uses portal_public_* RPCs keyed by the token.
--
-- Files live in the private bucket `portal` under <file_key>/<out|in|proofs>/<file>. file_key is a second random key
-- that never changes, so making a new link doesn't break files; the page only learns paths through the token. Anyone
-- can make a signed URL only for a path that is listed (not removed) on an active portal.
--
-- Email goes through the outreach pipeline (partner_email_put): Outbox, held for review or approved, do-not-contact,
-- bounces, unsubscribes and the outreach signature. Like every send path, only organizations with a booked job
-- (bookings.status = 'booked') can be emailed, and a proof tied to a job only when that job is booked. Never SMS.
-- Push: portal_proof (approved / changes asked) and portal_upload (they sent a file).

insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('portal', 'Partner portal', 'Partners',
        'One link per league or school: their picture days, team times, deliverables, proofs to approve, agreement, files and sales statement. View = see it; Edit = make links, put up proofs and files, email them.',
        66, 'live', false)
on conflict (key) do update set status = 'live', label = excluded.label, description = excluded.description;

-- ---------------------------------------------------------------- tables
create table public.partner_portals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null unique references public.prospect_orgs (id) on delete cascade,
  token       text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  file_key    text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  active      boolean not null default true,
  show_sales  boolean not null default true,
  welcome     text not null default '' check (length(welcome) <= 2000),
  viewed_at   timestamptz,
  view_count  int not null default 0,
  email_id    uuid references public.prospect_scheduled_emails (id) on delete set null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.partner_portals is 'Partner portal: one link per organization (#portal/<token>). file_key prefixes its files in the portal bucket.';

create table public.portal_proofs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.prospect_orgs (id) on delete cascade,
  booking_id   uuid references public.bookings (id) on delete set null,
  label        text not null check (btrim(label) <> '' and length(label) <= 120),
  note         text not null default '' check (length(note) <= 2000),
  file_path    text,
  file_name    text,
  link         text check (link is null or link ~* '^https?://'),
  round        int not null default 1,
  status       text not null default 'waiting' check (status in ('waiting', 'approved', 'changes', 'withdrawn')),
  decided_name text,
  decided_note text,
  decided_at   timestamptz,
  history      jsonb not null default '[]'::jsonb,   -- earlier rounds: [{round, status, name, note, at, file_name}]
  email_id     uuid references public.prospect_scheduled_emails (id) on delete set null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (file_path is not null or link is not null)
);
create index portal_proofs_org_idx on public.portal_proofs (org_id, created_at desc);
create index portal_proofs_booking_idx on public.portal_proofs (booking_id);
comment on table public.portal_proofs is 'Composites and proofs put up for an organization to approve on its portal. history keeps earlier rounds.';

create table public.portal_files (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.prospect_orgs (id) on delete cascade,
  booking_id  uuid references public.bookings (id) on delete set null,
  direction   text not null check (direction in ('out', 'in')),   -- out = we share it with them; in = they sent it
  path        text not null unique,
  name        text not null,
  size_bytes  bigint,
  note        text not null default '' check (length(note) <= 1000),
  from_name   text not null default '',
  seen_at     timestamptz,                                         -- staff opened a file they sent
  removed_at  timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index portal_files_org_idx on public.portal_files (org_id, created_at desc) where removed_at is null;
comment on table public.portal_files is 'Files on a partner portal: shared with the organization (out) or sent by them (in).';

create table public.portal_settings (
  id            boolean primary key default true check (id),
  invite_subject text not null default 'Your 207 Photo page for {{league|picture day}}',
  invite_body    text not null default E'{{hi|Hi there}},\n\nEverything for {{league|your picture day}} with 207 Photo is now on one page: your picture day and team times, the roster form, your agreement, files, and photos to approve as they are ready. Once sales are in, your sales and payout statement shows there too.\n\n{{portal_link}}\n\nNo account or password needed. Keep the link handy and share it with anyone who helps run picture day.\n\nThanks!',
  proof_subject  text not null default '{{proof}} is ready for your OK',
  proof_body     text not null default E'{{hi|Hi there}},\n\n{{proof}} for {{league|your organization}} is ready. Please take a look and approve it, or tell us what to change, on your 207 Photo page:\n\n{{portal_link}}\n\nThanks!',
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);
comment on table public.portal_settings is 'One row: the partner portal email templates (the link, and a proof to approve).';
insert into public.portal_settings default values;

-- ---------------------------------------------------------------- access
alter table public.partner_portals enable row level security;
alter table public.portal_proofs   enable row level security;
alter table public.portal_files    enable row level security;
alter table public.portal_settings enable row level security;
revoke all on public.partner_portals, public.portal_proofs, public.portal_files, public.portal_settings from anon, authenticated;
grant select on public.partner_portals, public.portal_proofs, public.portal_files, public.portal_settings to authenticated;
grant update on public.portal_settings to authenticated;
create policy partner_portals_read on public.partner_portals for select to authenticated using ((select public.can('portal', 'view')));
create policy portal_proofs_read   on public.portal_proofs   for select to authenticated using ((select public.can('portal', 'view')));
create policy portal_files_read    on public.portal_files    for select to authenticated using ((select public.can('portal', 'view')));
create policy portal_settings_read on public.portal_settings for select to authenticated using ((select public.can('portal', 'view')));
create policy portal_settings_write on public.portal_settings for update to authenticated
  using ((select public.can('portal', 'edit'))) with check ((select public.can('portal', 'edit')));

-- ---------------------------------------------------------------- files
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('portal', 'portal', false, 26214400,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp', 'image/gif', 'text/csv', 'text/plain',
              'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet',
              'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'])
on conflict (id) do nothing;

-- A path a portal page may read: listed and not removed, on an active portal.
create function public.portal_path_readable(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.partner_portals pp
                  where pp.active and pp.file_key = split_part(coalesce(p_name, ''), '/', 1)
                    and (exists (select 1 from public.portal_files f where f.path = p_name and f.org_id = pp.org_id and f.removed_at is null)
                      or exists (select 1 from public.portal_proofs x where x.file_path = p_name and x.org_id = pp.org_id and x.status <> 'withdrawn')))
$$;
-- A path an organization may upload to: <file_key>/in/<file> on an active portal.
create function public.portal_path_uploadable(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_name, '') ~ '^[0-9a-f]{32}/in/[^/]{1,200}$'
         and exists (select 1 from public.partner_portals pp where pp.active and pp.file_key = split_part(p_name, '/', 1))
$$;
-- Staff upload to <file_key>/out/... or <file_key>/proofs/... of any portal.
create function public.portal_path_staff(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_name, '') ~ '^[0-9a-f]{32}/(out|proofs)/[^/]{1,200}$'
         and exists (select 1 from public.partner_portals pp where pp.file_key = split_part(p_name, '/', 1))
$$;

create policy portal_files_public_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'portal' and public.portal_path_readable(name));
create policy portal_files_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'portal' and (select public.can('portal', 'view')));
create policy portal_files_public_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'portal' and public.portal_path_uploadable(name));
create policy portal_files_staff_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'portal' and (select public.can('portal', 'edit')) and public.portal_path_staff(name));
create policy portal_files_staff_delete on storage.objects for delete to authenticated
  using (bucket_id = 'portal' and (select public.can('portal', 'edit')));

-- ---------------------------------------------------------------- helpers
create function public.portal_link(p_token text) returns text
language sql immutable set search_path = '' as $$ select 'https://admin.207photo.com/#portal/' || p_token $$;

create function public.portal_clean(p text, p_max int default 500) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(coalesce(p, ''), '[\x00-\x08\x0b\x0c\x0e-\x1f]', '', 'g')), p_max) $$;

-- Only booked jobs send (track-only and cancelled never do).
create function public.portal_org_booked(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.bookings b where b.org_id = p_org and b.status = 'booked') $$;

-- The organization's portal, made if missing.
create function public.portal_ensure(p_org uuid) returns public.partner_portals
language plpgsql security definer set search_path = '' as $$
declare pp public.partner_portals;
begin
  select * into pp from public.partner_portals where org_id = p_org;
  if pp.id is null then
    if not exists (select 1 from public.prospect_orgs where id = p_org) then raise exception 'Organization not found.'; end if;
    insert into public.partner_portals (org_id, created_by) values (p_org, auth.uid())
    on conflict (org_id) do nothing;
    select * into pp from public.partner_portals where org_id = p_org;
  end if;
  return pp;
end $$;

create function public.portal_proof_json(x public.portal_proofs, p_staff boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', x.id, 'booking_id', x.booking_id, 'label', x.label, 'note', x.note,
    'file_path', x.file_path, 'file_name', x.file_name, 'link', x.link, 'round', x.round, 'status', x.status,
    'decided_name', x.decided_name, 'decided_note', x.decided_note, 'decided_at', x.decided_at, 'history', x.history,
    'created_at', x.created_at, 'updated_at', x.updated_at,
    'job', case when x.booking_id is not null then public.schedule_booking_title(x.booking_id) end)
  || case when p_staff then jsonb_build_object('email', case when x.email_id is not null then public.partner_email_state(x.email_id) end) else '{}'::jsonb end
$$;

create function public.portal_file_json(f public.portal_files) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', f.id, 'direction', f.direction, 'path', f.path, 'name', f.name, 'size', f.size_bytes,
    'note', f.note, 'from_name', f.from_name, 'booking_id', f.booking_id, 'seen_at', f.seen_at, 'created_at', f.created_at)
$$;

-- ---------------------------------------------------------------- the public page (no sign-in)
create function public.portal_public(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pp public.partner_portals; o public.prospect_orgs; v_today date := (now() at time zone 'America/New_York')::date;
        v_jobs jsonb; v_ag jsonb; v_sales jsonb := null;
begin
  if coalesce(length(p_token), 0) < 32 then return jsonb_build_object('found', false); end if;
  select * into pp from public.partner_portals where token = p_token;
  if pp.id is null or not pp.active then return jsonb_build_object('found', false); end if;
  select * into o from public.prospect_orgs where id = pp.org_id;
  update public.partner_portals set viewed_at = now(), view_count = view_count + 1 where id = pp.id;

  -- Jobs: everything not cancelled, upcoming first (soonest), then the last ~18 months (latest first).
  select coalesce(jsonb_agg(j order by (j->>'upcoming')::boolean desc,
                                       case when (j->>'upcoming')::boolean then j->>'picture_day' end,
                                       j->>'picture_day' desc), '[]'::jsonb) into v_jobs
    from (
      select jsonb_build_object(
        'id', b.id, 'title', public.schedule_booking_title(b.id), 'picture_day', b.picture_day,
        'start_at', case when b.time_set then b.start_at end, 'end_at', case when b.end_set then b.end_at end,
        'location', coalesce(b.location, ''), 'retake_day', b.retake_day,
        'upcoming', coalesce(b.picture_day >= v_today, true), 'status', b.status,
        'stage', (select s.label from public.booking_progress bp join public.booking_stages s on s.id = bp.stage_id where bp.booking_id = b.id),
        'plan', (select jsonb_build_object('token', case when b.status = 'booked' and b.picture_day >= v_today then p.token end,
                         'submitted_at', p.submitted_at, 'roster_name', p.roster_name)
                   from public.pd_plans p where p.booking_id = b.id),
        'teams', coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'slot_at', t.sent_slot_at, 'field', coalesce(t.sent_field, ''),
                                   'status', t.status) order by t.sent_slot_at, t.name)
                             from public.pd_teams t join public.pd_plans p on p.id = t.plan_id
                            where p.booking_id = b.id and t.removed_at is null and t.status <> 'new' and t.sent_slot_at is not null), '[]'::jsonb),
        'deliverables', coalesce((select jsonb_agg(jsonb_build_object('label', d.label, 'status', d.status, 'due_date', d.due_date,
                                   'link', case when d.status = 'done' then d.link end, 'done_at', d.done_at) order by d.sort, d.created_at)
                             from public.booking_deliverables d where d.booking_id = b.id and d.status <> 'skipped'), '[]'::jsonb)) j
        from public.bookings b
       where b.org_id = pp.org_id and b.status <> 'cancelled'
         and (b.picture_day is null or b.picture_day >= v_today - 550)
       limit 40) z;

  select jsonb_build_object('title', a.title, 'status', a.status, 'token', a.token, 'picture_day', a.picture_day,
                            'accepted_name', a.accepted_name, 'accepted_at', a.accepted_at, 'renewal_date', a.renewal_date)
    into v_ag
    from public.partner_agreements a where a.org_id = pp.org_id and a.status in ('sent', 'accepted')
   order by a.created_at desc limit 1;

  if pp.show_sales and exists (select 1 from public.job_results r where r.org_id = pp.org_id) then
    select jsonb_build_object(
      'jobs', coalesce(jsonb_agg(jsonb_build_object('name', c.job_name, 'picture_day', c.picture_day, 'season', c.season, 'season_year', c.season_year,
                'sales', c.sales, 'orders', c.orders, 'pct', c.pct, 'due', c.due, 'paid', c.paid, 'balance', c.balance, 'state', c.payout_state,
                'fixed', c.payout_amount is not null)
              order by c.picture_day desc nulls last), '[]'::jsonb),
      'sales', coalesce(sum(c.sales), 0), 'due', coalesce(sum(c.due), 0), 'paid', coalesce(sum(c.paid), 0), 'balance', coalesce(sum(c.balance), 0),
      'payments', coalesce((select jsonb_agg(jsonb_build_object('amount', p.amount, 'paid_on', p.paid_on, 'method', p.method, 'job', r.job_name) order by p.paid_on desc, p.id desc)
                             from public.job_payments p join public.job_results r on r.gotphoto_job_id = p.gotphoto_job_id where r.org_id = pp.org_id), '[]'::jsonb))
      into v_sales
      from public.job_results_calc c where c.org_id = pp.org_id;
  end if;

  return jsonb_build_object('found', true, 'org', o.name, 'welcome', pp.welcome, 'file_key', pp.file_key,
    'jobs', v_jobs, 'agreement', v_ag, 'sales', v_sales,
    'proofs', coalesce((select jsonb_agg(public.portal_proof_json(x, false) order by (x.status = 'waiting') desc, x.updated_at desc)
                          from public.portal_proofs x where x.org_id = pp.org_id and x.status <> 'withdrawn'), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(public.portal_file_json(f) order by f.created_at desc)
                         from public.portal_files f where f.org_id = pp.org_id and f.removed_at is null), '[]'::jsonb));
end $$;

-- They approve a proof or ask for changes.
create function public.portal_public_proof(p_token text, p_proof uuid, p_answer text, p_name text, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pp public.partner_portals; x public.portal_proofs; v_name text := public.portal_clean(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'), 120);
        v_note text := public.portal_clean(p_note, 2000); v_org text;
begin
  if p_answer not in ('approve', 'changes') then raise exception 'Pick approve or changes.'; end if;
  select * into pp from public.partner_portals where token = p_token and active;
  if pp.id is null or coalesce(length(p_token), 0) < 32 then raise exception 'This link is not valid.'; end if;
  select * into x from public.portal_proofs where id = p_proof and org_id = pp.org_id for update;
  if x.id is null or x.status = 'withdrawn' then raise exception 'That proof is no longer up. Please reply to our email.'; end if;
  if x.status <> 'waiting' then raise exception 'You already answered this one. We''ll post a new version if anything changes.'; end if;
  if length(v_name) < 2 or v_name !~ '[[:alpha:]]' then raise exception 'Type your name.'; end if;
  if p_answer = 'changes' and v_note = '' then raise exception 'Tell us what to change.'; end if;
  update public.portal_proofs set status = case when p_answer = 'approve' then 'approved' else 'changes' end,
         decided_name = v_name, decided_note = v_note, decided_at = now(), updated_at = now()
   where id = x.id;
  select name into v_org from public.prospect_orgs where id = x.org_id;
  insert into public.prospect_activities (org_id, kind, body, meta, occurred_at)
  values (x.org_id, 'note', v_name || case when p_answer = 'approve' then ' approved ' else ' asked for changes to ' end || x.label || ' on the partner portal.'
                            || case when v_note <> '' then E'\n' || v_note else '' end,
          jsonb_build_object('source', 'portal', 'proof_id', x.id), now());
  begin
    perform public.push_notify('portal_proof',
      case when p_answer = 'approve' then x.label || ' approved' else 'Changes asked: ' || x.label end,
      coalesce(v_org, '') || ': ' || v_name || case when v_note <> '' then ': ' || left(v_note, 160) else '' end,
      '/#partners/portal/' || x.org_id, 'portal_proof_' || x.id);
  exception when others then raise warning 'portal_proof push: %', sqlerrm;
  end;
  return jsonb_build_object('ok', true, 'status', case when p_answer = 'approve' then 'approved' else 'changes' end);
end $$;

-- They sent a file: the page uploads it to <file_key>/in/... and records it here.
create function public.portal_public_upload(p_token text, p_path text, p_name text, p_size bigint, p_from text default '', p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pp public.partner_portals; v_org text; v_from text := public.portal_clean(p_from, 120);
begin
  select * into pp from public.partner_portals where token = p_token and active;
  if pp.id is null or coalesce(length(p_token), 0) < 32 then raise exception 'This link is not valid.'; end if;
  if split_part(coalesce(p_path, ''), '/', 1) <> pp.file_key or not public.portal_path_uploadable(p_path) then raise exception 'That upload didn''t work. Please try again.'; end if;
  if (select count(*) from public.portal_files where org_id = pp.org_id and direction = 'in' and created_at > now() - interval '1 day') >= 50 then
    raise exception 'That''s a lot of files today. Please email the rest to 207 Photo.';
  end if;
  insert into public.portal_files (org_id, direction, path, name, size_bytes, note, from_name)
  values (pp.org_id, 'in', p_path, public.portal_clean(p_name, 200), p_size, public.portal_clean(p_note, 1000), v_from)
  on conflict (path) do nothing;
  select name into v_org from public.prospect_orgs where id = pp.org_id;
  begin
    perform public.push_notify('portal_upload', 'New file from ' || coalesce(v_org, 'a partner'),
      public.portal_clean(p_name, 120) || case when v_from <> '' then ' (' || v_from || ')' else '' end,
      '/#partners/portal/' || pp.org_id, 'portal_upload_' || pp.org_id);
  exception when others then raise warning 'portal_upload push: %', sqlerrm;
  end;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- staff
create function public.portal_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('portal', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('org_id', o.id, 'org', o.name, 'town', coalesce(o.town, ''), 'token', pp.token, 'active', pp.active,
             'show_sales', pp.show_sales, 'viewed_at', pp.viewed_at, 'view_count', pp.view_count, 'created_at', pp.created_at,
             'email', case when pp.email_id is not null then public.partner_email_state(pp.email_id) end,
             'next_day', (select min(b.picture_day) from public.bookings b where b.org_id = o.id and b.status = 'booked' and b.picture_day >= v_today),
             'waiting', (select count(*) from public.portal_proofs x where x.org_id = o.id and x.status = 'waiting'),
             'changes', (select count(*) from public.portal_proofs x where x.org_id = o.id and x.status = 'changes'),
             'approved', (select count(*) from public.portal_proofs x where x.org_id = o.id and x.status = 'approved'),
             'new_files', (select count(*) from public.portal_files f where f.org_id = o.id and f.direction = 'in' and f.seen_at is null and f.removed_at is null))
           order by pp.active desc, coalesce(pp.viewed_at, pp.created_at) desc)
      from public.partner_portals pp join public.prospect_orgs o on o.id = pp.org_id), '[]'::jsonb);
end $$;

create function public.portal_orgs(p_q text default '') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_q, ''));
begin
  if not public.can('portal', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', z.id, 'name', z.name, 'town', z.town, 'has', z.has) order by z.booked desc, z.name)
    from (select o.id, o.name, coalesce(o.town, '') town, exists (select 1 from public.partner_portals pp where pp.org_id = o.id) has,
                 exists (select 1 from public.bookings b where b.org_id = o.id and b.status <> 'cancelled') booked
            from public.prospect_orgs o
           where (v_q = '' and exists (select 1 from public.bookings b where b.org_id = o.id and b.status <> 'cancelled'))
              or (v_q <> '' and (o.name ilike '%' || v_q || '%' or coalesce(o.town, '') ilike '%' || v_q || '%'))
           order by 5 desc, o.name limit 30) z), '[]'::jsonb);
end $$;

-- One organization's portal: made on first open by someone who can edit.
create function public.portal_get(p_org uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pp public.partner_portals; o public.prospect_orgs;
begin
  if not public.can('portal', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into o from public.prospect_orgs where id = p_org;
  if o.id is null then raise exception 'Organization not found.'; end if;
  select * into pp from public.partner_portals where org_id = p_org;
  if pp.id is null and public.can('portal', 'edit') then pp := public.portal_ensure(p_org); end if;
  return jsonb_build_object('org_id', o.id, 'org', o.name, 'town', coalesce(o.town, ''),
    'portal', case when pp.id is not null then jsonb_build_object('id', pp.id, 'token', pp.token, 'file_key', pp.file_key, 'active', pp.active,
                   'show_sales', pp.show_sales, 'welcome', pp.welcome, 'viewed_at', pp.viewed_at, 'view_count', pp.view_count,
                   'email', case when pp.email_id is not null then public.partner_email_state(pp.email_id) end) end,
    'can_email', public.portal_org_booked(o.id),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'title', public.schedule_booking_title(b.id), 'picture_day', b.picture_day, 'status', b.status)
                            order by b.picture_day desc nulls first)
                            from public.bookings b where b.org_id = o.id and b.status <> 'cancelled'), '[]'::jsonb),
    'proofs', coalesce((select jsonb_agg(public.portal_proof_json(x, true) order by (x.status = 'withdrawn'), x.created_at desc)
                          from public.portal_proofs x where x.org_id = o.id), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(public.portal_file_json(f) order by f.created_at desc)
                         from public.portal_files f where f.org_id = o.id and f.removed_at is null), '[]'::jsonb));
end $$;

-- p: {active?, show_sales?, welcome?, new_link?: true}
create function public.portal_save(p_org uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pp public.partner_portals;
begin
  if not public.can('portal', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  pp := public.portal_ensure(p_org);
  update public.partner_portals set
    active = coalesce((p->>'active')::boolean, active),
    show_sales = coalesce((p->>'show_sales')::boolean, show_sales),
    welcome = case when p ? 'welcome' then public.portal_clean(p->>'welcome', 2000) else welcome end,
    token = case when coalesce((p->>'new_link')::boolean, false) then encode(extensions.gen_random_bytes(18), 'hex') else token end,
    viewed_at = case when coalesce((p->>'new_link')::boolean, false) then null else viewed_at end,
    view_count = case when coalesce((p->>'new_link')::boolean, false) then 0 else view_count end,
    updated_at = now()
   where id = pp.id
  returning * into pp;
  return jsonb_build_object('ok', true, 'token', pp.token);
end $$;

-- Add or change a proof. p: {org_id (new), booking_id, label, note, file_path, file_name, link}.
-- A new file or link on a proof that was answered starts the next round.
create function public.portal_proof_save(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.portal_proofs; pp public.partner_portals; v_org uuid; v_bk uuid := nullif(p->>'booking_id', '')::uuid;
        v_path text := nullif(btrim(coalesce(p->>'file_path', '')), ''); v_link text := nullif(btrim(coalesce(p->>'link', '')), '');
        v_label text := public.portal_clean(p->>'label', 120); v_new_file boolean;
begin
  if not public.can('portal', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_link is not null and v_link !~* '^https?://' then raise exception 'The link must start with https://'; end if;
  if p_id is not null then
    select * into x from public.portal_proofs where id = p_id for update;
    if x.id is null then raise exception 'Proof not found.'; end if;
    v_org := x.org_id;
  else
    v_org := nullif(p->>'org_id', '')::uuid;
  end if;
  pp := public.portal_ensure(v_org);
  if v_bk is not null and not exists (select 1 from public.bookings where id = v_bk and org_id = v_org) then raise exception 'That job is not this organization''s.'; end if;
  if v_path is not null and split_part(v_path, '/', 1) <> pp.file_key then raise exception 'Upload the file again.'; end if;
  if v_label = '' then raise exception 'Name the proof (for example "Team composite").'; end if;
  if x.id is null then
    if v_path is null and v_link is null then raise exception 'Upload a file or paste a link.'; end if;
    insert into public.portal_proofs (org_id, booking_id, label, note, file_path, file_name, link, created_by)
    values (v_org, v_bk, v_label, public.portal_clean(p->>'note', 2000), v_path, public.portal_clean(p->>'file_name', 200), v_link, auth.uid())
    returning * into x;
  else
    v_new_file := (v_path is not null and v_path is distinct from x.file_path) or (p ? 'link' and v_link is distinct from x.link);
    if coalesce(v_path, x.file_path) is null and (case when p ? 'link' then v_link else x.link end) is null then raise exception 'Upload a file or paste a link.'; end if;
    update public.portal_proofs set
      label = v_label, booking_id = v_bk, note = public.portal_clean(p->>'note', 2000),
      file_path = coalesce(v_path, file_path), file_name = case when v_path is not null then public.portal_clean(p->>'file_name', 200) else file_name end,
      link = case when p ? 'link' then v_link else link end,
      history = case when v_new_file and status in ('approved', 'changes') then history || jsonb_build_array(jsonb_build_object('round', round, 'status', status,
                  'name', decided_name, 'note', decided_note, 'at', decided_at, 'file_name', file_name)) else history end,
      round = case when v_new_file and status in ('approved', 'changes') then round + 1 else round end,
      status = case when v_new_file or status = 'withdrawn' then 'waiting' else status end,
      decided_name = case when v_new_file or status = 'withdrawn' then null else decided_name end,
      decided_note = case when v_new_file or status = 'withdrawn' then null else decided_note end,
      decided_at = case when v_new_file or status = 'withdrawn' then null else decided_at end,
      updated_at = now()
     where id = x.id
    returning * into x;
  end if;
  return jsonb_build_object('ok', true, 'id', x.id, 'round', x.round, 'status', x.status);
end $$;

create function public.portal_proof_withdraw(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('portal', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.portal_proofs set status = 'withdrawn', updated_at = now() where id = p_id;
  if not found then raise exception 'Proof not found.'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Share a file with them (staff uploaded it to <file_key>/out/...).
create function public.portal_file_add(p_org uuid, p_path text, p_name text, p_size bigint, p_note text default '', p_booking uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pp public.partner_portals; v_id uuid;
begin
  if not public.can('portal', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  pp := public.portal_ensure(p_org);
  if split_part(coalesce(p_path, ''), '/', 1) <> pp.file_key or split_part(p_path, '/', 2) <> 'out' then raise exception 'Upload the file again.'; end if;
  if p_booking is not null and not exists (select 1 from public.bookings where id = p_booking and org_id = p_org) then raise exception 'That job is not this organization''s.'; end if;
  insert into public.portal_files (org_id, booking_id, direction, path, name, size_bytes, note, created_by, seen_at)
  values (p_org, p_booking, 'out', p_path, public.portal_clean(p_name, 200), p_size, public.portal_clean(p_note, 1000), auth.uid(), now())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function public.portal_file_remove(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('portal', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.portal_files set removed_at = now() where id = p_id and removed_at is null;
  if not found then raise exception 'File not found.'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Files they sent: seen once someone who can see the portal opens or ticks them.
create function public.portal_files_seen(p_org uuid, p_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.can('portal', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.portal_files set seen_at = now()
   where org_id = p_org and direction = 'in' and seen_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'seen', n);
end $$;

-- Today: proofs they asked to change, and files they sent that nobody opened.
create function public.portal_attention() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('portal', 'view') then return jsonb_build_object('changes', 0, 'files', 0); end if;
  return jsonb_build_object(
    'changes', (select count(*) from public.portal_proofs where status = 'changes'),
    'files', (select count(*) from public.portal_files where direction = 'in' and seen_at is null and removed_at is null));
end $$;

-- ---------------------------------------------------------------- email (outreach pipeline)
-- p_kind: 'invite' (p_ref = org id) or 'proof' (p_ref = proof id). Returns who it can go to and the filled-in template.
create function public.portal_compose(p_kind text, p_ref uuid, p_contact uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.portal_settings; v_org uuid; x public.portal_proofs; pp public.partner_portals; v_first uuid[] := '{}';
        v_contacts jsonb; v_contact uuid; v_vars jsonb; v_subj text; v_body text; v_warn text := '';
begin
  if not public.can('portal', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into s from public.portal_settings;
  if p_kind = 'invite' then
    v_org := p_ref;
    select coalesce(b.contact_ids, '{}') into v_first from public.bookings b
     where b.org_id = v_org and b.status = 'booked' order by b.picture_day nulls last limit 1;
  elsif p_kind = 'proof' then
    select * into x from public.portal_proofs where id = p_ref;
    if x.id is null then raise exception 'Proof not found.'; end if;
    if x.status <> 'waiting' then raise exception 'Only a proof waiting for their OK can be emailed.'; end if;
    v_org := x.org_id;
    select coalesce(b.contact_ids, '{}') into v_first from public.bookings b where b.id = x.booking_id;
  else raise exception 'Unknown kind.';
  end if;
  pp := public.portal_ensure(v_org);
  if not pp.active then raise exception 'Turn the portal on first.'; end if;
  v_contacts := public.partner_contacts(v_org, coalesce(v_first, '{}'));
  v_contact := coalesce(p_contact, (v_contacts -> 0 ->> 'id')::uuid);
  v_vars := public.partner_vars(v_org, v_contact) || jsonb_build_object('portal_link', public.portal_link(pp.token), 'proof', coalesce(x.label, ''));
  if p_kind = 'invite' then v_subj := s.invite_subject; v_body := s.invite_body; else v_subj := s.proof_subject; v_body := s.proof_body; end if;
  if not public.portal_org_booked(v_org) or (x.booking_id is not null and (select b.status from public.bookings b where b.id = x.booking_id) <> 'booked') then
    v_warn := 'Only booked jobs send email. Copy the link instead.';
  end if;
  if exists (select 1 from public.prospect_scheduled_emails e where e.org_id = v_org and e.status in ('held', 'scheduled', 'sending')) then
    v_warn := btrim(v_warn || ' This organization already has an email waiting to go.');
  end if;
  return jsonb_build_object('org_id', v_org, 'org', (select name from public.prospect_orgs where id = v_org), 'contacts', v_contacts, 'contact_id', v_contact,
    'subject', public.prospect_tidy(public.prospect_render(v_subj, v_vars)), 'body', public.prospect_tidy(public.prospect_render(v_body, v_vars)), 'warning', v_warn);
end $$;

create function public.portal_queue(p_kind text, p_ref uuid, p_contact uuid, p_subject text, p_body text, p_approve boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; x public.portal_proofs; pp public.partner_portals; v_id uuid;
begin
  if not public.can('portal', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_kind = 'invite' then
    v_org := p_ref;
  elsif p_kind = 'proof' then
    select * into x from public.portal_proofs where id = p_ref for update;
    if x.id is null then raise exception 'Proof not found.'; end if;
    if x.status <> 'waiting' then raise exception 'Only a proof waiting for their OK can be emailed.'; end if;
    v_org := x.org_id;
    if x.booking_id is not null and (select b.status from public.bookings b where b.id = x.booking_id) <> 'booked' then
      raise exception 'Only booked jobs send email. Copy the link instead.';
    end if;
    if public.partner_email_waiting(x.email_id) then raise exception 'An email about this proof is already waiting. Change it in Outreach to review.'; end if;
  else raise exception 'Unknown kind.';
  end if;
  select * into pp from public.partner_portals where org_id = v_org;
  if pp.id is null or not pp.active then raise exception 'Turn the portal on first.'; end if;
  if not public.portal_org_booked(v_org) then raise exception 'Only organizations with a booked job get email. Copy the link instead.'; end if;
  if strpos(coalesce(p_body, ''), pp.token) = 0 then raise exception 'Keep the portal link in the message.'; end if;
  if p_kind = 'invite' and public.partner_email_waiting(pp.email_id) then raise exception 'An email with this link is already waiting. Change it in Outreach to review.'; end if;
  v_id := public.partner_email_put(v_org, p_contact, p_subject, p_body, coalesce(p_approve, false));
  if p_kind = 'invite' then update public.partner_portals set email_id = v_id, updated_at = now() where id = pp.id;
  else update public.portal_proofs set email_id = v_id, updated_at = now() where id = x.id;
  end if;
  return jsonb_build_object('ok', true, 'email_id', v_id, 'status', case when p_approve then 'scheduled' else 'review' end);
end $$;

-- The job page's Partner portal tab: the organization's link and this job's proofs and shared files.
create function public.portal_job(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings; pp public.partner_portals;
begin
  if not public.can('portal', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking;
  if b.id is null then raise exception 'Booking not found.'; end if;
  select * into pp from public.partner_portals where org_id = b.org_id;
  return jsonb_build_object('org_id', b.org_id, 'org', (select name from public.prospect_orgs where id = b.org_id),
    'token', pp.token, 'active', pp.active, 'viewed_at', pp.viewed_at,
    'proofs', coalesce((select jsonb_agg(public.portal_proof_json(x, true) order by x.created_at desc)
                          from public.portal_proofs x where x.booking_id = b.id and x.status <> 'withdrawn'), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(public.portal_file_json(f) order by f.created_at desc)
                         from public.portal_files f where f.booking_id = b.id and f.removed_at is null), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------- push kinds
insert into public.push_topics (key, label, description, module, sort) values
  ('portal_proof',  'Proof answered', 'A league or school approved a proof or asked for changes on their partner portal.', 'portal', 66),
  ('portal_upload', 'File from a partner', 'A league or school sent a file through their partner portal.', 'portal', 67)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- grants
revoke all on function public.portal_path_readable(text), public.portal_path_uploadable(text), public.portal_path_staff(text),
  public.portal_link(text), public.portal_clean(text, int), public.portal_org_booked(uuid), public.portal_ensure(uuid),
  public.portal_proof_json(public.portal_proofs, boolean), public.portal_file_json(public.portal_files),
  public.portal_public(text), public.portal_public_proof(text, uuid, text, text, text), public.portal_public_upload(text, text, text, bigint, text, text),
  public.portal_list(), public.portal_orgs(text), public.portal_get(uuid), public.portal_save(uuid, jsonb),
  public.portal_proof_save(uuid, jsonb), public.portal_proof_withdraw(uuid), public.portal_file_add(uuid, text, text, bigint, text, uuid),
  public.portal_file_remove(uuid), public.portal_files_seen(uuid, uuid[]), public.portal_attention(),
  public.portal_compose(text, uuid, uuid), public.portal_queue(text, uuid, uuid, text, text, boolean), public.portal_job(uuid)
from public, anon, authenticated;
grant execute on function
  public.portal_list(), public.portal_orgs(text), public.portal_get(uuid), public.portal_save(uuid, jsonb),
  public.portal_proof_save(uuid, jsonb), public.portal_proof_withdraw(uuid), public.portal_file_add(uuid, text, text, bigint, text, uuid),
  public.portal_file_remove(uuid), public.portal_files_seen(uuid, uuid[]), public.portal_attention(),
  public.portal_compose(text, uuid, uuid), public.portal_queue(text, uuid, uuid, text, text, boolean), public.portal_job(uuid)
to authenticated;
-- The public page, and the storage checks its policies call: anyone with the link.
grant execute on function public.portal_public(text), public.portal_public_proof(text, uuid, text, text, text),
  public.portal_public_upload(text, text, text, bigint, text, text), public.portal_path_readable(text), public.portal_path_uploadable(text)
to anon, authenticated;
grant execute on function public.portal_path_staff(text) to authenticated;
