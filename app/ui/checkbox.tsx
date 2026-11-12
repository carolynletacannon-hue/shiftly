import type { ComponentProps } from "react";
/** A real checkbox: native validation, Space key, form reset and checked state. */
export function Checkbox({
  className = "",
  ...props
}: Omit<ComponentProps<"input">, "type">) {
  return (
    <input {...props} type="checkbox" className={`ui-checkbox ${className}`} />
  );
}
