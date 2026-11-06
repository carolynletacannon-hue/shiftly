"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import {
  preferenceDefaults,
  preferenceLabels,
  type Preferences,
} from "@/lib/notifications/preferences";
export function PreferenceControls({
  org,
  initial,
  manager,
  action,
}: {
  org: string;
  initial: Preferences;
  manager: boolean;
  action: (
    org: string,
    values: Preferences,
  ) => Promise<{ ok: boolean; message: string }>;
}) {
  const [values, setValues] = useState(initial);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  return (
    <section className="panel workspace-card">
      <h2>Notification Preferences</h2>
      <p>
        Email preferences apply only to this workplace. Important updates remain
        available in your notification center.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setMessage("");
          start(async () => {
            try {
              setMessage((await action(org, values)).message);
            } catch {
              setMessage("Unable to save preferences. Please try again.");
            }
          });
        }}
      >
        {[true, false].map((important) => (
          <fieldset
            key={String(important)}
            disabled={pending}
            style={{ border: 0, padding: 0, margin: "1.5rem 0" }}
          >
            <legend>
              <strong>
                {important
                  ? "Important notifications"
                  : "Optional notifications"}
              </strong>
            </legend>
            {(Object.keys(preferenceDefaults) as (keyof Preferences)[])
              .filter(
                (key) =>
                  preferenceDefaults[key] === important &&
                  (key !== "approval" || manager),
              )
              .map((key) => (
                <label
                  key={key}
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    alignItems: "start",
                    padding: "0.8rem 0",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={values[key]}
                    disabled={key.startsWith("reminder_")}
                    onChange={(e) => {
                      setValues({ ...values, [key]: e.target.checked });
                      setMessage("");
                    }}
                  />
                  <span>
                    <strong>{preferenceLabels[key][0]}</strong>
                    <br />
                    <small>{preferenceLabels[key][1]}</small>
                  </span>
                </label>
              ))}
          </fieldset>
        ))}
        <button className="button primary" disabled={pending}>
          {pending ? "Saving…" : "Save preferences"}
        </button>
        <p role="status" aria-live="polite">
          {message}
        </p>
      </form>
    </section>
  );
}
export type InboxItem = {
  id: string;
  message: string;
  href: string | null;
  read_at: string | null;
  created_at: string;
};
export function Inbox({
  org,
  items,
  action,
}: {
  org: string;
  items: InboxItem[];
  action: (
    org: string,
    id?: string,
  ) => Promise<{ ok: boolean; message: string }>;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState("");
  function read(id?: string) {
    start(async () => {
      try {
        setMessage((await action(org, id)).message);
        window.dispatchEvent(new window.Event("notifications-read"));
      } catch {
        setMessage("Unable to mark notifications as read.");
      }
    });
  }
  return (
    <section className="panel workspace-card">
      <h2>Recent notifications</h2>
      <button
        className="button secondary"
        disabled={pending || !items.some((n) => !n.read_at)}
        onClick={() => read()}
      >
        Mark all as read
      </button>
      <p role="status">{message}</p>
      {!items.length && (
        <p>You’re all caught up. Important updates will appear here.</p>
      )}
      {items.map((item) => (
        <article className="template-card" key={item.id}>
          <strong>{item.read_at ? "Read" : "Unread"}</strong>
          <p>{item.message}</p>
          <small>
            {new Date(item.created_at).toLocaleDateString("en-US", {
              timeZone: "UTC",
              dateStyle: "medium",
            })}
          </small>
          <div className="schedule-tools">
            {item.href?.startsWith(`/workspaces/${org}/`) && (
              <Link
                className="button secondary"
                href={item.href}
                onClick={() => read(item.id)}
              >
                View details
              </Link>
            )}
            {!item.read_at && (
              <button
                className="button secondary"
                disabled={pending}
                onClick={() => read(item.id)}
              >
                Mark as read
              </button>
            )}
          </div>
        </article>
      ))}
      <p>
        <small>Showing the 100 most recent updates.</small>
      </p>
    </section>
  );
}
