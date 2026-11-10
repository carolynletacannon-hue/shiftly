"use server";
import { requireWorkspace } from "@/lib/auth";
import { requireTimeClock } from "@/lib/time-clock/feature";
import {
  digest,
  hashPin,
  kioskCookie,
  kioskCookieMaxAge,
  newPin,
  pinLookup,
  token,
} from "@/lib/time-clock/security";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { localToInstant } from "@/lib/scheduling/time";
export type Result = {
  message?: string;
  pin?: string;
  error?: string;
  activated?: boolean;
};
export async function clockAction(_: Result, form: FormData): Promise<Result> {
  requireTimeClock();
  const org = String(form.get("organization_id") || ""),
    command = String(form.get("command") || "");
  const { db } = await requireWorkspace(
    org,
    command === "request"
      ? ["owner", "manager", "employee"]
      : ["owner", "manager"],
  );
  let payload: Record<string, unknown> = {};
  const field = (key: string) => String(form.get(key) || "");
  let revealed: string | undefined, deviceSecret: string | undefined;
  try {
    if (command === "settings")
      payload = {
        enabled: form.has("enabled"),
        require_breaks: form.has("require_breaks"),
      };
    else if (command === "enroll") {
      deviceSecret = token();
      payload = { name: field("name"), token_hash: digest(deviceSecret) };
    } else if (command === "pin") {
      revealed = newPin();
      payload = {
        employee_id: field("employee_id"),
        lookup_hash: pinLookup(org, revealed),
        pin_hash: hashPin(revealed),
      };
    } else if (command === "revoke") payload = { kiosk_id: field("kiosk_id") };
    else if (command === "request")
      payload = { session_id: field("session_id"), reason: field("reason") };
    else if (command === "approve" || command === "void")
      payload = {
        session_id: field("session_id"),
        revision: Number(field("revision")),
        reason: field("reason"),
      };
    else if (command === "review")
      payload = {
        request_id: field("request_id"),
        decision: field("decision"),
        reason: field("reason"),
      };
    else if (command === "correct") {
      const { data: workspace, error } = await db
        .from("organizations")
        .select("timezone")
        .eq("id", org)
        .single();
      if (error || !workspace)
        throw Error("Unable to load workplace time zone");
      const instant = (value: string, choice?: string) =>
        value
          ? localToInstant(
              value,
              workspace.timezone,
              choice === "later"
                ? "later"
                : choice === "earlier"
                  ? "earlier"
                  : "reject",
            )
          : null;
      const breaks = JSON.parse(field("breaks") || "[]");
      if (!Array.isArray(breaks) || breaks.length > 30)
        throw Error("Provide a JSON array of recorded breaks");
      payload = {
        session_id: field("session_id"),
        employee_id: field("employee_id"),
        revision: Number(field("revision")),
        reason: field("reason"),
        clock_in: instant(field("clock_in"), field("clock_in_choice")),
        clock_out: instant(field("clock_out"), field("clock_out_choice")),
        breaks: breaks.map((b) => ({
          starts_at: instant(b.starts_at, b.starts_at_choice),
          ends_at: instant(b.ends_at || "", b.ends_at_choice),
        })),
        ...(field("request_id") ? { request_id: field("request_id") } : {}),
      };
    } else return { error: "Unknown action" };
    const { error } = await db.rpc("time_clock_manage", {
      org,
      command,
      payload,
    });
    if (error)
      return {
        error:
          command === "pin" && error.code === "23505"
            ? "PIN collision. Generate again."
            : error.message,
      };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : "Unable to save. Please retry.",
    };
  }
  if (deviceSecret) {
    // Fail closed: do not enter kiosk mode unless the manager refresh session is revoked.
    const { error } = await db.auth.signOut({ scope: "local" });
    if (error)
      return {
        error: "Sign-out failed. Revoke this enrollment and try again.",
      };
    const jar = await cookies();
    for (const cookie of jar.getAll())
      if (cookie.name.startsWith("sb-")) jar.delete(cookie.name);
    jar.set(kioskCookie, deviceSecret, {
      secure: true,
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: kioskCookieMaxAge,
    });
    return { activated: true };
  }
  revalidatePath(`/workspaces/${org}/time-clock`);
  return {
    message: revealed
      ? "Store this PIN securely. It will disappear in 30 seconds and cannot be retrieved."
      : "Saved.",
    ...(revealed ? { pin: revealed } : {}),
  };
}
