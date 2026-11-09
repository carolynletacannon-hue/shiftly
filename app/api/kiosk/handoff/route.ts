import { NextResponse } from "next/server";
export function GET(req: Request) {
  // Hard navigation drops the authenticated React router cache. Clear cached pages
  // and browser storage without clearing the isolated HttpOnly kiosk cookie.
  const response = NextResponse.redirect(new URL("/kiosk", req.url), 303);
  response.headers.set("Clear-Site-Data", '"cache", "storage"');
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
