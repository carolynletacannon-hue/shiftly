import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleCalendar } from "../lib/scheduling/calendar";
import { CoverageCalendar } from "../lib/scheduling/coverage-calendar";
import type { Member, Shift } from "../lib/scheduling/types";
const members: Member[] = [
  {
    id: "roster",
    name: "Synthetic roster colleague",
    role: "employee",
    color_key: "blue",
  },
  {
    id: "connected",
    name: "Synthetic connected colleague",
    role: "employee",
    color_key: "pink",
  },
];
const shift = (
  id: string,
  employee_id: string | null,
  shift_group_id: string,
): Shift => ({
  id,
  employee_id,
  shift_group_id,
  schedule_id: "synthetic-week",
  starts_at: "2026-11-09T15:00:00Z",
  ends_at: "2026-11-09T23:00:00Z",
  position_name: "General",
  notes: "",
  required_count: 1,
});
const props = { members, week: "2026-11-08", timezone: "America/Denver" };
const render = (shifts: Shift[], coverage = false) =>
  renderToStaticMarkup(
    coverage
      ? createElement(CoverageCalendar, {
          ...props,
          shifts,
          peers: shifts,
          warning: 40,
          pending: false,
          onAssign: () => {},
          onAdd: () => {},
          onEdit: () => {},
        })
      : createElement(ScheduleCalendar, { ...props, shifts, view: "days" }),
  );
for (const coverage of [false, true]) {
  test(`${coverage ? "manager coverage" : "team calendar"}: named individual colors, single-assignee tint and neutral unassigned shifts`, () => {
    const shared = render(
      [shift("one", "roster", "shared"), shift("two", "connected", "shared")],
      coverage,
    );
    assert.match(shared, /data-employee-color="blue"/);
    assert.match(shared, /data-employee-color="pink"/);
    assert.match(shared, /Synthetic roster colleague/);
    assert.match(shared, /Synthetic connected colleague/);
    assert.doesNotMatch(shared, /has-employee-color/);
    assert.match(
      render([shift("one", "roster", "single")], coverage),
      /has-employee-color/,
    );
    const neutral = render([shift("open", null, "unassigned")], coverage);
    assert.doesNotMatch(neutral, /has-employee-color/);
    // The calendar includes a colored hours-summary roster outside unassigned cards.
    assert.match(neutral, coverage ? /Assign employees/ : /Unassigned/);
  });
}
