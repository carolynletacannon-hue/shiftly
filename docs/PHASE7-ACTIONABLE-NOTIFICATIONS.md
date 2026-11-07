# Phase 7: Actionable Notifications & Employee Preferences

## Behavior and defaults

Meadowmark extends `shift_notifications` and `shift_email_deliveries` instead of creating a second inbox or email queue. Existing time-off notification records remain, with new decisions and historical records mirrored into the consolidated inbox. Historical emails are not replayed.

| Category | Email default | In-app behavior |
| --- | --- | --- |
| Coverage | On | Volunteer acceptance, official assignment, denial, cancellation/withdrawal |
| Swap | On | Recipient proposal, acceptance, decline, manager decision, official reassignment |
| Time off | On | Approval, denial, manager cancellation of previously approved time off |
| Published schedule changes | On | Changes to the recipient's published assignments, including additions/removals, reassignment and start/end changes |
| Manager approvals | On | Pending time-off and accepted transfer requests; resolved items are marked read |
| Weekly schedule published | **Off** | Created only for employees explicitly opted in and assigned in the first publication |
| 24-hour reminder | **Off / unavailable** | No scheduler or delivery implementation |
| 1-hour reminder | **Off / unavailable** | No scheduler or delivery implementation |

Important in-app updates are independent of email preferences. Employees edit only their own settings, separately for each workspace. Missing preference rows use the defaults above. Existing employees are never automatically opted into publication email or reminders. Email rollout itself is disabled by default.

Open coverage opportunities remain visible under Shift Requests; opening one does not email every coworker. Acceptance needing review says approval is pending and assignments have not changed. Deferred transfer triggers inspect the final transaction state: automatic coverage emits only the official completion, without an intermediate approval alert. Every swap requires coworker consent **and manager approval**, even when coverage policy permits automatic coverage. A pending volunteer may withdraw their offer, cancelling the request; assignments stay unchanged and a new request can be created.

Managers can cancel approved linked-employee time off with the new `revoke` command. Employees retain cancellation of their own pending requests only. Approved requests cannot be edited in place; cancel the approved request and submit a replacement for changed dates.

## UI

The existing navigation bell opens `/workspaces/[id]/notifications`; it does not add another menu. Its badge shows the exact unread count (visually capped at 99+), refreshes on navigation/focus, every minute while mounted, and after read actions. A count request failure leaves navigation usable without asserting a zero count.

The center shows the latest 100 notifications, read/unread labels, individual and all-read actions, useful empty/error/loading states, and links to requests or the correct published schedule week. Mark-all covers all unread records in this workplace, including older records outside the displayed 100. Time-off and transfer request cards have stable anchors. Recipient and workspace predicates are applied in the application and enforced by RLS. Existing duplicate notification lists on Schedule, Time Off and Shift Requests are consolidated here.

Preferences use accessible checkboxes, sage styling inherited from the application, disabled loading controls, and database-confirmed save feedback. Manager review preferences appear only for managers/owners. Reminder controls explain their unavailable state instead of accepting an ineffective opt-in.

## Events and duplicate prevention

Database triggers run inside the authorized business transactions. Browser users cannot insert notification records or write messages, recipient IDs, categories, or event keys. The private notification writer is not executable by browser roles.

A unique `(organization_id, user_id, event_key)` index prevents replay of the same semantic event. Transfer keys contain request ID and final status; time-off keys refer to the existing event record. Published schedule keys contain schedule ID and revision, with one summary per affected employee. Only publication events compare snapshots: deleting and recreating publication rows does not produce transient cancellation/addition alerts. No draft trigger sends notifications. Republishing identical employee assignments produces no important change event, even if the revision advanced.

The private baseline is seeded from existing publications during migration. Initial publication is distinct from a change to an already-published schedule. Snapshot comparison includes stable assignment IDs and actual UTC start/end instants; recipient-only old/new shift times are rendered in the published schedule's IANA time zone, including overnight end dates. Transfers suppress generic schedule-change events for the same official action, while still refreshing the baseline for later edits. Shared shift assignments remain independent.

## Email architecture and failure recovery

Gmail SMTP, the sender address, `GMAIL_USER`, and `GMAIL_APP_PASSWORD` remain unchanged. Invitations and password/authentication emails are independent of Phase 7. The previous time-off claim RPC becomes a no-op after migration so decisions are not sent by two workers.

