"use server";
import { requireWorkspace } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { availabilityWarning } from "@/lib/time-off/conflicts";
import type { CopyPreview } from "@/lib/scheduling/copy-types";
export async function copyWeekAction(orgId: string, input: {
  source: string; destination: string; mode: string; strategy: string; token?: string;
}): Promise<{ preview?: CopyPreview; error?: string; copied?: boolean }> {
  const { db } = await requireWorkspace(orgId, ["owner", "manager"]);
  try {
    const { data, error } = await db.rpc("copy_schedule_week", {
      org: orgId, source_week: input.source, destination_week: input.destination,
      copy_mode: input.mode, strategy: input.strategy, preview_token: input.token || null,
    });
    if (error) return { error: /^(Copy blocked:|Stale revision|Employee has overlapping|Assigned employee|Shift must start|Approved time off|Archived employees|This shift does not permit)/.test(error.message)
      ? error.message : error.code === "23505"
      ? "Some destination slots have incompatible staffing requirements. Use Replace draft after reviewing the preview, or align the shifts first."
      : "Unable to copy. Refresh and check your permissions and migration setup, then preview again. Nothing was copied." };
    if (input.token) revalidatePath(`/workspaces/${orgId}/schedule`);
    const preview = data as CopyPreview;
    for (const shift of preview.shifts) {
      if (availabilityWarning(shift, preview.availability, preview.availability_timezone))
        preview.warnings.push({ message: "Availability warning: review employee availability", employee_id: shift.employee_id || undefined, label: shift.label });
    }
    return { preview, copied: !!input.token };
  } catch { return { error: "Unable to copy. Refresh and preview again before retrying." }; }
}
