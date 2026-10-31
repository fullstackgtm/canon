import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { calls } from "../modules/examples/icps/server.ts";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";
import { defaultSlots, planUpgrade } from "../modules/kernel/upgrade.ts";
import { formArguments, rowsOfValue } from "../modules/kernel/document.ts";
import { renderText, rowWhenHolds, valueAt } from "../modules/kernel/text.ts";
import { emptySpec, specGate } from "../convex/lib/icps.ts";
import { specToQuery } from "../convex/lib/icpQuery.ts";
import { gatedFit } from "../convex/lib/icpGates.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import type { AccountRow } from "../convex/lib/recordContract.ts";
import type { ModuleScope, AppliedIntent } from "../convex/lib/modules/scope.ts";
import type { CallOutput, ReadDoc } from "../modules/kernel/calls.ts";

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const manifest = JSON.parse(readFileSync("modules/examples/icps/module.json", "utf8"));
const fit = { base: 10, industryRanks: [70, 50, 30], countryRanks: [20], bands: { central: 20, inside: 10, adjacent: 0 }, unlistedBand: 0, buyerLevels: ["cxo", "vp", "head", "director"] };
const spec = { ...emptySpec(), market: { industries: ["software development"], countries: ["us"], employeeBands: [] } };
const root = { _id: "icps:a", orgId: "org", name: "Software", source: "manual", spec, active: true, isDefault: true, createdAt: 11, updatedAt: 12 };
const node = { _id: "icpNodes:s", orgId: "org", icpId: "icps:a", kind: "segment", name: "Large", query: "size:201-500", createdAt: 13, updatedAt: 14 };
const persona = { ...node, _id: "icpNodes:p", parentId: node._id, kind: "persona", name: "Managers", query: "level:manager", createdAt: 15 };
const user = { _id: "admin", orgId: "org", role: "admin", name: "Admin", email: "a@x", isActive: true };
const source = { kind: "canon", id: "icps", ref: "0.3.0", sha: "a".repeat(40) };
const files = loadConvex(["icpsCutover.ts", "lib/icpsInterface.ts", "lib/modules/scope.ts", "icps.ts", "icpTree.ts", "icpChallenge.ts", "icpFills.ts", "lib/modules/providedChanges.ts", "fitReconciler.ts", "modules.ts"], {
  "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user, requireCap: async () => user, requireUser: async () => user, agentClientOf: async () => null, isDevAuthBypassEnabled: () => true }),
  "lib/recipes.ts": (r) => ({ ...r, modelSettings: async () => fit }),
});

test("the editing upgrade accepts the unbounded string fields published by 0.2", () => {
  const prior = structuredClone(manifest);
  prior.version = "0.2.0";
  for (const [collection, fields] of [
    ["icps", ["name", "description", "query", "pointOfView", "offer"]],
    ["nodes", ["name", "query", "role", "pointOfView", "offer"]],
  ] as const) for (const field of fields) prior.collections[collection].schema.value[field].fieldType = { type: "string" };
  assert.deepEqual(planUpgrade(prior, defaultSlots(prior), manifest, prior.version).problems, []);
});
const scopeFns = files["lib/modules/scope.ts"] as unknown as {
  moduleScope(ctx: unknown, module: string): Promise<ModuleScope | null>;
  systemScope(ctx: unknown, org: string, module: string): Promise<ModuleScope | null>;
};
const readers = files["lib/icpsInterface.ts"] as unknown as {
  readIcps(ctx: unknown, org: string): Promise<Array<{ key: string; spec: typeof spec; createdAt: number; active: boolean }>>;
  readIcpNodes(ctx: unknown, org: string): Promise<import("../convex/lib/icpsInterface.ts").IcpNodeRow[]>;
};
function workspace(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  const db = memoryDb({ organizations: [{ _id: "org" }], users: [user], icps: [root], icpNodes: [node, persona],
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: manifest.id, slug: "icps", source, version: manifest.version, manifest: JSON.stringify(manifest), manifestHash: Math.random().toString(), status: "installed", bundleHash: "bundle", bundleStorageId: "code" }],
    recipeEnablements: [{ _id: "enabled", orgId: "org", point: "module", recipeId: manifest.id, contributionKey: "nav", enabled: true }], ...extra });
  const scheduled: Array<{ ref: string; args: Record<string, unknown> }> = [];
  const publications: typeof scheduled = [];
  const context = () => ({ db: new Proxy(db, { get: (target, key) => { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } }), auth: { getUserIdentity: async () => null }, scheduler: { runAfter: async (_ms: number, ref: unknown, args: Record<string, unknown>) => { (String(ref).split(".")[1] === "moduleActivityPublications" ? publications : scheduled).push({ ref: String(ref), args }); } } });
  const ctx = context();
  async function transaction<T>(run: (ctx: ReturnType<typeof context>) => Promise<T>) {
    const checkpoint = db.checkpoint(), queues = structuredClone({ scheduled, publications });
    try { return await run(context()); }
    catch (e) { db.rollback(checkpoint); scheduled.splice(0, scheduled.length, ...queues.scheduled); publications.splice(0, publications.length, ...queues.publications); assert.deepEqual(db.checkpoint(), checkpoint); assert.deepEqual(structuredClone({ scheduled, publications }), queues); throw e; }
  }
  const cutOver = () => transaction((ctx) => files["icpsCutover.ts"].cutOver.handler(ctx, { orgId: "org" }));
  const moduleScope = async (context = ctx) => (await scopeFns.moduleScope(context, manifest.id))!;
  const command = async (call: string, args: Record<string, unknown>, fields: Array<Record<string, unknown>> = []) => {
    const scope = await moduleScope();
    const definitions = await scope.view("icps.all", {}) as ReadDoc[], nodes = await scope.view("nodes.all", {}) as ReadDoc[];
    const result = await calls[call]({ now: 100, caller: { userId: "admin", role: "admin" }, args }, { definitions, nodes, fields });
    await transaction(async (ctx) => (await moduleScope(ctx)).apply(call, (result.intents ?? []) as AppliedIntent[]));
    return result;
  };
  const doc = (key: string) => db.rows("moduleDocs").find((d) => d.key === key)!;
  return { db, ctx, scheduled, transaction, cutOver, moduleScope, command, doc };
}

