-- Partner follow-through (2026-10-22): rebooking, review requests and agreements, in the Outreach area.
--
-- Rebooking   Every past client comes back when it is time to book again: last year's date, the job, and a
--             ready rebook email. The list is worked out live (partner_rebook_list) from prospect_orgs.last_job_at
--             (GotPhoto history) and bookings; partner_rebook only remembers what someone did about it
--             (emailed / later / not this year) for that year's date.
-- Reviews     When a job reaches its "Deliverables sent" stage, a partner_reviews row is made. For a booked job
--             (bookings.status = 'booked') a thank-you that asks for a Google review is drafted and HELD for
--             review in Outreach to review; nothing sends until someone approves it. Track-only jobs get the
--             row only, with a button to draft one by hand. Staff log what came back; a quote can be saved to
--             the Email library.
-- Agreements  A service agreement per organization: date, pricing and payout terms, accepted online at
--             https://admin.207photo.com/#agree/<token> by typing a name (no sign-in). Also the W-9, the
--             insurance certificate and the renewal date. New module `agreements` (Edit = make and send).
--
-- Every email here goes through the existing outreach pipeline (prospect_scheduled_emails), so it shows in the
-- Outbox, honours do-not-contact, bounces and unsubscribes, and uses the outreach sender and signature.
-- Templates use the same {{name|fallback}} placeholders as the Email library (prospect_render).

-- ---------------------------------------------------------------- module
insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('agreements', 'Agreements', 'Partners',
        'Service agreements with leagues and schools: sent, accepted online, W-9, insurance certificate and renewal date.', 65, 'live', false)
on conflict (key) do update set status = 'live';

-- ---------------------------------------------------------------- settings (one row): templates
create table public.partner_followup_settings (
  id                boolean primary key default true check (id),
  rebook_lead_days  integer not null default 75 check (rebook_lead_days between 14 and 240),
  rebook_subject    text not null default '{{league|Picture day}} {{year}}',
  rebook_body       text not null default E'{{hi|Hi there}},\n\nLast year we photographed {{league|your league}} on {{last_date}}, and it''s about time to get this year''s picture day on the calendar. Want me to hold the same time of year again? I can send over a few dates that work.\n\nThanks again for having us!',
  review_auto       boolean not null default true,
  review_link       text not null default '',
  review_subject    text not null default 'Thank you, {{league|from 207 Photo}}',
  review_body       text not null default E'{{hi|Hi there}},\n\nThank you for having us for {{job|picture day}}. Everything should be in your hands now; let me know if anything is missing.\n\nIf you were happy with how it went, would you leave us a quick Google review? It''s the biggest help to a small business like ours: {{review_link}}\n\nAnd if you have a sentence or two we could share with other leagues and schools, just reply to this email.\n\nThanks again!',
  agreement_subject text not null default '{{title}} for {{league|picture day}}',
  agreement_body    text not null default E'{{hi|Hi there}},\n\nHere is our agreement for {{league|picture day}}. It has the date, pricing and how the {{payout_word|fundraiser}} works. You can read it and accept it online by typing your name, no account needed:\n\n{{agreement_link}}\n\nAny questions, just reply.\n\nThanks!',
  agreement_terms   text not null default E'This agreement is between 207 Photo and {{league}}.\n\nPicture day: {{picture_day|to be scheduled together}}\nWhat we provide: {{job|team and individual photos}}\n\nPricing\n{{pricing|Families order online from their own gallery. There is no cost to the organization.}}\n\nPayout\n{{payout|None.}}\n\nWhat we do\n- Photograph every team or class that is scheduled, and come back for a makeup or retake session if one is agreed.\n- Put photos online within a few days and send families their access code.\n- Send the organization''s deliverables (team photos, composites, files) when they are ready.\n- Keep families'' information private and use it only for this picture day.\n\nWhat you do\n- Share the schedule and a roster (or let families pre-register), and give families the picture day information we send.\n- Give us a contact for the day and a place to set up.\n\nCancelling or moving\nEither of us can cancel or move picture day by email. We will always try to find a new date together.\n\nThis agreement runs until {{renewal_date|the end of this season}}.',
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);
comment on table public.partner_followup_settings is 'One row: rebook lead time, and the rebook / review / agreement email templates and default agreement terms.';
insert into public.partner_followup_settings default values;

-- ---------------------------------------------------------------- rebooking
create table public.partner_rebook (
  org_id      uuid not null references public.prospect_orgs (id) on delete cascade,
  due_on      date not null,             -- the date this year's picture day would be (last job + whole years)
  status      text not null default 'todo' check (status in ('todo', 'emailed', 'later', 'skipped')),
  later_until date,
  note        text not null default '',
  email_id    uuid references public.prospect_scheduled_emails (id) on delete set null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (org_id, due_on)
);
comment on table public.partner_rebook is 'What was done about rebooking an organization for one year (due_on = last job date moved forward to this year).';

-- ---------------------------------------------------------------- reviews
create table public.partner_reviews (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid unique references public.bookings (id) on delete cascade,
  org_id      uuid not null references public.prospect_orgs (id) on delete cascade,
  email_id    uuid references public.prospect_scheduled_emails (id) on delete set null,
  outcome     text not null default 'open' check (outcome in ('open', 'reviewed', 'quote', 'declined', 'no_reply', 'skipped')),
  quote       text not null default '',
  quote_by    text not null default '',
  snippet_id  uuid references public.prospect_snippets (id) on delete set null,
  note        text not null default '',
  reached_at  timestamptz not null default now(),   -- when the job reached Deliverables sent
  outcome_at  timestamptz,
  outcome_by  uuid,
  created_at  timestamptz not null default now()
);
comment on table public.partner_reviews is 'One per job that reached Deliverables sent: the review request email and what came back.';
create index partner_reviews_org_idx on public.partner_reviews (org_id, reached_at desc);

