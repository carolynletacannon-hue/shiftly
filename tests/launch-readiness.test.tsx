import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketingHome } from "../app/marketing";
import { OnboardingChecklist } from "../app/workspaces/[id]/onboarding-checklist";
import { workplaceMilestones } from "../lib/onboarding";
import { publicOrigin } from "../lib/public-site";
import robots from "../app/robots";
import sitemap from "../app/sitemap";

test("public homepage has semantic landmarks, honest previews, six features and working destinations", () => {
  const html = renderToStaticMarkup(createElement(MarketingHome));
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  for (const text of [
    "Less time scheduling.",
    "More time running your business.",
    "Sign In",
    "Get Started",
    'href="/login"',
    'href="/signup?next=%2Fonboarding"',
    'href="#features"',
    'id="features"',
    'id="how-it-works"',
    'id="main-content"',
    "sample data",
    "Demo changes aren’t saved.",
  ])
    assert.ok(html.includes(text), text);
  assert.equal((html.match(/class="feature-card"/g) || []).length, 6);
  assert.ok(html.includes("<summary>Menu</summary>"));
  assert.ok(!html.includes("app-navigation"));
  assert.doesNotMatch(
    html,
    /free forever|payroll processing|AI-generated schedules|testimonials/i,
  );
});
test("signed-in homepage stays public and routes account CTAs to workplaces", () => {
  const html = renderToStaticMarkup(
    createElement(MarketingHome, { signedIn: true }),
  );
  assert.ok(html.includes("Go to Dashboard"));
  assert.ok(html.includes("Open Meadowmark"));
  assert.ok(html.includes('href="/workspaces"'));
  assert.ok(!html.includes('href="/signup'));
  assert.ok(!html.includes('href="/login'));
});
test("onboarding progress comes from existing records and never requires invitations or publishes", () => {
  const steps = workplaceMilestones("sample", {
    timezone: "America/Denver",
    employees: 0,
    schedules: 1,
    published: 0,
  });
  assert.deepEqual(
    steps.map((s) => s.complete),
    [true, true, false, true, false],
  );
  const html = renderToStaticMarkup(
    createElement(OnboardingChecklist, {
      workspace: "sample",
      userId: "sample-user",
      steps,
    }),
  );
  assert.ok(html.includes("3 of 5 steps complete"));
  assert.ok(html.includes("Skip for now"));
  assert.ok(html.includes("Your schedule stays private"));
  assert.ok(!html.includes("<form"));
  assert.ok(
    workplaceMilestones("sample", {
      timezone: "America/Denver",
      employees: 3,
      schedules: 1,
      published: 1,
    }).every((s) => s.complete),
  );
});
test("canonical configuration rejects absent, credentialed and non-origin URLs", () => {
  for (const value of [
    "",
    "not-a-url",
    "http://localhost:3000",
    "https://name:secret@example.test",
    "https://example.test/path",
    "https://example.test/?token=private",
    "https://example.test/#private",
  ])
    assert.equal(publicOrigin(value), undefined);
  assert.equal(
    publicOrigin("https://meadowmark.example/"),
    "https://meadowmark.example",
  );
});
test("sitemap contains only the homepage, robots exclude private routes and tokens", () => {
  const previous = process.env.NEXT_PUBLIC_SITE_URL;
  try {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    assert.deepEqual(sitemap(), []);
    assert.equal(robots().sitemap, undefined);
    process.env.NEXT_PUBLIC_SITE_URL = "https://meadowmark.example";
    assert.deepEqual(
      sitemap().map((p) => p.url),
      ["https://meadowmark.example/"],
    );
    const result = robots();
    assert.equal(result.sitemap, "https://meadowmark.example/sitemap.xml");
    assert.ok(JSON.stringify(result.rules).includes("/workspaces"));
    assert.ok(JSON.stringify(result.rules).includes("/invite"));
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous;
  }
});
