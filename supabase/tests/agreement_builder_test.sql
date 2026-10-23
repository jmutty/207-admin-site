-- Tests for 20261024050000_agreement_builder (ws/agreement). Run against a NON-production copy of the schema,
-- inside a transaction that is rolled back:
--   psql -d shadow -v ON_ERROR_STOP=1 -f supabase/tests/agreement_builder_test.sql
-- "ALL AGREEMENT BUILDER TESTS PASSED" at the end means every check held.

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

-- People: a1 = Agreements edit only; x1 = Agreements + Jobs + Season results edit; v1 = Agreements view; n1 = nothing.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@example.com'), ('00000000-0000-0000-0000-0000000000b1', 'x1@example.com'),
  ('00000000-0000-0000-0000-0000000000c1', 'v1@example.com'), ('00000000-0000-0000-0000-0000000000d1', 'n1@example.com');
insert into public.team_members (user_id, display_name, active) values
  ('00000000-0000-0000-0000-0000000000a1', 'Agreements Edit', true), ('00000000-0000-0000-0000-0000000000b1', 'Office', true),
  ('00000000-0000-0000-0000-0000000000c1', 'Agreements View', true), ('00000000-0000-0000-0000-0000000000d1', 'Nothing', true);
insert into public.team_permissions values
  ('00000000-0000-0000-0000-0000000000a1', 'agreements', 'edit'),
  ('00000000-0000-0000-0000-0000000000b1', 'agreements', 'edit'), ('00000000-0000-0000-0000-0000000000b1', 'bookings', 'edit'), ('00000000-0000-0000-0000-0000000000b1', 'results', 'edit'),
  ('00000000-0000-0000-0000-0000000000c1', 'agreements', 'view');

-- Enfield Station School: two school jobs this school year (fall booked, spring track-only), a cancelled one, a league job, one next year.
insert into public.prospect_orgs (id, name, stage, audience, town) values
  ('00000000-0000-0000-0000-00000000005e', 'Enfield Station School', 'client', 'school', 'Enfield'),
  ('00000000-0000-0000-0000-00000000005f', 'Howland Little League', 'client', 'league', 'Howland');
insert into public.prospect_contacts (id, org_id, first_name, last_name, email, phone, role, is_primary, created_at) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000005e', 'Marisa', 'LeBlanc', 'marisa.leblanc@sau31.org', '207-555-0101', 'Admin. Asst.', true, now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000005e', 'Tom', 'Reed', 'treed@sau31.org', null, 'Principal', false, now() - interval '1 day');
insert into public.bookings (id, org_id, type_key, picture_day, retake_day, status) values
  ('00000000-0000-0000-0000-000000000b01', '00000000-0000-0000-0000-00000000005e', 'school', '2026-09-18', '2026-10-14', 'booked'),
  ('00000000-0000-0000-0000-000000000b02', '00000000-0000-0000-0000-00000000005e', 'school', '2027-03-10', null, 'tracked'),
  ('00000000-0000-0000-0000-000000000b03', '00000000-0000-0000-0000-00000000005e', 'school', '2026-10-01', null, 'cancelled'),
  ('00000000-0000-0000-0000-000000000b04', '00000000-0000-0000-0000-00000000005e', 'league', '2026-10-05', null, 'booked'),
  ('00000000-0000-0000-0000-000000000b05', '00000000-0000-0000-0000-00000000005e', 'school', '2027-09-20', null, 'booked');
insert into public.deliverable_templates (type_key, label, due_days) values ('school', 'Yearbook files', 30);
insert into public.booking_deliverables (booking_id, label, status) values
  ('00000000-0000-0000-0000-000000000b01', 'SIS import file', 'done'), ('00000000-0000-0000-0000-000000000b01', 'Thank-you card', 'todo');

select pg_temp.ok((select agreement_defaults ->> 'FIX_RATE' = '75' and agreement_defaults ->> 'LIAB_CAP' = '10000' and agreement_defaults ->> 'ROSTER_EMAIL' = 'info@207photo.com'
                     and agreement_defaults ->> 'SPACE_SIZE' = '20 ft by 30 ft' from public.partner_followup_settings), 'standard terms seeded from the sheet');

