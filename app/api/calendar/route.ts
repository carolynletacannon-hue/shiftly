import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { calendarEnabled, calendarOrigin } from "@/lib/calendar/token";
import { calendarHeaders, serveCalendar } from "@/lib/calendar/response";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    if (!calendarEnabled()) throw new Error("Calendar unavailable");
    const origin = calendarOrigin();
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
    return await serveCalendar(request, origin, async (token_digest) => {
      // Vercel overwrites this header; shared fallback is conservative off Vercel.
      const ip = request.headers.get("x-vercel-forwarded-for") || "shared";
      const request_bucket = createHash("sha256").update(ip).digest()[0];
      const { data, error } = await db.rpc("read_calendar_feed", {
        token_digest,
        request_bucket,
      });
      if (error || !data) throw new Error("Calendar unavailable");
      return data;
    });
  } catch {
    return new Response("Calendar unavailable.", {
      status: 503,
      headers: calendarHeaders,
    });
  }
}
