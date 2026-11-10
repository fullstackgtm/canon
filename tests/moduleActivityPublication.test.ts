import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { types } from "node:util";
import { compareValues } from "convex/values";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import type { ModuleManifest } from "../modules/kernel/manifest.ts";
import type { FieldSpec } from "../modules/kernel/schema.ts";
import type { ModuleScope } from "../convex/lib/modules/scope.ts";
import type { ModuleImport } from "../convex/lib/modules/imports.ts";

// loadConvex uses require for SDK imports; instanceof must use that same constructor.
const { ConvexError } = createRequire(import.meta.url)("convex/values") as typeof import("convex/values");

const ID = "@test/activity-producer";
const person = { _id: "admin", orgId: "org", role: "admin", name: "Ada", isActive: true };
const field = (type: "string" | "number", optional = false): FieldSpec => ({ fieldType: { type }, optional });
function manifest(): ModuleManifest {
  const collection = (parent?: string) => ({ key: "auto" as const, indexes: {}, access: {}, ...(parent ? { setOf: { parent } } : {}),
    schema: { type: "object" as const, value: { title: field("string"), deal: { fieldType: { type: "ref" as const, to: "deals" as const }, optional: true }, people: { fieldType: { type: "array" as const, value: { type: "ref" as const, to: "people" as const } }, optional: true } } },
    activity: { kind: "visit", subject: "title", targets: { deals: "deal", people: "people" }, path: "items/:key" },
  });
  return { kind: "module", id: ID, version: "1.0.0", title: "Producer", description: "Activity producer fixture", author: { org: "test" }, engines: { moduleApi: "1" },
    nav: { label: "Producer", icon: "map", section: "Work", landing: "items" }, server: "dist/module.js",
    collections: { roots: { key: "auto", indexes: {}, access: {}, schema: { type: "object", value: { title: field("string") } } }, items: collection("roots"), others: collection("roots"), standalone: collection() },
    views: {}, pages: [], ops: { update: { kind: "update", collection: "standalone", label: "Update", roles: ["admin"], agent: "allowed", fields: ["title", "deal"] } },
    calls: { edit: { label: "Edit", roles: ["admin"], agent: "allowed", reads: {}, writes: ["roots", "items", "others", "standalone"], returns: "none" }, watch: { label: "Watch", roles: [], system: true, agent: "allowed", reads: {}, writes: [], returns: "none" } },
    reads: { activities: ["kind", "subject", "dealId"] }, watches: [{ object: "activities", call: "watch", fields: ["kind", "dealId"] }],
  };
}
function doc(collection: string, key: string, extra: Record<string, unknown> = {}) {
  return { _id: `${collection}:${key}`, _creationTime: 10, orgId: "org", moduleId: ID, collection, key, data: { title: key, ...(collection === "roots" ? {} : { deal: "d1", people: ["con_1", "con_2"] }) }, version: 1, updatedAt: 10, ...extra };
}
const INDEXES: Record<string, string[]> = {
  by_orgId_ordinal: ["orgId", "ordinal"], by_orgId_seq: ["orgId", "seq"],
  by_publicationId_kind_incarnation: ["publicationId", "kind", "incarnation"],
  by_publicationId_kind_collection_key_incarnation: ["publicationId", "kind", "collection", "key", "incarnation"],
  by_ownerKind_ownerId_side_part: ["ownerKind", "ownerId", "side", "part"],
  by_orgId_moduleId_collection_key: ["orgId", "moduleId", "collection", "key"],
  by_orgId_moduleId_collection_parentKey_gen_key: ["orgId", "moduleId", "collection", "parentKey", "gen", "key"],
};
function fixture(rows = [doc("standalone", "one")], pending?: Record<string, unknown>, enabled = true, captureSession: "normal" | "missing" = "normal", editManifest?: (m: ModuleManifest) => void, clock?: { now: number }, env: Record<string, string> = {}) {
  const m = manifest();
  editManifest?.(m);
  let importCalls = 0;
  const loaded = loadConvex(["modules.ts", "moduleJobs.ts", "moduleActivityPublications.ts", "lib/modules/scope.ts", "lib/modules/activityCapture.ts"], {
    "lib.ts": (real) => ({ ...real, getCurrentUser: async () => db.get(person._id), requireUser: async () => db.get(person._id), agentClientOf: async () => null }),
    "lib/modules/imports.ts": (real) => {
      (real.MODULE_IMPORTS as Record<string, ModuleImport>)["probe.legacy"] = { module: ID, label: "Fixture import", batch: async (_ctx, _orgId, cursor) => {
        importCalls++;
        return { docs: [{ collection: "standalone", key: cursor === null ? "import-first" : "import-next", data: { title: "Imported" } }], cursor: cursor === null ? "next" : null };
      } };
      return real;
    },
    ...(captureSession === "missing" ? { "lib/modules/activityCapture.ts": (real: Record<string, unknown>) => ({ ...real, withModulePublication: async (_ctx: unknown, body: () => Promise<unknown>) => body() }) } : {}),
  }, { process: { env }, ...(clock ? { Date: class extends Date { static now() { return clock.now; } } } : {}) });
  const pkg = { _id: "pkg", orgId: "org", moduleId: ID, slug: "activity-producer", source: { kind: "canon", id: "activity-producer", ref: "1.0.0", sha: "a".repeat(40) }, version: "1.0.0", status: "installed", installedAt: 1, epoch: 1, manifest: JSON.stringify(m), manifestHash: "old", ...(pending ? { pending } : {}) };
  const db = memoryDb({ users: [person], organizations: [{ _id: "org" }], deals: ["d1", "d2"].map((_id) => ({ _id, orgId: "org", name: _id })), modulePackages: [pkg], moduleDocs: rows,
    recipeEnablements: [{ _id: "enabled", orgId: "org", point: "module", recipeId: ID, contributionKey: "nav", enabled }],
  });
  let fault: ((table: string) => void) | null = null;
  const physicalReads: string[] = [];
  const scheduled: Array<{ ref: string; args: Record<string, unknown>; delay: number }> = [];
  const scheduler = { runAfter: async (delay: number, ref: unknown, args: Record<string, unknown>) => { scheduled.push({ ref: String(ref), args, delay }); } };
  const compare = (a: unknown, b: unknown) => {
    if ((a === undefined || a === null || typeof a === "string" || typeof a === "number" || typeof a === "boolean") && (b === undefined || b === null || typeof b === "string" || typeof b === "number" || typeof b === "boolean")) return compareValues(a, b);
    throw new Error("The fixture index needs a supported scalar field.");
  };
  type FixtureRange = Record<"eq" | "gt" | "gte" | "lt" | "lte", (field: string, value: unknown) => FixtureRange>;
  const query = (table: string) => {
    const base = db.query(table);
    let fields: string[] = [], descending = false;
    const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
    const selected = (rows: Record<string, unknown>[]) => { if (table === "moduleDocs") physicalReads.push(...rows.map((r) => `${r.collection}/${r.key}`)); return rows; };
    const sorted = async () => db.rows(table).filter((r) => predicates.every((p) => p(r))).sort((a, b) => {
      for (const field of fields) { const order = compare(a[field], b[field]); if (order) return order * (descending ? -1 : 1); }
      return compare(a._creationTime, b._creationTime) * (descending ? -1 : 1);
    }).map((r) => structuredClone(r));
    const chain = { ...base,
      withIndex: (name: string, fn?: (q: unknown) => unknown) => {
        fields = INDEXES[name] ?? [];
        const range = (test: (n: number) => boolean) => (field: string, value: unknown) => { predicates.push((r) => test(compare(r[field], value))); return q; };
        const q: FixtureRange = { eq: range((n) => n === 0), gt: range((n) => n > 0), gte: range((n) => n >= 0), lt: range((n) => n < 0), lte: range((n) => n <= 0) };
        fn?.(q); return chain;
      },
      order: (direction: "asc" | "desc") => { descending = direction === "desc"; return chain; },
      take: async (n: number) => selected((await sorted()).slice(0, n)), first: async () => selected((await sorted()).slice(0, 1))[0] ?? null,
      unique: async () => { const rows = await sorted(); if (rows.length > 1) throw new Error("The fixture unique index matched multiple rows."); return selected(rows)[0] ?? null; },
      collect: async () => selected(await sorted()),
      async *[Symbol.asyncIterator]() { for (const row of await sorted()) yield selected([row])[0]; },
      paginate: async ({ numItems, cursor }: { numItems: number; cursor: string | null }) => { const list = await sorted(), start = Number(cursor ?? 0); return { page: selected(list.slice(start, start + numItems)), isDone: start + numItems >= list.length, continueCursor: String(start + numItems) }; },
    };
    return chain;
  };

  function context() {
    const txDb = new Proxy(db, { get: (target, key) => key === "query" ? query : key === "get" ? async (id: string) => { const row = structuredClone(await db.get(id)); if (row?.moduleId === ID && row.data) physicalReads.push(`${row.collection}/${row.key}`); return row; } : key === "insert" ? async (table: string, value: Record<string, unknown>) => { fault?.(table); return db.insert(table, value); } : Reflect.get(target, key) });
    return { db: txDb, scheduler, storage: { delete: async () => undefined }, auth: { getUserIdentity: async () => null }, runMutation: (ref: unknown, args: Record<string, unknown>) => call(String(ref).split(".").pop()!, args, `${String(ref).split(".")[1]}.ts`) };
  }
  async function call(name: string, args: Record<string, unknown> = {}, file = "modules.ts") {
    const checkpoint = db.checkpoint(), scheduledAt = scheduled.length;
    try { return structuredClone(await loaded[file][name].handler(context(), args)); }
    catch (error) { db.rollback(checkpoint); scheduled.splice(scheduledAt); throw error; }
  }
  const head = () => db.rows("moduleActivityHeads")[0];
  const publication = () => db.rows("moduleActivityPublications").find((p) => p.state !== "complete");
  async function drain() {
    for (let i = 0; i < 10_000; i++) {
      const next = await call("next", { orgId: "org" }, "moduleActivityPublications.ts");
      if (!next) return;
      await call("step", next, "moduleActivityPublications.ts");
    }
    assert.fail("The bounded publication did not finish.");
  }
  function side(frame: Record<string, unknown>, name: "before" | "after") {
    if (frame[`${name}Digest`] === null) return null;
    const chunks = db.rows("moduleActivityChunks").filter((c) => c.ownerKind === "journal" && c.ownerId === frame._id && c.side === name).sort((a, b) => Number(a.part) - Number(b.part));
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + (c.bytes as ArrayBuffer).byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) { const part = new Uint8Array(chunk.bytes as ArrayBuffer); bytes.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  const changes = () => db.rows("moduleActivityJournal").filter((r) => r.kind === "change" && Number(r.seq) <= Number(head()?.readableSeq ?? 0)).map((r) => ({ before: side(r, "before"), after: side(r, "after") }));
  const edit = (intents: unknown[]) => call("applyCall", { module: ID, call: "edit", epoch: Number(db.rows("modulePackages")[0].epoch), intents, admit: ["people::con_1", "people::con_2"] });
  const scope = () => (loaded["lib/modules/scope.ts"].moduleScope as unknown as (ctx: unknown, module: string) => Promise<ModuleScope | null>)(context(), ID);
  async function transaction(body: (scope: ModuleScope) => Promise<unknown>, nested = false) {
    const checkpoint = db.checkpoint(), scheduledAt = scheduled.length, ctx = context();
    const scoped = await (loaded["lib/modules/scope.ts"].moduleScope as unknown as (ctx: unknown, module: string) => Promise<ModuleScope>)(ctx, ID);
    const withPublication = loaded["lib/modules/activityCapture.ts"].withModulePublication as unknown as (ctx: unknown, body: () => Promise<unknown>) => Promise<unknown>;
    try { return await (nested ? withPublication(ctx, () => body(scoped)) : body(scoped)); }
    catch (error) { db.rollback(checkpoint); scheduled.splice(scheduledAt); throw error; }
  }
  return { db, m, pkg, call, edit, drain, head, publication, side, changes, scheduled, scope, transaction, physicalReads, importCalls: () => importCalls, fail: (fn: typeof fault) => { fault = fn; } };
}

test("ordinary leaf and root data edits publish without reading unrelated physical activity rows", async () => {
  const h = fixture([doc("standalone", "one"), doc("roots", "parent"), ...Array.from({ length: 60 }, (_, i) => doc("standalone", `unrelated-${i}`)), ...Array.from({ length: 60 }, (_, i) => doc("items", `child-${i}`, { parentKey: "parent", gen: 0 }))]);
  await h.edit([{ op: "patch", collection: "standalone", key: "one", data: { title: "Changed" } }]);
  h.physicalReads.length = 0;
  await h.drain();
  assert.ok(h.physicalReads.length > 0);
  assert.deepEqual([...new Set(h.physicalReads)], ["standalone/one"]);
  assert.deepEqual(h.changes().map((change) => [change.before.activity.subject, change.after.activity.subject]), [["one", "Changed"]]);
  await h.edit([{ op: "patch", collection: "roots", key: "parent", data: { title: "Root data only" } }]);
  h.physicalReads.length = 0;
  await h.drain();
  assert.deepEqual([...new Set(h.physicalReads)], ["roots/parent"]);
  assert.equal(h.changes().length, 1);
  assert.equal(h.head().pending, false);
  assert.equal(h.db.rows("modulePackages")[0].activityPublication, undefined);
});

test("valid dot keys publish canonical create, edit and delete without navigation or retained pins", async () => {
  const h = fixture([], undefined, true, "normal", (m) => { m.collections.standalone.key = { from: ["title"] }; });
  for (const key of [".", ".."]) {
    await h.edit([{ op: "put", collection: "standalone", data: { title: key, deal: "d1", people: ["con_1", "con_2"] } }]);
    await h.drain();
    await h.edit([{ op: "patch", collection: "standalone", key, data: { deal: "d2" } }]);
    await h.drain();
    await h.edit([{ op: "delete", collection: "standalone", key }]);
    await h.drain();
    const changes = h.changes().filter((change) => (change.before ?? change.after).sourceIdentity.key === key);
    assert.equal(changes.length, 3);
    assert.equal(changes[0].before, null);
    assert.equal(changes[2].after, null);
    assert.equal(changes[1].before.scalarTargets.deals, "d1");
    assert.equal(changes[1].after.scalarTargets.deals, "d2");
    assert.deepEqual(changes[2].before.refs, [{ object: "contact", id: "con_1" }, { object: "contact", id: "con_2" }, { object: "deal", id: "d2" }]);
    for (const side of changes.flatMap((change) => [change.before, change.after]).filter(Boolean)) {
      assert.equal(side.activity.id, `module:%40test%2Factivity-producer/standalone/${key}`);
      assert.deepEqual(side.sourceIdentity, { moduleId: ID, collection: "standalone", key });
      assert.deepEqual(side.provenance.representation, { slug: "activity-producer", path: "items/:key", key });
      assert.equal("source" in side.activity, false);
      assert.equal("href" in side.activity, false);
      assert.equal(side.available.includes("source"), false);
      assert.equal(side.available.includes("href"), false);
    }
    assert.equal(h.head().committedOrdinal, h.head().publishedOrdinal);
    assert.equal(h.head().pending, false);
    assert.equal(h.db.rows("modulePackages")[0].activityPublication, undefined);
  }
});

test("retained representation changes publish without treating unrelated manifest hashes as canonical fact changes", async () => {
  const h = fixture();
  const next = structuredClone(h.m);
  next.version = "1.0.1";
  next.collections.standalone.activity!.path = "changed/:key";
  await h.call("storeModule", { moduleId: ID, source: { ...h.pkg.source, sha: "d".repeat(40) }, version: next.version, manifest: JSON.stringify(next), manifestHash: "path-change", approveReads: true });
  await h.drain();
  const changes = h.changes();
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].before.activity, changes[0].after.activity);
  assert.equal(changes[0].before.provenance.representation.path, "items/:key");
  assert.equal(changes[0].after.provenance.representation.path, "changed/:key");
  next.version = "1.0.2";
  await h.call("storeModule", { moduleId: ID, source: { ...h.pkg.source, sha: "e".repeat(40) }, version: next.version, manifest: JSON.stringify(next), manifestHash: "unrelated-hash", approveReads: true });
  h.physicalReads.length = 0;
  await h.drain();
  assert.deepEqual(h.physicalReads, []);
  assert.equal(h.changes().length, 1);
  assert.equal(h.head().pending, false);
});

