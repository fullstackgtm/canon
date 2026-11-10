import assert from "node:assert/strict";
import { test } from "node:test";
import { can } from "../convex/lib/capabilities.ts";
import { CAPABILITIES, type Capability } from "../modules/kernel/capabilities.ts";

test("each capability is held by exactly the built-in roles that had it before the registry", () => {
  const held = (role: string) => (Object.keys(CAPABILITIES) as Capability[]).filter((c) => can({ role }, c));
  assert.deepEqual(held("admin"), Object.keys(CAPABILITIES));
  assert.deepEqual(held("manager"), ["strategy.edit", "integrations.manage", "targets.set", "pipelines.edit", "agents.run", "recipes.decide", "usage.view", "imports.run", "facts.review", "cleanup.run", "team.edit", "deals.write", "workspace.edit", "tokens.manage", "audiences.manageAll"]);
  assert.deepEqual(held("rep"), []);
  assert.deepEqual(held("other"), []);
});
