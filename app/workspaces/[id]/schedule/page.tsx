import Link from "next/link";
import { Frame } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import { addDays, validWeek, weekBounds } from "@/lib/scheduling/time";
import type { Member, Schedule, Shift } from "@/lib/scheduling/types";
import { ScheduleEditor } from "./editor";
import { WeekNavigation } from "@/lib/scheduling/week-navigation";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { id } = await params;
  const { db } = await requireWorkspace(id, ["owner", "manager"]);
  const { data: org, error: orgError } = await db
    .from("organizations")
    .select("name,timezone,settings")
    .eq("id", id)
    .single();
  if (orgError || !org) throw Error("Unable to load workspace");
  const requested = (await searchParams).week;
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
  ] = await Promise.all([
    db
      .from("schedules")
      .select("*,shifts(*)")
      .eq("organization_id", id)
      .eq("week_start", week)
      .maybeSingle(),
    db
      .from("memberships")
      .select("user_id,role,profiles(display_name)")
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
  ]);
  if (
    [draftError, rosterError, positionError, templateError, settingsError].some(
      Boolean,
    )
  )
    throw Error(
      "Unable to load scheduling data. Check the Phase 2 migration and retry.",
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
    id: m.user_id,
    role: m.role,
    name:
      (m.profiles as unknown as { display_name: string })?.display_name ||
      `Team member ${m.user_id.slice(0, 6)}`,
  }));
  return (
    <Frame>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{org.name} · MANAGER SCHEDULE</p>
          <h1>Plan a smoother week</h1>
          <p className="subtitle">
            Private drafts. Clear shifts. Publish when you’re ready.
          </p>
        </div>
        <div className="schedule-tools">
          <Link className="button secondary" href={`/workspaces/${id}`}>
            Workspace
          </Link>
          <Link
            className="button secondary"
            href={`/workspaces/${id}/my-schedule?week=${week}&view=team`}
          >
            Published team view
          </Link>
        </div>
      </div>
      <WeekNavigation id={id} week={week} />
      <ScheduleEditor
        key={`${id}:${week}`}
        orgId={id}
        week={week}
        timezone={timezone}
        schedule={draft as Schedule | null}
        members={members}
        positions={positions || []}
        templates={templates || []}
        settings={settings}
        carryIn={carryIn}
        peers={peers}
      />
    </Frame>
  );
}
