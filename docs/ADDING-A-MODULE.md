# Adding a module to 207 Admin

A "module" is one area of the site that people can be given access to: Bookings, Galleries, Scheduling,
Inventory, Job checklists (`workflows`) and the planned Time clock. Every module follows the same
pattern, so access control comes for free.

There are four pieces, and each one is small:

| Piece | Where | What |
|---|---|---|
| Registry row | migration: `public.app_modules` | Makes the module grantable on the Team page |
| Tables and RPCs | the same migration | Every policy and RPC checks `public.can('<key>', 'view' / 'edit')` |
| Page | `app/src/<module>.js` + `app/src/<module>.html` | Calls `registerPage({...})`, and the menu, router, Cmd-K and access all follow |
| Build | `app/build.py` | Add both files to `JS_PARTS` / `HTML_PARTS` |

The four planned modules already have rows (`status = 'planned'`), so you can give people access
**before** a module ships. They will see it the day it goes live.

## 1. Database (one migration)

`supabase/migrations/<yyyymmddhhmmss>_<module>.sql`:

```sql
-- Employee scheduling: shifts and who works them.
update public.app_modules set status = 'live' where key = 'scheduling';   -- or insert a new row

create table public.shifts (
  id         uuid primary key default gen_random_uuid(),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  booking_id uuid references public.bookings (id) on delete set null,
  user_id    uuid references public.team_members (user_id) on delete set null,
  note       text not null default '',
  created_at timestamptz not null default now()
);
alter table public.shifts enable row level security;
revoke all on public.shifts from anon;
grant select, insert, update, delete on public.shifts to authenticated;

-- The standard pair: read needs view, everything else needs edit. Always wrap in (select ...)
-- so Postgres evaluates the check once per query, not once per row.
create policy shifts_read  on public.shifts for select to authenticated using ((select public.can('scheduling', 'view')));
create policy shifts_write on public.shifts for all    to authenticated using ((select public.can('scheduling', 'edit')))
                                                                      with check ((select public.can('scheduling', 'edit')));

-- RPCs: SECURITY DEFINER functions bypass RLS, so they must check access themselves, first thing.
create function public.shift_assign(p_shift uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can('scheduling', 'edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.shifts set user_id = p_user where id = p_shift;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.shift_assign(uuid, uuid) from public, anon;
grant execute on function public.shift_assign(uuid, uuid) to authenticated;
```

Rules of thumb:

- **Never** check `is_admin()` in new code unless the action is truly owners-only. Use `can()`.
- For data shared by several modules, use `can_any(array['bookings','scheduling'], 'view')`.
- For "my own rows" in the time clock, use `user_id = (select auth.uid()) and (select public.can('timeclock','view'))`
  for clocking in and out, and `can('timeclock','edit')` for managers who edit anyone's timesheet.
  That way **View = use it for yourself**, and **Edit = manage everyone**.
- After applying a migration, run the Supabase security advisor (it flags missing RLS and grants).

### Notifications (optional)

Add a kind of notification in the same migration, then queue it wherever the event happens:

```sql
insert into public.push_topics (key, label, description, module, sort)
values ('shift_uncovered', 'Shift needs someone', 'A shift this week has nobody on it.', 'scheduling', 70);

-- in a trigger or RPC (wrap triggers in begin ... exception when others ... end so a notification can never block the change):
perform public.push_notify('shift_uncovered', 'A shift needs someone', 'Saturday 9am at Hampden', '/#staff/schedule', 'shift_uncovered');
```

It reaches everyone who can see `scheduling` (and full-access people) who has turned notifications
on and not switched this kind off. The last argument (tag) merges repeats within 10 minutes. Add a
check to `supabase/tests/push_test.sql`.

## 2. Page (frontend)

`app/src/scheduling.html`: one panel per tab. Ids must be `aca-panel-<tab>`.

```html
      <section class="panel" id="aca-panel-schedule" role="tabpanel">
        <div class="card"><div class="card-head"><div><h2>Schedule</h2><p>Who works which picture day.</p></div></div>
          <div id="aca-schedBody"></div></div>
      </section>
```

