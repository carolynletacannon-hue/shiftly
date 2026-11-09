import { requireWorkspace } from "@/lib/auth";
import { requireTimeClock } from "@/lib/time-clock/feature";
import {
  csv,
  dateBounds,
  durations,
  type Timecard,
} from "@/lib/time-clock/records";
import { localDate } from "@/lib/scheduling/time";
export const dynamic = "force-dynamic";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  requireTimeClock();
  const { id } = await params;
  const { db } = await requireWorkspace(id, ["owner", "manager"]);
  const query = new URL(req.url).searchParams;
  const { data: org, error } = await db
    .from("organizations")
    .select("timezone")
    .eq("id", id)
    .single();
  if (error || !org)
    return new Response("Workplace unavailable", { status: 503 });
  let bounds;
  try {
    bounds = dateBounds(
      query.get("from") || "",
      query.get("to") || "",
      org.timezone,
    );
  } catch {
    return new Response("Choose a valid date range of up to 366 days", {
      status: 400,
    });
  }
  let q = db
    .from("time_sessions")
    .select("*,time_breaks(starts_at,ends_at)")
    .eq("organization_id", id)
    .lt("clock_in", bounds.end)
    .or(`clock_out.is.null,clock_out.gt.${bounds.start}`)
    .order("clock_in")
    .limit(1001);
  const employee = query.get("employee");
  if (employee) q = q.eq("employee_id", employee);
  const [sessions, employees] = await Promise.all([
    q,
    db.from("employees").select("id,display_name").eq("organization_id", id),
  ]);
  if (sessions.error || employees.error)
    return new Response("Export unavailable", { status: 503 });
  // Never silently return a partial export at the API's configured row cap.
  if ((sessions.data?.length || 0) >= 1000)
    return new Response("Narrow the date range; record limit exceeded.", {
      status: 422,
    });
  const ids = (sessions.data || []).map((s) => s.id);
  const audit = ids.length
    ? await db
        .from("time_audit")
        .select("session_id,action,reason,created_at")
        .eq("organization_id", id)
        .in("session_id", ids)
        .in("action", ["correct", "void"])
        .limit(1000)
    : { data: [], error: null };
  if (audit.error) return new Response("Export unavailable", { status: 503 });
  if (audit.data?.length === 1000)
    return new Response(
      "Narrow the date range; correction history limit exceeded.",
      { status: 422 },
    );
  const now = new Date().toISOString();
  const rows: unknown[][] = [
    [
      "Employee",
      "Work date (session start)",
      "Clock in UTC",
      "Clock out UTC",
      "Workplace timezone",
      "Unpaid break seconds in range",
      "Paid hours in range (unrounded)",
      "Approval status",
      "Corrections",
      "Session ID",
      "Range start UTC",
      "Range end UTC",
    ],
  ];
  for (const card of (sessions.data || []) as Timecard[]) {
    const d = durations(card, bounds.start, bounds.end, now);
    rows.push([
      employees.data?.find((e) => e.id === card.employee_id)?.display_name ||
        "Employee",
      localDate(card.clock_in, org.timezone),
      card.clock_in,
      card.clock_out,
      org.timezone,
      d.unpaidSeconds,
      d.paidHours,
      card.voided_at
        ? "Voided"
        : card.approved_at
          ? "Approved"
          : card.clock_out
            ? "Unapproved"
            : "Open / provisional",
      audit.data
        ?.filter((a) => a.session_id === card.id)
        .map((a) => `${a.created_at}: ${a.reason}`)
        .join("; "),
      card.id,
      bounds.start,
      bounds.end,
    ]);
  }
  return new Response(csv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="meadowmark-time-records.csv"',
      "Cache-Control": "private, no-store",
    },
  });
}
