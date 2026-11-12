import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { Icon, type IconName } from "./icons";
export function PageHeader({
  children,
  className = "",
  ...props
}: ComponentProps<"div">) {
  return (
    <div className={`page-heading ui-page-header ${className}`} {...props}>
      {children}
    </div>
  );
}
export function Card({
  children,
  className = "",
  ...props
}: ComponentProps<"section">) {
  return (
    <section className={`panel ui-card ${className}`} {...props}>
      {children}
    </section>
  );
}
export function MetricCard({
  title,
  value,
  description,
  href,
  action,
  icon,
}: {
  title: string;
  value: ReactNode;
  description: string;
  href: string;
  action: string;
  icon: IconName;
}) {
  return (
    <Card className="ui-metric-card">
      <div className="ui-metric-heading">
        <h2>{title}</h2>
        <span className="ui-icon-tile">
          <Icon name={icon} />
        </span>
      </div>
      <strong className="ui-metric-value">{value}</strong>
      <p>{description}</p>
      <Link className="ui-card-action" href={href}>
        {action}
        <Icon name="arrow-right" />
      </Link>
    </Card>
  );
}
export function SectionTitle({
  children,
  icon,
}: {
  children: ReactNode;
  icon: IconName;
}) {
  return (
    <div className="ui-section-title">
      <span className="ui-icon-tile">
        <Icon name={icon} />
      </span>
      <h2>{children}</h2>
    </div>
  );
}
