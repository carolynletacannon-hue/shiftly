import type { MetadataRoute } from "next";
import { publicOrigin } from "@/lib/public-site";
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin();
  return origin
    ? [{ url: `${origin}/`, changeFrequency: "monthly", priority: 1 }]
    : [];
}
