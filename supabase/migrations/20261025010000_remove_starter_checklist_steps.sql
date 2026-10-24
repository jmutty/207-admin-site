-- Jeremiah 2026-10-24: drop all five starter checklist steps (seeded in 20261022180000_job_workflows). They never looked at
-- the booking, so people were asked to confirm start times and crew that were already set. He'll add his own steps.
-- Open tasks from those steps come off people's lists; tasks already checked off stay as history (same as Remove in Settings).

create temp table starter_steps on commit drop as
  select id from public.workflow_steps
   where type_key is null and archived_at is null
     and title in ('Confirm start time and crew with the contact', 'Pack the kit and charge batteries', 'Upload and back up the photos',
                   'Launch the job on GotPhoto', 'Send the partner a thank-you');

update public.staff_tasks k set active = false, updated_at = now()
 where k.workflow_step_id in (select id from starter_steps) and k.active
   and not exists (select 1 from public.staff_task_done d where d.task_id = k.id);

update public.workflow_steps set waits_for = null where waits_for in (select id from starter_steps);
update public.workflow_steps set archived_at = now() where id in (select id from starter_steps);
