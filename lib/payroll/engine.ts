import { Temporal as T } from "@js-temporal/polyfill";
import { csv } from "../time-clock/records";
import type { Timecard } from "../time-clock/records";
export type Settings = {
  frequency: "weekly" | "biweekly" | "semimonthly" | "monthly";
  anchor: string;
  timezone: string;
  workweek_day: number;
  workweek_time: string;
  rule: string;
  employee_access: boolean;
};
export type Rate = {
  id: string;
  employee_id: string;
  effective_at: string;
  cents: string;
  classification: string;
  created_at: string;
};
export type Employee = {
  id: string;
  display_name: string;
  archived_at: string | null;
  user_id?: string | null;
};
export type Input = {
  settings: Settings;
  employees: Employee[];
  rates: Rate[];
  cards: Timecard[];
  requests: { employee_id: string; status: string }[];
};
export type Row = {
  employee: string;
  name: string;
  archived: boolean;
  rates: string[];
  regularNs: string;
  overtimeNs: string;
  regularCents: string;
  overtimeCents: string;
  totalCents: string;
  warnings: string[];
  approval: string;
};
export type Report = {
  version: "federal-weekly-v1";
  start: string;
  end: string;
  rows: Row[];
  warnings: string[];
};
export type OvertimeRule = {
  thresholdNs: bigint;
  regularFactor: bigint;
  overtimeFactor: bigint;
  denominator: bigint;
};
const HOUR = BigInt(3600000000000),
  WEEK = BigInt(168) * HOUR;
export const overtimeRules: Readonly<Record<string, OvertimeRule>> = {
  "federal-weekly-confirmed": {
    thresholdNs: BigInt(40) * HOUR,
    regularFactor: BigInt(2),
    overtimeFactor: BigInt(3),
    denominator: BigInt(2),
  },
};
const ns = (s: string) => T.Instant.from(s).epochNanoseconds;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const floor = (a: bigint, b: bigint) =>
  a >= BigInt(0) ? a / b : (a - b + BigInt(1)) / b;
export const money = (c: string) =>
  `${BigInt(c) / BigInt(100)}.${(BigInt(c) % BigInt(100)).toString().padStart(2, "0")}`;
export const hours = (n: string) =>
  (Number(BigInt(n)) / Number(HOUR)).toFixed(4);
