-- Jobs calendar "Show" list (2026-10-24, Jeremiah): which extras the calendar shows (who's on it, weather, holds,
-- Google Calendar events, launch day, discount ends...). The owner's picks are everyone's default; each person can
-- change their own on their device (the app keeps that), and "Use the company default" goes back.
-- Stored as {key: true/false}; keys the app doesn't know are ignored, keys missing use the app's built-in default.

alter table public.admin_settings add column if not exists calendar_show jsonb;
comment on column public.admin_settings.calendar_show is 'Jobs calendar Show list, the company default ({layer: true/false}). Set by full access from the calendar; null = built-in defaults.';

create or replace function public.calendar_show_get()
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $$
  select s.calendar_show from public.admin_settings s where s.id and public.can_any('{bookings}', 'view')
$$;

create or replace function public.calendar_show_set(p_show jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_show is not null and jsonb_typeof(p_show) <> 'object' then raise exception 'bad show list'; end if;
  insert into public.admin_settings (id, calendar_show, updated_at) values (true, p_show, now())
  on conflict (id) do update set calendar_show = excluded.calendar_show, updated_at = now();
end $$;

revoke all on function public.calendar_show_get() from public, anon;
revoke all on function public.calendar_show_set(jsonb) from public, anon;
grant execute on function public.calendar_show_get() to authenticated;
grant execute on function public.calendar_show_set(jsonb) to authenticated;
