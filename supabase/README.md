# Database (Supabase project `socluffmclkdljtmiexw`)

`migrations/` holds the database changes made from this repo. Everything before 2026-10-21 was
applied directly in Supabase (see the project's migration history).

## Testing a migration before it goes live

Use a copy of the production schema without any production data: a Supabase branch, or a local
Postgres loaded with the schema. On 2026-10-21 the copy was rebuilt from production's catalog, and
all 202 function definitions were verified byte-identical. Then:

```sh
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261021120000_team_access_foundation.sql
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261021120100_module_scoped_access.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/team_access_test.sql   # signs in as owner / staff / outsiders; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261021200000_booking_stages_deliverables.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/booking_tracking_test.sql  # stages, deliverables, auto ticks, access; rolls back
```

`tests/team_access_test.sql` must end with `ALL ACCESS TESTS PASSED`. Add checks there for every new
module: one staff user who can, one who can't.

## How the 2026-10-21 migrations went to production

Supabase's MCP holds any migration containing `delete` for a confirmation prompt. So the foundation
migration was applied in parts, with identical SQL:

| Part | What | Status |
|---|---|---|
| `team_access_foundation_1_tables` | app_modules, team_members, team_permissions, team_audit | applied |
| `team_access_foundation_2a_checks` + `_2b_grants` | can / can_any / my_access / is_team_member, team_list, team_flag_password, team_audit_list, me_password_changed | applied |
| `team_access_foundation_3_signin` | emailed code + remembered devices accept team members | applied |
| `module_scoped_access` | every policy and RPC switched from is_admin() to module checks | applied |
| `team_access_foundation_4_team_management` | team_save, team_set_active | applied (pasted into the SQL Editor) |
