import Link from "next/link";
export function NotificationBell({
  base,
  unread,
}: {
  base: string;
  unread: number | null;
}) {
  return (
    <Link
      className="notifications-link"
      href={`${base}/notifications`}
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
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
      {!!unread && (
        <span aria-hidden="true" className="notification-count">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
