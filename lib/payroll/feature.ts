import "server-only";
import { notFound } from "next/navigation";
export const payrollEnabled = () =>
  process.env.PAYROLL_REPORTS_ENABLED === "true";
export function requirePayroll() {
  if (!payrollEnabled()) notFound();
}
