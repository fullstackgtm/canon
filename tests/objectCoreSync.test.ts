import assert from "node:assert/strict";
import { test } from "node:test";
import { staleCopies } from "../scripts/sync-object-core.ts";

test("the record service's copy of the fold, registry and policy matches convex/lib", () => {
  assert.deepEqual(staleCopies(), [], "run: node --experimental-strip-types scripts/sync-object-core.ts");
});
