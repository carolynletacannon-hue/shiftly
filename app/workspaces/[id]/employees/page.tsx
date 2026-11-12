import { PageHeader, Card } from "@/app/ui/surfaces";
import { Button, ButtonLink } from "@/app/ui/button";
import { LifecycleControls, type EmployeeStatus } from "./lifecycle-controls";
import { Frame, Input, Message } from "@/app/components";
import { requireWorkspace } from "@/lib/auth";
import { saveEmployee, inviteRoster } from "./actions";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ setup?: string; message?: string }>;
}) {
  const { id } = await params;
  const { db, role } = await requireWorkspace(id, ["owner", "manager"]);
  const query = await searchParams;
  const [roster, contacts, invitations] = await Promise.all([
    db
      .from("employees")
      .select("id,display_name,user_id,archived_at")
      .eq("organization_id", id)
      .order("display_name"),
    db.rpc("employee_contacts", { org: id }),
    db
      .from("invitations")
      .select("employee_id,accepted_at,revoked_at,expires_at")
      .eq("organization_id", id),
  ]);
  if (roster.error || contacts.error || invitations.error)
    throw Error("Unable to load employees. Check the roster migration.");
  const statuses = new Map<string, EmployeeStatus>();
  await Promise.all(
    (roster.data || []).map(async (employee) => {
      const { data, error } = await db.rpc("employee_lifecycle", {
        org: id,
        employee: employee.id,
        command: "inspect",
      });
      if (error || !data)
        throw Error(
          "Unable to inspect employee dependencies. Check the employee lifecycle migration.",
        );
      statuses.set(employee.id, data as EmployeeStatus);
    }),
  );
  return (
    <Frame workspace={{ id, role, name: undefined }}>
      <PageHeader className="page-heading">
        <div>
          <p className="eyebrow">
            {query.setup ? "STEP 2 OF 3 · YOUR TEAM" : "YOUR TEAM"}
          </p>
          <h1>Employees</h1>
          <p>
            Add a name. They’re ready to schedule. Accounts and invitations are
            optional.
          </p>
        </div>
      </PageHeader>
      <Message text={query.message} />
      <Card className="panel workspace-card">
        <h2>Add an employee</h2>
        <form action={saveEmployee} className="account-form">
          <input type="hidden" name="organization_id" value={id} />
          <input type="hidden" name="setup" value={query.setup || ""} />
          <Input name="display_name" label="Employee name" />
          <Button icon="plus" className="button primary">Add employee</Button>
          <details>
            <summary>Contact information (optional)</summary>
            <Input name="email" type="email" label="Email" required={false} />
            <Input name="phone" label="Phone" required={false} />
          </details>
        </form>
      </Card>
      <div className="employee-list">
        {roster.data
          ?.filter((employee) => !employee.archived_at)
          .map((employee) => {
            const contact = (
              contacts.data as {
                id: string;
                email: string | null;
                phone: string;
              }[]
            )?.find((c) => c.id === employee.id);
            const pending = invitations.data?.some(
              (i) =>
                i.employee_id === employee.id &&
                !i.accepted_at &&
                !i.revoked_at &&
                Date.parse(i.expires_at) > Date.now(),
            );
            return (
              <Card className="panel workspace-card" key={employee.id}>
                <h2>{employee.display_name}</h2>
                <p className="schedule-badge">
                  {employee.user_id
                    ? "Connected"
                    : pending
                      ? "Invited"
                      : "Roster only"}
                </p>
                <details>
                  <summary>Edit name & contact information</summary>
                  <form action={saveEmployee} className="account-form">
                    <input type="hidden" name="organization_id" value={id} />
                    <input type="hidden" name="id" value={employee.id} />
                    <Input
                      name="display_name"
                      label="Name"
                      defaultValue={employee.display_name}
                    />
                    <Input
                      name="email"
                      type="email"
                      label="Email (optional)"
                      required={false}
                      defaultValue={contact?.email || ""}
                    />
                    <Input
                      name="phone"
                      label="Phone (optional)"
                      required={false}
                      defaultValue={contact?.phone || ""}
                    />
                    <Button icon="check" className="button secondary">Save employee</Button>
                  </form>
                </details>
                <LifecycleControls
                  org={id}
                  employee={employee}
                  status={statuses.get(employee.id)!}
                />
                {!employee.user_id && (
                  <details>
                    <summary>
                      {pending ? "Replace invitation" : "Invite later"}
                    </summary>
                    <p>
                      An invitation grants employee access only after they
                      accept with the verified email below.
                    </p>
                    <form action={inviteRoster} className="account-form">
                      <input type="hidden" name="organization_id" value={id} />
                      <input
                        type="hidden"
                        name="employee_id"
                        value={employee.id}
                      />
                      <Input
                        name="email"
                        type="email"
                        label="Invitation email"
                        defaultValue={contact?.email || ""}
                      />
                      <Button icon="plus" className="button secondary">
                        Create invitation
                      </Button>
                    </form>
                  </details>
                )}
              </Card>
            );
          })}
      </div>
      <Card
        className="panel workspace-card"
        aria-labelledby="archived-employees"
      >
        <h2 id="archived-employees">Archived Employees</h2>
        <p>
          History is preserved. Restoring makes employees available for
          scheduling; invite them again to reconnect account access.
        </p>
        {!roster.data?.some((employee) => employee.archived_at) && (
          <p>No archived employees.</p>
        )}
        {roster.data
          ?.filter((employee) => employee.archived_at)
          .map((employee) => (
            <article className="workspace-card" key={employee.id}>
              <h3>{employee.display_name}</h3>
              <p>Archived · Workspace access revoked</p>
              <LifecycleControls
                org={id}
                employee={employee}
                status={statuses.get(employee.id)!}
              />
            </article>
          ))}
      </Card>
      {query.setup && (
        <ButtonLink
          className="button primary"
          href={`/workspaces/${id}/weekly-setup?setup=1`}
        >
          Next: set up weekly shifts →
        </ButtonLink>
      )}
    </Frame>
  );
}
