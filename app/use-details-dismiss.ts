"use client";
import { useEffect, useRef } from "react";

/** Retain native disclosure semantics and Tab navigation for link menus. */
export function useDetailsDismiss(location?: string) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [location]);
  useEffect(() => {
    function dismiss(event: PointerEvent | KeyboardEvent | FocusEvent) {
      const details = ref.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        details.open = false;
        details.querySelector("summary")?.focus();
      } else if (event.target instanceof Node && !details.contains(event.target)) {
        details.open = false;
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, []);
  return ref;
}
