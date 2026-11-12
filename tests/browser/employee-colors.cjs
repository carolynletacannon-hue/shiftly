const assert = require("node:assert/strict");
exports.checkColors = async ({
  browser,
  page,
  context,
  employees,
  dir,
  session,
  owner,
  employee,
  org,
}) => {
  const url = `http://localhost:3100/workspaces/${org}/employees`;
  const cookie = (id) => ({
    name: "sb-127-auth-token",
    value: session(id),
    domain: "localhost",
    path: "/",
  });
  await context.addCookies([cookie(owner)]);
  for (const [index, width] of [
    [0, 1280],
    [4, 390],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(url);
    const card = page.locator(".employee-card").filter({
      has: page.getByRole("heading", {
        name: employees[index].display_name,
        exact: true,
      }),
    });
    await card
      .getByRole("button", { name: "Edit name & contact information" })
      .click();
    const picker = card.getByRole("group", {
      name: "Employee color",
      exact: true,
    });
    await picker.getByRole("radio").first().waitFor();
    assert.equal(await picker.getByRole("radio").count(), 8);
    const current = picker.locator("input:checked");
    await current.focus();
    await page.keyboard.press("ArrowRight");
    const chosen = await picker.locator("input:checked").inputValue();
    assert.notEqual(chosen, index === 0 ? "blue" : "purple");
    assert.ok(
      await picker
        .locator("label:focus-within")
        .evaluate((el) => getComputedStyle(el).outlineStyle !== "none"),
    );
    await page.addScriptTag({
      path: "work/browser-tools/node_modules/axe-core/axe.min.js",
    });
    assert.deepEqual(
      await page.evaluate(async () =>
        (
          await window.axe.run(document.querySelector(".employee-list"), {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          })
        ).violations.map((v) => v.id),
      ),
      [],
    );
    const [saved] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/employees"),
      ),
      card.getByRole("button", { name: "Save employee", exact: true }).click(),
    ]);
    assert.equal(saved.status(), 200);
    await page.waitForURL(/message=/);
    await page.reload();
    await card.locator(`[role=img][data-employee-color="${chosen}"]`).waitFor();
    const second = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    await second.addCookies([cookie(owner)]);
    const secondPage = await second.newPage();
    await secondPage.goto(url);
    const secondCard = secondPage.locator(".employee-card").filter({
      has: secondPage.getByRole("heading", {
        name: employees[index].display_name,
        exact: true,
      }),
    });
    await secondCard.locator(`[data-employee-color="${chosen}"]`).waitFor();
    await second.close();
    await card
      .getByRole("button", { name: "Edit name & contact information" })
      .click();
    assert.ok(
      await picker
        .getByRole("radio", {
          name: chosen[0].toUpperCase() + chosen.slice(1),
          exact: true,
        })
        .isChecked(),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.addStyleTag({
      content: "nextjs-portal{display:none!important}",
    });
    await page.evaluate(() => {
      document.activeElement?.blur();
      scrollTo(0, 0);
    });
    await page.screenshot({
      path: `${dir}/employee-picker-${width}.png`,
      fullPage: true,
    });
    // Restore the fixture's palette for the multi-employee calendar assertions.
    await picker
      .getByRole("radio", {
        name: index === 0 ? "Blue" : "Purple",
        exact: true,
      })
      .check();
    const [restored] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/employees"),
      ),
      card.getByRole("button", { name: "Save employee", exact: true }).click(),
    ]);
    assert.equal(restored.status(), 200);
    // Next dev can leave an action response stream open after committing. Check
    // the rendered result and a fresh request instead of waiting for stream EOF.
    const original = index === 0 ? "blue" : "purple";
    await card.locator(`[role=img][data-employee-color="${original}"]`).waitFor();
    await page.reload();
    await card.locator(`[role=img][data-employee-color="${original}"]`).waitFor();
  }
  await context.addCookies([cookie(employee)]);
  await page.goto(url);
  await page.waitForURL(/\/workspaces\?message=Workspace/);
  assert.equal(
    await page.getByRole("radio").count(),
    0,
    "employee has no color editor",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Save employee", exact: true })
      .count(),
    0,
  );
};
