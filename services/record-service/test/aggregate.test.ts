// Reports (CP9, src/aggregate.ts): the SQL answers what the shared semantics
// (src/core/objects/reportSpec.ts) compute in memory over the same list rows,
// including a key on a related company and a date bucket.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { aggregateRowsInMemory, compileAggregateRequest, type AggregateRequest } from "../src/core/objects/reportSpec.ts";
import { indexObjectDef, resolveObjectDef, STANDARD_OBJECTS } from "../src/core/objects/registry.ts";
import { registerListDef, type ListRow } from "../src/core/objects/listSpec.ts";
import { FakeLedger } from "./ledgerFake.ts";
import { startApp } from "./helpers.ts";

describe("report aggregates", () => {
  const ledger = new FakeLedger();
  let ctx: Awaited<ReturnType<typeof startApp>>;
  const w = "cp9";

  before(async () => {
    const sourceUrl = await ledger.listen();
    ctx = await startApp({ projector: { sourceUrl, pollMs: 0, pageSize: 50, rebuildChunk: 50 } });
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

  it("groups deals by stage, by their company's industry and by close month, as the list rows add up", async () => {
    assert.equal((await ctx.client.ws(w).post("provision")).status, 200);
    const up = await post("accounts/upsert", {
      records: [{ domain: "atlas.example", name: "Atlas", industry: "Software" }, { domain: "boreal.example", name: "Boreal", industry: "Retail" }, { domain: "cove.example", name: "Cove" }],
      source: "pdl", idempotencyKey: "cp9",
    });
    const [atlas, boreal] = up.ids as string[];
    const deal = { currency: "USD", dealType: "new_business", isWon: false };
    ledger.set(w, "deal", "d1", { ...deal, name: "One", amount: 100_000, probability: 0.2, stage: "discovery", isClosed: false, closeDate: "2026-01-05", companyId: atlas }, 1000);
    ledger.set(w, "deal", "d2", { ...deal, name: "Two", amount: 250_000, stage: "discovery", isClosed: false, closeDate: "2026-01-20", companyId: boreal }, 1001);
    ledger.set(w, "deal", "d3", { ...deal, name: "Three", amount: 400_000, probability: 0.5, stage: "proposal", isClosed: false, closeDate: "2026-02-02", companyId: atlas }, 1002);
    ledger.set(w, "deal", "d4", { ...deal, name: "Four", stage: "proposal", isClosed: true, closeDate: "2026-04-01" }, 1003);
    ledger.set(w, "deal", "d5", { ...deal, name: "Five", amount: 50_000, isClosed: false, closeDate: "2026-04-15", companyId: "acc_gone" }, 1004);
    assert.equal((await ctx.client.ws(w).post("projector/nudge", { wait: true })).status, 200);

    const deals = (await post("p/deal/list", { limit: 200 })).rows as ListRow[];
    const accounts = (await post("register/account/list", { limit: 200 })).rows as ListRow[];
    const dealDef = indexObjectDef(resolveObjectDef(STANDARD_OBJECTS.deal));
    const accountDef = registerListDef("account", resolveObjectDef(STANDARD_OBJECTS.account));
    const expected = (req: AggregateRequest) => {
      const q = compileAggregateRequest("deal", dealDef, req, (o) => (o === "account" ? accountDef : undefined));
      const { projectedThrough: _, ...rest } = aggregateRowsInMemory(q, deals, () => new Map(accounts.map((a) => [a.id, a])), {});
      return rest;
    };
    const run = async (req: AggregateRequest) => {
      const { projectedThrough: _, ...rest } = await post("p/deal/aggregate", req);
      return rest;
    };

    const byStage: AggregateRequest = { filter: [{ field: "isClosed", op: "eq", value: false }], groupBy: [{ field: "stage" }], measures: [{ fn: "count" }, { fn: "sum", field: "amount" }] };
    assert.deepEqual(await run(byStage), {
      groups: [{ keys: ["discovery"], values: [2, 350_000] }, { keys: ["proposal"], values: [1, 400_000] }, { keys: [null], values: [1, 50_000] }],
      subtotals: [], total: [4, 800_000], rows: 4, truncated: false,
    });
    assert.deepEqual(await run(byStage), expected(byStage));

    const byIndustryMonth: AggregateRequest = {
      groupBy: [{ field: "industry", via: "companyId" }, { field: "closeDate", bucket: "month" }],
      measures: [{ fn: "count" }, { fn: "sum", field: "amount" }, { fn: "avg", field: "amount" }, { fn: "max", field: "amount" }],
    };
    const got = await run(byIndustryMonth);
    assert.deepEqual(got, expected(byIndustryMonth));
    assert.deepEqual(got.subtotals, [
      { keys: ["Retail"], values: [1, 250_000, 250_000, 250_000] },
      { keys: ["Software"], values: [2, 500_000, 250_000, 400_000] },
      { keys: [null], values: [2, 50_000, 50_000, 50_000] },
    ], "a deal whose company is unknown, or has no company, groups as empty");
    assert.deepEqual(got.groups.map((g: { keys: unknown[] }) => g.keys), [["Retail", "2026-01-01"], ["Software", "2026-01-01"], ["Software", "2026-02-01"], [null, "2026-04-01"]]);

    const threeKeys: AggregateRequest = {
      groupBy: [{ field: "stage" }, { field: "industry", via: "companyId" }, { field: "closeDate", bucket: "month" }],
      measures: [{ fn: "count" }, { fn: "sum", field: "amount", weight: "probability" }],
    };
    const three = await run(threeKeys);
    assert.deepEqual(three, expected(threeKeys));
    assert.deepEqual(three.subtotals, [
      { keys: ["discovery", "Retail"], values: [1, null] }, { keys: ["discovery", "Software"], values: [1, 20_000] },
      { keys: ["proposal", "Software"], values: [1, 200_000] }, { keys: ["proposal", null], values: [1, null] }, { keys: [null, null], values: [1, null] },
    ], "three keys subtotal by the first two; amount weighted by probability, empty without one");
    assert.deepEqual(three.total, [5, 220_000]);

    const weekly: AggregateRequest = { groupBy: [{ field: "closeDate", bucket: "week" }], measures: [{ fn: "min", field: "amount" }] };
    assert.deepEqual(await run(weekly), expected(weekly));
    const daily: AggregateRequest = { groupBy: [{ field: "closeDate", bucket: "day" }], measures: [{ fn: "sum", field: "amount" }] };
    assert.deepEqual(await run(daily), expected(daily));
    assert.equal((await ctx.client.ws(w).post("p/deal/aggregate", { groupBy: [{ field: "amount" }], measures: [{ fn: "count" }] })).status, 400, "a plain number is not a group key");
  });

  it("counts notes, tasks, calls and meetings together as activities, by owner and type", async () => {
    ledger.set(w, "note", "n1", { body: "Asked for pricing", ownerId: "u1" }, 2000);
    ledger.set(w, "call", "c1", { subject: "Intro", ownerId: "u1" }, 2001);
    ledger.set(w, "call", "c2", { subject: "Follow-up", ownerId: "u2" }, 2002);
    ledger.set(w, "task", "t1", { subject: "Send deck", status: "open" }, 2003);
    assert.equal((await ctx.client.ws(w).post("projector/nudge", { wait: true })).status, 200);
    const { projectedThrough: _, ...got } = await post("p/activity/aggregate", { groupBy: [{ field: "ownerId" }, { field: "type" }], measures: [{ fn: "count" }] });
    assert.deepEqual(got, {
      groups: [{ keys: ["u1", "call"], values: [1] }, { keys: ["u1", "note"], values: [1] }, { keys: ["u2", "call"], values: [1] }, { keys: [null, "task"], values: [1] }],
      subtotals: [{ keys: ["u1"], values: [2] }, { keys: ["u2"], values: [1] }, { keys: [null], values: [1] }],
      total: [4], rows: 4, truncated: false,
    });
  });
});
