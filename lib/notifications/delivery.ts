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
  const groups = new Map<string, PreparedDelivery[]>();
  for (const item of await worker.claim()) {
    try {
      const prepared = await worker.prepare(item);
      if (!prepared) continue;
      const key = `${item.organization_id}:${item.user_id}`;
      groups.set(key, [...(groups.get(key) || []), prepared]);
    } catch {
      /* Other recipients can still receive their updates. */
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
      if (result.status === "accepted")
        for (const item of items) await worker.finish(item);
    } catch {
      /* Expiring database leases allow bounded recovery. */
    }
  }
}
