import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  accountNamesFor,
  atLeastVersion,
  createFakeRecordClient,
  createHttpRecordClient,
  createMemoryRecordStore,
  generatePdlSample,
  recordClient,
} from "../convex/lib/recordClient.ts";
import { AccountsListRequest, EditRequest } from "../convex/lib/recordContract.ts";

const fixtureUrl = new URL("./fixtures/pdl-sample.json", import.meta.url);

test("a fenced module report requires the service's matching readiness receipt, while legacy reports remain compatible", async () => {
  const projection = { packageId: "package", epoch: 2, generation: 3, collections: ["visits"] };
  const result = { groups: [], subtotals: [], total: [0], rows: 0, truncated: false, projectedThrough: {} };
  let echo: unknown;
  const http = createHttpRecordClient({ baseUrl: "https://rs.test", token: "fixture", fetchImpl: (async () => Response.json({ ...result, ...(echo ? { projection: echo } : {}) })) as typeof fetch });
  const request = { module: "@canon/visits", collection: "visits", fields: [{ name: "status", label: "Status", type: "text" as const }], docScope: null, measures: [{ fn: "count" as const }] };
  assert.equal((await http.moduleAggregate("ws", request)).rows, 0);
  await assert.rejects(http.moduleAggregate("ws", { ...request, projection }), /projection receipts/);
  echo = { ...projection, generation: 2 };
  await assert.rejects(http.moduleAggregate("ws", { ...request, projection }), /projection receipts/);
  echo = projection;
  assert.equal((await http.moduleAggregate("ws", { ...request, projection })).rows, 0);
});

test("pdl fixture is the generator's deterministic, clearly-synthetic output", () => {
  const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  const generated = generatePdlSample();
  assert.equal(fixture.length, generated.length);
  assert.ok(fixture.length >= 2000);
  assert.deepEqual(fixture, generated);
  for (const company of fixture.slice(0, 200)) {
    assert.match(company.website, /\.example$/);
    assert.deepEqual(Object.keys(company).sort(), ["country", "founded", "id", "industry", "linkedin_url", "locality", "name", "region", "size", "website"]);
  }
  assert.equal(new Set(fixture.map((c: { website: string }) => c.website)).size, fixture.length);
});

function seeded() {
  let t = 1_000;
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => ++t });
  return client;
}

test("the fake stays below the projection-receipt contract and refuses stamped work", async () => {
  const client = seeded();
  const version = await client.contractVersion();
  assert.equal(atLeastVersion(version, "1.42.0"), true);
  assert.equal(atLeastVersion(version, "1.43.0"), false);
  const legacy = await client.moduleSync("ws", { module: "visits", upserts: [], deletes: [] });
  assert.deepEqual(legacy, { at: 1001, upserted: 0, deleted: 0 });
  const projection = { packageId: "package1", epoch: 1, generation: 1, collections: ["visits"] };
  await assert.rejects(client.moduleSync("ws", {
    module: "visits", upserts: [], deletes: [], projection,
    work: { kind: "rebuild", collection: "visits", job: "job1", seq: 1, complete: true },
  }), /projection receipts/);
  await assert.rejects(client.moduleAggregate("ws", {
    module: "visits", collection: "visits", fields: [], docScope: null,
    measures: [{ fn: "count" }], projection,
  }), /keeps no module docs/);
});

