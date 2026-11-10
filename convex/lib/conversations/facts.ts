/**
 * What a conversation changed in the CRM: the prompt that asks a model for a
 * deal's next step and close date and the job titles people gave, and the gate
 * that keeps only answers quoted word for word from the conversation. One
 * extractor for a meeting's transcript, an email thread and a LinkedIn
 * conversation (docs/conversation-intake.md); only the prompt's wording changes
 * with the kind. What survives is proposed through the agent write gate with
 * the conversation's kind as its `sourceKind` (convex/canonGate.ts), where the
 * org's ownership and auto-accept rules decide what applies without a person.
 *
 * Pure: no database access, no Node-only imports.
 */
import type { CallsModel } from "../../../recipes/models.ts";
import { foldText as fold, quoteFound } from "../../../engine/src/evidence.ts";
import type { ReadForSuggestions } from "../calls/suggestions.ts";

/** Where a proposal must quote from, at most this much of it, so a long conversation still fits a prompt. */
export const CONVERSATION_TEXT_MAX = 60_000;
const NEXT_STEP_MAX = 300;
const TITLE_MAX = 120;
const COMPANY_NAME_MAX = 120;
const DEAL_NAME_MAX = 200;
/** People one conversation may suggest by name (Granola lists none of them with an address). */
const MENTIONED_PEOPLE_MAX = 5;

export type ConversationKind = "call" | "email" | "linkedin";
/** What was read: a `callRecordings` id for a call, a conversation's id for a thread. Also the proposals' `sourceKind`. */
export type ConversationSource = { kind: ConversationKind; id: string };

export type ConversationFactsContext = {
  source: ConversationSource;
  /** A meeting's title, an email thread's subject, or a LinkedIn conversation's label. */
  title: string;
  /** YYYY-MM-DD: the meeting's day or the thread's latest message. Close dates are read relative to it. */
  day: string;
  summary: string | null;
  /** A call's transcript, or a thread's messages as `threadText` writes them. */
  text: string;
  /** Who the thread's "(us)" lines are from. */
  owner?: { name: string; email: string | null } | null;
  deal: { name: string; stage: string | null; nextStep: string | null; closeDate: string | null } | null;
  /** The other side's people the conversation was matched to, with the job titles on record. */
  people: Array<{ email: string; name: string | null; title: string | null }>;
  /** People on the other side the CRM does not have yet, and their companies' domains: what a conversation may suggest adding. */
  newPeople?: Array<{ email: string; name: string | null }>;
  newDomains?: string[];
  /** No open deal matched: ask whether the conversation shows a new opportunity. */
  askOpportunity?: boolean;
  /** Ask which outside company and people the conversation names (Granola often lists no attendees). */
  askMentions?: boolean;
};

/** One message of an email thread or LinkedIn conversation. */
export type ThreadMessage = { at: number; from: string; direction: "us" | "them"; text: string };

