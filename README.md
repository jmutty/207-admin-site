# 207 Admin

207 Photo's internal admin at https://admin.207photo.com.

```
site/                              what Cloudflare serves: loader page, logo, sw.js (notifications), manifest. No secrets.
app/                               the app: src/ -> build.py -> dist/207-admin.js (hosted on Supabase Storage)
supabase/migrations/               database changes made in this repo (earlier history lives in Supabase)
supabase/functions/                edge functions changed in this repo (admin, team)
docs/ADDING-A-MODULE.md            how to add a new area (scheduling, time clock, inventory, ...)
```

## How it fits together

- **Hosting.** Cloudflare Pages project `207-admin` (direct upload, not connected to GitHub) serves `index.html`. To change it, zip the files inside `site/` and upload them (Create deployment -> Production).
  `index.html` loads supabase-js and then `loader.js`, which
  pulls the current app bundle from Supabase Storage (`admin-app/207-admin.js`). Deploying the app
  never needs a change here.
- **Security.** The browser holds only the public anon key. All data access goes through Postgres
  row-level security and `SECURITY DEFINER` RPCs, under the signed-in person's own Supabase Auth
  login. Sign-in has two steps: a password, then a 6-digit code emailed to them, or a device
  remembered for 90 days. The database refuses admin data until the second step is done
  (`admin_session_ok()`).
- **People and access.** Full access is a row in `admin_users`. Everyone else is a row in
  `team_members`, with per-module `None / View / Edit` in `team_permissions`. Every policy and RPC
  asks `public.can('<module>', 'view' | 'edit')`. The app asks `my_access()` and shows only the pages
  you can use. Manage people on the **Team** page. A new person gets a welcome email (Resend) with their temporary
  password and https://admin.207photo.com/#welcome, which shows how to put the app on their phone (`app/src/welcome.js`).
- **Notifications.** Push notifications to phones and computers. `push_topics` lists the kinds of
  notification, one per module, and each goes only to people who can see that module. Triggers call
  `push_notify()`, and the `push-sender` edge function delivers. Each person turns them on under
  account menu -> Notifications. On iPhone this needs the home-screen app.
- **Modules.** `public.app_modules` lists the areas. In the app, `RAIL` in `app/src/shell-top.js` (plus
  `registerPage()` calls in module files) is the single list that builds the menu, router, Cmd-K and
  access checks. See [docs/ADDING-A-MODULE.md](docs/ADDING-A-MODULE.md).

## Working on the app

```sh
cd app
python3 build.py                     # writes dist/207-admin.js (syntax-checked)
open test/harness.html               # offline click-through with fake data (serve app/ first)
NODE_PATH=/opt/node-tools/node_modules node test/smoke.js   # automated checks, owner + staff
./deploy.sh                          # build + upload to Supabase Storage (needs SUPABASE_ACCESS_TOKEN)
```

`deploy.sh` keeps the previous live bundle under `admin-app/prev/` for rollback.

The app source moved here from Dropbox
(`Software DMG's for Installation/Apps - Source Code/Access Code Lookup Admin/Access Code Admin Project Files/admin-page/`)
on 2026-10-21. Its first commit is byte-identical to what was deployed then. Edit it here from now on.
