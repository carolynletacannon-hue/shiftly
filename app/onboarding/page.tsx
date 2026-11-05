import { Frame, Input, Message } from "../components";
import { requireUser } from "@/lib/auth";
import { createWorkspace } from "../workspaces/actions";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  await requireUser();
  return (
    <Frame>
      <section className="panel auth-card">
        <p className="eyebrow">A NEW BEGINNING</p>
        <h1>Create your workspace</h1>
        <p>Next, add employee names and set up your weekly shifts. No employee accounts needed.</p>
        <Message text={(await searchParams).message} />
        <form className="account-form" action={createWorkspace}>
          <Input name="name" label="Business name" />
          <details><summary>Business timezone (Mountain time by default)</summary>
          <Input
            name="timezone"
            label="IANA timezone"
            defaultValue="America/Denver"
          />
          <small>
            For example, America/Denver or Europe/London. Daylight saving is
            handled by the timezone.
          </small></details>
          <button className="button primary">Create workspace</button>
        </form>
      </section>
    </Frame>
  );
}
