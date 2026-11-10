import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_ACCEPT, resolveAttribute, writeDecision, type FactLike } from "../convex/lib/canon/policy.ts";

const DAY = 24 * 60 * 60 * 1000;
let n = 0;
function fact(p: Partial<FactLike> & Pick<FactLike, "value" | "sourceKind" | "observedAt">): FactLike {
  n++;
  return { _id: `f${n}`, attribute: "amount", sourceRef: `${p.sourceKind}:opp1:amount`, confidence: 1, status: "accepted", ...p };
}

test("write rule: an unchanged value from the same source re-confirms instead of writing", () => {
  const latest = { _id: "f1", value: 5000, evidence: undefined };
  assert.deepEqual(writeDecision(latest, { value: 5000 }), { kind: "confirm", factId: "f1" });
  assert.deepEqual(writeDecision(latest, { value: 6000 }), { kind: "write" });
  assert.deepEqual(writeDecision(latest, { value: 5000, evidence: "call:seg9" }), { kind: "write" }, "new evidence is a new fact");
  assert.deepEqual(writeDecision(null, { value: 5000 }), { kind: "write" });
});

test("only accepted facts count; empty when none", () => {
  const r = resolveAttribute([fact({ value: 1, sourceKind: "agent_run", observedAt: 1, status: "proposed" })]);
  assert.equal(r.state, "empty");
  assert.equal(r.value, null);
  assert.ok(AUTO_ACCEPT.has("salesforce") && AUTO_ACCEPT.has("import") && !AUTO_ACCEPT.has("enrichment"));
});

test("rule 1: the newest user fact wins over a CRM value", () => {
  const sf = fact({ value: 5000, sourceKind: "salesforce", observedAt: 10 });
  const user = fact({ value: 7500, sourceKind: "user", observedAt: 20 });
  assert.equal(resolveAttribute([sf, user]).value, 7500);
});

test("a newer CRM fact overrides an older user fact (no frozen fields)", () => {
  const user = fact({ value: "commit", sourceKind: "user", observedAt: 10, attribute: "forecastCategory" });
  const sf = fact({ value: "best_case", sourceKind: "salesforce", observedAt: 20, attribute: "forecastCategory" });
  assert.equal(resolveAttribute([user, sf]).value, "best_case");
});

test("rule 2: precedence beats recency across tiers", () => {
  const sf = fact({ value: 5000, sourceKind: "salesforce", observedAt: 10 });
  const enrich = fact({ value: 9000, sourceKind: "enrichment", observedAt: 50 });
  const r = resolveAttribute([sf, enrich]);
  assert.equal(r.value, 5000);
  assert.equal(r.sourceKind, "salesforce");
  assert.equal(r.state, "resolved", "a lower tier disagreeing is not a contest");
});

test("a source's newer fact supersedes its older one", () => {
  const old = fact({ value: 5000, sourceKind: "salesforce", observedAt: 10 });
  const now = fact({ value: 6000, sourceKind: "salesforce", observedAt: 20 });
  assert.equal(resolveAttribute([old, now]).value, 6000);
  assert.equal(resolveAttribute([old, now]).state, "resolved", "a source does not contest itself");
});

test("rule 3: within a tier, low-confidence facts do not win on recency", () => {
  const hi = fact({ value: 100, sourceKind: "enrichment", observedAt: 10, confidence: 0.9, sourceRef: "clay" });
  const lo = fact({ value: 999, sourceKind: "pipeline", observedAt: 30, confidence: 0.2 });
  const r = resolveAttribute([hi, lo], { minConfidence: 0.5, contestWindowMs: DAY, tier: { pipeline: 40 } });
  assert.equal(r.value, 100);
});

