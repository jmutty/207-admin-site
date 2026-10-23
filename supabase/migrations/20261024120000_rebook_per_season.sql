-- Due to rebook, one row per season (2026-10-23).
--
-- The rebook list kept one date per partner: its most recent job. A school or rec department with winter sports
-- AND a fall picture day only came back for the fall one, so 29 of last winter's clients never showed up.
-- Now every group of last year's jobs (dates within 30 days of the group's first: picture day, second day, makeups)
-- is its own row, due on the group's picture day moved forward to this year. A booking, calendar date or GotPhoto job
-- within 45 days of that date takes the row off the list, so booking winter no longer hides spring.
--
-- Dates come from the calendar (prospect_orgs.cal_dates), bookings, last_job_at and GotPhoto jobs whose name
-- starts with one of the partner's GotPhoto names. GotPhoto shoot dates often run a day or more early, so a
-- group's picture day is its first calendar or booking date when it has one.
--
-- partner_compose / partner_queue take the row's due date (p_due) for kind 'rebook'; without it they use the
-- partner's next open row. partner_rebook already keys on (org_id, due_on), so nothing there changes.
-- Safe to run twice; nothing deleted.

-- Every rebook row for one partner: last year's job groups (or, with nothing in the last ~14 months, its latest
-- job), due date, and whether this year's is already on the calendar.
create or replace function public.partner_rebook_rows(p_org uuid)
returns table (picture_day date, last_day date, due_on date, jobs text, booked boolean)
language sql stable security definer set search_path = '' as $$
  with recursive o as (select * from public.prospect_orgs where id = p_org),
  t as (select (now() at time zone 'America/New_York')::date as d),
  pts as (
    select x as day, true as cal, null::text as job from o, unnest(coalesce(o.cal_dates, '{}'::date[])) x
    union all select o.last_job_at, true, null from o where o.last_job_at is not null
    union all select b.picture_day, true, coalesce(nullif(b.title_override, ''), bt.label)
      from public.bookings b left join public.booking_types bt on bt.key = b.type_key
     where b.org_id = p_org and b.status in ('booked', 'tracked', 'done') and b.picture_day is not null
    union all select (j.shoot_at at time zone 'America/New_York')::date, false, nullif(btrim(split_part(j.name, '|', 2)), '')
      from public.synced_jobs j, o
     where j.shoot_at is not null
       and lower(btrim(split_part(j.name, '|', 1))) in (select lower(btrim(g)) from unnest(coalesce(o.gotphoto_names, '{}')) g)
  ),
  past as (select p.* from pts p, t where p.day < t.d),
  recent as (select p.* from past p, t where p.day > t.d - 425),
  pick as (
    select * from recent
    union all select * from past where not exists (select 1 from recent) and day = (select max(day) from past)
  ),
  ord as (select p.*, row_number() over (order by p.day, p.cal desc) as rn from pick p),
  grp as (  -- a group runs at most 30 days from its first date
    select q.rn, q.day as start from ord q where q.rn = 1
    union all
    select q.rn, case when q.day - g.start > 30 then q.day else g.start end from grp g join ord q on q.rn = g.rn + 1
  ),
  r as (
    select coalesce(min(q.day) filter (where q.cal), min(q.day)) as picture_day, max(q.day) as last_day,
           string_agg(distinct q.job, ', ') filter (where q.job is not null) as jobs
      from ord q join grp g on g.rn = q.rn group by g.start
  ),
  ahead as (  -- what's already on the calendar for this year
    select x as day from o, unnest(coalesce(o.cal_dates, '{}'::date[])) x
    union all select o.next_job_at from o where o.next_job_at is not null
    union all select b.picture_day from public.bookings b where b.org_id = p_org and b.status in ('booked', 'tracked', 'done') and b.picture_day is not null
    union all select (j.shoot_at at time zone 'America/New_York')::date from public.synced_jobs j, o
     where j.shoot_at is not null
       and lower(btrim(split_part(j.name, '|', 1))) in (select lower(btrim(g)) from unnest(coalesce(o.gotphoto_names, '{}')) g)
  )
  select r.picture_day, r.last_day, d.due_on, coalesce(r.jobs, ''),
         exists (select 1 from ahead a where a.day > r.last_day and a.day between d.due_on - 45 and d.due_on + 45)
    from r cross join lateral (select public.partner_rebook_due(r.picture_day) as due_on) d
   order by d.due_on
