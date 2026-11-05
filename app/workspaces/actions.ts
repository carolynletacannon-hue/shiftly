"use server";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser, requireWorkspace } from "@/lib/auth";
import { field } from "@/lib/forms";
import { issueInvitation } from "@/lib/invitations";
export async function createWorkspace(form: FormData) {
  const { db } = await requireUser();
  let id: string | undefined;
  try {
    const { data, error } = await db.rpc("create_workspace", {
      workspace_name: field(form, "name"),
      workspace_timezone: field(form, "timezone"),
    });
    if (error) throw error;
    id = data;
  } catch {
    redirect(
      "/onboarding?message=Unable+to+create+workspace.+Check+name+and+timezone.",
    );
  }
  redirect("/workspaces/" + id);
}
export async function switchWorkspace(form: FormData) {
  const id = field(form, "organization_id");
  await requireWorkspace(id);
  (await cookies()).set("shiftly-workspace", id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
  redirect("/workspaces/" + id);
}
export async function updateWorkspace(form: FormData) {
  const id = field(form, "organization_id");
  const { db } = await requireWorkspace(id, ["owner"]);
  let failed = false;
  try {
    const start = Number(field(form, "week_starts_on"));
    if (![0, 1].includes(start)) throw new Error();
    const { error } = await db
      .from("organizations")
      .update({
        name: field(form, "name"),
        timezone: field(form, "timezone"),
        settings: { week_starts_on: start },
      })
      .eq("id", id);
    failed = !!error;
  } catch {
    failed = true;
  }
  redirect(
    "/workspaces/" +
      id +
      "?message=" +
      encodeURIComponent(
        failed
          ? "Unable to save settings. Check your timezone."
          : "Workspace settings saved.",
      ),
  );
}
async function sendInvitation(form: FormData, resending: boolean) {
  const id = field(form, "organization_id");
  const { db, user } = await requireWorkspace(id, ["owner", "manager"]);
  let result: Awaited<ReturnType<typeof issueInvitation>>;
  try {
    let email = resending ? "" : field(form, "email", 254);
    let role = resending ? "" : field(form, "role");
    const replaces = resending ? field(form, "invitation_id") : undefined;
    if (resending) {
      const { data, error } = await db.from("invitations")
        .select("email,role").eq("organization_id", id).eq("id", replaces!).single();
      if (error || !data) throw new Error();
      email = data.email;
      role = data.role;
    }
    result = await issueInvitation(db, { organizationId: id, email, role, replaces });
  } catch (error) {
    redirect("/workspaces/" + id + "?message=" + encodeURIComponent(
      error instanceof Error && error.message === "rate-limit"
        ? "Invitation limit reached. Wait at least one minute before retrying; hourly limits also apply. Existing links remain unchanged."
        : "Unable to confirm invitation creation. Check permissions, details, and the invitation list before retrying.",
    ));
  }
  // Preserve a usable private link even when email is unconfigured or rejected.
  (await cookies()).set("shiftly-invite", JSON.stringify({
    id, userId: user.id, token: result.token, invitationId: result.invitationId,
    delivery: result.delivery,
  }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/workspaces/" + id,
    maxAge: 120,
  });
  redirect("/workspaces/" + id + "?invited=1");
}
export async function invite(form: FormData) {
  return sendInvitation(form, false);
}
export async function resend(form: FormData) {
  return sendInvitation(form, true);
}
export async function revoke(form: FormData) {
  const id = field(form, "organization_id");
  const { db } = await requireWorkspace(id, ["owner", "manager"]);
  const { data } = await db
    .from("invitations")
    .select("id")
    .eq("organization_id", id)
    .eq("id", field(form, "invitation_id"))
    .single();
  if (!data) redirect("/workspaces");
  const { error } = await db.rpc("revoke_invitation", {
    invitation_id: data.id,
  });
  redirect(
    "/workspaces/" +
      id +
      "?message=" +
      encodeURIComponent(
        error ? "Unable to revoke invitation" : "Invitation revoked",
      ),
  );
}
export async function changeRole(form: FormData) {
  const id = field(form, "organization_id");
  const { db } = await requireWorkspace(id, ["owner"]);
  const { error } = await db.rpc("change_member_role", {
    org: id,
    member_id: field(form, "user_id"),
    new_role: field(form, "role"),
  });
  redirect(
    "/workspaces/" +
      id +
      "?message=" +
      encodeURIComponent(error ? "Role change denied" : "Role updated"),
  );
}
export async function accept(form: FormData) {
  const { db } = await requireUser();
  const token = field(form, "token");
  const { data, error } = await db.rpc("accept_invitation", {
    token_digest: createHash("sha256").update(token).digest("hex"),
  });
  if (error)
    redirect(
      "/invite?message=Invitation+invalid,+expired,+already+used,+or+for+a+different+email.+Confirm+your+email+first.",
    );
  redirect("/workspaces/" + data);
}
