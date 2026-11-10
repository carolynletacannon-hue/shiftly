import { NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { requirePayroll } from "@/lib/payroll/feature";
import { exportReport, type Report } from "@/lib/payroll/engine";
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  requirePayroll();
  const { id } = await params;
  const { db } = await requireWorkspace(id, ["owner", "manager"]);
  const report = request.nextUrl.searchParams.get("report");
  if (!report || !/^[a-f0-9-]{36}$/i.test(report))
    return new Response("Choose an approved report", { status: 400 });
  const { data, error } = await db
    .from("payroll_reports")
    .select("snapshot,version")
    .eq("organization_id", id)
    .eq("id", report)
    .single();
  if (error || !data)
    return new Response("Report unavailable", { status: 404 });
  const events = await db
    .from("payroll_events")
    .select("id")
    .eq("organization_id", id)
    .eq("report_id", report)
    .eq("action", "reopen")
    .limit(1);
  if (events.error)
    return new Response("Unable to verify report status", { status: 503 });
  return new Response(
    exportReport(
      data.snapshot as Report,
      `${events.data?.length ? "Historical approved snapshot — reopened" : "Approved preparation snapshot"} v${data.version}; no payment confirmed`,
    ),
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="payroll-preparation-v${data.version}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
