# Phase 8 — Public Homepage, Onboarding & Launch Readiness

## Scope and architecture

Based on latest `origin/main` at `97b9b36` (Phase 7 email-delivery fix). Existing Next.js App Router, server actions, Supabase authorization, roster, schedule editor, invitations, and Meadowmark theme are reused. No new runtime dependencies, database migrations, external tracking, or production writes.

### Public homepage

`/` now renders public content instead of redirecting. A separate public header includes Features, How It Works, Sign In, and Get Started. A native disclosure menu provides mobile navigation without another application header. The page includes the requested headline and description, six feature cards, three setup steps, small-business value proposition, explicitly labeled sample schedule illustration, nonpersistent demo link, final CTA, and footer with real navigation destinations. No invented testimonials, pricing, legal links, or unsupported product features. Calendar copy explicitly notes workplace enablement.

The visual design uses warm off-white, sage, dark green, restrained serif accents, rounded cards, and a responsive schedule illustration built from local markup. No external images or fonts are loaded.

### Authentication and routing

- Anonymous `/`: homepage, `/login` Sign In, and `/signup?next=%2Fonboarding` Get Started.
- Authenticated `/`: homepage remains visible; verified `getUser()` controls Open Meadowmark / Go to Dashboard links to `/workspaces`. No workspace or employee data is fetched by the homepage.
- Homepage is dynamic; existing proxy uses private/no-store for configured authenticated requests. Auth availability failure falls back to anonymous marketing content.
- Protected pages still use `requireUser` / `requireWorkspace` and existing RLS. No authentication configuration or token semantics changed.
- Workspace selection now opens a dashboard. Manager action messages and one-time invitation delivery links still redirect to the existing admin screen.
- Account confirmation and invitation `next` destinations retain existing `safeNext` validation. Existing signup defaults remain intact outside the homepage CTA.

### Business onboarding and dashboard

Workspace creation uses the same checked RPC, then opens its dashboard. The scheduling time zone is visible during setup, includes native suggestions, accepts other valid IANA zones, and retains server validation and the America/Denver default. Submit buttons on login, signup, and workspace creation disable during submission and show pending wording.

Managers see current-week draft/publication status, earliest future never-published draft, pending time-off and shift approvals, active employee count, and a schedule shortcut. Queries are organization-scoped, parallel, use count-only or limited projections, and do not add polling. The next-draft card deliberately means never published; current-week unpublished revisions have their own status.

The five-step checklist derives completion from existing workplace/timezone, active roster, schedule, and publication records. Saving existing business actions automatically updates progress on the next dashboard visit. Creating a draft does not require invitations. Publication always requires the existing explicit review. Skip for now hides the checklist; Show getting-started checklist restores it. Only dismissal is stored in localStorage, keyed by account/workspace; it is device-specific and resilient to disabled storage. Progress is not another mutable database state. Details count as complete when a valid scheduling timezone exists; users are prompted to review it.

### Employee onboarding and dashboard

Invitation acceptance continues to use the existing verified-email, hashed-token RPC. Missing/malformed links have fresh-invitation guidance; the existing invalid/expired/already-used/wrong-email response is preserved. Successful acceptance reaches the role-aware dashboard. Employees get a welcoming explanation, next published shift (with its publication timezone), recent own time-off requests and notifications, and direct links to My Schedule, Time Off, Shift Requests, Notifications, and Calendar Integration. Coverage opportunities remain in the existing Shift Requests screen. No manager cards or manager-only navigation appear for employees. Empty published schedule guidance remains available.

### Mobile, empty states, accessibility

Public layouts adapt to phone, tablet, and desktop widths. Existing schedule/calendar mobile layouts are retained. Shared polish adds minimum widths for form/container shrinkage, wrapping toolbar buttons, 44px notification/menu tap areas, stronger secondary text contrast, visible focus outlines, underlined inline dashboard links, and reduced-motion support. The application menu closes on Escape. Calendar Integration has a stable section anchor.

New dashboard cards explain empty requests, teams, shifts, and updates. Shared workspace loading and error boundaries show plain language without database error details and remind users to check saved state before repeating an action. Existing native destructive employee confirmations and explicit publish review are retained. No success state was added before a server operation completes.

## SEO and configuration

Root layout defaults to `noindex,nofollow`; homepage alone opts into indexing. The homepage has a title, description, and Open Graph title/description. Existing brand SVG app icon is retained. A dedicated social-sharing image is deferred; there is no fabricated image URL.

`NEXT_PUBLIC_SITE_URL` is reused. Only an explicitly configured HTTPS origin without credentials, path, query, or fragment produces a canonical URL and sitemap entry. Missing/invalid/local HTTP configuration yields no canonical and an empty sitemap. `robots.txt` excludes workspace, invitation, auth, API, demo, and account pages; sitemap contains only `/`. Robots directives are crawler hints, not authorization.

