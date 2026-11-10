"use server";
import { Temporal } from "@js-temporal/polyfill";
import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { requirePayroll } from "@/lib/payroll/feature";
import { parseRate, workweekAnchor, type Settings } from "@/lib/payroll/engine";
import { loadPayroll } from "@/lib/payroll/server";
import { clockService } from "@/lib/time-clock/server";
export async function payrollAction(form: FormData) {
  requirePayroll();
  const id = String(form.get("org"));
  const { db, user } = await requireWorkspace(id, ["owner", "manager"]);
  const command = String(form.get("command"));
  const value = (key: string) => String(form.get(key) || "");
  let message = "Saved.";
  try {
    const payload: Record<string, unknown> = { reason: value("reason") };
    if (command === "approve") {
      const { input, report } = await loadPayroll(id, value("date"), true);
      const token = createHash("sha256")
        .update(JSON.stringify({ input, report }))
        .digest("hex");
      if (value("review_token") !== token)
        throw Error("Sources changed. Refresh and review again.");
      if (report.warnings.length || !report.rows.length)
        throw Error("Resolve all exceptions before approval.");
      const result = await clockService().rpc("payroll_approve", {
        org: id,
        actor: user.id,
        expected: input,
        report,
        why: value("reason"),
      });
      if (result.error) throw Error(result.error.message);
      message = "Approved for export. No wages have been paid.";
    } else {
      if (command === "settings") {
        for (const key of [
          "frequency",
          "anchor",
          "timezone",
          "workweek_day",
          "workweek_time",
          "rule",
        ])
          payload[key] = value(key);
        payload.employee_access = form.get("employee_access") === "on";
        workweekAnchor({
          ...payload,
          workweek_day: Number(payload.workweek_day),
        } as Settings);
        const anchor = Temporal.PlainDate.from(value("anchor"));
        if (value("frequency") === "semimonthly" && anchor.day > 15)
          throw Error("Semimonthly anchor must use days 1–15.");
        Temporal.PlainTime.from(value("workweek_time"));
      } else if (command === "rate") {
        const s = await db
          .from("payroll_settings")
          .select("timezone")
          .eq("organization_id", id)
          .single();
        if (s.error) throw Error("Save payroll settings first.");
        payload.employee_id = value("employee_id");
        payload.cents = parseRate(value("rate"));
        payload.classification = value("classification");
        payload.effective_at = Temporal.PlainDateTime.from(
          value("effective_at"),
        )
          .toZonedDateTime(s.data.timezone, { disambiguation: "reject" })
          .toInstant()
          .toString();
      } else if (command === "reopen") payload.report_id = value("report_id");
      else throw Error("Unknown command");
      const result = await db.rpc("payroll_manage", {
        org: id,
        command,
        payload,
      });
      if (result.error) throw Error(result.error.message);
    }
  } catch (error) {
    message = error instanceof Error ? error.message : "Payroll action failed.";
  }
  redirect(
    `/workspaces/${id}/payroll?date=${encodeURIComponent(value("date"))}&message=${encodeURIComponent(message)}`,
  );
}
