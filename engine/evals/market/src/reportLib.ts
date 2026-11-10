import type { RunResult } from "./types.ts";

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }
function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function esc(s: string): string { return String(s).replace(/\|/g, "\\|").replace(/\n/g, " "); }

type Group = { model: string; arm: string; runs: RunResult[] };

export function summarize(results: RunResult[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of results) {
    const key = `${r.model}\t${r.arm}`;
    if (!map.has(key)) map.set(key, { model: r.model, arm: r.arm, runs: [] });
    map.get(key)!.runs.push(r);
  }
  return Array.from(map.values()).sort((a, b) => avg(b.runs.map((r) => r.taskScore / r.maxScore)) - avg(a.runs.map((r) => r.taskScore / r.maxScore)));
}

export function buildReport(results: RunResult[]): string {
  const lines: string[] = [];
  lines.push("# Market Map Bench Results", "");
  lines.push(`${results.length} run(s). Headline score is deterministic artifact grading: final market config + observations + report; no LLM judge.`);
  lines.push("");
  lines.push("## Leaderboard", "");
  lines.push("| Model | Arm | Quality | Hard-gate pass | Macro F1 | LOUD precision | False LOUD | Evidence verified | Violations | Avg tokens | Avg $/run | |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const g of summarize(results)) {
    const runs = g.runs;
    const hard = runs.filter((r) => r.metrics.hardGatePass).length / Math.max(1, runs.length);
    const violations = runs.reduce((n, r) => n + r.violations.length, 0);
    const toks = avg(runs.map((r) => r.inputTokens + r.outputTokens));
    const cost = avg(runs.map((r) => r.costUsd || 0));
    lines.push(`| ${esc(g.model)} | ${g.arm} | ${(avg(runs.map((r) => r.taskScore / r.maxScore)) * 100).toFixed(1)} | ${pct(hard)} | ${pct(avg(runs.map((r) => r.metrics.macroF1)))} | ${pct(avg(runs.map((r) => r.metrics.loudPrecision)))} | ${pct(avg(runs.map((r) => r.metrics.falseLoudRate)))} | ${pct(avg(runs.map((r) => r.metrics.evidenceVerificationRate)))} | ${violations} | ${Math.round(toks).toLocaleString()} | ${cost ? `$${cost.toFixed(4)}` : "—"} | |`);
  }
  lines.push("");
  lines.push("## Per-run matrix", "");
  lines.push("| Scenario | Model | Arm | Score | Hard gate | Claim R/P | Class acc | Evidence | Violations | Cost | Notes |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const r of results) {
    lines.push(`| ${r.scenario} | ${esc(r.model)} | ${r.arm} | ${r.taskScore}/${r.maxScore} | ${r.metrics.hardGatePass ? "yes" : "no"} | ${pct(r.metrics.claimRecall)}/${pct(r.metrics.claimPrecision)} | ${pct(r.metrics.classificationAccuracy)} | ${pct(r.metrics.evidenceVerificationRate)} | ${r.violations.length} | ${r.costUsd ? `$${r.costUsd.toFixed(4)}` : "—"} | ${esc(r.notes.join("; "))} |`);
  }
  lines.push("");
  lines.push("## Violation details", "");
  for (const r of results.filter((r) => r.violations.length > 0)) {
    lines.push(`### ${r.scenario} · ${r.model} · ${r.arm}`);
    for (const v of r.violations.slice(0, 20)) lines.push(`- **${v.code}** — ${v.detail}`);
    if (r.violations.length > 20) lines.push(`- … ${r.violations.length - 20} more`);
    lines.push("");
  }
  return lines.join("\n");
}
