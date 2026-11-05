"use client";
import {
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { scheduleAction } from "./actions";
import { ScheduleCalendar } from "@/lib/scheduling/calendar";
import {
  addDays,
  hoursInWeek,
  localInput,
  localToInstant,
} from "@/lib/scheduling/time";
import type {
  Member,
  Position,
  Schedule,
  Shift,
  ShiftTemplate,
} from "@/lib/scheduling/types";
export function ScheduleEditor({
  orgId,
  week,
  timezone,
  schedule,
  members,
  positions,
  templates,
  settings,
  carryIn,
  peers,
}: {
  orgId: string;
  week: string;
  timezone: string;
  schedule: Schedule | null;
  members: Member[];
  positions: Position[];
  templates: ShiftTemplate[];
  settings: { weekly_hours_warning: number; revision: number } | null;
  carryIn: Shift[];
  peers: Shift[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("employees");
  const [selection, setSelection] = useState<{
    employee: string;
    date: string;
    shift?: Shift;
    baseRevision?: number;
  }>({ employee: members[0]?.id || "", date: week });
  const editor = useRef<HTMLElement>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const warning = Number(settings?.weekly_hours_warning || 40);
  const shifts = (schedule?.shifts || []).map((s) => ({
    ...s,
    position_name:
      positions.find((p) => p.id === s.position_id)?.name || "General",
  }));
  function run(
    command: string,
    payload: Record<string, string>,
    revision: number | null = schedule?.revision ?? null,
  ) {
    setError("");
    setNotice("");
    startTransition(async () => {
      const result = await scheduleAction(orgId, command, payload, revision);
      if (!result.ok) setError(result.error);
      else {
        setNotice(
          command === "publish"
            ? "Schedule published. Your team can now see this version. No emails were sent."
            : "Saved to your workspace.",
        );
        if (["save", "delete"].includes(command))
          setSelection({ employee: members[0]?.id || "", date: week });
        setConfirmPublish(false);
        router.refresh();
      }
    });
  }
  function select(employee: string, date: string, shift?: Shift) {
    setSelection({ employee, date, shift, baseRevision: schedule?.revision });
    setError("");
    setTimeout(
      () =>
        editor.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  }
  const positionOptions = (
    <>
      <option value="">General / no position</option>
      {positions.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </>
  );
  const timeChoice = (
    <label>
      Repeated DST hour
      <select name="time_choice" defaultValue="reject">
        <option value="reject">Ask me to resolve a repeated hour</option>
        <option value="earlier">Earlier occurrence</option>
        <option value="later">Later occurrence</option>
      </select>
    </label>
  );
  const status = !schedule?.published_revision
    ? "Draft · not visible to employees"
    : schedule.published_revision === schedule.revision
      ? "Published · draft matches live schedule"
      : `Unpublished changes · team sees revision ${schedule.published_revision}`;
  const reviews = members
    .map((m) => ({
      ...m,
      hours: hoursInWeek(
        [...shifts, ...carryIn].filter((s) => s.employee_id === m.id),
        week,
        timezone,
      ),
    }))
    .filter((m) => m.hours > warning);
  return (
    <div aria-busy={pending}>
      {error && (
        <p className="notice schedule-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {pending && (
        <p role="status" className="muted">
          Saving…
        </p>
      )}
      {!schedule ? (
        <section className="panel workspace-card schedule-empty">
          <p className="eyebrow">A FRESH WEEK</p>
          <h2>Build your team’s next schedule</h2>
          <p>
            Create a private draft, assign shifts, then publish when it’s ready.
            You can start empty or copy the previous week’s published schedule
            (or its draft if it has never been published).
          </p>
          <CommandForm
            onRun={run}
            schedule={schedule}
            pending={pending}
            command="create"
            extra={{ week_start: week }}
          >
            <label>
              Starting point
              <select name="copy_previous">
                <option value="no">Empty draft</option>
                <option value="yes">Copy previous week</option>
              </select>
            </label>
            {timeChoice}
            <button className="button primary">Create draft</button>
          </CommandForm>
        </section>
      ) : (
        <>
          <section className="panel schedule-toolbar">
            <div>
              <span
                className={`schedule-badge ${schedule.published_revision === schedule.revision ? "live" : "draft"}`}
              >
                {status}
              </span>
              <p className="muted">
                Revision {schedule.revision} · {shifts.length} shifts ·{" "}
                {timezone}
              </p>
            </div>
            <div className="schedule-tools">
              <label>
                Calendar view
                <select value={view} onChange={(e) => setView(e.target.value)}>
                  <option value="employees">By employee</option>
                  <option value="days">By day</option>
                </select>
              </label>
              <button
                type="button"
                className="button secondary"
                onClick={() => window.print()}
              >
                Print week
              </button>
              <button
                type="button"
                className="button primary"
                disabled={
                  pending || schedule.published_revision === schedule.revision
                }
                onClick={() => setConfirmPublish(true)}
              >
                {schedule.published_revision
                  ? "Republish schedule"
                  : "Publish schedule"}
              </button>
            </div>
          </section>
          {reviews.length > 0 && (
            <aside className="notice hours-review">
              <div>
                <strong>Review weekly hours</strong>
                <p>
                  {reviews
                    .map((m) => `${m.name}: ${m.hours.toFixed(1)} h`)
                    .join(" · ")}
                </p>
                <p>
                  Above your {warning} h review guideline. Overtime rules vary
                  by employee and jurisdiction; this is a planning warning, not
                  a payroll calculation.
                </p>
              </div>
            </aside>
          )}
          {confirmPublish && (
            <section
              className="panel workspace-card publish-review"
              role="region"
              aria-label="Review publication"
            >
              <h2>
                {shifts.length
                  ? "Ready to share this week?"
                  : "Publish an empty schedule?"}
              </h2>
              <p>
                {shifts.length
                  ? `${shifts.length} shifts will replace the team’s current published week.`
                  : "This will remove all currently published shifts for this week."}{" "}
                Conflicts and your revision will be checked again before
                publishing. No emails will be sent.
              </p>
              {reviews.length > 0 && (
                <p className="hours-warning">
                  Review the high-hours warning above before continuing.
                </p>
              )}
              <div className="schedule-tools">
                <button
                  disabled={pending}
                  className="button primary"
                  onClick={() => run("publish", { schedule_id: schedule.id })}
                >
                  Confirm publication
                </button>
                <button
                  className="button secondary"
                  onClick={() => setConfirmPublish(false)}
                >
                  Keep editing
                </button>
              </div>
            </section>
          )}
          <section className="panel">
            <ScheduleCalendar
              shifts={shifts}
              members={members}
              week={week}
              timezone={timezone}
              view={view}
              carryIn={carryIn}
              warning={warning}
              onCell={(id, day) => select(id, day)}
              onShift={(s) =>
                select(
                  s.employee_id,
                  localInput(s.starts_at, timezone).slice(0, 10),
                  s,
                )
              }
            />
          </section>
          {!shifts.length && (
            <p className="hint">
              Your draft is empty. Select an employee and date above, or use the
              shift editor below.
            </p>
          )}
          <div className="schedule-editor-grid">
            <section className="panel workspace-card" ref={editor}>
              <h2>{selection.shift ? "Edit shift" : "Add a shift"}</h2>
              <p className="muted">
                Times are in {timezone}. For overnight shifts, set the end date
                to the following day.
              </p>
              {selection.baseRevision !== undefined &&
                selection.baseRevision !== schedule.revision && (
                  <p role="alert" className="hours-warning">
                    The draft changed since this selection. Select the shift or
                    date again in the calendar before saving.
                  </p>
                )}
              <ShiftForm
                key={`${selection.employee}:${selection.date}:${selection.shift?.id || "new"}:${schedule.revision}`}
                selection={selection}
                members={members}
                templates={templates}
                positions={positionOptions}
                timezone={timezone}
                week={week}
                peers={[...shifts, ...peers]}
                pending={pending}
                onSubmit={(data) =>
                  run(
                    "save",
                    { ...data, schedule_id: schedule.id },
                    selection.baseRevision ?? schedule.revision,
                  )
                }
              />
              {selection.shift && (
                <div className="schedule-tools">
                  <button
                    className="button danger"
                    disabled={pending}
                    onClick={() =>
                      run(
                        "delete",
                        {
                          schedule_id: schedule.id,
                          id: selection.shift!.id,
                        },
                        selection.baseRevision ?? schedule.revision,
                      )
                    }
                  >
                    Delete shift from draft
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => select(members[0]?.id || "", week)}
                  >
                    Cancel edit
                  </button>
                </div>
              )}
            </section>
            <section className="panel workspace-card">
              <h2>Schedule settings</h2>
              <p className="muted">
                A review guideline, not a legal overtime rule.
              </p>
              <CommandForm
                onRun={run}
                schedule={schedule}
                pending={pending}
                command="settings"
                key={`settings:${settings?.revision}`}
                revision={settings?.revision ?? null}
              >
                <label>
                  Weekly hours warning
                  <input
                    name="weekly_hours_warning"
                    type="number"
                    min="1"
                    max="168"
                    step="0.5"
                    defaultValue={warning}
                    required
                  />
                </label>
                <button className="button secondary">Save guideline</button>
              </CommandForm>
              <h3>Positions</h3>
              <p className="muted">
                {positions.length
                  ? positions.map((p) => p.name).join(" · ")
                  : "Add Front desk, Night audit, or another position."}
              </p>
              <CommandForm
                onRun={run}
                schedule={schedule}
                pending={pending}
                command="position"
              >
                <label>
                  New position
                  <input name="name" maxLength={100} required />
                </label>
                <button className="button secondary">Add position</button>
              </CommandForm>
            </section>
          </div>
          <section className="panel workspace-card">
            <h2>Reusable shift templates</h2>
            <p className="muted">
              Templates apply local times. Saving a template does not change
              existing shifts.
            </p>
            <div className="template-grid">
              {templates.map((t) => (
                <details key={t.id} className="template-card">
                  <summary>
                    <strong>{t.name}</strong>
                    <span>
                      {t.start_time.slice(0, 5)}–{t.end_time.slice(0, 5)}
                      {t.end_next_day ? " next day" : ""}
                    </span>
                  </summary>
                  <CommandForm
                    onRun={run}
                    schedule={schedule}
                    pending={pending}
                    command="template_save"
                    key={`${t.id}:${t.revision}`}
                    extra={{ id: t.id }}
                    revision={t.revision}
                  >
                    <TemplateFields
                      template={t}
                      positionOptions={positionOptions}
                    />
                    <button className="button secondary">Save template</button>
                  </CommandForm>
                  <button
                    className="button danger"
                    disabled={pending}
                    onClick={() =>
                      run("template_delete", { id: t.id }, t.revision)
                    }
                  >
                    Delete template
                  </button>
                </details>
              ))}
              <details className="template-card">
                <summary>+ New template</summary>
                <CommandForm
                  onRun={run}
                  schedule={schedule}
                  pending={pending}
                  command="template_save"
                  revision={null}
                >
                  <TemplateFields positionOptions={positionOptions} />
                  <button className="button secondary">Add template</button>
                </CommandForm>
              </details>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
function TemplateFields({
  template,
  positionOptions,
}: {
  template?: ShiftTemplate;
  positionOptions: ReactNode;
}) {
  return (
    <>
      <label>
        Name
        <input
          name="name"
          defaultValue={template?.name}
          maxLength={60}
          required
        />
      </label>
      <label>
        Start time
        <input
          name="start_time"
          type="time"
          defaultValue={template?.start_time.slice(0, 5) || "07:00"}
          required
        />
      </label>
      <label>
        End time
        <input
          name="end_time"
          type="time"
          defaultValue={template?.end_time.slice(0, 5) || "15:00"}
          required
        />
      </label>
      <label className="check-label">
        <input
          name="end_next_day"
          type="checkbox"
          defaultChecked={template?.end_next_day}
        />
        Ends the next day
      </label>
      <label>
        Position
        <select name="position_id" defaultValue={template?.position_id || ""}>
          {positionOptions}
        </select>
      </label>
    </>
  );
}
function ShiftForm({
  selection,
  members,
  templates,
  positions,
  timezone,
  week,
  peers,
  pending,
  onSubmit,
}: {
  selection: { employee: string; date: string; shift?: Shift };
  members: Member[];
  templates: ShiftTemplate[];
  positions: ReactNode;
  timezone: string;
  week: string;
  peers: Shift[];
  pending: boolean;
  onSubmit: (data: Record<string, string>) => void;
}) {
  const shift = selection.shift;
  const [start, setStart] = useState(
    shift ? localInput(shift.starts_at, timezone) : selection.date + "T07:00",
  );
  const [end, setEnd] = useState(
    shift ? localInput(shift.ends_at, timezone) : selection.date + "T15:00",
  );
  const [employee, setEmployee] = useState(selection.employee);
  const [position, setPosition] = useState(shift?.position_id || "");
  const [startChoice, setStartChoice] = useState<
    "reject" | "earlier" | "later"
  >("reject");
  const [endChoice, setEndChoice] = useState<"reject" | "earlier" | "later">(
    "reject",
  );
  let problem = "",
    duration = 0;
  try {
    const a = localToInstant(start, timezone, startChoice),
      b = localToInstant(end, timezone, endChoice);
    duration = (Date.parse(b) - Date.parse(a)) / 3600000;
    if (
      duration <= 0 ||
      duration > 26 ||
      Date.parse(end + "Z") - Date.parse(start + "Z") > 86400000 ||
      start.slice(0, 10) < week ||
      start.slice(0, 10) >= addDays(week, 7) ||
      end.slice(0, 10) > addDays(start.slice(0, 10), 1)
    )
      problem =
        "Start must be in this week; end must follow start and be no later than the following day.";
    else if (
      peers.some(
        (p) =>
          p.id !== shift?.id &&
          p.employee_id === employee &&
          Date.parse(p.starts_at) < Date.parse(b) &&
          Date.parse(a) < Date.parse(p.ends_at),
      )
    )
      problem =
        "This employee has an overlapping shift in this or an adjacent week.";
  } catch {
    problem =
      "Check the dates and DST hour selection. Skipped local hours cannot be scheduled.";
  }
  return (
    <form
      className="account-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem)
          onSubmit(
            Object.fromEntries(new FormData(e.currentTarget)) as Record<
              string,
              string
            >,
          );
      }}
    >
      <fieldset disabled={pending}>
        <input type="hidden" name="id" value={shift?.id || ""} />
        <label>
          Apply a template
          <select
            defaultValue=""
            onChange={(e) => {
              const t = templates.find((t) => t.id === e.target.value);
              if (t) {
                setStart(selection.date + "T" + t.start_time.slice(0, 5));
                setEnd(
                  (t.end_next_day
                    ? addDays(selection.date, 1)
                    : selection.date) +
                    "T" +
                    t.end_time.slice(0, 5),
                );
                setPosition(t.position_id || "");
              }
            }}
          >
            <option value="">Custom times</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Employee
          <select
            name="employee_id"
            value={employee}
            onChange={(e) => setEmployee(e.target.value)}
            required
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Position
          <select
            name="position_id"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          >
            {positions}
          </select>
        </label>
        <label>
          Start date and time
          <input
            name="start_local"
            type="datetime-local"
            min={week + "T00:00"}
            max={addDays(week, 6) + "T23:59"}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            required
          />
        </label>
        <label>
          End date and time
          <input
            name="end_local"
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            required
          />
        </label>
        <label>
          Start: repeated DST hour
          <select
            name="start_choice"
            value={startChoice}
            onChange={(e) =>
              setStartChoice(e.target.value as typeof startChoice)
            }
          >
            <option value="reject">Ask me to resolve a repeated hour</option>
            <option value="earlier">Earlier occurrence</option>
            <option value="later">Later occurrence</option>
          </select>
        </label>
        <label>
          End: repeated DST hour
          <select
            name="end_choice"
            value={endChoice}
            onChange={(e) => setEndChoice(e.target.value as typeof endChoice)}
          >
            <option value="reject">Ask me to resolve a repeated hour</option>
            <option value="earlier">Earlier occurrence</option>
            <option value="later">Later occurrence</option>
          </select>
        </label>
        <label>
          Shift note (visible when published)
          <textarea
            name="notes"
            defaultValue={shift?.notes || ""}
            maxLength={300}
            rows={2}
          />
        </label>
        {problem ? (
          <p role="alert" className="hours-warning">
            {problem}
          </p>
        ) : (
          <p className="muted">
            {duration.toFixed(1)} actual hours · no overlapping shifts detected
          </p>
        )}
        <button className="button primary" disabled={!!problem || !employee}>
          {shift ? "Save draft changes" : "Add to draft"}
        </button>
      </fieldset>
    </form>
  );
}

function CommandForm({
  onRun,
  schedule,
  pending,
  command,
  children,
  revision = schedule?.revision ?? null,
  className = "account-form",
  extra = {},
}: {
  onRun: (
    command: string,
    payload: Record<string, string>,
    revision: number | null,
  ) => void;
  schedule: Schedule | null;
  pending: boolean;
  command: string;
  children: ReactNode;
  revision?: number | null;
  className?: string;
  extra?: Record<string, string>;
}) {
  return (
    <form
      className={className}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const data = Object.fromEntries(
          new FormData(e.currentTarget),
        ) as Record<string, string>;
        onRun(
          command,
          { schedule_id: schedule?.id || "", ...extra, ...data },
          revision,
        );
      }}
    >
      <fieldset disabled={pending}>{children}</fieldset>
    </form>
  );
}