/** A thread as the prompt reads and the gate quotes it: one line per message, oldest first, `[YYYY-MM-DD] Name (us|them): text`. */
export function threadText(messages: readonly ThreadMessage[]): string {
  return [...messages].sort((a, b) => a.at - b.at)
    .map((m) => `[${new Date(m.at).toISOString().slice(0, 10)}] ${m.from} (${m.direction}): ${m.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

/** The model's answer through the forced tool call. */
export const CONVERSATION_FACTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    nextStep: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: { value: { type: "string" }, evidence: { type: "string" } },
      required: ["value", "evidence"],
    },
    closeDate: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: { value: { type: "string", description: "YYYY-MM-DD" }, evidence: { type: "string" } },
      required: ["value", "evidence"],
    },
    titles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { email: { type: "string" }, value: { type: "string" }, evidence: { type: "string" } },
        required: ["email", "value", "evidence"],
      },
    },
    companyNames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { domain: { type: "string" }, name: { type: "string" } },
        required: ["domain", "name"],
      },
    },
    opportunity: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        amountDollars: { type: ["number", "null"] },
        closeDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
        nextStep: { type: ["string", "null"] },
        evidence: { type: "string" },
      },
      required: ["name", "amountDollars", "closeDate", "nextStep", "evidence"],
    },
    otherCompany: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        searchHint: { type: "string", description: "A few words that tell this company apart in a web search (what it does, where, its systems)" },
        evidence: { type: "string" },
      },
      required: ["name", "searchHint", "evidence"],
    },
    mentionedPeople: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, evidence: { type: "string" } },
        required: ["name", "evidence"],
      },
    },
  },
  required: ["nextStep", "closeDate", "titles", "companyNames", "opportunity", "otherCompany", "mentionedPeople"],
} as const;

/** How the prompt names each kind of conversation and its parts. A call's wording is the prompt calls have always had. */
const WORDS: Record<ConversationKind, {
  intro: (day: string, title: string) => string;
  it: string; on: string; titleWord: string; textWord: string; textLabel: string; layout?: string;
}> = {
  call: {
    intro: (day, title) => `You update a CRM from a sales meeting held on ${day}, titled "${title}".`,
    it: "meeting", on: "on the call", titleWord: "title", textWord: "transcript", textLabel: "Transcript",
  },
  email: {
    intro: (day, title) => `You update a CRM from a sales email thread whose latest message is from ${day}, with the subject "${title}".`,
    it: "thread", on: "in the thread", titleWord: "subject", textWord: "messages", textLabel: "Messages",
    layout: "Each message is one line, oldest first: [date] sender (us|them): text. \"us\" is",
  },
  linkedin: {
    intro: (day, title) => `You update a CRM from a sales LinkedIn conversation whose latest message is from ${day}, titled "${title}".`,
    it: "conversation", on: "in the conversation", titleWord: "title", textWord: "messages", textLabel: "Messages",
    layout: "Each message is one line, oldest first: [date] sender (us|them): text. \"us\" is",
  },
};

/**
 * The prompt for one conversation. The kernel names the answer's fields, says which to leave empty, and holds the
 * evidence rule; the workspace's calls model (`define`) says what each answer means.
 */
export function conversationFactsPrompt(c: ConversationFactsContext, define: CallsModel["define"]): string {
  const w = WORDS[c.source.kind];
  const deal = c.deal
    ? `The ${w.it} is about the deal "${c.deal.name}" (stage ${c.deal.stage ?? "unknown"}; next step on record: ${c.deal.nextStep ?? "none"}; expected close date on record: ${c.deal.closeDate ?? "none"}).`
    : `No deal is linked to this ${w.it}: return null for nextStep and closeDate.`;
  const people = [
    ...c.people.map((p) => `- ${p.email}${p.name ? ` (${p.name})` : ""}: job title on record ${p.title ?? "none"}`),
    ...(c.newPeople ?? []).map((p) => `- ${p.email}${p.name ? ` (${p.name})` : ""}: not in the CRM yet`),
  ].join("\n");
  const call = c.source.kind === "call";
  return [
    w.intro(c.day, c.title),
    deal,
    people ? `People from the other company ${w.on}:\n${people}` : "",
    w.layout ? `${w.layout} ${c.owner?.name ? `${c.owner.name} and their team` : "our team"}; "them" is the other company.` : "",
    `Return only what the ${w.it} itself establishes:`,
    `- nextStep: ${define.nextStep}`,
    `- closeDate: ${define.closeDate}`,
    `- titles: a person's job title only when they or someone ${w.on} stated it, and it differs from the one on record or the person is not in the CRM yet.`,
    c.newDomains?.length
      ? `- companyNames: for these company domains, the company's name as the ${call ? "call" : w.it} or its people give it (leave a domain out if the name is never said): ${c.newDomains.join(", ")}.`
      : "- companyNames: an empty list.",
    c.askMentions
      ? `- otherCompany: ${define.otherCompany}\n- mentionedPeople: ${define.mentionedPeople}`
      : "- otherCompany: null.\n- mentionedPeople: an empty list.",
    c.askOpportunity
      ? `- opportunity: ${define.opportunity}`
      : "- opportunity: null.",
    `Every \`evidence\` must be copied exactly, word for word, from the ${w.titleWord}, the ${w.textWord} or the summary below: one or two sentences that state the value. Do not paraphrase evidence. If you cannot quote it, leave the value out.`,
    c.summary ? `Summary:\n${c.summary}` : "",
    `${w.textLabel}:\n${c.text.slice(0, CONVERSATION_TEXT_MAX)}`,
  ].filter(Boolean).join("\n\n");
}

const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/** A real calendar day (YYYY-MM-DD, no overflow such as 02-30 or month 13) on or after `from`. */
export function isDayOnOrAfter(day: string | null, from: string): day is string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day && day >= from;
}

/** One proposed fact as the gate takes it: deal facts carry `dealId`; a person's carries their email. */
export type ConversationFact =
  | { entityType: "opportunity"; attribute: "nextStep" | "closeDate"; value: string; evidence: string }
  | { entityType: "contact"; email: string; attribute: "title"; value: string; evidence: string };

/**
 * The model's answer, kept only where its evidence is a verbatim quote of the
 * conversation (the gate's verbatim evidence rule) and its value is new: a next
 * step or title already on record, or a close date that is not a real day at or
 * after the conversation, is dropped.
 */
export function groundedFacts(raw: unknown, c: ConversationFactsContext): ConversationFact[] {
  const source = fold(`${c.summary ?? ""}\n${c.text.slice(0, CONVERSATION_TEXT_MAX)}`);
  const quoted = (evidence: string | null): evidence is string => quoteFound(evidence, source);
  const r = rec(raw);
  const out: ConversationFact[] = [];

  if (c.deal) {
    const next = rec(r.nextStep);
    const value = str(next.value)?.slice(0, NEXT_STEP_MAX);
    const evidence = str(next.evidence);
    if (value && quoted(evidence) && fold(value) !== fold(c.deal.nextStep ?? "")) out.push({ entityType: "opportunity", attribute: "nextStep", value, evidence });

    const close = rec(r.closeDate);
    const day = str(close.value);
    const closeEvidence = str(close.evidence);
    const valid = isDayOnOrAfter(day, c.day);
    if (valid && quoted(closeEvidence) && day !== c.deal.closeDate) out.push({ entityType: "opportunity", attribute: "closeDate", value: day, evidence: closeEvidence });
  }

  const people = new Map(c.people.map((p) => [p.email.toLowerCase(), p]));
  for (const t of Array.isArray(r.titles) ? r.titles : []) {
    const item = rec(t);
    const person = people.get(str(item.email)?.toLowerCase() ?? "");
    const value = str(item.value)?.slice(0, TITLE_MAX);
    const evidence = str(item.evidence);
    if (person && value && quoted(evidence) && fold(value) !== fold(person.title ?? "")) {
      out.push({ entityType: "contact", email: person.email, attribute: "title", value, evidence });
    }
  }
  return out;
}

