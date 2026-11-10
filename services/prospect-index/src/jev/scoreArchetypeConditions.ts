// Score every archetype against every condition once with Jev Nouls, and cache
// the result as taxonomy/archetype_conditions.v1.json. This replaces a
// hand-written archetype -> condition table: the scores are reproducible
// (pinned model) and reviewable, and taxonomy/jtbd.v1.json can override any
// cell via condition_overrides.
//
//   node --experimental-strip-types src/jev/scoreArchetypeConditions.ts
import { writeFileSync } from "node:fs";
import { MODEL, costUsd, systemOne, usage, type Question } from "./client.ts";
import { allArchetypes, archetypeConditionsPath, jtbd } from "./taxonomy.ts";

const { conditions } = jtbd();
const items = allArchetypes();
const scores: Record<string, Record<string, number>> = {};

const t0 = performance.now();
let next = 0;
await Promise.all(Array.from({ length: 16 }, async () => {
  while (next < items.length) {
    const a = items[next++];
    const questions: Record<string, Question> = {};
    for (const [c, desc] of Object.entries(conditions)) {
      questions[c] = {
        type: "noul",
        instructions: `Does a typical business of the type described in \`business_type\` meet this condition: ${desc}?`,
        criteria: { true: "Most businesses of this type meet the condition", false: "Most businesses of this type do not meet the condition" },
      };
    }
    const state = { business_type: { category: a.groupLabel, type: a.archetype.replace(/_/g, " "), definition: a.definition } };
    const r = await systemOne(state, questions, 2500);
    scores[a.key] = Object.fromEntries(Object.entries(r.answers).map(([c, ans]) => [c, Number(((ans as { noul: number }).noul).toFixed(3))]));
  }
}));

const ordered = Object.fromEntries(items.map((a) => [a.key, scores[a.key]]));
writeFileSync(archetypeConditionsPath, JSON.stringify({ version: "archetype-conditions-v1", model: MODEL, scores: ordered }, null, 1) + "\n");
console.log(JSON.stringify({
  archetypes: items.length, conditions: Object.keys(conditions).length,
  requests: usage.requests, inputTokens: usage.inputTokens, costUsd: Number(costUsd(usage.inputTokens).toFixed(4)),
  secs: Math.round((performance.now() - t0) / 100) / 10,
}));