test("public packed writes retain the first root and logical preimage across siblings, generations and reincarnation", async () => {
  const h = fixture([doc("roots", "root", { gens: { items: 1, others: 1 } }), doc("items", "old", { parentKey: "root", gen: 1 }), doc("items", "future", { parentKey: "root", gen: 2, data: { title: "future", deal: "d2" } }), doc("items", "retained-stage", { parentKey: "root", gen: 3 }), doc("standalone", "same")]);
  const result = await h.edit([
    { op: "patch", collection: "roots", key: "root", data: { title: "Edited first" } },
    { op: "delete", collection: "items", key: "old" },
    { op: "replaceSet", collection: "items", parentKey: "root", gen: 2, count: 1 },
    { op: "delete", collection: "standalone", key: "same" },
    { op: "put", collection: "standalone", key: "same", data: { title: "Recreated", deal: "d2", people: ["con_1", "con_2"] } },
  ]);
  assert.equal(result.writes, 5);
  assert.equal(h.head().pending, true);
  assert.equal(h.head().readableSeq, 0);
  const originalRoot = h.db.rows("moduleActivityEvidence").find((r) => r.kind === "root" && r.key === "root")!;
  const rootChunks = h.db.rows("moduleActivityChunks").filter((r) => r.ownerId === originalRoot._id && r.side === "header");
  assert.equal(JSON.parse(new TextDecoder().decode(rootChunks[0].bytes as ArrayBuffer)).gens.items, 1);
  await assert.rejects(h.call("dropGeneration", { module: ID, call: "edit", epoch: 1, collection: "items", parentKey: "root", gen: 3 }));
  await h.drain();
  const changes = h.changes();
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.map((c) => [c.before?.sourceIdentity.key ?? null, c.after?.sourceIdentity.key ?? null]).sort(), [[null, "future"], ["old", null], ["same", "same"]].sort());
  const recreated = changes.find((c) => c.after?.sourceIdentity.key === "same")!;
  assert.equal(recreated.before.activity.subject, "same");
  assert.equal(recreated.after.activity.subject, "Recreated");
  assert.notEqual(recreated.before.incarnation, recreated.after.incarnation);
  assert.deepEqual(recreated.before.refs, [{ object: "contact", id: "con_1" }, { object: "contact", id: "con_2" }, { object: "deal", id: "d1" }]);
  assert.equal(recreated.after.scalarTargets.people, null);
  const deletedChild = changes.find((c) => c.before?.sourceIdentity.key === "old")!;
  assert.deepEqual(deletedChild.before.provenance.root, { incarnation: "roots:root", generation: 1 });
  assert.equal(deletedChild.before.provenance.version, 1);
  assert.equal(deletedChild.before.provenance.packageId, "pkg");
  assert.equal(h.head().pending, false);
  assert.equal(h.db.rows("modulePackages")[0].activityPublication, undefined);
  assert.equal(h.db.rows("moduleActivityEvidence").length, 0);
  await h.edit([
    { op: "delete", collection: "roots", key: "root" },
    { op: "put", collection: "roots", key: "root", data: { title: "New root incarnation" } },
    { op: "put", collection: "items", key: "new-child", parentKey: "root", data: { title: "New child", deal: "d2", people: ["con_1"] } },
  ]);
  await h.drain();
  const replacement = h.changes().slice(3);
  assert.deepEqual(replacement.map((c) => [c.before?.sourceIdentity.key ?? null, c.after?.sourceIdentity.key ?? null]).sort(), [["future", null], [null, "new-child"]].sort());
  assert.deepEqual(replacement.find((c) => c.before)?.before.refs, [{ object: "deal", id: "d2" }]);
  assert.deepEqual(replacement.find((c) => c.after)?.after.refs, [{ object: "contact", id: "con_1" }, { object: "deal", id: "d2" }]);
  assert.notEqual(replacement.find((c) => c.before)?.before.provenance.root.incarnation, replacement.find((c) => c.after)?.after.provenance.root.incarnation);
  assert.equal(h.head().committedOrdinal, h.head().publishedOrdinal);
  assert.equal(h.head().pending, false);
  assert.equal(h.db.rows("modulePackages")[0].activityPublication, undefined);
});

