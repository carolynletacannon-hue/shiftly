"use server";
import { requireWorkspace } from "@/lib/auth";
import {
  preferenceDefaults,
  type Preferences,
} from "@/lib/notifications/preferences";
import { revalidatePath } from "next/cache";
export async function savePreferences(org: string, preferences: Preferences) {
  const { db, user } = await requireWorkspace(org);
  const values = Object.fromEntries(
    Object.keys(preferenceDefaults).map((key) => [
      key,
      preferences[key as keyof Preferences] === true,
    ]),
  );
  // No scheduler is configured. Do not imply that an unavailable reminder works.
  values.reminder_24h = false;
  values.reminder_1h = false;
  const { data, error } = await db
    .from("notification_preferences")
    .upsert({ ...values, organization_id: org, user_id: user.id })
    .select("user_id")
    .single();
  if (error || !data)
    return {
      ok: false,
      message: "Unable to save preferences. Please try again.",
    };
  revalidatePath(`/workspaces/${org}/notifications`);
  return { ok: true, message: "Notification preferences saved." };
}
export async function markRead(org: string, notification?: string) {
  const { db, user } = await requireWorkspace(org);
  let query = db
    .from("shift_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("organization_id", org)
    .eq("user_id", user.id)
    .is("read_at", null);
  if (notification) query = query.eq("id", notification);
  const { error } = await query;
  if (error)
    return { ok: false, message: "Unable to mark notifications as read." };
  revalidatePath(`/workspaces/${org}/notifications`);
  return { ok: true, message: "Notifications marked as read." };
}
