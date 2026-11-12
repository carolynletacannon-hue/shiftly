import { PageHeader } from "@/app/ui/surfaces";
import { Frame } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import { validWeek } from "@/lib/scheduling/time";
import { WeeklyWizard } from "./wizard";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { db, role } = await requireWorkspace(id, ["owner", "manager"]);
  const [org, templates, requirements, version] = await Promise.all([
    db
      .from("organizations")
      .select("name,timezone,settings")
      .eq("id", id)
      .single(),
    db
      .from("shift_templates")
      .select("*")
      .eq("organization_id", id)
      .order("start_time"),
    db.from("coverage_requirements").select("*").eq("organization_id", id),
    db
      .from("weekly_setup_versions")
      .select("revision")
      .eq("organization_id", id)
      .maybeSingle(),
  ]);
  if (
    org.error ||
    templates.error ||
    requirements.error ||
    version.error ||
    !org.data
  )
    throw Error("Unable to load weekly setup. Check the scheduling migration.");
  const week = validWeek(
    undefined,
    org.data.timezone,
    org.data.settings.week_starts_on ?? 0,
  );
  return (
    <Frame workspace={{ id, role, name: org.data.name }}>
      <PageHeader className="page-heading">
        <div>
          <p className="eyebrow">SET IT UP ONCE · USE IT EVERY WEEK</p>
          <h1>Set Up Weekly Schedule</h1>
          <p>
            Choose shifts, check the days, and tell us how many people you need.
          </p>
        </div>
      </PageHeader>
      <WeeklyWizard
        key={version.data?.revision ?? 0}
        org={id}
        templates={templates.data || []}
        requirements={requirements.data || []}
        revision={version.data?.revision ?? 0}
        week={week}
      />
    </Frame>
  );
}
