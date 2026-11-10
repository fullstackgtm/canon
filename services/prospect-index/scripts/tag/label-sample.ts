// Step 1 of corpus tagging: Jev labels a stratified sample (the teacher set).
//
//   node --experimental-strip-types scripts/tag/label-sample.ts [--n 200000] [--chunk 5000]
//
// Sample: companies with usable homepage text, stratified by PDL industry
// (including no industry) so rare business types get enough examples: each
// industry gets max(MIN_PER_INDUSTRY, its proportional share). Labels use the
// text-aware classifier (classifyCompaniesFast with homepage text) and are
// written as parquet chunks under ~/.fullstackgtm/data/tags/teacher/;
// re-running skips chunks already written.
import { existsSync, mkdirSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { classifyCompaniesFast, type CompanyIn } from "../../src/jev/classifyCompanies.ts";
import { usage, costUsd } from "../../src/jev/client.ts";

const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const N = Number(arg("n", "200000"));
const CHUNK = Number(arg("chunk", "5000"));
const MIN_PER_INDUSTRY = 600;
const ABOUT_CHARS = 500;
const H = `${process.env.HOME}/.fullstackgtm/data`;
const OUT = `${H}/tags/teacher`;
mkdirSync(OUT, { recursive: true });

// In-memory database with the index attached read-only: appenders need a writable catalog.
const db = await DuckDBInstance.create(":memory:");
const c = await db.connect();
await c.run(`ATTACH '${H}/pdl_companies.duckdb' AS idx (READ_ONLY)`);
// Deterministic sample (hash order), so re-runs pick the same companies.
await c.run(`CREATE TEMP TABLE usable AS
  SELECT p.domain, p.name, p.industry, p."sizeBand" AS size_band, p.country, p.locality, h.title, h.description, h.text
  FROM read_parquet('${H}/homepages/part-*.parquet') h
  JOIN idx.domain_status s USING (domain) JOIN idx.companies p USING (domain)
  WHERE s.http_text_chars >= 200 AND NOT s.http_blocked AND s.http_status < 400`);
await c.run(`CREATE TEMP TABLE sample AS
  WITH counts AS (SELECT coalesce(industry, '') AS ind, count(*) AS n FROM usable GROUP BY 1),
  total AS (SELECT sum(n) AS t FROM counts),
  quota AS (SELECT ind, greatest(${MIN_PER_INDUSTRY}, round(n * ${N} / t))::BIGINT AS q FROM counts, total),
  ranked AS (SELECT u.*, row_number() OVER (PARTITION BY coalesce(u.industry, '') ORDER BY hash(u.domain)) AS r FROM usable u)
  SELECT ranked.* EXCLUDE (r), row_number() OVER (ORDER BY hash(domain)) AS n FROM ranked JOIN quota ON quota.ind = coalesce(ranked.industry, '') WHERE r <= q`);
const total = Number(((await c.runAndReadAll(`SELECT count(*) AS n FROM sample`)).getRowObjects()[0] as { n: bigint }).n);
console.log(JSON.stringify({ label: "teacher sample", total }));

for (let start = 0, part = 0; start < total; start += CHUNK, part++) {
  const file = `${OUT}/part-${String(part).padStart(4, "0")}.parquet`;
  if (existsSync(file)) continue;
  const rows = (await c.runAndReadAll(`SELECT * FROM sample WHERE n > ${start} AND n <= ${start + CHUNK}`)).getRowObjects() as Array<Record<string, string | null>>;
  const companies: CompanyIn[] = rows.map((r) => ({
    domain: r.domain!, name: r.name ?? r.domain!, industry: r.industry, sizeBand: r.size_band, country: r.country, locality: r.locality,
    about: [r.title, r.description, r.text].filter(Boolean).join(" | ").slice(0, ABOUT_CHARS),
  }));
  const tags = await classifyCompaniesFast(companies, 24);
  await c.run(`CREATE OR REPLACE TEMP TABLE lab (domain VARCHAR, archetype VARCHAR, p DOUBLE, second VARCHAR, p2 DOUBLE)`);
  const a = await c.createAppender("lab");
  for (const t of tags) {
    const [top, nxt] = t.archetypes;
    a.appendVarchar(t.domain);
    top ? a.appendVarchar(top.key) : a.appendNull();
    a.appendDouble(top?.p ?? 0);
    nxt ? a.appendVarchar(nxt.key) : a.appendNull();
    a.appendDouble(nxt?.p ?? 0);
    a.endRow();
  }
  a.flushSync(); a.closeSync();
  await c.run(`COPY lab TO '${file}' (FORMAT parquet)`);
  console.log(JSON.stringify({ part, labeled: Math.min(start + CHUNK, total), of: total, tokens: usage.inputTokens, cost: Number(costUsd(usage.inputTokens).toFixed(3)) }));
}
console.log(JSON.stringify({ label: "teacher done", usage, cost: costUsd(usage.inputTokens) }));