test("the editing package validates general capability, nested choice and cardinality declarations", () => {
  const parsed = parseModuleManifest(manifest);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  for (const edit of [
    (m: typeof manifest) => { m.calls.create.capability = "new.power"; },
    (m: typeof manifest) => { m.calls.create.roles = ["admin", "manager"]; },
    (m: typeof manifest) => { m.calls.create.system = true; m.calls.create.roles = []; },
    (m: typeof manifest) => { m.collections.nodes.setOf = { parent: "icps" }; },
  ]) { const m = structuredClone(manifest); edit(m); assert.equal(parseModuleManifest(m).ok, false); }
});

test("atomic cutover keeps keys, original creation times, relationships and one idempotent receipt", async () => {
  const w = workspace();
  const before = await readers.readIcps(w.ctx, "org");
  const pre = await w.moduleScope();
  assert.notEqual(pre.admission(manifest.calls.create), null);
  await assert.rejects(w.transaction(async (ctx) => (await w.moduleScope(ctx)).apply("create", [{ op: "put", collection: "icps", key: "shadow", data: { ...root, query: specToQuery(spec) } }])));
  const receipt = await w.cutOver();
  assert.deepEqual([receipt.icps, receipt.nodes, receipt.repeated], [1, 2, false]);
  assert.deepEqual(plain((await readers.readIcps(w.ctx, "org")).map(({ key, spec, createdAt }) => ({ key, spec, createdAt }))), plain(before.map(({ key, spec, createdAt }) => ({ key, spec, createdAt }))));
  assert.deepEqual(plain((await readers.readIcpNodes(w.ctx, "org")).map((n) => [n.key, n.parent, n.createdAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))), [["icpNodes:p", "icpNodes:s", 15], ["icpNodes:s", null, 13]]);
  const scope = await w.moduleScope();
  const provided = await scope.provide("icps.v1", {}, 25) as ReadDoc[];
  assert.deepEqual([provided[0].key, provided[0].createdAt], ["icps:a", 11]);
  assert.equal(Object.hasOwn(w.doc(node._id).data as object, "parent"), false);
  assert.equal((await w.cutOver()).repeated, true);
  assert.equal(w.db.rows("moduleInterfaceOwners").length, 1);
  assert.equal(w.db.rows("icps")[0].name, "Software");
});

test("cutover refuses incomplete bounds or providers and rolls back owner, docs and invalidation on failure", async () => {
  for (const extra of [
    { icps: Array.from({ length: 26 }, (_, i) => ({ ...root, _id: `icps:${i}` })) },
    { icpNodes: Array.from({ length: 76 }, (_, i) => ({ ...node, _id: `icpNodes:${i}` })) },
    { icpNodes: [{ ...node, parentId: "missing" }] },
    { moduleDocs: [{ _id: "preview", orgId: "org", moduleId: manifest.id, collection: "icps", key: "preview", data: {}, version: 1 }] },
  ] as Array<Record<string, Array<Record<string, unknown>>>>) { const w = workspace(extra); await assert.rejects(w.cutOver()); assert.equal(w.db.rows("moduleInterfaceOwners").length, 0); }
  for (const patch of [{ source: { kind: "github-public", owner: "x", repo: "x" } }, { pending: { version: "0.4.0" } }, { status: "uninstalled" }]) {
    const w = workspace(); await w.db.patch("pkg", patch); await assert.rejects(w.cutOver()); assert.equal(w.db.rows("moduleInterfaceOwners").length, 0);
  }
  const w = workspace();
  const insert = w.db.insert;
  let copied = 0;
  w.db.insert = async (table, value) => { if (table === "moduleDocs" && ++copied === 2) throw new Error("injected copy failure"); return insert(table, value); };
  await assert.rejects(w.cutOver(), (error: unknown) => {
    assert.ok(error && typeof error === "object" && "message" in error && "cause" in error);
    assert.equal(error.message, "The module write could not commit. Retry the original operation.");
    assert.equal((error.cause as { message?: string }).message, "injected copy failure");
    return true;
  });
  assert.deepEqual([w.db.rows("moduleDocs").length, w.db.rows("moduleInterfaceOwners").length, w.db.rows("fitReconciliations").length], [0, 0, 0]);
});

