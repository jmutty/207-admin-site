-- View schedule (2026-10-24, Jeremiah): "Send changes" becomes a View schedule screen. Pick a person, see exactly the
-- email they would get with their next two weeks (today + 13 days), and send it from there. Days with changes
-- nobody has been told about yet are marked "Changed" (and anything taken off them is listed), and sending marks
-- that person's saved-up changes as sent. Same look as the weekly schedule email (week_email_content).

create or replace function public.schedule_view_content(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  fmt constant text := 'FMHH12:MIam';
  v_start date := (now() at time zone 'America/New_York')::date;
  v_end date := v_start + 13;
  v_from timestamptz := v_start::timestamp at time zone 'America/New_York';
  v_to timestamptz := (v_end + 1)::timestamp at time zone 'America/New_York';
  v_txt text[] := '{}'; v_htm text[] := '{}'; v_lines text[]; v_hl text[];
  v_min numeric := 0; v_jobs int := 0; v_pending int := 0; v_changed int := 0; v_name text;
  d date; r record; v_line text; v_sub text; v_btn text; v_chg boolean; v_gone text;
begin
  for d in select generate_series(v_start, v_end, interval '1 day')::date loop
    v_lines := '{}'; v_hl := '{}';
    for r in select e.*, case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) end as btitle,
                    case when e.booking_id is not null then public.schedule_destination(e.booking_id) end as bloc,
                    ro.label as role, a.status as ask, a.token
               from public.schedule_entries e
               left join public.bookings b on b.id = e.booking_id
               left join public.crew_roles ro on ro.id = e.role_id
               left join public.crew_asks a on a.booking_id = e.booking_id and a.user_id = e.user_id
              where e.user_id = p_uid and coalesce(b.status, 'booked') = 'booked'
                and e.starts_at < (d + 1)::timestamp at time zone 'America/New_York'
                and e.ends_at > d::timestamp at time zone 'America/New_York'
                -- a bar that runs over several days shows on its first day in the range only
                and greatest((e.starts_at at time zone 'America/New_York')::date, v_start) = d
              order by e.starts_at loop
      v_btn := '';
      if r.kind = 'off' then
        v_line := 'Time off' || case when r.title <> '' then ': ' || r.title else '' end ||
                  case when (r.ends_at - r.starts_at) > interval '1 day' then ' through ' || to_char(least((r.ends_at - interval '1 minute') at time zone 'America/New_York', v_end::timestamp), 'FMDy FMMM/FMDD') else '' end;
        v_sub := '';
      else
        v_line := to_char(r.starts_at at time zone 'America/New_York', fmt) || '-' || to_char(r.ends_at at time zone 'America/New_York', fmt) || ' ' ||
                  case when r.kind = 'job' then coalesce(r.btitle, 'On site job') else coalesce(nullif(r.title, ''), case r.kind when 'studio' then 'Studio' when 'admin' then 'Admin' when 'flex' then 'Flex time' else 'Work' end) end ||
                  case when r.role is not null then ' (' || r.role || ')' else '' end;
        v_sub := concat_ws(' · ', case when r.kind = 'job' then nullif(r.bloc, '') end,
                   case when r.kind = 'job' and r.drive_before_min > 0 then public.schedule_leave_from(r.id) || ' ' || to_char((r.starts_at - make_interval(mins => r.drive_before_min + r.setup_min)) at time zone 'America/New_York', fmt) end,
                   nullif(r.note, ''),
                   case r.ask when 'confirmed' then 'confirmed' when 'pending' then 'please confirm' end);
        v_min := v_min + extract(epoch from (r.ends_at - r.starts_at)) / 60 + case when r.kind = 'job' then r.drive_before_min + r.drive_after_min else 0 end;
        if r.kind = 'job' then
          v_jobs := v_jobs + 1;
          if r.ask = 'pending' then
            v_pending := v_pending + 1;
            v_btn := '<br>' || public.crew_button('https://admin.207photo.com/#crew/' || r.token || '/yes', 'Confirm', '#2e7d4f') ||
                     public.crew_button('https://admin.207photo.com/#crew/' || r.token || '/no', 'Can''t make it', '#8a8580');
          end if;
        end if;
      end if;
      v_lines := v_lines || (v_line || case when v_sub <> '' then E'\n    ' || v_sub else '' end ||
                             case when v_btn <> '' then E'\n    Confirm: https://admin.207photo.com/#crew/' || r.token else '' end);
      v_hl := v_hl || ('<b>' || public.html_esc(v_line) || '</b>' ||
                       case when v_sub <> '' then '<br><span style="color:#6b675f;font-size:13px">' || public.html_esc(v_sub) || '</span>' else '' end || v_btn);
    end loop;
    select count(*) > 0, string_agg(distinct case when c.what = 'removed' then c.title end, ', ')
      into v_chg, v_gone
      from public.schedule_changes c where c.user_id = p_uid and c.sent_at is null and c.day = d;
    v_gone := nullif(v_gone, '');
    if cardinality(v_lines) = 0 and not v_chg then continue; end if;
    if v_chg then v_changed := v_changed + 1; end if;
    if cardinality(v_lines) = 0 then v_lines := array['Nothing scheduled now']; v_hl := array['Nothing scheduled now']; end if;
    v_txt := v_txt || (to_char(d, 'FMDy FMMM/FMDD') || case when v_chg then ' (changed)' else '' end || E':\n  ' || array_to_string(v_lines, E'\n  ') ||
                       case when v_gone is not null then E'\n  Taken off: ' || v_gone else '' end);
    v_htm := v_htm || ('<tr><td style="padding:8px 12px 8px 0;vertical-align:top;white-space:nowrap;color:#6b675f">' || to_char(d, 'FMDy FMMM/FMDD') ||
                       case when v_chg then '<br><span style="display:inline-block;margin-top:2px;padding:0 6px;border-radius:8px;background:#fdecc8;color:#7a5200;font-size:12px;font-weight:bold">Changed</span>' else '' end || '</td>' ||
                       '<td style="padding:8px 0;vertical-align:top">' || array_to_string(v_hl, '<br>') ||
                       case when v_gone is not null then '<br><span style="color:#a33;font-size:13px">Taken off: ' || public.html_esc(v_gone) || '</span>' else '' end || '</td></tr>');
  end loop;
  v_name := split_part(public.staff_name(p_uid), ' ', 1);
  return jsonb_build_object(
    'days', cardinality(v_txt), 'jobs', v_jobs, 'pending', v_pending, 'changed', v_changed,
    'subject', case when v_changed > 0 then 'Your schedule changed: the next two weeks' else 'Your schedule for the next two weeks' end ||
               coalesce(': ' || nullif(concat_ws(', ', case when v_jobs = 1 then '1 job' when v_jobs > 1 then v_jobs || ' jobs' end,
                                                      case when v_pending > 0 then v_pending || ' to confirm' end), ''), ''),
    'text', 'Hi ' || v_name || '. Here is your schedule for the next two weeks, ' || to_char(v_start, 'FMMM/FMDD') || ' to ' || to_char(v_end, 'FMMM/FMDD') ||
            case when v_changed > 0 then '. Days marked (changed) are different from before' else '' end || E'.\n\n' ||
            case when cardinality(v_txt) = 0 then 'Nothing is scheduled for you.' else array_to_string(v_txt, E'\n\n') end ||
            E'\n\n' || trim(to_char(round(v_min / 15) / 4, 'FM990.99'), '.') || E' hours scheduled.\n\nYour whole schedule: https://admin.207photo.com/#staff/schedule',
    'html', '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1e1b;max-width:600px">' ||
            '<p style="font-size:16px">Hi ' || public.html_esc(v_name) || '. Here is your schedule for the next two weeks, ' || to_char(v_start, 'FMMM/FMDD') || ' to ' || to_char(v_end, 'FMMM/FMDD') ||
            case when v_changed > 0 then '. Days marked <b>Changed</b> are different from before' else '' end || '.</p>' ||
            case when cardinality(v_htm) = 0 then '<p>Nothing is scheduled for you.</p>' else '<table style="border-collapse:collapse;font-size:14.5px">' || array_to_string(v_htm, '') || '</table>' end ||
            '<p style="margin:12px 0 0;font-size:13px;color:#6b675f">' || trim(to_char(round(v_min / 15) / 4, 'FM990.99'), '.') || ' hours scheduled.</p>' ||
            '<p style="margin-top:22px;font-size:13px;color:#6b675f"><a href="https://admin.207photo.com/#staff/schedule" style="color:#6b675f">Your whole schedule</a> in 207 Admin. Only your own schedule is in this email.</p></div>');
