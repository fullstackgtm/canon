/**
 * Research for a deal's play (docs/deal-plays.md): the subject the recipe's
 * prompts read (recipes/), the pages block, and the screen the model's answer
 * passes before anything is saved. Facts (timeline, signals, competitors, named people) need a quote
 * found word for word in a page the run read; risks, gaps and discovery
 * questions are the model's judgment and are kept as such. Persona, angle and
 * the brief are hypotheses. Pure: the run injects pages and the model.
 */
import { DEAL_ROLES, type DealRole } from "../objects/registry.ts";
import { locateQuote, normalizeForQuote, type FetchedPage } from "../research/agentLoop.ts";
import { CONFIDENCE, ITEM_KINDS, PLAY_CHANNELS, type Channel, type Confidence, type ItemKind } from "./model.ts";

const PAGE_CHARS = 5000;
const PROMPT_PAGE_BUDGET = 48_000;
/** Kinds that state a fact about the account, so need a verified quote. */
export const CITED_KINDS: readonly ItemKind[] = ["timeline", "signal", "competitor"];

export type ResearchSubject = {
  company: string;
  domain: string;
  dealName: string;
  /** What the seller offers and the angle, as the play's owner wrote it. */
  context: string | null;
  people: ReadonlyArray<{ name: string; title: string | null; role: DealRole | null }>;
  /** What the deal's gaps need to know (the recipe's prep). Searches aim at them; each is answered from a page or left open. */
  questions: readonly string[];
};

/** Pages trimmed to the prompt's budget, each numbered with its URL. */
export function pagesBlock(pages: readonly FetchedPage[]): string {
  let left = PROMPT_PAGE_BUDGET;
  const out: string[] = [];
  for (const p of pages) {
    if (left <= 0) break;
    const text = p.text.slice(0, Math.min(PAGE_CHARS, left));
    left -= text.length;
    out.push(`--- ${p.snippet ? "Search result" : "Page"}: ${p.url}\n${text}`);
  }
  return out.join("\n\n");
}

// ───────────────────────────── Screening ─────────────────────────────

export type ScreenedItem = {
  kind: ItemKind; text: string; quote?: string; sourceUrl?: string; occurredOn?: string; evidence: "verified" | "none";
  person?: { name: string; title?: string; role?: DealRole };
};
export type ScreenedPerson = { contactId: string; persona: string; angle: string; confidence: Confidence; suggestedRole: DealRole | null };
export type ScreenedStep = { title: string; channel: Channel; contactId?: string; role?: DealRole; dueOn?: string };
/** A research question and what a page says to it; `answer` is absent when no page did, verbatim. */
export type ScreenedAnswer = { question: string; answer?: string; quote?: string; sourceUrl?: string };
export type Screened = { whyNow: string; alphaHypothesis: string; alphaPitch: string; items: ScreenedItem[]; people: ScreenedPerson[]; steps: ScreenedStep[]; answers: ScreenedAnswer[]; dropped: number };

const s = (x: unknown) => (typeof x === "string" ? x.trim() : "");
const oneOf = <T extends string>(list: readonly T[], x: unknown): T | null => (list.includes(x as T) ? (x as T) : null);
const nameKey = (n: string) => normalizeForQuote(n).replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
/** A person's name, not a role or a team: two to five words, no digits, brackets or commas. */
export const looksLikeName = (n: string) => /^[\p{L}][\p{L}'.-]*(?: [\p{L}][\p{L}'.-]*){1,4}$/u.test(n) && !/\b(?:role|team|leader|analyst|manager|director|head|officer|vp)\b/i.test(n);
const addDays = (today: string, days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + Math.max(0, Math.min(365, Math.round(days))) * 86_400_000).toISOString().slice(0, 10);

/**
 * Keep what the evidence supports. A cited kind whose quote isn't in a page read is dropped, and so is a person
 * Canon doesn't know whose quote isn't. A known person (by name) gets notes; one Canon doesn't know becomes a
 * verified gap ("not in Canon yet"), not a contact.
 */
