import type { CSSProperties } from "react";
/** Store palette keys, never user-supplied CSS. Colors are a current workplace
 * roster preference, not part of an immutable published shift snapshot. */
export const EMPLOYEE_COLORS = [
  {
    key: "sage",
    label: "Sage",
    tone: "#386A51",
    tint: "#EAF3ED",
    ink: "#244B36",
  },
  {
    key: "blue",
    label: "Blue",
    tone: "#3467A0",
    tint: "#EBF2FB",
    ink: "#264C77",
  },
  {
    key: "purple",
    label: "Purple",
    tone: "#7955A0",
    tint: "#F2EDF8",
    ink: "#5B3C7E",
  },
  {
    key: "coral",
    label: "Coral",
    tone: "#B05244",
    tint: "#FBEFEC",
    ink: "#813D33",
  },
  {
    key: "amber",
    label: "Amber",
    tone: "#94650D",
    tint: "#FBF4E4",
    ink: "#67470B",
  },
  {
    key: "teal",
    label: "Teal",
    tone: "#24766F",
    tint: "#E7F4F1",
    ink: "#1D5852",
  },
  {
    key: "pink",
    label: "Pink",
    tone: "#A54F78",
    tint: "#FAEDF3",
    ink: "#7B3657",
  },
  {
    key: "slate",
    label: "Slate",
    tone: "#576B7F",
    tint: "#EDF1F5",
    ink: "#3E5062",
  },
] as const;
export type EmployeeColorKey = (typeof EMPLOYEE_COLORS)[number]["key"];
export function isEmployeeColorKey(value: unknown): value is EmployeeColorKey {
  return (
    typeof value === "string" &&
    EMPLOYEE_COLORS.some((color) => color.key === value)
  );
}
export function employeeColor(value?: string | null) {
  return (
    EMPLOYEE_COLORS.find((color) => color.key === value) || EMPLOYEE_COLORS[0]
  );
}
export function employeeColorStyle(value?: string | null): CSSProperties {
  const color = employeeColor(value);
  return {
    "--employee-tone": color.tone,
    "--employee-tint": color.tint,
    "--employee-ink": color.ink,
  } as CSSProperties;
}
