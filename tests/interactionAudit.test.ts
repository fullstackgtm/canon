import assert from "node:assert/strict";
import test from "node:test";
import { interactionSurfaceAudit } from "../scripts/fsgtm.ts";

test("the audit sees actions called from components, and has no unbaselined gap", () => {
  const audit = interactionSurfaceAudit();
  const names = [...audit.results, ...audit.baselined].map((r) => r.mutation);
  // Called with useAction from src/components, not a page.
  assert.ok(names.includes("api.recordMerges.merge"));
  assert.deepEqual(audit.results.filter((r) => r.gaps.length).map((r) => r.mutation), []);
  assert.deepEqual(audit.staleBaseline, []);
});
