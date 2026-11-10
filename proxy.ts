import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    request.cookies.has("__Host-meadowmark-kiosk") &&
    path !== "/kiosk" &&
    !path.startsWith("/api/kiosk") &&
    !path.startsWith("/_next/") &&
    path !== "/icon.svg"
  ) {
    return NextResponse.redirect(new URL("/kiosk", request.url));
  }
  if (path === "/kiosk" || path.startsWith("/api/kiosk")) {
    const kioskResponse = NextResponse.next();
    kioskResponse.headers.set("Cache-Control", "private, no-store");
    kioskResponse.headers.set("X-Frame-Options", "DENY");
    return kioskResponse;
  }
  // Public bearer feed must never refresh sessions or enter auth telemetry.
  if (request.nextUrl.pathname === "/api/calendar") return NextResponse.next();
  let response = NextResponse.next({ request });
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  )
    return response;
  const client = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(values) {
          values.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          values.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );
  await client.auth.getUser();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|demo).*)"],
};
