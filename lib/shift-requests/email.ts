import "server-only";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/service";
import { deliverNotificationBatch } from "@/lib/notifications/delivery";
// Shared existing outbox; feature flag never affects invitations or password mail.
export async function deliverShiftEmails() {
  if (process.env.PHASE7_EMAIL_ENABLED !== "true") return;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (
    !url ||
    !key ||
    !process.env.GMAIL_USER ||
    !process.env.GMAIL_APP_PASSWORD
  )
    return;
  let origin: URL;
  try {
    origin = new URL(process.env.NEXT_PUBLIC_SITE_URL || "");
    if (
      origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "localhost")
    )
      return;
  } catch {
    return;
  }
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await deliverNotificationBatch(
    {
      async claim() {
        const { data, error } = await db.rpc("claim_shift_emails");
        if (error) throw Error("Unable to claim notification emails");
        return data || [];
      },
      async prepare(item) {
        const { data: eligible, error } = await db.rpc(
          "notification_email_eligible",
          { notification: item.id, token: item.claim_token },
        );
        if (error || !eligible) return null;
        const {
          data: { user },
          error: userError,
        } = await db.auth.admin.getUserById(item.user_id);
        if (userError || !user?.email || !user.email_confirmed_at) return null;
        const { data: notification } = await db
          .from("shift_notifications")
          .select("href")
          .eq("id", item.id)
          .single();
        const href = notification?.href?.startsWith(
          `/workspaces/${item.organization_id}/`,
        )
          ? notification.href
          : `/workspaces/${item.organization_id}/notifications`;
        return {
          ...item,
          email: user.email,
          url: new URL(href, origin.origin).href,
        };
      },
      async finish(item) {
        const { error } = await db
          .from("shift_email_deliveries")
          .update({ sent_at: new Date().toISOString() })
          .eq("id", item.id)
          .eq("claim_token", item.claim_token)
          .is("sent_at", null);
        if (error) throw Error("Unable to acknowledge notification email");
      },
    },
    sendEmail,
  );
}