The existing outbox is claimed by a service-role-only RPC using `FOR UPDATE SKIP LOCKED`, batches of at most 10, ten-minute leases, random claim tokens, and a maximum of five attempts. Eligibility is checked at claim time and immediately before preparation: current workspace membership, active connected roster identity, current email preferences, and (for manager review alerts) an unresolved request and current manager role. Auth emails are resolved on the server and must be verified. Queues do not store addresses, Gmail credentials, calendar tokens, or SMTP errors.

Within each batch, related notifications for the same user and workplace are combined into one email. Different workplaces and recipients never share a message. Links are constrained to the recipient's workplace. HTML is escaped and a plain-text version is included. Successful SMTP acceptance marks each included row sent, conditional on its claim token; failed or unconfigured delivery remains unsent. No mail retry rolls back a saved business decision.

Attempts are spaced by the lease and capped at five. Unsent records older than seven days are excluded; historical pending rows are skipped during rollout. A stale worker cannot prepare or acknowledge a newer claim. **SMTP delivery is not exactly once**: a lost acknowledgement or a crash after SMTP accepts a message but before the database records acceptance can cause a duplicate on retry. Batching and event idempotency reduce duplicates but cannot remove this ambiguity.

No scheduled job is installed or enabled. Successful scheduling, transfer and time-off actions request a bounded background delivery pass via Next.js `after()`. The existing protected `POST /api/shift-request-emails` endpoint drains all Phase 7 categories when called by an operator with `Authorization: Bearer <CRON_SECRET>`. It is POST-only, and a missing secret denies access. For a low-volume workplace this provides immediate delivery attempts and a manual recovery path; idle queues need an operator-triggered pass. This does **not** promise unattended retry latency. A reviewed scheduler can invoke the same worker later without changing queue semantics.

## Vercel Hobby limitations

`vercel.json` disables automatic deployment of this feature branch and has no new cron configuration. Hobby cron is intended for daily execution with coarse scheduling precision, so it cannot support reliable one-hour reminders, and a daily scan does not reliably deliver an exact 24-hour reminder either. Both reminder implementations are deliberately deferred. No paid service, external scheduler, or automatic subscription is added.

Before enabling any future scheduler, verify the account's current limits at [Vercel Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) and [cron limitations](https://vercel.com/docs/cron-jobs/manage-cron-jobs#cron-job-limitations). Direct retrieval of Vercel and Supabase documentation was blocked by this execution environment's network policy; account-specific entitlements were not available. The implementation makes no reliability claim based on an unverified plan upgrade.

## Migration and manual deployment

1. Review this PR and take the normal database backup. Keep `PHASE7_EMAIL_ENABLED=false` or unset.
2. Apply all prior migrations, including Phase 6, to a disposable local or staging database. Review `supabase/migrations/*_phase7_actionable_notifications.sql` and apply it there first. It is additive, transactional, and preserves existing data and records. It replaces selected function definitions while preserving their existing authorization boundaries. Guarded function rewrites fail if the expected transfer implementation has changed.
3. Run the tests below, check RLS/grants, and exercise authenticated employee/manager flows in preview. Verify preferences, read counts, new requests, cancellation, publication changes, and unaffected calendar/invitation flows.
4. After review, manually apply the migration to production using the established Supabase migration process. **No production migration has been run by this implementation task.** The code expects the migration; deploy schema first, then the reviewed application version. Test the schema-first transition in staging because the old time-off worker becomes a no-op.
5. Manually deploy the approved application version. No automatic production deployment is part of this work.
6. Only after a separate production review, set `PHASE7_EMAIL_ENABLED=true` and perform a small internal delivery check. This task leaves live environment variables unchanged and does not activate notifications or jobs.

The Supabase CLI was attempted for migration creation but could not start because it tried writing to the environment's read-only home directory. The timestamped migration was authored locally as a fallback and validated by executing the complete migration chain in PostgreSQL tests; it was never applied to a remote database. CLI advisors and migration-history commands were not available here. Live external documentation was also unavailable through the network policy.

### Environment variables

- Existing public Supabase URL and publishable key: authenticated application/RLS access.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only email queue and verified auth-email lookup. Never prefix with `NEXT_PUBLIC_`.
- `GMAIL_USER`, `GMAIL_APP_PASSWORD`: existing Gmail SMTP settings and sender.
- `NEXT_PUBLIC_SITE_URL`: canonical HTTPS application origin (HTTP localhost only for development).
- `PHASE7_EMAIL_ENABLED`: exact value `true` enables the new worker; unset/false stops delivery before claiming anything. In-app events and scheduling continue.
- `CRON_SECRET`: server-only bearer secret for manual queue-drain endpoint; no scheduled invocation is configured.
- Existing calendar variables remain unchanged.

## Testing and manual validation

