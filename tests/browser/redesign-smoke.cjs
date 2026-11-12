/* Synthetic local data only. CAPTURE_PHASE=before captures the current baseline. */
const {
  fixture,
  session,
  org,
  owner,
  employeeCommands,
  setEmployees,
} = require("./ui-fixture.cjs");
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const phase = process.env.CAPTURE_PHASE || "after";
const dir = `work/redesign/${phase}`;
fs.mkdirSync(dir, { recursive: true });
(async () => {
  await new Promise((resolve) => fixture.listen(54321, "127.0.0.1", resolve));
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
        TIME_CLOCK_ENABLED: "true",
        TIME_CLOCK_PIN_PEPPER: "local-fixture-pepper-32-characters-long",
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
    await context.addCookies([
      {
        name: "sb-127-auth-token",
        value: session(owner),
        domain: "localhost",
        path: "/",
      },
    ]);
    const page = await context.newPage();
    const hydrationErrors = [];
    page.on("pageerror", (error) => hydrationErrors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /hydrated|hydration|cannot be a descendant/i.test(message.text())
      )
        hydrationErrors.push(message.text());
    });
    async function auditOpen(selector) {
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
      assert.deepEqual(violations, [], `accessibility: ${selector}`);
    }

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const screen of [
        "",
        "admin",
        "weekly-setup",
        "employees",
        "time-off",
        "schedule",
        "notifications",
      ]) {
        await page.goto(`http://localhost:3100/workspaces/${org}/${screen}`);
        await page.locator(".app-header").waitFor();
        await page.waitForLoadState("networkidle");
        assert.ok(
          !(await page.locator("h1").first().innerText()).includes("couldn’t"),
          screen,
        );
        await page.addStyleTag({
          content: "nextjs-portal { display: none !important; }",
        });
        await page.screenshot({
          path: `${dir}/${screen || "dashboard"}-${width}.png`,
          fullPage: true,
        });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${screen} overflow ${width}`,
        );
      }
      await page.goto(`http://localhost:3100/workspaces/${org}/admin`);
      await page.waitForLoadState("networkidle");
      if (phase === "before") {
        await page.locator("select[name=week_starts_on]").focus();
      }
      if (phase === "after") {
        await page.addStyleTag({
          content: "nextjs-portal { display:none !important; }",
        });
        const week = page.getByRole("combobox", {
          name: "Week starts on",
          exact: true,
        });
        await week.click();
        await page
          .getByRole("option", { name: "Monday", exact: true })
          .waitFor();
        await auditOpen(".ui-select-content");
        await page.screenshot({
          path: `${dir}/select-open-${width}.png`,
          fullPage: false,
        });
        await page.getByRole("option", { name: "Monday", exact: true }).click();
        assert.equal(
          await page.locator("select[name=week_starts_on]").inputValue(),
          "1",
        );
        assert.equal(
          await week.evaluate((el) =>
            new FormData(el.closest("form")).get("week_starts_on"),
          ),
          "1",
        );
        await week.evaluate((el) => el.closest("form").reset());
        await page.waitForFunction(
          () =>
            document.querySelector("select[name=week_starts_on]").value === "0",
        );
        await page.waitForTimeout(50);
        assert.match(await week.innerText(), /Sunday/);
        await week.focus();
        await page.keyboard.press("ArrowDown");
        await page.getByRole("listbox").waitFor();
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("role") === "option",
        );
        await page.keyboard.press("m");
        await page.waitForFunction(
          () => document.activeElement?.textContent === "Monday",
        );
        await page.keyboard.press("Enter");
        assert.equal(
          await page.locator("select[name=week_starts_on]").inputValue(),
          "1",
        );
        await week.click();
        await page.getByRole("listbox").waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("listbox").waitFor({ state: "hidden" });
        await page.waitForFunction(
          () =>
            document.activeElement ===
            document.querySelector('button[aria-label="Week starts on"]'),
        );
        assert.ok(await week.evaluate((el) => el === document.activeElement));
        await page.goto(`http://localhost:3100/workspaces/${org}/schedule`);
        await page
          .getByRole("button", { name: "Copy Week", exact: true })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        const calendar = dialog.getByRole("button", {
          name: "Choose Source week",
          exact: true,
        });
        await calendar.click();
        await page.getByRole("grid").waitFor();
        await auditOpen(".ui-calendar-popover");
        await page.screenshot({
          path: `${dir}/calendar-open-${width}.png`,
          fullPage: false,
        });
        const day = page
          .locator(".ui-calendar-popover .rdp-day_button")
          .filter({ hasText: /^15$/ })
          .first();
        await day.click();
        assert.match(
          await dialog.locator("input[type=date]").first().inputValue(),
          /-15$/,
        );
        await dialog.getByRole("combobox").first().click();
        await page
          .getByRole("option", { name: "Shift structure only", exact: true })
          .click();
        assert.equal(
          await dialog.locator("select").first().inputValue(),
          "structure",
        );
        await page.screenshot({
          path: `${dir}/copy-week-${width}.png`,
          fullPage: true,
        });
        await page.keyboard.press("Escape");
        assert.ok(!(await dialog.isVisible()));
        assert.ok(
          await page
            .getByRole("button", { name: "Copy Week", exact: true })
            .evaluate((el) => el === document.activeElement),
        );
      }
    }
    if (phase === "after") {
      await page.goto(`http://localhost:3100/workspaces/${org}/notifications`);
      await page
        .getByRole("button", {
          name: "Retry eligible notifications",
          exact: true,
        })
        .click();
      const confirmation = page.getByRole("alertdialog");
      await confirmation.waitFor();
      await auditOpen(".ui-confirm-dialog");
      assert.ok(
        await confirmation
          .getByRole("button", { name: "Cancel", exact: true })
          .evaluate((el) => el === document.activeElement),
      );
      await confirmation.screenshot({ path: `${dir}/confirmation.png` });
      await page.keyboard.press("Escape");
      assert.ok(!(await confirmation.isVisible()));
      assert.ok(
        await page
          .getByRole("button", {
            name: "Retry eligible notifications",
            exact: true,
          })
          .evaluate((el) => el === document.activeElement),
      );
      await page.goto(`http://localhost:3100/workspaces/${org}/weekly-setup`);
      const apply = page
        .getByRole("combobox", {
          name: "Apply setup",
          exact: true,
        })
        .and(page.locator("button"));
      await apply.click();
      await page
        .getByRole("option", { name: "Future weeks only", exact: true })
        .click();
      assert.match(await apply.innerText(), /Future weeks only/);
      await apply.evaluate((el) => (el.closest("fieldset").disabled = true));
      await page.waitForFunction(
        () =>
          document.querySelector('button[aria-label="Apply setup"]').disabled,
      );
      await apply.evaluate((el) => (el.closest("fieldset").disabled = false));
      await page.waitForFunction(
        () =>
          !document.querySelector('button[aria-label="Apply setup"]').disabled,
      );
      const checkbox = page.locator("input[type=checkbox]").first();
      const checked = await checkbox.isChecked();
      await checkbox.focus();
      await page.keyboard.press("Space");
      assert.equal(await checkbox.isChecked(), !checked);
      await page.goto(`http://localhost:3100/workspaces/${org}/time-off`);
      await page
        .getByText("Enter time off for an employee without an account", {
          exact: true,
        })
        .click();
      const employeeSelect = page
        .getByRole("combobox", {
          name: "Employee",
          exact: true,
        })
        .and(page.locator("button"));
      await employeeSelect.waitFor();
      assert.ok(
        await employeeSelect.isDisabled(),
        "no employees disables the entire request fieldset",
      );
      // Exercise native constraint-validation forwarding without submitting an action.
      await employeeSelect.evaluate(
        (el) => (el.closest("fieldset").disabled = false),
      );
      await page.waitForFunction(
        () => !document.querySelector('button[aria-label="Employee"]').disabled,
      );
      assert.equal(
        await page
          .locator("select[name=employee_id]")
          .evaluate((el) => el.reportValidity()),
        false,
      );
      assert.ok(
        await employeeSelect.evaluate((el) => el === document.activeElement),
      );
      assert.equal(await employeeSelect.getAttribute("aria-invalid"), "true");
      setEmployees([
        {
          id: "00000000-0000-0000-0000-000000000005",
          display_name: "Synthetic UI Member",
          user_id: null,
          archived_at: null,
        },
      ]);
      await page.goto(`http://localhost:3100/workspaces/${org}/employees`);
      await page
        .getByRole("button", { name: "Archive employee", exact: true })
        .click();
      const archive = page.getByRole("alertdialog", {
        name: "Archive employee",
        exact: true,
      });
      await archive.waitFor();
      assert.ok(
        !employeeCommands.includes("archive"),
        "opening confirmation cannot change an employee",
      );
      await archive
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      assert.ok(
        !employeeCommands.includes("archive"),
        "cancellation cannot submit the form",
      );
      await page
        .getByRole("button", { name: "Archive employee", exact: true })
        .click();
      await archive
        .getByRole("button", { name: "Archive employee", exact: true })
        .click();
      await page.waitForURL("**/employees?message=Employee%20archived*");
      assert.equal(
        employeeCommands.filter((command) => command === "archive").length,
        1,
        "confirmation submits the original form exactly once",
      );
      await page
        .getByRole("button", { name: "Restore employee", exact: true })
        .waitFor();
      setEmployees([]);
      const fallback = await browser.newContext({ javaScriptEnabled: false });
      await fallback.addCookies([
        {
          name: "sb-127-auth-token",
          value: session(owner),
          domain: "localhost",
          path: "/",
        },
      ]);
      const ssr = await fallback.newPage();
      await ssr.goto(`http://localhost:3100/workspaces/${org}/admin`);
      // Next may stream the entire authenticated screen behind a hidden
      // suspense boundary when JavaScript is disabled. Verify the component's
      // server markup retains the native field rather than asserting that
      // Next's page-level streaming shell has hydrated.
      assert.equal(
        await ssr
          .locator("select[name=week_starts_on]")
          .getAttribute("aria-hidden"),
        null,
      );
      assert.equal(
        await ssr.locator("select[name=week_starts_on]").inputValue(),
        "0",
      );
      assert.equal(await ssr.locator(".ui-select-trigger").count(), 0);
      await fallback.close();
    }
    await context.clearCookies();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("http://localhost:3100/login");
      await page.waitForLoadState("networkidle");
      await page.addStyleTag({
        content: "nextjs-portal {display:none !important;}",
      });
      await page.screenshot({
        path: `${dir}/login-${width}.png`,
        fullPage: true,
      });
    }
    assert.deepEqual(
      hydrationErrors,
      [],
      "no browser errors or hydration mismatches",
    );
    console.log(
      `PASS ${phase}: desktop/mobile screenshots and page overflow checks`,
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
