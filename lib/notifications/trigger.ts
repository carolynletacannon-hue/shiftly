import "server-only";
import { after } from "next/server";
import { deliverShiftEmails } from "@/lib/shift-requests/email";

/** Register before redirect/response; Next after() retains Vercel's invocation. */
export function scheduleNotificationEmails(organization: string) {
  try {
    after(async () => {
      await deliverShiftEmails(organization);
    });
    console.info("[notification-email] worker_scheduled");
  } catch {
    // A committed business action must remain successful if registration fails.
    console.error("[notification-email] scheduling_failed");
  }
}
