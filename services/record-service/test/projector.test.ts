import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import { all } from "../src/db.ts";
import { Workspace } from "../src/workspace.ts";
import { FakeLedger, shardOf } from "./ledgerFake.ts";
import { startApp } from "./helpers.ts";

const TIER = [{ value: "gold", label: "Gold", active: true }, { value: "silver", label: "Silver", active: true }];

describe("object-layer projector", () => {
  const ledger = new FakeLedger();
  let ctx: Awaited<ReturnType<typeof startApp>>;
  let failNextRebuildChunk = false;

  before(async () => {
    const sourceUrl = await ledger.listen();
    ctx = await startApp({
      projector: {
        sourceUrl, pollMs: 0, pageSize: 3, rebuildChunk: 2,
        onRebuildChunk: () => {
          if (failNextRebuildChunk) {
            failNextRebuildChunk = false;
            throw new Error("rebuild cut off");
          }
        },
      },
    });
  });
  after(async () => {
    await ctx.app.shutdown();
    await ledger.close();
  });

  const nudge = (ws: string) => ctx.client.ws(ws).post("projector/nudge", { wait: true });
  const list = (ws: string, object: string, body: unknown = {}) => ctx.client.ws(ws).post(`p/${object}/list`, body);
  const sql = (ws: string, q: string) => ctx.app.registry.with(ws, (w) => w.read((c) => all(c, q)));
  const exec = (ws: string, q: string) => ctx.app.registry.with(ws, (w) => w.write((c) => c.run(q), "exclusive"));

  it("round-trips ledger credit splits as typed rows and clears them with a later fact", async () => {
    const splits = [{ userId: "u1", percentage: 60, kind: "revenue" }, { userId: "u2", percentage: 40, kind: "revenue" }, { userId: "u1", percentage: 20, kind: "overlay" }];
    ledger.set("split-org", "deal", "split-deal", { name: "Split deal", splitAllocations: splits }, 1000);
    assert.equal((await nudge("split-org")).status, 200);
    assert.deepEqual((await list("split-org", "deal")).json.rows[0].values.splitAllocations, splits);
    ledger.set("split-org", "deal", "split-deal", { splitAllocations: null }, 2000);
    assert.equal((await nudge("split-org")).status, 200);
    assert.equal((await list("split-org", "deal")).json.rows[0].values.splitAllocations, null);
  });

  it("projects tailed entries of several objects into typed rows", async () => {
    ledger.set("o1", "lead", "lead-ada", { lastName: "Lovelace", firstName: "Ada", company: "Analytical", status: "working" }, 1000);
    ledger.set("o1", "task", "task-1", { subject: "Call Ada", dueDate: "2026-10-07", priority: "high" }, 1100);
    ledger.set("o1", "lead", "lead-ada", { company: "Engines Ltd" }, 1200);
    ledger.set("o1", "product", "prod-1", { name: "Seat", unitPrice: 49.5, active: true }, 1300);

    const n = await nudge("o1");
    assert.equal(n.status, 200, JSON.stringify(n.json));

    assert.deepEqual((await list("o1", "lead")).json.rows, [{
      id: "lead-ada", object: "lead", version: 2, status: "active", title: "Lovelace", createdAt: 1000, updatedAt: 1200, deletedAt: null,
      values: { firstName: "Ada", lastName: "Lovelace", company: "Engines Ltd", title: null, email: null, phone: null, status: "working", leadSource: null, ownerId: null, convertedAt: null, convertedAccountId: null, convertedContactId: null, convertedDealId: null },
    }]);
    assert.deepEqual((await list("o1", "task")).json.rows[0].values, { subject: "Call Ada", status: null, priority: "high", dueDate: "2026-10-07", description: null, ownerId: null, accountId: null, contactId: null, dealId: null });
    assert.deepEqual((await list("o1", "product")).json.rows[0].values, { name: "Seat", sku: null, family: null, unitPrice: 49.5, active: true, description: null });

    const through = (await list("o1", "lead")).json.projectedThrough;
    assert.equal(Object.keys(through).length, 16);
    assert.equal(through[String(shardOf("lead-ada"))] >= 2, true);
    assert.deepEqual(Object.fromEntries(Object.entries(through as Record<string, number>).filter(([, seq]) => seq > 0)), ledger.heads("o1"));
  });

  it("replays already applied entries without changing anything", async () => {
    const before = (await list("o1", "lead")).json.rows;
    await exec("o1", "DELETE FROM projector_cursor");
    assert.equal((await nudge("o1")).status, 200);
    assert.deepEqual(await sql("o1", "SELECT count(*)::INTEGER AS n FROM ledger_mirror"), [{ n: 4 }]);
    assert.deepEqual((await list("o1", "lead")).json.rows, before);
    const twice = await Promise.all([nudge("o1"), nudge("o1")]);
    assert.deepEqual(twice.map((r) => r.status), [200, 200]);
    assert.deepEqual(await sql("o1", "SELECT count(*)::INTEGER AS n FROM ledger_mirror"), [{ n: 4 }]);
  });

  it("keeps pulling past a tail page cut short by its byte budget", async () => {
    const ws = "o-short";
    for (let i = 1; i <= 5; i++) ledger.set(ws, "lead", "lead-short", { lastName: `v${i}` }, 9000 + i);
    ledger.tailCap = 1;
    try {
      assert.equal((await nudge(ws)).status, 200);
    } finally {
      ledger.tailCap = Infinity;
    }
    const [row] = (await list(ws, "lead")).json.rows;
    assert.deepEqual([row.version, row.values.lastName], [5, "v5"]);
  });

  it("checks only the incoming entries against the mirror, not a stream's whole history", async () => {
    const ws = "o-hot";
    for (let i = 1; i <= 30; i++) ledger.set(ws, "lead", "lead-hot", { lastName: `v${i}` }, 9100 + i);
    assert.equal((await nudge(ws)).status, 200);
    ledger.set(ws, "lead", "lead-hot", { lastName: "v31" }, 9200);

    // Count the ledger_mirror rows every read returns during the next catch-up.
    let mirrorRows = 0;
    const read = Workspace.prototype.read;
    Workspace.prototype.read = function <T>(this: Workspace, fn: (c: DuckDBConnection) => Promise<T>) {
      return read.call(this, (c) => fn(new Proxy(c, {
        get(target, key) {
          if (key !== "runAndReadAll") return Reflect.get(target, key, target);
          return async (q: string, params?: Record<string, DuckDBValue>) => {
            const reader = await target.runAndReadAll(q, params);
            if (/ledger_mirror/.test(q)) mirrorRows += reader.currentRowCount;
            return reader;
          };
        },
      }))) as Promise<T>;
    };
    try {
      assert.equal((await nudge(ws)).status, 200);
    } finally {
      Workspace.prototype.read = read;
    }
    assert.equal(mirrorRows, 0, "the one new entry is not mirrored yet; no other mirror row should be read");
    const [row] = (await list(ws, "lead")).json.rows;
    assert.deepEqual([row.version, row.values.lastName], [31, "v31"]);
  });

  it("fills a version gap from the stream endpoint", async () => {
    ledger.set("o2", "lead", "lead-gap", { lastName: "Hopper" }, 2000);
    ledger.set("o2", "lead", "lead-gap", { company: "Navy" }, 2100);
    assert.equal((await nudge("o2")).status, 200);
    // Lose the stream's mirror rows and fold state, as if they had never been applied.
    const [{ build }] = await sql("o2", "SELECT build_id AS build FROM projection_builds WHERE object = 'lead' AND status = 'done'");
    await exec("o2", `DELETE FROM s_lead__b${build} WHERE id = 'lead-gap'`);
    await exec("o2", "DELETE FROM ledger_mirror WHERE stream = 'lead-gap'");
    ledger.set("o2", "lead", "lead-gap", { title: "Rear Admiral" }, 2200);

    assert.equal((await nudge("o2")).status, 200);
    const [row] = (await list("o2", "lead")).json.rows;
    assert.equal(row.version, 3);
    assert.deepEqual([row.values.lastName, row.values.company, row.values.title], ["Hopper", "Navy", "Rear Admiral"]);
    assert.deepEqual(await sql("o2", "SELECT version FROM ledger_mirror WHERE stream = 'lead-gap' ORDER BY version"), [{ version: 1 }, { version: 2 }, { version: 3 }]);
  });

  it("a gap filled from entries the mirror already holds does not mirror them twice", async () => {
    ledger.set("o2b", "lead", "lead-gap2", { lastName: "Hamilton" }, 2300);
    ledger.set("o2b", "lead", "lead-gap2", { company: "MIT" }, 2400);
    assert.equal((await nudge("o2b")).status, 200);
    const [{ build }] = await sql("o2b", "SELECT build_id AS build FROM projection_builds WHERE object = 'lead' AND status = 'done'");
    await exec("o2b", `DELETE FROM s_lead__b${build} WHERE id = 'lead-gap2'`);
    ledger.set("o2b", "lead", "lead-gap2", { title: "Director" }, 2500);

    assert.equal((await nudge("o2b")).status, 200);
    const [row] = (await list("o2b", "lead")).json.rows;
    assert.deepEqual([row.version, row.values.lastName, row.values.company, row.values.title], [3, "Hamilton", "MIT", "Director"]);
    assert.deepEqual(await sql("o2b", "SELECT version FROM ledger_mirror WHERE stream = 'lead-gap2' ORDER BY version"), [{ version: 1 }, { version: 2 }, { version: 3 }]);
  });

  it("rebuilds an object when its columns change, and a forced rebuild gives identical rows", async () => {
    const ws = "o3";
    ledger.set(ws, "lead", "lead-1", { lastName: "Curie" }, 3000);
    ledger.set(ws, "lead", "lead-2", { lastName: "Meitner" }, 3001);
    ledger.set(ws, "lead", "lead-3", { lastName: "Franklin" }, 3002);
    assert.equal((await nudge(ws)).status, 200);
    const builds = async () => sql(ws, "SELECT build_id AS b, status FROM projection_builds WHERE object = 'lead' ORDER BY build_id");
    assert.deepEqual(await builds(), [{ b: 1, status: "done" }]);

    ledger.extensions.set(ws, { lead: { registryVersion: 1, customFields: [{ fieldId: "cf_tier", apiName: "custom.tier", label: "Tier", type: "picklist", options: TIER } as never] } });
    ledger.set(ws, "lead", "lead-2", { cf_tier: "gold" }, 3100);
    assert.equal((await nudge(ws)).status, 200);
    assert.deepEqual(await builds(), [{ b: 1, status: "replaced" }, { b: 2, status: "done" }]);
    const afterChange = (await list(ws, "lead", { sort: { field: "recordTitle", dir: "asc" } })).json.rows;
    assert.deepEqual(afterChange.map((r: { id: string; values: { cf_tier: string | null } }) => [r.id, r.values.cf_tier]), [["lead-1", null], ["lead-3", null], ["lead-2", "gold"]]);

    failNextRebuildChunk = true;
    const cut = await ctx.client.ws(ws).post("projector/rebuild", { object: "lead" });
    assert.equal(cut.status, 500);
    assert.deepEqual(await sql(ws, "SELECT build_id AS b, cursor FROM projection_builds WHERE object = 'lead' AND status = 'building'"), [{ b: 3, cursor: "lead-2" }]);
    const resumed = await ctx.client.ws(ws).post("projector/rebuild", { object: "lead" });
    assert.deepEqual(resumed.json, { build: 3, rows: 3 });
    assert.deepEqual((await list(ws, "lead", { sort: { field: "recordTitle", dir: "asc" } })).json.rows, afterChange);
  });

  it("a forced rebuild cut off before a catch-up still publishes the caught-up rows", async () => {
    const ws = "o7";
    for (const id of ["r-1", "r-2", "r-3", "r-4"]) ledger.set(ws, "lead", id, { lastName: `${id} v1` }, 7000);
    assert.equal((await nudge(ws)).status, 200);

    failNextRebuildChunk = true;
    assert.equal((await ctx.client.ws(ws).post("projector/rebuild", { object: "lead" })).status, 500);
    ledger.set(ws, "lead", "r-1", { lastName: "r-1 v2" }, 7100);
    assert.equal((await nudge(ws)).status, 200);
    const caughtUp = (await list(ws, "lead", { sort: { field: "id", dir: "asc" } })).json.rows;
    assert.deepEqual(caughtUp.map((r: { id: string; version: number; title: string }) => [r.id, r.version, r.title]).slice(0, 1), [["r-1", 2, "r-1 v2"]]);

    assert.deepEqual((await ctx.client.ws(ws).post("projector/rebuild", { object: "lead" })).json, { build: 2, rows: 4 });
    assert.deepEqual((await list(ws, "lead", { sort: { field: "id", dir: "asc" } })).json.rows, caughtUp);
  });

  it("projects a registry change that arrives with no new ledger entries", async () => {
    const ws = "o8";
    ledger.set(ws, "lead", "g-1", { lastName: "Noether" }, 8000);
    assert.equal((await nudge(ws)).status, 200);
    ledger.extensions.set(ws, { lead: { registryVersion: 1, customFields: [{ fieldId: "cf_score", apiName: "custom.score", label: "Score", type: "number" }] as never } });

    assert.equal((await nudge(ws)).status, 200);
    const r = await list(ws, "lead", { sort: { field: "custom.score", dir: "asc" } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.rows.map((row: { id: string; values: Record<string, unknown> }) => [row.id, row.values.cf_score]), [["g-1", null]]);
  });

  it("lists a renamed custom field by its new name", async () => {
    const ws = "o10";
    const field = (apiName: string) => ({ lead: { registryVersion: 1, customFields: [{ fieldId: "cf_rank", apiName, label: "Rank", type: "number" }] as never } });
    ledger.extensions.set(ws, field("custom.rank"));
    ledger.set(ws, "lead", "n-1", { lastName: "Pascal", cf_rank: 2 }, 10_000);
    ledger.set(ws, "lead", "n-2", { lastName: "Fermat", cf_rank: 1 }, 10_001);
    assert.equal((await nudge(ws)).status, 200);
    ledger.extensions.set(ws, field("custom.position"));
    assert.equal((await nudge(ws)).status, 200);

    const sorted = async () => {
      const r = await list(ws, "lead", { sort: { field: "custom.position", dir: "asc" } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return r.json.rows.map((row: { id: string }) => row.id);
    };
    assert.deepEqual(await sorted(), ["n-2", "n-1"]);
    assert.equal((await list(ws, "lead", { sort: { field: "custom.rank", dir: "asc" } })).status, 400);
    assert.equal((await ctx.client.ws(ws).post("projector/rebuild", { object: "lead" })).status, 200);
    assert.deepEqual(await sorted(), ["n-2", "n-1"]);
  });

  it("a list reads the build it validated against when a rebuild swaps the view mid-request", async () => {
    const ws = "o11";
    ledger.extensions.set(ws, { lead: { registryVersion: 1, customFields: [{ fieldId: "cf_score", apiName: "custom.score", label: "Score", type: "number" }] as never } });
    ledger.set(ws, "lead", "v-1", { lastName: "Gauss", cf_score: 7 }, 11_000);
    ledger.set(ws, "lead", "v-2", { lastName: "Euler", cf_score: 3 }, 11_001);
    assert.equal((await nudge(ws)).status, 200);

    const w = await ctx.app.registry.with(ws, async (w) => w);
    const read = w.read.bind(w);
    let armed = true;
    let caughtUp: Promise<void> | null = null;
    const swapped = async () => (await sql(ws, "SELECT status FROM projection_builds WHERE object = 'lead' AND build_id = 2")).some((r) => r.status === "done");
    // After the list loads its build metadata, drop the field and wait until the rebuild swaps the view, before the list reads rows.
    const swapAfterMetadata = (c: DuckDBConnection) => new Proxy(c, {
      get(target, prop) {
        if (prop === "runAndReadAll") {
          return async (q: string, params?: Record<string, DuckDBValue>) => {
            const out = await target.runAndReadAll(q, params);
            if (armed && q.includes("projection_builds")) {
              armed = false;
              ledger.extensions.set(ws, { lead: { registryVersion: 2, customFields: [] } });
              caughtUp = ctx.app.projector.catchUp(ws);
              while (!(await swapped())) await new Promise((r) => setTimeout(r, 5));
            }
            return out;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    (w as { read: unknown }).read = <T>(fn: (c: DuckDBConnection) => Promise<T>) => read((c) => fn(swapAfterMetadata(c)));
    try {
      const r = await list(ws, "lead", { filter: [{ field: "custom.score", op: "gte", value: 1 }], sort: { field: "custom.score", dir: "asc" } });
      assert.equal(armed, false);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json.rows.map((row: { id: string; values: Record<string, unknown> }) => [row.id, row.values.cf_score]), [["v-2", 3], ["v-1", 7]]);
    } finally {
      delete (w as { read?: unknown }).read;
    }
    await caughtUp;
    assert.deepEqual(await sql(ws, "SELECT build_id AS b, status FROM projection_builds WHERE object = 'lead' ORDER BY build_id"), [{ b: 1, status: "replaced" }, { b: 2, status: "done" }]);
    assert.equal((await list(ws, "lead", { sort: { field: "custom.score", dir: "asc" } })).status, 400);
  });

  it("pages a sort on text longer than any filter value", async () => {
    const ws = "o9";
    const long = (c: string) => c.repeat(5000);
    ledger.set(ws, "lead", "t-1", { lastName: long("a") }, 9000);
    ledger.set(ws, "lead", "t-2", { lastName: long("b") }, 9001);
    ledger.set(ws, "lead", "t-3", { lastName: long("c") }, 9002);
    assert.equal((await nudge(ws)).status, 200);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await list(ws, "lead", { sort: { field: "recordTitle", dir: "asc" }, limit: 1, ...(cursor ? { cursor } : {}) });
      assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
      ids.push(...r.json.rows.map((row: { id: string }) => row.id));
      cursor = r.json.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(ids, ["t-1", "t-2", "t-3"]);
  });

  it("filters, sorts and pages on custom fields with a keyset cursor", async () => {
    const ws = "o4";
    ledger.extensions.set(ws, {
      lead: {
        registryVersion: 1,
        customFields: [
          { fieldId: "cf_score", apiName: "custom.score", label: "Score", type: "number" },
          { fieldId: "cf_tier", apiName: "custom.tier", label: "Tier", type: "picklist", options: TIER },
          { fieldId: "cf_tags", apiName: "custom.tags", label: "Tags", type: "multipicklist", options: [{ value: "a", label: "A", active: true }, { value: "b", label: "B", active: true }] },
        ] as never,
      },
    });
    const leads: Array<[string, number | null, string | null, string[] | null]> = [
      ["l-a", 30, "gold", ["a"]], ["l-b", 10, "gold", null], ["l-c", 50, "silver", ["a", "b"]], ["l-d", null, "gold", ["b"]],
      ["l-e", 30, "gold", null], ["l-f", null, "gold", null], ["l-g", 20, null, ["a"]],
    ];
    leads.forEach(([id, score, tier, tags], i) => ledger.set(ws, "lead", id, { lastName: id.toUpperCase(), cf_score: score, cf_tier: tier, cf_tags: tags }, 4000 + i));
    assert.equal((await nudge(ws)).status, 200);

    const body = { filter: [{ field: "custom.tier", op: "eq", value: "gold" }], sort: { field: "custom.score", dir: "desc" }, limit: 2 };
    const ids: string[][] = [];
    let cursor: string | undefined;
    const totals: number[] = [];
    do {
      const r = await list(ws, "lead", { ...body, ...(cursor ? { cursor } : {}) });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      ids.push(r.json.rows.map((row: { id: string }) => row.id));
      totals.push(r.json.total);
      cursor = r.json.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(ids, [["l-a", "l-e"], ["l-b", "l-d"], ["l-f"]]);
    assert.deepEqual(totals, [5, 5, 5]);

    const asc = await list(ws, "lead", { filter: [{ field: "custom.score", op: "gte", value: 20 }], sort: { field: "custom.score", dir: "asc" } });
    assert.deepEqual(asc.json.rows.map((r: { id: string }) => r.id), ["l-g", "l-a", "l-e", "l-c"]);
    const tags = await list(ws, "lead", { filter: [{ field: "custom.tags", op: "hasAny", value: ["b"] }], sort: { field: "id", dir: "asc" } });
    assert.deepEqual(tags.json.rows.map((r: { id: string }) => r.id), ["l-c", "l-d"]);
    const empty = await list(ws, "lead", { filter: [{ field: "custom.score", op: "empty" }], sort: { field: "id", dir: "desc" } });
    assert.deepEqual(empty.json.rows.map((r: { id: string }) => r.id), ["l-f", "l-d"]);
    const byId = await list(ws, "lead", { filter: [{ field: "id", op: "in", value: ["l-c", "l-a", "nope"] }], sort: { field: "id", dir: "asc" } });
    assert.deepEqual(byId.json.rows.map((r: { id: string }) => r.id), ["l-a", "l-c"]);

    assert.equal((await list(ws, "lead", { filter: [{ field: "custom.nope", op: "eq", value: 1 }] })).status, 400);
    assert.equal((await list(ws, "lead", { filter: [{ field: "custom.score", op: "contains", value: "3" }] })).status, 400);
    assert.equal((await list(ws, "lead", { sort: { field: "custom.tags", dir: "asc" } })).status, 400);
    assert.equal((await list(ws, "lead", { ...body, cursor: "bm9wZQ" })).status, 400);
  });

  it("lists deleted records only in the recycle bin", async () => {
    const ws = "o5";
    ledger.set(ws, "task", "t-keep", { subject: "Keep" }, 5000);
    ledger.set(ws, "task", "t-drop", { subject: "Drop" }, 5001);
    ledger.append(ws, "task", "t-drop", { kind: "lifecycle", op: "delete" }, 5002);
    assert.equal((await nudge(ws)).status, 200);
    assert.deepEqual((await list(ws, "task")).json.rows.map((r: { id: string }) => r.id), ["t-keep"]);
    const bin = (await list(ws, "task", { deleted: true })).json.rows;
    assert.deepEqual(bin.map((r: { id: string; status: string; deletedAt: number }) => [r.id, r.status, r.deletedAt]), [["t-drop", "deleted", 5002]]);

    ledger.append(ws, "task", "t-drop", { kind: "lifecycle", op: "restore" }, 5003);
    assert.equal((await nudge(ws)).status, 200);
    assert.deepEqual((await list(ws, "task", { sort: { field: "id", dir: "asc" } })).json.rows.map((r: { id: string }) => r.id), ["t-drop", "t-keep"]);
    assert.deepEqual((await list(ws, "task", { deleted: true })).json.rows, []);
  });

  it("searches titles across objects", async () => {
    const ws = "o6";
    ledger.set(ws, "lead", "s-1", { lastName: "Babbage" }, 6000);
    ledger.set(ws, "task", "s-2", { subject: "Email Babbage" }, 6001);
    ledger.set(ws, "product", "s-3", { name: "Cabbage" }, 6002);
    ledger.set(ws, "note", "s-4", { body: "unrelated" }, 6003);
    assert.equal((await nudge(ws)).status, 200);
    const r = await ctx.client.ws(ws).post("p/search", { q: "bbage" });
    assert.deepEqual(r.json.hits, [
      { object: "product", id: "s-3", title: "Cabbage", updatedAt: 6002 },
      { object: "task", id: "s-2", title: "Email Babbage", updatedAt: 6001 },
      { object: "lead", id: "s-1", title: "Babbage", updatedAt: 6000 },
    ]);
    const prefix = await ctx.client.ws(ws).post("p/search", { q: "BAB", objects: ["lead", "task"] });
    assert.deepEqual(prefix.json.hits.map((h: { id: string }) => h.id), ["s-1", "s-2"]);
  });

  it("lists an unprojected workspace as empty and refuses a nudge without a projector", async () => {
    const r = await list("never-seen", "lead");
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.rows, r.json.total, r.json.nextCursor], [[], 0, null]);
    const plain = await startApp();
    try {
      assert.equal((await plain.client.ws("o1").post("projector/nudge", {})).status, 503);
    } finally {
      await plain.app.shutdown();
    }
  });
});

describe("projector shutdown", () => {
  it("refuses nudges and returns within its deadline while a catch-up is running", async () => {
    const ledger = new FakeLedger();
    const sourceUrl = await ledger.listen();
    const ctx = await startApp({ projector: { sourceUrl, pollMs: 0, pageSize: 1 } });
    try {
      for (let i = 0; i < 40; i++) ledger.set("d1", "lead", `d-${i}`, { lastName: `L${i}` }, 12_000 + i);
      ledger.tailDelayMs = 50;
      assert.equal((await ctx.client.ws("d1").post("projector/nudge", {})).status, 200);
      while (ledger.requests < 3) await new Promise((r) => setTimeout(r, 10));

      const t0 = performance.now();
      const stopped = ctx.app.shutdown(300);
      await new Promise((r) => setTimeout(r, 20));
      const late = await ctx.client.ws("d1").post("projector/nudge", {}).catch(() => ({ status: "refused" }));
      await stopped;
      const ms = performance.now() - t0;
      assert.deepEqual({ lateNudgeRefused: late.status === 503 || late.status === "refused", withinDeadline: ms < 1000 }, { lateNudgeRefused: true, withinDeadline: true }, `late nudge ${late.status}, shutdown took ${Math.round(ms)} ms`);
    } finally {
      await ctx.app.shutdown();
      await ledger.close();
    }
  });
});

describe("projector with no configured ledger source", () => {
  const ledger = new FakeLedger();
  let ctx: Awaited<ReturnType<typeof startApp>>;
  before(async () => {
    ctx = await startApp({ projector: { pollMs: 0 } });
  });
  after(async () => {
    await ctx.app.shutdown();
    await ledger.close();
  });

  it("learns where the ledger is from Convex's nudge and pulls with the service's own token", async () => {
    const sourceUrl = await ledger.listen();
    ledger.set("o9", "lead", "lead-grace", { lastName: "Hopper" }, 1000);
    const ws = ctx.client.ws("o9");
    assert.equal((await ws.post("projector/nudge", { wait: true })).status, 503, "no source yet");
    assert.equal((await ws.post("projector/nudge", { wait: true, source: "http://convex.example.com" })).status, 400, "plain http off the loopback is refused");
    assert.equal((await ws.post("projector/nudge", { wait: true, source: sourceUrl })).status, 200);
    assert.deepEqual((await ws.post("p/lead/list", {})).json.rows.map((r: { id: string }) => r.id), ["lead-grace"]);

    await ctx.app.shutdown();
    ledger.set("o9", "lead", "lead-ada", { lastName: "Lovelace" }, 2000);
    ctx = await startApp({ dataDir: ctx.cfg.dataDir, projector: { pollMs: 0 } });
    assert.equal((await ctx.client.ws("o9").post("projector/nudge", { wait: true })).status, 200, "a restart remembers the source, so a nudge without one still pulls");
    assert.deepEqual((await ctx.client.ws("o9").post("p/lead/list", {})).json.rows.map((r: { id: string }) => r.id).sort(), ["lead-ada", "lead-grace"]);
  });
});
