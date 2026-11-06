import type { Availability } from "../time-off/types";
import type { Shift } from "./types";
export type CopyPreview = {
  token: string; timezone: string; week: string; added: number; assigned: number; removed: number; skipped: number;
  availability_timezone: string; availability: Availability[]; published: boolean; source_revision: number; destination_revision: number;
  warnings: { message: string; employee_id?: string; label?: string }[];
  shifts: Shift[]; hours: { id: string; display_name: string; hours: number }[];
};
