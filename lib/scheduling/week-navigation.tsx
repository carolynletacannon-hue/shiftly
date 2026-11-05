import Link from "next/link";
import { addDays } from "./time";
export function WeekNavigation({
  id,
  week,
  employee = false,
  view = "mine",
  todayWeek,
}: {
  id: string;
  week: string;
  employee?: boolean;
  view?: string;
  todayWeek?: string;
}) {
  const base = `/workspaces/${id}/${employee ? "my-schedule" : "schedule"}`;
  return (
    <nav className="week-picker" aria-label="Schedule week">
      <Link
        className="button secondary"
        href={`${base}?week=${addDays(week, -7)}&view=${view}`}
      >
        ← Previous
      </Link>
      {todayWeek && week !== todayWeek && (
        <Link className="button secondary" href={`${base}?week=${todayWeek}&view=${view}`}>
          Today
        </Link>
      )}
      <form key={week} action={base}>
        <label>
          Week containing
          <input type="date" name="week" defaultValue={week} required />
        </label>
        {employee && <input type="hidden" name="view" value={view} />}
        <button className="button secondary">Go</button>
      </form>
      <Link
        className="button secondary"
        href={`${base}?week=${addDays(week, 7)}&view=${view}`}
      >
        Next →
      </Link>
    </nav>
  );
}