test("staged sets stay unpublished and a public cascade captures two child collections", async () => {
  const h = fixture([doc("roots", "root", { gens: { items: 1, others: 1 } }), doc("items", "a", { parentKey: "root", gen: 1 }), doc("others", "b", { parentKey: "root", gen: 1 })]);
  for (const offset of [0, 1]) await h.call("stageSet", { module: ID, call: "edit", epoch: 1, collection: "items", parentKey: "root", gen: 9, offset, docs: [{ title: `Staged ${offset}` }], admit: [] });
  assert.equal(h.db.rows("moduleActivityHeads").length, 0);
  await h.edit([{ op: "delete", collection: "roots", key: "root" }]);
  await h.drain();
  assert.deepEqual(h.changes().map((c) => [c.before.sourceIdentity.collection, c.after]).sort(), [["items", null], ["others", null]]);
  const through = Number(h.head().readableSeq);
  await h.edit([{ op: "put", collection: "roots", key: "ephemeral", data: { title: "Ephemeral" } }, { op: "delete", collection: "roots", key: "ephemeral" }]);
  await h.drain();
  assert.equal(h.changes().length, 2);
  assert.equal(h.head().readableSeq, through + 1);
  assert.equal(h.db.rows("moduleActivityJournal").filter((row) => row.kind === "complete").length, 2);
});

test("registered op failure during capture rolls back business data, evidence, frontier and pin in the transaction model", async () => {
  const h = fixture();
  const before = h.db.checkpoint();
  let evidenceWrites = 0;
  h.fail((table) => { if (table === "moduleActivityEvidence" && ++evidenceWrites === 2) throw new ConvexError("private evidence rejection"); });
  await assert.rejects(h.call("op", { module: ID, op: "update", key: "one", expect: 1, data: { title: "Business write happened before flush" } }), (error) => types.isNativeError(error) && !(error instanceof ConvexError) && !error.message.includes("private evidence"));
  assert.equal(evidenceWrites, 2);
  assert.deepEqual(h.db.checkpoint(), before, "memoryDb rollback models Convex atomicity; this is not backend rollback proof");
  assert.equal(h.scheduled.length, 0);
  h.fail((table) => { if (table === "moduleDocs") throw new ConvexError("private physical rejection"); });
  await assert.rejects(h.transaction(async (scope) => {
    try { await scope.apply("edit", [{ op: "put", collection: "standalone", key: "new", data: { title: "Nested attempt" } }]); }
    catch (error) { assert.equal(error instanceof ConvexError, false); }
    return "must not flush a caught fatal";
  }, true), (error) => types.isNativeError(error) && !(error instanceof ConvexError));
  assert.deepEqual(h.db.checkpoint(), before);
  assert.equal(h.scheduled.length, 0);
  h.fail(null);
  await assert.rejects(h.edit([{ op: "event", collection: "standalone", key: "one", note: "Effect before refused write" }, { op: "patch", collection: "standalone", key: "missing", data: { title: "Refused" } }]), (error) => types.isNativeError(error) && !(error instanceof ConvexError));
  assert.deepEqual(h.db.checkpoint(), before, "an effect attempted before the physical boundary is rolled back too");
  assert.equal(h.scheduled.length, 0);
});

test("successful session reentry advances revisions around a safe refusal and keeps first OLD", async () => {
  const h = fixture();
  await h.transaction(async (scope) => {
    await scope.op("update", { key: "one", expect: 1, data: { title: "First success" } });
    const first = structuredClone(h.publication()!);
    await assert.rejects(scope.op("update", { key: "one", expect: 99, data: { title: "Stale" } }), (error) => error instanceof ConvexError && !("cause" in error));
    assert.deepEqual(structuredClone(h.publication()), first);
    await scope.op("update", { key: "one", expect: 2, data: { title: "Final success" } });
    assert.equal(h.publication()!._id, first._id);
    assert.ok(Number(h.publication()!.revision) > Number(first.revision));
  });
  await h.drain();
  assert.deepEqual(h.changes().map((change) => [change.before.activity.subject, change.after.activity.subject]), [["one", "Final success"]]);
});

