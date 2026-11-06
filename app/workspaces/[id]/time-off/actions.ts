"use server";
import { requireWorkspace } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { localToInstant, type TimeChoice } from "@/lib/scheduling/time";
import { deliverTimeOffEmails } from "@/lib/time-off/notifications";

export async function timeOffAction(
  org: string,
  command: string,
  input: Record<string, unknown>,
) {
  const { db } = await requireWorkspace(
    org,
    ["manual", "approve", "deny", "remove_manual"].includes(command)
      ? ["owner", "manager"]
      : undefined,
  );
  if (
    ![
      "submit",
      "manual",
      "approve",
      "deny",
      "cancel",
      "availability",
      "remove_manual",
    ].includes(command)
  )
    return { ok: false, message: "Unknown action." };
  const payload = { ...input };
  if (["submit", "manual"].includes(command) && !payload.full_day) {
    const { data: business, error } = await db
      .from("organizations")
      .select("timezone")
      .eq("id", org)
      .single();
    if (error || !business)
      return { ok: false, message: "Unable to load workspace." };
    try {
      for (const boundary of ["start", "end"]) {
        const choice = input[`${boundary}_choice`];
        payload[`${boundary}s_at`] = localToInstant(
          `${input[`${boundary}_date`]}T${input[`${boundary}_time`]}`,
          business.timezone,
          (choice === "earlier" || choice === "later"
            ? choice
            : "reject") as TimeChoice,
        );
      }
    } catch {
      return {
        ok: false,
        message:
          "Check the times. Skipped daylight-saving hours are invalid; choose earlier or later for a repeated hour.",
      };
    }
  }
  const { data, error } = await db.rpc("time_off_command", {
    org,
    command,
    payload,
  });
  if (error) {
    const safe = [
      "Time-off permission denied",
      "Employee unavailable",
      "Manual time off",
      "Manage only your own",
      "Request unavailable",
      "Request already reviewed",
      "Partial-day dates",
      "Invalid availability",
    ];
    return {
      ok: false,
      message: safe.some((s) => error.message.startsWith(s))
        ? error.message
        : "Unable to save. Check the dates and times, then refresh and try again.",
    };
  }
  // The transaction has committed. Notification failure must never change ok.
  let emailOk = true;
  if (["submit", "approve", "deny"].includes(command)) {
    try {
      emailOk = await deliverTimeOffEmails(data.id);
    } catch {
      emailOk = false;
    }
  }
  for (const route of ["time-off", "schedule", "my-schedule"])
    revalidatePath(`/workspaces/${org}/${route}`);
  return {
    ok: true,
    message: `Saved.${emailOk ? "" : " Email could not be confirmed. The notification is available in Shiftly."}`,
  };
}
