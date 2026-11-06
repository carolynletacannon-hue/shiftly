import "server-only";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/service";
// Service credentials stay on the server. No recipient addresses cross the browser API.
export async function deliverShiftEmails() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (
    !url ||
    !key ||
    !process.env.GMAIL_USER ||
    !process.env.GMAIL_APP_PASSWORD
  )
    return;
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.rpc("claim_shift_emails");
  if (error || !data) return;
  for (const item of data as {
    id: string;
    user_id: string;
    message: string;
  }[]) {
    try {
      const {
        data: { user },
      } = await db.auth.admin.getUserById(item.user_id);
      const result = user?.email
        ? await sendEmail(
            {
              to: user.email,
              subject: "Shiftly shift request update",
              text:
                item.message + ". Open Shift Requests in Shiftly for details.",
              html: "<p>There is an update to your shift requests. Open Shift Requests in Shiftly for details.</p>",
            },
            item.id,
          )
        : { status: "failed" };
      if (result.status === "accepted")
        await db
          .from("shift_email_deliveries")
          .update({ sent_at: new Date().toISOString() })
          .eq("id", item.id);
    } catch {
      /* The durable queue retries without affecting schedule changes. */
    }
  }
}
