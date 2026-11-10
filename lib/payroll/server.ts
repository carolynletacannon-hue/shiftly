import "server-only";
import { Temporal } from "@js-temporal/polyfill";
import { requireWorkspace } from "../auth";
import { requirePayroll } from "./feature";
import { calculate, period, type Input } from "./engine";
export async function loadPayroll(
  id: string,
  date?: string,
  managerOnly = false,
) {
  requirePayroll();
  const auth = await requireWorkspace(
    id,
    managerOnly ? ["owner", "manager"] : undefined,
  );
  const { data, error } = await auth.db.rpc("payroll_input", { org: id });
  if (error || !data?.settings)
    throw Error(
      "Configure payroll settings first. Confirm the Phase 10 migration is installed.",
    );
  const input = data as Input;
  if (input.cards.length > 10000 || input.rates.length > 10000)
    throw Error(
      "Payroll source exceeds the supported 10,000 record limit. External review required.",
    );
  const today = Temporal.Now.zonedDateTimeISO(input.settings.timezone)
    .toPlainDate()
    .toString();
  const p = period(input.settings, date || today);
  return { ...auth, input, p, report: calculate(input, p.start, p.end) };
}
