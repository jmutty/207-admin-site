-- Tests for 20261023141500_timeclock_round_two (location, reminders, midnight clock-out, expenses, pay rates,
-- overtime warnings, job time). Run on a NON-production schema copy after the migration; everything is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/timeclock_round_two_test.sql
begin;

create function pg_temp.act(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', case when p_uid is null then '{"role":"anon"}'
    else json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', 'aal2')::text end, true);
  execute case when p_uid is null then 'set local role anon' else 'set local role authenticated' end;
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
grant execute on all functions in schema pg_temp to anon, authenticated;

-- o owner; e edits the time clock; v views it (full time, hourly); w views it (part time, day rate); n no time clock
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000002a1', 'o@example.com'), ('00000000-0000-0000-0000-0000000002e1', 'e@example.com'),
  ('00000000-0000-0000-0000-0000000002c1', 'v@example.com'), ('00000000-0000-0000-0000-0000000002c2', 'w@example.com'), ('00000000-0000-0000-0000-0000000002d1', 'n@example.com');
insert into public.admin_users (user_id) values ('00000000-0000-0000-0000-0000000002a1') on conflict do nothing;
insert into public.team_members (user_id, display_name, active, employment_type, job_title) values
  ('00000000-0000-0000-0000-0000000002a1', 'Owner Two', true, 'salaried', 'Owner'), ('00000000-0000-0000-0000-0000000002e1', 'Edit Two', true, 'full_time', ''),
  ('00000000-0000-0000-0000-0000000002c1', 'View Two', true, 'full_time', 'Lead photographer'), ('00000000-0000-0000-0000-0000000002c2', 'Wanda Day', true, 'part_time', 'Assistant'),
  ('00000000-0000-0000-0000-0000000002d1', 'No Two', true, 'full_time', '')
  on conflict (user_id) do update set display_name = excluded.display_name, employment_type = excluded.employment_type, job_title = excluded.job_title;
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000002e1', 'timeclock', 'edit'),
  ('00000000-0000-0000-0000-0000000002c1', 'timeclock', 'view'), ('00000000-0000-0000-0000-0000000002c2', 'timeclock', 'view'),
  ('00000000-0000-0000-0000-0000000002d1', 'bookings', 'view');
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('00000000-0000-0000-0000-0000000002c1', 'https://push.example.com/v', 'k', 'a'), ('00000000-0000-0000-0000-0000000002c2', 'https://push.example.com/w', 'k', 'a'),
  ('00000000-0000-0000-0000-0000000002e1', 'https://push.example.com/e', 'k', 'a');

insert into public.booking_types (key, label, audience) values ('tc2_test', 'TC2 test', 'school') on conflict do nothing;
insert into public.prospect_orgs (id, name, town) values ('00000000-0000-0000-0000-0000000002f1', 'Round Two Academy', 'Hampden');
insert into public.bookings (id, org_id, type_key, status, location, picture_day, start_at, end_at, time_set, end_set) values
  ('00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000002f1', 'tc2_test', 'booked', '89 Western Ave, Hampden ME',
   (now() at time zone 'America/New_York')::date, now() + interval '40 minutes', now() + interval '3 hours', true, true),
  ('00000000-0000-0000-0000-0000000002b2', '00000000-0000-0000-0000-0000000002f1', 'tc2_test', 'tracked', '1 Far Rd, Bethel ME',
   (now() at time zone 'America/New_York')::date, now() + interval '40 minutes', now() + interval '3 hours', true, true);

select pg_temp.ok((select remind_before_min = 15 and remind_out_after_min = 30 and auto_out and gps_on from public.timeclock_settings where id), 'settings defaults');

-- ---------------------------------------------------------------- access
select pg_temp.act('00000000-0000-0000-0000-0000000002d1');
select pg_temp.raises($$select public.expense_list(current_date)$$, 'no time clock: expenses refused');
select pg_temp.raises($$select public.timeclock_job('00000000-0000-0000-0000-0000000002b1')$$, 'no time clock: job time refused');
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select pg_temp.raises($$select public.timeclock_rates()$$, 'view: pay rates refused');
select pg_temp.raises($$select public.timeclock_rate_save('{"scope":"type","scope_key":"full_time","basis":"hourly","rate":99}')$$, 'view: setting a rate refused');
select pg_temp.raises($$select public.timeclock_settings_get()$$, 'view: settings refused');
select pg_temp.raises($$select public.expense_list(current_date, true)$$, 'view: everyone''s expenses refused');
select pg_temp.raises($$select * from public.timeclock_expenses$$, 'tables are not readable directly');
select pg_temp.act(null);
select pg_temp.raises($$select public.timeclock_in('studio')$$, 'anon refused');

-- ---------------------------------------------------------------- location on clock in / out
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select pg_temp.ok((public.timeclock_status() ->> 'gps')::boolean, 'status says to ask for location');
select public.timeclock_in('studio', null, 'x', '{"lat": 44.7449, "lng": -68.8370, "acc": 12.4}');
reset role;
select pg_temp.ok((select in_lat = 44.7449 and in_lng = -68.837 and in_acc = 12 from public.time_punches where user_id = '00000000-0000-0000-0000-0000000002c1' and clock_out is null), 'clock in keeps the location');
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select public.timeclock_in('admin', null, '', '{"lat": "nope", "lng": 500}');
reset role;
select pg_temp.ok((select in_lat is null and in_lng is null from public.time_punches where user_id = '00000000-0000-0000-0000-0000000002c1' and clock_out is null), 'a bad location is dropped, not refused');
select pg_temp.ok((select out_lat is null from public.time_punches where user_id = '00000000-0000-0000-0000-0000000002c1' and kind = 'studio'), 'switch with a bad location: no out location');
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select public.timeclock_out('', '{"lat": 44.8, "lng": -68.9, "acc": 30}');
reset role;
select pg_temp.ok((select out_lat = 44.8 and out_acc = 30 from public.time_punches where user_id = '00000000-0000-0000-0000-0000000002c1' and kind = 'admin'), 'clock out keeps the location');
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select pg_temp.ok((select (p -> 'out_loc' ->> 'lat')::numeric = 44.8 from jsonb_array_elements(public.timesheet_week(current_date) -> 'punches') p where p ->> 'kind' = 'admin'), 'timesheet shows the location');
select public.timeclock_in('other');
select public.timeclock_out();
select pg_temp.ok(true, 'old calls without a location still work');
reset role;
delete from public.time_punches where user_id = '00000000-0000-0000-0000-0000000002c1';

-- ---------------------------------------------------------------- reminders
-- v: a booked job starting in 40 min with 30 min drive = leave in 10 min -> reminder. w: same times on a track-only job -> none.
insert into public.schedule_entries (id, user_id, kind, booking_id, starts_at, ends_at, drive_before_min, drive_after_min) values
  ('00000000-0000-0000-0000-0000000002a8', '00000000-0000-0000-0000-0000000002c1', 'job', '00000000-0000-0000-0000-0000000002b1', now() + interval '40 minutes', now() + interval '3 hours', 30, 30),
  ('00000000-0000-0000-0000-0000000002a9', '00000000-0000-0000-0000-0000000002c2', 'job', '00000000-0000-0000-0000-0000000002b2', now() + interval '40 minutes', now() + interval '3 hours', 30, 30);
select public.timeclock_tick();
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'clock_reminder' and target_user = '00000000-0000-0000-0000-0000000002c1' and title like 'Clock in at %'), 'clock-in reminder pushed');
select pg_temp.ok(not exists (select 1 from public.push_outbox where topic = 'clock_reminder' and target_user = '00000000-0000-0000-0000-0000000002c2'), 'no reminder for a booking that isn''t booked');
select public.timeclock_tick();
select pg_temp.ok((select count(*) from public.push_outbox where topic = 'clock_reminder' and target_user = '00000000-0000-0000-0000-0000000002c1') = 1, 'one reminder per bar');
-- switched off: no push
insert into public.push_prefs values ('00000000-0000-0000-0000-0000000002c2', 'clock_reminder', false);
-- clock-out reminder: v clocked in to a bar that ended (with drive time) 45 min ago
insert into public.schedule_entries (id, user_id, kind, starts_at, ends_at, title) values
  ('00000000-0000-0000-0000-0000000002aa', '00000000-0000-0000-0000-0000000002c2', 'studio', now() - interval '4 hours', now() - interval '45 minutes', 'Editing');
