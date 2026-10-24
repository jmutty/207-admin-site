-- Editing time when nobody on a job is marked Lead (2026-10-24, Jeremiah's 11/3 Penquis job had none): the first
-- person put on that job that day counts as the Lead. Once someone there is marked Lead, they get it instead.
-- Any change to a job bar (or removing one) now re-checks every bar of that job, so the editing moves along.
-- Track-only jobs get editing time too (Jeremiah, Hancock Grammar 11/6 makeup day): only a cancelled job doesn't.

-- Is this job bar the Lead's for editing?
create function public.edit_is_lead(p_job uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  with j as (select * from public.schedule_entries where id = p_job and kind = 'job'),
       mates as (select e.* from public.schedule_entries e, j
                  where e.kind = 'job' and e.booking_id = j.booking_id
                    and (e.starts_at at time zone 'America/New_York')::date = (j.starts_at at time zone 'America/New_York')::date)
  select exists (select 1 from j join public.crew_roles r on r.id = j.role_id and lower(btrim(r.label)) = 'lead')
      or (exists (select 1 from j)
          and not exists (select 1 from mates m join public.crew_roles r on r.id = m.role_id and lower(btrim(r.label)) = 'lead')
          and p_job = (select m.id from mates m order by m.created_at, m.id limit 1))
$$;
revoke all on function public.edit_is_lead(uuid) from public, anon, authenticated;

create function pg_temp.patch_function(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;
select pg_temp.patch_function('public.edit_sync(uuid)'::regprocedure,
  'not exists \(select 1 from public\.crew_roles r where r\.id = j\.role_id and lower\(btrim\(r\.label\)\) = ''lead''\)',
  'not public.edit_is_lead(j.id)', 1);
select pg_temp.patch_function('public.edit_sync(uuid)'::regprocedure,
  'b\.status = ''booked''', 'b.status <> ''cancelled''', 1);

-- A job bar changed or went: re-check every bar of that job on that day (the Lead may have moved).
create or replace function public.edit_job_changed() returns trigger
language plpgsql security definer set search_path to '' as $$
declare r record;
begin
  begin
    if (tg_op <> 'DELETE' and new.kind = 'job') or (tg_op <> 'INSERT' and old.kind = 'job') then
      if tg_op <> 'UPDATE' or new.kind is distinct from old.kind or new.user_id is distinct from old.user_id
         or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
         or new.role_id is distinct from old.role_id or new.booking_id is distinct from old.booking_id
         or new.batch_id is distinct from old.batch_id or new.teardown_min is distinct from old.teardown_min
         or new.drive_after_min is distinct from old.drive_after_min then
        for r in select e.id from public.schedule_entries e
                  where e.kind = 'job'
                    and ((tg_op <> 'DELETE' and e.booking_id = new.booking_id
                          and (e.starts_at at time zone 'America/New_York')::date = (new.starts_at at time zone 'America/New_York')::date)
                      or (tg_op <> 'INSERT' and e.booking_id = old.booking_id
                          and (e.starts_at at time zone 'America/New_York')::date = (old.starts_at at time zone 'America/New_York')::date))
                  order by e.ends_at loop
          perform public.edit_sync(r.id);
        end loop;
        if tg_op = 'UPDATE' and new.kind <> 'job' then perform public.edit_sync(new.id); end if;
      end if;
    end if;
  exception when others then raise warning 'edit_job_changed: %', sqlerrm;  -- never block a schedule change
  end;
  return null;
end $$;
drop trigger schedule_entries_edit_sync on public.schedule_entries;
create trigger schedule_entries_edit_sync after insert or update or delete on public.schedule_entries
  for each row execute function public.edit_job_changed();

-- Upcoming jobs with nobody marked Lead, and track-only jobs, get their editing time now
do $$
declare r record;
begin
  for r in select e.id from public.schedule_entries e where e.kind = 'job' and e.ends_at > now() order by e.ends_at loop
    perform public.edit_sync(r.id);
  end loop;
end $$;
