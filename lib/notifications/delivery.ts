import { notificationEmail } from "./email";
import type { EmailMessage, EmailResult } from "../email/types";
export type NotificationDelivery = {
  id: string;
  user_id: string;
  organization_id: string;
  message: string;
  claim_token: string;
};
type PreparedDelivery = NotificationDelivery & { email: string; url: string };
export type NotificationWorker = {
  claim(): Promise<NotificationDelivery[]>;
  prepare(item: NotificationDelivery): Promise<PreparedDelivery | null>;
  finish(item: NotificationDelivery): Promise<void>;
};
/** One email per recipient/workplace in each bounded claim batch. */
export async function deliverNotificationBatch(
  worker: NotificationWorker,
  send: (message: EmailMessage, key: string) => Promise<EmailResult>,
) {
  const outcomes = {
    claimed: 0,
    suppressed: 0,
    preparationFailed: 0,
    accepted: 0,
    failed: 0,
    acknowledged: 0,
    acknowledgementFailed: 0,
  };
  const groups = new Map<string, PreparedDelivery[]>();
  const claimed = await worker.claim();
  outcomes.claimed = claimed.length;
  for (const item of claimed) {
    try {
      const prepared = await worker.prepare(item);
      if (!prepared) {
        outcomes.suppressed++;
        continue;
      }
      const key = `${item.organization_id}:${item.user_id}`;
      groups.set(key, [...(groups.get(key) || []), prepared]);
    } catch {
      outcomes.preparationFailed++;
      console.error("[notification-email] preparation_failed");
    }
  }
  for (const items of groups.values()) {
    try {
      const first = items[0];
      const url =
        items.length === 1
          ? first.url
          : new URL(
              `/workspaces/${first.organization_id}/notifications`,
              first.url,
            ).href;
      const result = await send(
        {
          to: first.email,
          ...notificationEmail(
            items.map((item) => item.message).join("\n\n"),
            url,
          ),
        },
        items
          .map((item) => item.id)
          .sort()
          .join(":"),
      );
      console.info("[notification-email] delivery_outcome", {
        status: result.status,
        notifications: items.length,
      });
      if (result.status === "accepted") {
        outcomes.accepted++;
        for (const item of items) {
          try {
            await worker.finish(item);
            outcomes.acknowledged++;
          } catch {
            outcomes.acknowledgementFailed++;
            console.error("[notification-email] acknowledgement_failed");
          }
        }
      } else outcomes.failed++;
    } catch {
      outcomes.failed++;
      console.error("[notification-email] delivery_failed");
    }
  }
  return outcomes;
}
