import assert from "node:assert/strict";
import { test } from "node:test";
import { emptySpec } from "../convex/lib/icps.ts";
import { resolveFillPrefill } from "../src/lib/fill-prefill.ts";

const first = { key: "icps:default", active: true, updatedAt: 1, spec: emptySpec() };
const selected = { key: "icps:exact/key+value", active: true, updatedAt: 2, spec: {
  ...emptySpec(),
  market: { industries: ["software development"], countries: ["us"], employeeBands: ["201-500"] },
  persona: { ...emptySpec().persona, titles: ["Revenue operations"], levels: ["vp"] },
  exclude: { industries: ["retail"], countries: ["gb"], titles: ["Consultant"] },
} };
const source = { icps: [first, selected] };
const context = { canRun: true, configured: true, icps: source.icps };

test("explicit fill resolves the exact current key and complete spec while absent intent keeps defaults", () => {
  assert.deepEqual(resolveFillPrefill(undefined, new Error("offline"), null), { status: "none" });
  const result = resolveFillPrefill(selected.key, source, context);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("Expected the requested ICP");
  assert.equal(result.icp.key, selected.key);
  assert.deepEqual(result.icp.spec, selected.spec);
});

test("explicit empty, malformed, foreign, inactive, unavailable and failed intent never resolves a fallback", () => {
  for (const key of ["", " ", "%bad", "foreign", "icps:exact/key+Value"]) {
    assert.equal(resolveFillPrefill(key, source, context).status, "refused");
  }
  for (const current of [null, new Error("unavailable"), { icps: [] }, { icps: [{ ...selected, active: false }] }]) {
    assert.equal(resolveFillPrefill(selected.key, current, context).status, "refused");
  }
  for (const current of [null, new Error("denied"), { ...context, icps: [] }, { ...context, canRun: false }, { ...context, configured: false }]) {
    assert.equal(resolveFillPrefill(selected.key, source, current).status, "refused");
  }
  assert.equal(resolveFillPrefill(selected.key, undefined, context).status, "loading");
  assert.equal(resolveFillPrefill(selected.key, source, undefined).status, "loading");
});

test("changed requests and current definitions carry a fresh form identity or refuse removed sources", () => {
  const resolve = (key: string, icps = source.icps) => {
    const result = resolveFillPrefill(key, { icps }, context);
    assert.equal(result.status, "ready");
    if (result.status !== "ready") throw new Error("Expected a current ICP");
    return result;
  };
  const before = resolve(selected.key);
  assert.equal(resolve(selected.key, structuredClone(source.icps)).revision, before.revision);
  const changed = { ...selected, updatedAt: 3, spec: { ...selected.spec, market: first.spec.market } };
  assert.notEqual(resolve(selected.key, [first, changed]).revision, before.revision);
  assert.deepEqual(resolve(selected.key, [first, changed]).icp.spec, changed.spec);
  assert.notEqual(resolve(first.key).revision, before.revision);
  assert.equal(resolveFillPrefill(selected.key, { icps: [first] }, context).status, "refused");
});
