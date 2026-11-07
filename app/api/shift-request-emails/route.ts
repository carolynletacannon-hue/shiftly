import { timingSafeEqual } from "node:crypto";
import { deliverShiftEmails } from "@/lib/shift-requests/email";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (
    !secret ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    return new Response("Unauthorized", { status: 401 });
  const result = await deliverShiftEmails();
  return Response.json(result, { status: result.ok ? 200 : 503 });
}
