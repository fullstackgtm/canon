/**
 * Live research for one candidate group, on the acting user's ChatGPT plan (the Codex backend, llm.ts provider
 * "chatgpt"). Hosted callers get the options from convex/lib/llmResolver.ts `resolveLlm`; the CLI from
 * `fullstackgtm login chatgpt`. There is no server-key fallback.
 *
 * The model has three tools:
 *   - `web_search`, the backend's built-in search, to find pages;
 *   - `fetch_page`, which we run: it returns a page's text, and that exact text is what the verbatim gate checks;
 *   - `submit_research`, a strict function for the answer.
 * Requests are unstored (`store: false`), so each turn resends the conversation, with reasoning carried as
 * encrypted content.
 *
 * The model is a researcher, not an authority. Its answer goes through the same gates as research written by a
 * person (research.ts). When quotes fail, it gets one repair turn listing them (`buildEvidenceRepairPrompt`). The
 * model never sets `attestedBy`: only a person can vouch for a claim.
 */
import { buildEvidenceRepairPrompt } from "../../../modules/kernel/evidence.ts";
// Type-only: llm.ts pulls in the Node credential store, and this module must run in Convex.
import type { LlmCallOptions } from "../llm.ts";
import type { CanonicalAccount, CanonicalGtmSnapshot } from "../types.ts";
import { accountParentId } from "../accountFamily.ts";
import { accountValue, rawString } from "./normalize.ts";
import type { HierarchyPolicy } from "./policy.ts";
import {
  checkResearch,
  ENTITY_STATUSES,
  fetchPage,
  verifyResearch,
  type GroupResearch,
  type PageReader,
  type ResearchVerification,
} from "./research.ts";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const MAX_TURNS = 40;
/** llm.ts DEFAULT_MODELS.chatgpt; CHATGPT_MODEL (CLI) or the resolver's model overrides it. */
const DEFAULT_MODEL = "gpt-6-luna";
/** Page text sent back to the model per fetch. The gate checks the whole page. */
const PAGE_CHARS_TO_MODEL = 30_000;

const CITATIONS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["url", "quote", "note"],
    properties: {
      url: { type: "string", description: "A page you read with fetch_page." },
      quote: { type: "string", description: "Copied word for word from that page's text: a sentence or phrase of at least a few words." },
      note: { type: "string", description: "One line: why the quote supports the claim." },
    },
  },
} as const;

const SUBMIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ultimateParent", "entities"],
  properties: {
    ultimateParent: {
      type: "object",
      additionalProperties: false,
      required: ["name", "citations"],
      properties: { name: { type: "string" }, citations: CITATIONS_SCHEMA },
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status", "accountIds", "parent", "ownerNow", "citations", "facts"],
        properties: {
          name: { type: "string" },
          status: { type: "string", enum: [...ENTITY_STATUSES] },
          accountIds: { type: "array", items: { type: "string" }, description: "CRM account ids from the list that are this entity; [] if none." },
          parent: { type: ["string", "null"], description: "Name of an intermediate parent entity in this list, or null for directly under the ultimate parent." },
          ownerNow: { type: ["string", "null"], description: "For divested or not_owned: who owns it now. Else null." },
          citations: CITATIONS_SCHEMA,
          facts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "value", "citations"],
              properties: { field: { type: "string" }, value: { type: "string" }, citations: CITATIONS_SCHEMA },
            },
          },
        },
      },
    },
  },
} as const;

const TOOLS = [
  { type: "web_search" },
  {
    type: "function",
    name: "fetch_page",
    description: "Fetch a web page and return its text. Quote only from text this tool returned.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string" } } },
  },
  {
    type: "function",
    name: "submit_research",
    description: "Submit the finished research for this corporate family. Call it once, when every claim is cited.",
    strict: true,
    parameters: SUBMIT_SCHEMA,
  },
];

const INSTRUCTIONS =
  "You research corporate ownership for a CRM cleanup. Use web_search to find pages, fetch_page to read them, and " +
  "submit_research to answer. Every quote must be copied exactly from text fetch_page returned. Never cite a search " +
  "snippet. Enrichment-vendor data in the request is a lead, never a source.";

type Item = { type: string; [k: string]: unknown };

export type ResearchRun = {
  research: GroupResearch;
  verification: ResearchVerification;
  /** Text of every page the agent read, keyed by URL: the evidence the verbatim gate checked. */
  pages: Record<string, string>;
  model: string;
  turns: number;
};

export function describeAccounts(accounts: CanonicalAccount[], snapshot: CanonicalGtmSnapshot, policy: HierarchyPolicy): string {
  const byId = new Map(snapshot.accounts.map((a) => [String(a.id), a]));
  return accounts
    .map((a) => {
      const parent = accountParentId(a);
      const parts = [
        `${a.id}: ${a.name}`,
        a.domain ? `website ${a.domain}` : null,
        parent ? `parent ${byId.get(parent)?.name ?? parent}` : "no parent",
        `country ${accountValue(a, countryFieldOf(snapshot, policy)) ?? "blank"}`,
        policy.ultimateParentField && rawString(a, policy.ultimateParentField) ? `enrichment vendor says ultimate parent "${rawString(a, policy.ultimateParentField)}"` : null,
      ];
      return `- ${parts.filter(Boolean).join("; ")}`;
    })
    .join("\n");
}

