"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import {
  products,
  productDestination,
  type Product,
} from "@/lib/products/registry";

export function ProductIcon({ icon }: { icon: Product["icon"] }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icon === "calendar" ? (
        <>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2" />
        </>
      ) : icon === "messages" ? (
        <path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z" />
      ) : (
        <>
          <path d="M4 21V3h12v18m0-12h4v12M2 21h20M8 7h4m-4 4h4m-4 4h4m-3 6v-3h2v3" />
        </>
      )}
    </svg>
  );
}
export function ProductSwitcher({
  organizationId,
  onOpen,
}: {
  organizationId?: string;
  onOpen?: () => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function close(event: PointerEvent | KeyboardEvent) {
      if (!details.current?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        details.current.open = false;
        details.current.querySelector("summary")?.focus();
      } else if (!details.current.contains(event.target as Node))
        details.current.open = false;
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details
      className="product-switcher"
      ref={details}
      onToggle={(event) => {
        if (event.currentTarget.open) onOpen?.();
      }}
    >
      <summary aria-label="Meadowmark products">
        <ProductIcon icon="calendar" />
        <span>Workforce</span>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className="product-popover">
        <p className="eyebrow">ONE MEADOWMARK ACCOUNT</p>
        <p className="product-intro">Your workplace. More possibilities.</p>
        <ul>
          {products.map((product) => {
            const destination = productDestination(product, organizationId);
            const content = (
              <>
                <span className="product-icon">
                  <ProductIcon icon={product.icon} />
                </span>
                <span>
                  <strong>{product.name}</strong>
                  <small>{product.description}</small>
                  <span className="product-status">
                    {product.status === "available"
                      ? "Current product"
                      : "Coming Soon"}
                  </span>
                </span>
              </>
            );
            return (
              <li key={product.id}>
                {destination ? (
                  <Link
                    href={destination}
                    onClick={() => {
                      if (details.current) details.current.open = false;
                    }}
                  >
                    {content}
                  </Link>
                ) : (
                  <div className="product-preview-row">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="product-footer">
          Connect and Hospitality are in planning. Workforce is ready to use
          today.
        </p>
      </div>
    </details>
  );
}
