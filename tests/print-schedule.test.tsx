import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrintSchedule } from "../lib/scheduling/print-schedule";
import { localToInstant } from "../lib/scheduling/time";
import type { Shift } from "../lib/scheduling/types";

const timezone = "America/Denver";
function shift(id: string, employee: string | null, start: string, end: string): Shift {
  return {
    id, employee_id: employee, schedule_id: "sample-week", notes: "Private planning note",
    starts_at: localToInstant(start, timezone),
    ends_at: localToInstant(end, timezone),
  };
}
function render(shifts: Shift[], options: { week?: string; draft?: boolean; carryIn?: Shift[] } = {}) {
  return renderToStaticMarkup(createElement(PrintSchedule, {
    businessName: "Sample Lodge & Cafe", week: "2026-11-01", timezone, shifts,
    // Members are roster identities; no account ID or email is needed to print.
    members: [
      { id: "roster-only", name: "Sample Employee A", role: "employee" },
      { id: "another-employee", name: "Sample Employee B", role: "employee" },
    ],
    draft: true, ...options,
  }));
}

test("prints seven dated columns, all employees sharing a shift and remaining unassigned places", () => {
  const slots = ["roster-only", "another-employee", null, null].map((employee, i) =>
    shift(`slot-${i}`, employee, "2026-11-01T07:00", "2026-11-01T15:00"));
  const html = render(slots);
  assert.equal((html.match(/scope="col"/g) || []).length, 7);
  assert.match(html, /Sample Lodge &amp; Cafe/);
  assert.match(html, /November 1, 2026 – November 7, 2026/);
  assert.match(html, /Sunday/);
  assert.match(html, /Saturday/);
  assert.equal((html.match(/print-schedule-shift"/g) || []).length, 1);
  assert.match(html, /7:00 AM – 3:00 PM/);
  assert.match(html, /America\/Denver/);
  assert.match(html, /Sample Employee A/);
  assert.match(html, /Sample Employee B/);
  assert.match(html, /Unassigned \(2\)/);
  assert.doesNotMatch(html, /Private planning note|<button|<select|<form|<input/);
});

test("marks drafts, omits the label for the current published revision, and escapes names", () => {
  assert.match(render([]), />Draft</);
  assert.doesNotMatch(render([], { draft: false }), />Draft</);
  assert.match(render([]), /No shifts/);
  const html = renderToStaticMarkup(createElement(PrintSchedule, {
    businessName: "<Sample>", week: "2026-12-28", timezone, shifts: [], members: [], draft: false,
  }));
  assert.match(html, /&lt;Sample&gt;/);
  assert.match(html, /December 28, 2026 – January 3, 2027/);
  assert.match(html, /<th scope="col"><span>Monday/);
});

test("prints overnight shifts on their start day, with end date and DST zone changes", () => {
  const overnight = shift("overnight", "roster-only", "2026-10-31T23:00", "2026-11-01T07:00");
  const html = render([overnight], { week: "2026-10-26" });
  assert.match(html, /11:00 PM MDT – Nov 1, 7:00 AM MST/);
  const cells = html.match(/<td>.*?<\/td>/g)!;
  assert.match(cells[5], /Sample Employee A/);
  assert.doesNotMatch(cells[6], /Sample Employee A/);
});

test("includes carry-in overnight shifts once and excludes shifts outside the week", () => {
  const carry = shift("carry", "roster-only", "2026-10-31T23:00", "2026-11-01T07:00");
  const ended = shift("ended", null, "2026-10-31T16:00", "2026-11-01T00:00");
  const next = shift("next", null, "2026-11-08T07:00", "2026-11-08T15:00");
  const html = render([carry, next], { carryIn: [carry, ended] });
  assert.equal((html.match(/Sample Employee A/g) || []).length, 1);
  assert.match(html, /Continues from Sat, Oct 31/);
  assert.doesNotMatch(html, /Unassigned/);
});

test("retains unknown assigned identities instead of describing them as unassigned", () => {
  const html = render([shift("unknown", "missing", "2026-11-01T07:00", "2026-11-01T15:00")]);
  assert.match(html, /Employee name unavailable/);
  assert.doesNotMatch(html, /Unassigned/);
});
