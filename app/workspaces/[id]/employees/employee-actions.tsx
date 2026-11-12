"use client";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/app/ui/button";
import { Icon } from "@/app/ui/icons";
import { ConfirmationDialog } from "@/app/ui/confirmation-dialog";
import { manageEmployee } from "./actions";
import type { EmployeeStatus } from "./lifecycle-controls";
type Command = "archive" | "restore" | "delete";
type Action = {
  command: Command;
  label: string;
  disabled: boolean;
  reason?: string;
};
const explanations: Record<Command, string> = {
  archive:
    "Archive this employee? Their workspace access and outstanding invitations will be revoked. Scheduling history will be preserved.",
  restore:
    "Restore this employee for scheduling? Account access stays revoked until an authorized new invitation is accepted.",
  delete: "Permanently delete this unused employee? This cannot be undone.",
};
function ActionIcon({ command }: { command: Command }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {command === "delete" ? (
        <>
          <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
        </>
      ) : command === "archive" ? (
        <>
          <rect x="3" y="3" width="18" height="5" rx="1" />
          <path d="M5 8v13h14V8m-10 4h6" />
        </>
      ) : (
        <>
          <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7" />
        </>
      )}
    </svg>
  );
}
function ActionsPopover({
  name,
  actions,
  trigger,
  onChoose,
}: {
  name: string;
  actions: Action[];
  trigger: React.RefObject<HTMLButtonElement | null>;
  onChoose: (action: Action) => void;
}) {
  const [open, setOpen] = useState(false);
  const { pending } = useFormStatus();
  const id = useId();
  const selecting = useRef(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          ref={trigger}
          type="button"
          className="employee-actions-trigger"
          disabled={pending}
          aria-busy={pending}
          aria-label={`Actions for ${name}`}
        >
          Actions <Icon name="chevron-down" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="employee-actions-popover"
          aria-labelledby={`${id}-title`}
          onCloseAutoFocus={(event) => {
            // The modal owns focus after choosing an action; ordinary dismissal
            // still restores focus through Radix. The dialog's close restores it below.
            if (selecting.current) {
              event.preventDefault();
              selecting.current = false;
            }
          }}
        >
          <p id={`${id}-title`} className="employee-actions-title">
            Employee actions
          </p>
          {actions
            .filter((a) => a.command === "restore")
            .map((action) => row(action))}
          <div className="employee-actions-divider" />
          <div className="employee-destructive-actions">
            {actions
              .filter((a) => a.command !== "restore")
              .map((action) => row(action))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
  function row(action: Action) {
    return (
      <button
        key={action.command}
        type="button"
        className={`employee-action-item${action.command !== "restore" ? " is-destructive" : ""}`}
        disabled={action.disabled}
        aria-label={action.label}
        aria-describedby={
          action.reason ? `${id}-${action.command}-reason` : undefined
        }
        onClick={() => {
          selecting.current = true;
          setOpen(false);
          onChoose(action);
        }}
      >
        <ActionIcon command={action.command} />
        <span>
          <strong>{action.label}</strong>
          {action.reason && (
            <small id={`${id}-${action.command}-reason`}>{action.reason}</small>
          )}
        </span>
      </button>
    );
  }
}
export function EmployeeActions({
  org,
  employee,
  status,
}: {
  org: string;
  employee: { id: string; display_name: string; archived_at: string | null };
  status: EmployeeStatus;
}) {
  const form = useRef<HTMLFormElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState<Action>();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const element = form.current!;
    const restoreFocus = () => trigger.current?.focus();
    element.addEventListener("close", restoreFocus, true);
    return () => element.removeEventListener("close", restoreFocus, true);
  }, []);
  const actions: Action[] = [
    employee.archived_at
      ? { command: "restore", label: "Restore employee", disabled: false }
      : {
          command: "archive",
          label: "Archive employee",
          disabled: status.blockers.length > 0,
          reason: status.blockers.length
            ? "Resolve the blockers on this card first."
            : undefined,
        },
    {
      command: "delete",
      label: "Permanently delete",
      disabled: status.delete_reasons.length > 0,
      reason: status.delete_reasons.length
        ? "History must be preserved. See details on this card."
        : undefined,
    },
  ];
  return (
    <form ref={form} action={manageEmployee} className="employee-actions-form">
      <input type="hidden" name="organization_id" value={org} />
      <input type="hidden" name="employee_id" value={employee.id} />
      <input type="hidden" name="command" value={selected?.command || ""} />
      <input type="hidden" name="confirmed" value="yes" />
      <ActionsPopover
        name={employee.display_name}
        actions={actions}
        trigger={trigger}
        onChoose={(action) => {
          setSelected(action);
          setConfirming(true);
        }}
      />
      <ConfirmationDialog
        open={confirming}
        title={selected?.label || "Employee action"}
        description={
          selected
            ? `${employee.display_name}: ${explanations[selected.command]}`
            : ""
        }
        confirmLabel={selected?.label || "Confirm"}
        danger={selected?.command !== "restore"}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          // Keep the selected command stable until the original server action
          // captures FormData; the popover has no submit buttons of its own.
          form.current?.requestSubmit();
        }}
      />
    </form>
  );
}
