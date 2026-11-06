"use client";
import Link from "next/link";
import { manageEmployee } from "./actions";
export type EmployeeStatus = {
  ok: boolean;
  blockers: { kind: string; id?: string; message: string }[];
  delete_reasons: string[];
};
export function LifecycleControls({
  org,
  employee,
  status,
}: {
  org: string;
  employee: { id: string; display_name: string; archived_at: string | null };
  status: EmployeeStatus;
}) {
  const archived = !!employee.archived_at;
  function action(
    command: "archive" | "restore" | "delete",
    label: string,
    disabled: boolean,
  ) {
    const explanation =
      command === "archive"
        ? "Archive this employee? Their workspace access and outstanding invitations will be revoked. Scheduling history will be preserved."
        : command === "restore"
          ? "Restore this employee for scheduling? Account access stays revoked until an authorized new invitation is accepted."
          : "Permanently delete this unused employee? This cannot be undone.";
    return (
      <form
        action={manageEmployee}
        onSubmit={(event) => {
          if (!window.confirm(`${employee.display_name}: ${explanation}`))
            event.preventDefault();
        }}
      >
        <input type="hidden" name="organization_id" value={org} />
        <input type="hidden" name="employee_id" value={employee.id} />
        <input type="hidden" name="command" value={command} />
        <input type="hidden" name="confirmed" value="yes" />
        <button
          className={`button ${command === "restore" ? "secondary" : "danger"}`}
          disabled={disabled}
        >
          {label}
        </button>
      </form>
    );
  }
  return (
    <div className="employee-lifecycle">
      {!archived && status.blockers.length > 0 && (
        <details>
          <summary>
            Resolve {status.blockers.length} item(s) before archiving
          </summary>
          <ul>
            {status.blockers.map((blocker, i) => (
              <li key={i}>
                {blocker.message}{" "}
                {blocker.kind !== "owner" && (
                  <Link
                    href={`/workspaces/${org}/${blocker.kind === "request" ? "shift-requests" : blocker.kind === "time-off" ? "time-off" : "schedule"}`}
                  >
                    Review
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="schedule-tools">
        {archived
          ? action("restore", "Restore employee", false)
          : action("archive", "Archive employee", status.blockers.length > 0)}
        {action(
          "delete",
          "Permanently delete",
          status.delete_reasons.length > 0,
        )}
      </div>
      {status.delete_reasons.length > 0 && (
        <details>
          <summary>Why permanent deletion is unavailable</summary>
          <p>
            History and related records must be preserved. Archive this employee
            to remove them from the active roster.
          </p>
          <ul>
            {status.delete_reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
