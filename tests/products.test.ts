import { test } from "node:test";
import assert from "node:assert/strict";
import { products, productDestination } from "../lib/products/registry";

test("stable products expose only the existing Workforce destination", () => {
  assert.deepEqual(
    products.map((p) => p.id),
    ["workforce", "connect", "hospitality"],
  );
  assert.equal(new Set(products.map((p) => p.id)).size, 3);
  for (const p of products) {
    assert.ok(p.name && p.description && p.icon);
    if (p.id === "workforce") {
      assert.equal(productDestination(p), "/workspaces");
      assert.equal(productDestination(p, "org-one"), "/workspaces/org-one");
      assert.equal(
        productDestination(p, "../other?x=1"),
        "/workspaces/..%2Fother%3Fx%3D1",
      );
    } else {
      assert.equal(p.status, "coming-soon");
      assert.equal(productDestination(p), null);
      assert.equal(productDestination(p, "forged-organization"), null);
    }
  }
});
