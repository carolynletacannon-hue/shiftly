# Roadmap

## Phase 0 — Demo
- Responsive team schedule, fictional seven-person roster
- Time-off request and manager-approval demonstrations
- Explicit demo-only state, no persistence or real login

## Phase 1 — Accounts
- Supabase email sign-in
- Organizations, invitations, manager and employee membership
- Row-level security and account deactivation

## Phase 2 — Scheduling (implemented)
- Persistent manager-only weekly draft editor, employee/day views and previous-week copy
- Reusable morning/evening/overnight templates and configurable positions
- Overlap validation, workload warnings, UTC instants and IANA/DST handling
- Explicit publish/republish snapshots, publication events and revision checks
- Employee My Schedule and published team views
- Approved absence integration remains deferred to Phase 3
- See [deployment and validation](PHASE2-SCHEDULING.md)

## Phase 3 — Requests
- Time off request submission/approval/denial
- Availability preferences
- Swap requests with both employees' consent
- Manager final approval and schedule version update

## Phase 4 — Calendars
- Individual private, revocable iCalendar subscription feeds
- Stable event IDs and timezone support
- Clear warning that subscriptions refresh on calendar-provider schedules

## Phase 5 — Production readiness
- Notifications and email delivery
- Role/authorization tests and accessibility audits
- Mobile usability, backup/recovery, rate limiting, monitoring
- Explicit approval before any real workplace rollout
