import assert from "node:assert/strict";
import test from "node:test";
import { project, type FoldState, type ProjectedRow } from "../convex/lib/objects/fold.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS, type ResolvedObjectDef } from "../convex/lib/objects/registry.ts";
import { listRowOf } from "../convex/lib/objects/listSpec.ts";
import { createFakeRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";
import { linkedActivities } from "../convex/lib/activities.ts";
import { materialize, save, saveBatch, shardOf, SHARDS, type ObjectStore, type Proposal, type SaveCommand, type SaveContext, type SaveResult, type StoredEntry } from "../convex/lib/objects/write.ts";

/** In-memory ObjectStore with the same semantics as convexObjectStore in convex/objects.ts. */
function memoryStore() {
  let ids = 0;
  const streams = new Map<string, { orgId: string; object: string; label: string }>();
  const externalIds = new Map<string, string>();
  const entries: Array<StoredEntry & { orgId: string }> = [];
  const heads = new Map<string, number>();
  const hotRows = new Map<string, { state: FoldState; row: ProjectedRow }>();
  const proposals = new Map<string, Proposal & { orgId: string }>();
  const store: ObjectStore = {
    async getStream(streamId) {
      return streams.get(streamId) ?? null;
    },
    async getHotRow(streamId) {
      return hotRows.get(streamId)?.state ?? null;
    },
    async readEntries(streamId, afterVersion, limit) {
      return entries.filter((e) => e.streamId === streamId && e.version > afterVersion).sort((a, b) => a.version - b.version).slice(0, limit);
    },
    async createStream(orgId, object, label) {
      const id = `s${++ids}`;
      streams.set(id, { orgId, object, label });
      return id;
    },
    async findByExternalId(orgId, provider, externalId) {
      return externalIds.get(`${orgId}|${provider}|${externalId}`) ?? null;
    },
    async addExternalId(orgId, streamId, provider, externalId) {
      externalIds.set(`${orgId}|${provider}|${externalId}`, streamId);
    },
    async removeExternalId(orgId, streamId, provider, externalId) {
      if (externalIds.get(`${orgId}|${provider}|${externalId}`) === streamId) externalIds.delete(`${orgId}|${provider}|${externalId}`);
    },
    async externalIdsOf(streamId, limit) {
      return [...externalIds].filter(([, holder]) => holder === streamId).slice(0, limit).map(([key]) => {
        const [, provider, externalId] = key.split("|");
        return { provider: provider!, externalId: externalId! };
      });
    },
    async nextSeq(orgId, shard) {
      const seq = (heads.get(`${orgId}|${shard}`) ?? 0) + 1;
      heads.set(`${orgId}|${shard}`, seq);
      return seq;
    },
    async appendEntry(orgId, entry) {
      entries.push({ ...entry, orgId });
    },
    async putHotRow(_orgId, _def, state, row) {
      hotRows.set(state.streamId, { state, row });
    },
    async addProposal(orgId, p) {
      proposals.set(p.factId, { ...p, orgId });
    },
    async removeProposal(_orgId, factId) {
      proposals.delete(factId);
    },
  };
  return { store, streams, externalIds, entries, hotRows, proposals };
}

const ORG = "org1";
const lead = resolveObjectDef(STANDARD_OBJECTS.lead);
const product = resolveObjectDef(STANDARD_OBJECTS.product);
const userCtx = (def: ResolvedObjectDef = lead, now = 1000): SaveContext => ({
  orgId: ORG, def, source: { kind: "user", ref: "user:u1" }, actor: { kind: "user", id: "u1" }, now,
});

function applied(r: SaveResult) {
  if (r.status !== "applied") assert.fail(`expected applied, got ${JSON.stringify(r)}`);
  return r;
}

async function created(m: ReturnType<typeof memoryStore>, values: Record<string, unknown> = { lastName: "Lovelace", company: "Analytical" }) {
  return applied(await save(m.store, userCtx(), { op: "create", values }));
}

const valuesOf = (m: ReturnType<typeof memoryStore>, streamId: string) => m.hotRows.get(streamId)?.row.values;

test("create, edit, delete and restore round trip through one stream", async () => {
  const m = memoryStore();
  const c = await created(m);
  assert.deepEqual({ version: c.version, shard: c.shard, seq: c.seq }, { version: 1, shard: shardOf(c.streamId), seq: 1 });
  assert.equal(valuesOf(m, c.streamId)?.lastName, "Lovelace");

  const edit = await save(m.store, userCtx(lead, 2000), { op: "update", streamId: c.streamId, values: { company: "Babbage & Co", status: "working" }, expectedVersion: 1 });
  assert.deepEqual(edit, { status: "applied", streamId: c.streamId, version: 2, shard: c.shard, seq: 2 });
  assert.equal(valuesOf(m, c.streamId)?.company, "Babbage & Co");
  assert.equal(valuesOf(m, c.streamId)?.status, "working");

  const del = await save(m.store, userCtx(lead, 3000), { op: "delete", streamId: c.streamId });
  assert.equal(del.status, "applied");
  assert.equal(m.hotRows.get(c.streamId)?.row.deletedAt, 3000);
  assert.deepEqual(await save(m.store, userCtx(), { op: "delete", streamId: c.streamId }), { status: "unchanged", streamId: c.streamId, version: 3 });
  const editDeleted = await save(m.store, userCtx(), { op: "update", streamId: c.streamId, values: { company: "X" } });
  assert.deepEqual(editDeleted, { status: "invalid", errors: [{ field: "streamId", message: "Lead is deleted; restore it first" }] });

  const res = await save(m.store, userCtx(lead, 4000), { op: "restore", streamId: c.streamId });
  assert.equal(res.status, "applied");
  assert.equal(m.hotRows.get(c.streamId)?.row.deletedAt, null);
  assert.equal(valuesOf(m, c.streamId)?.company, "Babbage & Co", "restore brings the values back");
  assert.deepEqual(m.entries.map((e) => [e.version, e.body.kind === "lifecycle" ? e.body.op : e.body.kind]), [[1, "assert"], [2, "assert"], [3, "delete"], [4, "restore"]]);
  assert.equal(m.hotRows.get(c.streamId)?.state.createdAt, 1000);
});

test("a stale expectedVersion is a conflict and stores nothing", async () => {
  const m = memoryStore();
  const c = await created(m);
  await save(m.store, userCtx(lead, 2000), { op: "update", streamId: c.streamId, values: { company: "A" } });
  const r = await save(m.store, userCtx(lead, 3000), { op: "update", streamId: c.streamId, values: { company: "B" }, expectedVersion: 1 });
  assert.deepEqual(r, { status: "conflict", streamId: c.streamId, version: 2, expectedVersion: 1 });
  assert.equal(m.entries.length, 2);
  assert.equal(valuesOf(m, c.streamId)?.company, "A");
});

test("saving the values the same user already set appends nothing", async () => {
  const m = memoryStore();
  const c = await created(m);
  const r = await save(m.store, userCtx(lead, 5000), { op: "update", streamId: c.streamId, values: { lastName: "Lovelace", company: "Analytical" } });
  assert.deepEqual(r, { status: "unchanged", streamId: c.streamId, version: 1 });
  assert.equal(m.entries.length, 1);
});

test("an agent-class source lands as a proposal with a queue row, and the row keeps its value", async () => {
  const m = memoryStore();
  const c = await created(m);
  const agent: SaveContext = { ...userCtx(lead, 2000), source: { kind: "enrichment", ref: "enrichment:user:u1" }, evidence: "careers page", confidence: 0.8 };
  const r = await save(m.store, agent, { op: "update", streamId: c.streamId, values: { title: "Countess" } });
  assert.deepEqual(r, { status: "proposed", streamId: c.streamId, version: 2, shard: c.shard, seq: 2 });
  assert.equal(valuesOf(m, c.streamId)?.title, null, "a proposal does not change the row");
  assert.deepEqual([...m.proposals.values()], [{ orgId: ORG, streamId: c.streamId, object: "lead", fieldId: "title", factId: `${c.streamId}@2#0`, observedAt: 2000 }]);

  assert.deepEqual(await save(m.store, agent, { op: "delete", streamId: c.streamId }), { status: "invalid", errors: [{ field: "source", message: "Agent sources may only propose field values" }] });
  assert.equal((await save(m.store, agent, { op: "create", values: { lastName: "Byron" } })).status, "invalid");
  assert.equal(m.entries.length, 2);
});

test("field ownership denies a field and stores nothing", async () => {
  const m = memoryStore();
  const c = await created(m);
  const r = await save(m.store, { ...userCtx(), mayWrite: (f) => f !== "ownerId" }, { op: "update", streamId: c.streamId, values: { ownerId: "u2", company: "Y" } });
  assert.deepEqual(r, { status: "invalid", errors: [{ field: "ownerId", message: "user may not write ownerId" }] });
  assert.equal(m.entries.length, 1);
});

test("invalid input and missing required fields store nothing", async () => {
  const m = memoryStore();
  assert.deepEqual(await save(m.store, userCtx(), { op: "create", values: { company: "No name" } }), {
    status: "invalid", errors: [{ field: "lastName", message: "Last name is required" }],
  });
  assert.deepEqual(await save(m.store, userCtx(), { op: "create", values: { lastName: "X", status: "hot" } }), {
    status: "invalid", errors: [{ field: "status", message: 'Lead status: "hot" is not an option' }],
  });
  assert.equal(m.streams.size, 0, "no record is allocated for invalid input");
  const c = await created(m);
  assert.deepEqual(await save(m.store, userCtx(), { op: "update", streamId: c.streamId, values: { lastName: "" } }), {
    status: "invalid", errors: [{ field: "lastName", message: "Last name is required" }],
  });
  assert.deepEqual(await save(m.store, userCtx(product), { op: "update", streamId: c.streamId, values: { name: "P" } }), {
    status: "invalid", errors: [{ field: "streamId", message: "Product not found" }],
  });
  assert.equal(m.entries.length, 1);
});

test("seq is gap-free and increasing per shard across many writes", async () => {
  const m = memoryStore();
  const streams: string[] = [];
  for (let i = 0; i < 200; i++) streams.push((await created(m, { lastName: `L${i}` })).streamId);
  for (let i = 0; i < 300; i++) {
    await save(m.store, userCtx(lead, 2000 + i), { op: "update", streamId: streams[(i * 7) % streams.length], values: { company: `C${i}` } });
  }
  assert.equal(m.entries.length, 500);
  const shards = new Set<number>();
  for (let shard = 0; shard < SHARDS; shard++) {
    const seqs = m.entries.filter((e) => e.shard === shard).map((e) => e.seq);
    if (seqs.length) shards.add(shard);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), `shard ${shard} seq runs 1..n in append order`);
  }
  assert.equal(shards.size, SHARDS, "200 streams spread over every shard");
});

