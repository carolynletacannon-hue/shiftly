/* Local HTTP fixture only: no real Supabase project, mail, or calendar tokens. */
const { createServer } = require("node:http");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { chromium } = (() => {
  try {
    return require("playwright");
  } catch {
    return require("../../work/browser-tools/node_modules/playwright");
  }
})();
const path = require("node:path");
const fs = require("node:fs");
const org = "00000000-0000-0000-0000-000000000001";
const owner = "00000000-0000-0000-0000-000000000002";
const employee = "00000000-0000-0000-0000-000000000003";
const user = (id) => ({
  id,
  aud: "authenticated",
  role: "authenticated",
  email: "sample@example.test",
  email_confirmed_at: new Date().toISOString(),
  app_metadata: {},
  user_metadata: {},
});
const requests = [];
const fixture = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let id = owner;
  try {
    id = JSON.parse(
      Buffer.from((req.headers.authorization || "").split(".")[1], "base64url"),
    ).sub;
  } catch {}
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/auth/v1/user")
    return res.end(JSON.stringify(user(id)));
  requests.push(url);
  const table = url.pathname.split("/").pop();
  const single = (req.headers.accept || "").includes("vnd.pgrst.object");
  let result = [];
  if (table === "memberships")
    result =
      url.searchParams.get("organization_id") === `eq.${org}`
        ? [
            {
              user_id: id,
              role: id === employee ? "employee" : "owner",
              profiles: { display_name: "Sample member" },
            },
          ]
        : [];
  if (table === "organizations")
    result = [
      {
        name: "Sample workplace",
        timezone: "America/Denver",
        settings: { week_starts_on: 0 },
      },
    ];
  if (table === "employees" && id === employee)
    result = [
      {
        id: employee,
        user_id: employee,
        display_name: "Sample team member",
        archived_at: null,
      },
    ];
  if (table === "notifications") result = { unread: 0 };
  if (req.method === "HEAD") res.setHeader("Content-Range", "*/0");
  if (single && !result.length) {
    res.statusCode = 406;
    return res.end(
      JSON.stringify({
        code: "PGRST116",
        details: "The result contains 0 rows",
        message: "No rows",
      }),
    );
  }
  res.end(JSON.stringify(single ? result[0] : result));
});
function session(id) {
  const jwt = [
    "eyJhbGciOiJIUzI1NiJ9",
    Buffer.from(
      JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url"),
    "fixture",
  ].join(".");
  return (
    "base64-" +
    Buffer.from(
      JSON.stringify({
        access_token: jwt,
        refresh_token: "local-fixture",
        token_type: "bearer",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: user(id),
      }),
    ).toString("base64url")
  );
}
(async () => {
  await new Promise((resolve) => fixture.listen(54321, "127.0.0.1", resolve));
  const log = fs.openSync("work/browser-server.log", "w");
  const app = spawn(
    "node",
    ["node_modules/next/dist/bin/next", "dev", "-p", "3100"],
    {
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        XDG_CONFIG_HOME: "/workspace/.config",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-fixture-key",
        NEXT_PUBLIC_SITE_URL: "http://localhost:3100",
        PHASE7_EMAIL_ENABLED: "false",
        CALENDAR_FEEDS_ENABLED: "false",
        SUPABASE_SERVICE_ROLE_KEY: "",
        VERCEL_ENV: "preview",
      },
      stdio: ["ignore", log, log],
    },
  );
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch("http://localhost:3100")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    browser = await chromium.launch({
      executablePath:
        process.env.BROWSER_EXECUTABLE_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const axePath =
      process.env.AXE_CORE_PATH ||
      path.resolve("work/browser-tools/node_modules/axe-core/axe.min.js");
    const auditFailures = [];
    async function audit(label) {
      await page.addScriptTag({ path: axePath });
      const violations = await page.evaluate(async () =>
        (
          await window.axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          })
        ).violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
      );
      if (violations.length) {
        auditFailures.push({ label, violations });
        console.error(JSON.stringify({ label, violations }));
      }
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${label} overflow`,
      );
    }
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("http://localhost:3100");
      await page.getByRole("heading", { level: 1 }).waitFor();
      await audit(`homepage ${width}`);
      await page.screenshot({
        path: `work/homepage-${width}.png`,
        fullPage: true,
      });
      if (width < 800) {
        await page.locator(".public-mobile summary").click();
        await page
          .getByRole("navigation", { name: "Mobile public navigation" })
          .getByRole("link", { name: "Sign In", exact: true })
          .click();
        await page.waitForURL("**/login");
      } else {
        await page
          .getByRole("navigation", { name: "Public navigation", exact: true })
          .getByRole("link", { name: "Sign In", exact: true })
          .click();
        await page.waitForURL("**/login");
      }
      await audit(`login ${width}`);
      await page.goto("http://localhost:3100/signup?next=%2Fonboarding");
      await page.getByLabel("Your name").waitFor();
      await audit(`signup ${width}`);
      assert.equal(
        await page
          .getByLabel("Password", { exact: true })
          .getAttribute("minlength"),
        "12",
      );
    }
    await page.goto(`http://localhost:3100/workspaces/${org}`);
    await page.waitForURL("**/login");
    await page.goto("http://localhost:3100/invite?token=invalid");
    await page
      .getByRole("heading", { name: "Let’s get you a fresh invitation" })
      .waitFor();
    await audit("invalid invitation");
    await page.goto("http://localhost:3100/invite?token=" + "a".repeat(64));
    assert.ok(
      (
        await page
          .getByRole("link", { name: "create an account" })
          .getAttribute("href")
      ).includes("%2Finvite%3Ftoken"),
    );
    for (const id of [owner, employee]) {
      await context.addCookies([
        {
          name: "sb-127-auth-token",
          value: session(id),
          domain: "localhost",
          path: "/",
        },
      ]);
      await page.goto("http://localhost:3100");
      await page
        .locator(".public-desktop")
        .getByRole("link", {
          name: "Go to Dashboard",
          exact: true,
          includeHidden: true,
        })
        .waitFor({ state: "attached" });
      await page.goto(`http://localhost:3100/workspaces/${org}`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      assert.ok(
        (await page.getByRole("heading", { level: 1 }).innerText()).includes(
          id === owner ? "clarity" : "Meadowmark",
        ),
      );
      await page.setViewportSize({ width: 375, height: 1000 });
      await audit(id === owner ? "manager dashboard" : "employee dashboard");
      await page.getByRole("button", { name: "Menu" }).click();
      assert.equal(
        await page
          .getByRole("button", { name: "Menu" })
          .getAttribute("aria-expanded"),
        "true",
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page
          .getByRole("button", { name: "Menu" })
          .getAttribute("aria-expanded"),
        "false",
      );
      if (id === owner) {
        await page.getByRole("button", { name: "Skip for now" }).click();
        await page.reload();
        await page
          .getByRole("button", { name: "Show getting-started checklist" })
          .waitFor();
        await page
          .getByRole("button", { name: "Show getting-started checklist" })
          .click();
        await page
          .getByRole("heading", { name: "Make yourself at home" })
          .waitFor();
        await page.goto("http://localhost:3100/onboarding");
        await page.getByLabel("Business name").waitFor();
        await audit("business setup");
      } else {
        assert.equal(
          await page.getByRole("link", { name: "Manage employees" }).count(),
          0,
        );
        await page.goto(`http://localhost:3100/workspaces/${org}/schedule`);
        await page.waitForURL("**/workspaces?message=Workspace*");
      }
      const screens =
        id === owner
          ? [
              "schedule",
              "employees",
              "time-off",
              "shift-requests",
              "notifications",
              "admin",
              "my-schedule",
            ]
          : ["my-schedule", "time-off", "shift-requests", "notifications"];
      for (const screen of screens) {
        await page.goto(`http://localhost:3100/workspaces/${org}/${screen}`);
        await page.locator(".app-header").waitFor();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll("h1")).some((h) =>
              h.textContent.includes("Loading"),
            ),
        );
        assert.ok(
          !(await page.getByRole("heading", { level: 1 }).innerText()).includes(
            "couldn’t",
          ),
          screen,
        );
        await audit(
          `${id === owner ? "manager" : "employee"} ${screen} mobile`,
        );
      }
    }
    assert.ok(
      requests
        .filter((u) =>
          [
            "schedules",
            "published_shifts",
            "time_off_requests",
            "shift_requests",
            "shift_notifications",
            "employees",
          ].includes(u.pathname.split("/").pop()),
        )
        .every((u) => u.searchParams.get("organization_id") === `eq.${org}`),
    );
    assert.deepEqual(auditFailures, [], "accessibility across all screens");
    console.log(
      "PASS: responsive homepage, CTAs, forms, invitation guidance, protected routing, role dashboards, onboarding dismissal, mobile menu, scoped dashboard queries, WCAG A/AA axe checks. Local mocked Supabase only.",
    );
  } finally {
    if (browser) await browser.close();
    app.kill("SIGTERM");
    fixture.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
