import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculate,
  period,
  contextBounds,
  parseRate,
  exportReport,
  type Input,
  type Settings,
} from "../lib/payroll/engine";
import type { Timecard } from "../lib/time-clock/records";
const settings: Settings = {
  frequency: "weekly",
  anchor: "2026-01-05",
  timezone: "UTC",
  workweek_day: 1,
  workweek_time: "00:00",
  rule: "federal-weekly-confirmed",
  employee_access: true,
};
const card = (
  a: string,
  b: string | null,
  more: Partial<Timecard> = {},
): Timecard => ({
  id: a,
  organization_id: "org",
  employee_id: "e",
  kiosk_id: null,
  clock_in: a,
  clock_out: b,
  revision: 1,
  approved_at: "2026-02-01T00:00Z",
  voided_at: null,
  created_at: a,
  time_breaks: [],
  ...more,
});
const input = (cards: Timecard[], s = settings): Input => ({
  settings: s,
  employees: [
    { id: "e", display_name: "Synthetic Employee", archived_at: null },
  ],
  rates: [
    {
      id: "r",
      employee_id: "e",
      effective_at: "2020-01-01T00:00Z",
      cents: "2000",
      classification: "hourly_nonexempt",
      created_at: "2020-01-01T00:00Z",
    },
  ],
  cards,
  requests: [],
});
const run = (
  i: Input,
  start = "2026-01-05T00:00Z",
  end = "2026-01-12T00:00Z",
) => calculate(i, start, end);
const shifts = (dates: string[], hours = 10) =>
  dates.map((d) =>
    card(`${d}T00:00Z`, `${d}T${hours.toString().padStart(2, "0")}:00Z`),
  );
