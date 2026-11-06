export type CalendarEvent = {
  shift_id: string;
  employee_id: string;
  organization_id: string;
  sequence: number;
  updated_at: string;
  cancelled: boolean;
  details: {
    starts_at: string;
    ends_at: string;
    label: string;
    position: string;
    business: string;
    notes: string;
  };
};

export function escapeText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** RFC 5545: 75 octets, including the continuation space; never split UTF-8. */
export function foldLine(line: string) {
  const lines: string[] = [];
  let current = "",
    bytes = 0;
  for (const char of line) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 75) {
      lines.push(current);
      current = " ";
      bytes = 1;
    }
    current += char;
    bytes += size;
  }
  return [...lines, current].join("\r\n");
}
const instant = (value: string) =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

/** Published timestamps are UTC instants: calendar apps display their own zone. */
export function calendarFeed(events: CalendarEvent[], origin: string) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Meadowmark//Work Schedule//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Meadowmark work schedule",
  ];
  for (const event of events) {
    const d = event.details;
    const url = `${origin}/workspaces/${event.organization_id}/my-schedule`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.organization_id}-${event.employee_id}-${event.shift_id}@calendar.meadowmark`,
      `DTSTAMP:${instant(event.updated_at)}`,
      `LAST-MODIFIED:${instant(event.updated_at)}`,
      `SEQUENCE:${event.sequence}`,
      `DTSTART:${instant(d.starts_at)}`,
      `DTEND:${instant(d.ends_at)}`,
      `SUMMARY:${escapeText(`${d.label || d.position} · ${d.business}`)}`,
      `DESCRIPTION:${escapeText([d.position, d.notes, `My Schedule: ${url}`].filter(Boolean).join("\n"))}`,
      `LOCATION:${escapeText(d.business)}`,
      `URL:${url}`,
      `STATUS:${event.cancelled ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }
  return [...lines, "END:VCALENDAR"].map(foldLine).join("\r\n") + "\r\n";
}
