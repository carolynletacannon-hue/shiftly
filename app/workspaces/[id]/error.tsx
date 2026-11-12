"use client";
import { Card } from "@/app/ui/surfaces";
import { Button, ButtonLink } from "@/app/ui/button";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <main className="account-page">
      <Card className="panel workspace-card" role="alert">
        <h1>We couldn’t load this page</h1>
        <p>
          Your changes may already have saved. Refresh and check before trying
          an action again.
        </p>
        <div className="calendar-actions">
          <Button className="button primary" onClick={reset}>
            Try again
          </Button>
          <ButtonLink className="button secondary" href="/workspaces">
            Your workplaces
          </ButtonLink>
        </div>
      </Card>
    </main>
  );
}
