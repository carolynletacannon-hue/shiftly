"use client";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Icon } from "./icons";
function parse(value?: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}
function format(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function DatePicker({
  value,
  defaultValue,
  onChange,
  className,
  ...props
}: Omit<ComponentProps<"input">, "type">) {
  const native = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(String(defaultValue || ""));
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("date");
  const [disabled, setDisabled] = useState(!!props.disabled);
  const current = value === undefined ? selected : String(value);
  useEffect(() => {
    const input = native.current!;
    setReady(true);
    const parent = input.labels?.[0];
    if (parent)
      setLabel(
        Array.from(parent.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(" ")
          .trim() || "date",
      );
    const sync = () => setDisabled(input.matches(":disabled"));
    sync();
    const observer = new MutationObserver(sync);
    for (let el: Element | null = input; el; el = el.parentElement)
      if (el === input || el.tagName === "FIELDSET")
        observer.observe(el, {
          attributes: true,
          attributeFilter: ["disabled"],
        });
    const reset = () => requestAnimationFrame(() => setSelected(input.value));
    input.form?.addEventListener("reset", reset);
    return () => {
      observer.disconnect();
      input.form?.removeEventListener("reset", reset);
    };
  }, []);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <span
      className={`ui-date-field ${className || ""}`}
      data-enhanced={ready || undefined}
    >
      <input
        {...props}
        ref={native}
        type="date"
        className="ui-date-input"
        value={value}
        defaultValue={defaultValue}
        onChange={(event) => {
          setSelected(event.target.value);
          onChange?.(event);
        }}
      />
      {ready && (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="ui-date-trigger"
              aria-label={`Choose ${label}`}
              disabled={disabled}
            >
              <Icon name="calendar" />
            </button>
          </Popover.Trigger>
          <Popover.Portal
            container={native.current?.closest("dialog") || undefined}
          >
            <Popover.Content
              className="ui-calendar-popover"
              aria-label={`Choose ${label}`}
              sideOffset={8}
              collisionBoundary={native.current?.closest("dialog") || undefined}
              collisionPadding={12}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
              }}
            >
              <DayPicker
                mode="single"
                selected={parse(current)}
                defaultMonth={parse(current)}
                autoFocus
                showOutsideDays
                weekStartsOn={0}
                disabled={[
                  ...(props.min ? [{ before: parse(String(props.min))! }] : []),
                  ...(props.max ? [{ after: parse(String(props.max))! }] : []),
                ]}
                onSelect={(date) => {
                  if (!date || native.current?.matches(":disabled")) return;
                  const input = native.current!;
                  const next = format(date);
                  const setter = Object.getOwnPropertyDescriptor(
                    HTMLInputElement.prototype,
                    "value",
                  )!.set!;
                  setter.call(input, next);
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                  input.dispatchEvent(new Event("change", { bubbles: true }));
                  setSelected(next);
                  setOpen(false);
                }}
              />
              <div className="ui-calendar-footer">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    native.current?.focus();
                  }}
                >
                  Type a date instead
                </button>
                <Popover.Close aria-label="Close calendar">
                  <Icon name="close" />
                </Popover.Close>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </span>
  );
}
