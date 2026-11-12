"use client";
import { EmployeeAccordion } from "./accordion";
import Link from "next/link";
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
  return (
    <div className="employee-lifecycle">
      {!archived && status.blockers.length > 0 && (
        <EmployeeAccordion
          title={`Resolve ${status.blockers.length} item(s) before archiving`}
          icon="shield"
          warning
        >
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
        </EmployeeAccordion>
      )}
      {status.delete_reasons.length > 0 && (
        <EmployeeAccordion
          title="Why permanent deletion is unavailable"
          icon="shield"
        >
          <p>
            History and related records must be preserved. Archive this employee
            to remove them from the active roster.
          </p>
          <ul>
            {status.delete_reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </EmployeeAccordion>
      )}
    </div>
  );
}
