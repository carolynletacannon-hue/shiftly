# Phase 12: Shared Accounts & Multi-Product Foundation

## Architecture reviewed and preserved

Workforce is the existing Next.js App Router application. `lib/supabase/server.ts`
uses the existing Supabase project and cookie-backed SSR client; `proxy.ts`
refreshes sessions through `auth.getUser()`. `lib/auth.ts` validates a user and
queries membership for the requested organization before serving protected pages
or actions. `app/workspaces/actions.ts` rechecks membership before setting the
HTTP-only `shiftly-workspace` preference and redirecting. That cookie is a UI
preference, never proof of access. Existing invitation acceptance and workplace
creation RPCs remain authoritative. No duplicate accounts, forms, or directories
are introduced.

Canonical identities:

| Contract | Existing authority | Boundary |
| --- | --- | --- |
| Account | `auth.users.id` | Verified Supabase identity, never a submitted user ID |
| Workplace | `organizations.id` | Membership checked for each requested organization |
| Membership | `memberships(organization_id,user_id)` | Existing owner, manager, employee roles |
| Employee | `employees.id` and its organization/user association | Employment is distinct from membership; do not duplicate per product |

An account can have memberships in several workplaces. Each employee remains
scoped to its workplace, including when the same user works for two organizations.
Do not merge employee records across organizations. An unlinked employee record
does not create an authenticated account or grant access.

## Registry and user experience

`lib/products/registry.ts` is a dependency-free typed public contract with stable
IDs, names, descriptions, semantic icon identifiers, availability and entry paths.
`productDestination` returns no URL for unreleased products. Icons render in the
UI layer. Workforce retains `/workspaces` and `/workspaces/:id`; Connect and
Hospitality deliberately have null destinations. No deployment origins are
invented. The responsive header switcher shows informational Coming Soon rows.
The account screen uses existing membership queries and existing Server Actions.
The registry is presentation metadata, never an authorization or entitlement API.

## Product permissions and activation design

Phase 12 introduces no new grants or product endpoints. All existing Workforce
permissions and RLS continue to apply, including manager-only actions and
employee self-service rules. Seeing a product in the switcher confers no access.
Owners and managers do not automatically receive permissions in future products.
Connect and Hospitality are unavailable for every role today.

Before releasing another product, add reviewed, additive migrations for:

- `organization_products`: primary key `(organization_id, product_id)`, foreign
  key to organizations, constrained product ID, activation state (inactive,
  active, suspended). Missing records deny access for new products. Keep existing
  Workforce membership access unchanged during backfill and rollout.
- `product_memberships`: primary key `(organization_id, user_id, product_id)`,
  composite foreign keys to both the existing membership and organization-product
  activation. Explicit product-role grants; constrained per-product role catalog.
  Removing workplace membership revokes associated product grants.
- Product-specific capability definitions, such as Connect moderator or
  Hospitality operations manager, distinct from Workforce manager. No generic
  role inheritance and no billing implementation in this phase.

Required authorization is: verified account AND live membership in requested
workplace AND active requested product AND explicit product grant AND the
operation-specific capability. Derive user ID from auth, never payloads. Deny
unknown products, unknown roles, absent grants and suspended activation. A manager
in workplace A cannot activate or grant anything in B; ownership alone does not
imply a product grant. Workplace activation and member grants are separate
administrative operations, audited and reauthorized server-side. A workplace may
activate any subset of products; removing one must not disable the others.

Enable RLS before granting table access. Scope SELECT by current user membership
and organization, expose only own grants (authorized grant administrators may
inspect their workplace). Deny client INSERT/UPDATE/DELETE initially. Later
administration RPCs must enforce capability, active membership, organization and
product constraints, with UPDATE USING and WITH CHECK predicates. Add indexes for
user/organization/product lookups. Use invoker views; any privileged function
needs a fixed search_path and explicit EXECUTE restrictions. Test with real
Postgres roles for cross-organization SELECT, forged payloads, reassignment,
revocation, suspended products and attempts to self-grant. Never rely on editable
user_metadata or stale JWT roles for current permission decisions.

These are design contracts, not installed tables or a working grant service.
They must be implemented and tested before enabling a future product.

## Future separate apps and directory contracts

Keep Workforce in this repository and deployment. Create separate Next.js
repositories/deployments for Connect and Hospitality when work begins; a monorepo
is unnecessary now. Share a small versioned TypeScript contracts package when a
second consumer exists, initially copying/extracting the pure registry. Use one
reviewed migration authority for the shared Supabase project to prevent conflicting
schema ownership. Each app owns its interface and product schema; do not import
Workforce pages or business logic into the other apps.

Connect will own messages, channels and communication permissions. Hospitality
will own operations data and its own capability model. Neither is implemented in
this phase. Both reference canonical organization and employee IDs. They must
query shared directory data through a narrow, versioned, authenticated API or
security-invoker views with explicit column allowlists: organization ID/name,
employee ID/display name and only the minimal active status needed. Do not give
new clients direct access to broad employee queries. API responses must be
no-store and scoped by verified user, workplace, activation and grant.

Never expose wages, payroll, private contact information, absence reasons,
management records, kiosk credentials or calendar tokens through shared directory
contracts. Existing Workforce RLS is not a sufficient product firewall on its own:
a bearer token for the same Supabase project may reach any tables its existing
policies permit. Before launching new apps, audit Data API grants/RLS across the
project, restrict exposed schemas, and use a backend boundary with minimal scoped
queries where product-specific isolation is required. Service-role keys remain
server-side and must not be used to bypass caller authorization in directory APIs.

