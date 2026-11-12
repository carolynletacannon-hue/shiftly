import { payrollEnabled } from "@/lib/payroll/feature";
import { timeClockEnabled } from "@/lib/time-clock/security";
import { WorkspaceContext } from "./ui/workspace-context";
import { TopNavigation } from "./top-navigation";
export function Frame({
  children,
  workspace,
}: {
  children: React.ReactNode;
  workspace?: { id: string; role: string; name?: string };
}) {
  return (
    <div
      className={workspace ? "account-shell workspace-shell" : "account-shell"}
    >
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <TopNavigation
        workspace={workspace}
        timeClock={timeClockEnabled()}
        payroll={payrollEnabled()}
      />
      <main id="main-content" className="account-page">
        {workspace && (
          <WorkspaceContext
            name={workspace.name || "Your workspace"}
            role={workspace.role}
          />
        )}
        {children}
      </main>
    </div>
  );
}
export function Message({ text }: { text?: string }) {
  return text ? (
    <p role="status" className="notice">
      {text}
    </p>
  ) : null;
}
export function Input({
  name,
  label,
  type = "text",
  defaultValue,
  required = true,
}: {
  name: string;
  label: string;
  type?: string;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        maxLength={type === "password" ? 128 : 254}
        minLength={type === "password" ? 12 : undefined}
        autoComplete={
          type === "password"
            ? "new-password"
            : type === "email"
              ? "email"
              : undefined
        }
      />
    </label>
  );
}
