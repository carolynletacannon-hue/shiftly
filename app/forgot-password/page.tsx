import { Frame, Input, Message } from "../components";
import { requestReset } from "../auth/actions";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  const params = await searchParams;
  return (
    <Frame>
      <section className="panel auth-card">
        <h1>Reset your password</h1>
        <Message text={params.message} />
        <form action={requestReset} className="account-form">
          <Input name="email" label="Email" type="email" />
          <button className="button primary">Send reset link</button>
        </form>
      </section>
    </Frame>
  );
}
