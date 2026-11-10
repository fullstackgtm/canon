import assert from "node:assert/strict";
import test from "node:test";
import { canonSnapshot, type CanonCompany, type CanonParentEdge } from "../engine/src/accountHierarchy/canonSnapshot.ts";
import { detectCandidateGroups } from "../engine/src/accountHierarchy/detect.ts";
import { resolvePolicy } from "../engine/src/accountHierarchy/policy.ts";
import { readSalesforceSnapshot, type SoqlRow } from "../engine/src/accountHierarchy/salesforceSnapshot.ts";
import { readCanonSnapshot } from "../convex/lib/hierarchyCanon.ts";
import { accessOf, type ObjectRule } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import type { AccountRow } from "../convex/lib/recordContract.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const policy = resolvePolicy({ ultimateParentField: "vendorParent" });
// One family three ways: a shared domain, a legal-suffix name match, and a vendor parent naming a top company.
const family: Array<{ id: string; name: string; domain: string; parent?: string; vendor?: string }> = [
  { id: "maison", name: "Maison Group SE", domain: "maison.com" },
  { id: "maison2", name: "Maison", domain: "maison.com" },
  { id: "brand", name: "Brand A", domain: "branda.com", vendor: "Maison Group" },
  { id: "gamma1", name: "Gamma Ltd", domain: "gamma.com", parent: "maison" },
  { id: "gamma2", name: "Gamma Inc", domain: "gamma.io" },
  { id: "other", name: "Unrelated", domain: "other.com" },
];
const once = <T>(page: T[]) => ({ page, isDone: true, continueCursor: "" });

test("a Canon snapshot builds the same groups as the same accounts read from Salesforce", async () => {
  const soql = async (q: string): Promise<SoqlRow[]> =>
    q.includes("FROM Account")
      ? family.map((a) => ({ Id: a.id, Name: a.name, Website: a.domain, ParentId: a.parent ?? null, vendorParent: a.vendor ?? null }))
      : [];
  const salesforce = await readSalesforceSnapshot(soql, async () => new Set(["vendorParent"]), policy);
  const canon = canonSnapshot({
    companies: family.map((a) => ({ id: a.id, name: a.name, domain: a.domain, ...(a.vendor ? { traits: { vendorParent: a.vendor } } : {}) })),
    parents: family.filter((a) => a.parent).map((a) => ({ childId: a.id, parentId: a.parent!, createdAt: 1 })),
    members: [],
  });
  const groups = (s: typeof canon) => detectCandidateGroups(s, policy).groups.map((g) => ({ ids: g.accountIds, reasons: g.reasons }));
  assert.deepEqual(groups(canon), groups(salesforce));
  assert.deepEqual(groups(canon).map((g) => g.ids), [["brand", "maison", "maison2"], ["gamma1", "gamma2"]]);
});

test("parent edges become the tree: one parent each, the oldest edge, never to a company outside the snapshot", () => {
  const companies: CanonCompany[] = ["top", "mid", "leaf", "twin"].map((id) => ({ id, name: id }));
  const parents: CanonParentEdge[] = [
    { childId: "leaf", parentId: "twin", createdAt: 5 },
    { childId: "leaf", parentId: "mid", createdAt: 2 },
    { childId: "mid", parentId: "top", createdAt: 1 },
    { childId: "twin", parentId: "gone", createdAt: 1 },
    { childId: "top", parentId: "top", createdAt: 1 },
  ];
  const tree = Object.fromEntries(canonSnapshot({ companies, parents, members: [] }).accounts.map((a) => [a.id, a.parentAccountId ?? null]));
  assert.deepEqual(tree, { top: null, mid: "top", leaf: "mid", twin: null });
});

test("a company the scan's starter cannot see is not in the snapshot, nor its edges or deals", async () => {
  const store = createMemoryRecordStore();
  const row = (id: string, name: string, ownerId: string) =>
    ({ id, domain: `${id}.example`, name, fit: 0.5, status: "new", segmentIds: [], source: "csv", updatedAt: 1, version: 1, ownerId }) as AccountRow;
  await store.putAccounts("ws", [row("atlas", "Atlas", "avery"), row("atlas-eu", "Atlas Europe", "avery"), row("secret", "Secret Holdings", "jordan")]);
  const ownOnly: ObjectRule[] = [{ object: "account", visibility: "own", unowned: false }];
  const client = scopedRecordClient(createFakeRecordClient({ store }), [accessOf({ userId: "avery", role: "rep", rules: ownOnly })], async () => null);
  const deal = (id: string, companyId: string) => ({ id, companyId, name: id, isClosed: true, isWon: true });
  const snapshot = await readCanonSnapshot({
    client,
    orgId: "ws",
    parents: async () => once([{ childId: "atlas-eu", parentId: "atlas", createdAt: 1 }, { childId: "atlas", parentId: "secret", createdAt: 1 }]),
    deals: async () => once([deal("d1", "atlas"), deal("d2", "secret")]),
    members: [{ id: "avery", name: "Avery" }],
  });
  assert.deepEqual(snapshot.accounts.map((a) => [a.id, a.parentAccountId ?? null]), [["atlas", null], ["atlas-eu", "atlas"]]);
  assert.deepEqual(snapshot.deals.map((d) => d.id), ["d1"]);
});

test("a workspace without Salesforce starts a Canon scan; Salesforce needs a connection", async () => {
  const files = loadConvex(["accountHierarchy.ts"]);
  const db = memoryDb({
    organizations: [{ _id: "org", clerkOrgId: "clerk_org" }],
    users: [{ _id: "admin", clerkUserId: "clerk_admin", orgId: "org", role: "admin", isActive: true }],
  });
  const scheduled: string[] = [];
  const ctx = {
    db,
    auth: { getUserIdentity: async () => ({ subject: "clerk_admin", tokenIdentifier: "token_admin", org_id: "clerk_org" }) },
    scheduler: { runAfter: async (_delay: number, ref: unknown) => { scheduled.push(String(ref)); } },
  };
  await assert.rejects(files["accountHierarchy.ts"].startScan.handler(ctx, { source: "salesforce" }));
  const scanId = await files["accountHierarchy.ts"].startScan.handler(ctx, {});
  assert.deepEqual((({ provider, status, startedBy }) => ({ provider, status, startedBy }))((await db.get(scanId))!), { provider: "canon", status: "reading", startedBy: "admin" });
  assert.deepEqual(scheduled, ["internal.accountHierarchyActions.runScan"]);
});
