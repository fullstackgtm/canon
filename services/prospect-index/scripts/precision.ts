// Precision of onboarding's adjacent segments, alongside label recall.
//
//   node --experimental-strip-types scripts/precision.ts [--gate 0.5,0.7,0.85] [--out file.json]
//
// For each benchmark vendor: run marketSegments (the exact onboarding code) with
// the given buyer-gate threshold, then ask Jev whether each adjacent segment it
// shows is a plausible customer for the product, judged from the site text.
//   precision    share of shown adjacent segments Jev judges plausible
//   recall       share of labeled `adjacent` segments that are shown (as buyer or adjacent)
//   shown/vendor average number of adjacent segments shown
// The judge sees only the site and the segment, not the reason the chain gave.
import { readFileSync, writeFileSync } from "node:fs";
import { marketSegments, type JevQuestion } from "../../../convex/lib/segments/marketSegments.ts";
import { pacedAsk } from "../src/jev/sharedSegments.ts";
import { usage, costUsd } from "../src/jev/client.ts";
import { allArchetypes } from "../src/jev/taxonomy.ts";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const gates = (arg("gate") ?? "0.5").split(",").map(Number);
const check = arg("check") !== "off"; // --check off: the chain without the plausibility filter
const root = new URL("..", import.meta.url).pathname;
type Vendor = { domain: string; buyers: string[]; adjacent?: string[] };
const vendors = JSON.parse(readFileSync(`${root}benchmark/vendors.v1.json`, "utf8")).vendors as Vendor[];
const texts = JSON.parse(readFileSync(`${root}benchmark/site-text.v1.json`, "utf8")) as Record<string, { title: string; description: string; text: string }>;
const siteText = (d: string) => { const t = texts[d]; return [t.title, t.description, t.text].filter(Boolean).join(" | ").slice(0, 12_000); };
const defs = Object.fromEntries(allArchetypes().map((a) => [a.key, a.definition]));

async function judge(domain: string, keys: string[]): Promise<number[]> {
  if (!keys.length) return [];
  const qs: Record<string, JevQuestion> = {};
  keys.forEach((k, i) => {
    qs[`q${i}`] = {
      type: "noul",
      instructions: `Would this kind of business plausibly buy the product sold on the website in \`website\`, even if the website does not mention it: ${defs[k]}?`,
      criteria: { true: "A realistic customer: it has the need this product serves", false: "Not a realistic customer for this product" },
    };
  });
  const p = await pacedAsk({ website: { domain, text: siteText(domain) } }, qs, 4_000);
  return keys.map((_, i) => p[`q${i}`] ?? 0);
}

const out: Record<string, unknown> = {};
for (const g of gates) {
  const u0 = usage.inputTokens;
  const rows = await Promise.all(vendors.map(async (v) => {
    const m = await marketSegments(pacedAsk, v.domain, siteText(v.domain), { gateMinP: g, plausibilityCheck: check });
    const adj = m.adjacent.map((a) => a.archetype);
    const verdicts = await judge(v.domain, adj);
    const shown = new Set([...m.buyers.map((b) => b.archetype), ...adj]);
    return {
      domain: v.domain, adjacent: m.adjacent.map((a, i) => ({ key: a.archetype, why: a.why, plausible: Number(verdicts[i].toFixed(2)) })),
      labeled: v.adjacent ?? [], hits: (v.adjacent ?? []).filter((a) => shown.has(a)),
    };
  }));
  const shownN = rows.reduce((a, r) => a + r.adjacent.length, 0);
  const plausible = rows.reduce((a, r) => a + r.adjacent.filter((x) => x.plausible >= 0.5).length, 0);
  const labeled = rows.reduce((a, r) => a + r.labeled.length, 0);
  const hits = rows.reduce((a, r) => a + r.hits.length, 0);
  const summary = {
    gate: g, check, precision: `${plausible}/${shownN} (${Math.round((100 * plausible) / Math.max(1, shownN))}%)`,
    recall: `${hits}/${labeled} (${Math.round((100 * hits) / Math.max(1, labeled))}%)`,
    "shown/vendor": (shownN / vendors.length).toFixed(2), "vendors with none": rows.filter((r) => !r.adjacent.length).length,
    cost: `$${costUsd(usage.inputTokens - u0).toFixed(3)}`,
  };
  console.log(JSON.stringify(summary));
  out[String(g)] = { summary, rows };
}
const file = arg("out");
if (file) writeFileSync(file, JSON.stringify(out, null, 1));
