export type EmailEnvironment = Record<string, string | undefined>;

/** Use deployment configuration only, never a request Host header or preview URL. */
export function notificationEmailConfig(env: EmailEnvironment = process.env) {
  if (env.PHASE7_EMAIL_ENABLED !== "true")
    return { ok: false as const, reason: "disabled" };
  // Preview and local builds must never drain the production queue.
  if (env.VERCEL_ENV !== "production")
    return { ok: false as const, reason: "non_production" };
  const missing = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GMAIL_USER",
    "GMAIL_APP_PASSWORD",
  ].filter((key) => !env[key]?.trim());
  if (missing.length)
    return { ok: false as const, reason: "missing_configuration", missing };
  if (!/^[a-z0-9._%+-]+@(gmail|googlemail)\.com$/i.test(env.GMAIL_USER!.trim()))
    return { ok: false as const, reason: "invalid_gmail_configuration" };
  try {
    const configured = env.NEXT_PUBLIC_SITE_URL?.trim();
    const origin = new URL(
      configured || `https://${env.VERCEL_PROJECT_PRODUCTION_URL || ""}`,
    );
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.hostname === "localhost"
    )
      throw Error("Invalid origin");
    return { ok: true as const, origin: origin.origin };
  } catch {
    return { ok: false as const, reason: "invalid_site_url" };
  }
}
