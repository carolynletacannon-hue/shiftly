import assert from "node:assert/strict";
import { chromium } from "playwright";
// Run against a local build with TIME_CLOCK_ENABLED=true and synthetic env vars.
// API responses here are UI fixtures; database/concurrency tests use real SQL.
const origin = process.env.TIME_CLOCK_TEST_ORIGIN || "http://localhost:3000";
assert.ok(
  ["localhost", "127.0.0.1"].includes(new URL(origin).hostname),
  "Browser fixtures must stay local",
);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const challenge = "a".repeat(43);
  let state = "out",
    lost = true;
  const recorded = new Set();
  let firstRequest;
  await page.route("**/api/kiosk", async (route) => {
    const body = route.request().postDataJSON();
    let data = {};
    if (body.command === "info")
      data = {
        name: "Synthetic Meadow Team",
        timezone: "America/Denver",
        now: "2026-11-01T08:30:00Z",
        require_breaks: true,
      };
    else if (body.command === "pin")
      data =
        body.pin === "1234"
          ? { name: "Example", status: state, challenge }
          : {
              error: "PIN unavailable. Wait and try again or ask your manager",
            };
    else if (body.command === "punch") {
      if (!recorded.has(body.request_id)) {
        recorded.add(body.request_id);
        state =
          body.action === "in"
            ? "working"
            : body.action === "break_start"
              ? "break"
              : body.action === "break_end"
                ? "working"
                : "out";
      }
      if (lost) {
        firstRequest = body.request_id;
        lost = false;
        return route.abort("failed");
      }
      if (body.action === "in")
        assert.equal(
          body.request_id,
          firstRequest,
          "retry must preserve request id",
        );
      data = { ok: true, action: body.action, at: "2026-11-01T08:30:00Z" };
    } else if (body.command === "end") data = { ok: true };
    return route.fulfill({ json: data });
  });
  await page.goto(origin + "/kiosk");
  await page.getByRole("heading", { name: "Synthetic Meadow Team" }).waitFor();
  await page.getByRole("button", { name: "1", exact: true }).click();
  assert.equal(await page.locator("#kiosk-pin").inputValue(), "1");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  await page.getByLabel("Employee PIN").fill("123");
  assert.ok(await continueButton.isDisabled());
  await page.getByLabel("Employee PIN").fill("0123");
  assert.ok(await continueButton.isEnabled());
  await page.getByRole("button", { name: "9", exact: true }).click();
  assert.equal(await page.getByLabel("Employee PIN").inputValue(), "0123");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  assert.ok(await continueButton.isDisabled());
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  const enter = async () => {
    await page.getByLabel("Employee PIN").fill("1234");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("heading", { name: "Hello, Example" }).waitFor();
  };
  await page.getByLabel("Employee PIN").fill("9999");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByText("PIN unavailable. Wait and try again or ask your manager", {
      exact: true,
    })
    .waitFor();
  await enter();
  assert.equal(
    await page.getByRole("button", { name: "Clock Out", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Clock In", exact: true }).click();
  await page.getByRole("button", { name: "Retry Clock In" }).click();
  await page
    .getByText("Clock In recorded. Thank you!", { exact: true })
    .waitFor();
  assert.equal(recorded.size, 1);
  await enter();
  await page
    .getByRole("button", { name: "Start Unpaid Break", exact: true })
    .click();
  await page
    .getByText("Start Unpaid Break recorded. Thank you!", { exact: true })
    .waitFor();
  await enter();
  assert.equal(
    await page.getByRole("button", { name: "Clock Out", exact: true }).count(),
    0,
  );
  await page
    .getByRole("button", { name: "End Unpaid Break", exact: true })
    .click();
  await page
    .getByText("End Unpaid Break recorded. Thank you!", { exact: true })
    .waitFor();
  await enter();
  await page.getByRole("button", { name: "Clock Out", exact: true }).click();
  await page
    .getByText("Clock Out recorded. Thank you!", { exact: true })
    .waitFor();
  assert.equal(recorded.size, 4);
  await page.clock.install();
  await enter();
  await page.clock.fastForward(31000);
  await page
    .getByRole("heading", { name: "Enter your four-digit PIN" })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Hello, Example" }).count(),
    0,
  );
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `no horizontal overflow at ${width}`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "work/phase9-kiosk-mobile.png",
    fullPage: true,
  });
  // Actual route/middleware checks, without mocked API responses.
  const context = await browser.newContext();
  const api = context.request;
  assert.equal(
    (
      await api.post(origin + "/api/kiosk", {
        headers: { origin },
        data: { command: "info" },
      })
    ).status(),
    401,
  );
  assert.equal(
    (
      await api.post(origin + "/api/kiosk", {
        headers: { origin: "https://untrusted.example" },
        data: { command: "info" },
      })
    ).status(),
    403,
  );
  const handoff = await api.get(origin + "/api/kiosk/handoff", {
    maxRedirects: 0,
  });
  assert.equal(handoff.status(), 303);
  assert.equal(handoff.headers()["clear-site-data"], '"cache", "storage"');
  const denied = await api.get(origin + "/workspaces", {
    maxRedirects: 0,
    headers: { Cookie: "__Host-meadowmark-kiosk=synthetic" },
  });
  assert.equal(denied.status(), 307);
  assert.ok(denied.headers().location.endsWith("/kiosk"));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  assert.equal((await page.locator("h1").textContent())?.length > 0, true);
  await page.goto(origin + "/demo");
  assert.ok(await page.locator("main").count());
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: keypad, wrong PIN, valid actions, interrupted retry, inactivity reset, responsive layouts, origin rejection, handoff headers, workspace isolation, homepage and demo.",
  );
} finally {
  await browser.close();
}
