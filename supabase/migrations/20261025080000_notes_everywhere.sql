-- Notes everywhere (2026-10-24, Jeremiah: "I need notes to be found easily in all areas where I might be looking at
-- a client or a job"). One read for the newest notes on many jobs and partners at once, so the partner Overview,
-- the job Overview, the Jobs and Partners lists, the Schedule boxes and My day can all show them.
--
-- notes_peek(p_bookings, p_orgs) returns
--   { "jobs": { "<booking id>": { "count": n, "org_id": "...", "latest": [ {author_name, body, created_at}, ... ] } },
--     "orgs": { "<org id>":     { "count": n, "latest": [ {author_name, body, created_at}, ... ] } } }
-- newest first, two of each. Job notes come only for jobs the person may open (job_can_view). Partner notes
-- (prospect_activities kind 'note') come only for people who can see Partners, the same rule as the table itself.
-- A job's partner is looked up too, so a job screen can show its partner's notes without a second call.
-- No table changes.

create or replace function public.notes_peek(p_bookings uuid[] default '{}', p_orgs uuid[] default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_jobs jsonb;
  v_orgs jsonb := '{}'::jsonb;
  v_org_ids uuid[];
begin
  if (select auth.uid()) is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(array_length(p_bookings, 1), 0) > 500 or coalesce(array_length(p_orgs, 1), 0) > 1000 then
    raise exception 'too many at once' using errcode = '22023';
  end if;

  with b as (
    select bk.id, bk.org_id from public.bookings bk
     where bk.id = any(coalesce(p_bookings, '{}')) and public.job_can_view(bk.id)
  )
  select coalesce(jsonb_object_agg(b.id, jsonb_build_object(
           'org_id', b.org_id,
           'count', (select count(*) from public.job_notes n where n.booking_id = b.id and n.deleted_at is null),
           'latest', (select coalesce(jsonb_agg(jsonb_build_object('author_name', x.author_name, 'body', x.body, 'created_at', x.created_at) order by x.created_at desc), '[]'::jsonb)
                        from (select n.author_name, n.body, n.created_at from public.job_notes n
                               where n.booking_id = b.id and n.deleted_at is null order by n.created_at desc limit 2) x))), '{}'::jsonb),
         array_agg(distinct b.org_id) filter (where b.org_id is not null)
    into v_jobs, v_org_ids
    from b;

  if public.can('partners', 'view') then
    with o as (select distinct u as id from unnest(coalesce(p_orgs, '{}') || coalesce(v_org_ids, '{}')) u where u is not null)
    select coalesce(jsonb_object_agg(o.id, jsonb_build_object(
             'count', (select count(*) from public.prospect_activities a where a.org_id = o.id and a.kind = 'note'),
             'latest', (select coalesce(jsonb_agg(jsonb_build_object('author_name', x.author_name, 'body', x.body, 'created_at', x.occurred_at) order by x.occurred_at desc), '[]'::jsonb)
                          from (select coalesce(public.staff_name(a.created_by), '') as author_name, concat_ws(E'\n', nullif(a.subject, ''), a.body) as body, a.occurred_at
                                  from public.prospect_activities a
                                 where a.org_id = o.id and a.kind = 'note' order by a.occurred_at desc limit 2) x)))
           filter (where exists (select 1 from public.prospect_activities a where a.org_id = o.id and a.kind = 'note')), '{}'::jsonb)
      into v_orgs
      from o;
  end if;

  return jsonb_build_object('jobs', v_jobs, 'orgs', v_orgs);
end $$;
revoke all on function public.notes_peek(uuid[], uuid[]) from public, anon;
grant execute on function public.notes_peek(uuid[], uuid[]) to authenticated;

-- The newest-first lookups above.
create index if not exists prospect_activities_org_note_idx on public.prospect_activities (org_id, occurred_at desc) where kind = 'note';
