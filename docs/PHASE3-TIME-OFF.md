# Phase 3: time off and weekly availability

## Migration gate — do not merge or deploy yet

For an installation with the weekly-setup fix already applied, apply **only**
[`20261106001914_phase3_time_off_availability.sql`](../supabase/migrations/20261106001914_phase3_time_off_availability.sql)
once, before merging or deploying this release. Do not rerun earlier migrations.
This PR stays draft until the database gate has been verified. No hosted SQL or production deployment is performed by this change.
Vercel automatically created previews from the initial branch pushes despite the
`[skip vercel]` tags. `vercel.json` now explicitly disables Git deployments for
`feat/phase3-time-off`; other branches keep their existing settings. Keep that rule
until the schema gate is satisfied. Existing previews require removal in Vercel;
the connected tools cannot delete them. Do not use those previews to validate
Phase 3 against an unmigrated database.

Prerequisites, in order, for a new database:

1. `202611050001_workspaces.sql`
2. `20261105025631_invitation_email_delivery.sql`
3. `20261105035217_phase2_scheduling.sql`
4. `20261105060000_coverage_scheduling.sql`
5. `20261105060001_simple_weekly_scheduling.sql`
6. `20261105060100_reconcile_weekly_setup.sql`
7. `20261106001914_phase3_time_off_availability.sql`

Use the established SQL Editor or CLI migration tracking process. Review the
migration before applying it. It adds tables, indexes, narrowly granted functions,
RLS and assignment/publication triggers. It does not update or delete existing
schedules, published shifts, employees, memberships or invitations. The automated
migration test takes snapshots of those records and verifies preservation.

## Everyday use

Employees open **Time off & availability** from My Schedule. Select a first and
last day (the same date for one day), optionally add a private note, and submit.
Full-day ranges include every selected day. Partial time off is a continuous
period from the first day's start time to the last day's end time, rather than a
repeating daily window. Dates and times use the business timezone. Repeated DST
hours require an explicit earlier/later selection; skipped times are rejected.

Requests show Pending, Approved, Denied or Cancelled. Only pending requests can be
cancelled by their employee. **My weekly availability** has one choice per weekday:
no preference, unavailable, or available between two local times. A single window
ends on the same day; use separate weekday entries for overnight preferences.
Saving replaces the week's preferences atomically. Preferences follow the current
business timezone; stored schedules and approved time-off periods retain their
original timezone/UTC instants.

Managers open **Time-Off Requests** from the weekly calendar; its button shows the
pending count. Each pending card shows employee, dates, private notes and an
existing-assignment warning. **Approve** or **Deny** saves immediately. The same
page lets a manager record approved time off for a placeholder employee without an
account, and remove that manual entry if needed. Linked employees submit their
own requests. Linking an account later preserves records under the roster id.

The manager calendar shows approved time off on each affected day, even before a
draft exists. No private notes are sent to the calendar client. Approved time off
is a **hard conflict**: assignment, time changes, copied assignments and publication
cannot introduce an overlap. Ends are exclusive, so a shift may begin exactly
when time off ends. Availability is an **advisory warning**: managers may keep the
assignment and publish it. Overnight shifts check every local day they touch.

Approving a request does not silently alter existing draft or published shifts.
Existing conflicts are highlighted. A manager can unassign/reassign conflicting
shifts one at a time, then explicitly republish. Editing notes on an existing
conflicting draft does not make it publishable. A per-business database lock
serializes scheduling changes and time-off decisions to avoid approval/assignment
races. Draft edits send no scheduling notifications.

## Private notifications and Gmail

Submission creates an in-app notification for each current owner/manager.
Approval or denial creates one for the linked employee. Recipients see recent
notifications on the time-off page; employees also see their latest decision on
My Schedule. The request status remains the source of truth. These are persistent
notifications rather than push/browser notifications or a realtime subscription.

