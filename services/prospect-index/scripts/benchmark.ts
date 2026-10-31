// Score domain -> buyer segment methods against benchmark/vendors.v1.json.
//
//   node --experimental-strip-types scripts/benchmark.ts [chain|direct ...] [--only domain,domain] [--out file.json]
//
// Site text comes from benchmark/site-text.v1.json (fetched once with
// ScrapingBee, JS rendered), so runs are comparable and cost only Jev tokens.
//   vertical vendors:   hit@1 = top segment is a labeled buyer; hit@3 = any of top 3
//   horizontal vendors: hit@3 = all top 3 are in the allowed set
//   adjacent labels:    recall of `adjacent` within the top 15
import { readFileSync, writeFileSync } from "node:fs";
import { segmentsForDomain } from "../src/jev/domainSegments.ts";
import { directBuyers } from "../src/jev/directBuyers.ts";
import { jobChain } from "../src/jev/jobChain.ts";
import { usage, costUsd } from "../src/jev/client.ts";

type Vendor = { domain: string; sells: string; kind: "vertical" | "horizontal"; buyers: string[]; adjacent?: string[] };
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const methods = process.argv.slice(2).filter((a) => ["chain", "direct", "jobchain", "combined", "split"].includes(a));
if (!methods.length) methods.push("chain", "direct");
const only = arg("only")?.split(",");
const CHAIN_W = Number(arg("chain-w") ?? 0.8);

const root = new URL("..", import.meta.url).pathname;
const vendors = (JSON.parse(readFileSync(`${root}benchmark/vendors.v1.json`, "utf8")).vendors as Vendor[]).filter((v) => !only || only.includes(v.domain));
const texts = JSON.parse(readFileSync(`${root}benchmark/site-text.v1.json`, "utf8")) as Record<string, { title: string; description: string; text: string }>;
const siteText = (d: string) => { const t = texts[d]; return t ? [t.title, t.description, t.text].filter(Boolean).join(" | ").slice(0, 12_000) : ""; };

const ranked: Record<string, (v: Vendor) => Promise<string[]>> = {
  chain: async (v) => (await segmentsForDomain(v.domain, { siteText: siteText(v.domain) })).segments.map((s) => s.archetype),
  direct: async (v) => (await directBuyers(v.domain, siteText(v.domain))).map((b) => b.archetype),
  jobchain: async (v) => (await jobChain(v.domain, siteText(v.domain))).segments.map((s) => s.archetype),
  // Direct buyers first; the chain adds segments the site doesn't name.
  // score = max(direct p, CHAIN_W x chain score)
  combined: async (v) => {
    const [d, c] = await Promise.all([directBuyers(v.domain, siteText(v.domain)), jobChain(v.domain, siteText(v.domain))]);
    const score = new Map<string, number>();
    for (const b of d) score.set(b.archetype, b.p);
    for (const s of c.segments) score.set(s.archetype, Math.max(score.get(s.archetype) ?? 0, CHAIN_W * s.score));
    return [...score].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  },
  // Product shape: buyer segments from the direct question, then a separate
  // block of adjacent segments from the chain. Adjacency budget stays 15:
  // direct's next 10 non-buyers... are replaced by direct's top 10 + chain's top 5.
  split: async (v) => {
    // Same wiring as onboarding (marketSegments): the chain is gated by the named buyers.
    const dP = directBuyers(v.domain, siteText(v.domain));
    const gate = dP.then((bs) => { const n = bs.filter((b) => b.p >= 0.5 && !b.archetype.endsWith("/other")); return n.length >= 15 ? [] : n.map((b) => b.archetype); });
    const [d, c] = await Promise.all([dP, jobChain(v.domain, siteText(v.domain), gate)]);
    const direct = d.map((b) => b.archetype);
    const buyers = new Set(v.buyers);
    const head = direct.filter((a) => buyers.has(a));          // labeled buyers stay where direct put them
    const dAdj = direct.filter((a) => !buyers.has(a)).slice(0, 10);
    const cAdj = c.segments.map((s) => s.archetype).filter((a) => !buyers.has(a) && !dAdj.includes(a)).slice(0, 5);
    return [...direct.slice(0, 3), ...[...head, ...dAdj, ...cAdj].filter((a) => !direct.slice(0, 3).includes(a))];
  },
};

const rows: Array<Record<string, unknown>> = [];
const summary: Record<string, Record<string, string>> = {};
for (const m of methods) {
  const u0 = usage.inputTokens;
  const res = await Promise.all(vendors.map(async (v) => {
    try { return { v, top: await ranked[m](v) }; } catch (e) { return { v, top: [] as string[], error: (e as Error).message }; }
  }));
  let v1 = 0, v3 = 0, nv = 0, h3 = 0, nh = 0, adjHit = 0, adjN = 0;
  for (const { v, top, error } of res as Array<{ v: Vendor; top: string[]; error?: string }>) {
    const set = new Set(v.buyers);
    const hit1 = set.has(top[0]), hit3 = v.kind === "vertical" ? top.slice(0, 3).some((t) => set.has(t)) : top.slice(0, 3).every((t) => set.has(t));
    if (v.kind === "vertical") { nv++; v1 += +hit1; v3 += +hit3; } else { nh++; h3 += +hit3; }
    const adjTop = top.filter((t) => !set.has(t)).slice(0, 15);
    for (const a of v.adjacent ?? []) { adjN++; adjHit += +adjTop.includes(a); }
    rows.push({ method: m, domain: v.domain, kind: v.kind, hit1, hit3, top3: top.slice(0, 3), top15: top.slice(0, 15), buyers: v.buyers, adjacent: v.adjacent ?? [], error });
  }
  const pct = (a: number, b: number) => `${a}/${b} (${Math.round((100 * a) / Math.max(1, b))}%)`;
  summary[m] = {
    "vertical hit@1": pct(v1, nv), "vertical hit@3": pct(v3, nv), "horizontal hit@3": pct(h3, nh),
    "adjacent recall@15": pct(adjHit, adjN), cost: `$${costUsd(usage.inputTokens - u0).toFixed(4)}`,
  };
}
console.table(summary);
const misses = rows.filter((r) => !r.hit3);
for (const r of misses) console.log(`${String(r.method).padEnd(6)} MISS ${String(r.domain).padEnd(26)} got ${(r.top3 as string[]).map((t) => t.split("/")[1]).join(", ")}${r.error ? "  ERROR " + r.error : ""}`);
const out = arg("out");
if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
