"use client";
import { useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { ClockForm } from "./controls";
import type { Timecard } from "@/lib/time-clock/records";
type Choice = "reject" | "earlier" | "later";
function local(value: string, timezone: string) {
  return Temporal.Instant.from(value)
    .toZonedDateTimeISO(timezone)
    .toPlainDateTime()
    .toString();
}
function choice(value: string, timezone: string): Choice {
  const instant = Temporal.Instant.from(value),
    plain = instant.toZonedDateTimeISO(timezone).toPlainDateTime();
  const early = plain
      .toZonedDateTime(timezone, { disambiguation: "earlier" })
      .toInstant(),
    late = plain
      .toZonedDateTime(timezone, { disambiguation: "later" })
      .toInstant();
  return early.equals(late)
    ? "reject"
    : instant.equals(early)
      ? "earlier"
      : "later";
}
function Dst({
  name,
  value,
  onChange,
}: {
  name?: string;
  value?: Choice;
  onChange?: (v: Choice) => void;
}) {
  return (
    <label>
      Repeated daylight saving hour
      <select
        name={name}
        defaultValue={onChange ? undefined : value || "reject"}
        value={onChange ? value : undefined}
        onChange={
          onChange ? (e) => onChange(e.target.value as Choice) : undefined
        }
      >
        <option value="reject">Automatic (reject ambiguous time)</option>
        <option value="earlier">First occurrence</option>
        <option value="later">Second occurrence</option>
      </select>
    </label>
  );
}
export function Correction({
  org,
  employees,
  timezone,
  card,
  requests = [],
  requestId = "",
}: {
  org: string;
  employees: { id: string; display_name: string }[];
  timezone: string;
  card?: Timecard;
  requests?: {
    id: string;
    employee_id: string;
    session_id: string | null;
    reason: string;
  }[];
  requestId?: string;
}) {
  const [employee, setEmployee] = useState(
    card?.employee_id || employees[0]?.id || "",
  );
  const [breaks, setBreaks] = useState(
    () =>
      card?.time_breaks.map((b) => ({
        starts_at: local(b.starts_at, timezone),
        ends_at: b.ends_at ? local(b.ends_at, timezone) : "",
        starts_at_choice: choice(b.starts_at, timezone),
        ends_at_choice: b.ends_at
          ? choice(b.ends_at, timezone)
          : ("reject" as Choice),
      })) || [],
  );
  function update(index: number, key: string, value: string) {
    setBreaks((rows) =>
      rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)),
    );
  }
  return (
    <ClockForm org={org} command="correct">
      <p>
        Times use {timezone}. Preserve seconds when known. Review every recorded
        break before saving. Original values remain in the audit.
      </p>
      <input type="hidden" name="session_id" value={card?.id || ""} />
      <input type="hidden" name="revision" value={card?.revision || ""} />
      {!card && (
        <label>
          Employee
          <select
            name="employee_id"
            required
            value={employee}
            onChange={(e) => setEmployee(e.target.value)}
          >
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.display_name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Clock in
        <input
          name="clock_in"
          type="datetime-local"
          step="any"
          defaultValue={card ? local(card.clock_in, timezone) : ""}
          required
        />
      </label>
      <Dst
        name="clock_in_choice"
        value={card ? choice(card.clock_in, timezone) : "reject"}
      />
      <label>
        Clock out (leave blank if still working)
        <input
          name="clock_out"
          type="datetime-local"
          step="any"
          defaultValue={card?.clock_out ? local(card.clock_out, timezone) : ""}
        />
      </label>
      <Dst
        name="clock_out_choice"
        value={card?.clock_out ? choice(card.clock_out, timezone) : "reject"}
      />
      <h3>Recorded unpaid breaks</h3>
      <input type="hidden" name="breaks" value={JSON.stringify(breaks)} />
      {breaks.map((b, i) => (
        <fieldset key={i}>
          <legend>Unpaid break {i + 1}</legend>
          <label>
            Start
            <input
              type="datetime-local"
              step="any"
              required
              value={b.starts_at}
              onChange={(e) => update(i, "starts_at", e.target.value)}
            />
          </label>
          <Dst
            value={b.starts_at_choice}
            onChange={(v) => update(i, "starts_at_choice", v)}
          />
          <label>
            End (blank if still on break)
            <input
              type="datetime-local"
              step="any"
              value={b.ends_at}
              onChange={(e) => update(i, "ends_at", e.target.value)}
            />
          </label>
          <Dst
            value={b.ends_at_choice}
            onChange={(v) => update(i, "ends_at_choice", v)}
          />
          <button
            type="button"
            className="button secondary"
            onClick={() => setBreaks((rows) => rows.filter((_, n) => n !== i))}
          >
            Remove break {i + 1}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="button secondary"
        disabled={breaks.length >= 30}
        onClick={() =>
          setBreaks((rows) => [
            ...rows,
            {
              starts_at: "",
              ends_at: "",
              starts_at_choice: "reject",
              ends_at_choice: "reject",
            },
          ])
        }
      >
        Add recorded break
      </button>
      <label>
        Related correction request
        <select name="request_id" defaultValue={requestId} key={employee}>
          <option value="">No related request</option>
          {requests
            .filter(
              (r) =>
                r.employee_id === employee &&
                (!r.session_id || r.session_id === card?.id),
            )
            .map((r) => (
              <option value={r.id} key={r.id}>
                {r.reason.slice(0, 100)}
              </option>
            ))}
        </select>
      </label>
      <label>
        Reason
        <textarea name="reason" required minLength={5} maxLength={1000} />
      </label>
    </ClockForm>
  );
}
