-- GotPhoto job names follow the booking's title (Jeremiah 2026-10-23). A job 207 Admin made gets renamed in
-- GotPhoto (PUT /v4/jobs/{id} name, by gotphoto-jobs each run) when the name the booking now gives (gp_job_name)
-- differs from the name 207 Admin last gave it (gp_job_creates.job_name). Compared with our own last name, not
-- GotPhoto's, so a rename done by hand in GotPhoto stays until the booking's title changes again.
create or replace function public.gp_rename_queue(p_limit int default 10) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('booking_id', x.id, 'gotphoto_job_id', x.gotphoto_job_id, 'name', x.want, 'was', x.job_name)), '[]'::jsonb)
    from (select b.id, b.gotphoto_job_id, c.job_name, public.gp_job_name(b.id) as want
            from bookings b join gp_job_creates c on c.booking_id = b.id and c.gotphoto_job_id = b.gotphoto_job_id
           where b.status = 'booked' and c.status in ('created', 'linked')
             and public.gp_job_name(b.id) is distinct from c.job_name
           limit p_limit) x;
$$;
revoke all on function public.gp_rename_queue(int) from public, anon, authenticated;
grant execute on function public.gp_rename_queue(int) to service_role;

create or replace function public.gp_rename_done(p_booking uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update gp_job_creates set job_name = p_name, updated_at = now() where booking_id = p_booking;
  update synced_jobs s set name = p_name from bookings b where b.id = p_booking and s.gotphoto_job_id = b.gotphoto_job_id;
end $$;
revoke all on function public.gp_rename_done(uuid, text) from public, anon, authenticated;
grant execute on function public.gp_rename_done(uuid, text) to service_role;