/** Whether a quote states this amount: `40,000`, `40000`, `40k` or `$40K` for 40000. */
export function amountStated(quote: string, dollars: number): boolean {
  const plain = quote.replace(/,/g, "").toLowerCase();
  const forms = [String(Math.round(dollars)), ...(dollars >= 1000 && dollars % 1000 === 0 ? [`${dollars / 1000}k`] : []), ...(dollars >= 1e6 && dollars % 1e5 === 0 ? [`${dollars / 1e6}m`] : [])];
  return forms.some((f) => new RegExp(`(^|[^\\d.])${f.replace(".", "\\.")}(?![\\d])`).test(plain));
}

/**
 * The parts of the answer that only suggest new records (lib/calls/suggestions.ts), checked like facts:
 * titles of people not in the CRM and the opportunity must quote the conversation; company names are kept only
 * for the domains asked about. An amount is kept only when its quote states it.
 */
export function groundedSuggestionRead(raw: unknown, c: ConversationFactsContext): ReadForSuggestions {
  const source = fold(`${c.title}\n${c.summary ?? ""}\n${c.text.slice(0, CONVERSATION_TEXT_MAX)}`);
  const quoted = (evidence: string | null): evidence is string => quoteFound(evidence, source, 3);
  const quotedLong = (evidence: string | null): evidence is string => quoteFound(evidence, source);
  const r = rec(raw);
  const asked = new Set(c.newDomains ?? []);
  const companyNames: Record<string, string> = {};
  for (const item of Array.isArray(r.companyNames) ? r.companyNames.map(rec) : []) {
    const domain = str(item.domain)?.toLowerCase();
    const name = str(item.name)?.slice(0, COMPANY_NAME_MAX);
    if (domain && name && asked.has(domain)) companyNames[domain] = name;
  }
  const newPeople = new Set((c.newPeople ?? []).map((p) => p.email.toLowerCase()));
  const titles: ReadForSuggestions["titles"] = {};
  for (const item of Array.isArray(r.titles) ? r.titles.map(rec) : []) {
    const email = str(item.email)?.toLowerCase();
    const value = str(item.value)?.slice(0, TITLE_MAX);
    const evidence = str(item.evidence);
    if (email && newPeople.has(email) && value && quoted(evidence)) titles[email] = { value, evidence };
  }
  let opportunity: ReadForSuggestions["opportunity"] = null;
  const o = rec(r.opportunity);
  const name = str(o.name)?.slice(0, DEAL_NAME_MAX);
  const evidence = str(o.evidence);
  if (c.askOpportunity && name && quotedLong(evidence)) {
    const dollars = typeof o.amountDollars === "number" && Number.isFinite(o.amountDollars) && o.amountDollars > 0 && amountStated(evidence, o.amountDollars) ? o.amountDollars : undefined;
    const closeDate = str(o.closeDate);
    const nextStep = str(o.nextStep)?.slice(0, NEXT_STEP_MAX);
    opportunity = {
      name, evidence,
      ...(dollars !== undefined ? { amount: Math.round(dollars * 100) } : {}),
      ...(isDayOnOrAfter(closeDate, c.day) ? { closeDate } : {}),
      ...(nextStep ? { nextStep } : {}),
    };
  }
  // The other company and its people named in the conversation: each quoted, and the quote must name them.
  let mentioned: ReadForSuggestions["mentioned"] = { company: null, people: [] };
  const oc = rec(r.otherCompany);
  const companyName = str(oc.name)?.slice(0, COMPANY_NAME_MAX);
  const companyEvidence = str(oc.evidence);
  if (c.askMentions && companyName && quoted(companyEvidence) && fold(companyEvidence).includes(fold(companyName))) {
    const people = (Array.isArray(r.mentionedPeople) ? r.mentionedPeople.map(rec) : []).flatMap((pp) => {
      const personName = str(pp.name)?.slice(0, 80);
      const why = str(pp.evidence);
      return personName && quoted(why) && fold(why).includes(fold(personName.split(" ")[0]!)) ? [{ name: personName, evidence: why }] : [];
    });
    mentioned = {
      company: { name: companyName, searchHint: (str(oc.searchHint) ?? "").slice(0, 120), evidence: companyEvidence },
      people: [...new Map(people.map((pp) => [fold(pp.name), pp])).values()].slice(0, MENTIONED_PEOPLE_MAX),
    };
  }
  return { companyNames, titles, opportunity, mentioned };
}
