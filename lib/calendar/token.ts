import "server-only";
import { createHash, randomBytes } from "node:crypto";
export const validCalendarToken = (value: string) =>
  /^[A-Za-z0-9_-]{43}$/.test(value);
export const calendarTokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const newCalendarToken = () => randomBytes(32).toString("base64url");
export function calendarOrigin() {
  const url = new URL(process.env.NEXT_PUBLIC_SITE_URL || "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Calendar origin unavailable");
  return url.origin;
}

/** Enable only after migration and hosting log-redaction checks in the runbook. */
export function calendarEnabled() {
  return (
    process.env.CALENDAR_FEEDS_ENABLED === "true" &&
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
