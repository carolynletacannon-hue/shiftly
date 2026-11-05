export type EmailMessage = { to: string; subject: string; html: string; text: string };
export type EmailResult = { status: "accepted" } | { status: "unconfigured" | "failed" };

// Providers must confirm acceptance for the intended recipient, not just return
// a locally generated message ID. Never expose raw transport errors to callers.
export interface EmailProvider {
  send(message: EmailMessage, deliveryKey: string): Promise<EmailResult>;
}