-- ---------------------------------------------------------------- context (prefill)
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
insert into t select 'ctx', public.agreement_builder_context('00000000-0000-0000-0000-00000000005e')::text;
select pg_temp.ok((select v from t where k = 'ctx')::jsonb -> 'org' ->> 'name' = 'Enfield Station School', 'context: the partner');
select pg_temp.ok((select v from t where k = 'ctx')::jsonb -> 'contacts' -> 0 ->> 'name' = 'Marisa LeBlanc'
                  and (select v from t where k = 'ctx')::jsonb -> 'contacts' -> 0 ->> 'phone' = '207-555-0101'
                  and (select v from t where k = 'ctx')::jsonb -> 'contacts' -> 0 ->> 'role' = 'Admin. Asst.', 'context: main contact first with title, email and phone');
select pg_temp.ok(exists (select 1 from jsonb_array_elements((select v from t where k = 'ctx')::jsonb -> 'bookings') b
                          where b ->> 'picture_day' = '2026-09-18' and b ->> 'retake_day' = '2026-10-14' and b ->> 'audience' = 'school'), 'context: jobs with picture and retake day');
select pg_temp.ok(not exists (select 1 from jsonb_array_elements((select v from t where k = 'ctx')::jsonb -> 'bookings') b where b ->> 'status' = 'cancelled'), 'context: no cancelled jobs');
select pg_temp.ok((select v from t where k = 'ctx')::jsonb -> 'defaults' ->> 'RATIO' = '300', 'context: our standard terms');
select pg_temp.ok(jsonb_array_length(public.agreement_orgs('')) = 2 and public.agreement_orgs('') -> 0 ->> 'audience' = 'school', 'partner picker: schools first');
select pg_temp.act('00000000-0000-0000-0000-0000000000d1');
select pg_temp.raises($$select public.agreement_builder_context('00000000-0000-0000-0000-00000000005e')$$, 'no access: no context');
select pg_temp.act(null);
select pg_temp.raises($$select public.agreement_builder_context('00000000-0000-0000-0000-00000000005e')$$, 'public: no context');
select pg_temp.raises($$select public.agreement_builder_save(null, '00000000-0000-0000-0000-00000000005e', '{"on":{},"val":{"SCHOOL_NAME":"X"}}', '<p>x</p>', 'x')$$, 'public: cannot save');

-- ---------------------------------------------------------------- save
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.agreement_builder_save(null, '00000000-0000-0000-0000-00000000005e', '{"on":{},"val":{"SCHOOL_NAME":"X"}}', '<p>x</p>', 'x')$$, 'agreements view: cannot save');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.agreement_builder_save(null, '00000000-0000-0000-0000-00000000005e', '{"on":{},"val":{}}', '<p>x</p>', 'x')$$, 'needs the school name');
select pg_temp.raises($$select public.agreement_builder_save(null, '00000000-0000-0000-0000-00000000005e', '{"on":{},"val":{"SCHOOL_NAME":"X"}}', '<p>x</p><script>alert(1)</script>', 'x')$$, 'no script in the stored markup');
select pg_temp.raises($$select public.agreement_builder_save(null, '00000000-0000-0000-0000-00000000005e', '{"on":{},"val":{"SCHOOL_NAME":"X"}}', '<p class="ab-p" onclick="x()">x</p>', 'x')$$, 'no event handlers in the stored markup');
select pg_temp.raises($$select public.agreement_builder_save(null, '00000000-0000-0000-0000-00000000005e', '{"on":{},"val":{"SCHOOL_NAME":"X"}}', '<a href="https://x">x</a>', 'x')$$, 'no links in the stored markup');
insert into t select 'ag', public.agreement_builder_save(null, '00000000-0000-0000-0000-00000000005e',
  '{"on":{"FALL":true,"RETAKE":true,"YEARBOOK":true,"SIS":true,"EXCLUSIVITY":true},"val":{"SCHOOL_NAME":"Enfield Station School","YEAR_START":"2026","YEAR_END":"2027","FALL":"2026-09-18","END_YEAR":"2027"}}',
  '<div class="ab-doc-in"><h1 class="ab-p ab-title">SCHOOL PHOTOGRAPHY SERVICE AGREEMENT</h1><p class="ab-p">Enfield</p></div>', E'SCHOOL PHOTOGRAPHY SERVICE AGREEMENT\n\nEnfield Station School',
  '{"title":"School Photography Service Agreement 2026-2027","picture_day":"2026-09-18","renewal_date":"2027-06-30","booking_id":"00000000-0000-0000-0000-000000000b01"}') ->> 'id';