test("editing validates queries without a version change and preserves whole-tree duplicate, move, delete and CAS", async () => {
  const w = workspace(); await w.cutOver();
  await assert.rejects(w.command("editQuery", { key: root._id, expect: 1, query: "size:banana" }));
  assert.equal(w.doc(root._id).version, 1);
  await w.command("editCriteria", { key: root._id, expect: 1, criteria: [{ group: 0, kind: "country", value: { countries: ["ca"] } }] });
  assert.equal((w.doc(root._id).data as Record<string, unknown>).query, "country:ca");
  await assert.rejects(w.command("rename", { key: root._id, expect: 1, name: "stale" }));
  await assert.rejects(w.command("move", { key: node._id, expect: 1, parent: persona._id }));
  const duplicate = await w.command("duplicate", { key: root._id, expect: 2 });
  const copyKey = (duplicate.value as { key: string }).key;
  const copy = w.doc(copyKey).data as Record<string, unknown>;
  const copied = w.db.rows("moduleDocs").filter((d) => (d.data as Record<string, unknown>).icp === copyKey);
  assert.deepEqual([copy.active, copy.isDefault, copied.length], [false, false, 2]);
  const segment = copied.find((d) => (d.data as Record<string, unknown>).kind === "segment")!;
  assert.equal((copied.find((d) => (d.data as Record<string, unknown>).kind === "persona")!.data as Record<string, unknown>).parent, segment.key);
  await w.command("move", { key: persona._id, expect: 1, parent: root._id });
  assert.equal((w.doc(persona._id).data as Record<string, unknown>).parent, undefined);
  await w.command("remove", { key: root._id, expect: 2 });
  assert.equal(w.db.rows("moduleDocs").some((d) => d.key === root._id || d.key === node._id || d.key === persona._id), false);
  assert.equal((w.doc(copyKey).data as Record<string, unknown>).isDefault, true);
});

test("a table row action submits the definition version rather than a loaded row's metadata version", async () => {
  const w = workspace(); await w.cutOver();
  const scope = await w.moduleScope();
  const definitions = await scope.view("icps.all", {}) as ReadDoc[], nodes = await scope.view("nodes.all", {}) as ReadDoc[];
  const context = { now: 100, caller: { userId: "admin", role: "admin" as const }, args: {} };
  const out = await calls.tree(context, { definitions, nodes, counts: { nodes: [...definitions, ...nodes].map((d) => ({ key: d.key, accounts: 1, people: 0 })), overlaps: [] } });
  const row = rowsOfValue(out.value, "rows").find((r) => r.key === root._id)!;
  const action = manifest.pages[0].body.find((n: { c: string; from?: string }) => n.c === "table" && n.from === "tree").rowActions.find((a: { call: string }) => a.call === "icpMessage");
  const args = formArguments(action.args as Record<string, { row: string }>, (e) => valueAt(row, e.row));
  assert.deepEqual(args, { key: root._id, expect: 1 });
  const edited = await calls.icpMessage({ ...context, args: { ...args, description: "From the table" } }, { definitions, nodes, fields: [] });
  await w.transaction(async (ctx) => (await w.moduleScope(ctx)).apply("icpMessage", (edited.intents ?? []) as AppliedIntent[]));
  assert.equal((w.doc(root._id).data as Record<string, unknown>).description, "From the table");
});

test("message dialogs replace their fields, so omitted empty controls clear saved values", async () => {
  const w = workspace(); await w.cutOver();
  for (const [call, key, values] of [
    ["icpMessage", root._id, { description: "Definition", pointOfView: "Evidence", offer: "Proof" }],
    ["segmentMessage", node._id, { pointOfView: "Evidence" }],
    ["personaMessage", persona._id, { role: "Champion", offer: "Proof" }],
  ] as const) {
    await w.command(call, { key, expect: 1, ...values });
    await w.command(call, { key, expect: 2 });
    for (const field of Object.keys(values)) assert.equal(Object.hasOwn(w.doc(key).data as object, field), false);
  }
  await assert.rejects(w.command("personaMessage", { key: root._id, expect: 3, role: "Wrong editor" }));
});

test("cap admission at live writes and snapshot cardinality refuse concurrent definitions beyond the limit", async () => {
  const w = workspace({ icpNodes: [] }); await w.cutOver();
  for (let i = 1; i < 24; i++) await w.command("create", { name: `ICP ${i}` });
  const scope = await w.moduleScope();
  const reads = { definitions: await scope.view("icps.all", {}) as ReadDoc[], nodes: [], fields: [] };
  const planned: CallOutput[] = [];
  for (const now of [201, 202]) planned.push(await calls.create({ now, caller: { userId: "admin", role: "admin" }, args: { name: "Racing" } }, reads));
  await w.transaction(async (ctx) => (await w.moduleScope(ctx)).apply("create", (planned[0].intents ?? []) as AppliedIntent[]));
  await assert.rejects(w.transaction(async (ctx) => (await w.moduleScope(ctx)).apply("create", (planned[1].intents ?? []) as AppliedIntent[])));
  await assert.rejects(w.command("create", { name: "26th" }));
  assert.equal(w.db.rows("moduleDocs").filter((d) => d.collection === "icps").length, 25);
});

