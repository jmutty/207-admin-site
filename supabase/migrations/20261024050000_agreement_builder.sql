-- Agreement builder (2026-10-24, ws/agreement): school agreements built from Jeremiah's "207 Photo School Agreement
-- Builder" sheet (Apps Script v2). The app renders the agreement (app/src/agreement-builder.js, renderAgreement)
-- from the ticked services and filled blanks; this stores those choices and the result on partner_agreements and
-- sends it through the existing agreement flow (partner_compose / partner_queue, the #agree/<token> page).
--
--   partner_followup_settings.agreement_defaults   our standard terms (ratio, turnaround days, insurance limits,
--                                                  $75 correction rate, $250 fee, $10,000 cap, county, space, setup
--                                                  minutes, net days, roster email). Changed once, used by every new one.
--   partner_agreements.builder / doc_html / doc_text   the choices ({on, val}) and the rendered agreement.
--                                                  partner_agreement_text() returns doc_text for these, so the page,
--                                                  agreement_get and the frozen accepted_text all keep working.
--   accepted_html                                  the HTML they accepted, frozen with accepted_text.
--   agreement_builder_context / _save / _apply     the builder dialog: prefill, save, and "Apply to this partner's
--                                                  jobs and payout terms" (adds missing deliverables to the school
--                                                  jobs of that school year, sets a percent rebate as payout terms;
--                                                  never removes anything).
--   agreement_accept (+ p_email)                   on accept, a copy is emailed to the person who accepted through
--                                                  the outreach pipeline: approved (next send window) when it goes to a
--                                                  known contact, held for review when they typed an address we didn't
--                                                  know (it is added as a contact).
-- Existing RPC signatures keep working; agreement_accept gains an optional 4th argument.

-- ---------------------------------------------------------------- settings: our standard terms
alter table public.partner_followup_settings
  add column if not exists agreement_defaults jsonb not null default jsonb_build_object(
    'RATIO', '300', 'TA_GALLERY', '10', 'TA_FILES', '15', 'TA_COMPOSITE', '30', 'TA_CARDS', '15', 'TA_SHIP', '3',
    'INS_OCC', '1000000', 'INS_AGG', '2000000', 'INS_SAM_AMT', '1000000',
    'FIX_RATE', '75', 'RESCHED_FEE', '250', 'LIAB_CAP', '10000', 'COUNTY', 'Penobscot',
    'SPACE_SIZE', '20 ft by 30 ft', 'SETUP_MIN', '30', 'BREAKDOWN', '30', 'NET_DAYS', '30', 'ROSTER_EMAIL', 'info@207photo.com');
comment on column public.partner_followup_settings.agreement_defaults is
  'Standard terms for the school agreement builder (sheet keys: RATIO, TA_*, INS_*, FIX_RATE, RESCHED_FEE, LIAB_CAP, COUNTY, SPACE_SIZE, SETUP_MIN, BREAKDOWN, NET_DAYS, ROSTER_EMAIL).';

-- ---------------------------------------------------------------- agreements: builder choices + rendered document
alter table public.partner_agreements
  add column if not exists builder       jsonb,           -- {"on": {"FALL": true, ...}, "val": {"SCHOOL_NAME": "...", ...}}; null = a plain-text agreement
  add column if not exists doc_html      text,            -- renderAgreement(builder).html (only ab- classes, shown sanitized)
  add column if not exists doc_text      text,            -- the same as plain text
  add column if not exists accepted_html text,            -- doc_html as it was accepted, frozen
  add column if not exists accepted_email text,           -- the email they typed for their copy
  add column if not exists copy_email_id uuid references public.prospect_scheduled_emails (id) on delete set null,
  add column if not exists copy_note     text not null default '',
  add column if not exists applied_at    timestamptz,     -- last "Apply to this partner's jobs and payout terms"
  add column if not exists applied_note  text not null default '';
