"use client";

import { useEffect, useState } from "react";
import { addDays, hoursInWeek, localDate, localToInstant, shiftLabel } from "./time";
import type { TimeOff, Availability } from "../time-off/types";
import { timeOffConflict, availabilityWarning } from "../time-off/conflicts";
import type { Member, Shift } from "./types";

export function CoverageCalendar({
  shifts,
  readOnly = false,
  timeOff,
  availability,
  members,
  week,
  timezone,
  availabilityTimezone = timezone,
  peers,
  carryIn = [],
  warning,
  pending,
  onAssign,
  onAdd,
  onEdit,
}: {
  shifts: Shift[];
  readOnly?: boolean;
  availabilityTimezone?: string;
  timeOff: TimeOff[];
  availability: Availability[];
  members: Member[];
  week: string;
  timezone: string;
  peers: Shift[];
  carryIn?: Shift[];
  warning: number;
  pending: boolean;
  onAssign: (slot: Shift, employeeId: string) => void;
  onAdd: (day: string) => void;
  onEdit: (slot: Shift) => void;
}) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(week, index));
  const [openId, setOpenId] = useState<string | null>(null);
  const open = shifts.find((slot) => slot.id === openId);
  const [employeeId, setEmployeeId] = useState("");
  useEffect(() => setEmployeeId(open?.employee_id || ""), [open?.id, open?.employee_id]);

  const dateLabel = (day: string) =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${day}T12:00:00Z`));

  function warnings(slot: Shift) {
    if (!employeeId) return { overlap: false, hours: 0 };
    const overlap = [...shifts, ...peers].some(
      (other) =>
        other.id !== slot.id &&
        other.employee_id === employeeId &&
        Date.parse(other.starts_at) < Date.parse(slot.ends_at) &&
        Date.parse(slot.starts_at) < Date.parse(other.ends_at),
    );
    const projected = [...shifts, ...carryIn]
      .filter((other) => other.id !== slot.id && other.employee_id === employeeId)
      .concat({ ...slot, employee_id: employeeId });
    return {
      overlap,
      hours: hoursInWeek(projected, week, timezone),
    };
  }

  return (
    <div className="coverage-calendar" aria-label="Weekly coverage schedule">
      {days.map((day) => {
        const daySlots = shifts
          .filter((slot) => slot.starts_at && slot.starts_at.slice(0, 10) !== "")
          .filter((slot) => localDate(slot.starts_at, timezone) === day)
          .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
        return (
          <section className="coverage-day" key={day} aria-labelledby={`day-${day}`}>
            <header>
              <div>
                <span>{dateLabel(day).split(",")[0]}</span>
                <strong id={`day-${day}`}>{dateLabel(day).split(", ").slice(1).join(", ")}</strong>
              </div>
              <span className="day-count">
                {daySlots.filter((slot) => slot.employee_id).length}/{daySlots.length}
              </span>
            </header>
            <div className="coverage-slot-list">
              {timeOff.filter(r => r.status === "approved" &&
                Date.parse(r.starts_at) < Date.parse(localToInstant(`${addDays(day, 1)}T00:00`, timezone, "earlier")) &&
                Date.parse(r.ends_at) > Date.parse(localToInstant(`${day}T00:00`, timezone, "earlier"))).map(r =>
                <div className="approved-time-off" key={r.id}><strong>{members.find(m => m.id === r.employee_id)?.name || "Employee"}</strong><br />Approved time off · {r.full_day ? "Full day" : shiftLabel(r.starts_at, r.ends_at, timezone)}</div>
              )}
              {daySlots.map((slot) => {
                const assigned = members.find((member) => member.id === slot.employee_id);
                const isOpen = openId === slot.id;
                const review = isOpen ? warnings(slot) : { overlap: false, hours: 0 };
                const hardConflict = timeOffConflict(slot, timeOff);
                const advisory = availabilityWarning(slot, availability, availabilityTimezone);
                const proposed = { ...slot, employee_id: employeeId || null };
                const proposedHard = isOpen && timeOffConflict(proposed, timeOff);
                const proposedAdvisory = isOpen && availabilityWarning(proposed, availability, availabilityTimezone);
                return (
                  <article
                    className={`coverage-slot ${slot.employee_id ? "covered" : "unassigned"} ${hardConflict ? "has-conflict" : ""}`}
                    key={slot.id}
                  >
                    <button
                      type="button"
                      className="slot-trigger"
                      aria-expanded={isOpen}
                      aria-controls={`assign-${slot.id}`}
                      onClick={() => setOpenId(isOpen ? null : slot.id)}
                    >
                      <span className="slot-topline">
                        <strong>{slot.label || slot.position_name || "Shift"}</strong>
                        <span className={`coverage-state ${slot.employee_id ? "covered" : "open"}`}>
                          {slot.employee_id ? "Covered" : "Open"}
                        </span>
                      </span>
                      <span className="slot-time">
                        {shiftLabel(slot.starts_at, slot.ends_at, timezone)}
                      </span>
                      <span className="slot-position">
                        {slot.position_name || "General"} · {slot.is_required ? "Required" : "One-off"}
                      </span>
                      <span className="slot-assignee">
                        <span className="avatar-mini" aria-hidden="true">
                          {assigned?.name?.slice(0, 1).toUpperCase() || "+"}
                        </span>
                        {assigned?.name || "Assign an employee"}
                      </span>
                    </button>
                    {hardConflict && <p className="hard-conflict">Hard conflict · approved time off</p>}
                    {advisory && <p className="inline-warning">Availability advisory</p>}
                    {isOpen && (
                      <div
                        className="assignment-popover"
                        id={`assign-${slot.id}`}
                        role="dialog"
                        aria-label={`Assign ${slot.label || "shift"}`}
                      >
                        <label>
                          Employee
                          <select
                            autoFocus
                            value={employeeId}
                            onChange={(event) => setEmployeeId(event.target.value)}
                          >
                            <option value="">Unassigned</option>
                            {members.map((member) => (
                              <option value={member.id} key={member.id}>
                                {member.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        {review.overlap && (
                          <p className="inline-warning" role="alert">
                            Overlaps another shift for this employee.
                          </p>
                        )}
                        {employeeId && review.hours > warning && (
                          <p className="inline-warning">
                            Projects {review.hours.toFixed(1)} hours this week, above the {warning}-hour review guideline.
                          </p>
                        )}
                        {proposedHard && <p className="hard-conflict" role="alert">Hard conflict: approved time off. Choose another employee.</p>}
                        {proposedAdvisory && <p className="inline-warning">Availability advisory: outside stated preferences. You may save this assignment.</p>}
                        <div className="popover-actions">
                          <button
                            type="button"
                            className="button primary"
                            disabled={pending || proposedHard || review.overlap || employeeId === (slot.employee_id || "")}
                            onClick={() => {
                              onAssign(slot, employeeId);
                              setOpenId(null);
                            }}
                          >
                            {employeeId ? "Save assignment" : "Unassign"}
                          </button>
                          {!slot.is_required && (
                            <button
                              type="button"
                              className="button secondary"
                              onClick={() => {
                                onEdit(slot);
                                setOpenId(null);
                              }}
                            >
                              Edit slot
                            </button>
                          )}
                          <button type="button" className="popover-close" onClick={() => setOpenId(null)}>
                            Close
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
              {!readOnly && !daySlots.length && <p className="empty-day">No coverage slots</p>}
            </div>
            {!readOnly && <button type="button" className="add-one-off" onClick={() => onAdd(day)}>
              + One-off slot
            </button>}
          </section>
        );
      })}
    </div>
  );
}
