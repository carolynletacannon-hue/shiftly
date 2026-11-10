# Persistent workplace kiosks

## Rollout (manual; no production migration was run)

1. Review and apply `supabase/migrations/20261110013442_persistent_kiosk_authorization.sql` to a disposable/staging Supabase database after all existing migrations. Generated using `supabase migration new persistent_kiosk_authorization` with CLI 2.81.3. Review staging database advisors, grants and RLS before production approval.
2. Deploy the application change to staging and exercise activation, PIN/punch, renewal, restart, explicit exit, and remote revocation. No additional environment variables are required. Keep the existing cryptographically random `TIME_CLOCK_PIN_PEPPER` stable across instances: it now also derives credential successors with a separate HMAC domain. Never send it to a browser. Supabase documentation/changelog fetches were blocked by the environment; the existing function API and grants were verified with local SQL tests.
3. After a separate production approval, apply the additive migration before deploying the application. Do not run database tests against hosted/production databases. Keep the database change when rolling back application code; a legacy application rollback restores its short cookie behavior, so prefer a forward fix.
4. Open existing kiosks after rollout to renew their legacy cookies, or leave active screens running for their next hourly rotation. Existing stored credentials, ownership, enrollment IDs, revocations, PINs, audit and attendance records are preserved. Previously timed-out database enrollments with a retained valid cookie resume without a manager. Already deleted/expired browser cookies cannot be recovered from their server-side hashes; those browsers require a fresh manager activation.

The migration keeps the legacy `expires_at` column nullable for compatibility, clears it on unrevoked devices, removes its default, and removes the deadline from authorization. It adds a unique pending credential hash to the private credential table and replaces only the service-role kiosk function. Existing service-only grants, empty search path, workplace locks, settings checks, employee membership checks, throttles and PIN lockouts remain enforced. No new public grants or tables are introduced.

## Credential renewal and security

Activation still requires an authenticated owner/manager in the correct workplace. It issues a random device credential, revokes the activating account's local refresh session, clears account cookies and cached account state, then enters the isolated kiosk. The manager is never restored on exit.

The browser holds only a Secure, HttpOnly, host-only, SameSite=Strict kiosk cookie. The database stores current/pending SHA-256 hashes, never raw kiosk tokens. On startup and hourly, the server derives a pseudorandom successor using HMAC-SHA-256 with the server pepper and the current secret. This makes concurrent/lost-response retries for the same generation return the same candidate without making it predictable from a stolen device secret alone.

Rotation stages the candidate hash; the current credential stays valid until a later request presents the candidate. That request atomically promotes the candidate and retires the old credential under the existing workplace/device locks. Retired credentials cannot punch or rotate. Failed renewal requests do not clear cookies, expire enrollment, or revoke the device. Renewal and exit use Web Locks where supported to serialize cookie-changing responses across tabs; queued renewal is skipped once exit starts. Requests time out after 15 seconds so an interrupted renewal cannot block exit indefinitely. Prefer one dedicated kiosk tab/profile; older browsers without Web Locks should use one tab. Reload and browser restart use the durable cookie without any account session. A discarded renewal response is safe both before and after acknowledgement.

Browser cookie storage is finite: browsers cap persistence at 400 days, renewed on startup/hourly operation. This is a browser retention limit, not a server enrollment deadline. Clearing the browser profile/storage, blocking cookies, or leaving it closed beyond browser retention can require manager activation. Brief outages or closing the browser for multiple days do not expire enrollment. No offline punches are fabricated or queued; reconnect and retry the existing punch request to obtain its idempotent receipt.

A current bearer credential is sensitive. Dedicated managed devices, HTTPS, host isolation, server-only secrets, same-origin requests, revocation, credential retirement and PIN limits remain required. Device credentials confer no manager permissions. PINs stay four digits; individual employee challenges expire after 30 seconds and are consumed by a successful punch. Inactivity clears employee identity/actions. Revocation is checked before punch receipt lookup as well as before new punches, so a displayed screen or old receipt cannot bypass revocation.

Pepper replacement remains an exceptional security operation: regenerate affected PINs as before. If an unacknowledged candidate was derived using the old pepper, do not silently overwrite it: renewal reports pending while current credential use remains available. Coordinate pepper replacement with device acknowledgement, or explicitly revoke and reactivate affected devices. Service-role API key rotation does not change the credential derivation key.

## Exit and recovery

When reachable, End Kiosk Mode revokes the enrollment in SQL before clearing cookies. Exit bypasses PIN/request throttles and workplace/global feature switches, while still checking the credential and revocation. All kiosk and Supabase account cookies are cleared, cache/storage are cleared, and hard navigation returns to `/login`. Invalid/revoked credentials can always clear local mode. Proxy rules allow kiosk API routes without redirecting, and cookie removal prevents login loops.

If Supabase is unavailable but the application server is reachable, exit still clears local credentials and returns to login. A manager should remotely revoke the orphaned enrollment once the backend returns; local deletion cannot revoke a server record during a database outage. If the entire site is unreachable, a non-secret local exit marker locks the screen, clears displayed employee data/actions and survives reloads. It retries exit on reconnection/startup or every 30 seconds, then clears cookies and returns to login. It never reenrolls a device or restores an account. The marker is a local recovery aid, not an authorization mechanism; server checks remain mandatory.

## Validation

- `npm install --cache /tmp/meadowmark-npm`
- `npm test` (includes real embedded PostgreSQL migrations, authorization, legacy migration upgrade, 13-hour/7-day/90-day devices, expired challenges, staged/acknowledged renewal, retired-token replay, exit despite throttling/disabled settings, and remote revocation).
- `npm run typecheck`
- `NEXT_TELEMETRY_DISABLED=1 npm run build`
- Run the production server locally with synthetic time-clock feature settings, then `node tests/time-clock-browser.mjs`. Covers lost rotation responses, reload, persistent cookie restoration in a new browser context without account cookies, PIN privacy/inactivity, local exit lock across reload, delayed rotation/exit ordering, login redirects, responsive screens and existing punch flows.

Hosted Supabase staging acceptance and advisors remain operator deployment steps; no hosted SQL or deployment was performed by this change.
