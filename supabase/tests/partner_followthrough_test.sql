-- Tests for 20261022210500_partner_followthrough. Run against a NON-production copy of the schema, inside a
-- transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/partner_followthrough_test.sql
-- "ALL PARTNER FOLLOW-THROUGH TESTS PASSED" at the end means every check held.

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
create temp table t (k text primary key, v text);
grant all on t to anon, authenticated;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'p1@example.com'), ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'),
  ('00000000-0000-0000-0000-0000000000a1', 'g1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000e1', 'Partners Edit', true), ('00000000-0000-0000-0000-0000000000c1', 'Partners View', true),
  ('00000000-0000-0000-0000-0000000000a1', 'Agreements Edit', true), ('00000000-0000-0000-0000-0000000000d1', 'Nothing', true);
insert into public.team_permissions values ('00000000-0000-0000-0000-0000000000e1', 'partners', 'edit'), ('00000000-0000-0000-0000-0000000000c1', 'partners', 'view'),
  ('00000000-0000-0000-0000-0000000000a1', 'agreements', 'edit');

select pg_temp.ok((select status from public.app_modules where key = 'agreements') = 'live', 'agreements module is live');
select pg_temp.ok(exists (select 1 from public.push_topics where key = 'agreement_accepted' and module = 'agreements'), 'push topic for accepted agreements');

-- Orgs: A due soon, B past client (old), C do not contact, D already has its next job, E booked last year through a booking.
insert into public.prospect_orgs (id, name, stage, last_job_at, next_job_at, sports) values
  ('00000000-0000-0000-0000-00000000000a', 'Hampden Youth Soccer', 'client', (now() at time zone 'America/New_York')::date - 300, null, '{soccer}'),
  ('00000000-0000-0000-0000-00000000000b', 'Old Town Little League', 'past_client', ((now() at time zone 'America/New_York')::date + 130 - interval '3 years')::date, null, '{baseball}'),
  ('00000000-0000-0000-0000-00000000000c', 'Do Not Call Rec', 'do_not_contact', (now() at time zone 'America/New_York')::date - 300, null, '{}'),
  ('00000000-0000-0000-0000-00000000000d', 'Brewer Hockey', 'client', (now() at time zone 'America/New_York')::date - 300, (now() at time zone 'America/New_York')::date + 30, '{hockey}'),
  ('00000000-0000-0000-0000-00000000000e', 'Hermon School', 'client', null, null, '{}');
insert into public.prospect_contacts (id, org_id, first_name, last_name, email, is_primary) values
  ('00000000-0000-0000-0000-0000000000ca', '00000000-0000-0000-0000-00000000000a', 'Dana', 'Smith', 'dana@hys.org', true),
  ('00000000-0000-0000-0000-0000000000cb', '00000000-0000-0000-0000-00000000000a', 'Lee', 'Jones', 'lee@hys.org', false),
  ('00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-00000000000b', 'Sam', null, 'sam@otll.org', true),
  ('00000000-0000-0000-0000-0000000000ce', '00000000-0000-0000-0000-00000000000e', 'Pat', null, 'pat@hermon.org', true);
insert into public.prospect_contacts (id, org_id, email, bounced_at) values ('00000000-0000-0000-0000-0000000000cf', '00000000-0000-0000-0000-00000000000b', 'gone@otll.org', now());
insert into public.bookings (id, org_id, type_key, picture_day, status) values
  ('00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-00000000000e', 'school', (now() at time zone 'America/New_York')::date - 330, 'tracked');

-- ---------------------------------------------------------------- rebooking
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
insert into t select 'list', public.partner_rebook_list()::text;
select pg_temp.ok((select count(*) from jsonb_array_elements((select v from t where k = 'list')::jsonb) x where x ->> 'org_id' = '00000000-0000-0000-0000-00000000000a' and (x ->> 'open')::boolean
                    and (x ->> 'days')::int = 65 and x -> 'contact' ->> 'email' = 'dana@hys.org') = 1, 'A is due in 65 days and open (lead 75), main contact first');
