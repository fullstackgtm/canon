import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { accessOf, type Access } from "../convex/lib/access.ts";
import { createFakeRecordClient, createHttpRecordClient, createMemoryRecordStore, type RecordClient } from "../convex/lib/recordClient.ts";
import type { ActivityAggregateRequest } from "../convex/lib/objects/moduleReport.ts";
import type { ActionCtx } from "../convex/_generated/server.ts";
import type { ModuleManifest } from "../modules/kernel/manifest.ts";

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const spec = { object: "activity", filter: [], groupBy: [{ field: "type" }], measures: [{ fn: "count" }] };
const projection = { packageId: "pkg", epoch: 1, generation: 1, collections: ["visits"] };
const empty = { groups: [], subtotals: [], total: [0], rows: 0, truncated: false, projectedThrough: {} };

function fixture() {
  const manifest: ModuleManifest = {
    kind: "module", id: "@test/activity", version: "1.0.0", title: "Visits", description: "Visits", author: { org: "test" }, engines: { moduleApi: "1" },
    nav: { label: "Visits", icon: "map", section: "Work", landing: "visits" },
    collections: { visits: { key: "auto", title: "title", owner: "rep", indexes: {}, access: { rep: "ownerOrUnrestricted", manager: "hier" },
      schema: { type: "object", value: { title: { fieldType: { type: "string" }, optional: false }, rep: { fieldType: { type: "ref", to: "users" }, optional: true }, company: { fieldType: { type: "ref", to: "companies" }, optional: true } } },
      activity: { kind: "visit", subject: "title", owner: "rep", targets: { companies: "company" }, path: "visits/:key" } } },
    views: { one: { kind: "one", collection: "visits", args: { key: "string" }, key: { arg: "key" } } }, ops: {},
    pages: [{ path: "visits", title: "Visits", body: [] }, { path: "visits/:key", title: "Visit", bind: { doc: { view: "one", args: { key: { route: "key" } } } }, body: [] }],
  };
  const users = [
    { _id: "admin", orgId: "org", role: "admin", isActive: true, name: "Admin" },
    { _id: "rep", orgId: "org", role: "custom", isActive: true, name: "Rep", managerId: "boss" },
    { _id: "boss", orgId: "org", role: "manager", isActive: true, name: "Boss" },
  ];
  let session = users[1];
  const db = memoryDb({
    users, orgRoles: [{ _id: "custom-role", orgId: "org", key: "custom", base: "rep", label: "Custom" }],
    rolePermissions: [{ _id: "rules", orgId: "org", role: "custom", rules: [{ object: "account", visibility: "own", unowned: false }] }],
    modulePackages: [{ _id: "pkg", orgId: "org", moduleId: manifest.id, status: "installed", slug: "activity", manifestHash: "initial", manifest: JSON.stringify(manifest), epoch: 1, projection: { ...projection, completed: ["visits"] } }],
    recipeEnablements: [{ _id: "enabled", orgId: "org", point: "module", contributionKey: "nav", recipeId: manifest.id, enabled: true }],
  });
  const requests: ActivityAggregateRequest[] = [];
  let during: (() => Promise<void>) | undefined;
  const client = createHttpRecordClient({ baseUrl: "https://record.invalid", token: "fixture", fetchImpl: async (_url, init) => {
    if (init?.method === "GET") return Response.json({ version: "1.44.0" });
    const request = JSON.parse(String(init?.body)) as ActivityAggregateRequest;
    requests.push(request);
    await during?.();
    return Response.json({ ...empty, moduleActivities: request.moduleActivities });
  } });
  const loaded = loadConvex(["reports.ts", "records.ts", "moduleActivities.ts", "permissions.ts"], {
    "lib.ts": (real) => ({ ...real, getCurrentUser: async () => session }),
    "lib/recordClient.ts": (real) => ({ ...real, recordClient: () => client }),
  });
  const queryCtx = { db: new Proxy(db, { get: (target, key) => ["insert", "patch", "replace", "delete"].includes(String(key)) ? undefined : Reflect.get(target, key) }) };
  const ctx = { runQuery: async (ref: unknown, args: unknown) => {
    const [file, name] = String(ref).replace(/^internal\./, "").split(".");
    return loaded[`${file}.ts`][name].handler(queryCtx, args);
  } };
  const principal = loaded["records.ts"] as unknown as { principalClient(ctx: ActionCtx, orgId: string, accesses: readonly Access[]): RecordClient };
  return {
    db, manifest, requests, client,
    run: () => loaded["reports.ts"].run.handler(ctx, { spec }),
    as: (id: string) => { session = users.find((u) => u._id === id)!; },
    during: (fn?: () => Promise<void>) => { during = fn; },
    update: async () => db.patch("pkg", { manifestHash: crypto.randomUUID(), manifest: JSON.stringify(manifest) }),
    principals: (accesses: Access[]) => principal.principalClient(ctx as unknown as ActionCtx, "org", accesses).aggregate("org", "activity", { measures: [{ fn: "count" }] }),
  };
}