/** The account field a billing-country fact names: the policy's, else Canon's column or Salesforce's billing country. */
export function countryFieldOf(snapshot: Pick<CanonicalGtmSnapshot, "provider">, policy: HierarchyPolicy): string {
  return policy.region?.countryField ?? (snapshot.provider === "canon" ? "country" : "BillingCountry");
}

export function researchPrompt(input: { group: string; rootAccount: CanonicalAccount; accountList: string; today: string; countryField?: string }): string {
  return `Today is ${input.today}. You are checking a CRM's account hierarchy for the corporate family "${input.group}" (top account: ${input.rootAccount.name}, id ${input.rootAccount.id}).

These CRM accounts may belong to the family, be duplicates of each other, or have left it:
${input.accountList}

For each company or brand these accounts represent, find out from the web whether it is:
- owned: owned by ${input.group} today (directly or through an intermediate company);
- divested: was owned and has been sold (say who owns it now);
- not_owned: never was, or the CRM puts it here by mistake (say who owns it);
- sale_pending: a sale is announced or reported but has not closed.
Prefer the parent company's own pages (its list of brands or subsidiaries) and recent news for changes. Check for sales and spin-offs in the last two years: the enrichment vendor data above is often out of date and is a lead, never a source.
When the sources show an intermediate company (a brand that is itself the parent of other brands in the list), name it as "parent" and add it as an entity, with accountIds [] if the CRM has no account for it.
Add "facts" only for a billing-country fix the sources clearly support for that specific legal entity (field "${input.countryField ?? "BillingCountry"}", value as a country name). Leave facts empty otherwise.

Citation rules, which a program checks:
- Every claim needs at least one citation: the URL of a page you read with fetch_page, and a quote copied word for word from the text it returned (a sentence or a phrase of at least a few words).
- If fetch_page fails for a page, find another source; don't cite a page you couldn't read.
- Don't paraphrase inside "quote". Put your gloss in "note".

When you are done, call submit_research once with every account above assigned to an entity (accountIds), or left out when you found nothing about it.`;
}

/** Every output item of one streamed, unstored Responses call, in order. */
export async function readResponseItems(body: ReadableStream<Uint8Array>): Promise<Item[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const items: Item[] = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event: { type?: string; item?: Item; response?: { error?: { message?: string } } };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === "response.failed" || event.type === "error") {
        throw new Error(`ChatGPT request failed: ${event.response?.error?.message ?? "unknown error"}`);
      }
      if (event.type === "response.output_item.done" && event.item) items.push(event.item);
    }
    if (done) break;
  }
  return items;
}

async function callCodex(llm: LlmCallOptions, model: string, input: Item[], fetchImpl: typeof fetch): Promise<Item[]> {
  if (llm.provider !== "chatgpt" || !llm.chatgptAccountId) throw new Error("Account hierarchy research runs on a ChatGPT sign-in (provider chatgpt).");
  const url = llm.chatgptBaseUrl ? `${llm.chatgptBaseUrl.replace(/\/$/, "").replace(/\/responses$/, "")}/responses` : CODEX_URL;
  const response = await fetchImpl(url, {
    method: "POST",
    signal: AbortSignal.timeout(4 * 60_000),
    headers: {
      Authorization: `Bearer ${llm.apiKey}`,
      "chatgpt-account-id": llm.chatgptAccountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: INSTRUCTIONS,
      input,
      tools: TOOLS,
      tool_choice: "auto",
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      store: false,
      stream: true,
    }),
  });
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? " The ChatGPT session expired or was revoked: sign in again." : response.status === 429 ? " The ChatGPT plan's usage limit is reached." : "";
    throw new Error(`ChatGPT API error ${response.status}.${hint}`);
  }
  if (!response.body) throw new Error("ChatGPT returned no streaming response body.");
  return readResponseItems(response.body);
}

