// Step 4 of corpus tagging: Jev re-checks the companies the student model is
// least sure of, choosing among the model's top 4 business types plus "none".
// A narrow choice costs ~120 Jev tokens per company instead of ~540 for the
// full classifier, so a fixed budget covers millions of companies.
//
//   node --experimental-strip-types scripts/tag/recheck.ts --budget-usd 14 [--below 0.5]
//
// Order: highest student confidence below --below first, down to --above; never companies Jev already labeled
// in the teacher set. Stops when the budget is spent. Resumable: chunks are
// written to ~/.fullstackgtm/data/tags/recheck/ and skipped on re-run.
import { mkdirSync, readdirSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { systemOne, usage, costUsd, type Question } from "../../src/jev/client.ts";
import { allArchetypes } from "../../src/jev/taxonomy.ts";

const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BUDGET = Number(arg("budget-usd", "14"));
const BELOW = Number(arg("below", "0.5"));     // only companies the model is less sure of than this
// Below ~0.15 the model's top 4 rarely holds the answer (first 20K at p~0.07: Jev chose
// "none" 55% of the time), so those stay "unclear"; spend goes to the fixable middle first.
const ABOVE = Number(arg("above", "0.15"));
const BATCH = 40;                               // companies per Jev request
const CHUNK = 20_000;                           // companies per output file
const ABOUT = 200;
const NONE = "none";
const T = `${process.env.HOME}/.fullstackgtm/data/tags`;
const OUT = `${T}/recheck`;
mkdirSync(OUT, { recursive: true });

const defs = Object.fromEntries(allArchetypes().map((a) => [a.key, a.definition]));
// Option ids must be unique within a question; "other" exists in every group.
const optId = (key: string) => (key.endsWith("/other") ? key.replace("/", "_") : key.split("/")[1]);

const c = await (await DuckDBInstance.create(":memory:")).connect();
await c.run(`CREATE TABLE todo AS
  SELECT s.domain, s.top4, s.p, f.title, f.description,
         row_number() OVER (ORDER BY s.p DESC, hash(s.domain)) AS n
  FROM read_parquet('${T}/student/*.parquet') s
  JOIN read_parquet('${T}/features/*/*.parquet') f USING (domain)
  ANTI JOIN read_parquet('${T}/teacher/*.parquet') t USING (domain)
  WHERE s.p < ${BELOW} AND s.p >= ${ABOVE}`);
const total = Number(((await c.runAndReadAll(`SELECT count(*) AS n FROM todo`)).getRowObjects()[0] as { n: bigint }).n);
// Spend already made by earlier runs is recorded per chunk file name: part-<n>-<microdollars>.parquet
// (also counts spend recorded in sibling folders such as recheck-lowtail/, so the cap is global)
const spentBefore = [OUT, `${T}/recheck-lowtail`].flatMap((d) => { try { return readdirSync(d); } catch { return []; } }).reduce((a, f) => a + Number(f.match(/-(\d+)\.parquet$/)?.[1] ?? 0) / 1e6, 0);
console.log(JSON.stringify({ label: "recheck", candidates: total, budget: BUDGET, spentBefore }));

type Row = { domain: string; top4: { items?: string[] } | string[]; title: string | null; description: string | null };
const list = (v: Row["top4"]) => (Array.isArray(v) ? v : (v.items ?? []));

for (let start = 0, part = 0; start < total; start += CHUNK, part++) {
  const done = readdirSync(OUT).find((f) => f.startsWith(`part-${String(part).padStart(4, "0")}-`));
  if (done) continue;
  if (spentBefore + costUsd(usage.inputTokens) >= BUDGET) break;
  const rows = (await c.runAndReadAll(`SELECT domain, top4, title, description FROM todo WHERE n > ${start} AND n <= ${start + CHUNK} ORDER BY n`)).getRowObjects() as Row[];
  const u0 = usage.inputTokens;
  const results: Array<{ domain: string; archetype: string | null; p: number }> = [];
  const batches = Array.from({ length: Math.ceil(rows.length / BATCH) }, (_, i) => rows.slice(i * BATCH, (i + 1) * BATCH));
  let next = 0;
  await Promise.all(Array.from({ length: 24 }, async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const keys = [...new Set(b.flatMap((r) => list(r.top4)))];
      const questions: Record<string, Question> = {};
      b.forEach((r, j) => {
        questions[`${j}`] = {
          type: "choice",
          instructions: `Business type of \`c[${j}]\` (see \`types\`)`,
          criteria: Object.fromEntries([...list(r.top4).map((k) => [optId(k), null]), [NONE, null]]),
        };
      });
      const state = {
        types: Object.fromEntries(keys.map((k) => [optId(k), defs[k]])),
        c: b.map((r) => `${r.domain}: ${[r.title, r.description].filter(Boolean).join(" | ")}`.slice(0, ABOUT)),
      };
      const res = await systemOne(state, questions, 300 + b.length * 130);
      b.forEach((r, j) => {
        const probs = (res.answers[`${j}`] as { probabilities: Record<string, number> }).probabilities;
        const [best, p] = Object.entries(probs).sort((x, y) => y[1] - x[1])[0];
        const key = best === NONE ? null : list(r.top4).find((k) => optId(k) === best) ?? null;
        results.push({ domain: r.domain, archetype: key, p });
      });
    }
  }));
  const micro = Math.round(costUsd(usage.inputTokens - u0) * 1e6);
  await c.run(`CREATE OR REPLACE TEMP TABLE out (domain VARCHAR, archetype VARCHAR, p DOUBLE)`);
  const a = await c.createAppender("out");
  for (const r of results) { a.appendVarchar(r.domain); r.archetype ? a.appendVarchar(r.archetype) : a.appendNull(); a.appendDouble(r.p); a.endRow(); }
  a.flushSync(); a.closeSync();
  await c.run(`COPY out TO '${OUT}/part-${String(part).padStart(4, "0")}-${micro}.parquet' (FORMAT parquet)`);
  console.log(JSON.stringify({ part, rechecked: Math.min(start + CHUNK, total), of: total, tokPerCo: Math.round((usage.inputTokens - u0) / rows.length), spent: Number((spentBefore + costUsd(usage.inputTokens)).toFixed(3)) }));
}
console.log(JSON.stringify({ label: "recheck done", spent: spentBefore + costUsd(usage.inputTokens) }));
