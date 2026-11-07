import Link from "next/link";
import { redirect } from "next/navigation";
import { Frame, Message } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import { validWeek, shiftLabel } from "@/lib/scheduling/time";
import { workplaceMilestones } from "@/lib/onboarding";
import { OnboardingChecklist } from "./onboarding-checklist";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; invited?: string }>;
}) {
  const { id } = await params;
  const { db, user, role } = await requireWorkspace(id);
  const manager = ["owner", "manager"].includes(role);
  const query = await searchParams;
  // Keep existing manager action feedback and one-time invitation links intact.
  if (manager && (query.message || query.invited))
    redirect(
      `/workspaces/${id}/admin?${new URLSearchParams(query as Record<string, string>)}`,
    );
  const { data: org, error } = await db
    .from("organizations")
    .select("name,timezone,settings")
    .eq("id", id)
    .single();
  if (error || !org)
    throw Error("Unable to load your workplace. Please try again.");
  const base = `/workspaces/${id}`;
  let content;
  if (manager) {
    const week = validWeek(
      undefined,
      org.timezone,
      org.settings.week_starts_on ?? 0,
    );
    const [
      employees,
      schedules,
      published,
      current,
      timeOff,
      requests,
      nextDraft,
    ] = await Promise.all([
      db
        .from("employees")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", id)
        .is("archived_at", null),
      db
        .from("schedules")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", id),
      db
        .from("published_schedules")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", id),
      db
        .from("schedules")
        .select("revision,published_revision")
        .eq("organization_id", id)
        .eq("week_start", week)
        .maybeSingle(),
      db
        .from("time_off_requests")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", id)
        .eq("status", "pending"),
      db
        .from("shift_requests")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", id)
        .eq("status", "pending"),
      db
        .from("schedules")
        .select("week_start")
        .eq("organization_id", id)
        .is("published_revision", null)
        .gte("week_start", week)
        .order("week_start")
        .limit(1),
    ]);
    if (
      [
        employees,
        schedules,
        published,
        current,
        timeOff,
        requests,
        nextDraft,
      ].some((r) => r.error)
    )
      throw Error("Unable to load your dashboard. Please try again.");
    const status = !current.data
      ? "No draft yet"
      : !current.data.published_revision
        ? "Draft · not published"
        : current.data.revision === current.data.published_revision
          ? "Published"
          : "Unpublished changes";
    content = (
      <>
        <div className="dashboard-grid">
          <section className="panel dashboard-card">
            <h2>This week’s schedule</h2>
            <strong>{status}</strong>
            <p>
              Week of {week} · {org.timezone}
            </p>
            <Link href={`${base}/schedule`}>Open schedule →</Link>
            {nextDraft.data?.[0] && (
              <p>
                Next unpublished week:{" "}
                <Link
                  href={`${base}/schedule?week=${nextDraft.data[0].week_start}`}
                >
                  {nextDraft.data[0].week_start}
                </Link>
              </p>
            )}
          </section>
          <section className="panel dashboard-card">
            <h2>Time-off requests</h2>
            <strong className="metric">{timeOff.count}</strong>
            <p>
              {timeOff.count ? "Waiting for review" : "You’re all caught up."}
            </p>
            <Link href={`${base}/time-off`}>Review time off →</Link>
          </section>
          <section className="panel dashboard-card">
            <h2>Shift approvals</h2>
            <strong className="metric">{requests.count}</strong>
            <p>
              {requests.count
                ? "Waiting for manager review"
                : "No pending approvals."}
            </p>
            <Link href={`${base}/shift-requests`}>View shift requests →</Link>
          </section>
          <section className="panel dashboard-card">
            <h2>Your team</h2>
            <strong className="metric">{employees.count}</strong>
            <p>Active employees</p>
            <Link href={`${base}/employees`}>Manage employees →</Link>
          </section>
        </div>
        <OnboardingChecklist
          workspace={id}
          userId={user.id}
          steps={workplaceMilestones(id, {
            timezone: org.timezone,
            employees: employees.count || 0,
            schedules: schedules.count || 0,
            published: published.count || 0,
          })}
        />
      </>
    );
  } else {
    const employee = await db
      .from("employees")
      .select("id")
      .eq("organization_id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (employee.error) throw Error("Unable to load your employee profile.");
    const employeeId =
      employee.data?.id || "00000000-0000-0000-0000-000000000000";
    const [nextShift, timeOff, notifications] = await Promise.all([
      db
        .from("published_shifts")
        .select("starts_at,ends_at,position_name,published_schedules(timezone)")
        .eq("organization_id", id)
        .eq("employee_id", employeeId)
        .gt("ends_at", new Date().toISOString())
        .order("starts_at")
        .limit(1),
      db
        .from("time_off_requests")
        .select("id,status,start_date,end_date")
        .eq("organization_id", id)
        .eq("employee_id", employeeId)
        .order("created_at", { ascending: false })
        .limit(3),
      db
        .from("shift_notifications")
        .select("id,message")
        .eq("organization_id", id)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(3),
    ]);
    if ([nextShift, timeOff, notifications].some((r) => r.error))
      throw Error("Unable to load your dashboard. Please try again.");
    const shift = nextShift.data?.[0];
    const shiftTimezone =
      (shift?.published_schedules as unknown as { timezone: string } | null)
        ?.timezone || org.timezone;
    content = (
      <>
        <section className="panel dashboard-card">
          <h2>Welcome to your team</h2>
          <p>
            Your published shifts and requests live here. Draft schedules stay
            with your manager until they’re ready.
          </p>
          <div className="calendar-actions">
            <Link className="button primary" href={`${base}/my-schedule`}>
              My Schedule
            </Link>
            <Link className="button secondary" href={`${base}/time-off`}>
              Time Off
            </Link>
            <Link className="button secondary" href={`${base}/shift-requests`}>
              Shift Requests
            </Link>
            <Link className="button secondary" href={`${base}/notifications`}>
              Notifications
            </Link>
            <Link
              className="button secondary"
              href={`${base}/my-schedule#calendar-integration`}
            >
              Calendar Integration
            </Link>
          </div>
        </section>
        <div className="dashboard-grid">
          <section className="panel dashboard-card">
            <h2>Your next published shift</h2>
            {shift ? (
              <>
                <strong>
                  {new Intl.DateTimeFormat("en-US", {
                    dateStyle: "full",
                    timeZone: shiftTimezone,
                  }).format(new Date(shift.starts_at))}
                </strong>
                <p>
                  {shiftLabel(shift.starts_at, shift.ends_at, shiftTimezone)} ·{" "}
                  {shiftTimezone}
                </p>
                <p>{shift.position_name}</p>
              </>
            ) : (
              <p>
                No upcoming published shifts yet. Your manager will publish the
                schedule when it’s ready.
              </p>
            )}
          </section>
          <section className="panel dashboard-card">
            <h2>Your recent time off</h2>
            {timeOff.data?.length ? (
              <ul>
                {timeOff.data.map((r) => (
                  <li key={r.id}>
                    {r.start_date} – {r.end_date}: {r.status}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No requests yet. Use Time Off when you need a day away.</p>
            )}
          </section>
          <section className="panel dashboard-card">
            <h2>Recent updates</h2>
            {notifications.data?.length ? (
              <ul>
                {notifications.data.map((n) => (
                  <li key={n.id}>{n.message}</li>
                ))}
              </ul>
            ) : (
              <p>
                You’re all caught up. Schedule changes and request decisions
                will appear here.
              </p>
            )}
            <Link href={`${base}/shift-requests`}>
              See coverage and swap opportunities →
            </Link>
          </section>
        </div>
      </>
    );
  }
  return (
    <Frame workspace={{ id, role, name: org.name }}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{org.name}</p>
          <h1>
            {manager
              ? "A little clarity for your week"
              : "Your week at Meadowmark"}
          </h1>
          <p className="subtitle">
            {manager
              ? "Your team, your schedule, and the next steps in one place."
              : "See what’s coming up and stay connected with your team."}
          </p>
        </div>
        {manager && (
          <Link className="button primary" href={`${base}/schedule`}>
            Create or edit schedule
          </Link>
        )}
      </div>
      <Message text={query.message} />
      {content}
    </Frame>
  );
}