-- ---------------------------------------------------------------- agreements
create table public.partner_agreements (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.prospect_orgs (id) on delete cascade,
  booking_id     uuid references public.bookings (id) on delete set null,
  title          text not null default 'Picture day agreement',
  picture_day    date,
  job            text not null default '',
  pricing        text not null default '',
  payout         text not null default '',
  terms          text not null default '',      -- the wording, with {{placeholders}}; rendered when shown
  status         text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'void')),
  token          text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  email_id       uuid references public.prospect_scheduled_emails (id) on delete set null,
  sent_at        timestamptz,
  viewed_at      timestamptz,
  accepted_name  text,
  accepted_title text,
  accepted_at    timestamptz,
  accepted_ip    text,
  accepted_ua    text,
  accepted_text  text,                           -- exactly what they accepted, frozen
  renewal_date   date,
  w9_status      text not null default 'not_needed' check (w9_status in ('not_needed', 'needed', 'requested', 'on_file')),
  w9_at          date,
  w9_path        text,
  coi_status     text not null default 'not_needed' check (coi_status in ('not_needed', 'needed', 'requested', 'on_file')),
  coi_at         date,
  coi_expires    date,
  coi_path       text,
  note           text not null default '',
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.partner_agreements is 'Service agreements with organizations. Accepted online by typed name at #agree/<token>; accepted_text is what they saw.';
create index partner_agreements_org_idx on public.partner_agreements (org_id, created_at desc);

-- ---------------------------------------------------------------- access
alter table public.partner_followup_settings enable row level security;
alter table public.partner_rebook            enable row level security;
alter table public.partner_reviews           enable row level security;
alter table public.partner_agreements        enable row level security;
revoke all on public.partner_followup_settings, public.partner_rebook, public.partner_reviews, public.partner_agreements from anon, authenticated;
grant select on public.partner_followup_settings, public.partner_rebook, public.partner_reviews, public.partner_agreements to authenticated;
grant update on public.partner_followup_settings to authenticated;

create policy partner_followup_settings_read on public.partner_followup_settings for select to authenticated
  using ((select public.can_any('{partners,agreements}', 'view')));
create policy partner_followup_settings_write on public.partner_followup_settings for update to authenticated
  using ((select public.can_any('{partners,agreements}', 'edit'))) with check ((select public.can_any('{partners,agreements}', 'edit')));
create policy partner_rebook_read on public.partner_rebook for select to authenticated using ((select public.can('partners', 'view')));
create policy partner_reviews_read on public.partner_reviews for select to authenticated using ((select public.can('partners', 'view')));
create policy partner_agreements_read on public.partner_agreements for select to authenticated using ((select public.can('agreements', 'view')));
-- Everything else changes through the RPCs below.

-- W-9s and insurance certificates: private bucket, read with signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('agreements', 'agreements', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'])
on conflict (id) do nothing;
create policy agreements_files_read on storage.objects for select to authenticated
  using (bucket_id = 'agreements' and (select public.can('agreements', 'view')));
create policy agreements_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'agreements' and (select public.can('agreements', 'edit')));
create policy agreements_files_update on storage.objects for update to authenticated
  using (bucket_id = 'agreements' and (select public.can('agreements', 'edit')))
  with check (bucket_id = 'agreements' and (select public.can('agreements', 'edit')));
create policy agreements_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'agreements' and (select public.can('agreements', 'edit')));

insert into public.push_topics (key, label, description, module, sort)
values ('agreement_accepted', 'Agreement accepted', 'A league or school accepted their agreement online.', 'agreements', 65)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- helpers (internal)
-- The day an organization's last job was: GotPhoto history or a past booking, whichever is later.
create function public.partner_last_job(p_org uuid) returns date
language sql stable security definer set search_path = '' as $$
  select nullif(greatest(coalesce(o.last_job_at, '-infinity'::date),
                         coalesce((select max(b.picture_day) from public.bookings b
                                    where b.org_id = o.id and b.status in ('booked', 'tracked', 'done')
                                      and b.picture_day < (now() at time zone 'America/New_York')::date), '-infinity'::date)), '-infinity'::date)
    from public.prospect_orgs o where o.id = p_org
$$;

-- That date moved forward whole years to the next one that is not more than 60 days gone.
create function public.partner_rebook_due(p_last date) returns date
language sql stable set search_path = '' as $$
  select case when p_last is null then null else
    (p_last + make_interval(years => greatest(1, extract(year from age((now() at time zone 'America/New_York')::date - 60, p_last))::int + 1)))::date end
$$;

create function public.partner_season_of(p_day date) returns text
language sql immutable set search_path = '' as $$
  select case when p_day is null then '' when extract(month from p_day) in (12, 1, 2) then 'winter' when extract(month from p_day) in (3, 4, 5) then 'spring'
              when extract(month from p_day) in (6, 7, 8) then 'summer' else 'fall' end
$$;

-- Placeholders every template can use.
create function public.partner_vars(p_org uuid, p_contact uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'hi', case when trim(coalesce(c.first_name, '')) <> '' then 'Hi ' || trim(c.first_name) else '' end,
    'first_name', trim(coalesce(c.first_name, '')),
    'league', case when o.name_known is false then '' else coalesce(o.name, '') end,
    'sport', lower(coalesce(nullif(o.sport, ''), o.sports[1], '')),
    'town', coalesce(o.town, ''),
    'sender_first_name', coalesce((select s.sender_first_name from public.prospect_settings s limit 1), ''))
  from public.prospect_orgs o left join public.prospect_contacts c on c.id = p_contact and c.org_id = o.id
  where o.id = p_org
