// Latency of the onboarding queries against a built index.
//   node --experimental-strip-types src/bench.ts <index.duckdb>
import { DuckDBInstance } from "@duckdb/node-api";
import { facets, lookupDomain, searchShared, type SharedFilter } from "./search.ts";

const db = await DuckDBInstance.create(process.argv[2], { access_mode: "READ_ONLY" });
const c = await db.connect();
async function time(label: string, fn: () => Promise<unknown>, n = 10) {
  const xs: number[] = [];
  let out: unknown;
  for (let i = 0; i < n; i++) { const t = performance.now(); out = await fn(); xs.push(performance.now() - t); }
  xs.sort((a, b) => a - b);
  console.log(JSON.stringify({ label, p50: Math.round(xs[n >> 1]), p95: Math.round(xs[Math.floor(n * 0.95)]), first: Math.round(xs[0]), sample: out }));
}
const icp: SharedFilter = { industry: ["computer software", "information technology and services", "internet"], country: ["united states"], employeeMin: 11, employeeMax: 200, minConfidence: "high" };
await time("lookupDomain(stripe.com)", async () => { const r = await lookupDomain(c, "stripe.com"); return r && { name: r.name, industry: r.industry, size: r.sizeBand, country: r.country }; });
await time("lookupDomain(app.hubspot.com) via parent", async () => (await lookupDomain(c, "app.hubspot.com"))?.domain);
await time("searchShared: US software 11-200, high confidence, top 100", async () => { const r = await searchShared(c, icp, 100); return { total: r.total, top: r.rows.slice(0, 3).map((x) => x.domain) }; });
await time("searchShared: fintech US 51-500 + q", async () => (await searchShared(c, { industry: ["financial services"], country: ["united states"], employeeMin: 51, employeeMax: 500, q: "pay" }, 50)).total);
await time("searchShared: page 50 (offset 5000)", async () => (await searchShared(c, icp, 100, 5000)).rows.length);
await time("facets(industry) top 200", async () => (await facets(c, "industry")).length, 3);
