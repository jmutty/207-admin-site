-- Director journey, the email series (2026-10-24, ws/director). Run AFTER 20261024060000_director_journey.sql,
-- in its own transaction (it uses the new trigger value 'booking').
--
-- booking_steps rows are production data. This file only:
--   A. ADDS one "Booked" step per sequence (trigger 'booking': right after booking, after the undo window),
--      switched OFF. Turn them on in Settings > Email library > Booking emails once booking-sender sends
--      trigger 'booking' steps and fills the new tokens (see booking_director_vars).
--   B. APPENDS token lines to existing steps, matched by stable keys, only where the token is not there yet:
--      day 0 set-up email (offset 0, admin, picture_day):  {{families_block}} {{flyer_line}}
--      two-week email (offset 14, admin, picture_day):      {{day_of_block}} {{weather_line}} {{team_times}} {{day_link}}
--      The lines go above the sign-off ("Warmly,", "Thanks,") when the body ends with one.
--   C. Moves hub send-day reminders (kind hub, before picture day or retake day) to 6:00 PM the evening before,
--      and says "Tomorrow" instead of "Today", by targeted replace. Gallery-live hub steps are unchanged.
-- Every statement is idempotent; nothing is deleted.

-- ---------------------------------------------------------------- A. the Booked step (off)
insert into public.booking_steps (sequence_id, step_no, label, offset_days, send_time, subject, body_md, is_active, kind, "trigger", hub_key, covered_by_gotphoto, school_days)
select q.id,
       (select coalesce(max(s.step_no), 0) + 1 from public.booking_steps s where s.sequence_id = q.id),
       'Booked (right away)', 0, '07:30', '{{org}} picture day is booked: {{picture_day}}',
       E'Hi {{first_name|there}},\n\nYou''re on our calendar. Here is what we have for {{org}}:\n\n'
         || E'- **When:** {{when_line}}\n- **Where:** {{where_line}}\n- **Questions:** reply to this email, or call or text {{day_of_phone}} (our number on picture day too)\n\n'
         || E'[Add it to your calendar]({{calendar_link}})\n\n'
         || case when t.audience = 'school'
                 then E'**One thing we need from you:** reply with the name and mobile number of your on-site contact for the day.\n\n'
                 when q.type_key = 'sports_data'
                 then E'**One thing we need from you:** reply with the name and mobile number of your on-site contact for the day, and send your roster (or tell us families will pre-register).\n\n'
                 else E'**One thing we need from you:** reply with the name and mobile number of your on-site contact for the day, and send your roster.\n\n' end
         || E'More details follow once your gallery is set up. Everything about your picture day is on one page, and it fills in as we go: {{day_link}}\n\nThanks for having us!',
       false, 'admin', 'booking', null, false, false
  from public.booking_sequences q
  left join public.booking_types t on t.key = q.type_key
 where not exists (select 1 from public.booking_steps s where s.sequence_id = q.id and s."trigger" = 'booking');

-- ---------------------------------------------------------------- B. blocks on the existing steps
-- Insert p_add above a closing line like "Warmly," / "Thanks," / "See you soon!", else at the end.
create or replace function pg_temp.director_add(p_body text, p_add text) returns text language sql immutable as $$
  select case when p_body ~ E'\n\n[^\n]{1,40}[,!][ \t]*$'
              then regexp_replace(p_body, E'(\n\n[^\n]{1,40}[,!][ \t]*)$', E'\n\n' || replace(p_add, '\', '\\') || E'\\1')
              else rtrim(p_body) || E'\n\n' || p_add end
$$;

update public.booking_steps
   set body_md = pg_temp.director_add(body_md, E'{{families_block}}\n\n{{flyer_line}}')
 where coalesce(kind, 'admin') = 'admin' and coalesce("trigger", 'picture_day') = 'picture_day' and offset_days = 0
   and strpos(body_md, '{{families_block') = 0;

update public.booking_steps
   set body_md = pg_temp.director_add(body_md, E'{{day_of_block}}\n\n{{weather_line}}\n\n{{team_times}}\n\nEverything about your picture day is on one page: {{day_link}}')
 where coalesce(kind, 'admin') = 'admin' and coalesce("trigger", 'picture_day') = 'picture_day' and offset_days = 14
   and strpos(body_md, '{{day_of_block') = 0;

-- ---------------------------------------------------------------- C. send-day reminders the evening before
update public.booking_steps
   set offset_days = offset_days + 1, send_time = '18:00'
 where kind = 'hub' and coalesce("trigger", 'picture_day') in ('picture_day', 'retake_day') and send_time < '12:00';

update public.booking_steps
   set subject = replace(subject, 'Today: send your', 'Tomorrow: send your'),
       body_md = replace(body_md, 'Today is a send day', 'Tomorrow is a send day')
 where kind = 'hub' and coalesce("trigger", 'picture_day') in ('picture_day', 'retake_day')
   and (strpos(subject, 'Today: send your') > 0 or strpos(body_md, 'Today is a send day') > 0);

-- "send any time this week" (the day-before messages: "send it tomorrow").
update public.booking_steps
   set body_md = regexp_replace(body_md, '(Tomorrow is a send day[^.\n]*\.)',
                   case when hub_key in ('day', 'm3', 'r2') then '\1 The message is ready now; send it tomorrow.'
                        else '\1 The message is ready now, so any time this week works.' end)
 where kind = 'hub' and coalesce("trigger", 'picture_day') in ('picture_day', 'retake_day')
   and body_md ~ 'Tomorrow is a send day[^.\n]*\.'
   and strpos(body_md, 'The message is ready now') = 0;
