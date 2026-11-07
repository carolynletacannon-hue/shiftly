import "server-only";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/service";
import { deliverNotificationBatch } from "@/lib/notifications/delivery";
import { notificationEmailConfig } from "@/lib/notifications/config";
export async function deliverShiftEmails(organization?: string) {
  console.info("[notification-email] worker_started");
  const config = notificationEmailConfig();
  if (!config.ok) {
    console.warn("[notification-email] worker_blocked", config);
    return { ok: false as const, reason: config.reason };
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  try {
    const db = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const outcomes = await deliverNotificationBatch(
      {
        async claim() {
          const { data, error } = await db.rpc(
            organization
              ? "claim_workspace_notification_emails"
              : "claim_shift_emails",
            organization ? { workspace: organization } : {},
          );
          if (error) {
            console.error("[notification-email] claim_failed", {
              code: /^[A-Z0-9]{5,12}$/.test(error.code)
                ? error.code
                : "unknown",
            });
            throw Error("Unable to claim notification emails");
          }
          console.info("[notification-email] queue_claimed", {
            count: data?.length || 0,
          });
          return data || [];
        },
        async prepare(item) {
          const { data: eligible, error } = await db.rpc(
            "notification_email_eligible",
            { notification: item.id, token: item.claim_token },
          );
          if (error) throw Error("Eligibility check failed");
          if (!eligible) return null;
          const {
            data: { user },
            error: userError,
          } = await db.auth.admin.getUserById(item.user_id);
          if (userError) throw Error("Recipient lookup failed");
          if (!user?.email || !user.email_confirmed_at) return null;
          const { data: notification, error: notificationError } = await db
            .from("shift_notifications")
            .select("href")
            .eq("id", item.id)
            .single();
          if (notificationError) throw Error("Notification lookup failed");
          const href = notification?.href?.startsWith(
            `/workspaces/${item.organization_id}/`,
          )
            ? notification.href
            : `/workspaces/${item.organization_id}/notifications`;
          return {
            ...item,
            email: user.email,
            url: new URL(href, config.origin).href,
          };
        },
        async finish(item) {
          const { data, error } = await db
            .from("shift_email_deliveries")
            .update({ sent_at: new Date().toISOString() })
            .eq("id", item.id)
            .eq("claim_token", item.claim_token)
            .is("sent_at", null)
            .select("id");
          if (error || data?.length !== 1)
            throw Error("Unable to acknowledge notification email");
        },
      },
      sendEmail,
    );
    console.info("[notification-email] worker_completed", outcomes);
    return { ok: true as const, ...outcomes };
  } catch {
    console.error("[notification-email] worker_failed");
    return { ok: false as const, reason: "worker_failed" };
  }
}
