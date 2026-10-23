-- Welcome email wording (2026-10-23): it said "On iPhone, open it in Safari", but staff opening it in Chrome
-- were following Safari steps. The #welcome page (app/src/welcome.js) now shows Chrome's own taps, so the email
-- says either browser works. Same function as 20261022190000_team_welcome_email.sql otherwise.

create or replace function public.team_send_welcome(p_user_id uuid, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text; v_name text; v_by text; v_key text; v_new boolean;
  v_link constant text := 'https://admin.207photo.com/#welcome';
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_password, '') !~ '^[a-z2-9]{4}(-[a-z2-9]{4}){3}$' then raise exception 'bad temporary password'; end if;
  -- Only for someone on a temporary password: they are asked to choose their own at sign-in.
  select u.email, split_part(public.staff_name(m.user_id), ' ', 1),
         not exists (select 1 from public.team_audit a where a.target = m.user_id and a.action = 'welcome_sent')
    into v_email, v_name, v_new
    from public.team_members m join auth.users u on u.id = m.user_id
   where m.user_id = p_user_id and m.active and m.must_change_password;
  if not found then raise exception 'They are not waiting on a temporary password.'; end if;
  if coalesce(v_email, '') = '' then raise exception 'They have no email address.'; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_key is null then raise exception 'Email is not set up (resend_api_key).'; end if;
  v_by := coalesce(public.staff_name((select auth.uid())), '207 Photo');

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'from', '207 Admin <alerts@207photo.com>', 'to', jsonb_build_array(v_email),
      'subject', case when v_new then 'Welcome to 207 Admin' else 'Your new 207 Admin password' end,
      'text', 'Hi ' || v_name || E',\n\n' ||
              case when v_new then v_by || E' added you to 207 Admin, 207 Photo''s internal app.\n\n'
                   else v_by || E' gave you a new temporary password for 207 Admin.\n\n' end ||
              E'1. PUT IT ON YOUR PHONE\nOpen this link on your phone and follow the steps (about 30 seconds). Safari and Chrome both work; the page shows the taps for your browser:\n' || v_link || E'\n\n' ||
              E'2. SIGN IN\nEmail: ' || v_email || E'\nTemporary password: ' || p_password || E'\n\n' ||
              E'We will email you a 6-digit code to finish signing in. Then you choose your own password, and this one stops working.\n\n' ||
              E'Questions? Ask ' || v_by || '.',
      'html', '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1f1e1b;max-width:520px">' ||
              '<p style="font-size:16px">Hi ' || public.html_esc(v_name) || ',</p>' ||
              '<p>' || public.html_esc(v_by) || case when v_new then ' added you to <b>207 Admin</b>, 207 Photo&#39;s internal app.' else ' gave you a new temporary password for <b>207 Admin</b>.' end || '</p>' ||
              '<h3 style="margin:22px 0 6px;font-size:15px">1. Put it on your phone</h3>' ||
              '<p style="margin:0 0 12px">Open this on your phone and follow the steps. It takes about 30 seconds.</p>' ||
              '<p style="margin:0 0 6px"><a href="' || v_link || '" style="display:inline-block;background:#bf4a1f;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:4px">Get the 207 Admin app</a></p>' ||
              '<p style="margin:0;font-size:13px;color:#6b675f">Safari and Chrome both work. The page shows the taps for the browser you open it in.</p>' ||
              '<h3 style="margin:22px 0 6px;font-size:15px">2. Sign in</h3>' ||
              '<table style="border-collapse:collapse;font-size:15px"><tr><td style="padding:3px 14px 3px 0;color:#6b675f">Email</td><td style="padding:3px 0">' || public.html_esc(v_email) || '</td></tr>' ||
              '<tr><td style="padding:3px 14px 3px 0;color:#6b675f">Temporary password</td><td style="padding:3px 0;font-family:Menlo,Consolas,monospace;font-size:16px;white-space:nowrap"><b>' || p_password || '</b></td></tr></table>' ||
              '<p>We will email you a 6-digit code to finish signing in. Then you choose your own password, and this one stops working.</p>' ||
              '<p style="margin-top:22px;font-size:13px;color:#6b675f">Questions? Ask ' || public.html_esc(v_by) || '. From <a href="https://admin.207photo.com/" style="color:#6b675f">207 Admin</a>.</p></div>'),
    timeout_milliseconds := 10000);

  insert into public.team_audit (actor, target, action) values ((select auth.uid()), p_user_id, 'welcome_sent');
  return jsonb_build_object('ok', true, 'to', v_email);
end $$;

revoke all on function public.team_send_welcome(uuid, text) from public, anon;
grant execute on function public.team_send_welcome(uuid, text) to authenticated;
