-- Picture day planner (2026-10-22).
--
-- For a booked picture day (leagues, mostly):
--   1. The organization's contact gets a short form (https://admin.207photo.com/#plan/<token>, no sign-in):
--      their teams and coaches, who is on site, the fields or rooms we can use, uniforms and props, a roster file.
--   2. Staff lay out a time slot for each team, by field, on the Picture days page (app/src/pictureday.js).
--   3. Each coach gets an email with their team's time and a link (#slot/<token>) to confirm or ask to move.
--
-- Tables: pd_plans (one per booking, holds the form), pd_teams (one per team: coach, field, slot, answer),
-- pd_emails (what was sent). Staff read the tables with can('pictureday', 'view') and change them only through
-- the pd_* RPCs (edit). The two public pages use pd_public_* RPCs keyed by an unguessable token.
--
-- Sending: Resend (like the welcome email), from the booking sender's name and address with its reply-to, so a
-- coach's reply lands in the same inbox as booking replies. It follows the Booking emails switch, quiet hours
-- and test mode in booking_settings: switched off, emails wait (status 'waiting') and go when it is back on.
-- Like every send path, only bookings with status = 'booked' send (never tracked or cancelled ones).

insert into public.app_modules (key, label, section, description, sort, status, admin_only)
values ('pictureday', 'Picture day planner', 'Jobs',
        'League picture days: the organization''s form, team time slots by field, and coach confirmations.', 15, 'live', false)
on conflict (key) do update set status = 'live', label = excluded.label, description = excluded.description;

create function public.pd_new_token() returns text
language sql volatile set search_path = '' as $$ select encode(extensions.gen_random_bytes(18), 'hex') $$;

create table public.pd_plans (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null unique references public.bookings (id) on delete cascade,
  token         text not null unique default public.pd_new_token(),
  contact_id    uuid references public.prospect_contacts (id) on delete set null,  -- who the form went to
  contact_name  text,
  contact_email text,
  intake_sent_at timestamptz,
  submitted_at  timestamptz,                  -- first time the form came back
  updated_by_contact_at timestamptz,          -- last time it came back
  onsite_name   text not null default '',
  onsite_phone  text not null default '',
  location      text not null default '',     -- where, as the organization wrote it (else the booking's location)
  fields        text[] not null default '{}', -- fields, rinks or rooms we can use, in order
  uniforms      text not null default '',
  props         text not null default '',
  notes         text not null default '',
  roster_path   text,                         -- storage: pictureday/<token>/<file>
  roster_name   text,
  roster_at     timestamptz,
  slot_min      smallint not null default 10 check (slot_min between 3 and 120),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.pd_plans is 'Picture day planner: one per booking. The organization''s form and the slot settings.';

create table public.pd_teams (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null references public.pd_plans (id) on delete cascade,
  token         text not null unique default public.pd_new_token(),
  name          text not null check (btrim(name) <> ''),
  coach_name    text not null default '',
  coach_email   text not null default '',
  coach_phone   text not null default '',
  players       smallint check (players between 0 and 500),
  field         text not null default '',
  slot_at       timestamptz,
  slot_min      smallint check (slot_min between 3 and 120),   -- null = the plan's
  sort          int not null default 0,
  added_by      text not null default 'staff' check (added_by in ('staff', 'contact')),
  status        text not null default 'new' check (status in ('new', 'sent', 'confirmed', 'move')),
  sent_at       timestamptz,
  sent_slot_at  timestamptz,                  -- the slot in the last email: a different slot_at = changed since
  sent_field    text,
  responded_at  timestamptz,
  coach_note    text not null default '',
  removed_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index pd_teams_plan on public.pd_teams (plan_id) where removed_at is null;
comment on table public.pd_teams is 'Picture day planner: one per team, with its coach, field, time slot and the coach''s answer.';

create table public.pd_emails (
  id         bigint generated always as identity primary key,
  plan_id    uuid not null references public.pd_plans (id) on delete cascade,
  team_id    uuid references public.pd_teams (id) on delete cascade,
  kind       text not null check (kind in ('intake', 'slot')),
  to_email   text not null,
  to_name    text not null default '',
  subject    text not null,
  body_text  text not null,
  body_html  text not null,
  status     text not null default 'waiting' check (status in ('waiting', 'sent', 'failed', 'cancelled')),
  test_mode  boolean not null default false,
  sent_to    text,
  request_id bigint,                -- net.http_post request id; checked for Resend's answer by pd_send_waiting
  checked    boolean not null default false,
  error      text,
  created_by uuid,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index pd_emails_waiting on public.pd_emails (id) where status = 'waiting';
create index pd_emails_plan on public.pd_emails (plan_id, id desc);
comment on table public.pd_emails is 'Picture day planner emails (the form to the organization, each coach''s time). Sent by pd_send_waiting.';

alter table public.pd_plans enable row level security;
alter table public.pd_teams enable row level security;
alter table public.pd_emails enable row level security;
revoke all on public.pd_plans, public.pd_teams, public.pd_emails from anon, authenticated;
grant select on public.pd_plans, public.pd_teams, public.pd_emails to authenticated;
create policy pd_plans_read  on public.pd_plans  for select to authenticated using ((select public.can('pictureday', 'view')));
create policy pd_teams_read  on public.pd_teams  for select to authenticated using ((select public.can('pictureday', 'view')));
create policy pd_emails_read on public.pd_emails for select to authenticated using ((select public.can('pictureday', 'view')));

-- ---------------------------------------------------------------- helpers
create function public.pd_fmt_day(p timestamptz) returns text language sql stable set search_path = '' as $$
  select to_char(p at time zone 'America/New_York', 'FMDay, FMMonth FMDD') $$;
create function public.pd_fmt_time(p timestamptz) returns text language sql stable set search_path = '' as $$
  select to_char(p at time zone 'America/New_York', 'FMHH12:MI AM') $$;
create function public.pd_clean(p text, p_max int default 500) returns text language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(coalesce(p, ''), '[\x00-\x08\x0b\x0c\x0e-\x1f]', '', 'g')), p_max) $$;
create function public.pd_email_ok(p text) returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p, '') ~* '^[A-Za-z0-9._%+''-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' $$;

-- The email around a body: same look as the welcome email, one orange button.
create function public.pd_email_html(p_paras text[], p_button text, p_link text, p_after text[], p_sig text)
returns text language sql immutable set search_path = '' as $$
  select '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f1e1b;max-width:540px">' ||
         coalesce((select string_agg('<p style="margin:0 0 12px">' || x || '</p>', '' order by i) from unnest(p_paras) with ordinality t(x, i)), '') ||
         '<p style="margin:18px 0 18px"><a href="' || p_link || '" style="display:inline-block;background:#bf4a1f;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:4px">' ||
         public.html_esc(p_button) || '</a></p>' ||
         coalesce((select string_agg('<p style="margin:0 0 12px">' || x || '</p>', '' order by i) from unnest(p_after) with ordinality t(x, i)), '') ||
         '<p style="margin:18px 0 0">' || replace(public.html_esc(p_sig), E'\n', '<br>') || '</p></div>' $$;

-- Where: what the organization wrote, else the booking's location.
create function public.pd_where(p_plan uuid) returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(p.location), ''), nullif(btrim(b.location), ''), '')
    from public.pd_plans p join public.bookings b on b.id = p.booking_id where p.id = p_plan $$;

