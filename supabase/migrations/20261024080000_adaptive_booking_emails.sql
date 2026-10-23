-- Booking emails that react to what's been done (2026-10-23). Plan and mockup: https://claude.ai/artifact/S43JcMYjHRYbi4qNjWvkfr
--
-- Jeremiah's goal: fewer emails, only what's important, every question answered, AND as many parents as possible
-- actually told about picture day (ADs are unreliable). His decisions:
--   1. When the AD goes quiet, coaches get a paste-ready parent message, and staff get a call task when there are no
--      coaches to fall back on (schools have none).
--   2. A copy or download on the hub counts as "sent", but only inside that message's window, and 3 or more messages
--      copied in the same hour never count (they grabbed everything at once). Same rule for schools and sports.
--   3. Parent Contacts with no roster 14 days out: nothing automatic to the AD; staff get a task to keep the date (run
--      it as Roster Only) or move it.
--   4. Emails stay in Gmail; links in them go through a redirect so clicks show on the job.
--   Staff tasks go to whoever booked the job (everyone with Bookings access when that person can't take it).
--   Weather: each booking is Indoors / Outdoors / Either. For Outdoors or Either, the forecast is checked from 3 days
--   out (booking-weather edge function, National Weather Service); 20%+ rain or gusts over 25 mph during the shoot
--   alerts whoever booked. Nothing goes to the AD automatically.
--   Every day-of block names Jeremiah's own cell for emergencies, with "call more than twice" instructions.
--
-- Pieces:
--   1. columns: bookings.shoot_setting / school_data_at / geo_*; booking_steps.send_if / check_key;
--      booking_settings.emergency_*; new weather wording
--   2. booking_hub_sent(): was a hub message copied inside its window (not in a grab-everything batch)?
--   3. booking_email_skip_reason() + booking_claim_due checks it at send time; booking_reschedule leaves those alone
--   4. booking_series_vars(): the new tokens (paste-ready messages, deep links, pricing, emergency, conditional asks)
--   5. booking_director_facts / _vars: weather only when outdoors, emergency contact, flyer wording
--   6. tracked links: booking_link_clicks + booking_track_links() in booking_render_row; the "go" edge function redirects
--   7. staff follow-ups: booking_followups + booking_followups_tick (hourly) + push topics + RPCs for Today / the job
--   8. weather: booking_weather_checks + booking_weather_due / _geo / _record (booking-weather edge function, daily)
--   9. the three email series rewritten (steps updated in place, new steps added, the AD coach checklist turned off)
--  10. grants + cron
-- Safe to run twice. No deletes.

-- ================================================================ 1. columns
alter table public.bookings add column if not exists shoot_setting text;
alter table public.bookings add column if not exists school_data_at timestamptz;
alter table public.bookings add column if not exists geo_lat double precision;
alter table public.bookings add column if not exists geo_lng double precision;
alter table public.bookings add column if not exists geo_for text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_shoot_setting_check') then
    alter table public.bookings add constraint bookings_shoot_setting_check check (shoot_setting in ('indoors', 'outdoors', 'either'));
  end if;
end $$;
comment on column public.bookings.shoot_setting is 'Indoors / outdoors / either (has an indoor fallback). Set from the job type when left blank: sports outdoors, schools indoors. Outdoors and either get the weather paragraph and the forecast check.';
comment on column public.bookings.school_data_at is 'Schools: when staff ticked "student data and wifi received". The two-week email stops asking once it is set.';

alter table public.booking_steps add column if not exists send_if text[] not null default '{}';
alter table public.booking_steps add column if not exists check_key text;
comment on column public.booking_steps.send_if is 'Checked at send time; every condition must hold or the email is skipped ("Not needed: ..."). hub_not_sent: the hub message check_key (else hub_key) was not copied inside its window. no_coaches: no coach emails on file. school_open: the two-weeks message is not copied yet or student data is not in.';

alter table public.booking_settings add column if not exists emergency_name text;
alter table public.booking_settings add column if not exists emergency_phone text;
alter table public.booking_settings add column if not exists emergency_email text;
update public.booking_settings set
  emergency_name  = coalesce(emergency_name, 'Jeremiah'),
  emergency_phone = coalesce(emergency_phone, '(207) 299-3928'),
  emergency_email = coalesce(emergency_email, 'jmutty@207photo.com');
-- the new weather wording (only replaces the old default, so a hand edit stays)
update public.booking_settings
   set weather_plan = 'If we''re shooting outside and rain or high winds are in the forecast, we''ll need a backup plan. An indoor space (a gym, cafeteria or big room with an outlet) is always our first choice. We''ll also look for a rain date if we can find one, though our own schedule doesn''t always allow it. We''ll touch base the day before, but please have an alternate in mind.'
 where coalesce(btrim(weather_plan), '') = '' or weather_plan like 'Outdoor shoots move to your backup date%';

create or replace function public.booking_shoot_default() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.shoot_setting is null then
    new.shoot_setting := case when (select t.audience from public.booking_types t where t.key = new.type_key) = 'school' then 'indoors' else 'outdoors' end;
  end if;
  return new;
end $$;
drop trigger if exists bookings_shoot_default on public.bookings;
create trigger bookings_shoot_default before insert or update of shoot_setting, type_key on public.bookings
  for each row execute function public.booking_shoot_default();
update public.bookings b set shoot_setting = case when t.audience = 'school' then 'indoors' else 'outdoors' end
  from public.booking_types t where t.key = b.type_key and b.shoot_setting is null;

-- ================================================================ 2. was it sent on the hub?
-- Where a booking's messages live on the hub: sports by GotPhoto job, schools by comm_hub_schools row.
create or replace function public.booking_hub_where(p_booking uuid, out hub text, out org text, out first_day date, out live_day date)
language sql stable security definer set search_path = '' as $$
  select case when t.audience = 'school' then 'school' else 'sports' end,
         case when t.audience = 'school' then b.hub_school_id::text else b.gotphoto_job_id end,
         coalesce((select min(d.day) from public.booking_days d where d.booking_id = b.id and not d.removed), b.picture_day),
         (select (j.gp_activated_at at time zone 'America/New_York')::date from public.booking_job_info(b.id) j)
    from public.bookings b left join public.booking_types t on t.key = b.type_key
   where b.id = p_booking
$$;

-- When a copy of that message starts to count. Before this, the AD grabbed it too early to have sent it on time.
--   two weeks (m1) 17 days out · one week (heads, m2) 10 days out · day before (day, m3) 3 days before that day ·
--   retakes (r1, r2) 10 / 3 days before retake day · photos online (live, m4) once the gallery is live ·
--   last call 8 days after the gallery opened. Unknown keys: from the booking.
create or replace function public.booking_hub_window_start(p_booking uuid, p_key text, p_day date default null)
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
declare w record; b public.bookings; d date;
begin
  select * into b from public.bookings where id = p_booking;
  if b.id is null then return null; end if;
  select * into w from public.booking_hub_where(p_booking);
  d := case p_key
    when 'm1' then w.first_day - 17
    when 'heads' then w.first_day - 10
    when 'm2' then w.first_day - 10
    when 'day' then coalesce(p_day, w.first_day) - 3
    when 'm3' then w.first_day - 3
    when 'r1' then b.retake_day - 10
    when 'r2' then b.retake_day - 3
    when 'live' then w.live_day
    when 'm4' then w.live_day
    when 'lastcall' then w.live_day + 8
    else (b.created_at at time zone 'America/New_York')::date end;
  if d is null then return null; end if;
  return d::timestamp at time zone 'America/New_York';
end $$;

-- The time of the first copy or download of that message that counts as sent, or null.
create or replace function public.booking_hub_sent(p_booking uuid, p_key text, p_day date default null)
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
declare w record; v_since timestamptz; v_send text; v_at timestamptz;
begin
  select * into w from public.booking_hub_where(p_booking);
  if w.org is null or p_key is null then return null; end if;
  v_since := public.booking_hub_window_start(p_booking, p_key, p_day);
  if v_since is null then return null; end if;
  v_send := case when p_key = 'day' then 'day-' || to_char(coalesce(p_day, w.first_day), 'YYYY-MM-DD') else p_key end;
  select min(e.created_at) into v_at
    from public.hub_events e
   where e.hub = w.hub and e.org_id = w.org and e.send_key = v_send and e.created_at >= v_since
     and (select count(distinct e2.send_key) from public.hub_events e2
           where e2.hub = e.hub and e2.org_id = e.org_id
             and e2.created_at between e.created_at - interval '1 hour' and e.created_at + interval '1 hour') < 3;
  return v_at;
end $$;

-- ================================================================ 3. skip at send time
-- Null = send it. Otherwise the reason, always starting "Not needed: " (booking_reschedule leaves those rows alone).
create or replace function public.booking_email_skip_reason(p_email uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare e public.booking_emails; st public.booking_steps; c text; v_key text; v_day date; v_at timestamptz; b public.bookings;
begin
  select * into e from public.booking_emails where id = p_email;
  select * into st from public.booking_steps where id = e.step_id;
  if st.id is null or coalesce(cardinality(st.send_if), 0) = 0 then return null; end if;
  select * into b from public.bookings where id = e.booking_id;
  foreach c in array st.send_if loop
    if c = 'hub_not_sent' then
      v_key := coalesce(st.check_key, st.hub_key);
      if v_key = 'day' then
        select d.day into v_day from public.booking_days d where d.booking_id = b.id and not d.removed
         order by d.day offset greatest(coalesce(e.day_index, 0), 0) limit 1;
      else v_day := null; end if;
      v_at := public.booking_hub_sent(b.id, v_key, v_day);
      if v_at is not null then
        return 'Not needed: the message was copied on the hub ' || trim(to_char(v_at at time zone 'America/New_York', 'FMMon FMDD, FMHH12:MI AM'));
      end if;
    elsif c = 'no_coaches' then
      if coalesce(cardinality(public.booking_coach_emails(b.id)), 0) > 0 then return 'Not needed: the coaches got this one'; end if;
    elsif c = 'school_open' then
      if public.booking_hub_sent(b.id, 'm1') is not null and b.school_data_at is not null then
        return 'Not needed: the two-weeks message was copied and the student data is in';
      end if;
    end if;
  end loop;
  return null;
end $$;

-- booking_claim_due as it was (prod 2026-10-23), plus the skip check before each email goes out.
create or replace function public.booking_claim_due(p_limit integer default 20, p_now timestamp with time zone default now())
returns setof jsonb language plpgsql security definer set search_path to 'public' as $function$
declare s booking_settings; v_local time; r record; v_thread text; v_rfc text; v_coach boolean; v_skip text;
begin
  select * into s from booking_settings;
  if not s.sending_enabled then return; end if;
  v_local := (p_now at time zone 'America/New_York')::time;
  if (s.quiet_start > s.quiet_end and (v_local >= s.quiet_start or v_local < s.quiet_end))
     or (s.quiet_start <= s.quiet_end and v_local >= s.quiet_start and v_local < s.quiet_end) then return; end if;

  update booking_emails set status = 'scheduled' where status = 'sending' and updated_at < p_now - interval '30 minutes';
  update booking_emails set status = 'cancelled', reason = 'step no longer exists' where status in ('scheduled', 'waiting') and step_id is null;

  for r in
    with due as (
      select e.id from booking_emails e join bookings b on b.id = e.booking_id
       where e.status = 'scheduled' and e.send_at <= p_now and b.status = 'booked' and e.step_id is not null
       order by e.send_at limit p_limit
       for update of e skip locked)
    update booking_emails e set status = 'sending', attempts = attempts + 1
      from due where e.id = due.id
    returning e.*
  loop
    -- adaptive series (2026-10-24): a step with send_if conditions is checked now, with the hub as it stands
    v_skip := public.booking_email_skip_reason(r.id);
    if v_skip is not null then
      update booking_emails set status = 'skipped', reason = v_skip, attempts = greatest(attempts - 1, 0) where id = r.id;
      continue;
    end if;
    -- Gmail thread: admin + hub steps continue the first email to the AD; coach steps continue the first coach email
    select (st.kind = 'coach') into v_coach from booking_steps st where st.id = r.step_id;
    v_coach := coalesce(v_coach, false);
    select e2.gmail_thread_id, e2.rfc_message_id into v_thread, v_rfc
      from booking_emails e2 left join booking_steps s2 on s2.id = e2.step_id
     where e2.booking_id = r.booking_id and e2.status = 'sent' and e2.gmail_thread_id is not null and not e2.test_mode
       and (coalesce(s2.kind, 'admin') = 'coach') = v_coach
     order by e2.sent_at asc limit 1;
    -- recipients re-checked at send time: an address flagged since scheduling is dropped (whole row fails when nobody is left)
    return next public.booking_render_row(r.id) || jsonb_build_object(
      'booking_id', r.booking_id, 'attempts', r.attempts, 'thread_id', v_thread, 'thread_rfc_id', v_rfc,
      'to', to_jsonb((select array_agg(x) from unnest(r.to_emails) x
                       where not exists (select 1 from prospect_contacts pc where lower(pc.email) = x and (pc.bounced_at is not null or pc.unsubscribed_at is not null)))),
      'cc', to_jsonb((select coalesce(array_agg(x), '{}') from unnest(r.cc_emails) x
                       where not exists (select 1 from prospect_contacts pc where lower(pc.email) = x and (pc.bounced_at is not null or pc.unsubscribed_at is not null)))),
      'test_mode', s.test_mode, 'test_recipient', s.test_recipient, 'bcc', s.bcc,
      'from_name', s.from_name, 'from_email', s.from_email, 'reply_to', s.reply_to, 'signature', s.signature);
  end loop;
end $function$;

-- booking_reschedule: a row skipped as "Not needed" stays skipped (it would otherwise be rescheduled every 15 minutes).
create or replace function pg_temp.patch_once(p_sig regprocedure, p_marker text, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  if strpos(v_def, p_marker) > 0 then raise notice 'patch %: already applied', p_sig; return; end if;
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;

select pg_temp.patch_once('public.booking_reschedule(uuid)'::regprocedure, 'Not needed:%',
  'if v_existing\.id is not null and v_existing\.status in \(''sent'', ''sending'', ''cancelled'', ''failed''\) then continue; end if;',
  'if v_existing.id is not null and (v_existing.status in (''sent'', ''sending'', ''cancelled'', ''failed'')
         or (v_existing.status = ''skipped'' and v_existing.reason like ''Not needed:%'')) then continue; end if;', 1);

-- ================================================================ 4. the new tokens
create or replace function public.booking_series_vars(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  b public.bookings; t public.booking_types; s public.booking_settings; w record; v_org text; v_aud text;
  v_hubbase text; v_n int; v_start timestamptz; v_when text; v_wd text; v_price date; v_price_txt text := '';
  v_em text := ''; v_em_line text := ''; v_days int; v_short text := ''; v_two text := ''; v_data text := '';
  v_heads text; v_day text; v_live text; v_links jsonb := '{}'::jsonb; k text;
begin
  select * into b from public.bookings where id = p_booking;
  if b.id is null then return '{}'::jsonb; end if;
  select * into t from public.booking_types where key = b.type_key;
  select * into s from public.booking_settings limit 1;
  select o.name into v_org from public.prospect_orgs o where o.id = b.org_id;
  v_aud := case when t.audience = 'school' then 'school' else 'sports' end;
  select * into w from public.booking_hub_where(p_booking);
  v_n := case when v_aud = 'sports' then coalesce(cardinality(public.booking_coach_emails(p_booking)), 0) else 0 end;

  -- deep links to each hub message (the same form booking_vars uses for {{hub_link}})
  v_hubbase := case when v_aud = 'school' then 'https://207photo.com/schooladmin/#school=' || coalesce(b.hub_school_id::text, '')
                    else 'https://207photo.com/sportsadmin/#job=' || coalesce(b.gotphoto_job_id, '') end;
  foreach k in array case when v_aud = 'school' then array['m1', 'm2', 'm3', 'm4', 'r1', 'r2'] else array['heads', 'live', 'lastcall'] end loop
    v_links := v_links || jsonb_build_object('link_' || k, v_hubbase || '/send=' || k || '/r');
  end loop;
  if v_aud = 'sports' then v_links := v_links || jsonb_build_object('link_day', v_hubbase || '/send=day-' || to_char(w.first_day, 'YYYY-MM-DD') || '/r'); end if;

  -- the first day's start, for the paste-ready lines
  select d.start_at into v_start from public.booking_days d where d.booking_id = b.id and not d.removed order by d.day, d.sort limit 1;
  if v_start is null and b.time_set then v_start := b.start_at; end if;
  v_wd := trim(to_char(w.first_day, 'FMDay'));
  v_when := trim(to_char(w.first_day, 'FMDay, FMMonth FMDD')) ||
            case when v_start is not null then ' at ' || lower(trim(to_char(v_start at time zone 'America/New_York', 'FMHH12:MI AM'))) else '' end;

  -- early-order pricing: the booking's own date, else two weeks after the gallery opened
  v_price := coalesce(b.discount_ends, w.live_day + 14);
  if v_price is not null then v_price_txt := trim(to_char(v_price, 'FMDay, FMMonth FMDD')); end if;

  -- picture day emergencies: always the owner's own cell, whoever booked
  if coalesce(btrim(s.emergency_phone), '') <> '' then
    v_em := 'If something goes wrong and you can''t reach us, call ' || coalesce(nullif(btrim(s.emergency_name), ''), 'Jeremiah') || ' directly at ' || s.emergency_phone
         || case when coalesce(btrim(s.emergency_email), '') <> '' then ' (or email ' || s.emergency_email || ')' else '' end
         || '. That phone screens calls, so if it goes to voicemail, call again right away: calling more than twice in a row rings through.';
    v_em_line := '**Picture day emergency?** ' || v_em;
  end if;

  v_days := w.first_day - (now() at time zone 'America/New_York')::date;
  if v_aud = 'sports' and v_days < 14 then
    v_short := '**Is picture day less than two weeks away?** Then the deadline has already passed and these are urgent. Send your roster today, and send families the message the hub shows you today.';
  elsif v_aud = 'school' and v_days < 21 then
    v_short := '**Is picture day less than three weeks away?** Then there is no time to spare. Send families the message the hub shows you today, and send us your student data today too.';
  end if;

  if v_aud = 'school' then
    if public.booking_hub_sent(p_booking, 'm1') is null then
      v_two := '**Send the "Two weeks before" message today.** It''s ready as an email, a text, a printed flyer or a social post: ' || (v_links ->> 'link_m1') || '. There''s also a "How to access your photos" picture to attach.';
    end if;
    if b.school_data_at is null then
      v_data := '**Student data:** we don''t have it yet, and it was due last week. The list of what we need and a sample are in our first email: student ID, first and last name, grade, homeroom teacher, and job title for staff, plus the name of your student information system. If wifi is an option on picture day, reply with the network name and password too.';
    end if;
    v_heads := '> School picture day is ' || trim(to_char(w.first_day, 'FMDay, FMMonth FMDD')) || '. No order forms and nothing to send in. Photos go online after picture day, and the link and access code come from school.';
    v_day := '';
    v_live := '';
  else
    v_heads := '> Picture day is ' || v_when || case when coalesce(btrim(b.location), '') <> '' then ' at ' || split_part(b.location, ',', 1) else '' end
            || '. Athletes should come in a clean, full uniform with their own gear. Nothing to pay on the day. Photos go online afterward at 207photo.com under Find My Photos.';
    v_day := '> Reminder: team photos are ' || v_wd || case when v_start is not null then ' at ' || lower(trim(to_char(v_start at time zone 'America/New_York', 'FMHH12:MI AM'))) else '' end
          || '. Clean, full uniform, and bring your own gear. Nothing to pay on the day.';
    v_live := '> Team photos are online! Go to 207photo.com, Find My Photos, and search "' || coalesce(v_org, '') || '".'
           || case when v_price is not null then ' Early-order pricing ends ' || trim(to_char(v_price, 'FMMonth FMDD')) || '.' else '' end;
  end if;

  return v_links || jsonb_build_object(
    'hub_home', v_hubbase,
    'short_notice', v_short,
    'paste_heads', v_heads, 'paste_day', v_day, 'paste_live', v_live,
    'pricing_ends', v_price_txt,
    'pricing_line', case when v_price_txt <> '' then '**Early-order pricing ends ' || v_price_txt || '.**' else '' end,
    'coach_tips_if_none', case when v_aud = 'sports' and v_n = 0 then
        '**For your coaches** (we don''t have their emails yet): teams grouped and ready at their time, a clean, full uniform, and their own gear (glove, bat, stick, club). Game balls are provided.' else '' end,
    'coaches_cc_line', case when v_aud <> 'sports' then ''
        when v_n > 0 then 'We''ve sent this to your coaches too, so they can post it to their team chats.'
        else 'If it''s easier, forward this to your coaches and ask them to post it to their team chats.' end,
    'coaches_live_line', case when v_aud = 'sports' and v_n > 0 then 'We''ve sent your coaches the link too.' else '' end,
    'two_weeks_ask', v_two, 'data_ask', v_data,
    'emergency_line', v_em_line);
end $$;

select pg_temp.patch_once(p.oid::regprocedure, 'booking_series_vars(p_booking)',
  'return v \|\| coalesce\(public\.booking_director_vars\(p_booking\), ''\{\}''::jsonb\);',
  'return v || coalesce(public.booking_director_vars(p_booking), ''{}''::jsonb) || coalesce(public.booking_series_vars(p_booking), ''{}''::jsonb);', 1)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'booking_vars';

-- ================================================================ 5. director facts and blocks
-- Weather only for outdoor / either bookings; the emergency contact; the flyer line no longer says "about a week before".
select pg_temp.patch_once('public.booking_director_facts(uuid)'::regprocedure, 'shoot_setting',
  'if v_aud = ''sports'' then v_weather := coalesce\(nullif\(btrim\(s\.weather_plan\), ''''\), ''''\); end if;',
  'if coalesce(bj ->> ''shoot_setting'', case when v_aud = ''sports'' then ''outdoors'' else ''indoors'' end) <> ''indoors'' then v_weather := coalesce(nullif(btrim(s.weather_plan), ''''), ''''); end if;', 1);
select pg_temp.patch_once('public.booking_director_facts(uuid)'::regprocedure, 'Each one shows up there',
  'Post the flyer and send the email about a week before picture day\.',
  'Each one shows up there when it''''s due, and we email you on each send day.', 1);
select pg_temp.patch_once('public.booking_director_facts(uuid)'::regprocedure, '''emergency''',
  '''day_link'', v_link, ''calendar_link'', v_cal\);',
  '''day_link'', v_link, ''calendar_link'', v_cal,
    ''shoot_setting'', coalesce(bj ->> ''shoot_setting'', ''''),
    ''emergency'', case when coalesce(btrim(s.emergency_phone), '''') <> '''' then jsonb_build_object(
      ''name'', coalesce(nullif(btrim(s.emergency_name), ''''), ''Jeremiah''), ''phone'', s.emergency_phone, ''email'', coalesce(s.emergency_email, '''')) end);', 1);

select pg_temp.patch_once('public.booking_director_vars(uuid)'::regprocedure, 'calling more than twice',
  '\|\| ''- \*\*Please reply with the name and mobile number of your on-site contact for the day\.\*\*'';',
  '|| ''- **Please reply with the name and mobile number of your on-site contact for the day.**''
    || case when f #>> ''{emergency,phone}'' <> '''' then E''\\n'' || ''- **If something goes wrong and you can''''t reach us,** call '' || (f #>> ''{emergency,name}'') || '' directly at '' || (f #>> ''{emergency,phone}'')
         || case when f #>> ''{emergency,email}'' <> '''' then '' (or email '' || (f #>> ''{emergency,email}'') || '')'' else '''' end
         || ''. That phone screens calls, so if it goes to voicemail, call again right away: calling more than twice in a row rings through.'' else '''' end;', 1);
select pg_temp.patch_once('public.booking_director_vars(uuid)'::regprocedure, 'If the weather looks bad',
  '\*\*If the weather is bad:\*\* ', '**If the weather looks bad:** ', 1);

-- ================================================================ 6. tracked links
create table if not exists public.booking_link_clicks (
  id         bigint generated always as identity primary key,
  email_id   uuid not null references public.booking_emails (id) on delete cascade,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  url        text not null,
  ip_key     text,
  at         timestamptz not null default now()
);
create index if not exists booking_link_clicks_booking on public.booking_link_clicks (booking_id, at desc);
alter table public.booking_link_clicks enable row level security;

-- Only our own pages are tracked (and redirected to): the hubs, the picture day page, the calendar file.
create or replace function public.booking_link_ok(p_url text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_url, '') ~ '^https://(207photo\.com/(sportsadmin|schooladmin)|admin\.207photo\.com/#day/|socluffmclkdljtmiexw\.supabase\.co/functions/v1/booking-ics\?)'
     and length(p_url) < 600
$$;

create or replace function public.booking_track_links(p_body text, p_email uuid) returns text
language plpgsql immutable set search_path = '' as $$
declare m text; v text := coalesce(p_body, '');
begin
  if p_email is null then return v; end if;
  -- longest first: the hub's home link is a prefix of each message link
  for m in select u from (select distinct regexp_replace(x[1], '[.,;:]+$', '') u
                            from regexp_matches(v, '(https://(?:207photo\.com/(?:sportsadmin|schooladmin)|admin\.207photo\.com/#day/|socluffmclkdljtmiexw\.supabase\.co/functions/v1/booking-ics\?)[^\s\)\]>"<]*)', 'g') x) q
            order by length(u) desc loop
    if public.booking_link_ok(m) then
      v := replace(v, m, 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/go?e=' || p_email
                        || '&u=' || translate(replace(encode(convert_to(m, 'UTF8'), 'base64'), E'\n', ''), '+/=', '-_'));
    end if;
  end loop;
  return v;
end $$;

-- The redirect logs a click and answers where to go (null: not one of ours).
create or replace function public.booking_link_click(p_email uuid, p_url text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_booking uuid; v_ip text;
begin
  if not public.booking_link_ok(p_url) then return null; end if;
  select booking_id into v_booking from public.booking_emails where id = p_email;
  if v_booking is null then return p_url; end if;
  v_ip := nullif(btrim(coalesce(current_setting('request.headers', true)::json ->> 'cf-connecting-ip',
            split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1), '')), '');
  if not exists (select 1 from public.booking_link_clicks c where c.email_id = p_email and c.url = p_url and c.at > now() - interval '10 minutes')
     and (select count(*) from public.booking_link_clicks c where c.booking_id = v_booking and c.at > now() - interval '1 hour') < 60 then
    insert into public.booking_link_clicks (email_id, booking_id, url, ip_key) values (p_email, v_booking, p_url, v_ip);
  end if;
  return p_url;
exception when others then return p_url;
end $$;

-- booking_render_row as it was (prod 2026-10-23), with links tracked in emails not sent yet.
create or replace function public.booking_render_row(p_email uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare e booking_emails; st booking_steps; v jsonb; v_sub text; v_body text;
begin
  select * into e from booking_emails where id = p_email;
  if e.id is null then return null; end if;
  select * into st from booking_steps where id = e.step_id;
  v := public.booking_vars(e.booking_id, coalesce(e.to_contact_id, e.contact_id), e.step_id, coalesce(e.day_index, 0));
  if e.status in ('sent', 'sending') and e.subject is not null then
    v_sub := e.subject; v_body := e.body_text;
  else
    v_sub := public.prospect_render(coalesce(st.subject, e.subject, ''), v);
    v_body := public.prospect_render(coalesce(st.body_md, e.body_text, ''), v);
    v_body := regexp_replace(v_body, E'\n[ \t]*\n[ \t]*\n+', E'\n\n', 'g');
    v_body := public.booking_track_links(v_body, e.id);
  end if;
  return jsonb_build_object('id', e.id, 'subject', v_sub, 'body', v_body, 'to_email', e.to_email, 'to_name', e.to_name,
    'to_emails', to_jsonb(e.to_emails), 'cc_emails', to_jsonb(e.cc_emails),
    'step_no', e.step_no, 'label', coalesce(st.label, ''), 'kind', coalesce(st.kind, 'admin'), 'status', e.status, 'send_at', e.send_at, 'vars', v);
end $function$;

-- ================================================================ 7. staff follow-ups
create table if not exists public.booking_followups (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references public.bookings (id) on delete cascade,
  kind         text not null check (kind in ('parents', 'roster', 'weather')),
  key          text not null,
  title        text not null,
  detail       text not null default '',
  data         jsonb,
  assigned_to  uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  snooze_until date,
  done_at      timestamptz,
  done_by      uuid,
  done_note    text,
  unique (booking_id, key)
);
create index if not exists booking_followups_open on public.booking_followups (assigned_to) where done_at is null;
alter table public.booking_followups enable row level security;
comment on table public.booking_followups is 'Staff tasks from the booking email series: parents not reached (no coaches to fall back on), no roster 14 days out (Parent Contacts), weather. On Today for whoever booked the job; resolved by hand or on their own.';

insert into public.push_topics (key, label, description, module, sort, default_on, default_mode) values
  ('parents_followup', 'Parents not reached', 'A team or school hasn''t sent families a picture day message and needs a call, or a Parent Contacts job has no roster two weeks out. Goes to whoever booked the job.', 'bookings', 45, true, 'push'),
  ('weather_alert', 'Weather alerts', 'Rain or high wind in the forecast for an outdoor picture day, from three days out. Goes to whoever booked the job.', 'bookings', 46, true, 'push')
on conflict (key) do nothing;

-- Whoever booked the job, while they're an active team member with Bookings access. Null = everyone with Bookings.
create or replace function public.booking_followup_owner(p_booking uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select b.created_by from public.bookings b
   where b.id = p_booking and b.created_by is not null
     and exists (select 1 from public.team_members m where m.user_id = b.created_by
                   and (m.active or exists (select 1 from public.admin_users a where a.user_id = m.user_id)))
     and public.team_user_can(b.created_by, 'bookings')
$$;

-- Opens (or reopens) a task and pushes it. Returns true when it is new or reopened.
create or replace function public.booking_followup_raise(p_booking uuid, p_kind text, p_key text, p_title text, p_detail text, p_data jsonb default null, p_reopen boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := public.booking_followup_owner(p_booking); f public.booking_followups; v_new boolean := false; v_topic text;
begin
  select * into f from public.booking_followups where booking_id = p_booking and key = p_key;
  if f.id is null then
    insert into public.booking_followups (booking_id, kind, key, title, detail, data, assigned_to)
    values (p_booking, p_kind, p_key, p_title, coalesce(p_detail, ''), p_data, v_owner);
    v_new := true;
  elsif f.done_at is not null and p_reopen then
    update public.booking_followups set title = p_title, detail = coalesce(p_detail, ''), data = p_data, assigned_to = v_owner,
           done_at = null, done_by = null, done_note = null, snooze_until = null, updated_at = now() where id = f.id;
    v_new := true;
  elsif f.done_at is null then
    update public.booking_followups set title = p_title, detail = coalesce(p_detail, ''), data = p_data, updated_at = now() where id = f.id;
  end if;
  if v_new then
    v_topic := case when p_kind = 'weather' then 'weather_alert' else 'parents_followup' end;
    begin
      if v_owner is null then
        perform public.push_notify(v_topic, p_title, left(coalesce(p_detail, ''), 280), '/#jobs/job/' || p_booking, v_topic || ':' || p_booking || ':' || p_key);
      elsif public.push_mode(v_owner, v_topic) = 'push' then
        perform public.push_notify(v_topic, p_title, left(coalesce(p_detail, ''), 280), '/#jobs/job/' || p_booking, v_topic || ':' || p_booking || ':' || p_key, v_owner);
      end if;
    exception when others then raise warning 'booking_followup_raise push: %', sqlerrm;
    end;
  end if;
  return v_new;
end $$;

create or replace function public.booking_followup_resolve(p_booking uuid, p_key text, p_note text) returns void
language sql security definer set search_path = '' as $$
  update public.booking_followups set done_at = now(), done_note = p_note, updated_at = now()
   where booking_id = p_booking and key = p_key and done_at is null
$$;

-- Hourly. Raises and clears the parents / roster tasks; weather has its own (booking_weather_record).
create or replace function public.booking_followups_tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; w record; j record; v_today date := (now() at time zone 'America/New_York')::date; v_n int; v_key text;
        v_ad text; v_phone text; v_raised int := 0; v_closed int := 0; v_league boolean; v_roster boolean;
begin
  for r in
    select b.id, b.org_id, b.type_key, b.sequence_id, t.audience, o.name org, b.contact_ids
      from public.bookings b join public.booking_types t on t.key = b.type_key left join public.prospect_orgs o on o.id = b.org_id
     where b.status = 'booked' and b.picture_day >= v_today - 30
  loop
    select * into w from public.booking_hub_where(r.id);
    select * into j from public.booking_job_info(r.id);
    v_n := case when r.audience = 'school' then 0 else coalesce(cardinality(public.booking_coach_emails(r.id)), 0) end;
    v_league := coalesce(j.workflow, '') = 'league';
    v_roster := j.roster_loaded_at is not null;
    select nullif(btrim(concat_ws(' ', pc.first_name, pc.last_name)), ''), coalesce(nullif(btrim(pc.phone), ''), '')
      into v_ad, v_phone
      from public.prospect_contacts pc where pc.id = (select rr.to_contact from public.booking_recipients(r.id, true) rr);

    -- families not told a week out (5 days before, no coaches to fall back on)
    v_key := case when r.audience = 'school' then 'm2' else 'heads' end;
    if w.first_day - v_today between 0 and 5 and v_n = 0 and public.booking_hub_sent(r.id, v_key) is null then
      if public.booking_followup_raise(r.id, 'parents', v_key, 'Families not told: ' || coalesce(r.org, 'a job'),
           coalesce(r.org, 'This job') || ' has picture day ' || trim(to_char(w.first_day, 'FMDay, FMMon FMDD')) || ', and families haven''t been sent the one-week message.'
           || case when r.audience = 'school' then ' Call the school.' else ' There are no coaches on file to fall back on. Call or text ' || coalesce(v_ad, 'the AD') || '.' end
           || case when v_phone <> '' then ' ' || v_phone || '.' else '' end) then v_raised := v_raised + 1; end if;
    elsif w.first_day < v_today or public.booking_hub_sent(r.id, v_key) is not null then
      perform public.booking_followup_resolve(r.id, v_key, case when w.first_day < v_today then 'Picture day passed' else 'The message was sent' end);
    end if;

    -- gallery link not sent 2 days after it opened
    v_key := case when r.audience = 'school' then 'm4' else 'live' end;
    if w.live_day is not null and v_today - w.live_day between 2 and 10 and v_n = 0 and not (v_league and v_roster)
       and public.booking_hub_sent(r.id, v_key) is null then
      if public.booking_followup_raise(r.id, 'parents', v_key, 'Gallery link not sent: ' || coalesce(r.org, 'a job'),
           'The gallery for ' || coalesce(r.org, 'this job') || ' has been live ' || (v_today - w.live_day) || ' days, and families haven''t been sent the link.'
           || case when r.audience = 'school' then ' Call the school.' else ' Call or text ' || coalesce(v_ad, 'the AD') || '.' end
           || case when v_phone <> '' then ' ' || v_phone || '.' else '' end) then v_raised := v_raised + 1; end if;
    elsif w.live_day is not null and (v_today - w.live_day > 10 or public.booking_hub_sent(r.id, v_key) is not null) then
      perform public.booking_followup_resolve(r.id, v_key, case when public.booking_hub_sent(r.id, v_key) is not null then 'The message was sent' else 'Past the gallery''s first ten days' end);
    end if;

    -- Parent Contacts with no roster two weeks out: staff decide (keep the date and run it as Roster Only, or move it)
    if r.audience = 'sports' and r.type_key = 'sports_data' and not v_roster and w.first_day - v_today between 0 and 14 then
      if public.booking_followup_raise(r.id, 'roster', 'roster', 'No roster: ' || coalesce(r.org, 'a job'),
           coalesce(r.org, 'This job') || ' has picture day ' || trim(to_char(w.first_day, 'FMDay, FMMon FMDD')) || ' and no roster with parent emails yet. Keep the date and run it as Roster Only, or move it.') then v_raised := v_raised + 1; end if;
    elsif v_roster or w.first_day < v_today or r.type_key <> 'sports_data' then
      perform public.booking_followup_resolve(r.id, 'roster', case when v_roster then 'The roster came in' when r.type_key <> 'sports_data' then 'Running as Roster Only' else 'Picture day passed' end);
    end if;
  end loop;
  -- anything left open on a booking that's cancelled or done
  update public.booking_followups f set done_at = now(), done_note = 'The booking is no longer active', updated_at = now()
    from public.bookings b where b.id = f.booking_id and f.done_at is null and b.status <> 'booked';
  get diagnostics v_closed = row_count;
  return jsonb_build_object('raised', v_raised, 'closed_inactive', v_closed);
end $$;

-- Open tasks for Today: the signed-in person's own, plus unassigned ones when they have Bookings access.
create or replace function public.booking_followups_mine() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'booking_id', f.booking_id, 'kind', f.kind, 'key', f.key,
           'title', f.title, 'detail', f.detail, 'org', o.name, 'picture_day', b.picture_day, 'created_at', f.created_at)
           order by b.picture_day, f.created_at), '[]'::jsonb)
    from public.booking_followups f
    join public.bookings b on b.id = f.booking_id
    left join public.prospect_orgs o on o.id = b.org_id
   where f.done_at is null and (f.snooze_until is null or f.snooze_until <= (now() at time zone 'America/New_York')::date)
     and public.is_team_member()
     and (f.assigned_to = (select auth.uid()) or (f.assigned_to is null and public.can('bookings', 'view')))
$$;

create or replace function public.booking_followup_done(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.booking_followups;
begin
  select * into f from public.booking_followups where id = p_id;
  if f.id is null then raise exception 'That task is gone.'; end if;
  if not (public.can('bookings', 'edit') or f.assigned_to = (select auth.uid())) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.booking_followups set done_at = now(), done_by = (select auth.uid()), done_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.booking_followup_snooze(p_id uuid, p_days int default 1) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.booking_followups;
begin
  select * into f from public.booking_followups where id = p_id;
  if f.id is null then raise exception 'That task is gone.'; end if;
  if not (public.can('bookings', 'edit') or f.assigned_to = (select auth.uid())) then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.booking_followups set snooze_until = (now() at time zone 'America/New_York')::date + greatest(1, least(coalesce(p_days, 1), 14)), updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- "Keep the date": the booking switches to the Roster Only series (its sent emails stay sent) and the task closes.
create or replace function public.booking_run_roster_only(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_seq uuid;
begin
  if not public.can('bookings', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select id into v_seq from public.booking_sequences where type_key = 'sports_nodata' and is_active order by created_at limit 1;
  if v_seq is null then raise exception 'There is no active Roster Only email series.'; end if;
  update public.bookings set type_key = 'sports_nodata', sequence_id = v_seq, updated_at = now() where id = p_booking and status = 'booked';
  if not found then raise exception 'Booking not found.'; end if;
  perform public.booking_reschedule(p_booking);
  update public.booking_followups set done_at = now(), done_by = (select auth.uid()), done_note = 'Kept the date: running as Roster Only', updated_at = now()
   where booking_id = p_booking and key = 'roster' and done_at is null;
  return jsonb_build_object('ok', true);
end $$;

-- ================================================================ 8. weather
create table if not exists public.booking_weather_checks (
  booking_id uuid not null references public.bookings (id) on delete cascade,
  day        date not null,
  checked_at timestamptz not null default now(),
  max_pop    int,
  max_gust   int,
  bad        boolean not null default false,
  hours      jsonb,
  error      text,
  primary key (booking_id, day)
);
alter table public.booking_weather_checks enable row level security;

-- For booking-weather: outdoor / either days 1 to 3 days out, with where and when.
create or replace function public.booking_weather_due() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('booking_id', b.id, 'day', d.day, 'days_out', d.day - (now() at time zone 'America/New_York')::date,
           'location', b.location, 'lat', b.geo_lat, 'lng', b.geo_lng, 'geo_for', b.geo_for,
           'start_at', case when coalesce(d.start_at, case when b.time_set then b.start_at end) is not null then coalesce(d.start_at, b.start_at) end,
           'end_at', case when coalesce(d.end_at, case when b.end_set then b.end_at end) is not null then coalesce(d.end_at, b.end_at) end)
           order by d.day), '[]'::jsonb)
    from public.bookings b
    join lateral (select x.day, x.start_at, x.end_at from public.booking_days x where x.booking_id = b.id and not x.removed
                  union all select b.picture_day, null::timestamptz, null::timestamptz
                   where not exists (select 1 from public.booking_days x where x.booking_id = b.id and not x.removed)) d on true
   where b.status = 'booked' and coalesce(b.shoot_setting, 'outdoors') <> 'indoors'
     and coalesce(btrim(b.location), '') <> ''
     and d.day - (now() at time zone 'America/New_York')::date between 1 and 3
$$;

create or replace function public.booking_weather_geo(p_booking uuid, p_lat double precision, p_lng double precision, p_for text) returns void
language sql security definer set search_path = '' as $$
  update public.bookings set geo_lat = p_lat, geo_lng = p_lng, geo_for = p_for where id = p_booking
$$;

-- One check of one day. Alerts whoever booked the first time it looks bad; the day before, it says again if it changed.
create or replace function public.booking_weather_record(p_booking uuid, p_day date, p_max_pop int, p_max_gust int, p_hours jsonb, p_error text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_bad boolean; v_prev public.booking_weather_checks; v_key text := 'weather-' || to_char(p_day, 'YYYY-MM-DD');
        v_org text; v_days int; v_title text; v_detail text; v_alerted boolean := false; v_hours text;
begin
  if p_error is not null then
    insert into public.booking_weather_checks (booking_id, day, checked_at, error) values (p_booking, p_day, now(), left(p_error, 300))
    on conflict (booking_id, day) do update set checked_at = now(), error = excluded.error;
    return jsonb_build_object('ok', false);
  end if;
  v_bad := coalesce(p_max_pop, 0) >= 20 or coalesce(p_max_gust, 0) > 25;
  select * into v_prev from public.booking_weather_checks where booking_id = p_booking and day = p_day;
  insert into public.booking_weather_checks (booking_id, day, checked_at, max_pop, max_gust, bad, hours, error)
  values (p_booking, p_day, now(), p_max_pop, p_max_gust, v_bad, p_hours, null)
  on conflict (booking_id, day) do update set checked_at = now(), max_pop = excluded.max_pop, max_gust = excluded.max_gust,
     bad = excluded.bad, hours = excluded.hours, error = null;

  select o.name into v_org from public.bookings b left join public.prospect_orgs o on o.id = b.org_id where b.id = p_booking;
  v_days := p_day - (now() at time zone 'America/New_York')::date;
  select string_agg((h ->> 'hour') || ' ' || coalesce(h ->> 'pop', '0') || '% rain, gusts ' || coalesce(h ->> 'gust', '0') || ' mph', '; ')
    into v_hours from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) h;
  v_detail := coalesce(v_org, 'This job') || ', ' || trim(to_char(p_day, 'FMDay, FMMon FMDD')) || ': up to ' || coalesce(p_max_pop, 0) || '% chance of rain, gusts to '
           || coalesce(p_max_gust, 0) || ' mph during the shoot. Bring tents, or talk to the AD about an indoor space, or a rain date if we have one open.'
           || case when v_hours is not null then ' By hour: ' || v_hours || '.' else '' end;

  if v_bad then
    v_title := case when v_days <= 1 and v_prev.booking_id is not null and v_prev.bad then 'Still rain or wind tomorrow: ' else 'Weather watch: ' end || coalesce(v_org, 'a job');
    -- new, or (the day before) reopened when it had cleared; otherwise just refresh the numbers
    v_alerted := public.booking_followup_raise(p_booking, 'weather', v_key, v_title, v_detail,
                   jsonb_build_object('day', p_day, 'max_pop', p_max_pop, 'max_gust', p_max_gust, 'hours', p_hours), v_days <= 1);
    if not v_alerted and v_days <= 1 and v_prev.booking_id is not null and v_prev.bad and v_prev.checked_at::date < now()::date then
      -- still bad the day before: one more push so it's on their mind
      begin
        perform public.push_notify('weather_alert', v_title, left(v_detail, 280), '/#jobs/job/' || p_booking, 'weather_alert:' || p_booking || ':' || v_key || ':eve',
                                   public.booking_followup_owner(p_booking));
      exception when others then null;
      end;
    end if;
  elsif v_prev.booking_id is not null and v_prev.bad then
    -- it cleared: close the task and say so
    perform public.booking_followup_resolve(p_booking, v_key, 'Weather OK: the forecast cleared');
    begin
      perform public.push_notify('weather_alert', 'Weather OK: ' || coalesce(v_org, 'a job'),
        coalesce(v_org, 'This job') || ', ' || trim(to_char(p_day, 'FMDay, FMMon FMDD')) || ': the forecast cleared (up to ' || coalesce(p_max_pop, 0) || '% rain, gusts to ' || coalesce(p_max_gust, 0) || ' mph).',
        '/#jobs/job/' || p_booking, 'weather_alert:' || p_booking || ':' || v_key || ':ok', public.booking_followup_owner(p_booking));
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('ok', true, 'bad', v_bad, 'alerted', v_alerted);
end $$;

-- ================================================================ the job page's Parents tab
create or replace function public.booking_parents(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings; t public.booking_types; w record; j record; v_msgs jsonb := '[]'::jsonb; m record; v_sent timestamptz; v_early timestamptz;
        v_since timestamptz; v_send text;
begin
  if not public.can('bookings', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_booking;
  if b.id is null then raise exception 'Booking not found.'; end if;
  select * into t from public.booking_types where key = b.type_key;
  select * into w from public.booking_hub_where(p_booking);
  select * into j from public.booking_job_info(p_booking);
  for m in
    select * from (values
      ('heads', 'One week before', w.first_day - 7, 1), ('day', 'Day before', w.first_day - 1, 2), ('live', 'Photos are online', w.live_day, 3), ('lastcall', 'Last call', w.live_day + 11, 4)) x(k, title, due, ord)
     where t.audience <> 'school'
    union all
    select * from (values
      ('m1', 'Two weeks before', w.first_day - 14, 1), ('m2', 'One week before', w.first_day - 7, 2), ('m3', 'Day before', w.first_day - 1, 3),
      ('m4', 'Gallery published', w.live_day, 4), ('r1', 'Retake day, one week out', b.retake_day - 7, 5), ('r2', 'Retake day, day before', b.retake_day - 1, 6)) x(k, title, due, ord)
     where t.audience = 'school' and (x.k not in ('r1', 'r2') or b.retake_day is not null)
    order by 4
  loop
    v_sent := public.booking_hub_sent(p_booking, m.k);
    v_since := public.booking_hub_window_start(p_booking, m.k);
    v_send := case when m.k = 'day' then 'day-' || to_char(w.first_day, 'YYYY-MM-DD') else m.k end;
    select max(e.created_at) into v_early from public.hub_events e where e.hub = w.hub and e.org_id = w.org and e.send_key = v_send;
    v_msgs := v_msgs || jsonb_build_object('key', m.k, 'title', m.title, 'due', m.due, 'sent_at', v_sent,
      'copied_at', v_early, 'counts_from', v_since);
  end loop;
  return jsonb_build_object(
    'audience', case when t.audience = 'school' then 'school' else 'sports' end,
    'messages', v_msgs,
    'roster_loaded_at', j.roster_loaded_at, 'code_count', coalesce(j.code_count, 0), 'workflow', j.workflow,
    'coaches', case when t.audience = 'school' then null else coalesce(cardinality(public.booking_coach_emails(p_booking)), 0) end,
    'shoot_setting', b.shoot_setting, 'school_data_at', b.school_data_at,
    'clicks', (select coalesce(jsonb_agg(jsonb_build_object('at', c.at, 'url', c.url, 'subject', e.subject) order by c.at desc), '[]'::jsonb)
                 from (select * from public.booking_link_clicks where booking_id = p_booking order by at desc limit 12) c
                 left join public.booking_emails e on e.id = c.email_id),
    'weather', (select coalesce(jsonb_agg(jsonb_build_object('day', x.day, 'checked_at', x.checked_at, 'max_pop', x.max_pop, 'max_gust', x.max_gust, 'bad', x.bad, 'error', x.error) order by x.day), '[]'::jsonb)
                  from public.booking_weather_checks x where x.booking_id = p_booking),
    'followups', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'key', f.key, 'title', f.title, 'detail', f.detail,
                    'created_at', f.created_at, 'done_at', f.done_at, 'done_note', f.done_note, 'snooze_until', f.snooze_until) order by f.done_at nulls first, f.created_at desc), '[]'::jsonb)
                    from public.booking_followups f where f.booking_id = p_booking));
end $$;

-- the booking form: shooting indoors / outdoors / either, and (schools) student data received
create or replace function public.booking_director_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings;
begin
  if not public.can('bookings', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into b from public.bookings where id = p_id;
  if b.id is null then raise exception 'Booking not found.'; end if;
  return jsonb_build_object('team_times', b.team_times, 'order_deadline', b.order_deadline, 'discount_ends', b.discount_ends,
    'shoot_setting', b.shoot_setting, 'school_data', b.school_data_at is not null,
    'day_link', 'https://admin.207photo.com/#day/' || b.day_token,
    'calendar_link', 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/booking-ics?t=' || b.day_token);
end $$;

-- p: any of team_times, order_deadline, discount_ends ('' clears a date), shoot_setting ('' = from the job type),
-- school_data (true / false). Left-out keys are unchanged.
create or replace function public.booking_director_save(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  if not public.can('bookings', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p ? 'team_times' and length(coalesce(p ->> 'team_times', '')) > 4000 then raise exception 'Team times are too long (4,000 characters at most).'; end if;
  if p ? 'shoot_setting' and coalesce(p ->> 'shoot_setting', '') not in ('', 'indoors', 'outdoors', 'either') then raise exception 'Shooting must be indoors, outdoors or either.'; end if;
  update public.bookings set
    team_times     = case when p ? 'team_times' then btrim(replace(coalesce(p ->> 'team_times', ''), E'\r', '')) else team_times end,
    order_deadline = case when p ? 'order_deadline' then nullif(p ->> 'order_deadline', '')::date else order_deadline end,
    discount_ends  = case when p ? 'discount_ends' then nullif(p ->> 'discount_ends', '')::date else discount_ends end,
    shoot_setting  = case when p ? 'shoot_setting' then nullif(p ->> 'shoot_setting', '') else shoot_setting end,
    school_data_at = case when p ? 'school_data' then case when (p ->> 'school_data')::boolean then coalesce(school_data_at, now()) end else school_data_at end
  where id = p_id
  returning day_token into v_token;
  if v_token is null then raise exception 'Booking not found.'; end if;
  return jsonb_build_object('ok', true, 'day_link', 'https://admin.207photo.com/#day/' || v_token);
end $$;

-- ================================================================ 9. the three series
-- Steps are updated in place by (series type, step number); new numbers are added. Nothing is deleted:
-- the Roster Only AD coach checklist (3) and the school 21-day data email (2) are turned off.
create or replace function pg_temp.put_step(p_type text, p_no int, p_label text, p_kind text, p_trigger text, p_offset int, p_time time,
  p_hub text, p_covered boolean, p_school_days boolean, p_send_if text[], p_check text, p_subject text, p_body text, p_active boolean default true)
returns void language plpgsql as $$
declare v_seq uuid;
begin
  for v_seq in select id from public.booking_sequences where type_key = p_type loop
    update public.booking_steps set label = p_label, kind = p_kind, trigger = p_trigger, offset_days = p_offset, send_time = p_time,
           hub_key = p_hub, covered_by_gotphoto = p_covered, school_days = p_school_days, send_if = p_send_if, check_key = p_check,
           subject = p_subject, body_md = p_body, is_active = p_active, updated_at = now()
     where sequence_id = v_seq and step_no = p_no;
    if not found then
      insert into public.booking_steps (sequence_id, step_no, label, kind, trigger, offset_days, send_time, hub_key, covered_by_gotphoto,
                                        school_days, send_if, check_key, subject, body_md, is_active)
      values (v_seq, p_no, p_label, p_kind, p_trigger, p_offset, p_time, p_hub, p_covered, p_school_days, p_send_if, p_check, p_subject, p_body, p_active);
    end if;
  end loop;
end $$;

create or replace function pg_temp.step_off(p_type text, p_no int) returns void language sql as $$
  update public.booking_steps st set is_active = false, updated_at = now()
    from public.booking_sequences s where s.id = st.sequence_id and s.type_key = p_type and st.step_no = p_no and st.is_active
$$;

update public.booking_sequences set name = 'Sports: Roster Only', updated_at = now() where type_key = 'sports_nodata' and name like 'Sports no data%';
update public.booking_sequences set name = 'Sports: Parent Contacts', updated_at = now() where type_key = 'sports_data' and name like 'Sports with data%';
update public.booking_sequences set name = 'School Photos', updated_at = now() where type_key = 'school' and name like 'School photos (%';

-- ---------------------------------------------------------------- shared sports bodies
create temp table _sb (k text primary key, v text) on commit drop;
insert into _sb values
('heads', $b$Hi {{first_name|there}},

Tomorrow is a send day for {{org}}. The message is ready now, so any time this week works. {{hub_detail}}

Your "{{hub_title}}" message is written and ready. Open it, pick email, text, flyer or Facebook, then copy and send:

{{hub_link}}

Questions? Reply to this email or text {{day_of_phone}}.$b$),
('nudge5_subject', $b${{org}} families haven't heard about picture day yet$b$),
('nudge5', $b$Hi {{first_name|there}},

Picture day is {{picture_day}}, and our hub shows your families haven't been sent the heads-up yet. Here it is, ready to paste into an email, a text or a post:

{{paste_heads}}

{{coaches_cc_line}}

Questions? Reply to this email or text {{day_of_phone}}.$b$),
('day', $b$Hi {{first_name|there}},

Tomorrow is a send day for {{org}}. The message is ready now; send it tomorrow. {{hub_detail}}

Your "{{hub_title}}" message is written and ready. Open it, pick email, text, flyer or Facebook, then copy and send:

{{hub_link}}

{{coach_tips_if_none}}

Questions? Reply to this email or text {{day_of_phone}}.$b$),
('live', $b$Hi {{first_name|there}},

The gallery for {{org}} picture day went live today.

{{live_note}}

{{pricing_line}}

{{coaches_live_line}}

Questions? Reply to this email or text {{day_of_phone}}.$b$),
('live2_subject', $b${{org}} families don't have the gallery link yet$b$),
('live2', $b$Hi {{first_name|there}},

Our hub shows the "Photos are online" message hasn't gone to your families yet. It's the one that matters most: it's how they find their photos. Here it is, ready to paste:

{{paste_live}}

Or open it on the hub, ready as an email, a text, a flyer or a post: {{link_live}}

Thank you,$b$),
('lastcall', $b$Hi {{first_name|there}},

Today is a send day for {{org}}. {{hub_detail}}

Your "{{hub_title}}" message is written and ready. Open it, pick email, text, flyer or Facebook, then copy and send:

{{hub_link}}

Questions? Reply to this email or text {{day_of_phone}}.$b$),
('coach_check', $b$Hi Coach,

{{ad_name|Your athletic director}} put us in touch. 207 Photo is photographing {{org}} on {{picture_day}}. Here is the schedule:

{{schedule|{{picture_day}}}}

Three things that make picture day go fast:

- Have your team grouped and ready at your time. Separate A/B or JV/Varsity if they are photographed apart.
- Game-day ready: clean, complete, correct uniform.
- Bring individual gear: glove, bat, stick, club, catcher's gear. Game balls are provided.

Anyone who misses their time can join another team's slot that day, or book our weekly studio drop-in at 207photo.com/makeups.

**Please post this to your team tomorrow:**

{{paste_day}}

See you there,$b$),
('coach_backup', $b$Hi Coach,

{{ad_name|Your athletic director}} put us in touch. 207 Photo is photographing {{org}} on {{picture_day}}. Please paste this into your team chat so families know:

{{paste_heads}}

Thank you! You'll get a short checklist two days before picture day.$b$),
('coach_live', $b$Hi Coach,

Your team's photos are online. {{coach_live_note}}

Thanks for passing it along,$b$),
('coach_last', $b$Hi Coach,

Quick one. Early-order pricing for {{org}} photos ends {{pricing_ends|in three days}}. One more post to the team chat catches the families who meant to order and forgot:

> Last call on team photos: early pricing ends {{pricing_ends|in three days}}. 207photo.com, Find My Photos, search "{{org}}".

Thank you,$b$),
('plan', $b$Hi {{first_name|there}},

Picture day is coming up. Here is what we have on file:

{{schedule|{{picture_day}}}}

If that is missing or wrong, reply and we will fix it. With more than one team, send the order and start times so teams are grouped and ready. Tell us about any deadlines too (banquets, senior nights, program covers) so we can deliver ahead of them.

{{roster_note}}

{{coach_note}}

{{day_of_block}}

{{weather_line}}

{{team_times}}

**Makeups:** there is no on-location makeup day. Anyone who misses their time can join another team's slot that day, or book our weekly studio drop-in at 207photo.com/makeups.

Everything about your picture day is on one page: {{day_link}}

Thanks,$b$);

-- ---------------------------------------------------------------- Sports: Roster Only
select pg_temp.put_step('sports_nodata', 1, 'Start here', 'admin', 'picture_day', 0, '07:30', null, false, false, '{}', null,
  '{{org}} picture day is {{picture_day}}: three things to do today',
$b$Hello {{first_name|there}},

- **When:** {{when_line}}
- **Where:** {{where_line}}
- [Add it to your calendar]({{calendar_link}})

Three things to do today. The first one takes about thirty seconds.

**1. Go to 207photo.com/sportsadmin and find your team**

Every message for your families is already written there: {{hub_home}}

Your families are not notified automatically, so these messages are the only way they hear about picture day and their photos. We'll email you at this address on each send day. The first message is waiting now, so copy it and send it while you're there.

**2. Send us your roster**

As early as you can, and no later than two weeks before picture day. It has to be a digital file: a spreadsheet, a CSV, or whatever your registration software exports. All we need is athlete first and last name, and team. [Here is a sample](https://docs.google.com/spreadsheets/u/1/d/1YVUMBCq5bkF8FIByGzV5Zm3TnTEBM-JnWwqz5oDqp_4/copy). A printed list has to be retyped by hand, and that is where errors come from, so a messy export beats a tidy piece of paper.

Families find their photos by searching their athlete's name at 207photo.com. Without your roster that search finds nothing.

**3. Reply All to this email and CC your coaches**

They get a short checklist two days before picture day and the gallery link the day photos are online, so you do not have to forward anything. In the same reply, send the name and cell number of whoever will be there on the day.

{{short_notice}}

{{cc_note}}

{{families_block}}

Thank you for your partnership and for serving your community,$b$);
select pg_temp.put_step('sports_nodata', 2, 'Picture day plan', 'admin', 'picture_day', 14, '07:30', null, false, false, '{}', null,
  '{{org}}: plan for picture day, {{picture_day}}', (select v from _sb where k = 'plan'));
select pg_temp.step_off('sports_nodata', 3);
select pg_temp.put_step('sports_nodata', 10, 'One week before', 'hub', 'picture_day', 8, '18:00', 'heads', false, false, '{hub_not_sent}', null,
  'Tomorrow: send your "{{hub_title}}" message ({{org}})', (select v from _sb where k = 'heads'));
select pg_temp.put_step('sports_nodata', 14, 'Families haven''t heard yet', 'admin', 'picture_day', 5, '07:30', null, false, false, '{hub_not_sent}', 'heads',
  (select v from _sb where k = 'nudge5_subject'), (select v from _sb where k = 'nudge5'));
select pg_temp.put_step('sports_nodata', 11, 'Day before', 'hub', 'picture_day', 2, '18:00', 'day', true, false, '{hub_not_sent}', null,
  'Tomorrow: send your "{{hub_title}}" message ({{org}})', (select v from _sb where k = 'day'));
select pg_temp.put_step('sports_nodata', 12, 'Photos are online', 'hub', 'gallery_live', 0, '07:30', 'live', false, false, '{}', null,
  '{{org}}: your photo gallery is live', (select v from _sb where k = 'live'));
select pg_temp.put_step('sports_nodata', 15, 'Gallery link not sent yet', 'admin', 'gallery_live', 2, '07:30', null, false, false, '{hub_not_sent}', 'live',
  (select v from _sb where k = 'live2_subject'), (select v from _sb where k = 'live2'));
select pg_temp.put_step('sports_nodata', 13, 'Discount ends soon', 'hub', 'gallery_live', 11, '07:30', 'lastcall', true, false, '{no_coaches,hub_not_sent}', null,
  'Today: send your "{{hub_title}}" message ({{org}})', (select v from _sb where k = 'lastcall'));
select pg_temp.put_step('sports_nodata', 24, 'Coach: families haven''t heard yet', 'coach', 'picture_day', 5, '07:30', null, false, false, '{hub_not_sent}', 'heads',
  '{{org}} picture day is {{picture_day_short}}: a message for your team', (select v from _sb where k = 'coach_backup'));
select pg_temp.put_step('sports_nodata', 20, 'Coach checklist', 'coach', 'picture_day', 2, '07:30', null, false, false, '{}', null,
  '{{org}} picture day is {{picture_day_short}}: coach checklist', (select v from _sb where k = 'coach_check'));
select pg_temp.put_step('sports_nodata', 21, 'Coach: photos online', 'coach', 'gallery_live', 0, '07:30', null, false, false, '{}', null,
  '{{org}} team photos are online', (select v from _sb where k = 'coach_live'));
select pg_temp.put_step('sports_nodata', 22, 'Coach: last call', 'coach', 'gallery_live', 11, '07:30', null, true, false, '{}', null,
  '{{org}} photos: early pricing ends {{pricing_ends|soon}}', (select v from _sb where k = 'coach_last'));

-- ---------------------------------------------------------------- Sports: Parent Contacts
select pg_temp.put_step('sports_data', 1, 'Start here', 'admin', 'picture_day', 0, '07:30', null, false, false, '{}', null,
  '{{org}} picture day is {{picture_day}}: three things to do today',
$b$Hello {{first_name|there}},

- **When:** {{when_line}}
- **Where:** {{where_line}}
- [Add it to your calendar]({{calendar_link}})

Three things to do today. The first one takes about thirty seconds.

**1. Go to 207photo.com/sportsadmin and find your team**

Every message for your families is already written there: {{hub_home}}

We'll email you at this address on each send day. The first message is waiting now, so copy it and send it while you're there.

**2. Send us your roster with parent emails**

As early as you can, and no later than two weeks before picture day. We need athlete first and last name, team, and parent email. A parent cell number is a big plus, because it means a text as well as an email. [Sample CSV, opens in Google Sheets](https://docs.google.com/spreadsheets/d/1tLsqeHQeFXipdBNuMA4yzCCe3Pt1T8dvGu8tfKjeaSg/copy), or send whatever your registration software exports.

With it, parents are emailed and texted a direct link the moment photos are online. Parent contact info is used only for photo notifications and is never shared.

**3. Reply All to this email and CC your coaches**

They get a short checklist two days before picture day, so you do not have to forward anything. In the same reply, send the name and cell number of whoever will be there on the day.

{{short_notice}}

{{cc_note}}

{{families_block}}

Thank you for your partnership,$b$);
select pg_temp.put_step('sports_data', 2, 'Picture day plan', 'admin', 'picture_day', 14, '07:30', null, false, false, '{}', null,
  '{{org}}: plan for picture day, {{picture_day}}', (select v from _sb where k = 'plan'));
select pg_temp.put_step('sports_data', 10, 'One week before', 'hub', 'picture_day', 8, '18:00', 'heads', false, false, '{hub_not_sent}', null,
  'Tomorrow: send your "{{hub_title}}" message ({{org}})', (select v from _sb where k = 'heads'));
select pg_temp.put_step('sports_data', 14, 'Families haven''t heard yet', 'admin', 'picture_day', 5, '07:30', null, false, false, '{hub_not_sent}', 'heads',
  (select v from _sb where k = 'nudge5_subject'), (select v from _sb where k = 'nudge5'));
select pg_temp.put_step('sports_data', 11, 'Day before', 'hub', 'picture_day', 2, '18:00', 'day', true, false, '{hub_not_sent}', null,
  'Tomorrow: send your "{{hub_title}}" message ({{org}})', (select v from _sb where k = 'day'));
select pg_temp.put_step('sports_data', 12, 'Photos are online', 'hub', 'gallery_live', 0, '07:30', 'live', true, false, '{}', null,
  '{{org}}: your photo gallery is live', (select v from _sb where k = 'live'));
select pg_temp.put_step('sports_data', 15, 'Gallery link not sent yet', 'admin', 'gallery_live', 2, '07:30', null, true, false, '{hub_not_sent}', 'live',
  (select v from _sb where k = 'live2_subject'), (select v from _sb where k = 'live2'));
select pg_temp.put_step('sports_data', 13, 'Discount ends soon', 'hub', 'gallery_live', 11, '07:30', 'lastcall', true, false, '{no_coaches,hub_not_sent}', null,
  'Today: send your "{{hub_title}}" message ({{org}})', (select v from _sb where k = 'lastcall'));
select pg_temp.put_step('sports_data', 24, 'Coach: families haven''t heard yet', 'coach', 'picture_day', 5, '07:30', null, false, false, '{hub_not_sent}', 'heads',
  '{{org}} picture day is {{picture_day_short}}: a message for your team', (select v from _sb where k = 'coach_backup'));
select pg_temp.put_step('sports_data', 20, 'Coach checklist', 'coach', 'picture_day', 2, '07:30', null, false, false, '{}', null,
  '{{org}} picture day is {{picture_day_short}}: coach checklist', (select v from _sb where k = 'coach_check'));
select pg_temp.put_step('sports_data', 21, 'Coach: photos online', 'coach', 'gallery_live', 0, '07:30', null, false, false, '{}', null,
  '{{org}} team photos are online', (select v from _sb where k = 'coach_live'));
select pg_temp.put_step('sports_data', 22, 'Coach: last call', 'coach', 'gallery_live', 11, '07:30', null, true, false, '{}', null,
  '{{org}} photos: early pricing ends {{pricing_ends|soon}}', (select v from _sb where k = 'coach_last'));

-- ---------------------------------------------------------------- School Photos
select pg_temp.put_step('school', 1, 'You''re booked, start here', 'admin', 'picture_day', 0, '07:30', null, false, false, '{}', null,
  '{{org}} picture day is booked: {{picture_day}}',
$b$Hi {{first_name|there}},

You're on our calendar! Picture day at {{org}} is **{{picture_day}}**. If that date is wrong, reply and we will fix it.

- **Where:** {{where_line}}
- [Add it to your calendar]({{calendar_link}})

**1. Go to 207photo.com/schooladmin and bookmark it,** then find your school. Every message for your families is already written there, with your school name, date and access code filled in, as an email, a text, a printed flyer and a social post. We'll email you at this address when each one is due. The first message is waiting now, so copy it and send it while you're there.

**2. Send your student data (within a week)**

For yearbook and administrative services we need a file with every student, faculty and staff member, as a CSV, tab-delimited or Excel file:

- Student ID (the number in your student information system)
- First name
- Last name
- Grade
- Homeroom teacher (leave blank if it doesn't apply)
- Job title (for staff, used for ID badges)

An export straight from your student information system is perfect. [Sample, opens in Google Sheets](https://docs.google.com/spreadsheets/d/12sLEeJK7ENgb1TvkWWZaTKwH8S3ghsa968mkaZMZhpg/copy)

**Which student information system do you use?** PowerSchool, Infinite Campus, Synergy, Rediker, Skyward, Aspen, Web2School, or something else? Just reply with the name. After makeup day we'll send your photos ready to import into it.

**3. Wifi on picture day (if you can)**

If we can get on your wifi while we shoot, families see their photos the same day. Without it, the photos wait until we are back in the studio, usually two to three days later. If wifi is an option, reply with the network name and password (guest or staff, either is fine). If your IT department needs more, we're happy to fill out a request form or send the MAC addresses of our computers.

In the same reply, send the name and cell number of whoever will be our contact on the day.

{{short_notice}}

{{cc_note}}

{{families_block}}

Warmly,$b$);
select pg_temp.step_off('school', 2);
select pg_temp.put_step('school', 3, 'Two weeks before', 'admin', 'picture_day', 14, '07:30', null, false, false, '{school_open}', null,
  '{{org}} picture day is two weeks away',
$b$Hi {{first_name|there}},

Picture day is two weeks away: {{picture_day}}.

{{two_weeks_ask}}

{{data_ask}}

{{day_of_block}}

{{team_times}}

Everything about your picture day is on one page: {{day_link}}

Warmly,$b$);
select pg_temp.put_step('school', 10, 'One week before', 'hub', 'picture_day', 8, '18:00', 'm2', false, true, '{hub_not_sent}', null,
  'Tomorrow: send your "{{hub_title}}" message ({{org}})',
$b$Hi {{first_name|there}},

Tomorrow is a send day for {{org}}. The message is ready now, so any time this week works. {{hub_detail}}

Your "{{hub_title}}" message is written and ready. Open it, pick email, text, flyer or Facebook, then copy and send:

{{hub_link}}

Everything about picture day (when we arrive, what we need) is on one page: {{day_link}}

Questions? Reply to this email or text {{day_of_phone}}.$b$);
select pg_temp.put_step('school', 15, 'Families haven''t heard yet', 'admin', 'picture_day', 5, '07:30', null, false, true, '{hub_not_sent}', 'm2',
  '{{org}} families haven''t had the picture day reminder yet',
$b$Hi {{first_name|there}},

Our hub shows the one-week reminder hasn't gone to your families yet. Here it is, ready to paste into your family email or newsletter:

{{paste_heads}}

Or open it on the hub, ready as an email, a text, a flyer or a social post: {{link_m2}}

Warmly,$b$);
select pg_temp.put_step('school', 4, 'Day before', 'admin', 'picture_day', 1, '07:30', null, false, false, '{hub_not_sent}', 'm3',
  '{{org}} picture day is tomorrow',
$b$Hi {{first_name|there}},

Picture day is tomorrow, {{picture_day}}. Just one thing left on your end.

**Send the "Day before picture day" message today.** It's ready as an email, a text, a printed flyer or a social post: {{link_m3}}

We recommend sending it two or three ways.

{{emergency_line}}

We're looking forward to being there tomorrow.

Warmly,$b$);
select pg_temp.put_step('school', 13, 'Gallery published', 'hub', 'gallery_live', 0, '07:30', 'm4', false, false, '{}', null,
  'Today: send your "{{hub_title}}" message ({{org}})',
$b$Hi {{first_name|there}},

Today is a send day for {{org}}. {{hub_detail}}

Your "{{hub_title}}" message is written and ready. Open it, pick email, text, flyer or Facebook, then copy and send:

{{hub_link}}

{{pricing_line}}

Questions? Reply to this email or text {{day_of_phone}}.$b$);
update public.booking_steps st set send_if = '{hub_not_sent}', updated_at = now()
  from public.booking_sequences s where s.id = st.sequence_id and s.type_key = 'school' and st.step_no in (11, 12) and st.send_if = '{}';

-- emails already queued pick up the new wording when they render; nudges already scheduled are re-checked when due.
select public.booking_reschedule(b.id) from public.bookings b where b.status = 'booked' and b.picture_day >= current_date - 30;

-- ================================================================ 10. grants and cron
revoke all on function
  public.booking_hub_where(uuid), public.booking_hub_window_start(uuid, text, date), public.booking_hub_sent(uuid, text, date),
  public.booking_email_skip_reason(uuid), public.booking_series_vars(uuid), public.booking_shoot_default(),
  public.booking_link_ok(text), public.booking_track_links(text, uuid), public.booking_link_click(uuid, text),
  public.booking_followup_owner(uuid), public.booking_followup_raise(uuid, text, text, text, text, jsonb, boolean),
  public.booking_followup_resolve(uuid, text, text), public.booking_followups_tick(),
  public.booking_followups_mine(), public.booking_followup_done(uuid, text), public.booking_followup_snooze(uuid, int),
  public.booking_run_roster_only(uuid), public.booking_weather_due(), public.booking_weather_geo(uuid, double precision, double precision, text),
  public.booking_weather_record(uuid, date, int, int, jsonb, text), public.booking_parents(uuid)
from public, anon, authenticated;
grant execute on function public.booking_followups_mine(), public.booking_followup_done(uuid, text), public.booking_followup_snooze(uuid, int),
  public.booking_run_roster_only(uuid), public.booking_parents(uuid) to authenticated;
-- the "go" redirect (no sign-in)
grant execute on function public.booking_link_click(uuid, text) to anon, authenticated;
-- booking-weather (service role)
grant execute on function public.booking_weather_due(), public.booking_weather_geo(uuid, double precision, double precision, text),
  public.booking_weather_record(uuid, date, int, int, jsonb, text), public.booking_trigger_ok(text) to service_role;

do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('booking-followups', 'booking-weather');
  perform cron.schedule('booking-followups', '20 * * * *', 'select public.booking_followups_tick()');
  -- 7:05 and 16:05 Eastern (cron runs in UTC; either side of daylight time is fine for a twice-a-day check)
  perform cron.schedule('booking-weather', '5 11,20 * * *', $c$select public.booking_poke('booking-weather', '{}'::jsonb)$c$);
end $$;
