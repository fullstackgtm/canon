// Build the standards database for the JTBD layer from public sources:
//
//   O*NET 31.0 (CC BY 4.0, onetcenter.org): occupations, work activities
//     (GWA > IWA > DWA), which tasks of which occupation involve each DWA,
//     task importance, and the software categories each occupation uses.
//   BLS OEWS May 2025 national industry-specific estimates (public domain):
//     employment by detailed occupation x 4-digit NAICS industry.
//
//   node --experimental-strip-types src/standards/build.ts [dir]
//
// `dir` (default ~/.fullstackgtm/data/standards) must contain the unzipped
// onet/db_31_0_text/ and oes/oesm25in4/. Writes <dir>/standards.duckdb:
//
//   occupation(soc, title, description)                 SOC 6-digit (OEWS level)
//   iwa(iwa_id, name, gwa_id)                           ~330 intermediate work activities = jobs
//   occ_iwa(soc, iwa_id, weight)                        how central the job is to the occupation, 0..1
//   occ_software(soc, category, examples, hot)          software categories used by the occupation
//   sw_example(category, example, soc)                 software examples and the occupations using them
//   occ_group(grp, title)                               SOC minor groups, ~94
//   industry(naics, title, emp)                         4-digit NAICS (as 6-char OEWS codes)
//   industry_occ(naics, soc, emp, share, lift)          lift = share in industry / share nationally
import { DuckDBInstance } from "@duckdb/node-api";
import { rmSync } from "node:fs";

const dir = process.argv[2] ?? `${process.env.HOME}/.fullstackgtm/data/standards`;
const onet = `${dir}/onet/db_31_0_text`;
const oes = `${dir}/oes/oesm25in4/nat4d_M2025_dl.xlsx`;
const out = `${dir}/standards.duckdb`;
rmSync(out, { force: true });

const c = await (await DuckDBInstance.create(out)).connect();
await c.run("INSTALL excel; LOAD excel");
const tsv = (f: string) => `read_csv('${onet}/${f}.txt', delim='\t', header=true, quote='', all_varchar=true)`;
const soc6 = (col: string) => `left(${col}, 7)`; // 11-1011.03 -> 11-1011

await c.run(`CREATE TABLE occupation AS
  SELECT ${soc6('"O*NET-SOC Code"')} AS soc, first(Title ORDER BY "O*NET-SOC Code") AS title, first(Description ORDER BY "O*NET-SOC Code") AS description
  FROM ${tsv("Occupation Data")} GROUP BY 1`);

await c.run(`CREATE TABLE iwa AS
  SELECT "IWA Element ID" AS iwa_id, "IWA Element Name" AS name, "GWA Element ID" AS gwa_id FROM ${tsv("GWAs to IWAs")}`);

// Task importance (IM scale, 1-5) -> DWA -> IWA, summed per occupation and
// normalized so each occupation's weights sum to 1 (its "time" across jobs).
await c.run(`CREATE TABLE occ_iwa AS
  WITH imp AS (
    SELECT "O*NET-SOC Code" AS soc8, "Task ID" AS task, avg(TRY_CAST("Data Value" AS DOUBLE)) AS im
    FROM ${tsv("Task Ratings")} WHERE "Scale ID" = 'IM' GROUP BY ALL),
  t AS (
    SELECT ${soc6('t."O*NET-SOC Code"')} AS soc, g."IWA Element ID" AS iwa_id, sum(coalesce(i.im, 3.0)) AS w
    FROM ${tsv("Tasks to DWAs")} t
    JOIN ${tsv("GWAs to IWAs to DWAs")} g ON g."DWA Element ID" = t."DWA Element ID"
    LEFT JOIN imp i ON i.soc8 = t."O*NET-SOC Code" AND i.task = t."Task ID"
    GROUP BY ALL)
  SELECT soc, iwa_id, w / sum(w) OVER (PARTITION BY soc) AS weight FROM t`);

await c.run(`CREATE TABLE occ_software AS
  SELECT ${soc6('"O*NET-SOC Code"')} AS soc, "Element Name" AS category,
         string_agg(DISTINCT "Workplace Example", '; ') AS examples, bool_or("Hot Technology" = 'Y') AS hot
  FROM ${tsv("Software Skills")} GROUP BY ALL`);

// One row per (software example, occupation): the bridge from "what kind of
// product is this" to the occupations that use it.
await c.run(`CREATE TABLE sw_example AS
  SELECT DISTINCT "Element Name" AS category, "Workplace Example" AS example, ${soc6('"O*NET-SOC Code"')} AS soc
  FROM ${tsv("Software Skills")}`);

// OEWS: detailed occupations x 4-digit industries, all ownerships. '**' and '#' mark
// suppressed or capped values; they become NULL.
await c.run(`CREATE TEMP TABLE oes AS
  SELECT NAICS AS naics, NAICS_TITLE AS naics_title, OCC_CODE AS soc, O_GROUP AS grp, TRY_CAST(TOT_EMP AS DOUBLE) AS emp
  FROM read_xlsx('${oes}', all_varchar=true) WHERE I_GROUP = '4-digit'`);
// SOC minor groups (e.g. 41-4000 "Sales Representatives, Wholesale and Manufacturing")
// for asking whose work a product manages; detailed SOC 41-4012 -> group 41-4000.
await c.run(`CREATE TABLE occ_group AS SELECT DISTINCT soc AS grp, any_value(OCC_TITLE) AS title FROM (
  SELECT OCC_CODE AS soc, OCC_TITLE FROM read_xlsx('${oes}', all_varchar=true) WHERE O_GROUP = 'minor') GROUP BY 1`);
await c.run(`CREATE TABLE industry AS SELECT naics, any_value(naics_title) AS title, sum(emp) FILTER (grp = 'total') AS emp FROM oes GROUP BY 1`);
await c.run(`CREATE TABLE industry_occ AS
  WITH d AS (SELECT naics, soc, emp FROM oes WHERE grp = 'detailed' AND emp > 0),
  tot AS (SELECT sum(emp) AS all_emp FROM industry),
  occ AS (SELECT soc, sum(emp) AS occ_emp FROM d GROUP BY 1)
  SELECT d.naics, d.soc, d.emp, d.emp / i.emp AS share,
         (d.emp / i.emp) / (o.occ_emp / tot.all_emp) AS lift
  FROM d JOIN industry i USING (naics) JOIN occ o USING (soc), tot`);

for (const t of ["occupation", "occ_group", "iwa", "occ_iwa", "occ_software", "sw_example", "industry", "industry_occ"]) {
  const n = (await c.runAndReadAll(`SELECT count(*) AS n FROM ${t}`)).getRowObjects()[0] as { n: bigint };
  console.log(t.padEnd(14), Number(n.n));
}
c.closeSync();
