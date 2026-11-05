import Link from "next/link";
import { Frame, Message } from "../components";
import { supabase } from "@/lib/supabase/server";
import { accept } from "../workspaces/actions";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; message?: string }>;
}) {
  const { token, message } = await searchParams;
  const db = await supabase();
  const {
    data: { user },
  } = await db.auth.getUser();
  const next = "/invite?token=" + encodeURIComponent(token || "");
  return (
    <Frame>
      <section className="panel auth-card">
        <h1>Join your team</h1>
        <Message text={message} />
        <p>
          Sign in with the confirmed email address this invitation was sent to.
          Invitations expire after seven days and can be accepted once.
        </p>
        {token && /^[a-f0-9]{64}$/.test(token) ? (
          user ? (
            <form action={accept}>
              <input type="hidden" name="token" value={token} />
              <button className="button primary">Accept invitation</button>
            </form>
          ) : (
            <p>
              <Link href={"/login?next=" + encodeURIComponent(next)}>
                Sign in
              </Link>{" "}
              or{" "}
              <Link href={"/signup?next=" + encodeURIComponent(next)}>
                create an account
              </Link>{" "}
              to accept.
            </p>
          )
        ) : (
          <p>Ask your workspace manager for a fresh invitation link.</p>
        )}
      </section>
    </Frame>
  );
}