test("fake client: upsert, filter, sort and cursor paging", async () => {
  const client = seeded();
  const shared = await client.searchShared({ industry: ["computer software"], country: ["united states"] }, 500);
  assert.ok(shared.total > 50);
  assert.ok(shared.rows.every((r) => r.industry === "computer software" && r.country === "united states"));
  const records = shared.rows.slice(0, 120).map((r, i) => ({ ...r, fit: (i % 10) / 10, segmentIds: [i % 2 ? "odd" : "even"] }));
  const up = await client.upsertAccounts("ws1", { records, source: "pdl", idempotencyKey: "k1" });
  assert.equal(up.upserted, 120);
  const again = await client.upsertAccounts("ws1", { records, source: "pdl", idempotencyKey: "k1" });
  assert.deepEqual(again, up);

  const seen = new Set<string>();
  let cursor: string | undefined;
  let lastFit = Infinity;
  do {
    const page = await client.list("ws1", { filter: { segmentId: "even" }, sort: { field: "fit", dir: "desc" }, limit: 25, cursor });
    assert.equal(page.total, 60);
    for (const row of page.rows) {
      assert.ok(row.fit <= lastFit);
      lastFit = row.fit;
      assert.ok(!seen.has(row.id));
      seen.add(row.id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.size, 60);
  assert.equal((await client.countSegment("ws1", { minFit: 0.5 })).total, 60);
  assert.equal((await client.list("ws2", {})).total, 0, "workspaces are isolated");
});

test("fake client: edits version the row, write history, and keep triage across re-import", async () => {
  const client = seeded();
  const [row] = (await client.searchShared({}, 1)).rows;
  const { ids } = await client.upsertAccounts("ws", { records: [{ ...row, fit: 0.9 }], source: "pdl", idempotencyKey: "a" });
  const id = ids[0];
  const r1 = await client.edit("ws", { object: "account", id, patch: { status: "working", employees: "42" }, actorId: "u1", idempotencyKey: "e1" });
  assert.equal(r1.version, 2);
  await assert.rejects(client.edit("ws", { object: "account", id, patch: { fit: 1 }, actorId: "u1", idempotencyKey: "e2" }), /not editable/);
  await assert.rejects(client.edit("ws", { object: "account", id, patch: { status: "bogus" }, actorId: "u1", idempotencyKey: "e3" }), /status must be/);
  const detail = await client.get("ws", id);
  assert.equal(detail?.account.status, "working");
  assert.equal(detail?.account.employees, 42);
  assert.deepEqual(detail?.history.map((h) => h.field).sort(), ["employees", "status"]);
  await client.upsertAccounts("ws", { records: [{ ...row, fit: 0.3 }], source: "pdl", idempotencyKey: "b" });
  const after = await client.get("ws", id);
  assert.equal(after?.account.status, "working", "re-import must not clobber user triage");
  assert.equal(after?.account.fit, 0.3);
});

test("fake client: contacts attach to accounts by domain", async () => {
  const client = seeded();
  const [row] = (await client.searchShared({}, 1)).rows;
  await client.upsertAccounts("ws", { records: [row], source: "pdl", idempotencyKey: "a" });
  await client.upsertContacts("ws", { records: [{ accountDomain: row.domain, fullName: "Test Person", title: "VP Sales" }], source: "pipe0", idempotencyKey: "c" });
  const contacts = await client.listContacts("ws", { filter: { q: "vp" } });
  assert.equal(contacts.total, 1);
  const detail = await client.get("ws", contacts.rows[0].accountId);
  assert.equal(detail?.contacts[0].fullName, "Test Person");
});

test("recordClient picks HTTP when RECORD_SERVICE_URL is set and sends workspace auth headers", async () => {
  assert.equal(recordClient({ env: {} }).mode, "fake");
  assert.throws(() => recordClient({ env: { RECORD_SERVICE_URL: "https://rs.test" } }), /RECORD_SERVICE_TOKEN/);
  const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    if (url.endsWith("/accounts/get")) return new Response("{}", { status: 404 });
    return Response.json({ rows: [], nextCursor: null, total: 0 });
  }) as unknown as typeof fetch;
  const client = recordClient({ env: { RECORD_SERVICE_URL: "https://rs.test/", RECORD_SERVICE_TOKEN: "tok" }, fetchImpl });
  assert.equal(client.mode, "http");
  await client.list("org 1", { limit: 5 });
  assert.equal(seen[0].url, "https://rs.test/v1/workspaces/org%201/accounts/list");
  assert.equal(seen[0].headers.get("authorization"), "Bearer tok");
  assert.equal(seen[0].headers.get("x-workspace-id"), "org 1");
  assert.equal(await client.get("org 1", "missing"), null);
  const http = createHttpRecordClient({ baseUrl: "https://rs.test", token: "tok", fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch });
  await assert.rejects(http.provision("w"), /HTTP 500/);
});

