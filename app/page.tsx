import type { Metadata } from "next";
import { supabase } from "@/lib/supabase/server";
import { publicOrigin } from "@/lib/public-site";
import { MarketingHome } from "./marketing";
export const dynamic = "force-dynamic";
const title = "Meadowmark | Simple Employee Scheduling for Small Businesses";
const description =
  "Less time scheduling. More time running your business. Plan weekly schedules, manage time off, and coordinate your team with Meadowmark.";
export const metadata: Metadata = {
  title,
  description,
  robots: { index: true, follow: true },
  alternates: publicOrigin() ? { canonical: publicOrigin() } : undefined,
  openGraph: {
    title,
    description,
    type: "website",
    ...(publicOrigin() ? { url: publicOrigin() } : {}),
  },
};
export default async function Home() {
  let signedIn = false;
  if (
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ) {
    try {
      const db = await supabase();
      const {
        data: { user },
        error,
      } = await db.auth.getUser();
      signedIn = !error && !!user;
    } catch {
      // Public content remains usable when authentication is temporarily unavailable.
    }
  }
  return <MarketingHome signedIn={signedIn} />;
}
