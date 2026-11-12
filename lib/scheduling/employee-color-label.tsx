import { employeeColor, employeeColorStyle } from "./employee-colors";
export function EmployeeColorSwatch({ color }: { color?: string | null }) {
  const palette = employeeColor(color);
  return (
    <span
      className="employee-color-swatch"
      data-employee-color={palette.key}
      style={employeeColorStyle(color)}
      role="img"
      aria-label={`${palette.label} employee color`}
      title={`${palette.label} employee color`}
    />
  );
}
export function EmployeeColorLabel({
  name,
  color,
  className = "",
}: {
  name: string;
  color?: string | null;
  className?: string;
}) {
  return (
    <span
      className={`employee-color-label ${className}`}
      data-employee-color={employeeColor(color).key}
      style={employeeColorStyle(color)}
    >
      <span className="employee-color-dot" aria-hidden="true" />
      <span>{name}</span>
    </span>
  );
}
