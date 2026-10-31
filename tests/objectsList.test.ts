import assert from "node:assert/strict";
import test from "node:test";
import { foldAll, type EntryBody, type LedgerEntry } from "../convex/lib/objects/fold.ts";
import { compileListRequest, decodeCursor, ListRequestError, listRowOf, listRowsInMemory, searchRowsInMemory, type ListRequest, type ListRow } from "../convex/lib/objects/listSpec.ts";
import { plainObjectDef, resolveObjectDef, STANDARD_OBJECTS, type FieldId, type OrgObjectExtension } from "../convex/lib/objects/registry.ts";
import { createFakeRecordClient, createHttpRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";

const TIER = [{ value: "gold", label: "Gold", active: true }, { value: "silver", label: "Silver", active: true }];
const ext: OrgObjectExtension = {
  registryVersion: 1,
  customFields: [
    { fieldId: "cf_score" as FieldId, apiName: "custom.score", label: "Score", type: "number" },
    { fieldId: "cf_tier" as FieldId, apiName: "custom.tier", label: "Tier", type: "picklist", options: TIER },
    { fieldId: "cf_tags" as FieldId, apiName: "custom.tags", label: "Tags", type: "multipicklist", options: [{ value: "a", label: "A", active: true }, { value: "b", label: "B", active: true }] },
  ],
};
const lead = resolveObjectDef(STANDARD_OBJECTS.lead, ext);
const task = resolveObjectDef(STANDARD_OBJECTS.task);

function rowFrom(def: typeof lead, streamId: string, at: number, values: Record<string, unknown>, extra: EntryBody[] = []): ListRow {
  const bodies: EntryBody[] = [
    { kind: "assert", status: "accepted", assertions: Object.entries(values).map(([fieldId, value]) => ({ fieldId: fieldId as FieldId, value: value as never })) },
    ...extra,
  ];
  const entries: LedgerEntry[] = bodies.map((body, i) => ({ streamId, version: i + 1, observedAt: at + i, source: { kind: "user", ref: "user:u1" }, actor: { kind: "user", id: "u1" }, body }));
  return listRowOf(def, foldAll(entries)!);
}

// The same records and expectations as services/record-service/test/projector.test.ts, so the fake and the service agree.
const leads: ListRow[] = ([
  ["l-a", 30, "gold", ["a"]], ["l-b", 10, "gold", null], ["l-c", 50, "silver", ["a", "b"]], ["l-d", null, "gold", ["b"]],
  ["l-e", 30, "gold", null], ["l-f", null, "gold", null], ["l-g", 20, null, ["a"]],
] as const).map(([id, score, tier, tags], i) => rowFrom(lead, id, 4000 + i, { lastName: id.toUpperCase(), cf_score: score, cf_tier: tier, cf_tags: tags }));

const ids = (rows: readonly ListRow[]) => rows.map((r) => r.id);
const through = {};

function pages(req: ListRequest): string[][] {
  const out: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = listRowsInMemory(lead, leads, { ...req, ...(cursor ? { cursor } : {}) }, through);
    out.push(ids(page.rows));
    assert.equal(page.total, 5);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

test("keyset pages on a custom field put empty cells last and keep the page-1 total", () => {
  assert.deepEqual(pages({ filter: [{ field: "custom.tier", op: "eq", value: "gold" }], sort: { field: "custom.score", dir: "desc" }, limit: 2 }), [["l-a", "l-e"], ["l-b", "l-d"], ["l-f"]]);
});

test("filters by type: ranges, multi-select membership, empty, and id lookups", () => {
  const list = (req: ListRequest) => ids(listRowsInMemory(lead, leads, req, through).rows);
  assert.deepEqual(list({ filter: [{ field: "custom.score", op: "gte", value: 20 }], sort: { field: "custom.score", dir: "asc" } }), ["l-g", "l-a", "l-e", "l-c"]);
  assert.deepEqual(list({ filter: [{ field: "custom.tags", op: "hasAny", value: ["b"] }], sort: { field: "id", dir: "asc" } }), ["l-c", "l-d"]);
  assert.deepEqual(list({ filter: [{ field: "custom.tags", op: "hasAll", value: ["a", "b"] }] }), ["l-c"]);
  assert.deepEqual(list({ filter: [{ field: "custom.score", op: "empty" }], sort: { field: "id", dir: "desc" } }), ["l-f", "l-d"]);
  assert.deepEqual(list({ filter: [{ field: "id", op: "in", value: ["l-c", "l-a", "nope"] }], sort: { field: "id", dir: "asc" } }), ["l-a", "l-c"]);
  assert.deepEqual(list({ filter: [{ field: "custom.tier", op: "neq", value: "gold" }], sort: { field: "id", dir: "asc" } }), ["l-c", "l-g"]);
  assert.deepEqual(list({ filter: [{ field: "recordTitle", op: "startsWith", value: "L-A" }] }), ["l-a"]);
});

test("rejects what the service rejects", () => {
  const reject = (req: ListRequest, message: string) => assert.throws(() => compileListRequest(lead, req), (e: unknown) => e instanceof ListRequestError && e.message === message);
  reject({ filter: [{ field: "custom.nope", op: "eq", value: 1 }] }, "unknown field custom.nope");
  reject({ filter: [{ field: "custom.score", op: "contains", value: "3" }] }, "custom.score cannot be filtered with contains");
  reject({ filter: [{ field: "custom.score", op: "eq", value: "3" }] }, "custom.score eq must be a number");
  reject({ sort: { field: "custom.tags", dir: "asc" } }, "custom.tags is a multi-select and cannot be sorted on");
  reject({ limit: 201 }, "limit must be 1 to 200");
  assert.throws(() => compileListRequest(task, { filter: [{ field: "dueDate", op: "eq", value: "2026-02-30" }] }), (e: unknown) => e instanceof ListRequestError && e.message === "dueDate eq must be a date (YYYY-MM-DD)", "a day that does not exist");
  assert.doesNotThrow(() => compileListRequest(task, { filter: [{ field: "dueDate", op: "eq", value: "2028-02-29" }] }), "a leap day exists");
  reject({ cursor: "bm9wZQ" }, "invalid cursor");
  const other = listRowsInMemory(lead, leads, { sort: { field: "custom.score", dir: "desc" }, limit: 1 }, through).nextCursor!;
  reject({ sort: { field: "custom.score", dir: "asc" }, cursor: other }, "cursor belongs to a different query");
  assert.equal(decodeCursor(other).total, 7);
});

test("a cursor on a text value longer than a filter value pages on", () => {
  const rows = ["a", "b", "c"].map((c, i) => rowFrom(lead, `t-${c}`, 9000 + i, { lastName: c.repeat(513) }));
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = listRowsInMemory(lead, rows, { sort: { field: "recordTitle", dir: "asc" }, limit: 1, ...(cursor ? { cursor } : {}) }, through);
    out.push(...ids(page.rows));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(out, ["t-a", "t-b", "t-c"]);
  assert.throws(() => compileListRequest(lead, { filter: [{ field: "recordTitle", op: "eq", value: "a".repeat(513) }] }), (e: unknown) => e instanceof ListRequestError && e.message === "recordTitle eq must be text of at most 512 characters");
});

test("deleted records appear only in the recycle bin, and search skips them", () => {
  const rows = [
    rowFrom(task, "t-keep", 5000, { subject: "Keep Babbage" }),
    rowFrom(task, "t-drop", 5001, { subject: "Drop Babbage" }, [{ kind: "lifecycle", op: "delete" }]),
  ];
  assert.deepEqual(ids(listRowsInMemory(task, rows, {}, through).rows), ["t-keep"]);
  const bin = listRowsInMemory(task, rows, { deleted: true }, through).rows;
  assert.deepEqual(bin.map((r) => [r.id, r.status, r.deletedAt]), [["t-drop", "deleted", 5002]]);
  assert.deepEqual(searchRowsInMemory(rows, { q: "babbage" }, through).hits, [{ object: "task", id: "t-keep", title: "Keep Babbage", updatedAt: 5000 }]);
});

test("the fake record client lists and searches through its object source, with all 16 shards in projectedThrough", async () => {
  const client = createFakeRecordClient({
    store: createMemoryRecordStore(),
    objects: { rows: async (_ws, objects) => ({ rows: leads.filter((r) => !objects || objects.includes(r.object)), defs: [plainObjectDef(lead)], heads: { "3": 12 } }) },
  });
  const page = await client.listObjects("org1", "lead", { filter: [{ field: "custom.tier", op: "eq", value: "silver" }] });
  assert.deepEqual(ids(page.rows), ["l-c"]);
  assert.deepEqual(page.rows[0].values, { firstName: null, lastName: "L-C", company: null, title: null, email: null, phone: null, status: null, leadSource: null, ownerId: null, convertedAt: null, convertedAccountId: null, convertedContactId: null, convertedDealId: null, cf_score: 50, cf_tier: "silver", cf_tags: ["a", "b"] });
  assert.equal(Object.keys(page.projectedThrough).length, 16);
  assert.deepEqual([page.projectedThrough["3"], page.projectedThrough["4"]], [12, 0]);
  assert.deepEqual((await client.searchObjects("org1", { q: "l-g" })).hits.map((h) => h.id), ["l-g"]);
  await assert.rejects(client.listObjects("org1", "lead", { sort: { field: "nope", dir: "asc" } }), ListRequestError);
  assert.deepEqual((await client.listObjects("org1", "task", {})).rows, []);
});

test("the HTTP client turns the service's 400 into the same ListRequestError", async () => {
  const calls: string[] = [];
  const client = createHttpRecordClient({
    baseUrl: "http://rs.test", token: "t".repeat(20),
    fetchImpl: (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ error: "unknown field custom.nope" }), { status: 400 });
    }) as unknown as typeof fetch,
  });
  await assert.rejects(client.listObjects("org1", "lead", { filter: [{ field: "custom.nope", op: "eq", value: 1 }] }), (e: unknown) => e instanceof ListRequestError && e.message === "unknown field custom.nope");
  assert.deepEqual(calls, ["http://rs.test/v1/workspaces/org1/p/lead/list"]);
});
