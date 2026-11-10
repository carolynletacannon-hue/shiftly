import { Temporal } from "@js-temporal/polyfill";
export type Break = { starts_at: string; ends_at: string | null };
export type Timecard = {
  id: string;
  organization_id: string;
  employee_id: string;
  kiosk_id: string | null;
  clock_in: string;
  clock_out: string | null;
  revision: number;
  approved_at: string | null;
  approval_source?: "automatic" | "manager" | null;
  voided_at: string | null;
  created_at: string;
  time_breaks: Break[];
};
export function dateBounds(from: string, to: string, timezone: string) {
  const a = Temporal.PlainDate.from(from),
    b = Temporal.PlainDate.from(to);
  if (Temporal.PlainDate.compare(a, b) > 0 || b.since(a).days > 366)
    throw Error("Choose a date range of up to 366 days.");
  return {
    start: a.toZonedDateTime(timezone).toInstant().toString(),
    end: b.add({ days: 1 }).toZonedDateTime(timezone).toInstant().toString(),
  };
}
/** Intersect actual UTC instants with a reporting interval; never round recorded time. */
export function durations(
  card: Pick<Timecard, "clock_in" | "clock_out" | "time_breaks"> & {
    voided_at?: string | null;
  },
  start: string,
  end: string,
  now: string,
) {
  if (card.voided_at) return { unpaidSeconds: 0, paidHours: 0 };
  const ns = (value: string) => Temporal.Instant.from(value).epochNanoseconds;
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const lo = max(ns(start), ns(card.clock_in));
  const hi = min(ns(end), ns(card.clock_out || now));
  const gross = max(BigInt(0), hi - lo);
  const unpaid = card.time_breaks.reduce(
    (sum, b) =>
      sum +
      max(
        BigInt(0),
        min(hi, ns(b.ends_at || card.clock_out || now)) -
          max(lo, ns(b.starts_at)),
      ),
    BigInt(0),
  );
  return {
    unpaidSeconds: Number(unpaid) / 1e9,
    paidHours: Number(gross - unpaid) / 3.6e12,
  };
}
export function csvCell(value: unknown) {
  let s = String(value ?? "");
  if (/^[\s]*[=+\-@\t\r\n]/.test(s)) s = "'" + s;
  return `"${s.replaceAll('"', '""')}"`;
}
export const csv = (rows: unknown[][]) =>
  "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
export function status(card: Timecard, now: string) {
  if (card.voided_at) return "Voided";
  if (
    !card.clock_out &&
    Date.parse(now) - Date.parse(card.clock_in) > 16 * 3600000
  )
    return "Missing Punch";
  if (!card.clock_out)
    return card.time_breaks.some((b) => !b.ends_at) ? "On Break" : "Working";
  return card.approved_at ? "Approved" : "Clocked Out";
}
