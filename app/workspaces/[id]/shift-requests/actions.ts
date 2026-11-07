"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/auth";
import { scheduleNotificationEmails } from "@/lib/notifications/trigger";
export async function requestAction(form: FormData) {
  const id = String(form.get("organization_id") || "");
  const { db } = await requireWorkspace(id);
  const command = String(form.get("command") || "");
  const payload = Object.fromEntries(
    [...form.entries()]
      .filter(([key]) => !["organization_id", "command"].includes(key))
      .map(([k, v]) => [k, String(v)]),
  );
  const { error } = await db.rpc("shift_request_command", {
    org: id,
    command,
    payload,
  });
  if (!error)
    scheduleNotificationEmails(id);
  revalidatePath(`/workspaces/${id}`, "layout");
  redirect(
    `/workspaces/${id}/shift-requests?message=${encodeURIComponent(error ? error.message : "Saved. Check the request status below.")}`,
  );
}
