import { Frame } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import type { TimeOff, Availability } from "@/lib/time-off/types";
import { TimeOffScreen } from "./screen";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { db, user, role } = await requireWorkspace(id);
  const [
    { data: org, error: orgError },
    { data: roster, error: rosterError },
    { data: requests, error: requestError },
    { data: availability, error: availabilityError },
  ] = await Promise.all([
    db.from("organizations").select("name,timezone").eq("id", id).single(),
    db
      .from("employees")
      .select("id,display_name,user_id,archived_at")
      .eq("organization_id", id)
      .order("display_name"),
    db
      .from("time_off_requests")
      .select("*")
      .eq("organization_id", id)
      .order("created_at", { ascending: false }),
    db.from("employee_availability").select("*").eq("organization_id", id),
  ]);
  if (orgError || rosterError || requestError || availabilityError || !org)
    throw Error(
      "Unable to load time off. Check that the Phase 3 migration is applied, then retry.",
    );
  const manager = role === "owner" || role === "manager";
  const own = roster?.find((e) => e.user_id === user.id);
  const [
    { data: drafts, error: draftError },
    { data: published, error: publishedError },
  ] = manager
    ? await Promise.all([
        db
          .from("shifts")
          .select("employee_id,starts_at,ends_at")
          .eq("organization_id", id),
        db
          .from("published_shifts")
          .select("employee_id,starts_at,ends_at")
          .eq("organization_id", id),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];
  if (draftError || publishedError)
    throw Error("Unable to check scheduled assignments");
  return (
    <Frame workspace={{ id, role, name: org.name }}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{org.name}</p>
          <h1>{manager ? "Time-Off Requests" : "My time off"}</h1>
          <p className="subtitle">
            {org.timezone} · Requests and notes are private to you and your
            managers.
          </p>
        </div>
      </div>
      <TimeOffScreen
        org={id}
        timezone={org.timezone}
        manager={manager}
        ownId={own?.id || ""}
        employees={(roster || []).map((e) => ({
          id: e.id,
          name: e.display_name,
          placeholder: !e.user_id,
          archived: !!e.archived_at,
        }))}
        requests={(requests || []) as TimeOff[]}
        availability={(availability || []) as Availability[]}
        shifts={[...(drafts || []), ...(published || [])]}
      />
    </Frame>
  );
}