insert into public.time_punches (user_id, user_name, kind, clock_in) values ('00000000-0000-0000-0000-0000000002c2', 'Wanda Day', 'studio', now() - interval '4 hours');
select public.timeclock_tick();
select pg_temp.ok(exists (select 1 from public.timeclock_reminders where entry_id = '00000000-0000-0000-0000-0000000002aa' and kind = 'out'), 'clock-out reminder due');
select pg_temp.ok(not exists (select 1 from public.push_outbox where target_user = '00000000-0000-0000-0000-0000000002c2' and title = 'Still clocked in?'), 'but not pushed when that kind is switched off');
delete from public.push_prefs where user_id = '00000000-0000-0000-0000-0000000002c2';
delete from public.time_punches where user_id = '00000000-0000-0000-0000-0000000002c2';

-- ---------------------------------------------------------------- midnight clock-out
insert into public.time_punches (id, user_id, user_name, kind, clock_in) values
  ('00000000-0000-0000-0000-0000000002f9', '00000000-0000-0000-0000-0000000002c2', 'Wanda Day', 'studio',
   ((now() at time zone 'America/New_York')::date - 1 + time '20:00') at time zone 'America/New_York');
select public.timeclock_tick();
select pg_temp.ok((select clock_out = ((now() at time zone 'America/New_York')::date)::timestamp at time zone 'America/New_York' and auto_out and needs_review
                     from public.time_punches where id = '00000000-0000-0000-0000-0000000002f9'), 'a clock running past midnight is stopped at midnight and flagged');