$$;

create function public.partner_fmt_day(p_day date) returns text
language sql immutable set search_path = '' as $$
  select case when p_day is null then '' else to_char(p_day, 'FMMonth FMDD, YYYY') end
$$;

-- An agreement's wording with its placeholders filled in.
create function public.partner_agreement_text(a public.partner_agreements) returns text
language sql stable security definer set search_path = '' as $$
  select public.prospect_tidy(public.prospect_render(coalesce(nullif(a.terms, ''), (select s.agreement_terms from public.partner_followup_settings s)),
    public.partner_vars(a.org_id, null) || jsonb_build_object(
      'league', (select o.name from public.prospect_orgs o where o.id = a.org_id),
      'title', a.title, 'picture_day', public.partner_fmt_day(a.picture_day), 'job', a.job,
      'pricing', a.pricing, 'payout', a.payout, 'renewal_date', public.partner_fmt_day(a.renewal_date))))
$$;

-- Contacts an email can go to, booking contacts and the main contact first.
create function public.partner_contacts(p_org uuid, p_first uuid[] default '{}') returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'email', c.email, 'role', coalesce(c.role, ''), 'primary', c.is_primary,
           'name', coalesce(nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.email))
         order by (c.id = any (coalesce(p_first, '{}'))) desc, c.is_primary desc, c.history_only, c.created_at), '[]'::jsonb)
    from public.prospect_contacts c
   where c.org_id = p_org and c.bounced_at is null and c.unsubscribed_at is null and coalesce(c.email, '') <> ''
$$;

