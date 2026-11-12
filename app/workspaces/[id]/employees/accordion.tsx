"use client";
import { useId, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/app/ui/icons";

/** Scoped to employee cards; inert keeps collapsed controls out of the tab order. */
export function EmployeeAccordion({
  title,
  children,
  icon = "settings",
  warning = false,
}: {
  title: string;
  children: ReactNode;
  icon?: IconName;
  warning?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div
      className={`employee-accordion${warning ? " employee-accordion-warning" : ""}`}
      data-open={open}
      onInvalidCapture={(event) => {
        if (open) return;
        const input = event.target as HTMLInputElement;
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => {
          input.focus();
          input.reportValidity();
        });
      }}
    >
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          id={`${id}-trigger`}
          onClick={() => setOpen(!open)}
        >
          <Icon name={icon} />
          <span>{title}</span>
          <Icon name="chevron-down" className="employee-accordion-chevron" />
        </button>
      </h3>
      <div
        id={`${id}-panel`}
        className="employee-accordion-region"
        inert={!open}
        aria-hidden={!open}
        aria-labelledby={`${id}-trigger`}
      >
        <div>
          <div className="employee-accordion-body">{children}</div>
        </div>
      </div>
    </div>
  );
}