select pg_temp.ok((select count(*) from jsonb_array_elements((select v from t where k = 'list')::jsonb) x where x ->> 'org_id' = '00000000-0000-0000-0000-00000000000e' and (x ->> 'open')::boolean) = 1,
                  'E comes back from last year''s booking');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements((select v from t where k = 'list')::jsonb) x where x ->> 'org_id' in ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000d')),
                  'do-not-contact and already-booked orgs are left out');
select pg_temp.ok(exists (select 1 from jsonb_array_elements((select v from t where k = 'list')::jsonb) x where x ->> 'org_id' = '00000000-0000-0000-0000-00000000000b' and not (x ->> 'open')::boolean and (x ->> 'days')::int = 130),
                  'B (130 days out) is listed but not open yet');
reset role;
select pg_temp.ok(public.partner_rebook_due('2023-11-05') >= (now() at time zone 'America/New_York')::date - 60, 'due date moves forward whole years');
insert into t select 'edue', public.partner_rebook_due(public.partner_last_job('00000000-0000-0000-0000-00000000000e'))::text;
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok((public.partner_rebook_attention() ->> 'due')::int = 2, 'Today: two to rebook');

insert into t select 'rc', public.partner_compose('rebook', '00000000-0000-0000-0000-00000000000a')::text;
select pg_temp.ok((select v from t where k = 'rc')::jsonb ->> 'body' like 'Hi Dana,%Last year we photographed Hampden Youth Soccer on %', 'rebook email fills in name, league and last date');
select pg_temp.ok(strpos((select v from t where k = 'rc')::jsonb ->> 'subject', '{{') = 0 and (select v from t where k = 'rc')::jsonb ->> 'subject' like 'Hampden Youth Soccer 20%', 'rebook subject has the year');
select pg_temp.ok(jsonb_array_length((select v from t where k = 'rc')::jsonb -> 'contacts') = 2, 'both working contacts offered');
select pg_temp.raises($$select public.partner_queue('rebook', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000ca', 'Hi', 'Hello {{league}}')$$, 'a leftover placeholder');
select pg_temp.raises($$select public.partner_queue('rebook', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000cc', 'Hi', 'Hello')$$, 'a contact from another org');
select public.partner_queue('rebook', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000ca',
  (select v from t where k = 'rc')::jsonb ->> 'subject', (select v from t where k = 'rc')::jsonb ->> 'body', false);
select pg_temp.ok((select count(*) from public.prospect_scheduled_emails where org_id = '00000000-0000-0000-0000-00000000000a' and status = 'held' and needs_review) = 1, 'rebook email is held for review');
select pg_temp.ok((select status from public.partner_rebook where org_id = '00000000-0000-0000-0000-00000000000a') = 'emailed', 'marked emailed');
select pg_temp.raises($$select public.partner_queue('rebook', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000ca', 'Hi', 'Hello')$$, 'a second rebook email while one waits');
select pg_temp.ok((public.partner_rebook_attention() ->> 'due')::int = 1, 'Today: one left to rebook');
select pg_temp.raises($$select public.partner_rebook_set('00000000-0000-0000-0000-00000000000e', current_date + 10, 'later', current_date - 1)$$, 'later needs a future date');
select public.partner_rebook_set('00000000-0000-0000-0000-00000000000e', (select v from t where k = 'edue')::date, 'skipped', null, 'Went with another photographer');
select pg_temp.ok((public.partner_rebook_attention() ->> 'due')::int = 0, 'Not this year takes it off Today');
-- Approving straight away schedules it and moves a past client to Prospecting.
select public.partner_queue('rebook', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000cc', 'Picture day', 'Hi Sam', true);
select pg_temp.ok((select status from public.prospect_scheduled_emails where org_id = '00000000-0000-0000-0000-00000000000b') = 'scheduled', 'approved rebook email is scheduled');
select pg_temp.ok((select stage from public.prospect_orgs where id = '00000000-0000-0000-0000-00000000000b') = 'contacting', 'past client moves to Prospecting');
select pg_temp.raises($$select public.partner_queue('rebook', '00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000000ca', 'Hi', 'Hello')$$, 'do not contact');

select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(jsonb_array_length(public.partner_rebook_list()) > 0, 'partners view: sees the rebook list');
select pg_temp.raises($$select public.partner_compose('rebook', '00000000-0000-0000-0000-00000000000a')$$, 'partners view: cannot draft');
select pg_temp.raises($$select public.partner_rebook_set('00000000-0000-0000-0000-00000000000a', current_date, 'skipped')$$, 'partners view: cannot mark');
select pg_temp.raises($$select public.agreements_list()$$, 'partners view: no agreements');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.partner_rebook_list()$$, 'no access: no rebook list');
select pg_temp.raises($$select public.partner_reviews_list()$$, 'no access: no reviews');
select pg_temp.ok((public.partner_rebook_attention() ->> 'due')::int = 0, 'no access: Today count is 0');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1', 'aal1');
select pg_temp.raises($$select public.partner_rebook_list()$$, 'password only (no second step): refused');

-- ---------------------------------------------------------------- reviews
reset role;
insert into public.bookings (id, org_id, type_key, picture_day, status, contact_ids) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000a', 'league', current_date - 20, 'booked', '{00000000-0000-0000-0000-0000000000cb}'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000000e', 'school', current_date - 20, 'tracked', '{}'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-00000000000a', 'league', current_date - 10, 'booked', '{}'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-00000000000b', 'league', current_date - 10, 'booked', '{}');
select public.booking_stage_move(b, (select id from public.booking_stages where type_key = 'league' and auto = 'gallery_live'), true) from (values ('00000000-0000-0000-0000-0000000000b1'::uuid)) v (b);
select pg_temp.ok(not exists (select 1 from public.partner_reviews), 'earlier stages make no review row');
select public.booking_stage_move(b, (select s.id from public.booking_stages s join public.bookings bk on bk.type_key = s.type_key and bk.id = b where s.auto = 'deliverables_done'), true)
  from (values ('00000000-0000-0000-0000-0000000000b1'::uuid), ('00000000-0000-0000-0000-0000000000b2'::uuid)) v (b);
select pg_temp.ok((select e.status = 'held' and e.needs_review and e.contact_id = '00000000-0000-0000-0000-0000000000cb' and e.body like 'Hi Lee,%'
                    from public.partner_reviews r join public.prospect_scheduled_emails e on e.id = r.email_id where r.booking_id = '00000000-0000-0000-0000-0000000000b1'),
                  'booked job: request drafted to the booking contact and held for review');
select pg_temp.ok((select email_id is null from public.partner_reviews where booking_id = '00000000-0000-0000-0000-0000000000b2'), 'track-only job: row, nothing drafted');
-- Moving again (back and forward) never makes a second row.
select public.booking_stage_move('00000000-0000-0000-0000-0000000000b1', (select id from public.booking_stages where type_key = 'league' and auto = 'deliverables_done'), false);
select pg_temp.ok((select count(*) from public.partner_reviews where booking_id = '00000000-0000-0000-0000-0000000000b1') = 1, 'one row per job');
-- A second job for the same org soon after: not asked again.
select public.booking_stage_move('00000000-0000-0000-0000-0000000000b3', (select id from public.booking_stages where type_key = 'league' and label = 'Deliverables sent'), false);
select pg_temp.ok((select email_id is null and note like 'Asked on %' from public.partner_reviews where booking_id = '00000000-0000-0000-0000-0000000000b3'), 'asked recently: no second request');
-- Review switched off: rows still made, nothing drafted.
update public.partner_followup_settings set review_auto = false;
select public.booking_stage_move('00000000-0000-0000-0000-0000000000b4', (select id from public.booking_stages where type_key = 'league' and auto = 'deliverables_done'), true);
select pg_temp.ok((select email_id is null from public.partner_reviews where booking_id = '00000000-0000-0000-0000-0000000000b4'), 'automatic drafts off: nothing drafted');
update public.partner_followup_settings set review_auto = true;

select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.ok(jsonb_array_length(public.partner_reviews_list()) = 4, 'reviews list has the four jobs');
insert into t select 'rv', (select id::text from public.partner_reviews where booking_id = '00000000-0000-0000-0000-0000000000b2');
insert into t select 'rvc', public.partner_compose('review', (select v from t where k = 'rv')::uuid)::text;
select pg_temp.ok((select v from t where k = 'rvc')::jsonb ->> 'warning' like 'Add your Google review link%', 'warns when the review link is missing');
select public.partner_queue('review', (select v from t where k = 'rv')::uuid, '00000000-0000-0000-0000-0000000000ce', 'Thank you', 'Hi Pat', false);
select pg_temp.ok((select email_id is not null from public.partner_reviews where id = (select v from t where k = 'rv')::uuid), 'track-only job: drafted by hand');
select pg_temp.raises($$select public.partner_queue('review', (select v from t where k = 'rv')::uuid, '00000000-0000-0000-0000-0000000000ce', 'Thank you', 'Hi Pat', false)$$, 'a second request while one waits');
select public.partner_review_log((select v from t where k = 'rv')::uuid, 'quote', 'Easiest picture day we have ever had.', 'Pat, principal', null, true);
select pg_temp.ok((select snippet_id is not null and outcome = 'quote' from public.partner_reviews where id = (select v from t where k = 'rv')::uuid), 'quote logged');
select pg_temp.ok((select s.kind = 'quote' and s.attribution = 'Pat, principal' and s.title = 'Hermon School' from public.prospect_snippets s
                    join public.partner_reviews r on r.snippet_id = s.id where r.id = (select v from t where k = 'rv')::uuid), 'quote saved to the Email library');
select pg_temp.ok(exists (select 1 from public.prospect_activities where org_id = '00000000-0000-0000-0000-00000000000e' and body like 'Gave us a quote%'), 'quote noted on the org timeline');
select pg_temp.raises($$select public.partner_review_log((select v from t where k = 'rv')::uuid, 'quote', '', '')$$, 'quote needs text');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.partner_review_log((select v from t where k = 'rv')::uuid, 'reviewed')$$, 'partners view: cannot log');

-- Cancelling the booked job takes its waiting request with it.
reset role;
update public.bookings set status = 'cancelled' where id = '00000000-0000-0000-0000-0000000000b1';
select pg_temp.ok((select e.status = 'skipped' and r.outcome = 'skipped' from public.partner_reviews r join public.prospect_scheduled_emails e on e.id = r.email_id
                    where r.booking_id = '00000000-0000-0000-0000-0000000000b1'), 'cancelled booking: request skipped');

-- ---------------------------------------------------------------- agreements
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.partner_rebook_list()$$, 'agreements only: no rebook list');
select pg_temp.ok(jsonb_array_length(public.agreement_orgs('hamp')) = 1, 'agreements only: can pick an org');
insert into t select 'ag', (public.agreement_save(null, '{"org_id":"00000000-0000-0000-0000-00000000000a"}') ->> 'id');
select public.agreement_save((select v from t where k = 'ag')::uuid, jsonb_build_object('picture_day', '2027-05-01', 'pricing', 'Packages from $25.', 'payout', '15% of sales to the league.', 'renewal_date', (current_date + 20)::text));
insert into t select 'agg', public.agreement_get((select v from t where k = 'ag')::uuid)::text;
select pg_temp.ok((select v from t where k = 'agg')::jsonb ->> 'rendered' like 'This agreement is between 207 Photo and Hampden Youth Soccer.%Picture day: May 1, 2027%15% of sales to the league.%', 'terms filled in');
select pg_temp.ok((select v from t where k = 'agg')::jsonb ->> 'status' = 'draft', 'starts as a draft');
insert into t select 'tok', (select token from public.partner_agreements where id = (select v from t where k = 'ag')::uuid);
select pg_temp.act(null);
select pg_temp.ok(not (public.agreement_public((select v from t where k = 'tok')) ->> 'found')::boolean, 'public: a draft is not shown');
select pg_temp.raises($$select public.agreements_list()$$, 'public: no list');
select pg_temp.raises($$select * from public.partner_agreements$$, 'public: no table');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
insert into t select 'agc', public.partner_compose('agreement', (select v from t where k = 'ag')::uuid)::text;
select pg_temp.ok(strpos((select v from t where k = 'agc')::jsonb ->> 'body', 'https://admin.207photo.com/#agree/' || (select v from t where k = 'tok')) > 0, 'email has the link');
select pg_temp.raises($$select public.partner_queue('agreement', (select v from t where k = 'ag')::uuid, '00000000-0000-0000-0000-0000000000ca', 'Agreement', 'No link here', false)$$, 'email must keep the link');
select public.partner_queue('agreement', (select v from t where k = 'ag')::uuid, '00000000-0000-0000-0000-0000000000ca',
  (select v from t where k = 'agc')::jsonb ->> 'subject', (select v from t where k = 'agc')::jsonb ->> 'body', false);
select pg_temp.ok((select status from public.partner_agreements where id = (select v from t where k = 'ag')::uuid) = 'sent', 'emailing marks it sent');

select pg_temp.act(null);
select pg_temp.ok((public.agreement_public((select v from t where k = 'tok')) ->> 'found')::boolean, 'public: a sent agreement shows');
select pg_temp.ok(not (public.agreement_public('nope') ->> 'found')::boolean and not (public.agreement_public(repeat('0', 36)) ->> 'found')::boolean, 'public: a wrong token shows nothing');
select pg_temp.ok(not (public.agreement_accept((select v from t where k = 'tok'), ' x ') ->> 'ok')::boolean, 'public: a name is required');
select pg_temp.ok((public.agreement_accept((select v from t where k = 'tok'), '  Dana   Smith ', 'President') ->> 'accepted_name') = 'Dana Smith', 'public: accepted by typed name');
select pg_temp.ok((public.agreement_accept((select v from t where k = 'tok'), 'Someone Else') ->> 'already')::boolean, 'public: accepting twice keeps the first');
reset role;
select pg_temp.ok((select status = 'accepted' and accepted_text like 'This agreement is between 207 Photo and Hampden Youth Soccer.%' and accepted_title = 'President'
                    from public.partner_agreements where id = (select v from t where k = 'ag')::uuid), 'accepted with the exact text frozen');
select pg_temp.ok(exists (select 1 from public.push_outbox where topic = 'agreement_accepted' and body = 'Hampden Youth Soccer: Dana Smith'), 'push sent');
select pg_temp.ok(exists (select 1 from public.prospect_activities where org_id = '00000000-0000-0000-0000-00000000000a' and body like 'Dana Smith accepted%'), 'noted on the org timeline');

select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select public.agreement_save((select v from t where k = 'ag')::uuid, '{"pricing":"changed","w9_status":"on_file","w9_at":"2026-10-22","coi_status":"on_file","coi_expires":"2026-11-01"}');
select pg_temp.ok((select pricing = 'Packages from $25.' and w9_status = 'on_file' and coi_expires = '2026-11-01' from public.partner_agreements where id = (select v from t where k = 'ag')::uuid),
                  'after acceptance: terms locked, paperwork still editable');
select pg_temp.ok((select (x ->> 'renew')::int = 1 and (x ->> 'coi')::int = 1 from (select public.agreements_attention() x) a), 'Today: renewal and insurance due');
select pg_temp.raises($$select public.agreement_set_status((select v from t where k = 'ag')::uuid, 'draft')$$, 'an accepted agreement cannot go back to draft');
select pg_temp.raises($$select public.agreement_save(null, '{"org_id":"00000000-0000-0000-0000-0000000000ff"}')$$, 'unknown org');
select pg_temp.act('00000000-0000-0000-0000-0000000000e1');
select pg_temp.raises($$select public.agreement_save(null, '{"org_id":"00000000-0000-0000-0000-00000000000a"}')$$, 'partners edit without agreements: cannot make one');
select pg_temp.ok((select count(*) from public.partner_agreements) = 0, 'partners edit without agreements: sees none');

select 'ALL PARTNER FOLLOW-THROUGH TESTS PASSED';
rollback;
