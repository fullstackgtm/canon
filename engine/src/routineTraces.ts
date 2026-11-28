/**
 * Routine import (docs/routine-import.md): read the traces a person's coworking or coding agent left behind, find the
 * GTM work they repeat, and describe each repeat as a request Canon can turn into an automation proposal.
 *
 * Pure: no Node imports, so Convex functions can import it. The CLI (cli/routines.ts) reads the files.
 *
 * Formats read:
 * - Claude Code session logs (~/.claude/projects/<project>/<session>.jsonl)
 * - Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
 * - ChatGPT data export (conversations.json, an array of { title, create_time, mapping })
 * - Claude.ai data export (conversations.json, an array of { name, created_at, chat_messages })
 */

export type TraceSource = "claude-code" | "codex" | "chatgpt-export" | "claude-export";

export type RoutineTrace = {
  source: TraceSource;
  id: string;
  title: string;
  /** Milliseconds since the epoch of the first timestamped entry, or null. */
  startedAt: number | null;
  /** What the person asked, in order, redacted and truncated. */
  prompts: string[];
  /** Tool names the agent called, in order, normalized (see toolName). */
  tools: string[];
};

export type RoutineCandidate = {
  key: string;
  title: string;
  occurrences: number;
  cadence: "daily" | "weekly" | "monthly" | "irregular";
  tools: string[];
  samplePrompts: string[];
  sources: TraceSource[];
  firstSeen: number | null;
  lastSeen: number | null;
  traceIds: string[];
};

const PROMPT_MAX = 400;
const PROMPTS_PER_TRACE = 6;
/** What importRoutine passes on to Ask Canon (convex/lib/automationAgent.ts REQUEST_MAX). */
export const ROUTINE_REQUEST_MAX = 2_000;

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bbearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /["']?\b(token|access[_-]?token|api[_-]?key|password|secret|client[_-]?secret)\b["']?\s*[:=]\s*["']?[^\s"',}]{8,}["']?/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

/** Strip anything shaped like a credential. Applied to every prompt before it leaves this module. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

function clip(text: string): string {
  const t = redact(text.replace(/\s+/g, " ").trim());
  return t.length > PROMPT_MAX ? `${t.slice(0, PROMPT_MAX - 1)}…` : t;
}

/** `mcp__claude_ai_HubSpot_1a2b__search_crm` → `hubspot.search_crm`; plain names lowercased. */
export function toolName(raw: string): string {
  const name = raw.trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp) return name.toLowerCase();
  const server = mcp[1]!.replace(/^claude_ai_/, "").replace(/_[0-9a-f]{6,}$/i, "").replace(/^plugin_[^_]+_/, "").toLowerCase();
  return `${server}.${mcp[2]!.toLowerCase()}`;
}

/** Text a person typed, skipping harness wrappers (system reminders, command output, tool results). */
function personText(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  // Harness wrappers (system reminders, command output, review payloads) all open with a tag.
  if (t.startsWith("<")) return null;
  if (t.startsWith("Caveat:") || t.startsWith("# AGENTS.md")) return null;
  return t;
}

function stamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function lines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (row && typeof row === "object") out.push(row as Record<string, unknown>);
    } catch {
      // A truncated last line (a session still being written) is skipped.
    }
  }
  return out;
}

function finish(trace: RoutineTrace): RoutineTrace {
  return { ...trace, prompts: trace.prompts.slice(0, PROMPTS_PER_TRACE), title: clip(trace.title || trace.prompts[0] || trace.id).slice(0, 120) };
}

export function parseClaudeCodeJsonl(text: string, id: string): RoutineTrace {
  const trace: RoutineTrace = { source: "claude-code", id, title: "", startedAt: null, prompts: [], tools: [] };
  for (const row of lines(text)) {
    trace.startedAt ??= stamp(row.timestamp);
    if (row.type === "summary" && typeof row.summary === "string" && !trace.title) trace.title = row.summary;
    const message = row.message as { role?: string; content?: unknown } | undefined;
    if (!message) continue;
    const content = message.content;
    if (row.type === "user" && !row.isMeta) {
      const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")) : [];
      for (const t of texts) {
        const said = personText(t);
        if (said) trace.prompts.push(clip(said));
      }
    }
    if (row.type === "assistant" && Array.isArray(content)) {
      for (const block of content) if (block?.type === "tool_use" && typeof block.name === "string") trace.tools.push(toolName(block.name));
    }
  }
  return finish(trace);
}

