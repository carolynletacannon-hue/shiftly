# Phase 5: shared shifts and unified application design

A manager now edits one calendar card for a shift, adds or removes individual employees, and sets its required staffing independently. A 2/3 card means two people are assigned and three are needed. Extra people are permitted by default; a manager can disable overstaffing for that shift. Shared label, notes, position, date and times change together. Each employee's hours, personal schedule, time off, coverage requests and swaps remain assignment-specific.

The shared navy theme covers authentication, onboarding, scheduling, roster, weekly setup, time off, shift requests and business settings. The common header uses server-authorized workspace roles, active links, an expandable mobile/tablet menu, notifications, account actions and workspace switching. The existing print layout remains white and lists every assigned employee. The demo uses the real shared calendar component but clearly marks all actions as temporary.

## Database model and compatibility

- `shift_groups` is the shared shift, including UTC instants, label, position, notes, template/requirement provenance, required count and overstaffing policy. Its organization and schedule are protected by composite foreign keys and RLS.
- Existing `shifts` rows retain their primary keys and become the normalized assignment/spot relationship through `shift_group_id`. `shift_assignments` is a security-invoker view of occupied assignments. Employees are never stored as an array or JSON membership list.
- Existing structure columns on assignment rows are compatibility projections for the deployed time-off, transfer and notification APIs. Locked scheduling commands update them together; validation rejects mismatched shared structure. Client roles cannot write the tables directly.
- Vacant spots support the existing open-shift volunteering workflow. Staffing count lives on the parent, independently of those spots. Dormant vacant identities can survive a count reduction; they do not inflate staffing counts. Frozen publication policy prevents volunteering beyond a staffing limit when overstaffing is disabled.
- Published assignment rows freeze shared identity, staffing count, policy and structure. They have no dependency on the mutable draft parent. Draft membership, count, time and note changes never update publication rows. Explicit publication and the existing consent/approval transfer boundary remain the only ways to change employee-visible assignments.
- Assignment history records old/new identities and snapshots; schedule changes record revision, command and actor. Draft audit records do not enter the publication notification outbox.

The migration combines only recurring siblings from the same requirement and schedule with equal times, position, template, label, notes and required status. Custom or unrelated equal-time shifts remain separate. No preexisting assignment, publication or request identity is deleted or rewritten. Printed groups also use persisted identity rather than time matching.

Pending requests compare entire publication snapshots. The migration enriches only open/pending snapshots with the newly added column values, preserving all prior snapshot fields and revision checks. Completed history remains unchanged. This preserves valid existing consents without making genuinely stale requests valid.

## Migration review and deployment gate

**Leave the PR unmerged until migration review and application are complete.** The feature branch has Vercel preview deployment disabled to avoid running the new UI against the old schema. No production database mutation was performed during implementation.

1. Start from the latest Phase 4 schema (`b4a5d49`). Live catalog inspection confirmed that the current scheduling, weekly reconciliation, time-off assignment checks, request commands and transfer-conflict routines match this baseline. Only schema/catalog metadata was retrieved for that comparison.
2. Review `20261106022413_multi_employee_shifts.sql`. It is one additive transaction. It locks the organization table before assignment/publication tables, follows the existing command lock order and uses bounded lock/statement timeouts. Retry in a quiet window if a lock times out.
3. Take the normal database backup and rehearse on staging. Compare assignment IDs/employees/times, publication IDs/revisions/timestamps and pending request IDs/status/consents before and after. Review the three added snapshot keys separately; all old snapshot fields must remain identical.
4. Run the automated suite against the migration chain. The upgrade fixtures deliberately insert publications and pending accepted coverage/swap requests **before** applying Phase 5, then approve them afterward and verify coworkers remain unchanged.
5. Run `npm run test:postgres` with `SHIFTLY_TEST_DATABASE_URL` pointing to an administrative connection on a disposable **local** PostgreSQL cluster. The test creates and drops its own database and observes actual backend lock waits across independent connections. It covers cross-week overlapping assignment races, time-off approval versus assignment, publication versus staffing edits and competing coverage acceptances. The same command also runs the preexisting pending-consent upgrade fixture against native PostgreSQL. Both were run successfully against PostgreSQL 17.11, matching the live major/minor version. Repeat staging smoke checks under the deployment environment as part of migration review.
6. Apply the reviewed migration before deploying the new application. Regenerate/reload the PostgREST schema cache if the new relation is not immediately available. Verify owner/manager and employee accounts, then merge and deploy. Prefer a forward fix over dropping columns after new assignments have been created.

Private calendar subscriptions are still a roadmap item in the current repository; this change preserves personal published schedule filtering and does not introduce a feed exposing the team schedule.

## Validation and UI review

Run `npm install`, `npm run typecheck`, `npm test`, and `NEXT_TELEMETRY_DISABLED=1 npm run build`. For native multi-session verification, run `SHIFTLY_TEST_DATABASE_URL=<local-administrative-url> npm run test:postgres` on a disposable local PostgreSQL cluster. This optional suite requires database/role creation privileges, refuses remote hosts and deletes only its own generated database.

The tests cover legacy upgrade identity preservation, published snapshots, pending request consent, safe grouping, independent capacity, overstaffing, single-assignment removal/replacement, swaps, automatic transfer, approved time off, recurring reconciliation, copied custom/overstaffed shifts, organization permissions, stale revisions, rollback, hours/DST and print grouping. Existing invitation and notification tests remain part of the full suite.

Browser checks exercised desktop (1536px), tablet (834px) and mobile (390px): page overflow, mobile navigation, employee restrictions, multi-person assignment controls, staffing changes, shared detail editor and print media. Manager/employee screenshots use real application components with isolated synthetic props; they do not represent an authenticated production session. The temporary preview harness is not shipped. Demo controls were tested for adding/removing a person and changing 3/2 staffing without persistence.

Review screenshots in [screenshots](screenshots/README.md). For a manual authenticated check, create a shift needing three people, assign two, print it, remove one person, publish, and confirm that each personal schedule contains only that person's assignments. Exercise a coworker-consented manager-approved swap and confirm that other employees sharing either shift remain unchanged.