test("fragmented Unicode, revision retry and a failed prefix retain source pins until complete publication", async () => {
  const h = fixture();
  const title = "🙂漢".repeat(15_000);
  assert.deepEqual(await h.call("op", { module: ID, op: "update", key: "one", expect: 1, data: { title } }), { key: "one", version: 2 });
  const first = await h.call("next", { orgId: "org" }, "moduleActivityPublications.ts");
  const step = await h.call("step", first, "moduleActivityPublications.ts");
  const count = h.db.rows("moduleActivityJournal").length;
  await h.call("step", first, "moduleActivityPublications.ts");
  assert.equal(h.db.rows("moduleActivityJournal").length, count);
  await h.call("failed", { id: first.id, revision: step.revision, error: "Publication interrupted: private source detail" }, "moduleActivityPublications.ts");
  assert.equal(h.publication()!.state, "failed");
  const installed = await h.call("installed");
  assert.equal(installed.modules[0].jobs.activityPublication.pending, true);
  assert.equal(typeof installed.modules[0].jobs.activityPublication.error, "string");
  assert.equal(installed.modules[0].jobs.activityPublication.error.includes("private source detail"), false);
  assert.equal("sourceModule" in installed.modules[0].jobs.activityPublication, false);
  assert.equal(installed.modules[0].jobs.activityBaselines[0].inactive, true);
  assert.equal(h.head().readableSeq, 0);
  await assert.rejects(h.call("op", { module: ID, op: "update", key: "one", expect: 2, data: { title: "Cannot destroy retained OLD" } }));
  // Advance only the fixture clock position, without changing saved publication work or evidence.
  await h.db.patch(String(h.publication()!._id), { retryAt: 0 });
  await h.drain();
  assert.equal(h.changes()[0].after.activity.subject, title);
  assert.equal(h.changes()[0].before.activity.subject, "one");
  assert.ok(h.db.rows("moduleActivityChunks").filter((c) => c.ownerKind === "journal" && c.side === "after").length > 1);
  assert.equal(h.db.rows("moduleActivityJournal").filter((j) => j.kind === "complete").length, 1);
});

test("fresh member writes join only a matching non-migrating lifecycle and retain the worker's first OLD", async () => {
  const h = fixture([doc("standalone", "one", { data: { title: "one", state: "open", deal: "d1", people: ["con_1", "con_2"] } }), doc("scratch", "scratch", { data: { title: "To drop" } })], undefined, true, "normal", (m) => {
    m.collections.scratch = structuredClone(m.collections.roots);
    m.collections.standalone.schema.value.state = { fieldType: { type: "union", value: [{ type: "literal", value: "open" }, { type: "literal", value: "closed" }] }, optional: false };
    m.collections.standalone.activity!.status = "state";
    m.machines = { state: { collection: "standalone", field: "state", states: ["open", "closed"], initial: "open", transitions: { close: { label: "Close", from: ["open"], to: "closed", roles: ["admin"], agent: "allowed" } } } };
    m.ops!.scratchCreate = { kind: "create", collection: "scratch", label: "Create scratch", roles: ["admin"], agent: "allowed", fields: ["title"] };
  });
  const next = structuredClone(h.m); next.version = "1.1.0";
  next.collections.standalone.indexes.byTitle = ["title"];
  delete next.collections.scratch;
  delete next.ops!.scratchCreate;
  await h.call("storeModule", { moduleId: ID, source: { ...h.pkg.source, sha: "f".repeat(40) }, version: next.version, manifest: JSON.stringify(next), manifestHash: "backfill", approveReads: true, drop: ["scratch"] });
  await h.call("upgradeStep", { orgId: "org", moduleId: ID, epoch: 2 });
  const pub = structuredClone(h.publication()!);
  assert.equal(pub.state, "lifecycle");
  const original = h.db.rows("moduleActivityEvidence").find((row) => row.kind === "row" && row.key === "one")!;
  const originalBytes = h.db.rows("moduleActivityChunks").find((row) => row.ownerId === original._id && row.side === "before")!.bytes as ArrayBuffer;
  assert.equal(JSON.parse(new TextDecoder().decode(originalBytes)).activity.subject, "one");
  const unchangedRefusal = async (invoke: () => Promise<unknown>) => {
    const before = h.db.checkpoint();
    await assert.rejects(invoke());
    assert.deepEqual(h.db.checkpoint(), before);
  };
  await unchangedRefusal(() => h.call("op", { module: ID, op: "scratchCreate", data: { title: "Forbidden by removed collection" } }));
  await unchangedRefusal(() => h.call("op", { module: ID, op: "update", key: "one", expect: 99, data: { title: "Stale" } }));
  await unchangedRefusal(() => h.call("op", { module: ID, op: "update", key: "one", expect: 1, data: { title: 42 } }));
  await h.db.patch("admin", { role: "rep" });
  await unchangedRefusal(() => h.call("op", { module: ID, op: "update", key: "one", expect: 1, data: { title: "Unauthorized" } }));
  await h.db.patch("admin", { role: "admin" });
  const valid = h.db.checkpoint();
  const pending = structuredClone(h.db.rows("modulePackages")[0].pending as Record<string, unknown>);
  const badPending = [{ ...pending, work: [{ collection: "standalone", mode: "migrate", call: "migration" }] }, { ...pending, phase: "cutover" }, { ...pending, error: "Stopped" }];
  for (const changed of badPending) {
    await h.db.patch("pkg", { pending: changed });
    await unchangedRefusal(() => h.call("op", { module: ID, op: "update", key: "one", expect: 1, data: { title: "Must refuse" } }));
    h.db.rollback(valid);
  }
  for (const patch of [{ state: "ready" }, { state: "publishing" }, { state: "failed" }, { state: "complete" }, { lifecycleEpoch: 99 }, { packageId: "another-package" }]) {
    await h.db.patch(String(pub._id), patch);
    await unchangedRefusal(() => h.call("op", { module: ID, op: "update", key: "one", expect: 1, data: { title: "Must refuse" } }));
    h.db.rollback(valid);
  }
  for (const patch of [{ activityPublication: "stale-pin" }, { epoch: 99 }, { manifestHash: "stale-serving-manifest" }]) {
    const bound = await h.scope(); assert.ok(bound);
    await h.db.patch("pkg", patch);
    await unchangedRefusal(() => bound.op("update", { key: "one", expect: 1, data: { title: "Stale binding" } }));
    h.db.rollback(valid);
  }
  await h.call("op", { module: ID, op: "update", key: "one", expect: 1, data: { title: "A" } });
  await h.edit([{ op: "put", collection: "standalone", key: "C", data: { title: "C", deal: "d2", people: ["con_1"] } }]);
  await h.call("transition", { module: ID, machine: "state", name: "close", key: "C", expect: 1 });
  assert.equal(h.publication()!._id, pub._id);
  assert.equal(h.publication()!.state, "lifecycle");
  assert.deepEqual(h.publication()!.work, pub.work);
  assert.ok(Number(h.publication()!.revision) > Number(pub.revision));
  assert.equal(h.db.rows("moduleActivityEvidence").find((row) => row.kind === "row" && row.key === "one")!._id, original._id);
  assert.equal(h.db.rows("moduleActivityEvidence").find((row) => row.kind === "row" && row.key === "C")!.initial, "absent");
  assert.equal(await h.call("next", { orgId: "org" }, "moduleActivityPublications.ts"), null);
  assert.equal(h.head().readableSeq, 0);
  await h.call("upgradeStep", { orgId: "org", moduleId: ID, epoch: 2 });
  await h.drain();
  const changes = h.changes();
  assert.equal(changes.length, 2);
  const edited = changes.find((change) => change.before?.sourceIdentity.key === "one")!;
  assert.equal(edited.before.activity.subject, "one");
  assert.equal(edited.after.activity.subject, "A");
  const created = changes.find((change) => change.after?.sourceIdentity.key === "C")!;
  assert.equal(created.before, null);
  assert.equal(created.after.activity.subject, "C");
  assert.equal(created.after.activity.status, "closed");
  assert.deepEqual(created.after.refs, [{ object: "contact", id: "con_1" }, { object: "deal", id: "d2" }]);
  assert.equal(h.head().committedOrdinal, h.head().publishedOrdinal);
  assert.equal(h.head().pending, false);
  assert.equal(h.db.rows("modulePackages")[0].activityPublication, undefined);
});

