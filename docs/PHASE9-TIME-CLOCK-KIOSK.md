# Phase 9 — Employee Time Clock & On-Site Kiosk

Status: implemented for review; disabled by default. No production migrations, employee changes, activation, merge, or rollout were performed by this change. This is timekeeping, not completed payroll or a claim of labor-law compliance.

## Architecture

The existing Next.js app owns the manager and employee screens at `/workspaces/[id]/time-clock`. The consolidated navigation shows Time Clock to managers and My Timesheet to employees when the server feature flag is enabled. My Timesheet has no punch endpoint or direct editing capability. Kiosk punches are available only through `/kiosk` and the same-origin `/api/kiosk` POST route.

An additive migration creates these workspace-scoped records:

| Table                               | Purpose                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `time_clock_settings`               | Explicit workplace opt-in and break guidance                                        |
| `time_kiosks`                       | Enrollment metadata, expiry, revocation, activity                                   |
| `shiftly_private.kiosk_credentials` | SHA-256 device-token hashes, short-lived employee challenges, durable rate counters |
| `shiftly_private.employee_pins`     | Salted scrypt credentials and keyed lookup digests; never raw PINs                  |
| `time_sessions`                     | UTC work intervals, revision, approval and void metadata                            |
| `time_breaks`                       | Actual explicit unpaid break intervals                                              |
| `time_punch_events`                 | Immutable original punches and retry receipts                                       |
| `time_correction_requests`          | Employee requests and manager decisions                                             |
| `time_audit`                        | Append-only before/after corrections, approvals, voids and device/security actions  |

All new public tables have RLS and SELECT-only authenticated grants. Employees can read only their own time records while they retain workspace access; managers can read only their workplace. Secrets have no browser grants. Public RPC wrappers use security invoker; privileged implementations live in the existing private schema with fixed empty search paths and explicit grants. Authenticated management operations check `auth.uid()` and the current workspace role. The kiosk RPC is executable only by server-side `service_role` and verifies the hashed device credential on every operation. The service client has no user session persistence.

The organization row is locked before device/employee/session state. This matches existing roster/scheduling lock order and serializes kiosk revocation, employee lifecycle changes, punches, and corrections. A partial unique index prevents more than one non-void open session. Authorized commands reject overlapping work/break intervals and invalid transitions within the same transaction. Original punch events and audit rows reject UPDATE and DELETE, including through normal privileged SQL. Foreign keys preserve time history when employees leave and prevent cascading workplace deletion from erasing attendance.

## Required environment variables and safe defaults

