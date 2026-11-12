# Workforce employee colors

Managers and owners can open **Employees → Edit name & contact information → Employee color**, choose one of eight colors, then **Save employee**. The saved swatch appears beside the employee's name. Native radio controls support Tab, arrow keys and Space; the checked option has a checkmark, a border and a tint. Each option has a written color name.

## Storage and authorization

The additive migration [`20261112054349_employee_colors.sql`](../supabase/migrations/20261112054349_employee_colors.sql) adds one `public.employees.color_key` column: non-null text, default `sage`, with a check constraint allowing `sage`, `blue`, `purple`, `coral`, `amber`, `teal`, `pink`, and `slate`.

Employee records already have a composite `(organization_id, id)` identity. A linked account can therefore have independent colors in different workplaces; roster-only and connected employees use the same mechanism. Repeated colors are allowed. Existing employees receive sage through the column default, with no explicit UPDATE or destructive backfill. Contact-only edits that omit `color_key` preserve the saved selection.

The server action requires owner/manager membership and filters by workplace and employee ID. Existing `roster_read`, `roster_add`, and `roster_edit` RLS policies remain intact. Only SELECT/INSERT/UPDATE privileges on the new column are added; identity, private contact information and other column grants are unchanged. Employee users can read colors in their workplaces but cannot change them through authenticated database/API access. No service-role bypass is used to save colors.

## Where colors appear

- **Employees:** named swatches on active and archived employee cards; eight-option picker inside the existing editing accordion.
- **Manager Schedule:** a tinted card and colored left edge for a single assignee; separate tinted, named indicators for every person on a shared shift. Unassigned cards remain neutral. Coverage/conflict indicators and assignment controls remain in place.
- **Team and personal Calendar:** the same palette in both weekly layouts, employee headings/hours summaries, and upcoming personal shifts.
- **Print Schedule:** names remain black, with colored borders/dots that do not require background printing. Seven dated columns and the existing pagination structure remain intact. Grayscale output still identifies every person by name.

Colors represent the **current workplace roster preference**. Changing a color updates the presentation of past and future weeks; it does not modify draft assignments, published shift snapshots, scheduling history or iCalendar events/subscription tokens. External calendar applications retain their own calendar-color settings.

## Manual release steps

Nothing in this branch applies a hosted migration or deploys the application.

1. Review the migration above. It contains only the new constrained column, column grants and a column comment.
2. Apply that exact migration through the workplace's normal Supabase migration process in staging first, keeping migration history in sync. Verify an existing employee starts at sage, then save another color as a manager and refresh a second signed-in session.
3. When approved for release, apply the reviewed migration to production **before deploying this application version**, using the normal authorized migration process. The previous application version is compatible with the additive column. Do not reset the database or indiscriminately apply unrelated pending migrations.
4. Deploy the application separately when authorized. Confirm a manager can edit, an employee cannot, and separate workplaces retain independent values. A rollback of application code can leave the additive column in place without losing saved preferences.

## Verification and evidence

Completed checks: **156 automated tests**, **21 native PostgreSQL tests**, typecheck, production build, the **35-case weekly browser matrix**, employee/premium UI/homepage/navigation smoke suites, and payroll/time-clock/kiosk browser checks. All passed.

Tests use synthetic people and workplaces only. Browser pages run the real Next application against a local HTTP fixture; fixture writes persist across page refreshes and independent browser contexts. Separate SQL integration tests run the actual migration and RLS under authenticated roles in embedded PostgreSQL and disposable native PostgreSQL 17. No production Supabase project is used.

- Palette tests check all eight text/tint combinations against WCAG 4.5:1 and colored indicators against 3:1, plus safe fallback for missing/invalid keys.
- SQL tests cover an upgrade with existing rows, all eight values, owner/manager saves, roster-only and connected employees, duplicate colors, omitted-color edits, employee writes/inserts denied, invalid/null values, identity-column write denial, cross-workplace writes denied, and independent values for the same account in two workplaces.
- Calendar SQL regression verifies a color edit does not change published shift snapshots, revoke subscriptions or increment calendar event sequences.
- Render tests check single-assignee tints, multiple individual named colors, neutral unassigned cards, and print labels.
- Browser checks cover owner editing of connected and roster-only employees, radio keyboard selection/focus, refresh and second-session persistence, employee editor exclusion, axe WCAG A/AA checks, shared shifts, long names, overlapping assignments, viewport-contained popovers and dialogs, and print borders with background printing disabled.
- The weekly matrix covers manager Schedule, owner team/personal Calendar, and employee team/personal Calendar at **375, 390, 768, 1024, 1280, 1440 and 1920 px**. Page, grid and parent overflow checks preserve the existing seven-day desktop and compact selected-day layouts.

Reproduce the feature browser suite with:

```sh
COLOR_TEST_ARTIFACTS=work/employee-colors-browser node tests/browser/weekly-layout.cjs
```

Run `npm test`, `npm run typecheck`, `npm run build`, and existing browser smoke suites. Run the native PostgreSQL suites using a disposable localhost database via `SHIFTLY_TEST_DATABASE_URL`, with `npm run test:postgres` (which includes the employee-color tests).

The Supabase CLI advisor comparison on a disposable local database found no new findings from this migration. Existing performance warnings concern profile/payroll/product-release RLS initialization and overlapping positions SELECT policies; they are outside this feature's scope. SQL function lint was attempted but the disposable PostgreSQL image does not include `plpgsql_check`; the complete migration chain and native database tests passed. This project has no separate application lint script.

### Visual evidence

- [Desktop employee picker](employee-colors/employees-desktop.png)
- [Mobile employee picker](employee-colors/employees-mobile.png)
- [Seven-day manager Schedule](employee-colors/schedule-desktop.png)
- [Compact mobile Calendar](employee-colors/calendar-mobile.png)
- [Printed schedule](employee-colors/print.png)

Manual release review should check the eight palette options in the organization's actual data, Windows/macOS forced-color settings, Safari/Firefox radio focus and printing, and a physical printer or PDF viewer. Automated browser verification uses Chromium; no physical cross-device or printer test is claimed.