export function screenFindings(raw: unknown, pages: readonly FetchedPage[], known: ReadonlyArray<{ id: string; name: string }>, today: string, questions: readonly string[] = []): Screened {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]) : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  const byName = new Map(known.map((p) => [nameKey(p.name), p.id]));
  let dropped = 0;
  const items: ScreenedItem[] = [];
  const cite = (quote: string, url: string) => (quote ? locateQuote(quote, pages, url || undefined) : null);

  for (const it of list("items")) {
    const kind = oneOf(ITEM_KINDS, it.kind);
    const text = s(it.text);
    if (!kind || !text) { dropped++; continue; }
    const occurredOn = /^\d{4}-\d{2}-\d{2}$/.test(s(it.occurredOn)) ? s(it.occurredOn) : undefined;
    const page = cite(s(it.quote), s(it.sourceUrl));
    if (CITED_KINDS.includes(kind) && !page) { dropped++; continue; }
    items.push(page ? { kind, text, quote: s(it.quote), sourceUrl: page.url, evidence: "verified", ...(occurredOn ? { occurredOn } : {}) } : { kind, text, evidence: "none" });
  }

  const people: ScreenedPerson[] = [];
  const named = new Map<string, string>();
  for (const p of list("people")) {
    const name = s(p.name);
    if (!name) { dropped++; continue; }
    const contactId = byName.get(nameKey(name));
    if (contactId) {
      named.set(nameKey(name), contactId);
      people.push({ contactId, persona: s(p.persona), angle: s(p.angle), confidence: oneOf(CONFIDENCE, p.confidence) ?? "low", suggestedRole: oneOf(DEAL_ROLES, p.suggestedRole) });
      continue;
    }
    const page = cite(s(p.quote), s(p.sourceUrl));
    // The quote itself must name them in full: a surname elsewhere on the page proves nothing.
    if (!looksLikeName(name) || !page || !nameKey(s(p.quote)).includes(nameKey(name))) { dropped++; continue; }
    const title = s(p.title);
    const role = oneOf(DEAL_ROLES, p.suggestedRole);
    items.push({
      kind: "gap", text: `Not in Canon yet: ${name}${title ? `, ${title}` : ""}${role ? ` (possible ${role})` : ""}. ${s(p.angle)}`.trim(),
      quote: s(p.quote), sourceUrl: page.url, evidence: "verified", person: { name, ...(title ? { title } : {}), ...(role ? { role } : {}) },
    });
  }

  const steps: ScreenedStep[] = list("steps").flatMap((st): ScreenedStep[] => {
    const title = s(st.title);
    const channel = oneOf(PLAY_CHANNELS, st.channel);
    if (!title || !channel) return [];
    const contactId = named.get(nameKey(s(st.personName))) ?? byName.get(nameKey(s(st.personName)));
    const role = oneOf(DEAL_ROLES, st.role);
    const days = typeof st.dueInDays === "number" && Number.isFinite(st.dueInDays) ? st.dueInDays : null;
    return [{ title, channel, ...(contactId ? { contactId } : role ? { role } : {}), ...(days !== null ? { dueOn: addDays(today, days) } : {}) }];
  });

  // Every question asked comes back: answered only with a quote found in a page read, otherwise open.
  const given = list("answers");
  const answers: ScreenedAnswer[] = questions.map((question) => {
    // Only an answer naming this question answers it: a quote that answers another one proves nothing here.
    const a = given.find((x) => s(x.question) === question);
    const page = a && s(a.answer) ? cite(s(a.quote), s(a.sourceUrl)) : null;
    if (a && s(a.answer) && !page) dropped++;
    return page ? { question, answer: s(a!.answer), quote: s(a!.quote), sourceUrl: page.url } : { question };
  });

  return { whyNow: s(r.whyNow), alphaHypothesis: s(r.alphaHypothesis), alphaPitch: s(r.alphaPitch), items, people, steps, answers, dropped };
}
