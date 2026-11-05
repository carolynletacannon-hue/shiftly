# Simple weekly scheduling and independent employee roster

## Manager workflow

1. Create a business with its name (Mountain time defaults; change timezone if needed).
2. Add employee names on **Employees**. Email, contact information and invitations are optional. Each name becomes schedulable immediately.
3. Open **Set Up Weekly Schedule**. Choose templates or custom local times, check weekdays or **Every day**, and choose staffing counts. Save once. Three shifts × seven days × one employee produces 21 slots.
4. The first calendar opens with its generated draft. Click a shift, choose an employee or Unassigned, and save. Coverage and actual weekly hours include roster-only employees.
5. Review and publish explicitly. Empty slots stay in the manager draft; incomplete publication still requires explicit confirmation. Later edits remain private until republished.

**Set Up Weekly Schedule** edits future coverage in bulk; **Advanced settings** retains individual rules, templates, positions and workload settings. **Administration** retains membership roles, workspace settings and invitations. The default workspace entry opens the calendar (or My Schedule for employees). `/demo` remains fictional.

## Migration gate — apply before merging/deploying this PR

Do not merge or enable auto-merge until the migration is applied and validated. No live schema or production records were changed during implementation.

Migration: `supabase/migrations/20261105060001_simple_weekly_scheduling.sql`.
It was created with the Supabase CLI and its generated timestamp was advanced to follow the existing coverage migration, whose timestamp was ahead of the execution clock. Apply all prior repository migrations in their established order first.

Before applying, take a database backup and compare the target schema with the four existing migration files. The target inspected during implementation already has `schedules`, `shifts`, `published_shifts`, templates and coverage requirements. This migration expects their current foreign-key names and fails transactionally if they differ; do not improvise destructive fixes.

The migration runs in one transaction:

- Adds `employees` with a composite `(organization_id,id)` key. Existing memberships backfill with `id=user_id` and the existing profile name; blank names use “Team member”. No profile or membership row is rewritten.
- Adds roster entries for any historical publication whose account no longer has a membership. Such a roster row does not restore access.
- Replaces only the assignment foreign keys with same-business roster foreign keys. Existing draft/published `employee_id`, shift IDs, times, notes, revisions and snapshots stay unchanged.
- Adds nullable invitation targets, tenant-scoped references, RLS, restricted column grants and private RPC implementations. Old invitations remain usable with their original verified-email semantics.
- Adds a membership trigger to create roster records for future ordinary invitations/new owners. Targeted invitations link before adding membership, avoiding duplicate roster entries.
- Adds versioned atomic weekly setup. Saving pauses old requirements rather than removing records referenced by saved shifts. Nothing regenerates existing weeks. Creating a new draft continues through the existing validated, locked, revision-aware scheduling command.

Check row counts and assignments before/after:

```sql
select count(*) from public.memberships;
select count(*), count(employee_id) from public.shifts;
select count(*), count(employee_id) from public.published_shifts;
select count(*) from public.memberships m
left join public.employees e on e.organization_id=m.organization_id and e.user_id=m.user_id
where e.id is null; -- expected 0
select count(*) from public.shifts s
left join public.employees e on e.organization_id=s.organization_id and e.id=s.employee_id
where s.employee_id is not null and e.id is null; -- expected 0
```

Also compare pre/post exported shift rows, not only counts. Run Supabase security advisors on the migrated target; the local Postgres tests verify RLS, grants and linking behavior but do not substitute for target advisors. Smoke-test the manager workflow with a synthetic employee, then revoke the test invitation. Deploy the PR only after these checks.

For rollback, keep the migrated schema and redeploy only compatible application code. Do not restore the former profile-based assignment foreign keys after roster-only shifts exist. Use a forward repair or restore a coordinated database/application backup if necessary.

## Identity and permissions

A roster name/contact address never creates Auth users, memberships or roles. Schedulable identities live in `employees`; authorization stays in `memberships`. Contacts are available only through a manager-authorized RPC; ordinary members can see team names/account identifiers consistent with the existing team schedule.

A manager targets an exact roster record and an invitation email; the existing invitation service still handles hashed random tokens, cooldowns, hourly limits, email delivery and manual-copy fallback. Roster invitations always grant employee access. Acceptance reads the verified email from `auth.users`, locks the organization/invitation/roster, checks the token, expiry, revocation and email, and links the existing roster identity atomically. Names are never matched. Unique `(organization_id,user_id)` prevents a second roster link within a business, while independent authorized memberships in multiple businesses remain supported. An already-linked account cannot claim a second placeholder; there is deliberately no automatic merge.

Invitation state is derived from active, unexpired, unaccepted invitations: **Roster only**, **Invited**, or **Connected**. Resending a targeted invitation preserves its target. Existing membership roles are never replaced during acceptance. Auth linking never changes shift assignment IDs.

## Validation

- `npm install --cache /tmp/shiftly-npm-cache`
- `npm run typecheck`, plus compiler API diagnostics to verify TypeScript in this executor.
- `npm test`; additionally `node --conditions=react-server --import tsx --test --test-isolation=none tests/*.test.ts` executes all 49 individual checks without subprocess isolation (the executor's isolated runner otherwise reports only file-level results).
- `NEXT_TELEMETRY_DISABLED=1 npm run build` (telemetry disabled to avoid writing outside the workspace).

Next uses the installed TypeScript 5 compiler API for its build check; this avoids a subprocess CLI output-parsing failure in the executor and retains build-time type checking.

Tests cover pre-existing memberships and draft/published assignments across migration; placeholder creation, assignment, totals, unassignment and publication; 21-rule bulk generation; atomic invalid-input rollback and stale configuration; verified linking, mismatched/unverified email, token replay, duplicate links, tenant isolation, anonymous/employee denials; existing time, overlap, DST, publish, revisions, invitation throttling and email delivery behavior.

No live Auth/browser end-to-end session was available. Before merge, verify onboarding, mobile checkbox/dropdown behavior, printing and authenticated page loading against the migrated staging/target database.