/** Runs the tool loop until the model calls submit_research. Returns its parsed arguments and call id. */
async function runUntilSubmitted(
  llm: LlmCallOptions,
  model: string,
  input: Item[],
  fetchImpl: typeof fetch,
  read: PageReader,
  pages: Record<string, string>,
  turns: { n: number },
  deadline: number,
): Promise<{ args: unknown; callId: string }> {
  let nudged = 0;
  let warned = false;
  while (turns.n++ < MAX_TURNS) {
    if (!warned && Date.now() > deadline) {
      warned = true;
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "Time is up. Call submit_research now with what you have verified so far, following the citation rules." }] });
    }
    const output = await callCodex(llm, model, input, fetchImpl);
    input.push(...output);
    const calls = output.filter((i) => i.type === "function_call") as Array<Item & { name: string; arguments: string; call_id: string }>;
    const submit = calls.find((c) => c.name === "submit_research");
    if (submit) return { args: JSON.parse(submit.arguments), callId: submit.call_id };
    if (!calls.length) {
      if (nudged++ >= 1) throw new Error("the model stopped without calling submit_research");
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "Call submit_research now with what you found, following the citation rules." }] });
      continue;
    }
    const results = await Promise.all(
      calls.map(async (c) => {
        if (c.name !== "fetch_page") return { type: "function_call_output", call_id: c.call_id, output: `Unknown tool ${c.name}.` };
        const { url } = JSON.parse(c.arguments) as { url: string };
        const page = /^https?:\/\//.test(url) ? await read(url) : { ok: false as const, detail: "not an http(s) URL" };
        if (!page.ok) return { type: "function_call_output", call_id: c.call_id, output: `Could not read ${url}: ${page.detail}. Use another source.` };
        pages[url] = page.text;
        const text = page.text.length > PAGE_CHARS_TO_MODEL ? `${page.text.slice(0, PAGE_CHARS_TO_MODEL)} [truncated]` : page.text;
        return { type: "function_call_output", call_id: c.call_id, output: text };
      }),
    );
    input.push(...results);
  }
  throw new Error(`research did not finish within ${MAX_TURNS} turns`);
}

type Cite = { url: string; quote: string; note: string };
function toResearch(args: unknown, group: string, rootId: string, model: string, today: string): GroupResearch {
  const raw = args as {
    ultimateParent: { name: string; citations: Cite[] };
    entities: Array<{ name: string; status: GroupResearch["entities"][number]["status"]; accountIds: string[]; parent: string | null; ownerNow: string | null; citations: Cite[]; facts: Array<{ field: string; value: string; citations: Cite[] }> }>;
  };
  // Keep only schema fields: attestedBy above all is a person's call, never the model's.
  const cite = (list: Cite[]) => list.map(({ url, quote, note }) => ({ url, quote, note }));
  return {
    group,
    ultimateParent: { name: raw.ultimateParent.name, accountId: rootId, citations: cite(raw.ultimateParent.citations) },
    researchedAt: today,
    researchedBy: `${model} on ChatGPT (web search, fetched pages), unreviewed`,
    entities: raw.entities.map((e) => ({
      name: e.name,
      status: e.status,
      accountIds: e.accountIds,
      ...(e.parent ? { parent: e.parent } : {}),
      ...(e.ownerNow ? { ownerNow: e.ownerNow } : {}),
      citations: cite(e.citations),
      ...(e.facts.length ? { facts: e.facts.map((f) => ({ field: f.field, value: f.value, citations: cite(f.citations) })) } : {}),
    })),
  };
}

export async function researchGroup(input: {
  llm: LlmCallOptions;
  group: string;
  rootId: string;
  accounts: CanonicalAccount[];
  snapshot: CanonicalGtmSnapshot;
  policy: HierarchyPolicy;
  today?: string;
  read?: PageReader;
  fetchImpl?: typeof fetch;
  /** Wall-clock budget: after it the model is told to submit, and the repair turn is skipped. */
  budgetMs?: number;
}): Promise<ResearchRun> {
  const deadline = Date.now() + (input.budgetMs ?? 15 * 60_000);
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const model = input.llm.model ?? DEFAULT_MODEL;
  const fetchImpl = input.fetchImpl ?? input.llm.fetchImpl ?? fetch;
  const read = input.read ?? fetchPage;
  const root = input.snapshot.accounts.find((a) => String(a.id) === input.rootId);
  if (!root) throw new Error(`account ${input.rootId} is not in the snapshot`);
  const prompt = researchPrompt({ group: input.group, rootAccount: root, accountList: describeAccounts(input.accounts, input.snapshot, input.policy), today, countryField: countryFieldOf(input.snapshot, input.policy) });
  const conversation: Item[] = [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }];
  const pages: Record<string, string> = {};
  const turns = { n: 0 };

  let submitted = await runUntilSubmitted(input.llm, model, conversation, fetchImpl, read, pages, turns, deadline);
  let research = checkResearch(toResearch(submitted.args, input.group, input.rootId, model, today));
  let verification = await verifyResearch(research, { pages, read });
  const rejected = Object.values(verification.checks).filter((c) => c.result !== "verified" && c.result !== "attested").map((c) => c.quote);
  if (rejected.length && Date.now() < deadline) {
    // One repair turn: answer the submit call with the failed quotes so the model can re-read and correct them.
    conversation.push({ type: "function_call_output", call_id: submitted.callId, output: buildEvidenceRepairPrompt("Fix the research and call submit_research again.", rejected) });
    submitted = await runUntilSubmitted(input.llm, model, conversation, fetchImpl, read, pages, turns, deadline);
    research = checkResearch(toResearch(submitted.args, input.group, input.rootId, model, today));
    verification = await verifyResearch(research, { pages, read });
  }
  return { research, verification, pages, model, turns: turns.n };
}
