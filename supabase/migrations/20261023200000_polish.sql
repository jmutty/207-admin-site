-- Polish pass (2026-10-23): Jeremiah's notes on each module, from the polish review. Runs after every
-- migration of this release. Email and push only, never SMS; only bookings.status = 'booked' send anything.
--
--   1. Picture day planner off      never used (no plans, teams or emails). Cron, pushes, public pages and the
--                                   module go; the tables stay, empty.
--   2. Open jobs: ask who's free    people say they're available (or can't make it) and can change their mind;
--                                   a manager picks who gets it, which puts them on the schedule. Not first come.
--   3. Job checklists               no step emails the partner (hub messages cover that).
--   4. Partner terms                a percent of sales, deliverables instead (like action photos), or nothing.
--                                   Payouts show on Today only once the season is over.
--   5. Notifications                each kind is Push now, Morning email or Off, per person. Morning email
--                                   kinds wait in push_digest for the 7am email. The digest is built from each
--                                   person's own Today list (every module's attention check, run as them), and
--                                   goes to the people picked under Settings, plus anyone with kinds waiting.
--
-- Contains deletes: apply from the Mac (Remote Control), not the Supabase MCP.

-- ================================================================ 1. picture day planner off
do $$ begin perform cron.unschedule('pd-email-send'); exception when others then null; end $$;
delete from public.push_prefs where topic in ('pd_intake', 'pd_move');
delete from public.push_topics where key in ('pd_intake', 'pd_move');
revoke execute on function public.pd_public_plan(text), public.pd_public_submit(text, jsonb), public.pd_public_roster(text, text, text),
  public.pd_public_slot(text), public.pd_public_slot_reply(text, text, text), public.pd_roster_path_ok(text) from anon, authenticated;
revoke execute on function public.pd_list(), public.pd_get(uuid), public.pd_save_plan(uuid, jsonb), public.pd_save_team(uuid, jsonb),
  public.pd_save_slots(uuid, jsonb), public.pd_remove_team(uuid), public.pd_send_intake(uuid, uuid, text, text), public.pd_slot_preview(uuid),
  public.pd_send_slots(uuid, uuid[]), public.pd_attention() from authenticated;
drop policy if exists pictureday_roster_upload on storage.objects;
delete from public.app_modules where key = 'pictureday';   -- its team_permissions rows go with it

-- ================================================================ 2. open jobs: ask who's available, the manager picks
alter table public.job_offer_recipients add column picked_at timestamptz;
alter table public.job_offer_recipients add column picked_by uuid references auth.users (id) on delete set null;
comment on column public.job_offer_recipients.picked_at is 'A manager picked them for the job (2026-10-23). answer = accepted only means they said they are available.';
update public.job_offer_recipients set picked_at = answered_at where answer = 'accepted' and picked_at is null;  -- the old "took it" answers
comment on table public.job_offers is 'A job offered to part-timers. They say if they are available; a manager picks. open -> filled (every spot picked) or closed (by a manager).';

update public.push_topics set label = 'Open job near you', description = 'A job near you needs someone. Say if you''re available; you hear back if you''re picked.' where key = 'job_offer';
update public.push_topics set label = 'Who''s available', description = 'Someone said they''re available for an open job you posted, or can''t make it.' where key = 'job_offer_reply';

-- 'taken' = picked (the spots filled), 'yes' = said they're available.
create or replace function public.openjobs_offer_json(p_offer uuid, p_uid uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'booking_id', o.booking_id, 'title', public.schedule_booking_title(o.booking_id),
    'type_label', t.label, 'location', coalesce(public.schedule_destination(o.booking_id), ''),
    'booking_status', b.status, 'spots', o.spots, 'note', o.note, 'pay', o.pay, 'status', o.status,
    'created_at', o.created_at, 'created_by', public.staff_name(o.created_by),
    'taken', (select count(*) from public.job_offer_recipients r where r.offer_id = o.id and r.picked_at is not null),
    'yes', (select count(*) from public.job_offer_recipients r where r.offer_id = o.id and r.answer = 'accepted'),
    'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'start_at', d.start_at, 'end_at', d.end_at) order by d.day), '[]'::jsonb)
               from public.openjobs_days(o.booking_id) d),
    'mine', case when p_uid is not null then
              (select jsonb_build_object('drive_min', r.drive_min, 'answer', r.answer, 'answered_at', r.answered_at, 'reason', r.reason, 'picked_at', r.picked_at)
                 from public.job_offer_recipients r where r.offer_id = o.id and r.user_id = p_uid) end)
    from public.job_offers o
    join public.bookings b on b.id = o.booking_id
    left join public.booking_types t on t.key = b.type_key
   where o.id = p_offer
$$;

create or replace function public.openjobs_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(public.openjobs_offer_json(o.id) || jsonb_build_object('recipients',
            (select coalesce(jsonb_agg(jsonb_build_object('user_id', r.user_id, 'name', public.staff_name(r.user_id), 'drive_min', r.drive_min,
                      'notified', r.notified, 'seen_at', r.seen_at, 'answer', r.answer, 'answered_at', r.answered_at, 'reason', r.reason, 'picked_at', r.picked_at)
                      order by r.picked_at is not null desc, r.answer = 'accepted' desc nulls last, r.drive_min nulls last, lower(public.staff_name(r.user_id))), '[]'::jsonb)
               from public.job_offer_recipients r where r.offer_id = o.id))
            order by o.status = 'open' desc, o.created_at desc), '[]'::jsonb)
    from public.job_offers o join public.bookings b on b.id = o.booking_id
   where o.status = 'open' or o.created_at > now() - interval '30 days');