select pg_temp.ok(exists (select 1 from public.push_outbox where target_user = '00000000-0000-0000-0000-0000000002c2' and title = 'Your clock was stopped at midnight'), 'and they are told');
select pg_temp.act('00000000-0000-0000-0000-0000000002c2');
select pg_temp.ok((public.timeclock_status() ->> 'review')::int = 1, 'the clock page says to check it');
select pg_temp.ok((public.timeclock_attention() ->> 'review')::int = 1, 'Today says to check it');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select pg_temp.raises($$select public.timesheet_approve('00000000-0000-0000-0000-0000000002c2', (now() at time zone 'America/New_York')::date - 1)$$, 'a week with a flagged punch can''t be approved');
select public.timepunch_save(jsonb_build_object('id', '00000000-0000-0000-0000-0000000002f9', 'kind', 'studio',
  'clock_in', ((now() at time zone 'America/New_York')::date - 1 + time '20:00') at time zone 'America/New_York',
  'clock_out', ((now() at time zone 'America/New_York')::date - 1 + time '22:00') at time zone 'America/New_York'));
reset role;
select pg_temp.ok((select not needs_review and auto_out from public.time_punches where id = '00000000-0000-0000-0000-0000000002f9'), 'fixing the time clears the flag');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select pg_temp.ok((public.timesheet_approve('00000000-0000-0000-0000-0000000002c2', (now() at time zone 'America/New_York')::date - 1) ->> 'ok')::boolean, 'then it can be approved');
select public.timesheet_approve('00000000-0000-0000-0000-0000000002c2', (now() at time zone 'America/New_York')::date - 1, false);
reset role;
delete from public.time_punches where user_id in ('00000000-0000-0000-0000-0000000002c1', '00000000-0000-0000-0000-0000000002c2');

