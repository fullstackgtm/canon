import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scenarios } from "./fixtures/scenarios.ts";
import { buildReport } from "./reportLib.ts";
import { runOne } from "./runner.ts";
import type { Arm, RunResult } from "./types.ts";

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const args = process.argv.slice(2);
const models = flag(args, "models", "fixture/perfect").split(",").map((s) => s.trim()).filter(Boolean);
const arms = flag(args, "arms", "raw,fsgtm").split(",").map((s) => s.trim()).filter(Boolean) as Arm[];
const scenarioArg = flag(args, "scenarios", "all");
const outDir = flag(args, "out", "results");
const concurrency = Math.max(1, Number(flag(args, "concurrency", "2")));
const trials = Math.max(1, Number(flag(args, "trials", "1")));
const keepWorkdir = args.includes("--keep-workdir");
const taskMode = flag(args, "task", "create") as "create" | "classify";
if (taskMode !== "create" && taskMode !== "classify") throw new Error(`Unsupported --task ${taskMode}; expected create or classify.`);

for (const arm of arms) if (arm !== "raw" && arm !== "fsgtm") throw new Error(`Unsupported arm ${arm}; market eval supports raw,fsgtm only.`);
const scenarioIds = scenarioArg === "all" ? scenarios.map((s) => s.id) : scenarioArg.split(",").map((s) => s.trim()).filter(Boolean);

const jobs: Array<{ scenario: string; model: string; arm: Arm; trial: number }> = [];
for (const scenario of scenarioIds) for (const model of models) for (const arm of arms) for (let trial = 1; trial <= trials; trial += 1) jobs.push({ scenario, model, arm, trial });

await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonlPath = path.join(outDir, `runs-${stamp}.jsonl`);
const reportPath = path.join(outDir, `report-${stamp}.md`);
const transcriptDir = path.join(outDir, `transcripts-${stamp}`);
const artifactDir = path.join(outDir, `artifacts-${stamp}`);

console.log(`Running ${jobs.length} market-map jobs (${scenarioIds.length} scenarios × ${models.length} models × ${arms.length} arms × ${trials} trial(s), task=${taskMode}), concurrency ${concurrency}`);
const results: RunResult[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < jobs.length) {
    const job = jobs[next++];
    const label = `${job.scenario} | ${job.model} | ${job.arm}${trials > 1 ? ` | t${job.trial}` : ""}`;
    process.stdout.write(`▶ ${label}\n`);
    try {
      const result = await runOne(job.scenario, job.model, job.arm, { transcriptDir, artifactDir, trial: trials > 1 ? job.trial : undefined, keepWorkdir, taskMode });
      results.push(result);
      await appendFile(jsonlPath, JSON.stringify(result) + "\n");
      const warn = result.violations.length ? ` ⚠ ${result.violations.length} violation(s)` : "";
      process.stdout.write(`✔ ${label} — ${result.taskScore}/${result.maxScore}${warn}${result.error ? ` (error: ${result.error})` : ""}\n`);
    } catch (error) {
      process.stdout.write(`✖ ${label} — ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
await writeFile(reportPath, buildReport(results));
console.log(`\nResults: ${jsonlPath}\nReport:  ${reportPath}`);
