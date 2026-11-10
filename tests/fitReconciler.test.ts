import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { gatedFit } from "../convex/lib/icpGates.ts";
import { emptySpec } from "../convex/lib/icps.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import type { AccountRow, IcpGate } from "../convex/lib/recordContract.ts";

const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const fallback = { base: 10, industries: { "software development": 30 }, countries: {}, employeeBands: [] };
const buyer = { levels: [], departments: [], topics: [], titles: ["vp sales"], exclude: [] };
const common = { base: 10, max: 100, employees: [], excludeIndustries: [], excludeCountries: [], custom: [{ key: "custom.kind", values: ["saas"] }], buyer };
const gates: IcpGate[] = [
  { ...common, id: "a", industries: { "software development": 30 }, countries: { us: 20 } },
  { ...common, id: "b", industries: { "software development": 50 }, countries: {}, employees: [{ min: 100, max: 1000, weight: 20 }] },
];
const fixtures = [
  { id: "both", industry: "software development", employees: 200, country: "us", custom: { "custom.kind": "saas" }, titles: ["VP Sales"] },
  { id: "a-only", industry: "software development", employees: 50, country: "us", custom: { "custom.kind": "saas" }, titles: ["VP Sales"] },
  { id: "outside", industry: "banking", employees: 50, country: "us", custom: { "custom.kind": "saas" }, titles: ["VP Sales"] },
  { id: "unknown", industry: "software development", employees: 200, country: "us", titles: ["VP Sales"] },
  { id: "no-buyer", industry: "software development", employees: 200, country: "us", custom: { "custom.kind": "saas" }, titles: ["Engineer"] },
];

test("five accounts keep literal best-rank memberships through gatedFit and the fake client, then clear", async () => {
  const expected = [{ fit: 0.8, icpIds: ["a", "b"] }, { fit: 0.6, icpIds: ["a"] }, { fit: 0, icpIds: [] }, { fit: 0, icpIds: [] }, { fit: 0, icpIds: [] }];
  assert.deepEqual(fixtures.map((r) => gatedFit(r, gates)), expected);
  const store = createMemoryRecordStore();
  const client = createFakeRecordClient({ store });
  await store.putAccounts("org", fixtures.map((r): AccountRow => ({ ...r, domain: `${r.id}.example`, name: r.id, fit: 0, status: "new", segmentIds: [], source: "fixture", updatedAt: 1, version: 1 })));
  await store.putContacts("org", fixtures.map((r) => ({ id: `person-${r.id}`, accountId: r.id, fullName: r.id, title: r.titles[0], status: "new", updatedAt: 1 })));
  await client.rescore("org", fallback, 1, gates);
  const scores = async () => (await store.allAccounts("org")).map(({ fit, icpIds }) => ({ fit, icpIds }));
  assert.deepEqual(await scores(), expected);
  await client.rescore("org", fallback, 2, []);
  const cleared = [{ fit: 0.4, icpIds: [] }, { fit: 0.4, icpIds: [] }, { fit: 0.1, icpIds: [] }, { fit: 0.4, icpIds: [] }, { fit: 0.4, icpIds: [] }];
  assert.deepEqual(await scores(), cleared);
  await assert.rejects(client.rescore("org", { base: 100 }, 1, gates));
  await assert.rejects(client.rescore("org", { base: 100 }));
  await client.rescore("org", { base: 100 }, 2, gates);
  assert.deepEqual(await scores(), cleared);
  assert.deepEqual(await client.icpStats("org"), { gates: [] });
});

const spec = { ...emptySpec(), market: { industries: ["software development"], employeeBands: [], countries: [] } };
const row = { _id: "icps:a", orgId: "org", name: "A", spec, active: true, isDefault: true, source: "manual", createdAt: 1, updatedAt: 1 };

