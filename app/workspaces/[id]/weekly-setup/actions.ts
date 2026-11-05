"use server";
import { requireWorkspace } from "@/lib/auth";
import { revalidatePath } from "next/cache";
export async function saveWeeklySetup(
  org: string,
  items: unknown,
  revision: number,
  week: string,
) {
  const { db } = await requireWorkspace(org, ["owner", "manager"]);
  const { error } = await db.rpc("save_weekly_setup", {
    org,
    items,
    expected_revision: revision,
  });
  if (error)
    return {
      ok: false,
      error: error.message.startsWith("Stale revision")
        ? "These settings changed. Refresh before saving."
        : "Unable to save. Choose valid days, times and staffing counts (maximum 300 slots per week).",
    };
  // Opening the first calendar creates its draft once. Existing weeks are never regenerated.
  const { data: existing, error: lookupError } = await db
    .from("schedules")
    .select("id")
    .eq("organization_id", org)
    .eq("week_start", week)
    .maybeSingle();
  let draftError = !!lookupError;
  if (!existing && !lookupError) {
    const result = await db.rpc("schedule_command", {
      org,
      command: "create",
      payload: { week_start: week },
      expected_revision: null,
    });
    draftError =
      !!result.error &&
      !result.error.message.startsWith("A draft already exists");
  }
  revalidatePath(`/workspaces/${org}/weekly-setup`);
  revalidatePath(`/workspaces/${org}/schedule`);
  return {
    ok: true,
    error: draftError
      ? "Weekly settings saved. The draft could not be created; open the calendar to review dates and try again."
      : "",
  };
}
