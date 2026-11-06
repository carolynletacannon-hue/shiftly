# Meadowmark — instructions for Codex

## Objective
Build a polished, mobile-first scheduling product for small workplaces, starting with a seven-person hospitality team. Keep the codebase easy to deploy via GitHub -> Vercel; no local development required of the owner.

## Stack
Next.js App Router, React, TypeScript, CSS; Supabase (Postgres and authentication) in a later milestone. Vercel is the deployment platform.

## Non-negotiable rules
- Run `npm install`, `npm run typecheck` and `npm run build` in your coding environment before proposing a merge.
- Do not introduce real guest or employee information into fixtures, logs, documentation, or code.
- The /demo dashboard has no persistence or real approvals. Keep this clear in the UI; authenticated workspace management is separate.
- Do not silently make demo-only actions look like real persisted approvals.
- Implement server-side authorization before implementing actual manager actions; never trust a client-side role toggle.
- All records and access must be scoped by organization. Enforce database row-level security when Supabase is introduced.
- Use an explicit publish workflow. Draft schedule updates should not notify staff.
- Every shift swap requires coworker consent and manager approval before changing the published schedule.
- Handle America/Denver time zones and daylight-saving changes correctly. Store timestamps as UTC instants where appropriate.
- Private per-user calendar feeds must use unpredictable revocable tokens; never expose the full team schedule through a personal feed.
- Keep changes small, accessible, mobile-friendly, and deployable to Vercel.
- Use PRs for significant features and describe how to validate them.

## Next steps
1. Verify the current sample interface passes production builds.
2. Refactor UI into reusable components and add tests.
3. Add Supabase authentication and organization membership.
4. Implement manager schedule drafts, validation, and publication.
5. Add time-off requests and manager review.
6. Add shift swap consent/approval flows.
7. Add private read-only iCalendar subscriptions.