test("legacy semantic endpoints are fenced after cutover and an unavailable owner never reads as empty", async () => {
  const w = workspace(); await w.cutOver();
  const before = plain([w.db.rows("icps"), w.db.rows("icpNodes"), w.db.rows("icpChallengeRuns")]);
  const inventory = [
    ["icps.ts", "create", { name: "Shadow", spec }], ["icps.ts", "update", { icpId: root._id, name: "Changed" }],
    ["icps.ts", "remove", { icpId: root._id }], ["icps.ts", "setDefault", { icpId: root._id }],
    ["icps.ts", "insertDerived", { orgId: "org", userId: "admin", name: "Derived", domain: "example.test", spec }],
    ["icpTree.ts", "createNode", { icpId: root._id, name: "Shadow", kind: "segment", query: "" }],
    ["icpTree.ts", "updateNode", { nodeId: node._id, name: "Shadow" }], ["icpTree.ts", "removeNode", { nodeId: node._id }],
    ["icpChallenge.ts", "start", {}], ["icpChallenge.ts", "accept", {}], ["icpChallenge.ts", "dismiss", {}],
  ] as const;
  for (const [file, name, args] of inventory) await assert.rejects(w.transaction(() => files[file][name].handler(w.ctx, args)), name);
  assert.deepEqual(plain([w.db.rows("icps"), w.db.rows("icpNodes"), w.db.rows("icpChallengeRuns")]), before);
  await w.db.patch("pkg", { pending: { version: "0.4.0" } });
  await assert.rejects(readers.readIcps(w.ctx, "org"));
  const state = w.db.rows("fitReconciliations")[0];
  await assert.rejects(files["fitReconciler.ts"].prepare.handler(w.ctx, { orgId: "org", generation: state.generation }));
  assert.equal(w.db.rows("fitReconciliations")[0].queued, true);
  assert.equal(w.db.rows("icpVersions").length, 0);
});

test("gap results avoid invalidation loops and core and provided audience saves schedule active string keys", async () => {
  const w = workspace(); await w.cutOver();
  w.scheduled.length = 0;
  const scope = await scopeFns.systemScope(w.ctx, "org", manifest.id);
  const revision = w.db.rows("fitReconciliations")[0].revision;
  await scope!.op("recordGap", { key: root._id, expect: 1, data: { gapCheck: { key: "cached", at: 10, market: 100, tam: 90, outcome: "covered" } } });
  assert.deepEqual([w.scheduled.length, w.db.rows("fitReconciliations")[0].revision], [0, revision]);
  const hooks = files["lib/modules/providedChanges.ts"] as unknown as { providedCollectionChanged(ctx: unknown, org: string, m: unknown, collection: string, before: unknown, after: unknown): Promise<void> };
  const audience = JSON.parse(readFileSync("modules/examples/audiences/module.json", "utf8"));
  await hooks.providedCollectionChanged(w.ctx, "org", audience, "audiences", { filter: [] }, { filter: [{ field: "accountIcpIds", op: "hasAny", value: [root._id] }] });
  assert.deepEqual(plain(w.scheduled.map((s) => s.args)), [{ orgId: "org", icpId: root._id }]);
});

test("the literal five-account fixture keeps gate ranks and keys after cutover, then the final off clears", async () => {
  const a = { ...spec, market: { industries: ["construction", "insurance", "software development"], countries: ["us"], employeeBands: [] }, persona: { levels: [], departments: [], titles: ["VP Sales"] }, custom: [{ slug: "kind", values: ["saas"] }] };
  const b = { ...a, market: { industries: ["construction", "software development"], countries: [], employeeBands: ["51-200"] } };
  const w = workspace({ icps: [{ ...root, _id: "a", spec: a }, { ...root, _id: "b", name: "B", spec: b, isDefault: false }], icpNodes: [] });
  const fixtures = [
    { id: "both", industry: "software development", employees: 200, country: "United States", custom: { "custom.kind": "saas" }, titles: ["VP Sales"] },
    { id: "a-only", industry: "software development", employees: 50, country: "United States", custom: { "custom.kind": "saas" }, titles: ["VP Sales"] },
    { id: "outside", industry: "banking", employees: 50, country: "United States", custom: { "custom.kind": "saas" }, titles: ["VP Sales"] },
    { id: "unknown", industry: "software development", employees: 200, country: "United States", titles: ["VP Sales"] },
    { id: "no-buyer", industry: "software development", employees: 200, country: "United States", custom: { "custom.kind": "saas" }, titles: ["Engineer"] },
  ];
  const expected = [{ fit: 0.8, icpIds: ["a", "b"] }, { fit: 0.6, icpIds: ["a"] }, { fit: 0, icpIds: [] }, { fit: 0, icpIds: [] }, { fit: 0, icpIds: [] }];
  const gatesOf = async () => (await readers.readIcps(w.ctx, "org")).filter((i) => i.active).map((i) => specGate(i.key, i.spec, fit));
  const before = await gatesOf(); assert.deepEqual(fixtures.map((r) => gatedFit(r, before)), expected);
  await w.cutOver(); const after = await gatesOf(); assert.deepEqual(plain(after), plain(before));
  const store = createMemoryRecordStore(), client = createFakeRecordClient({ store });
  await store.putAccounts("org", fixtures.map((r): AccountRow => ({ ...r, domain: `${r.id}.test`, name: r.id, fit: 0, status: "new", segmentIds: [], source: "fixture", updatedAt: 1, version: 1 })));
  await store.putContacts("org", fixtures.map((r) => ({ id: `person-${r.id}`, accountId: r.id, fullName: r.id, title: r.titles[0], status: "new", updatedAt: 1 })));
  await client.rescore("org", { base: 10 }, 1, after);
  assert.deepEqual((await store.allAccounts("org")).map(({ fit, icpIds }) => ({ fit, icpIds })), expected);
  for (const key of ["a", "b"]) await w.command("toggle", { key, expect: 1 });
  await client.rescore("org", { base: 10 }, 2, await gatesOf());
  assert.deepEqual((await store.allAccounts("org")).map(({ fit, icpIds }) => ({ fit, icpIds })), fixtures.map(() => ({ fit: 0.1, icpIds: [] })));
});

