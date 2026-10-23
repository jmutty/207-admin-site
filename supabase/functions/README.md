# Supabase Edge Functions

Project `socluffmclkdljtmiexw`. Only the functions changed in this repo are kept here:

| Function | What it does | Auth |
|---|---|---|
| `admin` | `POST /gpjob?booking=<id>`: "Create it in GotPhoto now", `can('bookings','edit')`, triggers `gotphoto-jobs` for that booking. `POST /sync`: "Sync now" in 207 Admin. Checks the caller with `can('galleries','edit')`, then triggers `gotphoto-sync` with the server-held sync secret. `POST /sales`: "Refresh sales" on Season results, `can('results','edit')`, triggers `gotphoto-sales`. | caller's JWT |
| `push-sender` | Sends queued push notifications (`push_outbox`): VAPID + aes128gcm with WebCrypto, no dependencies (`webpush.ts`, cross-checked in `webpush.test.mjs`). Woken by the database (pg_net) and a 5-minute retry cron. | `x-push-secret` (Vault) |
| `drive-time` | Schedule page: drive minutes from the studio address to a booking (Google Maps Routes API), cached in `drive_time_cache`; with `from_booking_id` it is job to job for batched jobs, cached in `drive_leg_cache`. Needs the secret `GOOGLE_MAPS_API_KEY`. | caller's JWT + `can('scheduling','edit')` |
| `place-search` | Google Maps suggestions for address boxes (`app/src/places.js`): booking Location, studio address, organization Town (Places API (New) Autocomplete + Place Details, biased to Maine). The pick is saved as "Name, address" in `bookings.location`, which `drive-time` uses. Same `GOOGLE_MAPS_API_KEY`, which needs **Places API (New)** enabled too. | caller's JWT + `can_any(bookings, scheduling, partners; edit)` |
| `calendar-write` | Keeps the "207Photo - Scheduling" Google Calendar in step with bookings (one event per booking day). Woken by booking RPCs and a retry cron. Needs the secret `GOOGLE_CALENDAR_SA_JSON`. Event body is built in `event.ts`. | `x-booking-secret` (Vault) |
| `offer-drive` | Open jobs: drive minutes from each part-timer's home address to a job (Google Maps Routes API `computeRouteMatrix`, 25 homes per call), cached in `offer_drive_cache`. Same `GOOGLE_MAPS_API_KEY`. With `mode: "crew"` (Schedule crew picker, Book a job) it does the same for everyone on the team (and the studio) to a booking or typed address, via `crew_drive_targets` / `crew_drive_store`. | caller's JWT + `can('openjobs','edit')`; crew mode `can('scheduling','edit')` |
| `gotphoto-sales` | Season results: reads each job's orders from the GotPhoto API (`/orders?job_id=`) and stores sales before tax and order counts in `job_results`. Hourly cron (`gotphoto-sales-hourly`) and "Refresh sales" (admin `/sales`). Which order field is the amount is in `results_settings`; `?probe=<job id>` shows the field names and numbers of a job's first orders without writing. Same `GP_*` secrets as gotphoto-sync. | `x-sync-secret` (Vault `sync_trigger_secret`) |
| `gotphoto-jobs` | Makes a booking's GotPhoto job through the Admin API (`POST /v4/jobs`): what Settings > Job types > GotPhoto defaults sets (`gp_type_defaults`: job type, archive rule, price profile per season, ...), the rest copied from the newest job of that GotPhoto job type, organization / address / access type from the organization's own last job. `?lists=1` (admin `/gplists`) returns the price and communication profiles for that page, name `Org \| Title \| year`, the next `JOB00000`. Links the booking once gotphoto-sync has the job. Cron `gotphoto-jobs` every 5 minutes (only when `gp_create_settings.auto_enabled`), and "Create it in GotPhoto now" on a job (admin `/gpjob?booking=`). `?dry=1` lists what it would make, with the request bodies, and makes nothing. Same `GP_*` secrets as gotphoto-sync. | `x-sync-secret` (Vault `sync_trigger_secret`) |
| `booking-ics` | "Add to your calendar" for a director: `GET ?t=<booking day_token>` returns the booking as a `.ics` (text/calendar), built by the anon SQL function `booking_ics(token)`. Linked from the Booked email (`{{calendar_link}}`) and the "Your picture day" page (`#day/<token>`). | none (token only) |
| `team` | Team page account actions: create a login with a temporary password (and email them a welcome with it and the phone app link, SQL `team_send_welcome`), reset a password, deactivate or reactivate (ban or unban), remove a deactivated person (deletes the login). Access rules stay in SQL (`team_save` / `team_set_active` / `team_remove` / `team_flag_password`, run with the caller's JWT). | caller's JWT + `is_admin()` |
| `go` | Tracked links in booking emails: `GET ?e=<booking_emails.id>&u=<base64url link>` logs the click (`booking_link_click`, anon) and redirects. Only our own pages (the hubs, `#day/` page, `booking-ics`); anything else gets a plain page, never a redirect. | none |
| `booking-weather` | Forecast check for outdoor / either picture days 1 to 3 days out: geocodes the location once (Places Text Search, `GOOGLE_MAPS_API_KEY`), reads the National Weather Service hourly grid, and calls `booking_weather_record` (20%+ rain or gusts over 25 mph during the shoot alerts whoever booked). Cron `booking-weather` twice a day. | `x-booking-secret` (Vault) |
| `prospect-sender` | Sends outreach email (`prospect_scheduled_emails`) through Gmail, every 15 minutes inside the send window (cron `prospect-sender-15min`). `?ids=A,B` is "Send now" (SQL `prospect_send_now`): just those emails, right away, any hour. Copied from deployed v12 on 2026-10-23. | `x-prospect-secret` (Vault `prospect_trigger_secret`) |

All functions are deployed with `verify_jwt = false` and do their own checks.

```sh
supabase functions deploy admin --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy team  --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy push-sender --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy drive-time --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy place-search --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy calendar-write --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy offer-drive --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy gotphoto-sales --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy gotphoto-jobs --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy booking-ics --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy go --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy booking-weather --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy prospect-sender --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase secrets set GOOGLE_MAPS_API_KEY=... --project-ref socluffmclkdljtmiexw   # Routes API + Places API (New)
```

`admin` calls `public.can()`, so deploy it **after** the 2026-10-21 migrations. Before that, Sync now
would be refused.

Not yet in the repo (unchanged, still only in Supabase): `gotphoto-sync`, `photo-release`,
`calendar-ingest`, `prospect-track`, `booking-sender`.
Pull exact copies with `supabase functions download <slug> --project-ref socluffmclkdljtmiexw`
before editing one.