$$;

-- ---------------------------------------------------------------- the list: one row per partner and season
create or replace function public.partner_rebook_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/New_York')::date; v_lead int;
begin
  if not public.can('partners', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select rebook_lead_days into v_lead from public.partner_followup_settings;
  return coalesce((
    with base as (
      select o.id, o.name, o.stage, o.town, o.audience, o.job_count
        from public.prospect_orgs o
       where o.stage is distinct from 'do_not_contact' and o.status is distinct from 'do_not_contact'
         and (o.last_job_at is not null or cardinality(coalesce(o.cal_dates, '{}'::date[])) > 0 or cardinality(coalesce(o.gotphoto_names, '{}')) > 0
              or exists (select 1 from public.bookings b where b.org_id = o.id and b.status in ('booked', 'tracked', 'done')))
    ), d as (
      select b.*, x.picture_day as last_date, x.due_on, x.jobs
        from base b cross join lateral public.partner_rebook_rows(b.id) x
       where not x.booked and x.due_on <= v_today + v_lead + 60
    )
    select jsonb_agg(jsonb_build_object(
             'org_id', d.id, 'name', d.name, 'stage', d.stage, 'town', coalesce(d.town, ''), 'audience', d.audience,
             'last_date', d.last_date, 'due_on', d.due_on, 'days', d.due_on - v_today, 'open', d.due_on - v_lead <= v_today,
             'job_count', coalesce(d.job_count, 0),
             'last_job', coalesce(nullif(d.jobs, ''), (select coalesce(nullif(bk.title_override, ''), t.label) from public.bookings bk left join public.booking_types t on t.key = bk.type_key
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
  ), '[]'::jsonb);
end $$;

-- The rebook row an email is for: the one due on p_due, or the partner's next open one.
create or replace function public.partner_rebook_pick(p_org uuid, p_due date) returns table (picture_day date, due_on date)
language sql stable security definer set search_path = '' as $$
  select x.picture_day, x.due_on from public.partner_rebook_rows(p_org) x
   where p_due is null or x.due_on = p_due
   order by (p_due is not null and x.due_on = p_due) desc, x.booked, x.due_on
   limit 1
$$;

-- ---------------------------------------------------------------- composing: rebook emails name their season
drop function if exists public.partner_compose(text, uuid, uuid);
create function public.partner_compose(p_kind text, p_ref uuid, p_contact uuid default null, p_due date default null) returns jsonb
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
    select x.picture_day, x.due_on into v_last, v_due from public.partner_rebook_pick(v_org, p_due) x;
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
    'due_on', v_due,
    'subject', public.prospect_tidy(public.prospect_render(v_subj, v_vars)), 'body', public.prospect_tidy(public.prospect_render(v_body, v_vars)), 'warning', v_warn);
end $$;

drop function if exists public.partner_queue(text, uuid, uuid, text, text, boolean);
create function public.partner_queue(p_kind text, p_ref uuid, p_contact uuid, p_subject text, p_body text, p_approve boolean default false, p_due date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid; r public.partner_reviews; a public.partner_agreements; v_due date;
begin
  if p_kind = 'agreement' then
    if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  elsif not public.can('partners', 'edit') then raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_kind = 'rebook' then
    v_org := p_ref;
    select x.due_on into v_due from public.partner_rebook_pick(v_org, p_due) x;
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
revoke all on function public.partner_rebook_rows(uuid), public.partner_rebook_pick(uuid, date), public.partner_rebook_list(),
  public.partner_compose(text, uuid, uuid, date), public.partner_queue(text, uuid, uuid, text, text, boolean, date)
from public, anon, authenticated;
grant execute on function public.partner_rebook_list(),
  public.partner_compose(text, uuid, uuid, date), public.partner_queue(text, uuid, uuid, text, text, boolean, date)
to authenticated;

notify pgrst, 'reload schema';
