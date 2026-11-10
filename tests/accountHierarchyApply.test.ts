import assert from "node:assert/strict";
import test from "node:test";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { accessOf } from "../convex/lib/access.ts";
import type { AccountRow } from "../convex/lib/recordContract.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const parentItem = (accountId: string, from: string | null, to: string | null) =>
  ({ op: "set_parent", accountId, from, to, why: "researched", citations: [], warn: [], key: `ah:parent:${accountId}:${to}` });

let client = createFakeRecordClient({ store: createMemoryRecordStore() });
const files = loadConvex(["accountHierarchy.ts", "associations.ts", "hubspotImport.ts"], { "records.ts": (real) => ({ ...real, callerClient: () => client }) });

async function fixture(opts: { provider?: "canon" | "salesforce"; companies?: string[] } = {}) {
  const store = createMemoryRecordStore();
  const companies = opts.companies ?? ["top", "old", "child"];
  await store.putAccounts("org", companies.map((id) => ({ id, name: id, domain: `${id}.test`, fit: 0, status: "new", segmentIds: [], source: "test", version: 1, updatedAt: 1 }) as AccountRow));
  client = createFakeRecordClient({ store });
  const items = [parentItem("child", "old", "top"), parentItem("top", null, "child"), { op: "merge", survivorId: "top", loserId: "old", fill: {}, why: "dup", moves: "", warn: [], key: "ah:merge:old" }];
  const db = memoryDb({
    organizations: [{ _id: "org", clerkOrgId: "clerk_org" }],
    users: [{ _id: "admin", clerkUserId: "clerk_admin", orgId: "org", role: "admin", isActive: true, name: "Ada" }],
    hierarchyScans: [{ _id: "scan", orgId: "org", provider: opts.provider ?? "canon", status: "done", startedBy: "admin", startedAt: 1 }],
    hierarchyGroups: [{ _id: "group", orgId: "org", scanId: "scan", rank: 0, groupKey: "g", size: 3, shellCount: 0, accounts: companies.map((id) => ({ id, name: id, shell: false })), reasons: [], suggestedRootId: "top" }],
    hierarchyResearch: [{ _id: "research", orgId: "org", scanId: "scan", groupId: "group", groupName: "Top", rootAccountId: "top", status: "done", startedBy: "admin", startedAt: 1, proposal: { items } }],
  });
  const ctx = (): any => ({
    db,
    auth: { getUserIdentity: async () => ({ subject: "clerk_admin", tokenIdentifier: "token_admin", org_id: "clerk_org" }) },
    scheduler: { runAfter: async () => null },
  });
  const call = (ref: unknown, args: any) => {
    const [, file, fn] = String(ref).split(".");
    if (`${file}.${fn}` === "records.callerContext") return { orgId: "org", userId: "admin", name: "Ada", role: "admin", access: accessOf({ userId: "admin", role: "admin" }) };
    const cp = db.checkpoint();
    return files[`${file}.ts`][fn].handler(ctx(), args).catch((error: unknown) => { db.rollback(cp); throw error; });
  };
  const actionCtx = { ...ctx(), runQuery: call, runMutation: call };
  const h = files["accountHierarchy.ts"];
  const parentOf = async (id: string) => (await files["associations.ts"].edges.handler(ctx(), { orgId: "org", association: "account_parent", side: "from", id })).active.map((e: { toId: string }) => e.toId);
  const setParent = (accountId: string, parentId: string | null) => files["associations.ts"].apply.handler(ctx(), { orgId: "org", userId: "admin", command: { op: "setParent", accountId, parentId } });
  const args = (accountId = "child", to = "top") => ({ researchId: "research", itemKey: `ah:parent:${accountId}:${to}` });
  const decision = async (key = args().itemKey) => plain((await h.group.handler(ctx(), { groupId: "group" })).decisions[key] ?? null);
  const approve = (a = args()) => h.approveParent.handler(actionCtx, a).then(plain);
  const undo = (a = args()) => h.undoParent.handler(actionCtx, a).then(plain);
  const hubspotParent = (accountId: string, parentId: string) =>
    files["hubspotImport.ts"].writeLinks.handler(ctx(), { orgId: "org", userId: "admin", links: [{ kind: "parent", ref: `hs-${accountId}`, accountId, parentId }] });
  const useCrmParent = (accountId: string, crmRef: string) => files["associations.ts"].useCrmParent.handler(actionCtx, { accountId, crmRef }).then(plain);
  await setParent("child", "old");
  return { db, h, ctx, parentOf, setParent, args, decision, approve, undo, hubspotParent, useCrmParent };
}

test("approving a Canon parent move links the company under its new parent as the approver, and approving again changes nothing", async () => {
  const f = await fixture();
  assert.deepEqual(await f.approve(), { status: "applied" });
  assert.deepEqual(await f.parentOf("child"), ["top"]);
  const d = await f.decision();
  assert.equal(d.decision, "approved");
  assert.equal(d.decidedBy, "Ada");
  assert.equal(typeof d.appliedAt, "number");
  assert.deepEqual(plain(f.db.rows("ledgerEntries").at(-1)?.actor), { kind: "user", id: "admin" });
  assert.deepEqual(plain((await f.h.group.handler(f.ctx(), { groupId: "group" })).parents), { top: null, old: null, child: "top" });

  const entries = f.db.rows("ledgerEntries").length;
  assert.deepEqual(await f.approve(), { status: "unchanged" });
  assert.equal(f.db.rows("ledgerEntries").length, entries);
  assert.deepEqual(await f.decision(), d);
});

