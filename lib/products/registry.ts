/** Public presentation metadata only. Availability never grants authorization. */
type ProductDefinition = {
  id: string;
  name: string;
  description: string;
  icon: "calendar" | "messages" | "building";
} & (
  | { status: "available"; entryPath: "/workspaces" }
  | { status: "coming-soon"; entryPath: null }
);
export const products = [
  {
    id: "workforce",
    name: "Meadowmark Workforce",
    description: "Scheduling, people, and time off for your workplace.",
    icon: "calendar",
    status: "available",
    entryPath: "/workspaces",
  },
  {
    id: "connect",
    name: "Meadowmark Connect",
    description:
      "A future home for team messaging and workplace communication.",
    icon: "messages",
    status: "coming-soon",
    entryPath: null,
  },
  {
    id: "hospitality",
    name: "Meadowmark Hospitality",
    description: "A future home for hotel operations and hospitality teams.",
    icon: "building",
    status: "coming-soon",
    entryPath: null,
  },
] as const satisfies readonly ProductDefinition[];
export type Product = (typeof products)[number];
export type ProductId = Product["id"];
export function productDestination(
  product: Product,
  organizationId?: string,
): string | null {
  if (product.status !== "available") return null;
  return organizationId
    ? `${product.entryPath}/${encodeURIComponent(organizationId)}`
    : product.entryPath;
}
