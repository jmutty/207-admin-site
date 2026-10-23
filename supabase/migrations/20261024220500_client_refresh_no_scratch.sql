-- Partner merge failed with "DELETE requires a WHERE clause" (2026-10-24): prospect_client_refresh cleared a scratch
-- table with a bare DELETE, which the API's safe-update guard refuses when a signed-in person's request reaches it
-- (partner_merge calls it; the GotPhoto sync never hit the guard). Same results, read from a CTE instead of a scratch table.
create or replace function public.prospect_client_jobs(p_org uuid) returns table (d date, cat text, src text)
language sql stable security definer set search_path to 'public' as $$
  select j.shoot_at::date, trim(split_part(j.name, '|', 2)), 'gp' from prospect_orgs o, synced_jobs j
   where o.id = p_org and cardinality(o.gotphoto_names) > 0 and trim(split_part(j.name, '|', 1)) = any (o.gotphoto_names) and j.shoot_at is not null
  union all
  select x, null, 'cal' from prospect_orgs o, unnest(o.cal_dates) x where o.id = p_org
$$;
revoke execute on function public.prospect_client_jobs(uuid) from public, anon, authenticated;

create or replace function public.prospect_client_refresh(p_org uuid) returns void
language plpgsql security definer set search_path to 'public' as $function$
declare o prospect_orgs; v_sports text[]; v_seasons text[]; v_months int[]; v_first date; v_last date; v_next date; v_n int; v_recent int;
begin
  select * into o from prospect_orgs where id = p_org;
  if o.id is null or (cardinality(o.gotphoto_names) = 0 and cardinality(o.cal_dates) = 0) then return; end if;
  select min(j.d), max(j.d) filter (where j.d <= current_date), min(j.d) filter (where j.d > current_date),
         count(*) filter (where j.src = 'gp'), count(*) filter (where j.d >= current_date - 800)
    into v_first, v_last, v_next, v_n, v_recent from prospect_client_jobs(p_org) j;
  select coalesce(array_agg(distinct s), '{}') into v_sports
    from prospect_client_jobs(p_org) j, unnest(public.prospect_job_sports(j.cat, o.audience)) s where j.cat is not null and (v_recent = 0 or j.d >= current_date - 800);
  select coalesce(array_agg(distinct extract(month from j.d)::int order by extract(month from j.d)::int), '{}') into v_months
    from prospect_client_jobs(p_org) j where v_recent = 0 or j.d >= current_date - 800;
  select coalesce(array_agg(distinct case when m between 8 and 11 then 'fall' when m in (12, 1, 2, 3) then 'winter' else 'spring' end), '{}')
    into v_seasons from unnest(v_months) m;
  update prospect_orgs set client_since = v_first, last_job_at = v_last,
         next_job_at = coalesce(v_next, case when next_job_at >= current_date then next_job_at end),
         job_count = nullif(v_n, 0),
         shoot_months = v_months,
         sports = (select coalesce(array_agg(distinct s), '{}') from unnest(o.sports || v_sports) s),
         seasons = case when cardinality(v_seasons) > 0 then v_seasons else seasons end,
         seasons_manual = cardinality(v_seasons) > 0 or seasons_manual
   where id = p_org;
  select * into o from prospect_orgs where id = p_org;
  if o.stage = 'client' and (o.last_job_at is null or o.last_job_at < current_date - 548) and (o.next_job_at is null or o.next_job_at < current_date) then
    perform prospect_stage_auto(p_org, 'past_client', 'No picture day in 18 months');
  elsif o.stage = 'past_client' and (o.next_job_at >= current_date or o.last_job_at >= current_date - 548) then
    perform prospect_stage_auto(p_org, 'client', 'New picture day booked');
  end if;
end $function$;