test("http searchShared clamps to the service's 200-row cap and sends only searchable filter keys", async () => {
  let body: Record<string, unknown> = {};
  const http = createHttpRecordClient({
    baseUrl: "https://rs.test",
    token: "tok",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ rows: [], total: 0 }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await http.searchShared({ industry: ["x"], status: "new", minFit: 3 }, 1000);
  assert.equal(body.limit, 200);
  assert.deepEqual(Object.keys(body.filter as object), ["industry"]);
});

test("contract schemas validate request bodies", () => {
  assert.ok(AccountsListRequest.safeParse({ limit: 50, sort: { field: "fit", dir: "desc" } }).success);
  assert.ok(!AccountsListRequest.safeParse({ limit: 500 }).success);
  assert.ok(!EditRequest.safeParse({ object: "deal", id: "x", patch: {}, actorId: "u", idempotencyKey: "k" }).success);
});

test("fake client: an edit replayed under its idempotency key returns its first response and does not re-apply", async () => {
  const client = seeded();
  const [row] = (await client.searchShared({}, 1)).rows;
  const { ids } = await client.upsertAccounts("ws", { records: [row], source: "pdl", idempotencyKey: "a" });
  const edit = (industry: string, idempotencyKey: string) => client.edit("ws", { object: "account", id: ids[0], patch: { industry }, actorId: "u1", idempotencyKey });
  const first = await edit("Edit A", "kA");
  await edit("Edit B", "kB");
  const replay = await edit("Edit A", "kA");
  assert.deepEqual(replay, first);
  assert.equal(typeof first.at, "number", "the response carries the operation's time, so the ledger can order a replay");
  assert.equal((await client.get("ws", ids[0]))?.account.industry, "Edit B");
});

test("fake client: getContact reads one contact by id", async () => {
  const client = seeded();
  const [row] = (await client.searchShared({}, 1)).rows;
  await client.upsertAccounts("ws", { records: [row], source: "pdl", idempotencyKey: "a" });
  const { ids } = await client.upsertContacts("ws", { records: [{ accountDomain: row.domain, fullName: "Ada Lovelace", email: "ada@x.example" }], source: "pipe0", idempotencyKey: "c" });
  const contact = await client.getContact("ws", ids[0]);
  assert.deepEqual([contact?.id, contact?.fullName, contact?.email], [ids[0], "Ada Lovelace", "ada@x.example"]);
  assert.equal(await client.getContact("ws", "con_missing"), null);
  assert.equal(await client.getContact("other", ids[0]), null, "workspaces are isolated");
});

test("fake client: listRegister lists accounts and contacts with the generic list request, fit on the service's 0-100 scale", async () => {
  const client = seeded();
  await client.upsertAccounts("ws1", {
    records: [
      { domain: "a.example", name: "Alpha", industry: "Retail", employees: 10, fit: 0.9 },
      { domain: "b.example", name: "Beta", industry: "", employees: 20, fit: 0.4 },
      { domain: "c.example", name: "Gamma", industry: "Retail", employees: 30, fit: 0.7 },
    ],
    source: "pdl", idempotencyKey: "k1",
  });
  await client.upsertContacts("ws1", { records: [{ accountDomain: "a.example", fullName: "Ada Lee", email: "ada@a.example" }], source: "pdl", idempotencyKey: "k2" });
  const req = { filter: [{ field: "industry", op: "notEmpty" as const }], sort: { field: "fit", dir: "desc" as const }, limit: 1 };
  const page = await client.listRegister("ws1", "account", req);
  assert.equal(page.total, 2);
  assert.deepEqual(page.rows.map((r) => [r.title, r.stream, r.values.fit]), [["Alpha", null, 90]]);
  const rest = await client.listRegister("ws1", "account", { ...req, cursor: page.nextCursor! });
  assert.deepEqual(rest.rows.map((r) => r.title), ["Gamma"]);
  const contacts = await client.listRegister("ws1", "contact", { filter: [{ field: "email", op: "contains", value: "ada" }] });
  assert.deepEqual(contacts.rows.map((r) => r.title), ["Ada Lee"]);
});

test("http getContact posts to contacts/get and returns the contact, or null on 404", async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const http = createHttpRecordClient({
    baseUrl: "https://rs.test",
    token: "tok",
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: string };
      seen.push({ url, body });
      if (body.id === "con_missing") return new Response(JSON.stringify({ error: "contact not found" }), { status: 404 });
      return Response.json({ contact: { id: body.id, accountId: "acc_x", fullName: "Ada", status: "new", updatedAt: 1 } });
    }) as unknown as typeof fetch,
  });
  assert.equal((await http.getContact("ws", "con_1"))?.fullName, "Ada");
  assert.equal(await http.getContact("ws", "con_missing"), null);
  assert.deepEqual(seen[0], { url: "https://rs.test/v1/workspaces/ws/contacts/get", body: { id: "con_1" } });
});

