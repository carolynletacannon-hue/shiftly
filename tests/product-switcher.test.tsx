import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductSwitcher } from "../app/product-switcher";

test("switcher provides one real destination, honest previews and no fake controls", () => {
  for (const organizationId of [undefined, "sample-workplace"]) {
    const html = renderToStaticMarkup(
      createElement(ProductSwitcher, { organizationId }),
    );
    assert.match(html, /<summary aria-label="Meadowmark products"/);
    assert.equal((html.match(/Coming Soon/g) || []).length, 2);
    assert.equal((html.match(/<a /g) || []).length, 1);
    assert.ok(
      html.includes(
        `href="/workspaces${organizationId ? "/" + organizationId : ""}"`,
      ),
    );
    for (const name of ["Workforce", "Connect", "Hospitality"])
      assert.ok(html.includes(`Meadowmark ${name}`));
    assert.doesNotMatch(html, /href="(?:#|\/connect|\/hospitality)|<button/);
  }
});