test("cutover spans registered batches and stopped segments publish actual changes before cancellation and reinstall", async () => {
  const m = manifest();
  const pending = { version: "2.0.0", source: { kind: "canon", id: "activity-producer", ref: "2.0.0", sha: "b".repeat(40) }, manifest: JSON.stringify({ ...m, version: "2.0.0" }), manifestHash: "next", epoch: 2, slots: {}, work: ["standalone", "items"].map((collection) => ({ collection, mode: "migrate", call: "migrate" })), phase: "cutover", staged: ["standalone", "items"], step: 0, done: 2, at: 1 };
  const rows = [doc("roots", "root", { gens: { items: 1 } }), doc("standalone", "one", { next: { epoch: 2, data: { title: "Migrated one", deal: "d2" } } }), doc("items", "child", { parentKey: "root", gen: 1, next: { epoch: 2, data: { title: "Migrated child", deal: "d2" } } })];
  const completed = fixture(structuredClone(rows), structuredClone(pending));
  await completed.call("upgradeStep", { orgId: "org", moduleId: ID, epoch: 2 });
  assert.equal(completed.publication()!.state, "lifecycle");
  assert.equal(await completed.call("next", { orgId: "org" }, "moduleActivityPublications.ts"), null);
  await completed.call("upgradeStep", { orgId: "org", moduleId: ID, epoch: 2 });
  assert.equal(completed.db.rows("modulePackages")[0].pending, undefined);
  await completed.drain();
  assert.equal(completed.changes().length, 2);
  assert.deepEqual(completed.changes().map((c) => c.before.activity.subject).sort(), ["child", "one"]);
  assert.equal(completed.db.rows("moduleActivityDescriptors").find((d) => d._id === completed.db.rows("moduleActivityPublications")[0].afterDescriptor)!.epoch, 2);

  const h = fixture(structuredClone(rows), structuredClone(pending));
  await h.call("upgradeStep", { orgId: "org", moduleId: ID, epoch: 2 });
  const state = h.db.rows("modulePackages")[0].pending as { step: number; cursor?: string };
  await h.call("migrationApply", { orgId: "org", moduleId: ID, epoch: 2, step: state.step, cursor: state.cursor ?? null, keys: [], results: null, error: "Stop after committed cutover batch" });
  assert.equal(h.publication()!.state, "ready");
  await h.drain();
  assert.equal(h.changes().length, 1);
  assert.equal(h.changes()[0].after.activity.subject, "Migrated one");
  await h.call("cancelUpgrade", { moduleId: ID });
  await h.drain();
  assert.equal(h.changes().length, 1);
  await h.call("setEnabled", { moduleId: ID, enabled: false });
  await h.drain();
  assert.equal(h.changes().filter((c) => c.after === null).length, 2);
  await h.call("uninstall", { moduleId: ID });
  await h.drain();
  assert.equal(h.changes().filter((c) => c.after === null).length, 2);
  const next = { ...m, version: "2.0.0" };
  await h.call("storeModule", { moduleId: ID, source: pending.source, version: next.version, manifest: JSON.stringify(next), manifestHash: "reinstall", approveReads: true });
  await h.drain();
  await h.call("setEnabled", { moduleId: ID, enabled: true });
  await h.drain();
  assert.equal(h.changes().filter((c) => c.before === null).length, 2);
  assert.equal(h.head().committedOrdinal, h.head().publishedOrdinal);
});

test("inactive adoption preserves disabled legacy origin while new and retyped activity watches snapshot stable heads", async () => {
  const h = fixture([], undefined, false);
  for (let shard = 0; shard < 16; shard++) await h.db.insert("moduleCursors", { orgId: "org", moduleId: ID, watch: "watch", shard, seq: 12 });
  await h.db.insert("moduleActivityHeads", { orgId: "org", version: 1, committedOrdinal: 9, publishedOrdinal: 7, appendedSeq: 40, readableSeq: 30, pending: true });
  await h.call("adopt", {}, "moduleActivityPublications.ts");
  const baseline = h.db.rows("moduleActivityCursors")[0];
  assert.equal(baseline.seq, 0);
  assert.equal(baseline.ordinal, 0);
  await h.call("adopt", {}, "moduleActivityPublications.ts");
  assert.equal(h.db.rows("moduleActivityCursors").length, 1);
  assert.equal(h.db.rows("moduleCursors").filter((c) => c.watch === "watch").length, 16);
  const previous = structuredClone(h.m);
  previous.calls!.newWatch = { ...previous.calls!.watch };
  previous.reads = { ...previous.reads, companies: ["name"] };
  previous.watches = [...previous.watches!, { object: "companies", call: "newWatch", fields: ["name"] }];
  await h.db.patch("pkg", { manifest: JSON.stringify(previous), manifestHash: "company-watch" });
  for (let shard = 0; shard < 16; shard++) await h.db.insert("moduleCursors", { orgId: "org", moduleId: ID, watch: "newWatch", shard, seq: 12 });
  const next = structuredClone(previous); next.version = "1.0.1";
  next.calls!.brandNew = { ...next.calls!.watch };
  next.watches = [{ object: "activities", call: "watch", fields: ["kind", "dealId"] }, { object: "activities", call: "newWatch", fields: ["dealId"] }, { object: "activities", call: "brandNew", fields: ["dealId"] }];
  await h.call("storeModule", { moduleId: ID, source: { ...h.pkg.source, sha: "c".repeat(40) }, version: next.version, manifest: JSON.stringify(next), manifestHash: "new-watch", approveReads: true });
  const added = h.db.rows("moduleActivityCursors").find((c) => c.watch === "newWatch")!;
  assert.equal(added.seq, 30);
  assert.equal(added.ordinal, 7);
  assert.equal(h.db.rows("moduleActivityCursors").find((c) => c.watch === "brandNew")!.seq, 30);
  assert.equal(h.db.rows("moduleActivityCursors").find((c) => c.watch === "watch")!.seq, 0);
});

test("an unwired registered writer refuses before its physical callback", async () => {
  const h = fixture(undefined, undefined, true, "missing");
  const before = h.db.checkpoint();
  await assert.rejects(h.call("op", { module: ID, op: "update", key: "one", expect: 1, data: { title: "Cannot bypass the session" } }));
  assert.deepEqual(h.db.checkpoint(), before);
});

test("adoption leaves a never-enabled watch unsubscribed until its first stable-head snapshot", async () => {
  const h = fixture([], undefined, false);
  await h.db.insert("moduleActivityHeads", { orgId: "org", version: 1, committedOrdinal: 2, publishedOrdinal: 1, appendedSeq: 8, readableSeq: 5, pending: true });
  await h.call("adopt", {}, "moduleActivityPublications.ts");
  assert.equal(h.db.rows("moduleActivityCursors").length, 0);
  assert.equal(h.db.rows("moduleCursors").length, 0);
  await h.call("setEnabled", { moduleId: ID, enabled: true });
  assert.equal(h.db.rows("moduleActivityCursors")[0].seq, 5);
  assert.equal(h.db.rows("moduleActivityCursors")[0].ordinal, 1);
  assert.equal(h.db.rows("moduleCursors").filter((c) => c.watch === "watch").length, 16);
});

test("off installation and activation register only activity baselines until the original enable head", async () => {
  const h = fixture([], undefined, false, "normal", (m) => { m.feeds = { events: { feed: "webhook.events", call: "watch", fields: ["type", "data"] } }; });
  await h.db.delete("pkg");
  await h.db.delete("enabled");
  await h.db.insert("ledgerShardHeads", { orgId: "org", shard: 0, seq: 11 });
  await h.call("storeModule", { moduleId: ID, source: h.pkg.source, version: h.m.version, manifest: JSON.stringify(h.m), manifestHash: "installed-off" });
  const baseline = structuredClone(h.db.rows("moduleActivityCursors")[0]);
  assert.ok(baseline);
  assert.equal(h.db.rows("moduleCursors").length, 0);
  await h.drain();
  await h.db.patch(String(h.db.rows("ledgerShardHeads")[0]._id), { seq: 22 });
  const next = { ...h.m, version: "1.0.1" };
  await h.call("storeModule", { moduleId: ID, source: { ...h.pkg.source, sha: "c".repeat(40) }, version: next.version, manifest: JSON.stringify(next), manifestHash: "upgraded-off" });
  assert.equal(h.db.rows("moduleCursors").length, 0);
  assert.equal(h.db.rows("moduleActivityCursors")[0].seq, baseline.seq);
  assert.equal(h.db.rows("moduleActivityCursors")[0].ordinal, baseline.ordinal);
  await h.drain();
  await h.db.patch(String(h.db.rows("ledgerShardHeads")[0]._id), { seq: 33 });
  await h.call("setEnabled", { moduleId: ID, enabled: true });
  const cursors = h.db.rows("moduleCursors");
  assert.equal(cursors.filter((row) => row.watch === "watch").length, 16);
  assert.equal(cursors.find((row) => row.watch === "watch" && row.shard === 0)!.seq, 33);
  assert.equal(cursors.filter((row) => row.watch !== "watch").length, 2, "connector position and backfill start only at enable");
  assert.equal(h.db.rows("moduleActivityCursors")[0].seq, baseline.seq);
  assert.equal(h.db.rows("moduleActivityCursors")[0].ordinal, baseline.ordinal);
  await h.drain();
  await h.call("setEnabled", { moduleId: ID, enabled: false });
  await h.drain();
  await h.db.patch(String(h.db.rows("ledgerShardHeads")[0]._id), { seq: 44 });
  await h.call("setEnabled", { moduleId: ID, enabled: true });
  assert.equal(h.db.rows("moduleCursors").find((row) => row.watch === "watch" && row.shard === 0)!.seq, 33);
  assert.equal(h.db.rows("moduleActivityCursors")[0].seq, baseline.seq);
});