test("a parent changed since the scan is refused, kept on the decision, and nothing is written", async () => {
  const f = await fixture({ companies: ["top", "old", "child", "elsewhere"] });
  await f.setParent("child", "elsewhere");
  const entries = f.db.rows("ledgerEntries").length;
  const result = await f.approve();
  assert.equal(result.status, "invalid");
  assert.deepEqual(await f.parentOf("child"), ["elsewhere"]);
  assert.equal(f.db.rows("ledgerEntries").length, entries);
  const d = await f.decision();
  assert.equal(d.applyError, result.message);
  assert.equal(d.appliedAt, undefined);
});

test("a cycle is refused and kept, and the move applies once its cause is fixed", async () => {
  const f = await fixture();
  // Proposed: top under child, while child sits under old; first put old under top, so child is below top.
  await f.setParent("old", "top");
  const refused = await f.approve(f.args("top", "child"));
  assert.equal(refused.status, "invalid");
  assert.deepEqual(await f.parentOf("top"), []);
  assert.equal((await f.decision(f.args("top", "child").itemKey)).applyError, refused.message);

  await f.setParent("old", null);
  assert.deepEqual(await f.approve(f.args("top", "child")), { status: "applied" });
  const d = await f.decision(f.args("top", "child").itemKey);
  assert.equal(d.applyError, undefined);
  assert.equal(typeof d.appliedAt, "number");
});

test("a parent the approver cannot see is refused through the record flow and kept; nothing is written", async () => {
  const f = await fixture({ companies: ["old", "child"] });
  const entries = f.db.rows("ledgerEntries").length;
  const result = await f.approve();
  assert.equal(result.status, "invalid");
  assert.deepEqual(await f.parentOf("child"), ["old"]);
  assert.equal(f.db.rows("ledgerEntries").length, entries);
  assert.equal((await f.decision()).applyError, result.message);
});

test("undo puts the previous parent back and clears the decision; once the parent moved again, undo is refused", async () => {
  const f = await fixture({ companies: ["top", "old", "child", "elsewhere"] });
  await f.approve();
  await assert.rejects(f.h.decide.handler(f.ctx(), { ...f.args(), decision: "rejected" }));
  await assert.rejects(f.h.decide.handler(f.ctx(), { ...f.args(), decision: "clear" }));
  assert.deepEqual(await f.undo(), { status: "applied" });
  assert.deepEqual(await f.parentOf("child"), ["old"]);
  assert.equal(await f.decision(), null);

  await f.approve();
  await f.setParent("child", "elsewhere");
  assert.equal((await f.undo()).status, "invalid");
  assert.deepEqual(await f.parentOf("child"), ["elsewhere"]);
  assert.equal(typeof (await f.decision()).appliedAt, "number");
});

test("rejecting writes nothing, and other items and Salesforce scans record the decision only", async () => {
  const canon = await fixture();
  const entries = canon.db.rows("ledgerEntries").length;
  await canon.h.decide.handler(canon.ctx(), { ...canon.args(), decision: "rejected" });
  await canon.h.decide.handler(canon.ctx(), { researchId: "research", itemKey: "ah:merge:old", decision: "approved" });
  await assert.rejects(canon.h.decide.handler(canon.ctx(), { ...canon.args(), decision: "approved" }));
  assert.equal(canon.db.rows("ledgerEntries").length, entries);
  assert.deepEqual(await canon.parentOf("child"), ["old"]);
  assert.equal((await canon.decision("ah:merge:old")).appliedAt, undefined);

  const sf = await fixture({ provider: "salesforce" });
  const before = sf.db.rows("ledgerEntries").length;
  await sf.h.decide.handler(sf.ctx(), { ...sf.args(), decision: "approved" });
  await assert.rejects(sf.approve());
  assert.equal(sf.db.rows("ledgerEntries").length, before);
  assert.equal((await sf.decision()).decision, "approved");
  assert.equal((await sf.decision()).appliedAt, undefined);
});

test("an approved move holds against the next CRM import, whose parent the group page shows; using it hands the parent back to the CRM", async () => {
  const f = await fixture();
  await f.approve();
  await f.hubspotParent("child", "old");
  assert.deepEqual(await f.parentOf("child"), ["top"]);
  const group = plain(await f.h.group.handler(f.ctx(), { groupId: "group" }));
  assert.deepEqual(group.crmParents.child.map((c: { ref: string; parentId: string }) => [c.ref, c.parentId]), [["hubspot:hs-child", "old"]]);

  assert.deepEqual(await f.useCrmParent("child", "hubspot:hs-child"), { status: "applied" });
  assert.deepEqual(await f.parentOf("child"), ["old"]);
  assert.deepEqual(plain(f.db.rows("ledgerEntries").at(-1)?.source), { kind: "hubspot", ref: "hubspot:hs-child" });
  assert.deepEqual(plain((await f.h.group.handler(f.ctx(), { groupId: "group" })).crmParents), {});
  await f.hubspotParent("child", "top");
  assert.deepEqual(await f.parentOf("child"), ["top"]);
});
