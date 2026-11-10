# Phase 13A: Connect integration foundation

## Scope and release boundary

Workforce remains the existing application and sole migration authority for the
shared database. This change adds no messaging, channels, handoffs, tasks,
announcements, payments, subscriptions or guest records. The Phase 12 registry
and switcher remain unchanged: Connect is Coming Soon with no destination.
No existing users, organizations, memberships, employees, policies, payroll,
timekeeping, kiosk credentials or sessions are migrated or replaced.

Three independent database conditions must hold before Connect v1 can be used:
`product_releases.available`, organization activation `state='active'`, and an
explicit product membership. The release row starts false and no activations or
grants are seeded. A valid Supabase session alone does not satisfy these checks.
Workforce continues to use existing workplace membership with no entitlement
requirement. Hospitality and unknown products cannot be provisioned here.

## Recommended shared authentication

Start with **independent sessions using the existing Supabase Auth project**.
Each Next.js app uses pinned compatible `@supabase/ssr` and `supabase-js` versions,
its own server/browser clients, and its own host-only cookie storage. Existing
accounts sign in with their existing credentials; do not recreate users or match
accounts by email. Validate the user with `getUser()` on the server, refresh via
Next.js proxy, then check live Connect permissions on every operation. Never
use `getSession()` or editable user metadata as authorization evidence.

Connect should implement its own login, recovery and callback using Supabase's
supported SSR flow. OAuth or PKCE email sign-in must start in Connect so the
verifier is available to its callback. Exchange the short-lived code using
`exchangeCodeForSession`, remove code parameters by redirecting to a clean local
path, and reject arbitrary external `next` URLs. Password login can establish a
session directly. Explicitly allowlist each real HTTPS callback in Supabase;
verify recovery and email templates route to the app that initiated the flow
without changing existing Workforce email behavior. Do not assume a template
hard-coded to Workforce supports Connect. Use separate development cookie names
if both applications run on localhost (cookies do not isolate by port).

Cookies default to host-only; do not set a parent-domain cookie. Retain SSR SDK
cookie compatibility between the app's browser and server clients. Use Secure
cookies in production and SameSite protections. Do not blindly force HttpOnly
on cookies that the standard Supabase browser client must read; a fully HttpOnly
session requires a separate backend-only architecture. Authenticated responses
must use `Cache-Control: private, no-store`, including errors; never cache by
organization alone. No cross-origin Workforce API or CORS configuration is needed
for the initial design: Connect's server calls Supabase with the caller's session.
No service-role key is needed for the runtime directory.

This provides one account, **not seamless SSO**. Unrelated domains cannot share
cookies or local storage. Never forward access tokens, refresh tokens, passwords,
or copied sessions through URLs, postMessage, redirects or a handoff endpoint.
An app-local cookie clear does not clear another app's cookie. Choose Supabase
local-session sign-out for app-only logout; global sign-out invalidates refresh
sessions across apps but already-issued JWTs can remain valid until expiry.
Product revocation below is checked in live database state and does not depend
on JWT role freshness.

Supported alternatives assessed:

| Option | Decision |
| --- | --- |
| Independent Supabase SSR sessions | Recommended incremental first release; existing identity, separate login per app |
| Same parent-domain cookies | Possible only on controlled sibling domains, increases trust scope and refresh coordination; not implemented |
| Supabase OAuth 2.1/OIDC server | Supported documented capability; evaluate later as a separate SSO project |
| Existing external IdP sign-in in each app | May reuse the upstream provider login, but each app still establishes its own Supabase session |
| Custom identity provider/token transfer | Not needed and not implemented |

The official OAuth server docs describe registered clients, an authorization UI,
consent, authorization-code + PKCE and refresh flows. Third-party OAuth client
flows are not implemented by simply using the ordinary Supabase SSR login helper.
Before adopting it, verify project availability, client token audience/scopes,
Data API compatibility, issuer/signature/expiry/nonce validation, state binding,
replay prevention, exact callback registration, consent and logout behavior in
staging. Do not promise seamless SSO from sharing a project URL.

Documentation consulted through the Supabase documentation search tool:
- https://supabase.com/docs/guides/auth/server-side/nextjs
- https://supabase.com/docs/guides/auth/oauth-server/oauth-flows
- https://supabase.com/docs/guides/auth/oauth-server/getting-started

The required changelog-index fetch was attempted but returned HTTP 403 under the
environment policy. No new Auth SDK flow or identity provider is implemented by
this phase; recheck the changelog before implementing Connect authentication.

## Version 1 contracts

