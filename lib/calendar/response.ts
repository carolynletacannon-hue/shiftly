import { calendarFeed, type CalendarEvent } from "./ical";
import { calendarTokenHash, validCalendarToken } from "./token";
export const calendarHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};
export async function serveCalendar(
  request: Request,
  origin: string,
  lookup: (
    hash: string,
  ) => Promise<{ status: string; events?: CalendarEvent[] }>,
) {
  const fail = (status: number) =>
    new Response(
      status === 429 ? "Please try again later." : "Calendar unavailable.",
      {
        status,
        headers: {
          ...calendarHeaders,
          ...(status === 429 ? { "Retry-After": "60" } : {}),
        },
      },
    );
  const tokens = new URL(request.url).searchParams.getAll("token");
  if (tokens.length !== 1 || !validCalendarToken(tokens[0])) return fail(404);
  try {
    // Only a digest crosses the database API. Never log request URLs or errors.
    const result = await lookup(calendarTokenHash(tokens[0]));
    if (result.status === "limited") return fail(429);
    if (result.status !== "ok") return fail(404);
    return new Response(calendarFeed(result.events || [], origin), {
      headers: {
        ...calendarHeaders,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="meadowmark.ics"',
      },
    });
  } catch {
    return fail(503);
  }
}
