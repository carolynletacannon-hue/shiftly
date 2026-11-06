# Phase 6: Secure Calendar Subscriptions

Employees can subscribe to their own published shifts without connecting a Google,
Apple, or Microsoft account. Calendar Integration appears on My Schedule using the
existing sage/light theme. Each business has a separate subscription: an employee
in two businesses adds two calendars. The team view never provides a team feed.

## Architecture and publication boundary

- `GET /api/calendar?token=…` is a dynamic Node route returning RFC 5545
  `text/calendar; charset=utf-8`, CRLF lines, escaped text and UTF-8-safe 75-octet
  folding. It bypasses session refresh, never redirects to login, never caches,
  never logs errors/URLs, and returns generic errors. No OAuth is involved.
- `manage_calendar_subscription` checks `auth.uid()`, current membership, linked
  roster identity and archive state. It accepts no target employee parameter.
  Organization-first locking follows the existing lifecycle command convention.
- Only the service role may call `read_calendar_feed`; the route sends a SHA-256
  digest in a POST RPC body, never the raw token. SQL rechecks token expiry, live
  employee connection, archive status and membership on every request. Service
  credentials stay in server modules and never enter the client bundle.
- A private event ledger is derived exclusively from `published_shifts`. Deferred
  row triggers reconcile the final committed assignment state, including approved
  swaps, direct published reassignments, and the existing delete/reinsert publish
  workflow. Draft edits and pending consents never enter the ledger. Existing
  publishing, authorization and swap approval functions are unchanged.
- An event UID is organization + employee roster identity + assignment ID with a
  fixed `@calendar.meadowmark` suffix. It survives changes, token rotation and
  deployments. Shared shifts produce only the subscriber's assignment event.
  Meaningful event changes increment SEQUENCE and update DTSTAMP/LAST-MODIFIED;
  unchanged republishing changes neither. A return to an earlier assignment
  resurrects its UID with a higher sequence.
- Events contain the published shift label, position, business name, existing
  employee-visible shift notes, and a non-secret My Schedule link. No roster
  contact details, private planning/audit payloads or coworker assignments appear.
  The business name is captured at publication; a renamed business updates event
  text when its schedule is next republished.
- UTC DTSTART/DTEND preserve the application's already-resolved instants, including
  overnight shifts and ambiguous/skipped DST handling performed by scheduling.
  Calendar apps display their selected time zone. Historical published shifts and
  cancellation records are retained; there is no rolling-window cutoff.

## Token security, revocation and abuse protection

The server generates 32 cryptographically random bytes (256 bits), URL-safe encoded.
Only the SHA-256 hash is stored in `shiftly_private.calendar_subscriptions`. Raw
URLs are shown once in client memory after successful creation, never persisted in
local storage, cookies or roster queries. Reloading requires regenerating a link
if the employee needs to see it again. Existing external subscriptions keep working.

Rotation atomically replaces the hash; the old URL immediately fails on subsequent
server requests. Revoke deletes the subscription. Archive, account disconnection,
roster removal and membership deletion permanently invalidate it via lifecycle
triggers. Restore/reconnect does not revive an old URL. Profile deletion cascades
subscription deletion. Tokens are long lived (no default expiry); the nullable
`expires_at` also supports an administrative expiry policy. Active expired tokens
are denied. There is one active token per workspace/roster identity.

All three new tables have RLS enabled and no anon/authenticated table grants or
policies. Private trigger helpers have no public execution grants. Public management
functions use invoker wrappers around narrowly authorized private definer functions
with empty search paths, matching this repository's existing conventions. Feed
functions have service-only execution grants, deliberately without a session UID.

Rate limits are transactional across Vercel instances: 120 requests per token per
minute, plus 600 per minute per one of 256 fixed request buckets, including invalid
well-formed tokens. The route hashes Vercel's overwritten `x-vercel-forwarded-for`
header to a bucket; it never persists IPs. Off Vercel, traffic uses a conservative
shared bucket unless a trusted ingress adapter is implemented. Hash collisions and
shared provider egress may share a bucket. Limits return 429 + Retry-After: 60.
Malformed tokens fail cheaply with 404; unexpected database/configuration errors
return 503, not a misleading empty calendar. Database bucket storage is bounded.

