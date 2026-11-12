"use client";
import { Button } from "@/app/ui/button";
import { Card } from "@/app/ui/surfaces";
import Link from "next/link";
import { useEffect, useState } from "react";
export type Milestone = {
  title: string;
  detail: string;
  complete: boolean;
  href: string;
};
export function OnboardingChecklist({
  workspace,
  userId,
  steps,
}: {
  workspace: string;
  userId: string;
  steps: Milestone[];
}) {
  const key = `meadowmark-onboarding:${userId}:${workspace}`;
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(key) === "dismissed");
    } catch {
      /* Storage may be disabled. */
    }
  }, [key]);
  const complete = steps.filter((s) => s.complete).length;
  function toggle() {
    const next = !dismissed;
    setDismissed(next);
    try {
      if (next) localStorage.setItem(key, "dismissed");
      else localStorage.removeItem(key);
    } catch {
      /* Current-session dismissal still works. */
    }
  }
  if (dismissed)
    return (
      <Button className="button secondary" onClick={toggle}>
        Show getting-started checklist
      </Button>
    );
  return (
    <Card className="panel dashboard-card ui-onboarding-card" aria-labelledby="getting-started">
      <h2 id="getting-started">Make yourself at home</h2>
      <p>
        {complete} of {steps.length} steps complete. Explore at your own pace —
        you can add employees later.
      </p>
      <progress
        aria-label="Workplace setup progress"
        value={complete}
        max={steps.length}
      />
      <ol className="onboarding-list">
        {steps.map((step) => (
          <li key={step.title}>
            <span aria-label={step.complete ? "Completed" : "Remaining"}>
              {step.complete ? "✓" : "○"}
            </span>{" "}
            <strong>{step.title}</strong>
            <Link href={step.href}>{step.complete ? "View" : "Continue"}</Link>
            <small>{step.detail}</small>
          </li>
        ))}
      </ol>
      <p>
        Your schedule stays private until you choose Publish in the schedule
        editor.
      </p>
      <Button className="button secondary onboarding-dismiss" onClick={toggle}>
        Skip for now
      </Button>
    </Card>
  );
}