test("import keeps createdAt and validFrom, and replaying a row changes nothing", async () => {
  const m = memoryStore();
  const ctx: SaveContext = { ...userCtx(lead, 9000), source: { kind: "import", ref: "csv:leads" }, actor: { kind: "integration", id: "import" }, alwaysKeepHotRow: false };
  const key = { provider: "csv:leads:lead", externalId: "row-1" };
  const importRow = async (values: Record<string, unknown>, validFrom: number): Promise<SaveResult> => {
    const streamId = await m.store.findByExternalId(ORG, key.provider, key.externalId);
    const cmd: SaveCommand = streamId
      ? { op: "update", streamId, values, validFrom }
      : { op: "create", values, externalId: key, createdAt: 100, validFrom };
    return save(m.store, ctx, cmd);
  };
  const { streamId } = applied(await importRow({ lastName: "Hopper", company: "Navy" }, 500));
  assert.equal(m.hotRows.size, 0, "an onDemand import keeps no hot row");

  assert.deepEqual(await importRow({ lastName: "Hopper", company: "Navy" }, 500), { status: "unchanged", streamId, version: 1 });
  assert.deepEqual(await importRow({ lastName: "Hopper", company: "Old snapshot" }, 400), { status: "unchanged", streamId, version: 1 });
  assert.equal((await importRow({ lastName: "Hopper", company: "Yale" }, 600)).status, "applied");
  assert.equal(m.streams.size, 1);

  const record = await materialize(m.store, streamId, 50);
  assert.ok(record);
  assert.deepEqual({ hot: record.hot, complete: record.complete, version: record.state.version, createdAt: record.state.createdAt }, { hot: true, complete: true, version: 2, createdAt: 100 }, "the import's change gave the record a hot row");
  const row = project(lead, record.state);
  assert.equal(row.values.company, "Yale");
  assert.equal(record.state.fields.company?.candidates[0]?.validFrom, 600);
});

