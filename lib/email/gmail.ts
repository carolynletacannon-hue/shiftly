import "server-only";
import nodemailer, { type SendMailOptions, type SMTPTransportOptions, type SMTPSentMessageInfo } from "nodemailer";
import type { EmailMessage, EmailProvider } from "./types";

type GmailTransport = {
  sendMail(message: SendMailOptions): Promise<SMTPSentMessageInfo>;
  close(): void;
};
export type GmailTransportFactory = (options: SMTPTransportOptions) => GmailTransport;
type GmailConfig = { user?: string; appPassword?: string };

export function createGmailProvider(
  config: GmailConfig = { user: process.env.GMAIL_USER, appPassword: process.env.GMAIL_APP_PASSWORD },
  createTransport: GmailTransportFactory = options => nodemailer.createTransport(options),
): EmailProvider | null {
  const user = config.user?.trim().toLowerCase();
  // Google displays app passwords in groups; permit those formatting spaces.
  const password = config.appPassword?.replace(/\s/g, "");
  if (!user || !/^[a-z0-9._%+-]+@(gmail|googlemail)\.com$/.test(user) || !password) return null;
  return {
    async send(message: EmailMessage) {
      let transport: GmailTransport | undefined;
      try {
        transport = createTransport({
          host: "smtp.gmail.com",
          port: 465,
          secure: true, // Implicit TLS from the start; never fall back to plaintext.
          auth: { user, pass: password },
          tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: "smtp.gmail.com" },
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 15_000,
          pool: false,
          logger: false,
          debug: false,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        const result = await transport.sendMail({
          ...message,
          from: { name: "Meadowmark", address: user },
          // Restrict the envelope to exactly this employee and the Gmail account.
          envelope: { from: user, to: [message.to] },
        });
        const accepted = result.accepted?.some(address =>
          address.toLowerCase() === message.to.toLowerCase(),
        );
        return accepted && !result.rejected?.length && /^250(?:[ -]|$)/.test(result.response ?? "")
          ? { status: "accepted" } : { status: "failed" };
      } catch {
        // SMTP errors may contain credentials, message contents or private links.
        // Authentication, TLS, timeout and quota errors all keep the manual link.
        return { status: "failed" };
      } finally {
        try { transport?.close(); } catch { /* Cleanup must not change acceptance. */ }
      }
    },
  };
}
