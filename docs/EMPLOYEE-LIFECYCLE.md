# Employee lifecycle and navigation cleanup

This release needs `20261106034547_employee_lifecycle.sql`. **Do not merge or deploy the application until the migration has been reviewed and applied through the authorized database workflow.** No production migration was applied while implementing this PR.

## Manager behavior

- Active employee cards offer Archive with explicit confirmation. Expand the blocker list to see every future draft or published assignment, pending shift request (including consented swaps), pending time-off request, or ownership restriction. Resolve these through scheduling and request review first. Reassigning a draft alone is insufficient: publish the changed coverage too.
- Archiving retains the roster identity and historical records, revokes outstanding roster/account-email invitations, and removes only that organization's membership. It never deletes the authentication account or memberships in other businesses.
- Archived Employees offers Restore with confirmation. Restoration enables assignment again but leaves account access revoked. Create a new roster invitation and have the employee accept it with a verified email to reconnect the same roster identity.
- Permanent deletion requires confirmation and is available only for unused, unconnected placeholders. Any foreign-key dependency, connected-account history, employee lifecycle audit, or assignment audit reference prevents deletion. The dependency check also detects new cascading foreign keys, so it cannot silently erase dependent records. Archiving and then restoring creates audit history and therefore prevents permanent deletion.
- A manager cannot remove an owner. An owner cannot archive the last owner, including themselves. Owners may archive themselves only while another owner remains.

## Database boundaries

`employee_lifecycle` is an invoker wrapper around an authenticated, organization-scoped private operation. Mutations recheck the caller after taking the same organization lock used by schedule commands, invitations, and shift requests. Membership removal has one private authorized boundary with no direct client EXECUTE grant. Column grants prevent clients from setting archive state or linking accounts directly. Employee audit rows use manager-only RLS.

Archived employees are excluded from assignment and manual time-off selectors. Existing historical names remain visible. Triggers reject new assignments, moved archived assignments, new time off, availability changes, and roster invitations for archived employees. Membership revocation prevents archived accounts from accepting coverage or swaps; restoration alone grants no access. Republishing a historical assignment is allowed only when it matches the persisted, completed draft assignment.

The deletion operation locks the roster row before checking dependencies, including all foreign keys to `employees` and the existing assignment audit snapshots. It deletes only the unused employee row; there are no cascading delete statements or changes to existing foreign keys.

## Navigation

Global navigation retains Schedule, Employees and Weekly setup for managers, Time Off, Shift Requests, Calendar for managers, and Settings for managers. My Schedule retains its personal/team view controls and week selection. Advanced scheduling settings are available from the global account/workspace menu. All existing page-specific create, publish, print, save, invitation, and week-navigation controls remain. Onboarding keeps its contextual next-step link.

## Validation

- `npm install`, `npm run typecheck`, `npm test`, and `NEXT_TELEMETRY_DISABLED=1 npm run build`.
- PostgreSQL migration tests cover past/future assignments, consented pending swaps, pending time off, linked/placeholder staff, invitation revocation, authorized reconnection, restoration without access, organization isolation, ownership rules, audit preservation, and unused-placeholder deletion. A synthetic future cascading dependency is verified to block deletion.
- Browser checks render the actual navigation and lifecycle controls with synthetic props and stubbed router/server-action boundaries: desktop single-row navigation at 1440, 1280, 1101 and 1051px; mobile menu at 390px; disabled archive blockers; cancellation of archive, restore, and permanent-delete confirmation dialogs. These are component checks, not a claim of a live authenticated Supabase browser session.
- Local SQL assertions verify audit-table RLS, denial of anonymous RPC execution, denial of direct archive-column updates, and denial of direct membership-removal execution. The Supabase CLI advisor was attempted but requires a running local Supabase database; none is configured in this environment. Run advisors against the reviewed target database as part of migration review.
