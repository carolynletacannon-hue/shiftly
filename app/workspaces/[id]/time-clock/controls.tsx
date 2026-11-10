"use client";
import { clockButtonLabel } from "@/lib/time-clock/approval-labels";
import { useActionState, useEffect, useState } from "react";
import { clockAction, type Result } from "./actions";
export function ClockForm({
  org,
  command,
  children,
}: {
  org: string;
  command: string;
  children: React.ReactNode;
}) {
  const [state, action, pending] = useActionState(clockAction, {} as Result);
  const [pin, setPin] = useState<string>();
  useEffect(() => {
    if (state.activated) {
      window.location.replace("/api/kiosk/handoff");
      return;
    }
    setPin(state.pin);
    const timer = setTimeout(() => setPin(undefined), 30000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <form action={action} className="account-form">
      <input type="hidden" name="organization_id" value={org} />
      <input type="hidden" name="command" value={command} />
      {children}
      <button className="button secondary" disabled={pending}>
        {clockButtonLabel(command, pending)}
      </button>
      {state.error && <p role="alert">{state.error}</p>}
      {state.message && <p role="status">{state.message}</p>}
      {pin && (
        <div className="pin-reveal">
          <strong aria-label="New employee PIN">{pin}</strong>
          <button type="button" onClick={() => setPin(undefined)}>
            Hide PIN
          </button>
        </div>
      )}
    </form>
  );
}