`app/src/scheduling.js`: all app code shares one scope, so keep this module's state inside an IIFE.

```js
  // ================================================================ SCHEDULING
  registerPage({ id: "schedule", label: "Scheduling", group: "Staff", section: "staff", module: "scheduling",
                 tabs: [["schedule", "Schedule"]], onShow: () => Scheduling.load() });
  // Optional: a line on Today.
  registerAttention("shiftsUncovered", { module: "scheduling", level: "warn", name: "shift coverage",
    one: "A shift this week has nobody on it.", many: "{n} shifts this week have nobody on it." });

  const Scheduling = (function () {
    async function load() {
      const { data, error } = await supabase.from("shifts").select("*").order("starts_at");
      if (error) { el("schedBody").innerHTML = '<p class="inline-error">' + esc(error.message) + "</p>"; return; }
      el("schedBody").innerHTML = (data || []).map((s) => "<div>" + esc(fmtDate(s.starts_at)) + "</div>").join("");
      // Hide edit controls for view-only people (the database refuses their writes anyway).
      // if (!canEdit("scheduling")) ...
    }
    return { load };
  })();
```

Then add the files to `app/build.py` (`JS_PARTS` before `src/shell-end.js`, and `HTML_PARTS`).

`registerPage` fields:

| Field | Meaning |
|---|---|
| `id` | the menu item id (and the rail badge `aca-nav-<id>`) |
| `label` / `title` | menu text; `title` also heads a multi-tab page |
| `group` | menu heading (`Jobs`, `Parents`, `Outreach`, `Staff`, `Operations`, `System`) |
| `section` | URL prefix: the page lives at `#<section>/<tab>` |
| `module` | the `app_modules.key` that controls access (`null` = everyone signed in) |
| `tabs` | `[[tab, label], ...]`, where the first is the default; more than one shows a tab strip |
| `onShow(tab)` | called every time one of its tabs is opened |
| `search` | extra Cmd-K entries `[[label, id], ...]` |
| `selfService` | `true` when View means "use it for yourself" (Assignments): no view-only notice |

A Today line: `registerAttention(...)` plus `registerTodayLoader("<module>", () => Thing.loadAttention())`, which runs
with the other Today checks for people who can see the module (see `app/src/scheduling.js`).

A page for people outside 207 Photo (no sign-in, opened from an emailed link with a token): call
`registerPublicPage({ wanted: () => /^#mypage\//.test(location.hash), show() {...} })` and back it with
`SECURITY DEFINER` RPCs granted to `anon` that look the token up (see `app/src/pictureday-public.js`).

A tab on the job page (`#jobs/job/<booking id>`, `app/src/jobpage.js`): call `registerJobTab({ id, label, order, module, show(job), render(booking, el, job) })`
from your own file. It's a hoisted function, so file order doesn't matter. `job` is the `job_get()` result. Built-in tabs use
orders 10 (Overview), 20 (Picture day), 30 (Checklist), 60 (Results), 80 (Notes) and 90 (History). Link to a job with `jobLink(id, tab)`.
`HistoryView.open(kind, id, title)` shows the change history (`history_get`: `job`, `org`, `punches`).

Helpers available everywhere: `supabase`, `el(id)`, `esc()`, `fmtDate()`, `fmtAgo()`, `toast()`,
`showError()`/`clearError()`, `canSee(m)`, `canEdit(m)`, `openModal(html, {locked})`, `setAttention()`.

## 3. Test

```sh
cd app
python3 build.py
NODE_PATH=/opt/node-tools/node_modules node test/smoke.js   # or any Node with Playwright installed
```

- Add your module's RPCs and tables to `test/mock-supabase.js`, then open `test/harness.html` to click
  through it offline. `?as=staff` signs in as a limited user (edit `my_access` in the mock to change
  what they get).
- Database: apply the migration to a branch or local copy first and test as a staff user
  (see `supabase/README.md`).

## 4. Ship

1. Apply the migration (Supabase dashboard SQL editor, `supabase db push`, or ask Claude).
2. `app/deploy.sh` to publish the app.
3. Give people access on the **Team** page.
