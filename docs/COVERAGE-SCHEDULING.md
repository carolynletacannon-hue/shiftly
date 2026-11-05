# Coverage-first scheduling rollout

This release adds recurring coverage requirements and turns each private draft
shift into a persistent coverage slot. The migration is additive: existing
organizations, members, invitations, schedules, draft shifts, published shifts,
templates, revisions, and events remain in place. Existing draft shifts become
assigned one-off slots. Unassigning a slot now clears `employee_id` without
deleting the slot.

## Required migration order

The application must not be deployed until
`supabase/migrations/20261105060000_coverage_scheduling.sql` has been applied.
The new manager page reads `coverage_requirements` and the new slot columns, so
deploying application code first will make that page unavailable.

For an existing Phase 2 installation:

1. Verify the Phase 2 schema is already applied. The currently connected hosted
   project records it as `20261105042545 phase2_scheduling`; the repository file
   containing the same Phase 2 schema is
   `20261105035217_phase2_scheduling.sql`.
2. Apply **only** `20261105060000_coverage_scheduling.sql`.
3. Do not rerun either the workspace, invitation, or Phase 2 migrations.
4. Verify the migration completed before deploying or merging this application
   release into an automatically deployed branch.

The currently connected project has migration-history versions generated during
its hosted rollout that differ from the repository filenames. For that project,
use the SQL Editor for this one additive file, or reconcile history before using
`supabase db push`; otherwise the CLI can incorrectly offer earlier migrations.

For a CLI project whose migration versions already match this repository, review
the pending list and push in order:

```sh
supabase migration list
supabase db push --dry-run
supabase db push
supabase migration list
```

The dry-run should show only `20261105060000`. If it shows an earlier migration,
stop and reconcile migration history before continuing. Do not mark a migration
applied unless the hosted schema has been verified to match it.

For a project managed through the SQL Editor, open the new migration file, paste
the whole transaction into the SQL Editor, run it once, and record version
`20261105060000` in the same deployment log used for earlier manual migrations.

For a brand-new installation, apply all migration files in filename order. Do not
apply the new file by itself because it intentionally builds on the Phase 2 tables
and command function.

## What the migration changes

- `coverage_requirements` stores organization-scoped template, weekday, position,
  active state, and headcount rules. RLS permits reads only to current owners and
  managers; all writes continue through the authorized scheduling RPC.
- Draft `shifts.employee_id` becomes nullable and slot metadata is added. Existing
  rows and IDs are preserved. Required slots have stable requirement/ordinal keys.
- Published rows gain slot metadata for safe Copy Previous Week behavior. Only
  assigned rows are copied into the employee-visible snapshot.
- The existing compare-and-swap revision, organization lock, overlap validation,
  local timezone/DST checks, and publication event boundary remain in use.
- Publishing with unfilled required slots is rejected unless the manager sends the
  explicit incomplete-publication confirmation from the review dialog.

Recurring rule changes affect only drafts created afterward. They never add,
remove, or rewrite slots in an existing draft or published schedule.

## Post-migration smoke test

In staging, create a recurring rule with headcount two and a second rule for a
different position. Create a new week and confirm three empty required slots
appear. Assign two different organization members, unassign one, and verify the
slot remains. Confirm overlaps are rejected and high weekly hours are warned.
Try publishing with an empty required slot, verify the first attempt is blocked,
then use the explicit incomplete confirmation. Sign in as an employee and confirm
only assigned published shifts are visible; the private draft, empty slots, and
coverage rules must remain hidden.

Also test Sunday-start and Monday-start organizations, an overnight template,
Copy Previous Week, two manager tabs with a stale revision, and the stacked mobile
day layout. Run `npm test`, `npm run typecheck`, and `npm run build` before release.
