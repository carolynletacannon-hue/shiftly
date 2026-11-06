import { Temporal } from "@js-temporal/polyfill";
import type { Availability, TimeOff } from "./types";
import type { Shift } from "../scheduling/types";

export function timeOffConflict(
  shift: Pick<Shift, "employee_id" | "starts_at" | "ends_at">,
  requests: TimeOff[],
) {
  return requests.some(
    (r) =>
      r.employee_id === shift.employee_id &&
      r.status === "approved" &&
      Date.parse(r.starts_at) < Date.parse(shift.ends_at) &&
      Date.parse(shift.starts_at) < Date.parse(r.ends_at),
  );
}

// Split overnight shifts into local calendar days. Midnight boundaries use the
// timezone's actual day length, including 23/25-hour DST days.
export function availabilityWarning(
  shift: Pick<Shift, "employee_id" | "starts_at" | "ends_at">,
  rules: Availability[],
  timezone: string,
) {
  if (!shift.employee_id) return false;
  let start = Temporal.Instant.from(shift.starts_at).toZonedDateTimeISO(
    timezone,
  );
  const end = Temporal.Instant.from(shift.ends_at).toZonedDateTimeISO(timezone);
  while (Temporal.ZonedDateTime.compare(start, end) < 0) {
    const next = start.toPlainDate().add({ days: 1 }).toZonedDateTime(timezone);
    const stop = Temporal.ZonedDateTime.compare(end, next) < 0 ? end : next;
    const rule = rules.find(
      (r) =>
        r.employee_id === shift.employee_id &&
        r.weekday === start.dayOfWeek % 7,
    );
    if (rule) {
      if (rule.unavailable) return true;
      if (!rule.start_time || !rule.end_time) return true;
      // A repeated hour can leave and re-enter a window even when both
      // endpoints look available. Check each monotonic wall-clock segment.
      let cursor = start;
      while (Temporal.ZonedDateTime.compare(cursor, stop) < 0) {
        const transition = cursor.getTimeZoneTransition("next");
        const boundary =
          transition && Temporal.ZonedDateTime.compare(transition, stop) < 0
            ? transition
            : stop;
        const lastIncluded = boundary.subtract({ nanoseconds: 1 });
        if (
          Temporal.PlainTime.compare(cursor.toPlainTime(), rule.start_time) <
            0 ||
          Temporal.PlainTime.compare(
            lastIncluded.toPlainTime(),
            rule.end_time,
          ) >= 0
        )
          return true;
        cursor = boundary;
      }
    }
    start = stop;
  }
  return false;
}
