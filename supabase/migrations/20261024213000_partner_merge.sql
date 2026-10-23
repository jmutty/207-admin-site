-- Merge two partner records that are the same league or school (2026-10-24, Jeremiah).
-- Partner page > "Merge into…": pick the record to keep, see what moves, confirm.
--
--   partner_merge_preview(keep, other)  what would move, and anything that blocks it
--   partner_merge(keep, other)          moves everything onto keep. Nothing is removed: the other record is renamed
--                                       "<name> (merged into <keep>)", set to Do not contact, and points at keep
--                                       through prospect_orgs.merged_into, so lists and search hide it and its page
--                                       links to the one kept. Same steps as the hand merge of Barracudas Swim into
--                                       Bangor Region YMCA (2026-10-23).
--
-- Contacts: people move across. Someone who is on both records with the same email stays one person: the kept
-- record's contact takes over their history, emails and job ticks (blank phone/name/notes filled in, stop/unsubscribe
-- carried over), and the duplicate stays behind on the old record as history only. A moved contact who was Main for a
-- service the kept partner already has a Main for becomes Copy in.
-- Partner fields: GotPhoto names, calendar dates, sports, seasons, services and shoot months are combined; blanks on
-- the kept record are filled from the other one; notes are joined; the further-along stage and service status win.
-- The old prospect_merge_orgs (never called by the app) removed the duplicate outright and missed bookings and
-- agreements; it now runs this instead.

alter table public.prospect_orgs add column if not exists merged_into uuid references public.prospect_orgs (id);
create index if not exists prospect_orgs_merged_into_idx on public.prospect_orgs (merged_into) where merged_into is not null;

-- The Barracudas Swim record merged by hand on 2026-10-23.
update public.prospect_orgs d set merged_into = k.id
  from public.prospect_orgs k
 where d.name = 'Barracudas Swim (merged into Bangor Region YMCA)' and k.name = 'Bangor Region YMCA' and d.merged_into is null;

