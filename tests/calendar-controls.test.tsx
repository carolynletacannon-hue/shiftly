import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CalendarControls } from "../app/workspaces/[id]/my-schedule/calendar/controls";

test("calendar controls: creation, copy failures/success, rotation confirmation, revoke and honest errors", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://example.test",
    pretendToBeVisual: true,
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById("root")!);
  const tokenUrl = "https://example.test/api/calendar?token=" + "a".repeat(43);
  let commands: string[] = [];
  let fail = false;
  const action = async (
    _org: string,
    command: "status" | "rotate" | "revoke",
  ) => {
    commands.push(command);
    return fail
      ? { error: "Please try again" }
      : command === "revoke"
        ? { active: false }
        : { active: true, url: tokenUrl };
  };
  const button = (text: string) =>
    Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === text,
    )!;
  const click = async (text: string) => {
    assert.ok(button(text), text);
    await act(async () => {
      button(text).click();
    });
  };
  try {
    await act(async () =>
      root.render(
        createElement(CalendarControls, {
          org: "org",
          initialActive: false,
          action,
        }),
      ),
    );
    assert.match(document.body.textContent!, /Calendar Integration/);
    assert.equal(document.querySelectorAll("details").length, 4);
    await click("Add to Calendar");
    assert.deepEqual(commands, ["rotate"]);
    assert.equal(
      (document.querySelector("input") as HTMLInputElement).value,
      tokenUrl,
    );
    assert.equal(
      document.querySelector('a[href^="webcal:"]')?.getAttribute("href"),
      tokenUrl.replace("https:", "webcal:"),
    );
    assert.equal(document.querySelector('a[href*="google.com"]'), null);
    assert.ok(!document.body.textContent?.includes("successfully subscribed"));
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw Error("denied");
        },
      },
      configurable: true,
    });
    await click("Copy subscription link");
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Select and copy/,
    );
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (s: string) => {
          copied = s;
        },
      },
      configurable: true,
    });
    await click("Copy subscription link");
    assert.equal(copied, tokenUrl);
    assert.match(
      document.querySelector('[role="status"]')!.textContent!,
      /copied/,
    );
    await click("Regenerate link");
    assert.equal(commands.length, 1);
    await click("Keep existing link");
    assert.equal(commands.length, 1);
    await click("Regenerate link");
    fail = true;
    await click("Create new link");
    assert.equal(
      (document.querySelector("input") as HTMLInputElement).value,
      tokenUrl,
    );
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /Please try again/,
    );
    fail = false;
    await click("Create new link");
    await click("Revoke link");
    assert.equal(commands.at(-1), "rotate");
    await click("Revoke private link");
    assert.equal(commands.at(-1), "revoke");
    assert.equal(document.querySelector("input"), null);
    assert.match(
      document.querySelector('[role="status"]')!.textContent!,
      /revoked/,
    );
    // Missing migration/configuration: useful instructions, no working-looking setup.
    await act(async () =>
      root.render(
        createElement(CalendarControls, {
          org: "other",
          initialActive: false,
          unavailable: true,
          action,
        }),
      ),
    );
    assert.equal(button("Add to Calendar"), undefined);
    assert.match(
      document.querySelector('[role="alert"]')!.textContent!,
      /unavailable/,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of Object.entries(previous))
      Object.defineProperty(globalThis, key, { value, configurable: true });
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
});