export function parseRate(s: string) {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s))
    throw Error("Enter a positive USD hourly rate with at most two decimals.");
  const [a, b = ""] = s.split(".");
  const c = BigInt(a) * BigInt(100) + BigInt(b.padEnd(2, "0"));
  if (c <= BigInt(0) || c > BigInt(99999999))
    throw Error("Hourly rate is out of range.");
  return c.toString();
}
export function period(s: Settings, date: string) {
  const d = T.PlainDate.from(date);
  let start: T.PlainDate, end: T.PlainDate;
  if (s.frequency === "monthly" || s.frequency === "semimonthly") {
    const anchorDay = T.PlainDate.from(s.anchor).day;
    if (s.frequency === "semimonthly" && anchorDay > 15)
      throw Error("Semimonthly anchor must be on days 1–15");
    const boundaries: T.PlainDate[] = [];
    for (const offset of [-1, 0, 1, 2]) {
      const month = d.with({ day: 1 }).add({ months: offset });
      boundaries.push(month.with({ day: anchorDay }));
      if (s.frequency === "semimonthly")
        boundaries.push(month.with({ day: anchorDay + 15 }));
    }
    boundaries.sort(T.PlainDate.compare);
    start = boundaries.filter((b) => T.PlainDate.compare(b, d) <= 0).at(-1)!;
    end = boundaries.find((b) => T.PlainDate.compare(b, d) > 0)!;
  } else {
    const anchor = T.PlainDate.from(s.anchor),
      days = s.frequency === "weekly" ? 7 : 14;
    const offset = d.since(anchor, { largestUnit: "days" }).days;
    start = anchor.add({ days: Math.floor(offset / days) * days });
    end = start.add({ days });
  }
  return {
    from: start.toString(),
    through: end.subtract({ days: 1 }).toString(),
    start: start.toZonedDateTime(s.timezone).toInstant().toString(),
    end: end.toZonedDateTime(s.timezone).toInstant().toString(),
  };
}
/** Fixed 168-hour federal workweeks. The anchor is local once; it does not move at DST. */
export function workweekAnchor(s: Settings) {
  const d = T.PlainDate.from(s.anchor);
  const day = d.subtract({ days: (d.dayOfWeek - s.workweek_day + 7) % 7 });
  return day
    .toPlainDateTime(T.PlainTime.from(s.workweek_time))
    .toZonedDateTime(s.timezone, { disambiguation: "reject" })
    .toInstant().epochNanoseconds;
}
export function contextBounds(s: Settings, start: string, end: string) {
  const a = workweekAnchor(s);
  const lo = a + floor(ns(start) - a, WEEK) * WEEK;
  const hi = a + (floor(ns(end) - BigInt(1) - a, WEEK) + BigInt(1)) * WEEK;
  return {
    start: T.Instant.fromEpochNanoseconds(lo).toString(),
    end: T.Instant.fromEpochNanoseconds(hi).toString(),
  };
}
export function calculate(input: Input, start: string, end: string): Report {
  const lo = ns(start),
    hi = ns(end);
  if (hi <= lo || hi - lo > BigInt(366) * BigInt(24) * HOUR)
    throw Error("Invalid reporting interval");
  const rule =
    overtimeRules[input.settings.rule] ||
    overtimeRules["federal-weekly-confirmed"];
  const anchor = workweekAnchor(input.settings),
    bounds = contextBounds(input.settings, start, end),
    contextLo = ns(bounds.start),
    contextHi = ns(bounds.end);
  const rows: Row[] = [];
  for (const e of input.employees) {
    const cards = input.cards
      .filter(
        (c) =>
          c.employee_id === e.id &&
          !c.voided_at &&
          ns(c.clock_in) < contextHi &&
          (!c.clock_out || ns(c.clock_out) > contextLo),
      )
      .sort((a, b) => T.Instant.compare(a.clock_in, b.clock_in));
    if (
      !cards.some(
        (c) => ns(c.clock_in) < hi && (!c.clock_out || ns(c.clock_out) > lo),
      ) &&
      !input.requests.some(
        (r) => r.employee_id === e.id && r.status === "pending",
      )
    )
      continue;
    const warnings = new Set<string>();
    const warn = (s: string) => warnings.add(s);
    if (input.settings.rule !== "federal-weekly-confirmed")
      warn(
        "Jurisdiction or overtime rules unverified: external payroll review required",
      );
    if (
      input.requests.some(
        (r) => r.employee_id === e.id && r.status === "pending",
      )
    )
      warn("Pending timesheet correction");
    // Corrections append a new version at the same effective instant; newest wins.
    const rateMap = new Map<string, Rate>();
    for (const r of input.rates
      .filter((r) => r.employee_id === e.id)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      ))
      rateMap.set(ns(r.effective_at).toString(), r);
    const rates = [...rateMap.values()].sort((a, b) =>
      T.Instant.compare(a.effective_at, b.effective_at),
    );
    const weeks = new Map<string, bigint>(),
      weekRates = new Map<string, Set<string>>();
    const displayed = new Set<string>();
    let regular = BigInt(0),
      ot = BigInt(0),
      regNumerator = BigInt(0),
      otNumerator = BigInt(0),
      priorEnd: bigint | null = null;
    for (const c of cards) {
      if (!c.clock_out) {
        warn("Missing clock-out");
        continue;
      }
      const cardLo = ns(c.clock_in),
        cardHi = ns(c.clock_out);
      if (cardHi <= cardLo) {
        warn("Invalid timecard");
        continue;
      }
      if (priorEnd !== null && cardLo < priorEnd) warn("Overlapping timecards");
      priorEnd = priorEnd === null ? cardHi : max(priorEnd, cardHi);
      if (!c.approved_at) {
        warn("Unapproved timecard in overtime workweek");
        continue;
      }
      const breaks: [bigint, bigint][] = [];
      let last = cardLo;
      let invalid = false;
      for (const b of [...c.time_breaks].sort((a, b) =>
        T.Instant.compare(a.starts_at, b.starts_at),
      )) {
        const a = ns(b.starts_at),
          z = b.ends_at ? ns(b.ends_at) : BigInt(0);
        if (!b.ends_at || a < cardLo || z > cardHi || z <= a || a < last) {
          invalid = true;
          break;
        }
        breaks.push([a, z]);
        last = z;
      }
      if (invalid) {
        warn("Invalid or incomplete unpaid break");
        continue;
      }
      const paid: [bigint, bigint][] = [];
      let cursor = cardLo;
      for (const [a, b] of breaks) {
        if (a > cursor) paid.push([cursor, a]);
        cursor = b;
      }
      if (cursor < cardHi) paid.push([cursor, cardHi]);
      for (const [p, q] of paid) {
        let a = max(p, contextLo),
          z = min(q, contextHi);
        while (a < z) {
          const week = floor(a - anchor, WEEK),
            key = week.toString(),
            weekEnd = anchor + (week + BigInt(1)) * WEEK;
          const rate = rates.filter((r) => ns(r.effective_at) <= a).at(-1);
          const next = rates.find((r) => ns(r.effective_at) > a);
          let b = min(z, weekEnd);
          if (next) b = min(b, ns(next.effective_at));
          if (a < lo) b = min(b, lo);
          else if (a < hi) b = min(b, hi);
          const length = b - a,
            used = weeks.get(key) || BigInt(0);
          const regularPart = min(
              length,
              max(BigInt(0), rule.thresholdNs - used),
            ),
            overtimePart = length - regularPart;
          weeks.set(key, used + length);
          if (!rate) warn("Missing wage rate in overtime workweek");
          else {
            const set = weekRates.get(key) || new Set<string>();
            set.add(rate.cents);
            weekRates.set(key, set);
            if (rate.classification !== "hourly_nonexempt")
              warn("Unsupported compensation or exemption classification");
          }
          if (a >= lo && a < hi) {
            regular += regularPart;
            ot += overtimePart;
            if (rate) {
              displayed.add(rate.cents);
              regNumerator +=
                regularPart * BigInt(rate.cents) * rule.regularFactor;
              otNumerator +=
                overtimePart * BigInt(rate.cents) * rule.overtimeFactor;
            }
          }
          a = b;
        }
      }
    }
    if ([...weekRates.values()].some((s) => s.size > 1))
      warn(
        "Multiple rates in a workweek: weighted regular-rate review required",
      );
    const round = (n: bigint) =>
      (n + (rule.denominator * HOUR) / BigInt(2)) / (rule.denominator * HOUR);
    const rc = round(regNumerator),
      oc = round(otNumerator);
    rows.push({
      employee: e.id,
      name: e.display_name,
      archived: !!e.archived_at,
      rates: [...displayed],
      regularNs: regular.toString(),
      overtimeNs: ot.toString(),
      regularCents: rc.toString(),
      overtimeCents: oc.toString(),
      totalCents: (rc + oc).toString(),
      warnings: [...warnings],
      approval: warnings.size ? "Needs review" : "Approved timecards",
    });
  }
  return {
    version: "federal-weekly-v1",
    start,
    end,
    rows,
    warnings: rows.flatMap((r) => r.warnings.map((w) => `${r.name}: ${w}`)),
  };
}
export function exportReport(r: Report, status: string) {
  return csv([
    [
      "Payroll-preparation report — estimated USD gross before deductions; not confirmation of payment",
    ],
    [
      "Employee",
      "Internal ID",
      "Period start (exclusive end follows)",
      "Period end",
      "Regular hours",
      "Overtime hours",
      "Hourly USD rate(s)",
      "Regular USD",
      "Overtime USD",
      "Total estimated gross USD",
      "Timecard review",
      "Report status",
    ],
    ...r.rows.map((x) => [
      x.name,
      x.employee,
      r.start,
      r.end,
      hours(x.regularNs),
      hours(x.overtimeNs),
      x.rates.map(money).join("; "),
      money(x.regularCents),
      money(x.overtimeCents),
      money(x.totalCents),
      x.approval,
      status,
    ]),
  ]);
}
