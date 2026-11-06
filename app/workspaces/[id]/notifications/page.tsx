import { savePreferences, markRead } from "./actions";
import { Frame } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import { preferenceDefaults } from "@/lib/notifications/preferences";
import { Inbox, PreferenceControls, type InboxItem } from "./controls";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { db, user, role } = await requireWorkspace(id);
  const [org, preferences, notifications] = await Promise.all([
    db.from("organizations").select("name").eq("id", id).single(),
    db
      .from("notification_preferences")
      .select("*")
      .eq("organization_id", id)
      .eq("user_id", user.id)
      .maybeSingle(),
    db
      .from("shift_notifications")
      .select("id,message,href,read_at,created_at")
      .eq("organization_id", id)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if (org.error || preferences.error || notifications.error)
    throw Error(
      "Unable to load notifications. Verify the Phase 7 migration is installed.",
    );
  return (
    <Frame workspace={{ id, role, name: org.data.name }}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{org.data.name}</p>
          <h1>Notifications</h1>
          <p>Updates that help you take the next step.</p>
        </div>
      </div>
      <Inbox
        action={markRead}
        org={id}
        items={(notifications.data || []) as InboxItem[]}
      />
      <PreferenceControls
        action={savePreferences}
        org={id}
        initial={{ ...preferenceDefaults, ...preferences.data }}
        manager={role !== "employee"}
      />
    </Frame>
  );
}
