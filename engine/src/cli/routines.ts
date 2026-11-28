// `routines scan`: find the GTM work a person's AI agents repeat, from trace files on this machine (docs/routine-import.md).
// Reads only; writes only --out. Nothing is sent anywhere.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { findRoutines, parseChatExport, parseClaudeCodeJsonl, parseCodexJsonl, routineRequest, type RoutineTrace } from "../routineTraces.ts";
import { option } from "./shared.ts";

const FILE_MAX = 25_000_000;
const FILES_MAX = 5_000;

function allOptions(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[i + 1]!);
  return out;
}

function sinceMs(value: string | undefined): number {
  const m = /^(\d+)d$/.exec(value ?? "90d");
  if (!m) throw new Error(`--since takes days, like 30d (got ${value})`);
  return Date.now() - Number(m[1]) * 86_400_000;
}

function walk(dir: string, since: number, out: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= FILES_MAX) return;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, since, out);
    else if ((name.endsWith(".jsonl") || name === "conversations.json") && st.mtimeMs >= since && st.size <= FILE_MAX) out.push(path);
  }
}

export function readTraceFile(path: string): RoutineTrace[] {
  const text = readFileSync(path, "utf8");
  if (basename(path) === "conversations.json" || path.endsWith(".json")) return parseChatExport(JSON.parse(text));
  const head = text.slice(0, 4_000);
  if (/"type":"session_meta"|"type":"response_item"/.test(head) || /\/\.codex\//.test(path)) return [parseCodexJsonl(text, path)];
  return [parseClaudeCodeJsonl(text, path)];
}

export async function routinesCommand(args: string[]) {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || args.includes("--help")) {
    console.log(`routines scan [--from <dir|file>]… [--since 90d] [--min-occurrences 2] [--json] [--out <path>]

Finds GTM work you asked your AI agents for more than once. Default sources:
  ~/.claude/projects   Claude Code session logs
  ~/.codex/sessions    Codex rollouts
Add a ChatGPT or Claude.ai data export with --from <folder or conversations.json>
(ChatGPT: Settings > Data controls > Export; Claude: Settings > Privacy > Export data).

Reads only. Prompts are redacted of anything shaped like a credential. To turn a
candidate into an automation proposal, ask your agent (signed in to Canon's /mcp)
to call canon_automations.import_routine with it; an admin approves it in Canon.`);
    return;
  }
  if (sub !== "scan") throw new Error(`Unknown routines subcommand: ${sub}. Try: routines scan`);
  const since = sinceMs(option(rest, "--since") ?? undefined);
  const from = allOptions(rest, "--from").map((p) => resolve(p));
  const roots = from.length ? from : [join(homedir(), ".claude", "projects"), join(homedir(), ".codex", "sessions")].filter(existsSync);
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) throw new Error(`No such file or folder: ${root}`);
    if (statSync(root).isDirectory()) walk(root, since, files);
    else files.push(root);
  }
  const traces: RoutineTrace[] = [];
  let unreadable = 0;
  for (const file of files) {
    try {
      traces.push(...readTraceFile(file).filter((t) => t.startedAt === null || t.startedAt >= since));
    } catch {
      unreadable++;
    }
  }
  const min = Number(option(rest, "--min-occurrences") ?? 2);
  const candidates = findRoutines(traces, { minOccurrences: Number.isFinite(min) && min > 0 ? min : 2 }).map((c) => ({ ...c, request: routineRequest(c) }));
  const result = { scannedFiles: files.length, traces: traces.length, unreadable, candidates };
  const out = option(rest, "--out");
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (rest.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Scanned ${files.length} files, ${traces.length} conversations${unreadable ? ` (${unreadable} unreadable)` : ""}. ${candidates.length} repeated GTM routines.`);
  candidates.slice(0, 20).forEach((c, i) => {
    console.log(`\n${i + 1}. ${c.title}  ×${c.occurrences}, ${c.cadence} [${c.sources.join(", ")}]`);
    if (c.tools.length) console.log(`   tools: ${c.tools.join(", ")}`);
    for (const p of c.samplePrompts) console.log(`   > ${p.slice(0, 160)}`);
  });
  if (candidates.length) console.log(`\nNext: ask your Canon-connected agent to import one, e.g. "import routine 1 from ${out ?? "<the --out file>"} into Canon".`);
}