select pg_temp.ok((select status = 'draft' and title = 'School Photography Service Agreement 2026-2027' and picture_day = '2026-09-18' and renewal_date = '2027-06-30'
                     and booking_id = '00000000-0000-0000-0000-000000000b01' and builder -> 'on' ->> 'YEARBOOK' = 'true' and payout = '' and job = 'School photography'
                     from public.partner_agreements where id = (select v from t where k = 'ag')::uuid), 'saved as a draft with its choices, date, renewal and job');
select pg_temp.ok((select v from t where k = 'ag') is not null and (select (x ->> 'has_builder')::boolean and not (x ? 'doc_html') and not (x ? 'builder')
                     from jsonb_array_elements(public.agreements_list()) x where x ->> 'id' = (select v from t where k = 'ag')), 'list: marked as a builder agreement, without the big columns');
select pg_temp.ok(public.agreement_get((select v from t where k = 'ag')::uuid) ->> 'rendered' = E'SCHOOL PHOTOGRAPHY SERVICE AGREEMENT\n\nEnfield Station School', 'agreement_get shows the rendered text');
-- a rebate turns into the agreement's payout line
select public.agreement_builder_save((select v from t where k = 'ag')::uuid, null,
  '{"on":{"FALL":true,"RETAKE":true,"YEARBOOK":true,"SIS":true,"EXCLUSIVITY":true,"REBATE_PCT":true,"REBATE_FLAT":true},"val":{"SCHOOL_NAME":"Enfield Station School","YEAR_START":"2026","YEAR_END":"2027","REBATE_PCT":"12.5","REBATE_FLAT":"2","REBATE_DEST":"the PTO"}}',
  '<div class="ab-doc-in"><p class="ab-p">Enfield, with a rebate</p></div>', E'Enfield Station School\n\nRebate', '{}');
select pg_temp.ok((select payout = 'Rebate to the school: 12.5 percent of net sales, plus $2 per completed order, designated for the PTO.' and doc_text = E'Enfield Station School\n\nRebate'
                     and picture_day = '2026-09-18' from public.partner_agreements where id = (select v from t where k = 'ag')::uuid), 'resave: payout line follows the rebate; untouched fields kept');

-- ---------------------------------------------------------------- standard terms
select public.agreement_defaults_save('{"FIX_RATE":"80","BOGUS":"x","COUNTY":" Hancock "}');
select pg_temp.ok((select agreement_defaults ->> 'FIX_RATE' = '80' and agreement_defaults ->> 'COUNTY' = 'Hancock' and not agreement_defaults ? 'BOGUS' and agreement_defaults ->> 'RATIO' = '300'
                     from public.partner_followup_settings), 'standard terms: changed keys saved, unknown keys ignored, others kept');
select pg_temp.act('00000000-0000-0000-0000-0000000000c1');
select pg_temp.raises($$select public.agreement_defaults_save('{"FIX_RATE":"1"}')$$, 'agreements view: cannot change standard terms');

-- ---------------------------------------------------------------- apply to jobs and payout terms
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
insert into t select 'ap1', public.agreement_builder_apply((select v from t where k = 'ag')::uuid, '{Yearbook files,SIS import file}')::text;
select pg_temp.ok((select v from t where k = 'ap1')::jsonb ->> 'message' like '%can''t change jobs%can''t change Season results%', 'agreements only: both parts skipped with a note');
reset role;
select pg_temp.ok((select count(*) from public.booking_deliverables) = 2 and not exists (select 1 from public.partner_terms), 'agreements only: nothing changed');
select pg_temp.act('00000000-0000-0000-0000-0000000000b1');
insert into t select 'ap2', public.agreement_builder_apply((select v from t where k = 'ag')::uuid, '{Yearbook files,SIS import file}')::text;
reset role;
select pg_temp.ok(((select v from t where k = 'ap2')::jsonb ->> 'jobs')::int = 2 and ((select v from t where k = 'ap2')::jsonb ->> 'added')::int = 3, 'adds to the two school jobs of 2026-2027, skipping what is there: ' || (select v from t where k = 'ap2'));
select pg_temp.ok((select count(*) from public.booking_deliverables where booking_id = '00000000-0000-0000-0000-000000000b01') = 3
                  and (select count(*) from public.booking_deliverables where booking_id = '00000000-0000-0000-0000-000000000b01' and label = 'SIS import file') = 1
                  and exists (select 1 from public.booking_deliverables where booking_id = '00000000-0000-0000-0000-000000000b01' and label = 'Thank-you card'), 'fall job: yearbook added, SIS not doubled, nothing removed');
