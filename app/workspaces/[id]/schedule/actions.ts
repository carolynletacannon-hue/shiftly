"use server";
import { requireWorkspace } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import {
  addDays,
  copyTimes,
  localToInstant,
  type TimeChoice,
} from "@/lib/scheduling/time";
import type { Shift } from "@/lib/scheduling/types";
const commands = [
  "create",
  "save",
  "slot_save",
  "assign",
  "delete",
  "publish",
  "template_save",
  "template_delete",
  "settings",
  "position",
  "requirement_save",
  "requirement_delete",
];
export async function scheduleAction(
  orgId: string,
  command: string,
  input: Record<string, string>,
  revision: number | null,
) {
  const { db } = await requireWorkspace(orgId, ["owner", "manager"]);
  if (!commands.includes(command))
    return { ok: false, error: "Unknown scheduling action." };
  try {
    let payload: Record<string, unknown> = { ...input };
    const choice: TimeChoice =
      input.time_choice === "earlier" || input.time_choice === "later"
        ? input.time_choice
        : "reject";
    if (command === "save" || command === "slot_save") {
      const { data: schedule, error } = await db
        .from("schedules")
        .select("timezone")
        .eq("organization_id", orgId)
        .eq("id", input.schedule_id)
        .single();
      if (error || !schedule) throw Error("Schedule unavailable");
      try {
        payload.starts_at = localToInstant(
          input.start_local,
          schedule.timezone,
          input.start_choice === "earlier" || input.start_choice === "later"
            ? input.start_choice
            : "reject",
        );
        payload.ends_at = localToInstant(
          input.end_local,
          schedule.timezone,
          input.end_choice === "earlier" || input.end_choice === "later"
            ? input.end_choice
            : "reject",
        );
      } catch {
        return {
          ok: false,
          error:
            "Check the local dates and times. Skipped DST times are invalid; for a repeated hour, choose the earlier or later occurrence explicitly.",
        };
      }
    }
    if (command === "create") {
      // Copy wall-clock times, not fixed UTC durations, so overnight shifts keep
      // their local start/end times when crossing a DST transition.
      payload = { week_start: input.week_start };
      if (input.copy_previous === "yes") {
        const previous = addDays(input.week_start, -7);
        const { data: published, error: publishedError } = await db
          .from("published_schedules")
          .select("*,published_shifts(*)")
          .eq("organization_id", orgId)
          .eq("week_start", previous)
          .maybeSingle();
        if (publishedError) throw Error("Unable to load the previous week");
        const { data: draft, error: draftError } = published
          ? { data: null, error: null }
          : await db
              .from("schedules")
              .select("*,shifts(*)")
              .eq("organization_id", orgId)
              .eq("week_start", previous)
              .maybeSingle();
        if (draftError || (!published && !draft))
          return {
            ok: false,
            error:
              "No schedule exists in the previous week. Create an empty draft instead.",
          };
        const [{ data: org }, { data: positions }] = await Promise.all([
          db.from("organizations").select("timezone").eq("id", orgId).single(),
          db.from("positions").select("id,name").eq("organization_id", orgId),
        ]);
        if (!org || !positions) throw Error("Unable to load workspace");
        const source = published || draft;
        try {
          payload.slots = (
            (published?.published_shifts || draft?.shifts || []) as Shift[]
          ).map((s) => ({
            employee_id: s.employee_id,
            position_id: published
              ? positions.find((p) => p.name === s.position_name)?.id || null
              : s.position_id,
            notes: s.notes,
            label: s.label || s.position_name || "Custom shift",
            requirement_id: s.requirement_id || null,
            template_id: s.template_id || null,
            slot_ordinal: s.slot_ordinal || 1,
            is_required: !!s.is_required,
            ...copyTimes(
              s,
              previous,
              input.week_start,
              source.timezone,
              org.timezone,
              choice,
            ),
          }));
        } catch {
          return {
            ok: false,
            error:
              "A copied shift falls in a skipped or repeated DST hour. Review the previous week or choose a repeated-hour option. Nothing was copied.",
          };
        }
      }
    }
    if (command === "template_save")
      payload.end_next_day = input.end_next_day === "on";
    if (command === "requirement_save")
      payload.is_active = input.is_active === "on" || !input.id;
    const { error } = await db.rpc("schedule_command", {
      org: orgId,
      command,
      payload,
      expected_revision: revision,
    });
    if (error) {
      const safe = [
        "Stale revision",
        "Approved time off",
        "Employee has overlapping",
        "Shift must start",
        "No unpublished changes",
        "Schedule unavailable",
        "Template unavailable",
        "Coverage requirement unavailable",
        "A draft already exists",
        "Choose the workspace week start",
        "Weekly shift limit reached",
        "Assigned employee",
        "Unfilled required slots",
        "Required slots cannot",
        "Required slot structure",
        "A required slot falls",
        "Choose an employee",
      ];
      return {
        ok: false,
        error: safe.some((s) => error.message.startsWith(s))
          ? error.message
          : error.code === "23505"
            ? "That name or week already exists. Refresh and try again."
            : error.code === "23503"
              ? "Choose a template, employee, and position from this workspace. Remove linked coverage requirements before deleting a template."
              : error.code === "23514"
                ? "Check the shift times. End must follow start; overnight shifts must end the next day, within 24 local hours."
                : "Unable to save. Check your permissions and fields, then refresh before retrying.",
      };
    }
    revalidatePath(`/workspaces/${orgId}/schedule`);
    revalidatePath(`/workspaces/${orgId}/my-schedule`);
    return { ok: true, error: "" };
  } catch {
    return {
      ok: false,
      error:
        "Unable to save. Check the values and refresh before retrying. Your published schedule is unchanged unless publication completed.",
    };
  }
}
