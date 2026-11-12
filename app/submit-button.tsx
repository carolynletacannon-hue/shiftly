"use client";
import { Button } from "@/app/ui/button";
import { useFormStatus } from "react-dom";
export function SubmitButton({
  children,
  pendingLabel,
}: {
  children: React.ReactNode;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      className="button primary"
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      aria-busy={pending}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