test("initial and later import batches wait for real publication without terminalizing progress", async () => {
  const h = fixture([], undefined, false, "normal", (m) => { m.imports = ["probe.legacy"]; });
  await h.db.delete("pkg");
  const install = () => h.call("storeModule", { moduleId: ID, source: h.pkg.source, version: h.m.version, manifest: JSON.stringify(h.m), manifestHash: "import-install" });
  await install();
  const args = { orgId: "org", moduleId: ID, name: "probe.legacy", cursor: null };
  const state = () => structuredClone(h.db.rows("modulePackages")[0].imports as Record<string, unknown>);
  const initial = state();
  const firstPublication = h.publication()!._id;
  const packageId = h.db.rows("modulePackages")[0]._id;
  assert.deepEqual(await h.call("importBatch", args), { status: "waiting", publicationId: firstPublication });
  await h.call("importStep", args);
  assert.equal(h.importCalls(), 0);
  assert.deepEqual(state(), initial);
  await h.drain();
  assert.ok(h.scheduled.some((task) => task.ref.endsWith("modules.resumeImports") && task.args.publicationId === firstPublication));
  const queuedFirst = h.scheduled.filter((task) => task.ref.endsWith("modules.importStep")).length;
  await h.call("resumeImports", { packageId, publicationId: firstPublication });
  assert.equal(h.scheduled.filter((task) => task.ref.endsWith("modules.importStep")).length, queuedFirst + 1, "completion wakes the actual installed package's current cursor");
  await h.call("importStep", args);
  assert.equal(h.importCalls(), 1);
  const afterFirst = state();
  assert.deepEqual(afterFirst, { "probe.legacy": { cursor: "next", done: false } });
  await h.call("importStep", { ...args, cursor: "next" });
  assert.equal(h.importCalls(), 1);
  assert.deepEqual(state(), afterFirst);
  const nextPublication = h.publication()!._id;
  await h.drain();
  const queuedNext = h.scheduled.filter((task) => task.ref.endsWith("modules.importStep") && task.args.cursor === "next").length;
  await h.call("resumeImports", { packageId, publicationId: nextPublication });
  assert.equal(h.scheduled.filter((task) => task.ref.endsWith("modules.importStep") && task.args.cursor === "next").length, queuedNext + 1);
  await h.call("importStep", { ...args, cursor: "next" });
  await h.drain();
  assert.deepEqual(state(), { "probe.legacy": { cursor: null, done: true } });
  assert.deepEqual(h.db.rows("moduleDocs").map((row) => row.key).sort(), ["import-first", "import-next"]);
  assert.equal(h.db.rows("recipeEnablements")[0].enabled, false, "imports retain the existing include-disabled policy");
  await h.call("importStep", args);
  assert.equal(h.importCalls(), 2);

  const bad = fixture([], undefined, false, "normal", (m) => { m.imports = ["probe.legacy"]; m.collections.standalone.schema.value.required = field("string"); });
  await bad.db.delete("pkg");
  await bad.call("storeModule", { moduleId: ID, source: bad.pkg.source, version: bad.m.version, manifest: JSON.stringify(bad.m), manifestHash: "bad-import" });
  const publicationId = bad.publication()!._id;
  await bad.drain();
  const badPackageId = bad.db.rows("modulePackages")[0]._id;
  await bad.call("resumeImports", { packageId: badPackageId, publicationId });
  await bad.call("importStep", args);
  const failed = structuredClone(bad.db.rows("modulePackages")[0].imports);
  assert.ok((failed as Record<string, { error: string }>)["probe.legacy"].error);
  assert.equal(bad.db.rows("moduleDocs").length, 0);
  await bad.call("resumeImports", { packageId: badPackageId, publicationId });
  await bad.call("importStep", args);
  assert.equal(bad.importCalls(), 1);
  assert.deepEqual(structuredClone(bad.db.rows("modulePackages")[0].imports), failed);
});

test("leased jobs wait at stage and apply pins without consuming attempts and retain self-dirty success", async () => {
  const h = fixture([doc("roots", "root", { gens: { items: 1 } }), doc("items", "live", { parentKey: "root", gen: 1 }), doc("standalone", "one")], undefined, true, "normal", (m) => { m.calls!.edit.system = true; m.jobs = { edit: { label: "Edit", key: ["record"], call: "edit" } }; });
  const sys = { orgId: "org", moduleId: ID };
  await h.call("feedApply", { ...sys, watch: "watch", epoch: 1, from: {}, to: {}, dirty: ["first", "stage", "apply", "error"].map((key) => ({ job: "edit", key })) }, "moduleJobs.ts");
  const grant = await h.call("lease", sys, "moduleJobs.ts");
  const keys = grant.batches.flat();
  const input = (key: string) => { const leased = keys.find((k: { key: string }) => k.key === key)!; return { ...sys, job: "edit", key, seq: leased.seq, lease: leased.lease, source: grant.source, epoch: grant.epoch, call: "edit", admit: [] }; };
  const staged = await h.call("stageKey", { ...input("stage"), collection: "items", parentKey: "root", gen: 10, offset: 0, docs: [{ title: "Own staged row" }] }, "moduleJobs.ts");
  assert.equal(staged.status, "staged");
  assert.equal(staged.count, 1);
  const first = await h.call("applyKey", { ...input("first"), intents: [{ op: "patch", collection: "standalone", key: "one", data: { title: "First committed" } }, { op: "dirty", job: "edit", key: "first" }] }, "moduleJobs.ts");
  assert.equal(first.status, "applied");
  const own = h.db.rows("moduleJobs").find((row) => row.key === "first")!;
  assert.ok(Number(own.dirtySeq) > input("first").seq);
  assert.equal(own.leaseSeq, undefined);
  assert.equal(own.leaseUntil, undefined);
  const publication = h.publication()!;
  const stage = await h.call("stageKey", { ...input("stage"), collection: "items", parentKey: "root", gen: 10, offset: 0, docs: [{ title: "Do not stage" }] }, "moduleJobs.ts");
  const apply = await h.call("applyKey", { ...input("apply"), intents: [{ op: "patch", collection: "standalone", key: "one", data: { title: "Do not apply" } }] }, "moduleJobs.ts");
  assert.deepEqual([stage.status, apply.status], ["waiting", "waiting"]);
  assert.deepEqual(stage.wait, apply.wait);
  assert.equal(stage.wait.publicationId, publication._id);
  for (const key of ["stage", "apply"]) {
    const row = h.db.rows("moduleJobs").find((row) => row.key === key)!;
    assert.equal(row.dirtySeq, input(key).seq);
    assert.equal(row.attempts, 0);
    assert.equal(row.leaseSeq, undefined);
  }
  assert.deepEqual(h.db.rows("moduleDocs").filter((row) => row.collection === "standalone").map((row) => (row.data as Record<string, unknown>).title), ["First committed"]);
  assert.deepEqual(structuredClone((await (await h.scope())!.activityDocs("items", 1000)).docs.map((row) => row.key)), ["live"]);
  const retained = h.db.checkpoint();
  const cleanup = { module: ID, call: "edit", epoch: 1, collection: "items", parentKey: "root", gen: 10 };
  await assert.rejects(h.call("dropGeneration", cleanup));
  assert.deepEqual(h.db.checkpoint(), retained, "the checked cleanup cannot remove pinned OLD, live or staged rows");
  await h.call("failed", { ...input("error"), error: "Actual runtime failure, not a pin refusal" }, "moduleJobs.ts");
  assert.equal(h.db.rows("moduleJobs").find((row) => row.key === "error")!.attempts, 1, "a pin's presence cannot suppress a genuine failure");
  const whilePinned = await h.call("lease", sys, "moduleJobs.ts");
  assert.equal(whilePinned.batches.length, 0);
  await h.drain();
  assert.equal(h.db.rows("moduleDocs").filter((row) => row.collection === "items" && row.gen === 10).length, 1, "publication completion does not promise automatic staged cleanup");
  await h.call("dropGeneration", cleanup);
  assert.deepEqual(h.db.rows("moduleDocs").filter((row) => row.collection === "items").map((row) => row.key), ["live"], "explicit checked cleanup removes only the known own unreferenced generation");
  assert.ok(h.scheduled.some((task) => task.ref.endsWith("moduleJobs.run") && task.args.moduleId === ID));
  const after = await h.call("lease", sys, "moduleJobs.ts");
  assert.deepEqual(after.batches.flat().map((row: { key: string }) => row.key).sort(), ["apply", "first", "stage"]);
  const retry = after.batches.flat().find((row: { key: string }) => row.key === "first");
  assert.equal(retry.lease.generation, input("first").lease.generation + 1);
  const beforeFailedOwnDirty = h.db.checkpoint(), queued = h.scheduled.length;
  await assert.rejects(h.call("applyKey", { ...input("first"), seq: retry.seq, source: after.source, lease: retry.lease, intents: [{ op: "dirty", job: "edit", key: "first" }, { op: "patch", collection: "standalone", key: "missing", data: { title: "Refused after invalidation" } }] }, "moduleJobs.ts"));
  assert.deepEqual(h.db.checkpoint(), beforeFailedOwnDirty, "failed business apply restores its own dirty and lease invalidation");
  assert.equal(h.scheduled.length, queued);
  const completed = await h.call("applyKey", { ...input("apply"), source: after.source, lease: after.batches.flat().find((row: { key: string }) => row.key === "apply").lease, intents: [] }, "moduleJobs.ts");
  assert.equal(completed.status, "applied", "completion before this attempt leaves no lost wake or saved output retry");
});

