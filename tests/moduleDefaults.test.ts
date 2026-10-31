import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { newObject } from "../convex/lib/objects/customObjects.ts";
import { parseModuleManifest } from "../modules/kernel/manifest.ts";
import type { ModuleImport } from "../convex/lib/modules/imports.ts";
import { test } from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { movedTo, reportsModuleTarget, visibleSections } from "../src/components/shell/nav.ts";

const admin = { _id: "admin", orgId: "org", role: "admin", name: "Ada", email: "a@x", isActive: true };
const caller: { user: Record<string, unknown> | null; agent: string | null } = { user: admin, agent: null };
type Example = { manifest: string; sha: string; bundle: string | null };
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const WORK = { kind: "module", id: "@canon/work", version: "0.1.0", title: "Work", description: "My work and Review.", author: { org: "canon" }, engines: { moduleApi: "1" }, default: true, links: ["my-work", "review"], collections: {}, views: {}, ops: {}, pages: [] };
const ID = "@canon/import-test";
const NAME = "test.legacy";
const CODE = "export const calls = { echo: () => ({ value: 'ok' }) };";
const CODE_HASH = "533921d21ecb707d2cc864b5537b6de7";
function fixture(server = false) {
  return {
    ...structuredClone(WORK), id: ID,
    collections: {
      items: { schema: { type: "object", value: { title: { fieldType: { type: "string" }, optional: false } } }, key: "auto", indexes: {}, access: { admin: "all" } },
      children: { schema: { type: "object", value: { title: { fieldType: { type: "string" }, optional: false } } }, key: "auto", indexes: {}, access: {}, setOf: { parent: "items" } },
    },
    ...(server ? { server: "dist/module.js", calls: { echo: { label: "Echo", args: { type: "object", value: {} }, roles: ["admin"], agent: "allowed", reads: {}, writes: [], returns: "value" } } } : {}),
  };
}
function example(m: Record<string, unknown>, sha: string, bundle: string | null = null): Example {
  return { manifest: JSON.stringify(m), sha: sha.repeat(64), bundle };
}

const fixtureImports: Record<string, ModuleImport> = {};
const canonImports: Record<string, ModuleImport> = {};
const configuration = { env: {} as Record<string, string> };
const loaded = loadConvex(["modules.ts", "moduleDefaults.ts", "moduleActivityPublications.ts", "researchSessions.ts", "reports.ts", "dashboards.ts", "templates.ts", "../modules/examples/_examples.generated.ts"], {
  "lib.ts": (r) => ({ ...r, getCurrentUser: async () => caller.user, requireUser: async () => caller.user, agentClientOf: async () => caller.agent }),
  "lib/modules/imports.ts": (r) => { Object.assign(canonImports, r.MODULE_IMPORTS); return { ...r, MODULE_IMPORTS: fixtureImports }; },
}, { process: configuration });
const fn = { ...loaded["modules.ts"], ...loaded["moduleDefaults.ts"], ...loaded["researchSessions.ts"] };
const shipped = loaded["../modules/examples/_examples.generated.ts"] as unknown as { MODULE_EXAMPLES: Record<string, Example> };
const originalExamples = shipped.MODULE_EXAMPLES;

