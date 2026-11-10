# Phase 10: Payroll Reports & Wage Calculations

Meadowmark prepares **estimated USD gross wages before deductions** from approved Phase 9 timecards. It does not pay employees, calculate withholding, collect banking information, issue pay stubs, or integrate with a named payroll provider. Approval means reviewed for preparation/export, never paid. `PAYROLL_REPORTS_ENABLED=false` is the default.

## Architecture

- `lib/payroll/engine.ts`: pure Temporal/BigInt calculation engine, calendar pay periods, fixed overtime workweeks, exceptions, currency formatting and safe CSV.
- `lib/payroll/server.ts`: authenticated, feature-gated source loading and calculation; rejects sources above 10,000 timecards or wage-history entries.
- `/workspaces/[id]/payroll`: manager dashboard/settings/history and employee My Pay Estimates, using the existing Frame, navigation, sage identity and responsive cards.
- Server Actions enforce manager/owner membership before any mutation. The browser cannot submit a trusted calculation. Approval recomputes on the server and compares a SHA-256 review token with the page the manager reviewed.
- `payroll_input` captures deterministically ordered settings, employees, rate history, actual timecards/breaks and correction statuses in a single PostgreSQL statement under RLS. This avoids REST row-limit truncation and inconsistent multi-request reads. Scheduled shifts are never calculation inputs.
- The server-only service client calls `payroll_approve`, which rechecks the manager's membership and compares the complete source JSON again while source tables are SHARE-locked. Changes between review and approval require refresh. These short global table locks can briefly delay timekeeping writes; review lock duration in staging before enabling at scale.

## Additive migration and schema

Apply `supabase/migrations/20261110022717_phase10_payroll_reports.sql` after all Phase 9 and persistent kiosk migrations:

| Table | Purpose |
| --- | --- |
| `payroll_settings` | Organization-scoped frequency, anchor, timezone, workweek reference, verified-rule selection, employee visibility |
| `payroll_rates` | Append-only effective-dated integer cents, classification, actor, explanation and recorded timestamp |
| `payroll_reports` | Immutable versioned calculation and complete source snapshots, approval actor/reason/time |
| `payroll_events` | Immutable settings before/after, rate actions, approval and reopening audit history |

Composite foreign keys prevent employee/report references across organizations. No existing production rows are changed. No cascades delete payroll history when an employee is archived. Wage corrections append a row at the original effective instant; the latest recorded entry at that instant wins. A different effective instant represents a new rate. UTC effective instants are entered in the payroll workplace timezone; ambiguous/nonexistent DST local times are rejected. Existing report snapshots always preserve their old inputs.

The installed current Supabase CLI could not initialize because it attempted to write `/home/agent/.supabase` on the read-only filesystem; an older CLI installation also failed. The additive SQL file was authored locally and executed against disposable embedded PostgreSQL instead. CLI advisors and staging Supabase integration remain rollout gates; no remote schema changes were performed. Direct documentation HTTP requests were blocked; the connected Supabase documentation search was used to verify RLS guidance.

## Pay periods and overtime workweeks

- Weekly/biweekly: consecutive 7/14-day calendar periods anchored to the configured start date, including periods before the anchor.
- Monthly: anchor day each month, clamped to the last day of shorter months.
- Semimonthly: anchor day 1–15, then anchor day + 15 in each month, clamped to month end. With day 1 this is 1–15 and 16–month end. Arbitrary separate pairs of cutoff days are not supported.
- Pay period boundaries are local calendar midnights converted to UTC. Overnight sessions and unpaid breaks are intersected with these instants.
- The overtime reference is the configured weekday/time on or immediately before the anchor date in the configured timezone. Subsequent federal workweeks are **exactly 168 actual hours**, independent of pay periods. Their local clock time shifts across DST. This is deliberate; employers using a different DST workweek policy need external review.
- Full workweeks surrounding a pay period are loaded. Hours before the period can make later hours overtime. Biweekly periods never substitute an 80-hour threshold. Weekends and holidays carry no automatic premium.
- Settings edits require an explanation and are audited, but are not effective-dated for future live calculations. Changing the workweek reference or timezone changes live estimates; consult external payroll review first. Immutable historical reports retain the old configuration.