test("an owning package refuses disable, uninstall, replacement and definition-dropping upgrades", async () => {
  const w = workspace(); await w.cutOver();
  for (const [name, args] of [["setEnabled", { moduleId: manifest.id, enabled: false }], ["uninstall", { moduleId: manifest.id }]] as const) await assert.rejects(files["modules.ts"][name].handler(w.ctx, args));
  const next = structuredClone(manifest); next.version = "0.4.0"; delete next.collections.nodes;
  for (const [sourceOf, m] of [[source, next], [{ kind: "github-public", owner: "o", repo: "r", sha: "b".repeat(40), ref: "v2" }, manifest]] as const) {
    await assert.rejects(files["modules.ts"].storeModule.handler(w.ctx, { moduleId: manifest.id, source: sourceOf, version: "0.4.0", manifest: JSON.stringify(m), manifestHash: "next" }));
  }
  assert.deepEqual([w.db.rows("modulePackages")[0].status, w.db.rows("recipeEnablements")[0].enabled, w.db.rows("moduleDocs").length], ["installed", true, 3]);
});

test("node limits hold at the same write boundary and an imported batch cannot leave a hidden 76th node", async () => {
  const w = workspace({ icpNodes: [] }); await w.cutOver();
  const docs = Array.from({ length: 76 }, (_, i) => ({ collection: "nodes", key: `node-${i}`, data: { icp: root._id, kind: "segment", name: `Segment ${i}`, query: "" } }));
  await assert.rejects(w.transaction(async (ctx) => (await scopeFns.systemScope(ctx, "org", manifest.id))!.copyCutover("icps.legacy.v1", docs)));
  assert.equal(w.db.rows("moduleDocs").filter((d) => d.collection === "nodes").length, 0);
  await w.transaction(async (ctx) => (await scopeFns.systemScope(ctx, "org", manifest.id))!.copyCutover("icps.legacy.v1", docs.slice(0, 75)));
  await assert.rejects(w.command("createNode", { key: root._id, expect: 1, kind: "persona" }));
  assert.equal(w.db.rows("moduleDocs").filter((d) => d.collection === "nodes").length, 75);
});

test("owner-aware gap actions keep covered, small, large, unavailable, filling and busy outcomes with fake providers", async (t) => {
  const token = process.env.TREG_TOKEN;
  process.env.TREG_TOKEN = "fake-test-provider";
  t.after(() => { if (token === undefined) delete process.env.TREG_TOKEN; else process.env.TREG_TOKEN = token; });
  for (const scenario of [
    { market: 100, tam: 90, outcome: "covered", fills: 0 },
    { market: 10, tam: 0, outcome: "small", fills: 0 },
    { market: 6000, tam: 0, outcome: "too_large", fills: 0 },
    { market: 100, tam: 0, outcome: "unavailable", fills: 0, unavailable: true },
    { market: 100, tam: 0, outcome: "filling", fills: 1 },
    { market: 100, tam: 0, outcome: "busy", fills: 0, busy: true },
  ]) {
    const w = workspace(scenario.busy ? { backgroundJobs: Array.from({ length: 3 }, (_, i) => ({ _id: `job-${i}`, orgId: "org", kind: "contact_sweep", status: "processing", startedAt: Date.now() })) } : {});
    await w.cutOver();
    let fills = 0;
    const gap = loadConvex(["icpFills.ts"], {
      "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user }),
      "records.ts": (r) => ({ ...r, clientFor: () => ({ countSegment: async () => ({ total: scenario.tam }) }) }),
      "marketSize.ts": (r) => ({ ...r, marketView: async () => { if (scenario.unavailable) throw new Error("fake unavailable"); return { total: scenario.market }; } }),
      "populateActions.ts": (r) => ({ ...r, startPopulation: async (_ctx: unknown, _session: unknown, org: string, providers: unknown, _words: unknown, mode: unknown) => { assert.equal(org, "org"); assert.deepEqual(plain(mode), { stage: true }); assert.match(JSON.stringify(providers), /quickenrich/); fills++; return "backgroundJobs:fake"; } }),
    })["icpFills.ts"];
    const ctx = { ...w.ctx,
      runQuery: (ref: unknown, args: unknown) => gap[String(ref).split(".").pop()!].handler(w.ctx, args),
      runMutation: (ref: unknown, args: unknown) => w.transaction(() => gap[String(ref).split(".").pop()!].handler(w.ctx, args)),
    };
    await gap.checkGap.handler(ctx, { orgId: "org", icpId: root._id });
    assert.deepEqual([(w.doc(root._id).data as { gapCheck: { outcome: string } }).gapCheck.outcome, fills], [scenario.outcome, scenario.fills]);
    if (scenario.fills) { await gap.checkGap.handler(ctx, { orgId: "org", icpId: root._id }); assert.equal(fills, 1, "same criteria keep the existing cooldown"); }
  }
});


