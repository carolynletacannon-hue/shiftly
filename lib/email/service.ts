import "server-only";
import { createGmailProvider } from "./gmail";
import type { EmailMessage, EmailProvider, EmailResult } from "./types";
export type { EmailMessage, EmailProvider, EmailResult } from "./types";

// Invitation code is independent of the provider. Future transactional providers
// can implement EmailProvider and be selected here without changing invitations.
export async function sendEmail(
  message: EmailMessage,
  deliveryKey: string,
  provider: EmailProvider | null = createGmailProvider(),
): Promise<EmailResult> {
  if (!provider) return { status: "unconfigured" };
  try {
    return await provider.send(message, deliveryKey);
  } catch {
    return { status: "failed" };
  }
}
