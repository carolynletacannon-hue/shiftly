import Link from "next/link";
import { Frame } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import { ScheduleCalendar } from "@/lib/scheduling/calendar";
import {
  addDays,
  hoursInWeek,
  shiftLabel,
  validWeek,
  weekBounds,
} from "@/lib/scheduling/time";
import type { Member, Shift } from "@/lib/scheduling/types";
import { WeekNavigation } from "@/lib/scheduling/week-navigation";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ week?: string; view?: string }>;
}) {
  const { id } = await params;
  const { db, user, role } = await requireWorkspace(id);
  const { data: alerts, error: alertError } = await db.from("time_off_notifications").select("event")
    .eq("organization_id", id).eq("recipient_id", user.id).in("event", ["approved", "denied"])
    .order("created_at", { ascending: false }).limit(1);
  if (alertError) throw Error("Unable to load time-off notifications");
  const query = await searchParams;
  const team = query.view === "team";
  const { data: org, error } = await db
    .from("organizations")
    .select("name,timezone,settings")
    .eq("id", id)
    .single();
  if (error || !org) throw Error("Unable to load workspace");
  let week = validWeek(
    query.week,
    org.timezone,
    org.settings.week_starts_on ?? 0,
  );
  if (
    query.week &&
    /^\d{4}-\d{2}-\d{2}$/.test(query.week) &&
    query.week !== week
  ) {
    const { data: saved } = await db
      .from("published_schedules")
      .select("week_start")
      .eq("organization_id", id)
      .eq("week_start", query.week)
      .maybeSingle();
    if (saved) week = saved.week_start;
  }
  const [
    { data: publication, error: publicationError },
    { data: roster, error: rosterError },
  ] = await Promise.all([
    db
      .from("published_schedules")
      .select("*,published_shifts(*)")
      .eq("organization_id", id)
      .eq("week_start", week)
      .maybeSingle(),
    db
      .from("employees")
      .select("id,user_id,display_name")
      .eq("organization_id", id),
  ]);
  if (publicationError || rosterError)
    throw Error("Unable to load published schedule");
  const employeeId = roster?.find(m => m.user_id === user.id)?.id;
  const timezone = publication?.timezone || org.timezone;
  const bounds = weekBounds(week, timezone);
  const [
    { data: carry, error: carryError },
    { data: upcoming, error: upcomingError },
  ] = await Promise.all([
    db
      .from("published_shifts")
      .select("*")
      .eq("organization_id", id)
      .lt("starts_at", bounds.start)
      .gt("ends_at", bounds.start),
    db
      .from("published_shifts")
      .select("*,published_schedules(timezone)")
      .eq("organization_id", id)
      .eq("employee_id", employeeId || "00000000-0000-0000-0000-000000000000")
      .gt("ends_at", new Date().toISOString())
      .order("starts_at")
      .limit(30),
  ]);
  if (carryError || upcomingError)
    throw Error("Unable to load published shifts");
  const all = (publication?.published_shifts || []) as Shift[];
  const shifts = team ? all : all.filter((s) => s.employee_id === employeeId);
  const carryIn = ((carry || []) as Shift[]).filter(
    (s) => team || s.employee_id === employeeId,
  );
  const members: Member[] = (roster || [])
    .filter((m) => team || m.user_id === user.id)
    .map((m) => ({
      id: m.id,
      role: "employee",
      name:
        m.display_name,
    }));
  return (
    <Frame>
      {!!alerts?.length && <p className="notice" role="status">Your most recent time-off decision: {alerts[0].event}. <Link href={`/workspaces/${id}/time-off`}>View request</Link></p>}
      <div className="page-heading">
        <div>
          <p className="eyebrow">{org.name} · PUBLISHED SHIFTS</p>
          <h1>{team ? "Team schedule" : "My Schedule"}</h1>
          <p className="subtitle">
            {timezone} · Your team’s latest published version
          </p>
        </div>
        <div className="schedule-tools">
          <Link className="button secondary" href={`/workspaces/${id}/time-off`}>Time off & availability</Link>
          <Link className="button secondary" href={`/workspaces/${id}`}>
            Workspace
          </Link>
          {role !== "employee" && (
            <Link
              className="button secondary"
              href={`/workspaces/${id}/schedule?week=${week}`}
            >
              Manage schedule
            </Link>
          )}
        </div>
      </div>
      <nav className="schedule-tabs" aria-label="Published schedule view">
        <Link
          aria-current={!team ? "page" : undefined}
          href={`?week=${week}&view=mine`}
        >
          My Schedule
        </Link>
        <Link
          aria-current={team ? "page" : undefined}
          href={`?week=${week}&view=team`}
        >
          Team schedule
        </Link>
      </nav>
      <WeekNavigation
        id={id}
        week={week}
        employee
        view={team ? "team" : "mine"}
      />
      <section className="panel workspace-card">
        <div className="schedule-toolbar">
          <div>
            <span className="schedule-badge live">
              Published schedules only
            </span>
            {publication && (
              <p className="muted">
                Revision {publication.revision} · Published{" "}
                {new Intl.DateTimeFormat("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: timezone,
                }).format(new Date(publication.published_at))}
              </p>
            )}
          </div>
          <strong>
            {hoursInWeek(
              [...all, ...(carry || [])].filter(
                (s) => s.employee_id === employeeId,
              ),
              week,
              timezone,
            ).toFixed(1)}{" "}
            h · your weekly total
          </strong>
        </div>
        {!publication && (
          <div className="schedule-empty">
            <h2>No schedule published for this week</h2>
            <p>
              Your manager will publish the schedule when it’s ready. Draft
              changes are private.
            </p>
          </div>
        )}
        {publication && !shifts.length && (
          <p className="muted">
            {team
              ? "The published week has no shifts."
              : "You have no shifts starting this week."}
          </p>
        )}
        {(publication || carryIn.length > 0) && (
          <ScheduleCalendar
            shifts={shifts}
            members={members}
            week={week}
            timezone={timezone}
            carryIn={carryIn}
            warning={168}
          />
        )}
      </section>
      {!team && (
        <section className="panel workspace-card upcoming-shifts">
          <h2>Your upcoming shifts</h2>
          {!upcoming?.length ? (
            <p className="muted">
              No upcoming published shifts yet. Check back after your manager
              publishes.
            </p>
          ) : (
            <div className="workspace-grid">
              {(
                upcoming as (Shift & {
                  published_schedules: { timezone: string };
                })[]
              ).map((s) => (
                <article className="template-card" key={s.id}>
                  <p className="eyebrow">
                    {new Intl.DateTimeFormat("en-US", {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      timeZone: s.published_schedules?.timezone || timezone,
                    }).format(new Date(s.starts_at))}
                  </p>
                  <strong>
                    {shiftLabel(
                      s.starts_at,
                      s.ends_at,
                      s.published_schedules?.timezone || timezone,
                    )}
                  </strong>
                  <p>{s.position_name}</p>
                  {s.notes && <p>{s.notes}</p>}
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      <p className="hint">
        Hours use actual elapsed time, including daylight-saving changes, and
        split overnight shifts at the local week boundary. Shifts appear on the
        day they start.
      </p>
    </Frame>
  );
}
