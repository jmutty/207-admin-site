-- Polish pass tests (20261023200000_polish). Run on a NON-production schema copy after every migration of this
-- release (README order); everything is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/polish_test.sql
begin;

create function pg_temp.act(p_uid uuid, p_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role, 'aal', 'aal2')::text, true);
  execute format('set local role %I', p_role);
end $$;
create function pg_temp.ok(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok  %', p_what;
end $$;
create function pg_temp.raises(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok  % (refused: %)', p_what, sqlerrm; return; end;
  raise exception 'FAILED: % (was allowed)', p_what;
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- o = owner, m = manager (Open jobs + results edit), p1 / p2 = part-timers (Open jobs view)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a0', 'o@example.com'), ('00000000-0000-0000-0000-0000000000a1', 'm@example.com'),
  ('00000000-0000-0000-0000-0000000000a2', 'p1@example.com'), ('00000000-0000-0000-0000-0000000000a3', 'p2@example.com');
insert into public.admin_users values ('00000000-0000-0000-0000-0000000000a0') on conflict do nothing;
insert into public.team_members (user_id, display_name, employment_type, home_address, max_drive_min) values
  ('00000000-0000-0000-0000-0000000000a0', 'Owner', 'salaried', '', 60),
  ('00000000-0000-0000-0000-0000000000a1', 'Manager Person', 'full_time', '', 60),
  ('00000000-0000-0000-0000-0000000000a2', 'Pat One', 'part_time', '1 Elm St, Bangor ME', 45),
  ('00000000-0000-0000-0000-0000000000a3', 'Riley Two', 'contractor', '2 Oak St, Ellsworth ME', 45)
on conflict (user_id) do update set employment_type = excluded.employment_type, home_address = excluded.home_address, max_drive_min = excluded.max_drive_min;
insert into public.team_permissions values
  ('00000000-0000-0000-0000-0000000000a1', 'openjobs', 'edit'), ('00000000-0000-0000-0000-0000000000a1', 'results', 'edit'),
  ('00000000-0000-0000-0000-0000000000a2', 'openjobs', 'view'), ('00000000-0000-0000-0000-0000000000a3', 'openjobs', 'view');
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('00000000-0000-0000-0000-0000000000a2', 'https://push.example/p1', 'k', 'a'), ('00000000-0000-0000-0000-0000000000a1', 'https://push.example/m', 'k', 'a');

insert into public.booking_types (key, label, default_duration_min) values ('school', 'School Photos', 120) on conflict do nothing;
insert into public.bookings (id, type_key, title_override, status, picture_day, location) values
  ('00000000-0000-0000-0000-0000000000b1', 'school', 'Hampden Academy', 'booked', current_date + 5, '89 Western Ave, Hampden ME');
insert into public.booking_days (booking_id, day, start_at, end_at, sort) values
  ('00000000-0000-0000-0000-0000000000b1', current_date + 5, (current_date + 5 + time '09:00') at time zone 'America/New_York', (current_date + 5 + time '12:00') at time zone 'America/New_York', 0);
update public.bookings set time_set = true, end_set = true, start_at = (current_date + 5 + time '09:00') at time zone 'America/New_York',
  end_at = (current_date + 5 + time '12:00') at time zone 'America/New_York' where id = '00000000-0000-0000-0000-0000000000b1';

-- ---------------------------------------------------------------- 1. picture day planner off
select pg_temp.ok(not exists (select 1 from public.app_modules where key = 'pictureday'), 'picture day module is gone');
select pg_temp.ok(not exists (select 1 from public.push_topics where key in ('pd_intake', 'pd_move')), 'picture day notifications are gone');
select pg_temp.ok(not exists (select 1 from cron.job where jobname = 'pd-email-send'), 'picture day email cron is gone');
select pg_temp.act(null, 'anon');
select pg_temp.raises($$select public.pd_public_plan('x')$$, 'public picture day form is closed');
reset role;

-- ---------------------------------------------------------------- 2. ask who's available, the manager picks
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select public.offer_drive_store('89 Western Ave, Hampden ME', '[{"origin":"1 Elm St, Bangor ME","minutes":22},{"origin":"2 Oak St, Ellsworth ME","minutes":31}]');
create temp table t_offer as select public.openjobs_post('{"booking_id":"00000000-0000-0000-0000-0000000000b1","spots":1,
  "user_ids":["00000000-0000-0000-0000-0000000000a2","00000000-0000-0000-0000-0000000000a3"]}') r;
grant select on t_offer to authenticated;
create temp view v_offer as select (r ->> 'id')::uuid as id from t_offer;
grant select on v_offer to authenticated;

select pg_temp.act('00000000-0000-0000-0000-0000000000a2');
select pg_temp.ok((public.openjobs_answer((select id from v_offer), true) ->> 'answer') = 'accepted', 'Pat says they''re available');
select pg_temp.ok((public.openjobs_answer((select id from v_offer), false, 'Dentist') ->> 'answer') = 'declined', 'Pat can change their mind');
select pg_temp.ok((public.openjobs_answer((select id from v_offer), true) ->> 'answer') = 'accepted', '... and back');
reset role;
select pg_temp.ok(not exists (select 1 from public.schedule_entries where booking_id = '00000000-0000-0000-0000-0000000000b1'), 'saying yes puts nothing on the schedule');
select pg_temp.ok(exists (select 1 from public.push_digest where user_id = '00000000-0000-0000-0000-0000000000a1' and topic = 'job_offer_reply' and sent_at is null)
              and not exists (select 1 from public.push_outbox where topic = 'job_offer_reply' and sent_at is null),
              'the manager''s "who''s available" waits for the morning email by default');
select pg_temp.act('00000000-0000-0000-0000-0000000000a3');
select public.openjobs_answer((select id from v_offer), false, 'Too far');

select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.ok((public.openjobs_attention() ->> 'to_pick')::int = 1, 'Today: one open job to pick for');
select pg_temp.ok((select (o ->> 'yes')::int = 1 and (o ->> 'taken')::int = 0 from jsonb_array_elements(public.openjobs_list()) o where (o ->> 'id')::uuid = (select id from v_offer)), 'list: 1 available, none picked');
select pg_temp.raises(format('select public.openjobs_pick(%L, %L)', (select id from v_offer), '00000000-0000-0000-0000-0000000000a3'), 'cannot pick someone who can''t make it');
select pg_temp.act('00000000-0000-0000-0000-0000000000a2');
select pg_temp.raises(format('select public.openjobs_pick(%L, %L)', (select id from v_offer), '00000000-0000-0000-0000-0000000000a2'), 'a part-timer cannot pick');

select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
create temp table t_pick as select public.openjobs_pick((select id from v_offer), '00000000-0000-0000-0000-0000000000a2') r;
select pg_temp.ok((select (r ->> 'filled')::boolean and (r ->> 'scheduled')::int = 1 from t_pick), 'pick: one spot, filled, on the schedule');
select pg_temp.ok((public.openjobs_attention() ->> 'to_pick')::int = 0, 'Today: nothing left to pick');
reset role;
select pg_temp.ok((select count(*) from public.schedule_entries where user_id = '00000000-0000-0000-0000-0000000000a2' and booking_id = '00000000-0000-0000-0000-0000000000b1') = 1, 'Pat is on the schedule');
select pg_temp.ok((select status from public.job_offers where id = (select id from v_offer)) = 'filled', 'the offer is filled');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'job_offer' and target_user = '00000000-0000-0000-0000-0000000000a2' and title like 'You''ve got the job%'), 'Pat gets a push right away');

