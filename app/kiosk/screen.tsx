"use client";
import { useEffect, useRef, useState } from "react";
import { Brand } from "@/app/brand";
type Info = {
  name: string;
  timezone: string;
  now: string;
  require_breaks: boolean;
};
type Person = {
  name: string;
  status: "out" | "working" | "break";
  challenge: string;
};
const labels: Record<string, string> = {
  in: "Clock In",
  out: "Clock Out",
  break_start: "Start Unpaid Break",
  break_end: "End Unpaid Break",
};
async function call(body: object) {
  const response = await fetch("/api/kiosk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return response.json();
}
export function Kiosk() {
  const [info, setInfo] = useState<Info>();
  const [pin, setPin] = useState("");
  const [person, setPerson] = useState<Person>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [clock, setClock] = useState("");
  const base = useRef({ at: 0, mono: 0 });
  const activity = useRef(0);
  const retry = useRef<{
    command: string;
    action: string;
    request_id: string;
    challenge: string;
  }>(undefined);
  function reset() {
    setPin("");
    setPerson(undefined);
    retry.current = undefined;
    activity.current = performance.now();
  }
  useEffect(() => {
    let live = true;
    call({ command: "info" })
      .then((data) => {
        if (!live) return;
        if (data.error) {
          setUnauthorized(true);
          setMessage(data.error);
        } else {
          setInfo(data);
          base.current = { at: Date.parse(data.now), mono: performance.now() };
          activity.current = performance.now();
        }
      })
      .catch(() => setMessage("Unable to connect. Reload to try again."));
    const tick = setInterval(() => {
      if (base.current.at)
        setClock(
          new Date(
            base.current.at + performance.now() - base.current.mono,
          ).toISOString(),
        );
      if (performance.now() - activity.current > 30000) {
        reset();
        setMessage("");
      }
    }, 1000);
    const rotation = setInterval(() => {
      call({ command: "rotate" })
        .then((data) => {
          reset();
          if (data.error) {
            setUnauthorized(true);
            setMessage(data.error);
          }
        })
        .catch(() => {
          setUnauthorized(true);
          setMessage(
            "Reconnect and ask your manager to authorize this kiosk again.",
          );
        });
    }, 3600000);
    const onPage = () => {
      reset();
    };
    window.addEventListener("pageshow", onPage);
    return () => {
      live = false;
      clearInterval(tick);
      clearInterval(rotation);
      window.removeEventListener("pageshow", onPage);
    };
  }, []);
  async function verify() {
    setBusy(true);
    setMessage("");
    activity.current = performance.now();
    const entered = pin;
    setPin("");
    try {
      const data = await call({ command: "pin", pin: entered });
      if (data.error) {
        setMessage(data.error);
        setPerson(undefined);
      } else {
        setPerson(data);
        activity.current = performance.now();
      }
    } catch {
      setMessage("Connection interrupted. Enter your PIN to try again.");
    } finally {
      setBusy(false);
    }
  }
  async function punch(action: string) {
    if (!person || busy) return;
    setBusy(true);
    activity.current = performance.now();
    retry.current ||= {
      command: "punch",
      action,
      request_id: crypto.randomUUID(),
      challenge: person.challenge,
    };
    try {
      const data = await call(retry.current);
      if (data.error) {
        reset();
        setMessage(data.error);
      } else {
        reset();
        setMessage(`${labels[data.action]} recorded. Thank you!`);
        setTimeout(() => setMessage(""), 5000);
      }
    } catch {
      setMessage(
        "Connection interrupted. Tap Retry to confirm the same punch.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function end() {
    setBusy(true);
    try {
      const data = await call({ command: "end" });
      if (data.error && !unauthorized) {
        setMessage(data.error);
        return;
      }
      reset();
      window.location.replace("/login");
    } catch {
      setMessage(
        "Unable to end kiosk mode. Retry or ask a manager to revoke it remotely.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="kiosk-shell">
      <div className="kiosk-brand">
        <Brand />
      </div>
      <section className="kiosk-card">
        <p className="eyebrow">WORKPLACE TIME CLOCK</p>
        <h1>{info?.name || "Welcome"}</h1>
        <p className="kiosk-time" suppressHydrationWarning>
          {info && clock
            ? new Intl.DateTimeFormat("en-US", {
                timeZone: info.timezone,
                dateStyle: "full",
                timeStyle: "medium",
              }).format(new Date(clock))
            : "Connecting securely…"}
        </p>
        <div role="status" aria-live="polite" className="kiosk-message">
          {message}
        </div>
        {unauthorized ? (
          <>
            <h2>Manager authorization required</h2>
            <p>This device must be enrolled by an owner or manager.</p>
            <button className="button secondary" disabled={busy} onClick={end}>
              Clear kiosk mode & sign in
            </button>
          </>
        ) : person ? (
          <>
            <h2>Hello, {person.name}</h2>
            <p>
              {person.status === "out"
                ? "You’re clocked out."
                : person.status === "break"
                  ? "You’re on an unpaid break."
                  : "You’re clocked in."}
            </p>
            <div className="kiosk-actions">
              {retry.current ? (
                <button
                  disabled={busy}
                  className="button primary"
                  onClick={() => punch(retry.current!.action)}
                >
                  Retry {labels[retry.current.action]}
                </button>
              ) : (
                (person.status === "out"
                  ? ["in"]
                  : person.status === "break"
                    ? ["break_end"]
                    : ["break_start", "out"]
                ).map((action) => (
                  <button
                    key={action}
                    disabled={busy}
                    className="button primary"
                    onClick={() => punch(action)}
                  >
                    {labels[action]}
                  </button>
                ))
              )}
              <button
                disabled={busy}
                className="button secondary"
                onClick={reset}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Enter your four-digit PIN</h2>
            <p>Clock in, clock out, or record an unpaid break.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void verify();
              }}
            >
              <label className="sr-only" htmlFor="kiosk-pin">
                Employee PIN
              </label>
              <input
                id="kiosk-pin"
                className="kiosk-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                value={pin}
                disabled={busy || !info}
                onChange={(e) => {
                  setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
                  activity.current = performance.now();
                }}
              />
              <div className="kiosk-keypad">
                {[
                  "1",
                  "2",
                  "3",
                  "4",
                  "5",
                  "6",
                  "7",
                  "8",
                  "9",
                  "Clear",
                  "0",
                  "Delete",
                ].map((key) => (
                  <button
                    type="button"
                    key={key}
                    disabled={busy || !info}
                    onClick={() => {
                      setPin((p) =>
                        key === "Clear"
                          ? ""
                          : key === "Delete"
                            ? p.slice(0, -1)
                            : (p + key).slice(0, 4),
                      );
                      activity.current = performance.now();
                    }}
                  >
                    {key}
                  </button>
                ))}
              </div>
              <button
                className="button primary kiosk-continue"
                disabled={busy || pin.length !== 4}
              >
                {" "}
                {busy ? "Checking…" : "Continue"}
              </button>
            </form>
            {info?.require_breaks && (
              <p>
                Record the start and end of each unpaid break. Ask your manager
                about required breaks.
              </p>
            )}
          </>
        )}
        {!unauthorized && (
          <details className="kiosk-end">
            <summary>End kiosk mode</summary>
            <p>
              This revokes this device. A manager must sign in to authorize it
              again.
            </p>
            <button className="button secondary" disabled={busy} onClick={end}>
              End & revoke this kiosk
            </button>
          </details>
        )}
      </section>
      <p className="kiosk-footer">
        Your time, recorded accurately. Your information stays private.
      </p>
    </main>
  );
}