-- Put one email in the outreach pipeline: held for review, or scheduled at the next send slot (p_approve).
create function public.partner_email_put(p_org uuid, p_contact uuid, p_subject text, p_body text, p_approve boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.prospect_contacts; o public.prospect_orgs; v_id uuid;
begin
  select * into o from public.prospect_orgs where id = p_org;
  if o.id is null then raise exception 'Organization not found.'; end if;
  if o.stage = 'do_not_contact' or o.status = 'do_not_contact' then raise exception '% is marked do not contact.', o.name; end if;
  select * into c from public.prospect_contacts where id = p_contact and org_id = p_org;
  if c.id is null then raise exception 'Pick who it goes to.'; end if;
  if c.bounced_at is not null or c.unsubscribed_at is not null then raise exception '% bounced or unsubscribed.', c.email; end if;
  if trim(coalesce(p_subject, '')) = '' or trim(coalesce(p_body, '')) = '' then raise exception 'Add a subject and a message.'; end if;
  if strpos(p_subject || p_body, '{{') > 0 then raise exception 'Fill in or remove the {{...}} placeholder first.'; end if;
  insert into public.prospect_scheduled_emails (org_id, contact_id, subject, body, send_at, date_manual, status, needs_review, edited, created_by)
  values (o.id, c.id, trim(p_subject), public.prospect_tidy(p_body),
          case when p_approve then public.prospect_next_send_at(now(), 0) else now() end, false,
          case when p_approve then 'scheduled' else 'held' end, not p_approve, true, auth.uid())
  returning id into v_id;
  if p_approve then update public.prospect_contacts set history_only = false, stopped_at = null where id = c.id; end if;
  perform public.prospect_org_refresh(o.id);
  return v_id;
end $$;

-- Is this email still waiting to go (held for review, scheduled or sending)?
create function public.partner_email_waiting(p_email uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.prospect_scheduled_emails e where e.id = p_email and e.status in ('held', 'scheduled', 'sending'))
$$;

create function public.partner_email_state(p_email uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'status', case when e.status = 'held' and e.needs_review then 'review' else e.status end,
                            'at', coalesce(e.sent_at, e.send_at), 'to', c.email, 'subject', e.subject)
    from public.prospect_scheduled_emails e left join public.prospect_contacts c on c.id = e.contact_id where e.id = p_email
$$;

-- ---------------------------------------------------------------- rebooking: the list
create function public.partner_rebook_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date; v_lead int;
begin
  if not public.can('partners', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select rebook_lead_days into v_lead from public.partner_followup_settings;
  return coalesce((
    with base as (
      select o.id, o.name, o.stage, o.town, o.audience, o.job_count, o.services, o.sports, o.next_job_at, public.partner_last_job(o.id) as last_date
        from public.prospect_orgs o
       where o.stage is distinct from 'do_not_contact' and o.status is distinct from 'do_not_contact'
         and (o.last_job_at is not null or exists (select 1 from public.bookings b where b.org_id = o.id and b.status in ('booked', 'tracked', 'done')))
    ), d as (
      select b.*, public.partner_rebook_due(b.last_date) as due_on from base b where b.last_date is not null
    )
    select jsonb_agg(jsonb_build_object(
             'org_id', d.id, 'name', d.name, 'stage', d.stage, 'town', coalesce(d.town, ''), 'audience', d.audience,
             'last_date', d.last_date, 'due_on', d.due_on, 'days', d.due_on - v_today, 'open', d.due_on - v_lead <= v_today,
             'job_count', coalesce(d.job_count, 0),
             'last_job', coalesce((select coalesce(nullif(bk.title_override, ''), t.label) from public.bookings bk left join public.booking_types t on t.key = bk.type_key
                                    where bk.org_id = d.id and bk.status in ('booked', 'tracked', 'done') and bk.picture_day = d.last_date limit 1), ''),
             'status', coalesce(r.status, 'todo'), 'later_until', r.later_until, 'note', coalesce(r.note, ''),
             'email', public.partner_email_state(r.email_id),
             'waiting', exists (select 1 from public.prospect_scheduled_emails e where e.org_id = d.id and e.status in ('held', 'scheduled', 'sending')),
             'contact', (select x from jsonb_array_elements(public.partner_contacts(d.id)) x limit 1),
             'agreement', (select jsonb_build_object('id', a.id, 'status', a.status, 'renewal_date', a.renewal_date) from public.partner_agreements a
                            where a.org_id = d.id and a.status <> 'void' order by a.created_at desc limit 1))
           order by d.due_on, d.name)
      from d
      left join public.partner_rebook r on r.org_id = d.id and r.due_on = d.due_on
     where d.due_on <= v_today + v_lead + 60
       -- already on the calendar for this year: a booking or a GotPhoto job after the last one
       and not exists (select 1 from public.bookings b where b.org_id = d.id and b.status in ('booked', 'tracked', 'done') and b.picture_day > d.last_date)
       and not (d.next_job_at is not null and d.next_job_at > d.last_date)
  ), '[]'::jsonb);
end $$;

-- Today: how many are due and nobody has done anything about yet.
create function public.partner_rebook_attention() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if not public.can('partners', 'view') then return jsonb_build_object('due', 0); end if;
  select jsonb_build_object('due', count(*)) into v from jsonb_array_elements(public.partner_rebook_list()) x
   where (x ->> 'open')::boolean and x ->> 'status' = 'todo' and not (x ->> 'waiting')::boolean;
  return v;
end $$;

create function public.partner_rebook_set(p_org uuid, p_due date, p_status text, p_until date default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('partners', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('todo', 'emailed', 'later', 'skipped') then raise exception 'Unknown status.'; end if;
  if p_status = 'later' and (p_until is null or p_until <= (now() at time zone 'America/New_York')::date) then raise exception 'Pick a later date.'; end if;
  insert into public.partner_rebook (org_id, due_on, status, later_until, note, updated_by)
  values (p_org, p_due, p_status, case when p_status = 'later' then p_until end, coalesce(p_note, ''), auth.uid())
  on conflict (org_id, due_on) do update set status = excluded.status, later_until = excluded.later_until,
    note = coalesce(p_note, partner_rebook.note), updated_at = now(), updated_by = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- reviews
create function public.partner_review_vars(p_review uuid, p_contact uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.partner_vars(r.org_id, p_contact) || jsonb_build_object(
           'review_link', (select s.review_link from public.partner_followup_settings s),
           'job', coalesce((select coalesce(nullif(b.title_override, ''), t.label) from public.bookings b left join public.booking_types t on t.key = b.type_key where b.id = r.booking_id), ''),
           'picture_day', coalesce((select public.partner_fmt_day(b.picture_day) from public.bookings b where b.id = r.booking_id), ''))
    from public.partner_reviews r where r.id = p_review
$$;

-- Draft the request for a review row (held for review). Returns the email id, or null with the reason in note.
create function public.partner_review_autodraft(p_review uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.partner_reviews; b public.bookings; s public.partner_followup_settings; v_contact uuid; v_prev timestamptz; v_vars jsonb; v_id uuid;
begin
  select * into r from public.partner_reviews where id = p_review;
  select * into b from public.bookings where id = r.booking_id;
  select * into s from public.partner_followup_settings;
  if b.status is distinct from 'booked' then return null; end if;
  if exists (select 1 from public.prospect_orgs o where o.id = r.org_id and (o.stage = 'do_not_contact' or o.status = 'do_not_contact')) then
    update public.partner_reviews set note = 'Do not contact, so no request was drafted.' where id = r.id; return null;
  end if;
  select max(e.created_at) into v_prev from public.partner_reviews x join public.prospect_scheduled_emails e on e.id = x.email_id
   where x.org_id = r.org_id and x.id <> r.id and e.status not in ('skipped', 'stopped', 'failed');
  if v_prev > now() - interval '150 days' then
    update public.partner_reviews set note = 'Asked on ' || public.partner_fmt_day((v_prev at time zone 'America/New_York')::date) || ', so no new request was drafted.' where id = r.id;
    return null;
  end if;
  select (x ->> 'id')::uuid into v_contact from jsonb_array_elements(public.partner_contacts(r.org_id, b.contact_ids)) x limit 1;
  if v_contact is null then update public.partner_reviews set note = 'Nobody to email.' where id = r.id; return null; end if;
  v_vars := public.partner_review_vars(r.id, v_contact);
  v_id := public.partner_email_put(r.org_id, v_contact,
            public.prospect_tidy(public.prospect_render(s.review_subject, v_vars)), public.prospect_render(s.review_body, v_vars), false);
  update public.partner_reviews set email_id = v_id where id = r.id;
  return v_id;
end $$;

-- A job reached "Deliverables sent": make its review row, and draft the request for a booked job.
-- Never blocks the stage change.
create function public.partner_review_on_stage() returns trigger
language plpgsql security definer set search_path = '' as $$
declare st public.booking_stages; b public.bookings; v_id uuid;
begin
  begin
    select * into st from public.booking_stages where id = new.stage_id;
    if st.id is null or not (st.auto is not distinct from 'deliverables_done' or lower(btrim(st.label)) = 'deliverables sent') then return new; end if;
    select * into b from public.bookings where id = new.booking_id;
    if b.org_id is null or b.status not in ('booked', 'tracked', 'done') then return new; end if;
    insert into public.partner_reviews (booking_id, org_id) values (b.id, b.org_id) on conflict (booking_id) do nothing returning id into v_id;
    if v_id is not null and b.status = 'booked' and (select review_auto from public.partner_followup_settings) then
      perform public.partner_review_autodraft(v_id);
    end if;
  exception when others then
    raise warning 'partner_review_on_stage: %', sqlerrm;
  end;
  return new;
end $$;
create trigger partner_review_on_stage after insert or update of stage_id on public.booking_progress
  for each row execute function public.partner_review_on_stage();

-- A cancelled booking takes its unsent review request with it.
create function public.partner_review_on_cancel() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.prospect_scheduled_emails e set status = 'skipped', needs_review = false
    from public.partner_reviews r where r.booking_id = new.id and e.id = r.email_id and e.status in ('held', 'scheduled');
  update public.partner_reviews set outcome = 'skipped', note = 'Booking cancelled.', outcome_at = now() where booking_id = new.id and outcome = 'open';
  return new;
end $$;
create trigger partner_review_on_cancel after update of status on public.bookings
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled') execute function public.partner_review_on_cancel();

create function public.partner_reviews_list(p_days integer default 400) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('partners', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'org_id', r.org_id, 'org', o.name, 'booking_id', r.booking_id, 'booking_status', b.status,
             'job', coalesce(nullif(b.title_override, ''), t.label, ''), 'picture_day', b.picture_day, 'reached_at', r.reached_at,
             'outcome', r.outcome, 'quote', r.quote, 'quote_by', r.quote_by, 'saved_quote', r.snippet_id is not null, 'note', r.note,
             'outcome_at', r.outcome_at, 'email', public.partner_email_state(r.email_id))
           order by (r.outcome = 'open') desc, r.reached_at desc)
      from public.partner_reviews r
      join public.prospect_orgs o on o.id = r.org_id
      left join public.bookings b on b.id = r.booking_id
      left join public.booking_types t on t.key = b.type_key
     where r.reached_at > now() - make_interval(days => p_days)), '[]'::jsonb);
end $$;

-- What came back. p_save_quote also adds the quote to the Email library (prospect_snippets).
create function public.partner_review_log(p_id uuid, p_outcome text, p_quote text default '', p_quote_by text default '', p_note text default null, p_save_quote boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.partner_reviews; o public.prospect_orgs; v_snip uuid;
begin
  if not public.can('partners', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_outcome not in ('open', 'reviewed', 'quote', 'declined', 'no_reply', 'skipped') then raise exception 'Unknown outcome.'; end if;
  select * into r from public.partner_reviews where id = p_id;
  if r.id is null then raise exception 'Not found.'; end if;
  select * into o from public.prospect_orgs where id = r.org_id;
  if p_outcome = 'quote' and trim(coalesce(p_quote, '')) = '' then raise exception 'Paste the quote.'; end if;
  v_snip := r.snippet_id;
  if p_save_quote and v_snip is null and trim(coalesce(p_quote, '')) <> '' then
    insert into public.prospect_snippets (kind, title, body, attribution, audience, sports, seasons, is_active)
    values ('quote', o.name, trim(p_quote), coalesce(nullif(trim(p_quote_by), ''), o.name),
            case when o.audience in ('league', 'school') then o.audience end, coalesce(o.sports, '{}'), coalesce(o.seasons, '{}'), true)
    returning id into v_snip;
  end if;
  update public.partner_reviews set outcome = p_outcome, quote = trim(coalesce(p_quote, '')), quote_by = trim(coalesce(p_quote_by, '')),
         note = coalesce(p_note, note), snippet_id = v_snip,
         outcome_at = case when p_outcome = 'open' then null else now() end, outcome_by = auth.uid()
   where id = p_id;
  if p_outcome in ('reviewed', 'quote') and r.outcome is distinct from p_outcome then
    insert into public.prospect_activities (org_id, kind, body, meta, occurred_at, created_by)
    values (r.org_id, 'note', case when p_outcome = 'reviewed' then 'Left us a review.' else 'Gave us a quote: "' || left(trim(p_quote), 400) || '"' end,
            jsonb_build_object('source', 'reviews'), now(), auth.uid());
  end if;
  return jsonb_build_object('ok', true, 'snippet_id', v_snip);
end $$;

-- ---------------------------------------------------------------- agreements
create function public.agreements_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('agreements', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(a) - 'terms' - 'accepted_text' || jsonb_build_object('org', o.name, 'email', public.partner_email_state(a.email_id),
             'booking_label', (select coalesce(nullif(b.title_override, ''), t.label, '') || ' ' || coalesce(to_char(b.picture_day, 'Mon FMDD'), '')
                                 from public.bookings b left join public.booking_types t on t.key = b.type_key where b.id = a.booking_id))
           order by case a.status when 'draft' then 0 when 'sent' then 1 when 'accepted' then 2 else 3 end, a.updated_at desc)
      from public.partner_agreements a join public.prospect_orgs o on o.id = a.org_id), '[]'::jsonb);
end $$;

create function public.agreement_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.partner_agreements;
begin
  if not public.can('agreements', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into a from public.partner_agreements where id = p_id;
  if a.id is null then raise exception 'Not found.'; end if;
  return to_jsonb(a) || jsonb_build_object('org', (select name from public.prospect_orgs where id = a.org_id),
    'rendered', coalesce(a.accepted_text, public.partner_agreement_text(a)), 'email', public.partner_email_state(a.email_id),
    'bookings', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'picture_day', b.picture_day, 'label', coalesce(nullif(b.title_override, ''), t.label, ''), 'status', b.status)
                   order by b.picture_day desc nulls last), '[]'::jsonb)
                   from public.bookings b left join public.booking_types t on t.key = b.type_key where b.org_id = a.org_id and b.status <> 'cancelled'));