select pg_temp.ok((select due_date = '2026-10-18' and template_id is not null from public.booking_deliverables where booking_id = '00000000-0000-0000-0000-000000000b01' and label = 'Yearbook files'),
                  'the saved Yearbook files deliverable brings its 30 days');
select pg_temp.ok((select count(*) from public.booking_deliverables where booking_id = '00000000-0000-0000-0000-000000000b02') = 2, 'spring track-only job gets both');
select pg_temp.ok(not exists (select 1 from public.booking_deliverables where booking_id in ('00000000-0000-0000-0000-000000000b03', '00000000-0000-0000-0000-000000000b04', '00000000-0000-0000-0000-000000000b05')),
                  'cancelled, league and next year''s jobs untouched');
select pg_temp.ok((select payout_pct = 12.5 and payout_kind = 'percent' and note like 'From the School Photography Service Agreement 2026-2027. Plus $2 per completed order. For the PTO.'
                     from public.partner_terms where org_id = '00000000-0000-0000-0000-00000000005e'), 'percent rebate becomes the partner''s payout terms');
select pg_temp.ok((select applied_at is not null and applied_note like 'Added 3 deliverables to 2 jobs.%Payout set to 12.5% of sales.' from public.partner_agreements where id = (select v from t where k = 'ag')::uuid), 'remembered what was applied');
select pg_temp.act('00000000-0000-0000-0000-0000000000b1');
select pg_temp.ok((public.agreement_builder_apply((select v from t where k = 'ag')::uuid, '{Yearbook files,SIS import file}') ->> 'added')::int = 0, 'applying again adds nothing');

-- ---------------------------------------------------------------- send, the page, accept, the copy
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
insert into t select 'tok', (select token from public.partner_agreements where id = (select v from t where k = 'ag')::uuid);
insert into t select 'agc', public.partner_compose('agreement', (select v from t where k = 'ag')::uuid)::text;
select public.partner_queue('agreement', (select v from t where k = 'ag')::uuid, '00000000-0000-0000-0000-0000000000e2',
  (select v from t where k = 'agc')::jsonb ->> 'subject', (select v from t where k = 'agc')::jsonb ->> 'body', true);
select pg_temp.act(null);
insert into t select 'pub', public.agreement_public((select v from t where k = 'tok'))::text;
select pg_temp.ok((select v from t where k = 'pub')::jsonb ->> 'html' = '<div class="ab-doc-in"><p class="ab-p">Enfield, with a rebate</p></div>'
                  and (select v from t where k = 'pub')::jsonb ->> 'text' = E'Enfield Station School\n\nRebate', 'public page: the builder HTML and text');
select pg_temp.raises($$select public.agreement_builder_apply((select v from t where k = 'ag')::uuid, '{x}')$$, 'public: cannot apply');
select pg_temp.ok(not (public.agreement_accept((select v from t where k = 'tok'), 'Marisa LeBlanc', 'Admin. Asst.', 'not an email') ->> 'ok')::boolean, 'a bad email is refused');
select pg_temp.raises($$select builder from public.partner_agreements$$, 'public: still cannot read the table');
insert into t select 'acc', public.agreement_accept((select v from t where k = 'tok'), 'Marisa LeBlanc', 'Admin. Asst.', ' Marisa.LeBlanc@SAU31.org ')::text;
select pg_temp.ok((select v from t where k = 'acc')::jsonb ->> 'copy' = 'scheduled', 'accepted; their copy goes out (known contact, approved)');
reset role;
select pg_temp.ok((select status = 'accepted' and accepted_html = doc_html and accepted_text = doc_text and accepted_email = 'marisa.leblanc@sau31.org'
                     from public.partner_agreements where id = (select v from t where k = 'ag')::uuid), 'frozen: the HTML and text they accepted');
