"use client";
import * as SelectPrimitive from "@radix-ui/react-select";
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Icon } from "./icons";
type Option = {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
};
function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join("");
}
function optionsFrom(children: ReactNode, group?: string): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<ComponentProps<"option"> & { label?: string }>(child))
      return [];
    if (child.type === Fragment)
      return optionsFrom(child.props.children, group);
    if (child.type === "optgroup")
      return optionsFrom(child.props.children, child.props.label);
    if (child.type !== "option") return [];
    const label = child.props.label || text(child.props.children);
    return [
      {
        value: String(child.props.value ?? label),
        label,
        disabled: child.props.disabled,
        group,
      },
    ];
  });
}
// Empty HTML option values are meaningful to forms; Radix reserves an empty
// string for its placeholder. Only the presentation uses this private encoding.
const EMPTY = "__meadowmark_empty_option__";
export function Select({
  children,
  value,
  defaultValue,
  onChange,
  className,
  id,
  ...props
}: Omit<ComponentProps<"select">, "multiple" | "size">) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = optionsFrom(children);
  const [selected, setSelected] = useState(
    String(defaultValue ?? options.find((o) => !o.disabled)?.value ?? ""),
  );
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [label, setLabel] = useState(props["aria-label"]);
  const [disabled, setDisabled] = useState(!!props.disabled);
  const current = value === undefined ? selected : String(value);
  useEffect(() => {
    const element = native.current!;
    setSelected(element.value);
    const parentLabel = element.labels?.[0];
    if (!props["aria-label"] && parentLabel) {
      setLabel(
        Array.from(parentLabel.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(" ")
          .trim(),
      );
    }
    setReady(true);
    const syncDisabled = () => setDisabled(element.matches(":disabled"));
    syncDisabled();
    const observer = new MutationObserver(syncDisabled);
    for (
      let ancestor: Element | null = element;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (ancestor === element || ancestor.tagName === "FIELDSET")
        observer.observe(ancestor, {
          attributes: true,
          attributeFilter: ["disabled"],
        });
    }
    function reset() {
      setInvalid(false);
      requestAnimationFrame(() => setSelected(element.value));
    }
    element.form?.addEventListener("reset", reset);
    return () => {
      observer.disconnect();
      element.form?.removeEventListener("reset", reset);
    };
  }, [props["aria-label"]]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const optionValues = options.map((option) => option.value).join("\u0000");
  useEffect(() => {
    if (value === undefined && native.current)
      setSelected(native.current.value);
  }, [optionValues, value]);
  function choose(encoded: string) {
    if (native.current?.matches(":disabled")) return;
    setInvalid(false);
    const next = encoded === EMPTY ? "" : encoded;
    const element = native.current!;
    // Dispatch through the original select so React handlers and FormData retain
    // the exact existing field names, values and ChangeEvent semantics.
    element.value = next;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return (
    <span
      className={`ui-select-field ${className || ""}`}
      data-enhanced={ready || undefined}
    >
      {ready && (
        <SelectPrimitive.Root
          open={open}
          onOpenChange={setOpen}
          value={current || EMPTY}
          onValueChange={choose}
          disabled={disabled}
        >
          <SelectPrimitive.Trigger
            ref={trigger}
            id={inputId}
            className="ui-select-trigger"
            aria-label={label || props.name || "Choose an option"}
            aria-labelledby={props["aria-labelledby"]}
            aria-describedby={
              [
                props["aria-describedby"],
                invalid ? `${inputId}-error` : undefined,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            aria-invalid={props["aria-invalid"] || invalid || undefined}
            aria-required={props.required}
          >
            <SelectPrimitive.Value />
            <SelectPrimitive.Icon>
              <Icon name="chevron-down" />
            </SelectPrimitive.Icon>
          </SelectPrimitive.Trigger>
          <SelectPrimitive.Portal
            container={native.current?.closest("dialog") || undefined}
          >
            <SelectPrimitive.Content
              position="popper"
              sideOffset={6}
              collisionBoundary={native.current?.closest("dialog") || undefined}
              collisionPadding={12}
              className="ui-select-content"
              style={{ zIndex: 100 }}
            >
              <SelectPrimitive.ScrollUpButton className="ui-select-scroll">
                <Icon
                  name="chevron-down"
                  style={{ transform: "rotate(180deg)" }}
                />
              </SelectPrimitive.ScrollUpButton>
              <SelectPrimitive.Viewport className="ui-select-viewport">
                {options.map((option, index) => (
                  <SelectPrimitive.Item
                    key={`${option.value}-${index}`}
                    value={option.value || EMPTY}
                    disabled={option.disabled}
                    textValue={option.label}
                    className="ui-select-item"
                  >
                    <SelectPrimitive.ItemText>
                      {option.label}
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator>
                      <Icon name="check" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Viewport>
              <SelectPrimitive.ScrollDownButton className="ui-select-scroll">
                <Icon name="chevron-down" />
              </SelectPrimitive.ScrollDownButton>
            </SelectPrimitive.Content>
          </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
      )}
      <select
        {...props}
        ref={native}
        id={ready ? `${inputId}-native` : inputId}
        className={ready ? "ui-native-select" : className}
        aria-hidden={ready || undefined}
        tabIndex={ready ? -1 : props.tabIndex}
        value={value === undefined ? undefined : value}
        defaultValue={value === undefined ? defaultValue : undefined}
        onChange={(event) => {
          if (value === undefined) setSelected(event.target.value);
          onChange?.(event);
        }}
        onInvalid={(event) => {
          props.onInvalid?.(event);
          if (ready) {
            event.preventDefault();
            trigger.current?.focus();
            setInvalid(true);
          }
        }}
      >
        {children}
      </select>
      {invalid && (
        <span className="ui-field-error" id={`${inputId}-error`} role="alert">
          {native.current?.validationMessage || "Choose an option."}
        </span>
      )}
    </span>
  );
}
