-- Job names read partner first everywhere: "Midcoast Rec • Fall Sports", not "Fall Sports • Midcoast Rec".
-- The calendar, Schedule, crew emails and GotPhoto names already put the partner first (schedule_booking_title);
-- the Jobs list, job page, job note pushes and the GotPhoto photos check still built "Label • Partner".
-- public.job_title is now the one formatter, and every title-building function calls it.

create or replace function public.job_title(p_override text, p_org text, p_label text)
returns text language sql immutable set search_path to '' as $$
  select coalesce(nullif(btrim(p_override), ''), nullif(concat_ws(' • ', nullif(btrim(p_org), ''), nullif(btrim(p_label), '')), ''), 'Booking')
$$;
grant execute on function public.job_title(text, text, text) to authenticated;

create or replace function public.schedule_booking_title(p_id uuid)
returns text language sql stable security definer set search_path to '' as $$
  select coalesce(public.job_title(b.title_override, o.name, coalesce(nullif(b.title_label, ''), t.label)), 'Booking')
    from public.bookings b
    left join public.prospect_orgs o on o.id = b.org_id
    left join public.booking_types t on t.key = b.type_key
   where b.id = p_id
$$;

-- The other four keep their bodies as they are live; only the title expression changes. A function someone has since
-- rewritten stops this migration instead of being silently skipped.
do $$
declare
  f text; def text; fixed text;
  old_expr constant text := 'coalesce(b.title_override, b.title_label || '' '' || chr(8226) || '' '' || o.name)';
  new_expr constant text := 'public.job_title(b.title_override, o.name, coalesce(nullif(b.title_label, ''''), t.label))';
begin
  foreach f in array array['public.admin_bookings(date,date)', 'public.gp_photos_missing()', 'public.job_get(uuid)', 'public.job_note_add(uuid,text,uuid[])'] loop
    def := pg_get_functiondef(f::regprocedure);
    continue when position('public.job_title(' in def) > 0;   -- already done (migration run twice)
    if position(old_expr in def) = 0 then raise exception '% no longer builds the old title; update this migration', f; end if;
    fixed := replace(def, old_expr, new_expr);
    -- gp_photos_missing and job_note_add have no booking_types join; they fall back to the job type's label through a subquery.
    if f in ('public.gp_photos_missing()', 'public.job_note_add(uuid,text,uuid[])') then
      fixed := replace(fixed, 'coalesce(nullif(b.title_label, ''''), t.label)',
                       'coalesce(nullif(b.title_label, ''''), (select t.label from public.booking_types t where t.key = b.type_key))');
    end if;
    execute fixed;
  end loop;
end $$;
