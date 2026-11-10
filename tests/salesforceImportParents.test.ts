import assert from "node:assert/strict";
import test from "node:test";
import { planObjects, runImport } from "../engine/src/sync/salesforceImport/engine.ts";
import { memorySink } from "../engine/src/sync/salesforceImport/sinks.ts";
import { fakeId, startFakeSalesforce, type FakeDataset, type FakeRow } from "../engine/src/sync/salesforceImport/testing/fakeSalesforce.ts";
import type { CanonSink, ObjectImportState, RejectedRow } from "../engine/src/sync/salesforceImport/contracts.ts";
import { normalizeSfId } from "../engine/src/sync/salesforceImport/mapping.ts";
import { DEFAULT_POLICY, pollingSource, runTick, salesforceRest, type EnginePorts, type SyncState } from "../engine/src/sync/salesforceSync/index.ts";
import { startMiniSf } from "../engine/src/sync/salesforceSync/testing/miniSf.ts";
import { FakeRecordStore, MemoryConflictSink, MemoryPlanSink } from "../engine/src/sync/salesforceSync/testing/fakes.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const files = loadConvex(["salesforceImportCanon.ts", "associations.ts"]);
const canonFn = files["salesforceImportCanon.ts"];
const sf = (n: number) => normalizeSfId(fakeId("001", n))!;

function canon() {
  const db = memoryDb({ organizations: [{ _id: "org" }], users: [{ _id: "admin", orgId: "org", role: "admin", isActive: true }] });
  const ctx = (): any => ({ db });
  const sink = {
    membersByEmail: async () => [],
    rememberIds: async (object: string, pairs: Array<{ sfId: string; canonId: string }>) => { await canonFn.rememberIds.handler(ctx(), { orgId: "org", object, pairs }); },
    setAccountParents: (links: unknown) => canonFn.setAccountParents.handler(ctx(), { orgId: "org", links }),
  } as unknown as CanonSink;
  const canonId = async (n: number) => (await db.query("sfImportIds").withIndex("by_orgId_and_sfId", (q: any) => q.eq("orgId", "org").eq("sfId", sf(n))).first())?.canonId as string;
  const parentOf = async (n: number) => {
    const edges = await files["associations.ts"].edges.handler(ctx(), { orgId: "org", association: "account_parent", side: "from", id: await canonId(n) });
    return edges.active.map((e: { toId: string }) => e.toId);
  };
  const setParentAsPerson = async (n: number, parent: number) =>
    files["associations.ts"].apply.handler(ctx(), { orgId: "org", userId: "admin", command: { op: "setParent", accountId: await canonId(n), parentId: await canonId(parent) } });
  const sendLinks = (links: Array<[number, number | null]>) =>
    canonFn.setAccountParents.handler(ctx(), { orgId: "org", links: links.map(([c, p]) => ({ sfId: sf(c), parentSfId: p === null ? null : sf(p) })) });
  return { sink, canonId, parentOf, setParentAsPerson, sendLinks };
}

const account = (n: number, domain: string, parent?: number): FakeRow =>
  ({ Id: fakeId("001", n), Name: `Company ${n}`, Website: domain, Industry: "", NumberOfEmployees: "", BillingCountry: "", OwnerId: "", ParentId: parent ? fakeId("001", parent) : "" });

/** A Salesforce org of accounts only, imported two accounts a chunk, one chunk a run, as the Convex action chain resumes. */
async function importAccounts(rows: FakeRow[], c: ReturnType<typeof canon>) {
  const ds: FakeDataset = {
    objects: new Map([["Account", { name: "Account", label: "Account", custom: false, fields: Object.keys(rows[0]).map((name) => ({ name, type: "string" })), rows }]]),
    tamDomains: [], expect: { accountsNoWebsite: 0, accountDupDomains: 0 },
  };
  const sim = await startFakeSalesforce(ds);
  try {
    const conn = { instanceUrl: sim.baseUrl, apiVersion: "60.0", getToken: async () => sim.token };
    let objects: ObjectImportState[] = await planObjects(conn, ["Account"]);
    const sink = memorySink();
    const rejected: RejectedRow[] = [];
    for (let run = 0; run < 20 && objects.some((o) => o.state !== "done"); run++) {
      let chunks = 0;
      objects = structuredClone(objects);
      await runImport({ conn, sink, canon: c.sink, orgId: "org", objects, chunkSize: 2, deadlineAt: 1, now: () => (chunks ? 1 : 0), checkpoint: async (_o, r) => { rejected.push(...r); chunks++; } });
    }
    return { objects, rejected };
  } finally {
    await sim.stop();
  }
}

