import assert from "node:assert/strict";
import test from "node:test";
import {
  grantFor, grantRequestRefusal, grantState, planFits, signGrant, type GrantFact, type GrantTerms, type StoredGrant,
} from "../convex/lib/agents/grants.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

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
  assert.equal(await grantState(g, KEY, NOW, true), "live");
  assert.equal(await grantState(g, KEY, NOW, false), "lapsed");
  assert.equal(planFits(g, "lapsed", AGENT, [fact()], 1, 0).ok, false);
  for (const tampered of [
    { ...g, attribute: "custom.owner" },
    { ...g, allowedValues: ["smb", "enterprise", "anything"] },
    { ...g, expiresAt: g.expiresAt + 1 },
    { ...g, agentId: "agent2" },
  ]) {
    const state = await grantState(tampered, KEY, NOW, true);
    assert.equal(state, "invalid");
    assert.equal(planFits(tampered, state, tampered.agentId, [fact({ actor: { kind: "agent", id: tampered.agentId } })], 1, 0).ok, false);
  }
  // Another key, or none, verifies nothing.
  assert.equal(await grantState(g, "other-key", NOW, true), "invalid");
  assert.equal(await grantState(g, null, NOW, true), "invalid");
  assert.equal(await grantState(g, KEY, g.expiresAt, true), "expired");
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
  const state = await grantState(revoked, KEY, NOW, true);
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

test("standing agent grants lapse immediately when the granting admin is demoted or deactivated", async () => {
  const ORG = "organizations:org1";
  const OTHER_ORG = "organizations:org2";
  const AGENT_ID = "agents:one";
  const HOME_ADMIN = "users:homeAdmin";
  const MEMBER_ADMIN = "users:memberAdmin";
  const GRANT_HOME = "agentGrants:home";
  const GRANT_MEMBER = "agentGrants:member";
  const PLAN_ID = "patchPlans:p1";

  class Clock extends Date {
    static now() {
      return NOW;
    }
  }
  const loaded = loadConvex(
    ["agentGrants.ts", "lib/agents/grantRead.ts"],
    {
      "lib/runtimeConfig.ts": (real) => ({ ...real, derivedSecret: async () => KEY }),
    },
    { Date: Clock },
  );
  const agentGrants = loaded["agentGrants.ts"] as unknown as typeof import("../convex/agentGrants.ts");
  const grantRead = loaded["lib/agents/grantRead.ts"] as unknown as typeof import("../convex/lib/agents/grantRead.ts");
  const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

  const homeTerms: GrantTerms = {
    grantId: GRANT_HOME, orgId: ORG, agentId: AGENT_ID, operation: "set_field", entityType: "account",
    attribute: "custom.tier", allowedValues: ["enterprise"], maxPerDay: 3, expiresAt: NOW + 86_400_000,
    createdBy: HOME_ADMIN, createdAt: NOW - 1000,
  };
  const memberTerms: GrantTerms = {
    ...homeTerms, grantId: GRANT_MEMBER, createdBy: MEMBER_ADMIN,
  };

  const db = memoryDb({
    users: [
      { _id: HOME_ADMIN, orgId: ORG, role: "admin", isActive: true, name: "Home Admin" },
      { _id: MEMBER_ADMIN, orgId: OTHER_ORG, role: "rep", isActive: true, name: "Member Admin" },
    ],
    orgMemberships: [
      { _id: "orgMemberships:m1", userId: MEMBER_ADMIN, orgId: ORG, role: "admin", isActive: true },
    ],
    agents: [{ _id: AGENT_ID, orgId: ORG, slug: "one", ledgerKey: "agent:one", ownerUserId: HOME_ADMIN }],
    agentGrants: [
      { _id: GRANT_HOME, ...homeTerms, signature: await signGrant(homeTerms, KEY) },
      { _id: GRANT_MEMBER, ...memberTerms, signature: await signGrant(memberTerms, KEY) },
    ],
    patchPlans: [{ _id: PLAN_ID, orgId: ORG, agentId: AGENT_ID, operation: "canon.propose_facts", status: "pending_approval" }],
    facts: [{
      _id: "facts:1", orgId: ORG, entityId: "canonEntities:1", entityType: "account", attribute: "custom.tier",
      value: "enterprise", evidence: "\"Enterprise customer\"", status: "proposed", patchPlanId: PLAN_ID,
      actor: { kind: "agent", id: AGENT_ID },
    }],
    patchOperations: [{ _id: "patchOperations:1", patchPlanId: PLAN_ID }],
  });
  const ctx = { db } as never;

  // Both grants start live while their granting admins are active admins in ORG.
  assert.equal((await agentGrants.liveGrants(ctx, AGENT_ID as never, NOW)).length, 2);
  assert.equal(await grantRead.storedGrantState(ctx, (await db.get(GRANT_HOME)) as never, KEY, NOW), "live");
  assert.equal(await grantRead.storedGrantState(ctx, (await db.get(GRANT_MEMBER)) as never, KEY, NOW), "live");

  // Demoting home admin lapses their grant immediately; approveUnderGrant refuses it.
  await db.patch(HOME_ADMIN, { role: "manager" });
  assert.equal(await grantRead.storedGrantState(ctx, (await db.get(GRANT_HOME)) as never, KEY, NOW), "lapsed");
  assert.deepEqual(plain((await agentGrants.liveGrants(ctx, AGENT_ID as never, NOW)).map((g) => g.grantId)), [GRANT_MEMBER]);
  const demotedAttempt = await agentGrants.approveUnderGrant(ctx, {
    agent: { _id: AGENT_ID, orgId: ORG } as never,
    grantId: GRANT_HOME as never,
    patchPlanId: PLAN_ID as never,
  });
  assert.equal(demotedAttempt.approved, false);
  assert.equal((await db.get("facts:1"))?.status, "proposed");

  // Restoring admin role then deactivating home admin also lapses their grant immediately.
  await db.patch(HOME_ADMIN, { role: "admin", isActive: false });
  assert.equal(await grantRead.storedGrantState(ctx, (await db.get(GRANT_HOME)) as never, KEY, NOW), "lapsed");
  const deactivatedAttempt = await agentGrants.approveUnderGrant(ctx, {
    agent: { _id: AGENT_ID, orgId: ORG } as never,
    grantId: GRANT_HOME as never,
    patchPlanId: PLAN_ID as never,
  });
  assert.equal(deactivatedAttempt.approved, false);
  assert.equal((await db.get("facts:1"))?.status, "proposed");

  // Demoting or deactivating the multi-org membership admin lapses their grant in ORG too.
  await db.patch("orgMemberships:m1", { role: "rep" });
  assert.equal(await grantRead.storedGrantState(ctx, (await db.get(GRANT_MEMBER)) as never, KEY, NOW), "lapsed");
  await db.patch("orgMemberships:m1", { role: "admin", isActive: false });
  assert.equal(await grantRead.storedGrantState(ctx, (await db.get(GRANT_MEMBER)) as never, KEY, NOW), "lapsed");
  assert.deepEqual(plain(await agentGrants.liveGrants(ctx, AGENT_ID as never, NOW)), []);
});
