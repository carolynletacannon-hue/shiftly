# Meadowmark visual refresh

The application now uses Meadowmark in navigation, account pages, page metadata,
loading messages, the demo, invitations, shift-request emails, time-off notices,
and the Gmail sender display name. `app/brand.tsx` supplies the reusable wordmark
and meadow-blade M icon; `app/icon.svg` supplies the browser icon. The previous
letter-S mark and dot wordmark are no longer rendered. There were no standalone
Shiftly logo assets in the repository.

The light palette lives in `app/design-system.css`. Base styles in
`app/globals.css` and schedule layouts in `app/scheduling.css` use shared tokens.
White surfaces, green selection states, restrained borders, readable shift times,
consistent initials, distinct coverage badges and stacked mobile day cards are
shared by real workspaces and the explicitly nonpersistent demo. The existing
single navigation system and all action handlers remain in place.

## Compatibility

No database migrations, authentication configuration, environment variables,
Supabase resources, cookie keys, scheduling permissions or integration endpoints
were changed. Gmail still uses the existing configured sender address, including
`shiftly.notifications@gmail.com`; only the display name becomes Meadowmark.
Invitation link construction, token handling, expiry, resend and delivery behavior
are unchanged. Remaining Shiftly strings in code are internal identifiers or test
fixtures. Existing screenshots under `docs/screenshots` are historical references,
not runtime branding assets.

## Verification

- `npm install --cache /tmp/meadowmark-npm-cache`: passed.
- `npm run typecheck`: passed.
- `npm test`: 83 tests passed, no failures or skips. Covers invitations, SMTP
  composition, roster deletion, shared shifts, copying weeks, authorization,
  scheduling, time off and print output using isolated test databases.
- `NEXT_TELEMETRY_DISABLED=1 npm run build`: passed.
- `git diff --check`: passed.
- No lint script or lint configuration is provided by this project.
- Chromium: login, signup and demo checked at 1440, 768, 390 and 320 pixels with
  dark OS preference emulated. All retained the light theme, without document
  overflow or browser JavaScript errors. Desktop and mobile screenshots reviewed.
- Mobile navigation and demo multi-employee assignment/removal checks passed.
- Native PostgreSQL concurrency suite was not run: no disposable native
  PostgreSQL connection is configured. The regular suite's embedded Postgres
  tests passed. No existing user database was contacted or reset.

## Deployment

Deploy through the normal review and Vercel process. No new configuration is
required. Keep all current environment values, especially the sender account.
This environment has no live service credentials, so authenticated production
smoke checks and a real invitation send remain deployment checks. If hosted
Supabase authentication email templates contain custom Shiftly branding outside
this repository, update their display copy separately without changing auth URLs
or sender configuration. No hosted service settings were edited here.
