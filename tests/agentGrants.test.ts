import assert from "node:assert/strict";
import test from "node:test";
import {
  grantFor, grantRequestRefusal, grantState, planFits, signGrant, type GrantFact, type GrantTerms, type StoredGrant,
} from "../convex/lib/agents/grants.ts";

const KEY = "test-signing-key";
const NOW = 1_800_000_000_000;
const AGENT = "agent1";

async function grant(over: Partial<GrantTerms> = {}): Promise<StoredGrant> {
  const t: GrantTerms = {
    grantId: "g1", orgId: "org1", agentId: AGENT, operation: "set_field", entityType: "account", attribute: "custom.tier",
    allowedValues: ["smb", "enterprise"], maxPerDay: 3, expiresAt: NOW + 86_400_000, createdBy: "admin1", createdAt: NOW - 1000, ...over,
  };
  return { ...t, signature: await signGrant(t, KEY) };
}

const fact = (over: Partial<GrantFact> = {}): GrantFact => ({
  id: "f1", status: "proposed", entityId: "e1", entityType: "account", attribute: "custom.tier", value: "enterprise",
  evidence: "\"We serve the Fortune 500\"\n\nSource: https://acme.example", actor: { kind: "agent", id: AGENT }, ...over,
});

test("a grant whose terms changed after signing is inert", async () => {
  const g = await grant();
  assert.equal(await grantState(g, KEY, NOW), "live");
  for (const tampered of [
    { ...g, attribute: "custom.owner" },
    { ...g, allowedValues: ["smb", "enterprise", "anything"] },
    { ...g, expiresAt: g.expiresAt + 1 },
    { ...g, agentId: "agent2" },
  ]) {
    const state = await grantState(tampered, KEY, NOW);
    assert.equal(state, "invalid");
    assert.equal(planFits(tampered, state, tampered.agentId, [fact({ actor: { kind: "agent", id: tampered.agentId } })], 1, 0).ok, false);
  }
  // Another key, or none, verifies nothing.
  assert.equal(await grantState(g, "other-key", NOW), "invalid");
  assert.equal(await grantState(g, null, NOW), "invalid");
  assert.equal(await grantState(g, KEY, g.expiresAt), "expired");
});

test("a plan that exceeds the grant in any way falls back to a person, whole", async () => {
  const g = await grant();
  const fits = (facts: GrantFact[], ops = facts.length, used = 0) => planFits(g, "live", AGENT, facts, ops, used).ok;
  assert.equal(fits([fact()]), true);
  assert.equal(fits([fact(), fact({ id: "f2", attribute: "custom.other" })]), false, "one fact on another field sinks the plan");
  assert.equal(fits([fact({ value: "mid-market" })]), false, "a value outside the allowed set");
  assert.equal(fits([fact({ evidence: " " })]), false, "no quote");
  assert.equal(fits([fact({ value: null })]), false, "clearing a field");
  assert.equal(fits([fact({ actor: { kind: "agent", id: "agent2" } })]), false, "another agent's fact");
  assert.equal(fits([fact({ status: "accepted" })]), false, "already decided");
  assert.equal(fits([fact()], 2), false, "an operation that is not one of its facts");
  assert.equal(fits([fact(), fact({ id: "f2" })], 2, 2), false, "over the daily cap");
  // Before submission, only covered answers are grouped under the grant.
  assert.equal(grantFor([g], { entityType: "account", attribute: "custom.tier", value: "smb" }), g);
  assert.equal(grantFor([g], { entityType: "contact", attribute: "custom.tier", value: "smb" }), null);
});

test("a revoked grant approves no later plan", async () => {
  const g = await grant();
  const revoked = { ...g, revokedAt: NOW - 1 };
  const state = await grantState(revoked, KEY, NOW);
  assert.equal(state, "revoked");
  assert.equal(planFits(revoked, state, AGENT, [fact()], 1, 0).ok, false);
});

test("only an admin can create a grant", () => {
  const request = {
    agent: { orgId: "org1", agentId: AGENT, fieldSlugs: ["tier"] },
    field: { slug: "tier", entityType: "account", choices: ["smb", "enterprise"] },
    days: 30,
  };
  for (const viewerRole of ["manager", "rep", "other"]) assert.match(grantRequestRefusal({ ...request, viewerRole }) ?? "", /admin/i);
  assert.equal(grantRequestRefusal({ ...request, viewerRole: "admin" }), null);
});
