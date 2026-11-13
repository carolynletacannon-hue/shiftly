# Phase 13C1 Passalong migration handoff

Workforce (`carolynletacannon-hue/shiftly`) is the sole migration authority.

- Source: [Connect draft PR #2](https://github.com/carolynletacannon-hue/Meadowmark-connect/pull/2), commit `bf349f34510c20905452e5627729cf3a1362b283`, `docs/database/passalong.sql`.
- Reviewed Workforce baseline: `656a8ef1503d55bac6c4d18cba3703065ebbe668`, including Connect foundation, Workforce pilot security, and employee colors.
- Migration: `20261112235952_phase13c1_passalong.sql`, generated with `supabase migration new phase13c1_passalong` using CLI **2.81.3**. Only provenance comments and transaction-local lock/statement timeouts differ from the reviewed SQL artifact.

The migration adds five private RLS tables (settings, categories, notes, comments and history), indexes, a checked private definer, and `public.connect_passalong_v1(uuid,text,jsonb)` as an invoker wrapper. Private tables have no client policies or table/sequence grants. Authenticated callers can execute the private function because the invoker wrapper requires it; direct calls enforce the same live authorization boundary. Keep `connect_private` out of the Data API's exposed schemas.

Every command checks account identity, anonymous-account status, current membership, explicit Connect grant, organization activation and release availability. Only Connect moderators manage settings/categories. Workforce owner/manager status does not imply Connect access. Account and employee attribution are derived in SQL. Individual accounts are the only supported mode; workstation/hybrid settings are rejected.

No existing Workforce functions, policies, employee colors, credentials, release gates, activations or grants are changed. Existing colors and identity rows survive the upgrade. There are no new application environment variables or secrets. Do not apply Connect's SQL artifact separately after applying this migration.

## Local verification

`npm test` exercises the migration and authorization contract using embedded PostgreSQL. `npm run test:postgres`, with `SHIFTLY_TEST_DATABASE_URL` pointing to a disposable **loopback-only** PostgreSQL admin connection, repeats the contract on native PostgreSQL and runs six independent authenticated comment sessions to verify serialization, activity bumps and counts. Each test creates and drops its own synthetic database. The existing CI PostgreSQL service runs this suite.

The Passalong suite upgrades an existing Workforce database with saved colors, compares shared functions/policies/identity/release records before and after, checks RLS and grants under Supabase-shaped default function privileges, tests attribution, editing/revisions, pinning, resolution, archived categories, filters, comments, audit history and failed-write rollback, cross-workplace denial, direct private calls, all-command revocation, anonymous denial and unchanged Workforce membership. Existing employee color, Connect and pilot security suites remain part of validation.

## Required deployment steps — future operator work

No hosted migration, merge, deployment or production activation is authorized by this preparation PR.

1. Review this PR with Connect draft PR #2. Record the migration filename, baseline and approved application commit in the release ticket. Reconcile the target's migration history against Workforce first; do not use schema push or apply the Connect review artifact directly.
2. Apply the reviewed Workforce migration to disposable staging through the normal Workforce migration process, with Connect release disabled. Confirm prerequisites through employee colors are installed and `connect_private` is not exposed via the Data API. Run security/performance advisors and review findings privately; verify release, activation and product grants are unchanged. The migration fails rather than waiting indefinitely for locks (5-second lock timeout, 60-second statement timeout); investigate and retry through normal migration tooling if needed.
3. Validate Connect against staging using its existing staging origin, Supabase configuration and auth callbacks. Use explicit synthetic pilot grants and enable only staging gates. Run Connect's auth/browser/application checks, two-workplace and revocation scenarios, and Workforce regression/browser checks. Hosted authentication/advisor behavior is not established by local SQL fixtures. Supabase's changelog fetch was blocked by this environment's network policy; review relevant release notes before hosted application. Current RLS/function documentation was reviewed via the documentation connector.
4. Resolve the existing shared-project API isolation prerequisite before any public launch. Obtain a separate production release decision. Apply the approved additive migration through Workforce while production Connect remains disabled; verify migration/advisor results. Coordinate owner-approved merges and explicit application deployment with Connect's documented release order (staging acceptance, approved production migration verification, merge, deployment).
5. Smoke-test the approved application with release still disabled. Production release availability, organization activation, explicit product grants and switcher destinations require a separate release decision. C1 does not authorize workstation/hybrid access; that requires Phase 13C2.

Rollback: disable Connect availability or suspend the affected organization, explicitly redeploy the prior approved application, and preserve all additive data/history. Destructive rollback requires a separately reviewed migration.
