"use client";
import { useDetailsDismiss } from "./use-details-dismiss";
import { ProductSwitcher } from "./product-switcher";
import { NotificationBell } from "./notification-bell";
import { Brand } from "./brand";
import Link from "next/link";
import { logout } from "./auth/actions";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
export function TopNavigation({
  workspace,
  timeClock = false,
  payroll = false,
}: {
  timeClock?: boolean;
  payroll?: boolean;
  workspace?: { id: string; role: string; name?: string };
}) {
  const pathname = usePathname();
  const accountRef = useDetailsDismiss(pathname);
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
  const [collapsed, setCollapsed] = useState(true);
  const headerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const header = headerRef.current!;
    const nav = header.querySelector<HTMLElement>("nav")!;
    function measure() {
      const style = getComputedStyle(header);
      const gap = parseFloat(style.columnGap);
      const controls = Array.from(header.children).filter(
        (child) => child !== nav && child !== menuRef.current,
      );
      const links = Array.from(nav.children);
      const required =
        controls.reduce(
          (sum, child) => sum + child.getBoundingClientRect().width,
          0,
        ) +
        links.reduce(
          (sum, child) => sum + child.getBoundingClientRect().width,
          0,
        ) +
        Math.max(0, links.length - 1) *
          parseFloat(getComputedStyle(nav).columnGap) +
        controls.length * gap;
      const available =
        header.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      setCollapsed(required > available);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    for (const child of header.querySelectorAll(
      ".brand, .product-switcher, nav a, .workspace-menu, .notifications-link",
    ))
      observer.observe(child);
    return () => observer.disconnect();
  }, [workspace?.id, workspace?.role, workspace?.name, timeClock, payroll]);
  useEffect(() => {
    setOpen(false);
  }, [pathname, collapsed]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (
        !headerRef.current?.querySelector("nav")?.contains(event.target) &&
        !menuRef.current?.contains(event.target)
      )
        setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && open) {
        setOpen(false);
        menuRef.current?.focus();
      }
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);
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
        ...(timeClock
          ? [
              {
                href: `${base}/time-clock`,
                label: admin ? "Time Clock" : "My Timesheet",
              },
            ]
          : []),
        ...(payroll
          ? [
              {
                href: `${base}/payroll`,
                label: admin ? "Payroll" : "My Pay Estimates",
              },
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
    <header
      ref={headerRef}
      className={`app-header${collapsed ? " navigation-collapsed" : ""}`}
    >
      <Link
        className="brand"
        href={workspace ? `${base}` : "/workspaces"}
        aria-label="Meadowmark home"
      >
        <Brand />
      </Link>
      <ProductSwitcher
        organizationId={workspace?.id}
        onOpen={() => {
          setOpen(false);
          const account =
            headerRef.current?.querySelector<HTMLDetailsElement>(
              ".workspace-menu",
            );
          if (account) account.open = false;
        }}
      />
      <button
        ref={menuRef}
        className="mobile-menu button secondary"
        type="button"
        aria-expanded={collapsed && open}
        aria-controls="app-navigation"
        onClick={() => {
          headerRef.current?.querySelectorAll("details").forEach((account) => {
            account.open = false;
          });
          setOpen(!open);
        }}
      >
        Menu <span aria-hidden="true">☰</span>
      </button>
      <nav
        id="app-navigation"
        className={
          collapsed && open ? "app-navigation is-open" : "app-navigation"
        }
        inert={collapsed && !open}
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
      <details
        ref={accountRef}
        className="workspace-menu"
        onToggle={(event) => {
          if (event.currentTarget.open) {
            setOpen(false);
            const product =
              headerRef.current?.querySelector<HTMLDetailsElement>(
                ".product-switcher",
              );
            if (product) product.open = false;
          }
        }}
      >
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
