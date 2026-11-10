import assert from "node:assert/strict";
import test from "node:test";
import { autoAcceptDecision, mayWrite, needsVerification, ownershipGrid, type AutoAcceptRule } from "../convex/lib/canon/gate.ts";
import { attributeLabel, isKnownAttribute } from "../convex/lib/canon/attributes.ts";

test("default ownership: CRMs, imports and users write everything; agents never write owner or amount", () => {
  for (const k of ["user", "salesforce", "hubspot", "import"] as const) assert.ok(mayWrite(k, "crmOwnerId"));
  for (const k of ["agent_run", "enrichment", "call", "pipeline"] as const) {
    assert.equal(mayWrite(k, "crmOwnerId"), false);
    assert.equal(mayWrite(k, "amount"), false);
    assert.ok(mayWrite(k, "nextStep"));
    assert.ok(mayWrite(k, "closeDate"));
  }
});

test("an org override flips one cell, either way", () => {
  assert.ok(mayWrite("call", "stage", [{ sourceKind: "call", attribute: "stage", allowed: true }]));
  assert.equal(mayWrite("salesforce", "nextStep", [{ sourceKind: "salesforce", attribute: "nextStep", allowed: false }]), false);
  const grid = ownershipGrid(["stage"], [{ sourceKind: "call", attribute: "stage", allowed: true }]);
  assert.deepEqual(grid.find((r) => r.sourceKind === "call")?.cells[0], { attribute: "stage", allowed: true, overridden: true });
});

test("auto-accept is off without a rule, and never accepts unchecked or evidence-free facts", () => {
  const rules: AutoAcceptRule[] = [{ sourceKind: "call", attribute: "nextStep", minConfidence: 0.9, enabled: true }];
  const fact = { sourceKind: "call" as const, attribute: "nextStep", evidence: "call:seg9 'we'll send the MSA Friday'" };
  assert.deepEqual(autoAcceptDecision(fact, [], 0.99), { accept: false, reason: "no_rule" });
  assert.deepEqual(autoAcceptDecision({ ...fact, evidence: " " }, rules, 0.99), { accept: false, reason: "no_evidence" });
  assert.deepEqual(autoAcceptDecision(fact, rules, undefined), { accept: false, reason: "unverified" });
  assert.deepEqual(autoAcceptDecision(fact, rules, 0.5), { accept: false, reason: "below_threshold" });
  assert.equal(autoAcceptDecision(fact, rules, 0.95).accept, true);
  assert.equal(autoAcceptDecision(fact, [{ ...rules[0], enabled: false }], 0.95).accept, false);
  assert.ok(needsVerification(fact, rules));
  assert.equal(needsVerification({ ...fact, attribute: "closeDate" }, rules), false);
});

test("ownership and auto-accept rules are scoped by entity type; rules without one are deal rules", () => {
  assert.equal(mayWrite("agent_run", "name", [], "account"), false);
  assert.equal(mayWrite("agent_run", "domain", [], "account"), false);
  assert.ok(mayWrite("agent_run", "industry", [], "account"));
  assert.ok(mayWrite("agent_run", "custom.ehr_vendor", [], "account"));
  assert.ok(mayWrite("agent_run", "email", [], "contact"));
  assert.equal(mayWrite("agent_run", "ownerId", [], "contact"), false);
  assert.ok(mayWrite("salesforce", "domain", [], "account"), "systems of record own identity fields");
  const dealOverride = [{ sourceKind: "agent_run" as const, attribute: "name", allowed: true }];
  assert.ok(mayWrite("agent_run", "name", dealOverride));
  assert.equal(mayWrite("agent_run", "name", dealOverride, "account"), false);
  assert.ok(mayWrite("agent_run", "name", [{ ...dealOverride[0], entityType: "account" }], "account"));

  const rule: AutoAcceptRule = { sourceKind: "agent_run", attribute: "custom.ehr_vendor", minConfidence: 0.8, enabled: true, entityType: "account" };
  const fact = { sourceKind: "agent_run" as const, attribute: "custom.ehr_vendor", evidence: "We run on Epic.", entityType: "account" as const };
  assert.equal(autoAcceptDecision(fact, [rule], 0.9).accept, true);
  assert.equal(autoAcceptDecision({ ...fact, entityType: "contact" }, [rule], 0.9).accept, false);
  assert.equal(autoAcceptDecision({ ...fact, entityType: undefined }, [rule], 0.9).accept, false, "a fact without a type is a deal fact");
});

test("attribute catalog: deals take only their fields; accounts and contacts also take custom.<slug>", () => {
  assert.ok(isKnownAttribute("opportunity", "nextStep"));
  assert.equal(isKnownAttribute("opportunity", "custom.x"), false);
  assert.ok(isKnownAttribute("account", "custom.ehr_vendor"));
  assert.ok(isKnownAttribute("contact", "title"));
  for (const bad of ["custom.", "custom.Has_Caps", "custom.1st", "custom.a-b", "ehr_vendor", `custom.${"a".repeat(64)}`]) {
    assert.equal(isKnownAttribute("account", bad), false, bad);
  }
  assert.equal(attributeLabel("account", "custom.ehr_vendor"), "ehr vendor");
  assert.equal(attributeLabel("opportunity", "closeDate"), "expected close date");
});