-- ---------------------------------------------------------------- pay rates
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select public.timeclock_rate_save('{"scope":"type","scope_key":"full_time","basis":"hourly","rate":20}');
select public.timeclock_rate_save('{"scope":"title","scope_key":"Lead Photographer","basis":"hourly","rate":25}');
select public.timeclock_rate_save('{"scope":"person","scope_key":"00000000-0000-0000-0000-0000000002c2","basis":"day","rate":200,"half_day_rate":120}');
select pg_temp.raises($$select public.timeclock_rate_save('{"scope":"type","scope_key":"intern","basis":"hourly","rate":20}')$$, 'unknown type refused');
select pg_temp.raises($$select public.timeclock_rate_save('{"scope":"person","scope_key":"00000000-0000-0000-0000-000000000000","basis":"hourly","rate":20}')$$, 'unknown person refused');
select pg_temp.ok((select p -> 'rate' ->> 'source' = 'title' and (p -> 'rate' ->> 'rate')::numeric = 25 from jsonb_array_elements(public.timeclock_rates() -> 'people') p where p ->> 'name' = 'View Two'), 'title beats type');
select pg_temp.ok((select p -> 'rate' ->> 'source' = 'type' from jsonb_array_elements(public.timeclock_rates() -> 'people') p where p ->> 'name' = 'Edit Two'), 'type applies with no title rate');
select pg_temp.ok((select p -> 'rate' is null or p -> 'rate' = 'null'::jsonb from jsonb_array_elements(public.timeclock_rates() -> 'people') p where p ->> 'name' = 'Owner Two'), 'salaried with no rate: none');
reset role;
-- two weeks ago: v works 5 x 9h = 45h (5h overtime); w works one 8h day and one 3h day
insert into public.time_punches (user_id, user_name, kind, clock_in, clock_out)
select '00000000-0000-0000-0000-0000000002c1', 'View Two', 'studio', ((public.tc_week_of(current_date - 14) + d) + time '08:00') at time zone 'America/New_York',
       ((public.tc_week_of(current_date - 14) + d) + time '17:00') at time zone 'America/New_York' from generate_series(1, 5) d;
insert into public.time_punches (user_id, user_name, kind, clock_in, clock_out) values
  ('00000000-0000-0000-0000-0000000002c2', 'Wanda Day', 'studio', ((public.tc_week_of(current_date - 14) + 1) + time '08:00') at time zone 'America/New_York', ((public.tc_week_of(current_date - 14) + 1) + time '16:00') at time zone 'America/New_York'),
  ('00000000-0000-0000-0000-0000000002c2', 'Wanda Day', 'studio', ((public.tc_week_of(current_date - 14) + 2) + time '08:00') at time zone 'America/New_York', ((public.tc_week_of(current_date - 14) + 2) + time '11:00') at time zone 'America/New_York');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
create temp table t_pay as select p from jsonb_array_elements(public.timesheet_payroll(current_date - 14, 1) -> 'people') p;
select pg_temp.ok((select (p -> 'pay' ->> 'pay')::numeric = 40 * 25 + 5 * 25 * 1.5 from t_pay where p ->> 'name' = 'View Two'), 'hourly: 40h x $25 + 5h x $37.50');
select pg_temp.ok((select (p -> 'pay' ->> 'pay')::numeric = 320 and (p -> 'pay' ->> 'half_days')::int = 1 from t_pay where p ->> 'name' = 'Wanda Day'), 'day rate: one full day + one half day');
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select pg_temp.ok((select (p -> 'pay' ->> 'pay')::numeric = 1187.5 from jsonb_array_elements(public.timesheet_week(current_date - 14) -> 'people') p), 'a person sees their own estimated pay');

