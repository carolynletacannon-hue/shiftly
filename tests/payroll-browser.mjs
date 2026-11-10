// Local HTTP fixtures exercise SSR/navigation/actions. Real SQL permissions are tested separately.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const org = "00000000-0000-0000-0000-000000000001",
  owner = "00000000-0000-0000-0000-000000000002",
  employee = "00000000-0000-0000-0000-000000000003";
const user = (id) => ({
  id,
  aud: "authenticated",
  role: "authenticated",
  email: "synthetic@example.test",
  app_metadata: {},
  user_metadata: {},
});
const fixture = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  const url = new URL(req.url, "http://localhost");
  let id = owner;
  try {
    id = JSON.parse(
      Buffer.from((req.headers.authorization || "").split(".")[1], "base64url"),
    ).sub;
  } catch {}
  if (url.pathname === "/auth/v1/user")
    return res.end(JSON.stringify(user(id)));
  const table = url.pathname.split("/").at(-1),
    single = (req.headers.accept || "").includes("vnd.pgrst.object");
  let data = [];
  if (table === "memberships")
    data = [
      {
        role: id === owner ? "owner" : "employee",
        organizations: { name: "Synthetic Meadow Team" },
      },
    ];
  if (table === "organizations")
    data = [{ name: "Synthetic Meadow Team", timezone: "America/Denver" }];
  if (table === "payroll_input")
    data = {
      settings: {
        frequency: "weekly",
        anchor: "2026-01-05",
        timezone: "America/Denver",
        workweek_day: 1,
        workweek_time: "00:00:00",
        rule: "federal-weekly-confirmed",
        employee_access: true,
      },
      employees: [
        {
          id: employee,
          user_id: employee,
          display_name: "Synthetic Team Member",
          archived_at: null,
        },
      ],
      rates: [
        {
          id: "rate",
          employee_id: employee,
          effective_at: "2020-01-01T00:00:00Z",
          cents: "2000",
          classification: "hourly_nonexempt",
          created_at: "2020-01-01T00:00:00Z",
        },
      ],
      cards: [
        {
          id: "card",
          employee_id: employee,
          clock_in: "2026-01-05T15:00:00Z",
          clock_out: "2026-01-05T23:00:00Z",
          approved_at: "2026-01-06T00:00Z",
          voided_at: null,
          time_breaks: [],
        },
      ],
      requests: [],
    };

  if (table === "employees")
    data = [
      {
        id: employee,
        user_id: employee,
        display_name: "Synthetic Team Member",
        archived_at: null,
      },
    ];
  if (table === "payroll_settings")
    data = [
      {
        frequency: "weekly",
        anchor: "2026-01-05",
        timezone: "America/Denver",
        workweek_day: 1,
        workweek_time: "00:00",
        rule: "federal-weekly-confirmed",
        employee_access: true,
      },
    ];
  if (table === "time_clock_settings")
    data = [{ enabled: true, require_breaks: false }];
  if (table === "time_sessions")
    data = ["05", "06", "07", "08", "09"].map((d, i) => ({
      id: `timecard-${i}`,
      organization_id: org,
      employee_id: employee,
      kiosk_id: null,
      revision: 1,
      clock_in: `2026-01-${d}T15:00:00Z`,
      clock_out: `2026-01-${d}T23:15:00Z`,
      approved_at: i === 0 ? "2026-01-06T00:00Z" : null,
      approval_source: i === 0 ? "automatic" : null,
      voided_at: null,
      time_breaks: [],
    }));
  if (table === "time_clock_manage") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const command = JSON.parse(body).command;
      res.end(
        JSON.stringify(
          command === "bulk_preview"
            ? { count: 1, token: "synthetic-preview", exceptions: [] }
            : { approved: 1 },
        ),
      );
    });
    return;
  }
  if (req.method === "HEAD") res.setHeader("Content-Range", "*/0");
  res.end(JSON.stringify(single ? data[0] : data));
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
        refresh_token: "local",
        token_type: "bearer",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: user(id),
      }),
    ).toString("base64url")
  );
}
await new Promise((r) => fixture.listen(54322, "127.0.0.1", r));
mkdirSync("work", { recursive: true });
const log = openSync("work/payroll-browser-server.log", "w");
const app = spawn(
  "node",
  ["node_modules/next/dist/bin/next", "start", "-p", "3200"],
  {
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54322",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture",
      SUPABASE_SERVICE_ROLE_KEY: "fixture",
      PAYROLL_REPORTS_ENABLED: "true",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3200",
      TIME_CLOCK_PIN_PEPPER: "local-fixture-pepper-32-characters-long",
      TIME_CLOCK_ENABLED: "true",
    },
    stdio: ["ignore", log, log],
  },
);
let browser;
try {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch("http://localhost:3200")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const id of [owner, employee]) {
    await context.clearCookies();
    await context.addCookies([
      {
        name: "sb-127-auth-token",
        value: session(id),
        domain: "localhost",
        path: "/",
      },
    ]);
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `http://localhost:3200/workspaces/${org}/payroll?date=2026-01-05`,
      );
      await page
        .getByRole("heading", {
          name: id === owner ? "Payroll" : "My Pay Estimates",
          exact: true,
        })
        .waitFor();
      assert.ok((await page.locator("main").innerText()).includes("$160.00"));
      assert.equal(
        await page
          .getByRole("button", {
            name: "Approve report for export",
            exact: true,
          })
          .count(),
        id === owner ? 1 : 0,
      );
      assert.equal(
        await page
          .getByText("Pay period and overtime settings", { exact: true })
          .count(),
        id === owner ? 1 : 0,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: `work/payroll-${id === owner ? "manager" : "employee"}-${width}.png`,
        fullPage: true,
      });
      console.log(
        `PASS payroll ${id === owner ? "manager" : "employee"} ${width}px`,
      );
    }
    if (id === employee) {
      const response = await page.goto(
        `http://localhost:3200/workspaces/${org}/payroll/export?report=00000000-0000-0000-0000-000000000004`,
      );
      assert.ok(page.url().includes("Workspace+access+denied"));
    }
  }

  await context.clearCookies();
  await context.addCookies([
    {
      name: "sb-127-auth-token",
      value: session(owner),
      domain: "localhost",
      path: "/",
    },
  ]);
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(
      `http://localhost:3200/workspaces/${org}/time-clock?from=2026-01-05&to=2026-01-11`,
    );
    await page
      .getByRole("heading", { name: "Time Clock Management", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Approve Timecard", exact: true })
        .count(),
      4,
    );
    assert.equal(
      await page
        .locator(".timecard-list article")
        .first()
        .getByRole("button", { name: "Approve Timecard", exact: true })
        .count(),
      0,
    );
    assert.ok(
      (
        await page.locator(".timecard-list article").first().innerText()
      ).includes("Approved automatically"),
    );
    assert.ok(
      (await page.locator(".timecard-list").innerText()).includes(
        "Overtime Recorded",
      ),
    );
    const confirm = page.getByRole("checkbox", {
      name: /I reviewed this date range/,
    });
    assert.equal(await confirm.isChecked(), false);
    await page
      .getByRole("button", { name: "Approve All Eligible", exact: true })
      .click();
    assert.equal(await confirm.evaluate((e) => e.validity.valueMissing), true);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `work/timecard-approval-${width}.png`,
      fullPage: true,
    });
    console.log(
      `PASS timecard approval labels, approved status, overtime, bulk confirmation and layout ${width}px`,
    );
  }
  await page
    .getByRole("checkbox", { name: /I reviewed this date range/ })
    .check();
  await page
    .getByRole("button", { name: "Approve All Eligible", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Eligible timecards approved." })
    .waitFor();
  const kiosk = spawn("node", ["tests/time-clock-browser.mjs"], {
    env: { ...process.env, TIME_CLOCK_TEST_ORIGIN: "http://localhost:3200" },
    stdio: "inherit",
  });
  await new Promise((resolve, reject) =>
    kiosk.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`Kiosk regression exited ${code}`)),
    ),
  );
  await context.clearCookies();
  await context.addCookies([
    {
      name: "__Host-meadowmark-kiosk",
      value: "synthetic",
      domain: "localhost",
      path: "/",
      secure: true,
    },
  ]);
  await page.goto(`http://localhost:3200/workspaces/${org}/payroll`);
  assert.equal(new URL(page.url()).pathname, "/kiosk");
  console.log("PASS employee export denial and kiosk redirect");
} finally {
  await browser?.close();
  app.kill("SIGTERM");
  fixture.close();
}
