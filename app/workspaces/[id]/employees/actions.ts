"use server";
import { requireWorkspace } from "@/lib/auth";
import { field } from "@/lib/forms";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { issueInvitation } from "@/lib/invitations";
import { cookies } from "next/headers";
export async function saveEmployee(form: FormData) {
  const org = field(form, "organization_id");
  const { db } = await requireWorkspace(org, ["owner", "manager"]);
  const id = String(form.get("id") || "");
  const values = {
    display_name: field(form, "display_name"),
    email:
      String(form.get("email") || "")
        .trim()
        .toLowerCase() || null,
    phone: String(form.get("phone") || "").trim(),
  };
  const result = id
    ? await db
        .from("employees")
        .update(values)
        .eq("organization_id", org)
        .eq("id", id)
        .select("id")
    : await db
        .from("employees")
        .insert({ ...values, organization_id: org })
        .select("id");
  revalidatePath(`/workspaces/${org}/employees`);
  revalidatePath(`/workspaces/${org}/schedule`);
  redirect(
    `/workspaces/${org}/employees?${form.get("setup") === "1" ? "setup=1&" : ""}message=${encodeURIComponent(result.error || !result.data?.length ? "Unable to save employee. Check the name and contact information." : "Employee saved and ready to schedule.")}`,
  );
}
export async function inviteRoster(form: FormData) {
  const org = field(form, "organization_id");
  const { db, user } = await requireWorkspace(org, ["owner", "manager"]);
  let result: Awaited<ReturnType<typeof issueInvitation>>;
  try {
    result = await issueInvitation(db, {
      organizationId: org,
      employeeId: field(form, "employee_id"),
      email: field(form, "email", 254),
      role: "employee",
    });
  } catch {
    redirect(
      `/workspaces/${org}/employees?message=Unable+to+invite.+Check+email+and+wait+one+minute+before+retrying.`,
    );
  }
  (await cookies()).set(
    "shiftly-invite",
    JSON.stringify({
      id: org,
      userId: user.id,
      token: result.token,
      invitationId: result.invitationId,
      delivery: result.delivery,
    }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: `/workspaces/${org}`,
      maxAge: 120,
    },
  );
  redirect(`/workspaces/${org}/admin?invited=1`);
}

export async function manageEmployee(form: FormData) {
  const org = field(form, "organization_id");
  const { db } = await requireWorkspace(org, ["owner", "manager"]);
  const command = field(form, "command");
  if (
    !["archive", "restore", "delete"].includes(command) ||
    form.get("confirmed") !== "yes"
  )
    throw Error("Confirm the employee action before continuing.");
  const { data, error } = await db.rpc("employee_lifecycle", {
    org,
    employee: field(form, "employee_id"),
    command,
  });
  const message = error
    ? "Unable to update employee. Refresh and review their assignments, requests, and access."
    : !data?.ok
      ? "Employee unchanged. Resolve the blockers listed on their card first."
      : command === "archive"
        ? "Employee archived. Workspace access and outstanding invitations revoked. History preserved."
        : command === "restore"
          ? "Employee restored for scheduling. Send a new invitation to reconnect their account."
          : "Unused employee permanently deleted.";
  revalidatePath(`/workspaces/${org}`, "layout");
  redirect(
    `/workspaces/${org}/employees?message=${encodeURIComponent(message)}`,
  );
}
