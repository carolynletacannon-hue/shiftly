import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { NextRequest } from "next/server";
import { POST } from "../app/api/kiosk/route";
import {
  digest,
  hashPin,
  kioskCookie,
  pinLookup,
  token,
} from "../lib/time-clock/security";
test("kiosk API: origin/cookie/flag gates, private PIN verification, rotation and narrow responses", async () => {
  const original = { ...process.env };
  const seen: {
    command: string;
    credential: string;
    payload: Record<string, string>;
  }[] = [];
  const org = "a0000000-0000-0000-0000-000000000001",
    employee = "a0000000-0000-0000-0000-000000000002",
    secret = token();
  const hash = hashPin("0123");
  let unknown = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/rest/v1/rpc/time_clock_kiosk");
    assert.equal(req.headers.authorization, "Bearer synthetic-service-key");
    let raw = "";
    for await (const part of req) raw += part;
    assert.ok(!raw.includes('"pin":"'));
    const body = JSON.parse(raw);
    seen.push(body);
    const data =
      body.command === "info"
        ? {
            org,
            name: "Synthetic Team",
            timezone: "America/Denver",
            now: "2026-11-01T08:00:00Z",
          }
        : body.command === "lookup"
          ? unknown
            ? { hash: "invalid" }
            : { hash, employee_id: employee }
          : body.command === "authorize"
            ? { name: "Example", status: "out" }
            : { ok: true };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  Object.assign(process.env, {
    TIME_CLOCK_ENABLED: "true",
    TIME_CLOCK_PIN_PEPPER: "synthetic-api-pepper-longer-than-32-characters",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${address.port}`,
    NEXT_PUBLIC_SITE_URL: "https://clock.example.test",
  });
  const call = (
    body: object,
    cookie = secret,
    origin = "https://clock.example.test",
  ) =>
    POST(
      new NextRequest("https://clock.example.test/api/kiosk", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          ...(cookie ? { cookie: `${kioskCookie}=${cookie}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  try {
    assert.equal((await call({ command: "info" }, "")).status, 401);
    assert.equal(
      (await call({ command: "info" }, secret, "https://other.example.test"))
        .status,
      403,
    );
    assert.equal(seen.length, 0);
    process.env.TIME_CLOCK_ENABLED = "false";
    assert.equal((await call({ command: "info" })).status, 404);
    process.env.TIME_CLOCK_ENABLED = "true";
    const info = await call({ command: "info" });
    assert.equal(info.headers.get("cache-control"), "private, no-store");
    assert.ok(!(await info.json()).org);
    const beforeInvalid = seen.length;
    for (const pin of [
      "",
      "12",
      "123",
      "12345",
      "123456",
      "12a4",
      "１２３４",
      1234,
    ]) {
      const invalid = await call({ command: "pin", pin });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, "Enter your four-digit PIN");
    }
    assert.equal(
      seen.length,
      beforeInvalid,
      "invalid PINs never reach the database",
    );
    const verified = await (await call({ command: "pin", pin: "0123" })).json();
    assert.equal(verified.name, "Example");
    assert.match(verified.challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!verified.hash && !verified.employee_id && !verified.org);
    const lookup = seen.find((r) => r.command === "lookup")!;
    assert.equal(lookup.payload.lookup_hash, pinLookup(org, "0123"));
    assert.ok(seen.every((r) => r.credential === digest(secret)));
    const authorized = seen.find((r) => r.command === "authorize")!;
    assert.equal(authorized.payload.verified_hash, hash);
    assert.equal(authorized.payload.challenge_hash, digest(verified.challenge));
    unknown = true;
    const failed = await call({ command: "pin", pin: "9999" });
    assert.equal(failed.status, 400);
    assert.match((await failed.json()).error, /PIN unavailable/);
    const punch = await call({
      command: "punch",
      challenge: verified.challenge,
      action: "in",
      request_id: "a0000000-0000-0000-0000-000000000003",
    });
    assert.equal(punch.status, 200);
    assert.equal(
      seen.at(-1)?.payload.challenge_hash,
      digest(verified.challenge),
    );
    const rotated = await call({ command: "rotate" });
    const cookie = rotated.headers.get("set-cookie") || "";
    assert.ok(
      cookie.includes("HttpOnly") &&
        cookie.includes("Secure") &&
        cookie.includes("SameSite=strict"),
    );
    assert.notEqual(seen.at(-1)?.payload.token_hash, digest(secret));
    const ended = await call({ command: "end" });
    assert.match(ended.headers.get("set-cookie") || "", /Max-Age=0/);
    assert.equal(
      (await call({ command: "lookup", lookup_hash: "untrusted" })).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
