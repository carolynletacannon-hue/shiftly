/* Real local Next pages, synthetic data only. Before mode records overflow;
   after mode asserts page AND weekly-grid bounds at every requested width. */
const {
  fixture,
  session,
  org,
  owner,
  employee,
  setTableResponses,
} = require("./ui-fixture.cjs");
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const week = "2026-11-08";
const names = [
  "Synthetic Alexandria Montgomery-Wellington",
  "Synthetic Christopher Verylongfamilyname",
  "SyntheticLongUnbrokenEmployeeNameForWrappingVerification",
  "Synthetic Morgan Additional Colleague",
  "Synthetic Taylor Available Employee",
];
const employees = names.map((display_name, i) => ({
  id: `00000000-0000-0000-0000-00000000001${i}`,
  user_id: i === 0 ? owner : i === 1 ? employee : null,
  display_name,
  archived_at: null,
}));
const sid = "00000000-0000-0000-0000-000000000020";
const shifts = [];
for (let d = 0; d < 7; d++)
  for (let g = 0; g < 2; g++)
    for (let a = 0; a < 2; a++) {
      const day = String(8 + d).padStart(2, "0");
      const start = Date.UTC(2026, 10, 8 + d, g ? 19 : 15),
        end = start + 8 * 3600000;
      shifts.push({
        id: `assignment-${d}-${g}-${a}`,
        organization_id: org,
        schedule_id: sid,
        employee_id: employees[g * 2 + a].id,
        shift_group_id: `group-${d}-${g}`,
        shift_groups: { required_count: 3, allow_overstaffing: false },
        required_count: 3,
        allow_overstaffing: false,
        is_required: true,
        label: g ? "Overlapping afternoon service" : "Morning guest service",
        position_name: "Hospitality and front-of-house operations",
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(end).toISOString(),
        notes:
          "Synthetic planning note with enough detail to exercise text wrapping.",
      });
    }