-- ---------------------------------------------------------------- expenses
select pg_temp.raises($$select public.expense_save('{"user_id":"00000000-0000-0000-0000-0000000002c2","day":"2026-10-01","amount":5,"category":"meals","note":"x"}')$$, 'view: someone else''s expense refused');
select pg_temp.raises($$select public.expense_save('{"day":"2026-10-01","amount":0,"category":"meals","note":"x"}')$$, 'zero amount refused');
select pg_temp.raises($$select public.expense_save('{"day":"2026-10-01","amount":5,"category":"meals"}')$$, 'no job and no note refused');
select pg_temp.raises($$select public.expense_save('{"day":"2026-10-01","amount":5,"category":"meals","note":"x","receipt_path":"00000000-0000-0000-0000-0000000002c2/a.jpg"}')$$, 'a receipt in someone else''s folder refused');
create temp table t_exp (id uuid);
grant all on t_exp to authenticated;
insert into t_exp select (public.expense_save(jsonb_build_object('day', current_date - 14, 'amount', 12.5, 'category', 'supplies', 'note', 'AA batteries',
                                                                  'receipt_path', '00000000-0000-0000-0000-0000000002c1/r1.jpg')) ->> 'id')::uuid;
reset role;
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'expense_update' and target_user = '00000000-0000-0000-0000-0000000002e1'), 'managers are told about a new expense');
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select pg_temp.ok((select count(*) = 1 from jsonb_array_elements(public.expense_list(current_date - 14) -> 'expenses')), 'it is on my list');
select pg_temp.raises($$select public.expense_review((select id from t_exp), 'approved')$$, 'view: approving refused');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select pg_temp.ok((public.timeclock_attention() ->> 'expenses')::int = 1, 'Today: one expense waiting');
select pg_temp.raises($$select public.expense_review((select id from t_exp), 'rejected', '')$$, 'sending back needs a reason');
select public.expense_review((select id from t_exp), 'rejected', 'No receipt total visible');
reset role;
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'expense_update' and target_user = '00000000-0000-0000-0000-0000000002c1' and title = 'Expense sent back'), 'they are told it went back');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select public.expense_save(jsonb_build_object('id', (select id from t_exp), 'day', current_date - 14, 'amount', 12.75, 'category', 'supplies', 'note', 'AA batteries'));
reset role;
select pg_temp.ok((select status = 'submitted' and receipt_path is not null from public.timeclock_expenses where id = (select id from t_exp)), 'fixing it sends it again and keeps the receipt');
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select public.expense_review((select id from t_exp), 'approved');
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select pg_temp.raises($$select public.expense_save(jsonb_build_object('id', (select id from t_exp), 'day', current_date - 14, 'amount', 99, 'category', 'supplies', 'note', 'x'))$$, 'an approved expense is locked');
select pg_temp.raises($$select public.expense_remove((select id from t_exp))$$, 'and can''t be removed');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select pg_temp.ok((select (p ->> 'expenses')::numeric = 12.75 from jsonb_array_elements(public.timesheet_payroll(current_date - 14, 1) -> 'people') p where p ->> 'name' = 'View Two'), 'payroll carries approved expenses');
select pg_temp.ok((select count(*) = 1 from jsonb_array_elements(public.timesheet_payroll(current_date - 14, 1) -> 'expense_rows')), 'and lists them for the CSV');

-- receipts bucket: own folder with View, any folder with Edit
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
insert into storage.objects (bucket_id, name) values ('receipts', '00000000-0000-0000-0000-0000000002c1/ok.jpg');
select pg_temp.raises($$insert into storage.objects (bucket_id, name) values ('receipts', '00000000-0000-0000-0000-0000000002c2/no.jpg')$$, 'view: upload into someone else''s folder refused');
select pg_temp.act('00000000-0000-0000-0000-0000000002c2');
select pg_temp.ok(not exists (select 1 from storage.objects where bucket_id = 'receipts' and name like '00000000-0000-0000-0000-0000000002c1/%'), 'view: others'' receipts are not visible');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select pg_temp.ok(exists (select 1 from storage.objects where bucket_id = 'receipts' and name like '00000000-0000-0000-0000-0000000002c1/%'), 'edit: sees every receipt');

