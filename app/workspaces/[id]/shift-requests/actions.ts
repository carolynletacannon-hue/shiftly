"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/auth";
import { after } from "next/server";
import { deliverShiftEmails } from "@/lib/shift-requests/email";
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
    after(async () => {
      try {
        await deliverShiftEmails();
      } catch {}
    });
  revalidatePath(`/workspaces/${id}`, "layout");
  redirect(
    `/workspaces/${id}/shift-requests?message=${encodeURIComponent(error ? error.message : "Saved. Check the request status below.")}`,
  );
}
