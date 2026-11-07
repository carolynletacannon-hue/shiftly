"use client";
import { useState } from "react";

type Result = { active?: boolean; url?: string; error?: string };
export function CalendarControls({
  org,
  initialActive,
  unavailable = false,
  action,
}: {
  org: string;
  initialActive: boolean;
  unavailable?: boolean;
  action: (
    org: string,
    command: "status" | "rotate" | "revoke",
  ) => Promise<Result>;
}) {
  const [active, setActive] = useState(initialActive);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
  async function update(command: "rotate" | "revoke") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action(org, command);
      if (
        result.error ||
        typeof result.active !== "boolean" ||
        (command === "rotate" && !result.url)
      ) {
        setError(
          result.error ||
            "Unable to update the calendar link. Please try again.",
        );
        return;
      }
      setActive(result.active);
      setUrl(result.url || "");
      setConfirm(null);
      setMessage(
        command === "rotate"
          ? "Your private link is ready. Add it in your calendar using the instructions below."
          : "Your link has been revoked. It can no longer fetch your schedule.",
      );
    } catch {
      setError("Unable to update the calendar link. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    setError("");
    setMessage("");
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Subscription link copied.");
    } catch {
      setError("Could not copy automatically. Select and copy the link below.");
    }
  }
  return (
    <section
      id="calendar-integration"
      className="panel workspace-card calendar-integration"
      aria-labelledby="calendar-heading"
    >
      <h2 id="calendar-heading">Calendar Integration</h2>
      <p>
        See your published shifts in your favorite calendar. This private
        subscription includes only your shifts at this business.
      </p>
      <p className="notice">
        Anyone with your private URL may be able to view your schedule. Keep it
        private. Regenerate or revoke it if it has been shared.
      </p>
      <p className="muted">
        Calendar apps choose when to refresh. Updates may take hours or longer.
        Check My Schedule for the latest published changes.
      </p>
      {unavailable ? (
        <p role="alert">
          Calendar integration is unavailable. Contact your manager and try
          again later.
        </p>
      ) : (
        <>
          <div className="calendar-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => (active ? setConfirm("rotate") : update("rotate"))}
            >
              Add to Calendar
            </button>
            {active && (
              <>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setConfirm("rotate")}
                >
                  Regenerate link
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setConfirm("revoke")}
                >
                  Revoke link
                </button>
              </>
            )}
          </div>
          {active && !url && (
            <p className="hint">
              You already have a private link. For security, it cannot be shown
              again. Regenerate it to set up a new subscription; then replace
              the link in each calendar app.
            </p>
          )}
          {confirm && (
            <div className="notice">
              <p>
                {confirm === "rotate"
                  ? "Create a new link? Your existing link will stop working immediately. You’ll need to replace the subscription in each calendar app."
                  : "Revoke this link? Calendar apps will stop receiving updates. Remove the subscribed calendar in each app to clear saved events."}
              </p>
              <div className="calendar-actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => update(confirm)}
                >
                  {confirm === "rotate"
                    ? "Create new link"
                    : "Revoke private link"}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                >
                  Keep existing link
                </button>
              </div>
            </div>
          )}
          {busy && <p role="status">Updating your calendar link…</p>}
          {error && <p role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
          {url && (
            <div className="calendar-link-controls" data-private="true">
              <label htmlFor="calendar-private-link">
                Private HTTPS subscription URL
              </label>
              <input
                id="calendar-private-link"
                type="text"
                readOnly
                value={url}
                autoComplete="off"
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" className="button secondary" onClick={copy}>
                Copy subscription link
              </button>
              <p className="hint">
                Copy this link now. It is only shown until you leave this page.
              </p>
            </div>
          )}
        </>
      )}
      <div className="calendar-platforms">
        <details>
          <summary>Google Calendar</summary>
          <p>
            Copy the HTTPS subscription URL. In Google Calendar on a computer,
            next to Other calendars choose + → From URL. Paste the link and
            choose Add calendar. The subscribed calendar can then appear on
            devices signed into that Google account.
          </p>
        </details>
        <details>
          <summary>Apple Calendar / iCloud</summary>
          <p>
            On a compatible Apple device, open the subscription link below and
            follow the prompts. Or in Calendar on a Mac choose File → New
            Calendar Subscription and paste the HTTPS link. Choose iCloud as the
            location if you want it on other Apple devices. On iPhone or iPad,
            use Calendar Accounts → Add Account → Other → Add Subscribed
            Calendar in Settings (menu names vary).
          </p>
          {url && (
            <a
              className="button secondary"
              href={url.replace(/^https:/, "webcal:")}
              rel="noreferrer"
              referrerPolicy="no-referrer"
            >
              Open in Apple Calendar
            </a>
          )}
        </details>
        <details>
          <summary>Outlook</summary>
          <p>
            Copy the HTTPS subscription URL. In Outlook on the web, open
            Calendar → Add calendar → Subscribe from web, paste the link, name
            the calendar, and choose Import. In desktop Outlook, look for Add
            Calendar → From Internet. Choose an internet subscription so future
            published changes can refresh.
          </p>
        </details>
        <details>
          <summary>Other calendar apps</summary>
          <p>
            Choose your app’s Subscribe or Add calendar from URL option, then
            paste the HTTPS subscription URL.
          </p>
        </details>
      </div>
      <p className="hint">
        Subscribing receives future published updates. Downloading or importing
        a one-time .ics file creates a static copy and will not keep your
        schedule up to date. Revoking a link cannot erase events already saved
        by a calendar app.
      </p>
    </section>
  );
}
