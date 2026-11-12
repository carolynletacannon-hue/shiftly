"use client";
import { Card } from "@/app/ui/surfaces";
import { Button } from "@/app/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="account-page">
      <Card className="panel workspace-card">
        <h1>We couldn’t load the schedule</h1>
        <p role="alert">
          Check your connection and retry. If this is the first Phase 2
          deployment, ask the workspace owner to verify the new scheduling
          migration was applied. Existing schedules are preserved.
        </p>
        <Button className="button primary" onClick={reset}>
          Try again
        </Button>
      </Card>
    </main>
  );
}
