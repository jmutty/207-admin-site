-- Rebook emails name the job (2026-10-24, Jeremiah: "I often shoot for the same partner several times a year. Maybe we
-- should put the job name instead of just the partner name in here so they know I'm specifically talking about
-- rebooking winter sports").
--
-- partner_compose gives rebook emails a {{job}} fill-in: last year's job(s) for that row ("Winter Sports", "Fall Sports
-- and School Photos"), blank when the row has no job name. It also returns 'job' so the Draft email title shows it.
-- The rebook template uses it, if it is still the one saved today:
--   subject  "{{league|Picture day}} {{job|picture day}} {{year}}"   e.g. "Narraguagus Jr/Sr High School Winter Sports 2026"
--   message  "Last year we photographed {{job|picture day}} at {{league|your league}} on {{last_date}}, ..."
-- Everything else in partner_compose is as in 20261025220000. Safe to run twice; nothing removed.

create or replace function public.partner_compose(p_kind text, p_ref uuid, p_contact uuid default null, p_due date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.partner_followup_settings; v_org uuid; v_first uuid[] := '{}'; v_contacts jsonb; v_contact uuid; v_vars jsonb; v_subj text; v_body text;
        v_last date; v_due date; r public.partner_reviews; a public.partner_agreements; v_warn text := '';
        v_svc text; v_line uuid[] := '{}'; v_cc uuid[] := '{}'; v_job text := '';
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
    -- the job(s) last year's row was for, e.g. 'Winter Sports' or 'Fall Sports and School Photos'
    select regexp_replace(coalesce(x.jobs, ''), ', ([^,]*)$', ' and \1') into v_job from public.partner_rebook_rows(v_org) x where x.due_on = v_due limit 1;
    v_vars := v_vars || jsonb_build_object('last_date', public.partner_fmt_day(v_last), 'last_season', public.partner_season_of(v_last),
                                           'year', coalesce(extract(year from v_due)::text, ''), 'job', coalesce(v_job, ''));
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
    'due_on', v_due, 'job', coalesce(v_job, ''),
    'subject', public.prospect_tidy(public.prospect_render(v_subj, v_vars)), 'body', public.prospect_tidy(public.prospect_render(v_body, v_vars)), 'warning', v_warn);
end $$;

update public.partner_followup_settings
   set rebook_subject = '{{league|Picture day}} {{job|picture day}} {{year}}', updated_at = now()
 where rebook_subject = '{{league|Picture day}} {{year}}';
update public.partner_followup_settings
   set rebook_body = replace(rebook_body, 'Last year we photographed {{league|your league}} on {{last_date}}',
                                          'Last year we photographed {{job|picture day}} at {{league|your league}} on {{last_date}}'), updated_at = now()
 where strpos(rebook_body, 'Last year we photographed {{league|your league}} on {{last_date}}') > 0;

notify pgrst, 'reload schema';
