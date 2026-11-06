import type { Shift } from "./types";
export type ShiftGroup = Shift & {
  assignments: Shift[];
  required_count: number;
  allow_overstaffing: boolean;
};
/** Group by persisted identity only. Equal times are never evidence of identity. */
export function groupShifts(shifts: Shift[]): ShiftGroup[] {
  const groups = new Map<string, ShiftGroup>();
  for (const shift of shifts) {
    const id = shift.shift_group_id || shift.id;
    let group = groups.get(id);
    if (!group) {
      group = {
        ...shift,
        id,
        shift_group_id: id,
        required_count:
          shift.shift_groups?.required_count ?? shift.required_count ?? 1,
        allow_overstaffing:
          shift.shift_groups?.allow_overstaffing ??
          shift.allow_overstaffing ??
          true,
        assignments: [],
      };
      groups.set(id, group);
    }
    if (shift.employee_id) group.assignments.push(shift);
  }
  return [...groups.values()];
}
export function staffing(shifts: Shift[]) {
  return groupShifts(shifts).reduce(
    (total, group) => ({
      required: total.required + group.required_count,
      covered:
        total.covered +
        Math.min(group.required_count, group.assignments.length),
      unfilled:
        total.unfilled +
        Math.max(0, group.required_count - group.assignments.length),
    }),
    { required: 0, covered: 0, unfilled: 0 },
  );
}
