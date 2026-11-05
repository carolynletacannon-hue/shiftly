import "server-only";
import { redirect } from "next/navigation";
import { supabase } from "./supabase/server";
export async function requireUser() {
  const db = await supabase();
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user) redirect("/login");
  return { db, user };
}
export async function requireWorkspace(
  id: string,
  roles = ["owner", "manager", "employee"],
) {
  const { db, user } = await requireUser();
  const { data: membership } = await db
    .from("memberships")
    .select("role")
    .eq("organization_id", id)
    .eq("user_id", user.id)
    .single();
  if (!membership || !roles.includes(membership.role))
    redirect("/workspaces?message=Workspace+access+denied");
  return { db, user, role: membership.role as string };
}
