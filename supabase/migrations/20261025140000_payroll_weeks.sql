-- Schedule lines up with payroll (2026-10-24, Jeremiah). Paychex pays every two weeks for Monday to Sunday periods
-- (09/28-10/11, 10/12-10/25, ...), payday the Friday after. So:
--   1. Weeks run Monday to Sunday everywhere: timesheets, approvals, overtime, the Schedule and the weekly email.
--   2. Pay periods (two weeks from a Monday, payday 5 days after the period ends) live in Time clock settings;
--      the payroll export and "timesheets to approve" go by pay period.
--   3. The schedule is released weekly: every Friday at 3pm each person gets their Monday to Sunday week (the
--      View schedule card email). The first release of a week has no "Changed" marks; changes after that do.
--   4. Thursday at 9am the people who edit the Schedule get a push and an email to finish next week's schedule,
--      with the jobs nobody is on yet.

-- ================================================================ 1. Monday weeks
create or replace function public.tc_week_of(p_day date) returns date
language sql immutable set search_path = '' as $$ select p_day - (extract(isodow from p_day)::int - 1) $$;

alter table public.timesheet_weeks drop constraint if exists timesheet_weeks_week_start_check;
alter table public.timesheet_weeks add constraint timesheet_weeks_week_start_check check (extract(isodow from week_start) = 1) not valid;

-- ================================================================ 2. pay periods
alter table public.timeclock_settings
  add column if not exists pay_weeks smallint not null default 2 check (pay_weeks in (1, 2)),
  add column if not exists pay_anchor date not null default '2026-09-28' check (extract(isodow from pay_anchor) = 1),
  add column if not exists payday_days smallint not null default 5 check (payday_days between 0 and 14);

-- The first day (a Monday) of the pay period that holds a day.
create or replace function public.tc_period_of(p_day date) returns date
language sql stable security definer set search_path = '' as $$
  select s.pay_anchor + (floor((p_day - s.pay_anchor)::numeric / (7 * s.pay_weeks)) * 7 * s.pay_weeks)::int
    from public.timeclock_settings s where s.id
$$;

-- The current pay period and the ones before it, newest first: start, end (a Sunday), payday.
create or replace function public.timeclock_pay_periods(p_back integer default 12)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.timeclock_settings; v_cur date; v_len int;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into s from public.timeclock_settings where id;
  v_cur := public.tc_period_of((now() at time zone 'America/New_York')::date);
  v_len := 7 * s.pay_weeks;
  return jsonb_build_object('weeks', s.pay_weeks, 'anchor', s.pay_anchor, 'payday_days', s.payday_days,
    'periods', (select jsonb_agg(jsonb_build_object('start', p, 'end', p + v_len - 1, 'payday', p + v_len - 1 + s.payday_days,
                                                    'current', i = 0) order by i)
                  from generate_series(0, greatest(1, least(coalesce(p_back, 12), 52))) i
                  cross join lateral (select v_cur - i * v_len as p) x));
end $$;
revoke all on function public.tc_period_of(date) from public, anon, authenticated;
revoke all on function public.timeclock_pay_periods(integer) from public, anon;
grant execute on function public.timeclock_pay_periods(integer) to authenticated;

