import assert from "node:assert/strict";
import test from "node:test";
import { accessOf } from "../convex/lib/access.ts";
import { scopedRecordClient } from "../convex/lib/scopedRecordClient.ts";
import { createFakeRecordClient, createHttpRecordClient, createMemoryRecordStore } from "../convex/lib/recordClient.ts";

async function fixture() {
  const store = createMemoryRecordStore();
  await store.putAccounts("ws", ["hidden", "visible", "same-name"].map((id) => ({ id, name: id === "same-name" ? "Hidden company name" : `${id === "hidden" ? "Hidden" : "Visible"} company name`, domain: `${id}.example`, ownerId: id === "hidden" ? "peer" : "u", fit: 0, status: "new" as const, segmentIds: [], source: "test", updatedAt: 1, version: 1 })));
  await store.putContacts("ws", ["hidden", "visible", "same-name", "missing"].map((accountId, i) => ({ id: `person${i}`, fullName: `Visible person ${i}`, accountId, ownerId: "u", status: "new" as const, updatedAt: i })));
  const base = createFakeRecordClient({ store });
  const own = accessOf({ userId: "u", role: "rep", rules: [{ object: "account", visibility: "own", unowned: false }] });
  return { base, own };
}
const request = { q: "Visible", objects: ["contact"] };

test("search retains visible contacts and rank while admitting company names by caller access", async () => {
  const { base, own } = await fixture();
  const client = scopedRecordClient(base, [own], async () => null);
  const legacy = await base.searchObjects("ws", request);
  const result = await client.searchObjects("ws", { ...request, company: { fields: ["name"] } });
  assert.deepEqual(result.hits.map((h) => [h.id, h.title, h.updatedAt]), legacy.hits.map((h) => [h.id, h.title, h.updatedAt]));
  assert.deepEqual(result.hits.map((h) => h.detail?.company), [null, "Hidden company name", "Visible company name", null]);
  assert.deepEqual((await client.searchObjects("ws", { q: "Hidden company name", objects: ["contact"] })).hits, []);
});

test("every principal contributes account visibility and readable fields", async () => {
  const { base, own } = await fixture();
  const team = (userId: string, members: string[]) => accessOf({ userId, role: "rep", teams: [{ memberIds: members }], rules: [{ object: "account", visibility: "team", unowned: false }] });
  const intersection = scopedRecordClient(base, [team("u", ["u", "peer"]), team("agent", ["agent", "u"])], async () => null);
  assert.deepEqual((await intersection.searchObjects("ws", request)).hits.map((h) => h.detail?.company), [null, "Hidden company name", "Visible company name", null]);
  for (const rules of [[{ object: "account", fields: [{ apiName: "name", level: "hidden" as const }] }], [{ object: "account", read: false }], [{ object: "contact", fields: [{ apiName: "accountId", level: "hidden" as const }] }]]) {
    const limited = accessOf({ userId: "u", role: "rep", rules });
    for (const accesses of [[limited], [own, limited]]) {
      const hits = (await scopedRecordClient(base, accesses, async () => null).searchObjects("ws", request)).hits;
      assert.equal(hits.length, 4);
      assert.ok(hits.every((h) => h.detail?.company === null));
    }
  }
});

test("unrestricted and unrelated field restrictions preserve exact responses without added calls", async () => {
  const { base } = await fixture();
  for (const rules of [[], [{ object: "account", fields: [{ apiName: "fit", level: "hidden" as const }] }]]) {
    let searches = 0, lists = 0, health = 0;
    const counted = { ...base, mode: "http" as const, contractVersion: async () => { health++; return "1.51.0"; }, searchObjects: async (...args: Parameters<typeof base.searchObjects>) => { searches++; return base.searchObjects(...args); }, listRegister: async (...args: Parameters<typeof base.listRegister>) => { lists++; return base.listRegister(...args); } };
    const client = scopedRecordClient(counted, [accessOf({ userId: "u", role: "rep", rules })], async () => null);
    assert.deepEqual(await client.searchObjects("ws", request), await base.searchObjects("ws", request));
    assert.deepEqual({ searches, lists, health }, { searches: 1, lists: 0, health: 0 });
  }
});

test("old or unknown HTTP services never receive a restricted contact search that would leak", async () => {
  const { base, own } = await fixture();
  for (const version of ["1.51.0", null]) {
    let searches = 0, health = 0;
    const old = createHttpRecordClient({ baseUrl: "http://fake-service", token: "test", fetchImpl: async (input) => {
      if (String(input).endsWith("/healthz")) { health++; return new Response(JSON.stringify({ version }), { status: 200 }); }
      searches++;
      return new Response(JSON.stringify(await base.searchObjects("ws", request)), { status: 200 });
    } });
    const client = scopedRecordClient(old, [own], async () => null);
    for (const req of [request, { q: "Visible" }, { q: "Visible", objects: [] }]) await assert.rejects(() => client.searchObjects("ws", req));
    assert.deepEqual({ searches, health }, { searches: 0, health: 1 });
  }
});

test("supported HTTP searches carry caller predicates and cache the support check", async () => {
  const { base, own } = await fixture();
  let searches = 0, health = 0;
  const http = createHttpRecordClient({ baseUrl: "http://fake-service", token: "test", fetchImpl: async (input, init) => {
    if (String(input).endsWith("/healthz")) { health++; return new Response(JSON.stringify({ version: "1.52.0-build" }), { status: 200 }); }
    searches++;
    const req = JSON.parse(String(init?.body));
    assert.deepEqual(req.company, { scope: { field: "ownerId", owners: ["u"], unowned: false }, fields: ["name"] });
    return new Response(JSON.stringify(await base.searchObjects("ws", req)), { status: 200 });
  } });
  const client = scopedRecordClient(http, [own], async () => null);
  for (let i = 0; i < 2; i++) assert.deepEqual((await client.searchObjects("ws", request)).hits.map((h) => h.detail?.company), [null, "Hidden company name", "Visible company name", null]);
  assert.deepEqual({ searches, health }, { searches: 2, health: 1 });
});

test("searches excluding contacts keep working on old services without a company support check", async () => {
  const { base, own } = await fixture();
  let health = 0, searches = 0;
  const old = { ...base, mode: "http" as const, contractVersion: async () => { health++; return "1.51.0"; }, searchObjects: async (...args: Parameters<typeof base.searchObjects>) => { searches++; assert.equal(args[1].company, undefined); return base.searchObjects(...args); } };
  const result = await scopedRecordClient(old, [own], async () => null).searchObjects("ws", { q: "Visible", objects: ["account", "deal"] });
  assert.deepEqual(result.hits.map((h) => h.id), ["visible"]);
  assert.deepEqual({ health, searches }, { health: 0, searches: 1 });
});
