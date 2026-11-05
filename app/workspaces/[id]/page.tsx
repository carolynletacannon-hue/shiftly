import Link from "next/link";
import { cookies } from "next/headers";
import { Frame, Input, Message } from "../../components";
import { requireWorkspace } from "@/lib/auth";
import { updateWorkspace, invite, revoke, changeRole } from "../actions";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; invited?: string }>;
}) {
  const { id } = await params;
  const { db, user, role } = await requireWorkspace(id);
  const query = await searchParams;
  const [{ data: org, error }, { data: members }, { data: positions }] =
    await Promise.all([
      db.from("organizations").select("*").eq("id", id).single(),
      db
        .from("memberships")
        .select("user_id,role,profiles(display_name)")
        .eq("organization_id", id),
      db.from("positions").select("id,name").eq("organization_id", id),
    ]);
  if (error || !org) throw new Error("Unable to load workspace");
  const admin = ["owner", "manager"].includes(role);
  const { data: invitations } = admin
    ? await db
        .from("invitations")
        .select("id,email,role,expires_at,accepted_at,revoked_at")
        .eq("organization_id", id)
        .order("created_at", { ascending: false })
    : { data: [] };
  let invitationLink = "";
  const raw = (await cookies()).get("shiftly-invite")?.value;
  if (query.invited && raw) {
    try {
      const saved = JSON.parse(raw);
      if (saved.id === id)
        invitationLink =
          (process.env.NEXT_PUBLIC_SITE_URL || "") +
          "/invite?token=" +
          saved.token;
    } catch {}
  }
  return (
    <Frame>
      <div className="page-heading">
        <div>
          <p className="eyebrow">WORKSPACE MANAGEMENT</p>
          <h1>{org.name}</h1>
          <p className="subtitle">
            {role} · {org.timezone}
          </p>
        </div>
        <Link className="button secondary" href="/workspaces">
          Switch workplace
        </Link>
      </div>
      <Message text={query.message} />
      <div className="demo-banner">
        Your workspace and team access are saved securely. Scheduling and time
        off are still a fictional <Link href="/demo">demo</Link>.
      </div>
      <div className="two-col">
        <section className="panel workspace-card">
          <h2>Business settings</h2>
          {role === "owner" ? (
            <form className="account-form" action={updateWorkspace}>
              <input type="hidden" name="organization_id" value={id} />
              <Input
                name="name"
                label="Business name"
                defaultValue={org.name}
              />
              <Input
                name="timezone"
                label="IANA timezone"
                defaultValue={org.timezone}
              />
              <label>
                Week starts on
                <select
                  name="week_starts_on"
                  defaultValue={org.settings.week_starts_on ?? 0}
                >
                  <option value="0">Sunday</option>
                  <option value="1">Monday</option>
                </select>
              </label>
              <button className="button primary">Save settings</button>
            </form>
          ) : (
            <p>
              The owner manages business settings. Your week starts on{" "}
              {org.settings.week_starts_on === 1 ? "Monday" : "Sunday"}.
            </p>
          )}
          <h2>Positions</h2>
          <p>
            {positions?.length
              ? positions.map((p) => p.name).join(", ")
              : "No positions configured yet."}
          </p>
        </section>
        <section className="panel workspace-card">
          <h2>Team members</h2>
          {members?.map((m) => (
            <article className="member-row" key={m.user_id}>
              <strong>
                {(m.profiles as unknown as { display_name: string })
                  ?.display_name || "Team member"}{" "}
                {m.user_id === user.id ? "(you)" : ""}
              </strong>
              <span>{m.role}</span>
              {role === "owner" &&
                m.user_id !== user.id &&
                m.role !== "owner" && (
                  <form action={changeRole}>
                    <input type="hidden" name="organization_id" value={id} />
                    <input type="hidden" name="user_id" value={m.user_id} />
                    <label>
                      Role
                      <select name="role" defaultValue={m.role}>
                        <option value="employee">Employee</option>
                        <option value="manager">Manager</option>
                      </select>
                    </label>
                    <button className="button secondary">Update role</button>
                  </form>
                )}
            </article>
          ))}
        </section>
      </div>
      {admin && (
        <section className="panel workspace-card invitation-panel">
          <h2>Invite a teammate</h2>
          <p>
            Create a private link and share it with the intended employee.
            Shiftly does not send invitation emails yet.
          </p>
          {invitationLink && (
            <div role="status" className="notice">
              <label>
                Copy this invitation link now (shown for two minutes)
                <input
                  readOnly
                  value={invitationLink}
                  aria-label="Invitation link"
                />
              </label>
            </div>
          )}
          <form action={invite} className="account-form">
            <input type="hidden" name="organization_id" value={id} />
            <Input name="email" type="email" label="Employee email" />
            <label>
              Role
              <select name="role">
                <option value="employee">Employee</option>
                {role === "owner" && <option value="manager">Manager</option>}
              </select>
            </label>
            <button className="button primary">Create invitation link</button>
          </form>
          <h3>Invitations</h3>
          {invitations?.map((i) => (
            <article className="member-row" key={i.id}>
              <strong>{i.email}</strong>
              <span>
                {i.role} ·{" "}
                {i.accepted_at
                  ? "Accepted"
                  : i.revoked_at
                    ? "Revoked"
                    : new Date(i.expires_at).getTime() <= Date.now()
                      ? "Expired"
                      : "Pending"}
              </span>
              {!i.accepted_at && !i.revoked_at && (
                <form action={revoke}>
                  <input type="hidden" name="organization_id" value={id} />
                  <input type="hidden" name="invitation_id" value={i.id} />
                  <button className="button secondary">Revoke</button>
                </form>
              )}
            </article>
          ))}
        </section>
      )}
    </Frame>
  );
}
