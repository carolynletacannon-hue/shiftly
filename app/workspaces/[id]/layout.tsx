import type { ReactNode } from "react";
// Includes post-response notification delivery for workspace Server Actions.
export const runtime = "nodejs";
export const maxDuration = 300;
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return children;
}
