"use client";
import { useState } from "react";
import { Icon } from "@/app/ui/icons";
import {
  EMPLOYEE_COLORS,
  employeeColor,
  employeeColorStyle,
  type EmployeeColorKey,
} from "@/lib/scheduling/employee-colors";
export function EmployeeColorPicker({ current }: { current?: string | null }) {
  const [selected, setSelected] = useState<EmployeeColorKey>(
    employeeColor(current).key,
  );
  return (
    <fieldset className="employee-color-picker">
      <legend>Employee color</legend>
      <p>
        Used for this employee’s shifts in this workplace. Save employee to
        apply.
      </p>
      <div className="employee-color-options">
        {EMPLOYEE_COLORS.map((color) => (
          <label
            key={color.key}
            className="employee-color-option"
            style={employeeColorStyle(color.key)}
          >
            <input
              type="radio"
              name="color_key"
              value={color.key}
              checked={selected === color.key}
              onChange={() => setSelected(color.key)}
            />
            <span className="employee-color-dot" aria-hidden="true" />
            <span>{color.label}</span>
            {selected === color.key && (
              <Icon name="check" className="employee-color-selected" />
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
