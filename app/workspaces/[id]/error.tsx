"use client";
import Link from "next/link";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <main className="account-page">
      <section className="panel workspace-card" role="alert">
        <h1>We couldn’t load this page</h1>
        <p>
          Your changes may already have saved. Refresh and check before trying
          an action again.
        </p>
        <div className="calendar-actions">
          <button className="button primary" onClick={reset}>
            Try again
          </button>
          <Link className="button secondary" href="/workspaces">
            Your workplaces
          </Link>
        </div>
      </section>
    </main>
  );
}
