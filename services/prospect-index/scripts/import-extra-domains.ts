// Import domains discovered outside PDL into extra_domains.
//
//   node --experimental-strip-types scripts/import-extra-domains.ts <file.jsonl|.csv|.json> --source <name>
//
// The file needs a `domain` column; `name` is optional. Domains are normalized
// (lowercase, scheme/www/path stripped) and deduped; existing rows keep their
// original source. Needs the index write lock: stop the DNS pass first, then
// re-run it so the new domains get checked.
import { DuckDBInstance } from "@duckdb/node-api";
import { ensureStatusSchema } from "../src/domainStatus.ts";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const file = process.argv[2];
const source = arg("source");
if (!file || file.startsWith("--") || !source) { console.error("usage: import-extra-domains.ts <file> --source <name>"); process.exit(1); }
const INDEX = process.env.PDL_INDEX ?? `${process.env.HOME}/.fullstackgtm/data/pdl_companies.duckdb`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const src = file.endsWith(".csv") ? `read_csv(${lit(file)}, header = true, null_padding = true)` : `read_json_auto(${lit(file)})`;

const db = await DuckDBInstance.create(INDEX);
const c = await db.connect();
await ensureStatusSchema(c);
const count = async (sql: string) => Number(((await c.runAndReadAll(sql)).getRowObjects()[0] as { n: bigint }).n);
const before = await count(`SELECT count(*) AS n FROM extra_domains`);
const hasName = (await c.runAndReadAll(`DESCRIBE SELECT * FROM ${src}`)).getRowObjects().some((r) => r.column_name === "name");
await c.run(`
  INSERT INTO extra_domains (domain, name, source)
  SELECT d, any_value(name), ${lit(source)} FROM (
    SELECT regexp_replace(regexp_replace(lower(trim(domain)), '^https?://', ''), '^www\\.|[/:?#].*$', '', 'g') AS d,
           ${hasName ? "name" : "NULL"} AS name
    FROM ${src}
  ) WHERE d LIKE '%.%' GROUP BY d
  ON CONFLICT (domain) DO NOTHING`);
const added = (await count(`SELECT count(*) AS n FROM extra_domains`)) - before;
const overlap = await count(`SELECT count(*) AS n FROM extra_domains e WHERE source = ${lit(source)} AND EXISTS (SELECT 1 FROM companies p WHERE p.domain = e.domain)`);
console.log(JSON.stringify({ source, added, alreadyInPdl: overlap, allDomains: await count(`SELECT count(*) AS n FROM all_domains`) }));
c.closeSync();
