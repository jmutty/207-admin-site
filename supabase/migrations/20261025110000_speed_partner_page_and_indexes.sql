-- Speed (2026-10-24), plan items 4 and 5.
--
-- 5. Two indexes for lookups that read every row:
--    * partner_rebook_rows() matches GotPhoto jobs to a partner by the job name's first part, for every partner on
--      the Due to rebook list (and Today's count). ~0.7 s -> ~0.09 s on live data.
--    * admin_lookup_blocks() (Find My Photos blocks) matched 28k codes by first + last name. ~0.5 s -> ~1 ms.
create index if not exists synced_jobs_name_org_idx on public.synced_jobs (lower(btrim(split_part(name, '|', 1))));
create index if not exists synced_codes_subject_name_idx on public.synced_codes (lower(trim(coalesce(subject_last, ''))), lower(trim(coalesce(subject_first, ''))));

-- 4. A partner's page asked for the whole company's outbox, rebooking list and sales and kept its own rows. Each of
--    these takes an optional p_org now: the page gets just that partner's rows. Called without it, they answer
--    exactly as before (the Outbox, Due to rebook and Results pages are unchanged). The only change in each body
--    is the p_org filter. A new argument changes the signature, so each is dropped and created again with its grants.
drop function if exists public.admin_outbox(integer);
CREATE OR REPLACE FUNCTION public.admin_outbox(p_days_back integer DEFAULT 14, p_org uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with tz as (select (now() at time zone 'America/New_York')::date as today),
  hw as (
    select 'sports' as hub, w.gotphoto_job_id as org_id, w.id, w.name, w.email from hub_watchers w where w.unsubscribed_at is null
    union all
    select 'school', w.school_id::text, w.id, w.name, w.email from school_hub_watchers w where w.unsubscribed_at is null
  ),
  outreach as (
    select 'outreach' as src, e.id::text as id, e.send_at as at,
           coalesce(nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.email) as to_name, c.email as to_email,
           o.name as org, o.id::text as org_id, null::text as booking_id, e.subject,
           case when e.enrollment_id is null then 'Quick email' else 'Outreach, email ' || e.step_no end as detail,
           case when e.status = 'scheduled' and e.needs_review then 'needs_review'
                when e.status = 'scheduled' then 'scheduled'
                when e.status = 'sent' then 'sent'
                when e.status = 'failed' then 'failed'
                else 'skipped' end as status,
           e.error, e.enrollment_id::text as enrollment_id, e.sent_at
      from prospect_scheduled_emails e
      left join prospect_orgs o on o.id = e.org_id
      left join prospect_contacts c on c.id = e.contact_id
     where e.status in ('scheduled', 'failed') or e.sent_at >= now() - make_interval(days => p_days_back)
  ),
  booking as (
    select 'booking' as src, e.id::text, e.send_at, e.to_name, e.to_email, o.name, o.id::text, b.id::text, e.subject,
           case when st.kind = 'hub' then 'Hub reminder: ' else 'Booking email: ' end || coalesce(st.label, 'step ' || e.step_no),
           case when e.status in ('scheduled', 'waiting', 'failed', 'sent', 'skipped') then e.status else 'waiting' end,
           coalesce(e.error, e.reason), null::text, e.sent_at
      from booking_emails e
      join bookings b on b.id = e.booking_id
      left join booking_steps st on st.id = e.step_id
      left join prospect_orgs o on o.id = b.org_id
     where b.status = 'booked' and (e.status in ('scheduled', 'waiting', 'failed') or e.sent_at >= now() - make_interval(days => p_days_back))
  ),
  makeup as (
    select 'makeup' as src, m.id::text, coalesce(m.sent_at, m.makeup_at) as at, m.parent_name, m.parent_email,
           coalesce(m.team_text, ''), null::text, null::text,
           coalesce(split_part(m.athlete_name, ' ', 1), 'Their') || '''s makeup photos are ready',
           'Makeup notice with the coupon',
           case when m.sent_at is not null then 'sent' when m.send_status = 'failed' then 'failed' else 'ready' end,
           m.send_error, null::text, m.sent_at
      from makeup_bookings m
     where m.dismissed_at is null and m.confirmed_job_id is not null
       and (m.sent_at is null or m.sent_at >= now() - make_interval(days => p_days_back))
  ),
  hub as (
    select 'hub' as src, s.hub || ':' || s.org_id || ':' || s.send_key as id,
           coalesce(l.sent_at, (d.send_day::timestamp + time '07:00') at time zone 'America/New_York') as at,
           (select string_agg(coalesce(w.name, w.email), ', ') from hw w where w.hub = s.hub and w.org_id = s.org_id) as to_name,
           null::text, s.org, null::text, null::text,
           'Today is a send day: ' || s.title, 'Hub reminder, ' || s.hub,
           case when l.sent_at is not null then 'sent' when d.send_day < tz.today then 'skipped' else 'scheduled' end,
           case when l.sent_at is null and d.send_day < tz.today then 'Not sent (no contact signed up, or covered by a booking)' end,
           null::text, l.sent_at
      from hub_sends_all() s
      cross join tz
      cross join lateral (select case when s.hub = 'school' then public.school_send_day(s.send_date) else s.send_date end as send_day) d
      left join lateral (select min(l.sent_at) as sent_at from hub_reminder_log l join hw w on w.id = l.watcher_id
                          where w.hub = s.hub and w.org_id = s.org_id and l.send_key = s.send_key) l on true
     where s.send_date is not null and not s.estimate
       and d.send_day between tz.today - least(p_days_back, 14) and tz.today + 7
       and not exists (select 1 from bookings b where b.status = 'booked' and ((s.hub = 'sports' and b.gotphoto_job_id = s.org_id) or (s.hub = 'school' and b.hub_school_id::text = s.org_id)))
  ),
  digest as (
    select 'digest' as src, 'digest' as id,
           case when (now() at time zone 'America/New_York')::time < a.digest_time
                then (tz.today::timestamp + a.digest_time) at time zone 'America/New_York'
                else ((tz.today + 1)::timestamp + a.digest_time) at time zone 'America/New_York' end as at,
           array_to_string(a.digest_recipients, ', '), null::text, 'The Today page, by email', null::text, null::text,
           'Today at 207 Photo', 'Morning digest', case when a.digest_enabled then 'scheduled' else 'skipped' end, null::text, null::text, null::timestamptz
      from admin_settings a, tz
  ),
  all_rows as (
    select * from outreach union all select * from booking union all select * from makeup union all select * from hub union all select * from digest
  )
  select case when not public.can_any('{partners}', 'view') then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('src', r.src, 'id', r.id, 'at', r.at, 'to_name', r.to_name, 'to_email', r.to_email, 'org', r.org, 'org_id', r.org_id,
                                        'booking_id', r.booking_id, 'subject', r.subject, 'detail', r.detail, 'status', r.status, 'error', r.error,
                                        'enrollment_id', r.enrollment_id, 'sent_at', r.sent_at)
                     order by case r.status when 'needs_review' then 0 when 'failed' then 0 when 'ready' then 0 when 'scheduled' then 1 when 'waiting' then 1 else 2 end,
                              case when r.status in ('sent', 'skipped') then null else r.at end asc nulls last,
                              r.sent_at desc nulls last)
      from all_rows r
     where p_org is null or r.org_id = p_org::text or (r.org_id is null and lower(r.org) = (select lower(o.name) from prospect_orgs o where o.id = p_org))), '[]'::jsonb) end;
$function$;
revoke all on function public.admin_outbox(integer, uuid) from public, anon;
grant execute on function public.admin_outbox(integer, uuid) to authenticated, service_role;

drop function if exists public.partner_rebook_list();
CREATE OR REPLACE FUNCTION public.partner_rebook_list(p_org uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_today date := (now() at time zone 'America/New_York')::date; v_lead int;
begin
  if not public.can('partners', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select rebook_lead_days into v_lead from public.partner_followup_settings;
  return coalesce((
    with base as (
      select o.id, o.name, o.stage, o.town, o.audience, o.job_count
        from public.prospect_orgs o
       where (p_org is null or o.id = p_org) and o.stage is distinct from 'do_not_contact' and o.status is distinct from 'do_not_contact'
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
end $function$;
revoke all on function public.partner_rebook_list(uuid) from public, anon;
grant execute on function public.partner_rebook_list(uuid) to authenticated, service_role;

drop function if exists public.results_jobs();
CREATE OR REPLACE FUNCTION public.results_jobs(p_org uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.can('results', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  perform public.results_refresh_internal();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.gotphoto_job_id, 'name', c.job_name, 'job_type', c.job_type, 'booking_type', bt.label,
             'gallery_status', c.gallery_status, 'picture_day', c.picture_day, 'season', c.season, 'season_year', c.season_year,
             'org_id', c.org_id, 'org_name', o.name, 'org_set', c.org_set,
             'gp_sales', c.gp_sales, 'gp_orders', c.gp_orders, 'gp_synced_at', c.gp_synced_at, 'gp_error', c.gp_error,
             'manual_sales', c.manual_sales, 'manual_orders', c.manual_orders, 'sales', c.sales, 'orders', c.orders,
             'pct', c.pct, 'pct_source', c.pct_source, 'payout_pct', c.payout_pct, 'payout_amount', c.payout_amount,
             'due', c.due, 'paid', c.paid, 'last_paid_on', c.last_paid_on, 'balance', c.balance, 'state', c.payout_state,
             'note', c.note)
           order by c.picture_day desc nulls last, c.job_name)
      from public.job_results_calc c
      left join public.prospect_orgs o on o.id = c.org_id
      left join public.booking_types bt on bt.key = c.booking_type
     where p_org is null or c.org_id = p_org), '[]'::jsonb);
end $function$;
revoke all on function public.results_jobs(uuid) from public, anon;
grant execute on function public.results_jobs(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