function harness(examples?: Record<string, Example>, imports: Record<string, ModuleImport> = {}, env: Record<string, string> = {}) {
  configuration.env = env;
  shipped.MODULE_EXAMPLES = examples ?? originalExamples;
  for (const name of Object.keys(fixtureImports)) delete fixtureImports[name];
  Object.assign(fixtureImports, canonImports, imports);
  const db = memoryDb({ organizations: [{ _id: "org", createdAt: Date.now() }, { _id: "org2", createdAt: Date.now() }], users: [admin] });
  const scheduled: Array<{ name: string; args: Record<string, unknown>; delay: number }> = [], publications: typeof scheduled = [];
  const files = new Map<string, string>();
  let stored = 0;
  const storage = {
    store: async (blob: Blob) => { const id = `file:${++stored}`; files.set(id, await blob.text()); return id; },
    delete: async (id: string) => { files.delete(id); },
  };
  const handler = (ref: unknown) => {
    const [visibility, file, name] = String(ref).split(".");
    assert.equal(visibility, "internal"); assert.ok(["modules", "moduleDefaults", "moduleActivityPublications", "researchSessions"].includes(file), `Unknown task ${String(ref)}`);
    const result = loaded[`${file}.ts`][name]; assert.ok(result, `Unknown handler ${String(ref)}`); return result;
  };
  const scheduler = { runAfter: async (delay: number, ref: unknown, args: Record<string, unknown>) => {
    if (["internal.recordActions.importSession", "internal.fitReconciler.reconcile"].includes(String(ref))) return;
    handler(ref); assert.ok(delay >= 0);
    const queue = String(ref).split(".")[1] === "moduleActivityPublications" || String(ref) === "internal.modules.resumeImports" ? publications : scheduled;
    queue.push({ name: String(ref), args, delay });
  } };
  const runQuery = (ref: unknown, args: Record<string, unknown>) => {
    const context = ctx();
    const reads = new Proxy(context.db, { get: (target, key) => ["insert", "patch", "replace", "delete"].includes(String(key)) ? undefined : Reflect.get(target, key, target) });
    return handler(ref).handler({ ...context, db: reads }, args);
  };
  const runMutation = async (ref: unknown, args: Record<string, unknown>) => {
    const cp = db.checkpoint(), queues = structuredClone({ scheduled, publications }), savedFiles = new Map(files), savedStored = stored;
    try { return await handler(ref).handler(ctx(), args); }
    catch (e) { db.rollback(cp); scheduled.splice(0, scheduled.length, ...queues.scheduled); publications.splice(0, publications.length, ...queues.publications); files.clear(); for (const [key, value] of savedFiles) files.set(key, value); stored = savedStored; throw e; }
  };
  const ctx = () => ({ db: new Proxy(db, { get: (target, key) => { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } }), scheduler, storage, runQuery, runMutation, // Claim requires an invitation for the verified email (#1030); the fixture caller is invited.
    auth: { getUserIdentity: async () => (caller.user ? { email: caller.user.email, emailVerified: true } : null) } });
  const action = { storage, scheduler, runQuery, runMutation };
  const actions = new Set(["reconcile", "previewInstall", "install"]);
  const queries = new Set(["list", "installed", "migrationRead"]);
  const task = (ref: string, args: Record<string, unknown>) => ref === "internal.moduleActivityPublications.run" || actions.has(ref.split(".")[2])
    ? handler(ref).handler(action, args) : queries.has(ref.split(".")[2]) ? runQuery(ref, args) : runMutation(ref, args);
  async function advancePublications() {
    const seen = new Set<string>();
    while (publications.some((entry) => entry.delay === 0)) {
      const position = JSON.stringify([publications, db.rows("moduleActivityHeads"), db.rows("moduleActivityPublications")]);
      assert.ok(seen.size < 100 && !seen.has(position), "Publication must progress"); seen.add(position);
      const [entry] = publications.splice(publications.findIndex((item) => item.delay === 0), 1); await task(entry.name, entry.args);
    }
    assert.equal(db.rows("moduleActivityPublications").some((row) => row.state === "failed"), false, "Publication failure retains its retry");
    for (const head of db.rows("moduleActivityHeads").filter((row) => row.pending)) {
      const frontier = db.rows("moduleActivityPublications").find((row) => row.orgId === head.orgId && row.ordinal === Number(head.publishedOrdinal) + 1);
      assert.equal(frontier?.state, "lifecycle", "An unfinished lifecycle is pending, never completed by the fixture");
    }
  }
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    await advancePublications();
    assert.ok(fn[name], `Unknown public fixture function ${name}`);
    const file = ["moduleDefaults", "researchSessions", "modules"].find((f) => loaded[`${f}.ts`][name] === fn[name]);
    return task(`internal.${file}.${name}`, args);
  };
  const next = async () => { const entry = scheduled.shift(); assert.ok(entry, "Expected scheduled work"); assert.equal(entry.delay, 0, "Do not advance retry time"); const result = await task(entry.name, entry.args); await advancePublications(); return result; };
  const drain = async () => { await advancePublications(); let count = 0; while (scheduled.length) { assert.ok(count++ < 100, "scheduled work terminates"); await next(); } };
  const rows = (table: string) => db.query(table).collect() as Promise<Array<Record<string, any>>>;
  const install = async () => { const p = await run("previewInstall", { source: "canon:fixture" }); return run("install", { source: p.source, sha: p.pinned.sha, manifestHash: p.manifestHash }); };
  return { run, rows, db, files, storage, scheduled, next, drain, install, seed: loaded["moduleDefaults.ts"].seedDefaultModules as unknown as (ctx: unknown, org: string) => Promise<number>, ctx };
}

test("Work is on in a workspace that never had it, is installed there once, and stays off once an admin turns it off", async () => {
  const h = harness(undefined, {}, { RECIPE_RUNTIME_URL: "https://runtime.test", RECIPE_RUNTIME_SECRET: "test-runtime-secret" });
  const nav = (mods: unknown) => visibleSections([], mods as never).find((s) => s.label === "Work")?.items.map((i) => [i.label, i.href, i.badge ?? null]);
  const work = [["My work", "/dashboard/tasks", "dueTasks"], ["Review", "/dashboard/facts", null], ["Next best actions", "/dashboard/m/work", null]];
  assert.deepEqual(nav(await h.run("list")), work, "before the sweep, the nav already shows Work");

  await h.run("sweep");
  await h.drain();
  await h.run("sweep");
  await h.drain();
  const pkgs = (await h.rows("modulePackages")).filter((p) => p.moduleId === "@canon/work");
  assert.deepEqual(pkgs.map((p) => [p.orgId, p.status, p.source.kind]), [["org", "installed", "canon"], ["org2", "installed", "canon"]], "one install per workspace, however often it runs");
  assert.deepEqual(nav(await h.run("list")), work);
  assert.deepEqual(visibleSections(["my-work", "review"], await h.run("list") as never).find((s) => s.label === "Work")?.items.map((i) => i.label), ["Next best actions"], "workspace.nav still hides the linked Canon pages by id");

  await h.run("setEnabled", { moduleId: "@canon/work", enabled: false });
  await h.run("sweep");
  assert.equal(nav(await h.run("list")), undefined, "turned off, Work leaves the nav and the sweep leaves it off");
});

test("Work upgrades coaching with a new conversation read receipt, preserving opt-outs", async () => {
  const next = JSON.parse(readFileSync("modules/examples/work/module.json", "utf8"));
  const bundle = readFileSync("modules/examples/work/dist/module.js", "utf8");
  const previous = structuredClone(next);
  previous.version = "0.2.0";
  delete previous.reads.conversations;
  delete previous.calls.startRun.reads.conversations;
  const catalog = { work: example(previous, "a", bundle) };
  const h = harness(catalog);
  await h.run("sweep"); await h.drain();
  await h.run("setEnabled", { moduleId: "@canon/work", enabled: false });
  catalog.work = example(next, "b", bundle);
  await h.run("sweep"); await h.drain();
  const pkg = (await h.rows("modulePackages")).find((p) => p.orgId === "org")!;
  assert.equal(pkg.version, next.version);
  assert.equal(h.files.get(pkg.bundleStorageId), bundle);
  assert.deepEqual(plain(pkg.autoUpgrade.newReads), next.reads.conversations.map((f: string) => `conversations.${f}`));
  assert.equal((await h.run("installed")).modules[0].enabled, false);
});

