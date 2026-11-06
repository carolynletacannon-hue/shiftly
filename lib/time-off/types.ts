export type TimeOff = {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  full_day: boolean;
  timezone: string;
  starts_at: string;
  ends_at: string;
  notes: string;
  status: "pending" | "approved" | "denied" | "cancelled";
};
export type Availability = {
  employee_id: string;
  weekday: number;
  unavailable: boolean;
  start_time: string | null;
  end_time: string | null;
};
