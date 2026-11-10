// For each PDL industry, which archetypes are plausible? One Jev request per
// industry (one Noul per archetype), cached as taxonomy/industry_archetypes.v1.json.
// The classifier uses it to give a company only ~10 options instead of 117,
// which is most of the per-company token cost (each option costs ~10 tokens).
//
//   node --experimental-strip-types src/jev/scoreIndustryArchetypes.ts
import { writeFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { MODEL, costUsd, systemOne, usage, type Question } from "./client.ts";
import { allArchetypes } from "./taxonomy.ts";

const out = new URL("../../taxonomy/industry_archetypes.v1.json", import.meta.url).pathname;
const indexPath = process.env.PDL_INDEX ?? `${process.env.HOME}/.fullstackgtm/data/pdl_companies.duckdb`;
const db = await DuckDBInstance.create(indexPath, { access_mode: "READ_ONLY" });
const c = await db.connect();
const industries = ((await c.runAndReadAll(`SELECT DISTINCT industry FROM companies WHERE industry IS NOT NULL ORDER BY 1`)).getRowObjects() as Array<{ industry: string }>).map((r) => r.industry);
const items = allArchetypes();

const scores: Record<string, Record<string, number>> = {};
let next = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: 16 }, async () => {
  while (next < industries.length) {
    const ind = industries[next++];
    const questions: Record<string, Question> = {};
    for (const a of items) {
      questions[a.key] = {
        type: "noul",
        instructions: `Could a company listed under the LinkedIn industry in \`industry\` plausibly be this type of business: ${a.definition}?`,
        criteria: { true: "A meaningful share of companies in this industry are this type", false: "Companies in this industry are rarely or never this type" },
      };
    }
    const r = await systemOne({ industry: ind }, questions, 5000);
    scores[ind] = Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, Number((a as { noul: number }).noul.toFixed(3))]));
  }
}));
writeFileSync(out, JSON.stringify({ version: "industry-archetypes-v1", model: MODEL, scores }, null, 0) + "\n");
console.log(JSON.stringify({ industries: industries.length, requests: usage.requests, inputTokens: usage.inputTokens, costUsd: Number(costUsd(usage.inputTokens).toFixed(4)), secs: Math.round((performance.now() - t0) / 100) / 10 }));