Email reuses `lib/email/service.ts` and the existing Nodemailer Gmail provider,
TLS settings and `GMAIL_USER` / `GMAIL_APP_PASSWORD`. The existing
`NEXT_PUBLIC_SITE_URL` supplies a canonical workspace login link. No names,
dates, notes, reasons or other recipients appear in email content or previews;
each recipient gets a separate message with no CC list.

Configure **`SUPABASE_SERVICE_ROLE_KEY`** in the trusted server environment for
this same Supabase project to enable the email worker. This is a new, server-only
setting. Never prefix it with `NEXT_PUBLIC_`, commit it, send it to a browser, or
log it. User-facing reads/writes still use the authenticated user's client and RLS.
Only the notification worker uses the key, through two narrowly scoped RPCs. It
is needed so employee sessions cannot obtain manager or coworker email addresses
from Auth. No service role key is required for the time-off workflow itself.

The notification rows commit in the same transaction as the request/decision.
The server attempts email only after that commit. Missing configuration, Gmail
rejection/quota/timeout, worker errors or a failed status write cannot roll it
back; the UI reports that email could not be confirmed. Gmail acceptance is not
an inbox-delivery guarantee. Current membership and recipient ownership are
rechecked when claiming mail; stale submission events and ineligible recipients
are skipped. A record can be claimed only once, so a duplicate worker invocation
does not resend. There is no cron, automatic retry or cross-tenant mail endpoint.

`pending` means no worker attempt was claimed (e.g. missing server configuration
or the process stopped before delivery). `sending` can be uncertain if the process
stopped after claiming or Gmail accepted before a timeout; `failed` and
`unconfigured` are terminal attempt results. Do not automatically reset or retry
these states: Gmail SMTP has no idempotency guarantee. In-app notifications remain
available. For a pending event, an operator can invoke the claim/delivery helper
from a trusted server after configuration is fixed; no public retry control or
recipient address lookup is exposed to employees.

## Access rules

All new tables enable RLS. Employees read only their own requests/preferences and
own notifications within an active membership. Owners/managers read requests and
availability within their business. Authenticated roles have no direct table
write privileges. The command RPC checks membership, organization, linked roster
ownership and allowed status transitions inside the database. Private notes never
appear in the published team schedule. Manual time off is restricted to managers
and owners for employees without accounts. Service-only mail RPCs are inaccessible
to anonymous and authenticated sessions; recipient addresses are never returned by
request/approval RPCs. Private SECURITY DEFINER functions have an empty search path
and explicit grants. There is no new public SECURITY DEFINER function.

## Validation

Run `npm install`, `npm test`, `npm run typecheck`, and `npm run build` with Node 22+.
In restricted environments, `NEXT_TELEMETRY_DISABLED=1 npm run build` avoids writing
Next.js telemetry configuration outside the workspace. Tests use isolated PGlite
Postgres and mocked SMTP; no real employee data, hosted writes or emails.

Coverage includes tenant isolation and private reads; spoofed auth/roster ids;
owner/manager decisions; employee denials of privileged actions; pending-only
cancellation; invalid dates/times/notes; atomic availability replacement; full-day
DST boundaries; hard conflict assignment and publication rollback; repair of
existing conflicting assignments; advisory preferences; placeholders before and
after verified invitation linking; private recipient claims and single-attempt
email delivery; missing configuration and SMTP failures. Existing scheduling,
weekly setup, invitation and Gmail provider tests continue to run.

After the migration gate is satisfied and a deployment is separately authorized,
use controlled accounts in two test businesses to smoke-test hosted RLS and Auth:
submit a full/partial request, review with a manager, cancel a pending request,
record placeholder time off, set Sunday unavailable, and verify calendar hard vs
advisory behavior. Test a real controlled Gmail recipient, then a simulated missing
SMTP configuration; the saved decision must remain valid. Hosted Gmail delivery
cannot be proven by the mocked tests.
