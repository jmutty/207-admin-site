-- View schedule (2026-10-24, Jeremiah): "Send changes" becomes a View schedule screen. Pick a person, see their next
-- two weeks (today + 13 days) as an agenda, and send it to them from there as one email. Days with changes nobody has
-- been told about yet are marked "Changed" (and anything taken off them is listed); sending marks that person's
-- saved-up changes as told. schedule_view_content returns the agenda (for the screen) and the email (subject, text, html).

create or replace function public.schedule_view_content(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  fmt constant text := 'FMHH12:MIam';
  v_start date := (now() at time zone 'America/New_York')::date;
  v_end date := v_start + 13;
  v_agenda jsonb := '[]'; v_items jsonb; v_txt text[] := '{}'; v_htm text[] := '{}'; v_lines text[]; v_cards text[];
  v_min numeric := 0; v_jobs int := 0; v_pending int := 0; v_changed int := 0; v_name text;
  d date; r record; v_title text; v_time text; v_sub text; v_leave text; v_btn text; v_chg boolean; v_gone text; v_color text;
begin
  for d in select generate_series(v_start, v_end, interval '1 day')::date loop
    v_items := '[]'; v_lines := '{}'; v_cards := '{}';
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
      v_btn := ''; v_leave := null;
      if r.kind = 'off' then
        v_time := 'All day';
        v_title := 'Time off' || case when r.title <> '' then ': ' || r.title else '' end ||
                   case when (r.ends_at - r.starts_at) > interval '1 day' then ' through ' || to_char(least((r.ends_at - interval '1 minute') at time zone 'America/New_York', v_end::timestamp), 'FMDy FMMM/FMDD') else '' end;
      else
        v_time := to_char(r.starts_at at time zone 'America/New_York', fmt) || ' - ' || to_char(r.ends_at at time zone 'America/New_York', fmt);
        v_title := case when r.kind = 'job' then coalesce(r.btitle, 'On site job') else coalesce(nullif(r.title, ''), case r.kind when 'studio' then 'Studio' when 'admin' then 'Admin' when 'flex' then 'Flex time' else 'Work' end) end;
        if r.kind = 'job' and r.drive_before_min > 0 then
          v_leave := initcap(public.schedule_leave_from(r.id)) || ' ' || to_char((r.starts_at - make_interval(mins => r.drive_before_min + r.setup_min)) at time zone 'America/New_York', fmt);
        end if;
        v_min := v_min + extract(epoch from (r.ends_at - r.starts_at)) / 60 + case when r.kind = 'job' then r.drive_before_min + r.drive_after_min else 0 end;
        if r.kind = 'job' then
          v_jobs := v_jobs + 1;
          if r.ask = 'pending' then
            v_pending := v_pending + 1;
            v_btn := '<div style="margin-top:8px">' || public.crew_button('https://admin.207photo.com/#crew/' || r.token || '/yes', 'Confirm', '#2e7d4f') ||
                     public.crew_button('https://admin.207photo.com/#crew/' || r.token || '/no', 'Can''t make it', '#8a8580') || '</div>';
          end if;
        end if;
      end if;
      v_sub := concat_ws(' · ', case when r.kind = 'job' then nullif(r.bloc, '') end, v_leave, r.role, nullif(r.note, ''),
                 case r.ask when 'confirmed' then 'Confirmed' when 'pending' then 'Please confirm' end);
      v_items := v_items || jsonb_build_array(jsonb_build_object('kind', r.kind, 'time', v_time, 'title', v_title, 'place', case when r.kind = 'job' then nullif(r.bloc, '') end,
                   'leave', v_leave, 'role', r.role, 'note', nullif(r.note, ''), 'ask', r.ask));
      v_lines := v_lines || (v_time || '  ' || v_title || case when v_sub <> '' then E'\n    ' || v_sub else '' end ||
                             case when v_btn <> '' then E'\n    Confirm: https://admin.207photo.com/#crew/' || r.token else '' end);
      v_color := case r.kind when 'job' then '#2f6db5' when 'studio' then '#7b5cc4' when 'admin' then '#3f8f5a' when 'flex' then '#1f8a84' when 'off' then '#a39d93' else '#6b7a8f' end;
      v_cards := v_cards || ('<div style="border-left:4px solid ' || v_color || ';background:#f7f6f3;border-radius:4px;padding:8px 12px;margin:0 0 6px">' ||
                   '<div style="font-size:12.5px;color:#6b675f">' || public.html_esc(v_time) || '</div>' ||
                   '<div style="font-size:15px;font-weight:bold;color:#1f1e1b">' || public.html_esc(v_title) || '</div>' ||
                   case when v_sub <> '' then '<div style="font-size:13px;color:#6b675f;margin-top:2px">' || public.html_esc(v_sub) || '</div>' else '' end || v_btn || '</div>');
    end loop;
    select count(*) > 0, string_agg(distinct case when c.what = 'removed' then c.title end, ', ')
      into v_chg, v_gone
      from public.schedule_changes c where c.user_id = p_uid and c.sent_at is null and c.day = d;
    v_gone := nullif(v_gone, '');
    if jsonb_array_length(v_items) = 0 and not v_chg then continue; end if;
    if v_chg then v_changed := v_changed + 1; end if;
    v_agenda := v_agenda || jsonb_build_array(jsonb_build_object('day', d, 'changed', v_chg, 'gone', v_gone, 'items', v_items));
    v_txt := v_txt || (to_char(d, 'FMDy FMMM/FMDD') || case when v_chg then ' (changed)' else '' end || E'\n  ' ||
                       case when cardinality(v_lines) = 0 then 'Nothing scheduled now' else array_to_string(v_lines, E'\n  ') end ||
                       case when v_gone is not null then E'\n  Taken off: ' || v_gone else '' end);
    v_htm := v_htm || ('<tr><td style="padding:14px 0 6px">' ||
                       '<div style="font-size:12px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:#6b675f;margin:0 0 6px">' || to_char(d, 'FMDay FMMM/FMDD') ||
                       case when v_chg then ' <span style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:10px;background:#fdecc8;color:#7a5200;font-size:11px;letter-spacing:0">Changed</span>' else '' end || '</div>' ||
                       case when cardinality(v_cards) = 0 then '<div style="font-size:14px;color:#6b675f;padding:4px 0">Nothing scheduled now</div>' else array_to_string(v_cards, '') end ||
                       case when v_gone is not null then '<div style="font-size:13px;color:#a33">Taken off: ' || public.html_esc(v_gone) || '</div>' else '' end || '</td></tr>');
  end loop;
  v_name := split_part(public.staff_name(p_uid), ' ', 1);
  return jsonb_build_object(
    'start', v_start, 'end', v_end, 'agenda', v_agenda,
    'days', jsonb_array_length(v_agenda), 'jobs', v_jobs, 'pending', v_pending, 'changed', v_changed,
    'hours', round(v_min / 15) / 4,
    'subject', case when v_changed > 0 then 'Your schedule changed: the next two weeks' else 'Your schedule for the next two weeks' end ||
               coalesce(': ' || nullif(concat_ws(', ', case when v_jobs = 1 then '1 job' when v_jobs > 1 then v_jobs || ' jobs' end,
                                                      case when v_pending > 0 then v_pending || ' to confirm' end), ''), ''),
    'text', 'Hi ' || v_name || '. Here is your schedule for the next two weeks, ' || to_char(v_start, 'FMMM/FMDD') || ' to ' || to_char(v_end, 'FMMM/FMDD') ||
            case when v_changed > 0 then '. Days marked (changed) are different from before' else '' end || E'.\n\n' ||
            case when cardinality(v_txt) = 0 then 'Nothing is scheduled for you.' else array_to_string(v_txt, E'\n\n') end ||
            E'\n\n' || trim(to_char(round(v_min / 15) / 4, 'FM990.99'), '.') || E' hours scheduled.\n\nYour whole schedule: https://admin.207photo.com/#staff/schedule',
    'html', '<div style="background:#efede8;padding:24px 12px"><div style="font-family:Arial,Helvetica,sans-serif;color:#1f1e1b;max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px 24px 18px">' ||
            '<div style="font-size:12px;font-weight:bold;letter-spacing:.08em;color:#c2412d">207 PHOTO</div>' ||
            '<div style="font-size:21px;font-weight:bold;margin:4px 0 2px">Your next two weeks</div>' ||
            '<div style="font-size:14px;color:#6b675f">' || to_char(v_start, 'FMDy FMMM/FMDD') || ' to ' || to_char(v_end, 'FMDy FMMM/FMDD') || ' &middot; ' ||
              coalesce(nullif(concat_ws(' &middot; ', case when v_jobs = 1 then '1 job' when v_jobs > 1 then v_jobs || ' jobs' end,
                trim(to_char(round(v_min / 15) / 4, 'FM990.99'), '.') || ' hours'), ''), '') || '</div>' ||
            '<p style="font-size:15px;line-height:1.5;margin:16px 0 4px">Hi ' || public.html_esc(v_name) || '.' ||
              case when v_changed > 0 then ' Your schedule changed. Days marked <b>Changed</b> are different from before.' else ' Here is what you have coming up.' end || '</p>' ||
            case when cardinality(v_htm) = 0 then '<p style="font-size:15px;color:#6b675f">Nothing is scheduled for you.</p>'
                 else '<table role="presentation" style="width:100%;border-collapse:collapse">' || array_to_string(v_htm, '') || '</table>' end ||
            '<p style="margin:18px 0 0;font-size:13px;color:#6b675f"><a href="https://admin.207photo.com/#staff/schedule" style="color:#6b675f">Your whole schedule</a> in 207 Admin. Only your own schedule is in this email.</p></div></div>');
end $$;

-- The screen: the agenda and email for one person, and where it would go.
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
