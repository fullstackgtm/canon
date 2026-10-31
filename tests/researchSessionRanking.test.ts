import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeRecordClient, createMemoryRecordStore, fitUnderWeights } from "../convex/lib/recordClient.ts";
import { icpToWeights, runResearchPipeline } from "../convex/lib/researchPipeline.ts";
import type { AccountInput, IcpWeights } from "../convex/lib/recordContract.ts";
import type { Icp } from "../engine/src/icp.ts";
import { defaultModel } from "../recipes/index.ts";

const icp = {
  name: "test ICP",
  motion: "sales",
  firmographics: {
    industries: ["Computer Software", "Internet"],
    geos: ["united states", "united kingdom"],
    employeeBands: ["11-50", "51-200", "201-500"],
  },
  persona: { departments: [], jobLevels: [], titleKeywords: [] },
  scoring: { threshold: 0.5 },
} as unknown as Icp;

test("icpToWeights: a company matching every primary dimension scores 100", () => {
  const w = icpToWeights(icp, defaultModel("scoring.fit"));
  assert.equal(fitUnderWeights({ industry: "computer software", country: "united states", employees: 51 }, w), 1);
  // Secondary industry and country, edge band: still in the ICP, but lower.
  const secondary = fitUnderWeights({ industry: "internet", country: "united kingdom", employees: 11 }, w);
  assert.ok(secondary > 0.5 && secondary < 1, `secondary ${secondary}`);
  // Adjacent band outside the ICP earns a little; far outside earns nothing for size.
  const adjacent = fitUnderWeights({ industry: "computer software", country: "united states", employees: 501 }, w);
  const far = fitUnderWeights({ industry: "computer software", country: "united states", employees: 10001 }, w);
  assert.ok(adjacent > far, `adjacent ${adjacent} > far ${far}`);
});

test("the TAM preview is ranked by ICP fit, best first, with varying fit", async () => {
  const shared: AccountInput[] = [];
  const add = (n: number, industry: string, country: string, employees: number) => {
    for (let i = 0; i < n; i++) shared.push({ domain: `${industry.replace(/\W/g, "")}-${country.replace(/\W/g, "")}-${employees}-${i}.com`, name: `${industry} ${i}`, industry, country, employees });
  };
  // Inserted worst-fit first: the fake returns matches in insertion order, so an unranked search would lead with them.
  add(30, "internet", "united kingdom", 11);
  add(30, "computer software", "united states", 51);
  add(30, "computer software", "united kingdom", 201);
  const client = createFakeRecordClient({ store: createMemoryRecordStore(), shared: () => shared });
  const result = await runResearchPipeline({ domain: "visitor.io", client, deriveIcp: async () => icp, tamLimit: 40 });
  const fits = result.preview.map((r) => r.fit ?? 0);
  assert.deepEqual([...fits].sort((a, b) => b - a), fits, "preview sorted by fit");
  assert.equal(result.preview[0].industry, "computer software");
  assert.equal(result.preview[0].country, "united states");
  assert.equal(fits[0], 1);
  assert.ok(new Set(result.tam.map((r) => r.fit)).size > 1, "fit varies across the TAM");
  assert.ok(result.tam.every((r) => r.industry !== "internet" || r.fit! < 1), "secondary matches rank below primary");
  assert.equal(result.tamTotal, 90, "total counts every match, not just the ranked page");
});

test("rescore stores the ICP so the workspace sees the same fit", async () => {
  const client = createFakeRecordClient({ store: createMemoryRecordStore() });
  await client.provision("ws1");
  await client.upsertAccounts("ws1", { records: [{ domain: "a.com", name: "A", industry: "computer software", country: "united states", employees: 60 }], source: "test", idempotencyKey: "k1" });
  const w: IcpWeights = icpToWeights(icp, defaultModel("scoring.fit"));
  await client.rescore("ws1", w);
  const page = await client.list("ws1", { sort: { field: "fit", dir: "desc" }, limit: 10 });
  assert.equal(page.rows[0].fit, 1);
});