test("public Activities reports preserve Access snapshots, role bases, hierarchy and preview intersections", async () => {
  const h = fixture();
  const report = await h.run();
  assert.equal(report.rows, 0);
  assert.equal(report.moduleActivities, undefined, "principal scopes stay inside the service transport");
  assert.deepEqual(h.requests.at(-1)?.moduleActivities?.[0].scopes, [{ owners: ["rep"], where: null, setOf: null }]);
  h.as("admin");
  await h.db.insert("accessPreviews", { userId: "admin", orgId: "org", asUserId: "rep", expiresAt: Date.now() + 60_000 });
  await h.run();
  assert.deepEqual(h.requests.at(-1)?.moduleActivities?.[0].scopes[0].owners, ["rep"]);
  const restricted = accessOf({ userId: "rep", role: "custom", rules: [{ object: "account", visibility: "own" }] });
  const manager = accessOf({ userId: "boss", role: "manager" });
  await h.principals([restricted, manager]);
  assert.deepEqual(h.requests.at(-1)?.moduleActivities?.[0].scopes.map((s) => s.owners), [["rep"], ["boss", "rep"]]);
  await h.principals([accessOf({ userId: "rep", role: "custom" })]);
  assert.equal(h.requests.at(-1)?.moduleActivities?.[0].scopes[0].owners, null, "stored narrower rules cannot replace the exact unrestricted snapshot");
  const ledgerOwn = accessOf({ userId: "rep", role: "custom", rules: ["note", "task", "call", "meeting"].map((object) => ({ object, visibility: "own" as const, unowned: false })) });
  await h.principals([ledgerOwn]);
  assert.deepEqual(h.requests.at(-1)?.scope, { field: "ownerId", owners: ["rep"], unowned: false });
  await assert.rejects(h.principals([accessOf({ userId: "rep", role: "custom", rules: [{ object: "task", visibility: "own" }] })]));
  h.manifest.collections.visits.access.rep = { scope: "own", or: { field: "title", in: ["shared"] } };
  await h.update();
  await assert.rejects(h.run(), /or/);
  h.manifest.collections.visits.access.rep = { scope: "own", members: "rep" };
  await h.update();
  await assert.rejects(h.run(), /member/);
});

test("public Activities reports refuse unready projections and lifecycle or scope changes during HTTP", async () => {
  const h = fixture();
  const checkpoint = h.db.checkpoint();
  for (const patch of [
    { projection: undefined },
    { projection: { ...projection, completed: [] } },
    { pending: { phase: "cutover", version: "2.0.0" } },
  ]) {
    await h.db.patch("pkg", patch);
    await assert.rejects(h.run());
    h.db.rollback(checkpoint);
  }
  for (const mutate of [
    () => h.db.patch("enabled", { enabled: false }),
    () => h.db.patch("pkg", { status: "uninstalled" }),
    () => h.db.patch("pkg", { projection: { ...projection, completed: [] } }),
    () => h.db.patch("pkg", { projection: { ...projection, generation: 2, completed: ["visits"] } }),
    () => h.db.patch("rep", { isActive: false }),
    async () => { await h.db.insert("moduleJobs", { orgId: "org", moduleId: h.manifest.id, job: "#report", key: "visits|one" }); },
    async () => { h.manifest.collections.visits.activity!.kind = "checkin"; await h.update(); },
    async () => { h.manifest.collections.visits.access.rep = "none"; await h.update(); },
  ]) {
    h.during(mutate);
    await assert.rejects(h.run());
    h.db.rollback(checkpoint);
    h.manifest.collections.visits.access.rep = "ownerOrUnrestricted";
    h.manifest.collections.visits.activity!.kind = "visit";
  }
  h.during();
  for (const [id, patch] of [["enabled", { enabled: false }], ["pkg", { status: "uninstalled" }]] as const) {
    await h.db.patch(id, patch);
    await h.run();
    assert.equal(h.requests.at(-1)?.moduleActivities, undefined);
    h.db.rollback(checkpoint);
  }
  h.manifest.pages[1].roles = ["admin"];
  await h.update();
  await h.run();
  assert.equal(h.requests.at(-1)?.moduleActivities, undefined);
});

test("RecordClient requires 1.44 and a complete source receipt, and the fake truthfully refuses", async () => {
  const h = fixture();
  await h.run();
  const request = h.requests[0];
  assert.ok(request.moduleActivities?.length);
  for (const [version, receipt] of [
    ["1.43.0", request.moduleActivities], [null, request.moduleActivities], ["1.44.0", undefined],
    ["1.44.0", request.moduleActivities.map((s) => ({ ...s, kind: "other" }))],
    ["1.44.0", request.moduleActivities.map((s) => ({ ...s, projection: { ...s.projection, generation: 2 } }))],
    ["1.44.0", request.moduleActivities.map((s) => ({ ...s, scopes: [] }))],
  ] as const) {
    const client = createHttpRecordClient({ baseUrl: "https://record.invalid", token: "fixture", fetchImpl: async (_url, init) => Response.json(init?.method === "GET" ? { version } : { ...empty, moduleActivities: receipt }) });
    await assert.rejects(client.aggregate("org", "activity", request));
  }
  const fake = createFakeRecordClient({ store: createMemoryRecordStore() });
  await assert.rejects(fake.aggregate("org", "activity", plain(request)), /fake/);
});
