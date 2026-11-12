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
        SUPABASE_SERVICE_ROLE_KEY: "local-fixture-key",
        TIME_CLOCK_ENABLED: "true",
        TIME_CLOCK_PIN_PEPPER: "local-fixture-pepper-32-characters-long",
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
    for (const id of [owner, employee]) {
      await context.addCookies([
        {
          name: "sb-127-auth-token",
          value: session(id),
          domain: "localhost",
          path: "/",
        },
      ]);
      await page.goto(`http://localhost:3100/workspaces/${org}/my-schedule`);
      await page.locator(".app-header").waitFor();
      for (const width of [390, 768, 1024, 1280, 1440, 1800]) {
        await page.goto(`http://localhost:3100/workspaces/${org}/my-schedule`);
        await page.locator(".notifications-link").waitFor();
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(150);
        const menu = page.locator(".mobile-menu");
        const nav = page.locator(".app-navigation");
        const check = async () => {
          const result = await page.evaluate(() => {
            const rects = [
              ...document.querySelectorAll(
                ".app-header > .brand, .product-switcher > summary, .app-header > .notifications-link, .workspace-menu > summary, .mobile-menu, .app-navigation a",
              ),
            ]
              .filter(
                (e) =>
                  getComputedStyle(e).visibility !== "hidden" &&
                  e.getBoundingClientRect().width > 0 &&
                  e.getBoundingClientRect().height > 0,
              )
              .map((e) => ({
                label: e.textContent,
                ...e.getBoundingClientRect().toJSON(),
              }));
            for (let i = 0; i < rects.length; i++)
              for (let j = i + 1; j < rects.length; j++) {
                const a = rects[i],
                  b = rects[j];
                if (
                  a.left < b.right &&
                  b.left < a.right &&
                  a.top < b.bottom &&
                  b.top < a.bottom
                )
                  return { overlap: [a.label, b.label] };
              }
            return {
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          assert.deepEqual(result, { overflow: false }, `${id} ${width}`);
        };
        await check();
        if (id === owner && width <= 1280) assert.ok(await menu.isVisible());
        if (width === 1800) assert.ok(!(await menu.isVisible()));
        assert.equal(
          await nav
            .getByRole("link", {
              name: id === owner ? "Time Clock" : "My Timesheet",
              exact: true,
              includeHidden: true,
            })
            .count(),
          1,
        );
        assert.ok(
          await page
            .getByRole("link", { name: "Notifications", exact: true })
            .isVisible(),
        );
        if (await menu.isVisible()) {
          await menu.click();
          await page.waitForTimeout(100);
          assert.equal(await menu.getAttribute("aria-expanded"), "true");
          await check();
          if (id === owner && [390, 1440].includes(width))
            await page.screenshot({ path: `work/navigation-${width}.png` });
          await page.addScriptTag({
            path: path.resolve(
              "work/browser-tools/node_modules/axe-core/axe.min.js",
            ),
          });
          const violations = await page.evaluate(
            async () =>
              (
                await window.axe.run(document.querySelector(".app-header"), {
                  runOnly: {
                    type: "tag",
                    values: ["wcag2a", "wcag2aa", "wcag21aa"],
                  },
                })
              ).violations,
          );
          assert.deepEqual(violations, [], "header accessibility");
          await page.keyboard.press("Escape");
          assert.equal(await menu.getAttribute("aria-expanded"), "false");
          assert.ok(await menu.evaluate((e) => e === document.activeElement));
          await menu.click();
          await page.locator(".workspace-menu summary").click();
          assert.equal(await menu.getAttribute("aria-expanded"), "false");
          await page.locator(".workspace-menu summary").click();
          await menu.click();
          await nav
            .getByRole("link", { name: "Time Off", exact: true })
            .click();
          await page.waitForURL("**/time-off");
          await page.waitForLoadState("networkidle");
          assert.equal(await menu.getAttribute("aria-expanded"), "false");
        }
        for (const selector of [".workspace-menu", ".product-switcher"]) {
          const disclosure = page.locator(selector);
          const trigger = disclosure.locator("summary");
          await trigger.focus();
          await page.keyboard.press("Enter");
          assert.equal(await disclosure.getAttribute("open"), "");
          await page.keyboard.press("Tab");
          assert.ok(
            await disclosure.evaluate((e) => e.contains(document.activeElement)),
            `${selector} Tab navigation at ${width}px`,
          );
          await page.keyboard.press("Escape");
          assert.equal(await disclosure.getAttribute("open"), null);
          assert.ok(await trigger.evaluate((e) => e === document.activeElement));
          await trigger.click();
          await page.mouse.click(width - 5, 895);
          assert.equal(await disclosure.getAttribute("open"), null);
          await trigger.click();
          await page.locator(".brand").focus();
          assert.equal(await disclosure.getAttribute("open"), null);
        }
        console.log(`PASS ${id === owner ? "owner" : "employee"} ${width}px`);
      }
    }
  } finally {
    if (browser) await browser.close();
    app.kill("SIGTERM");
    fixture.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
