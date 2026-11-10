// Export the data the portable segment module needs into one JSON bundle:
//   convex/lib/segments/segmentData.v1.json
//
//   node --experimental-strip-types scripts/export-segment-data.ts
//
// Inputs: taxonomy/*.v1.json and the standards database (src/standards/build.ts).
// Occupations and industries are referenced by index to keep the bundle small.
import { readFileSync, writeFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

const STANDARDS = process.env.STANDARDS_DB ?? `${process.env.HOME}/.fullstackgtm/data/standards/standards.duckdb`;
const MIN_INDUSTRY_EMP = 25_000;      // tiny industries have extreme occupation shares
const MIN_LIFT = 2;                   // the chain only credits roles at least 2x concentrated
const PDL_MIN_P = 0.25;               // PDL industry counts toward an archetype at this probability
const GENERIC = new Set([
  "Spreadsheet software", "Office suite software", "Word processing software", "Electronic mail software",
  "Presentation software", "Internet browser software", "Operating system software",
  "Cloud-based management software", "Cloud-based data access and sharing software", "Development environment software",
  "Web platform development software", "Object or component oriented development software", "Application server software",
  "Administration software",
  // Most B2B products "are" sales and marketing software; it pointed at graphic designers,
  // producers and management analysts for unrelated vendors (getweave.com, performio.co).
  "Sales and marketing software",
]);

const root = new URL("..", import.meta.url).pathname;
const repo = new URL("../../..", import.meta.url).pathname;
const tax = (f: string) => JSON.parse(readFileSync(`${root}taxonomy/${f}`, "utf8"));
const arch = tax("archetypes.v1.json") as { groups: Record<string, { label: string; archetypes: Record<string, string> }> };
const naicsArch = tax("naics_archetypes.v1.json").scores as Record<string, Record<string, number>>;
const pdlArch = tax("industry_archetypes.v1.json").scores as Record<string, Record<string, number>>;
const labels = tax("archetype_labels.v1.json").labels as Record<string, string>;

const c = await (await DuckDBInstance.create(STANDARDS, { access_mode: "READ_ONLY" })).connect();
const rows = async <T>(sql: string) => (await c.runAndReadAll(sql)).getRowObjects() as T[];
const list = (v: unknown) => (Array.isArray(v) ? v : ((v as { items?: string[] })?.items ?? [])) as string[];

const occ = await rows<{ soc: string; title: string }>(`SELECT soc, title FROM occupation ORDER BY soc`);
const occIdx = new Map(occ.map((o, i) => [o.soc, i]));
const ind = await rows<{ naics: string; title: string }>(`SELECT naics, title FROM industry WHERE emp >= ${MIN_INDUSTRY_EMP} ORDER BY naics`);
const indIdx = new Map(ind.map((x, i) => [x.naics, i]));

const sw = await rows<{ category: string; example: string; socs: unknown }>(
  `SELECT category, example, list(DISTINCT soc ORDER BY soc) AS socs FROM sw_example GROUP BY ALL ORDER BY category, example`);
const categories: Record<string, { occs: number[]; examples: Array<[string, number[]]> }> = {};
for (const r of sw) {
  if (GENERIC.has(r.category)) continue;
  const socs = list(r.socs).map((s) => occIdx.get(s)).filter((i): i is number => i !== undefined);
  const cat = (categories[r.category] ??= { occs: [], examples: [] });
  cat.examples.push([r.example, socs]);
}
for (const cat of Object.values(categories)) cat.occs = [...new Set(cat.examples.flatMap(([, s]) => s))].sort((a, b) => a - b);

const groups = await rows<{ grp: string; title: string }>(`SELECT grp, title FROM occ_group WHERE grp NOT LIKE '55-%' ORDER BY grp`);
const occByGroup = groups.map((g) => occ.map((o, i) => (o.soc.slice(0, 4) === g.grp.slice(0, 4) ? i : -1)).filter((i) => i >= 0));

// occupation -> [industry index, share, lift] where lift >= MIN_LIFT
const io = await rows<{ soc: string; naics: string; share: number; lift: number }>(
  `SELECT soc, naics, share, lift FROM industry_occ WHERE lift >= ${MIN_LIFT} ORDER BY soc, naics`);
const occIndustries: Record<number, Array<[number, number, number]>> = {};
for (const r of io) {
  const oi = occIdx.get(r.soc), ii = indIdx.get(r.naics);
  if (oi === undefined || ii === undefined) continue;
  (occIndustries[oi] ??= []).push([ii, Number(r.share.toFixed(5)), Number(r.lift.toFixed(2))]);
}
c.closeSync();

const archetypes = Object.entries(arch.groups).flatMap(([g, grp]) =>
  Object.entries(grp.archetypes).map(([k, def]) => ({ key: `${g}/${k}`, label: labels[`${g}/${k}`], group: grp.label, definition: def })));
// archetype -> PDL industries most associated with it (for TAM estimates until companies are tagged)
const pdlIndustries: Record<string, string[]> = {};
for (const a of archetypes) {
  pdlIndustries[a.key] = Object.entries(pdlArch).map(([pdl, s]) => [pdl, s[a.key] ?? 0] as [string, number])
    .filter(([, p]) => p >= PDL_MIN_P).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([pdl]) => pdl);
}

const bundle = {
  version: 1,
  sources: {
    onet: "O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA), used under the CC BY 4.0 license",
    bls: "BLS Occupational Employment and Wage Statistics, May 2025, national industry-specific estimates",
  },
  archetypes,
  pdlIndustries,
  occupations: occ.map((o) => o.title),
  occupationCodes: occ.map((o) => o.soc),
  groups: groups.map((g) => g.title),
  occByGroup,
  categories,
  industries: ind.map((x) => x.title),
  occIndustries,
  industryArchetypes: ind.map((x) => naicsArch[x.naics] ?? {}),
};
const out = `${repo}convex/lib/segments/segmentData.v1.json`;
writeFileSync(out, JSON.stringify(bundle));
console.log({ out, bytes: JSON.stringify(bundle).length, categories: Object.keys(categories).length, industries: ind.length });