function workspace(tables: Parameters<typeof memoryDb>[0] = { icps: [row] }) {
  const db = memoryDb(tables);
  const scheduled: Array<{ ms: number; args: { orgId: string; generation: number } }> = [];
  const sent: Array<{ version: number; weights: unknown; gates: IcpGate[] }> = [];
  let deliver = async () => ({ rescored: 5 });
  const files = loadConvex(["icps.ts", "icpFills.ts", "icpVersions.ts", "fitReconciler.ts", "lib/modules/providedChanges.ts"], {
    "records.ts": (r) => ({ ...r, clientFor: () => ({ contractVersion: async () => "1.41.0", rescore: async (_org: string, weights: unknown, version: number, gates: IcpGate[]) => {
      sent.push(plain({ weights, version, gates }));
      return deliver();
    } }) }),
    "lib.ts": (r) => ({ ...r, getCurrentUser: async () => ({ orgId: "org" }), requireCap: async () => ({ _id: "user", orgId: "org", role: "admin" }) }),
    "icpFills.ts": (r) => ({ ...r, scheduleGapCheck: async () => null }),
  });
  const ctx = { db, scheduler: { runAfter: async (ms: number, _ref: unknown, args: { orgId: string; generation: number }) => { scheduled.push({ ms, args: plain(args) }); } },
    runMutation: (ref: unknown, args: object): Promise<unknown> => {
      const [, file, name] = String(ref).split(".");
      return files[`${file}.ts`][name].handler(ctx, args);
    } };
  const fit = files["fitReconciler.ts"];
  const request = () => fit.request.handler(ctx, { orgId: "org" });
  const run = (generation: number) => fit.reconcile.handler(ctx, { orgId: "org", generation });
  return { db, ctx, files, fit, sent, scheduled, request, run, delivery: (f: typeof deliver) => { deliver = f; }, state: () => db.rows("fitReconciliations")[0] };
}

test("a failed last-off clear remains stale and replays its exact version until remote acknowledgment", async () => {
  const w = workspace({ icps: [{ ...row, active: false }], icpVersions: [{ _id: "icpVersions:1", orgId: "org", version: 1, acceptedAt: 1, weights: fallback, gates }] });
  w.delivery(async () => { throw new Error("offline"); });
  await assert.rejects(w.run(await w.request()));
  assert.deepEqual(plain(w.sent), [{ version: 2, weights: fallback, gates: [] }]);
  assert.equal(w.state().acknowledgedRevision, 0);
  assert.equal(w.state().queued, true);
  assert.deepEqual(plain(w.state().pending), { revision: 1, version: 2 });
  const retry = w.scheduled.at(-1)!;
  assert.equal(retry.ms, 60_000);
  w.delivery(async () => ({ rescored: 5 }));
  await w.run(retry.args.generation);
  assert.deepEqual(plain(w.sent), [{ version: 2, weights: fallback, gates: [] }, { version: 2, weights: fallback, gates: [] }]);
  assert.equal(w.state().acknowledgedVersion, 2);
  assert.equal(w.state().acknowledgedRevision, 1);
  assert.equal(w.state().queued, false);
  await w.run(retry.args.generation);
  assert.equal(w.sent.length, 2);
  assert.equal(w.db.rows("icpVersions").length, 2);
  const recordedClear = workspace({ icps: [{ ...row, active: false }], icpVersions: [{ _id: "icpVersions:2", orgId: "org", version: 2, acceptedAt: 2, weights: fallback, gates: [] }] });
  await recordedClear.run(await recordedClear.request());
  assert.deepEqual(plain(recordedClear.sent), [{ version: 2, weights: fallback, gates: [] }]);
  assert.equal(recordedClear.state().acknowledgedVersion, 2);
  assert.equal(recordedClear.db.rows("icpVersions").length, 1, "a stored clear without acknowledgment is delivered again");
});

test("only definition changes invalidate fit; metadata and gap results do not create a reconcile loop", async () => {
  const w = workspace({ icps: [{ ...row, isDefault: false }, { ...row, _id: "icps:b", name: "B" }] });
  const icps = w.files["icps.ts"];
  await icps.update.handler(w.ctx, { icpId: "icps:a", name: "Renamed", spec });
  await w.files["icpFills.ts"].record.handler(w.ctx, { icpId: "icps:a", gapCheck: { key: "same", at: 1, outcome: "covered" } });
  assert.equal(w.db.rows("fitReconciliations").length, 0);
  await icps.setDefault.handler(w.ctx, { icpId: "icps:a" });
  await icps.update.handler(w.ctx, { icpId: "icps:a", spec: { ...spec, market: { ...spec.market, countries: ["us"] } } });
  await icps.remove.handler(w.ctx, { icpId: "icps:b" });
  assert.equal(w.state().revision, 3);
  assert.equal(w.scheduled.length, 1);
  await w.run(w.scheduled[0].args.generation);
  assert.equal(w.state().acknowledgedRevision, 3);
  assert.deepEqual(w.sent[0].gates.map((g) => [g.id, Object.keys(g.countries)]), [["icps:a", ["united states"]]]);
});

