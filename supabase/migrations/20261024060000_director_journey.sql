-- Director journey (2026-10-24, ws/director): what a league or school director gets from us.
--
-- 1. New booking fields: team_times (a pasted list, one line per team), order_deadline, discount_ends, and
--    day_token: the link to their read-only "Your picture day" page, admin.207photo.com/#day/<token>.
-- 2. New sending settings: booking_settings.day_of_phone and weather_plan (Settings > Sending).
-- 3. booking_steps.trigger may be 'booking' (sent right after booking, after the undo window). The steps
--    themselves are added, switched OFF, in 20261024060100_director_steps.sql (a separate file, so a new enum
--    value, if trigger is an enum, is committed before it is used).
-- 4. booking_director_facts / booking_director_vars: every new email token in one place, for booking-sender
--    (production-only edge function) to merge into its own tokens:
--      {{families_block}} {{day_of_block}} {{weather_line}} {{flyer_line}} {{team_times}} {{order_deadline}}
--      {{discount_ends}} {{day_link}} {{calendar_link}} {{when_line}} {{where_line}} {{day_of_phone}}
-- 5. booking_public(token) for the #day page, booking_ics(token) for the "Add to your calendar" download
--    (edge function booking-ics returns it as text/calendar). Both anon, by token only, safe fields only.
-- 6. Moved / cancelled: a trigger on bookings queues a short note to the main booking contact through the
--    partner email pipeline, HELD for review (only once we have emailed them about the booking).
-- 7. Files + thank-you: the review request lists the delivered files ({{files_block}}), and no review email
--    can be queued while the Google review link is empty.
-- 8. partner_statement_queue: Season results "Email statement", held for review.
--
-- Safe to run more than once. Existing RPC signatures are untouched; nothing is deleted.

-- ================================================================ 1. booking fields
alter table public.bookings
  add column if not exists team_times     text not null default '',
  add column if not exists order_deadline date,
  add column if not exists discount_ends  date,
  add column if not exists day_token      text default encode(extensions.gen_random_bytes(18), 'hex');
update public.bookings set day_token = encode(extensions.gen_random_bytes(18), 'hex') where day_token is null;
alter table public.bookings alter column day_token set not null;
create unique index if not exists bookings_day_token_uq on public.bookings (day_token);
comment on column public.bookings.team_times is 'Pasted team order, one line per team ("9:00 U10 Blue"). Fills {{team_times}} and the picture day page.';
comment on column public.bookings.order_deadline is 'Last day families can order (optional). Fills {{order_deadline}}.';
comment on column public.bookings.discount_ends is 'Last day of the early-order discount (optional). Fills {{discount_ends}}.';
comment on column public.bookings.day_token is 'Token for the director''s read-only page admin.207photo.com/#day/<token> and the calendar download.';

-- ================================================================ 2. sending settings
alter table public.booking_settings
  add column if not exists day_of_phone text not null default '(207) 558-3185',
  add column if not exists weather_plan text not null default 'Outdoor shoots move to your backup date or an indoor space. We decide together by 7:00 AM on picture day, and we email and call you either way.';
comment on column public.booking_settings.day_of_phone is '207''s phone for picture-day problems, shown in director emails and on the picture day page.';
comment on column public.booking_settings.weather_plan is 'The rain plan line for outdoor (sports) picture days.';