end $$;

-- Organizations to pick from when starting an agreement (people with agreements but not partners can't read prospect_orgs).
create function public.agreement_orgs(p_q text default '') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'town', coalesce(o.town, ''), 'stage', o.stage) order by o.stage in ('client', 'booked', 'talking') desc, o.name)
    from (select * from public.prospect_orgs o where o.stage is distinct from 'do_not_contact'
            and (coalesce(p_q, '') = '' or o.name ilike '%' || p_q || '%' or o.town ilike '%' || p_q || '%')
          order by o.stage in ('client', 'booked', 'talking') desc, o.name limit 40) o), '[]'::jsonb);
end $$;

-- Create (p_id null) or change an agreement. Once accepted, only the paperwork, renewal date and note can change.
create function public.agreement_save(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.partner_agreements; v_id uuid := p_id; v_booking public.bookings;
begin
  if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_id is null then
    if not exists (select 1 from public.prospect_orgs where id = (p ->> 'org_id')::uuid) then raise exception 'Pick an organization.'; end if;
    select * into v_booking from public.bookings where id = nullif(p ->> 'booking_id', '')::uuid and org_id = (p ->> 'org_id')::uuid;
    insert into public.partner_agreements (org_id, booking_id, picture_day, job, terms, renewal_date, created_by)
    values ((p ->> 'org_id')::uuid, v_booking.id, v_booking.picture_day,
            coalesce((select t.label from public.booking_types t where t.key = v_booking.type_key), ''),
            (select s.agreement_terms from public.partner_followup_settings s),
            coalesce(v_booking.picture_day + 365, ((now() at time zone 'America/New_York')::date + 365)), auth.uid())
    returning id into v_id;
  end if;
  select * into a from public.partner_agreements where id = v_id for update;
  if a.id is null then raise exception 'Not found.'; end if;
  if a.status in ('draft', 'sent') then
    update public.partner_agreements set
      title       = coalesce(nullif(trim(p ->> 'title'), ''), title),
      booking_id  = case when p ? 'booking_id' then (select b.id from public.bookings b where b.id = nullif(p ->> 'booking_id', '')::uuid and b.org_id = a.org_id) else booking_id end,
      picture_day = case when p ? 'picture_day' then nullif(p ->> 'picture_day', '')::date else picture_day end,
      job         = coalesce(p ->> 'job', job),
      pricing     = coalesce(p ->> 'pricing', pricing),
      payout      = coalesce(p ->> 'payout', payout),
      terms       = coalesce(p ->> 'terms', terms)
    where id = v_id;
  end if;
  update public.partner_agreements set
    renewal_date = case when p ? 'renewal_date' then nullif(p ->> 'renewal_date', '')::date else renewal_date end,
    w9_status    = coalesce(p ->> 'w9_status', w9_status),
    w9_at        = case when p ? 'w9_at' then nullif(p ->> 'w9_at', '')::date else w9_at end,
    w9_path      = case when p ? 'w9_path' then nullif(p ->> 'w9_path', '') else w9_path end,
    coi_status   = coalesce(p ->> 'coi_status', coi_status),
    coi_at       = case when p ? 'coi_at' then nullif(p ->> 'coi_at', '')::date else coi_at end,
    coi_expires  = case when p ? 'coi_expires' then nullif(p ->> 'coi_expires', '')::date else coi_expires end,
    coi_path     = case when p ? 'coi_path' then nullif(p ->> 'coi_path', '') else coi_path end,
    note         = coalesce(p ->> 'note', note),
    updated_at   = now()
  where id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- 'sent' (link shared by hand), 'draft' (back to editing, link stops working), 'void'.
create function public.agreement_set_status(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.partner_agreements;
begin
  if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into a from public.partner_agreements where id = p_id for update;
  if a.id is null then raise exception 'Not found.'; end if;
  if p_status not in ('draft', 'sent', 'void') then raise exception 'Unknown status.'; end if;
  if a.status = 'accepted' and p_status <> 'void' then raise exception 'This agreement was already accepted.'; end if;
  update public.partner_agreements set status = p_status, sent_at = case when p_status = 'sent' then coalesce(sent_at, now()) else sent_at end, updated_at = now() where id = p_id;
  if p_status = 'void' and a.email_id is not null then
    update public.prospect_scheduled_emails set status = 'skipped', needs_review = false where id = a.email_id and status in ('held', 'scheduled');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Today: renewals within 30 days (with nothing newer started) and insurance certificates expiring within 30 days.
create function public.agreements_attention() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.can('agreements', 'view') then return jsonb_build_object('renew', 0, 'coi', 0); end if;
  return jsonb_build_object(
    'renew', (select count(*) from public.partner_agreements a where a.status = 'accepted' and a.renewal_date <= v_today + 30
               and not exists (select 1 from public.partner_agreements n where n.org_id = a.org_id and n.id <> a.id and n.status <> 'void' and n.created_at > a.created_at)),
    'coi', (select count(*) from public.partner_agreements a where a.status <> 'void' and a.coi_status = 'on_file' and a.coi_expires <= v_today + 30
             and not exists (select 1 from public.partner_agreements n where n.org_id = a.org_id and n.id <> a.id and n.status <> 'void' and n.created_at > a.created_at)));
end $$;

-- ---------------------------------------------------------------- the public page (no sign-in)
-- Anyone with the link can read the agreement while it is sent or accepted, and accept it once.
create function public.agreement_public(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.partner_agreements;
begin
  if coalesce(length(p_token), 0) < 20 then return jsonb_build_object('found', false); end if;
  select * into a from public.partner_agreements where token = p_token and status in ('sent', 'accepted');
  if a.id is null then return jsonb_build_object('found', false); end if;
  if a.viewed_at is null then update public.partner_agreements set viewed_at = now() where id = a.id; end if;
  return jsonb_build_object('found', true, 'title', a.title, 'org', (select name from public.prospect_orgs where id = a.org_id),
    'picture_day', a.picture_day, 'renewal_date', a.renewal_date, 'status', a.status,
    'text', coalesce(a.accepted_text, public.partner_agreement_text(a)),
    'accepted_name', a.accepted_name, 'accepted_title', a.accepted_title, 'accepted_at', a.accepted_at);
end $$;

create function public.agreement_accept(p_token text, p_name text, p_title text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.partner_agreements; v_hdr jsonb; v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')); v_org text;
begin
  if coalesce(length(p_token), 0) < 20 then return jsonb_build_object('ok', false, 'error', 'This link is not valid.'); end if;
  select * into a from public.partner_agreements where token = p_token for update;
  if a.id is null or a.status not in ('sent', 'accepted') then return jsonb_build_object('ok', false, 'error', 'This agreement is no longer open. Please reply to our email for a new link.'); end if;
  if a.status = 'accepted' then return jsonb_build_object('ok', true, 'already', true, 'accepted_name', a.accepted_name, 'accepted_at', a.accepted_at); end if;
  if length(v_name) < 3 or length(v_name) > 120 or v_name !~ '[[:alpha:]]' then return jsonb_build_object('ok', false, 'error', 'Type your full name to accept.'); end if;
  begin v_hdr := current_setting('request.headers', true)::jsonb; exception when others then v_hdr := null; end;
  update public.partner_agreements set status = 'accepted', accepted_name = v_name, accepted_title = left(btrim(coalesce(p_title, '')), 120),
         accepted_at = now(), accepted_text = public.partner_agreement_text(a),
         accepted_ip = left(split_part(coalesce(v_hdr ->> 'x-forwarded-for', v_hdr ->> 'cf-connecting-ip', ''), ',', 1), 64),
         accepted_ua = left(coalesce(v_hdr ->> 'user-agent', ''), 300), updated_at = now()
   where id = a.id;
  select name into v_org from public.prospect_orgs where id = a.org_id;
  insert into public.prospect_activities (org_id, kind, body, meta, occurred_at)
  values (a.org_id, 'note', v_name || ' accepted the ' || a.title || ' online.', jsonb_build_object('source', 'agreements', 'agreement_id', a.id), now());
  begin
    perform public.push_notify('agreement_accepted', 'Agreement accepted', coalesce(v_org, '') || ': ' || v_name, '/#partners/agreements', 'agreement_' || a.id);
  exception when others then null;
  end;
  return jsonb_build_object('ok', true, 'accepted_name', v_name, 'accepted_at', now());
end $$;

-- ---------------------------------------------------------------- composing the emails
-- p_kind: 'rebook' (p_ref = org id), 'review' (p_ref = partner_reviews id), 'agreement' (p_ref = agreement id).
-- Returns who it can go to and the filled-in template; nothing is saved.
create function public.partner_compose(p_kind text, p_ref uuid, p_contact uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.partner_followup_settings; v_org uuid; v_first uuid[] := '{}'; v_contacts jsonb; v_contact uuid; v_vars jsonb; v_subj text; v_body text;
        v_last date; v_due date; r public.partner_reviews; a public.partner_agreements; v_warn text := '';
begin
  if p_kind = 'agreement' then
    if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  elsif not public.can('partners', 'edit') then raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into s from public.partner_followup_settings;
  if p_kind = 'rebook' then
    v_org := p_ref;
  elsif p_kind = 'review' then
    select * into r from public.partner_reviews where id = p_ref;
    v_org := r.org_id;
    select coalesce(b.contact_ids, '{}') into v_first from public.bookings b where b.id = r.booking_id;
    if (select b.status from public.bookings b where b.id = r.booking_id) = 'cancelled' then raise exception 'That booking was cancelled.'; end if;
  elsif p_kind = 'agreement' then
    select * into a from public.partner_agreements where id = p_ref;
    v_org := a.org_id;
    select coalesce(b.contact_ids, '{}') into v_first from public.bookings b where b.id = a.booking_id;
    if a.status not in ('draft', 'sent') then raise exception 'Only a draft or sent agreement can be emailed.'; end if;
  else raise exception 'Unknown kind.';
  end if;
  if v_org is null then raise exception 'Not found.'; end if;
  v_contacts := public.partner_contacts(v_org, coalesce(v_first, '{}'));
  v_contact := coalesce(p_contact, (v_contacts -> 0 ->> 'id')::uuid);
  v_vars := public.partner_vars(v_org, v_contact);
  if p_kind = 'rebook' then
    v_last := public.partner_last_job(v_org); v_due := public.partner_rebook_due(v_last);
    v_vars := v_vars || jsonb_build_object('last_date', public.partner_fmt_day(v_last), 'last_season', public.partner_season_of(v_last),
                                           'year', coalesce(extract(year from v_due)::text, ''));
    v_subj := s.rebook_subject; v_body := s.rebook_body;
  elsif p_kind = 'review' then
    v_vars := v_vars || public.partner_review_vars(r.id, v_contact);
    v_subj := s.review_subject; v_body := s.review_body;
    if s.review_link = '' then v_warn := 'Add your Google review link under Templates so it fills in.'; end if;
  else
    v_vars := v_vars || jsonb_build_object('title', a.title, 'picture_day', public.partner_fmt_day(a.picture_day), 'job', a.job,
              'payout_word', case when a.payout <> '' then 'payout' else '' end,
              'agreement_link', 'https://admin.207photo.com/#agree/' || a.token);
    v_subj := s.agreement_subject; v_body := s.agreement_body;
  end if;
  if exists (select 1 from public.prospect_scheduled_emails e where e.org_id = v_org and e.status in ('held', 'scheduled', 'sending')) then
    v_warn := trim(v_warn || ' This organization already has an email waiting to go.');
  end if;
  return jsonb_build_object('org_id', v_org, 'org', (select name from public.prospect_orgs where id = v_org), 'contacts', v_contacts, 'contact_id', v_contact,
    'subject', public.prospect_tidy(public.prospect_render(v_subj, v_vars)), 'body', public.prospect_tidy(public.prospect_render(v_body, v_vars)), 'warning', v_warn);
end $$;

-- Save the (edited) email: held in Outreach to review, or approved and scheduled (p_approve).
create function public.partner_queue(p_kind text, p_ref uuid, p_contact uuid, p_subject text, p_body text, p_approve boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid; r public.partner_reviews; a public.partner_agreements; v_due date;
begin
  if p_kind = 'agreement' then
    if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  elsif not public.can('partners', 'edit') then raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_kind = 'rebook' then
    v_org := p_ref; v_due := public.partner_rebook_due(public.partner_last_job(v_org));
    if v_due is null then raise exception 'This organization has no past job.'; end if;
    if exists (select 1 from public.partner_rebook x where x.org_id = v_org and x.due_on = v_due and public.partner_email_waiting(x.email_id)) then
      raise exception 'A rebook email is already waiting. Change it in Outreach to review.';
    end if;
  elsif p_kind = 'review' then
    select * into r from public.partner_reviews where id = p_ref for update;
    v_org := r.org_id;
    if v_org is null then raise exception 'Not found.'; end if;
    if (select b.status from public.bookings b where b.id = r.booking_id) = 'cancelled' then raise exception 'That booking was cancelled.'; end if;
    if public.partner_email_waiting(r.email_id) then raise exception 'A request is already waiting. Change it in Outreach to review.'; end if;
  elsif p_kind = 'agreement' then
    select * into a from public.partner_agreements where id = p_ref for update;
    v_org := a.org_id;
    if v_org is null then raise exception 'Not found.'; end if;
    if a.status not in ('draft', 'sent') then raise exception 'Only a draft or sent agreement can be emailed.'; end if;
    if strpos(p_body, a.token) = 0 then raise exception 'Keep the agreement link in the message.'; end if;
    if public.partner_email_waiting(a.email_id) then raise exception 'An email with this agreement is already waiting. Change it in Outreach to review.'; end if;
  else raise exception 'Unknown kind.';
  end if;
  v_id := public.partner_email_put(v_org, p_contact, p_subject, p_body, coalesce(p_approve, false));
  if p_kind = 'rebook' then
    insert into public.partner_rebook (org_id, due_on, status, email_id, updated_by) values (v_org, v_due, 'emailed', v_id, auth.uid())
    on conflict (org_id, due_on) do update set status = 'emailed', later_until = null, email_id = v_id, updated_at = now(), updated_by = auth.uid();
    if p_approve then perform public.prospect_stage_auto(v_org, 'contacting', 'Rebook email approved'); end if;
  elsif p_kind = 'review' then
    update public.partner_reviews set email_id = v_id, note = '' where id = r.id;
  else
    update public.partner_agreements set email_id = v_id, status = 'sent', sent_at = coalesce(sent_at, now()), updated_at = now() where id = a.id;
  end if;
  return jsonb_build_object('ok', true, 'email_id', v_id, 'status', case when p_approve then 'scheduled' else 'review' end);
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function
  public.partner_last_job(uuid), public.partner_rebook_due(date), public.partner_season_of(date), public.partner_vars(uuid, uuid),
  public.partner_fmt_day(date), public.partner_agreement_text(public.partner_agreements), public.partner_contacts(uuid, uuid[]),
  public.partner_email_put(uuid, uuid, text, text, boolean), public.partner_email_waiting(uuid), public.partner_email_state(uuid),
  public.partner_review_vars(uuid, uuid), public.partner_review_autodraft(uuid), public.partner_review_on_stage(), public.partner_review_on_cancel(),
  public.partner_rebook_list(), public.partner_rebook_attention(), public.partner_rebook_set(uuid, date, text, date, text),
  public.partner_reviews_list(integer), public.partner_review_log(uuid, text, text, text, text, boolean),
  public.agreements_list(), public.agreement_get(uuid), public.agreement_orgs(text), public.agreement_save(uuid, jsonb),
  public.agreement_set_status(uuid, text), public.agreements_attention(), public.agreement_public(text), public.agreement_accept(text, text, text),
  public.partner_compose(text, uuid, uuid), public.partner_queue(text, uuid, uuid, text, text, boolean)
from public, anon, authenticated;
grant execute on function
  public.partner_rebook_list(), public.partner_rebook_attention(), public.partner_rebook_set(uuid, date, text, date, text),
  public.partner_reviews_list(integer), public.partner_review_log(uuid, text, text, text, text, boolean),
  public.agreements_list(), public.agreement_get(uuid), public.agreement_orgs(text), public.agreement_save(uuid, jsonb),
  public.agreement_set_status(uuid, text), public.agreements_attention(),
  public.partner_compose(text, uuid, uuid), public.partner_queue(text, uuid, uuid, text, text, boolean)
to authenticated;
-- The public page: by token only.
grant execute on function public.agreement_public(text), public.agreement_accept(text, text, text) to anon, authenticated;
