import { PageHeader, Card } from "@/app/ui/surfaces";
import { Button, ButtonLink } from "@/app/ui/button";
import { cookies } from "next/headers";
import { Frame, Message } from "../components";
import { requireUser } from "@/lib/auth";
import { logout } from "../auth/actions";
import { switchWorkspace } from "./actions";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  const { db, user } = await requireUser();
  const { data, error } = await db
    .from("memberships")
    .select("role,organization_id,organizations(name,timezone)")
    .eq("user_id", user.id);
  if (error)
    throw new Error("Unable to load your workplaces. Please try again.");
  const active = (await cookies()).get("shiftly-workspace")?.value;
  return (
    <Frame>
      <PageHeader className="page-heading">
        <div>
          <p className="eyebrow">YOUR MEADOWMARK ACCOUNT</p>
          <h1>Choose your workplace</h1>
          <p className="subtitle">Signed in as {user.email}</p>
        </div>
        <form action={logout}>
          <Button className="button secondary">Sign out</Button>
        </form>
      </PageHeader>
      <p className="shared-account-intro">
        One Meadowmark account for your workplaces and products. Choose a
        workplace to continue into Workforce. Your existing invitations and team
        access stay with your account.
      </p>
      <Message text={(await searchParams).message} />
      <div className="workspace-grid">
        {data?.map((m) => {
          const org = m.organizations as unknown as {
            name: string;
            timezone: string;
          };
          return (
            <Card className="panel workspace-card" key={m.organization_id}>
              <p className="eyebrow">MEADOWMARK WORKFORCE</p>
              <h2>{org.name}</h2>
              <p>
                {org.timezone} · {m.role}
              </p>
              <form action={switchWorkspace}>
                <input
                  type="hidden"
                  name="organization_id"
                  value={m.organization_id}
                />
                <Button className="button primary">
                  {active === m.organization_id
                    ? "Continue to Workforce"
                    : "Open Workforce"}
                </Button>
              </form>
            </Card>
          );
        })}
        <Card className="panel workspace-card">
          <h2>
            {data?.length ? "Another workplace?" : "Let’s get your team set up"}
          </h2>
          <p>Create a workspace or open an invitation from your team.</p>
          <ButtonLink icon="plus" className="button secondary" href="/onboarding">
            Create workspace
          </ButtonLink>
        </Card>
      </div>
    </Frame>
  );
}
