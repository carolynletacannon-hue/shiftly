import { Frame, Input, Message } from "../components";
import { resetPassword } from "../auth/actions";
import { requireUser } from "@/lib/auth";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  return (
    <Frame>
      <section className="panel auth-card">
        <h1>Choose a new password</h1>
        <Message text={params.message} />
        <form action={resetPassword} className="account-form">
          <Input
            name="password"
            label="New password (12+ characters)"
            type="password"
          />
          <button className="button primary">Update password</button>
        </form>
      </section>
    </Frame>
  );
}
