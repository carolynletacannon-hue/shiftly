# Phase 2 — persistent scheduling

## Deployment: apply only this new migration

Before merging/deploying Phase 2, apply the full contents of
[`supabase/migrations/20261105035217_phase2_scheduling.sql`](../supabase/migrations/20261105035217_phase2_scheduling.sql)
**once** to the existing Shiftly Supabase database. This is the only new SQL file
required for Phase 2. It is wrapped in a transaction and is additive: it creates
new scheduling tables, indexes, policies and functions, plus a composite unique
index on existing positions. It does not alter or remove existing workspace,
account, membership, invitation or position records. Default templates are seeded
only when a manager creates the first draft for a workspace.

Use the same migration tracking approach already used for the project. For a
SQL Editor-managed installation, run only this new file in Supabase → SQL Editor,
and record version `20261105035217` as applied. For a CLI-managed installation,
review migration history first and ensure only this new migration is pending.
**Do not rerun** `202611050001_workspaces.sql` or
`20261105025631_invitation_email_delivery.sql`. Do not reset, drop, or recreate the
database. Review your usual backup/recovery plan before applying a schema change.

No hosted SQL was executed during implementation. Automated tests use newly
created, isolated PGlite databases with fictional users; these cannot modify the
hosted project. Hosted Supabase advisors and an authenticated browser smoke test
should be run in your own staging project before rollout.

No additional Vercel variables, worker, SMTP configuration, or service-role key
are needed for scheduling. Existing authentication and Gmail invitations remain
unchanged. Keep `shiftly_private` out of the exposed Supabase API schemas. Review
and merge the PR after the migration is applied, then let the normal GitHub →
Vercel deployment build run. Use Node.js 22 or later as in the existing CI.

## Manager workflow

From a workspace, open **Schedule editor** (owner/manager only). Pick a week; the
workspace's configured Sunday/Monday start is respected. Create an empty private
draft or copy the previous week. Copy prefers the previous published snapshot,
falling back to its draft only when it has never been published. It never
replaces an existing target draft. Copied shifts are independent and unpublished.
If a published position name no longer matches a configured position, the copied
shift uses General and can be reassigned before publication.

Use employee rows or switch to day columns. Select **+ Add** on a date/employee,
choose an optional position/template, and enter local start/end dates and times.
Overnight shifts must explicitly end on the following day. Existing cards open
editing and reassignment; delete affects the draft only. Morning (07:00–15:00),
evening (15:00–23:00), and overnight (23:00–07:00 next day) templates are seeded
for the first draft and can be edited, deleted, or extended. New positions can be
added in Schedule settings. Template changes never rewrite existing shifts.

Review weekly hours and the workload warning. The configurable guideline defaults
to 40 hours, is advisory, and is not a legal overtime calculation. Employment rules,
contracts and local law can differ for each worker. Use **Print week** for a compact
printed view; drafts stay labeled as drafts. A week supports up to 300 shifts,
which comfortably covers a seven-person front desk while bounding bulk operations.

Select **Publish schedule**, review the confirmation, and explicitly confirm.
Subsequent edits create unpublished changes in the same workbench; employees
continue to see the last publication. **Republish schedule** explicitly replaces
that week. Publishing an empty draft is allowed only through the explicit publish
action and clears the published week; the confirmation calls this out.

## Employee workflow

**My Schedule** shows the selected published week, your actual scheduled hours,
and up to 30 upcoming published shifts. **Team schedule** shows the organization's
published week for all members. Employees cannot access draft rows or manager-only
configuration through the UI, direct Data API, or scheduling RPC. Empty and
loading/error states explain when a week is not published or cannot be loaded.
A shift that continues into the week from the previous week is shown separately.

## Storage, validation and concurrency

- `schedules` and `shifts` hold the private editable workbench, revision number,
  week start, and frozen IANA timezone for each week.
