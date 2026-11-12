"use client";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
const titles: Record<string, string> = {
  admin: "Settings",
  schedule: "Schedule",
  employees: "Employees",
  "weekly-setup": "Weekly setup",
  "time-off": "Time off",
  "shift-requests": "Shift requests",
  "my-schedule": "My schedule",
  notifications: "Notifications",
  "time-clock": "Time clock",
  payroll: "Payroll",
  settings: "Scheduling settings",
};
export function WorkspaceContext({
  name,
  role,
}: {
  name: string;
  role: string;
}) {
  const pathname = usePathname();
  const key = pathname.split("/").filter(Boolean).at(-1)!;
  return (
    <div className="ui-workspace-context">
      <div>
        <Icon name="layers" />
        <span>Workforce</span>
        <Icon name="chevron-right" />
        <span className="ui-context-name">{name}</span>
        <Icon name="chevron-right" />
        <strong>{titles[key] || "Overview"}</strong>
      </div>
      <span className="ui-role-badge">{role}</span>
    </div>
  );
}
