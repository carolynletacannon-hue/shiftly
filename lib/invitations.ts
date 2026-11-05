import "server-only";
import { randomBytes, createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { invitationEmail } from "./email/invitation";
import { sendEmail, type EmailResult } from "./email/service";

export function invitationUrl(token: string, siteUrl = process.env.NEXT_PUBLIC_SITE_URL) {
  if (!siteUrl) return null;
  try {
    const origin = new URL(siteUrl);
    if (origin.username || origin.password ||
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && origin.hostname === "localhost"))) return null;
    return new URL(`/invite?token=${token}`, origin.origin).toString();
  } catch { return null; }
}

export async function issueInvitation(db: SupabaseClient, input: {
  organizationId: string; email: string; role: string; replaces?: string;
}, deliver = sendEmail) {
  const { data: org, error: orgError } = await db.from("organizations")
    .select("name").eq("id", input.organizationId).single();
  if (orgError || !org) throw new Error("Unable to load workspace");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("Invalid email");
  const token = randomBytes(32).toString("hex");
  const { data: invitationId, error } = await db.rpc("issue_invitation", {
    org: input.organizationId, invite_email: email, invite_role: input.role,
    token_digest: createHash("sha256").update(token).digest("hex"),
    replaces: input.replaces ?? null,
  });
  if (error || !invitationId) {
    // Use only our known database error, never reflect raw database messages.
    throw new Error(error?.message === "Invitation rate limit exceeded" ? "rate-limit" : "Unable to create invitation");
  }
  const url = invitationUrl(token);
  let delivery: EmailResult = { status: "unconfigured" };
  if (url) {
    try {
      delivery = await deliver({ to: email, ...invitationEmail({
        businessName: org.name, role: input.role, invitationUrl: url,
      }) }, `invitation/${invitationId}`);
    } catch { delivery = { status: "failed" }; }
  }
  return { token, invitationId: String(invitationId), delivery: delivery.status };
}
