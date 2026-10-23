-- 20261024150000 created these tables without table grants, so Settings > Job types could not read
-- the GotPhoto defaults (saving worked: it goes through a security definer function). Read access is
-- still limited by each table's RLS policy (can_any('{bookings}','view')). Applied live 2026-10-23.
grant select on public.gp_type_defaults, public.gp_create_settings, public.gp_job_creates to authenticated;