## Cross-application authentication proposal (not implemented)

Retain Supabase Auth as identity authority. Existing Workforce login, callback,
password reset, invitations and session refresh remain untouched. Do not share
cookies across unrelated origins, put refresh tokens in URLs, or copy browser
storage across apps. Separate apps can initially use the same existing identity
with their own host-only SSR cookies and independently established sessions;
that provides one account without claiming seamless SSO.

For seamless SSO, first validate Supabase's supported OAuth/OIDC authorization
server capability and operational requirements against current official docs.
Register each app as a separate client with exact HTTPS callback allowlists.
Use authorization-code flow with PKCE, state and nonce and a central sign-in
origin backed by the existing Supabase identity. Each app exchanges a short-lived,
one-use code server-side and establishes its own host-only Secure, HttpOnly,
SameSite=Lax session. Validate issuer, audience, signature, expiry and nonce;
prevent open redirects and bind state/verifier to the initiating browser. Do not
assume an arbitrary OAuth client token is a Supabase Data API access token: define
and review the backend/API token audience before enabling database access.

If that supported capability is unsuitable, stop at independent sessions until a
reviewed identity broker backed by existing Supabase users is implemented. Do not
invent a token-transfer endpoint. Stage replay, callback tampering, CSRF, session
rotation, expiry, revocation, multi-tab refresh and cross-product logout tests.
Define local versus global logout explicitly; one app clearing its cookie does
not clear another app's session. Recheck live permissions per operation regardless
of a valid SSO session. Keep session-bearing responses out of CDN caches.

Use distinct staging/production Supabase projects, callback client registrations,
secrets and deployment origins. Allow preview callbacks only explicitly; never
use a wildcard production callback for arbitrary preview deployments. Host-only
cookies remain appropriate even on sibling subdomains.

## Security and compatibility boundaries

No migration is required before merging or deploying Phase 12. No database SQL,
auth changes, new Data API exposure or cross-app SSO are installed here. Payroll,
kiosk and time-clock business logic are untouched. Payroll uses its existing
feature gate, live membership validation and scoped `payroll_input` RPC; wage
records and report exports remain outside the shared directory contract. The
time-clock manager actions retain their role checks and guarded approval rules.
Kiosk mode uses the separate restricted `/kiosk` shell: `proxy.ts` redirects
kiosk-cookie browsers away from account/Workforce pages before normal session
handling. The kiosk API continues to verify device credentials and employee
challenges server-side; neither a kiosk credential nor an employee PIN is a
Meadowmark account identity. The product switcher is only in the normal account
header and is never added to the kiosk shell. Existing navigation continues to
use measured available space, including the new product control, with existing
feature-gated Payroll and Time Clock links intact.

Supabase documentation fetch was denied by this environment's outbound policy;
no new Supabase feature or SDK API is introduced based on unverified guidance.
The SSO proposal requires current-documentation verification before implementation.

## Adding a product

Add a stable literal ID and metadata to the registry with coming-soon status and
null destination first. To make it available, require a real deployed destination,
reviewed activation/grant migrations, server and database authorization, narrow
directory contracts, security tests and the approved authentication design.
Extend the registry destination union for vetted application origins rather than
accepting arbitrary request URLs. UI availability alone must never enable access.

## Deployment and rollback

1. Run `npm install`, `npm test`, `npm run test:postgres`, `npm run typecheck`,
   `npm run build`, `node tests/browser/launch-smoke.cjs`,
   `node tests/browser/navigation-smoke.cjs` and `npm run test:payroll:browser`
   (the latter also runs the kiosk/time-clock browser regression). Browser axe
   tooling is installed separately under `work/browser-tools`. Run browser suites
   sequentially when they share a local port. Review fixture-only browser
   coverage and any unavailable real-service tests.
2. Review the PR and deploy to a staging/preview environment through the normal
   explicit release process. Verify account selection, invitations, workplace
   creation, both roles, multiple organizations, and the switcher at mobile,
   tablet and desktop widths. No new environment variables are needed.
3. Merge/release only after owner review. No production migrations are required
   or applied for this phase. Future activation/grant migrations must be named
   and staged before the PR that depends on them is merged.
4. Roll back by reverting the Phase 12 commit and redeploying the previous build.
   There is no data rollback or session reset. Existing Workforce URLs and
   memberships remain intact.

## Phase 12 verification

- `npm install` completed using a workspace-local npm cache.
- `npm test`: 150 passing tests, including registry/switcher, scheduling,
  employee lifecycle, invitations, requests, payroll privacy, kiosk restrictions,
  timecard approval and organization isolation.
- `npm run test:postgres`: 17 passing tests on a disposable native PostgreSQL 18
  cluster, including concurrent sessions. Only local synthetic data is used.
- `npm run typecheck` and production `npm run build` passed. Build uses
  `NEXT_TELEMETRY_DISABLED=1 XDG_CONFIG_HOME=/workspace/.config` for this sandbox.
- Browser tests use a local HTTP Supabase fixture, not a live hosted project.
  They exercise two roles, multiple workplaces, membership-scoped selection,
  existing action redirects, foreign-organization denial, informational product
  states, responsive layout, keyboard dismissal and WCAG A/AA axe checks.
- Current main's copy-week fixture fix is preserved. A dashboard link underline
  fixes an accessibility issue exposed by the audit.
- Additional browser suites cover responsive measured navigation, payroll reports,
  employee export denial, kiosk isolation, PIN flow and timecard approvals. All
  browser fixtures are synthetic; database suites enforce actual SQL permissions.
