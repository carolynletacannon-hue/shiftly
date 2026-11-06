import { groupShifts } from "./groups";
import { addDays, hoursInWeek, localDate, shiftLabel } from "./time";
import type { Member, Shift } from "./types";
export function ScheduleCalendar({
  shifts,
  members,
  week,
  timezone,
  view = "employees",
  carryIn = [],
  onCell,
  onShift,
  warning = 40,
}: {
  shifts: Shift[];
  members: Member[];
  week: string;
  timezone: string;
  view?: string;
  carryIn?: Shift[];
  onCell?: (employee: string, date: string) => void;
  onShift?: (shift: Shift) => void;
  warning?: number;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const label = (day: string) =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(day + "T12:00:00Z"));
  const card = (s: Shift & { assignments?: Shift[] }, showName = false) => (
    <div key={s.id} className="schedule-shift">
      {s.label && <strong>{s.label}</strong>}
      {showName && (
        <strong>
          {(s.assignments || [s])
            .map(
              (a) =>
                members.find((m) => m.id === a.employee_id)?.name ||
                "Team member",
            )
            .join(", ")}
        </strong>
      )}
      {onShift ? (
        <button
          type="button"
          className="shift-edit"
          onClick={() => onShift(s)}
          aria-label={`Edit shift: ${shiftLabel(s.starts_at, s.ends_at, timezone)}`}
        >
          {shiftLabel(s.starts_at, s.ends_at, timezone)}
        </button>
      ) : (
        <strong>{shiftLabel(s.starts_at, s.ends_at, timezone)}</strong>
      )}
      <span>{s.position_name || "General"}</span>
      {s.notes && <small>{s.notes}</small>}
    </div>
  );
  return (
    <>
      {view === "days" && (
        <div className="schedule-hour-summary">
          {members.map((member) => (
            <span key={member.id}>
              <strong>{member.name}</strong> ·{" "}
              {hoursInWeek(
                [...shifts, ...carryIn].filter(
                  (s) => s.employee_id === member.id,
                ),
                week,
                timezone,
              ).toFixed(1)}{" "}
              h
            </span>
          ))}
        </div>
      )}
      <div
        className="calendar-scroll"
        role="region"
        aria-label="Weekly schedule"
        tabIndex={0}
      >
        {view === "days" ? (
          <div className="schedule-days">
            {days.map((day) => (
              <section key={day}>
                <h3>{label(day)}</h3>
                {groupShifts(shifts)
                  .filter((s) => localDate(s.starts_at, timezone) === day)
                  .map((s) => card(s, true))}
                {!shifts.some(
                  (s) => localDate(s.starts_at, timezone) === day,
                ) && <p className="muted">No shifts</p>}
                {onCell && (
                  <button
                    className="button secondary"
                    onClick={() => onCell(members[0]?.id || "", day)}
                    disabled={!members.length}
                  >
                    + Add shift
                  </button>
                )}
              </section>
            ))}
          </div>
        ) : (
          <table className="schedule-table">
            <caption className="sr-only">
              Week beginning {week}. All times in {timezone}.
            </caption>
            <thead>
              <tr>
                <th scope="col">Team member / hours</th>
                {days.map((day) => (
                  <th scope="col" key={day}>
                    {label(day)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const hours = hoursInWeek(
                  [...shifts, ...carryIn].filter(
                    (s) => s.employee_id === member.id,
                  ),
                  week,
                  timezone,
                );
                return (
                  <tr key={member.id}>
                    <th scope="row">
                      <strong>{member.name}</strong>
                      <span
                        className={hours > warning ? "hours-warning" : "muted"}
                      >
                        {hours.toFixed(1)} h scheduled
                        {hours > warning ? " · review hours" : ""}
                      </span>
                    </th>
                    {days.map((day) => (
                      <td key={day}>
                        {shifts
                          .filter(
                            (s) =>
                              s.employee_id === member.id &&
                              localDate(s.starts_at, timezone) === day,
                          )
                          .map((s) => card(s))}
                        {onCell && (
                          <button
                            className="add-shift"
                            onClick={() => onCell(member.id, day)}
                            aria-label={`Add shift for ${member.name} on ${day}`}
                          >
                            + Add
                          </button>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {carryIn.length > 0 && (
        <div className="carry-in">
          <h3>Continuing from the previous week</h3>
          {carryIn.map((s) => card(s, true))}
          <p className="muted">
            Only the hours inside this week count toward this week’s total. Edit
            these shifts in their starting week.
          </p>
        </div>
      )}
    </>
  );
}
