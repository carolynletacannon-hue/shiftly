import "server-only";
import { notFound } from "next/navigation";
import { timeClockEnabled } from "./security";
export function requireTimeClock() {
  if (!timeClockEnabled()) notFound();
}
