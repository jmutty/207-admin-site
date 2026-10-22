-- Tests for 20261023114700_partner_portal. Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/partner_portal_test.sql
-- "ALL PARTNER PORTAL TESTS PASSED" at the end means every check held.

begin;

create function pg_temp.act(p_uid uuid, p_aal text default 'aal2') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims', case when p_uid is null then '{"role":"anon"}'
    else json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal, 'session_id', '00000000-0000-0000-0000-0000000000' || right(p_uid::text, 2))::text end, true);
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

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'e1@example.com'), ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'),
  ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Edit One', true), ('00000000-0000-0000-0000-0000000000c1', 'View One', true),
  ('00000000-0000-0000-0000-0000000000d1', 'No Portal', true);
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'portal', 'edit'), ('00000000-0000-0000-0000-0000000000c1', 'portal', 'view');

-- Hampden has a booked job, a done one with sales, and a cancelled one. Orono has only a track-only job.
insert into public.prospect_orgs (id, name) values ('00000000-0000-0000-0000-00000000f001', 'Hampden Youth Soccer'), ('00000000-0000-0000-0000-00000000f002', 'Orono Rec');
insert into public.prospect_contacts (id, org_id, first_name, last_name, email, is_primary) values
  ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000f001', 'Dana', 'President', 'dana@hys.example.org', true),
  ('00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000f002', 'Ollie', 'Rec', 'ollie@orono.example.org', true);
insert into public.bookings (id, org_id, type_key, title_label, picture_day, start_at, end_at, location, contact_ids, status, time_set) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000f001', (select key from public.booking_types order by 1 limit 1), 'Spring Sports',
   current_date + 20, (current_date + 20 + time '09:00') at time zone 'America/New_York', (current_date + 20 + time '13:00') at time zone 'America/New_York',
   'Hampden Fields', array['00000000-0000-0000-0000-00000000c0a1'::uuid], 'booked', true),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000f001', (select key from public.booking_types order by 1 limit 1), 'Fall Sports',
   current_date - 60, now() - interval '60 days', now() - interval '60 days' + interval '1 hour', '', '{}', 'done', true),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000f001', (select key from public.booking_types order by 1 limit 1), 'Cancelled Day',
   current_date + 10, now() + interval '10 days', now() + interval '10 days 1 hour', '', '{}', 'cancelled', false),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000f002', (select key from public.booking_types order by 1 limit 1), 'Tracked',
   current_date + 5, now() + interval '5 days', now() + interval '5 days 1 hour', '', '{}', 'tracked', false);
insert into public.booking_deliverables (booking_id, label, status, link, done_at) values
  ('00000000-0000-0000-0000-0000000000b2', 'Team photo files', 'done', 'https://www.dropbox.com/s/abc', now()),
  ('00000000-0000-0000-0000-0000000000b2', 'Banner', 'todo', null, null),
  ('00000000-0000-0000-0000-0000000000b2', 'Skipped thing', 'skipped', null, null);
insert into public.pd_plans (id, booking_id) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1');
insert into public.pd_teams (plan_id, name, status, slot_at, sent_slot_at, sent_field) values
  ('00000000-0000-0000-0000-0000000000a1', 'U10 Blue', 'confirmed', now() + interval '20 days', now() + interval '20 days', 'Field 1'),
  ('00000000-0000-0000-0000-0000000000a1', 'U12 Red', 'new', now() + interval '20 days', null, null);
insert into public.partner_agreements (org_id, title, status) values ('00000000-0000-0000-0000-00000000f001', 'Old draft', 'draft');
insert into public.partner_agreements (org_id, title, status, created_at) values ('00000000-0000-0000-0000-00000000f001', 'Spring agreement', 'sent', now() + interval '1 second');
insert into public.job_results (gotphoto_job_id, job_name, picture_day, org_id, gp_sales, gp_orders) values ('gp1', 'Hampden Fall', current_date - 60, '00000000-0000-0000-0000-00000000f001', 1000, 40);
insert into public.partner_terms (org_id, payout_pct) values ('00000000-0000-0000-0000-00000000f001', 10);
insert into public.job_payments (gotphoto_job_id, amount, paid_on) values ('gp1', 40, current_date - 5);