select pg_temp.act('00000000-0000-0000-0000-0000000000a2');
select pg_temp.raises(format('select public.openjobs_answer(%L, false)', (select id from v_offer)), 'once picked, they call the office instead');
select pg_temp.ok((select o -> 'mine' ->> 'picked_at' is not null from jsonb_array_elements(public.openjobs_mine() -> 'offers') o where (o ->> 'id')::uuid = (select id from v_offer)), 'Pat sees they were picked');
select pg_temp.act('00000000-0000-0000-0000-0000000000a3');
select pg_temp.ok((public.openjobs_answer((select id from v_offer), true) ->> 'error') = 'filled', 'Riley changes their mind, but it''s filled');
reset role;

-- ---------------------------------------------------------------- 3. job checklists: no partner emails
select pg_temp.ok(not exists (select 1 from public.workflow_steps where partner_email), 'no step emails the partner');
select pg_temp.ok(not exists (select 1 from public.wf_emails where kind = 'partner' and status = 'waiting'), 'no partner email is waiting');
select pg_temp.raises($$insert into public.workflow_steps (title, anchor, partner_email) values ('Send partner note', 'booked', true)$$, 'a step cannot be set to email the partner');

-- ---------------------------------------------------------------- 4. partner terms: percent, deliverables or nothing
insert into public.prospect_orgs (id, name, gotphoto_names) values
  ('00000000-0000-0000-0000-00000000a0a1', 'Brewer Youth Basketball', '{}'), ('00000000-0000-0000-0000-00000000a0a2', 'Hampden Rec', '{}');