test("Dialer defaults into its Activity slot, preserves opt-outs and automatically approves new task reads", async () => {
  const dialer = JSON.parse(readFileSync("modules/examples/dialer/module.json", "utf8"));
  const bundle = readFileSync("modules/examples/dialer/dist/module.js", "utf8");
  const catalog = { dialer: example(dialer, "d", bundle) };
  const env = { RECIPE_RUNTIME_URL: "https://runtime.test", RECIPE_RUNTIME_SECRET: "test-runtime-secret" };
  const h = harness(catalog, {}, env);
  const nav = async () => visibleSections([], await h.run("list") as never).flatMap((s) => s.items.filter((i) => i.id === "dialer").map((i) => [s.label, i.label, i.href]));
  const expected = [["Activity", "Dialer", "/dashboard/m/dialer/dialer"]];
  assert.deepEqual(await nav(), expected, "one entry is available while the default install is pending");
  await h.seed(h.ctx(), "org");
  await h.drain();
  await h.run("sweep"); await h.drain();
  assert.deepEqual(await nav(), expected);
  const modules = await h.run("list");
  assert.equal(movedTo("/dashboard/dialer", modules), "/dashboard/m/dialer/dialer");
  assert.equal(movedTo("/dashboard/dialer/old", modules), "/dashboard/m/dialer/dialer");
  assert.equal(movedTo("/dashboard/dialer-other", modules), null);
  assert.equal(visibleSections(["dialer"], modules).flatMap((s) => s.items).some((i) => i.id === "dialer"), false);
  await h.run("setEnabled", { moduleId: "@canon/dialer", enabled: false });
  await h.run("sweep"); await h.drain();
  assert.deepEqual(await nav(), []);
  assert.equal(movedTo("/dashboard/dialer", await h.run("list")), null);
  await h.run("uninstall", { moduleId: "@canon/dialer" });
  await h.run("sweep"); await h.drain();
  assert.deepEqual(await nav(), []);
  assert.equal((await h.rows("modulePackages")).find((p) => p.orgId === "org")?.status, "uninstalled");

  const previous = structuredClone(dialer);
  previous.version = "0.3.0";
  delete previous.uses;
  delete previous.calls.loadCallTasks;
  const header = previous.pages[0].body[0];
  header.actions = header.actions.filter((action: { call?: string }) => action.call !== "loadCallTasks");
  const upgrades = harness({ dialer: example(previous, "a", bundle) }, {}, env);
  const preview = await upgrades.run("previewInstall", { source: "canon:dialer" });
  await upgrades.run("install", { source: preview.source, sha: preview.pinned.sha, manifestHash: preview.manifestHash });
  await upgrades.run("setEnabled", { moduleId: "@canon/dialer", enabled: true });
  shipped.MODULE_EXAMPLES.dialer = catalog.dialer;
  await upgrades.run("sweep"); await upgrades.drain();
  const installed = (await upgrades.rows("modulePackages")).find((p) => p.orgId === "org")!;
  assert.equal(installed.version, "0.4.0");
  assert.ok(installed.autoUpgrade.newReads.length > 0);
  assert.deepEqual(visibleSections([], await upgrades.run("list") as never).flatMap((s) => s.items.filter((i) => i.id === "dialer").map((i) => [s.label, i.label, i.href])), expected);
  assert.equal((await upgrades.rows("modulePackages")).find((p) => p.orgId === "org")!.version, "0.4.0");
});

test("default server bundles seed once per workspace, including workspace creation and an install race", async () => {
  const catalog = { fixture: example(fixture(true), "a", CODE) };
  const h = harness(catalog);
  assert.equal(await h.seed(h.ctx(), "org"), 0, "workspace creation schedules its bundle");
  await h.run("sweep");
  await h.drain();
  await h.run("sweep");
  await h.drain();
  assert.deepEqual((await h.rows("modulePackages")).map((p) => [p.orgId, p.bundleHash, h.files.get(p.bundleStorageId), p.installedBy ?? null]), [
    ["org", CODE_HASH, CODE, null], ["org2", CODE_HASH, CODE, null],
  ]);
  assert.equal(h.files.size, 2);
  assert.deepEqual((await h.rows("recipeEnablements")).map((p) => [p.orgId, p.enabled]), [["org", true], ["org2", true]]);

  const racing = harness(catalog);
  const store = racing.storage.store;
  racing.storage.store = async (blob) => {
    await racing.db.insert("recipeEnablements", { orgId: "org", point: "module", recipeId: ID, contributionKey: "nav", enabled: false });
    return store(blob);
  };
  await racing.run("reconcile", { orgId: "org" });
  assert.equal((await racing.rows("modulePackages")).length, 0);
  assert.equal(racing.files.size, 0, "the abandoned bundle is deleted when an admin acts before the insert");
});

