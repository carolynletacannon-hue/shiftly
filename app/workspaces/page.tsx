import Link from "next/link";
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
    throw new Error(
      "Unable to load your workplaces. Please try again.",
    );
  const active = (await cookies()).get("shiftly-workspace")?.value;
  return (
    <Frame>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR WORKPLACES</p>
          <h1>Choose a workspace</h1>
          <p className="subtitle">Signed in as {user.email}</p>
        </div>
        <form action={logout}>
          <button className="button secondary">Sign out</button>
        </form>
      </div>
      <Message text={(await searchParams).message} />
      <div className="workspace-grid">
        {data?.map((m) => {
          const org = m.organizations as unknown as {
            name: string;
            timezone: string;
          };
          return (
            <section className="panel workspace-card" key={m.organization_id}>
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
                <button className="button primary">
                  {active === m.organization_id ? "Continue" : "Open workspace"}
                </button>
              </form>
            </section>
          );
        })}
        <section className="panel workspace-card">
          <h2>
            {data?.length ? "Another workplace?" : "Let’s get your team set up"}
          </h2>
          <p>Create a workspace or open an invitation from your team.</p>
          <Link className="button secondary" href="/onboarding">
            Create workspace
          </Link>
        </section>
      </div>
    </Frame>
  );
}
