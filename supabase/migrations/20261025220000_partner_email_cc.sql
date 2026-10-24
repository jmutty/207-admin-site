-- Rebook (and review / agreement) emails go to more than one person (2026-10-24, Jeremiah: "I'm not able to select
-- multiple? This really should show what I already have selected in that partner's page as main and copy").
--
-- The Draft email box had one To. Now it lists the partner's people with To / CC / left out for each, filled in from
-- the contact lines: for a rebook, the service of last year's job (Team & individual or School photos); its Main goes
-- in To, its Copy in people in CC (plus the Action people for a sports job at an Action client), Not involved and
-- stopped people are left out. Review and agreement emails start from the booking's people: the first in To, the rest
-- in CC. Anyone can still be moved by hand.
--
-- 1. prospect_scheduled_emails.cc_contact_ids: the people copied on that one email. prospect-sender puts them on Cc.
-- 2. partner_contacts also returns each person's service_roles and whether their emails are stopped.
-- 3. partner_rebook_service(org, due): which service a rebook row is for.
-- 4. partner_compose returns to_id, cc_ids, service and service_name (everything else as before).
-- 5. partner_queue_cc(...): partner_queue plus the CC list.
-- Safe to run twice; nothing removed.

alter table public.prospect_scheduled_emails add column if not exists cc_contact_ids uuid[] not null default '{}';

create or replace function public.partner_contacts(p_org uuid, p_first uuid[] default '{}') returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'email', c.email, 'role', coalesce(c.role, ''), 'primary', c.is_primary,
           'name', coalesce(nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.email),
           'roles', coalesce(c.service_roles, '{}'::jsonb), 'stopped', c.stopped_at is not null)
         order by (c.id = any (coalesce(p_first, '{}'))) desc, c.is_primary desc, c.history_only, c.created_at), '[]'::jsonb)
    from public.prospect_contacts c
   where c.org_id = p_org and c.bounced_at is null and c.unsubscribed_at is null and coalesce(c.email, '') <> ''
$$;

-- The service a rebook row is for: last year's booking nearest the row's picture day, else the partner's first service.
create or replace function public.partner_rebook_service(p_org uuid, p_due date default null) returns text
language sql stable security definer set search_path = '' as $$
  with pk as (select x.picture_day from public.partner_rebook_pick(p_org, p_due) x limit 1)
  select coalesce((select public.prospect_service_of_type(b.type_key) from public.bookings b, pk
                    where b.org_id = p_org and b.status in ('booked', 'tracked', 'done') and pk.picture_day is not null
                      and abs(b.picture_day - pk.picture_day) <= 30
                    order by abs(b.picture_day - pk.picture_day) limit 1),
                  (public.prospect_org_services(p_org))[1])
$$;

