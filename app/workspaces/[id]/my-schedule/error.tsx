"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="account-page">
      <section className="panel workspace-card">
        <h1>We couldn’t load the schedule</h1>
        <p role="alert">
          Check your connection and retry. If the problem continues, contact
          your workspace manager. Your published schedule is preserved.
        </p>
        <button className="button primary" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
