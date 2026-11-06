import { supabase } from "@/lib/supabase/server";
export async function GET(request: Request) {
  const db = await supabase();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const org = new URL(request.url).searchParams.get("workspace");
  if (!org || !/^[0-9a-f-]{36}$/i.test(org))
    return Response.json({ error: "Invalid workspace" }, { status: 400 });
  const { count, error } = await db
    .from("shift_notifications")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org)
    .eq("user_id", user.id)
    .is("read_at", null);
  if (error) return Response.json({ error: "Unavailable" }, { status: 503 });
  return Response.json(
    { unread: count || 0 },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
