import { Checkbox } from "@/app/ui/checkbox";
import { Button, ButtonLink } from "@/app/ui/button";
import { PageHeader } from "@/app/ui/surfaces";
import { DatePicker } from "@/app/ui/date-picker";
import { Select } from "@/app/ui/select";
import Link from "next/link";
import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { Frame, Message } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import { requirePayroll } from "@/lib/payroll/feature";
import {
  calculate,
  period,
  money,
  hours,
  type Input,
  type Settings,
  type Report,
} from "@/lib/payroll/engine";
import { payrollAction } from "./actions";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string; employee?: string; message?: string }>;
}) {
  requirePayroll();
  const { id } = await params;
  const { db, role } = await requireWorkspace(id);
  const manager = ["owner", "manager"].includes(role);
  const q = await searchParams;
  const [source, org, history, events] = await Promise.all([
    db.rpc("payroll_input", { org: id }),
    db.from("organizations").select("name,timezone").eq("id", id).single(),
    manager
      ? db
          .from("payroll_reports")
          .select(
            "id,period_start,period_end,version,snapshot,reason,created_at",
          )
          .eq("organization_id", id)
          .order("created_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [], error: null }),
    manager
      ? db
          .from("payroll_events")
          .select("id,report_id,action,reason,created_at")
          .eq("organization_id", id)
          .order("created_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (source.error || org.error || history.error || events.error)
    throw Error(
      "Unable to load payroll. Confirm the Phase 10 migration is installed.",
    );
  const input = source.data as Input;
  const timezone = input.settings?.timezone || org.data!.timezone;
  const today = Temporal.Now.zonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
  const settings: Settings = input.settings || {
    frequency: "biweekly",
    anchor: today,
    timezone,
    workweek_day: 1,
    workweek_time: "00:00",
    rule: "unverified",
    employee_access: false,
  };
  let selected;
  try {
    selected = period(settings, q.date || today);
  } catch {
    selected = period(settings, today);
  }
  const oversized = input.cards.length > 10000 || input.rates.length > 10000;
  const report =
    input.settings && !oversized
      ? calculate(input, selected.start, selected.end)
      : null;
  const rows =
    report?.rows.filter((r) => !q.employee || r.employee === q.employee) || [];
  const token = report
    ? createHash("sha256")
        .update(JSON.stringify({ input, report }))
        .digest("hex")
    : "";
  const form = (command: string, children: React.ReactNode) => (
    <form action={payrollAction} className="payroll-form">
      <input type="hidden" name="org" value={id} />
      <input type="hidden" name="command" value={command} />
      <input type="hidden" name="date" value={selected.from} />
      {children}
      <label>
        Explanation
        <input name="reason" required minLength={5} maxLength={1000} />
      </label>
      <Button className="button">
        {command === "approve"
          ? "Approve report for export"
          : command === "reopen"
            ? "Reopen for correction"
            : "Save"}
      </Button>
    </form>
  );
  const summary = (key: "totalCents" | "regularNs" | "overtimeNs") =>
    rows.reduce((s, r) => s + BigInt(r[key]), BigInt(0)).toString();
  return (
    <Frame workspace={{ id, role, name: org.data!.name }}>
      <PageHeader className="page-heading">
        <div>
          <p className="eyebrow">PAYROLL PREPARATION · USD</p>
          <h1>{manager ? "Payroll" : "My Pay Estimates"}</h1>
          <p>
            Estimated gross wages before deductions. These are not official pay
            statements or confirmation of payment.
          </p>
        </div>
      </PageHeader>
      <Message text={q.message} />
      {!manager && !settings.employee_access ? (
        <p>Your workplace has not enabled employee pay estimates.</p>
      ) : (
        <>
          <form className="time-filter">
            <label>
              Date within pay period
              <DatePicker
                name="date"
                defaultValue={selected.from}
                required
              />
            </label>
            {manager && (
              <label>
                Employee
                <Select name="employee" defaultValue={q.employee || ""}>
                  <option value="">All employees</option>
                  {input.employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.display_name}
                      {e.archived_at ? " (archived)" : ""}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <Button icon="calendar" className="button secondary">View period</Button>
          </form>
          <h2>
            {selected.from} – {selected.through}
          </h2>
          <p>
            {settings.frequency} · {timezone} ·{" "}
            <Link
              href={`?date=${Temporal.PlainDate.from(selected.from).subtract({ days: 1 })}`}
            >
              Previous period
            </Link>
            {" · "}
            <Link href={`?date=${today}`}>Current period</Link>
            {" · "}
            <Link
              href={`?date=${Temporal.PlainDate.from(selected.through).add({ days: 1 })}`}
            >
              Next period
            </Link>
          </p>
          {oversized && (
            <p role="alert">
              Source limit exceeded. External review required; calculations and
              approval are disabled.
            </p>
          )}
          <div className="time-summary">
            <article>
              Estimated labor cost
              <strong>${money(summary("totalCents"))}</strong>
            </article>
            <article>
              Regular hours<strong>{hours(summary("regularNs"))}</strong>
            </article>
            <article>
              Overtime hours<strong>{hours(summary("overtimeNs"))}</strong>
            </article>
            <article>
              Employees included<strong>{rows.length}</strong>
            </article>
            <article>
              Unresolved exceptions
              <strong>{report?.warnings.length || 0}</strong>
            </article>
          </div>
          <div className="time-summary">
            {[
              "Missing clock-out",
              "Unapproved timecard",
              "Missing wage rate",
            ].map((label) => (
              <article key={label}>
                {label}
                <strong>
                  {report?.warnings.filter((w) => w.includes(label)).length ||
                    0}
                </strong>
              </article>
            ))}
          </div>
          <p>
            Initial support: ordinary hourly nonexempt work with one rate per
            168-hour workweek. State or local rules, exemptions, tips, bonuses
            and other compensation require external review. This tool does not
            establish payroll-law compliance.
          </p>
          {report?.warnings.length ? (
            <section className="notice" role="alert">
              <h2>Resolve before approval</h2>
              {report.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </section>
          ) : null}
          {rows.map((r) => (
            <details className="panel workspace-card" key={r.employee}>
              <summary>
                {r.name}
                {r.archived ? " (archived)" : ""} · ${money(r.totalCents)}{" "}
                estimated gross · {r.approval}
              </summary>
              <p>
                Hourly rate(s):{" "}
                {r.rates.map((c) => `$${money(c)}`).join(", ") || "Missing"} ·
                Regular {hours(r.regularNs)} h / ${money(r.regularCents)} ·
                Overtime {hours(r.overtimeNs)} h / ${money(r.overtimeCents)}
              </p>
              {r.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
              <Link
                href={`/workspaces/${id}/time-clock?from=${selected.from}&to=${selected.through}&employee=${r.employee}`}
              >
                Review timecards and correction requests
              </Link>
            </details>
          ))}
          {manager &&
            report &&
            !report.warnings.length &&
            report.rows.length > 0 &&
            Date.parse(report.end) <= Date.now() &&
            form(
              "approve",
              <>
                <input type="hidden" name="review_token" value={token} />
                <p>
                  Approve all employees for this period. Approval preserves the
                  complete source and calculation snapshot. No payment is
                  initiated.
                </p>
              </>,
            )}
          <h2>Outstanding correction requests</h2>
          {input.requests
            .filter((r) => r.status === "pending")
            .map((r, i) => (
              <p key={i}>
                {
                  input.employees.find((e) => e.id === r.employee_id)
                    ?.display_name
                }
                : Pending correction ·{" "}
                <Link href={`/workspaces/${id}/time-clock`}>
                  Review request
                </Link>
              </p>
            ))}
          <h2>Wage history</h2>
          {input.employees.map((e) => (
            <details className="panel workspace-card" key={e.id}>
              <summary>
                {e.display_name}
                {e.archived_at ? " (archived)" : ""}
              </summary>
              {input.rates
                .filter((r) => r.employee_id === e.id)
                .sort(
                  (a, b) =>
                    b.effective_at.localeCompare(a.effective_at) ||
                    b.created_at.localeCompare(a.created_at),
                )
                .map((r) => (
                  <p key={r.id}>
                    ${money(r.cents)}/h · Effective{" "}
                    {Temporal.Instant.from(r.effective_at)
                      .toZonedDateTimeISO(timezone)
                      .toString()}{" "}
                    · {r.classification} · Recorded {r.created_at}
                  </p>
                ))}
              {manager &&
                form(
                  "rate",
                  <>
                    <input type="hidden" name="employee_id" value={e.id} />
                    <label>
                      Hourly USD rate
                      <input
                        name="rate"
                        inputMode="decimal"
                        placeholder="20.00"
                        required
                        pattern="[0-9]+(\.[0-9]{1,2})?"
                      />
                    </label>
                    <label>
                      Effective local date and time ({timezone})
                      <input
                        name="effective_at"
                        type="datetime-local"
                        required
                      />
                    </label>
                    <label>
                      Classification
                      <Select name="classification">
                        <option value="hourly_nonexempt">
                          Hourly, overtime eligible
                        </option>
                        <option value="exempt_review">
                          Exemption classification — external review
                        </option>
                        <option value="other_review">
                          Other compensation — external review
                        </option>
                      </Select>
                    </label>
                    <p>
                      To correct an error, append a rate at the same effective
                      instant with an explanation. Earlier entries are
                      preserved. Ambiguous DST times are rejected.
                    </p>
                  </>,
                )}
            </details>
          ))}
        </>
      )}
      {manager && (
        <>
          <details className="panel workspace-card">
            <summary>Pay period and overtime settings</summary>
            {form(
              "settings",
              <>
                <label>
                  Pay period
                  <Select name="frequency" defaultValue={settings.frequency}>
                    {["weekly", "biweekly", "semimonthly", "monthly"].map(
                      (f) => (
                        <option key={f}>{f}</option>
                      ),
                    )}
                  </Select>
                </label>
                <label>
                  Period anchor / fixed workweek reference date
                  <DatePicker
                    name="anchor"
                    defaultValue={settings.anchor}
                    required
                  />
                </label>
                <p>
                  Monthly periods use the anchor day, clamped to month end.
                  Semimonthly anchors must use days 1–15; the second boundary is
                  15 days later in that month, clamped to month end. Weekly and
                  biweekly periods use the anchor date.
                </p>
                <label>
                  Workplace IANA time zone
                  <input name="timezone" defaultValue={timezone} required />
                </label>
                <label>
                  Workweek start day
                  <Select
                    name="workweek_day"
                    defaultValue={settings.workweek_day}
                  >
                    {[
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                      "Sunday",
                    ].map((d, i) => (
                      <option value={i + 1} key={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Workweek start time
                  <input
                    type="time"
                    name="workweek_time"
                    defaultValue={settings.workweek_time}
                    required
                  />
                </label>
                <p>
                  Workweeks repeat every 168 actual hours from the configured
                  reference date, day and time, independently of pay periods.
                  Local start time shifts at daylight saving changes. Changing
                  this setting requires external review of affected weeks.
                </p>
                <label>
                  Overtime rules
                  <Select name="rule" defaultValue={settings.rule}>
                    <option value="unverified">
                      Unverified jurisdiction — review required
                    </option>
                    <option value="federal-weekly-confirmed">
                      Reviewed: federal weekly single-rate estimate applies
                    </option>
                  </Select>
                </label>
                <label>
                  <Checkbox
                    name="employee_access"
                    defaultChecked={settings.employee_access}
                  />
                  Enable employees to view their own pay estimates and wage
                  history
                </label>
              </>,
            )}
          </details>
          <h2>Approved report history</h2>
          <p>
            Original snapshots remain available after reopening. Current
            estimates above reflect corrections; exports below retain the
            approved values. Up to 100 recent reports and audit events shown.
          </p>
          {history.data?.map((h) => {
            const r = h.snapshot as Report;
            const reopened = events.data?.some(
              (e) => e.report_id === h.id && e.action === "reopen",
            );
            return (
              <details className="panel workspace-card" key={h.id}>
                <summary>
                  {h.period_start} · Version {h.version} ·{" "}
                  {reopened ? "Reopened" : "Approved for export"}
                </summary>
                <p>
                  {h.reason} · Approved {h.created_at}
                </p>
                <ButtonLink
                  className="button secondary"
                  href={`/workspaces/${id}/payroll/export?report=${h.id}`}
                >
                  Export immutable version {h.version} CSV
                </ButtonLink>
                {r.rows.map((row) => (
                  <p key={row.employee}>
                    {row.name} · ${money(row.totalCents)} estimated gross
                  </p>
                ))}
                {!reopened &&
                  form(
                    "reopen",
                    <>
                      <input type="hidden" name="report_id" value={h.id} />
                      <p>
                        Preserve this version and permit a corrected approval
                        with an explanation.
                      </p>
                    </>,
                  )}
              </details>
            );
          })}
          <details className="panel workspace-card">
            <summary>Payroll audit history</summary>
            {events.data?.map((e) => (
              <p key={e.id}>
                {e.created_at} · {e.action} · {e.reason}
              </p>
            ))}
          </details>
        </>
      )}
    </Frame>
  );
}
