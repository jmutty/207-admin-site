# Supabase Edge Functions

Project `socluffmclkdljtmiexw`. Only the functions changed in this repo are kept here:

| Function | What it does | Auth |
|---|---|---|
| `admin` | `POST /sync`: "Sync now" in 207 Admin. Checks the caller with `can('galleries','edit')`, then triggers `gotphoto-sync` with the server-held sync secret. | caller's JWT |
| `push-sender` | Sends queued push notifications (`push_outbox`): VAPID + aes128gcm with WebCrypto, no dependencies (`webpush.ts`, cross-checked in `webpush.test.mjs`). Woken by the database (pg_net) and a 5-minute retry cron. | `x-push-secret` (Vault) |
| `drive-time` | Schedule page: drive minutes from the studio address to a booking (Google Maps Routes API), cached in `drive_time_cache`. Needs the secret `GOOGLE_MAPS_API_KEY`. | caller's JWT + `can('scheduling','edit')` |
| `team` | Team page account actions: create a login with a temporary password, reset a password, deactivate or reactivate (ban or unban), remove a deactivated person (deletes the login). Access rules stay in SQL (`team_save` / `team_set_active` / `team_remove` / `team_flag_password`, run with the caller's JWT). | caller's JWT + `is_admin()` |

All functions are deployed with `verify_jwt = false` and do their own checks.

```sh
supabase functions deploy admin --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy team  --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy push-sender --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase functions deploy drive-time --no-verify-jwt --project-ref socluffmclkdljtmiexw
supabase secrets set GOOGLE_MAPS_API_KEY=... --project-ref socluffmclkdljtmiexw   # Routes API key
```

`admin` calls `public.can()`, so deploy it **after** the 2026-10-21 migrations. Before that, Sync now
would be refused.

Not yet in the repo (unchanged, still only in Supabase): `gotphoto-sync`, `photo-release`,
`calendar-ingest`, `prospect-sender`, `prospect-track`, `calendar-write`, `booking-sender`.
Pull exact copies with `supabase functions download <slug> --project-ref socluffmclkdljtmiexw`
before editing one.