test("the import links each account under its Salesforce parent whatever order they arrive in, and skips what Canon cannot link", async () => {
  const c = canon();
  const { objects, rejected } = await importAccounts([
    account(3, "grandchild.test", 2),
    account(2, "child.test", 1),
    account(5, "orphan.test", 6),
    account(6, ""),
    account(1, "top.test"),
    account(7, "top.test", 1),
    account(8, "loop-a.test", 9),
    account(10, "loop-a.test"),
    account(9, "loop-b.test", 10),
  ], c);
  assert.deepEqual(objects.map((o) => [o.apiName, o.state, o.seen, o.upserted + o.rejected]), [["Account", "done", 9, 9]]);
  assert.deepEqual(await c.parentOf(3), [await c.canonId(2)]);
  assert.deepEqual(await c.parentOf(2), [await c.canonId(1)]);
  assert.deepEqual(await c.parentOf(5), []);
  assert.deepEqual(await c.parentOf(1), []);
  assert.equal(await c.canonId(10), await c.canonId(8));
  assert.deepEqual(await c.parentOf(9), [await c.canonId(8)]);
  assert.deepEqual(await c.parentOf(8), []);
  assert.deepEqual(rejected.filter((r) => r.reason.startsWith("Parent")).map((r) => r.sfId), [sf(7), sf(8)]);
});

test("a changed or cleared ParentId moves or removes the edge Salesforce made; a parent a person set stays until Salesforce names another", async () => {
  const c = canon();
  await importAccounts([account(1, "a.test"), account(2, "b.test"), account(3, "c.test", 1), account(4, "d.test", 1)], c);
  assert.deepEqual((await c.sendLinks([[3, 2], [4, null]])).applied, 2);
  assert.deepEqual(await c.parentOf(3), [await c.canonId(2)]);
  assert.deepEqual(await c.parentOf(4), []);

  await c.setParentAsPerson(4, 2);
  await c.sendLinks([[4, null]]);
  assert.deepEqual(await c.parentOf(4), [await c.canonId(2)]);
  await c.setParentAsPerson(3, 1);
  await c.setParentAsPerson(3, 2);
  await c.sendLinks([[3, null]]);
  assert.deepEqual(await c.parentOf(3), [await c.canonId(2)]);
  await c.sendLinks([[4, 1]]);
  assert.deepEqual(await c.parentOf(4), [await c.canonId(1)]);
});

test("the sync hands a polled account's new ParentId to the parents port", async () => {
  const T0 = Date.UTC(2026, 10, 1);
  const clock = { t: T0 };
  const now = () => clock.t;
  const ids = [sf(1), sf(2)];
  const sim = await startMiniSf({ now, records: { Account: ids.map((Id) => ({ Id, Name: Id, Industry: "", NumberOfEmployees: 1, BillingCountry: "US", ParentId: null, SystemModstamp: T0 - 1000 })) } });
  try {
    const store = new FakeRecordStore(now);
    ids.forEach((id, i) => store.seed("account", `a${i}`, id, { name: id, industry: "", employees: 1, country: "US" }, T0 - 1000));
    const rest = salesforceRest({ instanceUrl: sim.baseUrl, getToken: async () => sim.token() });
    const sent: unknown[] = [];
    const ports: EnginePorts = {
      records: store, sf: rest.port, cdc: pollingSource({ soql: rest.soql, policy: DEFAULT_POLICY, now }), plans: new MemoryPlanSink(now), conflicts: new MemoryConflictSink(),
      parents: async (links) => { sent.push(...links); return { applied: links.length, rejected: [] }; }, now, saveState: async () => {},
    };
    const state: SyncState = { readOnly: true, mode: "poll", inboundCursor: { modstampByObject: {} }, outboxCursor: 0 };
    await runTick(ports, DEFAULT_POLICY, state);
    clock.t += 1000;
    sim.edit("Account", ids[1], { ParentId: ids[0] });
    const stats = await runTick(ports, DEFAULT_POLICY, state);
    assert.deepEqual(sent, [{ sfId: ids[1], parentSfId: ids[0] }]);
    assert.equal(stats.parentLinks, 1);
  } finally {
    await sim.stop();
  }
});