test("provided collections invalidate selected fields, imports and lifecycle changes without watching gap results", async () => {
  const w = workspace();
  const hooks = w.files["lib/modules/providedChanges.ts"] as unknown as {
    providedCollectionChanged: (...args: unknown[]) => Promise<void>;
    providedCollectionsReset: (...args: unknown[]) => Promise<void>;
  };
  const manifest = { id: "@canon/icps", provides: { "icps.v1": { view: "icps.all", fields: ["spec", "active", "isDefault"] } }, views: { "icps.all": { collection: "icps" } } };
  const data = { spec, active: true, isDefault: false };
  await hooks.providedCollectionChanged(w.ctx, "org", manifest, "icps", data, { ...data, gapCheck: { at: 1 } });
  await hooks.providedCollectionChanged(w.ctx, "org", manifest, "nodes", null, data);
  assert.equal(w.db.rows("fitReconciliations").length, 0);
  await hooks.providedCollectionChanged(w.ctx, "org", manifest, "icps", null, data);
  await hooks.providedCollectionChanged(w.ctx, "org", manifest, "icps", data, { ...data, active: false });
  await hooks.providedCollectionsReset(w.ctx, "org", [manifest, { ...manifest, provides: {} }]);
  await hooks.providedCollectionChanged(w.ctx, "other", manifest, "icps", data, null);
  assert.deepEqual(w.db.rows("fitReconciliations").map((r) => [r.orgId, r.revision, r.acknowledgedRevision]), [["org", 3, 0], ["other", 1, 0]]);
  assert.equal(w.scheduled.length, 2);
});

test("edits coalesce, snapshot versions stay bound, and edits during a send survive its acknowledgment", async () => {
  const w = workspace();
  const icps = w.files["icps.ts"];
  await icps.update.handler(w.ctx, { icpId: "icps:a", active: false });
  await icps.update.handler(w.ctx, { icpId: "icps:a", active: true });
  assert.equal(w.scheduled.length, 1);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const waiting = new Promise<void>((r) => { release = r; });
  w.delivery(async () => { entered(); await waiting; return { rescored: 5 }; });
  const first = w.run(w.scheduled[0].args.generation);
  await started;
  assert.equal(w.sent[0].version, 1);
  assert.deepEqual(w.sent[0].gates.map((g) => g.id), ["icps:a"]);
  await icps.update.handler(w.ctx, { icpId: "icps:a", active: false });
  const staleAttempt = w.scheduled.at(-1)!.args.generation;
  release();
  await first;
  assert.equal(w.state().acknowledgedRevision, 2);
  assert.equal(w.state().revision, 3);
  assert.equal(w.state().queued, true);
  w.delivery(async () => ({ rescored: 5 }));
  await w.run(w.scheduled.at(-1)!.args.generation);
  assert.deepEqual(w.sent.map((s) => [s.version, s.gates.map((g) => g.id)]), [[1, ["icps:a"]], [2, []]]);
  assert.equal(w.state().acknowledgedRevision, 3);
  await w.run(staleAttempt);
  assert.equal(w.sent.length, 2);
});

test("an interrupted send retries the same snapshot before compiling newer definitions", async () => {
  const w = workspace();
  const first = await w.request();
  const claim = await w.fit.claim.handler(w.ctx, { orgId: "org", generation: first });
  const old = await w.fit.prepare.handler(w.ctx, { orgId: "org", generation: claim });
  await w.files["icps.ts"].update.handler(w.ctx, { icpId: "icps:a", active: false });
  await w.run(claim);
  assert.deepEqual(w.sent.map((s) => [s.version, s.gates.map((g) => g.id)]), [[1, ["icps:a"]]]);
  await w.run(w.scheduled.at(-1)!.args.generation);
  assert.deepEqual(w.sent.map((s) => [s.version, s.gates.map((g) => g.id)]), [[1, ["icps:a"]], [2, []]]);
  await w.fit.acknowledge.handler(w.ctx, { orgId: "org", generation: old.generation, version: old.version });
  assert.equal(w.state().acknowledgedVersion, 2);
  assert.equal(w.state().queued, false);
  assert.equal(await w.fit.prepare.handler(w.ctx, { orgId: "org", generation: claim }), null);
  assert.equal(w.db.rows("icpVersions").length, 2, "a late old request cannot allocate a newer version");
});