## Supported calculations and limitations

The versioned `overtimeRules` registry starts with federal weekly ordinary hourly nonexempt work: 40 hours at 1x, subsequent hours at 1.5x. Additional rule definitions require their own validation and tests; the initial rule does not represent universal legal compliance.

A manager must explicitly select that the federal single-rate estimate applies. Unverified jurisdictions, exemptions, salary/other compensation, multiple rates within the same workweek, tips, commissions, bonuses and other special compensation need external review. Meadowmark cannot detect compensation recorded outside the system. Do not select the verified rule when those circumstances exist. Unsupported classifications and multiple effective rates within a workweek produce prominent blocking warnings; displayed arithmetic is provisional and not a weighted regular-rate implementation.

Only approved, completed, nonvoided actual sessions produce wages. Unapproved records, missing clock-outs, missing rates anywhere in the relevant workweek, overlapping sessions, incomplete/overlapping/out-of-bounds breaks, and pending correction requests block approval. Unapproved sessions and sessions with invalid breaks are excluded from displayed wages while being flagged. All pending correction requests conservatively block that employee, even if a missing whole session has not yet been entered or the request is outside the chosen period. No automatic break deductions or punch rounding occur.

Time is calculated with integer nanoseconds from actual UTC instants. Rates remain integer USD cents serialized as strings. Regular and overtime compensation each accumulate exact integer rational amounts across the employee's selected period, then round half up to the nearest cent once per category. Total gross is the sum of those rounded categories. Overtime compensation includes the entire 1.5x amount, not just the additional premium. Display/export hours use four decimal places only; saved nanoseconds are authoritative. No JavaScript floating-point money arithmetic is used.

## Manager workflow

1. Keep the rollout flag disabled until staging acceptance. Once enabled in staging, open Payroll in the existing navigation.
2. Save pay period/timezone/workweek settings, verify the applicable rules with payroll support, and explicitly choose employee visibility if desired.
3. Enter hourly rates with effective local timestamps and nonexempt/unsupported classification. Use explanations for every addition or correction.
4. Choose a date in a pay period and optionally filter the employee breakdown. Summary cards show estimated labor cost, regular/overtime hours, employees, missing punches, unapproved cards, missing rates and other exceptions.
5. Drill into Phase 9 timecards for approval/corrections. Employee filtering affects the dashboard, but payroll approval always includes **all employees in the selected period**. The approval form states this explicitly.
6. After the period ends and all blockers are resolved, approve the complete report with an explanation. Concurrent changes force a fresh review. Empty reports cannot be approved.
7. Export a specific immutable approved version as CSV. Reopened versions remain downloadable as historical approved snapshots and are labeled accordingly. Exports contain only name/internal employee identifier, period, hours, rates, wage estimates and review status; no SSNs, bank details or provider compatibility claims.
8. To correct an approved period, reopen its latest version with an explanation, correct/reapprove the actual timecards or append rate corrections, review the new live estimate, and approve a new version. Original reports and their sources remain intact. Time reporting and correction requests remain available after approval.

CSV cells quote embedded commas, quotes and newlines and prefix spreadsheet formula-leading values (including whitespace prefixes) with an apostrophe. UTF-8 BOM and CRLF aid spreadsheet use. The title and status say payroll preparation and no payment confirmation.

## Employee permissions and kiosk security

The employee navigation offers My Pay Estimates when the feature is enabled. A workplace must separately enable employee visibility; only that employee's effective rate history, approved actual hour/wage estimates and pending correction statuses appear. Employees cannot alter rates/settings, approve, reopen, export manager reports or access other employees' compensation. Employees use Phase 9 to read the full request and request corrections. Managers retain archived employee records for historical reporting.