test("inline query validation canonicalizes without writes and refuses invalid, unknown-field and stale edits", async () => {
  const w = workspace(); await w.cutOver();
  const scope = await w.moduleScope();
  const definitions = await scope.view("icps.all", {}) as ReadDoc[], nodes = await scope.view("nodes.all", {}) as ReadDoc[];
  const validate = (key: string, query: string, expect = 1) => calls.validateQuery({ now: 100, caller: { userId: "admin", role: "admin" }, args: { key, expect, query } }, { definitions, nodes, fields: [] });
  assert.deepEqual((await validate(persona._id, "dept:revops")).value, { text: "dept:revenue-operations" });
  for (const [key, query, expect] of [[root._id, "size:banana", 1], [root._id, "field.unknown:yes", 1], [root._id, "country:us", 0]] as const) {
    assert.ok(((await validate(key, query, expect)).value as { error: string }).error);
    await assert.rejects(w.command("editQuery", { key, expect, query }));
  }
  assert.equal(w.doc(root._id).version, 1);
  await w.command("editQuery", { key: persona._id, expect: 1, query: "dept:revops" });
  assert.equal((w.doc(persona._id).data as Record<string, unknown>).query, "dept:revenue-operations");
});

test("blur message field writes preserve siblings, clear explicitly and keep kind, length and CAS gates", async () => {
  const w = workspace(); await w.cutOver();
  await w.command("icpMessage", { key: root._id, expect: 1, description: "Definition", pointOfView: "Original", offer: "Offer" });
  await w.command("messageField", { key: root._id, expect: 2, field: "pointOfView", value: "Changed" });
  const data = () => w.doc(root._id).data as Record<string, unknown>;
  assert.deepEqual([data().description, data().pointOfView, data().offer], ["Definition", "Changed", "Offer"]);
  await w.command("messageField", { key: root._id, expect: 3, field: "pointOfView", value: "" });
  assert.deepEqual([data().pointOfView, data().offer], [undefined, "Offer"]);
  await assert.rejects(w.command("messageField", { key: root._id, expect: 3, field: "offer", value: "stale" }));
  await assert.rejects(w.command("messageField", { key: node._id, expect: 1, field: "offer", value: "wrong kind" }));
  await assert.rejects(w.command("messageField", { key: persona._id, expect: 1, field: "role", value: "x".repeat(41) }));
  await w.command("rename", { key: root._id, expect: 4, name: "  Renamed  " });
  assert.deepEqual([data().name, data().offer], ["Renamed", "Offer"]);
});

test("editor metadata retains field types and every token category persists through the authoritative call", async () => {
  const w = workspace(); await w.cutOver();
  const fields = [
    { id: "amount", label: "Amount", entity: "account", answerType: "number", options: null },
    { id: "answer", label: "Answer", entity: "account", answerType: "text", options: null },
    { id: "ready", label: "Ready", entity: "account", answerType: "boolean", options: null },
    { id: "model", label: "Model", entity: "account", answerType: null, options: [{ key: "saas", label: "SaaS" }] },
  ];
  await w.command("editQuery", { key: root._id, expect: 1, query: "" }, fields);
  const condition = async (key: string, id: string, change: Record<string, unknown>) => w.command("editToken", { key, expect: w.doc(key).version, change: { id, add: true, ...change } }, fields);
  await condition(root._id, "own-country", { values: ["ca"] });
  await condition(root._id, "own-field-amount", { min: 5, max: 20 });
  await condition(root._id, "own-field-answer", { values: ["Enterprise"] });
  await condition(root._id, "own-field-ready", { values: ["true"] });
  await condition(root._id, "own-field-model", { values: ["saas"] });
  await condition(persona._id, "own-title", { values: ["Revenue"] });
  await condition(node._id, "newNot-dept", { values: ["Revenue operations"] });
  const rootQuery = String((w.doc(root._id).data as Record<string, unknown>).query);
  for (const part of ["country:ca", "field.amount:5..20", "field.answer:enterprise", "field.ready:true", "field.model:saas"]) assert.ok(rootQuery.includes(part), part);
  assert.equal((w.doc(node._id).data as Record<string, unknown>).query, "size:201-500 -has(dept:revenue-operations)");
  assert.equal((w.doc(persona._id).data as Record<string, unknown>).query, "level:manager title:Revenue");
  await assert.rejects(condition(root._id, "own-field-missing", { values: ["yes"] }));
  await assert.rejects(condition(persona._id, "own-industry", { values: ["software development"] }));
  await w.command("editToken", { key: root._id, expect: w.doc(root._id).version, change: { id: "own-1", min: 10 } }, fields);
  assert.ok(String((w.doc(root._id).data as Record<string, unknown>).query).includes("field.amount:10.."));
  await w.command("editToken", { key: root._id, expect: w.doc(root._id).version, change: { id: "own-1", max: 30 } }, fields);
  assert.ok(String((w.doc(root._id).data as Record<string, unknown>).query).includes("field.amount:..30"));
  await w.command("editToken", { key: root._id, expect: w.doc(root._id).version, change: { id: "own-1", remove: true } }, fields);
  await condition(root._id, "own-not-industry", { values: ["software development"] });
  await condition(root._id, "own-size", { values: ["201-500"] });
  await condition(persona._id, "own-dept", { values: ["Revenue operations"] });
  assert.ok(!String((w.doc(root._id).data as Record<string, unknown>).query).includes("field.amount"));
});