create or replace function public.timeclock_settings_save(p_rate numeric, p_overtime numeric, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.timeclock_settings;
begin
  if not public.can('timeclock', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_rate is null or p_rate < 0 or p_rate > 5 then raise exception 'The mileage rate is $0 to $5 a mile.'; end if;
  if p_overtime is null or p_overtime < 0 or p_overtime > 80 then raise exception 'Overtime starts after 0 to 80 hours a week.'; end if;
  select * into s from public.timeclock_settings where id;
  p := coalesce(p, '{}'::jsonb);
  if coalesce((p ->> 'remind_before_min')::int, s.remind_before_min) not between 0 and 120 then raise exception 'The clock-in reminder is 0 to 120 minutes before.'; end if;
  if coalesce((p ->> 'remind_out_after_min')::int, s.remind_out_after_min) not between 0 and 240 then raise exception 'The clock-out reminder is 0 to 240 minutes after.'; end if;
  if coalesce((p ->> 'ot_warn_hours')::numeric, s.ot_warn_hours) not between 0 and 40 then raise exception 'Warn 0 to 40 hours before overtime.'; end if;
  if coalesce((p ->> 'half_day_hours')::numeric, s.half_day_hours) not between 1 and 12 then raise exception 'A half day is under 1 to 12 hours.'; end if;
  if coalesce((p ->> 'pay_weeks')::int, s.pay_weeks) not in (1, 2) then raise exception 'A pay period is 1 or 2 weeks.'; end if;
  if extract(isodow from coalesce((p ->> 'pay_anchor')::date, s.pay_anchor)) <> 1 then raise exception 'Pick a Monday that a pay period started on.'; end if;
  if coalesce((p ->> 'payday_days')::int, s.payday_days) not between 0 and 14 then raise exception 'Payday is 0 to 14 days after the period ends.'; end if;
  update public.timeclock_settings
     set mileage_rate = round(p_rate, 3), overtime_after = round(p_overtime, 1),
         gps_on = coalesce((p ->> 'gps_on')::boolean, gps_on),
         remind_before_min = coalesce((p ->> 'remind_before_min')::int, remind_before_min),
         remind_out_after_min = coalesce((p ->> 'remind_out_after_min')::int, remind_out_after_min),
         auto_out = coalesce((p ->> 'auto_out')::boolean, auto_out),
         ot_warn_hours = round(coalesce((p ->> 'ot_warn_hours')::numeric, ot_warn_hours), 1),
         half_day_hours = round(coalesce((p ->> 'half_day_hours')::numeric, half_day_hours), 1),
         pay_weeks = coalesce((p ->> 'pay_weeks')::int, pay_weeks),
         pay_anchor = coalesce((p ->> 'pay_anchor')::date, pay_anchor),
         payday_days = coalesce((p ->> 'payday_days')::int, payday_days),
         updated_at = now()
   where id;
  return jsonb_build_object('ok', true);
end $$;

-- Today: timesheets waiting for approval are the ones from the last finished pay period.
create or replace function public.timeclock_attention()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_edit boolean := public.can('timeclock', 'edit');
  v_today date := (now() at time zone 'America/New_York')::date;
  v_len int := 7 * (select s.pay_weeks from public.timeclock_settings s where s.id);
  v_last date := public.tc_period_of(v_today) - v_len;
begin
  if not public.can('timeclock', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'open_long', (select count(*) from public.time_punches t where t.clock_out is null and t.clock_in < now() - interval '12 hours'
                   and (v_edit or t.user_id = (select auth.uid()))),
    'to_approve', case when v_edit then (select count(distinct t.user_id) from public.time_punches t
                    where public.tc_day_of(t.clock_in) >= v_last and public.tc_day_of(t.clock_in) < v_last + v_len
                      and not exists (select 1 from public.timesheet_weeks w where w.user_id = t.user_id
                                         and w.week_start = public.tc_week_of(public.tc_day_of(t.clock_in)))) else 0 end,
    'last_week', v_last, 'last_period_end', v_last + v_len - 1,
    'review', (select count(*) from public.time_punches t where t.needs_review and (v_edit or t.user_id = (select auth.uid()))),
    'expenses', case when v_edit then (select count(*) from public.timeclock_expenses e where e.status = 'submitted') else 0 end,
    'near_ot', case when v_edit then (select count(distinct o.user_id) from public.timeclock_ot_warnings o where o.week_start = public.tc_week_of(v_today)) else 0 end);
end $$;

-- ================================================================ 3. the weekly release
-- One person's schedule from p_start to p_end as the screen agenda and the card email. p_week: it is the weekly
-- release of a Monday to Sunday week (its own heading and subject; "Changed" marks only once that week went out).
create or replace function public.schedule_view_range(p_uid uuid, p_start date, p_end date, p_week boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  fmt constant text := 'FMHH12:MIam';
  v_start date := p_start;
  v_end date := p_end;
  v_agenda jsonb := '[]'; v_items jsonb; v_txt text[] := '{}'; v_htm text[] := '{}'; v_lines text[]; v_cards text[];
  v_min numeric := 0; v_jobs int := 0; v_pending int := 0; v_changed int := 0; v_name text;
  v_confirm boolean := public.crew_confirm_on();  -- confirm marks and buttons only while crew confirmations are on
  -- a week that has not gone out yet has nothing to compare with: no "Changed" marks
  v_marks boolean := not p_week or exists (select 1 from public.week_email_log l where l.user_id = p_uid and l.week_start = p_start);
  v_head text; v_subj text; v_intro text;
  d date; r record; v_title text; v_time text; v_sub text; v_leave text; v_btn text; v_chg boolean; v_gone text; v_color text;
begin
  for d in select generate_series(v_start, v_end, interval '1 day')::date loop
    v_items := '[]'; v_lines := '{}'; v_cards := '{}';
    for r in select e.*, case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) end as btitle,
                    case when e.booking_id is not null then public.schedule_destination(e.booking_id, (e.starts_at at time zone 'America/New_York')::date) end as bloc,
                    ro.label as role, case when v_confirm then a.status end as ask, a.token
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
    v_chg := false; v_gone := null;
    -- View schedule (two weeks): this week counts as out; next week only once its release went to this person
    if v_marks and (p_week or public.tc_week_of(d) <= public.tc_week_of((now() at time zone 'America/New_York')::date)
                    or exists (select 1 from public.week_email_log l where l.user_id = p_uid and l.week_start = public.tc_week_of(d))) then
      select count(*) > 0, string_agg(distinct case when c.what = 'removed' then c.title end, ', ')
        into v_chg, v_gone
        from public.schedule_changes c where c.user_id = p_uid and c.sent_at is null and c.day = d;
      v_gone := nullif(v_gone, '');
    end if;
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
  if p_week then
    v_head := 'Your week of ' || to_char(v_start, 'FMMM/FMDD');
    v_subj := case when v_changed > 0 then 'Your schedule changed for the week of ' else 'Your schedule for the week of ' end || to_char(v_start, 'FMMM/FMDD');
    v_intro := 'Here is your schedule for the week of ' || to_char(v_start, 'FMMM/FMDD') || ' (Monday to Sunday)';
  else
    v_head := 'This week and next';
    v_subj := case when v_changed > 0 then 'Your schedule changed: this week and next' else 'Your schedule for this week and next' end;
    v_intro := 'Here is your schedule for this week and next, ' || to_char(v_start, 'FMMM/FMDD') || ' to ' || to_char(v_end, 'FMMM/FMDD');
  end if;
  return jsonb_build_object(
    'start', v_start, 'end', v_end, 'agenda', v_agenda,
    'days', jsonb_array_length(v_agenda), 'jobs', v_jobs, 'pending', v_pending, 'changed', v_changed,
    'hours', round(v_min / 15) / 4,
    'subject', v_subj ||
               coalesce(': ' || nullif(concat_ws(', ', case when v_jobs = 1 then '1 job' when v_jobs > 1 then v_jobs || ' jobs' end,
                                                      case when v_pending > 0 then v_pending || ' to confirm' end), ''), ''),
    'text', 'Hi ' || v_name || '. ' || v_intro ||
            case when v_changed > 0 then '. Days marked (changed) are different from before' else '' end || E'.\n\n' ||
            case when cardinality(v_txt) = 0 then 'Nothing is scheduled for you.' else array_to_string(v_txt, E'\n\n') end ||
            E'\n\n' || trim(to_char(round(v_min / 15) / 4, 'FM990.99'), '.') || E' hours scheduled.\n\nYour whole schedule: https://admin.207photo.com/#staff/schedule',
    'html', '<div style="background:#efede8;padding:24px 12px"><div style="font-family:Arial,Helvetica,sans-serif;color:#1f1e1b;max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px 24px 18px">' ||
            '<div style="font-size:12px;font-weight:bold;letter-spacing:.08em;color:#c2412d">207 PHOTO</div>' ||
            '<div style="font-size:21px;font-weight:bold;margin:4px 0 2px">' || public.html_esc(v_head) || '</div>' ||
            '<div style="font-size:14px;color:#6b675f">' || to_char(v_start, 'FMDy FMMM/FMDD') || ' to ' || to_char(v_end, 'FMDy FMMM/FMDD') || ' &middot; ' ||
              coalesce(nullif(concat_ws(' &middot; ', case when v_jobs = 1 then '1 job' when v_jobs > 1 then v_jobs || ' jobs' end,
                trim(to_char(round(v_min / 15) / 4, 'FM990.99'), '.') || ' hours'), ''), '') || '</div>' ||
            '<p style="font-size:15px;line-height:1.5;margin:16px 0 4px">Hi ' || public.html_esc(v_name) || '.' ||
              case when v_changed > 0 then ' Your schedule changed. Days marked <b>Changed</b> are different from before.'
                   when p_week then ' Here is your schedule for next week.' else ' Here is what you have coming up.' end || '</p>' ||
            case when cardinality(v_htm) = 0 then '<p style="font-size:15px;color:#6b675f">Nothing is scheduled for you.</p>'
                 else '<table role="presentation" style="width:100%;border-collapse:collapse">' || array_to_string(v_htm, '') || '</table>' end ||
            '<p style="margin:18px 0 0;font-size:13px;color:#6b675f"><a href="https://admin.207photo.com/#staff/schedule" style="color:#6b675f">Your whole schedule</a> in 207 Admin. Only your own schedule is in this email.</p></div></div>');
end $$;

-- View schedule: from today to the end of next week (Monday to Sunday weeks).
create or replace function public.schedule_view_content(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.schedule_view_range(p_uid, (now() at time zone 'America/New_York')::date,
                                    public.tc_week_of((now() at time zone 'America/New_York')::date) + 13, false)
$$;

-- The weekly email (Email the week, and the Friday release) is the View schedule card email for one Monday to
-- Sunday week. Nothing on that week: no email.
create or replace function public.week_email_content(p_uid uuid, p_start date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := public.schedule_view_range(p_uid, p_start, p_start + 6, true);
begin
  if (v ->> 'days')::int = 0 then return null; end if;
  return v;
end $$;

insert into public.push_topics (key, label, description, module, sort) values
  ('week_schedule',     'Your week''s schedule', 'Friday: your schedule for next week is out.', 'scheduling', 74),
  ('schedule_finalize', 'Finish next week''s schedule', 'Thursday: next week''s schedule goes out tomorrow. Shown to people who change the Schedule.', 'scheduling', 71)
on conflict (key) do nothing;

-- Sending a week: the email, an app notification, and that week's saved-up changes count as told.
create or replace function public.week_email_deliver(p_start date, p_users uuid[], p_force boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_req bigint; v_sent int := 0; v_empty int := 0; v_noaddr int := 0; r record;
begin
  for r in select m.user_id, u.email from public.team_members m join auth.users u on u.id = m.user_id
            where m.active and (p_users is null or m.user_id = any (p_users))
              and (p_force or not exists (select 1 from public.week_email_log l where l.user_id = m.user_id and l.week_start = p_start)) loop
    v := public.week_email_content(r.user_id, p_start);
    if v is null then v_empty := v_empty + 1; continue; end if;
    v_req := public.crew_send_email(r.email, v ->> 'subject', v ->> 'text', v ->> 'html');
    if v_req is null then v_noaddr := v_noaddr + 1; end if;
    insert into public.week_email_log (user_id, week_start, request_id) values (r.user_id, p_start, v_req)
    on conflict (user_id, week_start) do update set sent_at = now(), request_id = excluded.request_id;
    update public.schedule_changes set sent_at = now() where user_id = r.user_id and sent_at is null and day between p_start and p_start + 6;
    begin
      perform public.push_notify('week_schedule', 'Your schedule for the week of ' || to_char(p_start, 'FMMM/FMDD'),
        coalesce(nullif(concat_ws(', ', case when (v ->> 'jobs')::int = 1 then '1 job' when (v ->> 'jobs')::int > 1 then (v ->> 'jobs') || ' jobs' end,
                                       trim(to_char((v ->> 'hours')::numeric, 'FM990.99'), '.') || ' hours'), ''), 'Your week') || '. Tap to see it.',
        '/#staff/schedule', 'week_schedule_' || p_start, r.user_id);
    exception when others then raise warning 'week_schedule push: %', sqlerrm;
    end;
    v_sent := v_sent + 1;
  end loop;
  return jsonb_build_object('ok', true, 'sent', v_sent, 'nothing_on', v_empty, 'no_email', v_noaddr);
end $$;

-- The release (cron, every hour): on the release day and hour, the coming Monday's week.
create or replace function public.week_email_auto()
returns integer language plpgsql security definer set search_path = '' as $$
declare s public.staff_settings; v_now timestamp := now() at time zone 'America/New_York'; v_start date;
begin
  select * into s from public.staff_settings where id;
  if not found or not s.week_email_auto or extract(dow from v_now) <> s.week_email_dow or extract(hour from v_now) <> s.week_email_hour then return 0; end if;
  v_start := v_now::date + (8 - extract(isodow from v_now)::int);   -- the coming Monday
  return (public.week_email_deliver(v_start, null, false) ->> 'sent')::int;
end $$;

create or replace function public.week_email_send(p_start date, p_users uuid[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_start is null or extract(isodow from p_start) <> 1 then raise exception 'Pick a week (it starts on a Monday).'; end if;
  return public.week_email_deliver(p_start, p_users, true);
end $$;

-- ================================================================ 4. Thursday: finish next week's schedule
alter table public.staff_settings add column if not exists finalize_sent_week date;

-- Next week's jobs that still need people (booked jobs only), for the reminder.
create or replace function public.schedule_finalize_open(p_start date)
returns table (day date, title text, have int, need int)
language sql stable security definer set search_path = '' as $$
  select x.day, split_part(public.schedule_booking_title(x.booking_id), ' • ', 1), x.have, x.need
    from (select d.day, d.booking_id,
                 (select count(distinct e.user_id) from public.schedule_entries e
                   where e.booking_id = d.booking_id and e.kind = 'job'
                     and (e.starts_at at time zone 'America/New_York')::date <= d.day
                     and (e.ends_at at time zone 'America/New_York')::date >= d.day)::int as have,
                 coalesce((select c.needed from public.booking_crew c where c.booking_id = d.booking_id), 1) as need,
                 coalesce(d.start_at, b.start_at) as st
            from public.booking_days d join public.bookings b on b.id = d.booking_id
           where not d.removed and b.status = 'booked' and d.day between p_start and p_start + 6) x
   where x.have < x.need
   order by x.day, x.st nulls last
$$;

-- Cron, every hour: the day before the release, at 9am, once per week.
create or replace function public.schedule_finalize_remind()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  s public.staff_settings; v_now timestamp := now() at time zone 'America/New_York';
  v_start date; v_n int := 0; v_open text[]; v_cnt int; v_jobs int; v_rel text; r record; v_body text; v_html text;
begin
  select * into s from public.staff_settings where id;
  if not found or not s.week_email_auto then return 0; end if;
  if extract(dow from v_now) <> (s.week_email_dow + 6) % 7 or extract(hour from v_now) <> 9 then return 0; end if;
  v_start := v_now::date + 1 + (8 - extract(isodow from v_now::date + 1)::int);   -- the Monday after the release day
  if s.finalize_sent_week is not distinct from v_start then return 0; end if;
  update public.staff_settings set finalize_sent_week = v_start where id;
  select array_agg(to_char(o.day, 'FMDy FMMM/FMDD') || ': ' || o.title || ' (' || case when o.have = 0 then 'nobody on it' else o.have || ' of ' || o.need end || ')'), count(*)
    into v_open, v_cnt from public.schedule_finalize_open(v_start) o;
  select count(*) into v_jobs from public.booking_days d join public.bookings b on b.id = d.booking_id
   where not d.removed and b.status = 'booked' and d.day between v_start and v_start + 6;
  v_rel := to_char(v_now::date + 1, 'FMDay') || ' at ' || to_char(make_time(s.week_email_hour, 0, 0), 'FMHH12am');
  v_body := 'Week of ' || to_char(v_start, 'FMMM/FMDD') || ': ' ||
            case when v_jobs = 0 then 'no jobs booked' else v_jobs || case when v_jobs = 1 then ' job' else ' jobs' end ||
                 case when v_cnt > 0 then ', ' || v_cnt || ' still need people' else ', all have people' end end || '. It goes out ' || v_rel || '.';
  v_html := '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1e1b;max-width:560px">' ||
            '<p>Next week''s schedule (' || to_char(v_start, 'FMDy FMMM/FMDD') || ' to ' || to_char(v_start + 6, 'FMDy FMMM/FMDD') || ') goes out to everyone ' || public.html_esc(v_rel) || '. ' ||
            'Finish it before then: last changes are easiest now.</p>' ||
            case when v_cnt > 0 then '<p><b>Still need people:</b></p><ul>' || (select string_agg('<li>' || public.html_esc(x) || '</li>', '') from unnest(v_open) x) || '</ul>'
                 else '<p>Every job that week has people on it.</p>' end ||
            '<p><a href="https://admin.207photo.com/#staff/schedule" style="color:#c2412d">Open the Schedule</a></p></div>';
  for r in select m.user_id, u.email from public.team_members m join auth.users u on u.id = m.user_id
            where m.active and (exists (select 1 from public.admin_users a where a.user_id = m.user_id)
                                or exists (select 1 from public.team_permissions p where p.user_id = m.user_id and p.module_key = 'scheduling' and p.level = 'edit')) loop
    begin
      perform public.push_notify('schedule_finalize', 'Finish next week''s schedule', v_body, '/#staff/schedule', 'schedule_finalize_' || v_start, r.user_id);
    exception when others then raise warning 'schedule_finalize push: %', sqlerrm;
    end;
    perform public.crew_send_email(r.email, 'Finish next week''s schedule (goes out ' || v_rel || ')',
      'Next week''s schedule (' || to_char(v_start, 'FMMM/FMDD') || ' to ' || to_char(v_start + 6, 'FMMM/FMDD') || ') goes out to everyone ' || v_rel || E'.\n\n' ||
      case when v_cnt > 0 then E'Still need people:\n' || array_to_string(v_open, E'\n') else 'Every job that week has people on it.' end ||
      E'\n\nThe Schedule: https://admin.207photo.com/#staff/schedule', v_html);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function public.schedule_view_range(uuid, date, date, boolean), public.schedule_finalize_open(date), public.schedule_finalize_remind() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'schedule-finalize-remind';
select cron.schedule('schedule-finalize-remind', '4 * * * *', $$select public.schedule_finalize_remind()$$);

-- Turn the Friday release on (Friday 3pm, the existing setting; Schedule > Crew settings changes it).
update public.staff_settings set week_email_auto = true, week_email_dow = 5, week_email_hour = 15 where id;
