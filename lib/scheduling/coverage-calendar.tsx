"use client";
import { EmployeeColorLabel } from "./employee-color-label";
import { employeeColorStyle } from "./employee-colors";
import * as Popover from "@radix-ui/react-popover";
import { ResponsiveWeek } from "./responsive-week";
import { Select } from "@/app/ui/select";
import { Button } from "@/app/ui/button";
import { Checkbox } from "@/app/ui/checkbox";
import { timeOffConflict, availabilityWarning } from "../time-off/conflicts";
import type { TimeOff, Availability } from "../time-off/types";
import { useState } from "react";
import {
  addDays,
  hoursInWeek,
  localDate,
  localToInstant,
  shiftLabel,
} from "./time";
import { groupShifts } from "./groups";
import type { Member, Shift } from "./types";
export function CoverageCalendar({
  shifts,
  members,
  week,
  timezone,
  peers,
  readOnly = false,
  timeOff = [],
  availability = [],
  availabilityTimezone = timezone,
  carryIn = [],
  warning,
  pending,
  onAssign,
  onRemove = () => {},
  onStaffing = () => {},
  onAdd,
  onEdit,
}: {
  readOnly?: boolean;
  timeOff?: TimeOff[];
  availability?: Availability[];
  availabilityTimezone?: string;
  shifts: Shift[];
  members: Member[];
  week: string;
  timezone: string;
  peers: Shift[];
  carryIn?: Shift[];
  warning: number;
  pending: boolean;
  onAssign: (slot: Shift, employeeId: string) => void;
  onRemove?: (slot: Shift, assignmentId: string) => void;
  onStaffing?: (slot: Shift, count: string, overstaffing: boolean) => void;
  onAdd: (day: string) => void;
  onEdit: (slot: Shift) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const groups = groupShifts(shifts);
  return (
    <ResponsiveWeek
      key={week}
      week={week}
      counts={Array.from(
        { length: 7 },
        (_, index) =>
          groups.filter(
            (group) =>
              localDate(group.starts_at, timezone) === addDays(week, index),
          ).length,
      )}
    >
      <div
        className="coverage-calendar"
        role="region"
        aria-label="Weekly coverage schedule"
      >
        {Array.from({ length: 7 }, (_, i) => addDays(week, i)).map((day, i) => {
          const dayGroups = groups
            .filter((g) => localDate(g.starts_at, timezone) === day)
            .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
          const label = new Intl.DateTimeFormat("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          }).format(new Date(`${day}T12:00:00Z`));
          return (
            <section
              className="coverage-day"
              data-week-day={day}
              data-day-index={i}
              key={day}
              aria-labelledby={`day-${day}`}
            >
              <header>
                <div>
                  <span>{label.split(",")[0]}</span>
                  <strong id={`day-${day}`}>
                    {label.split(", ").slice(1).join(", ")}
                  </strong>
                </div>
                <span className="day-count">{dayGroups.length} shifts</span>
              </header>
              <div className="coverage-slot-list">
                {timeOff
                  .filter(
                    (request) =>
                      request.status === "approved" &&
                      Date.parse(request.starts_at) <
                        Date.parse(
                          localToInstant(
                            `${addDays(day, 1)}T00:00`,
                            timezone,
                            "earlier",
                          ),
                        ) &&
                      Date.parse(request.ends_at) >
                        Date.parse(
                          localToInstant(`${day}T00:00`, timezone, "earlier"),
                        ),
                  )
                  .map((request) => (
                    <div className="approved-time-off" key={request.id}>
                      <strong>
                        {members.find((m) => m.id === request.employee_id)
                          ?.name || "Employee"}
                      </strong>
                      <br />
                      Approved time off ·{" "}
                      {request.full_day
                        ? "Full day"
                        : shiftLabel(
                            request.starts_at,
                            request.ends_at,
                            timezone,
                          )}
                    </div>
                  ))}
                {dayGroups.map((group) => {
                  const isOpen = openId === group.id;
                  const overlap =
                    !!employeeId &&
                    [...shifts, ...peers].some(
                      (other) =>
                        other.employee_id === employeeId &&
                        other.id !== group.id &&
                        Date.parse(other.starts_at) <
                          Date.parse(group.ends_at) &&
                        Date.parse(group.starts_at) < Date.parse(other.ends_at),
                    );
                  const hours = employeeId
                    ? hoursInWeek(
                        [...shifts, ...carryIn]
                          .filter((other) => other.employee_id === employeeId)
                          .concat({ ...group, employee_id: employeeId }),
                        week,
                        timezone,
                      )
                    : 0;
                  const proposed = { ...group, employee_id: employeeId };
                  const timeOffBlocked =
                    !!employeeId && timeOffConflict(proposed, timeOff);
                  const availabilityAdvisory =
                    !!employeeId &&
                    availabilityWarning(
                      proposed,
                      availability,
                      availabilityTimezone,
                    );
                  const hardConflict = group.assignments.some((a) =>
                    timeOffConflict(a, timeOff),
                  );
                  const advisory = group.assignments.some((a) =>
                    availabilityWarning(a, availability, availabilityTimezone),
                  );
                  const covered =
                    group.assignments.length >= group.required_count;
                  return (
                    <article
                      className={`coverage-slot ${covered ? "covered" : "unassigned"} ${hardConflict ? "has-conflict" : ""} ${group.assignments.length === 1 ? "has-employee-color" : ""}`}
                      style={
                        group.assignments.length === 1
                          ? employeeColorStyle(
                              members.find(
                                (member) =>
                                  member.id ===
                                  group.assignments[0].employee_id,
                              )?.color_key,
                            )
                          : undefined
                      }
                      key={group.id}
                    >
                      <Popover.Root
                        open={isOpen}
                        onOpenChange={(open) => {
                          setOpenId(open ? group.id : null);
                          if (open) setEmployeeId("");
                        }}
                      >
                        <Popover.Trigger asChild>
                          <button
                            type="button"
                            disabled={readOnly}
                            className="slot-trigger"
                            aria-expanded={isOpen}
                            aria-controls={`assign-${group.id}`}
                          >
                            <span className="slot-topline">
                              <strong>{group.label || "Shift"}</strong>
                              <span
                                className={`coverage-state ${covered ? "covered" : "open"}`}
                              >
                                {group.assignments.length}/
                                {group.required_count}
                              </span>
                            </span>
                            <span className="slot-time">
                              {shiftLabel(
                                group.starts_at,
                                group.ends_at,
                                timezone,
                              )}
                            </span>
                            <span className="slot-position">
                              {group.position_name || "General"} ·{" "}
                              {group.is_required ? "Recurring" : "One-off"}
                            </span>
                            <span className="slot-assignees">
                              {group.assignments.map((a) => (
                                <span className="slot-assignee" key={a.id}>
                                  <EmployeeColorLabel
                                    className="slot-assignee-name"
                                    name={
                                      members.find(
                                        (m) => m.id === a.employee_id,
                                      )?.name || "Team member"
                                    }
                                    color={
                                      members.find(
                                        (m) => m.id === a.employee_id,
                                      )?.color_key
                                    }
                                  />
                                </span>
                              ))}
                              {!group.assignments.length && (
                                <span className="slot-assignee">
                                  + Assign employees
                                </span>
                              )}
                            </span>
                            <span className="sr-only">
                              {group.assignments.length} of{" "}
                              {group.required_count} employees assigned. Manage
                              shift.
                            </span>
                            {group.notes && (
                              <small className="slot-note">{group.notes}</small>
                            )}
                          </button>
                        </Popover.Trigger>
                        {hardConflict && (
                          <p className="hard-conflict">
                            Hard conflict · an assigned employee has approved
                            time off
                          </p>
                        )}
                        {advisory && (
                          <p className="inline-warning">
                            Availability advisory · review assigned employees’
                            preferences
                          </p>
                        )}
                        {isOpen && (
                          <Popover.Portal>
                            <Popover.Content
                              className="assignment-popover weekly-assignment-popover"
                              align="start"
                              sideOffset={6}
                              collisionPadding={12}
                              aria-label={`Manage ${group.label || "shift"} assignments`}
                              id={`assign-${group.id}`}
                              onKeyDown={(e) => {
                                if (e.key === "Escape" && !e.defaultPrevented)
                                  setOpenId(null);
                              }}
                            >
                              <p className="eyebrow">EMPLOYEE ASSIGNMENTS</p>
                              {group.assignments.map((a) => (
                                <div className="assignment-row" key={a.id}>
                                  <span>
                                    {members.find((m) => m.id === a.employee_id)
                                      ?.name || "Team member"}
                                  </span>
                                  <button
                                    type="button"
                                    className="remove-assignment"
                                    disabled={pending}
                                    onClick={() => onRemove(group, a.id)}
                                    aria-label={`Remove ${members.find((m) => m.id === a.employee_id)?.name || "employee"} from this shift`}
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                              <label>
                                Add employee
                                <Select
                                  value={employeeId}
                                  onChange={(e) =>
                                    setEmployeeId(e.target.value)
                                  }
                                >
                                  <option value="">Select employee…</option>
                                  {members
                                    .filter((member) => !member.archived)
                                    .filter(
                                      (m) =>
                                        !group.assignments.some(
                                          (a) => a.employee_id === m.id,
                                        ),
                                    )
                                    .map((m) => (
                                      <option key={m.id} value={m.id}>
                                        {m.name}
                                      </option>
                                    ))}
                                </Select>
                              </label>
                              {timeOffBlocked && (
                                <p className="inline-warning" role="alert">
                                  Approved time off conflicts with this shift.
                                </p>
                              )}
                              {availabilityAdvisory && (
                                <p className="inline-warning">
                                  Availability advisory: outside this employee’s
                                  stated preferences.
                                </p>
                              )}
                              {overlap && (
                                <p className="inline-warning" role="alert">
                                  This employee has an overlapping shift.
                                </p>
                              )}
                              {!!employeeId && hours > warning && (
                                <p className="inline-warning">
                                  Projects {hours.toFixed(1)} hours; review the{" "}
                                  {warning}-hour guideline.
                                </p>
                              )}
                              {!group.allow_overstaffing && covered && (
                                <p className="availability-note">
                                  Staffing limit reached. Increase the
                                  requirement or allow extra employees.
                                </p>
                              )}
                              <Button
                                icon="plus"
                                type="button"
                                className="button primary"
                                disabled={
                                  pending ||
                                  !employeeId ||
                                  overlap ||
                                  timeOffBlocked ||
                                  (!group.allow_overstaffing && covered)
                                }
                                onClick={() => {
                                  onAssign(group, employeeId);
                                  setEmployeeId("");
                                }}
                              >
                                Add employee
                              </Button>
                              <form
                                className="staffing-form"
                                key={`${group.id}:${group.required_count}:${group.allow_overstaffing}`}
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  const data = new FormData(e.currentTarget);
                                  onStaffing(
                                    group,
                                    String(data.get("count")),
                                    data.get("overstaffing") === "on",
                                  );
                                }}
                              >
                                <label>
                                  Employees needed
                                  <input
                                    name="count"
                                    aria-label="Employees needed"
                                    type="number"
                                    min="1"
                                    max="50"
                                    required
                                    defaultValue={group.required_count}
                                  />
                                </label>
                                <label className="check-label">
                                  <Checkbox
                                    name="overstaffing"
                                    defaultChecked={group.allow_overstaffing}
                                  />
                                  Allow extra employees
                                </label>
                                <Button
                                  icon="check"
                                  className="button secondary"
                                  disabled={pending}
                                >
                                  Save staffing
                                </Button>
                              </form>
                              <p className="availability-note">
                                Availability preferences are advisory. Approved
                                time off blocks assignment. Changes stay private
                                until published.
                              </p>
                              <Button
                                type="button"
                                className="button secondary"
                                onClick={() => {
                                  onEdit(group);
                                  setOpenId(null);
                                }}
                              >
                                Edit shift details
                              </Button>
                              <button
                                type="button"
                                className="popover-close"
                                onClick={() => setOpenId(null)}
                              >
                                Close
                              </button>
                            </Popover.Content>
                          </Popover.Portal>
                        )}
                      </Popover.Root>
                    </article>
                  );
                })}
                {!dayGroups.length && (
                  <p className="empty-day">No shifts planned</p>
                )}
              </div>
              {!readOnly && (
                <button
                  type="button"
                  className="add-one-off"
                  onClick={() => onAdd(day)}
                >
                  + Add shift
                </button>
              )}
            </section>
          );
        })}
      </div>
    </ResponsiveWeek>
  );
}