end $$;

-- The screen: the email for one person, and whether they have an address and changes waiting.
create or replace function public.schedule_view_preview(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_email text;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.team_members m where m.user_id = p_user and m.active) then raise exception 'Not on the team.'; end if;
  v := public.schedule_view_content(p_user);
  select u.email into v_email from auth.users u where u.id = p_user;
  return v || jsonb_build_object('email', v_email, 'has_email', coalesce(v_email, '') <> '');
end $$;

-- Send it to them; their saved-up changes count as told.
create or replace function public.schedule_view_send(p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_email text; v_req bigint;
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  select u.email into v_email from public.team_members m join auth.users u on u.id = m.user_id where m.user_id = p_user and m.active;
  if coalesce(v_email, '') = '' then raise exception 'They have no email address.'; end if;
  v := public.schedule_view_content(p_user);
  v_req := public.crew_send_email(v_email, v ->> 'subject', v ->> 'text', v ->> 'html');
  if v_req is null then raise exception 'Email sending is not set up.'; end if;
  update public.schedule_changes set sent_at = now() where user_id = p_user and sent_at is null;
  return jsonb_build_object('ok', true, 'email', v_email);
end $$;

revoke all on function public.schedule_view_content(uuid) from public, anon, authenticated;
revoke all on function public.schedule_view_preview(uuid) from public, anon;
revoke all on function public.schedule_view_send(uuid) from public, anon;
grant execute on function public.schedule_view_preview(uuid) to authenticated;
grant execute on function public.schedule_view_send(uuid) to authenticated;