end $$;

-- Mine: open offers (answered or not: they can change their answer until someone is picked), and ones from the
-- last 30 days. Opening the page marks them seen.
create or replace function public.openjobs_mine()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v jsonb;
begin
  if not public.can('openjobs', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(public.openjobs_offer_json(o.id, v_uid) order by (r.answer is null and o.status = 'open') desc, o.created_at desc), '[]'::jsonb) into v
    from public.job_offer_recipients r
    join public.job_offers o on o.id = r.offer_id
    join public.bookings b on b.id = o.booking_id
   where r.user_id = v_uid
     and ((o.status = 'open' and b.status = 'booked' and exists (select 1 from public.openjobs_days(o.booking_id)))
       or (r.answer is not null and r.answered_at > now() - interval '30 days')
       or (o.status <> 'open' and coalesce(o.closed_at, o.created_at) > now() - interval '7 days'));
  update public.job_offer_recipients set seen_at = now() where user_id = v_uid and seen_at is null;
  return jsonb_build_object('me', v_uid, 'offers', v);
end $$;

-- I'm available (p_accept true) or Can't make it (false, with an optional reason). Nothing goes on the schedule
-- until a manager picks. Changing the answer is fine while the offer is open and they haven't been picked.
create or replace function public.openjobs_answer(p_offer uuid, p_accept boolean, p_reason text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  o public.job_offers; r public.job_offer_recipients; v_title text; v_who text; v_yes int;
begin
  if not public.can('openjobs', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into o from public.job_offers where id = p_offer for update;
  select * into r from public.job_offer_recipients where offer_id = p_offer and user_id = v_uid;
  if o.id is null or r.offer_id is null then raise exception 'That job was not offered to you.'; end if;
  if r.picked_at is not null then raise exception 'You were picked for this job. Call the office if you can''t make it.'; end if;
  if o.status = 'filled' then return jsonb_build_object('ok', false, 'error', 'filled'); end if;
  if o.status <> 'open' or not exists (select 1 from public.bookings where id = o.booking_id and status = 'booked')
     or not exists (select 1 from public.openjobs_days(o.booking_id)) then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  if r.answer is not distinct from (case when p_accept then 'accepted' else 'declined' end)
     and (p_accept or r.reason = left(btrim(coalesce(p_reason, '')), 300)) then
    return jsonb_build_object('ok', true, 'answer', r.answer, 'scheduled', 0, 'untimed', 0);
  end if;
  update public.job_offer_recipients
     set answer = case when p_accept then 'accepted' else 'declined' end, answered_at = now(),
         reason = case when p_accept then '' else left(btrim(coalesce(p_reason, '')), 300) end
   where offer_id = o.id and user_id = v_uid;

  if o.created_by is not null and o.created_by <> v_uid and public.openjobs_wants_push(o.created_by, 'job_offer_reply') then
    begin
      v_title := public.schedule_booking_title(o.booking_id);
      v_who := public.staff_name(v_uid);
      select count(*) into v_yes from public.job_offer_recipients x where x.offer_id = o.id and x.answer = 'accepted';
      perform public.push_notify('job_offer_reply',
        case when p_accept then v_who || ' is available for ' || v_title else v_who || ' can''t make ' || v_title end,
        case when p_accept then v_yes || case when v_yes = 1 then ' person is' else ' people are' end || ' available. Pick who gets it.'
             else coalesce(nullif(left(btrim(coalesce(p_reason, '')), 200), '') || '. ', '') ||
                  (select count(*) from public.job_offer_recipients x where x.offer_id = o.id and x.answer is null) || ' still to answer.' end,
        '/#staff/openjobs', 'job_offer_reply_' || o.id, o.created_by);
    exception when others then raise warning 'openjobs_answer push: %', sqlerrm;
    end;
  end if;
  return jsonb_build_object('ok', true, 'answer', case when p_accept then 'accepted' else 'declined' end, 'scheduled', 0, 'untimed', 0);
end $$;

-- The manager picks someone who said they're available: they go on the schedule for each day with a time (with
-- their own drive, rounded up to 5 minutes; setup and teardown come from the schedule's defaults), and get a push.
create function public.openjobs_pick(p_offer uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  o public.job_offers; r public.job_offer_recipients; d record;
  v_taken int; v_drive int; v_added int := 0;
begin
  if not public.can('openjobs', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into o from public.job_offers where id = p_offer for update;
  select * into r from public.job_offer_recipients where offer_id = p_offer and user_id = p_user;
  if o.id is null or r.offer_id is null then raise exception 'That person wasn''t asked about this job.'; end if;
  if r.answer is distinct from 'accepted' then raise exception 'Pick someone who said they''re available.'; end if;
  if r.picked_at is not null then return jsonb_build_object('ok', true, 'filled', o.status = 'filled', 'scheduled', 0); end if;
  if o.status <> 'open' or not exists (select 1 from public.bookings where id = o.booking_id and status = 'booked') then
    raise exception 'This offer is closed.';
  end if;
  select count(*) into v_taken from public.job_offer_recipients where offer_id = o.id and picked_at is not null;
  if v_taken >= o.spots then raise exception 'Every spot is already filled.'; end if;

  update public.job_offer_recipients set picked_at = now(), picked_by = v_me where offer_id = o.id and user_id = p_user;
  v_taken := v_taken + 1;
  if v_taken >= o.spots then update public.job_offers set status = 'filled', closed_at = now() where id = o.id; end if;

  v_drive := least(600, ceil(coalesce(r.drive_min, 0) / 5.0)::int * 5);
  for d in select * from public.openjobs_days(o.booking_id) where start_at is not null loop
    continue when exists (select 1 from public.schedule_entries e where e.user_id = p_user and e.booking_id = o.booking_id and e.starts_at = d.start_at);
    insert into public.schedule_entries (user_id, kind, booking_id, starts_at, ends_at, drive_before_min, drive_after_min, title, note, created_by)
    values (p_user, 'job', o.booking_id, d.start_at, d.end_at, v_drive, v_drive, '', 'Picked from Open jobs', v_me);
    v_added := v_added + 1;
  end loop;

  if public.openjobs_wants_push(p_user, 'job_offer') then
    begin
      perform public.push_notify('job_offer', 'You''ve got the job: ' || public.schedule_booking_title(o.booking_id),
        case when v_added > 0 then 'It''s on your schedule.' else 'The office will add the times.' end,
        '/#staff/crew', 'job_offer_pick_' || o.id || '_' || p_user, p_user);
    exception when others then raise warning 'openjobs_pick push: %', sqlerrm;
    end;
  end if;
  return jsonb_build_object('ok', true, 'filled', v_taken >= o.spots, 'scheduled', v_added,
                            'untimed', (select count(*) from public.openjobs_days(o.booking_id) where start_at is null));
end $$;

-- Today: offers waiting on me; for managers, open offers with someone available to pick, and ones nobody can make.
create or replace function public.openjobs_attention()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if not public.can('openjobs', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'waiting', (select count(*) from public.job_offer_recipients r join public.job_offers o on o.id = r.offer_id join public.bookings b on b.id = o.booking_id
                 where r.user_id = v_uid and r.answer is null and o.status = 'open' and b.status = 'booked' and exists (select 1 from public.openjobs_days(o.booking_id))),
    'to_pick', case when public.can('openjobs', 'edit') then
                 (select count(*) from public.job_offers o join public.bookings b on b.id = o.booking_id
                   where o.status = 'open' and b.status = 'booked' and exists (select 1 from public.openjobs_days(o.booking_id))
                     and exists (select 1 from public.job_offer_recipients r where r.offer_id = o.id and r.answer = 'accepted' and r.picked_at is null))
               else 0 end,
    'no_takers', case when public.can('openjobs', 'edit') then
                   (select count(*) from public.job_offers o join public.bookings b on b.id = o.booking_id
                     where o.status = 'open' and b.status = 'booked' and exists (select 1 from public.openjobs_days(o.booking_id))
                       and not exists (select 1 from public.job_offer_recipients r where r.offer_id = o.id and r.answer is distinct from 'declined'))
                 else 0 end);
end $$;

revoke all on function public.openjobs_pick(uuid, uuid) from public, anon;
grant execute on function public.openjobs_pick(uuid, uuid) to authenticated;

-- ================================================================ 3. job checklists: no partner emails
update public.wf_emails set status = 'cancelled' where kind = 'partner' and status = 'waiting';
update public.workflow_steps set partner_email = false where partner_email;
alter table public.workflow_steps add constraint workflow_steps_no_partner_email check (not partner_email);
comment on column public.workflow_steps.partner_email is 'Always false since 2026-10-23: checklist steps never email the partner (hub messages cover that).';

-- ================================================================ 4. partner terms: percent, deliverables or nothing
alter table public.partner_terms
  add column payout_kind text not null default 'percent' check (payout_kind in ('percent', 'deliverables', 'none')),
  add column gets text not null default '' check (length(gets) <= 200);
comment on column public.partner_terms.payout_kind is 'percent = payout_pct of sales; deliverables = they get something instead (gets, e.g. action photos), no money; none = nothing.';

-- Only percent terms pay money (a job's own percent or amount still wins). Same columns as before.
create or replace view public.job_results_calc with (security_invoker = true) as
with base as (
  select r.*,
         coalesce(r.manual_sales, r.gp_sales) as sales,
         coalesce(r.manual_orders, r.gp_orders) as orders,
         coalesce(r.payout_pct, case when t.payout_kind = 'percent' then t.payout_pct end, 0) as pct,
         case when r.payout_pct is not null then 'job' when t.org_id is not null then 'partner' else 'none' end as pct_source,
         coalesce(p.paid, 0) as paid, p.last_paid_on
    from public.job_results r
    left join public.partner_terms t on t.org_id = r.org_id
    left join (select gotphoto_job_id, sum(amount) as paid, max(paid_on) as last_paid_on
                 from public.job_payments group by gotphoto_job_id) p on p.gotphoto_job_id = r.gotphoto_job_id
), due as (
  select b.*, coalesce(b.payout_amount, round(coalesce(b.sales, 0) * b.pct / 100, 2)) as due from base b
)
select d.*,
       greatest(d.due - d.paid, 0) as balance,
       case when d.sales is null and d.payout_amount is null and d.pct > 0 and d.paid = 0 then 'waiting'
            when d.due <= 0 and d.paid = 0 then 'none'
            when d.paid >= d.due - 0.005 then 'paid'
            else 'owed' end as payout_state,
       public.results_season(d.picture_day) as season,
       public.results_season_year(d.picture_day) as season_year
  from due d;
revoke all on public.job_results_calc from anon, authenticated;
grant select on public.job_results_calc to authenticated;

-- The last day of the season a picture day falls in (winter = Dec-Feb, spring = Mar-May, summer = Jun-Jul, fall = Aug-Nov).
create function public.results_season_end(d date) returns date
language sql immutable set search_path = '' as $$
  select case public.results_season(d)
           when 'winter' then make_date(public.results_season_year(d), 3, 1) - 1
           when 'spring' then make_date(extract(year from d)::int, 6, 1) - 1
           when 'summer' then make_date(extract(year from d)::int, 8, 1) - 1
           else make_date(extract(year from d)::int, 12, 1) - 1 end
$$;

-- Today: payouts owed for seasons that are over (Jeremiah checks once at season end and pays by check).
create or replace function public.results_attention() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not public.can('results', 'view') then null else (
    select jsonb_build_object('owed', count(*), 'total', coalesce(sum(c.balance), 0))
      from public.job_results_calc c
     where c.payout_state = 'owed' and public.results_season_end(c.picture_day) < (now() at time zone 'America/New_York')::date) end
$$;

create or replace function public.results_partners() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not public.can('results', 'view') then null else coalesce((
    select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'payout_pct', t.payout_pct, 'payout_kind', t.payout_kind, 'gets', coalesce(t.gets, ''),
                                        'note', coalesce(t.note, ''), 'jobs', (select count(*) from public.job_results r where r.org_id = o.id))
                     order by lower(o.name))
      from public.prospect_orgs o
      left join public.partner_terms t on t.org_id = o.id
     where t.org_id is not null or o.client_since is not null or coalesce(o.job_count, 0) > 0
        or exists (select 1 from public.job_results r where r.org_id = o.id)), '[]'::jsonb) end
$$;

-- A partner's terms. p_kind null removes them (their jobs then pay nothing unless set per job).
drop function public.results_set_terms(uuid, numeric, text);
create function public.results_set_terms(p_org uuid, p_pct numeric, p_note text default '', p_kind text default 'percent', p_gets text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('results', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_kind is null or (p_kind = 'percent' and p_pct is null) then
    delete from public.partner_terms where org_id = p_org;
    return jsonb_build_object('ok', true, 'removed', true);
  end if;
  if p_kind not in ('percent', 'deliverables', 'none') then raise exception 'Pick a percent, deliverables or nothing.'; end if;
  if p_kind = 'percent' and (p_pct < 0 or p_pct > 100) then raise exception 'The share is 0 to 100 percent.'; end if;
  insert into public.partner_terms (org_id, payout_pct, note, payout_kind, gets)
  values (p_org, case when p_kind = 'percent' then p_pct else 0 end, left(coalesce(p_note, ''), 500), p_kind,
          case when p_kind = 'deliverables' then left(btrim(coalesce(p_gets, '')), 200) else '' end)
  on conflict (org_id) do update set payout_pct = excluded.payout_pct, note = excluded.note, payout_kind = excluded.payout_kind, gets = excluded.gets;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.results_set_terms(uuid, numeric, text, text, text) from public, anon;
grant execute on function public.results_set_terms(uuid, numeric, text, text, text) to authenticated;

-- ================================================================ 5. notifications: Push now / Morning email / Off
alter table public.push_topics add column default_mode text not null default 'push' check (default_mode in ('push', 'email', 'off'));
alter table public.push_prefs add column mode text check (mode in ('push', 'email', 'off'));
update public.push_prefs set mode = case when enabled then 'push' else 'off' end where mode is null;
comment on column public.push_prefs.mode is 'push = right away, email = waits for the morning email, off. enabled = mode <> off (older code reads it).';

-- Defaults: things that can't wait push; the rest wait for the morning email; kinds that started off stay off.
-- A person's own choice wins.
update public.push_topics set default_mode = 'off' where not default_on;
update public.push_topics set default_mode = 'email'
 where default_on and key in ('makeup_new', 'retake_new', 'outreach_review', 'agreement_accepted', 'clearance_warning', 'checklist_late',
               'gear_overdue', 'timeoff_request', 'overtime_warning', 'expense_update', 'job_offer_reply');

-- One person's mode for one kind (null for an unknown kind: send it).
create function public.push_mode(p_uid uuid, p_topic text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(p.mode, case when p.user_id is not null then case when p.enabled then 'push' else 'off' end end, t.default_mode)
    from public.push_topics t
    left join public.push_prefs p on p.user_id = p_uid and p.topic = t.key
   where t.key = p_topic
$$;

create table public.push_digest (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.team_members (user_id) on delete cascade,
  topic      text not null,
  title      text not null,
  body       text not null default '',
  url        text not null default '/',
  tag        text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
comment on table public.push_digest is 'Notifications a person set to Morning email, waiting for admin_morning_digest.';
create index push_digest_open_idx on public.push_digest (user_id, created_at) where sent_at is null;
alter table public.push_digest enable row level security;   -- no policies: functions only

-- push_notify: a person-targeted push follows that person's mode; a push to everyone who can see the kind also
-- queues a morning-email copy for the people who set it to Morning email (push_claim skips them for the push).
create or replace function public.push_notify(p_topic text, p_title text, p_body text default '', p_url text default '/', p_tag text default null, p_target_user uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_mode text;
begin
  if p_target_user is not null then
    v_mode := public.push_mode(p_target_user, p_topic);
    if v_mode = 'off' then return; end if;
    if v_mode = 'email' then
      if p_tag is null or not exists (select 1 from public.push_digest d where d.user_id = p_target_user and d.tag = p_tag and d.sent_at is null) then
        insert into public.push_digest (user_id, topic, title, body, url, tag)
        values (p_target_user, p_topic, left(p_title, 120), left(coalesce(p_body, ''), 300), coalesce(p_url, '/'), p_tag);
      end if;
      return;
    end if;
  else
    insert into public.push_digest (user_id, topic, title, body, url, tag)
    select m.user_id, p_topic, left(p_title, 120), left(coalesce(p_body, ''), 300), coalesce(p_url, '/'), p_tag
      from public.team_members m join public.push_topics t on t.key = p_topic
     where (m.active or exists (select 1 from public.admin_users a where a.user_id = m.user_id))
       and public.team_user_can(m.user_id, t.module) and public.push_mode(m.user_id, p_topic) = 'email'
       and (p_tag is null or not exists (select 1 from public.push_digest d where d.user_id = m.user_id and d.tag = p_tag and d.sent_at is null));
  end if;
  if p_tag is not null and exists (select 1 from public.push_outbox o
                                    where o.tag = p_tag and o.sent_at is null and o.created_at > now() - interval '10 minutes'
                                      and o.target_user is not distinct from p_target_user) then
    return;
  end if;
  insert into public.push_outbox (topic, title, body, url, tag, target_user)
  values (p_topic, left(p_title, 120), left(coalesce(p_body, ''), 300), coalesce(p_url, '/'), p_tag, p_target_user);
  perform public.push_poke();
end $$;

-- push_claim: a push to everyone goes to the devices of people who set the kind to Push now.
create or replace function public.push_claim(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with c as (
    update public.push_outbox o set claimed_at = now(), attempts = attempts + 1
     where o.id in (select id from public.push_outbox
                     where sent_at is null and attempts < 5 and (claimed_at is null or claimed_at < now() - interval '2 minutes')
                     order by created_at limit greatest(1, least(coalesce(p_limit, 20), 100))
                     for update skip locked)
    returning o.*)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'title', c.title, 'body', c.body, 'url', c.url, 'tag', c.tag,
           'subs', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
                      from public.push_subscriptions s
                      join public.team_members m on m.user_id = s.user_id
                     where (m.active or exists (select 1 from public.admin_users a where a.user_id = m.user_id))
                       and case when c.target_user is not null then s.user_id = c.target_user
                                else exists (select 1 from public.push_topics t
                                              where t.key = c.topic and public.team_user_can(s.user_id, t.module)
                                                and public.push_mode(s.user_id, t.key) = 'push')
                           end))), '[]'::jsonb)
    into v from c;
  return v;
end $$;

create or replace function public.push_my_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'vapid_public', (select decrypted_secret from vault.decrypted_secrets where name = 'push_vapid_public'),
    'topics', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key, 'label', t.label, 'description', t.description,
                 'mode', public.push_mode(v_uid, t.key), 'enabled', public.push_mode(v_uid, t.key) = 'push') order by t.sort), '[]'::jsonb)
                 from public.push_topics t where public.team_user_can(v_uid, t.module)),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label, 'endpoint', s.endpoint, 'created_at', s.created_at, 'last_ok_at', s.last_ok_at) order by s.created_at), '[]'::jsonb)
                  from public.push_subscriptions s where s.user_id = v_uid));
