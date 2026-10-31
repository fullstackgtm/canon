import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError } from "convex/values";
import {
  applyDecision,
  dispatchBlockReason,
  providerWritebackBlockReason,
  requiredString,
  sameOperationSubset,
  validProviderResult,
} from "../convex/lib/patchPlanGuards.ts";

// These guards are the decision points patchPlans.apply and
// patchPlanActions.apply share. The safety model they encode: a CRM write
// only ever happens from an approved plan, and a CRM-backed deal patch is
// never marked applied without a matching provider writeback result.

test("apply is blocked for every non-approved plan status", () => {
  for (const status of ["draft", "pending_approval", "rejected", "cancelled", "failed"]) {
    const decision = applyDecision({ status });
    assert.equal(decision.kind, "blocked", `expected ${status} to block apply`);
    assert.match(
      decision.kind === "blocked" ? decision.reason : "",
      /must be approved before apply/,
    );
  }
});

test("approval subsets compare as exact, duplicate-free sets", () => {
  assert.equal(sameOperationSubset(["a", "b"], ["b", "a"]), true);
  assert.equal(sameOperationSubset(["a", "b"], ["a"]), false);
  assert.equal(sameOperationSubset(["a"], ["a", "b"]), false);
  assert.equal(sameOperationSubset(["a", "a"], ["a", "a"]), false);
});

test("apply is allowed only from approved, and applied is idempotent", () => {
  assert.equal(applyDecision({ status: "approved" }).kind, "allowed");
  assert.equal(applyDecision({ status: "applied" }).kind, "already_applied");
});

test("non-set verbs cannot be dispatched by the apply mutation directly", () => {
  assert.match(
    dispatchBlockReason({ verb: "do" }, false) ?? "",
    /applied through patchPlanActions.apply/,
  );
  assert.equal(dispatchBlockReason({ verb: "set" }, false), null);
});

test("already-dispatched do operations only record status, never re-dispatch", () => {
  assert.equal(dispatchBlockReason({ verb: "do" }, true), null);
});

test("a CRM-backed deal requires a matching provider writeback result", () => {
  const hubspotDeal = { crmId: "hs-123", crmProvider: "hubspot" };

  for (const badResult of [
    null,
    undefined,
    "ok",
    42,
    [],
    {},
    { provider: "hubspot" },
    { crmId: "hs-123" },
    { provider: "salesforce", crmId: "hs-123" },
    { provider: "hubspot", crmId: "hs-999" },
    { provider: "local", reason: "Deal has no supported CRM provider metadata" },
  ]) {
    assert.match(
      providerWritebackBlockReason(hubspotDeal, badResult) ?? "",
      /Provider writeback result is required/,
      `expected ${JSON.stringify(badResult)} to be rejected`,
    );
  }

  assert.equal(
    providerWritebackBlockReason(hubspotDeal, { provider: "hubspot", crmId: "hs-123" }),
    null,
  );
  assert.equal(
    providerWritebackBlockReason(
      { crmId: "sf-1", crmProvider: "salesforce" },
      { provider: "salesforce", crmId: "sf-1", field: "NextStep" },
    ),
    null,
  );
});

test("local-only deals apply without a provider writeback result", () => {
  assert.equal(providerWritebackBlockReason({}, null), null);
  assert.equal(providerWritebackBlockReason({ crmId: null, crmProvider: null }, null), null);
  // A deal with CRM metadata from an unsupported provider has no writeback
  // path, so the local apply is not blocked on one.
  assert.equal(
    providerWritebackBlockReason({ crmId: "x-1", crmProvider: "pipedrive" }, null),
    null,
  );
});

test("validProviderResult requires an object carrying the exact provider and crmId", () => {
  assert.equal(validProviderResult({ provider: "hubspot", crmId: "1" }, "hubspot", "1"), true);
  assert.equal(validProviderResult({ provider: "hubspot", crmId: "1" }, "salesforce", "1"), false);
  assert.equal(validProviderResult({ provider: "hubspot", crmId: "2" }, "hubspot", "1"), false);
  assert.equal(validProviderResult([{ provider: "hubspot", crmId: "1" }], "hubspot", "1"), false);
  assert.equal(validProviderResult(null, "hubspot", "1"), false);
});

test("requiredString rejects missing, blank, and non-string plan args", () => {
  assert.equal(requiredString({ nextStep: " Send proposal " }, "nextStep"), "Send proposal");
  for (const args of [null, undefined, [], "x", { nextStep: "" }, { nextStep: "   " }, { nextStep: 7 }, {}]) {
    assert.throws(() => requiredString(args, "nextStep"), ConvexError);
  }
});