Run `npm install`, `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:postgres`. In a restricted environment use a writable npm cache and disable Next.js telemetry, e.g. `npm install --cache /workspace/.npm-cache` and `NEXT_TELEMETRY_DISABLED=1 XDG_CONFIG_HOME=/workspace/.config npm run build`.

`tests/notifications.test.ts` executes the entire migration chain in embedded PostgreSQL (PGlite), including real role/RLS behavior. It covers defaults, persistence, cross-workplace isolation, forged writes, read states, publication snapshots, drafts and republication, transfer states, time-off decisions, optional publication, archived/disconnected recipients, preference enforcement, bounded retries, claim recovery and stale tokens. Unit tests cover escaped templates, feature-flag shutdown, recipient/workplace batching, and SMTP failure/acceptance. `tests/notification-controls.test.tsx` uses DOM interaction for accessible preferences, real save failure/success states, read actions, safe links, and bell badges.

For native PostgreSQL and concurrent workers, set `SHIFTLY_TEST_DATABASE_URL` to a disposable **localhost** database with permission to create test databases, then run both commands. The new notification migration tests automatically use that native cluster via the existing test helper. Without the variable, the dedicated native concurrency command fails its setup assertion; `npm test` still runs the PGlite migration tests. Never point these tests at production.

Manual preview checks: log in as two employees and a manager, opt out of coverage email for one employee, complete a consent/approval transfer, change one published shift and republish, save an unchanged assignment revision, deny time off, revoke approved time off, and verify badges and links on mobile. Simulate a Gmail failure using test mocks; never expose actual credentials in screenshots or logs. Exercise overnight shifts across America/Denver DST using the existing calendar and scheduling regression tests. Browser/SMTP smoke tests against a real connected staging workspace require credentials and remain manual.

## Security, troubleshooting and rollback

Only workspace members can read their own inbox and preferences; managers cannot modify an employee's preferences. Only `read_at` can be updated on notification records. The preferences table has RLS, a membership FK and ownership checks on both existing and new row values. Private functions have fixed empty search paths and explicit revoked public execution. The service role alone can claim or inspect delivery work through server infrastructure. No auth-user metadata is used for authorization.

If notifications cannot load, verify the migration is installed, current membership exists, and the session is valid. If email is absent, check the flag, canonical site URL and configured Gmail variables without printing secrets; then inspect queue attempts, sent/skipped timestamps and lease expiry using an authorized admin session. Confirm the recipient is still connected, active, verified and opted into that category. Resolved manager approvals are intentionally not emailed. Missing preferences mean important email on and optional email off. No reminders will send.

For recovery after transient failure, allow the lease to expire and invoke the protected worker manually. Exhausted or older-than-seven-day work is not automatically replayed. Investigate SMTP acceptance ambiguity before explicitly resetting attempts; reprocessing can duplicate accepted email. Existing queue records contain messages for their intended recipients and should be treated as private operational data.

For immediate rollback, set `PHASE7_EMAIL_ENABLED=false`; this stops claims without affecting scheduling, calendars, invitations or in-app updates. Prefer a forward fix with the additive schema retained. Reverting application code alone is insufficient: the legacy time-off claim function was intentionally disabled and transfer fanout replaced. A full behavioral rollback requires a reviewed compensating migration restoring those specific prior function definitions and dropping the Phase 7 event triggers; disable all delivery first to prevent legacy and new workers overlapping. Preserve notification and preference records. Do not drop tables, truncate history or replay queues during rollback.

### Implementation validation results

- `npm install`: passed with a workspace-local cache.
- `npm test`: 117 passed (108 server/database tests and 9 DOM/render tests).
- `npm run typecheck`: passed.
- Production `npm run build`: passed with telemetry disabled and a writable configuration directory.
- `npm run test:postgres`: 13 passed on a disposable native PostgreSQL 18.6 server, including multi-session outbox claim isolation and stale-token fencing.
- Notification-specific suite on native PostgreSQL: 14 passed. The normal suite also validates the migration chain with PGlite.
- `git diff --check`: passed.
- Not run: real staging browser/SMTP delivery or Supabase CLI advisors. No staging credentials were configured; the CLI could not write its home directory. External Supabase/Vercel documentation retrieval was blocked. No production database or environment was accessed.

## Email worker repair

See [Phase 7 email delivery repair](PHASE7-EMAIL-DELIVERY-FIX.md) for the production-only guard, trusted Vercel URL fallback, manager diagnostics/scoped retry controls, logging and reviewed rollout checks. Preview no longer sends mail even when the flag is enabled.
