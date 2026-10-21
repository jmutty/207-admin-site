-- "Your day" morning email (2026-10-22): each person with Assignments gets their own email in the morning
-- (7am Eastern by default) with today's schedule (on site jobs with when to leave, studio / admin / other
-- time, time off, hours and a lunch reminder at 6 hours) and today's tasks (urgent first, overdue flagged).
-- Nothing is sent on a day with nothing on it. Owners set the hour (or switch it off) on Assignments > Tasks;
-- each person can switch their own off on My day. Sent through Resend like the morning digest.

alter table public.staff_settings
  add column day_email_on boolean not null default true,
  add column day_email_hour smallint not null default 7 check (day_email_hour between 4 and 11);
comment on column public.staff_settings.day_email_on is 'The "Your day" morning email to each person (on/off for everyone).';
comment on column public.staff_settings.day_email_hour is 'Hour (Eastern) the "Your day" email goes out; it is always about the same day.';

alter table public.team_members add column day_email boolean not null default true;
comment on column public.team_members.day_email is 'false = this person switched their "Your day" morning email off.';

create table public.day_email_log (
  user_id    uuid not null references public.team_members (user_id) on delete cascade,
  day        date not null,
  sent_at    timestamptz not null default now(),
  request_id bigint,                     -- net.http_post request; null = nothing on that day, so nothing was sent
  primary key (user_id, day)
);
comment on table public.day_email_log is 'Who got their "Your day" morning email for which day (once per person per day).';
alter table public.day_email_log enable row level security;
revoke all on public.day_email_log from anon, authenticated;

