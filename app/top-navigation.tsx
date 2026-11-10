"use client";
import { ProductSwitcher } from "./product-switcher";
import { NotificationBell } from "./notification-bell";
import { Brand } from "./brand";
import Link from "next/link";
import { logout } from "./auth/actions";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
export function TopNavigation({
  workspace,
}: {
  workspace?: { id: string; role: string; name?: string };
}) {
  const pathname = usePathname();
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    if (!workspace) return;
    let active = true;
    async function refresh() {
      try {
        const response = await fetch(
          `/api/notifications?workspace=${workspace!.id}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const data = await response.json();
        if (active) setUnread(data.unread);
      } catch {
        /* Navigation remains available if the count cannot load. */
      }
    }
    void refresh();
    const interval = setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    window.addEventListener("notifications-read", refresh);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("notifications-read", refresh);
    };
  }, [workspace?.id, pathname]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  const base = workspace ? `/workspaces/${workspace.id}` : "";
  const admin = workspace && ["owner", "manager"].includes(workspace.role);
  const links = workspace
    ? [
        { href: base, label: "Dashboard" },
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
      <ProductSwitcher organizationId={workspace?.id} />
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
      {workspace && <NotificationBell base={base} unread={unread} />}
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
          {workspace && (
            <Link href={`${base}/notifications`}>Notification preferences</Link>
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