insert into public.job_results (gotphoto_job_id, job_name, picture_day, org_id, org_set, gp_sales) values
  ('pt1', 'BYB | Last winter', make_date(extract(year from current_date)::int - 1, 1, 15), '00000000-0000-0000-0000-00000000a0a1', true, 1000),
  ('pt2', 'BYB | This week',   current_date,                                              '00000000-0000-0000-0000-00000000a0a1', true, 500),
  ('pt3', 'Hampden | Soccer',  make_date(extract(year from current_date)::int - 1, 10, 4), '00000000-0000-0000-0000-00000000a0a2', true, 800);
select pg_temp.ok(public.results_season_end('2026-01-17') = '2026-02-28' and public.results_season_end('2025-12-06') = '2026-02-28'
              and public.results_season_end('2025-10-04') = '2025-11-30' and public.results_season_end('2026-06-10') = '2026-07-31', 'season ends');

select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select public.results_set_terms('00000000-0000-0000-0000-00000000a0a1', 10, 'Partner Plan');
select public.results_set_terms('00000000-0000-0000-0000-00000000a0a2', null, '', 'deliverables', 'Action photos for the banquet');
select pg_temp.ok((select due = 100 and payout_state = 'owed' from public.job_results_calc where gotphoto_job_id = 'pt1'), 'percent: 10% of $1,000 owed');
select pg_temp.ok((select due = 0 and payout_state = 'none' from public.job_results_calc where gotphoto_job_id = 'pt3'), 'deliverables: no money owed');
select pg_temp.ok((select p ->> 'payout_kind' = 'deliverables' and p ->> 'gets' = 'Action photos for the banquet'
                     from jsonb_array_elements(public.results_partners()) p where p ->> 'name' = 'Hampden Rec'), 'partners list shows what they get');
select pg_temp.ok((public.results_attention() ->> 'owed')::int = 1 and (public.results_attention() ->> 'total')::numeric = 100, 'Today: only the payout from a season that is over');
select public.results_set_terms('00000000-0000-0000-0000-00000000a0a1', null, '', 'none');
select pg_temp.ok((select due = 0 from public.job_results_calc where gotphoto_job_id = 'pt1'), 'nothing: no money owed');
select pg_temp.raises($$select public.results_set_terms('00000000-0000-0000-0000-00000000a0a1', 10, '', 'cash')$$, 'unknown kind refused');
select public.results_set_terms('00000000-0000-0000-0000-00000000a0a1', null);
select pg_temp.ok(not exists (select 1 from public.partner_terms where org_id = '00000000-0000-0000-0000-00000000a0a1'), 'terms removed');
reset role;

-- ---------------------------------------------------------------- 5. notifications: Push now / Morning email / Off
select pg_temp.ok((select default_mode from public.push_topics where key = 'makeup_new') = 'email', 'makeups wait for the morning email by default');
select pg_temp.ok(not exists (select 1 from public.push_topics where not default_on and default_mode <> 'off'), 'kinds that started off stay off');

