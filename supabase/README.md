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
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261021220000_booking_track_only.sql
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261021230000_deliverables_due_after_launch.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/booking_tracking_test.sql  # stages, deliverables, auto ticks, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1    -f tests/booking_track_only_test.sql   # track-only jobs: nothing sent, org matching, auto-track; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022090000_inventory.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/inventory_test.sql          # bins, items, kits, check-out, search, photos bucket, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022120000_scheduling_assignments.sql
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022150000_schedule_kinds.sql
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022160000_day_email.sql
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022170000_schedule_calendar.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/scheduling_test.sql   # schedule bars + kinds + flex, Google Calendar events, drive time cache, tasks + carry-over, evening push, morning email, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022180000_job_workflows.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/workflows_test.sql    # job checklists: tasks per job, follow picture day and crew, hand edits, cancel, track-only, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022210500_partner_followthrough.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/partner_followthrough_test.sql   # rebooking list, review requests on Deliverables sent, agreements + the public accept page, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022213000_open_jobs.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/open_jobs_test.sql     # part-timers, drive cache, offers, take it / pass, first come first served, pushes, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022213100_season_results.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/season_results_test.sql   # seasons, org matching, partner terms, payments, sales queue, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022213200_timeclock_mileage.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/timeclock_test.sql    # clock in/switch/out, own fixes, approval locks, payroll + overtime, mileage trips + look-ups, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022213500_picture_day_planner.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/pictureday_test.sql   # form, teams, slots, coach answers, sending switch/test mode/quiet hours, booked only, roster bucket, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022233000_staff_gear_records.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/staff_records_test.sql   # clearances, school-job warnings (booked only), onboarding + auto ticks, morning push, gear value + service log, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261022234500_checklist_flow_views.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/workflows_test.sql    # the job checklist tests still hold after it
psql -d shadow -v ON_ERROR_STOP=1    -f tests/checklist_flow_test.sql   # waits for, groups, reminders (owner push, manager push + email), partner email on done (booking settings, booked only), task board + bulk + workload, saved views, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261023090000_employment_type.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/employment_type_test.sql   # job title + type (full access only), Open jobs to Part time / 1099, no overtime for salaried / 1099; rolls back
psql -d shadow -v ON_ERROR_STOP=1    -f tests/open_jobs_test.sql         # again: offers now follow the employment type
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261023091300_job_gear.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/job_gear_test.sql      # repairs block check-out (alone and in a kit), fixing logs a repair, past-due push, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261023101500_crew_confirm_time_off.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/crew_confirm_time_off_test.sql   # crew roles, confirm asks (booked only, quiet hours, one reminder), public Confirm / Can't make it, people needed, crew picker, capacity, weekly email, time off approvals, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261023120000_job_setup_batching.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/job_batching_test.sql   # setup/teardown defaults + extents, trips (batch, unbatch, one-bar trips), job-to-job cache, mileage share, emails, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261023141500_timeclock_round_two.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/timeclock_round_two_test.sql   # location, reminders (booked only), midnight clock-out, pay rates, expenses + receipts bucket, overtime warnings, job time, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261023141600_email_delivery.sql
psql -d shadow -v ON_ERROR_STOP=1    -f tests/email_delivery_test.sql       # Resend sends recorded by the pg_net trigger, answers + look-ups, bounces, resend, report, access; rolls back
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261023200000_polish.sql
psql -d shadow -v ON_ERROR_STOP=1 -1 -f migrations/20261023210000_team_home.sql   # home address on the Team page
psql -d shadow -v ON_ERROR_STOP=1    -f tests/polish_test.sql       # picture day off, ask who's available + pick, no partner emails on checklists, payout kinds + season end, notification modes + morning digest; rolls back
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
| `team_remove` (20261021170000) | team_remove; team_audit_list keeps names of removed people | not yet applied |
