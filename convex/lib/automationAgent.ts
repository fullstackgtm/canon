/**
 * Ask Canon on the Automations page: a person's request in words becomes a rule document a model writes on their own
 * ChatGPT plan. Canon's `check` reads each answer as it reads an agent's proposal, and its problem goes back to the
 * model at most twice. A rule that passes is stored as a proposal from the agent "ask-canon", which waits for an admin
 * like any other (convex/automationAgent.ts). The model call, the check and the budget are injected, so tests run the
 * loop with a fake model. Free of database and Node-only imports.
 */

/** The first answer and at most two retries. */
export const MAX_ATTEMPTS = 3;
export const REQUEST_MAX = 2_000;
/** One request's model budget, charged before each call (lib/agents/webhook.ts turnMeter). */
export const ASK_BUDGET = { maxTokens: 60_000, maxSeconds: 120 };
export const ASK_AGENT = "ask-canon";
export const NO_PLAN = "Ask Canon writes rules on your own ChatGPT plan, and you haven't connected one. Connect ChatGPT in Integrations, then ask again.";

export const RULE_TOOL = "automation_rule";
export const RULE_SCHEMA = {
  type: "object",
  properties: {
    rule: {
      type: "object",
      description: "The whole rule document: name, object, trigger, conditions and actions, in the vocabulary below.",
      properties: {
        name: { type: "string" },
        object: { type: "string" },
        trigger: { type: "object" },
        conditions: { type: "array", items: { type: "object" } },
        actions: { type: "array", items: { type: "object" } },
      },
      required: ["name", "object", "trigger", "conditions", "actions"],
    },
    summary: { type: "string", description: "One or two sentences for the person: what the rule does, and anything the request asked for that a rule can't do, and why." },
  },
  required: ["rule", "summary"],
} as const;

export type RuleDocLike = { name: string; object: string; trigger: unknown; conditions: unknown[]; actions: unknown[] };
export type Checked = { ok: true; sentence: string; note?: string } | { ok: false; problem: string };
export type Asked = { ok: true; doc: RuleDocLike; sentence: string; note?: string; summary: string; attempts: number } | { ok: false; problem: string; summary: string; attempts: number };

export type AskDeps = {
  call(prompt: string): Promise<unknown>;
  check(doc: RuleDocLike): Promise<Checked>;
  /** Charges a call before it is made, and throws when it would cross the budget. */
  charge(prompt: string): void;
};

/** A model's answer as a rule document and its summary, or why it isn't one. */
export function readAnswer(answer: unknown): { doc: RuleDocLike; summary: string } | { problem: string } {
  const a = answer as { rule?: Record<string, unknown>; summary?: unknown } | null;
  const r = a?.rule;
  if (!r || typeof r !== "object") return { problem: "The answer has no rule object" };
  if (typeof r.name !== "string" || typeof r.object !== "string" || typeof r.trigger !== "object" || r.trigger === null) return { problem: "A rule needs a name, an object and a trigger" };
  return {
    doc: { name: r.name, object: r.object, trigger: r.trigger, conditions: Array.isArray(r.conditions) ? r.conditions : [], actions: Array.isArray(r.actions) ? r.actions : [] },
    summary: typeof a?.summary === "string" ? a.summary.slice(0, 600) : "",
  };
}

/** The prompt for one attempt: the vocabulary, the workspace, the request, and the last answer's problem. */
export function askPrompt(a: { vocabulary: string; workspace: string; request: string; current?: string; last?: { doc: unknown; problem: string } }): string {
  return [
    "You write one Canon automation rule for an admin, as a JSON document, by calling the tool. Canon checks it and shows the admin what it does in a sentence; nothing runs until a person approves it.",
    "Use only this vocabulary. Field names are the apiName values listed for each object; ids are the ids listed. Money is in cents.",
    a.vocabulary,
    "The workspace:",
    a.workspace,
    a.current ? `The rule to change (keep what the request doesn't change):\n${a.current}` : "",
    `The request: ${a.request}`,
    a.last ? `Your last answer was refused. Fix exactly this and answer again.\nAnswer: ${JSON.stringify(a.last.doc)}\nProblem: ${a.last.problem}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Ask for a rule until Canon's check takes it, at most MAX_ATTEMPTS times. Stores nothing. */
export async function askForRule(input: { vocabulary: string; workspace: string; request: string; current?: string }, deps: AskDeps): Promise<Asked> {
  let last: { doc: unknown; problem: string } | undefined;
  let summary = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt = askPrompt({ ...input, ...(last ? { last } : {}) });
    deps.charge(prompt);
    const read = readAnswer(await deps.call(prompt));
    if ("problem" in read) {
      last = { doc: null, problem: read.problem };
      continue;
    }
    summary = read.summary;
    const checked = await deps.check(read.doc);
    if (checked.ok) return { ok: true, doc: read.doc, sentence: checked.sentence, ...(checked.note ? { note: checked.note } : {}), summary, attempts: attempt };
    last = { doc: read.doc, problem: checked.problem };
  }
  return { ok: false, problem: last?.problem ?? "No answer", summary, attempts: MAX_ATTEMPTS };
}
