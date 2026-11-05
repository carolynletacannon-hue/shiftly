"use server";
import { requireWorkspace } from "@/lib/auth";
import { revalidatePath } from "next/cache";
export async function saveWeeklySetup(org: string, items: unknown, revision: number, week: string, applyToWeek = true) {
  const { db } = await requireWorkspace(org, ["owner", "manager"]);
  const { error } = await db.rpc("save_weekly_setup", {
    org, items, expected_revision: revision, apply_week: applyToWeek ? week : null,
  });
  if (error) return { ok: false, error: error.message.startsWith("Stale revision")
    ? "These settings changed. Refresh before saving." : error.message };
  revalidatePath(`/workspaces/${org}/weekly-setup`);
  revalidatePath(`/workspaces/${org}/schedule`);
  return { ok: true, error: "" };
}
