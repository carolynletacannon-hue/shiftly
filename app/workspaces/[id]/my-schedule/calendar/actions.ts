"use server";
import { requireWorkspace } from "@/lib/auth";
import {
  calendarEnabled,
  calendarOrigin,
  calendarTokenHash,
  newCalendarToken,
} from "@/lib/calendar/token";
export async function calendarAction(
  org: string,
  command: "status" | "rotate" | "revoke",
): Promise<{ active?: boolean; url?: string; error?: string }> {
  const { db } = await requireWorkspace(org);
  try {
    if (command === "rotate" && !calendarEnabled())
      return {
        error: "Calendar integration is unavailable. Contact your manager.",
      };
    // Validate configuration before changing anything. Raw URLs exist only in this response.
    const origin = command === "rotate" ? calendarOrigin() : "";
    const token = command === "rotate" ? newCalendarToken() : null;
    const { data, error } = await db.rpc("manage_calendar_subscription", {
      org,
      command,
      token_digest: token ? calendarTokenHash(token) : null,
    });
    if (error || !data)
      return {
        error:
          "Unable to update calendar integration. Try again or contact your manager.",
      };
    return {
      active: data.active,
      ...(token ? { url: `${origin}/api/calendar?token=${token}` } : {}),
    };
  } catch {
    return {
      error:
        "Calendar integration is unavailable. Try again or contact your manager.",
    };
  }
}
