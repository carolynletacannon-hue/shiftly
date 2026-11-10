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
  // A lost hourly rotation response must not demand manager reenrollment.
  await page.route("**/api/kiosk", async (route) => {
    if (route.request().postDataJSON().command === "rotate")
      return route.abort();
    return route.fallback();
  });
  await page.clock.fastForward(3600000);
  assert.equal(
    await page
      .getByRole("heading", { name: "Manager authorization required" })
      .count(),
    0,
  );
  await page.reload();
  await page.getByRole("heading", { name: "Synthetic Meadow Team" }).waitFor();
  await enter();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  // Authorization errors must not navigate until local exit is confirmed.
  await page.unroute("**/api/kiosk");
  let allowExit = false;
  await page.route("**/api/kiosk", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: body.command === "end" && allowExit ? 200 : 403,
      contentType: "application/json",
      body: JSON.stringify(
        body.command === "end" && allowExit
          ? { ok: true }
          : { error: "Kiosk authorization required" },
      ),
    });
  });
  await page.goto(origin + "/kiosk");
  await page
    .getByRole("heading", { name: "Manager authorization required" })
    .waitFor();
  await page
    .getByRole("button", { name: "Clear kiosk mode & sign in" })
    .click();
  await page.waitForFunction(() => !document.querySelector("button")?.disabled);
  assert.equal(new URL(page.url()).pathname, "/kiosk");
  assert.equal(await page.getByLabel("Employee PIN").count(), 0);
  await page.reload();
  await page
    .getByRole("heading", { name: "Kiosk mode ended on this browser" })
    .waitFor();
  assert.equal(await page.getByLabel("Employee PIN").count(), 0);
  allowExit = true;
  await page.getByRole("button", { name: "Retry sign out" }).click();
  await page.waitForURL(origin + "/login");
  await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  // A new browser context restores a persistent cookie without a manager session.
  const durable = await browser.newContext();
  await durable.addCookies([
    {
      name: "__Host-meadowmark-kiosk",
      value: "a".repeat(43),
      domain: new URL(origin).hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      expires: Math.floor(Date.now() / 1000) + 400 * 86400,
    },
  ]);
  const saved = await durable.storageState();
  await durable.close();
  const restarted = await browser.newContext({ storageState: saved });
  const restartedPage = await restarted.newPage();
  await restartedPage.route("**/api/kiosk", async (route) => {
    assert.match(
      route.request().headers().cookie || "",
      /__Host-meadowmark-kiosk=/,
    );
    const command = route.request().postDataJSON().command;
    await route.fulfill({
      json:
        command === "info"
          ? {
              name: "Restarted workplace",
              timezone: "America/Denver",
              now: new Date().toISOString(),
            }
          : { ok: true },
    });
  });
  await restartedPage.goto(origin + "/kiosk");
  await restartedPage
    .getByRole("heading", { name: "Restarted workplace" })
    .waitFor();
  assert.equal(
    (await restarted.cookies()).filter((c) => c.name.startsWith("sb-")).length,
    0,
  );
  await restarted.close();
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
  // Exit waits for an in-flight cookie rotation before clearing authorization.
  const raceContext = await browser.newContext();
  const racePage = await raceContext.newPage();
  let releaseRotation;
  const rotationGate = new Promise((resolve) => {
    releaseRotation = resolve;
  });
  let rotationStarted;
  const started = new Promise((resolve) => {
    rotationStarted = resolve;
  });
  let ended = false;
  await racePage.route("**/api/kiosk", async (route) => {
    const command = route.request().postDataJSON().command;
    if (command === "rotate") {
      rotationStarted();
      await rotationGate;
    }
    if (command === "end") ended = true;
    await route.fulfill({
      json:
        command === "info"
          ? {
              name: "Exit race workplace",
              timezone: "America/Denver",
              now: new Date().toISOString(),
            }
          : { ok: true },
    });
  });
  await racePage.goto(origin + "/kiosk");
  await started;
  await racePage.getByText("End kiosk mode", { exact: true }).click();
  await racePage
    .getByRole("button", { name: "End & revoke this kiosk" })
    .click();
  await racePage
    .getByRole("heading", { name: "Kiosk mode ended on this browser" })
    .waitFor();
  assert.equal(ended, false, "exit must wait for the renewal response");
  releaseRotation();
  await racePage.waitForURL(origin + "/login");
  assert.equal(ended, true);
  await raceContext.close();
  console.log(
    "Browser checks passed: persistent cookie restart, lost rotation response, reload, durable local exit, rotation/exit race, keypad, wrong PIN, valid actions, interrupted retry, inactivity reset, responsive layouts, origin rejection, handoff headers, workspace isolation, homepage and demo.",
  );
} finally {
  await browser.close();
}
