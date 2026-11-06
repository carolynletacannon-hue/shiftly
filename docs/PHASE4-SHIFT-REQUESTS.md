# Phase 4 rollout — migration first, application second

Do not merge or deploy this branch until the migration is applied and verified on the intended Supabase project. No production migration is applied by the implementation task.

Exact additive migration: `supabase/migrations/20261106000000_shift_requests.sql`.

## Before applying

1. Confirm the target project and take a recoverable database backup. Confirm its migration history contains all six preceding repository migrations, ending with `20261105060100_reconcile_weekly_setup.sql`.
2. Compare the target schema with this checkout. This baseline has **no existing time-off or weekly availability persistence**. Phase 4 introduces `employee_time_off` and `employee_weekly_availability` for conflict validation. If the target has another time-off/availability implementation, stop and integrate those authoritative records before rollout; do not maintain parallel sources. These tables do not replace or delete any existing records. This PR does not introduce separate time-off setup screens.
3. Apply the full migration to a disposable/staging database first, then run the automated suite against the repository. Its Postgres harness replays every migration on a clean database.
4. The migration checks the current publisher's implementation before replacing its assigned-only filter with inclusion of published open slots. If that guard fails, the entire migration rolls back. Review the changed publisher; do not remove the guard blindly.

## Apply

With an authenticated, reviewed Supabase CLI and the correct project linked:

```sh
supabase --help
supabase migration --help
supabase db push --help
supabase migration list
supabase db push --dry-run
# Verify ONLY the expected pending migration is listed before proceeding.
supabase db push
supabase migration list
```

Alternatively run the **complete exact SQL file** in the intended project's SQL editor in its existing `begin`/`commit` transaction, and reconcile migration history using the CLI's documented migration repair workflow. Do not execute fragments. Do not reset the database. No existing publication is republished by this migration; unassigned slots become visible on subsequent explicit publications.

## Verify before merge/deploy

Run `docs/phase4-verify.sql` in the target's SQL editor. Confirm RLS is enabled on all seven new public tables, anonymous/member direct mutation and queue access are denied, all private privileged functions use an empty search path, and the default policy is manager approval (absence of a workspace policy row also means manager approval). Run Supabase's security advisors and review new findings.

Use synthetic staging accounts in two businesses to check:

- Employee A requests coverage from My Schedule; employee B accepts. Assignment stays with A until manager approval under the default policy. Cancellation/decline/denial do not change the assignment.
- A valid approval updates the published and affected draft assignments immediately. No second publish is necessary. Both sides of a swap change together. Unrelated unpublished edits remain unpublished.
- A second browser accepting/approving the same request fails. An approved request cannot execute twice. A manager republish after request creation makes final approval fail safely; cancel and create a new request.
- Overlap in drafts, published adjacent weeks, and approved time off block finalization. Test time off approved *after* consent. Verify overnight and DST intervals in America/Denver and a second IANA timezone.
- Manager settings → Shift Coverage offers both policies. New employee-managed requests complete on explicit replacement acceptance; swaps carry initiator consent and require the other owner to accept. Changing policy alone never finalizes anything. Any intervening policy revision holds existing requests for manager review, even when toggling back.
- Unfilled **published** slots and manager-offered placeholder shifts can receive volunteers. Managers may assign placeholders directly; these actions are explicitly audited as manual assignments. Linked-employee transfers require employee consent.
- A different business cannot read or mutate requests, notifications or policies. Employees cannot access coworker email/phone or the email queue.

Only after these checks may the PR be merged and the application deployed through the normal release process.

## Notifications and email

In-app notifications are committed with each request transition and are visible in Shift Requests. Managers receive visibility into automatic completions. Employee contacts are never returned to browser clients.

Existing `GMAIL_USER` / `GMAIL_APP_PASSWORD` are reused. For server-side recipient resolution and queue processing configure `SUPABASE_SERVICE_ROLE_KEY` **only on the server**. Never use a `NEXT_PUBLIC_` variable. Without it, in-app notifications continue and email remains queued. Email work is attempted after successful actions with Next.js `after()`.

For retries, configure a scheduler to POST `/api/shift-request-emails` with `Authorization: Bearer <CRON_SECRET>` every five minutes. The endpoint denies calls when the secret is absent. Workers claim at most ten messages with `FOR UPDATE SKIP LOCKED`, a five-minute lease and ten-attempt limit. Monitor unsent rows with ten attempts and reset attempts after correcting provider configuration. SMTP acceptance is recorded separately; crashes between SMTP acceptance and recording can cause duplicate email (at-least-once delivery). Email failure never rolls back requests or schedules.

## Consistency and audit

All request commands serialize on the same business row lock used by schedule publishing. Finalization rechecks membership, ownership snapshots, publication revisions, policy revision, consent, affected draft assignments, approved time off and overlaps. UTC instants determine overlap; publication timezones determine local warnings and week boundaries. Availability and weekly hours are warnings, not hard blockers. A swap validates both recipients; projected hours show the replacement's affected local week.

Request rows preserve original/replacement identities, original published snapshots, policy version, consent identity/time, approver/time, finalization time and whether manager approval was used. Published revision events reuse the existing immutable event mechanism. Direct authenticated mutations of request/audit/notification tables are not granted.

Future time-off approval/availability mutation endpoints must use the same organization lock and enforce organization-scoped authorization. This branch exposes no direct client writes to these constraint tables.

## Recovery

On application trouble, roll back the application release while retaining the additive schema and request/audit history. Do not delete requests or restore old assignments manually after completed transfers. Correct assignments through a reviewed manager action. Pending stale requests may be denied/cancelled and recreated; they never silently retarget a changed publication.

## Validation environment limits

The Supabase documentation was checked through its connected docs search. Direct changelog fetch was denied by network policy. Supabase CLI installation was attempted but could not execute in this workspace; the migration file is therefore checked through the real Postgres-compatible PGlite migration replay and functional tests. PGlite queues database calls, so the concurrent-call tests verify transitions and one-winner behavior but do not substitute for separate-connection lock testing on hosted Postgres. Hosted migration verification, multi-session concurrency checks and security advisors remain release gates, not claims of this PR.