select pg_temp.ok((select status from public.app_modules where key = 'portal') = 'live', 'portal module is live');
select pg_temp.ok((select count(*) from public.push_topics where module = 'portal') = 2, 'two notification kinds for the portal');

-- ---------------------------------------------------------------- access
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.portal_list()$$, 'n1: cannot list portals');
select pg_temp.raises($$select public.portal_get('00000000-0000-0000-0000-00000000f001')$$, 'n1: cannot open one');
select pg_temp.ok((public.portal_attention() ->> 'changes')::int = 0, 'n1: attention is zero without access');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(public.portal_get('00000000-0000-0000-0000-00000000f001') -> 'portal' = 'null'::jsonb, 'v1: opening does not make a portal (view only)');
select pg_temp.raises($$select public.portal_save('00000000-0000-0000-0000-00000000f001', '{}')$$, 'v1: cannot make a portal');
select pg_temp.raises($$select public.portal_compose('invite', '00000000-0000-0000-0000-00000000f001')$$, 'v1: cannot compose an email');

-- ---------------------------------------------------------------- staff make the link
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(length(public.portal_get('00000000-0000-0000-0000-00000000f001') -> 'portal' ->> 'token') = 36, 'e1: opening makes the portal with a 36-character token');
select pg_temp.ok((public.portal_get('00000000-0000-0000-0000-00000000f001') ->> 'can_email')::boolean, 'Hampden can be emailed (booked job)');
select pg_temp.ok(not (public.portal_get('00000000-0000-0000-0000-00000000f002') ->> 'can_email')::boolean, 'Orono cannot be emailed (track-only)');
select pg_temp.ok(jsonb_array_length(public.portal_get('00000000-0000-0000-0000-00000000f001') -> 'bookings') = 2, 'the job list leaves out the cancelled one');
select pg_temp.ok(jsonb_array_length(public.portal_list()) = 2, 'e1: both portals listed');
select pg_temp.ok(jsonb_array_length(public.portal_orgs('hamp')) = 1, 'org search finds Hampden');
reset role;
create temp table tok as select org_id, token, file_key from public.partner_portals;
grant select on tok to anon, authenticated;
create temp table pdtok as select token from public.pd_plans;
grant select on pdtok to anon, authenticated;