No new environment variables. Existing Supabase public configuration is still required for account/workspace pages. Existing calendar/Gmail/Phase 7 rollout variables and credential handling are unchanged. Never place service-role or Gmail credentials in `NEXT_PUBLIC_*` variables.

## Security review

Source review covered authentication guards, workspace dashboard queries, invitations, calendar feed route/token helpers, Phase 7 email configuration/worker and delivery grouping, and existing RLS/security regression tests.

- New dashboard queries run only after membership verification and explicitly filter `organization_id`. Employee shift/time-off queries also filter their linked roster identity; notifications filter the authenticated user. Dashboard role is read from membership, never browser state or user-editable metadata.
- Anonymous homepage retrieves only verified sign-in presence, not tenant records. Checklist dismissal grants no permission and changes no business records.
- Invitation creation/acceptance and rate-limited issue RPC are unchanged. Tokens remain hashed at acceptance, matching confirmed email, expiring, and single-use.
- Calendar bearer feed bypasses session refresh as before. Random revocable tokens, hashed lookup, private personal publication projections, no-store responses, durable rate limits, and disabled-by-default rollout remain unchanged. Preserve existing hosting firewall/log-redaction assumptions; do not enable feeds just to test marketing.
- Phase 7 worker remains server-only, gated to configured production, bounded in claims, and grouped by workplace plus recipient. Eligibility is checked before recipient lookup; safe workspace links and sanitized outcomes remain. No email delivery was triggered here. Existing tests exercise failure/retry and recipient isolation.
- Existing service-role use stays in server-only modules/server route handlers. No credentials were added to client bundles or docs. Existing worker endpoint retains constant-time cron-secret validation.
- Supabase authentication throttling, hosting firewall configuration, actual production policies/migrations, and secret bindings require deployment-owner verification. They were not queried or changed. This is a source review plus local tests, not a certification or a live penetration test.
- Supabase changelog fetch was attempted but blocked by the environment's destination policy (403). No Supabase API feature or schema change was introduced; existing client APIs are reused.

## Database and deployment safety

No migrations; no data backfill, reset, deletion, or production modification. Deploy only after review. Existing Phase 1–7 migrations and configuration must already be installed. No Vercel environment variables were changed.

## Validation

- `npm install --cache /workspace/.npm-cache`: passed; clean `npm ci` also passed after repairing the initial interrupted dependency extraction.
- `npm run typecheck`: passed.
- `npm test`: passed, 126 tests (112 database/service/security checks plus 14 rendered UI checks), zero failed or skipped. Includes existing scheduling/publication, invitations, tenant/role boundaries, time off, coverage/swaps, calendar security and delivery regressions, plus five new Phase 8 UI/metadata/onboarding checks.
- `node --import tsx --test tests/launch-readiness.test.tsx`: final recheck passed, 5/5 after homepage icon polish.
- `node tests/browser/launch-smoke.cjs`: passed in actual Chromium with a local HTTP Supabase fixture. Twenty-four WCAG A/AA axe page/viewport checks passed with no detected violations; checked viewport overflow, navigation/form semantics, 375/768/1440px homepage and auth screens, invalid invitation guidance and retained auth destination, anonymous protected-route redirect, signed-in homepage state, manager/employee dashboards, role denial, mobile menu/Escape, persisted checklist skip/restore, business setup, and major workspace mobile screens (weekly schedule, employees, My Schedule, Time Off, Shift Requests, Notifications, settings).
- Initial browser harness failures were fixed (streamed route transitions, print-only headings, and hidden responsive navigation locators). Actual contrast/link distinction findings were corrected in product CSS and the complete suite then passed.
- `npm run test:postgres`: 12 passed; 1 configuration failure because no disposable local `SHIFTLY_TEST_DATABASE_URL` is configured. Native multi-session concurrency is unverified; see reproduction instructions below.

Browser fixtures contain synthetic data only; they cannot establish production authentication/email/calendar-provider connectivity. Final production build/capture results are appended below.

## Manual launch checklist

