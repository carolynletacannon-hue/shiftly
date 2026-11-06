import { deliverShiftEmails } from "@/lib/shift-requests/email";
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return new Response("Unauthorized", { status: 401 });
  await deliverShiftEmails();
  return Response.json({ ok: true });
}