test("the default sweep automatically approves and records new reads for Canon defaults", async () => {
  const m = fixture(true);
  const catalog = { fixture: example(m, "a", CODE) };
  const h = harness(catalog, {}, { RECIPE_RUNTIME_URL: "https://runtime.test", RECIPE_RUNTIME_SECRET: "test-runtime-secret" });
  await h.run("sweep"); await h.drain();
  await h.run("setEnabled", { moduleId: ID, enabled: false });
  const upgraded = { ...m, version: "0.2.0", collections: { ...m.collections, items: { ...m.collections.items, schema: { type: "object", value: { ...m.collections.items.schema.value, extra: { fieldType: { type: "string" }, optional: true } } } } } };
  catalog.fixture = example(upgraded, "b", CODE + "\n");
  await h.run("sweep");
  await h.next();
  assert.equal((await h.rows("modulePackages"))[0].pending.by, undefined, "Canon's backfill has no installer user");
  await h.run("sweep"); await h.drain();
  assert.deepEqual((await h.rows("modulePackages")).map((p) => [p.version, p.source.sha, p.epoch]), [["0.2.0", "b".repeat(64), 2], ["0.2.0", "b".repeat(64), 2]]);
  assert.equal((await h.run("installed")).modules[0].enabled, false);
  assert.equal(h.files.size, 2, "the old bundles were removed");

  const github = (await h.rows("modulePackages")).find((p) => p.orgId === "org2")!;
  await h.db.patch(github._id, { source: { kind: "github-public", owner: "o", repo: "r", ref: "v0.2.0", sha: "b".repeat(40) } });
  catalog.fixture = example({ ...upgraded, version: "0.3.0", reads: { deals: ["amount"] } }, "c", CODE);
  await h.run("sweep"); await h.drain();
  assert.deepEqual((await h.rows("modulePackages")).map((p) => p.version), ["0.3.0", "0.2.0"], "a GitHub install is never auto-approved by the default sweep");
  const receipt = (await h.run("installed")).modules[0].autoUpgrade;
  assert.equal(receipt.version, "0.3.0");
  assert.deepEqual(plain(receipt.newReads), ["deals.amount"]);
  await h.run("setEnabled", { moduleId: ID, enabled: true });
  assert.deepEqual(plain((await h.run("list")).find((m: { moduleId: string }) => m.moduleId === ID).autoUpgrade), plain(receipt));
});

test("Canon imports run from their cursor once per workspace and preserve existing keys on later builds", async () => {
  const calls: Array<[string, string | null]> = [];
  const imports: Record<string, ModuleImport> = { [NAME]: {
    module: ID, label: "Existing items",
    batch: async (_ctx, org, cursor) => {
      calls.push([org, cursor]);
      return cursor === null
        ? { docs: [{ collection: "items", key: "one", data: { title: "First" } }], cursor: "page2" }
        : { docs: [{ collection: "items", key: "one", data: { title: "Overwrite" } }, { collection: "children", key: "child", parentKey: "one", data: { title: "Child" } }], cursor: null };
    },
  } };
  const m = { ...fixture(), imports: [NAME] };
  const catalog = { fixture: example(m, "a") };
  const h = harness(catalog, imports);
  const preview = await h.run("previewInstall", { source: "canon:fixture" });
  assert.deepEqual(plain(preview.imports), [{ name: NAME, label: "Existing items" }]);
  await h.install();
  await h.next();
  assert.deepEqual(plain((await h.rows("modulePackages"))[0].imports[NAME]), { cursor: null, done: false }, "the first import waits for the retained publication");
  assert.deepEqual(calls, [], "waiting never invokes the importer");
  assert.equal((await h.run("installed")).modules[0].enabled, false, "manual installs start off");
  await h.run("sweep");
  await h.next();
  assert.deepEqual(plain((await h.rows("modulePackages"))[0].imports[NAME]), { cursor: "page2", done: false });
  await h.drain();
  assert.deepEqual(calls, [["org", null], ["org2", null], ["org", "page2"], ["org2", "page2"]]);
  assert.deepEqual((await h.rows("moduleDocs")).map((d) => [d.orgId, d.collection, d.key, d.parentKey ?? null, d.data.title]), [
    ["org", "items", "one", null, "First"], ["org2", "items", "one", null, "First"], ["org", "children", "child", "one", "Child"], ["org2", "children", "child", "one", "Child"],
  ]);
  assert.deepEqual(plain((await h.run("installed")).modules[0].imports), [{ name: NAME, label: "Existing items", cursor: null, done: true }]);
  assert.deepEqual((await h.rows("moduleEvents")).map((e) => e.actor.kind), ["system", "system", "system", "system"]);

  await h.run("sweep"); await h.drain();
  catalog.fixture = example({ ...m, version: "0.2.0" }, "b");
  await h.run("sweep"); await h.drain();
  await h.run("uninstall", { moduleId: ID });
  await h.install(); await h.drain();
  assert.equal(calls.length, 4, "sweeps, upgrades and reinstalls never rerun a completed import");
});

test("an import first named by a pending upgrade waits until cutover", async () => {
  let calls = 0;
  const m = fixture();
  const catalog = { fixture: example(m, "a") };
  const h = harness(catalog, { [NAME]: { module: ID, label: "Existing items", batch: async () => { calls++; return { docs: [{ collection: "items", key: "one", data: { title: "Imported", extra: "Fits new schema" } }], cursor: null }; } } });
  await h.install();
  const next = { ...m, version: "0.2.0", imports: [NAME], collections: { ...m.collections, items: { ...m.collections.items, schema: { type: "object", value: { ...m.collections.items.schema.value, extra: { fieldType: { type: "string" }, optional: true } } } } } };
  catalog.fixture = example(next, "b");
  assert.equal((await h.install()).status, "upgrading");
  assert.equal(calls, 0);
  assert.equal((await h.rows("modulePackages"))[0].imports, undefined);
  await h.next();
  assert.equal((await h.rows("modulePackages"))[0].version, "0.2.0");
  assert.equal(calls, 0, "cutover schedules the import after activation");
  await h.drain();
  assert.equal(calls, 1);
  assert.deepEqual(plain((await h.rows("moduleDocs"))[0].data), { title: "Imported", extra: "Fits new schema" });
});

