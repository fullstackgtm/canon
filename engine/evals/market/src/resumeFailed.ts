import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildReport } from "./reportLib.ts";
import { runOne } from "./runner.ts";
import type { Arm, RunResult } from "./types.ts";

function flag(args: string[], name: string, fallback = ""): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const args = process.argv.slice(2);
const fromPath = flag(args, "from");
if (!fromPath) throw new Error("resumeFailed requires --from <runs.jsonl>");
const outDir = flag(args, "out", "results/resume-failed");
const concurrency = Math.max(1, Number(flag(args, "concurrency", "2")));
const scenarioAllow = new Set(flag(args, "scenarios", "").split(",").map((s) => s.trim()).filter(Boolean));
const modelAllow = new Set(flag(args, "models", "").split(",").map((s) => s.trim()).filter(Boolean));
const armAllow = new Set(flag(args, "arms", "").split(",").map((s) => s.trim()).filter(Boolean));

const prior = readFileSync(fromPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RunResult);
const seen = new Set<string>();
const jobs = prior
  .filter((r) => r.error)
  .filter((r) => scenarioAllow.size === 0 || scenarioAllow.has(r.scenario))
  .filter((r) => modelAllow.size === 0 || modelAllow.has(r.model))
  .filter((r) => armAllow.size === 0 || armAllow.has(r.arm))
  .map((r) => ({ scenario: r.scenario, model: r.model, arm: r.arm as Arm, trial: r.trial ?? 1 }))
  .filter((job) => {
    const key = `${job.scenario}|${job.model}|${job.arm}|${job.trial}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonlPath = path.join(outDir, `runs-resume-${stamp}.jsonl`);
const reportPath = path.join(outDir, `report-resume-${stamp}.md`);
const transcriptDir = path.join(outDir, `transcripts-resume-${stamp}`);
const artifactDir = path.join(outDir, `artifacts-resume-${stamp}`);

console.log(`Resuming ${jobs.length} failed market-map job(s), concurrency ${concurrency}`);
const results: RunResult[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < jobs.length) {
    const job = jobs[next++];
    const label = `${job.scenario} | ${job.model} | ${job.arm} | t${job.trial}`;
    process.stdout.write(`▶ ${label}\n`);
    try {
      const result = await runOne(job.scenario, job.model, job.arm, { transcriptDir, artifactDir, trial: job.trial });
      results.push(result);
      await appendFile(jsonlPath, `${JSON.stringify(result)}\n`);
      const warn = result.violations.length ? ` ⚠ ${result.violations.length} violation(s)` : "";
      process.stdout.write(`✔ ${label} — ${result.taskScore}/${result.maxScore}${warn}${result.error ? ` (error: ${result.error})` : ""}\n`);
    } catch (error) {
      process.stdout.write(`✖ ${label} — ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
await writeFile(reportPath, buildReport(results));
console.log(`\nResume results: ${jsonlPath}\nResume report:  ${reportPath}`);
