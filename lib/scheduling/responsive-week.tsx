"use client";
import { useId, useRef, useState, type ReactNode } from "react";
import { addDays } from "./time";

/** Layout-only controller. The same seven day/cell nodes remain mounted; CSS
 * selects the wide grid or compact overview based on actual content width. */
export function ResponsiveWeek({
  week,
  counts,
  children,
}: {
  week: string;
  counts: number[];
  children: ReactNode;
}) {
  const [selected, setSelected] = useState(0);
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="weekly-view" data-selected-day={selected}>
      <div className="weekly-overview" role="group" aria-label="Week overview">
        {Array.from({ length: 7 }, (_, index) => {
          const day = addDays(week, index);
          const date = new Date(`${day}T12:00:00Z`);
          const label = new Intl.DateTimeFormat("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          }).format(date);
          const count = counts[index] || 0;
          return (
            <button
              type="button"
              key={day}
              ref={(node) => {
                buttons.current[index] = node;
              }}
              aria-pressed={selected === index}
              aria-controls={`${id}-content`}
              aria-label={`${label}: ${count} ${count === 1 ? "shift" : "shifts"}`}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % 7
                    : event.key === "ArrowLeft"
                      ? (index + 6) % 7
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? 6
                          : null;
                if (next === null) return;
                event.preventDefault();
                setSelected(next);
                buttons.current[next]?.focus();
              }}
            >
              <span>
                {new Intl.DateTimeFormat("en-US", {
                  weekday: "short",
                  timeZone: "UTC",
                }).format(date)}
              </span>
              <strong>{date.getUTCDate()}</strong>
              <small>
                {count}
                <span className="sr-only">
                  {" "}
                  {count === 1 ? "shift" : "shifts"}
                </span>
              </small>
            </button>
          );
        })}
      </div>
      <p className="weekly-overview-hint">
        Select a day to see its shifts and details.
      </p>
      <div id={`${id}-content`} className="weekly-content">
        {children}
      </div>
    </div>
  );
}