test("hierarchical read declares only valid moves and depth-bounded ghost kinds for each record type", async () => {
  const w = workspace(); await w.cutOver();
  const scope = await w.moduleScope();
  const definitions = await scope.view("icps.all", {}) as ReadDoc[], nodes = await scope.view("nodes.all", {}) as ReadDoc[];
  const context = { now: 100, caller: { userId: "admin", role: "admin" as const }, args: {} };
  const out = await calls.tree(context, { definitions, nodes, fields: [], counts: { nodes: [...definitions, ...nodes].map((d) => ({ key: d.key, accounts: 1, people: 2 })), overlaps: [] } });
  const rows = (out.value as { rows: Array<{ key: string; depth: number; addChoices: Array<{ value: string }>; moveTargets: Array<{ value: string }> }> }).rows;
  assert.deepEqual(rows.map((r) => [r.key, r.depth, r.addChoices.map((c) => c.value)]), [[root._id, 0, ["segment", "persona"]], [node._id, 1, ["segment", "persona"]], [persona._id, 2, []]]);
  assert.deepEqual(rows.find((r) => r.key === node._id)!.moveTargets, []);
  assert.deepEqual(rows.find((r) => r.key === persona._id)!.moveTargets.map((t) => t.value), [root._id]);
  let parent = node._id;
  for (let depth = 2; depth <= 4; depth++) { const created = await w.command("createNode", { key: parent, expect: w.doc(parent).version, kind: "segment" }); parent = (created.value as { key: string }).key; }
  await assert.rejects(w.command("createNode", { key: parent, expect: w.doc(parent).version, kind: "persona" }));
  await assert.rejects(w.command("move", { key: node._id, expect: w.doc(node._id).version, parent }));
  await assert.rejects(w.command("move", { key: persona._id, expect: 1, parent }));
  const duplicate = await w.command("duplicate", { key: root._id, expect: 1 });
  await assert.rejects(w.command("move", { key: persona._id, expect: 1, parent: (duplicate.value as { key: string }).key }));
});

test("native Accounts and Fill links preserve exact active root keys within the row-action cap", async () => {
  const off = { ...root, _id: "icps:off", name: "Off", active: false, isDefault: false };
  const w = workspace({ icps: [root, off] }); await w.cutOver();
  const scope = await w.moduleScope();
  const definitions = await scope.view("icps.all", {}) as ReadDoc[], nodes = await scope.view("nodes.all", {}) as ReadDoc[];
  const out = await calls.tree({ now: 100, caller: { userId: "admin", role: "admin" }, args: {} }, {
    definitions, nodes, counts: { nodes: [...definitions, ...nodes].map((d) => ({ key: d.key, accounts: 1, people: 2 })), overlaps: [] },
  });
  const actions = manifest.pages[0].body.find((n: { c: string; from?: string }) => n.c === "table" && n.from === "tree").rowActions;
  assert.equal(parseModuleManifest(manifest).ok, true);
  assert.ok(actions.length <= 12);
  const links = actions.filter((a: { canon?: string }) => a.canon === "companies") as Array<{ query: Record<string, string>; when: { field: string; in: unknown[] } }>;
  for (const row of rowsOfValue(out.value, "rows")) {
    const offered = links.filter((a) => rowWhenHolds(a.when, row));
    const queryPairs = offered.map((a) => Object.fromEntries(Object.entries(a.query).map(([key, value]) => [key, renderText(value, { row, binds: {}, members: new Map(), currency: "USD" })])));
    assert.deepEqual(queryPairs, row.key === root._id ? [{ icp: root._id }, { fill: root._id }] : []);
  }
});

