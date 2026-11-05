import Link from "next/link";
import { Frame } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import { addDays, validWeek, weekBounds } from "@/lib/scheduling/time";
import type {
  CoverageRequirement,
  Member,
  Schedule,
  Shift,
} from "@/lib/scheduling/types";
import { ScheduleEditor } from "./editor";
import { WeekNavigation } from "@/lib/scheduling/week-navigation";
export async function SchedulingPage({
  params,
  searchParams,
  advanced = false,
}: {
  advanced?: boolean;
  params: Promise<{ id: string }>;
  searchParams: Promise<{ week?: string; setupSaved?: string }>;
}) {
  const { id } = await params;
  const { db } = await requireWorkspace(id, ["owner", "manager"]);
  const { data: org, error: orgError } = await db
    .from("organizations")
    .select("name,timezone,settings")
    .eq("id", id)
    .single();
  if (orgError || !org) throw Error("Unable to load workspace");
  const { week: requested, setupSaved } = await searchParams;
  let week = validWeek(
    requested,
    org.timezone,
    org.settings.week_starts_on ?? 0,
  );
  // Preserve links to saved historical weeks if the workspace later changes its week start.
  if (
    requested &&
    /^\d{4}-\d{2}-\d{2}$/.test(requested) &&
    requested !== week
  ) {
    const { data: saved } = await db
      .from("schedules")
      .select("week_start")
      .eq("organization_id", id)
      .eq("week_start", requested)
      .maybeSingle();
    if (saved) week = saved.week_start;
  }
  const [
    { data: draft, error: draftError },
    { data: roster, error: rosterError },
    { data: positions, error: positionError },
    { data: templates, error: templateError },
    { data: settings, error: settingsError },
    { data: requirements, error: requirementError },
  ] = await Promise.all([
    db
      .from("schedules")
      .select("*,shifts(*)")
      .eq("organization_id", id)
      .eq("week_start", week)
      .maybeSingle(),
    db
      .from("employees")
      .select("id,display_name,user_id")
      .eq("organization_id", id),
    db
      .from("positions")
      .select("id,name")
      .eq("organization_id", id)
      .order("name"),
    db
      .from("shift_templates")
      .select("*")
      .eq("organization_id", id)
      .order("start_time"),
    db
      .from("schedule_settings")
      .select("weekly_hours_warning,revision")
      .eq("organization_id", id)
      .maybeSingle(),
    db
      .from("coverage_requirements")
      .select("*")
      .eq("organization_id", id)
      .order("weekday"),
  ]);
  if (
    [
      draftError,
      rosterError,
      positionError,
      templateError,
      settingsError,
      requirementError,
    ].some(Boolean)
  )
    throw Error(
      "Unable to load scheduling data. Check the Phase 2 and coverage migrations, then retry.",
    );
  const timezone = draft?.timezone || org.timezone;
  const bounds = weekBounds(week, timezone);
  const peerEnd = weekBounds(addDays(week, 1), timezone).end;
  const [
    { data: otherDrafts, error: peerError },
    { data: published, error: publishedError },
  ] = await Promise.all([
    db
      .from("shifts")
      .select("*")
      .eq("organization_id", id)
      .lt("starts_at", peerEnd)
      .gt("ends_at", bounds.start),
    db
      .from("published_shifts")
      .select("*")
      .eq("organization_id", id)
      .lt("starts_at", peerEnd)
      .gt("ends_at", bounds.start),
  ]);
  if (peerError || publishedError)
    throw Error("Unable to check adjacent shifts");
  const peers = [...(otherDrafts || []), ...(published || [])].filter(
    (s) => s.schedule_id !== draft?.id,
  ) as Shift[];
  const carryPublished = (published || []).filter(
    (s) => Date.parse(s.starts_at) < Date.parse(bounds.start),
  );
  const publishedSchedules = new Set(carryPublished.map((s) => s.schedule_id));
  const carryIn = [
    ...carryPublished,
    ...(otherDrafts || []).filter(
      (s) =>
        Date.parse(s.starts_at) < Date.parse(bounds.start) &&
        !publishedSchedules.has(s.schedule_id),
    ),
  ] as Shift[];
  const members: Member[] = (roster || []).map((m) => ({
    id: m.id,
    role: "employee",
    name:
      m.display_name,
  }));
  return (
    <Frame>
      {setupSaved && <p className="notice" role="status">{setupSaved === "applied" ? "Weekly setup saved. This week’s shifts are ready for assignment." : "Weekly setup saved for future weeks. This week is unchanged."}</p>}
      <div className="page-heading">
        <div>
          <p className="eyebrow">{org.name} · MANAGER SCHEDULE</p>
          <h1>{advanced ? "Advanced scheduling settings" : "Weekly schedule"}</h1>
          <p className="subtitle">
            See what the week needs, fill open slots, then publish when it’s ready.
          </p>
        </div>
        <div className="schedule-tools">
          <Link className="button secondary" href={`/workspaces/${id}/weekly-setup`}>Set Up Weekly Schedule</Link>
          <Link className="button secondary" href={`/workspaces/${id}/schedule${advanced ? "" : "/settings"}`}>{advanced ? "Weekly calendar" : "Advanced settings"}</Link>
          <Link className="button secondary" href={`/workspaces/${id}/employees`}>
            Employees
          </Link>
          <Link
            className="button secondary"
            href={`/workspaces/${id}/my-schedule?week=${week}&view=team`}
          >
            Published team view
          </Link>
        </div>
      </div>
      <WeekNavigation
        id={id}
        week={week}
        todayWeek={validWeek(
          undefined,
          org.timezone,
          org.settings.week_starts_on ?? 0,
        )}
      />
      <ScheduleEditor
        key={`${id}:${week}`}
        advanced={advanced}
        orgId={id}
        week={week}
        timezone={timezone}
        schedule={draft as Schedule | null}
        members={members}
        positions={positions || []}
        templates={templates || []}
        requirements={(requirements || []) as CoverageRequirement[]}
        settings={settings}
        firstDay={org.settings.week_starts_on ?? 0}
        carryIn={carryIn}
        peers={peers}
      />
    </Frame>
  );
}


export default SchedulingPage;
