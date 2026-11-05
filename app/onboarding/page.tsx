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
        <p>You'll be its owner. You can invite your team next.</p>
        <Message text={(await searchParams).message} />
        <form className="account-form" action={createWorkspace}>
          <Input name="name" label="Business name" />
          <Input
            name="timezone"
            label="IANA timezone"
            defaultValue="America/Denver"
          />
          <small>
            For example, America/Denver or Europe/London. Daylight saving is
            handled by the timezone.
          </small>
          <button className="button primary">Create workspace</button>
        </form>
      </section>
    </Frame>
  );
}