test("an in-progress import waits through migration and cutover and resumes its cursor on activation", async () => {
  const calls: Array<string | null> = [];
  const m = { ...fixture(true), imports: [NAME] };
  const catalog = { fixture: example(m, "a", CODE) };
  const h = harness(catalog, { [NAME]: { module: ID, label: "Existing items", batch: async (_ctx, _org, cursor) => {
    calls.push(cursor);
    return { docs: [{ collection: "items", key: cursor ?? "first", data: { title: cursor ?? "First" } }], cursor: cursor === null ? "second" : null };
  } } });
  await h.install();
  await h.next();
  await h.next();
  catalog.fixture = example({ ...m, version: "0.2.0", migrations: { items: [{ from: "<0.2.0", call: "migrateItems" }] } }, "b", CODE);
  assert.equal((await h.install()).status, "upgrading");
  const at = { orgId: "org", moduleId: ID, name: NAME, cursor: "second" };
  await h.next();
  assert.deepEqual(plain((await h.rows("modulePackages"))[0].imports[NAME]), { cursor: "second", done: false });
  assert.deepEqual(calls, [null]);
  const upgrade = { orgId: "org", moduleId: ID, epoch: 2 };
  const batch = await h.run("migrationRead", upgrade);
  assert.equal(await h.run("migrationApply", { ...upgrade, step: batch.step, cursor: batch.cursor, keys: batch.docs.map((d: { key: string }) => d.key), results: { value: { results: [{ key: "first", data: { title: "Migrated" } }] } }, error: null }), "more");
  await h.next();
  assert.equal((await h.rows("modulePackages"))[0].pending.phase, "cutover");
  await h.run("importStep", at);
  assert.deepEqual(plain((await h.rows("modulePackages"))[0].imports[NAME]), { cursor: "second", done: false });
  assert.deepEqual(calls, [null]);
  await h.drain();
  assert.deepEqual(calls, [null, "second"]);
  assert.deepEqual(plain((await h.rows("modulePackages"))[0].imports[NAME]), { cursor: null, done: true });
  assert.deepEqual((await h.rows("moduleDocs")).map(d => [d.key, d.data.title]), [["first", "Migrated"], ["second", "second"]]);
});

test("a schema-invalid import rolls back its batch and records an error without retrying", async () => {
  const calls: Array<string | null> = [];
  const m = { ...fixture(), imports: [NAME] };
  const catalog = { fixture: example(m, "a") };
  const h = harness(catalog, { [NAME]: {
    module: ID, label: "Existing items",
    batch: async (_ctx, _org, cursor) => {
      calls.push(cursor);
      return cursor === null
        ? { docs: [{ collection: "items", key: "kept", data: { title: "Committed batch" } }], cursor: "bad" }
        : { docs: [{ collection: "items", key: "rollback", data: { title: "Rolled back" } }, { collection: "items", key: "invalid", data: { title: 7 } }], cursor: null };
    },
  } });
  await h.install(); await h.drain();
  assert.deepEqual(calls, [null, "bad"]);
  assert.deepEqual((await h.rows("moduleDocs")).map((d) => d.key), ["kept"]);
  const state = (await h.run("installed")).modules[0].imports[0];
  assert.equal(state.cursor, "bad"); assert.equal(state.done, false); assert.equal(typeof state.error, "string");
  assert.equal(h.scheduled.length, 0);
  await h.run("reconcile", { orgId: "org" });
  catalog.fixture = example({ ...m, version: "0.2.0" }, "b");
  await h.install(); await h.drain();
  await h.run("importStep", { orgId: "org", moduleId: ID, name: NAME, cursor: "bad" });
  assert.deepEqual(calls, [null, "bad"], "upgrades and duplicate scheduled calls never retry an error");
});

test("imports accept only unique dotted names bound to this module in Canon's registry", async () => {
  for (const imports of [["legacy"], ["Test.legacy"], [NAME, NAME], Array.from({ length: 11 }, (_, n) => `test.import${n}`)]) {
    assert.equal(parseModuleManifest({ ...fixture(), imports }).ok, false);
  }
  const catalog = { fixture: example({ ...fixture(), imports: [NAME] }, "a") };
  const h = harness(catalog, { [NAME]: { module: "@canon/other", label: "Wrong module", batch: async () => ({ docs: [], cursor: null }) } });
  await assert.rejects(h.run("previewInstall", { source: "canon:fixture" }));
  await assert.rejects(h.install());
  await assert.rejects(h.run("storeModule", { moduleId: ID, source: { kind: "canon", id: "fixture", ref: "0.1.0", sha: "a" }, version: "0.1.0", manifest: catalog.fixture.manifest, manifestHash: "hash" }));
  assert.equal((await h.rows("modulePackages")).length, 0);
  const unknown = harness(catalog);
  await assert.rejects(unknown.install());
});

test("the default sweep drops empty collections but leaves populated drops for an admin", async () => {
  const m = fixture();
  const catalog = { fixture: example(m, "a") };
  const h = harness(catalog);
  await h.run("sweep");
  await h.db.insert("moduleDocs", { orgId: "org", moduleId: ID, collection: "children", key: "kept", parentKey: "parent", data: { title: "Existing child" }, version: 1, updatedAt: 1 });
  catalog.fixture = example({ ...m, version: "0.2.0", collections: { items: m.collections.items } }, "b");
  await h.run("sweep"); await h.drain();
  assert.deepEqual((await h.rows("modulePackages")).map((p) => [p.orgId, p.version]), [["org", "0.1.0"], ["org2", "0.2.0"]]);
  assert.deepEqual((await h.rows("moduleDocs")).map((d) => d.key), ["kept"]);
});


