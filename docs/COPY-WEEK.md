# Copy Week

Managers and owners can open **Copy Week** on the weekly schedule, choose any saved source week and a destination, then preview and confirm. The default source is the previous week; the default destination is the viewed week. The source is explicitly the saved working schedule, including open places, rather than a published snapshot that might omit draft work.

- **Structure and assignments** preserves shared shift identity within the new week, labels, positions, local times, notes, recurring requirement/template links, staffing counts, overstaffing policy and every participating employee.
- **Structure only** copies the same shifts and staffing places without adding employees. Merge keeps destination employees; Replace produces an unassigned draft.
- **Assignments only** matches destination shared shifts by label, position and shifted start/end instants. It leaves destination structure and staffing policy intact. It can add assignment places to an existing shared shift where overstaffing permits, but never creates a new shared shift. Unmatched or full shifts are reported.

**Merge** keeps existing work, matches equivalent groups one-to-one, recognizes existing employee assignments, and fills open places or adds compatible assignment places. Copy lineage stabilizes matching of otherwise identical groups on repeat runs. **Replace** removes only destination draft assignment slots; it requires a preview and an explicit checkbox confirmation. Previous groups remain as historical identities, and the complete previous draft and group policies are retained in a manager-only copy audit. Published snapshots, requests, request responses, publication events, employee history and recurring weekly configuration are never updated by copying. Publication remains a separate action. A subsequent Publish can make an old pending request stale through the existing request revision checks.

Archived employees are skipped and named in the preview. Existing database triggers enforce approved full-day/partial-day time off, active roster membership and staffing capacity. Schedule validation checks overlaps across draft and published adjacent weeks. Existing availability evaluation supplies warnings, including overnight and DST boundaries. Projected hours are clipped to the destination's calendar-week boundaries and include draft carry-in shifts. Warnings do not override hard conflicts.

Copy dates advance by multiples of seven calendar days in the saved business timezone. Source local start and end times move independently, preserving overnight boundaries and allowing elapsed hours to change across DST. Nonexistent or ambiguous destination times block copying with an actionable message instead of silently choosing an occurrence; adjust those source times or enter those shifts manually.

## Transaction and permissions

`copy_schedule_week` is an invoker wrapper around a private definer function, following Shiftly's existing command architecture. The private function checks `auth.uid()` and manager/owner membership before and after taking the organization lock. Source/destination reads and all writes are organization scoped. Anonymous execution is revoked; the copy audit table has RLS and manager-only read grants. No new write grant is given to clients on scheduling tables.

Preview executes the same mutation and validation path in a subtransaction and deliberately rolls it back, including deferred assignment audit events. A token binds the options, source/destination state, groups, assignments, published assignments, employees, time off, availability, timezone and hours settings. Confirmation recomputes it under the organization lock; intervening changes require another preview. Confirmation atomically advances the destination revision and writes both the existing schedule change audit and a copy-specific before snapshot. Existing editors holding the previous revision fail their normal revision checks.

## Release gate

Keep the PR unmerged until **20261106052138_copy_schedule_week.sql** has been reviewed and applied to the intended Supabase project. It adds group copy lineage, a copy audit table with scoped permissions, and the preview/copy RPC; it does not rewrite existing schedules or migrate assignments. Apply the complete migration in its transaction using the project's normal migration process. Do not publish any schedule as part of deployment.

The migration was generated with `supabase migration new`. Supabase documentation was consulted through its connected documentation search; direct changelog access returned HTTP 403. Migration replay and functional queries run on isolated embedded PostgreSQL and a disposable native PostgreSQL 17.11 cluster. CLI advisors were attempted but the CLI's expected local Supabase stack was unavailable; run hosted security/performance advisors against staging after application and before merging. No production migration has been applied by this work.

## Validation

Run `npm install`, `npm test`, `npm run typecheck`, and `NEXT_TELEMETRY_DISABLED=1 npm run build`.

With `SHIFTLY_TEST_DATABASE_URL` set to an administrative connection on a disposable **local** PostgreSQL cluster, run `npm run test:postgres` and `node --conditions=react-server --import tsx --test tests/copy-week.test.ts`. These fixtures create and drop their own databases and refuse remote hosts.

Automated coverage includes empty/existing destinations, shared employees and group policies, all modes, repeat-copy deduplication, archived employees, approved time off, availability data, overnight/DST behavior, failed-copy rollback, stale confirmation, owner/employee/anonymous and tenant isolation, recurring configuration preservation, published snapshots, deferred audit rollback and pending request preservation. The native multi-session fixture observes a second copy waiting on the organization lock and then failing its stale preview check.

Before release, smoke-test the manager dialog on mobile and desktop: review the preview list and projected hours, verify Replace remains disabled until checked, confirm a copy into a published week, and verify the staff view changes only after explicit Publish.