- `published_schedules` and `published_shifts` hold only the current live snapshot.
  Each publish atomically replaces that snapshot, including positions and notes.
  Published position names are copied, so later position renames do not silently
  rewrite the live schedule. Old full snapshots are not retained; `schedule_events`
  retains who published which revision and when.
- Every business-owned row has `organization_id`. Composite foreign keys prevent
  cross-business shift, employee, schedule, or position references. All new tables
  have RLS and explicit authenticated read grants. There are no direct client write
  grants on scheduling tables. Employee policies permit only published snapshots.
- `public.schedule_command` is a security-invoker wrapper around a narrowly granted
  function in the unexposed private schema. It checks the authenticated user's
  current workspace role before and after acquiring an organization lock.
- All draft/template/settings writes check the expected revision. Stale clients
  receive a refresh error instead of overwriting another manager. Publishing checks
  the same content revision and rejects duplicate publications. Organization-level
  transaction locks serialize overlap checks and publications across adjacent weeks;
  this favors correctness for small teams over parallel editing throughput.
- Overlaps use half-open intervals: back-to-back shifts are allowed. Saving or
  copying rejects employee overlaps against other drafts and other weeks' published
  snapshots. Publishing revalidates before changing employee-visible data. Resolve
  a conflicting adjacent week and republish it first when its old published shift
  still conflicts. Different employees may work overlapping shifts.
- Start/end instants are finite UTC `timestamptz` values. Starts must be inside the
  schedule's local week; end must follow start and end no later than the next local
  day, with at most 24 wall-clock hours (26 actual hours covers DST transitions).
  All date/time display and copying use explicit IANA timezones rather than the
  browser/server timezone. Week timezone is frozen when the draft is created.
- Temporal rejects nonexistent spring-forward hours. For a repeated fall-back hour,
  select the earlier or later occurrence for start and end separately; offsets/abbreviations are
  shown on shift cards. Copying preserves wall-clock start/end times across DST,
  rather than blindly adding 168 hours. A failed copy rolls back the entire draft.
- Weekly hours use actual elapsed time, clipped to local week boundaries, so
  overnight shifts are split and 167/169-hour DST weeks are handled correctly.
  These are scheduled hours without unpaid-break or payroll-rule deductions.

## Future integrations, deliberately inactive

Each successful publication inserts one organization-scoped `schedule.published`
event with schedule ID, content revision, actor and timestamp in the same
transaction. Draft edits insert no events. A future notification worker can consume
these events with idempotency keyed by `(schedule_id, revision)`; no worker or
email sending is connected in Phase 2. These events are publication metadata, not a
ready-to-run delivery queue with retry/claim state.

`shiftly_private.validate_schedule` centralizes final validation so approved
absence/availability checks can be added there in a later migration. No time-off
requests, shift swaps, calendar subscriptions, or new employee notifications are
implemented. The fictional `/demo` remains explicitly separate from real schedules.

## Validation and rollout smoke test

`npm test`, `npm run typecheck`, and `npm run build` are required. The new tests cover
real Postgres role/RLS behavior, tenant isolation, direct-write denial, draft versus
published visibility, explicit republishing, delete/reassignment privacy, overnight
and cross-week overlaps, stale competing edits, atomic copy rollback, template and
settings revisions, and DST dates/hours. Existing authentication/invitation tests
remain part of the suite. PGlite queues competing requests in one local database;
production multi-connection behavior is protected by the SQL organization lock and
should also be smoke-tested with two manager sessions in staging.

After applying the new migration in staging, sign in as owner, manager, employee,
and an unrelated workspace user. Create a week, add a morning and overnight shift,
copy to the next week, and verify employee pages remain empty until publication.
Publish, edit a shift, and confirm the old employee view remains unchanged until
republishing. Try overlapping assignments and saving from two manager tabs with
the same revision. Verify the second stale edit fails without losing the first.
Check both DST transition weeks, phone/desktop layouts, keyboard navigation and
printing. Confirm there are no employee emails on draft edits or publication.