test("Reports upgrades without consent, adopts Canon rows and template deletion receipts, and resumes its import", async () => {
  const reports = JSON.parse(readFileSync("modules/examples/reports/module.json", "utf8"));
  const old = { ...reports, version: "0.3.0", reads: { ...reports.reads } };
  delete old.reads.targets; delete old.reads.stageHistory;
  old.pages = reports.pages.filter((p: { path: string }) => p.path === "builder");
  old.nav = { ...reports.nav, landing: "builder" };
  delete old.imports; delete old.reports; delete old.dashboards;
  const catalog = { reports: example(old, "a") };
  const h = harness(catalog);
  await h.seed(h.ctx(), "org"); await h.drain();
  const spec = { object: "deal", filter: [], groupBy: [{ field: "stage" }], measures: [{ fn: "count" }], chart: "bar" };
  for (let i = 0; i < 55; i++) await h.db.insert("reports", { _id: `r${i}`, orgId: "org", name: `Report ${i}`, createdBy: i === 1 ? "other" : "admin", shared: i !== 1, spec, updatedAt: 42, ...(i === 0 ? { builtIn: "pipeline_by_stage" } : {}) });
  await h.db.insert("dashboards", { _id: "board", orgId: "org", name: "Revenue edited", createdBy: "admin", shared: false, builtIn: "revenue", tiles: [{ reportId: "r0", wide: true }], updatedAt: 17 });
  for (let i = 0; i < 50; i++) await h.db.insert("dashboards", { _id: `b${i}`, orgId: "org", name: `Board ${i}`, createdBy: "admin", shared: false, tiles: [], updatedAt: 17 });
  await h.db.insert("recipeEnablements", { orgId: "org", point: "templates.reports", recipeId: "fsgtm-enterprise-deal", contributionKey: "open_by_owner_stage", enabled: true, installed: { version: "1.0.0", at: 1, rowId: "deleted" } });
  const nav = async () => visibleSections([], await h.run("list")).flatMap((s) => s.items).filter((i) => i.id === "reports").map((i) => i.href);
  assert.deepEqual(await nav(), ["/dashboard/dashboards"]);
  // A stale completion receipt cannot activate an older manifest.
  const oldPkg = (await h.rows("modulePackages"))[0];
  await h.db.patch(oldPkg._id, { imports: { "reports.legacy": { cursor: null, done: true } } });
  assert.equal((await h.run("list"))[0].reportsTakeover, false);
  await h.db.patch(oldPkg._id, { imports: undefined });
  catalog.reports = example(reports, "b");
  await h.run("sweep");
  while (!(await h.rows("modulePackages"))[0].imports?.["reports.legacy"]?.cursor) await h.next();
  const cursor = (await h.rows("modulePackages"))[0].imports["reports.legacy"].cursor;
  assert.ok(cursor, "the first bounded batch persists a resume point");
  assert.deepEqual(await nav(), ["/dashboard/dashboards"]);
  assert.equal(reportsModuleTarget(await h.run("list"), "reports", ""), null);
  const during = await loaded["reports.ts"].create.handler(h.ctx(), { name: "During import", spec, shared: false });
  assert.equal((await h.db.get(during))!.module, undefined, "core creates stay Canon's until the import is done");
  assert.ok(await loaded["reports.ts"].get.handler(h.ctx(), { reportId: "r0" }), "partially adopted reports remain readable");
  while (!(await h.db.get("board"))!.module) await h.next();
  assert.deepEqual(await nav(), ["/dashboard/dashboards"]);
  assert.ok((await loaded["dashboards.ts"].list.handler(h.ctx(), {})).some((d: { _id: string }) => d._id === "board"), "partially adopted dashboards remain in Canon until import completion");
  await h.run("sweep"); await h.drain();
  const pkg = (await h.rows("modulePackages"))[0];
  assert.equal(pkg.version, "0.6.0");
  assert.deepEqual(await nav(), ["/dashboard/m/reports/pacing"]);
  assert.ok(pkg.autoUpgrade.newReads.includes("targets.year"));
  assert.deepEqual(plain(pkg.imports["reports.legacy"]), { cursor: null, done: true });
  const rows = await h.rows("reports");
  assert.equal(rows.filter((r) => r.builtIn === "pipeline_by_stage").length, 1);
  assert.equal(rows.some((r) => r.builtIn === "open_pipeline" || r.builtIn === "open_by_owner_stage"), false, "deleted built-ins and recipe reports never return");
  assert.deepEqual(plain(rows.find((r) => r._id === "r1")), { _id: "r1", _creationTime: rows.find((r) => r._id === "r1")!._creationTime, orgId: "org", name: "Report 1", createdBy: "other", shared: false, spec: { ...spec, object: "canon.deals" }, updatedAt: 42, module: { moduleId: "@canon/reports", report: "deals" } });
  assert.deepEqual(plain((await h.rows("dashboards")).find((d) => d._id === "board")!.tiles), [{ reportId: "r0", wide: true }]);
  assert.equal((await h.rows("dashboards")).find((d) => d._id === "board")!.shared, false);
  const before = plain(await h.rows("reports"));
  await h.run("importStep", { orgId: "org", moduleId: "@canon/reports", name: "reports.legacy", cursor });
  await h.run("sweep"); await h.drain();
  assert.deepEqual(plain(await h.rows("reports")), before, "stale batches and completed imports cannot reapply");
  await h.run("setEnabled", { moduleId: "@canon/reports", enabled: false });
  const legacy = loaded["reports.ts"], boards = loaded["dashboards.ts"];
  const visible = await legacy.list.handler(h.ctx(), {});
  assert.equal(visible.some((r: { _id: string }) => r._id === "r1"), false, "fallback preserves another member's private reports");
  assert.equal((await legacy.get.handler(h.ctx(), { reportId: "r0" })).spec.object, "deal");
  assert.equal((await boards.list.handler(h.ctx(), {})).find((d: { _id: string }) => d._id === "board").tiles[0].reportId, "r0");
  await legacy.update.handler(h.ctx(), { reportId: "r0", spec, name: "Off-state edit" });
  assert.equal((await h.rows("reports")).find((r) => r._id === "r0")!.spec.object, "canon.deals");
  const made = await legacy.create.handler(h.ctx(), { name: "Made while off", spec, shared: false });
  const board = await boards.create.handler(h.ctx(), { name: "Made while off", shared: false, tiles: [{ reportId: made, wide: false }] });
  assert.equal((await h.rows("reports")).find((r) => r._id === made)!.module.moduleId, "@canon/reports");
  assert.equal((await h.rows("dashboards")).find((d) => d._id === board)!.module, undefined);
  await h.run("uninstall", { moduleId: "@canon/reports" });
  assert.ok((await legacy.list.handler(h.ctx(), {})).some((r: { _id: string }) => r._id === made), "uninstalled fallback retains saved data");
  assert.deepEqual(plain(await loaded["templates.ts"].ensureDefaults.handler(h.ctx(), {})), { created: 0 }, "uninstalled fallback never duplicates shipped templates");
});