### URL privacy is a deployment requirement

A subscription URL is a bearer credential. Query tokens keep secrets out of the
route pathname; query strings still require protection at every logging layer.
The application has no calendar analytics, request logging, or exception reporting.
Feed responses are private/no-store, no-referrer, nosniff, and noindex/noarchive.
The app's global no-referrer policy also covers the controls.

**Before enabling feeds**, exclude `/api/calendar` query strings from Vercel access
logs, log drains, tracing/APM and error reporting. Exclude the private controls from
session replay/DOM capture and server-action response recording. Configure any CDN,
proxy or WAF the same way; never cache the feed or use the complete URL as a metric
label. Verify with a synthetic canary token and controlled requests, not a real
employee URL. Do not paste live URLs into PRs, screenshots, logs or support tickets.
If a provider cannot suppress/redact these fields, keep feeds disabled and use an
ingress with verified redaction. Platform logging cannot be verified from this
repository; it is an explicit deployment blocker, not an assumed guarantee.

Add a Vercel Firewall request rate limit for the constant `/api/calendar` path
before enabling, sized for shared calendar-provider IPs. This protects infrastructure
before database checks, including malformed-token floods. Do not use token-bearing
URLs in rule logs. The durable SQL limits provide application-level protection;
no in-memory limiter or additional external data service is required.

## Calendar setup

Choose **Add to Calendar**, then copy the private HTTPS link while it is visible.
The UI reports link creation or copying only after the operation succeeds. It never
claims that a third-party subscription was installed or synchronized.

- **Google Calendar:** On a computer, next to Other calendars choose **+ → From
  URL**, paste the HTTPS URL, then **Add calendar**. Enable that subscribed calendar
  on signed-in devices as needed. Opening a URL alone does not universally install
  a live Google subscription.
- **Apple Calendar / iCloud:** **Open in Apple Calendar** uses the same feed with
  `webcal://` for compatible handlers. On Mac, **File → New Calendar Subscription**
  also accepts the HTTPS URL; choose iCloud as the location for other Apple devices.
  On iPhone/iPad, use **Settings → Calendar Accounts → Add Account → Other → Add
  Subscribed Calendar** (Settings paths vary by OS version).
- **Outlook:** In Outlook on the web use **Calendar → Add calendar → Subscribe from
  web**, paste the HTTPS URL, name it, and choose **Import**. Desktop Outlook may
  offer **Add Calendar → From Internet**. Use the internet subscription workflow,
  even where its final button is called Import.
- **Other apps:** Use **Subscribe** or **Add calendar from URL** with the HTTPS URL.

A one-time .ics download/import is a static copy. This feature provides subscription
setup, not a separate static export action. External apps choose their refresh
intervals; hours or longer are possible and instant synchronization is not promised.
My Schedule remains the authoritative latest published view.

## Cancellations and interoperability limitations

Removed/reassigned assignments remain as `STATUS:CANCELLED` VEVENT tombstones with
the same UID, original event details, incremented sequence and modified timestamp.
New assignees receive only their own event. Deferred reconciliation avoids false
cancellations from unchanged republishing. Tombstones are retained indefinitely so
clients that poll infrequently can observe them. This adds storage over time; any
future retention policy must account for historical subscriptions and UID reuse.

The feed intentionally omits calendar-level METHOD (it is a subscribed calendar,
not an iTIP invitation/cancellation email). Calendar clients vary in whether they
hide, strike through or retain cancelled entries. Some cache events after a link
is revoked or fails. Revocation stops future server access; it cannot remotely
erase already downloaded data. Remove the subscribed calendar in each client to
clear saved entries. After rotation, replace the subscription in each app and remove
the old calendar to avoid client-side copies. Real Google/Apple/Outlook account
installation and refresh behavior still require manual device validation.

## Migration and deployment (review required)

**Do not deploy enabled feeds before applying the migration. Do not apply it to
production automatically.**

1. Review and apply all existing migrations in chronological order through
   `20261106052138_copy_schedule_week.sql`, if not already installed.
