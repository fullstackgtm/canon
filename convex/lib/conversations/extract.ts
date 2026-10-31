/**
 * Extraction from an email thread or LinkedIn conversation (docs/conversation-intake.md, CI3b): which messages one
 * pass reads, who the counterpart is to the prompt, and what an unmatched counterpart suggests adding. The worker is
 * convex/conversationExtract.ts; the extractor itself is facts.ts.
 *
 * Pure: no database access, no Node-only imports.
 */
import { FREE_EMAIL_DOMAINS } from "../../../engine/src/freeEmailDomains.ts";
import { domainOfEmail } from "../calls/granola.ts";
import { planSuggestions, type PlannedSuggestion, type ReadForSuggestions } from "../calls/suggestions.ts";
import { publicIdentifierOf } from "../linkedin/cadence.ts";
import { CONVERSATION_TEXT_MAX, threadText, type ThreadMessage } from "./facts.ts";

/** A pass reads at most this many of a conversation's latest messages. */
export const THREAD_READ_MAX = 200;
/** Messages before the new ones a re-extraction reads again, so a reply is read with what it answers. */
export const CONTEXT_MESSAGES = 10;

/** A stored message with when it was stored (`_creationTime`): a backfilled old message is still new to the extractor. */
export type StoredMessage = ThreadMessage & { stored: number };

/**
 * What one pass reads: every message stored since the last pass (`extractedAt`; all of them on the first pass), and
 * up to CONTEXT_MESSAGES before the earliest of them, oldest first. Over CONVERSATION_TEXT_MAX the newest are kept.
 * Nothing when no message is new.
 */
export function messagesToRead(messages: readonly StoredMessage[], extractedAt: number | undefined): ThreadMessage[] {
  const sorted = [...messages].sort((a, b) => a.at - b.at);
  const first = sorted.findIndex((m) => extractedAt === undefined || m.stored > extractedAt);
  if (first < 0) return [];
  const window = sorted.slice(Math.max(0, first - CONTEXT_MESSAGES));
  // The newest message is always read; older ones while the thread's text (one line each) still fits.
  let kept = 0;
  let size = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    const line = threadText([window[i]!]).length + 1;
    if (kept && size + line > CONVERSATION_TEXT_MAX) break;
    size += line;
    kept++;
  }
  return window.slice(window.length - kept).map(({ at, from, direction, text }) => ({ at, from, direction, text }));
}

export type Counterpart = { name?: string; email?: string; publicIdentifier?: string; profileUrl?: string };

/** The counterpart's LinkedIn vanity slug, lowercased. */
export const slugOfCounterpart = (c: Counterpart) => (c.publicIdentifier?.trim() || publicIdentifierOf(c.profileUrl))?.toLowerCase() ?? null;

/**
 * How the prompt and the facts name a person: their email, else their LinkedIn profile (`linkedin.com/in/<slug>`).
 * The model's `titles[].email` answers with the same key.
 */
export function personKey(p: { email?: string | null; linkedinUrl?: string | null }): string | null {
  if (p.email) return p.email.toLowerCase();
  const slug = publicIdentifierOf(p.linkedinUrl);
  return slug ? `linkedin.com/in/${slug.toLowerCase()}` : null;
}

/** The counterpart as the prompt lists someone not in the CRM yet, with their company's domain on business email. */
export function unknownCounterpart(channel: "email" | "linkedin", c: Counterpart): { key: string; name: string | null; domain: string | null } | null {
  if (channel === "email") {
    const email = c.email?.trim().toLowerCase();
    if (!email || !email.includes("@")) return null;
    const domain = domainOfEmail(email);
    return { key: email, name: c.name?.trim() || null, domain: FREE_EMAIL_DOMAINS.has(domain) ? null : domain };
  }
  const slug = slugOfCounterpart(c);
  return slug ? { key: `linkedin.com/in/${slug}`, name: c.name?.trim() || null, domain: null } : null;
}

/**
 * What one conversation suggests adding. An email counterpart not in the CRM is a person (with a name) and their
 * company by domain, as a meeting's attendee is. A LinkedIn one is a person with their profile link. A deal is
 * suggested when no open deal matched and the conversation quotes an opportunity. Nothing is created here.
 */
export function conversationSuggestions(a: {
  conversationId: string;
  channel: "email" | "linkedin";
  /** The counterpart when the CRM has no record of them; null when it does. */
  unknown: { key: string; name: string | null; domain: string | null } | null;
  /** The counterpart's email, known or not (email only). */
  email: string | null;
  domainKnown: boolean;
  hasDeal: boolean;
  read: ReadForSuggestions;
}): PlannedSuggestion[] {
  const out: PlannedSuggestion[] = [];
  if (a.channel === "email" && a.email) {
    const email = a.email.toLowerCase();
    const domain = domainOfEmail(email);
    out.push(...planSuggestions({
      callKey: a.conversationId, attendees: [{ email, name: a.unknown?.name ?? null }],
      knownEmails: new Set(a.unknown ? [] : [email]), knownDomains: new Set(a.domainKnown ? [domain] : []),
      meetingDomains: FREE_EMAIL_DOMAINS.has(domain) ? [] : [domain], hasDeal: true, recent: true, read: a.read,
    }));
  }
  if (a.channel === "linkedin" && a.unknown?.name) {
    const title = a.read.titles[a.unknown.key];
    out.push({
      kind: "contact", key: `linkedin:${a.unknown.key.replace("linkedin.com/in/", "")}`,
      values: { name: a.unknown.name, linkedinUrl: `https://www.${a.unknown.key}`, ...(title ? { title: title.value } : {}) },
      ...(title ? { evidence: title.evidence } : {}),
    });
  }
  const o = a.read.opportunity;
  if (o && !a.hasDeal) {
    out.push({
      kind: "deal", key: `conversation:${a.conversationId}`,
      values: { name: o.name, ...(o.amount !== undefined ? { amount: o.amount } : {}), ...(o.closeDate ? { closeDate: o.closeDate } : {}), ...(o.nextStep ? { nextStep: o.nextStep } : {}) },
      evidence: o.evidence,
    });
  }
  return out;
}
