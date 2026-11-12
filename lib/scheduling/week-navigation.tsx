import { ButtonLink, Button } from "@/app/ui/button";
import { DatePicker } from "@/app/ui/date-picker";
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
      <ButtonLink
        className="button secondary"
        href={`${base}?week=${addDays(week, -7)}&view=${view}`}
      >
        ← Previous
      </ButtonLink>
      {todayWeek && week !== todayWeek && (
        <ButtonLink className="button secondary" href={`${base}?week=${todayWeek}&view=${view}`}>
          Today
        </ButtonLink>
      )}
      <form key={week} action={base}>
        <label>
          Week containing
          <DatePicker name="week" defaultValue={week} required />
        </label>
        {employee && <input type="hidden" name="view" value={view} />}
        <Button className="button secondary">Go</Button>
      </form>
      <ButtonLink
        className="button secondary"
        href={`${base}?week=${addDays(week, 7)}&view=${view}`}
      >
        Next →
      </ButtonLink>
    </nav>
  );
}
