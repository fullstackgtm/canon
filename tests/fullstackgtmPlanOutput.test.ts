import assert from "node:assert/strict";
import test from "node:test";
import { compactPlan, verbosePlanRequested } from "../engine/src/cli/planOutput.ts";
import type { PatchPlan } from "../engine/src/types.ts";

const plan = {
  id: "plan_123", title: "Clean contacts", createdAt: "2026-01-01T00:00:00Z",
  status: "needs_approval", dryRun: true, summary: "Fill missing contact data.", findings: [],
  operations: [
    { id: "a", objectType: "contact", objectId: "1", operation: "set_field", field: "title", beforeValue: null, afterValue: "CEO", reason: "missing", riskLevel: "low", approvalRequired: true },
    { id: "b", objectType: "contact", objectId: "2", operation: "set_field", field: "title", beforeValue: null, afterValue: "CTO", reason: "missing", riskLevel: "low", approvalRequired: true },
  ],
} as PatchPlan;

test("compact plan output is short, actionable, and omits operation payloads", () => {
  const output = compactPlan(plan);
  assert.match(output, /Plan preview/);
  assert.match(output, /2 operations · 2 set_field/);
  assert.match(output, /DRY RUN · NOTHING WRITTEN/);
  assert.doesNotMatch(output, /CEO|CTO|beforeValue/);
  assert.ok(output.split("\n").length <= 9);
});

test("saved summaries and verbose flag are explicit", () => {
  assert.match(compactPlan(plan, { saved: true }), /Next\s+fullstackgtm plans show plan_123/);
  assert.equal(verbosePlanRequested(["--verbose"]), true);
  assert.equal(verbosePlanRequested(["--full"]), true);
  assert.equal(verbosePlanRequested(["--json"]), false);
});
