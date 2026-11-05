import { Temporal } from "@js-temporal/polyfill";
export type TimeChoice = "reject" | "earlier" | "later";
export function addDays(date: string, days: number) {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}
export function localDate(instant: string, timezone: string) {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
}
export function localInput(instant: string, timezone: string) {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timezone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}
export function localToInstant(
  value: string,
  timezone: string,
  choice: TimeChoice = "reject",
) {
  const local = Temporal.PlainDateTime.from(value);
  const result = local.toZonedDateTime(timezone, { disambiguation: choice });
  // Never silently move a spring-forward time into a different local hour.
  if (!result.toPlainDateTime().equals(local))
    throw new Error(
      "This local time does not exist because of daylight saving time.",
    );
  return result.toInstant().toString();
}
export function weekStart(date: string, firstDay = 0) {
  const day = Temporal.PlainDate.from(date);
  return day
    .subtract({ days: ((day.dayOfWeek % 7) - firstDay + 7) % 7 })
    .toString();
}
export function validWeek(
  value: string | undefined,
  timezone: string,
  firstDay = 0,
) {
  try {
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value))
      return weekStart(value, firstDay);
  } catch {}
  return weekStart(
    Temporal.Now.zonedDateTimeISO(timezone).toPlainDate().toString(),
    firstDay,
  );
}
export function weekBounds(week: string, timezone: string) {
  const start = Temporal.PlainDate.from(week)
    .toZonedDateTime(timezone)
    .toInstant();
  const end = Temporal.PlainDate.from(addDays(week, 7))
    .toZonedDateTime(timezone)
    .toInstant();
  return { start: start.toString(), end: end.toString() };
}
export function hoursInWeek(
  shifts: { starts_at: string; ends_at: string }[],
  week: string,
  timezone: string,
) {
  const bounds = weekBounds(week, timezone);
  const lo = Date.parse(bounds.start),
    hi = Date.parse(bounds.end);
  return shifts.reduce(
    (total, s) =>
      total +
      Math.max(
        0,
        Math.min(hi, Date.parse(s.ends_at)) -
          Math.max(lo, Date.parse(s.starts_at)),
      ) /
        3600000,
    0,
  );
}
export function copyTimes(
  shift: { starts_at: string; ends_at: string },
  sourceWeek: string,
  targetWeek: string,
  sourceTimezone: string,
  targetTimezone: string,
  choice: TimeChoice = "reject",
) {
  const days = Temporal.PlainDate.from(targetWeek).since(
    Temporal.PlainDate.from(sourceWeek),
  ).days;
  const move = (instant: string) => {
    const source = Temporal.Instant.from(instant)
      .toZonedDateTimeISO(sourceTimezone)
      .toPlainDateTime()
      .add({ days });
    return localToInstant(source.toString(), targetTimezone, choice);
  };
  return { starts_at: move(shift.starts_at), ends_at: move(shift.ends_at) };
}
export function shiftLabel(start: string, end: string, timezone: string) {
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: timezone,
  });
  const endDate =
    localDate(end, timezone) !== localDate(start, timezone)
      ? new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          timeZone: timezone,
        }).format(new Date(end)) + ", "
      : "";
  return `${time.format(new Date(start))} – ${endDate}${time.format(new Date(end))}`;
}