test("rule 4: peer sources that disagree within the window are contested", () => {
  const sf = fact({ value: 5000, sourceKind: "salesforce", observedAt: 10 * DAY });
  const hs = fact({ value: 5200, sourceKind: "hubspot", observedAt: 12 * DAY });
  const r = resolveAttribute([sf, hs]);
  assert.equal(r.state, "contested");
  assert.equal(r.value, 5200, "value is still the rule-3 winner (most recent)");
  assert.deepEqual(r.contestedBy, [sf._id]);
  // Outside the window the newer value simply wins.
  const far = fact({ value: 5200, sourceKind: "hubspot", observedAt: 90 * DAY });
  assert.equal(resolveAttribute([sf, far]).state, "resolved");
  // Agreement is not a contest.
  const agree = fact({ value: 5000, sourceKind: "hubspot", observedAt: 11 * DAY });
  assert.equal(resolveAttribute([sf, agree]).state, "resolved");
});

test("as-of replay by transaction time: what Canon knew then", () => {
  const v1 = fact({ value: "Prospecting", sourceKind: "salesforce", observedAt: 100, attribute: "stage" });
  const v2 = fact({ value: "Negotiation", sourceKind: "salesforce", observedAt: 200, attribute: "stage" });
  assert.equal(resolveAttribute([v1, v2], undefined, { knownAt: 150 }).value, "Prospecting");
  assert.equal(resolveAttribute([v1, v2], undefined, { knownAt: 250 }).value, "Negotiation");
  assert.equal(resolveAttribute([v1, v2], undefined, { knownAt: 50 }).state, "empty");
});

test("as-of replay by valid time: what was true then, even if learned later", () => {
  // Backfilled late (observed at 1000) but true in the world since 100.
  const imported = fact({ value: 4000, sourceKind: "import", observedAt: 1000, validFrom: 100 });
  const sf = fact({ value: 6000, sourceKind: "salesforce", observedAt: 1000, validFrom: 500 });
  assert.equal(resolveAttribute([imported, sf], undefined, { validAt: 300 }).value, 4000);
  assert.equal(resolveAttribute([imported, sf], undefined, { validAt: 600 }).value, 6000);
  // Bitemporal: true by 600, but Canon only learned it at 1000.
  assert.equal(resolveAttribute([imported, sf], undefined, { validAt: 600, knownAt: 900 }).state, "empty");
});

test("asserted-empty values resolve to empty", () => {
  const r = resolveAttribute([fact({ value: null, sourceKind: "salesforce", observedAt: 5 })]);
  assert.equal(r.state, "empty");
  assert.ok(r.factId, "the empty assertion is still a receipt");
});

test("a CRM null yields to a lower-tier value learned after it, and wins over one learned before it", () => {
  const noneYet = fact({ value: null, sourceKind: "salesforce", observedAt: 10, attribute: "email" });
  const found = fact({ value: "sam@acme.com", sourceKind: "enrichment", observedAt: 20, attribute: "email" });
  assert.equal(resolveAttribute([noneYet, found]).value, "sam@acme.com", "the CRM had none; the newer found value fills it");
  const cleared = fact({ value: null, sourceKind: "salesforce", observedAt: 30, attribute: "email" });
  const r = resolveAttribute([cleared, found]);
  assert.deepEqual([r.value, r.state, r.sourceKind], [null, "empty", "salesforce"], "a CRM clear after the found value stands");
});

test("a Canon field's value takes an attribute over from the CRMs; a person's newer edit wins until the field decides again", () => {
  const hs = fact({ value: "Software", sourceKind: "hubspot", observedAt: 30 });
  const field = fact({ value: "Technology", sourceKind: "canon_field", observedAt: 10 });
  assert.ok(AUTO_ACCEPT.has("canon_field"));
  assert.equal(resolveAttribute([hs, field]).value, "Technology", "a later CRM value doesn't undo the field's decision");
  const user = fact({ value: "Fintech", sourceKind: "user", observedAt: 40 });
  assert.equal(resolveAttribute([hs, field, user]).value, "Fintech");
  const decidedAgain = fact({ value: "Retail", sourceKind: "canon_field", observedAt: 50 });
  assert.equal(resolveAttribute([hs, field, user, decidedAgain]).value, "Retail");
});
