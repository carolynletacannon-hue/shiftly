import Link from "next/link";
import { Frame } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import { requireTimeClock } from "@/lib/time-clock/feature";
import {
  dateBounds,
  durations,
  status,
  type Timecard,
} from "@/lib/time-clock/records";
import { addDays, localDate, weekStart } from "@/lib/scheduling/time";
import { Correction } from "./correction";
import { ClockForm } from "./controls";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string; employee?: string }>;
}) {
  requireTimeClock();
  const { id } = await params;
  const { db, role, user } = await requireWorkspace(id);
  const manager = ["owner", "manager"].includes(role);
  const query = await searchParams;
  const { data: org, error: orgError } = await db
    .from("organizations")
    .select("name,timezone")
    .eq("id", id)
    .single();
  if (orgError || !org) throw Error("Unable to load workplace");
  const now = new Date().toISOString(),
    today = localDate(now, org.timezone),
    week = weekStart(today);
  const from = query.from || week,
    to = query.to || addDays(week, 6);
  const day = dateBounds(today, today, org.timezone),
    weekly = dateBounds(week, addDays(week, 6), org.timezone);
  let bounds;
  try {
    bounds = dateBounds(from, to, org.timezone);
  } catch {
    return (
      <Frame workspace={{ id, role, name: org.name }}>
        <h1>Choose a valid date range</h1>
        <Link href={`/workspaces/${id}/time-clock`}>Return to timesheets</Link>
      </Frame>
    );
  }
  const rosterResult = await db
    .from("employees")
    .select("id,display_name,user_id,archived_at")
    .eq("organization_id", id)
    .order("display_name");
  if (rosterResult.error) throw Error("Unable to load roster");
  const roster = rosterResult.data || [],
    mine = roster.find((e) => e.user_id === user.id);
  const employee = manager ? query.employee : mine?.id;
  let sessionQuery = db
    .from("time_sessions")
    .select("*,time_breaks(starts_at,ends_at)")
    .eq("organization_id", id)
    .lt("clock_in", bounds.end)
    .or(`clock_out.is.null,clock_out.gt.${bounds.start}`)
    .order("clock_in", { ascending: false })
    .limit(1000);
  if (employee) sessionQuery = sessionQuery.eq("employee_id", employee);
  let currentWeekQuery = db
    .from("time_sessions")
    .select("*,time_breaks(starts_at,ends_at)")
    .eq("organization_id", id)
    .lt("clock_in", weekly.end)
    .or(`clock_out.is.null,clock_out.gt.${weekly.start}`)
    .limit(1000);
  if (employee) currentWeekQuery = currentWeekQuery.eq("employee_id", employee);
  const [
    sessions,
    settings,
    kiosks,
    requests,
    audits,
    schedule,
    open,
    currentWeek,
    punches,
  ] = await Promise.all([
    sessionQuery,
    db
      .from("time_clock_settings")
      .select("enabled,require_breaks")
      .eq("organization_id", id)
      .maybeSingle(),
    manager
      ? db
          .from("time_kiosks")
          .select("*")
          .eq("organization_id", id)
          .order("created_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("time_correction_requests")
      .select("*")
      .eq("organization_id", id)
      .order("created_at", { ascending: false })
      .limit(1000),
    db
      .from("time_audit")
      .select("*")
      .eq("organization_id", id)
      .order("created_at", { ascending: false })
      .limit(1000),
    db
      .from("published_shifts")
      .select("employee_id,starts_at,ends_at,shift_group_id")
      .eq("organization_id", id)
      .lt("starts_at", bounds.end)
      .gt("ends_at", bounds.start)
      .limit(1000),
    db
      .from("time_sessions")
      .select("*,time_breaks(starts_at,ends_at)")
      .eq("organization_id", id)
      .is("clock_out", null)
      .is("voided_at", null)
      .limit(1000),
    currentWeekQuery,
    db
      .from("time_punch_events")
      .select("session_id,action,occurred_at")
      .eq("organization_id", id)
      .order("occurred_at", { ascending: false })
      .limit(1000),
  ]);
  if (
    [
      sessions,
      settings,
      kiosks,
      requests,
      audits,
      schedule,
      open,
      currentWeek,
      punches,
    ].some((r) => r.error)
  )
    throw Error(
      "Unable to load timekeeping. Confirm the Phase 9 migration is installed.",
    );
  const cards = (sessions.data || []) as Timecard[],
    current = (open.data || []) as Timecard[];
  const total = (start: string, end: string) =>
    cards.reduce((sum, c) => sum + durations(c, start, end, now).paidHours, 0);
  const weekTotal = (start: string, end: string) =>
    ((currentWeek.data as Timecard[]) || []).reduce(
      (sum, c) => sum + durations(c, start, end, now).paidHours,
      0,
    );
  // Union published intervals per employee: multiple assignments never double-count time.
  const planned = new Map<string, Array<[number, number]>>();
  for (const shift of schedule.data || []) {
    if (employee && shift.employee_id !== employee) continue;
    const list = planned.get(shift.employee_id) || [];
    list.push([
      Math.max(Date.parse(bounds.start), Date.parse(shift.starts_at)),
      Math.min(Date.parse(bounds.end), Date.parse(shift.ends_at)),
    ]);
    planned.set(shift.employee_id, list);
  }
  let scheduled = 0;
  for (const list of planned.values()) {
    list.sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [lo, hi] of list) {
      scheduled += Math.max(0, hi - Math.max(lo, end)) / 3600000;
      end = Math.max(end, hi);
    }
  }
  const name = (employeeId: string) =>
    roster.find((e) => e.id === employeeId)?.display_name || "Employee";
  const fmt = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: org.timezone,
          dateStyle: "medium",
          timeStyle: "long",
        }).format(new Date(value))
      : "Missing clock-out";
  return (
    <Frame workspace={{ id, role, name: org.name }}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ACTUAL TIME · {org.timezone}</p>
          <h1>{manager ? "Time Clock Management" : "My Timesheet"}</h1>
          <p>
            Actual punches and recorded unpaid breaks. Open sessions are
            provisional. Hours are not payroll.
          </p>
        </div>
      </div>
      <form className="time-filter">
        <label>
          From
          <input type="date" name="from" defaultValue={from} required />
        </label>
        <label>
          Through
          <input type="date" name="to" defaultValue={to} required />
        </label>
        {manager && (
          <label>
            Employee
            <select name="employee" defaultValue={employee || ""}>
              <option value="">All employees</option>
              {roster.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.display_name}
                  {e.archived_at ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="button secondary">Apply filters</button>
        {manager && (
          <Link
            className="button secondary"
            href={`/workspaces/${id}/time-clock/export?from=${from}&to=${to}${employee ? `&employee=${employee}` : ""}`}
          >
            Export CSV
          </Link>
        )}
      </form>
      <p>
        Daily and weekly totals use the current workplace week and selected
        employee. Up to 1,000 records are shown; narrow the range if the limit
        is reached.
      </p>
      <div className="time-summary">
        <article>
          Today<strong>{weekTotal(day.start, day.end).toFixed(2)} h</strong>
        </article>
        <article>
          This week
          <strong>{weekTotal(weekly.start, weekly.end).toFixed(2)} h</strong>
        </article>
        <article>
          Selected actual
          <strong>{total(bounds.start, bounds.end).toFixed(2)} h</strong>
        </article>
        <article>
          Selected scheduled<strong>{scheduled.toFixed(2)} h</strong>
        </article>
        <article>
          Actual − scheduled
          <strong>
            {(total(bounds.start, bounds.end) - scheduled).toFixed(2)} h
          </strong>
        </article>
      </div>
      <section className="time-clock-section">
        <h2>Current attendance</h2>
        <p>
          Open sessions across all dates
          {manager ? " for this workplace" : " visible to your account"}.
        </p>
        {current
          .filter((c) => !employee || c.employee_id === employee)
          .map((c) => (
            <p key={c.id}>
              <strong>{name(c.employee_id)}</strong> · {status(c, now)} · In{" "}
              {fmt(c.clock_in)}
            </p>
          ))}
        {!current.length && <p>No open work sessions.</p>}
      </section>
      {manager && (
        <details className="panel workspace-card time-settings">
          <summary>Kiosk Management & employee PINs</summary>
          <h2>Workplace settings</h2>
          <ClockForm org={id} command="settings">
            <label>
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={settings.data?.enabled}
              />
              Enable this workplace’s time clock
            </label>
            <label>
              <input
                type="checkbox"
                name="require_breaks"
                defaultChecked={settings.data?.require_breaks}
              />
              Require break guidance on the kiosk
            </label>
            <p>
              Breaks are recorded only when punched or corrected. No automatic
              deductions.
            </p>
          </ClockForm>
          <h2>Activate on this device</h2>
          <p>
            Activation signs you out and limits this browser to the kiosk.
            Devices expire after 12 hours and require a new manager enrollment.
            Keep this page away from employees until activation is complete.
          </p>
          <ClockForm org={id} command="enroll">
            <label>
              Device name
              <input
                name="name"
                required
                maxLength={80}
                placeholder="Front Desk Tablet"
              />
            </label>
          </ClockForm>
          <h2>Authorized workplace kiosks</h2>
          {kiosks.data?.map((k) => (
            <article key={k.id}>
              <h3>{k.name}</h3>
              <p>
                {k.revoked_at
                  ? "Revoked"
                  : Date.parse(k.expires_at) < Date.parse(now)
                    ? "Expired"
                    : "Authorized"}{" "}
                · Last activity:{" "}
                {k.last_activity ? fmt(k.last_activity) : "No activity yet"} ·
                Expires {fmt(k.expires_at)}
              </p>
              {!k.revoked_at && (
                <ClockForm org={id} command="revoke">
                  <input type="hidden" name="kiosk_id" value={k.id} />
                  <p>Revoke this kiosk immediately.</p>
                </ClockForm>
              )}
            </article>
          ))}
          <h2>Employee PIN management</h2>
          <p>
            Generate a unique six-digit PIN for each eligible employee and share
            it privately. A new PIN replaces the old PIN. PINs are revealed
            once, never emailed.
          </p>
          {roster
            .filter((e) => !e.archived_at)
            .map((e) => (
              <details key={e.id}>
                <summary>{e.display_name}</summary>
                <ClockForm org={id} command="pin">
                  <input type="hidden" name="employee_id" value={e.id} />
                </ClockForm>
              </details>
            ))}
        </details>
      )}
      <section className="timecard-list" aria-label="Timecard history">
        {!cards.length && <p>No time records in this range.</p>}
        {cards.map((card) => {
          const pending = requests.data?.some(
            (r) =>
              r.status === "pending" &&
              r.employee_id === card.employee_id &&
              (!r.session_id || r.session_id === card.id),
          );
          const d = durations(card, bounds.start, bounds.end, now);
          return (
            <article key={card.id} className="panel workspace-card">
              <div className="timecard-header">
                <h2>{name(card.employee_id)}</h2>
                <strong className="schedule-badge">
                  {pending ? "Pending Correction" : status(card, now)}
                </strong>
              </div>
              <p>
                In: {fmt(card.clock_in)}
                <br />
                Out: {fmt(card.clock_out)}
              </p>
              <p>
                {d.paidHours.toFixed(4)} paid hours in range ·{" "}
                {(d.unpaidSeconds / 60).toFixed(2)} unpaid minutes in range
              </p>
              {card.time_breaks.map((b, i) => (
                <p key={i}>
                  Unpaid break: {fmt(b.starts_at)} →{" "}
                  {b.ends_at ? fmt(b.ends_at) : "On Break"}
                </p>
              ))}
              {manager && !card.voided_at ? (
                <>
                  <ClockForm org={id} command="approve">
                    <input type="hidden" name="session_id" value={card.id} />
                    <input
                      type="hidden"
                      name="revision"
                      value={card.revision}
                    />
                    <p>Approve this completed timecard.</p>
                  </ClockForm>
                  <details>
                    <summary>Correct this timecard</summary>
                    <Correction
                      org={id}
                      employees={roster}
                      timezone={org.timezone}
                      card={card}
                      requests={
                        requests.data?.filter((r) => r.status === "pending") ||
                        []
                      }
                    />
                  </details>
                  <details>
                    <summary>Void an invalid timecard</summary>
                    <ClockForm org={id} command="void">
                      <input type="hidden" name="session_id" value={card.id} />
                      <input
                        type="hidden"
                        name="revision"
                        value={card.revision}
                      />
                      <p>
                        Voiding excludes these hours from totals and retains the
                        original record and audit history. Add a corrected work
                        session separately if needed.
                      </p>
                      <label>
                        Reason
                        <textarea
                          name="reason"
                          required
                          minLength={5}
                          maxLength={1000}
                        />
                      </label>
                    </ClockForm>
                  </details>
                </>
              ) : (
                <details>
                  <summary>Request a correction</summary>
                  <ClockForm org={id} command="request">
                    <input type="hidden" name="session_id" value={card.id} />
                    <label>
                      What needs to change?
                      <textarea
                        name="reason"
                        minLength={5}
                        maxLength={1000}
                        required
                      />
                    </label>
                  </ClockForm>
                </details>
              )}
              <details>
                <summary>Punch & correction history</summary>
                {punches.data
                  ?.filter((p) => p.session_id === card.id)
                  .map((p, i) => (
                    <p key={i}>
                      {
                        (
                          {
                            in: "Clock In",
                            out: "Clock Out",
                            break_start: "Start Unpaid Break",
                            break_end: "End Unpaid Break",
                          } as Record<string, string>
                        )[p.action]
                      }{" "}
                      · {fmt(p.occurred_at)} · Original kiosk punch
                    </p>
                  ))}
                {audits.data
                  ?.filter((a) => a.session_id === card.id)
                  .map((a) => (
                    <div key={a.id}>
                      <p>
                        {a.action} · {fmt(a.created_at)} ·{" "}
                        {a.reason || "Recorded action"} · Actor:{" "}
                        {roster.find((e) => e.user_id === a.actor_id)
                          ?.display_name ||
                          (a.actor_id ? "Workplace manager" : "Kiosk")}
                      </p>
                      {a.before_values && (
                        <Snapshot
                          label="Before"
                          value={a.before_values}
                          fmt={fmt}
                        />
                      )}
                      {a.after_values && (
                        <Snapshot
                          label="After"
                          value={a.after_values}
                          fmt={fmt}
                        />
                      )}
                    </div>
                  ))}
                <p>
                  Original kiosk punch events remain immutable. Corrections
                  above preserve each prior revision.
                </p>
              </details>
            </article>
          );
        })}
      </section>
      {manager && (
        <details className="panel workspace-card time-clock-section">
          <summary>Add a missing work session</summary>
          <Correction
            org={id}
            employees={roster}
            timezone={org.timezone}
            requests={
              requests.data?.filter((r) => r.status === "pending") || []
            }
          />
        </details>
      )}
      {!manager && (
        <section className="panel workspace-card time-clock-section">
          <h2>Missing a whole work session?</h2>
          <ClockForm org={id} command="request">
            <label>
              Describe the missing date, time and breaks
              <textarea name="reason" minLength={5} maxLength={1000} required />
            </label>
          </ClockForm>
        </section>
      )}
      <section className="time-clock-section">
        <h2>Correction requests</h2>
        {requests.data?.map((r) => (
          <article className="panel workspace-card" key={r.id}>
            <h3>
              {name(r.employee_id)} · {r.status}
            </h3>
            <p>{r.reason}</p>
            <p>{fmt(r.created_at)}</p>
            {r.response && <p>Manager response: {r.response}</p>}
            {manager && r.status === "pending" && (
              <>
                <p>
                  Apply the requested changes before approving. Rejections
                  require an explanation.
                </p>
                {!r.session_id || cards.some((c) => c.id === r.session_id) ? (
                  <details>
                    <summary>Apply requested correction</summary>
                    <Correction
                      org={id}
                      employees={roster.filter((e) => e.id === r.employee_id)}
                      timezone={org.timezone}
                      card={cards.find((c) => c.id === r.session_id)}
                      requests={[r]}
                      requestId={r.id}
                    />
                  </details>
                ) : (
                  <p>
                    Use the date filters to find this timecard, then select this
                    request when correcting it.
                  </p>
                )}
                <ClockForm org={id} command="review">
                  <input type="hidden" name="request_id" value={r.id} />
                  <label>
                    Decision
                    <select name="decision">
                      <option value="approved">
                        Approve applied correction
                      </option>
                      <option value="rejected">Reject request</option>
                    </select>
                  </label>
                  <label>
                    Response
                    <textarea
                      name="reason"
                      required
                      minLength={5}
                      maxLength={1000}
                    />
                  </label>
                </ClockForm>
              </>
            )}
          </article>
        ))}
        {!requests.data?.length && <p>No correction requests.</p>}
      </section>
    </Frame>
  );
}

function Snapshot({
  label,
  value,
  fmt,
}: {
  label: string;
  value: Record<string, unknown>;
  fmt: (s: string | null) => string;
}) {
  const breaks = Array.isArray(value.breaks)
    ? (value.breaks as { starts_at: string; ends_at: string | null }[])
    : [];
  return (
    <div className="time-audit-snapshot">
      <strong>{label}</strong>
      {typeof value.clock_in === "string" && (
        <p>
          Clock in: {fmt(value.clock_in)}
          <br />
          Clock out:{" "}
          {value.clock_out ? fmt(String(value.clock_out)) : "Open session"}
        </p>
      )}
      {breaks.map((b, i) => (
        <p key={i}>
          Unpaid break: {fmt(b.starts_at)} →{" "}
          {b.ends_at ? fmt(b.ends_at) : "Open break"}
        </p>
      ))}
      {!!value.voided_at && <p>Voided: {fmt(String(value.voided_at))}</p>}
      {!!value.approved_at && <p>Approved: {fmt(String(value.approved_at))}</p>}
      {typeof value.decision === "string" && <p>Decision: {value.decision}</p>}
    </div>
  );
}