test("stale, renewed, recreated, expired and superseded job witnesses cannot mutate another lease", async () => {
  const h = fixture(undefined, undefined, true, "normal", (m) => { m.calls!.edit.system = true; m.jobs = { edit: { label: "Edit", key: ["record"], call: "edit" } }; });
  const sys = { orgId: "org", moduleId: ID };
  await h.call("feedApply", { ...sys, watch: "watch", epoch: 1, from: {}, to: {}, dirty: [{ job: "edit", key: "one" }] }, "moduleJobs.ts");
  const grant = await h.call("lease", sys, "moduleJobs.ts"), key = grant.batches[0][0];
  const input = { ...sys, job: "edit", key: "one", seq: key.seq, lease: key.lease, source: grant.source, epoch: grant.epoch, call: "edit", admit: [] };
  const original = h.db.checkpoint();
  const refuses = async (args = input) => {
    const before = h.db.checkpoint();
    const apply = await h.call("applyKey", { ...args, intents: [{ op: "patch", collection: "standalone", key: "one", data: { title: "Must not apply" } }] }, "moduleJobs.ts");
    assert.equal(apply.status, "stale");
    const stage = await h.call("stageKey", { ...args, collection: "items", parentKey: "root", gen: 10, offset: 0, docs: [{ title: "Must not stage" }] }, "moduleJobs.ts");
    assert.equal(stage.status, "stale");
    await h.call("failed", { ...args, error: "Stale caller cannot consume attempts" }, "moduleJobs.ts");
    assert.equal(await h.call("finishEmpty", { ...sys, job: "edit", epoch: args.epoch, source: args.source, keys: [{ key: "one", seq: args.seq, lease: args.lease }] }, "moduleJobs.ts"), 0);
    assert.deepEqual(h.db.checkpoint(), before);
  };
  await h.db.patch(key.lease.rowId, { leaseGeneration: key.lease.generation + 1 });
  await refuses();
  h.db.rollback(original);
  await h.db.patch(key.lease.rowId, { dirtySeq: key.seq + 1 });
  await refuses();
  h.db.rollback(original);
  const row = structuredClone(h.db.rows("moduleJobs")[0]);
  await h.db.delete(key.lease.rowId);
  await h.db.insert("moduleJobs", { ...row, _id: "recreated-job" });
  await refuses();
  h.db.rollback(original);
  await h.db.patch(key.lease.rowId, { leaseUntil: 0 });
  await refuses({ ...input, lease: { ...key.lease, leaseUntil: 0 } });
  h.db.rollback(original);
  await h.db.patch("enabled", { enabled: false });
  await refuses();
  h.db.rollback(original);
  await h.db.patch("pkg", { epoch: 2, manifestHash: "new-epoch" });
  await refuses();
  h.db.rollback(original);
  await h.db.patch(key.lease.rowId, { leaseGeneration: Number.MAX_SAFE_INTEGER, leaseUntil: undefined, leaseSeq: undefined });
  const beforeOverflow = h.db.checkpoint();
  await assert.rejects(h.call("lease", sys, "moduleJobs.ts"));
  assert.deepEqual(h.db.checkpoint(), beforeOverflow);
});

test("durable schedule slots survive pin waits and consume genuine failures only once", async () => {
  const clock = { now: Date.UTC(2026, 9, 23, 12) };
  const h = fixture(undefined, undefined, true, "normal", (m) => { m.calls!.edit.system = true; m.schedules = { hourly: { label: "Hourly", call: "edit", everyMinutes: 60 } }; }, clock, { RECIPE_RUNTIME_URL: "https://runtime.test", RECIPE_RUNTIME_SECRET: "test-runtime-secret" });
  const sys = { orgId: "org", moduleId: ID };
  const slot = () => structuredClone(h.db.rows("moduleJobs").find((row) => row.job === "#schedule:hourly")!);
  const grant = async () => {
    const g = await h.call("lease", sys, "moduleJobs.ts"), key = g.batches.flat().find((row: { job: string }) => row.job === "#schedule:hourly");
    return key ? { ...sys, job: key.job, key: key.key, seq: key.seq, lease: key.lease, source: g.source, epoch: g.epoch, call: "edit", admit: [] } : null;
  };
  await h.call("sweep", {}, "moduleJobs.ts");
  const first = await grant();
  assert.ok(first);
  const registered = structuredClone(slot());
  await h.call("sweep", {}, "moduleJobs.ts");
  assert.deepEqual(slot(), registered, "a second dispatch cannot overwrite the same leased occurrence");
  await h.call("op", { module: ID, op: "update", key: "one", expect: 1, data: { title: "Pin before schedule apply" } });
  const waiting = await h.call("applyKey", { ...first, intents: [{ op: "patch", collection: "standalone", key: "one", data: { title: "Scheduled" } }] }, "moduleJobs.ts");
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(slot().payload, registered.payload);
  assert.equal(slot().attempts, 0);
  assert.equal(slot().dirtySeq, registered.dirtySeq);
  assert.equal((await h.call("installed")).modules[0].jobs.schedules[0].state, "waiting");
  clock.now += 2 * 60 * 60_000;
  await h.call("sweep", {}, "moduleJobs.ts");
  assert.deepEqual(slot().payload, registered.payload, "missed periods cannot replace a waiting occurrence");
  assert.equal(await grant(), null);
  await h.drain();
  const resumed = await grant();
  assert.ok(resumed);
  const result = await h.call("applyKey", { ...resumed, intents: [{ op: "patch", collection: "standalone", key: "one", data: { title: "Scheduled" } }] }, "moduleJobs.ts");
  assert.equal(result.status, "applied");
  assert.equal(h.db.rows("moduleJobs").filter((row) => row.job === "#schedule:hourly").length, 0);
  const duplicate = await h.call("applyKey", { ...resumed, intents: [{ op: "patch", collection: "standalone", key: "one", data: { title: "Duplicate" } }] }, "moduleJobs.ts");
  assert.equal(duplicate.status, "stale");
  assert.equal((h.db.rows("moduleDocs")[0].data as Record<string, unknown>).title, "Scheduled");
  await h.drain();
  await h.call("sweep", {}, "moduleJobs.ts");
  const next = await grant();
  assert.ok(next);
  await h.call("failed", { ...next, error: "Genuine schedule runtime failure" }, "moduleJobs.ts");
  const failed = structuredClone(slot());
  assert.equal(failed.attempts, 1);
  assert.equal(failed.leaseSeq, undefined);
  assert.equal((await h.call("installed")).modules[0].jobs.schedules[0].state, "failed");
  await h.call("sweep", {}, "moduleJobs.ts");
  assert.deepEqual(slot(), failed);
  assert.equal(await grant(), null, "the failed occurrence must not retry its semantics");
  clock.now += 60 * 60_000;
  await h.call("sweep", {}, "moduleJobs.ts");
  assert.equal(slot().attempts, 0);
  assert.notDeepEqual(slot().payload, failed.payload);
  const current = await grant();
  assert.ok(current);
  const beforeOff = h.db.checkpoint();
  await h.db.patch("enabled", { enabled: false });
  assert.equal((await h.call("applyKey", { ...current, intents: [] }, "moduleJobs.ts")).status, "stale");
  h.db.rollback(beforeOff);
  const changed = structuredClone(h.m);
  changed.schedules!.hourly.call = "watch";
  await h.db.patch("pkg", { manifest: JSON.stringify(changed), manifestHash: "schedule-changed" });
  assert.equal((await h.call("applyKey", { ...current, intents: [] }, "moduleJobs.ts")).status, "stale");
  delete changed.schedules!.hourly;
  await h.db.patch("pkg", { manifest: JSON.stringify(changed), manifestHash: "schedule-removed" });
  assert.equal((await h.call("stageKey", { ...current, collection: "items", parentKey: "root", gen: 10, offset: 0, docs: [] }, "moduleJobs.ts")).status, "stale");
  assert.deepEqual(slot().leaseGeneration, current.lease.generation);
});

