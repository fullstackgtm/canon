// Step 2 of corpus tagging: export model inputs for every company with usable
// homepage text to ~/.fullstackgtm/data/tags/features/*.parquet (Python reads these;
// its DuckDB is older than the index file's).
//
//   node --experimental-strip-types scripts/tag/export-features.ts
import { mkdirSync, rmSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

const H = `${process.env.HOME}/.fullstackgtm/data`;
const OUT = `${H}/tags/features`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const c = await (await DuckDBInstance.create(":memory:")).connect();
await c.run(`ATTACH '${H}/pdl_companies.duckdb' AS idx (READ_ONLY)`);
await c.run(`COPY (
  SELECT p.domain, p.industry, p."sizeBand" AS size_band, p.country, h.title, h.description, left(h.text, 1000) AS text,
         hash(p.domain) % 16 AS shard
  FROM read_parquet('${H}/homepages/part-*.parquet') h
  JOIN idx.domain_status s USING (domain) JOIN idx.companies p USING (domain)
  WHERE s.http_text_chars >= 200 AND NOT s.http_blocked AND s.http_status < 400
) TO '${OUT}' (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (shard))`);
console.log((await c.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${OUT}/*/*.parquet')`)).getRowObjects());
