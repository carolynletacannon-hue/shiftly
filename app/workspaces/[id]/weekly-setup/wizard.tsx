"use client";
import { Checkbox } from "@/app/ui/checkbox";
import { Card, PageHeader } from "@/app/ui/surfaces";
import { Button } from "@/app/ui/button";
import { Select } from "@/app/ui/select";
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
  const [applyToWeek, setApplyToWeek] = useState(true);
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
          const result = await saveWeeklySetup(org, rows, revision, week, applyToWeek);
          if (!result.ok || result.error) {
            setError(result.error);
            return;
          }
          router.push(`/workspaces/${org}/schedule?week=${week}&setupSaved=${applyToWeek ? "applied" : "future"}`);
          router.refresh();
        });
      }}
    >
      <fieldset disabled={pending}>
        {rows.map((r, index) => (
          <Card className="panel workspace-card" key={r.key}>
            <PageHeader className="page-heading">
              <h2>{r.name || `Shift ${index + 1}`}</h2>
              <Button
                type="button"
                className="button secondary"
                onClick={() => setRows(rows.filter((row) => row.key !== r.key))}
              >
                Remove shift
              </Button>
            </PageHeader>
            <label>
              Shift template
              <Select
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
              </Select>
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
                  <Checkbox
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
              <Button
                type="button"
                className="button secondary"
                onClick={() => update(r.key, { days: [0, 1, 2, 3, 4, 5, 6] })}
              >
                Every day
              </Button>
              {weekdays.map((name, day) => (
                <label className="check-label" key={name}>
                  <Checkbox
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
          </Card>
        ))}
        <Button
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
        </Button>
        <Card className="panel workspace-card">
          <h2>{count} shift slots each week</h2>
          <label>Apply setup
            <Select value={applyToWeek ? "current" : "future"} onChange={(e) => setApplyToWeek(e.target.value === "current")}>
              <option value="current">Apply to this week</option>
              <option value="future">Future weeks only</option>
            </Select>
          </label>
          <p>
            Future weekly drafts will include these shifts automatically. Applying to this week preserves assignments. Published weeks require future weeks only.
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
          <Button
            className="button primary"
            disabled={rows.some((r) => !r.days.length) || count > 300}
          >
            {pending ? "Saving…" : "Save & open calendar"}
          </Button>
        </Card>
      </fieldset>
    </form>
  );
}
