"use client";
import { Brand } from "./brand";
import Link from "next/link";
import { logout } from "./auth/actions";
import { usePathname } from "next/navigation";
import { useState } from "react";
export function TopNavigation({
  workspace,
}: {
  workspace?: { id: string; role: string; name?: string };
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const base = workspace ? `/workspaces/${workspace.id}` : "";
  const admin = workspace && ["owner", "manager"].includes(workspace.role);
  const links = workspace
    ? [
        {
          href: `${base}/${admin ? "schedule" : "my-schedule"}`,
          label: "Schedule",
        },
        ...(admin
          ? [
              { href: `${base}/employees`, label: "Employees" },
              { href: `${base}/weekly-setup`, label: "Weekly setup" },
            ]
          : []),
        { href: `${base}/time-off`, label: "Time Off" },
        { href: `${base}/shift-requests`, label: "Shift Requests" },
        ...(admin
          ? [
              { href: `${base}/my-schedule`, label: "Calendar" },
              { href: `${base}/admin`, label: "Settings" },
            ]
          : []),
      ]
    : [
        { href: "/workspaces", label: "Workspaces" },
        { href: "/demo", label: "Explore demo" },
      ];
  return (
    <header className="app-header">
      <Link
        className="brand"
        href={workspace ? `${base}` : "/workspaces"}
        aria-label="Meadowmark home"
      >
        <Brand />
      </Link>
      <button
        className="mobile-menu button secondary"
        type="button"
        aria-expanded={open}
        aria-controls="app-navigation"
        onClick={() => setOpen(!open)}
      >
        Menu <span aria-hidden="true">☰</span>
      </button>
      <nav
        id="app-navigation"
        className={open ? "app-navigation is-open" : "app-navigation"}
        aria-label="Main navigation"
      >
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            onClick={() => setOpen(false)}
            aria-current={
              pathname === link.href ||
              (link.label === "Schedule" &&
                pathname.startsWith(`${link.href}/`))
                ? "page"
                : undefined
            }
          >
            {link.label}
          </Link>
        ))}
      </nav>
      {workspace && (
        <Link
          className="notifications-link"
          href={`${base}/shift-requests#notifications`}
          aria-label="Notifications"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
          </svg>
        </Link>
      )}
      <details className="workspace-menu">
        <summary aria-label="Account and workspace menu">
          <span className="account-avatar" aria-hidden="true">
            {workspace?.name?.slice(0, 1) || "M"}
          </span>
          <span className="workspace-menu-label">
            {workspace?.name || "Your workspace"}
            <small>{workspace?.role || "Account"}</small>
          </span>
          <span aria-hidden="true">⌄</span>
        </summary>
        <div>
          {admin && (
            <Link href={`${base}/schedule/settings`}>
              Advanced scheduling settings
            </Link>
          )}
          <Link href="/workspaces">Switch workspace</Link>
          <Link href="/demo">Explore demo</Link>
          <Link href="/reset-password">Change password</Link>
          {workspace && (
            <form action={logout}>
              <button type="submit">Sign out</button>
            </form>
          )}
        </div>
      </details>
    </header>
  );
}
