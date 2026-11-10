import { segmentsForDomain } from "../src/jev/domainSegments.ts";
import { usage, costUsd } from "../src/jev/client.ts";
for (const d of process.argv.slice(2)) {
  const t0 = performance.now();
  try {
    const r = await segmentsForDomain(d);
    console.log(`\n=== ${d}  (${Math.round(performance.now() - t0)} ms)`);
    console.log("  jobs:", r.jobs.slice(0, 6).map((j) => `${j.label} p=${j.p.toFixed(2)} c=${j.centrality.toFixed(2)}`).join(" | "));
    for (const s of r.segments.slice(0, 12)) console.log(`  ${s.relevance.toFixed(2)}  ${s.archetype.padEnd(40)} via ${s.jtbd} -> ${s.condition}`);
  } catch (e) { console.log(`\n=== ${d}: ERROR ${(e as Error).message}`); }
}
console.log("\nusage:", usage, "cost $" + costUsd(usage.inputTokens).toFixed(4));
