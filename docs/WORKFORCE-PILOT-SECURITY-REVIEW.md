# Workforce pilot security and validation

This public document describes repository changes, synthetic test results and general deployment guidance. Environment-specific review material is excluded. Passing tests does not certify an application or deployment as secure.

## Changes

- Add site-wide framing restrictions through CSP `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- Keep privileged implementations in the repository's private schema, with explicit grants and compatible public security-invoker RPC wrappers.
- Remove ordinary client execution from the profile bootstrap trigger while preserving its trigger binding.
- Enable deny-all RLS for the internal scheduling snapshot table without adding permissive policies.
- Add regression coverage for role enforcement, workplace isolation, invitation lifecycle, personal-data access and upgrade compatibility.
- Disable automatic Vercel Git deployment for this review branch. Other branch settings are unchanged.

Object names and signatures in the migration and tests come from existing repository migrations. Test identities and records are synthetic. This document makes no assertions about any hosted project's configuration or contents.

## Validation

| Check | Result |
| --- | --- |
| `npm install` | Passed; no dependency changes required. |
| `npm test` | 138 TypeScript and 15 TSX tests passed. |
| `npm run test:postgres` | 20 tests passed on disposable native PostgreSQL. A final targeted catalog assertion also passed. |
| `npm run typecheck` | Passed. |
| `npm run build` | Passed. |
| Launch browser smoke | Passed, including response-header assertions. |
| Navigation browser smoke | Passed for synthetic owner/employee sessions at six viewport widths. |
| `npm run test:payroll:browser` | Passed, including the nested kiosk browser suite. |
| `npm audit` | Zero known vulnerabilities at the time of the check. |

The new permission test covers two synthetic workplaces and owner, manager, employee, coworker, outsider and invitation identities. It tests actual SQL grants/RLS and RPC entrypoints, preserves published rows across the migration, verifies profile creation afterward, and populates distinct synthetic wage records before checking access. Browser fixtures exercise Next.js against a local mock service. They do not replace staging tests with real Auth sessions and PostgREST. Native testing used PostgreSQL 18.6; repeat staging checks on the intended deployment's database version.

To reproduce native tests, set `SHIFTLY_TEST_DATABASE_URL` to an administrative connection for a disposable local database. The harness restricts native connections to loopback. Never use a hosted employee database for test execution. Run launch and navigation browser fixtures sequentially because they share local ports.

## Required migration and staging checks

The only new migration is:

`supabase/migrations/20261111231650_workforce_pilot_security.sql`

It preserves existing records and RPC signatures. It relocates existing functions rather than dropping their dependent policies/triggers. It adds no permissive policies and changes no employee accounts, workplace memberships or optional feature flags.

Before any deployment:

1. Review the SQL, privately verify the target database and compare its schema and migration history with the repository. Do not replay earlier migrations or run an unreviewed blanket migration push. Resolve any mismatch before proceeding.
2. Take an encrypted private backup and prove restoration to an isolated target. Keep all dumps and environment-specific review material outside Git, logs and PR attachments.
3. Apply this migration to staging first. It expects the preceding repository schema, including the original function locations; unexpected state should be investigated instead of bypassing errors.
4. With synthetic accounts and real staging JWTs, test compatible RPC calls, authorized management operations, denied employee/foreign-workplace operations, invitation expiry/replay, and private-schema rejection through PostgREST.
5. Verify profile bootstrap, existing records, final response headers, manager routes/exports, and a publish → employee view → coverage consent → manager approval workflow. Also verify a two-employee swap requires consent and manager approval under the selected pilot policy.
6. Confirm the private schema is excluded from the Data API's exposed schemas. Checked private implementations still need the narrow permissions used by invoker wrappers; do not revoke them indiscriminately.
7. Keep the PR unmerged and its branch deployment gate enabled until the owner separately approves deployment. Applying a hosted migration or changing settings is a separate owner-authorized step.

If PostgREST has not refreshed its schema cache after an approved migration, use its supported schema-reload procedure. Do not weaken grants to resolve cache errors.

For rollback, prefer rolling back application code while retaining compatible database hardening. If schema relocation needs reversal, prepare a new reviewed forward migration and test it in staging. Preserve trigger/policy dependencies and narrow grants. Do not reset a live database, use cascading drops, remove records, or restore broad client execution on trigger functions.

## General owner setup

- In Supabase Authentication → Sign In / Providers → Email, review email confirmation, backend password requirements and secure account-change settings. Leaked-password protection is available on Pro and above; enable it only through an owner-approved settings/plan decision. No billing change is required by this PR. See [Supabase password security](https://supabase.com/docs/guides/auth/password-security).
- Verify exact HTTPS Site URL/callback allowlists, Auth rate limits, server-only secrets and separation between test and live credentials. Never include credentials or invitation links in public review artifacts.
- Select hosting that permits the intended use. [Vercel's fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines) restrict Hobby to noncommercial personal use; no-charge business pilots are not automatically eligible. Vercel Pro starts at the [listed $20/month price](https://vercel.com/pricing), with possible seat/usage/tax additions. [Netlify permits commercial projects on Free](https://www.netlify.com/blog/introducing-netlify-free-plan/); its [current pricing](https://www.netlify.com/pricing/) and quotas require review, and moving this Next.js application requires full staging validation. Do not change billing or providers automatically.
- Supabase Free requires an owner-managed backup process; do not assume managed backups or PITR. Follow the [official backup/restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) and the installed CLI version's help. Export roles, application schema/data including private internals, necessary Auth data/custom triggers, and migration history. Back up Storage object bytes separately if used. Keep secrets/configuration in restricted storage outside Git.
- Assign a backup owner and substitute. For a small pilot, back up daily, before migrations and after major schedule changes; retain encrypted off-site copies under a documented retention policy. Verify exit codes, coverage, checksums and decryption privately. Restore to an isolated compatible target before launch and regularly afterward, with outbound mail/jobs disabled. Verify integrity, account links, publication revisions, role denial and a synthetic workflow. Record only non-sensitive drill results. Never test recovery over the live database.

## Small supervised pilot checklist

- [ ] Complete staging acceptance, private configuration review, hosting eligibility and a restoration drill.
- [ ] Designate an owner/backup manager; give regular staff the employee role and link only verified matching accounts.
- [ ] Use minimal display names/contact information and the correct workplace timezone/week start.
- [ ] Enable manager approval for coverage/swaps in the pilot workplace; retain coworker consent and explicit schedule publication.
- [ ] Verify employees can view published schedules, request/accept eligible coverage/swaps and submit their own time off, while management and coworker-private records remain inaccessible.
- [ ] Keep time-off explanations minimal; sensitive health or personal details belong in the existing restricted HR process.
- [ ] Keep the official paper schedule, timekeeping and payroll authoritative. Reconcile approved schedule changes with paper daily and define the outage fallback.
- [ ] Keep kiosk, time clock and payroll optional. Do not change shared deployment flags or disable features used by other workplaces.
- [ ] Set a short pilot period, daily owner review, access-removal procedure and stop conditions for incorrect access or unreliable scheduling.