- Existing `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- `NEXT_PUBLIC_SITE_URL`: canonical origin for this deployment. Use HTTPS outside local development; set the correct preview origin during staging tests.
- Server-only `SUPABASE_SERVICE_ROLE_KEY`; never prefix it with `NEXT_PUBLIC_`.
- Server-only `TIME_CLOCK_PIN_PEPPER`: at least 32 random characters, generated with a cryptographic generator and kept in the hosting secret store. Do not put it in chat, documentation, analytics or source control.
- `TIME_CLOCK_ENABLED=false` by default. Set `true` only after review and staging acceptance. Both the runtime flag and an explicit per-workplace enabled setting are required for kiosk operation.

Changing the pepper invalidates existing keyed PIN lookups: regenerate all affected employee PINs. A service-role key rotation follows the existing Supabase operational procedure. Device rotation does not require changing either secret.

## Database migration instructions

The migration is `supabase/migrations/20261109230749_phase9_time_clock_kiosk.sql`, generated with `supabase migration new phase9_time_clock_kiosk` and tested with all prior migrations in order. It does not enable any workplace or populate fake attendance. Apply it first to a disposable/staging database and review grants/RLS with Supabase advisors there. The Supabase changelog fetch was blocked by the environment's outbound policy; current RLS/function documentation was consulted through the Supabase documentation tool.

Do not run the migration against production as part of this PR. A separately authorized operator must review the migration, backups, record-retention requirements, staging results and deployment plan before a manual production application. Check the installed Supabase CLI's help/version before using migration commands. Never point test commands at production.

## Manager kiosk setup

1. Use a dedicated, managed workplace browser/profile. Sign in as owner or manager on that device.
2. Open Time Clock → Kiosk Management & employee PINs. Explicitly enable the workplace and select break guidance if required.
3. Generate PINs for each eligible employee and share privately. Do this before handing the device to employees.
4. Enter a recognizable device name and choose **Activate kiosk & sign out**.
5. The server enrolls a random device credential, revokes the manager's local refresh session, deletes Supabase cookies and installs a separate Secure, HttpOnly, host-only, SameSite=Strict kiosk cookie. A hard navigation through `/api/kiosk/handoff` clears browser cache/storage and drops the authenticated React router state. It retains only the scoped kiosk cookie.
6. Confirm the kiosk displays the correct workplace/time zone and that attempting to visit workspace/account pages redirects to the kiosk. Use the operating system's kiosk/full-screen mode for actual device lockdown.

The scoped cookie is checked by middleware to block access back to app pages while kiosk mode is present. Independent of that UI boundary, manager actions require authenticated membership server-side and in SQL. The kiosk never gets manager access tokens or a service-role key.

The manager device list shows authorized, expired and revoked devices and last activity. Remote revocation takes effect at the database boundary; an already displayed kiosk screen grants no subsequent authority. Reauthorization always creates a new enrollment. Enrollments last **12 hours**, with token rotation hourly while the page is open; rotation does not extend the original lifetime. If a rotation response is lost, authorization fails closed and the manager can enroll again. Kiosk expiry does not fabricate a clock-out: open sessions remain visible for review.

**End kiosk mode** revokes this enrollment, clears the cookie and returns to login. Anyone at the terminal can end/revoke it, but only a manager can enroll again. This is a deliberate availability tradeoff. An expired/revoked credential can clear its local kiosk cookie without gaining access to anything.

## PIN security and management

PINs are cryptographically random six-digit strings, including leading zeros. A per-workplace unique HMAC-SHA-256 lookup uses the server pepper; salted scrypt stores the verification credential. PIN checks use constant-time comparison, including dummy scrypt work for unknown PINs. A rare collision is rejected by the database and the manager can generate again. PINs are shown once to the authorized manager, disappear after 30 seconds, and can be hidden immediately. They cannot be retrieved later or emailed by Meadowmark.

Five attempts initiate a five-minute device lockout. The counter is updated and committed before PIN validation, so failures cannot roll it back. Successful verification clears the failure counter. The kiosk shares a durable 120-operations/minute limit across server instances; PIN checks consume more than one operation. Lockouts are recorded without PINs or guessed identities. Reverse-proxy/WAF request-volume controls remain advisable for unauthenticated traffic.

Archived employees, disconnected former account holders, and linked employees without current membership cannot punch. Archiving, account-link changes, and membership removal invalidate PINs; restoring/reconnecting requires regeneration. Active roster-only employees can use manager-issued PINs without needing an online account. A PIN reset also invalidates outstanding kiosk employee challenges. Employee self-service PIN changes are deferred; use the manager reset workflow.

A successful PIN verification reveals only a first name, current state and a random 30-second challenge. The challenge is held in page memory, bound to that kiosk/employee and consumed after one successful punch. No PIN, device secret or challenge goes in a URL. The numeric screen clears after 30 seconds of inactivity. No roster, wage, personal contact data, schedule or timecard is delivered to the kiosk.

## Timekeeping and breaks

Valid transitions are clocked out → Clock In; working → Start Unpaid Break or Clock Out; on break → End Unpaid Break. Clocking out during an open unpaid break is rejected. No break is automatically created or deducted. The configurable required-break guidance reminds employees to record actual breaks; it does not enforce jurisdiction-specific duration or deduct unpaid time. Paid breaks remain working time by leaving the work state unchanged.

PostgreSQL `clock_timestamp()` creates punch instants. Browser time is never submitted as evidence of work; the displayed clock advances from a server time snapshot and is informational. Recorded precision is preserved; interval arithmetic uses Temporal nanoseconds before conversion to numeric report hours. Displayed rounded hour labels do not change stored punches; CSV hours are unrounded numeric calculations.

UTC instants handle overnight work and daylight saving changes. Daily/weekly totals intersect work and unpaid-break intervals with local IANA date boundaries, including 23/25-hour days. No scheduled hours are substituted for actual time. Open-session hours are provisional and continue only to the report's current instant. An open session over 16 elapsed hours is labeled Missing Punch as a review heuristic; it is not automatically closed.

Every punch has a client-generated random request ID. Retrying the same device/request/action returns the immutable receipt, without applying a second transition. The kiosk retains the same ID after a network error and shows a Retry control. A different action with the same ID is rejected. After timeout, an employee can reenter their PIN to inspect the current committed state.

## Employee and manager workflows

Employees can review their own daily/weekly records, breaks, missing clock-outs, correction snapshots and request decisions. They can request a correction against a session or report an entirely missing session. They cannot directly create punches or silently edit records.

Managers can view current working/on-break/missing attendance, completed records, paid totals, employee/date filters and published-schedule comparisons. Multiple published assignments are combined as interval unions per employee so shared or overlapping assignments do not double-count planned hours. Out-of-schedule work is allowed. Punches never create or alter published schedules.

Corrections require a 5–1,000 character explanation and the displayed revision. A stale edit fails, requiring refresh/review. Managers can correct timestamps and each recorded unpaid break, or add a missing work session. Future timestamps, overlapping work/breaks, and breaks outside the work interval are rejected. The form preserves stored timestamp precision and provides first/second occurrence choices separately for each ambiguous DST endpoint; nonexistent spring-forward local times are rejected.

Every correction preserves the prior session and break values, records the actor/time/reason, increments the revision and clears approval. Original kiosk punch events never change. Managers can **void an invalid timecard** with a reason: it remains visible with its audit, contributes zero hours and cannot be modified again. Add a replacement session when appropriate.

To approve an employee correction request, first apply a correction linked to that request; SQL requires a matching audited correction for that employee/session. Rejecting requires a response. Timecard approval requires a completed, non-void session with no outstanding applicable correction request. Approval itself is audited. Employee records remain after archiving; former employees lose app access, not the retained business history.

## CSV exports

Manager-only `/workspaces/[id]/time-clock/export` uses the authenticated workplace and optional employee/date filters. It exports employee, session-start work date, UTC clock-in/out, workplace zone, actual unpaid seconds and paid hours **within the selected range**, approval/void status, correction explanations, session ID and range bounds. Overnight sessions remain a single identifiable row; daily totals are calculated by interval intersections, not by assigning every hour to the start date. Open sessions are explicitly provisional. Voids contribute zero hours.

All cells are quoted, internal quotes escaped, and formula-leading content (including whitespace-prefixed formulas) neutralized. Exports are private/no-store. They fail rather than silently truncate at the configured 1,000-record boundary; use smaller ranges for larger teams. UI history, attendance, published assignments, original punch lists, audit lists and requests are bounded to 1,000 rows (device list to 100) and show a range-limit notice. Large-scale paginated reporting/archive export is deferred.

## Testing results

Validation uses synthetic `.test` identities and local databases only:

- `npm install --cache /workspace/.npm-cache` succeeded. A first default-cache attempt failed because the home cache was read-only; it did not require a dependency change.
- `npm test`: **132 passed (118 server/unit/database tests + 14 React UI tests), zero failures**.
- `npm run typecheck` and `NEXT_TELEMETRY_DISABLED=1 npm run build`: **passed**.
- `SHIFTLY_TEST_DATABASE_URL=postgres://…@127.0.0.1:55432/postgres npm run test:postgres`: **15 passed, zero failures**, on disposable **native PostgreSQL 18**; includes existing scheduling/calendar migrations and Phase 9 multi-connection tests. The harness creates and drops isolated databases and refuses remote hosts.
- New database coverage: role enforcement, disabled workplace, enrollment, revocation/reenrollment, credential rotation/expiry, wrong PIN lookup, durable lockout, active eligibility/archiving, each punch transition, duplicate rejection, retry receipts, preserved original events, corrections/stale revisions/overlaps/invalid breaks, requests, approvals, voids and workplace isolation.
- Native multi-connection coverage observes a real PostgreSQL lock wait, serializes competing punches, confirms a lost-response retry returns exactly the committed receipt, races correction revisions and waits on revocation. Embedded PGlite is used for ordinary migration tests, not as evidence of native concurrency.
- API contract tests use a local synthetic Supabase HTTP fixture to verify origin/cookie/feature gates, server-only PIN hashing, narrow employee responses, challenge hashing, rotation and termination. They do not contact production.
- Unit coverage: scrypt, keyed lookup, leading-zero PIN format, nanosecond interval arithmetic, overnight/fall-back/spring-forward date boundaries, no inferred deductions, voided totals, and CSV injection/escaping.
- `npm run test:time-clock:browser`: Chromium keypad/PIN errors, valid actions, interrupted request with same retry ID, timeout privacy reset, 390/768/1280px overflow checks, same-origin rejection, actual handoff headers, actual middleware workspace denial, public homepage and demo regression. Employee action responses in this UI test are fixtures; SQL security/state transitions are tested separately. Browser screenshots are test artifacts, not live employee data.
- CI now runs the native tests against a disposable PostgreSQL 17 service.
- The Copy Week regression fixture was future-dated because its former “upcoming” shift had expired; fixed DST-specific fixtures remain unchanged.

