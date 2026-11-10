# Timecard approval workflow

Routine new kiosk timecards are approved automatically in the same transaction as their clock-out receipt, using database validation. This marks actual recorded time as ready for wage estimation. It never approves a payroll report or indicates that wages were paid. Managers still explicitly review and approve Phase 10 payroll-preparation reports.

## Migration and rollout

Apply the additive `supabase/migrations/20261110035505_timecard_approval_workflow.sql` after Phase 9, persistent kiosk authorization and Phase 10, first in disposable/staging Supabase. Deploy the matching app only after testing the migration. There are no new environment variables; retain the existing `TIME_CLOCK_ENABLED`, time-clock workplace settings and Phase 10 rollout flag. No production migration is run by this change.

The migration adds nullable `time_sessions.approval_source` (`automatic`/`manager`) and guarded functions/triggers. It does **not** update any historical timecards, timestamps or approval statuses. Legacy approved records retain their approval and a null source. Legacy pending cards remain pending. There is no automatic historical backfill: managers must deliberately review and individually approve them, or use the confirmed bulk workflow for eligible routine records with complete matching original punch receipts.

The Supabase CLI was attempted for migration creation but could not initialize its read-only home directory, so the SQL file was authored locally and replay-tested on PGlite and native PostgreSQL 17. Supabase advisors and connected staging integration remain operator rollout checks.

## Automatic eligibility and exceptions

A newly inserted immutable `out` receipt can approve its own session only when all of these conditions hold:

- A completed nonvoided actual timecard with valid nonfuture timestamps.
- No overlapping **same-employee** nonvoided sessions. Intervals are half-open; adjacent same-employee sessions do not overlap.
- All explicitly recorded unpaid breaks are completed, within the session, ordered without overlap and supported by matching immutable start/end receipts.
- Exactly matching original clock-in/out receipts and the expected break receipt count.
- No pending correction request for the session, or a pending whole-session request for that employee.
- Kiosk-originated time that has never had a manager `correct` or `void` action.

Different employees may work simultaneously without an approval restriction or imposed clock-out order. The same employee may also clock in at one kiosk and clock out at another in the workplace. Organization locking serializes short database transactions for safety; it does not limit the workplace to one active employee. Existing per-device rate limits and infrastructure capacity still apply.

Missing clock-outs, invalid/incomplete breaks, same-employee duplicate time and pending corrections remain unapproved. Edited timecards require individual manager review even if they otherwise validate. Approving an individual card checks structural validity and resolved correction requests in the database, so frontend bypasses cannot approve exceptions. Repeat approval of the same already-approved revision is a no-op; stale revisions are rejected.

A pending correction request invalidates an affected existing approval immediately and advances its revision. Whole-session requests conservatively invalidate that employee's approved sessions until review. Timestamp, employee or void changes clear approval; break changes invalidate an approved session; newly introduced same-employee overlaps invalidate conflicting approved sessions. These actions append `approval_invalidated` audit entries with prior/next values. Request rejection/resolution does not silently restore approval: managers review again. Original punch events and prior correction/audit records remain immutable. No scheduled times are used to close sessions, approve time or deduct breaks.

## Manager experience

Approved timecards display **Approved** (with an automatic qualifier where appropriate) instead of another approval button. Action labels include Approve Timecard, Void Timecard, Generate New PIN, Activate Kiosk & Sign Out, Save Settings and Approve All Eligible, with action-specific pending text.

The selected date/employee range has a bulk preview. Eligible pending cards must be fully contained in the workplace-local date range and have complete unmodified kiosk receipts. Overnight cards crossing a boundary need a wider range or individual review. Open, invalid, edited and correction-blocked records are excluded and show review reasons. The manager must check the confirmation box before submitting. The server and database also enforce manager membership and explicit confirmation.

The database reconstructs the eligible set and compares the preview fingerprint, including full card values, revisions, breaks and relevant correction history, under the same organization lock used by punches/corrections. If eligibility or any reviewed source changes, the entire batch is rejected without partial approval; refresh and confirm again. A repeated nonempty batch using an old token cannot reapprove records. Each approval and the overall batch retain audit entries. Batches over 1,000 cards require a narrower range. A disabled workplace can still load management/settings; bulk approval remains unavailable until the clock is enabled.

## Overtime visibility and payroll

The manager dashboard shows recorded overtime in the selected range and **Overtime Recorded** on affected cards. These indicators use a separate 40-hour counter for each employee and full surrounding 168-hour workweeks, including time before the selected range. Open sessions are provisional. They never gate automatic or manual approval, and never compare one employee's hours with another's.

When Phase 10 is enabled and configured, indicators use its workweek reference. Otherwise they use Sunday midnight from the January 4, 2026 reference in the workplace timezone; fixed 168-hour weeks shift local start time at DST. This is a visibility estimate, not a jurisdiction-specific wage calculation. More than 1,000 source records suppress the indicator and ask for a narrower range rather than silently showing a truncated result.

Phase 10's wage engine is unchanged: it reads `approved_at`, accepts both automatic and manager approvals, and independently blocks payroll report finalization on unresolved payroll exceptions. Tests verify ordinary and overtime wages from automatically approved overlapping employee handoffs. Previously approved payroll snapshots remain immutable; later time corrections affect live estimates and require the existing reopened report/version workflow.

## Security

Existing timekeeping RLS, employee/workplace isolation and the kiosk command allowlist remain intact. The old manager implementation is renamed and its browser EXECUTE permission revoked. The guarded wrapper retains explicit authentication, manager checks, organization locking, revision checks and existing restricted public/invoker boundaries. Trigger helpers are private, have fixed empty search paths and are not callable by browser roles. No service credentials or compensation data are added to kiosk responses.

## Validation

- `npm install --cache /workspace/.npm-cache` executed.
- `npm test`: 148 tests passed (134 TypeScript, 14 TSX).
- `npm run test:postgres` with `SHIFTLY_TEST_DATABASE_URL` pointing to a disposable localhost PostgreSQL 17 container: 17 tests passed, including multi-session correction/bulk races and simultaneous distinct-employee punches.
- `npm run typecheck` and `NEXT_TELEMETRY_DISABLED=1 npm run build`: passed.
- `node tests/payroll-browser.mjs`: payroll manager/employee regressions, timecard labels/approved state/overtime/bulk confirmation at 375px and 1440px, employee export denial, kiosk redirect and the full existing kiosk browser suite passed. HTTP UI fixtures stay local; SQL tests separately verify real permissions and persistence.

Regression coverage includes new routine approval, historical pending preservation, overnight shift handoffs, opposite clock-out order, cross-kiosk clock-out, complete/incomplete breaks, missing punches, same-employee overlaps, pending requests before/after clock-out, edited open/completed timecards, voiding, duplicate approvals/batches, exact Phase 10 overtime wages, employee/cross-workplace denial and immutable audit/punch histories. Tests on older workflows now refresh the revision after a correction request and separately assert original manager audit actions, while new tests assert automatic/invalidation audit events.

## Rollback

Keep all approval, punch and audit history. If automatic approval must be paused, use a separately reviewed database migration to disable the `time_auto_approve` trigger; merely reverting the frontend does not stop database automation. Keep the guarded manager wrapper, RLS and approval invalidation triggers while investigating. A complete function/trigger rollback requires an explicitly reviewed migration restoring the previous manager entry point and grants; do not drop tables, delete receipts or mass-update approval statuses. Existing workplace clock disabling can pause kiosk access using its normal manager setting, but is not a substitute for reviewing the database rollback. Never change existing production timecards as part of deployment or rollback.
