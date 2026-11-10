// One-time Jev pass: which archetypes does each 4-digit NAICS industry (as used
// by BLS OEWS) correspond to? One Choice per industry over the archetypes of
// all groups (definitions shared in state), batched. Writes
// taxonomy/naics_archetypes.v1.json: {naics: {archetypeKey: p}} keeping p >= 0.05.
//
//   node --experimental-strip-types src/standards/mapNaicsArchetypes.ts
import { writeFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { systemOne, usage, costUsd, type Question } from "../jev/client.ts";
import { allArchetypes } from "../jev/taxonomy.ts";

const STANDARDS = process.env.STANDARDS_DB ?? `${process.env.HOME}/.fullstackgtm/data/standards/standards.duckdb`;
const c = await (await DuckDBInstance.create(STANDARDS, { access_mode: "READ_ONLY" })).connect();
const industries = (await c.runAndReadAll(`SELECT naics, title FROM industry ORDER BY naics`)).getRowObjects() as Array<{ naics: string; title: string }>;

const arch = allArchetypes();
// Choice option ids must be unique; "other" exists in every group.
const ids = arch.map((a) => (a.archetype === "other" ? `${a.group}_other` : a.archetype));
const types = Object.fromEntries(arch.map((a, i) => [ids[i], `${a.groupLabel}: ${a.definition}`]));
const criteria = Object.fromEntries(ids.map((id) => [id, null]));

const BATCH = 10;
const out: Record<string, Record<string, number>> = {};
const batches = Array.from({ length: Math.ceil(industries.length / BATCH) }, (_, i) => industries.slice(i * BATCH, (i + 1) * BATCH));
await Promise.all(batches.map(async (b) => {
  const questions: Record<string, Question> = {};
  b.forEach((ind, j) => {
    questions[`i${j}`] = {
      type: "choice",
      instructions: `Which business type in \`types\` best describes a typical company in the US industry \`industries[${j}]\` (a NAICS industry as used in government employment statistics)?`,
      criteria,
    };
  });
  const r = await systemOne({ types, industries: b.map((x) => `${x.title} (NAICS ${x.naics.slice(0, 4)})`) }, questions, 1500 * b.length);
  b.forEach((ind, j) => {
    const probs = (r.answers[`i${j}`] as { probabilities: Record<string, number> }).probabilities;
    out[ind.naics] = Object.fromEntries(
      Object.entries(probs).filter(([, p]) => p >= 0.05).sort((x, y) => y[1] - x[1])
        .map(([id, p]) => [arch[ids.indexOf(id)].key, Number(p.toFixed(3))]));
  });
}));

const path = new URL("../../taxonomy/naics_archetypes.v1.json", import.meta.url).pathname;
writeFileSync(path, JSON.stringify({
  version: 1, source: "BLS OEWS May 2025 4-digit industries; Jev choice over archetypes.v1",
  titles: Object.fromEntries(industries.map((i) => [i.naics, i.title])), scores: out,
}, null, 1));
console.log({ industries: industries.length, usage, cost: costUsd(usage.inputTokens).toFixed(4) });