test("fake client: `at` follows the order edits were applied, strictly increasing, whatever the callers stamped", async () => {
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), now: () => 5_000 });
  const { ids } = await client.upsertAccounts("ws", { records: [{ domain: "order.example", name: "Order" }], source: "pdl", idempotencyKey: "a" });
  const edit = (industry: string, idempotencyKey: string, sourceTimestamp?: number) =>
    client.edit("ws", { object: "account", id: ids[0], patch: { industry }, actorId: "u1", idempotencyKey, ...(sourceTimestamp ? { sourceTimestamp } : {}) });
  const b = await edit("Edit B", "kB", 101);
  const a = await edit("Edit A", "kA", 100);
  const c = await edit("Edit C", "kC");
  assert.deepEqual([b.at, a.at, c.at], [5_000, 5_001, 5_002], "one clock reading, three edits: each later than the last");
  assert.equal((await edit("Edit A", "kA", 999)).at, 5_001, "a replay answers with the first at");
});

test("fake client: reusing an idempotency key with a different patch is rejected and applies nothing", async () => {
  const client = seeded();
  const { ids } = await client.upsertAccounts("ws", { records: [{ domain: "reuse.example", name: "Reuse" }], source: "pdl", idempotencyKey: "a" });
  const edit = (industry: string) => client.edit("ws", { object: "account", id: ids[0], patch: { industry }, actorId: "u1", idempotencyKey: "k" });
  const first = await edit("Edit A");
  await assert.rejects(edit("Edit B"), /idempotency key k was already used for a different request/);
  assert.equal((await client.get("ws", ids[0]))?.account.industry, "Edit A");
  assert.deepEqual(await edit("Edit A"), first);
});

test("http edit surfaces the service's 409 for a reused idempotency key as an error", async () => {
  const http = createHttpRecordClient({
    baseUrl: "https://rs.test",
    token: "tok",
    fetchImpl: (async () => new Response(JSON.stringify({ error: "idempotency key k was already used for a different request" }), { status: 409 })) as unknown as typeof fetch,
  });
  await assert.rejects(http.edit("ws", { object: "account", id: "acc_x", patch: { industry: "B" }, actorId: "u1", idempotencyKey: "k" }), /HTTP 409 .*already used for a different request/);
});

test("http client provisions a workspace the service doesn't have yet, then retries once", async () => {
  const calls: string[] = [];
  let provisioned = false;
  const fetchImpl = (async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith("/provision")) {
      provisioned = true;
      return Response.json({ created: true });
    }
    if (!provisioned) return Response.json({ error: "workspace not provisioned" }, { status: 404 });
    if (path.endsWith("/accounts/get")) return Response.json({ error: "account not found" }, { status: 404 });
    return Response.json({ groups: [], total: 0 });
  }) as unknown as typeof fetch;
  const client = createHttpRecordClient({ baseUrl: "http://rs", token: "t", fetchImpl });
  const facets = await client.facets("org_1", { groupBy: "industry" });
  assert.deepEqual(facets, { groups: [], total: 0 });
  assert.deepEqual(calls, ["/v1/workspaces/org_1/accounts/facets", "/v1/workspaces/org_1/provision", "/v1/workspaces/org_1/accounts/facets"]);

  // An ordinary 404 keeps its meaning: no such record, and no provisioning.
  calls.length = 0;
  assert.equal(await client.get("org_1", "acc_missing"), null);
  assert.deepEqual(calls, ["/v1/workspaces/org_1/accounts/get"]);
});

test("http client does not loop when provisioning itself fails", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n++;
    return Response.json({ error: "workspace not provisioned" }, { status: 404 });
  }) as unknown as typeof fetch;
  const client = createHttpRecordClient({ baseUrl: "http://rs", token: "t", fetchImpl });
  await assert.rejects(client.facets("org_1", { groupBy: "industry" }), /HTTP 404/);
  assert.ok(n <= 3, `bounded retries, got ${n}`);
});

test("accountNamesFor skips contacts that have no account instead of looking up an empty id", async () => {
  const looked: string[] = [];
  const get = async (_ws: string, id: string) => (looked.push(id), id === "a1" ? ({ account: { name: "Acme" } } as never) : null);
  assert.deepEqual(await accountNamesFor({ get }, "ws", ["a1", "", "a1", "gone"]), { a1: "Acme" });
  assert.deepEqual(looked, ["a1", "gone"]);
});
