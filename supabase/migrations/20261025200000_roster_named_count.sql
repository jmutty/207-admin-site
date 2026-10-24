-- Roster counts named athletes, not access codes (2026-10-24, Jeremiah: "Roster counts are off ... probably counting blank
-- access codes created for missing athletes"). GotPhoto showed Midcoast Rec 32 names / Maine Coast Storm 91 names; we
-- showed 183 and 80 because synced_jobs.code_count counts every active QR code, blank ones included.
--
-- Also: adding a names list in GotPhoto doesn't always change the job's `modified` time, and gotphoto-sync only re-pulls a
-- job's codes when that time moves, so our copy can miss a roster loaded later (Maine Coast Storm: 80 blank codes synced
-- 10/14, 91 names in GotPhoto now). roster-refresh marks jobs with a picture day in the next 30 days for a fresh code
-- pull once an hour, so the next 5-minute sync picks up new names. Only an update; nothing is removed.

create or replace function public.booking_roster(p_booking uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $$
declare b record; j record; v_names int := 0; v_today date := (now() at time zone 'America/New_York')::date; v_in boolean; v_state text; v_due date;
begin
  select bk.id, bk.picture_day, bk.status, bk.gotphoto_job_id, bk.hub_school_id, bk.school_data_at, t.audience
    into b from public.bookings bk join public.booking_types t on t.key = bk.type_key where bk.id = p_booking;
  if b.id is null then return null; end if;
  select sj.gotphoto_job_id, sj.roster_loaded_at, coalesce(sj.code_count, 0) code_count, sj.access_type into j
    from public.synced_jobs sj
   where sj.gotphoto_job_id = coalesce(b.gotphoto_job_id, case when b.hub_school_id is not null then public.school_hub_job(b.hub_school_id) end);
  v_due := b.picture_day - 14;
  if b.audience = 'school' then
    v_in := b.school_data_at is not null;
  elsif j.gotphoto_job_id is null then
    v_state := 'nojob';
  elsif j.access_type = 'single_password' then
    v_state := 'single';
  else
    -- Named athletes only. Blank QR cards made for kids missing from the roster (or spares for picture day) have no name
    -- and are not a roster: Midcoast Rec had 32 names and 151 blank cards, and showed "Roster in · 183".
    select count(*) into v_names from public.synced_codes c
     where c.gotphoto_job_id = j.gotphoto_job_id and c.active and c.code_type = 'photo'
       and btrim(coalesce(c.subject_first, '') || coalesce(c.subject_last, '')) <> '';
    v_in := v_names > 0;
  end if;
  if b.picture_day < v_today then v_state := 'past';
  elsif v_state is null then v_state := case when v_in then 'in' when v_today > v_due then 'late' else 'due' end;
  end if;
  return jsonb_build_object('state', v_state, 'names', case when b.audience = 'school' then null else v_names end,
    'loaded_at', case when b.audience = 'school' then b.school_data_at when v_names > 0 then j.roster_loaded_at end,
    'due', v_due, 'days_out', b.picture_day - v_today, 'school', b.audience = 'school');
end $$;
revoke all on function public.booking_roster(uuid) from public, anon;
grant execute on function public.booking_roster(uuid) to authenticated;


create or replace function public.roster_refresh_tick() returns int
language sql security definer set search_path = '' as $$
  with t as (
    update public.synced_jobs j set codes_synced_for = null
     where j.status in ('published', 'created') and j.access_type is distinct from 'single_password'
       and j.shoot_at between now() - interval '1 day' and now() + interval '30 days'
       and j.codes_synced_for is not null
    returning 1)
  select count(*)::int from t;
$$;
revoke all on function public.roster_refresh_tick() from public, anon, authenticated;

do $$ begin
  perform cron.unschedule('roster-refresh') where exists (select 1 from cron.job where jobname = 'roster-refresh');
  perform cron.schedule('roster-refresh', '25 * * * *', 'select public.roster_refresh_tick()');
end $$;
