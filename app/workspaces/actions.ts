"use server";
import { randomBytes, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser, requireWorkspace } from "@/lib/auth";
import { field } from "@/lib/forms";
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
export async function invite(form: FormData) {
  const id = field(form, "organization_id");
  const { db, role } = await requireWorkspace(id, ["owner", "manager"]);
  const token = randomBytes(32).toString("hex");
  let failed = false;
  try {
    const desired = field(form, "role");
    if (
      !["employee", "manager"].includes(desired) ||
      (role === "manager" && desired !== "employee")
    )
      throw new Error();
    const { error } = await db.rpc("invite_employee", {
      org: id,
      invite_email: field(form, "email", 254),
      invite_role: desired,
      token_digest: createHash("sha256").update(token).digest("hex"),
    });
    failed = !!error;
  } catch {
    failed = true;
  }
  if (failed)
    redirect("/workspaces/" + id + "?message=Unable+to+create+invitation");
  // Short-lived HttpOnly cookie carries the one-time display link without putting it in a query string.
  (await cookies()).set("shiftly-invite", JSON.stringify({ id, token }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/workspaces/" + id,
    maxAge: 120,
  });
  redirect("/workspaces/" + id + "?invited=1");
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
