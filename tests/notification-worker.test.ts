import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationEmailConfig } from "../lib/notifications/config";
import { deliverShiftEmails } from "../lib/shift-requests/email";
import { POST } from "../app/api/shift-request-emails/route";

const configured = {
  PHASE7_EMAIL_ENABLED: "true",
  VERCEL_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-key",
  GMAIL_USER: "fixture@gmail.com",
  GMAIL_APP_PASSWORD: "fixture-password",
  VERCEL_PROJECT_PRODUCTION_URL: "meadowmark.example.test",
};

test("worker origin: production fallback fixes missing site URL; reject unsafe explicit configuration", () => {
  assert.deepEqual(notificationEmailConfig(configured), {
    ok: true,
    origin: "https://meadowmark.example.test",
  });
  assert.deepEqual(
    notificationEmailConfig({
      ...configured,
      NEXT_PUBLIC_SITE_URL: "https://custom.example.test",
    }),
    { ok: true, origin: "https://custom.example.test" },
  );
  for (const value of [
    "http://localhost:3000",
    "http://example.test",
    "invalid",
    "https://user:pass@example.test",
    "https://example.test/path",
    "https://example.test/?private=x",
  ])
    assert.equal(
      notificationEmailConfig({ ...configured, NEXT_PUBLIC_SITE_URL: value })
        .ok,
      false,
    );
  assert.equal(
    notificationEmailConfig({
      ...configured,
      VERCEL_PROJECT_PRODUCTION_URL: "",
    }).ok,
    false,
  );
  assert.equal(
    notificationEmailConfig({ ...configured, PHASE7_EMAIL_ENABLED: "false" })
      .ok,
    false,
  );
  for (const VERCEL_ENV of [undefined, "development", "preview"])
    assert.deepEqual(notificationEmailConfig({ ...configured, VERCEL_ENV }), {
      ok: false,
      reason: "non_production",
    });
  const missing = notificationEmailConfig({
    ...configured,
    GMAIL_APP_PASSWORD: "",
  });
  assert.deepEqual(missing, {
    ok: false,
    reason: "missing_configuration",
    missing: ["GMAIL_APP_PASSWORD"],
  });
});

test("worker and protected endpoint report configuration/claim failures without exposing private errors", async (t) => {
  const keys = [
    ...Object.keys(configured),
    "NEXT_PUBLIC_SITE_URL",
    "CRON_SECRET",
  ];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const logs: unknown[][] = [];
  t.mock.method(console, "info", (...args: unknown[]) => logs.push(args));
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  const calls: { url: string; body: string }[] = [];
  let fail = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      calls.push({ url: String(url), body: String(options.body) });
      return new Response(
        JSON.stringify(
          fail
            ? {
                code: "42501",
                message: "PRIVATE fixture-password fixture@gmail.com",
              }
            : [],
        ),
        {
          status: fail ? 403 : 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  try {
    Object.assign(process.env, configured);
    delete process.env.NEXT_PUBLIC_SITE_URL;
    process.env.CRON_SECRET = "fixture-secret";
    assert.equal(
      (await POST(new Request("https://example.test", { method: "POST" })))
        .status,
      401,
    );
    assert.equal(calls.length, 0);
    delete process.env.GMAIL_APP_PASSWORD;
    assert.equal((await deliverShiftEmails()).ok, false);
    assert.equal(calls.length, 0);
    process.env.GMAIL_APP_PASSWORD = configured.GMAIL_APP_PASSWORD;
    const empty = await deliverShiftEmails(
      "11111111-1111-1111-1111-111111111111",
    );
    assert.equal(empty.ok, true);
    assert.match(calls[0].url, /rpc\/claim_workspace_notification_emails$/);
    assert.deepEqual(JSON.parse(calls[0].body), {
      workspace: "11111111-1111-1111-1111-111111111111",
    });
    fail = true;
    const response = await POST(
      new Request("https://example.test", {
        method: "POST",
        headers: { authorization: "Bearer fixture-secret" },
      }),
    );
    assert.equal(response.status, 503);
    assert.match(calls[1].url, /rpc\/claim_shift_emails$/);
    assert.ok(JSON.stringify(logs).includes("claim_failed"));
    assert.ok(!JSON.stringify(logs).includes("PRIVATE"));
    for (const privateValue of [
      "fixture-password",
      "fixture-key",
      "fixture@gmail.com",
      "fixture-secret",
    ])
      assert.ok(!JSON.stringify(logs).includes(privateValue));
    process.env.VERCEL_ENV = "preview";
    assert.equal((await deliverShiftEmails()).ok, false);
    assert.equal(calls.length, 2);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test("SMTP acceptance and acknowledgement failures have distinct counts and private logs", async (t) => {
  const { deliverNotificationBatch } = await import(
    "../lib/notifications/delivery"
  );
  const logs: unknown[][] = [];
  for (const method of ["info", "error"] as const)
    t.mock.method(console, method, (...args: unknown[]) => logs.push(args));
  const jobs = ["a", "b"].map((id) => ({
    id,
    user_id: "fixture-user",
    organization_id: "fixture-org",
    claim_token: `private-${id}`,
    message: "private-message",
  }));
  const result = await deliverNotificationBatch(
    {
      claim: async () => jobs,
      prepare: async (item) => ({
        ...item,
        email: "private@example.test",
        url: "https://example.test/workspaces/fixture-org/notifications",
      }),
      finish: async (item) => {
        if (item.id === "a") throw Error("private-error");
      },
    },
    async () => ({ status: "accepted" }),
  );
  assert.equal(result.accepted, 1);
  assert.equal(result.acknowledgementFailed, 1);
  assert.equal(result.acknowledged, 1);
  assert.ok(!JSON.stringify(logs).includes("private-"));
  assert.ok(!JSON.stringify(logs).includes("private@example.test"));
});
