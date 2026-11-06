import { TopNavigation } from "./top-navigation";
export function Frame({
  children,
  workspace,
}: {
  children: React.ReactNode;
  workspace?: { id: string; role: string; name?: string };
}) {
  return (
    <div className="account-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <TopNavigation workspace={workspace} />
      <main id="main-content" className="account-page">
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
