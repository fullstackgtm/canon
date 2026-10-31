import assert from "node:assert/strict";
import test from "node:test";
import { getScenario } from "../src/fixtures/scenarios.ts";
import { mapClaims } from "../src/grade.ts";
import { runOne } from "../src/runner.ts";

test("claim mapping recognizes semantically named generated claims", () => {
  const scenario = getScenario("creative-intelligence-mini");
  const mapped = mapClaims({
    category: scenario.category,
    vendors: scenario.vendors.map((v) => ({ id: v.id, name: v.name, urls: { home: v.urls.home, pricing: v.urls.pricing ?? null, product: v.urls.product ?? [] } })),
    claims: [
      { id: "creative-fatigue", capability: "Creative fatigue detection", icp: "paid social", pricingStructure: "unknown", definition: "Detect ad fatigue and wear-out." },
      { id: "governance", capability: "Brand governance and guardrails", icp: "enterprise", pricingStructure: "unknown", definition: "Approval workflows and guardrails." },
    ],
  }, scenario.goldClaims);
  assert.equal(mapped.get("creative-fatigue"), "fatigue-detection");
  assert.equal(mapped.get("governance"), "enterprise-governance");
});

test("fixture perfect passes in raw and fsgtm arms; sloppy fails", async () => {
  const raw = await runOne("ai-sales-research-mini", "fixture/perfect", "raw");
  assert.equal(raw.metrics.hardGatePass, true);
  assert.equal(raw.taskScore, 100);

  const fsgtm = await runOne("ai-sales-research-mini", "fixture/perfect", "fsgtm");
  assert.equal(fsgtm.metrics.hardGatePass, true);
  assert.equal(fsgtm.taskScore, 100);
  assert.ok(fsgtm.toolCalls >= 3);

  const sloppy = await runOne("ai-sales-research-mini", "fixture/sloppy", "raw");
  assert.ok(sloppy.violations.length > 0);
  assert.ok(sloppy.taskScore < 90);
});
