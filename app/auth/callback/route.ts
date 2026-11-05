import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/server";
import { safeNext } from "@/lib/forms";
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const db = await supabase();
    const { error } = await db.auth.exchangeCodeForSession(code);
    if (!error)
      return NextResponse.redirect(
        new URL(
          safeNext(request.nextUrl.searchParams.get("next")),
          request.url,
        ),
      );
  }
  return NextResponse.redirect(
    new URL(
      "/login?message=Link+expired+or+invalid.+Please+try+again.",
      request.url,
    ),
  );
}