test("regular hourly wages use approved actual time, preserve precision and exclude valid unpaid breaks", () => {
  const r = run(
    input([
      card("2026-01-05T00:00Z", "2026-01-05T08:00Z", {
        time_breaks: [
          { starts_at: "2026-01-05T04:00Z", ends_at: "2026-01-05T04:30Z" },
        ],
      }),
    ]),
  );
  assert.equal(r.rows[0].totalCents, "15000");
  assert.deepEqual(r.warnings, []);
});
test("weekly OT is 1.5x after 40; weekends alone are regular", () => {
  const r = run(
    input(
      shifts([
        "2026-01-05",
        "2026-01-06",
        "2026-01-07",
        "2026-01-08",
        "2026-01-09",
      ]),
    ),
  ).rows[0];
  assert.equal(r.regularCents, "80000");
  assert.equal(r.overtimeCents, "30000");
  assert.equal(run(input(shifts(["2026-01-11"]))).rows[0].overtimeCents, "0");
});
test("biweekly never averages weeks; semimonthly includes earlier workweek context", () => {
  const cards = shifts([
    "2026-01-05",
    "2026-01-06",
    "2026-01-07",
    "2026-01-08",
    "2026-01-09",
    "2026-01-12",
  ]);
  const r = run(
    input(cards, { ...settings, frequency: "biweekly" }),
    "2026-01-05T00:00Z",
    "2026-01-19T00:00Z",
  );
  assert.equal(r.rows[0].overtimeCents, "30000");
  const split = run(
    input(
      shifts([
        "2026-01-12",
        "2026-01-13",
        "2026-01-14",
        "2026-01-15",
        "2026-01-16",
      ]),
    ),
    "2026-01-16T00:00Z",
    "2026-02-01T00:00Z",
  );
  assert.equal(split.rows[0].regularCents, "0");
  assert.equal(split.rows[0].overtimeCents, "30000");
});
test("overnight spanning period boundary and workweek splits actual instants", () => {
  const c = card("2026-01-11T22:00Z", "2026-01-12T06:00Z");
  assert.equal(run(input([c])).rows[0].totalCents, "4000");
  assert.equal(
    run(input([c]), "2026-01-12T00:00Z", "2026-01-19T00:00Z").rows[0]
      .totalCents,
    "12000",
  );
});
test("DST spring and fall use elapsed UTC time; federal weeks are exactly 168 hours", () => {
  for (const [a, b, cents] of [
    ["2026-03-08T00:00-07:00", "2026-03-08T08:00-06:00", "14000"],
    ["2026-11-01T00:00-06:00", "2026-11-01T08:00-07:00", "18000"],
  ]) {
    const i = input([card(a, b)], { ...settings, timezone: "America/Denver" });
    const p = period(i.settings, a.slice(0, 10));
    assert.equal(run(i, p.start, p.end).rows[0].totalCents, cents);
    const bounds = contextBounds(i.settings, p.start, p.end);
    assert.equal(
      (Date.parse(bounds.end) - Date.parse(bounds.start)) % (168 * 3600000),
      0,
    );
  }
});
test("mid-period rate changes use effective rates; mid-workweek multiple rates require review", () => {
  const i = input(shifts(["2026-01-05", "2026-01-12"]));
  i.rates.push({
    ...i.rates[0],
    id: "raise",
    effective_at: "2026-01-12T00:00Z",
    cents: "2500",
  });
  const r = run(i, "2026-01-05T00:00Z", "2026-01-19T00:00Z");
  assert.equal(r.rows[0].totalCents, "45000");
  assert.deepEqual(r.warnings, []);
  i.rates[1].effective_at = "2026-01-05T05:00Z";
  assert.match(run(i).warnings.join(), /Multiple rates/);
});
test("missing punches, approvals, wage gaps, invalid breaks and requests block finalization", () => {
  const cases: [Input, RegExp][] = [
    [input([card("2026-01-05T00:00Z", null)]), /Missing clock-out/],
    [
      input(shifts(["2026-01-05"]).map((c) => ({ ...c, approved_at: null }))),
      /Unapproved/,
    ],
    [{ ...input(shifts(["2026-01-05"])), rates: [] }, /Missing wage/],
    [
      input([
        card("2026-01-05T00:00Z", "2026-01-05T08:00Z", {
          time_breaks: [{ starts_at: "2026-01-05T04:00Z", ends_at: null }],
        }),
      ]),
      /Invalid or incomplete/,
    ],
    [
      {
        ...input(shifts(["2026-01-05"])),
        requests: [{ employee_id: "e", status: "pending" }],
      },
      /Pending/,
    ],
  ];
  for (const [i, re] of cases) assert.match(run(i).warnings.join(), re);
  assert.equal(run(cases[1][0]).rows[0].totalCents, "0");
});
test("unsupported jurisdiction and exemption require external review; archived employees preserved", () => {
  const i = input(shifts(["2026-01-05"]), { ...settings, rule: "unverified" });
  i.employees[0].archived_at = "2026-02-01";
  i.rates[0].classification = "exempt_review";
  const r = run(i);
  assert.equal(r.rows[0].archived, true);
  assert.match(r.warnings.join(), /Jurisdiction/);
  assert.match(r.warnings.join(), /exemption/);
});
test("exact minor units, aggregate half-up rounding, no punch rounding", () => {
  assert.equal(parseRate("0.29"), "29");
  assert.equal(parseRate("123.4"), "12340");
  assert.throws(() => parseRate("20.005"));
  assert.throws(() => parseRate("1e3"));
  const i = input([card("2026-01-05T00:00Z", "2026-01-05T00:30Z")]);
  i.rates[0].cents = "101";
  assert.equal(run(i).rows[0].totalCents, "51");
  i.cards = [card("2026-01-05T00:00:00Z", "2026-01-05T00:00:01.000001Z")];
  assert.equal(run(i).rows[0].regularNs, "1000001000");
});
test("period configuration supports all frequencies and month end clamping", () => {
  assert.equal(period(settings, "2026-01-04").from, "2025-12-29");
  assert.equal(
    period({ ...settings, frequency: "biweekly" }, "2026-01-18").from,
    "2026-01-05",
  );
  assert.equal(
    period(
      { ...settings, frequency: "semimonthly", anchor: "2026-01-01" },
      "2026-01-16",
    ).through,
    "2026-01-31",
  );
  assert.equal(
    period(
      { ...settings, frequency: "monthly", anchor: "2026-01-31" },
      "2026-02-28",
    ).from,
    "2026-02-28",
  );
});
test("CSV guards formula injection, quotes and labels estimates", () => {
  const i = input(shifts(["2026-01-05"]));
  i.employees[0].display_name = ' \t=HYPERLINK("bad")\n';
  const text = exportReport(run(i), "Approved");
  assert.ok(text.includes('"\' \t=HYPERLINK(""bad"")\n"'));
  assert.match(text, /not confirmation of payment/);
  assert.ok(!text.includes("user_id"));
});

test("whole-session correction requests block reports even without a timecard", () => {
  const i = input([]);
  i.requests = [{ employee_id: "e", status: "pending" }];
  assert.match(run(i).warnings.join(), /Pending/);
});