`lib/connect/contracts.ts` is dependency-free and initially copied verbatim into
the separate repository at the reviewed foundation commit. Record that commit in
Connect; extract a small versioned package when both consumers need updates.
Do not import Workforce UI, payroll or kiosk modules. Add v2 RPCs/types for
breaking changes and keep v1 during a coordinated consumer migration.

| Identity | Authority and meaning |
| --- | --- |
| account_id | Verified `auth.users.id`; never supplied as a directory argument |
| organization_id | Existing `organizations.id`; caller must have live membership |
| employee_id | Existing workplace-scoped `employees.id`; never assume it equals account ID |
| membership | Existing `(organization_id,user_id)` workplace association |
| Connect role | Explicit `member` or `moderator`, independent of Workforce role |

`connect_context_v1(org)` returns JSON with version `"1"`, caller account ID,
organization ID/name/timezone, caller's active linked employee ID (nullable), and
Connect role. Membership can exist without an active linked employee. An
unlinked employee does not create an account or grant access. Archived identities
are never returned as active identities. The same account in two workplaces has
two independently checked associations; retain canonical IDs without merging.

`connect_directory_v1(org)` returns only `organization_id`, `employee_id`, and
`display_name` for active employees of that organization, including unlinked
roster people. It intentionally supplies neither other users' account IDs nor
emails. A roster entry is not proof that someone can receive a direct message;
future recipient resolution needs its own scoped permission contract.

No contact details, pay rates, payroll data, PIN hashes, device credentials,
calendar tokens, absence reasons, archived employee records or `select *` employee
projection are exposed. The server-only `connectDirectory` helper validates the
caller and delegates to both authorized RPCs using the caller client. It creates
no public HTTP endpoint and no deployment URL. When used in Connect, expose only
allowlisted response fields, handle authorization errors as 403, and set no-store
on every response. Never persist/cache an authorization result across requests.
A permission change racing an in-flight read cannot retract a response already
read; subsequent RPC statements recheck live state.

## Database permissions and administration

Migration: `supabase/migrations/20261110054258_phase13a_connect_foundation.sql`.
Apply after all earlier migrations to a disposable local database and staging
before an explicit production migration approval. Nothing is applied to hosted
projects by this task.

New tables have RLS and explicit read grants; there are **no client write grants**.
Authenticated users can inspect release metadata, activations for their own
workplaces, and their own product grants. Composite foreign keys bind grants to
both workplace membership and workplace activation. Membership deletion cascades
grants; restoring membership does not restore a deleted grant. Activation delete
also cascades grants. Missing/inactive/suspended activation, unavailable release,
missing grant, unauthenticated callers and foreign workplaces fail closed.

Narrow security-definer implementations live in the existing non-exposed
`shiftly_private` schema, use an empty search path, derive the caller via
`auth.uid()`, and check all three gates plus live membership before projecting
allowed fields. Public RPC wrappers use security invoker. EXECUTE defaults are
revoked and explicitly granted only to authenticated callers. Do not expose the
private schema in Data API settings. Direct private function calls have the same
authorization as wrappers. This privilege boundary avoids new broad table grants.

Roles define future capabilities in the contract: both roles read the directory
and participate; moderator additionally moderates communication. These definitions
implement no communication actions yet. Future actions must enforce their required
capability in both server code and database policies/functions. Moderator does
not grant product administration, payroll access or Workforce manager powers.

Initial provisioning is **manual trusted-operator SQL only**; no self-service UI,
service-role browser use, or automatic grants. Owners/managers cannot self-grant.
Review provisioning requests and retain the SQL operator audit trail externally;
an in-app audited administration workflow is future work. Use actual UUIDs in
reviewed parameterized SQL. Staging example, after a real deployment is verified:

```sql
begin;
insert into public.organization_products(organization_id,product_id,state)
values (:organization_id,'connect','active');
insert into public.product_memberships(organization_id,user_id,product_id,role)
values (:organization_id,:user_id,'connect','member');
-- Only the separately approved release step may enable this global gate:
-- update public.product_releases set available=true where product_id='connect';
commit;
```

Revoke an individual by deleting their product membership. Suspend a workplace by
setting its activation state to `suspended`. Disable Connect globally by setting
its release availability false. None of these affects Workforce. Restoring
activation intentionally resumes retained grants; inspect those grants first.
Do not enable the global gate in production during Phase 13A.

### Shared-project isolation limitation / launch prerequisite

A normal Supabase session is project-wide. Existing Workforce RLS may allow a
Connect-authenticated manager to call existing Workforce APIs directly. This
phase adds no such grants and the directory exposes no sensitive fields, but
neither a publishable key nor a Next.js route is a product-specific firewall.
Do not claim that adding these tables restricts existing APIs by application.

