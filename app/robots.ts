import type { MetadataRoute } from "next";
import { publicOrigin } from "@/lib/public-site";
export default function robots(): MetadataRoute.Robots {
  const origin = publicOrigin();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/workspaces",
        "/onboarding",
        "/invite",
        "/api/",
        "/auth/",
        "/login",
        "/signup",
        "/reset-password",
        "/forgot-password",
        "/demo",
      ],
    },
    ...(origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
