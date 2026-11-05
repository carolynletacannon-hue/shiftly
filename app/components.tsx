import Link from "next/link";
export function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="account-shell">
      <header className="account-header">
        <Link className="brand" href="/workspaces">
          <span className="brand-mark">S</span>shiftly.
        </Link>
        <nav>
          <Link href="/workspaces">Workspaces</Link>
          <Link href="/demo">View demo</Link>
        </nav>
      </header>
      <main className="account-page">{children}</main>
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