comment on column public.partner_agreements.builder is 'Agreement builder choices ({on, val} with the sheet keys). Null for plain-text agreements.';

-- Builder agreements read as their rendered text; the rest as before.
create or replace function public.partner_agreement_text(a public.partner_agreements) returns text
language sql stable security definer set search_path = '' as $$
  select case when a.builder is not null and coalesce(a.doc_text, '') <> '' then a.doc_text
    else public.prospect_tidy(public.prospect_render(coalesce(nullif(a.terms, ''), (select s.agreement_terms from public.partner_followup_settings s)),
      public.partner_vars(a.org_id, null) || jsonb_build_object(
        'league', (select o.name from public.prospect_orgs o where o.id = a.org_id),
        'title', a.title, 'picture_day', public.partner_fmt_day(a.picture_day), 'job', a.job,
        'pricing', a.pricing, 'payout', a.payout, 'renewal_date', public.partner_fmt_day(a.renewal_date)))) end
$$;

-- The list leaves the big columns out and says which ones the builder made.
create or replace function public.agreements_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('agreements', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(a) - 'terms' - 'accepted_text' - 'builder' - 'doc_html' - 'doc_text' - 'accepted_html'
             || jsonb_build_object('org', o.name, 'email', public.partner_email_state(a.email_id), 'has_builder', a.builder is not null, 'audience', o.audience,
             'booking_label', (select coalesce(nullif(b.title_override, ''), t.label, '') || ' ' || coalesce(to_char(b.picture_day, 'Mon FMDD'), '')
                                 from public.bookings b left join public.booking_types t on t.key = b.type_key where b.id = a.booking_id))
           order by case a.status when 'draft' then 0 when 'sent' then 1 when 'accepted' then 2 else 3 end, a.updated_at desc)
      from public.partner_agreements a join public.prospect_orgs o on o.id = a.org_id), '[]'::jsonb);
end $$;

-- Partners to pick from: schools first (the builder is for schools), then clients, then the rest.
create or replace function public.agreement_orgs(p_q text default '') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'town', coalesce(o.town, ''), 'stage', o.stage, 'audience', o.audience)
                     order by (o.audience = 'school') desc nulls last, o.stage in ('client', 'booked', 'talking') desc, o.name)
    from (select * from public.prospect_orgs o where o.stage is distinct from 'do_not_contact'
            and (coalesce(p_q, '') = '' or o.name ilike '%' || p_q || '%' or o.town ilike '%' || p_q || '%')
          order by (o.audience = 'school') desc nulls last, o.stage in ('client', 'booked', 'talking') desc, o.name limit 40) o), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- the builder dialog