- [ ] Review desktop/phone homepage, menu keyboard behavior, Explore Features scroll, Sign In, Get Started, and signed-in dashboard CTA on the actual preview domain.
- [ ] In a separate nonproduction Supabase project, create/confirm an account, create a workplace with its actual timezone, skip/restore checklist, add a roster employee, create a draft, explicitly publish, and confirm progress. Refresh and verify no duplicated workplace/roster records.
- [ ] Accept real nonproduction invitations as a new/existing confirmed user; test wrong email, unconfirmed email, missing/expired/revoked/already-used tokens, and resend. Confirm old roster history remains linked correctly.
- [ ] Check employee dashboard, upcoming overnight/DST shifts, My Schedule, no-publication state, time-off decisions, consent then manager approval for swaps, coverage, notifications/preferences, and calendar section anchor.
- [ ] With two businesses and owner/manager/employee identities, verify direct URL and server-action denial across businesses and manager boundaries. Check managers' read-only/owner-only settings behavior.
- [ ] At 320, 375, 768, and desktop widths, test populated schedules, long names, tables, settings, native copy-week modal, publication review, employee archive/delete confirmation, keyboard focus, and print layout.
- [ ] Verify Gmail diagnostics and one-recipient delivery in an approved test deployment; verify failed delivery never claims success or affects business decisions. No production messages should be generated for launch testing.
- [ ] Verify production canonical origin, auth callback allowlist, favicon, root index directive, private no-index directives, robots, sitemap, configured rate limits, and private cache headers.
- [ ] Verify calendar feed firewall, log redaction, revocation/rotation, personal-only content, and existing rollout runbook before enabling subscriptions.

## Release and rollback

1. Review the feature PR and CI. Do not merge or deploy until the owner approves release.
2. Use Vercel preview with a separate nonproduction Supabase project and email/feed rollout disabled, then complete the checklist. Preserve existing environment names and never point destructive tests at production.
3. After approval, merge through the normal GitHub-to-Vercel production workflow. Confirm `/`, sign-in, workspace dashboard, scheduling, invitation acceptance, and existing Phase 7 diagnostics.
4. If the release misbehaves, promote the previous known-good Vercel deployment and revert the Phase 8 commit through a PR. No database rollback is necessary. Existing business records and published schedules remain in place; device-local checklist dismissal may remain harmlessly.

## Known limitations and launch gates

Production release is blocked on owner review and completion of live-provider/nonproduction manual checks above. Automated browser checks use an HTTP fixture for authenticated states; they do not prove Supabase session refresh, real account confirmation, actual invitation delivery, external calendar refresh cadence, or Gmail delivery. Filled/interacting modals and all assistive technologies need manual review; automated axe checks are not a complete accessibility audit. No legal/contact destination was invented; supply real reviewed destinations before adding those footer links. Checklist dismissal does not sync across devices. Cross-week native multi-session PostgreSQL checks require a disposable local PostgreSQL service; embedded database regressions cover existing tenant and workflow rules.

### Reproduce validation

```sh
npm install
npm run typecheck
npm test
NEXT_TELEMETRY_DISABLED=1 npm run build
```

The managed executor needs writable cache/config paths: `npm install --cache /workspace/.npm-cache` and `XDG_CONFIG_HOME=/workspace/.config NEXT_TELEMETRY_DISABLED=1 npm run build`. A clean `npm ci` with that cache repaired incomplete files from the first interrupted install; no dependency manifest/lockfile changes are required.

Browser smoke prerequisites are a local Chromium executable and Playwright/axe-core. To avoid adding production dependencies:

```sh
npm install --prefix work/browser-tools --no-package-lock playwright axe-core
node tests/browser/launch-smoke.cjs
```

The harness starts an isolated local HTTP fixture on port 54321 and Next dev on port 3100, disables feed/email rollout, and closes both when complete. Set `BROWSER_EXECUTABLE_PATH` if Chromium is elsewhere; default is `/usr/bin/chromium`. Optionally set `AXE_CORE_PATH` for an existing axe script. Captures/logs live in ignored `work/`. These ports must be available. It tests actual server-rendered routes using synthetic sessions and responses, not a real Supabase project.

The separate `npm run test:postgres` requires `SHIFTLY_TEST_DATABASE_URL` pointing to an administrative connection on a **disposable local** PostgreSQL cluster. This executor has no such connection configured. That command was attempted: 12 checks passed using embedded PostgreSQL, and the multi-session concurrency check failed its configuration assertion. It must be rerun with the local database before claiming native concurrency validation. Do not supply a production connection.

### Final production validation

- `NEXT_TELEMETRY_DISABLED=1 XDG_CONFIG_HOME=/workspace/.config npm run build`: passed, including optimized compilation, Next.js TypeScript validation, and route generation.
- Post-build `npm run typecheck`: passed.
- Local production-server Chromium smoke: passed at 375px and 1440px, including two additional axe WCAG A/AA checks with no detected violations, no viewport overflow, actual Explore Features / Get Started navigation, homepage index versus signup no-index metadata, and absent-domain canonical/sitemap behavior.
- [Phone homepage screenshot](screenshots/phase8-homepage-375.png) and [desktop homepage screenshot](screenshots/phase8-homepage-1440.png) captured from that production build, with no development overlay or real personal information.
- `git diff --check`: passed.
