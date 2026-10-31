/**
 * Recommended AI segments: an LLM proposes traits, Jev measures them.
 *
 * The LLM (the user's ChatGPT plan, via lib/llmResolver) reads what we know
 * about the vendor and its pipeline and proposes candidate traits. Each must
 * cite its basis with a quote copied from those inputs; quotes that aren't
 * found verbatim are dropped. Jev then answers every candidate for a sample of
 * accounts in the current scope, and candidates are ranked by how decisively
 * they split that sample. Jev's probabilities and thresholds are untouched:
 * the LLM writes questions, Jev answers them.
 *
 * Pure: the action in convex/tamSuggestActions.ts does the I/O.
 */
import type { SystemOneAnswer, SystemOneQuestion } from "../segments/jev";
import { bucketFor, choiceQuestion, noulQuestion, optionKey, UNSURE, type ChoiceOption } from "./jevSegments.ts";

export const MAX_SUGGESTIONS = 8;
export const SAMPLE_SIZE = 40;
const MAX_OPTIONS = 6;
/** The smaller side of a split must reach this share to count as splitting the view. */
const SPLIT_MIN_SHARE = 0.1;
/** At this smaller-side share a split earns full marks; below it the score scales down. */
const FULL_SPLIT_SHARE = 0.2;

export type SuggestionContext = {
  vendorDomain?: string;
  icp?: unknown;
  buyers: Array<{ label: string; why: string }>;
  jobs: string[];
  existingSegments: Array<{ label: string; criterion: string }>;
  closedDeals: Array<{ name: string; won: boolean; amount?: number; account?: string; industry?: string; employees?: number }>;
  callInsights: Array<{ type: string; text: string; evidence: string }>;
  sampleAccounts: Array<{ name: string; industry?: string; employees?: number; country?: string }>;
};

export type Suggestion = {
  label: string;
  kind: "noul" | "choice";
  criterion: string;
  options?: ChoiceOption[];
  rationale: string;
  basis: string[];
};