-- Everything the dialog prefills from: the partner, its contacts (main contact first), its jobs with picture and
-- retake days, our standard terms, the choices of its last builder agreement (billing address, buildings), and
-- the agreement itself (p_id) or the one a new one starts from (p_from).
create or replace function public.agreement_builder_context(p_org uuid, p_id uuid default null, p_from uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.partner_agreements; f public.partner_agreements; o public.prospect_orgs; v_org uuid := p_org;
begin
  if not public.can('agreements', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_id is not null then
    select * into a from public.partner_agreements where id = p_id;
    if a.id is null then raise exception 'Not found.'; end if;
    v_org := a.org_id;
  end if;
  if p_from is not null then
    select * into f from public.partner_agreements where id = p_from;
    if f.id is null then raise exception 'Not found.'; end if;
    v_org := coalesce(v_org, f.org_id);
  end if;
  select * into o from public.prospect_orgs where id = v_org;
  if o.id is null then raise exception 'Pick a partner.'; end if;
  return jsonb_build_object(
    'org', jsonb_build_object('id', o.id, 'name', o.name, 'town', coalesce(o.town, ''), 'audience', o.audience,
             -- read by name so a later legal name / billing address column is picked up without changing this
             'legal_name', coalesce(to_jsonb(o) ->> 'legal_name', ''), 'billing_address', coalesce(to_jsonb(o) ->> 'billing_address', '')),
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, ''),
                         'role', coalesce(c.role, ''), 'email', coalesce(c.email, ''), 'phone', coalesce(c.phone, ''), 'primary', c.is_primary)
                         order by c.is_primary desc nulls last, c.history_only, c.created_at), '[]'::jsonb)
                   from public.prospect_contacts c where c.org_id = o.id and c.bounced_at is null and c.unsubscribed_at is null),
    'bookings', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'picture_day', b.picture_day, 'retake_day', b.retake_day, 'status', b.status,
                         'type_key', b.type_key, 'audience', t.audience, 'label', coalesce(nullif(b.title_override, ''), t.label, '')) order by b.picture_day), '[]'::jsonb)
                   from public.bookings b left join public.booking_types t on t.key = b.type_key
                  where b.org_id = o.id and b.status <> 'cancelled' and b.picture_day >= (now() at time zone 'America/New_York')::date - 400),
    'defaults', (select s.agreement_defaults from public.partner_followup_settings s),
    'last', (select x.builder from public.partner_agreements x where x.org_id = o.id and x.builder is not null and x.id is distinct from a.id and x.status <> 'void'
              order by x.created_at desc limit 1),
    'agreement', case when a.id is null then null else jsonb_build_object('id', a.id, 'status', a.status, 'title', a.title, 'builder', a.builder,
                   'booking_id', a.booking_id, 'token', a.token, 'accepted_at', a.accepted_at, 'accepted_name', a.accepted_name, 'accepted_html', a.accepted_html) end,
    'from', case when f.id is null then null else jsonb_build_object('id', f.id, 'builder', f.builder) end);
end $$;