create or replace function public.partner_merge_check(p_keep uuid, p_other uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare k public.prospect_orgs; d public.prospect_orgs;
begin
  if p_keep is null or p_other is null or p_keep = p_other then return 'Pick two different partners.'; end if;
  select * into k from public.prospect_orgs where id = p_keep;
  select * into d from public.prospect_orgs where id = p_other;
  if k.id is null or d.id is null then return 'That partner doesn''t exist any more.'; end if;
  if d.merged_into is not null then return d.name || ' was already merged.'; end if;
  if k.merged_into is not null then return k.name || ' was merged into another partner. Merge into that one instead.'; end if;
  if exists (select 1 from public.prospect_enrollments where org_id = p_other and status in ('active', 'paused'))
     and exists (select 1 from public.prospect_enrollments where org_id = p_keep and status in ('active', 'paused')) then
    return 'Both partners are in an outreach sequence right now. Stop one of them first (Contacts tab).';
  end if;
  return null;
end $$;
revoke execute on function public.partner_merge_check(uuid, uuid) from public, anon, authenticated;

create or replace function public.partner_merge_preview(p_keep uuid, p_other uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare k public.prospect_orgs; d public.prospect_orgs;
begin
  if auth.uid() is not null and not public.can('partners', 'edit') then
    raise exception 'You need edit access to Partners to merge.' using errcode = '42501';
  end if;
  select * into k from public.prospect_orgs where id = p_keep;
  select * into d from public.prospect_orgs where id = p_other;
  return jsonb_build_object(
    'keep', k.name, 'other', d.name,
    'blocked', public.partner_merge_check(p_keep, p_other),
    'contacts', (select count(*) from public.prospect_contacts c where c.org_id = p_other),
    'same_people', (select count(*) from public.prospect_contacts c join public.prospect_contacts kc
                      on kc.org_id = p_keep and lower(kc.email) = lower(c.email) where c.org_id = p_other),
    'jobs', (select count(*) from public.bookings b where b.org_id = p_other),
    'gotphoto_jobs', (select count(*) from public.job_results j where j.org_id = p_other),
    'agreements', (select count(*) from public.partner_agreements a where a.org_id = p_other),
    'reviews', (select count(*) from public.partner_reviews r where r.org_id = p_other),
    'history', (select count(*) from public.prospect_activities a where a.org_id = p_other),
    'emails', (select count(*) from public.prospect_scheduled_emails e where e.org_id = p_other),
    'followups', (select count(*) from public.prospect_followups f where f.org_id = p_other),
    'gotphoto_names', to_jsonb(coalesce(d.gotphoto_names, '{}')),
    'cal_dates', cardinality(coalesce(d.cal_dates, '{}'::date[])));
end $$;
grant execute on function public.partner_merge_preview(uuid, uuid) to authenticated;

create or replace function public.partner_merge(p_keep uuid, p_other uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k public.prospect_orgs; d public.prospect_orgs; v_err text; v_mains text[]; pair record;
  v_stage jsonb := '{"new":0,"no_reply":1,"not_now":2,"contacting":3,"talking":4,"booked":5,"past_client":6,"client":7}';
  v_svc jsonb := '{"not_interested":0,"competitor":1,"prospect":2,"past_client":3,"client":4}';
  v_moved int; v_same int; v_jobs int;
begin
  if auth.uid() is not null and not public.can('partners', 'edit') then
    raise exception 'You need edit access to Partners to merge.' using errcode = '42501';
  end if;
  v_err := public.partner_merge_check(p_keep, p_other);
  if v_err is not null then raise exception '%', v_err; end if;
  select * into k from public.prospect_orgs where id = p_keep for update;
  select * into d from public.prospect_orgs where id = p_other for update;

  -- the same person on both records: keep the kept record's contact, hand it the duplicate's references
  for pair in
    select c.id as dup, kc.id as kept from public.prospect_contacts c
      join public.prospect_contacts kc on kc.org_id = p_keep and lower(kc.email) = lower(c.email)
     where c.org_id = p_other
  loop
    update public.prospect_contacts kc set
      first_name = coalesce(nullif(kc.first_name, ''), c.first_name),
      last_name = coalesce(nullif(kc.last_name, ''), c.last_name),
      role = coalesce(nullif(kc.role, ''), c.role),
      phone = coalesce(nullif(kc.phone, ''), c.phone),
      notes = nullif(concat_ws(E'\n', nullif(kc.notes, ''), nullif(c.notes, '')), ''),
      unsubscribed_at = coalesce(kc.unsubscribed_at, c.unsubscribed_at),
      bounced_at = coalesce(kc.bounced_at, c.bounced_at),
      stopped_at = coalesce(kc.stopped_at, c.stopped_at)
      from public.prospect_contacts c where kc.id = pair.kept and c.id = pair.dup;
    update public.prospect_activities set contact_id = pair.kept where contact_id = pair.dup;
    update public.prospect_threads set contact_id = pair.kept where contact_id = pair.dup;
    update public.prospect_scheduled_emails set contact_id = pair.kept where contact_id = pair.dup;
    update public.booking_emails set contact_id = pair.kept where contact_id = pair.dup;
    update public.booking_emails set to_contact_id = pair.kept where to_contact_id = pair.dup;
    update public.pd_plans set contact_id = pair.kept where contact_id = pair.dup;
    update public.bookings set contact_ids = array_replace(contact_ids, pair.dup, pair.kept) where pair.dup = any (contact_ids);
    update public.prospect_contacts set history_only = true, service_roles = '{}'::jsonb where id = pair.dup;
  end loop;
  select count(*) into v_same from public.prospect_contacts c
    join public.prospect_contacts kc on kc.org_id = p_keep and lower(kc.email) = lower(c.email) where c.org_id = p_other;

  -- everyone else moves; one Main per service, so a second Main becomes Copy in
  select coalesce(array_agg(distinct e.key), '{}') into v_mains
    from public.prospect_contacts c, jsonb_each_text(c.service_roles) e where c.org_id = p_keep and e.value = 'main';
  update public.prospect_contacts c set org_id = p_keep,
         service_roles = coalesce((select jsonb_object_agg(e.key, case when e.value = 'main' and e.key = any (v_mains) then 'copy' else e.value end)
                                     from jsonb_each_text(c.service_roles) e), '{}'::jsonb)
   where c.org_id = p_other
     and not exists (select 1 from public.prospect_contacts kc where kc.org_id = p_keep and lower(kc.email) = lower(c.email));
  get diagnostics v_moved = row_count;

  update public.bookings set org_id = p_keep where org_id = p_other;
  get diagnostics v_jobs = row_count;
  update public.job_results set org_id = p_keep where org_id = p_other;
  update public.partner_agreements set org_id = p_keep where org_id = p_other;
  update public.partner_reviews set org_id = p_keep where org_id = p_other;
  update public.prospect_activities set org_id = p_keep where org_id = p_other;
  update public.prospect_followups set org_id = p_keep, org_name = k.name where org_id = p_other;
  update public.prospect_past_outreach set org_id = p_keep, org_name = k.name where org_id = p_other;
  update public.prospect_scheduled_emails set org_id = p_keep where org_id = p_other;
  update public.prospect_enrollments set org_id = p_keep where org_id = p_other;
  -- rebooking rows and terms: the kept record's own win where both have one
  update public.partner_rebook r set org_id = p_keep
   where r.org_id = p_other and not exists (select 1 from public.partner_rebook x where x.org_id = p_keep and x.due_on = r.due_on);
  update public.partner_terms t set org_id = p_keep
   where t.org_id = p_other and not exists (select 1 from public.partner_terms x where x.org_id = p_keep);

  update public.prospect_orgs set
    gotphoto_names = (select coalesce(array_agg(distinct g order by g), '{}') from unnest(coalesce(k.gotphoto_names, '{}') || coalesce(d.gotphoto_names, '{}')) g),
    cal_dates = (select coalesce(array_agg(distinct x order by x), '{}') from unnest(coalesce(k.cal_dates, '{}'::date[]) || coalesce(d.cal_dates, '{}'::date[])) x),
    sports = (select coalesce(array_agg(distinct s), '{}') from unnest(coalesce(k.sports, '{}') || coalesce(d.sports, '{}')) s),
    seasons = (select coalesce(array_agg(distinct s), '{}') from unnest(coalesce(k.seasons, '{}') || coalesce(d.seasons, '{}')) s),
    services = (select coalesce(array_agg(distinct s order by s), '{}') from unnest(coalesce(k.services, '{}') || coalesce(d.services, '{}')) s),
    shoot_months = (select coalesce(array_agg(distinct m order by m), '{}') from unnest(coalesce(k.shoot_months, '{}') || coalesce(d.shoot_months, '{}')) m),
    town = coalesce(nullif(k.town, ''), d.town),
    county = coalesce(nullif(k.county, ''), d.county),
    website = coalesce(nullif(k.website, ''), d.website),
    personal_line = coalesce(nullif(k.personal_line, ''), d.personal_line),
    wifi_network = coalesce(nullif(k.wifi_network, ''), d.wifi_network),
    wifi_password = coalesce(nullif(k.wifi_password, ''), d.wifi_password),
    sp_competitor = coalesce(nullif(k.sp_competitor, ''), d.sp_competitor),
    sp_until = coalesce(k.sp_until, d.sp_until),
    sp_note = nullif(concat_ws(E'\n', nullif(k.sp_note, ''), nullif(d.sp_note, '')), ''),
    notes = nullif(concat_ws(E'\n', nullif(k.notes, ''), nullif(d.notes, '')), ''),
    client_since = least(k.client_since, d.client_since),
    last_job_at = greatest(k.last_job_at, d.last_job_at),
    next_job_at = least(k.next_job_at, d.next_job_at),
    last_opened_at = greatest(k.last_opened_at, d.last_opened_at),
    stage = case when coalesce((v_stage ->> d.stage)::int, -1) > coalesce((v_stage ->> k.stage)::int, -1) then d.stage else k.stage end,
    service_status = coalesce(k.service_status, '{}'::jsonb) || coalesce((
      select jsonb_object_agg(e.key, e.value) from jsonb_each_text(coalesce(d.service_status, '{}'::jsonb)) e
       where coalesce((v_svc ->> e.value)::int, -1) > coalesce((v_svc ->> (k.service_status ->> e.key))::int, -1)), '{}'::jsonb)
   where id = p_keep;

  -- the other record stays (for its old links and history), out of every list and every sync
  update public.prospect_orgs set
    name = d.name || ' (merged into ' || k.name || ')',
    merged_into = p_keep, stage = 'do_not_contact', status = 'do_not_contact',
    gotphoto_names = '{}', cal_dates = '{}', client_since = null, last_job_at = null, next_job_at = null, job_count = null,
    next_action = null, next_action_at = null
   where id = p_other;

  insert into public.prospect_activities (org_id, kind, body, meta, created_by) values
    (p_keep, 'note', 'Merged in "' || d.name || '": its contacts, jobs, emails and history are here now.',
       jsonb_build_object('merged_from', p_other, 'merged_name', d.name), auth.uid()),
    (p_other, 'note', 'Merged into "' || k.name || '". Everything moved there.',
       jsonb_build_object('merged_into', p_keep, 'merged_name', k.name), auth.uid());

  perform public.prospect_client_refresh(p_keep);
  perform public.prospect_org_refresh(p_keep);
  perform public.prospect_org_refresh(p_other);
  return jsonb_build_object('kept', k.name, 'merged', d.name, 'contacts_moved', v_moved, 'same_people', v_same, 'jobs_moved', v_jobs);
end $$;
grant execute on function public.partner_merge(uuid, uuid) to authenticated;

-- the old helper now merges the same safe way
create or replace function public.prospect_merge_orgs(p_keep uuid, p_drop uuid) returns jsonb
language sql security definer set search_path = '' as $$ select public.partner_merge(p_keep, p_drop) $$;
