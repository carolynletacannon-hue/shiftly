# UI modernization audit and review

Scope: existing light/sage branding, page structure, routes and native form semantics. No dependencies, schemas, migrations, permission checks or business actions changed.

## Audit and implementation

| Area | Finding | Change |
| --- | --- | --- |
| Shared theme | Secondary text and focus colors varied; card shadows were heavy | Consistent readable secondary text and green focus; shared surface/control radius, height, border, shadow and motion tokens |
| Buttons | Inconsistent secondary hover and borders; pending submissions had only text | Shared 44px baseline, intentional primary/secondary/danger states, disabled states, `aria-busy` and reduced-motion-safe progress indicator |
| Forms | Screen styles competed; select appearance, textarea padding and date sizing varied | One shared control layer loaded after screen styles; common hover, invalid, disabled and read-only states; native select arrow styling with forced-colors fallback |
| Date/time | Native pickers differed in alignment; mobile fields could zoom on focus | Retained native picker and validation; tabular numbers, aligned WebKit date text, mobile 16px text |
| Checkboxes/radios | Broad input rules could distort checkbox sizing | Explicit native appearance, consistent size and accent; keyboard semantics retained |
| Menus | Product and account popovers differed in elevation; account menu lacked Escape dismissal | Shared popover treatment and reusable native disclosure dismissal for Escape (focus restored), outside pointer and focus leaving; account closes on route change |
| Dialogs/popovers | Copy-week dialog and assignment/publication panels used separate treatments | Consistent surface, border, radius, backdrop, scroll limits and subtle entrance motion; native modal focus behavior retained |
| Tables/lists | Schedule table headers and hover states differed from other surfaces | Shared header surface, numeric alignment, focus-within row treatment and contained horizontal scrolling; responsive timecard/payroll card layouts retained |
| Mobile | New account padding conflicted with fixed notification position | Compact mobile trigger spacing; existing content-measured navigation retained |
| Motion | No common transition timing | 140ms color/border/shadow transitions and surface entrance only when motion is allowed; static pending indicator for reduced motion |

Shared CSS reaches Workforce dashboard, demo, settings, onboarding, weekly setup, scheduling, time off, shift requests, employee management, notifications, payroll, kiosk, account/auth pages and the product picker. Connect is currently a preview in the product registry with backend contracts; there is no Connect screen to restyle. No existing custom toggle or tooltip component was found; native checkbox settings and browser title behavior remain native.

## Manual visual review

- Review real populated schedules (long names, dense staffing, conflicts), timecard history and payroll reports on desktop and mobile. Local synthetic fixtures cannot represent every production data shape.
- Check the copy-week modal with long preview results, validation errors and keyboard-only operation; check printed schedules/PDFs.
- Verify native select menus and date/time picker panels on supported Safari/iOS, Firefox and Chromium versions. Native OS picker panels intentionally retain platform appearance. Automated verification in this environment uses Chromium.
- Review native checkbox settings, disabled controls, pending submissions, forced-colors mode and reduced motion with assistive technology.
- Connect UI should use these shared tokens and controls when its screens are implemented.

Validation: dependency install, typecheck and production build passed; all 151 behavior tests passed. The responsive navigation/keyboard/axe suite passed for both roles at six widths. Launch/screen accessibility checks and payroll/timecard/kiosk browser suites passed in Chromium using synthetic local fixtures. The project defines no lint script or lint configuration; typecheck, production build, existing behavior tests and local browser/a11y suites are used instead.