export function parseCodexJsonl(text: string, id: string): RoutineTrace {
  const trace: RoutineTrace = { source: "codex", id, title: "", startedAt: null, prompts: [], tools: [] };
  for (const row of lines(text)) {
    trace.startedAt ??= stamp(row.timestamp);
    const payload = row.payload as Record<string, unknown> | undefined;
    if (row.type !== "response_item" || !payload) continue;
    if (payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
      for (const block of payload.content as { type?: string; text?: string }[]) {
        const said = block?.type === "input_text" ? personText(String(block.text ?? "")) : null;
        if (said) trace.prompts.push(clip(said));
      }
    }
    if ((payload.type === "function_call" || payload.type === "custom_tool_call") && typeof payload.name === "string") trace.tools.push(toolName(payload.name));
  }
  return finish(trace);
}

/** A ChatGPT or Claude.ai data export's conversations.json. Tool use is mostly absent from exports, so prompts carry the signal. */
export function parseChatExport(json: unknown): RoutineTrace[] {
  if (!Array.isArray(json)) return [];
  const out: RoutineTrace[] = [];
  for (const convo of json as Record<string, unknown>[]) {
    if (convo && typeof convo === "object" && convo.mapping && typeof convo.mapping === "object") {
      const nodes = Object.values(convo.mapping as Record<string, { message?: { author?: { role?: string; name?: string }; content?: { parts?: unknown[] }; recipient?: string; create_time?: number } }>)
        .map((n) => n.message).filter((m): m is NonNullable<typeof m> => Boolean(m))
        .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
      const trace: RoutineTrace = { source: "chatgpt-export", id: String(convo.id ?? convo.conversation_id ?? out.length), title: String(convo.title ?? ""), startedAt: stamp(convo.create_time), prompts: [], tools: [] };
      for (const m of nodes) {
        if (m.author?.role === "user") for (const part of m.content?.parts ?? []) if (typeof part === "string" && personText(part)) trace.prompts.push(clip(part));
        if (m.author?.role === "assistant" && m.recipient && m.recipient !== "all") trace.tools.push(toolName(m.recipient));
        if (m.author?.role === "tool" && m.author.name) trace.tools.push(toolName(m.author.name));
      }
      out.push(finish(trace));
    } else if (convo && Array.isArray(convo.chat_messages)) {
      const trace: RoutineTrace = { source: "claude-export", id: String(convo.uuid ?? out.length), title: String(convo.name ?? ""), startedAt: stamp(convo.created_at), prompts: [], tools: [] };
      for (const m of convo.chat_messages as { sender?: string; text?: string; content?: { type?: string; name?: string; text?: string }[] }[]) {
        if (m.sender === "human") {
          const said = personText(String(m.text ?? m.content?.find((c) => c.type === "text")?.text ?? ""));
          if (said) trace.prompts.push(clip(said));
        }
        for (const c of m.content ?? []) if (c.type === "tool_use" && c.name) trace.tools.push(toolName(c.name));
      }
      out.push(finish(trace));
    }
  }
  return out;
}

const GTM_TOOL = /canon|hubspot|salesforce|clay|apollo|zoominfo|gmail|outreach|salesloft|linkedin|granola|gong|attio|pipedrive|smartlead|instantly|lemlist|crm/i;
const GTM_WORDS = /\b(accounts?|deals?|pipeline|prospects?|leads?|icp|outreach|crm|opportunit(y|ies)|contacts?|sequences?|renewals?|churn|quota|forecast|follow[- ]?ups?|meetings?|champions?|hubspot|salesforce|enrich\w*|territor(y|ies)|inbound|outbound)\b/gi;

/** How GTM-shaped a trace is: GTM tool calls count most, GTM words in prompts a little. */
export function gtmScore(trace: RoutineTrace): number {
  if (isAutomated(trace)) return 0;
  const tools = trace.tools.filter((t) => GTM_TOOL.test(t)).length;
  const words = trace.prompts.join(" ").match(GTM_WORDS)?.length ?? 0;
  return tools * 3 + Math.min(words, 10);
}

