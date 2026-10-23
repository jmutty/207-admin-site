-- Short email links (2026-10-24). Booking emails showed each tracked link as the long
-- https://socluffmclkdljtmiexw.supabase.co/functions/v1/go?e=<email>&u=<base64 link>. Now:
--   1. every tracked link gets an 8-character code per email (booking_link_codes), and the email carries
--      https://admin.207photo.com/go/<code>. Cloudflare Pages (site/_redirects) sends /go/<code> on to the
--      "go" edge function as ?c=<code>, which logs the click (booking_link_go -> booking_link_click) and redirects.
--   2. a bare link becomes clickable words ("Open your picture day page", "Open the message on your hub").
--      Links a template already wrote as [words](link) keep their words. The plain-text copy of the email
--      shows "words (https://admin.207photo.com/go/<code>)" (booking-sender's mdToText).
-- Codes are derived from the email and link, so rendering the same email again (preview, then the real send)
-- gives the same code. Emails that already went out keep their old links, and the go function still answers them.
-- booking_track_links now writes rows, so it and the two functions that call it on the way to the app
-- (booking_render_row, booking_email_preview) become VOLATILE.

create table if not exists public.booking_link_codes (
  code       text primary key,
  email_id   uuid not null references public.booking_emails (id) on delete cascade,
  url        text not null,
  created_at timestamptz not null default now(),
  unique (email_id, url)
);
alter table public.booking_link_codes enable row level security;
revoke all on public.booking_link_codes from public, anon, authenticated;

-- The code for one link in one email, made on first use. 8 base64url characters of sha256(email|link|try).
create or replace function public.booking_link_code(p_email uuid, p_url text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_code text; i int := 0;
begin
  select code into v_code from public.booking_link_codes where email_id = p_email and url = p_url;
  if v_code is not null then return v_code; end if;
  loop
    v_code := left(translate(encode(sha256(convert_to(p_email::text || '|' || p_url || '|' || i, 'UTF8')), 'base64'), '+/=', '-_'), 8);
    begin
      insert into public.booking_link_codes (code, email_id, url) values (v_code, p_email, p_url);
      return v_code;
    exception when unique_violation then
      select code into v_code from public.booking_link_codes where email_id = p_email and url = p_url;
      if v_code is not null then return v_code; end if; -- made by a render running at the same time
      i := i + 1;                                         -- a different link already has this code
      if i > 5 then return null; end if;
    end;
  end loop;
end $$;

-- The words a bare link gets in the email.
create or replace function public.booking_link_label(p_url text) returns text
language sql immutable set search_path = '' as $$
  select case when p_url ~ '^https://admin\.207photo\.com/#day/' then 'Open your picture day page'
              when p_url ~ '^https://207photo\.com/(sportsadmin|schooladmin)/.*send=' then 'Open the message on your hub'
              when p_url ~ '^https://207photo\.com/(sportsadmin|schooladmin)' then 'Open your hub'
              when p_url ~ '/functions/v1/booking-ics\?' then 'Add it to your calendar'
              else 'Open the link' end
$$;

create or replace function public.booking_track_links(p_body text, p_email uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare m text; v text := coalesce(p_body, ''); c text; s text;
begin
  if p_email is null or not exists (select 1 from public.booking_emails where id = p_email) then return v; end if;
  -- longest first: the hub's home link is a prefix of each message link
  for m in select u from (select distinct regexp_replace(x[1], '[.,;:]+$', '') u
                            from regexp_matches(v, '(https://(?:207photo\.com/(?:sportsadmin|schooladmin)|admin\.207photo\.com/#day/|socluffmclkdljtmiexw\.supabase\.co/functions/v1/booking-ics\?)[^\s\)\]>"<]*)', 'g') x) q
            order by length(u) desc loop
    if public.booking_link_ok(m) then
      c := public.booking_link_code(p_email, m);
      if c is null then -- no free code (never expected): the old long tracked link
        v := replace(v, m, 'https://socluffmclkdljtmiexw.supabase.co/functions/v1/go?e=' || p_email
                          || '&u=' || translate(replace(encode(convert_to(m, 'UTF8'), 'base64'), E'\n', ''), '+/=', '-_'));
        continue;
      end if;
      s := 'https://admin.207photo.com/go/' || c;
      v := replace(v, '](' || m || ')', '](' || s || ')');                        -- [words](link): keep the words
      v := replace(v, m, '[' || public.booking_link_label(m) || '](' || s || ')'); -- bare link: give it words
    end if;
  end loop;
  return v;
end $$;
revoke all on function public.booking_link_code(uuid, text), public.booking_track_links(text, uuid) from public, anon, authenticated;

-- The go function's answer for /go/<code>: where to send the person (null: no such code). p_log false for a HEAD.
create or replace function public.booking_link_go(p_code text, p_log boolean default true) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare r public.booking_link_codes;
begin
  if coalesce(p_code, '') !~ '^[A-Za-z0-9_-]{8}$' then return null; end if;
  select * into r from public.booking_link_codes where code = p_code;
  if r.code is null then return null; end if;
  if not p_log then return case when public.booking_link_ok(r.url) then r.url end; end if;
  return public.booking_link_click(r.email_id, r.url);
end $$;
revoke all on function public.booking_link_go(text, boolean) from public;
grant execute on function public.booking_link_go(text, boolean) to anon, authenticated;

alter function public.booking_render_row(uuid) volatile;
alter function public.booking_email_preview(uuid) volatile;
