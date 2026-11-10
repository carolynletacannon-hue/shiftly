import { NextRequest, NextResponse } from "next/server";
import { clockService } from "@/lib/time-clock/server";
import {
  digest,
  kioskCookie,
  kioskCookieMaxAge,
  nextKioskToken,
  pinLookup,
  timeClockEnabled,
  token,
  validToken,
  verifyPin,
} from "@/lib/time-clock/security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};
export async function POST(req: NextRequest) {
  // Compare with this deployment, not the canonical marketing/login domain.
  // Do not trust forwarded headers or allow arbitrary *.vercel.app origins.
  if (
    req.headers.get("origin") !== req.nextUrl.origin ||
    req.headers.get("sec-fetch-site") === "cross-site"
  )
    return NextResponse.json(
      { error: "Request unavailable" },
      { status: 403, headers },
    );
  let ending = false;
  if (Number(req.headers.get("content-length") || 0) <= 2048) {
    try {
      const raw = await req.clone().text();
      ending = raw.length <= 2048 && JSON.parse(raw).command === "end";
    } catch {
      // The normal handler reports malformed requests.
    }
  }
  const result = await handle(req, ending);
  if (!ending) return result;
  // Local exit must work even if disabled, expired, revoked, or offline.
  // The handler still attempts to revoke a usable credential first.
  const response = NextResponse.json({ ok: true }, { headers });
  response.cookies.set(kioskCookie, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  // Never restore an authenticated manager session when leaving a shared kiosk.
  for (const { name } of req.cookies.getAll()) {
    if (/^sb-.+-auth-token(?:\.\d+)?$/.test(name))
      response.cookies.set(name, "", {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      });
  }
  response.headers.set("Clear-Site-Data", '"cache", "storage"');
  return response;
}
async function handle(req: NextRequest, ending = false) {
  if (!timeClockEnabled() && !ending)
    return NextResponse.json(
      { error: "Time clock unavailable" },
      { status: 404, headers },
    );
  const secret = req.cookies.get(kioskCookie)?.value || "";
  if (!validToken(secret)) {
    const response = NextResponse.json(
      { error: "Kiosk authorization required" },
      { status: 401, headers },
    );
    // Clearing a broken/expired local cookie grants no authority.
    if (req.cookies.has(kioskCookie))
      response.cookies.set(kioskCookie, "", {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        maxAge: 0,
      });
    return response;
  }
  if (Number(req.headers.get("content-length") || 0) > 2048)
    return NextResponse.json(
      { error: "Request too large" },
      { status: 413, headers },
    );
  try {
    const raw = await req.text();
    if (raw.length > 2048)
      return NextResponse.json(
        { error: "Request too large" },
        { status: 413, headers },
      );
    const body = JSON.parse(raw);
    const db = clockService();
    const call = async (command: string, payload: object = {}) => {
      const { data, error } = await db.rpc("time_clock_kiosk", {
        credential: digest(secret),
        command,
        payload,
      });
      if (error || !data) throw Error("Unavailable");
      return data;
    };
    let result;
    let rotated: string | undefined;
    if (body.command === "pin") {
      if (typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin))
        return NextResponse.json(
          { error: "Enter your four-digit PIN" },
          { status: 400, headers },
        );
      const info = await call("info");
      if (info.error) result = info;
      else {
        const found = await call("lookup", {
          lookup_hash: pinLookup(info.org, body.pin),
        });
        if (found.error) result = found;
        else {
          const verified = verifyPin(body.pin, found.hash || "invalid");
          if (!verified || !found.employee_id)
            result = {
              error: "PIN unavailable. Wait and try again or ask your manager",
            };
          else {
            const challenge = token();
            result = await call("authorize", {
              employee_id: found.employee_id,
              verified_hash: found.hash,
              challenge_hash: digest(challenge),
            });
            if (!result.error) result.challenge = challenge;
          }
        }
      }
    } else if (body.command === "punch") {
      if (
        !validToken(body.challenge || "") ||
        !/^[0-9a-f-]{36}$/i.test(body.request_id || "") ||
        !["in", "out", "break_start", "break_end"].includes(body.action)
      )
        return NextResponse.json(
          { error: "Enter your PIN again" },
          { status: 400, headers },
        );
      result = await call("punch", {
        action: body.action,
        request_id: body.request_id,
        challenge_hash: digest(body.challenge),
      });
    } else if (body.command === "rotate") {
      rotated = nextKioskToken(secret);
      result = await call("rotate", { token_hash: digest(rotated) });
    } else if (["info", "end"].includes(body.command)) {
      result = await call(body.command);
      delete result.org;
    } else
      return NextResponse.json(
        { error: "Unknown action" },
        { status: 400, headers },
      );
    const response = NextResponse.json(result, {
      status: result.error ? 400 : 200,
      headers,
    });
    if (rotated && !result.error)
      response.cookies.set(kioskCookie, rotated, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        maxAge: kioskCookieMaxAge,
      });
    if (body.command === "end")
      response.cookies.set(kioskCookie, "", {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        maxAge: 0,
      });
    return response;
  } catch {
    return NextResponse.json(
      { error: "Time clock unavailable. Please retry or ask your manager." },
      { status: 503, headers },
    );
  }
}
