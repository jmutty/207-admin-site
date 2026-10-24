-- "Roster loaded" means GotPhoto has named athletes (2026-10-24, Jeremiah: "this is showing a roster but there isn't one
-- loaded?"). Penquis got 60 blank QR cards today. synced_jobs_roster_loaded_at stamped roster_loaded_at as soon as a job had
-- more than one code, so the Hub tab said "loaded 10/24 (60 codes)" and closed the No roster task.
-- Now roster_loaded_at is set only while the job has at least one active photo code with a name, and cleared when it has
-- none. The other checks that read "more than one code" as a roster (booking emails' roster_in, the legacy hub reminders)
-- read roster_loaded_at instead. No rows are removed.

create or replace function public.synced_jobs_roster_loaded_at()
 returns trigger
 language plpgsql
as $function$
begin
  if new.access_type is distinct from 'single_password' then
    if exists (select 1 from public.synced_codes c
                where c.gotphoto_job_id = new.gotphoto_job_id and c.active and c.code_type = 'photo'
                  and btrim(coalesce(c.subject_first, '') || coalesce(c.subject_last, '')) <> '') then
      new.roster_loaded_at := coalesce(new.roster_loaded_at, now());
    else
      new.roster_loaded_at := null;
    end if;
  end if;
  return new;
end $function$;

-- Re-check every job stamped so far (the trigger runs on any update that sets code_count).
update public.synced_jobs set code_count = code_count where roster_loaded_at is not null;

-- booking_vars and hub_reminders_due: swap their "more than one code" test for roster_loaded_at. Edited from the live
-- definitions so nothing else in them changes; each swap must match once or the migration stops.
do $$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.booking_vars'::regproc);
  v_new := replace(v_def,
    'v_roster_in := j.gotphoto_job_id is not null and (j.roster_loaded_at is not null or (coalesce(j.access_type, '''') <> ''single_password'' and coalesce(j.code_count, 0) > 1));',
    'v_roster_in := j.gotphoto_job_id is not null and j.roster_loaded_at is not null;');
  if v_new = v_def then raise exception 'booking_vars: roster_in line not found'; end if;
  execute v_new;

  select p.oid::regprocedure::text into v_new from pg_proc p where p.proname = 'hub_reminders_due' and p.pronamespace = 'public'::regnamespace;
  v_def := pg_get_functiondef(v_new::regprocedure);
  v_new := replace(v_def, 'and coalesce(j.code_count, 0) > 1', 'and j.roster_loaded_at is not null');
  if v_new = v_def then raise exception 'hub_reminders_due: code_count test not found'; end if;
  execute v_new;

  -- booking_parents (the Hub tab) also returns how many named athletes there are.
  select p.oid::regprocedure::text into v_new from pg_proc p where p.proname = 'booking_parents' and p.pronamespace = 'public'::regnamespace;
  v_def := pg_get_functiondef(v_new::regprocedure);
  v_new := replace(v_def, '''code_count'', coalesce(j.code_count, 0),',
    '''code_count'', coalesce(j.code_count, 0), ''named_count'', (select count(*) from public.synced_codes c where c.gotphoto_job_id = j.gotphoto_job_id and c.active and c.code_type = ''photo'' and btrim(coalesce(c.subject_first, '''') || coalesce(c.subject_last, '''')) <> ''''),');
  if v_new = v_def then raise exception 'booking_parents: code_count not found'; end if;
  execute v_new;
end $$;

-- Reopen No roster tasks closed as "The roster came in" whose job has no names after all.
update public.booking_followups f set done_at = null, done_by = null, done_note = null, updated_at = now()
  from public.bookings b, public.synced_jobs j
 where f.kind = 'roster' and f.done_at is not null and f.done_note = 'The roster came in'
   and b.id = f.booking_id and b.status = 'booked' and b.picture_day >= (now() at time zone 'America/New_York')::date
   and j.gotphoto_job_id = b.gotphoto_job_id and j.roster_loaded_at is null;
