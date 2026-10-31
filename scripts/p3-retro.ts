/**
 * Measures merged PRs against the p3 budgets in
 * .agents/skills/p3-mode/references/canoncrm.md ("Budgets and stop rules").
 * The retro playbook (.agents/skills/p3-mode/playbooks/retro.md) runs it.
 *
 *   node --experimental-strip-types scripts/p3-retro.ts --since 2026-10-06
 *   node --experimental-strip-types scripts/p3-retro.ts --prs 21,24,26 [--json]
 *
 * Kind and review rounds come from the `Kind:` and `Review rounds: n/3` lines
 * in each PR body. A kind ending in `?` was inferred from the title and files.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BUDGET = { reviewRounds: 3, groundworkRun: 2, minUserVisibleShare: 1 / 3, commitsWithoutRounds: 10, maxFixShare: 0.25 };

const KINDS = ["user-visible", "groundwork", "fix", "infra", "docs"] as const;
type Kind = (typeof KINDS)[number];

export type RawPr = {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  mergedAt: string;
  commits: unknown[];
  files: { path: string; additions: number }[];
};

export type PrRow = {
  number: number;
  title: string;
  mergedAt: string;
  kind: Kind;
  kindInferred: boolean;
  reviewRounds: number | null;
  commits: number;
  hoursToMerge: number;
  codeLines: number;
  testLines: number;
};

const isTest = (p: string) => /(^|\/)tests?\/|\.test\.tsx?$/.test(p);
const isDocs = (p: string) => /\.md$|^docs\//.test(p);
const isUi = (p: string) => /^(app|components|hooks)\//.test(p) || p.endsWith(".tsx");
const isInfra = (p: string) => /^(scripts|\.github|\.agents|\.claude|\.codex)\//.test(p);

function inferKind(pr: RawPr): Kind {
  if (/^(fix|hotfix)\b/i.test(pr.title)) return "fix";
  const code = pr.files.filter((f) => !isTest(f.path) && !isDocs(f.path));
  if (code.length === 0) return "docs";
  if (code.some((f) => isUi(f.path))) return "user-visible";
  if (code.every((f) => isInfra(f.path))) return "infra";
  return "groundwork";
}

export function toRow(pr: RawPr): PrRow {
  const stated = /^Kind:\s*([\w-]+)/im.exec(pr.body ?? "")?.[1]?.toLowerCase() as Kind | undefined;
  const rounds = /^Review rounds:\s*(\d+)/im.exec(pr.body ?? "")?.[1];
  const sum = (pred: (p: string) => boolean) =>
    pr.files.filter((f) => pred(f.path)).reduce((n, f) => n + f.additions, 0);
  return {
    number: pr.number,
    title: pr.title,
    mergedAt: pr.mergedAt,
    kind: stated && KINDS.includes(stated) ? stated : inferKind(pr),
    kindInferred: !(stated && KINDS.includes(stated)),
    reviewRounds: rounds === undefined ? null : Number(rounds),
    commits: pr.commits.length,
    hoursToMerge: (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 3_600_000,
    codeLines: sum((p) => !isTest(p) && !isDocs(p)),
    testLines: sum(isTest),
  };
}

export function summarize(rows: PrRow[]) {
  const ordered = [...rows].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  const breaches: string[] = [];
  const firstTwo = ordered.filter((r) => r.kind === "user-visible" || r.kind === "groundwork").slice(0, 2);
  if (firstTwo.length === 2 && firstTwo.every((r) => r.kind === "groundwork")) {
    breaches.push(`no user-visible change in the first two product PRs: #${firstTwo[0].number}, #${firstTwo[1].number}`);
  }
  let run: number[] = [];
  const flushRun = () => {
    if (run.length > BUDGET.groundworkRun) {
      breaches.push(`${run.length} groundwork PRs in a row with nothing user-visible: #${run.join(", #")}`);
    }
    run = [];
  };
  for (const r of ordered) {
    if (r.kind === "groundwork") run.push(r.number);
    else if (r.kind === "user-visible") flushRun();
    if (r.reviewRounds !== null && r.reviewRounds > BUDGET.reviewRounds) {
      breaches.push(`#${r.number} took ${r.reviewRounds} review rounds (budget ${BUDGET.reviewRounds})`);
    }
    if (r.reviewRounds === null && r.commits > BUDGET.commitsWithoutRounds) {
      breaches.push(`#${r.number} has ${r.commits} commits and no "Review rounds:" line; likely over the review budget`);
    }
    if (r.testLines > r.codeLines && r.testLines > 200) {
      breaches.push(`#${r.number} added ${r.testLines} test lines for ${r.codeLines} code lines`);
    }
  }
  flushRun();
  const product = ordered.filter((r) => r.kind === "user-visible" || r.kind === "groundwork");
  const userVisibleShare = product.length ? product.filter((r) => r.kind === "user-visible").length / product.length : 1;
  if (userVisibleShare < BUDGET.minUserVisibleShare) {
    breaches.push(`user-visible share ${(userVisibleShare * 100).toFixed(0)}% of product PRs (budget ${(BUDGET.minUserVisibleShare * 100).toFixed(0)}%)`);
  }
  const fixShare = ordered.length ? ordered.filter((r) => r.kind === "fix").length / ordered.length : 0;
  if (ordered.length >= 8 && fixShare > BUDGET.maxFixShare) {
    breaches.push(`fix share ${(fixShare * 100).toFixed(0)}% of PRs (budget ${(BUDGET.maxFixShare * 100).toFixed(0)}%): work is shipping before it works`);
  }
  const code = ordered.reduce((n, r) => n + r.codeLines, 0);
  const tests = ordered.reduce((n, r) => n + r.testLines, 0);
  const hours = ordered.map((r) => r.hoursToMerge).sort((a, b) => a - b);
  return {
    prs: ordered.length,
    userVisibleShare,
    fixShare,
    testToCode: code ? tests / code : 0,
    medianHoursToMerge: hours.length ? (hours[Math.floor((hours.length - 1) / 2)] + hours[Math.floor(hours.length / 2)]) / 2 : 0,
    breaches,
  };
}

const FIELDS = "number,title,body,createdAt,mergedAt,commits,files";

function gh(args: string[]): unknown {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}

function fetchPrs(args: { since?: string; prs?: number[]; repo?: string }): RawPr[] {
  const repo = args.repo ? ["--repo", args.repo] : [];
  if (args.prs) {
    return args.prs.map((n) => gh(["pr", "view", String(n), ...repo, "--json", FIELDS]) as RawPr).filter((pr) => pr.mergedAt);
  }
  // GitHub's GraphQL node cap rejects `commits` + `files` much past 50 PRs, so list
  // numbers first and fetch details one PR at a time.
  const numbers = gh(["pr", "list", ...repo, "--state", "merged", "--limit", "1000",
    "--search", `merged:>=${args.since}`, "--json", "number"]) as { number: number }[];
  if (numbers.length === 1000) throw new Error("1000 or more merged PRs since that date; narrow --since");
  return fetchPrs({ prs: numbers.map((n) => n.number), repo: args.repo });
}

function main(argv: string[]) {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = flag("--since");
  const prs = flag("--prs")?.split(",").filter(Boolean).map(Number);
  if (!since && !prs) {
    console.error("usage: p3-retro.ts --since YYYY-MM-DD | --prs 21,24,26 [--repo owner/name] [--json]");
    process.exit(2);
  }
  const rows = fetchPrs({ since, prs, repo: flag("--repo") }).map(toRow);
  const summary = summarize(rows);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ rows, summary }, null, 2));
    return;
  }
  console.log("| PR | Kind | Rounds | Commits | Hours | Code | Tests | Title |\n|---|---|---|---|---|---|---|---|");
  for (const r of [...rows].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt))) {
    const rounds = r.reviewRounds ?? "-";
    console.log(`| #${r.number} | ${r.kind}${r.kindInferred ? "?" : ""} | ${rounds} | ${r.commits} | ${r.hoursToMerge.toFixed(1)} | ${r.codeLines} | ${r.testLines} | ${r.title} |`);
  }
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  console.log(`\n${summary.prs} PRs. User-visible share ${pct(summary.userVisibleShare)}, fix share ${pct(summary.fixShare)}, ` +
    `test lines per code line ${summary.testToCode.toFixed(2)}, median ${summary.medianHoursToMerge.toFixed(1)} h to merge.`);
  console.log(summary.breaches.length ? `\nBudget breaches:\n${summary.breaches.map((b) => `- ${b}`).join("\n")}` : "\nNo budget breaches.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
