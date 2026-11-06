import { addDays, localDate, weekBounds } from "./time";
import type { Member, Shift } from "./types";

/** Static schedule content, kept outside the application shell for printing. */
export function PrintSchedule({
  businessName,
  week,
  timezone,
  shifts,
  members,
  carryIn = [],
  draft,
}: {
  businessName: string;
  week: string;
  timezone: string;
  shifts: Shift[];
  members: Member[];
  carryIn?: Shift[];
  draft: boolean;
}) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index));
  const dateLabel = (date: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(
      new Date(`${date}T12:00:00Z`),
    );
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: timezone,
  });
  const zonedClock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: timezone, timeZoneName: "short",
  });
  const timeLabel = (slot: Shift) => {
    const start = new Date(slot.starts_at), end = new Date(slot.ends_at);
    const zone = (date: Date) => zonedClock.formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
    // State the schedule zone once in the heading, retaining both abbreviations
    // for shifts crossing a daylight-saving transition.
    const format = zone(start) === zone(end) ? clock : zonedClock;
    const endDate = localDate(slot.ends_at, timezone);
    const endDay = endDate === localDate(slot.starts_at, timezone)
      ? "" : `${dateLabel(endDate, { month: "short", day: "numeric" })}, `;
    return `${format.format(start)} – ${endDay}${format.format(end)}`;
  };
  const bounds = weekBounds(week, timezone);
  const roster = new Map(members.map((member) => [member.id, member.name]));
  // Each employee/empty place is a separate slot in the existing data model.
  // Combine equal time ranges so all employees and open places print together.
  const slots = [...new Map([...shifts, ...carryIn].map((slot) => [slot.id, slot])).values()]
    .filter((slot) => Date.parse(slot.starts_at) < Date.parse(bounds.end) &&
      Date.parse(slot.ends_at) > Date.parse(bounds.start))
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) ||
      Date.parse(a.ends_at) - Date.parse(b.ends_at));
  const columns = days.map((day) => {
    const groups = new Map<string, Shift[]>();
    for (const slot of slots) {
      const startDay = localDate(slot.starts_at, timezone);
      if (startDay !== day && !(day === week && startDay < week)) continue;
      const key = `${Date.parse(slot.starts_at)}:${Date.parse(slot.ends_at)}`;
      const group = groups.get(key) || [];
      group.push(slot);
      groups.set(key, group);
    }
    return [...groups.values()];
  });
  const rowCount = Math.max(1, ...columns.map((column) => column.length));

  return (
    <section className="print-schedule" aria-label="Printable weekly schedule">
      <header className="print-schedule-heading">
        <div>
          <h1>{businessName}</h1>
          <p>
            {dateLabel(week, { month: "long", day: "numeric", year: "numeric" })}
            {" – "}
            {dateLabel(days[6], { month: "long", day: "numeric", year: "numeric" })}
            {" · "}{timezone}
          </p>
        </div>
        {draft && <strong className="print-schedule-draft">Draft</strong>}
      </header>
      <table className="print-schedule-grid" aria-label="Seven-day shift calendar">
        <thead>
          <tr>{days.map((day) => (
            <th key={day} scope="col">
              <span>{dateLabel(day, { weekday: "long" })}</span>
              <span>{dateLabel(day, { month: "short", day: "numeric" })}</span>
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }, (_, row) => (
            <tr key={row}>{columns.map((column, index) => {
              const group = column[row];
              if (!group) return <td key={days[index]}>{row === 0 ? "No shifts" : null}</td>;
              const slot = group[0];
              const unassigned = group.filter((item) => !item.employee_id).length;
              const startDay = localDate(slot.starts_at, timezone);
              return (
                <td key={days[index]}>
                  <article className="print-schedule-shift">
                    {startDay < week && <p>Continues from {dateLabel(startDay, { weekday: "short", month: "short", day: "numeric" })}</p>}
                    <p className="print-schedule-time">{timeLabel(slot)}</p>
                    <ul>
                      {group.filter((item) => item.employee_id).map((item) => (
                        <li key={item.id}>{roster.get(item.employee_id!) || "Employee name unavailable"}</li>
                      ))}
                      {unassigned > 0 && <li className="print-schedule-unassigned">Unassigned{unassigned > 1 ? ` (${unassigned})` : ""}</li>}
                    </ul>
                  </article>
                </td>
              );
            })}</tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