-- {subject, text, html} for one person's day, or null when there is nothing on it.
create function public.day_email_content(p_uid uuid, p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'America/New_York';
  v_to timestamptz := (p_day + 1)::timestamp at time zone 'America/New_York';
  fmt constant text := 'FMHH12:MIam';
  v_sched text[] := '{}'; v_sched_h text[] := '{}'; v_tasks text[] := '{}'; v_tasks_h text[] := '{}';
  v_min numeric := 0; v_jobs int := 0; v_open int := 0; v_line text; v_sub text; v_name text; v_hours text;
  r record;
begin
  for r in select e.*, case when e.booking_id is not null then public.schedule_booking_title(e.booking_id) end as btitle, b.location as bloc
             from public.schedule_entries e left join public.bookings b on b.id = e.booking_id
            where e.user_id = p_uid and e.starts_at < v_to and e.ends_at > v_from and coalesce(b.status, '') <> 'cancelled'
            order by e.kind = 'off' desc, e.starts_at loop
    if r.kind = 'off' then
      v_line := 'Time off' || case when r.title <> '' then ': ' || r.title else '' end; v_sub := '';
    else
      v_line := to_char(greatest(r.starts_at, v_from) at time zone 'America/New_York', fmt) || '-' || to_char(least(r.ends_at, v_to) at time zone 'America/New_York', fmt) || ' ' ||
        case r.kind when 'job' then coalesce(nullif(r.title, ''), r.btitle, 'On site job')
                    else coalesce(nullif(r.title, ''), case r.kind when 'studio' then 'Studio' when 'admin' then 'Admin' else 'Work' end) end;
      v_sub := concat_ws(' · ',
        case r.kind when 'job' then 'On site job' when 'studio' then case when r.title <> '' then 'Studio' end when 'admin' then case when r.title <> '' then 'Admin' end end,
        nullif(r.bloc, ''),
        case when r.kind = 'job' and r.drive_before_min > 0 then 'leave the studio ' || to_char((r.starts_at - make_interval(mins => r.drive_before_min)) at time zone 'America/New_York', fmt) || ' (' || r.drive_before_min || ' min drive)' end,
        nullif(r.note, ''));
      v_min := v_min + extract(epoch from least(r.ends_at + case when r.kind = 'job' then make_interval(mins => r.drive_after_min) else interval '0' end, v_to)
                                         - greatest(r.starts_at - case when r.kind = 'job' then make_interval(mins => r.drive_before_min) else interval '0' end, v_from)) / 60;
      if r.kind = 'job' then v_jobs := v_jobs + 1; end if;
    end if;
    v_sched := v_sched || ('- ' || v_line || case when v_sub <> '' then E'\n  ' || v_sub else '' end);
    v_sched_h := v_sched_h || ('<li style="margin:6px 0"><b>' || public.html_esc(v_line) || '</b>' ||
                 case when v_sub <> '' then '<br><span style="color:#6b675f;font-size:13px">' || public.html_esc(v_sub) || '</span>' else '' end || '</li>');
  end loop;
  for r in select i.* from public.staff_task_items(p_day, array[p_uid]) i
            where i.done_at is null order by i.priority = 'urgent' desc, i.overdue desc, lower(i.title) loop
    v_open := v_open + 1;
    v_line := r.title || case when r.priority = 'urgent' then ' (urgent)' else '' end ||
              case when r.overdue then ' (overdue, from ' || to_char(r.on_date, 'FMDy FMMon FMDD') || ')' else '' end;
    v_tasks := v_tasks || ('- [ ] ' || v_line || case when r.notes <> '' then E'\n  ' || r.notes else '' end);
    v_tasks_h := v_tasks_h || ('<li style="margin:6px 0">' || public.html_esc(r.title) ||
      case when r.priority = 'urgent' then ' <span style="color:#c62828;font-weight:600">Urgent</span>' else '' end ||
      case when r.overdue then ' <span style="color:#8a6100">Overdue, from ' || to_char(r.on_date, 'FMDy FMMon FMDD') || '</span>' else '' end ||
      case when r.notes <> '' then '<br><span style="color:#6b675f;font-size:13px">' || public.html_esc(r.notes) || '</span>' else '' end || '</li>');
  end loop;
  if cardinality(v_sched) = 0 and v_open = 0 then return null; end if;

  v_name := split_part(public.staff_name(p_uid), ' ', 1);
  v_hours := case when v_min > 0 then trim(to_char(round(v_min / 15) / 4, 'FM990.99'), '.') || ' hours scheduled' ||
                   case when v_min >= 360 then '. Plan a lunch break.' else '.' end end;
  return jsonb_build_object(
    'subject', 'Your day, ' || to_char(p_day, 'FMDay FMMon FMDD') || ': ' ||
               coalesce(nullif(concat_ws(', ', case when v_jobs = 1 then '1 job' when v_jobs > 1 then v_jobs || ' jobs' end,
                                              case when v_open = 1 then '1 task' when v_open > 1 then v_open || ' tasks' end), ''), 'your schedule'),
    'text', 'Good morning ' || v_name || E'. Here is your day.\n\n' ||
            'SCHEDULE' || E'\n' || case when cardinality(v_sched) > 0 then array_to_string(v_sched, E'\n') else 'Nothing on the schedule.' end ||
            case when v_hours is not null then E'\n' || v_hours else '' end || E'\n\n' ||
            'TASKS' || E'\n' || case when v_open > 0 then array_to_string(v_tasks, E'\n') else 'No tasks today.' end || E'\n\n' ||
            'Check tasks off on My day: https://admin.207photo.com/#staff/myday',
    'html', '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f1e1b;max-width:560px">' ||
            '<p style="font-size:16px">Good morning ' || public.html_esc(v_name) || '. Here is your day.</p>' ||
            '<h3 style="margin:18px 0 6px;font-size:14px">Schedule</h3>' ||
            case when cardinality(v_sched_h) > 0 then '<ul style="margin:0;padding-left:20px">' || array_to_string(v_sched_h, '') || '</ul>' else '<p style="margin:0">Nothing on the schedule.</p>' end ||
            case when v_hours is not null then '<p style="margin:6px 0 0;font-size:13px;color:' || case when v_min >= 360 then '#8a6100' else '#6b675f' end || '">' || v_hours || '</p>' else '' end ||
            '<h3 style="margin:18px 0 6px;font-size:14px">Tasks</h3>' ||
            case when v_open > 0 then '<ul style="margin:0;padding-left:20px">' || array_to_string(v_tasks_h, '') || '</ul>' else '<p style="margin:0">No tasks today.</p>' end ||
            '<p style="margin-top:18px"><a href="https://admin.207photo.com/#staff/myday" style="color:#1f1e1b">Check tasks off on My day</a></p>' ||
            '<p style="margin-top:22px;font-size:13px;color:#6b675f">From <a href="https://admin.207photo.com/" style="color:#6b675f">207 Admin</a>. Switch this email off on My day.</p></div>');
end $$;

create function public.html_esc(p text) returns text language sql immutable set search_path = '' as $$
  select replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

-- Cron, every 15 minutes: from the set hour (Eastern) until 3 hours after it, email each person their day once.
create function public.day_email_send()
returns int language plpgsql security definer set search_path = '' as $$
declare
  s public.staff_settings;
  v_now timestamp := now() at time zone 'America/New_York';
  v_day date := (now() at time zone 'America/New_York')::date;
  v_key text; v jsonb; v_req bigint; v_sent int := 0; r record;
begin
  select * into s from public.staff_settings where id;
  if not found or not s.day_email_on or extract(hour from v_now) < s.day_email_hour or extract(hour from v_now) >= s.day_email_hour + 3 then return 0; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_key is null then return 0; end if;
  for r in select m.user_id, u.email from public.team_members m join auth.users u on u.id = m.user_id
            where m.active and m.day_email and coalesce(u.email, '') <> '' and public.team_user_can(m.user_id, 'assignments')
              and not exists (select 1 from public.day_email_log l where l.user_id = m.user_id and l.day = v_day) loop
    v := public.day_email_content(r.user_id, v_day);
    v_req := null;
    if v is not null then
      select net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object('from', '207 Admin <alerts@207photo.com>', 'to', jsonb_build_array(r.email),
                                   'subject', v ->> 'subject', 'text', v ->> 'text', 'html', v ->> 'html'),
        timeout_milliseconds := 25000) into v_req;
      v_sent := v_sent + 1;
    end if;
    insert into public.day_email_log (user_id, day, request_id) values (r.user_id, v_day, v_req) on conflict do nothing;
  end loop;
  return v_sent;
