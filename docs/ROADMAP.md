# Roadmap

## Phase 0 — Demo
- Responsive team schedule, fictional seven-person roster
- Time-off request and manager-approval demonstrations
- Explicit demo-only state, no persistence or real login

## Phase 1 — Accounts
- Supabase email sign-in
- Organizations, invitations, manager and employee membership
- Row-level security and account deactivation

## Phase 2 — Scheduling
- Recurring shift templates
- Manager-only draft schedule editor
- Conflicts, approved absences, overlapping shifts
- Publish/republish with audit history

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
