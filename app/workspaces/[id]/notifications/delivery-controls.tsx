"use client";
import { useState, useTransition } from "react";
import {
  runEmailDiagnostic,
  retryNotificationEmails,
} from "./delivery-actions";
export function DeliveryControls({ org }: { org: string }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState("");
  return (
    <section className="card">
      <h2>Email delivery</h2>
      <p>
        Send a diagnostic email to your own verified account, or retry up to ten
        eligible notifications in this workspace. Retries respect employee
        preferences and active delivery leases.
      </p>
      <button
        disabled={pending}
        onClick={() =>
          start(async () => {
            setMessage(await runEmailDiagnostic(org));
          })
        }
      >
        Send me a test email
      </button>{" "}
      <button
        disabled={pending}
        onClick={() => {
          if (
            window.confirm(
              "Deliver eligible queued notifications to employees in this workspace now?",
            )
          )
            start(async () => {
              setMessage(await retryNotificationEmails(org));
            });
        }}
      >
        Retry eligible notifications
      </button>
      <p role="status">{pending ? "Running delivery…" : message}</p>
    </section>
  );
}
