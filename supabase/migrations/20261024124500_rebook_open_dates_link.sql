-- Rebook email: point past clients at our open dates calendar (2026-10-23).
-- Changes the default template, and the saved one only while it is still the untouched default,
-- so a template someone already edited under Templates is left alone.

alter table public.partner_followup_settings alter column rebook_body set default
  E'{{hi|Hi there}},\n\nLast year we photographed {{league|your league}} on {{last_date}}, and it''s about time to get this year''s picture day on the calendar. Want me to hold the same time of year again?\n\nYou can see our open dates here: https://calendar.207photo.com/\n\nJust reply with a date or two that work and I''ll hold one for you.\n\nThanks again for having us!';

update public.partner_followup_settings
   set rebook_body = E'{{hi|Hi there}},\n\nLast year we photographed {{league|your league}} on {{last_date}}, and it''s about time to get this year''s picture day on the calendar. Want me to hold the same time of year again?\n\nYou can see our open dates here: https://calendar.207photo.com/\n\nJust reply with a date or two that work and I''ll hold one for you.\n\nThanks again for having us!'
 where rebook_body = E'{{hi|Hi there}},\n\nLast year we photographed {{league|your league}} on {{last_date}}, and it''s about time to get this year''s picture day on the calendar. Want me to hold the same time of year again? I can send over a few dates that work.\n\nThanks again for having us!';
