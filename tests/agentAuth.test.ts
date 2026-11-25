import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const ORG_A = "organizations:a";
const ORG_B = "organizations:b";
const NOW = 1_800_000_000_000;

const ADMIN_A = { _id: "users:adminA", orgId: ORG_A, role: "admin", isActive: true, name: "Admin A" };
const REP_A = { _id: "users:repA", orgId: ORG_A, role: "rep", isActive: true, name: "Rep A" };
const REP_A2 = { _id: "users:repA2", orgId: ORG_A, role: "rep", isActive: true, name: "Rep A2" };
const ADMIN_B = { _id: "users:adminB", orgId: ORG_B, role: "admin", isActive: true, name: "Admin B" };
const REP_B = { _id: "users:repB", orgId: ORG_B, role: "rep", isActive: true, name: "Rep B" };

let currentUser: Record<string, unknown> | null = null;
class Clock extends Date {
  static now() {
    return NOW;
  }
}

const loaded = loadConvex(
  ["agentAuth.ts"],
  {
    "lib.ts": (real) => ({
      ...real,
      getCurrentUser: async () => currentUser,
      requireUser: async () => {
        if (!currentUser) throw new Error("Not authenticated");
        return currentUser;
      },
    }),
  },
  { Date: Clock },
);
const agentAuth = loaded["agentAuth.ts"]!;
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function seedDb() {
  return memoryDb({
    users: [ADMIN_A, REP_A, REP_A2, ADMIN_B, REP_B],
    agentRegistrations: [
      {
        _id: "agentRegistrations:a1",
        name: "Org A Bot 1",
        operatorContact: "ops-a@orga.example",
        tokenHash: "a".repeat(64),
        scopes: ["read:evals"],
        registrationIpHash: "1".repeat(64),
        createdAt: NOW - 3000,
        expiresAt: NOW + 86_400_000,
        claimedByUserId: REP_A._id,
        claimedByOrgId: ORG_A,
        claimedAt: NOW - 2000,
      },
      {
        _id: "agentRegistrations:a2",
        name: "Org A Bot 2",
        operatorContact: "ops-a2@orga.example",
        tokenHash: "b".repeat(64),
        scopes: ["read:evals"],
        registrationIpHash: "2".repeat(64),
        createdAt: NOW - 2500,
        expiresAt: NOW + 86_400_000,
        claimedByUserId: REP_A2._id,
        claimedByOrgId: ORG_A,
        claimedAt: NOW - 1500,
      },
      {
        _id: "agentRegistrations:b1",
        name: "Org B Bot",
        operatorContact: "secret-pii@orgb.example",
        tokenHash: "c".repeat(64),
        scopes: ["read:evals"],
        registrationIpHash: "3".repeat(64),
        createdAt: NOW - 2000,
        expiresAt: NOW + 86_400_000,
        claimedByUserId: REP_B._id,
        claimedByOrgId: ORG_B,
        claimedAt: NOW - 1000,
      },
      {
        _id: "agentRegistrations:unclaimed",
        name: "Global Unclaimed Bot",
        operatorContact: "private-unclaimed@external.example",
        tokenHash: "d".repeat(64),
        scopes: ["read:evals"],
        registrationIpHash: "4".repeat(64),
        createdAt: NOW - 1000,
        expiresAt: NOW + 86_400_000,
      },
    ],
  });
}

test("agentAuth.list exposes only registrations claimed within the caller's workspace", async () => {
  const db = seedDb();
  const ctx = { db };

  currentUser = ADMIN_A;
  const listA = await agentAuth.list.handler(ctx, {});
  assert.deepEqual(
    listA.map((r: { _id: string }) => r._id).sort(),
    ["agentRegistrations:a1", "agentRegistrations:a2"],
  );
  assert.doesNotMatch(JSON.stringify(listA), /secret-pii@orgb\.example|private-unclaimed@external\.example/);

  currentUser = ADMIN_B;
  const listB = await agentAuth.list.handler(ctx, {});
  assert.deepEqual(
    listB.map((r: { _id: string }) => r._id),
    ["agentRegistrations:b1"],
  );

  currentUser = REP_A;
  assert.deepEqual(plain(await agentAuth.list.handler(ctx, {})), []);

  currentUser = null;
  assert.deepEqual(plain(await agentAuth.list.handler(ctx, {})), []);
});

test("agentAuth.revoke denies cross-tenant and unclaimed registrations while allowing same-org admins and claim owners", async () => {
  const db = seedDb();
  const ctx = { db };

  // Org A admin cannot revoke Org B's or unclaimed global registrations.
  currentUser = ADMIN_A;
  await assert.rejects(agentAuth.revoke.handler(ctx, { registrationId: "agentRegistrations:b1" }));
  await assert.rejects(agentAuth.revoke.handler(ctx, { registrationId: "agentRegistrations:unclaimed" }));
  assert.equal((await db.get("agentRegistrations:b1"))?.revokedAt, undefined);
  assert.equal((await db.get("agentRegistrations:unclaimed"))?.revokedAt, undefined);

  // Org A non-admin cannot revoke another Org A member's, Org B's, or unclaimed registrations.
  currentUser = REP_A;
  await assert.rejects(agentAuth.revoke.handler(ctx, { registrationId: "agentRegistrations:a2" }));
  await assert.rejects(agentAuth.revoke.handler(ctx, { registrationId: "agentRegistrations:b1" }));
  await assert.rejects(agentAuth.revoke.handler(ctx, { registrationId: "agentRegistrations:unclaimed" }));
  assert.equal((await db.get("agentRegistrations:a2"))?.revokedAt, undefined);

  // Claim owner can revoke their own claimed registration.
  assert.deepEqual(plain(await agentAuth.revoke.handler(ctx, { registrationId: "agentRegistrations:a1" })), { ok: true });
  assert.equal((await db.get("agentRegistrations:a1"))?.revokedAt, NOW);

  // Org A admin can revoke a registration claimed within Org A.
  currentUser = ADMIN_A;
  assert.deepEqual(plain(await agentAuth.revoke.handler(ctx, { registrationId: "agentRegistrations:a2" })), { ok: true });
  assert.equal((await db.get("agentRegistrations:a2"))?.revokedAt, NOW);
});
