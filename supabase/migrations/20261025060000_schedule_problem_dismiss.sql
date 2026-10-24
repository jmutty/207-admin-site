-- Dismiss a Schedule problem (2026-10-24, Jeremiah: "I'd want to be able to dismiss a problem if it's a non-issue").
-- A problem is known by its day and its words ("Ryan U. drives 2h30 to Gould Academy"), so when the thing behind it
-- changes (a longer drive, a renamed calendar event) the words change and it shows again. Shared by everyone who
-- edits the Schedule. Bringing one back sets active = false rather than removing the row.
create table if not exists public.schedule_problem_dismissals (
  day date not null,
  text text not null,
  active boolean not null default true,
  dismissed_by uuid,
  dismissed_at timestamptz not null default now(),
  primary key (day, text)
);
alter table public.schedule_problem_dismissals enable row level security;
revoke all on public.schedule_problem_dismissals from anon, authenticated;

create or replace function public.schedule_problem_dismiss(p_day date, p_text text, p_on boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_day is null or coalesce(btrim(p_text), '') = '' then raise exception 'Nothing to dismiss.'; end if;
  insert into public.schedule_problem_dismissals as d (day, text, active, dismissed_by, dismissed_at)
  values (p_day, left(p_text, 500), p_on, (select auth.uid()), now())
  on conflict (day, text) do update set active = excluded.active, dismissed_by = excluded.dismissed_by, dismissed_at = excluded.dismissed_at;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.schedule_problem_dismiss(date, text, boolean) from public, anon;
grant execute on function public.schedule_problem_dismiss(date, text, boolean) to authenticated;

-- schedule_week carries the dismissed problems for its days (patched in place so other changes to it stay)
create function pg_temp.patch_function(p_sig regprocedure, p_from text, p_to text, p_expect int)
returns void language plpgsql as $$
declare v_def text := pg_get_functiondef(p_sig); v_n int;
begin
  select count(*) into v_n from regexp_matches(v_def, p_from, 'g');
  if v_n <> p_expect then raise exception 'patch %: expected % match(es) of %, found %', p_sig, p_expect, p_from, v_n; end if;
  execute regexp_replace(v_def, p_from, p_to, 'g');
end $$;
select pg_temp.patch_function('public.schedule_week(date,integer)'::regprocedure,
  '''tasks'', case when v_tasks_mine then',
  '''dismissed'', (select coalesce(jsonb_agg(jsonb_build_object(''day'', x.day, ''text'', x.text, ''by'', public.staff_name(x.dismissed_by), ''at'', x.dismissed_at)), ''[]''::jsonb)
                     from public.schedule_problem_dismissals x where x.active and x.day >= p_start and x.day < v_end),
    ''tasks'', case when v_tasks_mine then', 1);