select pg_temp.act('00000000-0000-0000-0000-0000000000a2');
select pg_temp.ok((select t ->> 'mode' from jsonb_array_elements(public.push_my_settings() -> 'topics') t where t ->> 'key' = 'job_offer') = 'push', 'job offers push by default');
select public.push_set_mode('job_offer', 'email');
select pg_temp.ok((select t ->> 'mode' = 'email' and (t ->> 'enabled')::boolean = false from jsonb_array_elements(public.push_my_settings() -> 'topics') t where t ->> 'key' = 'job_offer'), 'set to Morning email');
select pg_temp.raises($$select public.push_set_mode('job_offer', 'sms')$$, 'no other modes');
select public.push_set_pref('job_offer', false);
select pg_temp.ok((select t ->> 'mode' from jsonb_array_elements(public.push_my_settings() -> 'topics') t where t ->> 'key' = 'job_offer') = 'off', 'the old switch still works');
select pg_temp.raises($$select public.push_mode('00000000-0000-0000-0000-0000000000a2', 'job_offer')$$, 'push_mode is internal');
reset role;

-- targeted: off sends nothing, email queues once per tag, push goes to the outbox
delete from public.push_outbox; delete from public.push_digest;
select public.push_notify('job_offer', 'Off test', '', '/', 'tag_off', '00000000-0000-0000-0000-0000000000a2');
select pg_temp.ok(not exists (select 1 from public.push_outbox) and not exists (select 1 from public.push_digest), 'off: nothing at all');
insert into public.push_prefs (user_id, topic, enabled, mode) values ('00000000-0000-0000-0000-0000000000a2', 'job_offer', true, 'email')
  on conflict (user_id, topic) do update set enabled = true, mode = 'email';
select public.push_notify('job_offer', 'Email test', 'Body', '/#staff/openjobs', 'tag_em', '00000000-0000-0000-0000-0000000000a2');
select public.push_notify('job_offer', 'Email test', 'Body', '/#staff/openjobs', 'tag_em', '00000000-0000-0000-0000-0000000000a2');
select pg_temp.ok((select count(*) from public.push_digest where tag = 'tag_em') = 1 and not exists (select 1 from public.push_outbox), 'email: queued once, no push');
-- to everyone: the manager (job_offer_reply = email by default) gets a digest copy and no device in the claim
select public.push_notify('job_offer_reply', 'Broadcast', '', '/', 'tag_all');
select pg_temp.ok(exists (select 1 from public.push_digest where tag = 'tag_all' and user_id = '00000000-0000-0000-0000-0000000000a1'), 'broadcast: Morning email people get a copy');
select pg_temp.ok((select jsonb_array_length(c -> 'subs') = 0 from jsonb_array_elements(public.push_claim(50)) c where c ->> 'tag' = 'tag_all'), 'broadcast: no push to Morning email people');

-- the morning email's Today items, run as each person
select pg_temp.ok(exists (select 1 from jsonb_array_elements(public.digest_today_items('00000000-0000-0000-0000-0000000000a3')) i where i ->> 't' like 'A job was offered%') is false, 'Riley has nothing waiting (they answered)');
update public.job_offers set status = 'open' where id = (select id from v_offer);
update public.job_offer_recipients set answer = null, answered_at = null where offer_id = (select id from v_offer) and user_id = '00000000-0000-0000-0000-0000000000a3';
select pg_temp.ok(exists (select 1 from jsonb_array_elements(public.digest_today_items('00000000-0000-0000-0000-0000000000a3')) i where i ->> 't' like 'A job was offered to you%'), 'Riley''s digest: a job is waiting on them');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements(public.digest_today_items('00000000-0000-0000-0000-0000000000a3')) i where i ->> 'u' = '#jobs/payouts'), 'Riley''s digest: no payouts (no results access)');
select pg_temp.ok(current_setting('request.jwt.claims', true) is distinct from '{"sub": "00000000-0000-0000-0000-0000000000a3", "role": "authenticated"}', 'digest puts the caller back');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.digest_today_items('00000000-0000-0000-0000-0000000000a1')$$, 'digest items are internal');
reset role;

do $$ begin raise notice 'ALL POLISH TESTS PASSED'; end $$;
rollback;
