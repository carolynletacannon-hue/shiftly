"use client";
import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { Button } from "./button";
import { Icon } from "./icons";
export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  danger = true,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const element = dialog.current!;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={`ui-confirm-dialog ${danger ? "ui-confirm-danger" : ""}`}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={onCancel}
      onClose={onCancel}
    >
      <span className="ui-icon-tile">
        <Icon name="shield" />
      </span>
      <h2 id={`${id}-title`}>{title}</h2>
      <p id={`${id}-description`}>{description}</p>
      <div className="ui-dialog-actions">
        <Button type="button" onClick={onCancel} autoFocus>
          Cancel
        </Button>
        <Button
          type="button"
          variant={danger ? "danger" : "primary"}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
/** Request the original form submission after consent, preserving action,
 * validation, the submitter and hidden command fields. No action runs on open. */
export function ConfirmForm({
  title,
  description,
  confirmLabel,
  children,
  ...props
}: ComponentProps<"form"> & {
  title: string;
  description: string;
  confirmLabel: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const approved = useRef(false);
  const submitter = useRef<HTMLButtonElement | HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <form
      {...props}
      ref={form}
      onSubmit={(event) => {
        if (approved.current) {
          approved.current = false;
          return;
        }
        event.preventDefault();
        submitter.current = (event.nativeEvent as SubmitEvent).submitter as
          HTMLButtonElement | HTMLInputElement | null;
        setOpen(true);
      }}
    >
      {children}
      <ConfirmationDialog
        open={open}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          approved.current = true;
          if (submitter.current) form.current?.requestSubmit(submitter.current);
          else form.current?.requestSubmit();
        }}
      />
    </form>
  );
}
