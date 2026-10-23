-- GotPhoto job name: a booking's custom title (Edit booking, e.g. "Mount View High School • Winter Sports 2") wins
-- over the title label, the same as the job page and calendar show it. The typed part goes between the
-- organization and the year; "Org • typed" and "typed • Org" both read back to "typed".
create or replace function public.gp_job_name(p_booking uuid) returns text
language sql stable security definer set search_path = public as $$
  select concat_ws(' | ', o.name,
           coalesce(nullif(btrim(case when b.title_override like o.name || ' • %' then substr(b.title_override, length(o.name) + 4)
                                      when b.title_override like '% • ' || o.name then left(b.title_override, length(b.title_override) - length(o.name) - 3)
                                      else b.title_override end), ''),
                    nullif(btrim(b.title_label), ''), t.label),
           case when t.audience = 'school' then
             case when extract(month from b.picture_day) >= 7 then extract(year from b.picture_day)::int || '-' || (extract(year from b.picture_day)::int + 1)
                  else (extract(year from b.picture_day)::int - 1) || '-' || extract(year from b.picture_day)::int end
           else extract(year from b.picture_day)::int::text end)
    from bookings b join prospect_orgs o on o.id = b.org_id join booking_types t on t.key = b.type_key
   where b.id = p_booking;
$$;
revoke all on function public.gp_job_name(uuid) from public, anon, authenticated;
