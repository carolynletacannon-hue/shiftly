/* Local synthetic fixtures; no real employees, mail or database writes. */
const {
  fixture,
  session,
  org,
  owner,
  employeeCommands,
  setEmployees,
  setStatuses,
  setInvitations,
} = require("./ui-fixture.cjs");
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const staff = [
  {
    id: "00000000-0000-0000-0000-000000000005",
    display_name: "Synthetic Roster Member",
    user_id: null,
    archived_at: null,
  },
  {
    id: "00000000-0000-0000-0000-000000000006",
    display_name: "Synthetic Connected Member",
    user_id: "00000000-0000-0000-0000-000000000006",
    archived_at: null,
  },
  {
    id: "00000000-0000-0000-0000-000000000007",
    display_name: "Synthetic Invited Member",
    user_id: null,
    archived_at: null,
  },
  {
    id: "00000000-0000-0000-0000-000000000008",
    display_name: "Synthetic Archived Member",
    user_id: null,
    archived_at: "2026-01-05T12:00:00Z",
  },
];
setEmployees(staff);
setStatuses({
  [staff[1].id]: {
    ok: true,
    blockers: [
      {
        kind: "shift",
        message: "Resolve the existing assigned shift before archiving.",
      },
    ],
    delete_reasons: ["Published scheduling history must be retained."],
  },
  [staff[3].id]: {
    ok: true,
    blockers: [],
    delete_reasons: ["Published scheduling history must be retained."],
  },
});
setInvitations([
  {
    employee_id: staff[2].id,
    accepted_at: null,
    revoked_at: null,
    expires_at: "2099-01-01T00:00:00Z",
  },
]);
fs.mkdirSync("work/employees", { recursive: true });
(async () => {
  await new Promise((r) => fixture.listen(54321, "127.0.0.1", r));
  const log = fs.openSync("work/employees/server.log", "w");
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
    await context.addCookies([
      {
        name: "sb-127-auth-token",
        value: session(owner),
        domain: "localhost",
        path: "/",
      },
    ]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    async function audit(selector) {
      await page.addScriptTag({
        path: "work/browser-tools/node_modules/axe-core/axe.min.js",
      });
      const failures = await page.evaluate(
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
      assert.deepEqual(failures, [], selector);
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`http://localhost:3100/workspaces/${org}/employees`);
      await page.waitForLoadState("networkidle");
      await page.addStyleTag({
        content: "nextjs-portal {display:none !important;}",
      });
      const roster = page.locator(".employee-card").filter({
        has: page.getByRole("heading", {
          name: staff[0].display_name,
          exact: true,
        }),
      });
      assert.ok(await roster.locator(".employee-status").isVisible());
      assert.equal(
        await page
          .getByRole("button", { name: "Archive employee", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Permanently delete", exact: true })
          .count(),
        0,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "no viewport overflow",
      );
      await page.screenshot({
        path: `work/employees/cards-${width}.png`,
        fullPage: true,
      });
      await audit(".employees-screen");
      const actions = roster.getByRole("button", {
        name: `Actions for ${staff[0].display_name}`,
        exact: true,
      });
      await actions.focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("dialog", { name: "Employee actions", exact: true })
        .waitFor();
      await audit(".employee-actions-popover");
      await page.screenshot({
        path: `work/employees/actions-${width}.png`,
        fullPage: false,
      });
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("aria-label") ===
          "Actions for Synthetic Roster Member",
      );
      const edit = roster.getByRole("button", {
        name: "Edit name & contact information",
        exact: true,
      });
      await edit.focus();
      await page.keyboard.press("Space");
      assert.equal(await edit.getAttribute("aria-expanded"), "true");
      const name = roster.getByLabel("Name", { exact: true });
      await name.waitFor();
      assert.equal(await name.inputValue(), staff[0].display_name);
      await page.keyboard.press("Tab");
      assert.ok(await name.evaluate((el) => el === document.activeElement));
      assert.equal(
        await name.evaluate((el) => new FormData(el.form).get("id")),
        staff[0].id,
      );
      await edit.click();
      assert.equal(await edit.getAttribute("aria-expanded"), "false");
      await page.keyboard.press("Tab");
      assert.ok(
        !(await name.evaluate((el) => el === document.activeElement)),
        "collapsed fields leave tab order",
      );
      await roster
        .getByRole("button", { name: "Invite later", exact: true })
        .click();
      await roster.getByLabel("Invitation email").waitFor();
      const blocked = page.locator(".employee-card").filter({
        has: page.getByRole("heading", {
          name: staff[1].display_name,
          exact: true,
        }),
      });
      await blocked.getByRole("button", { name: /^Resolve 1 item/ }).click();
      await blocked
        .getByRole("link", { name: "Review", exact: true })
        .waitFor();
      await blocked
        .getByRole("button", {
          name: "Why permanent deletion is unavailable",
          exact: true,
        })
        .click();
      await blocked
        .getByText("Published scheduling history must be retained.")
        .waitFor();
      await blocked
        .getByRole("button", {
          name: `Actions for ${staff[1].display_name}`,
          exact: true,
        })
        .click();
      assert.ok(
        await page
          .getByRole("button", { name: "Archive employee", exact: true })
          .isDisabled(),
      );
      assert.ok(
        await page
          .getByRole("button", { name: "Permanently delete", exact: true })
          .isDisabled(),
      );
      await page.keyboard.press("Escape");
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: `work/employees/expanded-${width}.png`,
        fullPage: true,
      });
    }
    // Both cancellation paths preserve state and focus; confirmation invokes the
    // original action once. The fixture changes only the target synthetic record.
    async function choose(name, command) {
      await page
        .getByRole("button", { name: `Actions for ${name}`, exact: true })
        .click();
      await page.getByRole("button", { name: command, exact: true }).click();
      await page
        .getByRole("alertdialog", { name: command, exact: true })
        .waitFor();
    }
    await choose(staff[0].display_name, "Archive employee");
    assert.equal(employeeCommands.filter((c) => c === "archive").length, 0);
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") ===
        "Actions for Synthetic Roster Member",
    );
    assert.equal(employeeCommands.filter((c) => c === "archive").length, 0);
    await choose(staff[0].display_name, "Archive employee");
    await page.keyboard.press("Escape");
    assert.equal(employeeCommands.filter((c) => c === "archive").length, 0);
    await choose(staff[0].display_name, "Archive employee");
    await audit(".ui-confirm-dialog[open]");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Archive employee", exact: true })
      .click();
    await page.waitForURL("**/employees?message=Employee*");
    await page.waitForLoadState("networkidle");
    assert.equal(employeeCommands.filter((c) => c === "archive").length, 1);
    await choose(staff[0].display_name, "Restore employee");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Restore employee", exact: true })
      .click();
    await page.waitForURL("**/employees?message=Employee%20restored*");
    await page.waitForLoadState("networkidle");
    assert.equal(employeeCommands.filter((c) => c === "restore").length, 1);
    await choose(staff[0].display_name, "Permanently delete");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Permanently delete", exact: true })
      .click();
    await page.waitForURL("**/employees?message=Unused*");
    await page.waitForLoadState("networkidle");
    assert.equal(employeeCommands.filter((c) => c === "delete").length, 1);
    assert.equal(
      await page
        .getByRole("heading", { name: staff[0].display_name, exact: true })
        .count(),
      0,
    );
    assert.ok(
      await page
        .getByRole("heading", { name: staff[1].display_name, exact: true })
        .isVisible(),
      "other employees preserved",
    );
    // Normal motion animates the row, while reduced motion removes the transition.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const remaining = page
      .locator(".employee-card")
      .filter({
        has: page.getByRole("heading", {
          name: staff[1].display_name,
          exact: true,
        }),
      });
    const expand = remaining.getByRole("button", {
      name: "Edit name & contact information",
      exact: true,
    });
    await expand.click();
    const panel = page.locator(
      `[id="${await expand.getAttribute("aria-controls")}"]`,
    );
    assert.ok(
      await panel.evaluate(
        (el) => parseFloat(getComputedStyle(el).transitionDuration) > 0,
      ),
    );
    await page.waitForTimeout(220);
    assert.ok((await panel.boundingBox()).height > 0);
    await expand.click();
    await page.waitForTimeout(220);
    assert.equal((await panel.boundingBox()).height, 0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.ok(
      await panel.evaluate(
        (el) => parseFloat(getComputedStyle(el).transitionDuration) < 0.001,
      ),
    );
    // Invalid optional contact information reopens its collapsed row for native validation.
    const create = page.locator(".employee-create");
    const contact = create.getByRole("button", {
      name: "Contact information (optional)",
      exact: true,
    });
    await create
      .getByLabel("Employee name", { exact: true })
      .fill("Synthetic Validation Member");
    await contact.click();
    await create.getByLabel("Email", { exact: true }).fill("invalid-address");
    await contact.click();
    await create
      .getByRole("button", { name: "Add employee", exact: true })
      .click();
    assert.equal(await contact.getAttribute("aria-expanded"), "true");
    assert.equal(
      await create
        .getByLabel("Email", { exact: true })
        .evaluate((el) => el.validity.typeMismatch),
      true,
    );
    assert.deepEqual(errors, [], "no browser errors");
    console.log(
      "PASS Employees: compact cards/status badges, mobile overflow, accordion keyboard/Tab, popover Escape/focus, disabled actions, cancellation and one-shot archive/restore/delete, scoped axe audits.",
    );
  } finally {
    if (browser) await browser.close();
    app.kill("SIGTERM");
    fixture.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
