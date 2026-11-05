import Link from "next/link";
import { Frame, Input, Message } from "../components";
import { authenticate } from "../auth/actions";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; next?: string }>;
}) {
  const params = await searchParams;
  return (
    <Frame>
      <section className="panel auth-card">
        <p className="eyebrow">WELCOME TO SHIFTLY</p>
        <h1>Welcome back</h1>
        <p className="subtitle">Your team, in one organized place.</p>
        <Message text={params.message} />
        <form className="account-form" action={authenticate}>
          <input type="hidden" name="mode" value="login" />
          <input
            type="hidden"
            name="next"
            value={params.next || "/workspaces"}
          />
          <Input name="email" label="Email" type="email" />
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={1}
              maxLength={128}
              autoComplete="current-password"
            />
          </label>
          <button className="button primary">Sign in</button>
        </form>
        <p>
          <Link
            href={`/signup?next=${encodeURIComponent(params.next || "/workspaces")}`}
          >
            Create an account
          </Link>
        </p>
        <Link href="/forgot-password">Forgot password?</Link>
      </section>
    </Frame>
  );
}
