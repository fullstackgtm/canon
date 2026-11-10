// Module reports (1.33.0, src/moduleDocs.ts): docs as Canon syncs them, and reports that count only the docs the
// scope admits: an owner list, a condition on a related doc, and a set doc of its parent's live generation.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startApp } from "./helpers.ts";

const MODULE = encodeURIComponent("@acme/visits");
const doc = (collection: string, key: string, data: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  ({ collection, key, parentKey: null, gen: null, gens: null, owner: null, data, version: 1, createdAt: 1, updatedAt: 1, ...more });
const fields = [
  { name: "status", label: "Status", type: "picklist", options: [{ value: "planned", label: "Planned" }, { value: "done", label: "Done" }] },
  { name: "amount", label: "Amount", type: "currency" },
  { name: "visitOn", label: "Visit date", type: "date" },
];

describe("module reports", () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  before(async () => { ctx = await startApp(); });
  after(async () => { await ctx.app.shutdown(); });
  const post = async (path: string, body: unknown) => {
    const r = await ctx.client.ws("mods").post(`modules/${MODULE}/${path}`, body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  const report = (collection: string, docScope: unknown, extra: Record<string, unknown> = {}) =>
    post("aggregate", { collection, fields: collection === "visits" ? fields : [{ name: "body", label: "Body", type: "text" }], docScope, measures: [{ fn: "count" }], ...extra });

  it("counts only what a scope admits, follows syncs and sweeps a rebuild's leftovers", async () => {
    await post("sync", {
      upserts: [
        doc("visits", "v1", { status: "planned", amount: 10000, visitOn: "2026-01-05" }, { owner: "rep1", gens: { notes: 0 } }),
        doc("visits", "v2", { status: "done", amount: 20000, visitOn: "2026-02-10" }, { owner: "rep2" }),
        doc("visits", "v3", { status: "done", amount: 30000, visitOn: "2026-02-20" }, { owner: "rep1" }),
        doc("months", "m1", { status: "closed" }), doc("months", "m2", { status: "open" }),
        doc("tallies", "t1", { month: "m1" }), doc("tallies", "t2", { month: "m2" }), doc("tallies", "t3", { month: 7 }),
        doc("notes", "n1", { body: "a" }, { parentKey: "v1", gen: 0 }), doc("notes", "n2", { body: "b" }, { parentKey: "v1", gen: 1 }),
        doc("notes", "n3", { body: "c" }, { parentKey: "v2", gen: 0 }),
      ],
      deletes: [],
    });
    const mine = { owners: ["rep1"], where: null, setOf: null };
    const byStatus = await report("visits", mine, { groupBy: [{ field: "status" }], measures: [{ fn: "count" }, { fn: "sum", field: "amount" }] });
    assert.deepEqual(byStatus.groups.map((g: { keys: unknown[]; values: unknown[] }) => [g.keys[0], ...g.values]), [["done", 1, 30000], ["planned", 1, 10000]], "a rep's report counts their visits only");
    const byMonth = await report("visits", null, { groupBy: [{ field: "visitOn", bucket: "month" }] });
    assert.deepEqual(byMonth.groups.map((g: { keys: unknown[]; values: unknown[] }) => [g.keys[0], g.values[0]]), [["2026-01-01", 1], ["2026-02-01", 2]]);

    const closed = { owners: null, where: { ref: "month", collection: "months", where: { field: "status", in: ["closed"] } }, setOf: null };
    assert.equal((await report("tallies", closed)).rows, 1, "a tally counts only while the month it names is closed");
    const notes = { owners: null, where: null, setOf: { parent: "visits", scope: mine } };
    assert.equal((await report("notes", notes)).rows, 1, "a note counts only in its parent's live generation, under a parent the caller reads");
    assert.equal((await report("visits", { owners: null, where: { field: "status", neq: "planned" }, setOf: null })).rows, 2);
    assert.equal((await report("visits", { owners: [], where: null, setOf: null })).rows, 0, "no owners admits nothing");

    await post("sync", { upserts: [doc("visits", "v2", { status: "done", amount: 20000 }, { owner: "rep1", version: 2 })], deletes: [{ collection: "visits", key: "v3" }] });
    assert.equal((await report("visits", mine)).rows, 2, "a doc handed to the rep counts for them, and a deleted one is gone");
    await new Promise((r) => setTimeout(r, 5));
    const rebuilt = await post("sync", { upserts: [doc("visits", "v1", { status: "planned", amount: 10000 }, { owner: "rep1" })], deletes: [] });
    await post("sync", { upserts: [], deletes: [], sweep: { collection: "visits", before: rebuilt.at } });
    assert.equal((await report("visits", null)).rows, 1, "the sweep drops the rows a rebuild didn't rewrite");
  });

  it("requires initialization of the complete dependency closure and fences the legacy transition", async () => {
    const request = (path: string, body: unknown) => ctx.client.ws("projection-init").post(`modules/${MODULE}/${path}`, body);
    const projection = { packageId: "package", epoch: 1, generation: 1, collections: ["parents", "visits"] };
    const aggregate = () => request("aggregate", { collection: "visits", fields, docScope: null, measures: [{ fn: "count" }], projection });
    assert.equal((await aggregate()).status, 503, "no workspace or initialization receipt is not an empty exact report");
    assert.equal((await request("sync", { upserts: [doc("visits", "legacy", {})], deletes: [] })).status, 200);
    const rebuild = (collection: string, complete: boolean, upserts: unknown[] = []) => request("sync", { projection, work: { kind: "rebuild", collection, job: `rebuild-${collection}`, seq: 10, complete }, upserts, deletes: [] });
    const first = await rebuild("visits", false, [doc("visits", "v1", {})]);
    assert.equal(first.status, 200);
    assert.equal(first.json.receipt.accepted, true);
    assert.deepEqual(first.json.receipt.projection, projection);
    assert.equal((await aggregate()).status, 503);
    await rebuild("visits", true);
    assert.equal((await aggregate()).status, 503, "a missing dependency collection holds the entire report unavailable");
    await rebuild("parents", true);
    const ready = await aggregate();
    assert.equal(ready.status, 200);
    assert.equal(ready.json.rows, 1, "adoption rebuilds the derived projection, including removing legacy leftovers");
    assert.deepEqual(ready.json.projection, projection, "the same snapshot that counted echoes its readiness receipt");
    assert.equal((await request("sync", { upserts: [], deletes: [{ collection: "visits", key: "v1" }] })).status, 409);
    assert.equal((await request("aggregate", { collection: "visits", fields, docScope: null, measures: [{ fn: "count" }] })).status, 503, "legacy readers cannot count an adopted projection during cutover");
  });

  it("retains key ordering across deletes and rejects colliding recreated jobs, with idempotent retries", async () => {
    const request = async (path: string, body: unknown) => {
      const r = await ctx.client.ws("projection-order").post(`modules/${MODULE}/${path}`, body);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return r.json;
    };
    const projection = { packageId: "package", epoch: 1, generation: 1, collections: ["visits"] };
    await request("sync", { projection, work: { kind: "rebuild", collection: "visits", job: "rebuild", seq: 10, complete: true }, upserts: [], deletes: [] });
    const put = (seq: number, job: string, amount?: number) => request("sync", { projection, work: { kind: "keys", keys: [{ collection: "visits", key: "v1", seq, job }] },
      upserts: amount === undefined ? [] : [doc("visits", "v1", { amount })], deletes: amount === undefined ? [{ collection: "visits", key: "v1" }] : [] });
    const count = () => request("aggregate", { projection, collection: "visits", fields, docScope: null, measures: [{ fn: "count" }, { fn: "sum", field: "amount" }] });
    await put(20, "old", 1);
    await put(30, "new", 2);
    assert.equal((await put(20, "old", 1)).receipt.accepted, false);
    assert.deepEqual((await count()).total, [1, 2]);
    await put(40, "delete");
    assert.equal((await put(30, "new", 2)).receipt.accepted, false, "a tombstone prevents resurrection");
    assert.equal((await count()).rows, 0);
    assert.equal((await put(40, "delete")).receipt.accepted, true);
    const collision = await put(40, "recreated", 3);
    assert.equal(collision.receipt.accepted, false);
    assert.equal(collision.receipt.retryAfter, 40, "source can rebase its existing dirty key after a repeated clock seed");
    await put(41, "recreated", 3);
    assert.equal((await put(41, "recreated", 999)).receipt.accepted, true);
    assert.deepEqual((await count()).total, [1, 3], "the first accepted leased identity wins on duplicate delivery");
  });

  it("fences stale rebuild pages and sweeps, including unseen keys, and preserves newer incremental rows", async () => {
    const request = async (path: string, body: unknown) => {
      const r = await ctx.client.ws("projection-rebuild").post(`modules/${MODULE}/${path}`, body);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return r.json;
    };
    const projection = { packageId: "package", epoch: 1, generation: 1, collections: ["visits"] };
    const rebuild = (seq: number, complete: boolean, keys: string[] = []) => request("sync", { projection, work: { kind: "rebuild", collection: "visits", job: `rebuild-${seq}`, seq, complete }, upserts: keys.map((k) => doc("visits", k, {})), deletes: [] });
    const put = (seq: number, key: string) => request("sync", { projection, work: { kind: "keys", keys: [{ collection: "visits", key, seq, job: `job-${seq}` }] }, upserts: [doc("visits", key, {})], deletes: [] });
    const count = () => request("aggregate", { projection, collection: "visits", fields, docScope: null, measures: [{ fn: "count" }] });
    await rebuild(100, true, ["keep", "gone"]);
    await put(200, "newer");
    await rebuild(150, false, ["keep"]);
    await rebuild(150, true);
    assert.equal((await count()).rows, 2, "the sweep removes unseen old rows, but preserves sequence 200");
    assert.equal((await put(125, "never-seen-before")).receipt.accepted, false, "the collection floor fences even a key without its own receipt");
    assert.equal((await rebuild(100, true)).receipt.accepted, false);
    await put(300, "after-sweep");
    await rebuild(150, true);
    await rebuild(150, false, ["gone"]);
    assert.equal((await count()).rows, 3, "duplicate finals and delayed pages cannot reopen the completed rebuild");
  });

  it("rejects old serving generations after reenable, upgrade and reinstall without reusing package identity", async () => {
    const request = (path: string, body: unknown) => ctx.client.ws("projection-lifecycle").post(`modules/${MODULE}/${path}`, body);
    const first = { packageId: "retained-package", epoch: 1, generation: 1, collections: ["visits"] };
    const sync = (projection: typeof first, key: string) => request("sync", { projection, work: { kind: "rebuild", collection: "visits", job: `rebuild-${projection.epoch}-${projection.generation}`, seq: 10, complete: true }, upserts: [doc("visits", key, {})], deletes: [] });
    const count = (projection: typeof first) => request("aggregate", { projection, collection: "visits", fields, docScope: null, measures: [{ fn: "count" }] });
    await sync(first, "before-disable");
    const enabled = { ...first, generation: 2 };
    await sync(enabled, "after-enable");
    assert.equal((await sync(first, "delayed")).json.receipt.accepted, false);
    assert.equal((await count(first)).status, 503);
    const reinstalled = { ...first, epoch: 3, generation: 1 };
    await sync(reinstalled, "after-reinstall");
    assert.equal((await sync(enabled, "old-epoch")).json.receipt.accepted, false);
    assert.equal((await sync({ ...reinstalled, packageId: "unknown-package" }, "unknown")).json.receipt.accepted, false, "unknown source identity needs explicit derived-store recovery, never automatic replacement");
    const current = await count(reinstalled);
    assert.equal(current.status, 200);
    assert.equal(current.json.rows, 1);
  });
});
