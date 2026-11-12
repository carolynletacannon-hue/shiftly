"use client";
import { Card } from "@/app/ui/surfaces";
import { Button } from "@/app/ui/button";
import { ConfirmationDialog } from "@/app/ui/confirmation-dialog";
import { useState, useTransition } from "react";
import {
  runEmailDiagnostic,
  retryNotificationEmails,
} from "./delivery-actions";
export function DeliveryControls({ org }: { org: string }) {
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <Card className="workspace-card">
      <h2>Email delivery</h2>
      <p>
        Send a diagnostic email to your own verified account, or retry up to ten
        eligible notifications in this workspace. Retries respect employee
        preferences and active delivery leases.
      </p>
      <Button
        aria-busy={pending}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setMessage(await runEmailDiagnostic(org));
          })
        }
      >
        Send me a test email
      </Button>{" "}
      <Button
        aria-busy={pending}
        disabled={pending}
        onClick={() => setConfirm(true)}
      >
        Retry eligible notifications
      </Button>
      <ConfirmationDialog
        open={confirm}
        title="Retry queued notifications?"
        description="Deliver eligible queued notifications to employees in this workspace now?"
        confirmLabel="Retry notifications"
        danger={false}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          start(async () => {
            setMessage(await retryNotificationEmails(org));
          });
        }}
      />
      <p role="status">{pending ? "Running delivery…" : message}</p>
    </Card>
  );
}
