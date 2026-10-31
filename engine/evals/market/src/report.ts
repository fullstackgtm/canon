import { readFileSync, writeFileSync } from "node:fs";
import { buildReport } from "./reportLib.ts";
import type { RunResult } from "./types.ts";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run report -- results/runs-*.jsonl [out.md]");
  process.exit(2);
}
const rows = readFileSync(input, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RunResult);
const report = buildReport(rows);
const out = process.argv[3];
if (out) writeFileSync(out, report);
else console.log(report);
