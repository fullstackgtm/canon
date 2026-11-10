import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { FakeLedger } from "./ledgerFake.ts";
import { startApp } from "./helpers.ts";

const moduleId = "@test/activity";
const modulePath = `modules/${encodeURIComponent(moduleId)}`;
const unrestricted = { owners: null, where: null, setOf: null };
const doc = (collection: string, key: string, more: Record<string, unknown> = {}) => ({
  collection, key, data: {}, owner: null, parentKey: null, gen: null, gens: null,
  version: 1, createdAt: Date.UTC(2026, 0, 5), updatedAt: Date.UTC(2026, 1, 5), ...more,
});

describe("Activities union HTTP contract", () => {
  const ledger = new FakeLedger();
  let ctx: Awaited<ReturnType<typeof startApp>>;
  before(async () => {
    ctx = await startApp({ projector: { sourceUrl: await ledger.listen(), pollMs: 0 } });
  });
  after(async () => { await ctx.app.shutdown(); await ledger.close(); });

  it("counts beyond the live-read limit with independent ledger and module scopes, refs, live parents and final filters", async () => {
    const ws = "activity-union";
    const post = async (path: string, body: unknown) => {
      const r = await ctx.client.ws(ws).post(path, body);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return r.json;
    };
    await post("provision", {});
    ledger.set(ws, "task", "mine", { subject: "Mine", ownerId: "rep1" }, Date.UTC(2026, 0, 5));
    ledger.set(ws, "task", "theirs", { subject: "Theirs", ownerId: "rep2" }, Date.UTC(2026, 0, 5));
    await post("projector/nudge", { heads: ledger.heads(ws), wait: true });
    const projection = { packageId: "package", epoch: 1, generation: 1, collections: ["months", "parents", "visits"] };
    const rebuild = (collection: string, upserts: unknown[], complete = true) => post(`${modulePath}/sync`, {
      projection, upserts, deletes: [], work: { kind: "rebuild", collection, job: `rebuild-${collection}`, seq: 1, complete },
    });
    await rebuild("months", [doc("months", "closed", { data: { status: "closed" } }), doc("months", "open", { data: { status: "open" } })]);
    await rebuild("parents", [doc("parents", "visible", { owner: "rep1", gens: { visits: 2 } }), doc("parents", "hidden", { owner: "rep2", gens: { visits: 2 } })]);
    const visit = (key: string, more: Record<string, unknown> = {}) => doc("visits", key, { owner: "rep1", parentKey: "visible", gen: 2, data: { performer: "rep2", month: "closed", visible: true }, ...more });
    const rows = Array.from({ length: 1001 }, (_, i) => visit(`visit-${i}`));
    rows.push(visit("old-gen", { gen: 1 }), visit("hidden-parent", { parentKey: "hidden" }), visit("wrong-owner", { owner: "rep2" }),
      visit("open-month", { data: { performer: "rep2", month: "open", visible: true } }), visit("second-principal-denies", { data: { performer: "rep2", month: "closed", visible: false } }));
    for (let offset = 0; offset < rows.length; offset += 500) await rebuild("visits", rows.slice(offset, offset + 500), offset + 500 >= rows.length);
    const source = { module: moduleId, collection: "visits", kind: "visit", owner: "performer", projection, scopes: [
      { owners: ["rep1"], where: { ref: "month", collection: "months", where: { field: "status", in: ["closed"] } }, setOf: { parent: "parents", scope: { ...unrestricted, owners: ["rep1"] } } },
      { ...unrestricted, where: { field: "visible", in: [true] } },
    ] };
    const request = { moduleActivities: [source], scope: { field: "ownerId", owners: ["rep1"], unowned: false }, groupBy: [{ field: "type" }, { field: "ownerId" }], measures: [{ fn: "count" }] };
    const report = await post("p/activity/aggregate", request);
    assert.deepEqual(report.groups, [{ keys: ["task", "rep1"], values: [1] }, { keys: ["visit", "rep2"], values: [1001] }]);
    assert.deepEqual(report.total, [1002]);
    assert.equal(report.rows, 1002);
    assert.deepEqual(report.moduleActivities, [source]);
    const filtered = await post("p/activity/aggregate", { ...request, filter: [{ field: "ownerId", op: "eq", value: "rep2" }], groupBy: [{ field: "createdAt", bucket: "month" }, { field: "type" }] });
    assert.deepEqual(filtered.groups, [{ keys: ["2026-01-01", "visit"], values: [1001] }]);
    const updated = await post("p/activity/aggregate", { ...request, filter: [{ field: "type", op: "eq", value: "visit" }], groupBy: [{ field: "updatedAt", bucket: "month" }] });
    assert.deepEqual(updated.groups, [{ keys: ["2026-02-01"], values: [1001] }]);
    assert.equal((await ctx.client.ws(ws).post("p/deal/aggregate", request)).status, 400);
    assert.equal((await ctx.client.ws(ws).post("p/activity/aggregate", { ...request, moduleActivities: [source, source] })).status, 400);
  });

  it("requires every stamped collection and can report module-only workspaces without a ledger projection", async () => {
    const ws = "activity-only";
    const projection = { packageId: "package", epoch: 1, generation: 1, collections: ["parents", "visits"] };
    const source = { module: moduleId, collection: "visits", kind: "visit", owner: null, projection, scopes: [unrestricted] };
    const request = { moduleActivities: [source], groupBy: [{ field: "ownerId" }], measures: [{ fn: "count" }] };
    const aggregate = (body: unknown = request) => ctx.client.ws(ws).post("p/activity/aggregate", body);
    assert.equal((await aggregate()).status, 503);
    const rebuild = (collection: string, complete: boolean, upserts: unknown[] = []) => ctx.client.ws(ws).post(`${modulePath}/sync`, {
      projection, upserts, deletes: [], work: { kind: "rebuild", collection, job: `rebuild-${collection}`, seq: 1, complete },
    });
    assert.equal((await rebuild("visits", false, [doc("visits", "one", { owner: "permission-owner" })])).status, 200);
    assert.equal((await aggregate()).status, 503);
    assert.equal((await rebuild("visits", true)).status, 200);
    assert.equal((await aggregate()).status, 503);
    assert.equal((await rebuild("parents", true)).status, 200);
    const ready = await aggregate();
    assert.equal(ready.status, 200, JSON.stringify(ready.json));
    assert.deepEqual(ready.json.groups, [{ keys: [null], values: [1] }], "permission owner never fills an undeclared activity owner");
    assert.deepEqual(ready.json.moduleActivities, [source]);
    assert.equal((await aggregate({ ...request, moduleActivities: [{ ...source, projection: undefined }] })).status, 400);
    assert.equal((await aggregate({ ...request, moduleActivities: [{ ...source, projection: { ...projection, generation: 0 } }] })).status, 503);
    assert.equal((await aggregate({ ...request, moduleActivities: [{ ...source, collection: "outside" }] })).status, 400);
  });
});
