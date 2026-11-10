/**
 * The verbatim rule: an AI-claimed fact counts only when its quote is found word for word in the source it names.
 * One matcher for every gate that applies the rule: a conversation's CRM facts (convex/lib/conversations/facts.ts) and a
 * module's hosted AI steps (modules/kernel/ai.ts, docs/modules.md "Hosted AI steps").
 *
 * Pure: no Node-only imports, so Convex functions and a module's server bundle import it alike.
 */

/** The shortest quote the rule accepts by default: shorter ones ("forty") are found almost anywhere. */
export const QUOTE_MIN_CHARS = 12;

/** Whitespace and case folded, and curly quotes straightened, so a quote matches the text it was copied from. */
export const foldText = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Whether `quote` is in `text` word for word, case, whitespace and curly quotes aside, and at least `minLength`
 * characters long. `text` may be folded already (`foldText`): folding twice changes nothing.
 */
export function quoteFound(quote: string | null | undefined, text: string, minLength = QUOTE_MIN_CHARS): quote is string {
  if (typeof quote !== "string" || quote.trim().length < minLength) return false;
  return foldText(text).includes(foldText(quote));
}

export function buildEvidenceRepairPrompt(prompt: string, rejected: string[]): string {
  const listed = rejected.slice(0, 6).map((quote) => `- ${JSON.stringify(quote.slice(0, 200))}`).join("\n");
  return `${prompt}

A previous answer was rejected because its evidence quotes did not appear verbatim in the sources${listed ? `:\n${listed}` : "."}
Answer again. Copy each quote exactly as it appears in one source (a sentence or phrase of at least a few words), and name that source's id.`;
}