Run browser checks against a **local** production build with the feature flag, a synthetic pepper/key, a canonical `http://localhost:3000` origin and synthetic Supabase configuration. Chromium defaults to `/usr/bin/chromium`; override `CHROMIUM_PATH` if necessary. Do not point the fixture browser tests at production. Genuine Supabase-auth enrollment/sign-out and hosting-cookie behavior still need staging acceptance on HTTPS; local SQL and mocked UI tests do not establish that deployment integration.

## Manual deployment and acceptance (after separate rollout authorization)

1. Review/merge through the PR only after approval. Keep `TIME_CLOCK_ENABLED=false` while deploying code.
2. Review backup/restore readiness and the jurisdiction's required retention/access policy. Have an authorized operator apply the additive migration manually to the intended database after staging acceptance.
3. Configure the server key, random pepper and exact HTTPS canonical origin. Verify neither secret appears in client bundles, build output, telemetry or error reporting.
4. In staging, test real owner and manager sessions, ordinary employees and two workspaces. Verify local refresh-session revocation, cleared manager cookies/storage, browser back/reload behavior, HttpOnly/Secure/SameSite cookie attributes, direct-RPC rejection for browser roles, expiry, rotation, remote revocation and reconnect.
5. Check actual PostgREST composite-FK relationships for nested breaks, row limits, grants and advisor output. Do not expose the private schema via the Data API.
6. Test real tablet touch/accessibility, server/network interruption, DST corrections, missing clock-outs, exported spreadsheet safety and comparison to published shared shifts.
7. Remove request/response bodies and cookie/auth headers from hosting, observability, error, session-replay and analytics capture on kiosk/enrollment/PIN routes and server actions. Do not add PINs or attendance payloads to logs. Use aggregate error metrics rather than sensitive records.
8. Following explicit rollout approval, enable the runtime flag and only the intended workplace. Have a manager enroll a dedicated device and generate PINs privately. Do not manufacture test punches in live employee records.

