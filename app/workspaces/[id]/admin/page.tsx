import { SectionTitle, PageHeader, Card } from "@/app/ui/surfaces";
import { Select } from "@/app/ui/select";
import { Button } from "@/app/ui/button";
import { requestAction } from "../shift-requests/actions";
import { cookies } from "next/headers";
import { Frame, Input, Message } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import {
  updateWorkspace,
  invite,
  resend,
  revoke,
  changeRole,
} from "../../actions";
import { invitationUrl } from "@/lib/invitations";
import { CopyInvitation } from "../../copy-invitation";
export const runtime = "nodejs";

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
  const { data: coveragePolicy } = await db
    .from("shift_coverage_policies")
    .select("*")
    .eq("organization_id", id)
    .maybeSingle();
  const admin = ["owner", "manager"].includes(role);
  const { data: invitations, error: invitationsError } = admin
    ? await db
        .from("invitations")
        .select("id,email,role,expires_at,accepted_at,revoked_at")
        .eq("organization_id", id)
        .order("created_at", { ascending: false })
    : { data: [], error: null };
  let invitationLink = "";
  let deliveryMessage = "";
  const raw = (await cookies()).get("shiftly-invite")?.value;
  if (query.invited && raw) {
    try {
      const saved = JSON.parse(raw);
      if (
        admin &&
        saved.id === id &&
        saved.userId === user.id &&
        invitations?.some(
          (i) =>
            i.id === saved.invitationId &&
            !i.accepted_at &&
            !i.revoked_at &&
            new Date(i.expires_at).getTime() > Date.now(),
        )
      ) {
        invitationLink =
          invitationUrl(saved.token) || "/invite?token=" + saved.token;
        deliveryMessage =
          saved.delivery === "accepted"
            ? "The email provider accepted the invitation email for delivery. You can also copy the link below."
            : saved.delivery === "failed"
              ? "Invitation created, but email acceptance could not be confirmed. Copy the link below or resend after one minute."
              : "Invitation created. Email delivery is not configured. Copy the link below to share it manually.";
      }
    } catch {}
  }
  return (
    <Frame workspace={{ id, role, name: org.name }}>
      <PageHeader className="page-heading">
        <div>
          <p className="eyebrow">WORKSPACE MANAGEMENT</p>
          <h1>{org.name}</h1>
          <p className="subtitle">
            {role} · {org.timezone}
          </p>
        </div>
      </PageHeader>
      <Message text={query.message} />

      <div className="two-col ui-settings-grid">
        <Card className="panel workspace-card">
          {admin && (
            <>
              <SectionTitle icon="shield">Shift Coverage</SectionTitle>
              <form action={requestAction} className="account-form">
                <input type="hidden" name="organization_id" value={id} />
                <input type="hidden" name="command" value="policy" />
                <input
                  type="hidden"
                  name="revision"
                  value={coveragePolicy?.revision ?? 1}
                />
                <label>
                  Shift swap and coverage approval policy
                  <Select
                    name="require_manager"
                    defaultValue={String(
                      coveragePolicy?.require_manager ?? true,
                    )}
                  >
                    <option value="true">
                      Require manager approval (default)
                    </option>
                    <option value="false">
                      Allow employee-managed coverage
                    </option>
                  </Select>
                </label>
                <p>
                  Changing this setting never automatically approves pending
                  requests.
                </p>
                <Button icon="check" className="button primary">
                  Save coverage policy
                </Button>
              </form>
            </>
          )}
          <div className="ui-settings-divider" />
          <SectionTitle icon="settings">Business settings</SectionTitle>
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
                <Select
                  name="week_starts_on"
                  defaultValue={org.settings.week_starts_on ?? 0}
                >
                  <option value="0">Sunday</option>
                  <option value="1">Monday</option>
                </Select>
              </label>
              <Button icon="check" className="button primary">
                Save settings
              </Button>
            </form>
          ) : (
            <p>
              The owner manages business settings. Your week starts on{" "}
              {org.settings.week_starts_on === 1 ? "Monday" : "Sunday"}.
            </p>
          )}
          <div className="ui-settings-divider" />
          <SectionTitle icon="layers">Positions</SectionTitle>
          <p>
            {positions?.length
              ? positions.map((p) => p.name).join(", ")
              : "No positions configured yet."}
          </p>
        </Card>
        <Card className="panel workspace-card">
          <SectionTitle icon="users">Team members</SectionTitle>
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
                      <Select name="role" defaultValue={m.role}>
                        <option value="employee">Employee</option>
                        <option value="manager">Manager</option>
                      </Select>
                    </label>
                    <Button className="button secondary">Update role</Button>
                  </form>
                )}
            </article>
          ))}
        </Card>
      </div>
      {admin && (
        <Card className="panel workspace-card invitation-panel">
          <SectionTitle icon="mail">Invite a teammate</SectionTitle>
          <p>
            Send a private invitation to your teammate. Invitations expire after
            seven days. You can also copy the link to share it manually.
          </p>
          {invitationLink && (
            <div role="status" className="notice">
              <div>
                <p>{deliveryMessage}</p>
                <CopyInvitation link={invitationLink} />
              </div>
            </div>
          )}
          <form action={invite} className="account-form">
            <input type="hidden" name="organization_id" value={id} />
            <Input name="email" type="email" label="Employee email" />
            <label>
              Role
              <Select name="role">
                <option value="employee">Employee</option>
                {role === "owner" && <option value="manager">Manager</option>}
              </Select>
            </label>
            <Button icon="mail" className="button primary">
              Send Invitation
            </Button>
          </form>
          <h3>Invitations</h3>
          {invitationsError && (
            <p role="alert">
              Unable to load invitations. Refresh to try again.
            </p>
          )}
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
              {!i.accepted_at &&
                !i.revoked_at &&
                (role === "owner" || i.role === "employee") && (
                  <form action={resend}>
                    <input type="hidden" name="organization_id" value={id} />
                    <input type="hidden" name="invitation_id" value={i.id} />
                    <Button className="button secondary">
                      Resend invitation
                    </Button>
                  </form>
                )}
              {!i.accepted_at && !i.revoked_at && (
                <form action={revoke}>
                  <input type="hidden" name="organization_id" value={id} />
                  <input type="hidden" name="invitation_id" value={i.id} />
                  <Button className="button secondary">Revoke</Button>
                </form>
              )}
            </article>
          ))}
        </Card>
      )}
    </Frame>
  );
}