-- ================================================================ 3. trigger 'booking' allowed on booking_steps
-- booking_steps is production-only schema. Its trigger column is either an enum or text with a check
-- constraint listing the values; add 'booking' to whichever it is. Anything unexpected stops the migration.
do $$
declare v_typ oid; r record; v_def text;
begin
  select a.atttypid into v_typ from pg_attribute a
   where a.attrelid = 'public.booking_steps'::regclass and a.attname = 'trigger' and not a.attisdropped;
  if v_typ is null then raise exception 'booking_steps.trigger not found'; end if;
  if (select t.typtype from pg_type t where t.oid = v_typ) = 'e' then
    execute format('alter type %s add value if not exists %L', v_typ::regtype, 'booking');
  end if;
  for r in select c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c
            where c.conrelid = 'public.booking_steps'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) ~ '''gallery_live''' loop
    continue when r.def ~ '''booking''';
    if r.def !~ 'ANY \(ARRAY\[' then raise exception 'Unexpected check on booking_steps (%): %', r.conname, r.def; end if;
    v_def := regexp_replace(r.def, '''gallery_live''(::[a-z ]+)?', '''gallery_live''\1, ''booking''\1');
    execute format('alter table public.booking_steps drop constraint %I', r.conname);
    execute format('alter table public.booking_steps add constraint %I %s', r.conname, v_def);
  end loop;
end $$;

-- ================================================================ 4. the facts and the tokens
create or replace function public.director_fmt_day(d date) returns text
language sql immutable set search_path = '' as $$
  select case when d is null then '' else to_char(d, 'FMDay, FMMonth FMDD') end
$$;
create or replace function public.director_fmt_time(t timestamptz) returns text
language sql stable set search_path = '' as $$
  select case when t is null then '' else to_char(t at time zone 'America/New_York', 'FMHH12:MI AM') end
$$;

-- Everything a director should know about one booking, as plain values. Internal (security definer, no grants):
-- booking_director_vars, booking_public and booking_ics read it. Columns that only exist in production are read
-- through to_jsonb(b), so a missing one is an empty value, never an error.
create or replace function public.booking_director_facts(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  b public.bookings; bj jsonb; t public.booking_types; s public.booking_settings;
  v_org text; v_aud text; v_wf text; v_days jsonb := '[]'::jsonb; v_when text; v_first_start timestamptz;
  v_setup int; v_arrival text := ''; v_needs text; v_weather text := ''; v_hub text; v_hub_link text; v_flyer text;
  v_roster text := ''; v_codes int; v_fam jsonb; v_terms text := ''; tm record; v_dlv jsonb := '[]'::jsonb;
  v_retake text; v_retake_day date; v_ag jsonb; v_reply text; v_job text; v_link text; v_cal text; v_order text; v_disc text;
  v_teams jsonb;
begin
  select * into b from public.bookings where id = p_booking;
  if b.id is null then return null; end if;
  bj := to_jsonb(b);
  select * into t from public.booking_types where key = b.type_key;
  select * into s from public.booking_settings limit 1;
  select o.name into v_org from public.prospect_orgs o where o.id = b.org_id;
  v_aud := case when t.audience = 'school' then 'school' else 'sports' end;
  v_job := nullif(bj ->> 'gotphoto_job_id', '');

  -- who the families are: a school; a league whose families registered (GotPhoto emails them); a roster-only team
  if v_aud = 'school' then v_wf := 'school';
  else
    begin
      select case sj.comm_workflow when 'league' then 'families' when 'school' then 'roster' end into v_wf
        from public.synced_jobs sj where sj.gotphoto_job_id = v_job;
    exception when others then v_wf := null;
    end;
    v_wf := coalesce(v_wf, case when b.type_key = 'sports_data' then 'families' else 'roster' end);
  end if;

  -- the day(s) and times
  begin
    select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'label', coalesce(d.label, ''),
             'start', case when d.start_at is not null and (coalesce(d.sort, 0) <> 0 or coalesce((bj ->> 'time_set')::boolean, true)) then public.director_fmt_time(d.start_at) else '' end,
             'end', case when d.end_at is not null and (coalesce(d.sort, 0) <> 0 or coalesce((bj ->> 'end_set')::boolean, true)) then public.director_fmt_time(d.end_at) else '' end,
             'start_at', case when d.start_at is not null and (coalesce(d.sort, 0) <> 0 or coalesce((bj ->> 'time_set')::boolean, true)) then d.start_at end,
             'end_at', case when d.end_at is not null and (coalesce(d.sort, 0) <> 0 or coalesce((bj ->> 'end_set')::boolean, true)) then d.end_at end)
           order by d.day, d.sort), '[]'::jsonb)
      into v_days from public.booking_days d where d.booking_id = b.id and d.removed is not true;
  exception when others then v_days := '[]'::jsonb;
  end;
  if jsonb_array_length(v_days) = 0 then
    v_days := jsonb_build_array(jsonb_build_object('day', b.picture_day, 'label', '',
      'start', case when coalesce((bj ->> 'time_set')::boolean, true) then public.director_fmt_time((bj ->> 'start_at')::timestamptz) else '' end,
      'end', case when coalesce((bj ->> 'end_set')::boolean, true) then public.director_fmt_time((bj ->> 'end_at')::timestamptz) else '' end,
      'start_at', case when coalesce((bj ->> 'time_set')::boolean, true) then (bj ->> 'start_at')::timestamptz end,
      'end_at', case when coalesce((bj ->> 'end_set')::boolean, true) then (bj ->> 'end_at')::timestamptz end));
  end if;
  select string_agg(public.director_fmt_day((x ->> 'day')::date)
           || case when x ->> 'start' <> '' then ', ' || (x ->> 'start') || case when x ->> 'end' <> '' then ' to ' || (x ->> 'end') else '' end
                   else ' (we''ll confirm the time)' end
           || case when x ->> 'label' <> '' then ' (' || (x ->> 'label') || ')' else '' end, '; ' order by x ->> 'day')
    into v_when from jsonb_array_elements(v_days) x;
  v_first_start := (v_days -> 0 ->> 'start_at')::timestamptz;

  -- arrival: start minus setup (the job bar's setup minutes, else the default, else 30)
  begin
    select max(e.setup_min) into v_setup from public.schedule_entries e where e.booking_id = b.id and e.kind = 'job';
  exception when others then v_setup := null;
  end;
  if v_setup is null then
    begin select st.setup_min into v_setup from public.staff_settings st limit 1; exception when others then v_setup := null; end;
  end if;
  v_setup := coalesce(v_setup, 30);
  if v_first_start is not null then v_arrival := public.director_fmt_time(v_first_start - make_interval(mins => v_setup)); end if;

  v_needs := case when v_aud = 'school'
    then 'A room for the day (gym, library or cafeteria) with an outlet, a table and two chairs, and the class order.'
    else 'A spot about 15 by 15 feet out of direct sun (or a room with an outlet if we''re indoors), and someone who can send teams over in order.' end;
  if v_aud = 'sports' then v_weather := coalesce(nullif(btrim(s.weather_plan), ''), ''); end if;

  v_hub := case when v_aud = 'school' then '207photo.com/schooladmin' else '207photo.com/sportsadmin' end;
  v_hub_link := 'https://' || v_hub || case when v_aud = 'sports' and v_job is not null then '/#job=' || v_job else '' end;
  v_flyer := 'A printable flyer, a parent email and a text message are written for you on the hub (' || v_hub || '). Post the flyer and send the email about a week before picture day.';

  if v_aud = 'sports' then
    begin select sj.code_count into v_codes from public.synced_jobs sj where sj.gotphoto_job_id = v_job; exception when others then v_codes := null; end;
    v_roster := case when coalesce(v_codes, 0) > 0 then 'We have your roster. Thank you!'
                     when v_wf = 'families' then 'We still need your roster, or tell us families will pre-register. Just reply to any of our emails.'
                     else 'We still need your roster. Just reply to any of our emails with it.' end;
  end if;

  v_order := public.director_fmt_day(b.order_deadline);
  v_disc := public.director_fmt_day(b.discount_ends);
  v_fam := case v_wf
    when 'families' then jsonb_build_array('Nothing to pay on picture day, and no order forms.',
                                           'After picture day, every family on your roster gets an email and a text with a link to their own athlete''s gallery.',
                                           'They order online from that gallery.')
    when 'roster' then jsonb_build_array('Nothing to pay on picture day, and no order forms.',
                                         'When the photos are online we email you a ready-to-send message with the link and the code; families find their athlete and order online from their own gallery.')
    else jsonb_build_array('Nothing to pay on picture day, and no order forms or envelopes.',
                           'Families get the access code by email (from the messages on the hub) and order online from their child''s own gallery.') end;
  if v_disc <> '' then v_fam := v_fam || to_jsonb('The early-order discount ends ' || v_disc || '.'); end if;
  if v_order <> '' then v_fam := v_fam || to_jsonb('Last day to order: ' || v_order || '.'); end if;

  -- what the program gets (Season results terms)
  begin
    select x.* into tm from public.partner_terms x where x.org_id = b.org_id;
    if tm.org_id is not null then
      v_terms := case coalesce(to_jsonb(tm) ->> 'payout_kind', 'percent')
        when 'deliverables' then 'Your program gets ' || coalesce(nullif(btrim(to_jsonb(tm) ->> 'gets'), ''), 'the agreed deliverables') || ' instead of a payout.'
        when 'none' then 'There is no cost to your program.'
        else case when tm.payout_pct > 0 then 'Your program gets ' || trim(trailing '.' from trim(trailing '0' from tm.payout_pct::text)) || '% of online sales (before tax), paid by check after the season.' else '' end end;
    end if;
  exception when others then v_terms := '';
  end;

  select coalesce(jsonb_agg(jsonb_build_object('label', d.label, 'done', d.status = 'done',
           'link', case when d.status = 'done' then d.link end, 'due', d.due_date) order by d.sort, d.created_at), '[]'::jsonb)
    into v_dlv from public.booking_deliverables d where d.booking_id = b.id and d.status <> 'skipped';

  v_retake_day := nullif(bj ->> 'retake_day', '')::date;
  v_retake := case when v_aud = 'school' and v_retake_day is not null then 'Retake day is ' || public.director_fmt_day(v_retake_day) || '. Anyone who was out, or wants a retake, comes then.'
                   when v_aud = 'school' then 'Anyone out on picture day can be photographed on a retake day; we''ll set one with you if it''s needed.'
                   else 'Missed picture day? There''s no on-location makeup day; families can book a makeup at 207photo.com/makeups.' end;

  select jsonb_build_object('status', a.status, 'link', 'https://admin.207photo.com/#agree/' || a.token, 'accepted_at', a.accepted_at)
    into v_ag from public.partner_agreements a
   where a.org_id = b.org_id and a.status in ('sent', 'accepted') and (a.booking_id = b.id or a.booking_id is null)
   order by (a.booking_id = b.id) desc nulls last, a.created_at desc limit 1;

  v_reply := coalesce(nullif(btrim(split_part(coalesce(s.reply_to, ''), ',', 1)), ''), s.from_email, '');
  v_link := 'https://admin.207photo.com/#day/' || b.day_token;
  v_cal := 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?t=' || b.day_token;
  select coalesce(jsonb_agg(btrim(l) order by n), '[]'::jsonb) into v_teams
    from regexp_split_to_table(coalesce(b.team_times, ''), E'\n') with ordinality as x(l, n) where btrim(l) <> '';

  return jsonb_build_object(
    'booking_id', b.id, 'status', b.status, 'org', coalesce(v_org, ''), 'audience', v_aud, 'workflow', v_wf,
    'job', coalesce(nullif(b.title_override, ''), nullif(b.title_label, ''), t.label, 'Picture day'),
    'picture_day', b.picture_day, 'days', v_days, 'when_line', coalesce(v_when, ''), 'time_set', v_first_start is not null,
    'location', coalesce(nullif(btrim(bj ->> 'location'), ''), ''), 'arrival', v_arrival, 'setup_min', v_setup,
    'contact', jsonb_build_object('name', coalesce(s.from_name, '207 Photo'), 'email', v_reply, 'phone', coalesce(s.day_of_phone, '')),
    'needs', v_needs, 'weather', v_weather, 'team_times', v_teams, 'roster', v_roster,
    'families', v_fam, 'order_deadline', b.order_deadline, 'discount_ends', b.discount_ends,
    'terms', v_terms, 'deliverables', v_dlv, 'retake', v_retake, 'retake_day', v_retake_day,
    'hub', v_hub, 'hub_link', v_hub_link, 'flyer', v_flyer, 'agreement', v_ag,
    'day_link', v_link, 'calendar_link', v_cal);
end $$;

-- The new email tokens for one booking (Markdown, same rules as the booking series). booking-sender merges these
-- into the tokens it already fills; anything empty falls back to the {{token|fallback}} text.
create or replace function public.booking_director_vars(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb; v_day text;
begin
  f := public.booking_director_facts(p_booking);
  if f is null then return '{}'::jsonb; end if;
  v_day := '**On picture day**' || E'\n'
    || case when f ->> 'arrival' <> '' then '- We arrive by ' || (f ->> 'arrival') || ' to set up (' || (f ->> 'setup_min') || ' minutes before we start).' || E'\n'
            else '- We arrive about ' || (f ->> 'setup_min') || ' minutes before the start time to set up.' || E'\n' end
    || '- What we need: ' || (f ->> 'needs') || E'\n'
    || case when f #>> '{contact,phone}' <> '' then '- If anything comes up that morning, call or text us at ' || (f #>> '{contact,phone}') || '.' || E'\n' else '' end
    || '- **Please reply with the name and mobile number of your on-site contact for the day.**';
  return jsonb_build_object(
    'families_block', '**How it works for families**' || E'\n' || (select string_agg('- ' || (x #>> '{}'), E'\n') from jsonb_array_elements(f -> 'families') x),
    'day_of_block', v_day,
    'weather_line', case when f ->> 'weather' <> '' then '**If the weather is bad:** ' || (f ->> 'weather') else '' end,
    'flyer_line', f ->> 'flyer',
    'team_times', case when jsonb_array_length(f -> 'team_times') > 0
                       then '**Team times**' || E'\n' || (select string_agg('- ' || (x #>> '{}'), E'\n') from jsonb_array_elements(f -> 'team_times') x) else '' end,
    'order_deadline', public.director_fmt_day((f ->> 'order_deadline')::date),
    'discount_ends', public.director_fmt_day((f ->> 'discount_ends')::date),
    'day_link', f ->> 'day_link', 'calendar_link', f ->> 'calendar_link',
    'when_line', f ->> 'when_line',
    'where_line', coalesce(nullif(f ->> 'location', ''), 'we''ll confirm the spot with you'),
    'day_of_phone', f #>> '{contact,phone}');
end $$;

-- ================================================================ 5. the public page + calendar download
-- admin.207photo.com/#day/<token>: read-only, no sign-in. Only these fields leave the database.
create or replace function public.booking_public(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid; f jsonb;
begin
  if coalesce(length(p_token), 0) < 20 then return jsonb_build_object('found', false); end if;
  select id into v_id from public.bookings where day_token = p_token and status in ('booked', 'cancelled');
  if v_id is null then return jsonb_build_object('found', false); end if;
  f := public.booking_director_facts(v_id);
  return jsonb_build_object('found', true, 'cancelled', f ->> 'status' = 'cancelled') || (f - 'booking_id' - 'status' - 'setup_min');
end $$;

create or replace function public.director_ics_text(p text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(replace(replace(coalesce(p, ''), E'\\', E'\\\\'), ';', E'\\;'), ',', E'\\,'), E'\r', ''), E'\n', E'\\n')
$$;
-- RFC 5545 lines are folded at 75 octets: CRLF + one space. 60 characters keeps accented names safe.
create or replace function public.director_ics_fold(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare v_out text := ''; v_rest text := p;
begin
  while length(v_rest) > 60 loop
    v_out := v_out || left(v_rest, 60) || E'\r\n ';
    v_rest := substr(v_rest, 61);
  end loop;
  return v_out || v_rest;
end $$;

-- The .ics for a booking token: one event per picture day (all-day while the time is not set). A cancelled booking
-- comes back as cancelled events so a calendar that imported it can drop them. Null when the token is unknown.
create or replace function public.booking_ics(p_token text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid; f jsonb; x jsonb; n int := 0; v_lines text[] := array['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//207 Photo//Picture day//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
        v_start timestamptz; v_end timestamptz; v_desc text;
begin
  if coalesce(length(p_token), 0) < 20 then return null; end if;
  select id into v_id from public.bookings where day_token = p_token and status in ('booked', 'cancelled');
  if v_id is null then return null; end if;
  f := public.booking_director_facts(v_id);
  v_desc := 'Picture day with 207 Photo for ' || (f ->> 'org') || '.'
    || case when f ->> 'arrival' <> '' then E'\nWe arrive by ' || (f ->> 'arrival') || ' to set up.' else '' end
    || case when f #>> '{contact,phone}' <> '' then E'\nPicture day phone: ' || (f #>> '{contact,phone}') else '' end
    || E'\nEverything about the day: ' || (f ->> 'day_link');
  for x in select * from jsonb_array_elements(f -> 'days') loop
    n := n + 1;
    v_start := (x ->> 'start_at')::timestamptz; v_end := (x ->> 'end_at')::timestamptz;
    v_lines := v_lines || array['BEGIN:VEVENT',
      'UID:' || v_id || '-' || n || '@207photo.com',
      'DTSTAMP:' || to_char(now() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"')];
    if v_start is not null then
      v_lines := v_lines || array['DTSTART:' || to_char(v_start at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
                                  'DTEND:' || to_char(coalesce(v_end, v_start + interval '1 hour') at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"')];
    else
      v_lines := v_lines || array['DTSTART;VALUE=DATE:' || to_char((x ->> 'day')::date, 'YYYYMMDD'),
                                  'DTEND;VALUE=DATE:' || to_char((x ->> 'day')::date + 1, 'YYYYMMDD')];
    end if;
    v_lines := v_lines || array[
      public.director_ics_fold('SUMMARY:' || public.director_ics_text('Picture day: ' || (f ->> 'org') || ' with 207 Photo' || case when x ->> 'label' <> '' then ' (' || (x ->> 'label') || ')' else '' end)),
      public.director_ics_fold('LOCATION:' || public.director_ics_text(f ->> 'location')),
      public.director_ics_fold('DESCRIPTION:' || public.director_ics_text(v_desc)),
      public.director_ics_fold('URL:' || (f ->> 'day_link')),
      'STATUS:' || case when f ->> 'status' = 'cancelled' then 'CANCELLED' else 'CONFIRMED' end,
      'END:VEVENT'];
  end loop;
  v_lines := v_lines || 'END:VCALENDAR'::text;
  return array_to_string(v_lines, E'\r\n') || E'\r\n';
end $$;

-- ================================================================ staff: the booking's director fields
create or replace function public.booking_director_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings;
begin
  if not public.can('bookings', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_id;
  if b.id is null then raise exception 'Booking not found.'; end if;
  return jsonb_build_object('team_times', b.team_times, 'order_deadline', b.order_deadline, 'discount_ends', b.discount_ends,
    'day_link', 'https://admin.207photo.com/#day/' || b.day_token,
    'calendar_link', 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?t=' || b.day_token);
end $$;

-- p: any of team_times, order_deadline, discount_ends ('' clears a date). Left-out keys are unchanged.
create or replace function public.booking_director_save(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  if not public.can('bookings', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p ? 'team_times' and length(coalesce(p ->> 'team_times', '')) > 4000 then raise exception 'Team times are too long (4,000 characters at most).'; end if;
  update public.bookings set
    team_times     = case when p ? 'team_times' then btrim(replace(coalesce(p ->> 'team_times', ''), E'\r', '')) else team_times end,
    order_deadline = case when p ? 'order_deadline' then nullif(p ->> 'order_deadline', '')::date else order_deadline end,
    discount_ends  = case when p ? 'discount_ends' then nullif(p ->> 'discount_ends', '')::date else discount_ends end
  where id = p_id
  returning day_token into v_token;
  if v_token is null then raise exception 'Booking not found.'; end if;
  return jsonb_build_object('ok', true, 'day_link', 'https://admin.207photo.com/#day/' || v_token);
end $$;

-- ================================================================ 6. moved / cancelled notes (held for review)
create table if not exists public.booking_director_notes (
  id         uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  kind       text not null check (kind in ('moved', 'cancelled')),
  email_id   uuid references public.prospect_scheduled_emails (id) on delete set null,
  old_day    date,
  new_day    date,
  note       text not null default '',
  created_at timestamptz not null default now()
);
comment on table public.booking_director_notes is 'Moved / cancelled notes queued to a booking''s main contact (held in the outbox for review).';
create index if not exists booking_director_notes_booking_idx on public.booking_director_notes (booking_id, created_at desc);
alter table public.booking_director_notes enable row level security;
revoke all on public.booking_director_notes from anon, authenticated;
grant select on public.booking_director_notes to authenticated;
drop policy if exists booking_director_notes_read on public.booking_director_notes;
create policy booking_director_notes_read on public.booking_director_notes for select to authenticated using ((select public.can_any('{bookings,partners}', 'view')));

-- After a booked job's date changes, or it is cancelled: a short note to the main booking contact, held in the
-- outbox. Only when we have already emailed them about this booking (otherwise they have nothing to correct).
-- A newer note replaces one still held. Never blocks the booking change.
create or replace function public.booking_director_on_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_kind text; v_contact uuid; v_vars jsonb; v_org text; v_hi text; v_subj text; v_body text; v_id uuid; f jsonb;
begin
  if new.status = 'cancelled' and old.status = 'booked' then v_kind := 'cancelled';
  elsif new.status = 'booked' and old.status = 'booked' and new.picture_day is distinct from old.picture_day then v_kind := 'moved';
  else return new;
  end if;
  begin
    if not exists (select 1 from public.booking_emails e where e.booking_id = new.id and e.status = 'sent') then return new; end if;
    update public.prospect_scheduled_emails e set status = 'skipped', needs_review = false
      from public.booking_director_notes n where n.booking_id = new.id and e.id = n.email_id and e.status = 'held';
    select (x ->> 'id')::uuid into v_contact from jsonb_array_elements(public.partner_contacts(new.org_id, coalesce(new.contact_ids, '{}'))) x limit 1;
    if v_contact is null then
      insert into public.booking_director_notes (booking_id, kind, old_day, new_day, note) values (new.id, v_kind, old.picture_day, new.picture_day, 'Nobody to email.');
      return new;
    end if;
    v_vars := public.partner_vars(new.org_id, v_contact);
    v_hi := coalesce(nullif(v_vars ->> 'hi', ''), 'Hi there');
    select name into v_org from public.prospect_orgs where id = new.org_id;
    f := public.booking_director_facts(new.id);
    if v_kind = 'moved' then
      v_subj := v_org || ' picture day moved to ' || public.director_fmt_day(new.picture_day);
      v_body := v_hi || E',\n\nA quick note: picture day for ' || v_org || ' is now ' || (f ->> 'when_line')
        || case when f ->> 'location' <> '' then ', at ' || (f ->> 'location') else '' end || '. It was ' || public.director_fmt_day(old.picture_day) || '.'
        || E'\n\nOur reminder emails follow the new date. If anything here is wrong, just reply to this email.'
        || E'\n\nEverything about the day is on one page: ' || (f ->> 'day_link') || E'\n\nThanks!';
    else
      v_subj := v_org || ' picture day cancelled';
      v_body := v_hi || E',\n\nThis confirms that picture day for ' || v_org || ' on ' || public.director_fmt_day(old.picture_day)
        || E' is cancelled, and the reminder emails for it are stopped.\n\nIf you would like to find a new date, just reply and we will set one up.\n\nThanks!';
    end if;
    v_id := public.partner_email_put(new.org_id, v_contact, v_subj, v_body, false);
    insert into public.booking_director_notes (booking_id, kind, email_id, old_day, new_day) values (new.id, v_kind, v_id, old.picture_day, new.picture_day);
  exception when others then
    raise warning 'booking_director_on_change: %', sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists booking_director_on_change on public.bookings;
create trigger booking_director_on_change after update of picture_day, status on public.bookings
  for each row execute function public.booking_director_on_change();

-- ================================================================ 7. files + thank-you, and the review link guard
-- The review request now knows what was delivered: {{files_block}} lists each finished deliverable with its link.
create or replace function public.partner_review_vars(p_review uuid, p_contact uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.partner_vars(r.org_id, p_contact) || jsonb_build_object(
           'review_link', (select s.review_link from public.partner_followup_settings s),
           'job', coalesce((select coalesce(nullif(b.title_override, ''), t.label) from public.bookings b left join public.booking_types t on t.key = b.type_key where b.id = r.booking_id), ''),
           'picture_day', coalesce((select public.partner_fmt_day(b.picture_day) from public.bookings b where b.id = r.booking_id), ''),
           'files_block', coalesce((select 'Here is everything we made for you:' || E'\n'
                                             || string_agg('- ' || d.label || case when coalesce(d.link, '') <> '' then ': ' || d.link else '' end, E'\n' order by d.sort, d.created_at)
                                             || E'\n\nLet me know if anything is missing.'
                                      from public.booking_deliverables d where d.booking_id = r.booking_id and d.status = 'done'), ''))
    from public.partner_reviews r where r.id = p_review
$$;

-- Same as 20261022210500, plus: no draft while the Google review link is empty (it would end in "a review: ").
create or replace function public.partner_review_autodraft(p_review uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.partner_reviews; b public.bookings; s public.partner_followup_settings; v_contact uuid; v_prev timestamptz; v_vars jsonb; v_id uuid;
begin
  select * into r from public.partner_reviews where id = p_review;
  select * into b from public.bookings where id = r.booking_id;
  select * into s from public.partner_followup_settings;
  if b.status is distinct from 'booked' then return null; end if;
  if coalesce(btrim(s.review_link), '') = '' then
    update public.partner_reviews set note = 'No Google review link yet, so no request was drafted. Add it under Reviews > Templates, then draft one.' where id = r.id; return null;
  end if;
  if exists (select 1 from public.prospect_orgs o where o.id = r.org_id and (o.stage = 'do_not_contact' or o.status = 'do_not_contact')) then
    update public.partner_reviews set note = 'Do not contact, so no request was drafted.' where id = r.id; return null;
  end if;
  select max(e.created_at) into v_prev from public.partner_reviews x join public.prospect_scheduled_emails e on e.id = x.email_id
   where x.org_id = r.org_id and x.id <> r.id and e.status not in ('skipped', 'stopped', 'failed');
  if v_prev > now() - interval '150 days' then
    update public.partner_reviews set note = 'Asked on ' || public.partner_fmt_day((v_prev at time zone 'America/New_York')::date) || ', so no new request was drafted.' where id = r.id;
    return null;
  end if;
  select (x ->> 'id')::uuid into v_contact from jsonb_array_elements(public.partner_contacts(r.org_id, b.contact_ids)) x limit 1;
  if v_contact is null then update public.partner_reviews set note = 'Nobody to email.' where id = r.id; return null; end if;
  v_vars := public.partner_review_vars(r.id, v_contact);
  v_id := public.partner_email_put(r.org_id, v_contact,
            public.prospect_tidy(public.prospect_render(s.review_subject, v_vars)), public.prospect_render(s.review_body, v_vars), false);
  update public.partner_reviews set email_id = v_id where id = r.id;
  return v_id;
end $$;

-- Any path that attaches a review email (Draft request, auto draft) stops while the review link is empty.
create or replace function public.partner_review_link_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email_id is not null and new.email_id is distinct from old.email_id
     and coalesce((select btrim(s.review_link) from public.partner_followup_settings s), '') = '' then
    raise exception 'Add your Google review link first (Reviews > Templates), so the email has a link to click.';
  end if;
  return new;
end $$;
drop trigger if exists partner_review_link_guard on public.partner_reviews;
create trigger partner_review_link_guard before update of email_id on public.partner_reviews
  for each row execute function public.partner_review_link_guard();

-- The thank-you carries the files: the default sentence becomes {{files_block|<that sentence>}}, so with nothing
-- delivered it reads exactly as before. Only where the default sentence is still there (an edited template is left alone).
alter table public.partner_followup_settings alter column review_body set default
  E'{{hi|Hi there}},\n\nThank you for having us for {{job|picture day}}. {{files_block|Everything should be in your hands now; let me know if anything is missing.}}\n\nIf you were happy with how it went, would you leave us a quick Google review? It''s the biggest help to a small business like ours: {{review_link}}\n\nAnd if you have a sentence or two we could share with other leagues and schools, just reply to this email.\n\nThanks again!';
update public.partner_followup_settings
   set review_body = replace(review_body, 'Everything should be in your hands now; let me know if anything is missing.',
                             '{{files_block|Everything should be in your hands now; let me know if anything is missing.}}')
 where strpos(review_body, '{{files_block') = 0
   and strpos(review_body, 'Everything should be in your hands now; let me know if anything is missing.') > 0;

-- ================================================================ 8. season statement email (held)
-- p_body may use {{hi|...}}, {{first_name}}, {{league}} and {{paid_line}} ("Check for $380.00 mailed on March 2, 2026
-- (check #1042)." from the latest payment, or nothing).
create or replace function public.partner_statement_queue(p_org uuid, p_subject text, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_contact uuid; v_email text; v_vars jsonb; v_paid text := ''; v_day date; v_amt numeric; v_method text; v_ref text; v_id uuid;
begin
  if not public.can('results', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select (x ->> 'id')::uuid, x ->> 'email' into v_contact, v_email from jsonb_array_elements(public.partner_contacts(p_org)) x limit 1;
  if v_contact is null then raise exception 'Nobody at this partner has an email address we can use. Add a contact on their page first.'; end if;
  select p.paid_on into v_day from public.job_payments p join public.job_results r on r.gotphoto_job_id = p.gotphoto_job_id
   where r.org_id = p_org order by p.paid_on desc, p.id desc limit 1;
  if v_day is not null then
    select sum(p.amount), max(p.method), max(p.ref) into v_amt, v_method, v_ref from public.job_payments p join public.job_results r on r.gotphoto_job_id = p.gotphoto_job_id
     where r.org_id = p_org and p.paid_on = v_day;
    v_paid := case when lower(coalesce(v_method, '')) = 'check'
      then 'Check for $' || to_char(v_amt, 'FM999,999,990.00') || ' mailed on ' || public.partner_fmt_day(v_day) || case when coalesce(v_ref, '') <> '' then ' (check #' || v_ref || ')' else '' end || '.'
      else 'Paid $' || to_char(v_amt, 'FM999,999,990.00') || case when coalesce(v_method, '') <> '' then ' by ' || v_method else '' end || ' on ' || public.partner_fmt_day(v_day) || '.' end;
  end if;
  v_vars := public.partner_vars(p_org, v_contact) || jsonb_build_object('paid_line', v_paid);
  v_id := public.partner_email_put(p_org, v_contact, public.prospect_tidy(public.prospect_render(p_subject, v_vars)), public.prospect_render(p_body, v_vars), false);
  return jsonb_build_object('ok', true, 'email_id', v_id, 'to', v_email, 'paid_line', v_paid);
end $$;

-- ================================================================ grants
revoke all on function
  public.director_fmt_day(date), public.director_fmt_time(timestamptz), public.booking_director_facts(uuid), public.booking_director_vars(uuid),
  public.booking_public(text), public.director_ics_text(text), public.director_ics_fold(text), public.booking_ics(text),
  public.booking_director_get(uuid), public.booking_director_save(uuid, jsonb), public.booking_director_on_change(),
  public.partner_review_vars(uuid, uuid), public.partner_review_autodraft(uuid), public.partner_review_link_guard(),
  public.partner_statement_queue(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.booking_director_get(uuid), public.booking_director_save(uuid, jsonb), public.partner_statement_queue(uuid, text, text) to authenticated;
-- The public page and the calendar download: by token only.
grant execute on function public.booking_public(text), public.booking_ics(text) to anon, authenticated;
-- booking-sender (service role) merges these into its tokens.
grant execute on function public.booking_director_vars(uuid) to service_role;