-- {to_email, to_name, subject, text, html}: the form email to the organization's contact.
create function public.pd_intake_content(p_plan uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.pd_plans; b public.bookings; v_org text; v_first text; v_when text; v_link text; v_sig text;
begin
  select * into p from public.pd_plans where id = p_plan;
  select * into b from public.bookings where id = p.booking_id;
  select name into v_org from public.prospect_orgs where id = b.org_id;
  v_org := coalesce(v_org, 'your');
  select coalesce(nullif(btrim(c.first_name), ''), 'there') into v_first from public.prospect_contacts c where c.id = p.contact_id;
  v_first := coalesce(v_first, nullif(split_part(btrim(p.contact_name), ' ', 1), ''), 'there');
  v_when := public.pd_fmt_day(coalesce(b.start_at, b.picture_day::timestamp at time zone 'America/New_York'))
            || case when b.time_set then ' at ' || public.pd_fmt_time(b.start_at) else '' end;
  v_link := 'https://admin.207photo.com/#plan/' || p.token;
  select signature into v_sig from public.booking_settings;
  v_sig := coalesce(nullif(v_sig, ''), 'The 207 Photo Team');
  return jsonb_build_object('to_email', p.contact_email, 'to_name', coalesce(p.contact_name, ''),
    'subject', v_org || ' picture day: tell us about your teams',
    'text', 'Hi ' || v_first || E',\n\n' ||
            'Picture day for ' || v_org || ' is ' || v_when || E'. To build the team schedule we need a few details: your teams and coaches, who will be on site, which fields we can use, and uniforms or props.\n\n' ||
            E'It takes about 5 minutes:\n' || v_link || E'\n\n' ||
            E'Once we have it, we will send each coach their team''s time, and they can confirm it or ask to move.\n\n' || v_sig,
    'html', public.pd_email_html(
              array['Hi ' || public.html_esc(v_first) || ',',
                    'Picture day for <b>' || public.html_esc(v_org) || '</b> is <b>' || public.html_esc(v_when) || '</b>. To build the team schedule we need a few details: your teams and coaches, who will be on site, which fields we can use, and uniforms or props. It takes about 5 minutes.'],
              'Tell us about your teams', v_link,
              array['Once we have it, we will send each coach their team&#39;s time, and they can confirm it or ask to move.'], v_sig));
end $$;

-- {to_email, to_name, subject, text, html}: one coach's time slot.
create function public.pd_slot_content(p_team uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.pd_teams; p public.pd_plans; b public.bookings; v_org text; v_first text; v_where text; v_link text; v_sig text;
        v_day text; v_time text; v_lines text[] := '{}'; v_lines_h text[] := '{}';
begin
  select * into t from public.pd_teams where id = p_team;
  select * into p from public.pd_plans where id = t.plan_id;
  select * into b from public.bookings where id = p.booking_id;
  select name into v_org from public.prospect_orgs where id = b.org_id;
  v_first := coalesce(nullif(split_part(btrim(t.coach_name), ' ', 1), ''), 'Coach');
  v_day := public.pd_fmt_day(t.slot_at); v_time := public.pd_fmt_time(t.slot_at);
  v_where := concat_ws(', ', nullif(public.pd_where(p.id), ''), nullif(btrim(t.field), ''));
  v_link := 'https://admin.207photo.com/#slot/' || t.token;
  select signature into v_sig from public.booking_settings;
  v_sig := coalesce(nullif(v_sig, ''), 'The 207 Photo Team');
  if v_where <> '' then v_lines := v_lines || ('Where: ' || v_where); v_lines_h := v_lines_h || ('<b>Where:</b> ' || public.html_esc(v_where)); end if;
  if btrim(p.uniforms) <> '' then v_lines := v_lines || ('Uniforms: ' || btrim(p.uniforms)); v_lines_h := v_lines_h || ('<b>Uniforms:</b> ' || public.html_esc(btrim(p.uniforms))); end if;
  if btrim(p.props) <> '' then v_lines := v_lines || ('Bring: ' || btrim(p.props)); v_lines_h := v_lines_h || ('<b>Bring:</b> ' || public.html_esc(btrim(p.props))); end if;
  if btrim(p.onsite_name) <> '' then
    v_lines := v_lines || ('On site that day: ' || concat_ws(', ', btrim(p.onsite_name), nullif(btrim(p.onsite_phone), '')));
    v_lines_h := v_lines_h || ('<b>On site that day:</b> ' || public.html_esc(concat_ws(', ', btrim(p.onsite_name), nullif(btrim(p.onsite_phone), ''))));
  end if;
  return jsonb_build_object('to_email', t.coach_email, 'to_name', t.coach_name,
    'subject', t.name || ': picture day ' || to_char(t.slot_at at time zone 'America/New_York', 'Dy, FMMon FMDD') || ' at ' || v_time,
    'text', 'Hi ' || v_first || E',\n\n' ||
            'Here is ' || t.name || '''s picture day time' || coalesce(' for ' || v_org, '') || E' with 207 Photo:\n\n' ||
            v_day || ' at ' || v_time || E'\n' || array_to_string(v_lines, E'\n') || E'\n\n' ||
            E'Please have the team there a few minutes early, ready for photos.\n\n' ||
            E'Can you make it? Confirm the time, or ask to move, here:\n' || v_link || E'\n\n' || v_sig,
    'html', public.pd_email_html(
              array['Hi ' || public.html_esc(v_first) || ',',
                    'Here is <b>' || public.html_esc(t.name) || '</b>&#39;s picture day time' || coalesce(' for ' || public.html_esc(v_org), '') || ' with 207 Photo:',
                    '<span style="font-size:18px"><b>' || public.html_esc(v_day) || ' at ' || public.html_esc(v_time) || '</b></span>' ||
                      coalesce('<br>' || array_to_string(v_lines_h, '<br>'), ''),
                    'Please have the team there a few minutes early, ready for photos. Can you make it?'],
              'Confirm or ask to move', v_link, '{}', v_sig));
end $$;

-- ---------------------------------------------------------------- sending
-- Sends waiting emails (booked jobs only), following booking_settings: the Booking emails switch, quiet hours,
-- test mode (everything to the test address, [TEST] subject), bcc. Then reads Resend's answers to earlier sends.
-- Runs right after anything is queued, and every 5 minutes.
create function public.pd_send_waiting() returns int
language plpgsql security definer set search_path = '' as $$
declare s public.booking_settings; v_key text; v_local time; r record; v_to text; v_from text; v_req bigint; n int := 0;
begin
  -- Resend's answers (pg_net keeps them for a few hours)
  update public.pd_emails e set checked = true,
         status = case when h.status_code between 200 and 299 then e.status else 'failed' end,
         error = case when h.status_code between 200 and 299 then e.error
                      else left(coalesce(nullif(h.error_msg, ''), 'HTTP ' || h.status_code || ': ' || coalesce(h.content, '')), 300) end
    from net._http_response h
   where e.status = 'sent' and not e.checked and e.request_id = h.id;

  select * into s from public.booking_settings;
  if not coalesce(s.sending_enabled, false) then return 0; end if;
  v_local := (now() at time zone 'America/New_York')::time;
  if (s.quiet_start > s.quiet_end and (v_local >= s.quiet_start or v_local < s.quiet_end))
     or (s.quiet_start <= s.quiet_end and v_local >= s.quiet_start and v_local < s.quiet_end) then return 0; end if;
  if s.test_mode and not public.pd_email_ok(s.test_recipient) then return 0; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_key is null then return 0; end if;
  -- Resend sends from any address on 207photo.com; anything else goes out from alerts@ with the reply-to kept.
  v_from := case when lower(s.from_email) like '%@207photo.com' then coalesce(nullif(s.from_name, ''), '207 Photo') || ' <' || s.from_email || '>'
                 else '207 Photo <alerts@207photo.com>' end;

  for r in select e.* from public.pd_emails e
             join public.pd_plans p on p.id = e.plan_id
             join public.bookings b on b.id = p.booking_id
            where e.status = 'waiting' and b.status = 'booked'
            order by e.id limit 50
            for update of e skip locked
  loop
    if r.team_id is not null and exists (select 1 from public.pd_teams t where t.id = r.team_id and t.removed_at is not null) then
      update public.pd_emails set status = 'cancelled', error = 'team removed' where id = r.id; continue;
    end if;
    if not s.test_mode and exists (select 1 from public.prospect_contacts pc where lower(btrim(pc.email)) = lower(r.to_email)
                                     and (pc.bounced_at is not null or pc.unsubscribed_at is not null)) then
      update public.pd_emails set status = 'failed', error = 'this address bounced or unsubscribed' where id = r.id; continue;
    end if;
    v_to := case when s.test_mode then s.test_recipient else r.to_email end;
    select net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := jsonb_strip_nulls(jsonb_build_object(
        'from', v_from, 'to', jsonb_build_array(v_to),
        'bcc', case when not s.test_mode and public.pd_email_ok(s.bcc) then jsonb_build_array(s.bcc) end,
        'reply_to', coalesce(nullif(btrim(s.reply_to), ''), s.from_email),
        'subject', case when s.test_mode then '[TEST] ' else '' end || r.subject,
        'text', r.body_text, 'html', r.body_html)),
      timeout_milliseconds := 10000) into v_req;
    update public.pd_emails set status = 'sent', sent_at = now(), request_id = v_req, test_mode = s.test_mode, sent_to = v_to, error = null
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
select cron.schedule('pd-email-send', '*/5 * * * *', 'select public.pd_send_waiting()');

create function public.pd_queue(p_plan uuid, p_team uuid, p_kind text, c jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.pd_emails (plan_id, team_id, kind, to_email, to_name, subject, body_text, body_html, created_by)
  values (p_plan, p_team, p_kind, lower(btrim(c->>'to_email')), coalesce(c->>'to_name', ''), c->>'subject', c->>'text', c->>'html', (select auth.uid()))
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- staff RPCs
create function public.pd_booking_ok(p_booking uuid) returns public.bookings
language plpgsql stable security definer set search_path = '' as $$
declare b public.bookings;
begin
  select * into b from public.bookings where id = p_booking;
  if b.id is null then raise exception 'Booking not found.'; end if;
  return b;
end $$;

-- Booked picture days from a week ago on, with where each plan stands.
create function public.pd_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('pictureday', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'booking_id', b.id, 'title', public.schedule_booking_title(b.id), 'org_name', o.name, 'audience', bt.audience,
             'picture_day', b.picture_day, 'start_at', b.start_at, 'time_set', b.time_set, 'location', b.location,
             'plan_id', p.id, 'intake_sent_at', p.intake_sent_at, 'submitted_at', p.submitted_at,
             'teams', coalesce(k.teams, 0), 'timed', coalesce(k.timed, 0), 'sent', coalesce(k.sent, 0),
             'confirmed', coalesce(k.confirmed, 0), 'move', coalesce(k.move, 0), 'changed', coalesce(k.changed, 0))
           order by b.picture_day, b.start_at)
      from public.bookings b
      left join public.prospect_orgs o on o.id = b.org_id
      left join public.booking_types bt on bt.key = b.type_key
      left join public.pd_plans p on p.booking_id = b.id
      left join lateral (
        select count(*) teams, count(*) filter (where t.slot_at is not null) timed,
               count(*) filter (where t.status in ('sent', 'confirmed', 'move')) sent,
               count(*) filter (where t.status = 'confirmed') confirmed, count(*) filter (where t.status = 'move') move,
               count(*) filter (where t.status <> 'new' and (t.slot_at is distinct from t.sent_slot_at or t.field is distinct from t.sent_field)) changed
          from public.pd_teams t where t.plan_id = p.id and t.removed_at is null) k on true
     where b.status = 'booked' and b.picture_day >= current_date - 7), '[]'::jsonb);
end $$;

-- One picture day: the booking, the plan (made on first open by someone who can edit), teams, contacts, emails.
create function public.pd_get(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b public.bookings; p public.pd_plans; s public.booking_settings;
begin
  if not public.can('pictureday', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  b := public.pd_booking_ok(p_booking);
  select * into p from public.pd_plans where booking_id = b.id;
  if p.id is null and public.can('pictureday', 'edit') and b.status = 'booked' then
    insert into public.pd_plans (booking_id) values (b.id) on conflict (booking_id) do nothing;
    select * into p from public.pd_plans where booking_id = b.id;
  end if;
  select * into s from public.booking_settings;
  return jsonb_build_object(
    'booking', jsonb_build_object('id', b.id, 'title', public.schedule_booking_title(b.id), 'org_id', b.org_id,
                 'org_name', (select name from public.prospect_orgs where id = b.org_id), 'status', b.status,
                 'picture_day', b.picture_day, 'start_at', b.start_at, 'end_at', b.end_at, 'time_set', b.time_set, 'location', b.location),
    'plan', case when p.id is null then null else to_jsonb(p) end,
    'link', case when p.id is null then null else 'https://admin.207photo.com/#plan/' || p.token end,
    'teams', coalesce((select jsonb_agg(to_jsonb(t) || jsonb_build_object('link', 'https://admin.207photo.com/#slot/' || t.token,
                         'changed', t.status <> 'new' and (t.slot_at is distinct from t.sent_slot_at or t.field is distinct from t.sent_field),
                         'email_status', (select e.status from public.pd_emails e where e.team_id = t.id order by e.id desc limit 1))
                       order by t.field, t.slot_at nulls last, t.sort, t.created_at)
                         from public.pd_teams t where t.plan_id = p.id and t.removed_at is null), '[]'::jsonb),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', btrim(concat_ws(' ', c.first_name, c.last_name)), 'email', c.email,
                            'role', c.role, 'on_booking', c.id = any (coalesce(b.contact_ids, '{}')))
                          order by (c.id = any (coalesce(b.contact_ids, '{}'))) desc, c.is_primary desc, c.created_at)
                            from public.prospect_contacts c
                           where c.org_id = b.org_id and not coalesce(c.history_only, false) and c.stopped_at is null
                             and c.bounced_at is null and c.unsubscribed_at is null and public.pd_email_ok(c.email)), '[]'::jsonb),
    'booking_coaches', coalesce((select jsonb_agg(lower(bc.email)) from public.booking_coaches bc where bc.booking_id = b.id and not bc.removed), '[]'::jsonb),
    'emails', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'team_id', e.team_id, 'to_email', e.to_email, 'to_name', e.to_name,
                          'subject', e.subject, 'status', e.status, 'error', e.error, 'test_mode', e.test_mode, 'sent_to', e.sent_to,
                          'created_at', e.created_at, 'sent_at', e.sent_at) order by e.id desc)
                         from (select * from public.pd_emails where plan_id = p.id order by id desc limit 40) e), '[]'::jsonb),
    'sending', jsonb_build_object('enabled', coalesce(s.sending_enabled, false), 'test_mode', coalesce(s.test_mode, false), 'test_recipient', s.test_recipient));
end $$;

-- Staff edit the form's answers and the slot length. p: {onsite_name, onsite_phone, location, fields[], uniforms, props, notes, slot_min}
create function public.pd_save_plan(p_plan uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('pictureday', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.pd_plans set
    onsite_name = case when p ? 'onsite_name' then public.pd_clean(p->>'onsite_name', 120) else onsite_name end,
    onsite_phone = case when p ? 'onsite_phone' then public.pd_clean(p->>'onsite_phone', 40) else onsite_phone end,
    location = case when p ? 'location' then public.pd_clean(p->>'location', 300) else location end,
    fields = case when p ? 'fields' then (select coalesce(array_agg(f order by i), '{}') from (
               select distinct on (lower(public.pd_clean(x, 60))) public.pd_clean(x, 60) f, i
                 from jsonb_array_elements_text(p->'fields') with ordinality a(x, i) where public.pd_clean(x, 60) <> ''
                order by lower(public.pd_clean(x, 60)), i limit 30) z) else fields end,
    uniforms = case when p ? 'uniforms' then public.pd_clean(p->>'uniforms', 1000) else uniforms end,
    props = case when p ? 'props' then public.pd_clean(p->>'props', 1000) else props end,
    notes = case when p ? 'notes' then public.pd_clean(p->>'notes', 2000) else notes end,
    slot_min = case when p ? 'slot_min' then greatest(3, least(120, (p->>'slot_min')::int)) else slot_min end,
    updated_at = now()
   where id = p_plan;
  if not found then raise exception 'Picture day not found.'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Add or change a team. p: {id?, name, coach_name, coach_email, coach_phone, players, field, slot_at, slot_min}
create function public.pd_save_team(p_plan uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_email text := lower(public.pd_clean(p->>'coach_email', 200));
begin
  if not public.can('pictureday', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if public.pd_clean(p->>'name', 120) = '' then raise exception 'Give the team a name.'; end if;
  if v_email <> '' and not public.pd_email_ok(v_email) then raise exception 'That coach email doesn''t look right.'; end if;
  if v_id is null then
    insert into public.pd_teams (plan_id, name, coach_name, coach_email, coach_phone, players, field, slot_at, slot_min, sort, added_by)
    values (p_plan, public.pd_clean(p->>'name', 120), public.pd_clean(p->>'coach_name', 120), v_email, public.pd_clean(p->>'coach_phone', 40),
            nullif(p->>'players', '')::smallint, public.pd_clean(p->>'field', 60), nullif(p->>'slot_at', '')::timestamptz, nullif(p->>'slot_min', '')::smallint,
            coalesce((select max(sort) + 1 from public.pd_teams where plan_id = p_plan), 0), 'staff')
    returning id into v_id;
  else
    update public.pd_teams set name = public.pd_clean(p->>'name', 120), coach_name = public.pd_clean(p->>'coach_name', 120), coach_email = v_email,
           coach_phone = public.pd_clean(p->>'coach_phone', 40), players = nullif(p->>'players', '')::smallint,
           field = public.pd_clean(p->>'field', 60), slot_at = nullif(p->>'slot_at', '')::timestamptz, slot_min = nullif(p->>'slot_min', '')::smallint,
           -- a new coach address has not been told anything yet
           status = case when coach_email is distinct from v_email then 'new' else status end,
           updated_at = now()
     where id = v_id and plan_id = p_plan and removed_at is null;
    if not found then raise exception 'Team not found.'; end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Lay out slots in one go. p_slots: [{id, field, slot_at}]
create function public.pd_save_slots(p_plan uuid, p_slots jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.can('pictureday', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.pd_teams t set field = public.pd_clean(x->>'field', 60), slot_at = nullif(x->>'slot_at', '')::timestamptz, updated_at = now()
    from jsonb_array_elements(p_slots) x
   where t.plan_id = p_plan and t.id = (x->>'id')::uuid and t.removed_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'saved', n);
end $$;

create function public.pd_remove_team(p_team uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('pictureday', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.pd_teams set removed_at = now(), updated_at = now() where id = p_team and removed_at is null;
  update public.pd_emails set status = 'cancelled', error = 'team removed' where team_id = p_team and status = 'waiting';
  return jsonb_build_object('ok', found);
end $$;

-- Email the form to one of the organization's contacts (or any address).
create function public.pd_send_intake(p_plan uuid, p_contact uuid, p_email text default null, p_name text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.pd_plans; b public.bookings; c public.prospect_contacts; v_email text; v_name text; s public.booking_settings;
begin
  if not public.can('pictureday', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into p from public.pd_plans where id = p_plan;
  if p.id is null then raise exception 'Picture day not found.'; end if;
  select * into b from public.bookings where id = p.booking_id;
  if b.status <> 'booked' then raise exception 'Only booked jobs send emails.'; end if;
  if p_contact is not null then
    select * into c from public.prospect_contacts where id = p_contact and org_id = b.org_id;
    if c.id is null then raise exception 'That contact is not on this organization.'; end if;
    v_email := lower(btrim(c.email)); v_name := btrim(concat_ws(' ', c.first_name, c.last_name));
  else
    v_email := lower(public.pd_clean(p_email, 200)); v_name := public.pd_clean(p_name, 120);
  end if;
  if not public.pd_email_ok(v_email) then raise exception 'Pick someone with an email address.'; end if;
  update public.pd_plans set contact_id = c.id, contact_email = v_email, contact_name = nullif(v_name, ''), intake_sent_at = now(), updated_at = now()
   where id = p.id;
  perform public.pd_queue(p.id, null, 'intake', public.pd_intake_content(p.id));
  perform public.pd_send_waiting();
  select * into s from public.booking_settings;
  return jsonb_build_object('ok', true, 'to', v_email, 'sending_enabled', coalesce(s.sending_enabled, false), 'test_mode', coalesce(s.test_mode, false));
end $$;

-- Preview the email one coach would get.
create function public.pd_slot_preview(p_team uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('pictureday', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.pd_teams where id = p_team and slot_at is not null) then raise exception 'Give the team a time first.'; end if;
  return public.pd_slot_content(p_team);
end $$;

-- Email coaches their times. p_teams null = every team with a coach email and a time that hasn't been told yet,
-- or whose time or field changed since; otherwise exactly those teams (send again).
create function public.pd_send_slots(p_plan uuid, p_teams uuid[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.pd_plans; b public.bookings; t record; n int := 0; s public.booking_settings;
begin
  if not public.can('pictureday', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into p from public.pd_plans where id = p_plan;
  if p.id is null then raise exception 'Picture day not found.'; end if;
  select * into b from public.bookings where id = p.booking_id;
  if b.status <> 'booked' then raise exception 'Only booked jobs send emails.'; end if;
  for t in select * from public.pd_teams
            where plan_id = p.id and removed_at is null and slot_at is not null and public.pd_email_ok(coach_email)
              and (case when p_teams is null then status = 'new' or slot_at is distinct from sent_slot_at or field is distinct from sent_field
                        else id = any (p_teams) end)
            order by slot_at
            for update
  loop
    update public.pd_emails set status = 'cancelled', error = 'replaced by a newer email' where team_id = t.id and status = 'waiting';
    perform public.pd_queue(p.id, t.id, 'slot', public.pd_slot_content(t.id));
    update public.pd_teams set status = 'sent', sent_at = now(), sent_slot_at = slot_at, sent_field = field,
           responded_at = null, coach_note = '', updated_at = now()
     where id = t.id;
    n := n + 1;
  end loop;
  if n > 0 then perform public.pd_send_waiting(); end if;
  select * into s from public.booking_settings;
  return jsonb_build_object('ok', true, 'queued', n, 'sending_enabled', coalesce(s.sending_enabled, false), 'test_mode', coalesce(s.test_mode, false));
end $$;

-- Today: coaches who asked to move, and forms that came back with no times sent yet.
create function public.pd_attention() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('pictureday', 'view') then return jsonb_build_object('move', 0, 'to_plan', 0); end if;
  return jsonb_build_object(
    'move', (select count(*) from public.pd_teams t join public.pd_plans p on p.id = t.plan_id join public.bookings b on b.id = p.booking_id
              where t.status = 'move' and t.removed_at is null and b.status = 'booked' and b.picture_day >= current_date),
    'to_plan', (select count(*) from public.pd_plans p join public.bookings b on b.id = p.booking_id
                 where p.submitted_at is not null and b.status = 'booked' and b.picture_day >= current_date
                   and not exists (select 1 from public.pd_teams t where t.plan_id = p.id and t.removed_at is null and t.status <> 'new')));
end $$;

-- ---------------------------------------------------------------- public pages (no sign-in, by token)
-- The organization's form. Null when the link is unknown.
create function public.pd_public_plan(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.pd_plans; b public.bookings;
begin
  select * into p from public.pd_plans where token = p_token;
  if p.id is null or length(coalesce(p_token, '')) < 32 then return null; end if;
  select * into b from public.bookings where id = p.booking_id;
  if b.status <> 'booked' then return jsonb_build_object('closed', true, 'reason', 'This picture day is no longer on our calendar. Please contact 207 Photo.'); end if;
  return jsonb_build_object(
    'closed', b.picture_day < current_date,
    'org_name', (select name from public.prospect_orgs where id = b.org_id),
    'title', public.schedule_booking_title(b.id),
    'picture_day', b.picture_day, 'start_at', case when b.time_set then b.start_at end, 'end_at', case when b.end_set then b.end_at end,
    'booking_location', coalesce(b.location, ''),
    'contact_name', p.contact_name, 'submitted_at', p.submitted_at, 'updated_at', p.updated_by_contact_at,
    'onsite_name', p.onsite_name, 'onsite_phone', p.onsite_phone, 'location', p.location, 'fields', to_jsonb(p.fields),
    'uniforms', p.uniforms, 'props', p.props, 'notes', p.notes, 'roster_name', p.roster_name,
    'teams', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'coach_name', t.coach_name, 'coach_email', t.coach_email,
                         'coach_phone', t.coach_phone, 'players', t.players,
                         'slot_at', case when t.status <> 'new' then t.sent_slot_at end, 'field', case when t.status <> 'new' then t.sent_field end,
                         'status', t.status) order by t.sort, t.created_at)
                         from public.pd_teams t where t.plan_id = p.id and t.removed_at is null), '[]'::jsonb));
end $$;

-- The organization sends the form (again). p: {onsite_name, onsite_phone, location, fields[], uniforms, props, notes,
-- teams: [{id?, name, coach_name, coach_email, coach_phone, players}]}. Teams left out are removed only if no coach
-- has been emailed yet; a team already emailed stays, and staff sort it out.
create function public.pd_public_submit(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pl public.pd_plans; b public.bookings; x jsonb; v_id uuid; v_keep uuid[] := '{}'; v_email text; v_name text; n int := 0; v_first boolean;
begin
  select * into pl from public.pd_plans where token = p_token for update;
  if pl.id is null or length(coalesce(p_token, '')) < 32 then raise exception 'This link is not valid.'; end if;
  select * into b from public.bookings where id = pl.booking_id;
  if b.status <> 'booked' or b.picture_day < current_date then raise exception 'This form is closed. Please email 207 Photo with any changes.'; end if;
  if jsonb_typeof(p->'teams') is distinct from 'array' then raise exception 'Add your teams.'; end if;
  if jsonb_array_length(p->'teams') > 150 then raise exception 'That is a lot of teams. Please email 207 Photo the list instead.'; end if;
  v_first := pl.submitted_at is null;

  update public.pd_plans set
    onsite_name = public.pd_clean(p->>'onsite_name', 120), onsite_phone = public.pd_clean(p->>'onsite_phone', 40),
    location = public.pd_clean(p->>'location', 300),
    fields = (select coalesce(array_agg(f order by i), '{}') from (
               select distinct on (lower(public.pd_clean(y, 60))) public.pd_clean(y, 60) f, i
                 from jsonb_array_elements_text(coalesce(p->'fields', '[]')) with ordinality a(y, i) where public.pd_clean(y, 60) <> ''
                order by lower(public.pd_clean(y, 60)), i limit 30) z),
    uniforms = public.pd_clean(p->>'uniforms', 1000), props = public.pd_clean(p->>'props', 1000), notes = public.pd_clean(p->>'notes', 2000),
    submitted_at = coalesce(submitted_at, now()), updated_by_contact_at = now(), updated_at = now()
   where id = pl.id;

  for x in select * from jsonb_array_elements(p->'teams') loop
    v_name := public.pd_clean(x->>'name', 120);
    if v_name = '' then continue; end if;
    v_email := lower(public.pd_clean(x->>'coach_email', 200));
    if v_email <> '' and not public.pd_email_ok(v_email) then raise exception 'The coach email for % doesn''t look right.', v_name; end if;
    v_id := null;
    if nullif(x->>'id', '') is not null then
      update public.pd_teams set name = v_name, coach_name = public.pd_clean(x->>'coach_name', 120), coach_email = v_email,
             coach_phone = public.pd_clean(x->>'coach_phone', 40), players = least(500, greatest(0, nullif(regexp_replace(coalesce(x->>'players', ''), '\D', '', 'g'), '')::int)),
             status = case when coach_email is distinct from v_email then 'new' else status end, updated_at = now()
       where id = (x->>'id')::uuid and plan_id = pl.id and removed_at is null
      returning id into v_id;
    end if;
    if v_id is null then
      insert into public.pd_teams (plan_id, name, coach_name, coach_email, coach_phone, players, sort, added_by)
      values (pl.id, v_name, public.pd_clean(x->>'coach_name', 120), v_email, public.pd_clean(x->>'coach_phone', 40),
              least(500, greatest(0, nullif(regexp_replace(coalesce(x->>'players', ''), '\D', '', 'g'), '')::int)),
              coalesce((select max(sort) + 1 from public.pd_teams where plan_id = pl.id), 0), 'contact')
      returning id into v_id;
    end if;
    v_keep := v_keep || v_id; n := n + 1;
  end loop;
  update public.pd_teams set removed_at = now(), updated_at = now()
   where plan_id = pl.id and removed_at is null and status = 'new' and not (id = any (v_keep));

  begin
    perform public.push_notify('pd_intake',
      case when v_first then 'Picture day form is in' else 'Picture day form updated' end,
      coalesce((select name from public.prospect_orgs where id = b.org_id), 'An organization') || ': ' || n || ' team' || case when n = 1 then '' else 's' end ||
        ', picture day ' || to_char(b.picture_day, 'FMMon FMDD') || '.',
      '/#jobs/pictureday/' || b.id, 'pd_intake_' || pl.id);
  exception when others then raise warning 'pd_intake push: %', sqlerrm;
  end;
  return jsonb_build_object('ok', true, 'teams', n);
end $$;

-- Roster file: the page uploads it to storage (pictureday/<token>/...) and then records it here.
create function public.pd_roster_path_ok(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.pd_plans p join public.bookings b on b.id = p.booking_id
                  where p.token = split_part(coalesce(p_name, ''), '/', 1) and length(p.token) >= 32
                    and b.status = 'booked' and b.picture_day >= current_date)
         and coalesce(p_name, '') ~ '^[0-9a-f]{32,}/[^/]{1,180}$' $$;

create function public.pd_public_roster(p_token text, p_path text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.pd_roster_path_ok(p_path) or split_part(p_path, '/', 1) <> p_token then raise exception 'This link is not valid.'; end if;
  update public.pd_plans set roster_path = p_path, roster_name = public.pd_clean(p_name, 180), roster_at = now(), updated_at = now() where token = p_token;
  return jsonb_build_object('ok', true);
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pictureday', 'pictureday', false, 10485760,
        array['text/csv', 'text/plain', 'application/pdf', 'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet',
              'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png', 'image/heic'])
on conflict (id) do nothing;
create policy pictureday_roster_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'pictureday' and public.pd_roster_path_ok(name));
create policy pictureday_roster_read on storage.objects for select to authenticated
  using (bucket_id = 'pictureday' and (select public.can('pictureday', 'view')));

-- A coach's slot page.
create function public.pd_public_slot(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.pd_teams; p public.pd_plans; b public.bookings;
begin
  select * into t from public.pd_teams where token = p_token and removed_at is null;
  if t.id is null or length(coalesce(p_token, '')) < 32 then return null; end if;
  select * into p from public.pd_plans where id = t.plan_id;
  select * into b from public.bookings where id = p.booking_id;
  if b.status <> 'booked' then return jsonb_build_object('closed', true, 'reason', 'This picture day is no longer on our calendar. Please contact 207 Photo.'); end if;
  if t.status = 'new' or t.sent_slot_at is null then return jsonb_build_object('closed', true, 'reason', 'Your team''s time isn''t set yet. We will email you when it is.'); end if;
  return jsonb_build_object(
    'closed', b.picture_day < current_date,
    'org_name', (select name from public.prospect_orgs where id = b.org_id),
    'team', t.name, 'coach_name', t.coach_name,
    'slot_at', t.sent_slot_at, 'slot_min', coalesce(t.slot_min, p.slot_min), 'field', coalesce(t.sent_field, ''),
    'where', public.pd_where(p.id), 'uniforms', p.uniforms, 'props', p.props,
    'onsite_name', p.onsite_name, 'onsite_phone', p.onsite_phone,
    'status', t.status, 'coach_note', t.coach_note, 'responded_at', t.responded_at);
end $$;

-- The coach answers: 'confirm', or 'move' with a note on what would work.
create function public.pd_public_slot_reply(p_token text, p_answer text, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.pd_teams; b public.bookings; v_org text; v_note text := public.pd_clean(p_note, 1000);
begin
  if p_answer not in ('confirm', 'move') then raise exception 'Pick confirm or move.'; end if;
  select * into t from public.pd_teams where token = p_token and removed_at is null for update;
  if t.id is null or length(coalesce(p_token, '')) < 32 or t.status = 'new' then raise exception 'This link is not valid.'; end if;
  select b2.* into b from public.bookings b2 join public.pd_plans p on p.booking_id = b2.id where p.id = t.plan_id;
  if b.status <> 'booked' or b.picture_day < current_date then raise exception 'Picture day has passed. Please email 207 Photo.'; end if;
  if p_answer = 'move' and v_note = '' then raise exception 'Tell us what time would work better.'; end if;
  update public.pd_teams set status = case when p_answer = 'confirm' then 'confirmed' else 'move' end,
         coach_note = case when p_answer = 'confirm' then '' else v_note end, responded_at = now(), updated_at = now()
   where id = t.id;
  if p_answer = 'move' then
    select name into v_org from public.prospect_orgs where id = b.org_id;
    begin
      perform public.push_notify('pd_move', t.name || ' wants a different time',
        coalesce(v_org || ': ', '') || left(v_note, 200), '/#jobs/pictureday/' || b.id, 'pd_move_' || t.id);
    exception when others then raise warning 'pd_move push: %', sqlerrm;
    end;
  end if;
  return jsonb_build_object('ok', true, 'status', case when p_answer = 'confirm' then 'confirmed' else 'move' end);
end $$;

insert into public.push_topics (key, label, description, module, sort) values
  ('pd_intake', 'Picture day form is in', 'An organization sent or updated its picture day form.', 'pictureday', 15),
  ('pd_move',   'Coach wants a different time', 'A coach asked to move their team''s picture day slot.', 'pictureday', 16)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- grants
revoke all on function public.pd_new_token(), public.pd_where(uuid), public.pd_intake_content(uuid), public.pd_slot_content(uuid),
  public.pd_send_waiting(), public.pd_queue(uuid, uuid, text, jsonb), public.pd_booking_ok(uuid)
  from public, anon, authenticated;
revoke all on function public.pd_list(), public.pd_get(uuid), public.pd_save_plan(uuid, jsonb), public.pd_save_team(uuid, jsonb),
  public.pd_save_slots(uuid, jsonb), public.pd_remove_team(uuid), public.pd_send_intake(uuid, uuid, text, text), public.pd_slot_preview(uuid),
  public.pd_send_slots(uuid, uuid[]), public.pd_attention()
  from public, anon;
grant execute on function public.pd_list(), public.pd_get(uuid), public.pd_save_plan(uuid, jsonb), public.pd_save_team(uuid, jsonb),
  public.pd_save_slots(uuid, jsonb), public.pd_remove_team(uuid), public.pd_send_intake(uuid, uuid, text, text), public.pd_slot_preview(uuid),
  public.pd_send_slots(uuid, uuid[]), public.pd_attention()
  to authenticated;
-- The public pages: anyone with the link.
revoke all on function public.pd_public_plan(text), public.pd_public_submit(text, jsonb), public.pd_public_roster(text, text, text),
  public.pd_public_slot(text), public.pd_public_slot_reply(text, text, text), public.pd_roster_path_ok(text) from public;
grant execute on function public.pd_public_plan(text), public.pd_public_submit(text, jsonb), public.pd_public_roster(text, text, text),
  public.pd_public_slot(text), public.pd_public_slot_reply(text, text, text), public.pd_roster_path_ok(text) to anon, authenticated;
