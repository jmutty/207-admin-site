-- Mileage is reimbursed from the studio, paid time counts from home (2026-10-24, Jeremiah: "I want drive time to
-- count toward their pay, so I want to count the time from home to the job. But I'm only willing to reimburse
-- from the studio to the job.").
--
-- Since 20261025000000 everyone with a home address starts and ends at home, so their drive bars (and scheduled
-- hours) count from home. Miles for reimbursement don't: each job is a round trip from the studio, and on a
-- batched trip the first leg is studio -> first job and the last is last job -> studio (job to job legs as
-- measured). When the studio drive to a job isn't looked up yet, the measured leg is used.
create or replace function public.mileage_estimate_for(p_user uuid, p_booking uuid, p_day date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select round((case when public.schedule_from_home(p_user) and not public.schedule_batched_later(e.batch_id, e.starts_at)
                        then coalesce(public.mileage_estimate(p_booking) * 1609.344 / 2, e.drive_before_m) else e.drive_before_m end
                 + case when public.schedule_from_home(p_user) and e.drive_after_m > 0
                        then coalesce(public.mileage_estimate(p_booking) * 1609.344 / 2, e.drive_after_m) else e.drive_after_m end) / 1609.344, 1)
       from public.schedule_entries e
      where e.user_id = p_user and e.booking_id = p_booking and e.kind = 'job' and e.batch_id is not null
        and e.drive_before_m is not null and e.drive_after_m is not null
        and (e.starts_at at time zone 'America/New_York')::date = p_day
      order by e.starts_at limit 1),
    public.mileage_estimate(p_booking))
$$;
