import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { test } from "node:test";
import { INTEGRATIONS } from "../src/app/dashboard/integrations/catalog.ts";

test("every integration on the Integrations page has a real logo file", () => {
  for (const integration of INTEGRATIONS) {
    assert.match(integration.logo, /^\/integrations\/[a-z0-9-]+\.(svg|png)$/, integration.key);
    const file = new URL(`../public${integration.logo}`, import.meta.url);
    assert.ok(existsSync(file) && statSync(file).size > 0, `${integration.key}: missing public${integration.logo}`);
  }
});