test("declaration-free doc writes preserve ready, publishing and failed markers until later activity activation", async () => {
  const h = fixture(undefined, undefined, true, "normal", (m) => { for (const c of Object.values(m.collections)) delete c.activity; });
  const install = (m: ModuleManifest, hash: string) => h.call("storeModule", { moduleId: ID, source: { ...h.pkg.source, sha: (m.version === "1.0.1" ? "b" : "c").repeat(40) }, version: m.version, manifest: JSON.stringify(m), manifestHash: hash, approveReads: true });
  const next = structuredClone(h.m);
  next.version = "1.0.1";
  await install(next, "empty-upgrade");
  const marker = h.publication()!;
  assert.equal(marker.state, "ready");
  const write = async (title: string) => {
    const retained = structuredClone(h.publication());
    await h.edit([{ op: "patch", collection: "standalone", key: "one", data: { title } }]);
    assert.deepEqual(structuredClone(h.publication()), retained, "ordinary absence proof does not join or advance the marker");
    assert.equal((h.db.rows("moduleDocs")[0].data as Record<string, unknown>).title, title);
  };
  const ready = h.db.checkpoint();
  await h.db.patch(String(marker._id), { state: "lifecycle" });
  const lifecycle = h.db.checkpoint();
  await assert.rejects(h.edit([{ op: "patch", collection: "standalone", key: "one", data: { title: "Lifecycle remains blocked" } }]));
  assert.deepEqual(h.db.checkpoint(), lifecycle);
  h.db.rollback(ready);
  await write("Ready completion");
  const at = await h.call("next", { orgId: "org" }, "moduleActivityPublications.ts");
  await h.call("step", at, "moduleActivityPublications.ts");
  assert.equal(h.publication()!.state, "publishing");
  await write("Publishing completion");
  const current = await h.call("next", { orgId: "org" }, "moduleActivityPublications.ts");
  await h.call("failed", { ...current, error: "Fixture publication pause" }, "moduleActivityPublications.ts");
  assert.equal(h.publication()!.state, "failed");
  await write("Failed marker completion");
  const checkpoint = h.db.checkpoint();
  const header = h.db.rows("moduleActivityDescriptors").find((row) => row._id === marker.beforeDescriptor)!;
  await h.db.patch(String(header._id), { digest: "0".repeat(64) });
  const malformed = h.db.checkpoint();
  await assert.rejects(h.edit([{ op: "patch", collection: "standalone", key: "one", data: { title: "Refuse bad digest" } }]));
  assert.deepEqual(h.db.checkpoint(), malformed);
  h.db.rollback(checkpoint);
  const metadata = h.db.checkpoint();
  await assert.rejects(h.call("setEnabled", { moduleId: ID, enabled: false }));
  assert.deepEqual(h.db.checkpoint(), metadata, "declaration absence grants no metadata write");
  await h.db.patch(String(marker._id), { retryAt: 0 });
  await h.drain();
  assert.deepEqual(h.changes(), []);
  next.version = "1.0.2";
  next.collections.standalone.activity = manifest().collections.standalone.activity;
  await install(next, "activity-activation");
  await assert.rejects(h.edit([{ op: "patch", collection: "standalone", key: "one", data: { title: "Cannot bypass activity" } }]));
  await h.drain();
  assert.deepEqual(h.changes().map((change) => [change.before, change.after.activity.subject]), [[null, "Failed marker completion"]]);
  assert.equal(h.head().pending, false);
});

test("OLD activity, package-wide activity and invalid descriptor bindings cannot use the activity-free write path", async () => {
  const h = fixture(undefined, undefined, false);
  const next = structuredClone(h.m);
  for (const c of Object.values(next.collections)) delete c.activity;
  next.version = "1.0.1";
  await h.call("storeModule", { moduleId: ID, source: { ...h.pkg.source, sha: "b".repeat(40) }, version: next.version, manifest: JSON.stringify(next), manifestHash: "removed-activity", approveReads: true });
  await h.db.patch("enabled", { enabled: true });
  const retained = h.db.checkpoint();
  await assert.rejects(h.edit([{ op: "patch", collection: "standalone", key: "one", data: { title: "OLD activity is still retained" } }]));
  assert.deepEqual(h.db.checkpoint(), retained, "disabled OLD activity declarations are not absence");
  await h.drain();
  next.version = "1.0.2";
  next.collections.items.activity = manifest().collections.items.activity;
  await h.call("storeModule", { moduleId: ID, source: { ...h.pkg.source, sha: "c".repeat(40) }, version: next.version, manifest: JSON.stringify(next), manifestHash: "parented-activity", approveReads: true });
  const packageWide = h.db.checkpoint();
  await assert.rejects(h.edit([{ op: "patch", collection: "standalone", key: "one", data: { title: "Other collection is empty but declared" } }]));
  assert.deepEqual(h.db.checkpoint(), packageWide);
  await h.drain();
  delete next.collections.items.activity;
  next.collections.roots.activity = { kind: "visit", subject: "title", targets: {}, path: "items/:key" };
  next.version = "1.0.3";
  await h.call("storeModule", { moduleId: ID, source: { ...h.pkg.source, sha: "d".repeat(40) }, version: next.version, manifest: JSON.stringify(next), manifestHash: "parent-only-activity", approveReads: true });
  const parentOnly = h.db.checkpoint();
  await assert.rejects(h.edit([{ op: "patch", collection: "standalone", key: "one", data: { title: "Parent-only activity is not absence" } }]));
  assert.deepEqual(h.db.checkpoint(), parentOnly);
});

test("UTF-8 index merging keeps retired Unicode keys and target-array reorder emits no false change", async () => {
  const h = fixture([doc("roots", "root", { gens: { items: 1 } }), doc("items", "\ue000", { parentKey: "root", gen: 1 }), doc("items", "😀", { parentKey: "root", gen: 1 }), doc("standalone", "one")]);
  await h.edit([{ op: "patch", collection: "standalone", key: "one", data: { people: ["con_2", "con_1"] } }, { op: "delete", collection: "items", key: "😀" }, { op: "replaceSet", collection: "items", parentKey: "root", gen: 2, count: 0 }]);
  let interrupted = false;
  for (let i = 0; i < 100; i++) {
    const at = await h.call("next", { orgId: "org" }, "moduleActivityPublications.ts");
    assert.ok(at);
    const work = structuredClone(h.publication()!.work as { evidenceCursor: string | null });
    const position = work.evidenceCursor && JSON.parse(work.evidenceCursor);
    if (position?.kind === "range" && position.last !== null) {
      await h.call("failed", { ...at, error: "Fixture range interruption" }, "moduleActivityPublications.ts");
      assert.deepEqual(structuredClone(h.publication()!.work), work);
      assert.equal(h.head().readableSeq, 0);
      assert.equal(h.db.rows("modulePackages")[0].activityPublication, at.id);
      assert.equal(await h.call("next", { orgId: "org" }, "moduleActivityPublications.ts"), null);
      await h.call("step", at, "moduleActivityPublications.ts");
      assert.deepEqual(structuredClone(h.publication()!.work), work);
      await h.db.patch(String(at.id), { retryAt: 0 });
      interrupted = true;
      break;
    }
    await h.call("step", at, "moduleActivityPublications.ts");
  }
  assert.equal(interrupted, true);
  await h.drain();
  assert.equal(h.changes().length, 2);
  assert.deepEqual(h.changes().map((c) => c.before.sourceIdentity.key).sort(compareValues), ["\ue000", "😀"]);
  assert.equal(h.changes().every((c) => c.after === null), true);
  assert.equal(h.head().pending, false);
  assert.equal(h.db.rows("modulePackages")[0].activityPublication, undefined);
});
