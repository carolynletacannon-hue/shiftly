import "server-only";
import { Resend } from "resend";

export type EmailMessage = { to: string; subject: string; html: string; text: string };
export type EmailResult = { status: "accepted" } | { status: "unconfigured" | "failed" };
type Transport = Pick<Resend, "emails">;

// Server-only reusable entry point. Never return provider errors: they can contain
// message contents, private links, or configuration details.
export async function sendEmail(
  message: EmailMessage,
  idempotencyKey: string,
  options: {
    apiKey?: string;
    from?: string;
    transport?: Transport;
  } = { apiKey: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM_EMAIL },
): Promise<EmailResult> {
  if (!options.apiKey?.trim() || !options.from?.trim()) return { status: "unconfigured" };
  try {
    const client = options.transport ?? new Resend(options.apiKey);
    const { data, error } = await client.emails.send(
      { ...message, from: options.from },
      { idempotencyKey },
    );
    return !error && data?.id ? { status: "accepted" } : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}