Before any Connect launch, audit existing Data API grants/RLS, RPC EXECUTE,
exposed schemas and sensitive APIs. If the requirement is to prevent a Connect
session from exercising existing Workforce rights, launch is blocked until a
separately reviewed supported token/client boundary or backend isolation design
is implemented and tested. Preserve Workforce rights during that work. Do not
solve this by shipping a service-role key to Connect or by weakening Workforce
permissions. A dedicated backend alone does not restrict an ordinary user token
that can still call Supabase directly.

## Separate repository and deployment: manual next steps

1. Review this PR and its checks. Keep this repository the migration authority.
   Create a separate private GitHub repository (suggested name
   `meadowmark-connect`) under the desired owner; do not fork Workforce business
   modules. No repository, paid resource or deployment is created by this phase.
2. Scaffold a Next.js App Router TypeScript app. Pin compatible dependencies and
   commit its lockfile. Copy the v1 contracts and caller-scoped SSR/RPC helper,
   record their source commit, and implement independent auth as described above.
3. Create a separate Vercel project connected to that repository, after owner
   approval. Use a distinct staging Supabase project shared with staging
   Workforce; never attach arbitrary previews to production credentials.
4. Configure Connect `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to the matching shared identity project.
   Use a server-validated app origin variable for callback generation (for
   example `CONNECT_APP_ORIGIN`); allowlist exact staging/production HTTPS
   callbacks separately. These are future Connect variables. Workforce requires
   **no new environment variables** for Phase 13A. No service-role secret is
   required by this foundation. Never place one in `NEXT_PUBLIC_*`.
5. Apply the migration to staging via the existing reviewed migration process.
   Confirm the release is false and new activation/grant tables empty. Run
   Supabase database security advisors on staging and review every new finding.
6. Resolve the shared-project API isolation prerequisite above. Implement the
   Connect authenticated workplace selector, denied/unavailable screen and a
   directory-only integration screen before communication features. Test all
   authentication and revocation paths before granting pilot access.
7. In staging only, provision synthetic workplaces and explicit pilot grants,
   then enable the staging release gate. Exercise verification below. Keep
   production unavailable until a separate release decision.
8. Only after real deployment, isolation review, auth verification and explicit
   release approval, propose the production migration/provisioning and a separate
   registry change for the vetted Connect origin. Never set a placeholder URL.
9. Build Connect-owned channels/DMs, handoffs, follow-up tasks and announcements
   in later phases with organization-scoped data, operation-specific capabilities
   and RLS tests. Reference shared IDs; do not duplicate employee/account records.

## Staging verification and rollback

Run `npm install`, `npm test`, `npm run typecheck`, `npm run build`, and
`SHIFTLY_TEST_DATABASE_URL=<disposable-local-admin-url> npm run test:postgres`.
Native tests create/drop isolated databases and refuse non-local hosts. Run the
existing launch/navigation/time-clock/payroll browser suites sequentially.
Fixtures must remain synthetic.

In staging verify two separate deployed origins and two workplaces: existing
user login/recovery, PKCE failure/replay, invalid callback/redirect, local/global
logout, expiry/refresh, membership deletion/reinvite, product grant deletion,
suspension/re-enable and global disable. Confirm unlinked/archived employees,
workplace-scoped employee identity, zero sensitive directory columns, manager
without Connect access, member vs moderator, anon denial and forged organization
requests. Check direct RPC requests as well as UI. Verify Workforce invitation,
scheduling/publication, time off, payroll, timecards and kiosk behavior without
any product rows. Check proxy/error responses and directory routes are no-store.
Real provider email and hosted SSO flows require manual staging verification.

Rollback first sets Connect release availability false; revoke pilot grants or
suspend organizations as needed. Roll back the app commit and redeploy the last
approved build through the explicit release workflow. Prefer retaining additive
tables for investigation. If removal is necessary after confirming no consumers,
use a separately reviewed migration: drop public v1 wrappers, then private v1
functions, then product_memberships, organization_products, product_releases.
Do not use CASCADE against shared identities. No account recreation, auth reset,
employee restoration, Workforce backfill or payroll rollback is required.

## Local verification results

Verified: `npm install`; `npm test` (151 passing tests); native PostgreSQL 18
`npm run test:postgres` (18 passing tests, including Connect); typecheck; production
build; launch and navigation browser suites; and the payroll browser suite, which
also runs the time-clock/kiosk suite. Native PostgreSQL binaries were installed
under ignored `work/` through `embedded-postgres`; no system or hosted database
was changed. Browser checks use the existing local
synthetic Supabase fixture; they do not prove hosted authentication delivery,
production RLS configuration or seamless SSO. Hosted staging migration/advisor
checks and authentication verification remain manual release prerequisites.