test("Reports leaves unmappable reports, and dashboards showing them, untouched and reports them while finishing the rest", async () => {
  const reports = JSON.parse(readFileSync("modules/examples/reports/module.json", "utf8"));
  const h = harness({ reports: example(reports, "a") });
  const spec = { object: "unknown_object", filter: [], groupBy: [], measures: [{ fn: "count" }], chart: "number" };
  const custom = newObject({ label: "Project", pluralLabel: "Projects", icon: "briefcase", titleLabel: "Project name" }, []);
  await h.db.insert("objectDefs", { orgId: "org", apiName: custom.apiName, ...custom.ext });
  await h.db.insert("reports", { _id: "custom", orgId: "org", name: "Projects", createdBy: "admin", shared: false, spec: { ...spec, object: custom.apiName, groupBy: [{ field: "custom.name" }] }, updatedAt: 11 });
  await h.db.insert("reports", { _id: "refused", orgId: "org", name: "Old object", createdBy: "admin", shared: false, spec, updatedAt: 12 });
  await h.db.insert("dashboards", { _id: "board", orgId: "org", name: "Private", createdBy: "admin", shared: false, tiles: [{ reportId: "refused", wide: false }, { reportId: "custom", wide: true }], updatedAt: 12 });
  await h.seed(h.ctx(), "org"); await h.drain();
  const state = (await h.rows("modulePackages"))[0].imports["reports.legacy"];
  assert.equal(state.done, true);
  assert.equal((await h.rows("reports")).find((r) => r._id === "custom")!.spec.object, "canon.custom_project");
  assert.match(state.error, /refused/);
  assert.equal(await loaded["reports.ts"].legacyRoute.handler(h.ctx(), { reportId: "refused" }), true);
  assert.equal(await loaded["reports.ts"].legacyRoute.handler(h.ctx(), { reportId: "missing" }), false);
  assert.equal((await h.rows("reports")).find((r) => r._id === "refused")!.module, undefined);
  // One tile stayed and one moved; Canon still opens and saves both.
  assert.equal((await h.rows("dashboards")).find((d) => d._id === "board")!.module, undefined);
  assert.match(state.error, /dashboard board/);
  const legacy = loaded["reports.ts"], boards = loaded["dashboards.ts"];
  const board = (await boards.list.handler(h.ctx(), {})).find((d: { _id: string }) => d._id === "board");
  assert.equal(await boards.legacyRoute.handler(h.ctx(), { dashboardId: "board" }), true);
  assert.equal(await boards.legacyRoute.handler(h.ctx(), { dashboardId: "missing" }), false);
  for (const tile of board.tiles) assert.ok(await legacy.get.handler(h.ctx(), { reportId: tile.reportId }));
  assert.equal((await legacy.runContext.handler(h.ctx(), { reportId: "custom" })).spec.object, custom.apiName);
  await boards.update.handler(h.ctx(), { dashboardId: "board", name: "Edited mixed", tiles: board.tiles });
  await assert.rejects(boards.update.handler(h.ctx(), { dashboardId: "board", shared: true }));
  for (const made of [
    await boards.create.handler(h.ctx(), { name: "Mixed", shared: false, tiles: board.tiles }),
    await boards.pin.handler(h.ctx(), { reportId: "refused", name: "Pinned" }),
  ]) assert.equal((await h.db.get(made))!.module, undefined);
  const moved = (await h.rows("dashboards")).find((d) => d.module === "@canon/reports")!;
  assert.equal(await boards.legacyRoute.handler(h.ctx(), { dashboardId: moved._id }), false);
  await assert.rejects(h.run("pinReport", { module: "@canon/reports", reportId: "refused", dashboardId: moved._id }));
  await h.db.patch("board", { createdBy: "other" });
  assert.equal(await boards.legacyRoute.handler(h.ctx(), { dashboardId: "board" }), false);
  await h.db.patch("board", { orgId: "org2", shared: true });
  assert.equal(await boards.legacyRoute.handler(h.ctx(), { dashboardId: "board" }), false);

  const shipped = (await h.rows("reports")).find((r) => r.builtIn === "open_pipeline")!;
  await h.run("removeReport", { module: "@canon/reports", reportId: shipped._id });
  assert.deepEqual(plain(await h.run("ensureShippedReports", { module: "@canon/reports" })), { created: 0 });
  assert.equal((await h.rows("reports")).some((r) => r.builtIn === "open_pipeline"), false);
});