select pg_temp.ok((select e.status = 'scheduled' and not e.needs_review and e.contact_id = '00000000-0000-0000-0000-0000000000e1' and e.subject = 'Your copy: School Photography Service Agreement 2026-2027'
                     and e.body like 'Hi Marisa,%https://admin.207photo.com/#agree/' || (select v from t where k = 'tok') || '%Accepted by Marisa LeBlanc, Admin. Asst. on %Enfield Station School%Rebate'
                     from public.partner_agreements a join public.prospect_scheduled_emails e on e.id = a.copy_email_id where a.id = (select v from t where k = 'ag')::uuid),
                  'the copy: to the address they typed (a contact), with the link and the accepted text');
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
select pg_temp.raises($$select public.agreement_builder_save((select v from t where k = 'ag')::uuid, null, '{"on":{},"val":{"SCHOOL_NAME":"X"}}', '<p class="ab-p">x</p>', 'x')$$, 'accepted: the builder cannot change it');
select pg_temp.ok((public.agreement_builder_context(null, null, (select v from t where k = 'ag')::uuid) -> 'from' -> 'builder' -> 'val' ->> 'REBATE_PCT') = '12.5'
                  and (public.agreement_builder_context(null, null, (select v from t where k = 'ag')::uuid) -> 'last' -> 'val' ->> 'SCHOOL_NAME') = 'Enfield Station School',
                  'next year''s can start from it (from + last)');

-- A second one, accepted with an address we didn't know: becomes a contact, copy held for review.
insert into t select 'ag2', public.agreement_builder_save(null, '00000000-0000-0000-0000-00000000005e', '{"on":{},"val":{"SCHOOL_NAME":"Enfield Station School"}}',
  '<p class="ab-p">Two</p>', 'Two') ->> 'id';
insert into t select 'tok2', (select token from public.partner_agreements where id = (select v from t where k = 'ag2')::uuid);
select public.partner_queue('agreement', (select v from t where k = 'ag2')::uuid, '00000000-0000-0000-0000-0000000000e2', 'Agreement',
  'https://admin.207photo.com/#agree/' || (select v from t where k = 'tok2'), false);
select pg_temp.act(null);
select pg_temp.ok(public.agreement_accept((select v from t where k = 'tok2'), 'Jo Ann Smith', '', 'jo@sau31.org') ->> 'copy' = 'review', 'unknown address: copy held for review');
reset role;
select pg_temp.ok((select c.first_name = 'Jo' and c.last_name = 'Ann Smith' and not c.is_primary from public.prospect_contacts c where c.email = 'jo@sau31.org'
                     and c.org_id = '00000000-0000-0000-0000-00000000005e'), 'unknown address: added as a contact');
select pg_temp.ok((select e.status = 'held' and e.needs_review from public.partner_agreements a join public.prospect_scheduled_emails e on e.id = a.copy_email_id
                     where a.id = (select v from t where k = 'ag2')::uuid), 'unknown address: waiting in Outreach to review');

-- A third, link shared by hand and accepted without an email: nothing to send, noted.
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
insert into t select 'ag3', public.agreement_builder_save(null, '00000000-0000-0000-0000-00000000005e', '{"on":{},"val":{"SCHOOL_NAME":"Enfield Station School"}}',
  '<p class="ab-p">Three</p>', 'Three') ->> 'id';
select public.agreement_set_status((select v from t where k = 'ag3')::uuid, 'sent');
insert into t select 'tok3', (select token from public.partner_agreements where id = (select v from t where k = 'ag3')::uuid);
select pg_temp.act(null);
select pg_temp.ok(public.agreement_accept((select v from t where k = 'tok3'), 'Tom Reed') ->> 'copy' = 'none', 'no email anywhere: accepted, no copy');
reset role;
select pg_temp.ok((select status = 'accepted' and copy_email_id is null and copy_note = 'No email address to send their copy to.' from public.partner_agreements where id = (select v from t where k = 'ag3')::uuid), 'noted why no copy went');

-- A plain (non-builder) agreement still renders its wording and freezes no HTML.
select pg_temp.act('00000000-0000-0000-0000-0000000000a1');
insert into t select 'ag4', (public.agreement_save(null, '{"org_id":"00000000-0000-0000-0000-00000000005f"}') ->> 'id');
select public.agreement_set_status((select v from t where k = 'ag4')::uuid, 'sent');
insert into t select 'tok4', (select token from public.partner_agreements where id = (select v from t where k = 'ag4')::uuid);
select pg_temp.act(null);
select pg_temp.ok((select (x ->> 'html') is null and x ->> 'text' like 'This agreement is between 207 Photo and Howland Little League.%'
                     from (select public.agreement_public((select v from t where k = 'tok4')) x) s), 'plain agreements: text as before, no HTML');

select 'ALL AGREEMENT BUILDER TESTS PASSED';
rollback;
