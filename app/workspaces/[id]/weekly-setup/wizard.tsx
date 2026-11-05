"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  CoverageRequirement,
  ShiftTemplate,
} from "@/lib/scheduling/types";
import { saveWeeklySetup } from "./actions";
type Row = {
  key: string;
  template_id: string;
  name: string;
  start_time: string;
  end_time: string;
  end_next_day: boolean;
  days: number[];
  required_count: number;
  position_id: string | null;
};
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export function WeeklyWizard({
  org,
  templates,
  requirements,
  revision,
  week,
}: {
  org: string;
  templates: ShiftTemplate[];
  requirements: CoverageRequirement[];
  revision: number;
  week: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [rows, setRows] = useState<Row[]>(() => {
    const active = requirements.filter((r) => r.is_active);
    if (!active.length && revision > 0) return [];
    if (active.length) {
      const grouped: Row[] = [];
      for (const r of active) {
        const match = grouped.find(
          (g) =>
            g.template_id === r.template_id &&
            g.required_count === r.required_count &&
            g.position_id === r.position_id &&
            !g.days.includes(r.weekday),
        );
        if (match) {
          if (!match.days.includes(r.weekday)) match.days.push(r.weekday);
          continue;
        }
        const t = templates.find((t) => t.id === r.template_id)!;
        grouped.push({
          key: r.id,
          template_id: t.id,
          name: t.name,
          start_time: t.start_time.slice(0, 5),
          end_time: t.end_time.slice(0, 5),
          end_next_day: t.end_next_day,
          days: [r.weekday],
          required_count: r.required_count,
          position_id: r.position_id,
        });
      }
      return grouped;
    }
    return (
      templates.length
        ? templates
        : [
            {
              id: "",
              name: "Morning",
              start_time: "07:00",
              end_time: "15:00",
              end_next_day: false,
              position_id: null,
            },
            {
              id: "",
              name: "Evening",
              start_time: "15:00",
              end_time: "23:00",
              end_next_day: false,
              position_id: null,
            },
            {
              id: "",
              name: "Overnight",
              start_time: "23:00",
              end_time: "07:00",
              end_next_day: true,
              position_id: null,
            },
          ]
    ).map((t, i) => ({
      key: String(i),
      template_id: t.id,
      name: t.name,
      start_time: t.start_time.slice(0, 5),
      end_time: t.end_time.slice(0, 5),
      end_next_day: t.end_next_day,
      days: [0, 1, 2, 3, 4, 5, 6],
      required_count: 1,
      position_id: t.position_id,
    }));
  });
  function update(key: string, patch: Partial<Row>) {
    setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  const count = rows.reduce((n, r) => n + r.days.length * r.required_count, 0);
  return (
    <form
      className="weekly-wizard"
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        startTransition(async () => {
          const result = await saveWeeklySetup(org, rows, revision, week);
          if (!result.ok || result.error) {
            setError(result.error);
            router.refresh();
            return;
          }
          router.push(`/workspaces/${org}/schedule?week=${week}`);
          router.refresh();
        });
      }}
    >
      <fieldset disabled={pending}>
        {rows.map((r, index) => (
          <section className="panel workspace-card" key={r.key}>
            <div className="page-heading">
              <h2>{r.name || `Shift ${index + 1}`}</h2>
              <button
                type="button"
                className="button secondary"
                onClick={() => setRows(rows.filter((row) => row.key !== r.key))}
              >
                Remove shift
              </button>
            </div>
            <label>
              Shift template
              <select
                value={r.template_id}
                onChange={(e) => {
                  const t = templates.find((t) => t.id === e.target.value);
                  update(
                    r.key,
                    t
                      ? {
                          template_id: t.id,
                          name: t.name,
                          start_time: t.start_time.slice(0, 5),
                          end_time: t.end_time.slice(0, 5),
                          end_next_day: t.end_next_day,
                          position_id: t.position_id,
                        }
                      : { template_id: "", position_id: null },
                  );
                }}
              >
                <option value="">Custom times</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.start_time.slice(0, 5)}–
                    {t.end_time.slice(0, 5)}
                  </option>
                ))}
              </select>
            </label>
            {!r.template_id && (
              <div className="setup-times">
                <label>
                  Shift name
                  <input
                    value={r.name}
                    onChange={(e) => update(r.key, { name: e.target.value })}
                    required
                    maxLength={60}
                  />
                </label>
                <label>
                  Start
                  <input
                    type="time"
                    value={r.start_time}
                    onChange={(e) =>
                      update(r.key, { start_time: e.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  End
                  <input
                    type="time"
                    value={r.end_time}
                    onChange={(e) =>
                      update(r.key, { end_time: e.target.value })
                    }
                    required
                  />
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={r.end_next_day}
                    onChange={(e) =>
                      update(r.key, { end_next_day: e.target.checked })
                    }
                  />
                  Ends the next day
                </label>
              </div>
            )}
            <fieldset className="weekday-options">
              <legend>Which days?</legend>
              <button
                type="button"
                className="button secondary"
                onClick={() => update(r.key, { days: [0, 1, 2, 3, 4, 5, 6] })}
              >
                Every day
              </button>
              {weekdays.map((name, day) => (
                <label className="check-label" key={name}>
                  <input
                    type="checkbox"
                    checked={r.days.includes(day)}
                    onChange={(e) =>
                      update(r.key, {
                        days: e.target.checked
                          ? [...r.days, day]
                          : r.days.filter((d) => d !== day),
                      })
                    }
                  />
                  {name}
                </label>
              ))}
            </fieldset>
            <label>
              Employees needed per shift
              <input
                type="number"
                min={1}
                max={50}
                value={r.required_count}
                required
                onChange={(e) =>
                  update(r.key, { required_count: Number(e.target.value) })
                }
              />
            </label>
          </section>
        ))}
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            setRows([
              ...rows,
              {
                key: crypto.randomUUID(),
                template_id: "",
                name: "",
                start_time: "07:00",
                end_time: "15:00",
                end_next_day: false,
                days: [0, 1, 2, 3, 4, 5, 6],
                required_count: 1,
                position_id: null,
              },
            ])
          }
        >
          + Add another shift
        </button>
        <section className="panel workspace-card">
          <h2>{count} shift slots each week</h2>
          <p>
            Save once. Future weekly drafts will include these shifts
            automatically. Existing schedules keep their shifts and assignments.
          </p>
          {!rows.length && (
            <p>
              No recurring shifts will be generated. Existing weeks stay as they
              are.
            </p>
          )}
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary"
            disabled={rows.some((r) => !r.days.length) || count > 300}
          >
            {pending ? "Saving…" : "Save & open calendar"}
          </button>
        </section>
      </fieldset>
    </form>
  );
}
