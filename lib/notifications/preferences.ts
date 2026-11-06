export const preferenceDefaults = {
  coverage: true,
  swap: true,
  time_off: true,
  schedule_change: true,
  approval: true,
  schedule_published: false,
  reminder_24h: false,
  reminder_1h: false,
};
export type Preferences = typeof preferenceDefaults;
export const preferenceLabels: Record<keyof Preferences, [string, string]> = {
  coverage: [
    "Shift coverage updates",
    "Offers, decisions, cancellations, and official coverage assignments.",
  ],
  swap: [
    "Shift swap updates",
    "Proposals, coworker responses, and manager decisions.",
  ],
  time_off: [
    "Time-off decisions",
    "Approvals, denials, and cancellations of approved time off.",
  ],
  schedule_change: [
    "Published schedule changes",
    "Changes to your assigned shifts after publication.",
  ],
  approval: [
    "Manager approval requests",
    "Requests that still need your review.",
  ],
  schedule_published: [
    "Weekly schedule published",
    "An email when your weekly schedule is first published.",
  ],
  reminder_24h: [
    "24-hour shift reminder",
    "Unavailable on the current deployment; no reminders are scheduled.",
  ],
  reminder_1h: [
    "1-hour shift reminder",
    "Unavailable on the current deployment; no reminders are scheduled.",
  ],
};
