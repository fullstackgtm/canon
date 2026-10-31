// Build the shared, read-only PDL company index from the People Data Labs Free
// Company Dataset CSV (CC BY 4.0; downloaded manually from peopledatalabs.com).
//
//   npm run load-pdl -- <companies.csv> [--data-dir /data] [--version <label>]
//
// Writes {dataDir}/shared/pdl_companies.duckdb atomically (build to a temp file,
// then rename), so a running service picks it up on its next open.
// Expected columns: id, website, name, founded, size, locality, region, country,
// industry, linkedin_url. Rows without a website are dropped; duplicate domains
// keep the first row with a LinkedIn URL.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { pdlPath } from "../src/pdl.ts";

export const PDL_ATTRIBUTION =
  "Company data from the People Data Labs Free Company Dataset (https://www.peopledatalabs.com), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).";

export async function loadPdl(csvPath: string, dataDir: string, version = basename(csvPath)) {
  if (!existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  const out = pdlPath(dataDir);
  mkdirSync(join(dataDir, "shared"), { recursive: true });
  const tmp = `${out}.building-${process.pid}`;
  rmSync(tmp, { force: true });
  const t0 = performance.now();
  const db = await DuckDBInstance.create(tmp);
  const c = await db.connect();
  try {
    const csv = csvPath.replaceAll("'", "''");
    await c.run(`CREATE TABLE pdl_companies AS
      WITH raw AS (
        SELECT * FROM read_csv('${csv}', header = true, all_varchar = true)
      ), norm AS (
        SELECT
          regexp_replace(regexp_replace(lower(trim(website)), '^(https?://)?(www\\.)?', ''), '[/?#].*$', '') AS domain,
          name, industry, country, locality, region, linkedin_url, founded, size,
          TRY_CAST(regexp_extract(size, '^(\\d+)', 1) AS INTEGER) AS employeesMin,
          TRY_CAST(regexp_extract(size, '-(\\d+)$', 1) AS INTEGER) AS employeesMax,
          id
        FROM raw WHERE website IS NOT NULL AND trim(website) <> ''
      )
      SELECT domain, any_value(name ORDER BY linkedin_url IS NULL, id) AS name,
        any_value(industry ORDER BY linkedin_url IS NULL, id) AS industry,
        any_value(country ORDER BY linkedin_url IS NULL, id) AS country,
        any_value(locality ORDER BY linkedin_url IS NULL, id) AS locality,
        any_value(region ORDER BY linkedin_url IS NULL, id) AS region,
        any_value(CASE WHEN linkedin_url IS NULL THEN NULL WHEN linkedin_url LIKE 'http%' THEN linkedin_url ELSE 'https://' || linkedin_url END
          ORDER BY linkedin_url IS NULL, id) AS linkedinUrl,
        any_value(TRY_CAST(founded AS INTEGER) ORDER BY linkedin_url IS NULL, id) AS founded,
        any_value(size ORDER BY linkedin_url IS NULL, id) AS sizeBand,
        any_value(employeesMin ORDER BY linkedin_url IS NULL, id) AS employeesMin,
        any_value(employeesMax ORDER BY linkedin_url IS NULL, id) AS employeesMax,
        any_value(id ORDER BY linkedin_url IS NULL, id) AS pdlId
      FROM norm WHERE domain <> '' GROUP BY domain ORDER BY domain`);
    await c.run(`CREATE INDEX pdl_domain ON pdl_companies(domain)`);
    await c.run(`CREATE TABLE attribution (source VARCHAR, license VARCHAR, licenseUrl VARCHAR, notice VARCHAR, datasetVersion VARCHAR, loadedAt BIGINT, rowCount BIGINT)`);
    const n = Number((await c.runAndReadAll(`SELECT count(*) FROM pdl_companies`)).getRows()[0][0]);
    await c.run(`INSERT INTO attribution VALUES ('People Data Labs Free Company Dataset', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', $notice, $v, $at, $n)`,
      { notice: PDL_ATTRIBUTION, v: version, at: Date.now(), n });
    await c.run("CHECKPOINT");
    c.closeSync();
    db.closeSync();
    renameSync(tmp, out);
    return { path: out, rows: n, secs: (performance.now() - t0) / 1000 };
  } catch (e) {
    c.closeSync();
    db.closeSync();
    rmSync(tmp, { force: true });
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const dataDir = opt("--data-dir") ?? process.env.DATA_DIR ?? "/data";
  const version = opt("--version");
  const [csv] = args;
  if (!csv) {
    console.error("usage: load-pdl <companies.csv> [--data-dir /data] [--version <label>]");
    process.exit(2);
  }
  console.log(JSON.stringify(await loadPdl(csv, dataDir, version)));
  console.log(PDL_ATTRIBUTION);
}