end $$;

create function public.push_set_mode(p_topic text, p_mode text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.push_topics where key = p_topic) then raise exception 'unknown notification type'; end if;
  if p_mode is null or p_mode not in ('push', 'email', 'off') then raise exception 'Pick Push now, Morning email or Off.'; end if;
  insert into public.push_prefs (user_id, topic, enabled, mode) values ((select auth.uid()), p_topic, p_mode <> 'off', p_mode)
  on conflict (user_id, topic) do update set enabled = excluded.enabled, mode = excluded.mode;
end $$;

-- The old on/off switch (older app builds): on = Push now, off = Off.
create or replace function public.push_set_pref(p_topic text, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.push_set_mode(p_topic, case when coalesce(p_enabled, true) then 'push' else 'off' end);
end $$;

revoke all on function public.push_mode(uuid, text) from public, anon, authenticated;
revoke all on function public.push_set_mode(text, text) from public, anon;
grant execute on function public.push_set_mode(text, text) to authenticated;

-- ---------------------------------------------------------------- the morning email
-- Each module's Today check, run as one person (so the counts match their own Today page). Sentences are the
-- app's (registerAttention). edit = only for people with Edit on the module.
create function public.digest_today_items(p_uid uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev text := current_setting('request.jwt.claims', true);
  v_prev_sub text := current_setting('request.jwt.claim.sub', true);
  v_out jsonb := '[]'::jsonb; d jsonb; x record; n int;
begin
  -- aal2: can() goes through admin_session_ok(), which refuses anything less. auth.uid() reads claim.sub first.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  for x in select * from (values
      ('admin_deliverables_attention', 'overdue',      'bookings',     false, 'warn', 'A deliverable is past its due date.', '{n} deliverables are past their due date.', '#jobs/bookings'),
      ('crew_attention',               'mine',         null,           false, 'warn', 'You were put on a job. Confirm it or say you can''t make it.', 'You were put on {n} jobs. Confirm them or say you can''t make it.', '#staff/crew'),
      ('crew_attention',               'waiting',      'scheduling',   false, 'soon', 'Someone on a job this week hasn''t confirmed yet.', '{n} people on jobs this week haven''t confirmed yet.', '#staff/schedule'),
      ('crew_attention',               'timeoff',      'timeoff',      true,  'warn', 'A time off request is waiting for you.', '{n} time off requests are waiting for you.', '#staff/timeoff'),
      ('email_attention',              'problems',     'emails',       false, 'warn', 'An email bounced in the last two weeks.', '{n} emails bounced in the last two weeks.', '#partners/delivery'),
      ('inventory_attention',          'past_due',     'inventory',    false, 'warn', 'Something is past due back.', '{n} things are past due back.', '#ops/invout'),
      ('inventory_attention',          'needs_repair', 'inventory',    false, 'soon', 'A piece of gear is broken or at repair.', '{n} pieces of gear are broken or at repair.', '#ops/inventory'),
      ('inventory_attention',          'service_due',  'inventory',    false, 'soon', 'A piece of gear is due for service in the next two weeks.', '{n} pieces of gear are due for service in the next two weeks.', '#ops/invgear'),
      ('openjobs_attention',           'waiting',      'openjobs',     false, 'warn', 'A job was offered to you. Say if you''re available.', '{n} jobs were offered to you. Say if you''re available.', '#staff/openjobs'),
      ('openjobs_attention',           'to_pick',      'openjobs',     true,  'warn', 'People said they''re available for an open job. Pick who gets it.', '{n} open jobs have people available. Pick who gets them.', '#staff/openjobs'),
      ('openjobs_attention',           'no_takers',    'openjobs',     true,  'soon', 'Nobody can make an open job. Offer it to more people or staff it yourself.', 'Nobody can make {n} open jobs.', '#staff/openjobs'),
      ('partner_rebook_attention',     'due',          'partners',     false, 'soon', 'A past client is due to rebook. Last year''s date is coming up.', '{n} past clients are due to rebook. Last year''s dates are coming up.', '#partners/rebook'),
      ('agreements_attention',         'coi',          'agreements',   false, 'warn', 'An insurance certificate on file expires within 30 days.', '{n} insurance certificates on file expire within 30 days.', '#partners/agreements'),
      ('agreements_attention',         'renew',        'agreements',   false, 'soon', 'An agreement renews within 30 days.', '{n} agreements renew within 30 days.', '#partners/agreements'),
      ('results_attention',            'owed',         'results',      false, 'soon', 'A partner payout is owed for a season that is over.', '{n} partner payouts are owed for seasons that are over.', '#jobs/payouts'),
      ('schedule_attention',           'unstaffed',    'scheduling',   false, 'soon', 'A job in the next two weeks has nobody on the schedule.', '{n} jobs in the next two weeks have nobody on the schedule.', '#staff/schedule'),
      ('staff_records_attention',      'school',       'staffrecords', false, 'err',  'Someone on a school job in the next 30 days isn''t cleared.', '{n} people on school jobs in the next 30 days aren''t cleared.', '#staff/clearances'),
      ('staff_records_attention',      'expiring',     'staffrecords', false, 'soon', 'A staff clearance runs out soon or has run out.', '{n} staff clearances run out soon or have run out.', '#staff/clearances'),
      ('staff_records_attention',      'onboarding',   'staffrecords', false, 'soon', 'A new person is still working through onboarding.', '{n} new people are still working through onboarding.', '#staff/onboarding'),
      ('timeclock_attention',          'open_long',    'timeclock',    false, 'warn', 'A clock has been running for more than 12 hours. Someone probably forgot to clock out.', '{n} clocks have been running for more than 12 hours.', '#staff/timesheets'),
      ('timeclock_attention',          'review',       'timeclock',    false, 'warn', 'A clock was stopped at midnight. Check its clock-out time.', '{n} clocks were stopped at midnight. Check their clock-out times.', '#staff/timesheets'),
      ('timeclock_attention',          'to_approve',   'timeclock',    true,  'soon', 'A timesheet from last week is waiting for approval.', '{n} timesheets from last week are waiting for approval.', '#staff/timesheets'),
      ('timeclock_attention',          'expenses',     'timeclock',    true,  'soon', 'An expense is waiting for approval.', '{n} expenses are waiting for approval.', '#staff/expenses'),
      ('timeclock_attention',          'near_ot',      'timeclock',    true,  'soon', 'Someone is close to overtime this week.', '{n} people are close to overtime this week.', '#staff/timesheets'),
      ('workflow_attention',           'overdue',      'workflows',    false, 'warn', 'A job checklist task is overdue.', '{n} job checklist tasks are overdue.', '#jobs/checklists')
    ) v(fn, k, module, edit, level, one, many, url) loop
    continue when x.module is not null and not public.team_user_can(p_uid, x.module);
    continue when x.edit and not public.can(coalesce(x.module, 'scheduling'), 'edit');
    continue when to_regprocedure('public.' || x.fn || '()') is null;
    begin
      execute format('select public.%I()', x.fn) into d;
      n := coalesce((d ->> x.k)::int, 0);
    exception when others then n := 0;
    end;
    if n > 0 then
      v_out := v_out || jsonb_build_object('n', n, 'level', x.level, 'u', x.url,
                                           't', case when n = 1 then x.one else replace(x.many, '{n}', n::text) end);
    end if;
  end loop;
  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true); perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
  return v_out;
exception when others then
  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true); perform set_config('request.jwt.claim.sub', coalesce(v_prev_sub, ''), true);
  raise warning 'digest_today_items: %', sqlerrm;
  return v_out;