All four new tables have RLS and revoked browser write grants. Policies derive authorization from database membership and employee identity, never editable user metadata. Manager mutations use a hardened private SECURITY DEFINER implementation behind an invoker wrapper, explicit `auth.uid()`/role checks, an empty search path, scoped foreign keys and restricted execution grants. The approval endpoint is service-role-only; browser roles cannot forge approved snapshots. The service key never enters a public environment variable or browser bundle. Rate/report/event UPDATE and DELETE are blocked by immutable-history triggers, including privileged accidental writes.

The existing kiosk proxy redirects enrolled kiosk browsers away from workspace pages; the kiosk API command allowlist was not extended. Anonymous clients have neither SELECT nor EXECUTE access to payroll. Authenticated RLS remains mandatory even if a browser bypasses navigation. The feature flag gates app routes/actions/navigation; RLS remains the API boundary independently of the app flag. Requests and exports are dynamic/private and are not publicly cached.

## Validation results

- `npm install --cache /workspace/.npm-cache`: executed successfully. No dependency changes required.
- `npm run typecheck`: passed.
- `NEXT_TELEMETRY_DISABLED=1 npm run build`: passed. Disabling telemetry avoids Next.js writing to the read-only home directory; no application setting is changed.
- `npm test`: passed 131 TypeScript tests plus 14 TSX tests (145 total, zero failures/skips).
- Focused payroll tests: passed 13 cases including the full additive migration on disposable PGlite PostgreSQL, real RLS role switching, denied forged snapshots, immutable originals, stale-source rejection, reopened corrected versions and archived history.
- Chromium: manager and employee payroll pages passed at 375px/1440px, no horizontal overflow, correct manager controls, employee export denial and kiosk redirect. Local HTTP fixtures test UI behavior; SQL tests verify real authorization separately.

Coverage includes ordinary pay, weekly OT, two-week independence, semimonthly context, overnight/period splits, spring/fall DST, explicit unpaid breaks, effective rates and rate corrections, multiple rates, unsupported rules/classifications, missing punches/approvals/rates, exact decimal parsing, half-up currency rounding, preserved nanosecond time, CSV injection, approval snapshots, postapproval corrections, archived employees, permissions, isolation and scheduling/time-clock regressions. The existing full kiosk Chromium suite also passed (persistent authorization, cookie restart/rotation/exit races, PIN flow, retries, inactivity, origin rejection, handoff headers, workspace isolation, homepage and demo). Native PostgreSQL concurrency and connected Supabase/PostgREST staging validation have not been claimed; the default database runner is PGlite.

## Deployment (manual only)

1. Review the PR and migration. Back up the production database using the existing operational process. Leave `PAYROLL_REPORTS_ENABLED=false` in Vercel.
2. Apply the additive migration to a disposable/staging Supabase project using the team's normal reviewed migration process. Run Supabase advisors, verify grants/function execution under real PostgREST, test two managers and two workplaces, and test a kiosk browser.
3. Run the automated checks and `node tests/payroll-browser.mjs` locally/in CI. The browser script uses only localhost HTTP fixtures and Chromium, never a production project.
4. Manually validate a full reviewed rate/timecard/report/reopen/export workflow in staging, including simultaneous timecard corrections during approval. Check actual payroll rules with the employer's payroll provider/adviser. Confirm export content, logging privacy and expected SHARE-lock duration.
5. Only after staging acceptance, have the operator apply the reviewed migration to production, deploy the reviewed app and enable the **server-only** `PAYROLL_REPORTS_ENABLED=true`. Preserve `SUPABASE_SERVICE_ROLE_KEY` in server secrets and all Phase 9 settings. This implementation does not perform these actions.
6. Configure each workplace explicitly. Monitor exceptions and compare a synthetic/authorized sample to externally reviewed calculations before using exports operationally.

## Rollback

Set `PAYROLL_REPORTS_ENABLED=false` and redeploy the previous reviewed application if necessary. This removes navigation and returns 404 for payroll routes/actions without disabling Phase 9 timekeeping. Keep the additive tables/functions and immutable histories; do not drop tables or delete snapshots/rates. Reenable only after a reviewed fix and staging validation. If a database privilege issue is found, have the operator revoke the affected function grant through a separately reviewed migration. No destructive rollback is supplied.
