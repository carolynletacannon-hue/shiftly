import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import {
  PreferenceControls,
  Inbox,
} from "../app/workspaces/[id]/notifications/controls";
import { NotificationBell } from "../app/notification-bell";
import { preferenceDefaults } from "../lib/notifications/preferences";

test("notification bell counts, zero/unknown state and workspace deep link", () => {
  const html = renderToStaticMarkup(
    createElement(NotificationBell, { base: "/workspaces/test", unread: 3 }),
  );
  assert.match(html, /Notifications, 3 unread/);
  assert.match(html, /href="\/workspaces\/test\/notifications"/);
  assert.match(
    renderToStaticMarkup(
      createElement(NotificationBell, {
        base: "/workspaces/test",
        unread: 120,
      }),
    ),
    /99\+/,
  );
  for (const unread of [0, null])
    assert.ok(
      !renderToStaticMarkup(
        createElement(NotificationBell, { base: "/workspaces/test", unread }),
      ).includes("notification-count"),
    );
});
test("preferences report actual save failures and success; inbox read action and safe links", async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://example.test",
    pretendToBeVisual: true,
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    self: globalThis.self,
    FormData: globalThis.FormData,
  };
  for (const key of [
    "window",
    "document",
    "navigator",
    "self",
    "FormData",
  ] as const)
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
    });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById("root")!);
  let fail = true;
  const saved: object[] = [];
  const reads: (string | undefined)[] = [];
  try {
    await act(async () =>
      root.render(
        createElement(PreferenceControls, {
          org: "test",
          initial: preferenceDefaults,
          manager: false,
          action: async (org, values) => {
            assert.equal(org, "test");
            saved.push(values);
            return {
              ok: !fail,
              message: fail
                ? "Unable to save preferences."
                : "Notification preferences saved.",
            };
          },
        }),
      ),
    );
    const inputs = [
      ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    assert.equal(inputs.length, 7);
    assert.equal(inputs.filter((i) => i.checked).length, 4);
    assert.equal(inputs.filter((i) => i.disabled).length, 2);
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.match(document.body.textContent!, /Unable to save/);
    assert.ok(!document.body.textContent!.includes("preferences saved"));
    fail = false;
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.match(document.body.textContent!, /Notification preferences saved/);
    assert.equal(saved.length, 2);
    await act(async () =>
      root.render(
        createElement(Inbox, {
          org: "test",
          items: [
            {
              id: "one",
              message: "Approved",
              href: "/workspaces/test/time-off#request-one",
              read_at: null,
              created_at: "2030-01-01T00:00:00Z",
            },
            {
              id: "two",
              message: "Private",
              href: "/workspaces/another/time-off",
              read_at: "2030-01-01T00:00:00Z",
              created_at: "2030-01-01T00:00:00Z",
            },
          ],
          action: async (_, id) => {
            reads.push(id);
            return { ok: true, message: "Notifications marked as read." };
          },
        }),
      ),
    );
    assert.equal(document.querySelectorAll("a").length, 1);
    assert.match(document.querySelector("a")!.href, /time-off#request-one/);
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Mark as read")!
        .click(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Mark all as read")!
        .click(),
    );
    assert.deepEqual(reads, ["one", undefined]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of [
      "window",
      "document",
      "navigator",
      "self",
      "FormData",
    ] as const)
      Object.defineProperty(globalThis, key, {
        value: previous[key],
        configurable: true,
      });
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
});
