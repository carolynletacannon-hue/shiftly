import { Temporal } from "@js-temporal/polyfill";
import { contextBounds, type Settings } from "../payroll/engine";
import { durations, type Timecard } from "./records";
/** Visibility only: never authorizes time or calculates wages. Each employee has
 * their own 40-hour counter, including recorded time before the filter boundary. */
export function recordedOvertime(
  cards: Timecard[],
  start: string,
  end: string,
  now: string,
  settings: Settings,
) {
  const context = contextBounds(settings, start, end);
  const result = new Map<string, number>();
  let week = Temporal.Instant.from(context.start);
  while (Temporal.Instant.compare(week, context.end) < 0) {
    const next = week.add({ hours: 168 });
    const before = new Map<string, number>();
    const lo =
      Temporal.Instant.compare(week, start) > 0 ? week.toString() : start;
    const hi = Temporal.Instant.compare(next, end) < 0 ? next.toString() : end;
    for (const card of [...cards].sort((a, b) =>
      Temporal.Instant.compare(a.clock_in, b.clock_in),
    )) {
      if (card.voided_at) continue;
      const earlier = durations(card, week.toString(), lo, now).paidHours;
      const inside = durations(card, lo, hi, now).paidHours;
      const used = before.get(card.employee_id) || 0;
      const overtime =
        Math.max(0, used + earlier + inside - 40) -
        Math.max(0, used + earlier - 40);
      if (overtime > 0)
        result.set(card.id, (result.get(card.id) || 0) + overtime);
      before.set(card.employee_id, used + earlier + inside);
    }
    week = next;
  }
  return result;
}