-- ---------------------------------------------------------------- job time
reset role;
insert into public.time_punches (user_id, user_name, kind, booking_id, clock_in, clock_out) values
  ('00000000-0000-0000-0000-0000000002c1', 'View Two', 'job', '00000000-0000-0000-0000-0000000002b1', now() - interval '20 days 3 hours', now() - interval '20 days'),
  ('00000000-0000-0000-0000-0000000002c2', 'Wanda Day', 'job', '00000000-0000-0000-0000-0000000002b1', now() - interval '20 days 3 hours', now() - interval '20 days');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select pg_temp.ok((select count(*) = 2 and bool_and(p -> 'rate' is not null) from jsonb_array_elements(public.timeclock_job('00000000-0000-0000-0000-0000000002b1') -> 'people') p), 'edit: everyone on the job, with rates');
select pg_temp.act('00000000-0000-0000-0000-0000000002c1');
select pg_temp.ok((select count(*) = 1 and bool_and((p ->> 'minutes')::int = 180 and p -> 'rate' = 'null'::jsonb) from jsonb_array_elements(public.timeclock_job('00000000-0000-0000-0000-0000000002b1') -> 'people') p), 'view: only my own time, no rate');

-- ---------------------------------------------------------------- overtime warning
reset role;
delete from public.time_punches where user_id = '00000000-0000-0000-0000-0000000002c1' and clock_in > now() - interval '8 days';
-- this week: 37h worked (fits only when the week is long enough already; otherwise the schedule pushes it over)
insert into public.time_punches (user_id, user_name, kind, clock_in, clock_out) values
  ('00000000-0000-0000-0000-0000000002c1', 'View Two', 'studio', greatest(public.tc_week_of((now() at time zone 'America/New_York')::date)::timestamp at time zone 'America/New_York', now() - interval '40 hours'),
   greatest(public.tc_week_of((now() at time zone 'America/New_York')::date)::timestamp at time zone 'America/New_York', now() - interval '40 hours') + interval '1 minute');
update public.timeclock_settings set overtime_after = 1 where id;   -- 1h of overtime room: the 2h40m job bar ahead goes past it
select public.timeclock_tick();
select pg_temp.ok(exists (select 1 from public.timeclock_ot_warnings where user_id = '00000000-0000-0000-0000-0000000002c1' and level = 'near'), 'scheduled past overtime: near warning');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'overtime_warning' and target_user = '00000000-0000-0000-0000-0000000002c1')
              and exists (select 1 from public.push_outbox where topic = 'overtime_warning' and target_user = '00000000-0000-0000-0000-0000000002e1' and title like 'View Two%'), 'the person and the managers are told');
select pg_temp.ok(not exists (select 1 from public.timeclock_ot_warnings where user_id = '00000000-0000-0000-0000-0000000002a1'), 'salaried: no warning');
select public.timeclock_tick();
select pg_temp.ok((select count(*) from public.timeclock_ot_warnings where user_id = '00000000-0000-0000-0000-0000000002c1') = 1, 'once per level');
update public.time_punches set clock_out = clock_in + interval '2 hours' where user_id = '00000000-0000-0000-0000-0000000002c1' and clock_in > now() - interval '41 hours';
select public.timeclock_tick();
select pg_temp.ok(exists (select 1 from public.timeclock_ot_warnings where user_id = '00000000-0000-0000-0000-0000000002c1' and level = 'over'), 'into overtime: over warning');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select pg_temp.ok((public.timeclock_attention() ->> 'near_ot')::int >= 1, 'Today: someone near overtime');

-- ---------------------------------------------------------------- settings
select public.timeclock_settings_save(0.7, 40, '{"gps_on": false, "remind_before_min": 0, "ot_warn_hours": 2}');
reset role;
select pg_temp.ok((select not gps_on and remind_before_min = 0 and ot_warn_hours = 2 and remind_out_after_min = 30 from public.timeclock_settings where id), 'settings save; untouched ones stay');
select pg_temp.act('00000000-0000-0000-0000-0000000002e1');
select pg_temp.raises($$select public.timeclock_settings_save(0.7, 40, '{"remind_before_min": 500}')$$, 'out-of-range reminder refused');
select public.timeclock_settings_save(0.7, 40);
select pg_temp.ok(true, 'the old two-argument save still works');

select 'ALL TIMECLOCK ROUND TWO TESTS PASSED';
rollback;
