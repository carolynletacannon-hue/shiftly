# Phase 7 email delivery repair

## Failure and fix

On main, `deliverShiftEmails()` silently returned before `claim_shift_emails` if `NEXT_PUBLIC_SITE_URL` was absent or invalid. This was an additional requirement beyond the email flag, Gmail credentials and service key. That pre-claim gate explains how eligible work can retain zero attempts without errors. The supplied production observations rule out an empty/inaccessible queue; they do not expose the site's actual environment value. We have not accessed production configuration, invoked production workers, sent mail or changed production data. Confirm the specific blocked reason in the new logs after a reviewed deployment.

The worker now uses a configured canonical HTTPS `NEXT_PUBLIC_SITE_URL`, or Vercel's trusted `VERCEL_PROJECT_PRODUCTION_URL` when the former is unset. An explicitly invalid value still fails closed and names the configuration failure. Request headers and preview deployment URLs cannot set email links. Local/preview execution is blocked before any database access, irrespective of email credentials and flag.

The existing `after()` usage was structurally correct: it awaits delivery and is registered after a successful database action. The claim RPC already uses service-role permissions, row locks, eligibility predicates and fenced leases; no grant widening or forced queue reset is needed. Successful publication, shift-request and relevant time-off actions now register a shared, logged `after()` callback scoped to their workspace. A workspace layout explicitly selects Node and a 300-second Vercel duration for Server Actions and their callbacks; the protected worker has the same settings. Saved actions remain successful independently of mail failures.

The added scoped RPC has exactly the original queue eligibility predicates, with a workspace filter **inside** the locked claim query. It changes no existing queue data. Browser roles cannot execute it. The global protected endpoint keeps the existing global RPC. SMTP acceptance acknowledgement checks the claim token and verifies a row was actually updated. Diagnostic/result logs contain only fixed event labels, configuration names, sanitized database error codes, statuses and counts; never addresses, messages, IDs, tokens, URLs, credentials or raw errors.

## Review and production verification

This branch disables its own Vercel automatic deployment. Do not merge/deploy until reviewed. No cron job is installed.

1. Apply `supabase/migrations/20261107002017_phase7_email_worker_scope.sql` through your reviewed migration process, first in a disposable test environment, then production when approved. It only adds a service-role-only function; it does not replay, reset or update queue rows. Deploy the reviewed application separately. Confirm Vercel supports the configured duration for the project.
2. In Vercel Production, retain the verified flag and mail/service credentials. Set `NEXT_PUBLIC_SITE_URL` to your canonical HTTPS origin (no path, credentials, query or fragment), **or remove it** to use `VERCEL_PROJECT_PRODUCTION_URL`. A copied `http://localhost:3000` value is invalid in production. Redeploy after environment changes. Confirm Vercel supplies `VERCEL_ENV=production` and the production URL system variable when using the fallback.
3. Sign in as an owner/manager and open **Notifications → Email delivery → Send me a test email**. This is an explicit real delivery to your own verified account only. It does not claim or change the employee queue. Look for `diagnostic_started` and `diagnostic_completed` with `accepted`; check the inbox/spam folder. SMTP acceptance is not proof of inbox arrival. Employees should not see these controls, and direct Server Action calls require owner/manager membership in the requested workspace.
4. Review the eligible queue privately. Then explicitly choose **Retry eligible notifications**, confirming the delivery prompt. This sends up to ten currently eligible queued rows in this workspace, grouped per employee. Check the returned claimed/accepted/acknowledged/suppressed/failure counts and `worker_started`, `queue_claimed`, `delivery_outcome`, `worker_completed` logs. The three previously eligible rows should receive attempts if still eligible; successful acceptance should set `sent_at`. No other workspace should receive claims from this action.
5. Retry immediately: already sent work must not be sent again and active ten-minute leases must not be bypassed. Failed unsent work can be retried after lease expiry, subject to the existing five-attempt cap and seven-day age limit. Skipped/historical/exhausted records are never reset. Preference opt-outs, inactive/disconnected employees, unverified addresses and resolved approvals remain suppressed. SMTP is still at-least-once: acceptance followed by an acknowledgement failure can cause a later duplicate. Investigate `acknowledgement_failed` before retrying such work.
6. For an approved functional check, make a genuine published schedule change or time-off decision for an opted-in, verified recipient. A draft-only change must remain quiet. Expect `worker_scheduled` followed by startup/claim/outcome logs after the action responds. Verify in-app notifications, links and preferences remain correct. These checks intentionally send mail and change business data; perform them only as approved production operations.
7. An operator may still explicitly POST to `/api/shift-request-emails` with the existing bearer `CRON_SECRET`. Missing/incorrect authorization returns 401 without worker execution. Configuration/claim failure returns 503 with a safe reason instead of misleading `{ok:true}`. This endpoint processes all workspaces; use the manager UI for scoped recovery. Do not place the secret in URLs, browser code or screenshots.

If startup is missing, inspect action scheduling logs. `worker_blocked` identifies disabled/non-production, missing configuration, invalid Gmail configuration or invalid site URL. `claim_failed` identifies RPC failures without exposing the underlying private error. Preparation, SMTP and acknowledgement failures have separate events and aggregate counts. Idle queues still need an explicit retry or another successful action; this change adds no unattended scheduler.

Rollback: set `PHASE7_EMAIL_ENABLED=false` and redeploy. This stops claims and diagnostics while preserving in-app notifications, preferences and normal business actions. Leave the additive scoped function installed; no destructive rollback is needed.

## Validation

All automated delivery tests use mocked network/SMTP or disposable embedded PostgreSQL fixtures. No real email, production RPC or production database operation is part of validation. See the pull request for final command results.

Validated in this change:

- `npm install --cache /tmp/meadowmark-npm-cache`: passed.
- `npm test`: 121 passed (112 server/database tests, 9 DOM/render tests).
- `npm run typecheck`: passed.
- `NEXT_TELEMETRY_DISABLED=1 XDG_CONFIG_HOME=/tmp/meadowmark-next-config npm run build`: passed.
- `git diff --check`: passed.
- Scoped RPC tested in disposable embedded PostgreSQL with the complete migration chain, including service-role execution, browser-role denial, workspace isolation and lease exclusion.
- Native multi-session PostgreSQL suite and hosted Supabase advisors were not run; no local native database or hosted test credentials were configured. No production configuration/data or real SMTP was accessed.
