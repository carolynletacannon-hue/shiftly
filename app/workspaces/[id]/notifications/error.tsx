"use client";
import { Card } from "@/app/ui/surfaces";
import { Button } from "@/app/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <Card className="panel workspace-card">
      <h1>Notifications unavailable</h1>
      <p>We couldn’t load your notifications. Please try again.</p>
      <Button className="button secondary" onClick={reset}>
        Try again
      </Button>
    </Card>
  );
}
