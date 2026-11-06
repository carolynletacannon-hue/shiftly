"use client";

import {
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { CoverageCalendar } from "@/lib/scheduling/coverage-calendar";
import {
  addDays,
  hoursInWeek,
  localInput,
  localToInstant,
} from "@/lib/scheduling/time";
import type {
  CoverageRequirement,
  Member,
  Position,
  Schedule,
  Shift,
  ShiftTemplate,
} from "@/lib/scheduling/types";
import type { TimeOff, Availability } from "@/lib/time-off/types";
import { timeOffConflict, availabilityWarning } from "@/lib/time-off/conflicts";
import { scheduleAction } from "./actions";

export function ScheduleEditor({
  orgId,
  timeOff,
  availability,
  availabilityTimezone,
  advanced = false,
  week,
  timezone,
  schedule,
  members,
  positions,
  templates,
  requirements,
  settings,
  carryIn,
  peers,
  firstDay,
}: {
  availabilityTimezone: string;
  timeOff: TimeOff[];
  availability: Availability[];
  advanced?: boolean;
  orgId: string;
  week: string;
  timezone: string;
  schedule: Schedule | null;
  members: Member[];
  positions: Position[];
  templates: ShiftTemplate[];
  requirements: CoverageRequirement[];
  settings: { weekly_hours_warning: number; revision: number } | null;
  carryIn: Shift[];
  peers: Shift[];
  firstDay: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [slotEditor, setSlotEditor] = useState<{
    date: string;
    slot?: Shift;
    baseRevision: number;
  } | null>(null);
  const editorRef = useRef<HTMLElement>(null);
  const warning = Number(settings?.weekly_hours_warning || 40);
  const shifts = (schedule?.shifts || []).map((shift) => ({
    ...shift,
    position_name:
      positions.find((position) => position.id === shift.position_id)?.name ||
      "General",
  }));
  const requiredSlots = shifts.filter((shift) => shift.is_required);
  const progressSlots = requiredSlots.length ? requiredSlots : shifts;
  const covered = progressSlots.filter((shift) => shift.employee_id).length;
  const unfilled = requiredSlots.filter((shift) => !shift.employee_id).length;

  function run(
    command: string,
    payload: Record<string, string>,
    revision: number | null = schedule?.revision ?? null,
  ) {
    setError("");
    setNotice("");
    startTransition(async () => {
      const result = await scheduleAction(orgId, command, payload, revision);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const messages: Record<string, string> = {
        assign: payload.employee_id
          ? "Assignment saved to the private draft."
          : "Employee unassigned; the coverage slot remains in the draft.",
        slot_save: "One-off slot saved to the private draft.",
        delete: "One-off slot removed from the private draft.",
        publish: "Schedule published. Employees can now see assigned shifts in this revision.",
        requirement_save: "Coverage requirement saved for newly created weeks.",
        requirement_delete: "Coverage requirement removed from future weeks. Existing weeks are unchanged.",
      };
      setNotice(messages[command] || "Saved to your workspace.");
      if (["slot_save", "delete"].includes(command)) setSlotEditor(null);
      setConfirmPublish(false);
      router.refresh();
    });
  }

  function openEditor(date: string, slot?: Shift) {
    if (!schedule) return;
    setSlotEditor({ date, slot, baseRevision: schedule.revision });
    setError("");
    setTimeout(
      () => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
      0,
    );
  }

  const positionOptions = (
    <>
      <option value="">General / no position</option>
      {positions.map((position) => (
        <option key={position.id} value={position.id}>
          {position.name}
        </option>
      ))}
    </>
  );
  const highHours = members
    .map((member) => ({
      ...member,
      hours: hoursInWeek(
        [...shifts, ...carryIn].filter((shift) => shift.employee_id === member.id),
        week,
        timezone,
      ),
    }))
    .filter((member) => member.hours > warning);
  const hardConflicts = [...shifts, ...carryIn].filter(s => timeOffConflict(s, timeOff));
  const advisoryWarnings = [...shifts, ...carryIn].filter(s => availabilityWarning(s, availability, availabilityTimezone));
  const status = !schedule?.published_revision
    ? "Private draft"
    : schedule.published_revision === schedule.revision
      ? "Published"
      : "Unpublished changes";

  return (
    <div className="coverage-workspace" aria-busy={pending}>
      <div className="message-stack" aria-live="polite">
        {!!hardConflicts.length && <p className="hard-conflict" role="alert">Hard conflict: {hardConflicts.length} assigned shift(s) overlap approved time off. Reassign them in their starting week before publishing. Existing published shifts stay unchanged.</p>}
        {!!advisoryWarnings.length && <p className="inline-warning">Availability advisory: {advisoryWarnings.length} assigned shift(s) fall outside stated preferences. You may keep these assignments.</p>}
        {error && <p className="notice schedule-error" role="alert">{error}</p>}
        {notice && <p className="notice success-notice" role="status">{notice}</p>}
        {pending && <p className="save-status" role="status">Saving…</p>}
      </div>

      {!schedule ? (
        <section className="panel coverage-empty">
          <div className="empty-icon" aria-hidden="true">▦</div>
          <p className="eyebrow">PRIVATE WEEKLY DRAFT</p>
          <h2>Create this week’s coverage plan</h2>
          <p>
            Shiftly will add every active recurring requirement as an empty slot.
            You can also carry forward assignments and one-off slots from the previous week.
          </p>
          <CommandForm
            onRun={run}
            schedule={schedule}
            pending={pending}
            command="create"
            extra={{ week_start: week }}
            className="draft-start-form"
          >
            <details className="draft-options"><summary>Copy assignments from last week (optional)</summary>
            <label>
              Starting point
              <select name="copy_previous" defaultValue="no">
                <option value="no">Use current coverage requirements</option>
                <option value="yes">Requirements + previous week assignments</option>
              </select>
            </label>
            <label>
              Repeated daylight-saving hour
              <select name="time_choice" defaultValue="reject">
                <option value="reject">Ask me if a copied time is ambiguous</option>
                <option value="earlier">Use earlier occurrence</option>
                <option value="later">Use later occurrence</option>
              </select>
            </label>
            </details>
            <button className="button primary">Create weekly draft</button>
          </CommandForm>
          {!advanced && <div className="time-off-preview"><h3>Approved time off</h3><CoverageCalendar readOnly shifts={[]} members={members} week={week} timezone={timezone} availabilityTimezone={availabilityTimezone} timeOff={timeOff} availability={availability} peers={[]} warning={warning} pending={pending} onAssign={() => {}} onAdd={() => {}} onEdit={() => {}} /></div>}
        </section>
      ) : (
        <>
          {!advanced && <>
          <section className="coverage-summary panel">
            <div className="coverage-progress" aria-label={`${covered} of ${progressSlots.length} coverage slots filled`}>
              <div
                className="progress-ring"
                style={{ "--coverage": `${progressSlots.length ? (covered / progressSlots.length) * 360 : 0}deg` } as CSSProperties}
              >
                <span>{covered}/{progressSlots.length}</span>
              </div>
              <div>
                <span className={`schedule-badge ${status === "Published" ? "live" : "draft"}`}>{status}</span>
                <h2>Weekly coverage</h2>
                <p>
                  {unfilled ? `${unfilled} required ${unfilled === 1 ? "slot needs" : "slots need"} an employee` : "All required slots are covered"}
                  {" · "}{timezone}
                </p>
              </div>
            </div>
            <div className="schedule-tools">
              <button type="button" className="button secondary" disabled={pending} onClick={() => window.print()}>
                Print Schedule
              </button>
              <button
                type="button"
                className="button primary"
                disabled={pending || schedule.published_revision === schedule.revision}
                onClick={() => setConfirmPublish(true)}
              >
                {schedule.published_revision ? "Republish" : "Publish"}
              </button>
            </div>
          </section>

          <section className="panel workspace-card weekly-hours"><h2>Employee hours this week</h2>
            <div className="hours-list">{members.map(member => <p key={member.id}><strong>{member.name}</strong> <span>{hoursInWeek([...shifts,...carryIn].filter(s=>s.employee_id===member.id),week,timezone).toFixed(1)} h</span></p>)}</div>
          </section>
          {highHours.length > 0 && (
            <aside className="notice hours-review">
              <div>
                <strong>Review weekly hours</strong>
                <p>{highHours.map((member) => `${member.name}: ${member.hours.toFixed(1)} h`).join(" · ")}</p>
                <p>Above the {warning}-hour planning guideline. Final payroll rules may differ.</p>
              </div>
            </aside>
          )}

          {confirmPublish && (
            <section className={`panel publish-review ${unfilled ? "incomplete" : ""}`} role="alertdialog" aria-labelledby="publish-title">
              <div>
                <p className="eyebrow">PUBLICATION REVIEW</p>
                <h2 id="publish-title">
                  {unfilled ? `Publish with ${unfilled} unfilled required ${unfilled === 1 ? "slot" : "slots"}?` : "Publish this covered week?"}
                </h2>
                <p>
                  Assigned shifts will replace the employee-visible version. Empty slots stay private. Conflicts and the draft revision are checked again.
                </p>
              </div>
              <div className="schedule-tools">
                <button
                  className={unfilled ? "button danger" : "button primary"}
                  disabled={pending}
                  onClick={() => run("publish", {
                    schedule_id: schedule.id,
                    allow_incomplete: unfilled ? "true" : "false",
                  })}
                >
                  {unfilled ? "Confirm incomplete publication" : "Confirm publication"}
                </button>
                <button className="button secondary" onClick={() => setConfirmPublish(false)}>
                  Keep editing
                </button>
              </div>
            </section>
          )}

          <section className="panel coverage-grid-panel">
            <CoverageCalendar
              availabilityTimezone={availabilityTimezone}
              timeOff={timeOff}
              availability={availability}
              shifts={shifts}
              members={members}
              week={week}
              timezone={timezone}
              peers={peers}
              warning={warning}
              carryIn={carryIn}
              pending={pending}
              onAssign={(slot, employeeId) =>
                run("assign", {
                  schedule_id: schedule.id,
                  id: slot.id,
                  employee_id: employeeId,
                })
              }
              onAdd={(day) => openEditor(day)}
              onEdit={(slot) => openEditor(localInput(slot.starts_at, timezone).slice(0, 10), slot)}
            />
          </section>

          {carryIn.length > 0 && (
            <aside className="carry-in coverage-carry-in">
              <h3>Continuing from the previous week</h3>
              <p className="muted">
                {carryIn.length} overnight {carryIn.length === 1 ? "shift continues" : "shifts continue"} into this week. Edit in the starting week.
              </p>
            </aside>
          )}

          {slotEditor && (
            <section className="panel one-off-editor" ref={editorRef}>
              <div className="editor-heading">
                <div>
                  <p className="eyebrow">ONE-OFF COVERAGE</p>
                  <h2>{slotEditor.slot ? "Edit one-off slot" : "Add a one-off slot"}</h2>
                  <p>Use this for coverage that does not repeat each week. Assignment is optional.</p>
                </div>
                <button className="popover-close" onClick={() => setSlotEditor(null)}>Close</button>
              </div>
              {slotEditor.baseRevision !== schedule.revision && (
                <p className="inline-warning" role="alert">The draft changed. Close and reopen this slot before saving.</p>
              )}
              <SlotForm
                key={`${slotEditor.date}:${slotEditor.slot?.id || "new"}:${schedule.revision}`}
                date={slotEditor.date}
                slot={slotEditor.slot}
                members={members}
                templates={templates}
                positionOptions={positionOptions}
                timezone={timezone}
                week={week}
                availabilityTimezone={availabilityTimezone}
              timeOff={timeOff}
                availability={availability}
                peers={[...shifts, ...peers]}
                warning={warning}
                pending={pending}
                onSubmit={(data) =>
                  run("slot_save", { ...data, schedule_id: schedule.id }, slotEditor.baseRevision)
                }
              />
              {slotEditor.slot && (
                <button
                  className="button danger"
                  disabled={pending}
                  onClick={() => run("delete", { schedule_id: schedule.id, id: slotEditor.slot!.id }, slotEditor.baseRevision)}
                >
                  Remove one-off slot
                </button>
              )}
            </section>
          )}

          </>}
          {advanced && <>
          <section className="coverage-config">
            <div className="config-heading">
              <div>
                <p className="eyebrow">AUTOMATION</p>
                <h2>Recurring coverage requirements</h2>
                <p>These rules populate newly created drafts. Existing draft and published weeks never change.</p>
              </div>
              <span className="count-pill">{requirements.filter((item) => item.is_active).length} active rules</span>
            </div>
            <div className="requirement-grid">
              {requirements.map((requirement) => (
                <details className="requirement-card" key={requirement.id}>
                  <summary>
                    <span>
                      <strong>{dayName(requirement.weekday)}</strong>
                      <small>{templates.find((template) => template.id === requirement.template_id)?.name || "Template"}</small>
                    </span>
                    <span className={requirement.is_active ? "rule-active" : "rule-paused"}>
                      {requirement.required_count} needed
                    </span>
                  </summary>
                  <CommandForm
                    onRun={run}
                    schedule={schedule}
                    pending={pending}
                    command="requirement_save"
                    revision={requirement.revision}
                    extra={{ id: requirement.id }}
                  >
                    <RequirementFields
                      requirement={requirement}
                      templates={templates}
                      positionOptions={positionOptions}
                      firstDay={firstDay}
                    />
                    <div className="schedule-tools">
                      <button className="button secondary">Save rule</button>
                      <button
                        type="button"
                        className="button danger"
                        onClick={() => run("requirement_delete", { id: requirement.id }, requirement.revision)}
                      >
                        Remove rule
                      </button>
                    </div>
                  </CommandForm>
                </details>
              ))}
              <details className="requirement-card add-rule">
                <summary>+ Add coverage rule</summary>
                <CommandForm
                  onRun={run}
                  schedule={schedule}
                  pending={pending}
                  command="requirement_save"
                  revision={null}
                >
                  <RequirementFields templates={templates} positionOptions={positionOptions} firstDay={firstDay} />
                  <button className="button primary" disabled={!templates.length}>Add rule</button>
                </CommandForm>
              </details>
            </div>
          </section>

          <div className="schedule-editor-grid">
            <section className="panel workspace-card">
              <h2>Planning settings</h2>
              <CommandForm onRun={run} schedule={schedule} pending={pending} command="settings" revision={settings?.revision ?? null}>
                <label>
                  Weekly hours review guideline
                  <input name="weekly_hours_warning" type="number" min="1" max="168" step="0.5" defaultValue={warning} required />
                </label>
                <button className="button secondary">Save guideline</button>
              </CommandForm>
              <h3>Positions</h3>
              <p className="muted">{positions.length ? positions.map((position) => position.name).join(" · ") : "Add a position for more precise coverage."}</p>
              <CommandForm onRun={run} schedule={schedule} pending={pending} command="position">
                <label>New position<input name="name" maxLength={100} required /></label>
                <button className="button secondary">Add position</button>
              </CommandForm>
            </section>

            <section className="panel workspace-card">
              <h2>Shift templates</h2>
              <p className="muted">Templates define labels and local times. The examples are editable and do not create coverage until used in a rule.</p>
              <div className="template-grid compact-templates">
                {templates.map((template) => (
                  <details key={template.id} className="template-card">
                    <summary><strong>{template.name}</strong><span>{template.start_time.slice(0, 5)}–{template.end_time.slice(0, 5)}</span></summary>
                    <CommandForm onRun={run} schedule={schedule} pending={pending} command="template_save" revision={template.revision} extra={{ id: template.id }}>
                      <TemplateFields template={template} positionOptions={positionOptions} />
                      <button className="button secondary">Save template</button>
                    </CommandForm>
                    <button className="button danger" disabled={pending} onClick={() => run("template_delete", { id: template.id }, template.revision)}>Delete template</button>
                  </details>
                ))}
                <details className="template-card">
                  <summary>+ New template</summary>
                  <CommandForm onRun={run} schedule={schedule} pending={pending} command="template_save" revision={null}>
                    <TemplateFields positionOptions={positionOptions} />
                    <button className="button secondary">Add template</button>
                  </CommandForm>
                </details>
              </div>
            </section>
          </div>
          </>}
        </>
      )}
    </div>
  );
}

function dayName(day: number) {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day];
}

function RequirementFields({
  requirement,
  templates,
  positionOptions,
  firstDay,
}: {
  requirement?: CoverageRequirement;
  templates: ShiftTemplate[];
  positionOptions: ReactNode;
  firstDay: number;
}) {
  const weekdays = Array.from({ length: 7 }, (_, index) => (firstDay + index) % 7);
  return (
    <>
      <label>
        Weekday
        <select name="weekday" defaultValue={requirement?.weekday ?? firstDay} required>
          {weekdays.map((day) => <option value={day} key={day}>{dayName(day)}</option>)}
        </select>
      </label>
      <label>
        Shift template
        <select name="template_id" defaultValue={requirement?.template_id || templates[0]?.id || ""} required>
          {templates.map((template) => <option value={template.id} key={template.id}>{template.name} · {template.start_time.slice(0, 5)}–{template.end_time.slice(0, 5)}</option>)}
        </select>
      </label>
      <label>Position<select name="position_id" defaultValue={requirement?.position_id || ""}>{positionOptions}</select></label>
      <label>
        Employees needed
        <input name="required_count" type="number" min="1" max="50" defaultValue={requirement?.required_count || 1} required />
      </label>
      <label className="check-label">
        <input name="is_active" type="checkbox" defaultChecked={requirement?.is_active ?? true} />
        Active for new weeks
      </label>
    </>
  );
}

function TemplateFields({ template, positionOptions }: { template?: ShiftTemplate; positionOptions: ReactNode }) {
  return (
    <>
      <label>Name<input name="name" defaultValue={template?.name} maxLength={60} required /></label>
      <label>Start time<input name="start_time" type="time" defaultValue={template?.start_time.slice(0, 5) || "07:00"} required /></label>
      <label>End time<input name="end_time" type="time" defaultValue={template?.end_time.slice(0, 5) || "15:00"} required /></label>
      <label className="check-label"><input name="end_next_day" type="checkbox" defaultChecked={template?.end_next_day} />Ends the next day</label>
      <label>Default position<select name="position_id" defaultValue={template?.position_id || ""}>{positionOptions}</select></label>
    </>
  );
}

function SlotForm({
  timeOff,
  availability,
  availabilityTimezone,
  date,
  slot,
  members,
  templates,
  positionOptions,
  timezone,
  week,
  peers,
  warning,
  pending,
  onSubmit,
}: {
  availabilityTimezone: string;
  timeOff: TimeOff[];
  availability: Availability[];
  date: string;
  slot?: Shift;
  members: Member[];
  templates: ShiftTemplate[];
  positionOptions: ReactNode;
  timezone: string;
  week: string;
  peers: Shift[];
  warning: number;
  pending: boolean;
  onSubmit: (data: Record<string, string>) => void;
}) {
  const [label, setLabel] = useState(slot?.label || "Custom shift");
  const [start, setStart] = useState(slot ? localInput(slot.starts_at, timezone) : `${date}T07:00`);
  const [end, setEnd] = useState(slot ? localInput(slot.ends_at, timezone) : `${date}T15:00`);
  const [employee, setEmployee] = useState(slot?.employee_id || "");
  const [position, setPosition] = useState(slot?.position_id || "");
  const [templateId, setTemplateId] = useState(slot?.template_id || "");
  const [startChoice, setStartChoice] = useState<"reject" | "earlier" | "later">("reject");
  const [endChoice, setEndChoice] = useState<"reject" | "earlier" | "later">("reject");
  let problem = "";
  let duration = 0;
  let projected = 0;
  let availabilityAdvisory = false;
  try {
    const startsAt = localToInstant(start, timezone, startChoice);
    const endsAt = localToInstant(end, timezone, endChoice);
    duration = (Date.parse(endsAt) - Date.parse(startsAt)) / 3600000;
    if (
      duration <= 0 || duration > 26 ||
      Date.parse(end + "Z") - Date.parse(start + "Z") > 86400000 ||
      start.slice(0, 10) < week || start.slice(0, 10) >= addDays(week, 7) ||
      end.slice(0, 10) > addDays(start.slice(0, 10), 1)
    ) problem = "Start must be in this week; end must follow start and be no later than the following day.";
    if (!problem && employee && peers.some((peer) =>
      peer.id !== slot?.id && peer.employee_id === employee &&
      Date.parse(peer.starts_at) < Date.parse(endsAt) && Date.parse(startsAt) < Date.parse(peer.ends_at)
    )) problem = "This employee has an overlapping shift in this or an adjacent week.";
    if (employee) {
      const proposed = { employee_id: employee, starts_at: startsAt, ends_at: endsAt };
      if (timeOffConflict(proposed, timeOff)) problem = "Hard conflict: this employee has approved time off. Choose another employee or time.";
      availabilityAdvisory = availabilityWarning(proposed, availability, availabilityTimezone);
      projected = hoursInWeek(
        peers.filter((peer) => peer.id !== slot?.id && peer.employee_id === employee).concat({
          id: slot?.id || "preview",
          schedule_id: slot?.schedule_id || "preview",
          employee_id: employee,
          starts_at: startsAt,
          ends_at: endsAt,
          notes: "",
        }),
        week,
        timezone,
      );
    }
  } catch {
    problem = "Check the dates and daylight-saving hour selection. Skipped local hours cannot be scheduled.";
  }
  return (
    <form className="slot-form" onSubmit={(event) => {
      event.preventDefault();
      if (!problem) onSubmit(Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>);
    }}>
      <fieldset disabled={pending}>
        <input type="hidden" name="id" value={slot?.id || ""} />
        <input type="hidden" name="template_id" value={templateId} />
        <label>
          Apply a template
          <select value={templateId} onChange={(event) => {
            setTemplateId(event.target.value);
            const template = templates.find((item) => item.id === event.target.value);
            if (!template) return;
            setLabel(template.name);
            setStart(`${date}T${template.start_time.slice(0, 5)}`);
            setEnd(`${template.end_next_day ? addDays(date, 1) : date}T${template.end_time.slice(0, 5)}`);
            setPosition(template.position_id || "");
          }}>
            <option value="">Custom times</option>
            {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
        </label>
        <label>Slot label<input name="label" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} required /></label>
        <label>Employee (optional)<select name="employee_id" value={employee} onChange={(event) => setEmployee(event.target.value)}><option value="">Leave unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>Position<select name="position_id" value={position} onChange={(event) => setPosition(event.target.value)}>{positionOptions}</select></label>
        <label>Start<input name="start_local" type="datetime-local" min={`${week}T00:00`} max={`${addDays(week, 6)}T23:59`} value={start} onChange={(event) => setStart(event.target.value)} required /></label>
        <label>End<input name="end_local" type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} required /></label>
        <label>Start DST choice<select name="start_choice" value={startChoice} onChange={(event) => setStartChoice(event.target.value as typeof startChoice)}><option value="reject">Ask for repeated hour</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select></label>
        <label>End DST choice<select name="end_choice" value={endChoice} onChange={(event) => setEndChoice(event.target.value as typeof endChoice)}><option value="reject">Ask for repeated hour</option><option value="earlier">Earlier occurrence</option><option value="later">Later occurrence</option></select></label>
        <label className="slot-notes">Note visible after publication<textarea name="notes" defaultValue={slot?.notes || ""} maxLength={300} rows={2} /></label>
        {availabilityAdvisory && <p className="inline-warning">Availability advisory: outside this employee’s stated preferences. You may save this assignment.</p>}
        {problem ? <p className="inline-warning" role="alert">{problem}</p> : <p className={projected > warning ? "inline-warning" : "muted"}>{duration.toFixed(1)} actual hours{employee ? ` · ${projected.toFixed(1)} projected weekly hours` : " · unassigned slot"}</p>}
        <button className="button primary" disabled={!!problem}>{slot ? "Save one-off slot" : "Add one-off slot"}</button>
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
  onRun: (command: string, payload: Record<string, string>, revision: number | null) => void;
  schedule: Schedule | null;
  pending: boolean;
  command: string;
  children: ReactNode;
  revision?: number | null;
  className?: string;
  extra?: Record<string, string>;
}) {
  return (
    <form className={className} onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
      onRun(command, { schedule_id: schedule?.id || "", ...extra, ...data }, revision);
    }}>
      <fieldset disabled={pending}>{children}</fieldset>
    </form>
  );
}
