import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; invited?: string }>;
}) {
  const { id } = await params;
  const { role } = await requireWorkspace(id);
  const query = await searchParams;
  if (query.message || query.invited)
    redirect(
      `/workspaces/${id}/admin?${new URLSearchParams(query as Record<string, string>)}`,
    );
  redirect(
    `/workspaces/${id}/${["owner", "manager"].includes(role) ? "schedule" : "my-schedule"}`,
  );
}
