import "server-only";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "../email/service";
import { timeOffEmail } from "../email/time-off";
import type { EmailResult } from "../email/types";

type Delivery = {
  id: string;
  email: string;
  event: string;
  organization_id: string;
};
type Worker = {
  claim: (requestId: string) => Promise<Delivery[]>;
  finish: (id: string, status: EmailResult["status"]) => Promise<void>;
};
export async function deliverTimeOffEmails(
  requestId: string,
  worker: Worker | null = createWorker(),
  send = sendEmail,
): Promise<boolean> {
  if (!worker) return false;
  try {
    const origin = new URL(process.env.NEXT_PUBLIC_SITE_URL || "");
    if (
      origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "localhost")
    )
      return false;
    const deliveries = await worker.claim(requestId);
    const results = await Promise.all(
      deliveries.map(async (delivery) => {
        let status: EmailResult["status"] = "failed";
        try {
          const url = new URL(
            `/workspaces/${delivery.organization_id}/time-off`,
            origin.origin,
          ).href;
          status = (
            await send(
              { to: delivery.email, ...timeOffEmail(delivery.event, url) },
              delivery.id,
            )
          ).status;
        } catch {
          /* Never expose SMTP details or roll back the saved decision. */
        }
        await worker.finish(delivery.id, status);
        return status === "accepted";
      }),
    );
    return results.every(Boolean);
  } catch {
    return false;
  }
}
function createWorker(): Worker | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!key || !url) return null;
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async claim(requestId) {
      const { data, error } = await db.rpc("claim_time_off_email", {
        request: requestId,
      });
      if (error) throw Error("Unable to claim notifications");
      return data as Delivery[];
    },
    async finish(id, status) {
      const { error } = await db.rpc("finish_time_off_email", {
        notification: id,
        result: status,
      });
      if (error) throw Error("Unable to record notification result");
    },
  };
}
