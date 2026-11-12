import Link from "next/link";
import type { ComponentProps } from "react";
import { Icon, type IconName } from "./icons";
type VisualProps = {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  icon?: IconName;
};
function classes(className = "", variant?: VisualProps["variant"]) {
  const inferred = /\b(primary|secondary|danger|ghost)\b/.test(className)
    ? ""
    : "secondary";
  return `button ui-button ${variant || inferred} ${className}`;
}
export function Button({
  children,
  className,
  variant,
  icon,
  ...props
}: ComponentProps<"button"> & VisualProps) {
  return (
    <button className={classes(className, variant)} {...props}>
      {icon && <Icon name={icon} />}
      <span className="ui-button-label">{children}</span>
    </button>
  );
}
export function ButtonLink({
  children,
  className,
  variant,
  icon,
  ...props
}: ComponentProps<typeof Link> & VisualProps) {
  return (
    <Link className={classes(className, variant)} {...props}>
      {icon && <Icon name={icon} />}
      <span className="ui-button-label">{children}</span>
    </Link>
  );
}
