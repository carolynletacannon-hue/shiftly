import { test } from "node:test";
import assert from "node:assert/strict";
import { clockButtonLabel } from "../lib/time-clock/approval-labels";
import { recordedOvertime } from "../lib/time-clock/overtime";
import type { Settings } from "../lib/payroll/engine";
import type { Timecard } from "../lib/time-clock/records";
test("timeclock action labels and pending states describe the action", () => {
  for (const [command, label, pending] of [
    ["approve", "Approve Timecard", "Approving…"],
    ["void", "Void Timecard", "Voiding…"],
    ["pin", "Generate New PIN", "Generating…"],
    ["enroll", "Activate Kiosk & Sign Out", "Activating…"],
    ["settings", "Save Settings", "Saving Settings…"],
    ["bulk_approve", "Approve All Eligible", "Approving…"],
  ]) {
    assert.equal(clockButtonLabel(command), label);
    assert.equal(clockButtonLabel(command, true), pending);
  }
});
test("overtime visibility keeps independent employee counters across overnight handoffs and report boundaries", () => {
  const settings: Settings = {
    frequency: "weekly",
    anchor: "2026-01-05",
    timezone: "UTC",
    workweek_day: 1,
    workweek_time: "00:00",
    rule: "unverified",
    employee_access: false,
  };
  const make = (
    id: string,
    employee: string,
    start: string,
    end: string,
  ): Timecard => ({
    id,
    employee_id: employee,
    organization_id: "o",
    kiosk_id: null,
    clock_in: start,
    clock_out: end,
    approved_at: null,
    voided_at: null,
    created_at: start,
    revision: 1,
    time_breaks: [],
  });
  const cards = ["05", "06", "07", "08", "09"].map((d) =>
    make(d, "a", `2026-01-${d}T15:00Z`, `2026-01-${d}T23:15Z`),
  );
  cards.push(make("night", "b", "2026-01-09T23:00Z", "2026-01-10T07:00Z"));
  const result = recordedOvertime(
    cards,
    "2026-01-09T00:00Z",
    "2026-01-11T00:00Z",
    "2026-01-12T00:00Z",
    settings,
  );
  assert.equal(result.get("09"), 1.25);
  assert.equal(result.has("night"), false);
  assert.equal(result.size, 1);
});
