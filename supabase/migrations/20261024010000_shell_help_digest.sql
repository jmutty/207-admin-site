-- Shell stream (walkthrough build, 2026-10-24). Two small functions for the app's account menu:
--   help_contacts()      the account menu's Help line: the full-access people (the owner first) with an email and,
--                        when one is on file, a phone, so a new hire knows who to ask. Any signed-in team member.
--   me_digest()          "Morning email goes to you" in Notifications (full access only): is my address on the
--   me_digest_set(bool)  morning email's recipients (admin_settings.digest_recipients)? Adds or removes only my own
--                        address; the list's other addresses and the on/off switch (digest_enabled) are untouched.
-- New functions only; nothing existing changes. Safe to run twice.

-- ---------------------------------------------------------------- Help line
-- The phone comes from a team_members.phone column when one exists (the person record may gain one), else the
-- auth user's phone or user_metadata.phone. to_jsonb() keeps this working whether or not that column exists yet.
create or replace function public.help_contacts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_team_member() then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'name', coalesce(nullif(m.display_name, ''), nullif(u.raw_user_meta_data ->> 'name', ''), split_part(u.email, '@', 1)),
             'email', u.email,
             'phone', nullif(btrim(coalesce(to_jsonb(m) ->> 'phone', nullif(to_jsonb(u) ->> 'phone', ''), u.raw_user_meta_data ->> 'phone', '')), ''))
           order by coalesce(m.created_at, u.created_at), u.email)
      from public.admin_users a
      join auth.users u on u.id = a.user_id
      left join public.team_members m on m.user_id = a.user_id
     where coalesce(m.active, true)), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- Morning email goes to you
create or replace function public.me_digest()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_email text;
  v_list  text[];
  v_on    boolean;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select lower(u.email) into v_email from auth.users u where u.id = (select auth.uid());
  select s.digest_recipients, s.digest_enabled into v_list, v_on from public.admin_settings s where s.id;
  return jsonb_build_object(
    'email', v_email,
    'on', v_email is not null and exists (select 1 from unnest(coalesce(v_list, '{}')) r where lower(btrim(r)) = v_email),
    'enabled', coalesce(v_on, false));
end $$;

create or replace function public.me_digest_set(p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_on is null then raise exception 'say on or off' using errcode = '22023'; end if;
  select lower(u.email) into v_email from auth.users u where u.id = (select auth.uid());
  if v_email is null then raise exception 'your account has no email address' using errcode = '22023'; end if;
  update public.admin_settings s
     set digest_recipients = case
           when p_on then case when exists (select 1 from unnest(coalesce(s.digest_recipients, '{}')) r where lower(btrim(r)) = v_email)
                               then s.digest_recipients
                               else array_append(coalesce(s.digest_recipients, '{}'), v_email) end
           else array(select r from unnest(coalesce(s.digest_recipients, '{}')) with ordinality t(r, i) where lower(btrim(r)) <> v_email order by i) end,
         updated_at = now()
   where s.id;
  return public.me_digest();
end $$;

-- ---------------------------------------------------------------- grants
revoke all on function public.help_contacts() from public, anon;
revoke all on function public.me_digest() from public, anon;
revoke all on function public.me_digest_set(boolean) from public, anon;
grant execute on function public.help_contacts() to authenticated;
grant execute on function public.me_digest() to authenticated;
grant execute on function public.me_digest_set(boolean) to authenticated;
