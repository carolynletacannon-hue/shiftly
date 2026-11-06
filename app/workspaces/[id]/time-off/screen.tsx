"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Availability, TimeOff } from "@/lib/time-off/types";
import { shiftLabel } from "@/lib/scheduling/time";
import { timeOffAction } from "./actions";

type Employee = { id: string; name: string; placeholder: boolean };
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export function TimeOffScreen({
  org,
  timezone,
  manager,
  ownId,
  employees,
  requests,
  availability,
  shifts,
}: {
  org: string;
  timezone: string;
  manager: boolean;
  ownId: string;
  employees: Employee[];
  requests: TimeOff[];
  availability: Availability[];
  shifts: { employee_id: string | null; starts_at: string; ends_at: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [feedback, setFeedback] = useState("");
  const [failed, setFailed] = useState(false);
  function run(
    command: string,
    input: Record<string, unknown>,
    done?: () => void,
  ) {
    setFeedback("");
    start(async () => {
      try {
        const result = await timeOffAction(org, command, input);
        setFailed(!result.ok);
        setFeedback(result.message);
        if (result.ok) {
          done?.();
          router.refresh();
        }
      } catch {
        setFailed(true);
        setFeedback(
          "Unable to confirm the result. Refresh before trying again.",
        );
      }
    });
  }
  function cards(items: TimeOff[]) {
    return items.map((r) => {
      const employee = employees.find((e) => e.id === r.employee_id);
      const conflict = shifts.some(
        (s) =>
          s.employee_id === r.employee_id &&
          Date.parse(s.starts_at) < Date.parse(r.ends_at) &&
          Date.parse(r.starts_at) < Date.parse(s.ends_at),
      );
      return (
        <article className="time-off-card" key={r.id}>
          <div className="time-off-card-heading">
            <strong>{employee?.name || "Employee"}</strong>
            <span className={`time-off-status ${r.status}`}>
              {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
            </span>
          </div>
          <p>
            <strong>
              {dateLabel(r.start_date)}
              {r.end_date !== r.start_date ? ` – ${dateLabel(r.end_date)}` : ""}
            </strong>
            <br />
            {r.full_day
              ? "Full day"
              : shiftLabel(r.starts_at, r.ends_at, r.timezone)}{" "}
            · {r.timezone}
          </p>
          {r.notes && <p className="private-note">{r.notes}</p>}
          {manager &&
            conflict &&
            ["pending", "approved"].includes(r.status) && (
              <p
                className={
                  r.status === "approved" ? "hard-conflict" : "inline-warning"
                }
              >
                {r.status === "approved"
                  ? "Hard conflict: reassign existing shifts before publishing."
                  : "Already scheduled in this period. Approval will require reassignment; published shifts stay unchanged."}
              </p>
            )}
          <div className="schedule-tools">
            {manager && r.status === "pending" && (
              <>
                <button
                  className="button primary"
                  disabled={pending}
                  onClick={() => run("approve", { id: r.id })}
                >
                  Approve
                </button>
                <button
                  className="button secondary"
                  disabled={pending}
                  onClick={() => run("deny", { id: r.id })}
                >
                  Deny
                </button>
              </>
            )}
            {r.employee_id === ownId && r.status === "pending" && (
              <button
                className="button secondary"
                disabled={pending}
                onClick={() => run("cancel", { id: r.id })}
              >
                Cancel request
              </button>
            )}
            {manager && employee?.placeholder && r.status === "approved" && (
              <button
                className="button secondary"
                disabled={pending}
                onClick={() => run("remove_manual", { id: r.id })}
              >
                Remove manual time off
              </button>
            )}
          </div>
        </article>
      );
    });
  }
  const waiting = requests.filter((r) => r.status === "pending");
  return (
    <div className="time-off-screen" aria-busy={pending}>
      <div aria-live="polite">
        {feedback && (
          <p
            className={`notice ${failed ? "schedule-error" : ""}`}
            role={failed ? "alert" : "status"}
          >
            {feedback}
          </p>
        )}
      </div>
      {manager && (
        <section className="panel workspace-card">
          <h2>Pending requests ({waiting.length})</h2>
          {waiting.length ? (
            <div className="time-off-list">{cards(waiting)}</div>
          ) : (
            <p className="muted">No requests waiting for review.</p>
          )}
        </section>
      )}
      {!manager && (
        <section className="panel workspace-card">
          <h2>Request time off</h2>
          {ownId ? (
            <RequestForm
              employeeId={ownId}
              timezone={timezone}
              pending={pending}
              onSave={(input, done) => run("submit", input, done)}
            />
          ) : (
            <p>
              Your manager needs to link your account to an employee record.
            </p>
          )}
        </section>
      )}
      {manager && (
        <details className="panel workspace-card">
          <summary>Enter time off for an employee without an account</summary>
          <p>This records approved time off immediately.</p>
          <RequestForm
            employees={employees.filter((e) => e.placeholder)}
            timezone={timezone}
            pending={pending}
            onSave={(input, done) => run("manual", input, done)}
          />
        </details>
      )}
      {manager && ownId && (
        <details className="panel workspace-card">
          <summary>Request time off for myself</summary>
          <RequestForm
            employeeId={ownId}
            timezone={timezone}
            pending={pending}
            onSave={(input, done) => run("submit", input, done)}
          />
        </details>
      )}
      <section className="panel workspace-card">
        <h2>{manager ? "Request history" : "My requests"}</h2>
        <div className="time-off-list">
          {cards(requests.filter((r) => !manager || r.status !== "pending"))}
        </div>
        {!requests.some((r) => !manager || r.status !== "pending") && (
          <p className="muted">No requests yet.</p>
        )}
      </section>
      {ownId && (
        <details className="panel workspace-card">
          <summary>My weekly availability</summary>
          <p>
            These preferences repeat every week in {timezone}. Managers see
            advisory warnings and may still assign you. Use a time-off request
            for dates that need approval.
          </p>
          <AvailabilityForm
            key={JSON.stringify(
              availability.filter((a) => a.employee_id === ownId),
            )}
            employeeId={ownId}
            availability={availability}
            pending={pending}
            onSave={(input) => run("availability", input)}
          />
        </details>
      )}
    </div>
  );
}
function RequestForm({
  employeeId,
  employees,
  timezone,
  pending,
  onSave,
}: {
  employeeId?: string;
  employees?: Employee[];
  timezone: string;
  pending: boolean;
  onSave: (input: Record<string, unknown>, done: () => void) => void;
}) {
  const [full, setFull] = useState(true);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  return (
    <form
      className="account-form time-off-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        onSave(
          { ...Object.fromEntries(new FormData(form)), full_day: full },
          () => {
            form.reset();
            setFirst("");
            setLast("");
            setFull(true);
          },
        );
      }}
    >
      <fieldset disabled={pending || (!!employees && !employees.length)}>
        {employeeId ? (
          <input type="hidden" name="employee_id" value={employeeId} />
        ) : (
          <label>
            Employee
            <select name="employee_id" required defaultValue="">
              <option value="" disabled>
                Choose employee
              </option>
              {employees?.map((e) => (
                <option value={e.id} key={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {employees && !employees.length && (
          <p className="muted">
            Add an employee without an account on the Employees page first.
          </p>
        )}
        <label>
          First day
          <input
            type="date"
            name="start_date"
            required
            value={first}
            onChange={(e) => {
              setFirst(e.target.value);
              if (!last || last < e.target.value) setLast(e.target.value);
            }}
          />
        </label>
        <label>
          Last day (same date for one day)
          <input
            type="date"
            name="end_date"
            required
            min={first || undefined}
            value={last}
            onChange={(e) => setLast(e.target.value)}
          />
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={full}
            onChange={(e) => setFull(e.target.checked)}
          />
          Full day / all selected days
        </label>
        {!full && (
          <>
            <p className="muted">
              Partial time off runs continuously from the first day’s start time
              to the last day’s end time, in {timezone}.
            </p>
            <label>
              Start time
              <input type="time" name="start_time" required />
            </label>
            <label>
              End time
              <input type="time" name="end_time" required />
            </label>
            <details>
              <summary>Daylight-saving hour options</summary>
              {["start", "end"].map((boundary) => (
                <label key={boundary}>
                  {boundary === "start" ? "Start" : "End"} repeated hour
                  <select name={`${boundary}_choice`} defaultValue="reject">
                    <option value="reject">Ask if ambiguous</option>
                    <option value="earlier">Earlier occurrence</option>
                    <option value="later">Later occurrence</option>
                  </select>
                </label>
              ))}
            </details>
          </>
        )}
        <label>
          Note (optional, visible to your managers)
          <textarea name="notes" rows={2} maxLength={1000} />
        </label>
        <button className="button primary">
          {employees ? "Record approved time off" : "Submit request"}
        </button>
      </fieldset>
    </form>
  );
}
function AvailabilityForm({
  employeeId,
  availability,
  pending,
  onSave,
}: {
  employeeId: string;
  availability: Availability[];
  pending: boolean;
  onSave: (input: Record<string, unknown>) => void;
}) {
  const [rules, setRules] = useState(() =>
    weekdays.map((_, weekday) => {
      const rule = availability.find(
        (a) => a.employee_id === employeeId && a.weekday === weekday,
      );
      return {
        kind: !rule ? "any" : rule.unavailable ? "unavailable" : "window",
        start: rule?.start_time?.slice(0, 5) || "09:00",
        end: rule?.end_time?.slice(0, 5) || "17:00",
      };
    }),
  );
  return (
    <form
      className="account-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          employee_id: employeeId,
          days: rules.flatMap((r, weekday) =>
            r.kind === "any"
              ? []
              : [
                  {
                    weekday,
                    unavailable: r.kind === "unavailable",
                    start_time: r.kind === "window" ? r.start : null,
                    end_time: r.kind === "window" ? r.end : null,
                  },
                ],
          ),
        });
      }}
    >
      <fieldset disabled={pending}>
        {rules.map((rule, day) => (
          <div className="availability-row" key={day}>
            <label>
              {weekdays[day]}
              <select
                value={rule.kind}
                onChange={(e) =>
                  setRules(
                    rules.map((r, i) =>
                      i === day ? { ...r, kind: e.target.value } : r,
                    ),
                  )
                }
              >
                <option value="any">No preference</option>
                <option value="unavailable">Unavailable</option>
                <option value="window">Available between</option>
              </select>
            </label>
            {rule.kind === "window" && (
              <>
                <label>
                  From
                  <input
                    type="time"
                    required
                    value={rule.start}
                    onChange={(e) =>
                      setRules(
                        rules.map((r, i) =>
                          i === day ? { ...r, start: e.target.value } : r,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Until
                  <input
                    type="time"
                    required
                    min={rule.start}
                    value={rule.end}
                    onChange={(e) =>
                      setRules(
                        rules.map((r, i) =>
                          i === day ? { ...r, end: e.target.value } : r,
                        ),
                      )
                    }
                  />
                </label>
              </>
            )}
          </div>
        ))}
        <button className="button primary">Save availability</button>
      </fieldset>
    </form>
  );
}
