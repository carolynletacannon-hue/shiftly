# Printing weekly schedules

The manager calendar's **Print Schedule** button calls the browser's print dialog.
The page includes a separate, static `PrintSchedule` component outside `Frame`;
print CSS hides the application shell and displays only that component. Screen
styles and assignment controls keep their existing behavior. Printing is disabled
while a schedule change is saving, so it uses the refreshed server-rendered week.

The printout includes the business, selected date range and schedule time zone,
seven dated day columns, shift times, employee names and **Unassigned** places.
Slots with identical start/end instants share a list of employees and open places.
Names come from the existing employee roster; a Shiftly account is not required.
The current revision is marked **Draft** unless it matches the published revision.
There are no new queries, database changes, publication actions or notifications.

Named print pages default to US Letter landscape with 0.4-inch margins. Body text
stays at 11pt; larger schedules continue across pages with repeated day headings
and intact shift rows instead of shrinking the text. Overnight shifts include the
end date. Shifts crossing a daylight-saving transition show both time-zone
abbreviations, and carry-in shifts appear on the first day with their start date.

## Validation

- Run `npm install`, `npm test`, `npm run typecheck`, and `npm run build`.
  Component rendering tests run without the `react-server` condition; the existing
  server/database tests retain it.
- Open a manager week with multiple employees sharing times, unassigned slots and
  overnight shifts. Open an assignment popover, then select **Print Schedule**.
  Verify only the schedule prints, with all seven days and no editing UI, employee
  hours, settings, notices or navigation. Cancel and confirm editing still works.
- Check a new draft, unpublished edits, and the current published revision. Only
  the first two should print **Draft**. Include a roster employee with no account.
- Check Sunday/Monday week starts, a year boundary, an overnight shift crossing
  the Denver daylight-saving transition, and a shift carried from the prior week.
- Use Letter landscape at 100% scale with background graphics off. Check a normal
  week fits one page and a busy week continues without splitting shifts or names.

Implementation validation used Chromium 155 with the actual editor and print
components, application CSS, synthetic roster data, and mocked navigation/actions
(no hosted authentication or database). A seven-day fixture with three daily
shift ranges, two employees and one open place per range, plus an overnight
carry-in, exported as **one 792 × 612pt page**. All 43 employee-name occurrences
and 21 unassigned places survived PDF text extraction. A larger 16-range-per-day
fixture exported as five pages with all 225 names and 112 unassigned places;
per-page name counts confirmed intact rows and repeated headings. Browser checks
also confirmed the print button invokes `window.print()`, print media hides the
application shell, published schedules omit Draft, and desktop/mobile screen
controls remain available after printing.

Interactive desktop print-preview verification was blocked by this environment's
managed Chromium policy, `PrintingEnabled: false`. The print-media layout and PDF
renderer were verified; the native dialog still needs a check in a browser with
printing enabled.
