// Record visibility (CP14, contract 1.29.0): a scope keeps another owner's
// records out of every read the service answers: lists, the register, search,
// reports and the legacy account and contact lists.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { FakeLedger } from "./ledgerFake.ts";
import { startApp } from "./helpers.ts";

describe("record visibility scopes", () => {
  const ledger = new FakeLedger();
  let ctx: Awaited<ReturnType<typeof startApp>>;
  const w = "cp14";
  const mine = { field: "ownerId", owners: ["u_avery"], unowned: false };

  before(async () => {
    const sourceUrl = await ledger.listen();
    ctx = await startApp({ projector: { sourceUrl, pollMs: 0, pageSize: 50, rebuildChunk: 50 } });
    const ws = ctx.client.ws(w);
    await ws.post("provision");
    const up = await ws.post("accounts/upsert", {
      records: [{ domain: "atlas.example", name: "Atlas" }, { domain: "boreal.example", name: "Boreal" }, { domain: "cove.example", name: "Cove" }],
      source: "pdl", idempotencyKey: "v1",
    });
    const [atlas, boreal] = up.json.ids as string[];
    await ws.post("records/edit", { object: "account", id: atlas, patch: { ownerId: "u_avery" }, actorId: "u", idempotencyKey: "e1" });
    await ws.post("records/edit", { object: "account", id: boreal, patch: { ownerId: "u_jordan" }, actorId: "u", idempotencyKey: "e2" });
    const deal = { currency: "USD", dealType: "new_business", isWon: false, isClosed: false, stage: "proposal", closeDate: "2026-11-01" };
    ledger.set(w, "deal", "d_avery", { ...deal, name: "Atlas expansion", amount: 100, ownerId: "u_avery" }, 1000);
    ledger.set(w, "deal", "d_jordan", { ...deal, name: "Atlas add-on", amount: 900, ownerId: "u_jordan" }, 1001);
    ledger.set(w, "deal", "d_none", { ...deal, name: "Atlas pilot", amount: 50 }, 1002);
    assert.equal((await ws.post("projector/nudge", { wait: true })).status, 200);
  });
  after(async () => {
    await ctx.app.shutdown();
    await ledger.close();
  });

  const post = async (path: string, body: unknown) => {
    const r = await ctx.client.ws(w).post(path, body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  const titles = (rows: Array<{ title?: string; name?: string }>) => rows.map((r) => r.title ?? r.name).sort();

  it("lists only the scope's records, with totals to match, on projections, the register and the legacy lists", async () => {
    assert.deepEqual(titles((await post("p/deal/list", { scope: mine })).rows), ["Atlas expansion"]);
    assert.equal((await post("p/deal/list", { scope: mine })).total, 1);
    assert.deepEqual(titles((await post("p/deal/list", { scope: { ...mine, unowned: true } })).rows), ["Atlas expansion", "Atlas pilot"]);
    // An id scope names the records themselves (a deal's owner lives on its Convex row).
    assert.deepEqual(titles((await post("p/deal/list", { scope: { field: "id", owners: ["d_jordan"], unowned: false } })).rows), ["Atlas add-on"]);
    assert.deepEqual(titles((await post("register/account/list", { scope: mine })).rows), ["Atlas"]);
    assert.deepEqual(titles((await post("accounts/list", { filter: { scope: mine } })).rows), ["Atlas"]);
    assert.deepEqual(titles((await post("p/deal/list", { scope: { ...mine, owners: [] } })).rows), [], "no owners and no unowned: nothing");
  });

  it("finds only the scope's records in search, other objects untouched", async () => {
    const hits = (await post("p/search", { q: "atlas", scopes: { deal: mine, account: { ...mine, owners: ["u_jordan"] } } })).hits as Array<{ object: string; title: string }>;
    assert.deepEqual(hits.map((h) => `${h.object}:${h.title}`).sort(), ["deal:Atlas expansion"]);
  });

  it("counts only the scope's records in a report", async () => {
    const r = await post("p/deal/aggregate", { measures: [{ fn: "count" }, { fn: "sum", field: "amount" }], scope: mine });
    assert.deepEqual(r.total, [1, 100]);
  });

  it("finds duplicates only among the scope's records, so a group never names a hidden one", async () => {
    const ws = ctx.client.ws(w);
    const li = "https://www.linkedin.com/company/delta";
    const up = await ws.post("accounts/upsert", { records: [{ domain: "delta.example", name: "Delta", linkedinUrl: li }, { domain: "deltahq.example", name: "Delta HQ", linkedinUrl: li }], source: "pdl", idempotencyKey: "v2" });
    const [mineId, theirsId] = up.json.ids as string[];
    await ws.post("records/edit", { object: "account", id: mineId, patch: { ownerId: "u_avery" }, actorId: "u", idempotencyKey: "e3" });
    await ws.post("records/edit", { object: "account", id: theirsId, patch: { ownerId: "u_jordan" }, actorId: "u", idempotencyKey: "e4" });
    assert.equal((await post("register/account/duplicates", {})).total, 1);
    assert.equal((await post("register/account/duplicates", { scope: mine })).total, 0);
  });

  it("refuses a scope an older client could misread", async () => {
    assert.equal((await ctx.client.ws(w).post("p/deal/list", { scope: { field: "ownerId", owners: ["u"] } })).status, 400);
    assert.equal((await ctx.client.ws(w).post("accounts/list", { filter: { scope: { field: "name", owners: ["u"], unowned: false } } })).status, 400);
  });
});