create or replace function public.partner_compose(p_kind text, p_ref uuid, p_contact uuid default null, p_due date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.partner_followup_settings; v_org uuid; v_first uuid[] := '{}'; v_contacts jsonb; v_contact uuid; v_vars jsonb; v_subj text; v_body text;
        v_last date; v_due date; r public.partner_reviews; a public.partner_agreements; v_warn text := '';
        v_svc text; v_line uuid[] := '{}'; v_cc uuid[] := '{}';
begin
  if p_kind = 'agreement' then
    if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  elsif not public.can('partners', 'edit') then raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into s from public.partner_followup_settings;
  if p_kind = 'rebook' then
    v_org := p_ref; v_first := public.partner_rebook_first(p_ref, p_due);
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

  -- who it goes to: the service's people (rebook) or the booking's people (review, agreement), in order, emailable
  -- and not stopped; Main before Copy in. Nobody set up for the service: the first person, as before.
  if p_kind = 'rebook' then
    v_svc := public.partner_rebook_service(v_org, p_due);
    select coalesce(array_agg((x ->> 'id')::uuid order by x -> 'roles' ->> v_svc desc, n), '{}') into v_line   -- 'main' before 'copy'
      from jsonb_array_elements(v_contacts) with ordinality t(x, n)
     where x -> 'roles' ->> v_svc in ('main', 'copy') and not (x ->> 'stopped')::boolean;
    -- a sports job at a partner we shoot action for copies the Action people in too (as Book a job does)
    if v_svc = 'portraits' and (select o.service_status ->> 'action' from public.prospect_orgs o where o.id = v_org) = 'client' then
      v_line := v_line || coalesce((select array_agg((x ->> 'id')::uuid order by n) from jsonb_array_elements(v_contacts) with ordinality t(x, n)
                                     where x -> 'roles' ->> 'action' in ('main', 'copy') and not (x ->> 'stopped')::boolean
                                       and not ((x ->> 'id')::uuid = any (v_line))), '{}');
    end if;
  else
    select coalesce(array_agg((x ->> 'id')::uuid order by n), '{}') into v_line
      from jsonb_array_elements(v_contacts) with ordinality t(x, n)
     where (x ->> 'id')::uuid = any (coalesce(v_first, '{}')) and not (x ->> 'stopped')::boolean;
  end if;
  v_contact := coalesce(p_contact, v_line[1],
                        (select (x ->> 'id')::uuid from jsonb_array_elements(v_contacts) with ordinality t(x, n) order by (x ->> 'stopped')::boolean, n limit 1));
  v_cc := coalesce((select array_agg(id order by n) from unnest(v_line) with ordinality u(id, n) where id is distinct from v_contact), '{}');

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
    'to_id', v_contact, 'cc_ids', to_jsonb(v_cc), 'service', v_svc,
    'service_name', case v_svc when 'portraits' then 'Team & individual' when 'action' then 'Action' when 'school_photos' then 'School photos' when 'events' then 'Events' end,
    'due_on', v_due,
    'subject', public.prospect_tidy(public.prospect_render(v_subj, v_vars)), 'body', public.prospect_tidy(public.prospect_render(v_body, v_vars)), 'warning', v_warn);
end $$;

-- partner_queue with people copied in. The CC list is checked like the To (same partner, an email, not bounced or
-- unsubscribed); approving it switches their emails back on, as it does for the To.
create or replace function public.partner_queue_cc(p_kind text, p_ref uuid, p_contact uuid, p_cc uuid[], p_subject text, p_body text,
                                                   p_approve boolean default false, p_due date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_res jsonb; v_org uuid; v_cc uuid[]; c public.prospect_contacts;
begin
  v_res := public.partner_queue(p_kind, p_ref, p_contact, p_subject, p_body, p_approve, p_due);
  select e.org_id into v_org from public.prospect_scheduled_emails e where e.id = (v_res ->> 'email_id')::uuid;
  v_cc := coalesce((select array_agg(distinct x) from unnest(coalesce(p_cc, '{}')) x where x is distinct from p_contact), '{}');
  for c in select * from public.prospect_contacts where id = any (v_cc) loop
    if c.org_id is distinct from v_org then raise exception 'Everyone copied in has to be from this partner.'; end if;
    if coalesce(btrim(c.email), '') = '' then raise exception '% has no email address.', coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), 'That person'); end if;
    if c.bounced_at is not null or c.unsubscribed_at is not null then raise exception '% bounced or unsubscribed.', c.email; end if;
  end loop;
  if cardinality(v_cc) <> (select count(*) from public.prospect_contacts where id = any (v_cc)) then raise exception 'Someone copied in was not found.'; end if;
  if cardinality(v_cc) > 0 then
    update public.prospect_scheduled_emails set cc_contact_ids = v_cc where id = (v_res ->> 'email_id')::uuid;
    if p_approve then update public.prospect_contacts set history_only = false, stopped_at = null where id = any (v_cc); end if;
  end if;
  return v_res || jsonb_build_object('cc', cardinality(v_cc));
end $$;

revoke all on function public.partner_rebook_service(uuid, date) from public, anon, authenticated;
revoke all on function public.partner_queue_cc(text, uuid, uuid, uuid[], text, text, boolean, date) from public, anon;
grant execute on function public.partner_queue_cc(text, uuid, uuid, uuid[], text, text, boolean, date) to authenticated;

notify pgrst, 'reload schema';
