// Build the free revenue data the CRM fill uses (docs/enrich-free-fill.md):
//   convex/lib/enrich/secRevenue.v1.json        domain -> SEC-reported revenue (public companies)
//   convex/lib/enrich/revenueCalibration.v1.json revenue per employee by PDL industry, for estimates
//
//   node --experimental-strip-types scripts/revenue-calibration.ts [pdl_companies.duckdb]
//
// Inputs: SEC XBRL frames for calendar 2024 (public domain, fetched here) and the
// built prospect index (src/build.ts). Filers are matched to the index by their
// normalized name; a name with more than one US match is dropped, and so is a
// match whose revenue is implausible for its size band (likely a different company).
import { writeFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

const INDEX = process.argv[2] ?? `${process.env.HOME}/.fullstackgtm/data/pdl_companies.duckdb`;
const YEAR = 2024;
const UA = "CanonCRM research ryan@fullstackgtm.com"; // SEC asks for a contact in the User-Agent
const TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"];
const MIN_INDUSTRY_ROWS = 8;
const repo = new URL("../../..", import.meta.url).pathname;

const tmp = `${process.env.TMPDIR ?? "/tmp"}/sec-frames-${YEAR}`;
const { mkdirSync } = await import("node:fs");
mkdirSync(tmp, { recursive: true });
for (const tag of TAGS) {
  const res = await fetch(`https://data.sec.gov/api/xbrl/frames/us-gaap/${tag}/USD/CY${YEAR}.json`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`SEC ${tag}: HTTP ${res.status}`);
  writeFileSync(`${tmp}/${tag}.json`, await res.text());
}

const db = await DuckDBInstance.create(":memory:");
const c = await db.connect();
const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJS() as Array<Record<string, any>>;
await c.run(`ATTACH '${INDEX}' AS pdl (READ_ONLY)`);
await c.run(`CREATE MACRO squash(s) AS regexp_replace(trim(regexp_replace(regexp_replace(lower(s), '[^a-z0-9 ]', ' ', 'g'),
  '\\b(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|plc|holdings|holding|group|the|sa|nv|ag|lp)\\b', '', 'g')), '\\s+', '', 'g')`);
await c.run(`CREATE TABLE rev AS SELECT cik, any_value(entityName) AS name, max(val) AS revenue FROM (
  ${TAGS.map((t) => `SELECT unnest(data, recursive := true) FROM read_json('${tmp}/${t}.json')`).join(" UNION ALL ")}
) WHERE val > 0 AND loc LIKE 'US-%' GROUP BY cik`);
await c.run(`CREATE TABLE m AS
  SELECT r.cik, r.revenue, p.domain, lower(p.industry) AS industry, p.employeeMin, p.employeeMax,
    sqrt(p.employeeMin * coalesce(p.employeeMax, 20000)) AS emp, hash(r.cik) % 5 = 0 AS test
  FROM rev r JOIN pdl.companies p ON squash(p.name) = squash(r.name)
  WHERE length(squash(r.name)) >= 4 AND p.domainConfidence = 'high' AND p.country = 'united states' AND p.employeeMin IS NOT NULL
  QUALIFY count(*) OVER (PARTITION BY r.cik) = 1`);

// Revenue per employee: medians over 11+ employee companies (micro filers are mostly shells and funds).
const fit = async (where: string) => {
  const [g] = await rows(`SELECT median(revenue / emp) AS rpe FROM m WHERE employeeMin >= 11 ${where}`);
  const ind = await rows(`SELECT industry, median(revenue / emp) AS rpe, count(*) AS n FROM m WHERE employeeMin >= 11 AND industry IS NOT NULL ${where}
    GROUP BY 1 HAVING count(*) >= ${MIN_INDUSTRY_ROWS} ORDER BY 1`);
  return { global: Number(g.rpe), industries: Object.fromEntries(ind.map((r) => [r.industry, Math.round(Number(r.rpe))])) };
};

// Held-out check: train on 80% of filers, score the band of the other 20%.
const train = await fit("AND NOT test");
await c.run(`CREATE TABLE ind AS SELECT * FROM (VALUES ${Object.entries(train.industries).map(([k, v]) => `('${k.replace(/'/g, "''")}', ${v})`).join(",") || "('', 0)"}) t(industry, rpe)`);
await c.run(`CREATE MACRO band(v) AS CASE WHEN v < 1e6 THEN 0 WHEN v < 1e7 THEN 1 WHEN v < 5e7 THEN 2 WHEN v < 1e8 THEN 3 WHEN v < 5e8 THEN 4 WHEN v < 1e9 THEN 5 ELSE 6 END`);
const [ev] = await rows(`WITH p AS (SELECT m.revenue, coalesce(ind.rpe, ${train.global}) * m.emp AS est FROM m LEFT JOIN ind USING (industry) WHERE m.test AND m.employeeMin >= 11)
  SELECT count(*) AS n, avg((band(est) = band(revenue))::int) AS exact, avg((abs(band(est) - band(revenue)) <= 1)::int) AS within1,
    exp(median(abs(ln(est / revenue)))) AS medianFactor FROM p`);

const all = await fit("");
// Public filers whose revenue sits within 20x of the estimate for their size: outside that the name match is suspect.
const sec = await rows(`SELECT m.domain, m.revenue, m.cik FROM m LEFT JOIN (SELECT * FROM (VALUES ${Object.entries(all.industries).map(([k, v]) => `('${k.replace(/'/g, "''")}', ${v})`).join(",")}) t(industry, rpe)) i USING (industry)
  WHERE abs(ln(m.revenue / (coalesce(i.rpe, ${all.global}) * m.emp))) < ln(20) ORDER BY m.domain`);

writeFileSync(`${repo}convex/lib/enrich/secRevenue.v1.json`, JSON.stringify({
  source: `SEC EDGAR XBRL frames CY${YEAR} (${TAGS.join(", ")}), public domain`,
  fiscalYear: YEAR,
  rows: Object.fromEntries(sec.map((r) => [r.domain, [Math.round(Number(r.revenue)), Number(r.cik)]])),
}) + "\n");
writeFileSync(`${repo}convex/lib/enrich/revenueCalibration.v1.json`, JSON.stringify({
  method: "median revenue / employee (geometric midpoint of the PDL size band) over US SEC filers with 11+ employees",
  fiscalYear: YEAR,
  heldOut: { companies: Number(ev.n), exactBand: round(ev.exact), withinOneBand: round(ev.within1), medianErrorFactor: round(ev.medianFactor) },
  globalRevenuePerEmployee: Math.round(all.global),
  industries: all.industries,
}, null, 1) + "\n");
console.log({ secRows: sec.length, industries: Object.keys(all.industries).length, global: Math.round(all.global), heldOut: ev });

function round(x: unknown) {
  return Math.round(Number(x) * 100) / 100;
}
