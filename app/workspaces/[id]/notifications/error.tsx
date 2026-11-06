"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="panel workspace-card">
      <h1>Notifications unavailable</h1>
      <p>We couldn’t load your notifications. Please try again.</p>
      <button className="button secondary" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