-- Only the markup renderAgreement makes may be stored (the page shows it sanitized as well).
create or replace function public.agreement_html_ok(p_html text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(length(p_html), 0) <= 400000
     and p_html !~* '<\s*/?\s*(script|style|iframe|object|embed|link|meta|base|form|input|img|svg|math|a|frame|template)\y'
     and p_html !~* '\s(on[a-z]+|style|href|src|srcdoc|action|formaction|xlink:href)\s*='
     and p_html !~* 'javascript:'
$$;

-- Create (p_id null) or change a builder agreement while it is a draft or sent. p: title, picture_day,
-- renewal_date, booking_id (all optional). The payout line on the agreement follows the rebate choices.
create or replace function public.agreement_builder_save(p_id uuid, p_org uuid, p_builder jsonb, p_html text, p_text text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.partner_agreements; v_id uuid := p_id; v_on jsonb; v_val jsonb; v_payout text := '';
begin
  if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_builder) is distinct from 'object' or jsonb_typeof(coalesce(p_builder -> 'on', '{}')) <> 'object' or jsonb_typeof(coalesce(p_builder -> 'val', '{}')) <> 'object' then
    raise exception 'Nothing to save.';
  end if;
  if coalesce(btrim(p_builder -> 'val' ->> 'SCHOOL_NAME'), '') = '' then raise exception 'Add the school name first.'; end if;
  if coalesce(p_html, '') = '' or coalesce(p_text, '') = '' then raise exception 'The agreement is empty.'; end if;
  if not public.agreement_html_ok(p_html) or length(p_text) > 200000 then raise exception 'That agreement can''t be saved. Reload the page and try again.'; end if;
  v_on := coalesce(p_builder -> 'on', '{}'); v_val := coalesce(p_builder -> 'val', '{}');
  if (v_on ->> 'REBATE_PCT')::boolean is true or (v_on ->> 'REBATE_FLAT')::boolean is true then
    v_payout := 'Rebate to the school: ' ||
      concat_ws(', plus ', case when (v_on ->> 'REBATE_PCT')::boolean is true then coalesce(nullif(btrim(v_val ->> 'REBATE_PCT'), ''), '___') || ' percent of net sales' end,
                           case when (v_on ->> 'REBATE_FLAT')::boolean is true then '$' || coalesce(nullif(btrim(v_val ->> 'REBATE_FLAT'), ''), '___') || ' per completed order' end) ||
      coalesce(', designated for ' || nullif(btrim(v_val ->> 'REBATE_DEST'), ''), '') || '.';
  end if;
  if v_id is null then
    if not exists (select 1 from public.prospect_orgs where id = p_org) then raise exception 'Pick a partner.'; end if;
    insert into public.partner_agreements (org_id, title, job, terms, created_by)
    values (p_org, 'School Photography Service Agreement', 'School photography', '', auth.uid())
    returning id into v_id;
  end if;
  select * into a from public.partner_agreements where id = v_id for update;
  if a.id is null then raise exception 'Not found.'; end if;
  if a.status not in ('draft', 'sent') then raise exception 'This agreement was already accepted (or voided), so it can''t change. Start a new one from it.'; end if;
  update public.partner_agreements set
    builder      = jsonb_build_object('on', v_on, 'val', v_val),
    doc_html     = p_html,
    doc_text     = p_text,
    title        = coalesce(nullif(left(btrim(p ->> 'title'), 120), ''), title),
    picture_day  = case when p ? 'picture_day' then nullif(p ->> 'picture_day', '')::date else picture_day end,
    renewal_date = case when p ? 'renewal_date' then nullif(p ->> 'renewal_date', '')::date else renewal_date end,
    booking_id   = case when p ? 'booking_id' then (select b.id from public.bookings b where b.id = nullif(p ->> 'booking_id', '')::uuid and b.org_id = a.org_id) else booking_id end,
    job          = coalesce(nullif(job, ''), 'School photography'),
    payout       = v_payout,
    updated_at   = now()
  where id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- "Apply to this partner's jobs and payout terms": the ticked deliverables (p_deliverables, names) are added to
-- this partner's school jobs in the agreement's school year (booked or track-only; July 1 to June 30) that don't
-- have them yet, and a percent rebate becomes the partner's payout terms. Nothing is removed. Each part needs the
-- matching permission (Jobs edit, Season results edit) and is skipped with a note without it.
create or replace function public.agreement_builder_apply(p_id uuid, p_deliverables text[] default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.partner_agreements; v_on jsonb; v_val jsonb; v_ys int; v_ye int; v_today date := (now() at time zone 'America/New_York')::date;
        b record; v_items jsonb; r jsonb; v_jobs int := 0; v_added int := 0; v_pct numeric; v_msg text[] := '{}'; v_note text;
begin
  if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into a from public.partner_agreements where id = p_id;
  if a.id is null then raise exception 'Not found.'; end if;
  if a.builder is null then raise exception 'This agreement wasn''t made in the builder.'; end if;
  v_on := coalesce(a.builder -> 'on', '{}'); v_val := coalesce(a.builder -> 'val', '{}');
  if v_val ->> 'YEAR_START' ~ '^\s*\d{4}\s*$' then v_ys := btrim(v_val ->> 'YEAR_START')::int; end if;
  if v_val ->> 'YEAR_END' ~ '^\s*\d{4}\s*$' then v_ye := btrim(v_val ->> 'YEAR_END')::int; end if;

  -- deliverables
  if coalesce(array_length(p_deliverables, 1), 0) > 0 then
    if not public.can_any('{bookings}', 'edit') then
      v_msg := v_msg || 'Deliverables weren''t added: you can''t change jobs.'::text;
    else
      for b in
        select bk.id, bk.type_key from public.bookings bk join public.booking_types t on t.key = bk.type_key
         where bk.org_id = a.org_id and bk.status in ('booked', 'tracked') and t.audience = 'school'
           and case when v_ys is not null and v_ye is not null and v_ye >= v_ys
                    then bk.picture_day between make_date(v_ys, 7, 1) and make_date(v_ye, 6, 30)
                    else bk.picture_day >= v_today end
         order by bk.picture_day
      loop
        -- a saved deliverable with the same name brings its due days along
        select coalesce(jsonb_agg(case when tp.id is not null then jsonb_build_object('template_id', tp.id) else jsonb_build_object('label', btrim(u.l)) end order by u.ord), '[]'::jsonb)
          into v_items
          from unnest(p_deliverables) with ordinality u (l, ord)
          left join lateral (select x.id from public.deliverable_templates x
                              where x.archived_at is null and (x.type_key is null or x.type_key = b.type_key) and lower(btrim(x.label)) = lower(btrim(u.l))
                              order by x.type_key nulls last limit 1) tp on true
         where btrim(coalesce(u.l, '')) <> '' and length(btrim(u.l)) <= 120;
        r := public.booking_deliverables_add(b.id, v_items);
        v_jobs := v_jobs + 1;
        v_added := v_added + coalesce((r ->> 'added')::int, 0);
      end loop;
      if v_jobs = 0 then v_msg := v_msg || 'No school jobs in that school year yet, so no deliverables were added.'::text;
      else v_msg := v_msg || ('Added ' || v_added || ' deliverable' || case when v_added = 1 then '' else 's' end || ' to ' || v_jobs || ' job' || case when v_jobs = 1 then '' else 's' end || '.'); end if;
    end if;
  end if;

  -- payout terms
  if (v_on ->> 'REBATE_PCT')::boolean is true and v_val ->> 'REBATE_PCT' ~ '^\s*\d{1,3}(\.\d+)?\s*%?\s*$' then
    v_pct := (regexp_replace(v_val ->> 'REBATE_PCT', '[^0-9.]', '', 'g'))::numeric;
    if v_pct > 100 then
      v_msg := v_msg || 'The rebate is over 100 percent, so payout terms weren''t changed.'::text;
    elsif not public.can('results', 'edit') then
      v_msg := v_msg || 'Payout terms weren''t changed: you can''t change Season results.'::text;
    else
      v_note := left('From the ' || a.title || '.' ||
                     case when (v_on ->> 'REBATE_FLAT')::boolean is true then ' Plus $' || coalesce(nullif(btrim(v_val ->> 'REBATE_FLAT'), ''), '___') || ' per completed order.' else '' end ||
                     coalesce(' For ' || nullif(btrim(v_val ->> 'REBATE_DEST'), '') || '.', ''), 500);
      insert into public.partner_terms (org_id, payout_pct, note, payout_kind, gets, updated_by)
      values (a.org_id, v_pct, v_note, 'percent', '', auth.uid())
      on conflict (org_id) do update set payout_pct = excluded.payout_pct, note = excluded.note, payout_kind = 'percent', gets = '', updated_by = excluded.updated_by;
      v_msg := v_msg || ('Payout set to ' || rtrim(to_char(v_pct, 'FM990.99'), '.') || '% of sales.');
    end if;
  elsif (v_on ->> 'REBATE_FLAT')::boolean is true then
    v_msg := v_msg || 'A flat rebate per order has no place in payout terms; it stays on the agreement.'::text;
  end if;

  update public.partner_agreements set applied_at = now(), applied_note = array_to_string(v_msg, ' ') where id = a.id;
  return jsonb_build_object('ok', true, 'jobs', v_jobs, 'added', v_added, 'payout_pct', v_pct, 'message', array_to_string(v_msg, ' '));
end $$;

-- Change our standard terms (the keys the builder reads from agreement_defaults; others are ignored).
create or replace function public.agreement_defaults_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not public.can('agreements', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Nothing to save.'; end if;
  select coalesce(jsonb_object_agg(k, left(btrim(p ->> k), 200)), '{}'::jsonb) into v
    from unnest(array['RATIO', 'TA_GALLERY', 'TA_FILES', 'TA_COMPOSITE', 'TA_CARDS', 'TA_SHIP', 'INS_OCC', 'INS_AGG', 'INS_SAM_AMT', 'FIX_RATE',
                      'RESCHED_FEE', 'LIAB_CAP', 'COUNTY', 'SPACE_SIZE', 'SETUP_MIN', 'BREAKDOWN', 'NET_DAYS', 'ROSTER_EMAIL']) k
   where p ? k and jsonb_typeof(p -> k) in ('string', 'number');
  update public.partner_followup_settings set agreement_defaults = agreement_defaults || v, updated_at = now(), updated_by = auth.uid();
  return jsonb_build_object('ok', true, 'defaults', (select agreement_defaults from public.partner_followup_settings));
end $$;

-- ---------------------------------------------------------------- the public page
create or replace function public.agreement_public(p_token text) returns jsonb
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
    'html', case when a.status = 'accepted' then a.accepted_html when a.builder is not null then a.doc_html end,
    'accepted_name', a.accepted_name, 'accepted_title', a.accepted_title, 'accepted_at', a.accepted_at,
    'copy', case when a.copy_email_id is not null then true else false end);
end $$;

-- Email the person who accepted a copy (internal; called by agreement_accept). To the address they typed when it
-- belongs to one of the partner's contacts (approved, next send window), or to a new contact made from it (held
-- for review), else to the contact the agreement email went to (approved). Returns {status, note}.
create or replace function public.agreement_send_copy(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.partner_agreements; c public.prospect_contacts; v_contact uuid; v_approve boolean := true; v_body text; v_id uuid; v_org text; v_first text;
begin
  select * into a from public.partner_agreements where id = p_id;
  if a.id is null or a.status <> 'accepted' then return jsonb_build_object('status', 'none', 'note', 'Not accepted.'); end if;
  if a.copy_email_id is not null then return jsonb_build_object('status', 'already'); end if;
  select name into v_org from public.prospect_orgs where id = a.org_id;
  if coalesce(a.accepted_email, '') <> '' then
    select x.id into v_contact from public.prospect_contacts x
     where x.org_id = a.org_id and lower(btrim(x.email)) = a.accepted_email and x.bounced_at is null and x.unsubscribed_at is null limit 1;
    if v_contact is null and not exists (select 1 from public.prospect_contacts x where x.org_id = a.org_id and lower(btrim(x.email)) = a.accepted_email) then
      insert into public.prospect_contacts (org_id, email, first_name, last_name, role, is_primary)
      values (a.org_id, a.accepted_email, nullif(split_part(a.accepted_name, ' ', 1), ''),
              nullif(btrim(substr(a.accepted_name, length(split_part(a.accepted_name, ' ', 1)) + 1)), ''), nullif(a.accepted_title, ''), false)
      returning id into v_contact;
      v_approve := false;   -- an address we didn't know: someone looks first
    end if;
  end if;
  if v_contact is null then
    select e.contact_id into v_contact from public.prospect_scheduled_emails e join public.prospect_contacts x on x.id = e.contact_id
     where e.id = a.email_id and x.bounced_at is null and x.unsubscribed_at is null;
  end if;
  if v_contact is null then
    update public.partner_agreements set copy_note = 'No email address to send their copy to.' where id = a.id;
    return jsonb_build_object('status', 'none', 'note', 'No email address to send their copy to.');
  end if;
  select * into c from public.prospect_contacts where id = v_contact;
  v_first := coalesce(nullif(btrim(c.first_name), ''), nullif(split_part(a.accepted_name, ' ', 1), ''));
  v_body := coalesce('Hi ' || v_first, 'Hi there') || E',\n\n' ||
    'Thank you for accepting the ' || a.title || ' for ' || coalesce(v_org, 'your school') || '. Your copy is below. ' ||
    E'You can also open it, print it or save it any time from this link:\n\n' ||
    'https://admin.207photo.com/#agree/' || a.token || E'\n\n' ||
    'Accepted by ' || a.accepted_name || coalesce(', ' || nullif(a.accepted_title, ''), '') || ' on ' || public.partner_fmt_day((a.accepted_at at time zone 'America/New_York')::date) || E'.\n\n' ||
    E'----------------------------------------\n\n' ||
    replace(replace(coalesce(a.accepted_text, ''), '{{', '{ {'), '}}', '} }');
  v_id := public.partner_email_put(a.org_id, v_contact, 'Your copy: ' || a.title, v_body, v_approve);
  update public.partner_agreements set copy_email_id = v_id, copy_note = case when v_approve then '' else 'Held for review: sent to an address they typed.' end where id = a.id;
  return jsonb_build_object('status', case when v_approve then 'scheduled' else 'review' end, 'email_id', v_id);
end $$;

-- Accept once by typed name; p_email (optional) is where their copy goes. Builder agreements also freeze the HTML.
drop function if exists public.agreement_accept(text, text, text);
create or replace function public.agreement_accept(p_token text, p_name text, p_title text default '', p_email text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.partner_agreements; v_hdr jsonb; v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')); v_org text;
        v_email text := lower(btrim(coalesce(p_email, ''))); v_copy jsonb;
begin
  if coalesce(length(p_token), 0) < 20 then return jsonb_build_object('ok', false, 'error', 'This link is not valid.'); end if;
  select * into a from public.partner_agreements where token = p_token for update;
  if a.id is null or a.status not in ('sent', 'accepted') then return jsonb_build_object('ok', false, 'error', 'This agreement is no longer open. Please reply to our email for a new link.'); end if;
  if a.status = 'accepted' then return jsonb_build_object('ok', true, 'already', true, 'accepted_name', a.accepted_name, 'accepted_at', a.accepted_at); end if;
  if length(v_name) < 3 or length(v_name) > 120 or v_name !~ '[[:alpha:]]' then return jsonb_build_object('ok', false, 'error', 'Type your full name to accept.'); end if;
  if v_email <> '' and (length(v_email) > 200 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return jsonb_build_object('ok', false, 'error', 'That email doesn''t look right. Fix it, or leave it blank.');
  end if;
  begin v_hdr := current_setting('request.headers', true)::jsonb; exception when others then v_hdr := null; end;
  update public.partner_agreements set status = 'accepted', accepted_name = v_name, accepted_title = left(btrim(coalesce(p_title, '')), 120),
         accepted_at = now(), accepted_text = public.partner_agreement_text(a),
         accepted_html = case when a.builder is not null then a.doc_html end, accepted_email = nullif(v_email, ''),
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
  -- Their copy. Never blocks the accept.
  begin
    v_copy := public.agreement_send_copy(a.id);
  exception when others then
    v_copy := jsonb_build_object('status', 'none');
    update public.partner_agreements set copy_note = left('Copy not sent: ' || sqlerrm, 500) where id = a.id;
  end;
  return jsonb_build_object('ok', true, 'accepted_name', v_name, 'accepted_at', now(), 'copy', coalesce(v_copy ->> 'status', 'none'));
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function public.agreement_builder_context(uuid, uuid, uuid), public.agreement_builder_save(uuid, uuid, jsonb, text, text, jsonb),
  public.agreement_builder_apply(uuid, text[]), public.agreement_defaults_save(jsonb), public.agreement_html_ok(text),
  public.agreement_send_copy(uuid), public.agreement_accept(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.agreement_builder_context(uuid, uuid, uuid), public.agreement_builder_save(uuid, uuid, jsonb, text, text, jsonb),
  public.agreement_builder_apply(uuid, text[]), public.agreement_defaults_save(jsonb)
  to authenticated;
grant execute on function public.agreement_accept(text, text, text, text) to anon, authenticated;
-- agreements_list / agreement_orgs / agreement_public / partner_agreement_text keep the grants they had (create or replace).