end $$;
revoke all on function public.digest_today_items(uuid) from public, anon, authenticated;

-- The 7am email. Digest recipients (Settings) get the shared Today summary (the original items) plus their own
-- module items; everyone gets the notifications they set to Morning email. One email per person.
create or replace function public.admin_morning_digest(p_force boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  a      public.admin_settings%rowtype;
  v_key  text;
  v_now  timestamp := now() at time zone 'America/New_York';
  v_today date := (now() at time zone 'America/New_York')::date;
  fix    jsonb := '[]'::jsonb;
  wait   jsonb := '[]'::jsonb;
  soon   jsonb := '[]'::jsonb;
  n int; v_req bigint; v_next record; b jsonb;
  p record; v_mine jsonb; v_queued jsonb; v_f jsonb; v_w jsonb; v_s jsonb; n_fix int; n_wait int;
  v_text text; v_html text; v_subject text; v_lead text; v_sent int := 0; v_to text[] := '{}'; v_ids bigint[];
  g record; it jsonb;
begin
  if p_force and not public.is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if not p_force and session_user not in ('postgres', 'supabase_admin') and not public.is_admin() then return jsonb_build_object('ok', false, 'error', 'not_allowed'); end if;
  select * into a from public.admin_settings where id;
  if not p_force then
    if a.digest_last_sent_on = v_today or v_now::time < a.digest_time then return jsonb_build_object('ok', true, 'sent', 0); end if;
  end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_key is null then return jsonb_build_object('ok', false, 'error', 'no_resend_key'); end if;

  -- the shared summary (unchanged from before)
  select count(*) into n from booking_emails e join bookings bk on bk.id = e.booking_id where e.status = 'failed' and bk.status = 'booked';
  if n > 0 then fix := fix || jsonb_build_object('n', n, 't', case when n = 1 then 'A booking email failed to send.' else n || ' booking emails failed to send.' end, 'u', '#partners/outbox'); end if;
  if exists (select 1 from sync_runs order by started_at desc limit 1) and (select ok from sync_runs order by started_at desc limit 1) = false then
    fix := fix || jsonb_build_object('n', 1, 't', 'GotPhoto sync is failing. It retries every 5 minutes; codes on Find My Photos may be stale.', 'u', '#system/health'); end if;
  b := public.admin_bookings_attention_internal();
  n := coalesce((b->>'no_contact')::int, 0); if n > 0 then wait := wait || jsonb_build_object('n', n, 't', case when n = 1 then 'A booking has nobody to email.' else n || ' bookings have nobody to email.' end, 'u', '#jobs/bookings'); end if;
  n := coalesce((b->>'needs_code')::int, 0); if n > 0 then wait := wait || jsonb_build_object('n', n, 't', case when n = 1 then 'A school booking needs its access code.' else n || ' school bookings need their access code.' end, 'u', '#jobs/bookings'); end if;
  n := coalesce((b->>'needs_job')::int, 0); if n > 0 then wait := wait || jsonb_build_object('n', n, 't', case when n = 1 then 'A sports booking is waiting for its GotPhoto job.' else n || ' sports bookings are waiting for their GotPhoto job.' end, 'u', '#jobs/bookings'); end if;
  select count(*) into n from prospect_scheduled_emails where status = 'scheduled' and needs_review;
  if n > 0 then wait := wait || jsonb_build_object('n', n, 't', case when n = 1 then 'An outreach email is waiting for your review.' else n || ' outreach emails are waiting for your review.' end, 'u', '#partners/outbox'); end if;
  select count(*) into n from lookup_requests where status = 'pending';
  if n > 0 then wait := wait || jsonb_build_object('n', n, 't', case when n = 1 then 'A parent asked for help finding a code.' else n || ' parents asked for help finding a code.' end, 'u', '#parents/requests'); end if;
  select count(*) into n from makeup_bookings m where m.dismissed_at is null and m.sent_at is null and m.makeup_at < now();
  if n > 0 then wait := wait || jsonb_build_object('n', n, 't', case when n = 1 then 'A makeup to confirm and send.' else n || ' makeups to confirm and send.' end, 'u', '#parents/makeups'); end if;
  select count(*) into n from prospect_followups where status = 'open' and due_on <= v_today;
  if n > 0 then soon := soon || jsonb_build_object('n', n, 't', case when n = 1 then 'A prospect follow-up is due.' else n || ' prospect follow-ups are due.' end, 'u', '#partners/orgs'); end if;
  select count(*) into n from hub_sends_all() s
   where s.send_date < v_today and v_today < s.late_until and not s.estimate
     and not exists (select 1 from hub_events e where e.hub = s.hub and e.org_id = s.org_id and e.send_key = s.send_key);
  if n > 0 then soon := soon || jsonb_build_object('n', n, 't', case when n = 1 then 'A team or school hasn''t grabbed its hub message yet.' else n || ' teams or schools haven''t grabbed their hub messages yet.' end, 'u', '#jobs/hubact'); end if;
  n := coalesce((b->>'calendar')::int, 0); if n > 0 then soon := soon || jsonb_build_object('n', n, 't', case when n = 1 then 'A booking is out of step with Google Calendar.' else n || ' bookings are out of step with Google Calendar.' end, 'u', '#jobs/bookings'); end if;
  select count(*) into n from synced_jobs where status = 'published' and coalesce(array_length(missing_fields, 1), 0) > 0 and coalesce(hide_override, false) = false;
  if n > 0 then soon := soon || jsonb_build_object('n', n, 't', case when n = 1 then 'A published gallery is missing search fields.' else n || ' published galleries are missing search fields.' end, 'u', '#jobs/jobs'); end if;
  b := public.retake_digest_entries();
  wait := wait || coalesce(b->'wait', '[]'::jsonb);
  soon := soon || coalesce(b->'soon', '[]'::jsonb);
  select bk.picture_day, coalesce(o.name, bk.title_override, bk.title_label) as org into v_next
    from bookings bk left join prospect_orgs o on o.id = bk.org_id
   where bk.status = 'booked' and bk.picture_day >= v_today order by bk.picture_day limit 1;

  -- who gets an email: digest recipients (when it's on), and anyone with Morning email notifications waiting
  for p in
    select distinct on (x.email) x.email, x.user_id, x.summary from (
      select lower(r) as email, (select u.id from auth.users u where lower(u.email) = lower(r) limit 1) as user_id, true as summary
        from unnest(case when a.digest_enabled or p_force then coalesce(a.digest_recipients, '{}') else '{}' end) r
      union all
      select lower(u.email), u.id, false from auth.users u
       where not p_force and exists (select 1 from public.push_digest d where d.user_id = u.id and d.sent_at is null)
    ) x where x.email is not null order by x.email, x.summary desc
  loop
    v_mine := case when p.user_id is not null then public.digest_today_items(p.user_id) else '[]'::jsonb end;
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 't', d.title || case when d.body <> '' then ': ' || d.body else '' end, 'u', ltrim(d.url, '/')) order by d.created_at), '[]'::jsonb),
           array_agg(d.id)
      into v_queued, v_ids
      from public.push_digest d where d.user_id = p.user_id and d.sent_at is null;
    if not p.summary and jsonb_array_length(v_queued) = 0 then continue; end if;

    v_f := case when p.summary then fix else '[]'::jsonb end || coalesce((select jsonb_agg(i) from jsonb_array_elements(v_mine) i where i ->> 'level' = 'err'), '[]'::jsonb);
    v_w := case when p.summary then wait else '[]'::jsonb end || coalesce((select jsonb_agg(i) from jsonb_array_elements(v_mine) i where i ->> 'level' = 'warn'), '[]'::jsonb);
    v_s := case when p.summary then soon else '[]'::jsonb end || coalesce((select jsonb_agg(i) from jsonb_array_elements(v_mine) i where i ->> 'level' = 'soon'), '[]'::jsonb);
    n_fix := (select coalesce(sum((i->>'n')::int), 0) from jsonb_array_elements(v_f) i);
    n_wait := (select coalesce(sum((i->>'n')::int), 0) from jsonb_array_elements(v_w) i);

    v_subject := to_char(v_today, 'FMDay') || ' at 207 Photo: ' ||
      case when n_fix + n_wait = 0 then 'nothing needs you' when n_fix + n_wait = 1 then '1 thing needs you' else (n_fix + n_wait) || ' things need you' end;
    v_lead := case when n_fix > 0 then n_fix || case when n_fix = 1 then ' thing is broken' else ' things are broken' end || ', ' else '' end ||
              case when n_wait > 0 then n_wait || case when n_wait = 1 then ' is waiting on you' else ' are waiting on you' end else 'nothing is waiting on you' end ||
              case when v_next.picture_day is not null then ', and the next picture day is ' || to_char(v_next.picture_day, 'FMDay, FMMon FMDD') || ' with ' || v_next.org else '' end || '.';
    v_text := v_lead || E'\n\n';
    v_html := '<p style="font-size:16px">' || replace(replace(v_lead, '&', '&amp;'), '<', '&lt;') || '</p>';
    for g in select * from (values (1, 'Fix now', v_f), (2, 'Waiting on you', v_w), (3, 'Check soon', v_s), (4, 'Since yesterday', v_queued)) gg(ord, title, items) order by ord loop
      if jsonb_array_length(g.items) = 0 then continue; end if;
      v_text := v_text || upper(g.title) || E'\n';
      v_html := v_html || '<h3 style="margin:18px 0 6px;font-size:14px">' || g.title || '</h3><ul style="margin:0;padding-left:20px">';
      for it in select * from jsonb_array_elements(g.items) loop
        v_text := v_text || '- ' || (it->>'t') || E'\n';
        v_html := v_html || '<li style="margin:4px 0"><a href="https://admin.207photo.com/' || replace(coalesce(it->>'u', ''), '"', '') || '" style="color:#1f1e1b">' || replace(replace(it->>'t', '&', '&amp;'), '<', '&lt;') || '</a></li>';
      end loop;
      v_text := v_text || E'\n';
      v_html := v_html || '</ul>';
    end loop;
    v_text := v_text || 'Open 207 Admin: https://admin.207photo.com/';
    v_html := '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1e1b;max-width:560px">' || v_html ||
              '<p style="margin-top:22px;font-size:13px;color:#6b675f">This is your Today page from <a href="https://admin.207photo.com/" style="color:#6b675f">207 Admin</a>. ' ||
              '"Since yesterday" lists the notifications you set to Morning email (change that under Notifications). Who gets the summary is under Settings.</p></div>';

    select net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := jsonb_build_object('from', '207 Admin <alerts@207photo.com>', 'to', jsonb_build_array(p.email), 'subject', v_subject, 'text', v_text, 'html', v_html),
      timeout_milliseconds := 25000) into v_req;
    if not p_force and v_ids is not null then update public.push_digest set sent_at = now() where id = any (v_ids); end if;
    v_sent := v_sent + 1; v_to := v_to || p.email::text;
  end loop;

  if p_force and v_sent = 0 then return jsonb_build_object('ok', false, 'error', 'no_recipients'); end if;
  update public.admin_settings set digest_last_sent_on = case when p_force then digest_last_sent_on else v_today end, digest_request_id = coalesce(v_req, digest_request_id), updated_at = now() where id;
  delete from public.push_digest where sent_at < now() - interval '30 days';
  return jsonb_build_object('ok', true, 'sent', v_sent, 'to', to_jsonb(v_to), 'subject', v_subject);
end $$;