/** A session another agent or an eval harness started (a subagent brief), not a person's request. */
export function isAutomated(trace: RoutineTrace): boolean {
  if (/\/subagents\/|\/agent-[0-9a-f]+\.jsonl$/.test(trace.id)) return true;
  const first = trace.prompts[0] ?? "";
  return /^(you are (an|a|the) (ai|agent|assistant|sub-?agent)|act as the|as a subagent|you're a subagent|the following is the codex agent history)/i.test(first);
}

const STOP = new Set("a an the and or of to for in on with my our me us is are be this that it at by from please can you could would i we all any each every new".split(" "));

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

function cadenceOf(times: number[]): RoutineCandidate["cadence"] {
  if (times.length < 3) return "irregular";
  const sorted = [...times].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => (t - sorted[i]!) / 86_400_000).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  if (median >= 0.5 && median <= 1.8) return "daily";
  if (median >= 5 && median <= 9) return "weekly";
  if (median >= 25 && median <= 35) return "monthly";
  return "irregular";
}

/**
 * Group GTM traces that look like the same job: their tools and opening prompts overlap. A group seen at least
 * `minOccurrences` times is a routine candidate, most frequent first.
 */
export function findRoutines(traces: RoutineTrace[], opts: { minOccurrences?: number; minScore?: number; similarity?: number } = {}): RoutineCandidate[] {
  const minOccurrences = opts.minOccurrences ?? 2;
  const minScore = opts.minScore ?? 3;
  const similarity = opts.similarity ?? 0.35;
  const gtm = traces.filter((t) => (t.prompts.length || t.tools.length) && gtmScore(t) >= minScore);
  const shape = (t: RoutineTrace) => new Set([...new Set(t.tools).values()].map((x) => `tool:${x}`).concat([...words(t.prompts[0] ?? t.title)]));
  const groups: { shape: Set<string>; members: RoutineTrace[] }[] = [];
  for (const trace of gtm) {
    const s = shape(trace);
    let best: (typeof groups)[number] | null = null;
    let bestScore = similarity;
    for (const g of groups) {
      const score = jaccard(s, g.shape);
      if (score >= bestScore) {
        best = g;
        bestScore = score;
      }
    }
    if (best) best.members.push(trace);
    else groups.push({ shape: s, members: [trace] });
  }
  return groups
    .filter((g) => g.members.length >= minOccurrences)
    .map((g): RoutineCandidate => {
      const counts = new Map<string, number>();
      for (const m of g.members) for (const t of new Set(m.tools)) counts.set(t, (counts.get(t) ?? 0) + 1);
      const tools = [...counts.entries()].filter(([, n]) => n * 2 >= g.members.length).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 12);
      const times = g.members.map((m) => m.startedAt).filter((t): t is number => t !== null);
      const samplePrompts = [...new Set(g.members.map((m) => m.prompts[0]).filter((p): p is string => Boolean(p)))].slice(0, 3);
      const title = g.members[0]!.title;
      return {
        key: [...g.shape].sort().slice(0, 8).join("|"),
        title, occurrences: g.members.length, cadence: cadenceOf(times), tools, samplePrompts,
        sources: [...new Set(g.members.map((m) => m.source))],
        firstSeen: times.length ? Math.min(...times) : null, lastSeen: times.length ? Math.max(...times) : null,
        traceIds: g.members.map((m) => m.id).slice(0, 20),
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences);
}

/** The words Ask Canon gets for one candidate: what the person keeps asking for, how often, with which tools. */
export function routineRequest(c: Pick<RoutineCandidate, "title" | "occurrences" | "cadence" | "tools" | "samplePrompts"> & { goal?: string }): string {
  const parts = [
    c.goal ? `Make this recurring work a rule: ${c.goal}` : `Make this recurring work a rule.`,
    `A person asked their AI agent for this ${c.occurrences} times (${c.cadence}). Title: ${c.title}.`,
    c.samplePrompts.length ? `What they asked:\n${c.samplePrompts.map((p) => `- ${p}`).join("\n")}` : "",
    c.tools.length ? `Tools the agent used: ${c.tools.join(", ")}.` : "",
    "Keep the part a rule can do the same way every time (a trigger or schedule, conditions, and set-field, task or owner actions). Say in the summary which steps need judgment and stay with the agent.",
  ].filter(Boolean).join("\n");
  return redact(parts).slice(0, ROUTINE_REQUEST_MAX);
}
