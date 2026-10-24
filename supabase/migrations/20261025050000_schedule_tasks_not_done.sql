-- Schedule task counts (2026-10-24, Jeremiah): the "N tasks" under a person's day counted tasks already checked off
-- (a done checklist step kept as history showed as "1 task"). Count only tasks not done for that day.
-- Patched in place (like 20261025040000) so other changes to schedule_week stay.
create function pg_temp.patch_function(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;
select pg_temp.patch_function('public.schedule_week(date,integer)'::regprocedure,
  'and public\.staff_task_due\(t, g::date\)',
  'and public.staff_task_due(t, g::date) and not exists (select 1 from public.staff_task_done x where x.task_id = t.id and x.on_date = g::date)', 1);
