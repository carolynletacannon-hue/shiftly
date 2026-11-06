export type Shift = {
  id: string;
  schedule_id: string;
  employee_id: string | null;
  shift_group_id?: string;
  required_count?: number;
  allow_overstaffing?: boolean;
  shift_groups?: { required_count: number; allow_overstaffing: boolean };

  position_id?: string | null;
  position_name?: string;
  label?: string;
  requirement_id?: string | null;
  template_id?: string | null;
  slot_ordinal?: number;
  is_required?: boolean;
  slot_kind?: "legacy" | "requirement" | "one_off";
  starts_at: string;
  ends_at: string;
  notes: string;
};
export type Schedule = {
  id: string;
  week_start: string;
  timezone: string;
  revision: number;
  published_revision?: number | null;
  published_at?: string;
  shifts: Shift[];
};
export type Member = { id: string; name: string; role: string };
export type Position = { id: string; name: string };
export type ShiftTemplate = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  end_next_day: boolean;
  position_id: string | null;
  revision: number;
};
export type CoverageRequirement = {
  id: string;
  template_id: string;
  weekday: number;
  position_id: string | null;
  required_count: number;
  is_active: boolean;
  revision: number;
};
