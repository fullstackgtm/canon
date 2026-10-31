// Build the shared prospect index from the People Data Labs free company
// dataset (CC BY 4.0; attribution required wherever records are shown).
//
//   node --experimental-strip-types src/build.ts <pdl-companies.parquet|.csv.gz> <out.duckdb>
//
// Output: a read-only DuckDB file with one table, `companies`, one row per
// normalized domain, sorted for filter pruning and indexed for domain lookups.
// The record service mounts it as `shared/pdl_companies.duckdb` and serves
// POST /v1/shared/prospects/search from it (see search.ts).
import { rm } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";
import { BUILD_SQL } from "./sql.ts";

const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error("usage: build.ts <pdl input> <out.duckdb>");

const source = input.endsWith(".parquet")
  ? `read_parquet('${input}')`
  : `read_csv('${input}', compression='gzip', header=true, sample_size=200000)`;

await rm(out, { force: true });
await rm(`${out}.wal`, { force: true });
const db = await DuckDBInstance.create(out);
const conn = await db.connect();
const t0 = performance.now();
for (const [label, sql] of BUILD_SQL(source)) {
  const t = performance.now();
  await conn.run(sql);
  console.log(`  ${label}: ${((performance.now() - t) / 1000).toFixed(1)}s`);
}
const stats = (await conn.runAndReadAll(`
  SELECT count(*) AS companies,
         count(*) FILTER (WHERE domainConfidence = 'high') AS highConfidence,
         count(*) FILTER (WHERE domainConfidence = 'low') AS lowConfidence,
         count(DISTINCT country) AS countries
  FROM companies`)).getRowObjects()[0];
await conn.run("CHECKPOINT");
conn.closeSync();
console.log(JSON.stringify({
  label: "prospect index built",
  ...Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Number(v)])),
  secs: Math.round((performance.now() - t0) / 100) / 10,
  out,
}));
