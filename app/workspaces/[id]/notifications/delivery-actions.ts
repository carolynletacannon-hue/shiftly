"use server";
import { randomUUID } from "node:crypto";
import { requireWorkspace } from "@/lib/auth";
import { notificationEmailConfig } from "@/lib/notifications/config";
import { sendEmail } from "@/lib/email/service";
import { deliverShiftEmails } from "@/lib/shift-requests/email";

export async function runEmailDiagnostic(org: string) {
  const { user } = await requireWorkspace(org, ["owner", "manager"]);
  const config = notificationEmailConfig();
  if (!config.ok) {
    console.warn("[notification-email] diagnostic_blocked", config);
    return `Email delivery unavailable: ${config.reason}. Check the server configuration.`;
  }
  // Recipient is always the authenticated manager, never client input.
  if (!user.email || !user.email_confirmed_at)
    return "Verify your account email before sending a diagnostic.";
  console.info("[notification-email] diagnostic_started");
  const result = await sendEmail(
    {
      to: user.email,
      subject: "Meadowmark email delivery test",
      text: "This is a Meadowmark email delivery test. No employee notifications were processed.",
      html: "<p>This is a Meadowmark email delivery test. No employee notifications were processed.</p>",
    },
    randomUUID(),
  );
  console.info("[notification-email] diagnostic_completed", {
    status: result.status,
  });
  return result.status === "accepted"
    ? "Gmail accepted your test email. Check your inbox and spam folder."
    : `Test email ${result.status}. Check notification-email server logs.`;
}

export async function retryNotificationEmails(org: string) {
  await requireWorkspace(org, ["owner", "manager"]);
  // The scoped RPC filters BEFORE claiming; no attempts/leases in other workspaces change.
  const result = await deliverShiftEmails(org);
  if (!result.ok)
    return `Email delivery unavailable: ${result.reason}. Check notification-email server logs.`;
  return `Claimed ${result.claimed}; Gmail accepted ${result.accepted} email(s); acknowledged ${result.acknowledged} notification(s); suppressed ${result.suppressed}; failures ${result.failed + result.preparationFailed + result.acknowledgementFailed}. Active leases, sent, skipped, expired and exhausted notifications are never reset.`;
}
