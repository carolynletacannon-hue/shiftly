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
        <p className="eyebrow">WELCOME TO MEADOWMARK</p>
        <h1>Create your account</h1>
        <p className="subtitle">Your team, in one organized place.</p>
        <Message text={params.message} />
        <form className="account-form" action={authenticate}>
          <input type="hidden" name="mode" value="signup" />
          <input
            type="hidden"
            name="next"
            value={params.next || "/workspaces"}
          />
          <Input name="display_name" label="Your name" />
          <Input name="email" label="Email" type="email" />
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          <small>Use at least 12 characters.</small>
          <button className="button primary">Create account</button>
        </form>
        <p>
          <Link
            href={`/login?next=${encodeURIComponent(params.next || "/workspaces")}`}
          >
            Already have an account? Sign in
          </Link>
        </p>
        <Link href="/forgot-password">Forgot password?</Link>
      </section>
    </Frame>
  );
}