test("an unchanged newer snapshot still blocks an older one that arrives after it", async () => {
  const m = memoryStore();
  const ctx: SaveContext = { ...userCtx(lead, 9000), source: { kind: "import", ref: "csv:leads" }, actor: { kind: "integration", id: "import" } };
  const created = applied(await save(m.store, ctx, { op: "create", values: { lastName: "Hopper", company: "Current" }, externalId: { provider: "csv", externalId: "row-1" }, validFrom: 100 }));
  const update = (company: string, validFrom: number) => save(m.store, ctx, { op: "update", streamId: created.streamId, values: { lastName: "Hopper", company }, validFrom });

  assert.equal((await update("Current", 300)).status, "applied", "a newer snapshot with no changes records its time");
  assert.deepEqual(m.entries.at(-1)?.body, { kind: "confirm", fieldIds: ["lastName", "company"], validFrom: 300 });
  assert.deepEqual(await update("Stale", 200), { status: "unchanged", streamId: created.streamId, version: 2 });
  assert.equal(project(lead, (await materialize(m.store, created.streamId, 50))!.state).values.company, "Current");
});

test("a unique field rejects a value another record holds, on create and update, and frees it when changed", async () => {
  const m = memoryStore();
  const ctx = userCtx(product);
  const widget = applied(await save(m.store, ctx, { op: "create", values: { name: "Widget", sku: "W-1" } }));
  const gadget = applied(await save(m.store, ctx, { op: "create", values: { name: "Gadget", sku: "G-1" } }));

  const taken = { status: "invalid", errors: [{ field: "sku", message: 'SKU "w-1" is already used by another product', retryable: true }] };
  assert.deepEqual(await save(m.store, ctx, { op: "create", values: { name: "Copy", sku: "w-1 " } }), taken, "case and spacing do not make a new SKU");
  assert.deepEqual(await save(m.store, ctx, { op: "update", streamId: gadget.streamId, values: { sku: "w-1 " } }), taken);
  assert.equal(m.streams.size, 2, "a rejected create allocates nothing");

  assert.equal((await save(m.store, ctx, { op: "update", streamId: widget.streamId, values: { sku: "W-2" } })).status, "applied");
  assert.equal((await save(m.store, ctx, { op: "update", streamId: gadget.streamId, values: { sku: "W-1" } })).status, "applied", "the old value is free again");
  assert.equal((await save(m.store, ctx, { op: "update", streamId: widget.streamId, values: { sku: "W-2" } })).status, "unchanged", "a record does not conflict with itself");
});