export const SUGGESTION_SCHEMA = {
  type: "object",
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      maxItems: MAX_SUGGESTIONS,
      items: {
        type: "object",
        required: ["label", "kind", "criterion", "rationale", "basis"],
        properties: {
          label: { type: "string", description: "2-5 word name, e.g. 'Commissioned field reps'." },
          kind: { type: "string", enum: ["noul", "choice"] },
          criterion: {
            type: "string",
            description:
              "noul: one declarative statement about 'the company' that is true or false. choice: the question the options answer.",
          },
          options: {
            type: "array",
            description: "choice only: 3-6 mutually exclusive answers.",
            items: {
              type: "object",
              required: ["label"],
              properties: { label: { type: "string" }, description: { type: "string" } },
            },
          },
          rationale: { type: "string", description: "One sentence: why this trait would separate good-fit accounts." },
          basis: {
            type: "array",
            description: "1-3 short quotes copied exactly from the inputs that motivated this trait.",
            items: { type: "string" },
          },
        },
      },
    },
  },
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The inputs as text. Basis quotes are checked against exactly this. */
export function contextText(c: SuggestionContext): string {
  const parts: string[] = [];
  if (c.vendorDomain) parts.push(`## Our company\n${c.vendorDomain}`);
  if (c.icp) parts.push(`## Our ideal customer profile\n${clip(JSON.stringify(c.icp), 3000)}`);
  if (c.buyers.length) parts.push(`## Who we sell to\n${c.buyers.map((b) => `- ${b.label}: ${b.why}`).join("\n")}`);
  if (c.jobs.length) parts.push(`## Jobs we help with\n${c.jobs.map((j) => `- ${j}`).join("\n")}`);
  if (c.closedDeals.length) {
    parts.push(
      `## Recent closed deals\n${c.closedDeals
        .map((d) => {
          const facts = [d.account, d.industry, d.employees !== undefined ? `${d.employees} employees` : undefined, d.amount ? `$${Math.round(d.amount).toLocaleString("en-US")}` : undefined]
            .filter(Boolean)
            .join(", ");
          return `- ${d.won ? "WON" : "LOST"}: ${d.name}${facts ? ` (${facts})` : ""}`;
        })
        .join("\n")}`,
    );
  }
  if (c.callInsights.length) {
    parts.push(
      `## From sales calls\n${c.callInsights.map((i) => `- [${i.type}] ${clip(i.text, 240)} — "${clip(i.evidence, 240)}"`).join("\n")}`,
    );
  }
  if (c.sampleAccounts.length) {
    parts.push(
      `## Sample of accounts in this market\n${c.sampleAccounts
        .map((a) => {
          const facts = [a.industry, a.employees !== undefined ? `${a.employees} employees` : undefined, a.country].filter(Boolean);
          return `- ${a.name}${facts.length ? ` (${facts.join(", ")})` : ""}`;
        })
        .join("\n")}`,
    );
  }
  if (c.existingSegments.length) {
    parts.push(`## Segments that already exist (do not repeat)\n${c.existingSegments.map((s) => `- ${s.label}: ${s.criterion}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export function suggestionPrompt(c: SuggestionContext): string {
  return `You help a B2B sales team segment its total addressable market. Propose up to ${MAX_SUGGESTIONS} new account traits ("AI segments") that would separate the accounts most likely to buy from the rest.

A separate classifier will judge each trait for every account using ONLY the account's homepage text plus its industry, employee count and country. So every trait must be something a company's own homepage can reveal (what it sells, to whom, how it sells, its business model, its tech or regulatory context). Avoid traits that need private data (revenue growth, internal tools, politics, intent). Industry, employee count, region and country are already segments: never propose a trait that restates them, such as a size band or an industry label.

Prefer traits that:
- separate the WON from the LOST deals, or tie to pains, objections and competitors heard on calls;
- connect to the jobs we help with and who we sell to;
- would split the sample accounts below rather than be true of nearly all or none of them.

Use kind "noul" for a yes/no statement about "the company" (e.g. "The company sells through a team of commissioned field sales reps."). Use kind "choice" only when the answer is one of 3-${MAX_OPTIONS} mutually exclusive options (e.g. primary sales motion: self-serve / inside sales / field sales / channel partners).

For each trait give a one-sentence rationale and 1-3 basis quotes copied exactly, character for character, from the inputs below. Do not repeat or rephrase existing segments.

# Inputs

${contextText(c)}`;
}

const normalize = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/**
 * Validate the model's output: drop malformed and duplicate traits, keep only
 * basis quotes that appear verbatim in the inputs, and bound everything.
 */
export function parseSuggestions(raw: unknown, inputs: string, existing: Array<{ label: string; criterion: string }>): Suggestion[] {
  const list = (raw as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) return [];
  const haystack = normalize(inputs);
  const seen = new Set(existing.flatMap((s) => [normalize(s.label), normalize(s.criterion)]));
  const out: Suggestion[] = [];
  for (const item of list) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const s = item as Record<string, unknown>;
    const label = typeof s.label === "string" ? s.label.trim().slice(0, 80) : "";
    const criterion = typeof s.criterion === "string" ? s.criterion.trim().slice(0, 500) : "";
    if (!label || criterion.length < 4) continue;
    if (seen.has(normalize(label)) || seen.has(normalize(criterion))) continue;
    const kind: Suggestion["kind"] = s.kind === "choice" ? "choice" : "noul";
    let options: ChoiceOption[] | undefined;
    if (kind === "choice") {
      const keys = new Set<string>();
      options = (Array.isArray(s.options) ? s.options : [])
        .map((o) => o as { label?: unknown; description?: unknown })
        .filter((o) => typeof o.label === "string" && o.label.trim())
        .map((o) => ({
          key: optionKey(String(o.label)),
          label: String(o.label).trim().slice(0, 80),
          ...(typeof o.description === "string" && o.description.trim() ? { description: o.description.trim().slice(0, 200) } : {}),
        }))
        .filter((o) => o.key && o.key !== "none" && o.key !== UNSURE && !keys.has(o.key) && (keys.add(o.key), true))
        .slice(0, MAX_OPTIONS);
      // A choice with fewer than two real options is not a choice.
      if (options.length < 2) continue;
    }
    if (kind === "noul") options = undefined;
    const basis = (Array.isArray(s.basis) ? s.basis : [])
      .filter((q): q is string => typeof q === "string" && q.trim().length >= 4)
      .map((q) => q.trim().slice(0, 300))
      .filter((q) => haystack.includes(normalize(q)))
      .slice(0, 3);
    seen.add(normalize(label));
    seen.add(normalize(criterion));
    out.push({
      label,
      kind,
      criterion,
      ...(options ? { options } : {}),
      rationale: typeof s.rationale === "string" ? s.rationale.trim().slice(0, 300) : "",
      basis,
    });
  }
  return out;
}

export function questionFor(s: Pick<Suggestion, "kind" | "criterion" | "options">): SystemOneQuestion {
  return s.kind === "choice" ? choiceQuestion(s.criterion, s.options ?? []) : noulQuestion(s.criterion);
}

/** Answers for one candidate across the sample → bucket counts (yes/no/unsure, or option keys). */
export function bucketCounts(answers: Array<SystemOneAnswer | null>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of answers) {
    if (!a) continue;
    const b = bucketFor(a);
    counts[b] = (counts[b] ?? 0) + 1;
  }
  return counts;
}

export type SplitVerdict = "splits" | "mostly-unsure" | "one-sided" | "not-measured";

/**
 * How useful a trait is on this sample, 0..1: the share Jev could decide,
 * times how big the second-largest answer is (yes/no: the smaller side; a
 * choice: the runner-up option). 2 yes of 40 is decisive but barely a split.
 */
export function splitScore(counts: Record<string, number>): { score: number; verdict: SplitVerdict; scored: number } {
  const scored = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!scored) return { score: 0, verdict: "not-measured", scored };
  const decisiveness = (scored - (counts[UNSURE] ?? 0)) / scored;
  const sides = Object.entries(counts)
    .filter(([k]) => k !== UNSURE && k !== "none")
    .map(([, n]) => n / scored)
    .sort((a, b) => b - a);
  const second = sides[1] ?? 0;
  const score = decisiveness * Math.min(1, second / FULL_SPLIT_SHARE);
  const verdict: SplitVerdict = decisiveness < 0.5 ? "mostly-unsure" : second >= SPLIT_MIN_SHARE ? "splits" : "one-sided";
  return { score: Math.round(score * 1000) / 1000, verdict, scored };
}