setTableResponses({
  employees,
  schedules: [
    {
      id: sid,
      organization_id: org,
      week_start: week,
      timezone: "America/Denver",
      revision: 2,
      published_revision: 1,
      shifts,
    },
  ],
  published_schedules: [
    {
      id: sid,
      organization_id: org,
      week_start: week,
      timezone: "America/Denver",
      revision: 1,
      published_at: "2026-11-07T12:00:00Z",
      published_shifts: shifts,
    },
  ],
  shifts,
  published_shifts: shifts,
  scheduling_settings: [{ weekly_hours_warning: 40 }],
  manage_calendar_subscription: { active: false },
});
const phase = process.env.CAPTURE_PHASE || "after";
const dir = `work/weekly/${phase}`;
fs.mkdirSync(dir, { recursive: true });
(async () => {
  await new Promise((r) => fixture.listen(54321, "127.0.0.1", r));
  const log = fs.openSync(`${dir}/server.log`, "w");
  const app = spawn(
    "node",
    ["node_modules/next/dist/bin/next", "dev", "-p", "3100"],
    {
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-fixture-key",
        SUPABASE_SERVICE_ROLE_KEY: "local-fixture-key",
        NEXT_PUBLIC_SITE_URL: "http://localhost:3100",
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
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    async function audit(selector) {
      await page.addScriptTag({
        path: "work/browser-tools/node_modules/axe-core/axe.min.js",
      });
      const violations = await page.evaluate(
        async (selector) =>
          (
            await window.axe.run(document.querySelector(selector), {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag21aa"],
              },
            })
          ).violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => n.target),
          })),
        selector,
      );
      assert.deepEqual(violations, [], `accessibility ${selector}`);
    }
    const reports = [];
    const cases = [
      {
        name: "manager-schedule",
        user: owner,
        path: "schedule",
        grid: ".coverage-calendar",
      },
      {
        name: "manager-calendar",
        user: owner,
        path: "my-schedule",
        view: "team",
        grid: ".schedule-days",
      },
      {
        name: "manager-personal",
        user: owner,
        path: "my-schedule",
        view: "mine",
        grid: ".schedule-table",
      },
      {
        name: "employee-calendar",
        user: employee,
        path: "my-schedule",
        view: "team",
        grid: ".schedule-days",
      },
      {
        name: "employee-personal",
        user: employee,
        path: "my-schedule",
        view: "mine",
        grid: ".schedule-table",
      },
    ];
    for (const test of cases) {
      await context.addCookies([
        {
          name: "sb-127-auth-token",
          value: session(test.user),
          domain: "localhost",
          path: "/",
        },
      ]);
      for (const width of process.env.WEEKLY_TEST_WIDTHS
        ? process.env.WEEKLY_TEST_WIDTHS.split(",").map(Number)
        : [375, 390, 768, 1024, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(
          `http://localhost:3100/workspaces/${org}/${test.path}?week=${week}&view=${test.view || ""}`,
        );
        await page.waitForLoadState("networkidle");
        await page.locator(test.grid).waitFor();
        const result = await page.locator(test.grid).evaluate((el) => ({
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          gridOverflow: el.scrollWidth > el.clientWidth + 1,
          parentOverflow:
            el.parentElement.scrollWidth > el.parentElement.clientWidth + 1,
          gridWidth: el.clientWidth,
          available: document.querySelector("main").clientWidth,
        }));
        reports.push({ name: test.name, width, ...result });
        if (phase === "after") {
          assert.equal(
            result.pageOverflow,
            false,
            `${test.name} ${width} page`,
          );
          assert.equal(
            result.gridOverflow,
            false,
            `${test.name} ${width} grid`,
          );
          assert.equal(
            result.parentOverflow,
            false,
            `${test.name} ${width} parent`,
          );
          const root = page.locator(".weekly-view").first();
          const overview = root.getByRole("group", {
            name: "Week overview",
            exact: true,
          });
          const compact = await overview.isVisible();
          const visibleIndices = async () =>
            root
              .locator("[data-day-index]")
              .evaluateAll((nodes) => [
                ...new Set(
                  nodes
                    .filter((el) => el.getClientRects().length)
                    .map((el) => el.dataset.dayIndex),
                ),
              ]);
          if (compact) {
            assert.equal(await overview.getByRole("button").count(), 7);
            const boxes = await overview
              .getByRole("button")
              .evaluateAll((nodes) =>
                nodes.map((el) => el.getBoundingClientRect().toJSON()),
              );
            assert.ok(
              boxes.every((box) => box.left >= 0 && box.right <= width + 1),
            );
            assert.ok(
              boxes.every((box) => Math.abs(box.top - boxes[0].top) < 1),
              "all seven overview days share a row",
            );
            await overview.getByRole("button").last().click();
            assert.deepEqual(await visibleIndices(), ["6"]);
            await page.keyboard.press("Home");
            assert.deepEqual(await visibleIndices(), ["0"]);
            await page.keyboard.press("ArrowRight");
            assert.deepEqual(await visibleIndices(), ["1"]);
            await page.keyboard.press("End");
            assert.deepEqual(await visibleIndices(), ["6"]);
            await page.keyboard.press("Space");
            assert.deepEqual(await visibleIndices(), ["6"]);
            await page.keyboard.press("Home");
            await page.keyboard.press("Enter");
            assert.deepEqual(await visibleIndices(), ["0"]);
          } else {
            assert.deepEqual(await visibleIndices(), [
              "0",
              "1",
              "2",
              "3",
              "4",
              "5",
              "6",
            ]);
            const boxes = await root
              .locator(
                test.grid === ".schedule-table"
                  ? "thead [data-day-index]"
                  : test.grid === ".schedule-days"
                    ? ".schedule-days > section"
                    : ".coverage-day",
              )
              .evaluateAll((nodes) =>
                nodes.map((el) => el.getBoundingClientRect().toJSON()),
              );
            assert.ok(
              boxes.every((box) => Math.abs(box.top - boxes[0].top) < 1),
              "seven full-width columns",
            );
          }
          if (width >= 1280)
            assert.equal(
              compact,
              false,
              "desktop uses all seven full day columns",
            );
          for (const box of await page
            .locator(test.grid)
            .evaluate((el) => [el.getBoundingClientRect().toJSON()]))
            assert.ok(
              box.left >= 0 && box.right <= width + 1,
              "grid stays in viewport",
            );
          // Keep controls legible, and detect overflowing content rather than clipping it.
          assert.equal(
            await root
              .locator(".slot-assignee-name,.slot-time,.schedule-shift")
              .evaluateAll((nodes) =>
                nodes
                  .filter(
                    (el) => el.getClientRects().length && el.clientWidth > 0,
                  )
                  .every(
                    (el) =>
                      el.scrollWidth <= el.clientWidth + 1 &&
                      parseFloat(getComputedStyle(el).fontSize) >= 12,
                  ),
              ),
            true,
            "readable wrapped cards",
          );
          const previous = page
            .getByRole("navigation", { name: "Schedule week" })
            .getByRole("link", { name: /Previous/ });
          assert.ok(
            (await previous.getAttribute("href")).includes("week=2026-11-01"),
          );
          const next = page
            .getByRole("navigation", { name: "Schedule week" })
            .getByRole("link", { name: /Next/ });
          assert.ok(
            (await next.getAttribute("href")).includes("week=2026-11-15"),
          );
          if ([390, 1280].includes(width)) await audit(".weekly-view");
          if (test.user === employee)
            assert.equal(
              await page.locator(".slot-trigger").count(),
              0,
              "published employee views have no assignment editor",
            );
        }
        if (
          [375, 390, 1280, 1920].includes(width) &&
          [
            "manager-schedule",
            "manager-calendar",
            "employee-personal",
          ].includes(test.name)
        ) {
          await page.addStyleTag({
            content: "nextjs-portal{display:none !important;}",
          });
          await page.evaluate(() => scrollTo(0, 0));
          await page.screenshot({
            path: `${dir}/${test.name}-${width}.png`,
            fullPage: true,
          });
        }
        if (
          phase === "after" &&
          test.name === "manager-schedule" &&
          [375, 390, 1280, 1920].includes(width)
        ) {
          const trigger = page
            .locator(".coverage-day .slot-trigger:visible")
            .first();
          await trigger.click();
          const panel = page.getByRole("dialog", {
            name: "Manage Morning guest service assignments",
            exact: true,
          });
          await panel.waitFor();
          await page.waitForTimeout(100);
          const box = await panel.boundingBox();
          assert.ok(
            box.x >= 0 &&
              box.x + box.width <= width + 1 &&
              box.y >= 0 &&
              box.y + box.height <= 1001,
            `assignment popover fits viewport: ${JSON.stringify(box)}`,
          );
          if (width === 390) await audit(".weekly-assignment-popover");
          const select = panel.getByRole("combobox", {
            name: "Add employee",
            exact: true,
          });
          await select.click();
          await page
            .getByRole("option", { name: names[2], exact: true })
            .click();
          await panel
            .getByText("This employee has an overlapping shift.", {
              exact: true,
            })
            .waitFor();
          assert.ok(
            await panel
              .getByRole("button", { name: "Add employee", exact: true })
              .isDisabled(),
          );
          await select.click();
          await page
            .getByRole("option", { name: names[4], exact: true })
            .click();
          assert.ok(
            await panel
              .getByRole("button", { name: "Add employee", exact: true })
              .isEnabled(),
          );
          await select.click();
          await page.keyboard.press("Escape");
          assert.ok(
            await panel.isVisible(),
            "inner select Escape preserves assignment editor",
          );
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "hidden" });
          await page.waitForFunction(() =>
            document.activeElement?.classList.contains("slot-trigger"),
          );
          await page
            .getByRole("button", {
              name: "Choose Week containing",
              exact: true,
            })
            .click();
          await page.locator(".ui-calendar-popover").waitFor();
          const calendar = await page
            .locator(".ui-calendar-popover")
            .boundingBox();
          assert.ok(
            calendar.x >= 0 && calendar.x + calendar.width <= width + 1,
          );
          await page.keyboard.press("Escape");
          await page
            .getByRole("button", { name: "Copy Week", exact: true })
            .click();
          const dialog = page.getByRole("dialog", {
            name: "Copy Week",
            exact: true,
          });
          await dialog.waitFor();
          const bounds = await dialog.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
          await page.keyboard.press("Escape");
        }
        console.log(
          `${phase} ${test.name} ${width}px ${JSON.stringify(result)}`,
        );
      }
    }
    assert.deepEqual(errors, [], "no browser errors");
    fs.writeFileSync(
      `${dir}/measurements.json`,
      JSON.stringify(reports, null, 2),
    );
    console.log(`PASS ${phase}: weekly layout matrix`);
  } finally {
    if (browser) await browser.close();
    app.kill("SIGTERM");
    fixture.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
