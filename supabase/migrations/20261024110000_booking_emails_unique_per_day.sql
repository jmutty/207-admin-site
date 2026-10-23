-- One booking_emails row per step per picture day (2026-10-23).
--
-- booking_reschedule sends the hub "day before" reminder once per night of a multi-day booking (day_index 0, 1, 2...),
-- but the unique index still allowed only one row per step, so a second night failed with a duplicate key. The index
-- now includes day_index. Every existing row has day_index 0 per step, so it builds without conflicts.

drop index if exists public.booking_emails_unique;
create unique index booking_emails_unique on public.booking_emails (booking_id, step_no, day_index) where not is_resend;