2. Apply only the new additive migration
   **`supabase/migrations/20261106220849_phase6_calendar_integration.sql`** next.
   It creates the three private tables, functions and triggers, then backfills
   existing published snapshots. It does not alter existing rows, drafts,
   publications, invitations, approvals or authorization policies. Its exclusive
   organization lock serializes with existing commands; retry in a quiet window
   if its five-second lock timeout fires. The transaction rolls back on failure.
3. Verify private-schema exposure is disabled and function grants match the SQL.
   Supabase's normal `public` Data API exposure must include the two RPC wrappers.
4. Set server-only `SUPABASE_SERVICE_ROLE_KEY` (existing variable used for optional
   email delivery, now required for calendar feeds). Keep existing Supabase URL and
   publishable key settings. `NEXT_PUBLIC_SITE_URL` must be the canonical HTTPS
   origin with no path, query, fragment or credentials; localhost HTTP deliberately
   cannot generate production subscription links.
5. Complete log redaction and WAF configuration above. Only then set server-only
   **`CALENDAR_FEEDS_ENABLED=true`**. Default is disabled, returning generic 503
   feeds and an unavailable message in My Schedule. Missing migration does not
   break the existing schedule display; calendar controls show unavailable.
6. After deployment is separately authorized, test with synthetic accounts across
   two workspaces. Subscribe in each client, publish/change/swap/cancel a shift,
   wait for its own refresh, and verify regeneration and archive behavior. At
   375px width verify wrapping, selectable URLs, clipboard fallback and webcal
   launch on an actual compatible device. No OAuth, cron job or new email setup
   is required for this feature.

No production migration or deployment was performed during implementation.

## Rollback

Set `CALENDAR_FEEDS_ENABLED=false` to stop all server feed reads, or deploy the
previous app version. Existing downloaded copies can remain in external clients.
Leave the additive database objects in place to preserve UIDs and cancellation
history for a later re-enable. If permanently decommissioning, revoke subscriptions
under a separately reviewed database change; drop only the calendar-specific
triggers, functions and three private tables after stopping readers. Never reset
or delete employee, assignment or publication tables. Keeping the ledger avoids
sequence resets on restoration.

## Verification

Automated test results are recorded below after the final validation run. Tests
use synthetic people and businesses only. `tests/calendar-database.test.ts` applies
the actual migrations to PostgreSQL (PGlite by default; disposable native local
PostgreSQL when `SHIFTLY_TEST_DATABASE_URL` is set). It upgrades existing published
data, verifies grants/RLS, tenant and employee scope, historical snapshots, live
membership checks, invalid/expired/revoked/rotated tokens, archive/disconnect/removal,
shared assignments, pending/approved swaps, publication privacy, meaningful revision
sequencing, unchanged republishing, deletions, empty feeds and durable rate limits.

Serializer/response tests cover overnight/DST/time zones, stable UIDs, cancellation,
error status and privacy headers, escaping and Unicode folding, including parsing
with independent `ical.js`. Interactive DOM tests cover link creation, truthful
failure handling, clipboard fallback/success, confirmation and revocation, platform
controls and unavailable state. DOM tests do not establish mobile pixel layout or
third-party app behavior; use the manual device checks above.

Final implementation validation (November 6, 2026):

- `npm install --cache /workspace/.npm-cache`: passed. A workspace cache was
  necessary because this managed environment's home directory is read-only.
- `npm test`: passed, 101 tests total (94 TypeScript/database tests and 7
  interactive/static React tests), zero failures or skipped tests.
- `npm run typecheck`: passed.
- `NEXT_TELEMETRY_DISABLED=1 npm run build`: passed. Telemetry was disabled to
  avoid Next.js attempting to write its configuration under the read-only home.
- `SHIFTLY_TEST_DATABASE_URL=<disposable-local-db> npm run test:postgres`:
  passed, 13 tests against an isolated PostgreSQL 17 container, including calendar
  upgrade/security tests and existing multi-session scheduling concurrency checks.
  This command is guarded to accept local test databases only.
- Built production server smoke check: disabled anonymous `/api/calendar`
  returned generic 503 with no-store, no-referrer, nosniff and noindex headers.
- `git diff --check`: passed.

No live database was queried or changed. No real employee data was used. Manual
Google/Apple/Outlook installation, refresh behavior, real-device mobile layout,
and deployed log-redaction/WAF configuration remain deployment validation tasks.