-- ---------------------------------------------------------------- the public page
select pg_temp.act(null);
select pg_temp.raises($$select count(*) from public.partner_portals$$, 'anon: cannot read the tables');
select pg_temp.ok(not (public.portal_public('nope') ->> 'found')::boolean, 'a short token finds nothing');
select pg_temp.ok(not (public.portal_public(repeat('a', 36)) ->> 'found')::boolean, 'an unknown token finds nothing');
create temp table pg1 as select public.portal_public((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001')) d;
select pg_temp.ok((select d ->> 'org' from pg1) = 'Hampden Youth Soccer', 'the page shows the organization');
select pg_temp.ok((select jsonb_array_length(d -> 'jobs') from pg1) = 2, 'two jobs: booked + done, not cancelled');
select pg_temp.ok((select d -> 'jobs' -> 0 ->> 'id' from pg1) = '00000000-0000-0000-0000-0000000000b1', 'upcoming job first');
select pg_temp.ok((select d -> 'jobs' -> 0 -> 'plan' ->> 'token' from pg1) = (select token from pdtok), 'the upcoming job links to its picture day form');
select pg_temp.ok((select jsonb_array_length(d -> 'jobs' -> 0 -> 'teams') from pg1) = 1, 'only team times already sent to coaches show');
select pg_temp.ok((select jsonb_array_length(d -> 'jobs' -> 1 -> 'deliverables') from pg1) = 2, 'deliverables shown, skipped ones left out');
select pg_temp.ok((select d -> 'jobs' -> 1 -> 'deliverables' -> 0 ->> 'link' from pg1) = 'https://www.dropbox.com/s/abc', 'a done deliverable carries its download link');
select pg_temp.ok((select d -> 'agreement' ->> 'title' from pg1) = 'Spring agreement', 'the latest sent agreement shows (not the draft)');
select pg_temp.ok((select (d -> 'sales' ->> 'due')::numeric from pg1) = 100 and (select (d -> 'sales' ->> 'balance')::numeric from pg1) = 60, 'sales statement: 10% of 1000 due, 40 paid, 60 owed');
select pg_temp.ok((select jsonb_array_length(d -> 'sales' -> 'payments') from pg1) = 1, 'payments listed');
reset role;
select pg_temp.ok((select view_count from public.partner_portals where org_id = '00000000-0000-0000-0000-00000000f001') = 1 and
                  (select viewed_at is not null from public.partner_portals where org_id = '00000000-0000-0000-0000-00000000f001'), 'opening the page is counted');
select pg_temp.ok((select d -> 'jobs' -> 0 -> 'plan' -> 'token' from pg1) is not null, 'form link present');

-- sales switched off
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.portal_save('00000000-0000-0000-0000-00000000f001', '{"show_sales": false, "welcome": "Hello  league!"}');
select pg_temp.act(null);
select pg_temp.ok(public.portal_public((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001')) -> 'sales' = 'null'::jsonb, 'sales hidden when switched off');
select pg_temp.ok(public.portal_public((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001')) ->> 'welcome' = 'Hello  league!', 'welcome note shows');

-- ---------------------------------------------------------------- proofs
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.portal_proof_save(null, '{"org_id":"00000000-0000-0000-0000-00000000f001","label":"Composite"}')$$, 'a proof needs a file or link');
select pg_temp.raises($$select public.portal_proof_save(null, jsonb_build_object('org_id','00000000-0000-0000-0000-00000000f001','label','Composite','file_path','ffff/proofs/x.jpg'))$$, 'a proof file must be in the portal''s folder');
select pg_temp.raises($$select public.portal_proof_save(null, '{"org_id":"00000000-0000-0000-0000-00000000f001","label":"Composite","link":"javascript:alert(1)"}')$$, 'a proof link must be http(s)');
select pg_temp.raises($$select public.portal_proof_save(null, '{"org_id":"00000000-0000-0000-0000-00000000f001","label":"Composite","link":"https://x.example","booking_id":"00000000-0000-0000-0000-0000000000b4"}')$$, 'a proof cannot point at another organization''s job');
create temp table pr as select (public.portal_proof_save(null, jsonb_build_object('org_id', '00000000-0000-0000-0000-00000000f001', 'label', 'U10 composite',
  'booking_id', '00000000-0000-0000-0000-0000000000b1', 'file_path', (select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '/proofs/1-comp.jpg', 'file_name', 'comp.jpg')) ->> 'id')::uuid id;
reset role;
grant select on pr to anon, authenticated;
insert into storage.objects (bucket_id, name) values ('portal', (select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '/proofs/1-comp.jpg'),
                                                     ('portal', (select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '/out/secret-unlisted.pdf');
select pg_temp.act(null);
select pg_temp.ok((select count(*) from storage.objects where bucket_id = 'portal') = 1, 'anon can see a listed proof file, not an unlisted one');
select pg_temp.ok(jsonb_array_length(public.portal_public((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001')) -> 'proofs') = 1, 'the proof is on the page');
select pg_temp.raises($$select public.portal_public_proof((select token from tok where org_id = '00000000-0000-0000-0000-00000000f002'), (select id from pr), 'approve', 'Dana')$$, 'another organization''s link cannot answer it');
select pg_temp.raises($$select public.portal_public_proof((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001'), (select id from pr), 'changes', 'Dana', '')$$, 'changes need a note');
select pg_temp.raises($$select public.portal_public_proof((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001'), (select id from pr), 'approve', '')$$, 'an answer needs a name');
select pg_temp.ok(public.portal_public_proof((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001'), (select id from pr), 'changes', 'Dana P', 'Spell Hampden right') ->> 'status' = 'changes', 'they ask for changes');
select pg_temp.raises($$select public.portal_public_proof((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001'), (select id from pr), 'approve', 'Dana')$$, 'cannot answer twice');
reset role;
select pg_temp.ok((select count(*) from public.push_log where topic = 'portal_proof' and url = '/#partners/portal/00000000-0000-0000-0000-00000000f001') = 1, 'push: changes asked');
select pg_temp.ok((select count(*) from public.prospect_activities where meta ->> 'source' = 'portal') = 1, 'logged on the organization');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.portal_attention() ->> 'changes')::int = 1, 'v1: Today shows one proof to change');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.portal_proof_save((select id from pr), jsonb_build_object('label', 'U10 composite', 'booking_id', '00000000-0000-0000-0000-0000000000b1',
  'file_path', (select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '/proofs/2-comp.jpg', 'file_name', 'comp2.jpg'));
select pg_temp.ok((select round = 2 and status = 'waiting' and decided_name is null and jsonb_array_length(history) = 1 from public.portal_proofs where id = (select id from pr)), 'a new file starts round 2 and keeps round 1 in history');
select public.portal_proof_save((select id from pr), jsonb_build_object('label', 'U10 team composite', 'booking_id', '00000000-0000-0000-0000-0000000000b1'));
select pg_temp.ok((select round = 2 and label = 'U10 team composite' and file_name = 'comp2.jpg' from public.portal_proofs where id = (select id from pr)), 'renaming keeps the round and file');
select pg_temp.act(null);
select pg_temp.ok(public.portal_public_proof((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001'), (select id from pr), 'approve', 'Dana P') ->> 'status' = 'approved', 'they approve round 2');

-- ---------------------------------------------------------------- email: booked only, outreach pipeline
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
create temp table c1 as select public.portal_compose('invite', '00000000-0000-0000-0000-00000000f001') c;
select pg_temp.ok((select c ->> 'body' from c1) like '%admin.207photo.com/#portal/' || (select token from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '%', 'invite carries the link');
select pg_temp.ok((select c ->> 'body' from c1) like 'Hi Dana,%', 'invite greets the booking contact');
select pg_temp.raises($$select public.portal_queue('invite', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000c0a1', 'Hi', 'no link here')$$, 'the link must stay in the message');
select pg_temp.ok(public.portal_queue('invite', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000c0a1', (select c ->> 'subject' from c1), (select c ->> 'body' from c1)) ->> 'status' = 'review', 'invite held for review');
select pg_temp.raises($$select public.portal_queue('invite', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000c0a1', 's', (select c ->> 'body' from c1))$$, 'no second invite while one waits');
select pg_temp.ok((select (public.portal_get('00000000-0000-0000-0000-00000000f001') -> 'portal' -> 'email' ->> 'status')) = 'review', 'the portal shows its email waiting');
select pg_temp.ok((public.portal_compose('invite', '00000000-0000-0000-0000-00000000f002') ->> 'warning') like 'Only booked jobs send%', 'a track-only organization is warned');
select pg_temp.raises($$select public.portal_queue('invite', '00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000c0b1', 's', 'x ' || (select token from tok where org_id = '00000000-0000-0000-0000-00000000f002'))$$, 'a track-only organization is never emailed');
select pg_temp.raises($$select public.portal_compose('proof', (select id from pr))$$, 'an approved proof is not emailed');
-- a proof on the done job can't be emailed even though the organization has a booked job
create temp table pr2 as select (public.portal_proof_save(null, '{"org_id":"00000000-0000-0000-0000-00000000f001","label":"Banner","link":"https://x.example/b","booking_id":"00000000-0000-0000-0000-0000000000b2"}') ->> 'id')::uuid id;
select pg_temp.raises($$select public.portal_queue('proof', (select id from pr2), '00000000-0000-0000-0000-00000000c0a1', 's', (select c ->> 'body' from c1))$$, 'a proof on a job that is not booked is never emailed');
reset role;
select pg_temp.ok((select count(*) from public.prospect_scheduled_emails) = 1, 'one email in the outreach pipeline');

-- ---------------------------------------------------------------- files
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.portal_file_add('00000000-0000-0000-0000-00000000f001', (select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f002') || '/out/a.pdf', 'a.pdf', 10)$$, 'a shared file must be in this portal''s folder');
select public.portal_file_add('00000000-0000-0000-0000-00000000f001', (select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '/out/1-schedule.pdf', 'schedule.pdf', 1000, 'Your schedule');
select pg_temp.act(null);
select pg_temp.ok(public.portal_path_uploadable((select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '/in/1-roster.csv'), 'they may upload into their in folder');
select pg_temp.ok(not public.portal_path_uploadable((select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '/out/1-roster.csv'), 'but not into out');
select pg_temp.ok(not public.portal_path_uploadable(repeat('b', 32) || '/in/1-roster.csv'), 'nor into an unknown folder');
select pg_temp.raises($$select public.portal_public_upload((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001'), (select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f002') || '/in/x.csv', 'x.csv', 1)$$, 'cannot record into another organization''s folder');
select public.portal_public_upload((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001'), (select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '/in/1-roster.csv', 'roster.csv', 2000, 'Coach Sam', 'Final roster');
select pg_temp.ok(jsonb_array_length(public.portal_public((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001')) -> 'files') = 2, 'both files on the page');
reset role;
select pg_temp.ok((select count(*) from public.push_log where topic = 'portal_upload') = 1, 'push: file from a partner');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok((public.portal_attention() ->> 'files')::int = 1, 'Today: one new file');
select pg_temp.ok((public.portal_files_seen('00000000-0000-0000-0000-00000000f001') ->> 'seen')::int = 1, 'v1: opening marks it seen');
select pg_temp.ok((public.portal_attention() ->> 'files')::int = 0, 'Today: nothing new');
select pg_temp.raises($$select public.portal_file_remove((select id from public.portal_files limit 1))$$, 'v1: cannot remove files');
select pg_temp.ok(jsonb_array_length(public.portal_job('00000000-0000-0000-0000-0000000000b1') -> 'proofs') = 1, 'job tab: this job''s proof');

-- ---------------------------------------------------------------- new link, turned off
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.portal_save('00000000-0000-0000-0000-00000000f001', '{"new_link": true}');
reset role;
insert into storage.objects (bucket_id, name) values ('portal', (select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '/out/1-schedule.pdf');
select pg_temp.act(null);
select pg_temp.ok(not (public.portal_public((select token from tok where org_id = '00000000-0000-0000-0000-00000000f001')) ->> 'found')::boolean, 'a new link retires the old one');
select pg_temp.ok((select count(*) from storage.objects where bucket_id = 'portal') = 1, 'the shared file is still readable (same folder); the replaced round-1 proof file is not');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select public.portal_save('00000000-0000-0000-0000-00000000f001', '{"active": false}');
reset role;
create temp table tok2 as select token from public.partner_portals where org_id = '00000000-0000-0000-0000-00000000f001';
grant select on tok2 to anon;
select pg_temp.act(null);
select pg_temp.ok(not (public.portal_public((select token from tok2)) ->> 'found')::boolean, 'a turned-off portal shows nothing');
select pg_temp.ok((select count(*) from storage.objects where bucket_id = 'portal') = 0, 'and its files can''t be read');
select pg_temp.ok(not public.portal_path_uploadable((select file_key from tok where org_id = '00000000-0000-0000-0000-00000000f001') || '/in/2.csv'), 'nor uploaded to');

reset role;
do $$ begin raise notice 'ALL PARTNER PORTAL TESTS PASSED'; end $$;
rollback;