## Monitoring, retention and rollback

Monitor aggregate route failure/latency and database contention, device last-activity/expiry, lockout audit counts, unexpected enrollments/revocations, long-open sessions, pending corrections and unapproved cards. Alerting/retention automation is not configured by this PR. Restricted authorized operators can inspect operational metadata without logging PINs, hashes, challenge values or employee attendance payloads.

There is no automated time-history deletion. Ensure managed backups/PITR and restricted archive exports satisfy the business's jurisdiction-specific retention requirements; this phase does not choose a universal retention period or certify compliance. Preserve audit and original punch tables during employee and organization offboarding. Database administrators remain trusted: a superuser can disable triggers or alter schema.

Emergency rollback: set the runtime feature flag false, disable the affected workplace and revoke enrollments through an authorized operational procedure. Revert app code if needed; retain all additive tables, original events and audits. Never drop timekeeping data to roll back code. Disabling collection may leave open sessions; resolve them later through explained manager corrections using independently verified records. Rotating the pepper requires PIN regeneration, and rotating/removing device credentials requires manager reenrollment.

## Physical-location limitations and deferred features

An enrolled browser is authorized to submit punches; that is **not proof of geolocation or physical presence**. Copying a kiosk URL is insufficient, but a stolen browser profile/cookie, compromised device, extension, local browser debugging, remote desktop or a manager enrolling an off-site device can defeat the intended on-site practice. HttpOnly mitigates script access; it is not hardware binding. No browser-only app can lock down OS/browser chrome. Dedicated managed devices, browser/OS kiosk policies and workplace supervision remain necessary. PIN sharing/buddy punching cannot be eliminated with this model.

No GPS, biometrics, facial recognition, continuous tracking or IP/network allowlist is implemented. Verified workplace network restrictions and hardware-backed device binding are future features, not current claims. Automated alerts, bulk PIN issuance, employee self-service PIN changes, long-lived background kiosk renewal, offline punches and very large paginated reports are deferred. Break guidance does not enforce local labor rules. Payroll processing, wage deductions, overtime rules, taxes, wage rates and payroll-provider integration are deferred to Phase 10; current exports are not payroll submissions.
