import assert from "node:assert/strict";
import test from "node:test";
import { runScopeOf, type RunScope } from "../convex/lib/scopeValidators.ts";

test("a contact run reads back a contact scope, typed or from a legacy filter", () => {
  const scope = { entity: "contact", scope: { ids: ["c1", "c2"] } } satisfies RunScope;
  assert.deepEqual(runScopeOf({ scope, filter: scope.scope }, "contact"), { entity: "contact", scope: { ids: ["c1", "c2"] } });
  assert.deepEqual(runScopeOf({ filter: { ids: ["c1"] } }, "contact"), { entity: "contact", scope: { ids: ["c1"] } });
  assert.deepEqual(runScopeOf({ filter: { minFit: 0.5 } }, "account"), { entity: "account", filter: { minFit: 0.5 } });
});
