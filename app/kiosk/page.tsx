import { requireTimeClock } from "@/lib/time-clock/feature";
import { Kiosk } from "./screen";
export const dynamic = "force-dynamic";
export default function Page() {
  requireTimeClock();
  return <Kiosk />;
}
