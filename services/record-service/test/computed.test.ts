// Formula and rollup fields (CP7c, src/computed.ts): computed by the list query
// from the projection, so they filter and sort, and a rollup follows a related
// record's change once the projector applies it.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { OrgObjectExtension } from "../src/core/objects/registry.ts";
import { FakeLedger } from "./ledgerFake.ts";
import { startApp } from "./helpers.ts";

const field = (slug: string, formula: string, returns: string, rollup?: unknown) =>
  ({ fieldId: `custom.${slug}`, apiName: `custom.${slug}`, label: slug, type: "formula", formula, returns, ...(rollup ? { rollup } : {}) });

const DEAL: OrgObjectExtension = {
  registryVersion: 1,
  customFields: [
    field("days", "daysBetween(today(), closeDate)", "number"),
    field("big", "amount >= 10000 and not isClosed", "checkbox"),
    field("label", "concat(name, ': ', round(amount / 3, 2), ' ', isWon)", "text"),
    field("weighted", "amount * probability / 100", "currency"),
    field("ratio", "probability / (amount - amount)", "number"),
    field("step", "if(isBlank(nextStep), 'none', nextStep)", "text"),
    field("until", "if(isClosed, closeDate, today())", "date"),
  ],
} as never;

const ACCOUNT: OrgObjectExtension = {
  registryVersion: 1,
  customFields: [
    field("open_pipeline", "not isClosed", "currency", { object: "deal", via: "companyId", fn: "sum", field: "amount" }),
    field("deals", "", "number", { object: "deal", via: "companyId", fn: "count" }),
    field("next_close", "not isClosed", "date", { object: "deal", via: "companyId", fn: "min", field: "closeDate" }),
    field("pipeline_k", "round(custom.open_pipeline / 1000, 1)", "number"),
    field("last_deal_change", "", "datetime", { object: "deal", via: "companyId", fn: "max", field: "updatedAt" }),
  ],
} as never;

const localDay = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("formula and rollup fields", () => {
  const ledger = new FakeLedger();
  let ctx: Awaited<ReturnType<typeof startApp>>;
  const w = "cp7c";

  before(async () => {
    const sourceUrl = await ledger.listen();
    ctx = await startApp({ projector: { sourceUrl, pollMs: 0, pageSize: 50, rebuildChunk: 50 } });
  });
  after(async () => {
    await ctx.app.shutdown();
    await ledger.close();
  });

  const nudge = () => ctx.client.ws(w).post("projector/nudge", { wait: true });
  const deals = async (body: unknown = {}) => (await ctx.client.ws(w).post("p/deal/list", body)).json;
  const companies = async (body: unknown = {}) => (await ctx.client.ws(w).post("register/account/list", body)).json;

  it("evaluates formulas over each deal, and lists, filters and sorts on them", async () => {
    ledger.extensions.set(w, { deal: DEAL, account: ACCOUNT });
    const deal = { currency: "USD", dealType: "new_business", isClosed: false, isWon: false };
    ledger.set(w, "deal", "d-atlas", { ...deal, name: "Atlas", amount: 1_200_000, probability: 50, closeDate: localDay(10), companyId: "pending" }, 1000);
    ledger.set(w, "deal", "d-won", { ...deal, name: "Won", amount: 300_000, probability: 100, closeDate: "2026-01-02", isClosed: true, isWon: true, nextStep: "Invoice" }, 1001);
    assert.equal((await nudge()).status, 200);

    const listed = await deals({ sort: { field: "custom.days", dir: "desc" } });
    assert.deepEqual(listed.rows.map((r: { id: string; values: Record<string, unknown> }) => [r.id, r.values["custom.days"], r.values["custom.big"], r.values["custom.label"], r.values["custom.weighted"], r.values["custom.ratio"], r.values["custom.step"], r.values["custom.until"]]), [
      ["d-atlas", 10, true, "Atlas: 4000 false", 600_000, null, "none", localDay(0)],
      ["d-won", listed.rows[1].values["custom.days"], false, "Won: 1000 true", 300_000, null, "Invoice", "2026-01-02"],
    ]);
    assert.ok((listed.rows[1].values["custom.days"] as number) < 0, "a past close date is negative days");
    const big = await deals({ filter: [{ field: "custom.weighted", op: "gte", value: 500_000 }] });
    assert.deepEqual(big.rows.map((r: { id: string }) => r.id), ["d-atlas"]);
  });

  it("rolls up deals onto their companies, and follows a deal's change", async () => {
    assert.equal((await ctx.client.ws(w).post("provision")).status, 200);
    const up = await ctx.client.ws(w).post("accounts/upsert", { records: [{ domain: "atlas.example", name: "Atlas" }, { domain: "boreal.example", name: "Boreal" }], source: "pdl", idempotencyKey: "cp7c" });
    const [atlas, boreal] = up.json.ids as string[];
    ledger.set(w, "deal", "d-atlas", { companyId: atlas }, 1100);
    ledger.set(w, "deal", "d-won", { companyId: atlas }, 1101);
    ledger.set(w, "deal", "d-boreal", { name: "Boreal", currency: "USD", dealType: "renewal", isClosed: false, isWon: false, amount: 2_000_000, closeDate: localDay(3), companyId: boreal }, 1102);
    assert.equal((await nudge()).status, 200);

    const byPipeline = async () => (await companies({ sort: { field: "custom.open_pipeline", dir: "desc" } })).rows
      .map((r: { id: string; values: Record<string, unknown> }) => [r.id, r.values["custom.open_pipeline"], r.values["custom.deals"], r.values["custom.next_close"], r.values["custom.pipeline_k"]]);
    assert.deepEqual(await byPipeline(), [
      [boreal, 2_000_000, 1, localDay(3), 20],
      [atlas, 1_200_000, 2, localDay(10), 12],
    ], "an open deal's amount counts; the closed one only in the count");
    const latest = (await companies({ sort: { field: "custom.last_deal_change", dir: "desc" } })).rows;
    assert.deepEqual(latest.map((r: { id: string; values: Record<string, unknown> }) => [r.id, r.values["custom.last_deal_change"]]), [[boreal, 1102], [atlas, 1101]], "a rollup reads a related system field");

    ledger.set(w, "deal", "d-atlas", { amount: 3_000_000 }, 1200);
    assert.equal((await nudge()).status, 200);
    assert.deepEqual((await byPipeline()).map((r: unknown[]) => [r[0], r[1]]), [[atlas, 3_000_000], [boreal, 2_000_000]]);
    const filtered = await companies({ filter: [{ field: "custom.deals", op: "gt", value: 1 }] });
    assert.deepEqual(filtered.rows.map((r: { id: string }) => r.id), [atlas]);
  });
});
