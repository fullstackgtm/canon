// Step 5 of corpus tagging: merge teacher, recheck and student tags into the
// prospect index as company_tags (one row per company with usable homepage text).
//
//   node --experimental-strip-types scripts/tag/merge.ts
//
// Priority per company:
//   jev        Jev's full text-aware classification (teacher sample)
//   jev_top4   Jev chose among the student's top 4 (recheck); when Jev answered
//              "none", the student's guess is kept with source 'model_disputed'
//   model      the student model alone
// `p` is the deciding source's confidence. Needs the index write lock.
import { DuckDBInstance } from "@duckdb/node-api";

const H = `${process.env.HOME}/.fullstackgtm/data`;
const T = `${H}/tags`;
const MODEL_VERSION = "student-v1+jev-1.13.0";

const c = await (await DuckDBInstance.create(`${H}/pdl_companies.duckdb`)).connect();
await c.run(`CREATE OR REPLACE TABLE company_tags AS
  WITH s AS (SELECT domain, archetype, p FROM read_parquet('${T}/student/*.parquet')),
  t AS (SELECT domain, archetype, p FROM read_parquet('${T}/teacher/*.parquet') WHERE archetype IS NOT NULL),
  r AS (SELECT domain, archetype, p FROM read_parquet(['${T}/recheck/*.parquet', '${T}/recheck-lowtail/*.parquet']))
  SELECT s.domain,
    coalesce(t.archetype, r.archetype, s.archetype) AS archetype,
    CASE WHEN t.archetype IS NOT NULL THEN t.p WHEN r.archetype IS NOT NULL THEN r.p ELSE s.p END AS p,
    CASE WHEN t.archetype IS NOT NULL THEN 'jev' WHEN r.archetype IS NOT NULL THEN 'jev_top4'
         WHEN r.domain IS NOT NULL THEN 'model_disputed' ELSE 'model' END AS source,
    '${MODEL_VERSION}' AS version,
    now() AS tagged_at
  FROM s LEFT JOIN t USING (domain) LEFT JOIN r USING (domain)`);
const summary = (await c.runAndReadAll(`SELECT source, count(*) AS n, round(avg(p), 3) AS avg_p FROM company_tags GROUP BY 1 ORDER BY 2 DESC`)).getRowObjects();
console.table(summary.map((r) => ({ ...r, n: Number(r.n) })));
c.closeSync();
