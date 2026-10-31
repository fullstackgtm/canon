// TAM preview: run the domain chain, then match segments against classified
// companies (a tagged sample here; the full index after the corpus run).
import { readFileSync } from "node:fs";
import { segmentsForDomain } from "../src/jev/domainSegments.ts";
const [domain, sampleFile, minRel = "0.55", minP = "0.4"] = process.argv.slice(2);
const sample = JSON.parse(readFileSync(sampleFile, "utf8")) as any[];
const scale = 23829494 / sample.length;
const r = await segmentsForDomain(domain);
const segs = r.segments.filter((s) => s.relevance >= Number(minRel));
console.log(`${domain}: jobs = ${r.jobs.slice(0, 3).map((j) => j.label).join(" | ")}`);
let total = 0;
for (const s of segs.slice(0, 12)) {
  const hits = sample.filter((c) => c.archetypes?.some((a: any) => a.key === s.archetype && a.p >= Number(minP)) && c.domain !== domain);
  total += hits.length;
  const ex = hits.filter((c) => (c.sizeBand ?? "") !== "1-10").slice(0, 3).map((c) => `${c.name} (${c.sizeBand ?? "?"}, ${c.country ?? "?"})`);
  console.log(`  ${s.relevance.toFixed(2)} ${s.archetype.padEnd(38)} ~${Math.round(hits.length * scale).toLocaleString().padStart(9)} cos | e.g. ${ex.join("; ") || "—"}`);
  console.log(`       why: ${s.why}`);
}
console.log(`  ≈ ${Math.round(total * scale).toLocaleString()} companies across the top segments (full-corpus estimate)`);