end $$;

select cron.schedule('day-email-send', '*/15 * * * *', 'select public.day_email_send()');
select cron.schedule('day-email-log-retention', '57 4 * * *', $$delete from public.day_email_log where day < current_date - 60$$);

-- The email settings: everyone's (on, hour) and my own switch. Anyone with Assignments.
create function public.day_email_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can('assignments', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select jsonb_build_object('on', s.day_email_on, 'hour', s.day_email_hour,
                                    'mine', coalesce((select m.day_email from public.team_members m where m.user_id = (select auth.uid())), true))
            from public.staff_settings s where s.id);
end $$;

-- Owners: switch the morning email on/off for everyone and set its hour.
create function public.day_email_settings_save(p_on boolean, p_hour int)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('assignments', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_hour is null or p_hour not between 4 and 11 then raise exception 'Pick an hour between 4am and 11am.'; end if;
  update public.staff_settings set day_email_on = coalesce(p_on, true), day_email_hour = p_hour, updated_at = now() where id;
  return jsonb_build_object('ok', true);
end $$;

-- Anyone: switch their own morning email on/off.
create function public.day_email_mine(p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('assignments', 'view') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.team_members set day_email = coalesce(p_on, true) where user_id = (select auth.uid());
  return jsonb_build_object('ok', true, 'on', coalesce(p_on, true));
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.day_email_content(uuid, date)', 'public.day_email_send()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.day_email_status()', 'public.day_email_settings_save(boolean, int)', 'public.day_email_mine(boolean)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