test("automatic claims replace untouched defaults with the plan, including bundles, and preserve later opt-outs", async () => {
  const h = harness(undefined, {}, { RECIPE_RUNTIME_URL: "https://runtime.test", RECIPE_RUNTIME_SECRET: "test-runtime-secret" });
  await h.seed(h.ctx(), "org");
  await h.drain();
  const plan = {
    archetypes: ["Z0"], persona: "unknown", landing: "/dashboard/accounts?segment=first", tasks: [], questions: [],
    modules: ["@canon/work", "@canon/icps", "@canon/sequences"].map((id) => ({ id, label: id, why: "Confirmed", evidence: [] })),
  };
  await h.db.insert("researchSessions", { token: "plan", status: "ready", invitedEmail: "a@x", createdAt: Date.now() - 60_000, startingPlan: plan });
  const result = await h.run("claim", { token: "plan" });
  assert.equal(result.redirect, "/dashboard/accounts?segment=first");
  await h.drain();
  const enabled = async () => (await h.run("list")).map((m: { moduleId: string }) => m.moduleId).sort();
  assert.deepEqual(plain(await enabled()), ["@canon/icps", "@canon/sequences", "@canon/work"]);
  const sequences = (await h.rows("modulePackages")).find((p) => p.orgId === "org" && p.moduleId === "@canon/sequences")!;
  assert.equal(sequences.status, "installed");
  assert.equal(typeof h.files.get(sequences.bundleStorageId), "string");
  await h.run("setEnabled", { moduleId: "@canon/sequences", enabled: false });
  await h.run("uninstall", { moduleId: "@canon/sequences" });
  assert.equal((await h.run("claim", { token: "plan" })).alreadyClaimed, true);
  await h.run("sweep"); await h.drain();
  assert.deepEqual(plain(await enabled()), ["@canon/icps", "@canon/work"]);
  assert.equal((await h.rows("modulePackages")).filter((p) => p.orgId === "org" && p.moduleId === "@canon/sequences").length, 1);
  assert.equal((await h.rows("modulePackages")).find((p) => p.orgId === "org" && p.moduleId === "@canon/sequences")!.status, "uninstalled");
  assert.deepEqual((await h.rows("recipeEnablements")).filter((e) => e.orgId === "org2" && e.enabled).map((e) => e.recipeId).sort(), ["@canon/dialer", "@canon/reports", "@canon/work"]);
});

test("claim excludes queued defaults, keeps explicit choices, and leaves old workspaces alone", async () => {
  const h = harness({ ...originalExamples, work: example(WORK, "a") });
  await h.seed(h.ctx(), "org");
  await h.run("setEnabled", { moduleId: "@canon/work", enabled: false });
  const plan = { archetypes: [], persona: "unknown", landing: "/dashboard/accounts", tasks: [], questions: [], modules: [] };
  await h.db.insert("researchSessions", { token: "plan", status: "ready", invitedEmail: "a@x", createdAt: Date.now() - 60_000, startingPlan: plan, planConfirmedAt: 2 });
  const stale = await h.run("candidates", { orgId: "org" });
  await h.run("claim", { token: "plan" });
  assert.deepEqual(plain(await h.run("list")), []);
  assert.equal(await h.run("storeDefault", { orgId: "org", ...stale[0], bundleHash: CODE_HASH, bundleStorageId: "stale" }), false);
  await h.drain();
  assert.deepEqual((await h.rows("modulePackages")).filter((p) => p.orgId === "org").map((p) => p.moduleId).sort(), ["@canon/reports", "@canon/work"]);
  assert.equal((await h.rows("recipeEnablements")).find((e) => e.orgId === "org" && e.recipeId === "@canon/work")!.by, "admin");

  for (const [token, confirmed, createdAt] of [["old", true, 0], ["old-draft", false, 0]] as const) {
    await h.db.patch("org", { startingPlan: undefined, createdAt });
    await h.db.insert("researchSessions", { token, status: "ready", invitedEmail: "a@x", createdAt: Date.now() - 60_000, startingPlan: plan, ...(confirmed ? { planConfirmedAt: 2 } : {}) });
    await h.run("claim", { token });
    assert.equal((await h.db.get("org"))?.startingPlan, undefined);
  }
});


test("claims build missing plans for admins, import without module changes for members, and refuse agents", async () => {
  for (const [role, agent] of [["admin", null], ["rep", null], ["admin", "agent"]] as const) {
    const h = harness();
    caller.user = { ...admin, role };
    caller.agent = agent;
    await h.db.insert("researchSessions", { token: "automatic", status: "ready", invitedEmail: "a@x", createdAt: Date.now() - 60_000, companyFinding: {
      name: "Acme", summary: "Software for teams", evidence: [{ url: "https://acme.example", quote: "Software for teams" }],
    } });
    if (agent) {
      // Agents never claim: the invitation names a person's verified email.
      await assert.rejects(h.run("claim", { token: "automatic" }), /invitation/);
      continue;
    }
    assert.equal((await h.run("claim", { token: "automatic" })).redirect, "/dashboard/accounts");
    const org = await h.db.get("org");
    const plan = org?.startingPlan as { modules: Array<{ id: string }> } | undefined;
    assert.deepEqual(plain(plan?.modules.map((m) => m.id) ?? []), role === "admin" && agent === null ? ["@canon/icps", "@canon/work"] : []);
    assert.equal((await h.rows("researchSessions"))[0].importStatus, "pending");
  }
  caller.user = admin;
  caller.agent = null;
});