test("the 0.5 upgrade leaves frozen interfaces, existing docs and authority unchanged", () => {
  const prior = JSON.parse(readFileSync("tests/fixtures/modules/icps-0.5.0.json", "utf8"));
  const plan = planUpgrade(prior, defaultSlots(prior), manifest, prior.version);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(manifest.provides, prior.provides);
  for (const collection of Object.keys(prior.collections)) assert.deepEqual(manifest.collections[collection], prior.collections[collection]);
  for (const name of ["editToken", "messageField"]) assert.deepEqual([manifest.calls[name].capability, manifest.calls[name].roles, manifest.calls[name].writes], ["strategy.edit", prior.calls.rename.roles, ["icps", "nodes"]]);
  for (const mutate of [
    (m: typeof manifest) => { m.pages[0].body.find((n: { c: string }) => n.c === "recordEditor").change.call = "missing"; },
    (m: typeof manifest) => { m.pages[0].body.find((n: { hierarchy?: unknown }) => n.hierarchy).hierarchy.move.arg = "missing"; },
    (m: typeof manifest) => { m.pages[0].body.find((n: { hierarchy?: unknown }) => n.hierarchy).columns[0].edit.version = "wrong"; },
  ]) { const broken = structuredClone(manifest); mutate(broken); assert.equal(parseModuleManifest(broken).ok, false); }
});

test("signup adoption writes a tenant-bound ICP, segment and persona atomically in either store", async () => {
  for (const owned of [false, true]) {
    const signupSpec = { ...spec, persona: { levels: ["vp"], departments: ["Marketing", "media"], titles: ["VP Marketing"] } };
    const w = workspace({ researchSessions: [{ _id: "signup", domain: "signup.test", claimedByOrgId: "org", claimedByUserId: "admin", icp: { firmographics: { industries: signupSpec.market.industries, employeeBands: [], geos: ["us"] }, persona: { jobLevels: signupSpec.persona.levels, departments: signupSpec.persona.departments, titleKeywords: signupSpec.persona.titles } } }] });
    if (owned) await w.cutOver();
    const adopt = (orgId = "org") => w.transaction((ctx) => files["icps.ts"].adoptResearch.handler(ctx, { orgId, sessionId: "signup" }));
    assert.equal(await adopt("another-org"), false);
    await adopt();
    const definitions = await readers.readIcps(w.ctx, "org");
    const imported = definitions.find((d) => d.key !== root._id)!;
    assert.ok(imported);
    const read = await readers.readIcpNodes(w.ctx, "org");
    const children = read.filter((n) => n.icp === imported.key);
    assert.equal(children.length, 2);
    const segment = children.find((n) => n.kind === "segment")!, buyer = children.find((n) => n.kind === "persona")!;
    assert.equal(segment.parent, null);
    assert.equal(segment.query, "industry:software-development country:us");
    assert.equal(buyer.parent, segment.key);
    assert.equal(buyer.query, 'level:vp dept:marketing,media title:"VP Marketing"');
    await adopt();
    assert.equal((await readers.readIcpNodes(w.ctx, "org")).length, read.length);
    assert.deepEqual(plain(imported.spec), plain({ ...signupSpec, persona: { ...signupSpec.persona, countries: [] } }));
  }
});

test("automatic signup adoption preserves its root when child creation is unavailable", async () => {
  for (const reason of ["old-package", "full", "invalid"] as const) for (const owned of reason === "old-package" ? [true] : [false, true]) {
    const existing = reason === "full" ? [node, persona, ...Array.from({ length: 73 }, (_, i) => ({ ...node, _id: `extra-${i}` }))] : [node, persona];
    const w = workspace({ icpNodes: existing, researchSessions: [{ _id: "signup", domain: "fallback.test", claimedByOrgId: "org", claimedByUserId: "admin", icp: { firmographics: { industries: ["software development"], employeeBands: [], geos: ["us"] }, persona: { jobLevels: ["vp"], departments: ["Marketing"], titleKeywords: reason === "invalid" ? ["VP (Marketing)"] : ["VP Marketing"] } } }] });
    if (owned) await w.cutOver();
    if (reason === "old-package") {
      const prior = structuredClone(manifest);
      delete prior.ops.adoptResearchNode;
      await w.db.patch("pkg", { manifest: JSON.stringify(prior), manifestHash: "old-package" });
    }
    await w.transaction((ctx) => files["icps.ts"].adoptResearch.handler(ctx, { orgId: "org", sessionId: "signup" }));
    assert.equal((await readers.readIcps(w.ctx, "org")).length, 2, `${reason} still saves the ICP`);
    assert.equal((await readers.readIcpNodes(w.ctx, "org")).length, existing.length, `${reason} creates no partial children`);
    assert.ok(w.db.rows("researchSessions")[0].icpNote);
  }
});

test("manual signup import is idempotent and remains fenced after module cutover", async () => {
  const w = workspace({ researchSessions: [{ _id: "signup", domain: "manual.test", claimedByOrgId: "org", createdAt: 1, icp: { firmographics: { industries: ["software development"], employeeBands: [], geos: ["us"] }, persona: { jobLevels: ["vp"], departments: ["Marketing"], titleKeywords: [] } } }] });
  const save = () => w.transaction((ctx) => files["icps.ts"].importFromResearch.handler(ctx, {}));
  const key = await save();
  assert.equal(await save(), key);
  assert.equal((await readers.readIcps(w.ctx, "org")).length, 2);
  assert.equal((await readers.readIcpNodes(w.ctx, "org")).length, 4);
  await w.cutOver();
  await assert.rejects(save());
});