test("a read folds at most its cap and marks the rest incomplete", async () => {
  const m = memoryStore();
  const ctx: SaveContext = { ...userCtx(), alwaysKeepHotRow: false, source: { kind: "import", ref: "csv:x" } };
  const { streamId } = applied(await save(m.store, ctx, { op: "create", values: { lastName: "A" } }));
  for (let i = 0; i < 5; i++) await save(m.store, { ...ctx, now: 2000 + i }, { op: "update", streamId, values: { company: `C${i}` } });
  m.hotRows.clear(); // an evicted hot row is the one way a long stream is read cold
  const r = await materialize(m.store, streamId, 3);
  assert.deepEqual({ hot: r?.hot, complete: r?.complete, version: r?.state.version }, { hot: false, complete: false, version: 3 });
  assert.equal(project(lead, r!.state).values.company, "C1");
});

test("saveBatch applies one change to each record, refuses ones of another object, and hands back what it could not reach", async () => {
  const m = memoryStore();
  const a = await created(m, { lastName: "A" });
  const b = await created(m, { lastName: "B" });
  const p = applied(await save(m.store, userCtx(product), { op: "create", values: { name: "Widget" } }));
  const out = await saveBatch(m.store, userCtx(lead, 2000), { op: "update", values: { status: "working" } }, [a.streamId, b.streamId, p.streamId, a.streamId], () => false);
  assert.deepEqual(out.results.map((r) => [r.streamId, r.result.status]), [[a.streamId, "applied"], [b.streamId, "applied"], [p.streamId, "invalid"]]);
  assert.deepEqual(out.unprocessed, []);
  assert.equal(m.hotRows.get(a.streamId)!.row.values.status, "working");
  assert.equal(m.hotRows.get(p.streamId)!.row.values.name, "Widget");

  const del = await saveBatch(m.store, userCtx(lead, 3000), { op: "delete" }, [a.streamId, b.streamId], () => false);
  assert.deepEqual(del.results.map((r) => r.result.status), ["applied", "applied"]);
  assert.equal(m.hotRows.get(b.streamId)!.state.lifecycle.status, "deleted");

  let budget = 1;
  const restore = await saveBatch(m.store, userCtx(lead, 4000), { op: "restore" }, [a.streamId, b.streamId], () => budget-- <= 0);
  assert.deepEqual(restore.results.map((r) => [r.streamId, r.result.status]), [[a.streamId, "applied"]]);
  assert.deepEqual(restore.unprocessed, [b.streamId]);
  assert.equal(m.hotRows.get(a.streamId)!.state.lifecycle.status, "active");
  assert.equal(m.hotRows.get(b.streamId)!.state.lifecycle.status, "deleted");
});

test("a note saved with an account lookup is listed among that account's activities", async () => {
  const m = memoryStore();
  const note = resolveObjectDef(STANDARD_OBJECTS.note);
  const linked = applied(await save(m.store, userCtx(note, 5000), { op: "create", values: { body: "Asked for pricing", accountId: "acc_1", ownerId: "u1" } }));
  applied(await save(m.store, userCtx(note, 6000), { op: "create", values: { body: "Elsewhere", accountId: "acc_2" } }));
  const client = createFakeRecordClient({
    store: createMemoryRecordStore(),
    objects: { rows: async () => ({ rows: [...m.hotRows.values()].map(({ state }) => listRowOf(note, state)), defs: [plainObjectDef(note)], heads: {} }) },
  });
  const { activities } = await linkedActivities(client, ORG, { field: "accountId", id: "acc_1" });
  assert.deepEqual(activities, [{ kind: "note", id: linked.streamId, at: 5000, ownerId: "u1", body: "Asked for pricing" }]);
});
